#include "playback_engine.h"
#include "audio_processing.h"

#include <algorithm>
#include <cassert>
#include <cstring>
#include <iostream>
#include <cmath>
#include <memory>
#include <stdexcept>
#include <vector>

namespace NativePlayback {

namespace {

class FakeExclusiveSink final : public AudioOutputSink {
public:
    bool isAvailable() const override { return true; }
    std::string backendKind() const override { return "coreaudio"; }
    std::vector<OutputDeviceInfo> enumerateOutputDevices(std::string*) const override {
        return {{"fake", "Fake Exclusive Device", 2, true}};
    }
    uint32_t deviceMaxChannels(const std::string&) const override { return 2; }
    DeviceFormatProbe probeDeviceFormats(const std::string&, uint32_t channels) const override {
        DeviceFormatProbe probe;
        probe.supported = true;
        probe.formats = {
            {44100, channels, "s16"},
            {48000, channels, "f32"},
            {48000, channels, "s32"},
            {96000, channels, "f32"}
        };
        return probe;
    }

    bool open(const std::string&, const TrackFormat& format, PlaybackEngine* engine, std::string*) override {
        engine_ = engine;
        format_ = format;
        status_.outputOpen = true;
        status_.deviceResolved = true;
        status_.exclusiveRequested = true;
        status_.backend = backendKind();
        status_.deviceId = "fake";
        status_.deviceLabel = "Fake Exclusive Device";
        status_.sourceFormat = DescribeTrackFormat(format);
        status_.processingFormat = status_.sourceFormat;
        return true;
    }

    void close() override {
        status_.outputOpen = false;
        status_.streamRunning = false;
        status_.exclusiveAcquired = false;
    }

    bool start(std::string* error) override {
        status_.formatNegotiated = true;
        status_.streamInitialized = true;
        status_.exclusiveAcquired = true;
        status_.systemMixerBypassed = true;
        status_.sourceSamplesModified = false;
        status_.wireFormatCanCarrySourceExactly = true;
        status_.wireFormat = DescribeTrackFormat(format_);
        std::vector<uint8_t> prime(format_.bytesPerFrame() * 2, 0);
        bool ended = false;
        const size_t rendered = engine_->renderInto(prime.data(), 2, ended);
        prime.resize(rendered * format_.bytesPerFrame());
        primes.push_back(prime);
        if (failNextStart) {
            failNextStart = false;
            status_.streamStarted = false;
            status_.streamRunning = false;
            status_.failureStage = "start";
            status_.failureSummary = "Fake platform start failure.";
            if (error) *error = status_.failureSummary;
            return false;
        }
        status_.streamStarted = true;
        status_.streamRunning = true;
        engine_->onPlatformStartVerified();
        status_.failureStage.clear();
        status_.failureSummary.clear();
        return true;
    }

    void pause() override {
        status_.streamStarted = false;
        status_.streamRunning = false;
        // Reservation deliberately retained.
    }
    void stop() override {
        status_.streamStarted = false;
        status_.streamRunning = false;
    }
    void reset() override { stop(); }
    NativeOutputStatus outputStatus() const override { return status_; }
    std::string activeDeviceId() const override { return "fake"; }
    std::string activeDeviceLabel() const override { return "Fake Exclusive Device"; }

