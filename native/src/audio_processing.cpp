#include "audio_processing.h"

#include "CDSPResampler.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <vector>

namespace NativePlayback {
namespace {

constexpr size_t kInputChunkFrames = 1024;
constexpr double kPi = 3.1415926535897932384626433832795;
constexpr double kLimiterCeiling = 0.8912509381337456; // -1 dBTP
constexpr double kGainRampSeconds = 0.010;
constexpr double kEqCrossfadeSeconds = 0.020;
constexpr double kLimiterReleaseSeconds = 0.100;

double dbToLinear(double db) {
    return std::pow(10.0, db / 20.0);
}

double decodeSample(const uint8_t* source, SampleFormat format) {
    switch (format) {
        case SampleFormat::Int16: {
            int16_t value = 0;
            std::memcpy(&value, source, sizeof(value));
            return static_cast<double>(value) / 32768.0;
        }
        case SampleFormat::Int24Packed: {
            int32_t value = static_cast<int32_t>(source[0])
                | (static_cast<int32_t>(source[1]) << 8)
                | (static_cast<int32_t>(source[2]) << 16);
            if ((value & 0x00800000) != 0) value |= ~0x00ffffff;
            return static_cast<double>(value) / 8388608.0;
        }
        case SampleFormat::Int32: {
            int32_t value = 0;
            std::memcpy(&value, source, sizeof(value));
            return static_cast<double>(value) / 2147483648.0;
        }
        case SampleFormat::Float32: {
            float value = 0.0f;
            std::memcpy(&value, source, sizeof(value));
            return std::isfinite(value) ? static_cast<double>(value) : 0.0;
        }
    }
    return 0.0;
}

struct BiquadCoefficients {
    double b0 = 1.0;
    double b1 = 0.0;
    double b2 = 0.0;
    double a1 = 0.0;
    double a2 = 0.0;
};

struct BiquadState {
    BiquadCoefficients coefficients;
    double z1 = 0.0;
    double z2 = 0.0;

    double process(double input) {
        const double output = coefficients.b0 * input + z1;
        z1 = coefficients.b1 * input - coefficients.a1 * output + z2;
        z2 = coefficients.b2 * input - coefficients.a2 * output;
        return output;
    }
};

BiquadCoefficients makeBiquad(const DspEqBand& band, double sampleRate) {
    const double frequency = std::clamp(band.frequency, 20.0, std::max(20.0, sampleRate * 0.49));
    const double q = std::clamp(band.q, 0.1, 18.0);
    const double gain = std::clamp(band.gain, -12.0, 12.0);
    const double w0 = 2.0 * kPi * frequency / sampleRate;
    const double sine = std::sin(w0);
    const double cosine = std::cos(w0);
    const double alpha = sine / (2.0 * q);
    const double a = std::pow(10.0, gain / 40.0);
    double b0 = 1.0, b1 = 0.0, b2 = 0.0, a0 = 1.0, a1 = 0.0, a2 = 0.0;

    if (band.type == "peaking") {
        b0 = 1.0 + alpha * a; b1 = -2.0 * cosine; b2 = 1.0 - alpha * a;
        a0 = 1.0 + alpha / a; a1 = -2.0 * cosine; a2 = 1.0 - alpha / a;
    } else if (band.type == "lowshelf" || band.type == "highshelf") {
        const double rootA = std::sqrt(a);
        if (band.type == "lowshelf") {
            b0 = a * ((a + 1.0) - (a - 1.0) * cosine + 2.0 * rootA * alpha);
            b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cosine);
            b2 = a * ((a + 1.0) - (a - 1.0) * cosine - 2.0 * rootA * alpha);
            a0 = (a + 1.0) + (a - 1.0) * cosine + 2.0 * rootA * alpha;
            a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cosine);
            a2 = (a + 1.0) + (a - 1.0) * cosine - 2.0 * rootA * alpha;
        } else {
            b0 = a * ((a + 1.0) + (a - 1.0) * cosine + 2.0 * rootA * alpha);
            b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cosine);
            b2 = a * ((a + 1.0) + (a - 1.0) * cosine - 2.0 * rootA * alpha);
            a0 = (a + 1.0) - (a - 1.0) * cosine + 2.0 * rootA * alpha;
            a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cosine);
            a2 = (a + 1.0) - (a - 1.0) * cosine - 2.0 * rootA * alpha;
        }
    } else if (band.type == "highpass") {
        b0 = (1.0 + cosine) / 2.0; b1 = -(1.0 + cosine); b2 = b0;
        a0 = 1.0 + alpha; a1 = -2.0 * cosine; a2 = 1.0 - alpha;
    } else if (band.type == "lowpass") {
        b0 = (1.0 - cosine) / 2.0; b1 = 1.0 - cosine; b2 = b0;
        a0 = 1.0 + alpha; a1 = -2.0 * cosine; a2 = 1.0 - alpha;
    }

    return {b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0};
}

