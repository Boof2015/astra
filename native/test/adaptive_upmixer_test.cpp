#include "adaptive_upmixer.h"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

using Astra::Upmix::AdaptiveUpmixer;
using Astra::Upmix::Algorithm;
using Astra::Upmix::Config;
using Astra::Upmix::SpeakerRole;

namespace {

constexpr float kSampleRate = 48000.0f;
constexpr float kPi = 3.14159265358979323846f;
constexpr float kSelectedSurroundGain = 1.95112626187f;

std::vector<SpeakerRole> fiveOne() {
    return {
        SpeakerRole::FrontLeft,
        SpeakerRole::FrontRight,
        SpeakerRole::FrontCenter,
        SpeakerRole::Lfe,
        SpeakerRole::SideLeft,
        SpeakerRole::SideRight,
    };
}

std::vector<SpeakerRole> quad() {
    return {
        SpeakerRole::FrontLeft,
        SpeakerRole::FrontRight,
        SpeakerRole::SideLeft,
        SpeakerRole::SideRight,
    };
}

std::vector<SpeakerRole> sevenOne() {
    return {
        SpeakerRole::FrontLeft,
        SpeakerRole::FrontRight,
        SpeakerRole::FrontCenter,
        SpeakerRole::Lfe,
        SpeakerRole::BackLeft,
        SpeakerRole::BackRight,
        SpeakerRole::SideLeft,
        SpeakerRole::SideRight,
    };
}

double energy(const std::vector<float>& interleaved,
              size_t channels,
              size_t channel,
              size_t begin,
              size_t end) {
    double value = 0.0;
    for (size_t frame = begin; frame < end; ++frame) {
        const double sample = interleaved[frame * channels + channel];
        value += sample * sample;
    }
    return value;
}

double correlation(const std::vector<float>& interleaved,
                   size_t channels,
                   size_t leftChannel,
                   size_t rightChannel,
                   size_t begin,
                   size_t end) {
    double cross = 0.0;
    double leftEnergy = 0.0;
    double rightEnergy = 0.0;
    for (size_t frame = begin; frame < end; ++frame) {
        const double left = interleaved[frame * channels + leftChannel];
        const double right = interleaved[frame * channels + rightChannel];
        cross += left * right;
        leftEnergy += left * left;
        rightEnergy += right * right;
    }
    return cross / std::sqrt(std::max(1.0e-30, leftEnergy * rightEnergy));
}

void appendFlush(std::vector<float>& input, size_t frames) {
    input.resize(input.size() + frames * 2, 0.0f);
}

std::vector<float> process(AdaptiveUpmixer& upmixer,
                           const std::vector<float>& input,
                           std::vector<float>* stems = nullptr,
                           size_t blockSize = 0) {
    const size_t frames = input.size() / 2;
    const size_t channels = upmixer.outputChannelCount();
    std::vector<float> output(frames * channels, 0.0f);
    if (stems) stems->assign(frames * 4, 0.0f);
    if (blockSize == 0) blockSize = frames;
    for (size_t offset = 0; offset < frames; offset += blockSize) {
        const size_t count = std::min(blockSize, frames - offset);
        upmixer.process(
            input.data() + offset * 2,
            output.data() + offset * channels,
            count,
            stems ? stems->data() + offset * 4 : nullptr);
    }
    return output;
}

std::vector<float> makeSine(size_t frames, float leftGain, float rightGain) {
    std::vector<float> input(frames * 2);
    for (size_t frame = 0; frame < frames; ++frame) {
        const float sample = 0.25f * std::sin(2.0f * kPi * 997.0f *
                                             static_cast<float>(frame) / kSampleRate);
        input[frame * 2] = sample * leftGain;
        input[frame * 2 + 1] = sample * rightGain;
    }
    return input;
}

uint32_t randomState = 0x8d31a4c7u;
float noise() {
    randomState = randomState * 1664525u + 1013904223u;
    return (static_cast<float>((randomState >> 8) & 0xffffu) / 32767.5f - 1.0f) * 0.16f;
}

void assertFinite(const std::vector<float>& values) {
    for (float value : values) assert(std::isfinite(value));
}

const std::vector<Algorithm>& researchCandidates() {
    static const std::vector<Algorithm> candidates = {
        Algorithm::FixedDifference,
        Algorithm::DominantMatrix,
        Algorithm::WeightedPca,
        Algorithm::Geometric,
    };
    return candidates;
}

void testSilenceAndRoles() {
    AdaptiveUpmixer upmixer({kSampleRate, sevenOne(), Algorithm::Adaptive});
    std::vector<float> input(12000 * 2, 0.0f);
    const auto output = process(upmixer, input, nullptr, 127);
    assertFinite(output);
    for (float value : output) assert(value == 0.0f);
    assert(upmixer.diagnostics().nonFiniteSamples == 0);
}

void testPerfectReconstruction() {
    AdaptiveUpmixer upmixer({kSampleRate, fiveOne(), Algorithm::Adaptive});
    const size_t signalFrames = 24000;
    std::vector<float> input(signalFrames * 2);
    randomState = 0x21c9a63bu;
    for (float& sample : input) sample = noise();
    std::vector<float> original = input;
    appendFlush(input, upmixer.tailFrames() + upmixer.hopSize());

    std::vector<float> stems;
    process(upmixer, input, &stems, 113);
    double signalEnergy = 0.0;
    double errorEnergy = 0.0;
    for (size_t frame = 0; frame < signalFrames; ++frame) {
        for (size_t channel = 0; channel < 2; ++channel) {
            const float expected = original[frame * 2 + channel];
            const size_t stemFrame = frame + upmixer.latencyFrames();
            const float reconstructed = stems[stemFrame * 4 + channel] +
                                        stems[stemFrame * 4 + 2 + channel];
            const double error = static_cast<double>(reconstructed) - expected;
            signalEnergy += static_cast<double>(expected) * expected;
            errorEnergy += error * error;
        }
    }
    const double errorDb = 10.0 * std::log10(errorEnergy / signalEnergy + 1.0e-30);
    assert(errorDb < -100.0);
}

void testResearchCandidateReconstructionAndTransparentFronts() {
    const size_t signalFrames = 36000;
    std::vector<float> original(signalFrames * 2);
    randomState = 0x6e21b70du;
    for (float& sample : original) sample = noise();

    for (const Algorithm algorithm : researchCandidates()) {
        AdaptiveUpmixer upmixer({kSampleRate, quad(), algorithm});
        std::vector<float> input = original;
        appendFlush(input, upmixer.tailFrames() + upmixer.hopSize());
        std::vector<float> stems;
        const auto output = process(upmixer, input, &stems, 113);
        double inputEnergy = 0.0;
        double frontError = 0.0;
        double reconstructionError = 0.0;
        for (size_t frame = 0; frame < signalFrames; ++frame) {
            const size_t delayed = frame + upmixer.latencyFrames();
            for (size_t channel = 0; channel < 2; ++channel) {
                const double expected = original[frame * 2 + channel];
                const double actual = output[delayed * 4 + channel];
                const double reconstructed = stems[delayed * 4 + channel] +
                                             stems[delayed * 4 + 2 + channel];
                inputEnergy += expected * expected;
                frontError += (actual - expected) * (actual - expected);
                reconstructionError += (reconstructed - expected) *
                                       (reconstructed - expected);
            }
        }
        assert(10.0 * std::log10(frontError / inputEnergy + 1.0e-30) < -100.0);
        assert(10.0 * std::log10(reconstructionError / inputEnergy + 1.0e-30) < -100.0);
    }
}

void testResearchCandidateCenterAndHardPanRejection() {
    for (const Algorithm algorithm : researchCandidates()) {
        AdaptiveUpmixer centered({kSampleRate, quad(), algorithm});
        auto input = makeSine(60000, 1.0f, 1.0f);
        appendFlush(input, centered.tailFrames());
        const auto output = process(centered, input, nullptr, 128);
        const size_t begin = centered.latencyFrames() + 12000;
        const size_t end = centered.latencyFrames() + 56000;
        const double front = energy(output, 4, 0, begin, end) +
                             energy(output, 4, 1, begin, end);
        const double rear = energy(output, 4, 2, begin, end) +
                            energy(output, 4, 3, begin, end);
        assert(10.0 * std::log10(rear / front + 1.0e-30) < -30.0);
    }

    for (const Algorithm algorithm : {
             Algorithm::DominantMatrix, Algorithm::WeightedPca, Algorithm::Geometric}) {
        AdaptiveUpmixer hardLeft({kSampleRate, quad(), algorithm});
        auto input = makeSine(60000, 1.0f, 0.0f);
        appendFlush(input, hardLeft.tailFrames());
        const auto output = process(hardLeft, input, nullptr, 127);
        const size_t begin = hardLeft.latencyFrames() + 12000;
        const size_t end = hardLeft.latencyFrames() + 56000;
        const double front = energy(output, 4, 0, begin, end) +
                             energy(output, 4, 1, begin, end);
        const double rear = energy(output, 4, 2, begin, end) +
                            energy(output, 4, 3, begin, end);
        assert(10.0 * std::log10(rear / front + 1.0e-30) < -30.0);
    }
}

void testResearchCandidateDiffuseDecorrelation() {
    const size_t signalFrames = 96000;
    std::vector<float> fixture(signalFrames * 2);
    randomState = 0x419cb53du;
    for (float& sample : fixture) sample = noise();

    for (const Algorithm algorithm : researchCandidates()) {
        AdaptiveUpmixer upmixer({kSampleRate, quad(), algorithm});
        std::vector<float> input = fixture;
        appendFlush(input, upmixer.tailFrames());
        const auto output = process(upmixer, input, nullptr, 257);
        const size_t begin = upmixer.latencyFrames() + 16000;
        const size_t end = upmixer.latencyFrames() + signalFrames - 4096;
        assert(std::abs(correlation(output, 4, 2, 3, begin, end)) < 0.2);
        assertFinite(output);
    }
}

void testResearchCandidateAdversarialBlocksAndReset() {
    const size_t signalFrames = 60000;
    std::vector<float> fixture(signalFrames * 2);
    randomState = 0xa53e91c7u;
    for (size_t frame = 0; frame < signalFrames; ++frame) {
        const float time = static_cast<float>(frame) / kSampleRate;
        const float center = 0.10f * std::sin(2.0f * kPi * 227.0f * time);
        const float pannedLeft = 0.12f * std::sin(2.0f * kPi * 431.0f * time);
        const float pannedRight = 0.11f * std::sin(2.0f * kPi * 719.0f * time);
        const float antiPhase = 0.05f * std::sin(2.0f * kPi * 1301.0f * time);
        const float decay = std::exp(-6.0f * static_cast<float>(frame % 8000) / 8000.0f);
        const float transient = frame % 4096 == 0 ? 0.8f : 0.0f;
        fixture[frame * 2] = center + pannedLeft + 0.2f * pannedRight +
                             antiPhase + decay * noise() + transient;
        fixture[frame * 2 + 1] = center + 0.2f * pannedLeft + pannedRight -
                                 antiPhase + decay * noise() - transient * 0.2f;
    }

    for (const Algorithm algorithm : researchCandidates()) {
        AdaptiveUpmixer contiguous({kSampleRate, quad(), algorithm});
        AdaptiveUpmixer blocked({kSampleRate, quad(), algorithm});
        const auto expected = process(contiguous, fixture);
        const auto actual = process(blocked, fixture, nullptr, 37);
        assert(expected == actual);
        assertFinite(actual);
        assert(blocked.diagnostics().nonFiniteSamples == 0);

        // reset() is the seek boundary: no covariance, delay, or overlap state
        // from the previous item may survive it.
        blocked.reset();
        const auto afterSeek = process(blocked, fixture, nullptr, 113);
        assert(expected == afterSeek);
    }
}

void testResearchAlgorithmNames() {
    assert(Astra::Upmix::parseAlgorithm("dominant-matrix") == Algorithm::DominantMatrix);
    assert(Astra::Upmix::parseAlgorithm("weighted-pca") == Algorithm::WeightedPca);
    assert(Astra::Upmix::parseAlgorithm("geometric-decomposition") == Algorithm::Geometric);
    assert(std::string(Astra::Upmix::algorithmName(Algorithm::DominantMatrix)) ==
           "dominant-matrix");
    assert(Astra::Upmix::parseAlgorithm("rejected-adaptive-control") ==
           Algorithm::RejectedAdaptiveControl);
}

void testProductionMatchesWinningQuadProfile() {
    const size_t signalFrames = 72000;
    std::vector<float> input(signalFrames * 2);
    randomState = 0x9172e4a1u;
    for (size_t frame = 0; frame < signalFrames; ++frame) {
        const float time = static_cast<float>(frame) / kSampleRate;
        const float center = 0.12f * std::sin(2.0f * kPi * 311.0f * time);
        input[frame * 2] = center + noise();
        input[frame * 2 + 1] = center + noise();
    }

    AdaptiveUpmixer production({kSampleRate, quad(), Algorithm::Adaptive});
    AdaptiveUpmixer winner({kSampleRate, quad(), Algorithm::DominantMatrix});
    appendFlush(input, std::max(production.tailFrames(), winner.tailFrames()) +
                       production.hopSize());
    const auto actual = process(production, input, nullptr, 128);
    const auto baseline = process(winner, input, nullptr, 128);
    double signalEnergy = 0.0;
    double errorEnergy = 0.0;
    for (size_t frame = 0; frame < input.size() / 2; ++frame) {
        for (size_t channel = 0; channel < 4; ++channel) {
            const double expected = baseline[frame * 4 + channel] *
                (channel >= 2 ? kSelectedSurroundGain : 1.0f);
            const double error = actual[frame * 4 + channel] - expected;
            signalEnergy += expected * expected;
            errorEnergy += error * error;
        }
    }
    assert(10.0 * std::log10(errorEnergy / signalEnergy + 1.0e-30) < -100.0);
}

void testProductionCenterIsNotTriplicated() {
    const size_t signalFrames = 60000;
    AdaptiveUpmixer upmixer({kSampleRate, fiveOne(), Algorithm::Adaptive});
    auto input = makeSine(signalFrames, 1.0f, 1.0f);
    const std::vector<float> original = input;
    appendFlush(input, upmixer.tailFrames() + upmixer.hopSize());
    const auto output = process(upmixer, input, nullptr, 128);
    const size_t begin = upmixer.latencyFrames() + 12000;
    const size_t end = upmixer.latencyFrames() + signalFrames - 4096;
    double inputEnergy = 0.0;
    double foldError = 0.0;
    for (size_t delayed = begin; delayed < end; ++delayed) {
        const size_t source = delayed - upmixer.latencyFrames();
        const double left = output[delayed * 6] + output[delayed * 6 + 2] * 0.7071067811865476;
        const double right = output[delayed * 6 + 1] + output[delayed * 6 + 2] * 0.7071067811865476;
        const double expectedLeft = original[source * 2];
        const double expectedRight = original[source * 2 + 1];
        inputEnergy += expectedLeft * expectedLeft + expectedRight * expectedRight;
        foldError += (left - expectedLeft) * (left - expectedLeft) +
                     (right - expectedRight) * (right - expectedRight);
    }
    const double surround = energy(output, 6, 4, begin, end) +
                            energy(output, 6, 5, begin, end);
    assert(10.0 * std::log10(foldError / inputEnergy + 1.0e-30) < -100.0);
    assert(10.0 * std::log10(surround / inputEnergy + 1.0e-30) < -30.0);
}

void testProductionSevenOneDistributesTheApprovedBed() {
    const size_t signalFrames = 96000;
    std::vector<float> input(signalFrames * 2);
    randomState = 0x35c8af12u;
    for (size_t frame = 0; frame < signalFrames; ++frame) {
        const float center = 0.10f * std::sin(
            2.0f * kPi * 281.0f * static_cast<float>(frame) / kSampleRate);
        input[frame * 2] = center + noise();
        input[frame * 2 + 1] = center + noise();
    }

    AdaptiveUpmixer quadUpmixer({kSampleRate, quad(), Algorithm::Adaptive});
    AdaptiveUpmixer sevenUpmixer({kSampleRate, sevenOne(), Algorithm::Adaptive});
    appendFlush(input, std::max(quadUpmixer.tailFrames(), sevenUpmixer.tailFrames()) +
                       quadUpmixer.hopSize());
    const auto quadOutput = process(quadUpmixer, input, nullptr, 128);
    const auto sevenOutput = process(sevenUpmixer, input, nullptr, 128);
    const size_t begin = quadUpmixer.latencyFrames() + 16000;
    const size_t end = quadUpmixer.latencyFrames() + signalFrames - 4096;
    const double quadSurround = energy(quadOutput, 4, 2, begin, end) +
                                energy(quadOutput, 4, 3, begin, end);
    const double sevenSurround = energy(sevenOutput, 8, 4, begin, end) +
                                 energy(sevenOutput, 8, 5, begin, end) +
                                 energy(sevenOutput, 8, 6, begin, end) +
                                 energy(sevenOutput, 8, 7, begin, end);
    assert(std::abs(10.0 * std::log10(sevenSurround / quadSurround)) < 0.25);
    assert(std::abs(correlation(sevenOutput, 8, 4, 6, begin, end)) < 0.2);
    assert(std::abs(correlation(sevenOutput, 8, 5, 7, begin, end)) < 0.2);
}

void testOptionalCenterDetailLeavesTheQuadFrontUntouched() {
    const size_t signalFrames = 60000;
    Config controlConfig{kSampleRate, quad(), Algorithm::Adaptive};
    Config detailConfig{kSampleRate, quad(), Algorithm::Adaptive};
    detailConfig.surroundCenterMixGain = std::pow(10.0f, -18.0f / 20.0f);
    AdaptiveUpmixer control(controlConfig);
    AdaptiveUpmixer detail(detailConfig);
    auto input = makeSine(signalFrames, 1.0f, 1.0f);
    const std::vector<float> original = input;
    appendFlush(input, std::max(control.tailFrames(), detail.tailFrames()) + detail.hopSize());
    const auto controlOutput = process(control, input, nullptr, 128);
    const auto detailOutput = process(detail, input, nullptr, 128);
    const size_t begin = detail.latencyFrames() + 12000;
    const size_t end = detail.latencyFrames() + signalFrames - 4096;
    double inputEnergy = 0.0;
    double frontError = 0.0;
    for (size_t delayed = begin; delayed < end; ++delayed) {
        const size_t source = delayed - detail.latencyFrames();
        for (size_t channel = 0; channel < 2; ++channel) {
            const double expected = original[source * 2 + channel];
            const double error = detailOutput[delayed * 4 + channel] - expected;
            inputEnergy += expected * expected;
            frontError += error * error;
        }
    }
    const double controlRear = energy(controlOutput, 4, 2, begin, end) +
                               energy(controlOutput, 4, 3, begin, end);
    const double detailRear = energy(detailOutput, 4, 2, begin, end) +
                              energy(detailOutput, 4, 3, begin, end);
    assert(10.0 * std::log10(frontError / inputEnergy + 1.0e-30) < -100.0);
    assert(10.0 * std::log10(controlRear / inputEnergy + 1.0e-30) < -30.0);
    const double detailRatioDb = 10.0 * std::log10(detailRear / inputEnergy + 1.0e-30);
    assert(std::abs(detailRatioDb + 18.0) < 0.5);
}

void testDirectLeakage() {
    for (const auto gains : {std::pair<float, float>{1.0f, 1.0f},
                             std::pair<float, float>{1.0f, 0.0f},
                             std::pair<float, float>{0.0f, 1.0f}}) {
        AdaptiveUpmixer upmixer({kSampleRate, fiveOne(), Algorithm::Adaptive});
        const size_t signalFrames = 48000;
        auto input = makeSine(signalFrames, gains.first, gains.second);
        appendFlush(input, upmixer.tailFrames());
        const auto output = process(upmixer, input, nullptr, 128);
        const size_t begin = upmixer.latencyFrames() + 4096;
        const size_t end = upmixer.latencyFrames() + signalFrames - 2048;
        const double front = energy(output, 6, 0, begin, end) +
                             energy(output, 6, 1, begin, end) +
                             energy(output, 6, 2, begin, end);
        const double surround = energy(output, 6, 4, begin, end) +
                                energy(output, 6, 5, begin, end);
        const double leakageDb = 10.0 * std::log10(surround / front + 1.0e-30);
        assert(leakageDb < -30.0);
        assert(energy(output, 6, 3, begin, end) == 0.0); // LFE stays silent.
    }
}

void testDiffuseDecorrelationAndPower() {
    AdaptiveUpmixer upmixer({kSampleRate, fiveOne(), Algorithm::Adaptive});
    const size_t signalFrames = 96000;
    std::vector<float> input(signalFrames * 2);
    randomState = 0x19a2f46du;
    double inputEnergy = 0.0;
    for (size_t frame = 0; frame < signalFrames; ++frame) {
        const float left = noise();
        const float right = noise();
        input[frame * 2] = left;
        input[frame * 2 + 1] = right;
        inputEnergy += static_cast<double>(left) * left + static_cast<double>(right) * right;
    }
    appendFlush(input, upmixer.tailFrames());
    const auto output = process(upmixer, input, nullptr, 257);
    const size_t begin = upmixer.latencyFrames() + 12000;
    const size_t end = upmixer.latencyFrames() + signalFrames - 4096;
    const double pairCorrelation = correlation(output, 6, 4, 5, begin, end);
    assert(std::abs(pairCorrelation) < 0.2);

    double outputEnergy = 0.0;
    for (size_t channel : {size_t{0}, size_t{1}, size_t{2}, size_t{4}, size_t{5}}) {
        outputEnergy += energy(output, 6, channel, upmixer.latencyFrames(),
                               upmixer.latencyFrames() + signalFrames);
    }
    const double powerDb = 10.0 * std::log10(outputEnergy / inputEnergy + 1.0e-30);
    const double configuredPowerDb = 10.0 * std::log10(1.0 + std::pow(10.0, -6.0 / 10.0));
    assert(std::abs(powerDb - configuredPowerDb) <= 1.0);
}

void testPhaseWideMaterialCreatesAudibleBed() {
    AdaptiveUpmixer upmixer({kSampleRate, quad(), Algorithm::Adaptive});
    const size_t signalFrames = 72000;
    std::vector<float> input(signalFrames * 2);
    for (size_t frame = 0; frame < signalFrames; ++frame) {
        const float phase = 2.0f * kPi * 733.0f * static_cast<float>(frame) / kSampleRate;
        input[frame * 2] = 0.22f * std::sin(phase);
        input[frame * 2 + 1] = 0.22f * std::cos(phase);
    }
    appendFlush(input, upmixer.tailFrames());
    const auto output = process(upmixer, input, nullptr, 128);
    const size_t begin = upmixer.latencyFrames() + 10000;
    const size_t end = upmixer.latencyFrames() + signalFrames - 4096;
    const double front = energy(output, 4, 0, begin, end) +
                         energy(output, 4, 1, begin, end);
    const double surround = energy(output, 4, 2, begin, end) +
                            energy(output, 4, 3, begin, end);
    const double surroundToFrontDb = 10.0 * std::log10(surround / front + 1.0e-30);
    assert(surroundToFrontDb > -10.0);
}

void testStableLateralSourceRemainsInTheFront() {
    AdaptiveUpmixer upmixer({kSampleRate, quad(), Algorithm::Adaptive});
    const size_t signalFrames = 72000;
    auto input = makeSine(signalFrames, 1.0f, 0.35f);
    const std::vector<float> original = input;
    appendFlush(input, upmixer.tailFrames());
    const auto output = process(upmixer, input, nullptr, 128);
    const size_t begin = upmixer.latencyFrames() + 10000;
    const size_t end = upmixer.latencyFrames() + signalFrames - 4096;
    const double front = energy(output, 4, 0, begin, end) +
                         energy(output, 4, 1, begin, end);
    const double surround = energy(output, 4, 2, begin, end) +
                            energy(output, 4, 3, begin, end);
    double frontError = 0.0;
    double inputEnergy = 0.0;
    for (size_t delayed = begin; delayed < end; ++delayed) {
        const size_t source = delayed - upmixer.latencyFrames();
        for (size_t channel = 0; channel < 2; ++channel) {
            const double expected = original[source * 2 + channel];
            const double error = output[delayed * 4 + channel] - expected;
            inputEnergy += expected * expected;
            frontError += error * error;
        }
    }
    assert(10.0 * std::log10(frontError / inputEnergy + 1.0e-30) < -100.0);
    assert(10.0 * std::log10(surround / front + 1.0e-30) < -30.0);
}

void testMusicLikeFixtureHasUsefulRearActivity() {
    AdaptiveUpmixer upmixer({kSampleRate, quad(), Algorithm::Adaptive});
    const size_t signalFrames = 96000;
    std::vector<float> input(signalFrames * 2);
    randomState = 0x2f7b3c11u;
    for (size_t frame = 0; frame < signalFrames; ++frame) {
        const float time = static_cast<float>(frame) / kSampleRate;
        const float center = 0.14f * std::sin(2.0f * kPi * 223.0f * time) +
                             0.05f * std::sin(2.0f * kPi * 669.0f * time);
        const float leftInstrument = 0.10f * std::sin(2.0f * kPi * 337.0f * time);
        const float rightInstrument = 0.09f * std::sin(2.0f * kPi * 491.0f * time);
        const float diffuseLeft = 0.42f * noise();
        const float diffuseRight = 0.42f * noise();
        input[frame * 2] = center + leftInstrument + 0.28f * rightInstrument + diffuseLeft;
        input[frame * 2 + 1] = center + 0.28f * leftInstrument + rightInstrument + diffuseRight;
    }
    appendFlush(input, upmixer.tailFrames());
    const auto output = process(upmixer, input, nullptr, 127);
    const size_t begin = upmixer.latencyFrames() + 12000;
    const size_t end = upmixer.latencyFrames() + signalFrames - 4096;
    const double front = energy(output, 4, 0, begin, end) +
                         energy(output, 4, 1, begin, end);
    const double surround = energy(output, 4, 2, begin, end) +
                            energy(output, 4, 3, begin, end);
    const double surroundToFrontDb = 10.0 * std::log10(surround / front + 1.0e-30);
    assert(surroundToFrontDb > -16.0);
    assert(surroundToFrontDb < -3.0);
}

void testBlockBoundariesAndReset() {
    std::vector<float> input(36000 * 2);
    randomState = 0xb4ca91e2u;
    for (size_t frame = 0; frame < input.size() / 2; ++frame) {
        const float pulse = frame % 997 == 0 ? 0.8f : 0.0f;
        input[frame * 2] = noise() + pulse;
        input[frame * 2 + 1] = noise() - pulse * 0.25f;
    }

    AdaptiveUpmixer contiguous({kSampleRate, sevenOne(), Algorithm::Adaptive});
    AdaptiveUpmixer blocked({kSampleRate, sevenOne(), Algorithm::Adaptive});
    const auto expected = process(contiguous, input);
    const auto actual = process(blocked, input, nullptr, 73);
    assert(expected == actual);

    blocked.reset();
    const auto afterReset = process(blocked, input, nullptr, 128);
    assert(expected == afterReset);
}

void testAdversarialMaterial() {
    AdaptiveUpmixer upmixer({kSampleRate, sevenOne(), Algorithm::Adaptive});
    std::vector<float> input(48000 * 2, 0.0f);
    for (size_t frame = 0; frame < input.size() / 2; ++frame) {
        const float decay = std::exp(-5.0f * static_cast<float>(frame % 12000) / 12000.0f);
        const float first = 0.2f * decay * std::sin(2.0f * kPi * 311.0f * frame / kSampleRate);
        const float second = 0.18f * std::sin(2.0f * kPi * 1421.0f * frame / kSampleRate);
        input[frame * 2] = first + second;
        input[frame * 2 + 1] = -first + second * 0.35f;
        if (frame % 4096 == 0) input[frame * 2 + 1] += 0.9f;
    }
    const auto output = process(upmixer, input, nullptr, 31);
    assertFinite(output);
    assert(upmixer.diagnostics().nonFiniteSamples == 0);
}

void testLfeAndHeightsStaySilent() {
    const std::vector<SpeakerRole> roles = {
        SpeakerRole::FrontLeft, SpeakerRole::FrontRight, SpeakerRole::FrontCenter,
        SpeakerRole::Lfe, SpeakerRole::SideLeft, SpeakerRole::SideRight,
        SpeakerRole::Height, SpeakerRole::Height,
    };
    AdaptiveUpmixer upmixer({kSampleRate, roles, Algorithm::Adaptive});
    auto input = makeSine(24000, 1.0f, 0.7f);
    appendFlush(input, upmixer.tailFrames());
    const auto output = process(upmixer, input, nullptr, 128);
    for (size_t frame = 0; frame < input.size() / 2; ++frame) {
        assert(output[frame * roles.size() + 3] == 0.0f);
        assert(output[frame * roles.size() + 6] == 0.0f);
        assert(output[frame * roles.size() + 7] == 0.0f);
    }
}

} // namespace

int main() {
    testSilenceAndRoles();
    testPerfectReconstruction();
    testResearchCandidateReconstructionAndTransparentFronts();
    testResearchCandidateCenterAndHardPanRejection();
    testResearchCandidateDiffuseDecorrelation();
    testResearchCandidateAdversarialBlocksAndReset();
    testResearchAlgorithmNames();
    testProductionMatchesWinningQuadProfile();
    testProductionCenterIsNotTriplicated();
    testProductionSevenOneDistributesTheApprovedBed();
    testOptionalCenterDetailLeavesTheQuadFrontUntouched();
    testDirectLeakage();
    testDiffuseDecorrelationAndPower();
    testPhaseWideMaterialCreatesAudibleBed();
    testStableLateralSourceRemainsInTheFront();
    testMusicLikeFixtureHasUsefulRearActivity();
    testBlockBoundariesAndReset();
    testAdversarialMaterial();
    testLfeAndHeightsStaySilent();
    std::cout << "adaptive_upmixer_tests: ok\n";
    return 0;
}