    PlaybackEngine* engine_ = nullptr;
    TrackFormat format_ {};
    NativeOutputStatus status_ {};
    bool failNextStart = false;
    std::vector<std::vector<uint8_t>> primes;
};

FakeExclusiveSink* gFakeSink = nullptr;

TrackBuffer makeTrack() {
    TrackBuffer track;
    track.format = BuildTrackFormat(48000, 2, "s16");
    const int16_t samples[] = {
        0x1234, static_cast<int16_t>(-0x1234),
        0x2345, static_cast<int16_t>(-0x2345),
        0x3456, static_cast<int16_t>(-0x3456),
        0x4567, static_cast<int16_t>(-0x4567)
    };
    track.data.resize(sizeof(samples));
    std::memcpy(track.data.data(), samples, sizeof(samples));
    track.duration = 4.0 / 48000.0;
    return track;
}

TrackBuffer makeFloatSine(uint32_t sampleRate, double frequency, size_t frames, double amplitude) {
    TrackBuffer track;
    track.format = BuildTrackFormat(sampleRate, 1, "f32");
    track.data.resize(frames * sizeof(float));
    for (size_t frame = 0; frame < frames; frame++) {
        const float sample = static_cast<float>(amplitude * std::sin(
            2.0 * 3.14159265358979323846 * frequency * static_cast<double>(frame) / sampleRate));
        std::memcpy(track.data.data() + frame * sizeof(float), &sample, sizeof(sample));
    }
    track.duration = static_cast<double>(frames) / sampleRate;
    return track;
}

std::vector<uint8_t> renderProcessed(
    const TrackBuffer& track,
    const TrackFormat& outputFormat,
    const NativeDspConfig& config
) {
    ProcessedAudioPipeline pipeline;
    pipeline.configure(track.format, outputFormat, config, {}, 0);
    uint64_t sourceFrame = 0;
    bool ended = false;
    std::vector<uint8_t> result;
    std::vector<uint8_t> block(257 * outputFormat.bytesPerFrame());
    for (int iteration = 0; !ended && iteration < 10000; iteration++) {
        const size_t rendered = pipeline.render(track, sourceFrame, block.data(), 257, ended);
        result.insert(result.end(), block.begin(), block.begin() + static_cast<std::ptrdiff_t>(rendered * outputFormat.bytesPerFrame()));
        if (rendered == 0 && !ended) throw std::runtime_error("Processed pipeline stalled.");
    }
    assert(ended);
    return result;
}

double floatRms(const std::vector<uint8_t>& bytes, size_t skipFrames = 0) {
    const size_t frames = bytes.size() / sizeof(float);
    double sum = 0.0;
    size_t count = 0;
    for (size_t frame = std::min(skipFrames, frames); frame < frames; frame++) {
        float sample = 0.0f;
        std::memcpy(&sample, bytes.data() + frame * sizeof(float), sizeof(sample));
        sum += static_cast<double>(sample) * sample;
        count++;
    }
    return count == 0 ? 0.0 : std::sqrt(sum / count);
}

} // namespace

std::unique_ptr<AudioOutputSink> CreatePlatformAudioSink() {
    auto sink = std::make_unique<FakeExclusiveSink>();
    gFakeSink = sink.get();
    return sink;
}

} // namespace NativePlayback