uint32_t nextRandom(uint32_t& state) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return state;
}

double uniformSigned(uint32_t& state) {
    return static_cast<double>(nextRandom(state)) / 4294967296.0 - 0.5;
}

const char* gainModeId(TrackGainMode mode) {
    switch (mode) {
        case TrackGainMode::Normalization: return "normalization";
        case TrackGainMode::ReplayGain: return "replaygain";
        case TrackGainMode::Off:
        default: return "off";
    }
}

} // namespace

struct ProcessedAudioPipeline::Impl {
    TrackFormat sourceFormat {};
    TrackFormat outputFormat {};
    NativeDspConfig config {};
    NativeTrackGain trackGain {};
    uint64_t startSourceFrame = 0;
    uint64_t expectedOutputFrames = 0;
    uint64_t emittedOutputFrames = 0;
    bool inputExhausted = false;
    bool flushed = false;
    std::vector<std::unique_ptr<r8b::CDSPResampler>> resamplers;
    std::vector<std::vector<double>> inputPlanar;
    TrackFormat preparedSourceFormat {};
    std::vector<std::unique_ptr<r8b::CDSPResampler>> preparedResamplers;
    std::vector<std::vector<double>> preparedInputPlanar;
    std::vector<std::vector<double>> resampled;
    size_t resampledOffset = 0;
    std::vector<double> processedInterleaved;
    size_t processedOffsetFrames = 0;
    std::vector<std::vector<BiquadState>> filters;
    std::vector<std::vector<BiquadState>> oldFilters;
    bool oldEqEnabled = false;
    double oldPreampDb = 0.0;
    size_t eqCrossfadeFrames = 0;
    size_t eqCrossfadeRemaining = 0;
    double currentVolume = 1.0;
    double targetVolume = 1.0;
    double volumeStep = 0.0;
    size_t volumeRampRemaining = 0;
    double currentTrackGain = 1.0;
    double targetTrackGain = 1.0;
    double trackGainStep = 0.0;
    size_t trackGainRampRemaining = 0;
    double limiterGain = 1.0;
    double limiterGainReductionDb = 0.0;
    uint64_t clippedSamples = 0;
    uint32_t ditherState = 0x9e3779b9u;

    void rebuildFilters() {
        filters.assign(outputFormat.channels, {});
        if (!config.eqEnabled) return;
        const size_t bandCount = std::min<size_t>(20, config.eqBands.size());
        for (auto& channelFilters : filters) {
            channelFilters.reserve(bandCount);
            for (size_t index = 0; index < bandCount; index++) {
                BiquadState state;
                state.coefficients = makeBiquad(config.eqBands[index], outputFormat.sampleRate);
                channelFilters.push_back(state);
            }
        }
    }

