#include "adaptive_upmixer.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

using Astra::Upmix::AdaptiveUpmixer;
using Astra::Upmix::Algorithm;
using Astra::Upmix::Config;
using Astra::Upmix::Diagnostics;
using Astra::Upmix::SpeakerRole;

namespace {

struct Options {
    std::filesystem::path input;
    std::filesystem::path output;
    std::filesystem::path primary;
    std::filesystem::path ambient;
    std::filesystem::path foldDown;
    std::filesystem::path diagnostics;
    std::string layout = "5.1";
    std::string algorithm = "adaptive";
    float sampleRate = 48000.0f;
    float rearTargetDb = std::numeric_limits<float>::quiet_NaN();
    float rearCenterDb = std::numeric_limits<float>::quiet_NaN();
};

std::string requireValue(int& index, int argc, char** argv) {
    if (++index >= argc) throw std::runtime_error(std::string("Missing value for ") + argv[index - 1]);
    return argv[index];
}

Options parseOptions(int argc, char** argv) {
    Options options;
    for (int index = 1; index < argc; ++index) {
        const std::string argument = argv[index];
        if (argument == "--input") options.input = requireValue(index, argc, argv);
        else if (argument == "--output") options.output = requireValue(index, argc, argv);
        else if (argument == "--primary") options.primary = requireValue(index, argc, argv);
        else if (argument == "--ambient") options.ambient = requireValue(index, argc, argv);
        else if (argument == "--fold-down") options.foldDown = requireValue(index, argc, argv);
        else if (argument == "--diagnostics") options.diagnostics = requireValue(index, argc, argv);
        else if (argument == "--layout") options.layout = requireValue(index, argc, argv);
        else if (argument == "--algorithm") options.algorithm = requireValue(index, argc, argv);
        else if (argument == "--sample-rate") options.sampleRate = std::stof(requireValue(index, argc, argv));
        else if (argument == "--rear-target-db") options.rearTargetDb = std::stof(requireValue(index, argc, argv));
        else if (argument == "--rear-center-db") options.rearCenterDb = std::stof(requireValue(index, argc, argv));
        else throw std::runtime_error("Unknown argument: " + argument);
    }
    if (options.input.empty() || options.output.empty() || options.primary.empty() ||
        options.ambient.empty() || options.foldDown.empty() || options.diagnostics.empty()) {
        throw std::runtime_error("Input, output, primary, ambient, fold-down, and diagnostics paths are required");
    }
    if (std::isfinite(options.rearTargetDb) &&
        (options.rearTargetDb < -60.0f || options.rearTargetDb > 6.0f)) {
        throw std::runtime_error("Rear target must be between -60 and +6 dB");
    }
    if (std::isfinite(options.rearCenterDb) &&
        (options.rearCenterDb < -60.0f || options.rearCenterDb > 0.0f)) {
        throw std::runtime_error("Rear center detail must be between -60 and 0 dB");
    }
    return options;
}

std::vector<SpeakerRole> rolesForLayout(const std::string& layout) {
    if (layout == "quad") {
        return {SpeakerRole::FrontLeft, SpeakerRole::FrontRight,
                SpeakerRole::SideLeft, SpeakerRole::SideRight};
    }
    if (layout == "5.0") {
        return {SpeakerRole::FrontLeft, SpeakerRole::FrontRight, SpeakerRole::FrontCenter,
                SpeakerRole::SideLeft, SpeakerRole::SideRight};
    }
    if (layout == "5.1") {
        return {SpeakerRole::FrontLeft, SpeakerRole::FrontRight, SpeakerRole::FrontCenter,
                SpeakerRole::Lfe, SpeakerRole::SideLeft, SpeakerRole::SideRight};
    }
    if (layout == "7.1") {
        return {SpeakerRole::FrontLeft, SpeakerRole::FrontRight, SpeakerRole::FrontCenter,
                SpeakerRole::Lfe, SpeakerRole::BackLeft, SpeakerRole::BackRight,
                SpeakerRole::SideLeft, SpeakerRole::SideRight};
    }
    throw std::runtime_error("Layout must be quad, 5.0, 5.1, or 7.1");
}

std::vector<float> readFloatFile(const std::filesystem::path& path) {
    std::ifstream stream(path, std::ios::binary | std::ios::ate);
    if (!stream) throw std::runtime_error("Could not open input: " + path.string());
    const auto bytes = stream.tellg();
    if (bytes < 0 || bytes % static_cast<std::streamoff>(sizeof(float) * 2) != 0) {
        throw std::runtime_error("Input must be interleaved stereo f32le");
    }
    std::vector<float> values(static_cast<size_t>(bytes) / sizeof(float));
    stream.seekg(0);
    stream.read(reinterpret_cast<char*>(values.data()), bytes);
    if (!stream) throw std::runtime_error("Could not read input: " + path.string());
    return values;
}

void writeFloatFile(const std::filesystem::path& path, const std::vector<float>& values) {
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    if (!stream) throw std::runtime_error("Could not open output: " + path.string());
    stream.write(reinterpret_cast<const char*>(values.data()),
                 static_cast<std::streamsize>(values.size() * sizeof(float)));
    if (!stream) throw std::runtime_error("Could not write output: " + path.string());
}

size_t findRole(const std::vector<SpeakerRole>& roles, SpeakerRole role) {
    const auto found = std::find(roles.begin(), roles.end(), role);
    return found == roles.end() ? roles.size() : static_cast<size_t>(found - roles.begin());
}

float roleSample(const std::vector<float>& rendered,
                 const std::vector<SpeakerRole>& roles,
                 size_t frame,
                 SpeakerRole role) {
    const size_t index = findRole(roles, role);
    return index == roles.size() ? 0.0f : rendered[frame * roles.size() + index];
}

double dbRatio(double numerator, double denominator) {
    return 10.0 * std::log10(numerator / std::max(1.0e-30, denominator) + 1.0e-30);
}

bool isSurroundRole(SpeakerRole role) {
    return role == SpeakerRole::SideLeft || role == SpeakerRole::SideRight ||
           role == SpeakerRole::BackLeft || role == SpeakerRole::BackRight;
}

} // namespace