int main() {
    using namespace NativePlayback;

    PlaybackEngine engine;
    TrackBuffer track = makeTrack();
    const std::vector<uint8_t> original = track.data;

    const TrackBuffer sine = makeFloatSine(48000, 1000.0, 48000, 0.1);
    const TrackFormat floatOutput = BuildTrackFormat(48000, 1, "f32");
    NativeDspConfig flatConfig;
    flatConfig.limiterEnabled = false;
    const auto flatOutput = renderProcessed(sine, floatOutput, flatConfig);
    NativeDspConfig boostedConfig = flatConfig;
    boostedConfig.eqEnabled = true;
    boostedConfig.eqBands.push_back({"peaking", 1000.0, 6.0, 1.0});
    const auto boostedOutput = renderProcessed(sine, floatOutput, boostedConfig);
    assert(floatRms(boostedOutput, 2000) > floatRms(flatOutput, 2000) * 1.7);

    NativeDspConfig limiterConfig;
    limiterConfig.eqEnabled = true;
    limiterConfig.preampDb = 12.0;
    limiterConfig.limiterEnabled = true;
    const auto limitedOutput = renderProcessed(makeFloatSine(48000, 997.0, 24000, 0.9), floatOutput, limiterConfig);
    float limitedPeak = 0.0f;
    for (size_t offset = 0; offset < limitedOutput.size(); offset += sizeof(float)) {
        float sample = 0.0f;
        std::memcpy(&sample, limitedOutput.data() + offset, sizeof(sample));
        limitedPeak = std::max(limitedPeak, std::abs(sample));
    }
    assert(limitedPeak <= 0.892f);

    const TrackBuffer resampleSource = makeFloatSine(44100, 1000.0, 4410, 0.1);
    const auto resampledOutput = renderProcessed(resampleSource, floatOutput, flatConfig);
    assert(resampledOutput.size() / floatOutput.bytesPerFrame() == 4800);

    const TrackBuffer silence = makeFloatSine(48000, 1000.0, 4096, 0.0);
    const TrackFormat int16Output = BuildTrackFormat(48000, 1, "s16");
    const auto ditheredOutput = renderProcessed(silence, int16Output, flatConfig);
    assert(std::any_of(ditheredOutput.begin(), ditheredOutput.end(), [](uint8_t value) { return value != 0; }));

    const uint8_t packed16[] = {0x34, 0x12, 0xCC, 0xED};
    uint8_t widened32[8] {};
    assert(WidenIntegerSamplesLeftJustified(packed16, 16, widened32, 32, 2));
    const uint8_t expected32[] = {0x00, 0x00, 0x34, 0x12, 0x00, 0x00, 0xCC, 0xED};
    assert(std::memcmp(widened32, expected32, sizeof(expected32)) == 0);

    const std::vector<ExactFormatOrderKey> formatKeys = {
        {0, true, false},
        {0, false, true},
        {1, true, true},
        {1, false, false}
    };
    const auto formatOrder = OrderExactFormatCandidates(formatKeys);
    assert((formatOrder == std::vector<size_t>{2, 1, 0, 3}));
    const auto attemptPlan = BuildExclusiveAttemptPlan(2, {100, 50}, 1000);
    assert(attemptPlan.size() == 10);
    assert(attemptPlan[0].transport == "event-driven" && attemptPlan[0].formatCandidateIndex == 0 && attemptPlan[0].requestedPeriod == 100);
    assert(attemptPlan[4].transport == "timer-driven" && !attemptPlan[4].conservative);
    assert(attemptPlan[8].transport == "timer-driven" && attemptPlan[8].conservative && attemptPlan[8].requestedPeriod == 1000);
    assert(ComputeAlignedExclusivePeriod(480, 48000, 10000000) == 100000);

    engine.loadTrack(std::move(track));

    auto snapshot = engine.getSnapshot();
    assert(snapshot.playbackState == "stopped");
    assert(!snapshot.outputStatus.bitPerfectActive);
    assert(!snapshot.outputStatus.streamRunning);

    gFakeSink->failNextStart = true;
    bool failed = false;
    try {
        engine.play();
    } catch (const std::runtime_error&) {
        failed = true;
    }
    assert(failed);
    snapshot = engine.getSnapshot();
    assert(snapshot.playbackState == "stopped");
    assert(snapshot.currentTime == 0.0);
    assert(!snapshot.outputStatus.bitPerfectActive);
    assert(gFakeSink->primes.size() == 1);
    assert(std::equal(gFakeSink->primes[0].begin(), gFakeSink->primes[0].end(), original.begin()));

    snapshot = engine.play();
    assert(snapshot.playbackState == "playing");
    assert(snapshot.outputStatus.bitPerfectActive);
    assert(gFakeSink->primes.size() == 2);
    // A failed platform start must roll back the speculative render cursor.
    assert(gFakeSink->primes[1] == gFakeSink->primes[0]);

    snapshot = engine.pause();
    assert(snapshot.playbackState == "paused");
    assert(snapshot.outputStatus.exclusiveAcquired);
    assert(!snapshot.outputStatus.streamRunning);
    assert(!snapshot.outputStatus.bitPerfectActive);

    engine.seek(2.0 / 48000.0);
    snapshot = engine.play();
    assert(snapshot.outputStatus.bitPerfectActive);
    assert(gFakeSink->primes.size() >= 3);
    const size_t seekOffset = 2 * BuildTrackFormat(48000, 2, "s16").bytesPerFrame();
    assert(std::equal(gFakeSink->primes.back().begin(), gFakeSink->primes.back().end(), original.begin() + seekOffset));

    gFakeSink->status_.streamStarted = false;
    gFakeSink->status_.streamRunning = false;
    gFakeSink->status_.failureStage = "runtime";
    gFakeSink->status_.failureSummary = "Fake device was unplugged.";
    RecomputeBitPerfectActive(gFakeSink->status_);
    engine.onNativeOutputRuntimeFailure(gFakeSink->status_.failureSummary);
    snapshot = engine.getSnapshot();
    assert(snapshot.playbackState == "paused");
    assert(!snapshot.outputStatus.bitPerfectActive);
    const auto runtimeEvents = engine.drainEvents();
    assert(std::any_of(runtimeEvents.begin(), runtimeEvents.end(), [](const PlaybackEvent& event) {
        return event.type == "outputStatusChanged" && event.message == "Fake device was unplugged.";
    }));
    assert(std::any_of(runtimeEvents.begin(), runtimeEvents.end(), [](const PlaybackEvent& event) {
        return event.type == "error" && event.message == "Fake device was unplugged.";
    }));

    gFakeSink->status_.streamRunning = true;
    gFakeSink->status_.streamStarted = true;
    snapshot = engine.play();
    assert(snapshot.playbackState == "playing");
    gFakeSink->status_.streamRunning = false;
    gFakeSink->status_.streamStarted = false;
    engine.onNativeStreamEnded();
    snapshot = engine.getSnapshot();
    assert(snapshot.playbackState == "stopped");
    assert(snapshot.currentTime == snapshot.duration);
    const auto endEvents = engine.drainEvents();
    assert(std::any_of(endEvents.begin(), endEvents.end(), [](const PlaybackEvent& event) {
        return event.type == "ended";
    }));

    snapshot = engine.stop();
    assert(snapshot.playbackState == "stopped");
    assert(!snapshot.outputStatus.streamRunning);
    assert(!snapshot.outputStatus.bitPerfectActive);

    NativeOutputRequest processedRequest;
    processedRequest.policy = OutputPolicy::Processed;
    processedRequest.requestedSampleRate = 96000;
    engine.configureOutput(processedRequest);
    gFakeSink->primes.clear();
    NativeDspConfig dspConfig;
    dspConfig.volume = 0.5;
    dspConfig.limiterEnabled = false;
    dspConfig.eqEnabled = true;
    dspConfig.eqBands.push_back({"peaking", 1000.0, 3.0, 1.0});
    engine.setDspConfig(dspConfig);
    engine.loadTrack(makeTrack());
    assert(gFakeSink != nullptr);
    gFakeSink->failNextStart = true;
    failed = false;
    try {
        engine.play();
    } catch (const std::runtime_error&) {
        failed = true;
    }
    assert(failed);
    assert(gFakeSink->primes.size() == 1);
    const auto failedProcessedPrime = gFakeSink->primes.front();
    snapshot = engine.play();
    assert(snapshot.outputStatus.processing.exclusiveActive);
    assert(snapshot.outputStatus.processing.processingActive);
    assert(snapshot.outputStatus.processing.resamplingActive);
    assert(snapshot.outputStatus.processing.outputPolicy == "processed");
    assert(snapshot.outputStatus.sourceSamplesModified);
    assert(!snapshot.outputStatus.bitPerfectActive);
    assert(gFakeSink->primes.size() == 2);
    assert(gFakeSink->primes.back() == failedProcessedPrime);

    // DSP settings must never leak into the direct renderer.
    engine.stop();
    NativeOutputRequest directRequest;
    directRequest.policy = OutputPolicy::Direct;
    engine.configureOutput(directRequest);
    gFakeSink->primes.clear();
    dspConfig.volume = 0.1;
    dspConfig.preampDb = 12.0;
    dspConfig.limiterEnabled = true;
    engine.setDspConfig(dspConfig);
    engine.loadTrack(makeTrack());
    snapshot = engine.play();
    assert(snapshot.outputStatus.bitPerfectActive);
    assert(gFakeSink->primes.size() == 1);
    assert(std::equal(gFakeSink->primes[0].begin(), gFakeSink->primes[0].end(), original.begin()));

    std::cout << "native playback state tests passed\n";
    return 0;
}