    void resetState(uint64_t sourceFrame) {
        startSourceFrame = sourceFrame;
        expectedOutputFrames = 0;
        emittedOutputFrames = 0;
        inputExhausted = false;
        flushed = false;
        resampled.clear();
        resampled.resize(outputFormat.channels);
        for (auto& channel : resampled) channel.reserve(kInputChunkFrames * 16);
        resampledOffset = 0;
        processedInterleaved.clear();
        processedInterleaved.reserve(kInputChunkFrames * 16 * std::max<uint32_t>(1, outputFormat.channels));
        processedOffsetFrames = 0;
        oldFilters.clear();
        oldEqEnabled = false;
        eqCrossfadeFrames = 0;
        eqCrossfadeRemaining = 0;
        limiterGain = 1.0;
        limiterGainReductionDb = 0.0;
        clippedSamples = 0;
        ditherState = 0x9e3779b9u;
        const double remainingSource = 0.0; // assigned when the track is first rendered
        (void) remainingSource;
        for (auto& resampler : resamplers) resampler->clear();
        rebuildFilters();
        currentVolume = std::clamp(config.muted ? 0.0 : config.volume, 0.0, 1.0);
        targetVolume = currentVolume;
        volumeStep = 0.0;
        volumeRampRemaining = 0;
        currentTrackGain = dbToLinear(trackGain.gainDb);
        targetTrackGain = currentTrackGain;
        trackGainStep = 0.0;
        trackGainRampRemaining = 0;
    }

    void configureResamplers() {
        resamplers.clear();
        inputPlanar.assign(sourceFormat.channels, std::vector<double>(kInputChunkFrames));
        if (sourceFormat.sampleRate == outputFormat.sampleRate) return;
        resamplers.reserve(sourceFormat.channels);
        for (uint32_t channel = 0; channel < sourceFormat.channels; channel++) {
            resamplers.push_back(std::make_unique<r8b::CDSPResampler>(
                sourceFormat.sampleRate,
                outputFormat.sampleRate,
                static_cast<int>(kInputChunkFrames),
                2.0,
                160.0,
                r8b::fprLinearPhase
            ));
        }
    }

    void prepareResamplers(const TrackFormat& format) {
        preparedSourceFormat = format;
        preparedResamplers.clear();
        preparedInputPlanar.assign(format.channels, std::vector<double>(kInputChunkFrames));
        if (format.sampleRate == outputFormat.sampleRate) return;
        preparedResamplers.reserve(format.channels);
        for (uint32_t channel = 0; channel < format.channels; channel++) {
            preparedResamplers.push_back(std::make_unique<r8b::CDSPResampler>(
                format.sampleRate,
                outputFormat.sampleRate,
                static_cast<int>(kInputChunkFrames),
                2.0,
                160.0,
                r8b::fprLinearPhase
            ));
        }
    }

    void resetTrackQueues(uint64_t sourceFrame) {
        startSourceFrame = sourceFrame;
        expectedOutputFrames = 0;
        emittedOutputFrames = 0;
        inputExhausted = false;
        flushed = false;
        if (resampled.size() != outputFormat.channels) resampled.resize(outputFormat.channels);
        for (auto& channel : resampled) {
            channel.clear();
            if (channel.capacity() < kInputChunkFrames * 16) channel.reserve(kInputChunkFrames * 16);
        }
        resampledOffset = 0;
        processedInterleaved.clear();
        processedOffsetFrames = 0;
    }

    void scheduleTrackGain(const NativeTrackGain& gain) {
        trackGain = gain;
        targetTrackGain = dbToLinear(trackGain.gainDb);
        const size_t rampFrames = std::max<size_t>(1, static_cast<size_t>(outputFormat.sampleRate * kEqCrossfadeSeconds));
        trackGainRampRemaining = rampFrames;
        trackGainStep = (targetTrackGain - currentTrackGain) / static_cast<double>(rampFrames);
    }

    size_t availableResampledFrames() const {
        if (resampled.empty()) return 0;
        return resampled[0].size() > resampledOffset ? resampled[0].size() - resampledOffset : 0;
    }

    int resamplerLatencyFrames() const {
        return resamplers.empty() ? 0 : std::max(0, resamplers.front()->getLatency());
    }

    size_t availableProcessedFrames() const {
        const size_t total = outputFormat.channels == 0 ? 0 : processedInterleaved.size() / outputFormat.channels;
        return total > processedOffsetFrames ? total - processedOffsetFrames : 0;
    }