int main(int argc, char** argv) {
    try {
        const Options options = parseOptions(argc, argv);
        const auto roles = rolesForLayout(options.layout);
        const Algorithm algorithm = Astra::Upmix::parseAlgorithm(options.algorithm.c_str());
        Config config{options.sampleRate, roles, algorithm};
        if (std::isfinite(options.rearCenterDb)) {
            config.surroundCenterMixGain = std::pow(10.0f, options.rearCenterDb / 20.0f);
        }
        AdaptiveUpmixer upmixer(config);

        const std::vector<float> input = readFloatFile(options.input);
        const size_t inputFrames = input.size() / 2;
        const size_t processFrames = inputFrames + upmixer.tailFrames() + upmixer.hopSize();
        std::vector<float> padded(processFrames * 2, 0.0f);
        std::copy(input.begin(), input.end(), padded.begin());
        std::vector<float> rendered(processFrames * roles.size(), 0.0f);
        std::vector<float> stems(processFrames * 4, 0.0f);
        upmixer.process(padded.data(), rendered.data(), processFrames, stems.data());

        const size_t latency = upmixer.latencyFrames();
        std::vector<float> alignedRendered(inputFrames * roles.size());
        std::vector<float> primary(inputFrames * 2);
        std::vector<float> ambient(inputFrames * 2);
        std::vector<float> foldDown(inputFrames * 2);
        double reconstructionError = 0.0;
        double inputEnergy = 0.0;
        double inputCommonEnergy = 0.0;
        double ambientCommonEnergy = 0.0;
        double frontEnergy = 0.0;
        double unscaledSurroundEnergy = 0.0;

        for (size_t frame = 0; frame < inputFrames; ++frame) {
            const size_t delayed = frame + latency;
            for (size_t channel = 0; channel < roles.size(); ++channel) {
                const float sample = rendered[delayed * roles.size() + channel];
                alignedRendered[frame * roles.size() + channel] = sample;
                const double sampleEnergy = static_cast<double>(sample) * sample;
                if (isSurroundRole(roles[channel])) unscaledSurroundEnergy += sampleEnergy;
                else if (roles[channel] == SpeakerRole::FrontLeft ||
                         roles[channel] == SpeakerRole::FrontRight ||
                         roles[channel] == SpeakerRole::FrontCenter) frontEnergy += sampleEnergy;
            }
            for (size_t channel = 0; channel < 2; ++channel) {
                primary[frame * 2 + channel] = stems[delayed * 4 + channel];
                ambient[frame * 2 + channel] = stems[delayed * 4 + 2 + channel];
                const double expected = input[frame * 2 + channel];
                const double reconstructed = primary[frame * 2 + channel] + ambient[frame * 2 + channel];
                const double error = reconstructed - expected;
                reconstructionError += error * error;
                inputEnergy += expected * expected;
            }

            const double inputCommon = (input[frame * 2] + input[frame * 2 + 1]) * 0.7071067811865476;
            const double ambientCommon = (ambient[frame * 2] + ambient[frame * 2 + 1]) *
                                         0.7071067811865476;
            inputCommonEnergy += inputCommon * inputCommon;
            ambientCommonEnergy += ambientCommon * ambientCommon;
        }

        double rearGain = 1.0;
        bool rearGainLimited = false;
        if (std::isfinite(options.rearTargetDb) && frontEnergy > 1.0e-30 &&
            unscaledSurroundEnergy > 1.0e-30) {
            const double desired = frontEnergy * std::pow(10.0, options.rearTargetDb / 10.0);
            rearGain = std::sqrt(desired / unscaledSurroundEnergy);
            const double maximumGain = std::pow(10.0, 12.0 / 20.0);
            if (rearGain > maximumGain) {
                rearGain = maximumGain;
                rearGainLimited = true;
            }
            for (size_t frame = 0; frame < inputFrames; ++frame) {
                for (size_t channel = 0; channel < roles.size(); ++channel) {
                    if (isSurroundRole(roles[channel])) {
                        alignedRendered[frame * roles.size() + channel] = static_cast<float>(
                            alignedRendered[frame * roles.size() + channel] * rearGain);
                    }
                }
            }
        }

        double renderedEnergy = 0.0;
        double surroundEnergy = 0.0;
        double frontNullError = 0.0;
        double rearCross = 0.0;
        double rearLeftEnergy = 0.0;
        double rearRightEnergy = 0.0;
        double samplePeak = 0.0;
        DSP::BiquadFilter inputHighpass;
        DSP::BiquadFilter inputLowpass;
        DSP::BiquadFilter ambientHighpass;
        DSP::BiquadFilter ambientLowpass;
        inputHighpass.setHighpass(250.0f, options.sampleRate);
        inputLowpass.setLowpass(4000.0f, options.sampleRate);
        ambientHighpass.setHighpass(250.0f, options.sampleRate);
        ambientLowpass.setLowpass(4000.0f, options.sampleRate);
        double vocalInputEnergy = 0.0;
        double vocalAmbientEnergy = 0.0;
        double vocalCross = 0.0;

        for (size_t frame = 0; frame < inputFrames; ++frame) {
            for (size_t channel = 0; channel < roles.size(); ++channel) {
                const float sample = alignedRendered[frame * roles.size() + channel];
                const double sampleEnergy = static_cast<double>(sample) * sample;
                renderedEnergy += sampleEnergy;
                if (isSurroundRole(roles[channel])) surroundEnergy += sampleEnergy;
                samplePeak = std::max(samplePeak, std::abs(static_cast<double>(sample)));
            }

            const float frontLeft = roleSample(alignedRendered, roles, frame, SpeakerRole::FrontLeft);
            const float frontRight = roleSample(alignedRendered, roles, frame, SpeakerRole::FrontRight);
            const double frontLeftError = static_cast<double>(frontLeft) - input[frame * 2];
            const double frontRightError = static_cast<double>(frontRight) - input[frame * 2 + 1];
            frontNullError += frontLeftError * frontLeftError + frontRightError * frontRightError;

            const float center = roleSample(alignedRendered, roles, frame, SpeakerRole::FrontCenter);
            const float sideLeft = roleSample(alignedRendered, roles, frame, SpeakerRole::SideLeft);
            const float sideRight = roleSample(alignedRendered, roles, frame, SpeakerRole::SideRight);
            const float backLeft = roleSample(alignedRendered, roles, frame, SpeakerRole::BackLeft);
            const float backRight = roleSample(alignedRendered, roles, frame, SpeakerRole::BackRight);
            foldDown[frame * 2] = frontLeft + 0.70710678f * center +
                                  0.70710678f * (sideLeft + backLeft);
            foldDown[frame * 2 + 1] = frontRight + 0.70710678f * center +
                                      0.70710678f * (sideRight + backRight);

            const double rearLeft = sideLeft + backLeft;
            const double rearRight = sideRight + backRight;
            rearCross += rearLeft * rearRight;
            rearLeftEnergy += rearLeft * rearLeft;
            rearRightEnergy += rearRight * rearRight;

            const float inputCommon = static_cast<float>(
                (input[frame * 2] + input[frame * 2 + 1]) * 0.7071067811865476);
            const float ambientCommon = static_cast<float>(
                (ambient[frame * 2] + ambient[frame * 2 + 1]) * 0.7071067811865476);
            const float vocalInput = inputLowpass.process(inputHighpass.process(inputCommon));
            const float vocalAmbient = ambientLowpass.process(ambientHighpass.process(ambientCommon));
            vocalInputEnergy += static_cast<double>(vocalInput) * vocalInput;
            vocalAmbientEnergy += static_cast<double>(vocalAmbient) * vocalAmbient;
            vocalCross += static_cast<double>(vocalInput) * vocalAmbient;
        }

        writeFloatFile(options.output, alignedRendered);
        writeFloatFile(options.primary, primary);
        writeFloatFile(options.ambient, ambient);
        writeFloatFile(options.foldDown, foldDown);

        const Diagnostics& diagnostic = upmixer.diagnostics();
        const double weight = std::max(1.0e-30, diagnostic.analysisWeight);
        std::ofstream json(options.diagnostics, std::ios::trunc);
        json << std::fixed << std::setprecision(8)
             << "{\n"
             << "  \"algorithm\": \"" << Astra::Upmix::algorithmName(algorithm) << "\",\n"
             << "  \"layout\": \"" << options.layout << "\",\n"
             << "  \"sampleRate\": " << options.sampleRate << ",\n"
             << "  \"inputFrames\": " << inputFrames << ",\n"
             << "  \"fftSize\": " << upmixer.fftSize() << ",\n"
             << "  \"hopSize\": " << upmixer.hopSize() << ",\n"
             << "  \"latencyFrames\": " << latency << ",\n"
             << "  \"rearTargetDb\": " << (std::isfinite(options.rearTargetDb) ? options.rearTargetDb : dbRatio(surroundEnergy, frontEnergy)) << ",\n"
             << "  \"rearCenterDb\": ";
        if (std::isfinite(options.rearCenterDb)) json << options.rearCenterDb;
        else json << "null";
        json << ",\n"
             << "  \"rearGainDb\": " << 20.0 * std::log10(std::max(1.0e-30, rearGain)) << ",\n"
             << "  \"rearGainLimited\": " << (rearGainLimited ? "true" : "false") << ",\n"
             << "  \"reconstructionErrorDb\": " << dbRatio(reconstructionError, inputEnergy) << ",\n"
             << "  \"frontNullErrorDb\": " << dbRatio(frontNullError, inputEnergy) << ",\n"
             << "  \"renderedPowerDb\": " << dbRatio(renderedEnergy, inputEnergy) << ",\n"
             << "  \"surroundPowerDb\": " << dbRatio(surroundEnergy, inputEnergy) << ",\n"
             << "  \"rearFrontRatioDb\": " << dbRatio(surroundEnergy, frontEnergy) << ",\n"
             << "  \"rearCommonModeLeakageDb\": " << dbRatio(ambientCommonEnergy, inputCommonEnergy) << ",\n"
             << "  \"vocalBandCoherence\": " << std::abs(vocalCross) / std::sqrt(std::max(1.0e-30, vocalInputEnergy * vocalAmbientEnergy)) << ",\n"
             << "  \"rearPairCorrelation\": " << rearCross / std::sqrt(std::max(1.0e-30, rearLeftEnergy * rearRightEnergy)) << ",\n"
             << "  \"samplePeakDbfs\": " << 20.0 * std::log10(std::max(1.0e-30, samplePeak)) << ",\n"
             << "  \"meanDirectness\": " << diagnostic.weightedDirectness / weight << ",\n"
             << "  \"meanDiffuseMask\": " << diagnostic.weightedDiffuseMask / weight << ",\n"
             << "  \"meanCenterConfidence\": " << diagnostic.weightedCenterConfidence / weight << ",\n"
             << "  \"meanSceneExpansion\": " << diagnostic.weightedSceneExpansion / weight << ",\n"
             << "  \"steerableShare\": " << diagnostic.steerableWeight / weight << ",\n"
             << "  \"frontLockedShare\": " << diagnostic.frontLockedWeight / weight << ",\n"
             << "  \"diffuseShare\": " << diagnostic.diffuseWeight / weight << ",\n"
             << "  \"nonFiniteSamples\": " << diagnostic.nonFiniteSamples << "\n"
             << "}\n";
        if (!json) throw std::runtime_error("Could not write diagnostic JSON");

        std::cout << "Adaptive upmix complete: " << inputFrames << " frames, "
                  << roles.size() << " channels, " << upmixer.fftSize()
                  << "-sample transform\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "adaptive_upmix_cli: " << error.what() << '\n';
        return 1;
    }
}
