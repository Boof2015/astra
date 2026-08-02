#include "playback_engine.h"

#include <algorithm>
#include <cassert>
#include <cstring>
#include <iostream>
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

    std::cout << "native playback state tests passed\n";
    return 0;
}