    void compactQueues() {
        if (resampledOffset > 4096 && !resampled.empty()) {
            for (auto& channel : resampled) channel.erase(channel.begin(), channel.begin() + static_cast<std::ptrdiff_t>(resampledOffset));
            resampledOffset = 0;
        }
        if (processedOffsetFrames > 4096 && outputFormat.channels > 0) {
            const size_t samples = processedOffsetFrames * outputFormat.channels;
            processedInterleaved.erase(processedInterleaved.begin(), processedInterleaved.begin() + static_cast<std::ptrdiff_t>(samples));
            processedOffsetFrames = 0;
        }
    }

    void appendInput(const TrackBuffer& track, uint64_t& sourceFrame) {
        const uint64_t totalSourceFrames = track.totalFrames();
        if (sourceFrame >= totalSourceFrames) {
            inputExhausted = true;
        }
        const size_t frames = inputExhausted ? kInputChunkFrames : static_cast<size_t>(std::min<uint64_t>(kInputChunkFrames, totalSourceFrames - sourceFrame));
        if (frames == 0) return;

        for (uint32_t channel = 0; channel < sourceFormat.channels; channel++) {
            auto& input = inputPlanar[channel];
            for (size_t frame = 0; frame < frames; frame++) {
                if (inputExhausted) {
                    input[frame] = 0.0;
                } else {
                    const size_t byteOffset = static_cast<size_t>(sourceFrame + frame) * sourceFormat.bytesPerFrame()
                        + channel * sourceFormat.bytesPerSample();
                    input[frame] = decodeSample(track.data.data() + byteOffset, sourceFormat.sampleFormat);
                }
            }
        }
        if (!inputExhausted) sourceFrame += frames;

        if (resamplers.empty()) {
            for (uint32_t channel = 0; channel < sourceFormat.channels; channel++) {
                auto& queue = resampled[channel];
                queue.insert(queue.end(), inputPlanar[channel].begin(), inputPlanar[channel].begin() + static_cast<std::ptrdiff_t>(frames));
            }
        } else {
            for (uint32_t channel = 0; channel < sourceFormat.channels; channel++) {
                double* output = nullptr;
                const int outputCount = resamplers[channel]->process(inputPlanar[channel].data(), static_cast<int>(frames), output);
                if (outputCount > 0 && output != nullptr) {
                    resampled[channel].insert(resampled[channel].end(), output, output + outputCount);
                }
            }
        }

        if (inputExhausted) flushed = true;
    }

    void processAvailable(size_t desiredFrames) {
        const size_t available = availableResampledFrames();
        const size_t toProcess = std::min(available, desiredFrames);
        if (toProcess == 0) return;
        const size_t channels = outputFormat.channels;
        processedInterleaved.reserve(processedInterleaved.size() + toProcess * channels);

        for (size_t frame = 0; frame < toProcess; frame++) {
            if (volumeRampRemaining > 0) {
                currentVolume += volumeStep;
                volumeRampRemaining--;
                if (volumeRampRemaining == 0) currentVolume = targetVolume;
            }
            if (trackGainRampRemaining > 0) {
                currentTrackGain += trackGainStep;
                if (--trackGainRampRemaining == 0) currentTrackGain = targetTrackGain;
            }
            for (size_t channel = 0; channel < channels; channel++) {
                const double baseValue = resampled[channel][resampledOffset + frame] * currentTrackGain;
                double value = baseValue * dbToLinear(config.eqEnabled ? config.preampDb : 0.0);
                for (auto& filter : filters[channel]) value = filter.process(value);
                if (eqCrossfadeRemaining > 0) {
                    double oldValue = baseValue * dbToLinear(oldEqEnabled ? oldPreampDb : 0.0);
                    if (channel < oldFilters.size()) {
                        for (auto& filter : oldFilters[channel]) oldValue = filter.process(oldValue);
                    }
                    const double alpha = 1.0 - static_cast<double>(eqCrossfadeRemaining)
                        / static_cast<double>(std::max<size_t>(1, eqCrossfadeFrames));
                    value = oldValue * (1.0 - alpha) + value * alpha;
                }
                processedInterleaved.push_back(value * currentVolume);
            }
            if (eqCrossfadeRemaining > 0 && --eqCrossfadeRemaining == 0) oldFilters.clear();
        }
        resampledOffset += toProcess;
    }

    double futurePeak(size_t frames) const {
        const size_t channels = outputFormat.channels;
        double peak = 0.0;
        const size_t available = std::min(frames, availableProcessedFrames());
        if (available == 0) return peak;
        const auto at = [&](ptrdiff_t frame, size_t channel) {
            const ptrdiff_t bounded = std::clamp<ptrdiff_t>(frame, 0, static_cast<ptrdiff_t>(available - 1));
            return processedInterleaved[(processedOffsetFrames + static_cast<size_t>(bounded)) * channels + channel];
        };
        for (size_t frame = 0; frame < available; frame++) {
            for (size_t channel = 0; channel < channels; channel++) {
                const double p0 = at(static_cast<ptrdiff_t>(frame) - 1, channel);
                const double p1 = at(static_cast<ptrdiff_t>(frame), channel);
                const double p2 = at(static_cast<ptrdiff_t>(frame) + 1, channel);
                const double p3 = at(static_cast<ptrdiff_t>(frame) + 2, channel);
                for (int phase = 0; phase < 4; phase++) {
                    const double t = static_cast<double>(phase) / 4.0;
                    const double t2 = t * t;
                    const double t3 = t2 * t;
                    const double interpolated = 0.5 * ((2.0 * p1)
                        + (-p0 + p2) * t
                        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
                        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
                    peak = std::max(peak, std::abs(interpolated));
                }
            }
        }
        return peak;
    }

    void writeSample(uint8_t* destination, double value) {
        const double limited = std::clamp(value, -1.0, std::nextafter(1.0, 0.0));
        if (limited != value) clippedSamples++;
        switch (outputFormat.sampleFormat) {
            case SampleFormat::Float32: {
                const float sample = static_cast<float>(limited);
                std::memcpy(destination, &sample, sizeof(sample));
                break;
            }
            case SampleFormat::Int16: {
                const double dither = (uniformSigned(ditherState) + uniformSigned(ditherState)) / 32768.0;
                const int16_t sample = static_cast<int16_t>(std::clamp(std::llround((limited + dither) * 32768.0), -32768ll, 32767ll));
                std::memcpy(destination, &sample, sizeof(sample));
                break;
            }
            case SampleFormat::Int24Packed: {
                const double dither = (uniformSigned(ditherState) + uniformSigned(ditherState)) / 8388608.0;
                const int32_t sample = static_cast<int32_t>(std::clamp(std::llround((limited + dither) * 8388608.0), -8388608ll, 8388607ll));
                destination[0] = static_cast<uint8_t>(sample & 0xff);
                destination[1] = static_cast<uint8_t>((sample >> 8) & 0xff);
                destination[2] = static_cast<uint8_t>((sample >> 16) & 0xff);
                break;
            }
            case SampleFormat::Int32: {
                const double dither = (uniformSigned(ditherState) + uniformSigned(ditherState)) / 2147483648.0;
                const int64_t quantized = std::clamp(std::llround((limited + dither) * 2147483648.0), -2147483648ll, 2147483647ll);
                const int32_t sample = static_cast<int32_t>(quantized);
                std::memcpy(destination, &sample, sizeof(sample));
                break;
            }
        }
    }
};

ProcessedAudioPipeline::ProcessedAudioPipeline() : impl_(std::make_unique<Impl>()) {}
ProcessedAudioPipeline::~ProcessedAudioPipeline() = default;

void ProcessedAudioPipeline::configure(
    const TrackFormat& sourceFormat,
    const TrackFormat& outputFormat,
    const NativeDspConfig& config,
    const NativeTrackGain& gain,
    uint64_t sourceFrame
) {
    impl_->sourceFormat = sourceFormat;
    impl_->outputFormat = outputFormat;
    impl_->config = config;
    impl_->config.volume = std::clamp(config.volume, 0.0, 1.0);
    impl_->config.preampDb = std::clamp(config.preampDb, -12.0, 12.0);
    if (impl_->config.eqBands.size() > 20) impl_->config.eqBands.resize(20);
    impl_->trackGain = gain;
    impl_->configureResamplers();
    impl_->resetState(sourceFrame);
}

void ProcessedAudioPipeline::updateDspConfig(const NativeDspConfig& config) {
    const double oldTarget = impl_->targetVolume;
    impl_->oldFilters = std::move(impl_->filters);
    impl_->oldEqEnabled = impl_->config.eqEnabled;
    impl_->oldPreampDb = impl_->config.preampDb;
    impl_->config = config;
    impl_->config.volume = std::clamp(config.volume, 0.0, 1.0);
    impl_->config.preampDb = std::clamp(config.preampDb, -12.0, 12.0);
    if (impl_->config.eqBands.size() > 20) impl_->config.eqBands.resize(20);
    impl_->targetVolume = impl_->config.muted ? 0.0 : impl_->config.volume;
    const size_t rampFrames = std::max<size_t>(1, static_cast<size_t>(impl_->outputFormat.sampleRate * kGainRampSeconds));
    impl_->volumeRampRemaining = rampFrames;
    impl_->volumeStep = (impl_->targetVolume - impl_->currentVolume) / static_cast<double>(rampFrames);
    if (oldTarget == impl_->targetVolume) {
        impl_->volumeRampRemaining = 0;
        impl_->volumeStep = 0.0;
    }
    impl_->rebuildFilters();
    impl_->eqCrossfadeFrames = std::max<size_t>(1, static_cast<size_t>(impl_->outputFormat.sampleRate * kEqCrossfadeSeconds));
    impl_->eqCrossfadeRemaining = impl_->eqCrossfadeFrames;
}

void ProcessedAudioPipeline::updateTrackGain(const NativeTrackGain& gain) {
    impl_->scheduleTrackGain(gain);
}

void ProcessedAudioPipeline::prepareGaplessTrack(const TrackFormat& sourceFormat) {
    impl_->prepareResamplers(sourceFormat);
}

void ProcessedAudioPipeline::beginGaplessTrack(const TrackFormat& sourceFormat, const NativeTrackGain& gain) {
    impl_->sourceFormat = sourceFormat;
    impl_->scheduleTrackGain(gain);
    if (impl_->preparedSourceFormat.sampleRate == sourceFormat.sampleRate
        && impl_->preparedSourceFormat.channels == sourceFormat.channels
        && impl_->preparedSourceFormat.sampleFormat == sourceFormat.sampleFormat) {
        impl_->resamplers = std::move(impl_->preparedResamplers);
        impl_->inputPlanar = std::move(impl_->preparedInputPlanar);
        impl_->preparedSourceFormat = {};
    } else {
        impl_->configureResamplers();
    }
    impl_->resetTrackQueues(0);
}

void ProcessedAudioPipeline::reset(uint64_t sourceFrame) {
    impl_->resetState(sourceFrame);
}

size_t ProcessedAudioPipeline::render(
    const TrackBuffer& track,
    uint64_t& sourceFrame,
    void* output,
    size_t requestedFrames,
    bool& streamEnded
) {
    streamEnded = false;
    if (requestedFrames == 0 || output == nullptr || impl_->outputFormat.channels == 0) return 0;
    if (impl_->expectedOutputFrames == 0) {
        const uint64_t remaining = track.totalFrames() > impl_->startSourceFrame
            ? track.totalFrames() - impl_->startSourceFrame
            : 0;
        impl_->expectedOutputFrames = static_cast<uint64_t>(std::llround(
            static_cast<double>(remaining) * impl_->outputFormat.sampleRate / impl_->sourceFormat.sampleRate
        ));
    }
    const uint64_t remainingOutput = impl_->expectedOutputFrames > impl_->emittedOutputFrames
        ? impl_->expectedOutputFrames - impl_->emittedOutputFrames
        : 0;
    const size_t wanted = static_cast<size_t>(std::min<uint64_t>(requestedFrames, remainingOutput));
    const size_t lookaheadFrames = impl_->config.limiterEnabled
        ? std::max<size_t>(1, static_cast<size_t>(impl_->outputFormat.sampleRate * 0.005))
        : 0;

    while (impl_->availableProcessedFrames() < wanted + lookaheadFrames && impl_->emittedOutputFrames + impl_->availableProcessedFrames() < impl_->expectedOutputFrames) {
        if (impl_->availableResampledFrames() == 0) impl_->appendInput(track, sourceFrame);
        const size_t before = impl_->availableProcessedFrames();
        impl_->processAvailable(wanted + lookaheadFrames - before);
        if (before == impl_->availableProcessedFrames() && impl_->flushed) break;
    }

    const size_t frames = std::min(wanted, impl_->availableProcessedFrames());
    const size_t channels = impl_->outputFormat.channels;
    const double peak = impl_->futurePeak(frames + lookaheadFrames);
    const double targetLimiterGain = impl_->config.limiterEnabled && peak > kLimiterCeiling
        ? kLimiterCeiling / peak
        : 1.0;
    if (targetLimiterGain < impl_->limiterGain) {
        impl_->limiterGain = targetLimiterGain;
    }
    const double release = 1.0 - std::exp(-1.0 / (impl_->outputFormat.sampleRate * kLimiterReleaseSeconds));
    uint8_t* bytes = static_cast<uint8_t*>(output);
    for (size_t frame = 0; frame < frames; frame++) {
        if (impl_->limiterGain < targetLimiterGain) {
            impl_->limiterGain += (targetLimiterGain - impl_->limiterGain) * release;
        }
        for (size_t channel = 0; channel < channels; channel++) {
            const double sample = impl_->processedInterleaved[(impl_->processedOffsetFrames + frame) * channels + channel]
                * (impl_->config.limiterEnabled ? impl_->limiterGain : 1.0);
            impl_->writeSample(bytes + (frame * channels + channel) * impl_->outputFormat.bytesPerSample(), sample);
        }
    }
    impl_->limiterGainReductionDb = impl_->limiterGain > 0.0 ? -20.0 * std::log10(impl_->limiterGain) : 120.0;
    impl_->processedOffsetFrames += frames;
    impl_->emittedOutputFrames += frames;
    impl_->compactQueues();
    streamEnded = impl_->emittedOutputFrames >= impl_->expectedOutputFrames;
    return frames;
}

NativeProcessingStatus ProcessedAudioPipeline::status() const {
    NativeProcessingStatus status;
    status.outputPolicy = "processed";
    status.processingActive = true;
    status.resamplingActive = impl_->sourceFormat.sampleRate != impl_->outputFormat.sampleRate;
    status.resamplerName = status.resamplingActive ? "r8brain-free-src 7.1" : "bypassed";
    status.resamplerQuality = status.resamplingActive ? "linear phase, 2% transition, 160 dB" : "source rate";
    status.sourceSampleRate = static_cast<int>(impl_->sourceFormat.sampleRate);
    status.targetSampleRate = static_cast<int>(impl_->outputFormat.sampleRate);
    status.processingLatencyFrames = impl_->resamplerLatencyFrames()
        + (impl_->config.limiterEnabled ? static_cast<int>(impl_->outputFormat.sampleRate * 0.005) : 0);
    status.gainMode = gainModeId(impl_->trackGain.mode);
    status.trackGainDb = impl_->trackGain.gainDb;
    status.preampDb = impl_->config.eqEnabled ? impl_->config.preampDb : 0.0;
    status.volume = impl_->config.volume;
    status.muted = impl_->config.muted;
    status.eqEnabled = impl_->config.eqEnabled;
    status.eqBandCount = impl_->config.eqEnabled ? static_cast<int>(std::min<size_t>(20, impl_->config.eqBands.size())) : 0;
    status.limiterEnabled = impl_->config.limiterEnabled;
    status.limiterGainReductionDb = impl_->limiterGainReductionDb;
    status.dither = impl_->outputFormat.sampleFormat == SampleFormat::Float32 ? "none" : "decorrelated TPDF";
    status.clippedSamples = impl_->clippedSamples;
    return status;
}

const TrackFormat& ProcessedAudioPipeline::outputFormat() const {
    return impl_->outputFormat;
}

} // namespace NativePlayback
