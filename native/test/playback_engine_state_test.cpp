#include "playback_engine.h"
#include "audio_processing.h"
#include "progressive_pcm_input.h"
#include "endpoint_pcm_writer.h"

#include <algorithm>
#include <array>
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <chrono>
#include <cstring>
#include <functional>
#include <future>
#include <iostream>
#include <cmath>
#include <memory>
#include <stdexcept>
#include <thread>
#include <vector>

namespace NativePlayback {

void RunEndpointFrameQueueTests();

namespace {

class FakeExclusiveSink final : public AudioOutputSink {
public:
    bool isAvailable() const override { return true; }
    std::string backendKind() const override { return "coreaudio"; }
    std::vector<OutputDeviceInfo> enumerateOutputDevices(std::string*) const override {
        return {{"fake", "Fake Exclusive Device", 2, true}};
    }
    uint32_t deviceMaxChannels(const std::string& deviceId) const override {
        return onDeviceMaxChannels ? onDeviceMaxChannels(deviceId) : 2;
    }
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
        std::vector<uint8_t> prime(format_.bytesPerFrame() * primeFrames, 0);
        bool ended = false;
        const size_t rendered = engine_->renderInto(prime.data(), primeFrames, ended);
        prime.resize(rendered * format_.bytesPerFrame());
        primes.push_back(prime);
        if (consumeDuringStart) engine_->onFramesConsumed(rendered);
        if (signalEndDuringStart && ended) engine_->onNativeStreamEnded();
        if (afterPrime) afterPrime();
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
        if (onPause) onPause();
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
    size_t primeFrames = 2;
    bool consumeDuringStart = false;
    bool signalEndDuringStart = false;
    std::function<void()> afterPrime;
    std::function<void()> onPause;
    std::function<uint32_t(const std::string&)> onDeviceMaxChannels;
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

void testDeviceCapabilityQueryAllowsRendering() {
    for (const auto policy : {OutputPolicy::Direct, OutputPolicy::Processed}) {
        PlaybackEngine engine;
        NativeOutputRequest request;
        request.policy = policy;
        engine.configureOutput(request);
        engine.setSelectedDeviceId("selected-device");
        engine.loadTrack(makeFloatSine(48000, 1000, 48000, 0.1));
        engine.play();

        std::promise<void> queryEntered;
        auto queryEnteredFuture = queryEntered.get_future();
        std::promise<void> renderFinished;
        auto renderFinishedFuture = renderFinished.get_future();
        bool renderedDuringQuery = false;
        std::string queriedDeviceId;
        gFakeSink->onDeviceMaxChannels = [&](const std::string& deviceId) {
            queriedDeviceId = deviceId;
            queryEntered.set_value();
            // Model a platform property query waiting for its IO callback.
            // The timeout lets a broken implementation unwind and join safely.
            renderedDuringQuery = renderFinishedFuture.wait_for(std::chrono::seconds(2))
                == std::future_status::ready;
            return 6u;
        };
        size_t renderedFrames = 0;
        std::thread callback([&]() {
            queryEnteredFuture.wait();
            float output[64] {};
            bool ended = false;
            renderedFrames = engine.renderInto(output, 64, ended);
            engine.onFramesConsumed(renderedFrames);
            renderFinished.set_value();
        });

        const uint32_t maxChannels = engine.getSelectedDeviceMaxChannels();
        callback.join();
        gFakeSink->onDeviceMaxChannels = {};
        assert(queriedDeviceId == "selected-device");
        assert(maxChannels == 6);
        assert(renderedFrames == 64);
        assert(renderedDuringQuery && "Device capability queries must not block the audio callback");
    }
}

void testVisualizerTransport() {
    for (uint32_t channels : {1u, 2u, 6u}) {
        PlaybackEngine engine;
        TrackBuffer track;
        track.format = BuildTrackFormat(48000, channels, "f32");
        constexpr size_t frames = 40000;
        track.duration = static_cast<double>(frames) / 48000;
        track.data.resize(frames * channels * sizeof(float));
        for (size_t i = 0; i < frames; ++i) {
            for (uint32_t c = 0; c < channels; ++c) {
                const float value = 0.1f * (c + 1) + static_cast<float>(i) / 1000000.0f;
                std::memcpy(track.data.data() + (i * channels + c) * sizeof(float), &value, sizeof(value));
            }
        }
        engine.loadTrack(track);
        engine.setVisualizerTapDemand({true, true, true, true});
        engine.play(); // The fake sink primes two frames before Playing.
        std::vector<float> output(frames * channels);
        bool ended = false;
        const size_t rendered = engine.renderInto(output.data(), 100, ended);
        assert(rendered == 100);
        assert(std::memcmp(output.data(), track.data.data() + 2 * track.format.bytesPerFrame(), rendered * track.format.bytesPerFrame()) == 0);
        auto samples = engine.drainVisualizerSamples();
        assert(samples.channels.size() == channels);
        for (uint32_t c = 0; c < channels; ++c) {
            assert(samples.channels[c].size() == rendered);
            for (size_t i = 0; i < rendered; ++i) assert(samples.channels[c][i] == output[i * channels + c]);
        }
        for (const auto& channel : engine.drainVisualizerSamples().channels) assert(channel.empty());

        engine.renderInto(output.data(), 100, ended);
        engine.setVisualizerTapDemand({true, false, false, false});
        assert(engine.drainVisualizerSamples().channels.empty());
        engine.renderInto(output.data(), 100, ended);
        samples = engine.drainVisualizerSamples();
        assert(samples.channels.size() == 1);
        assert(samples.channels[0].size() == 100);

        engine.setVisualizerTapDemand({false, true, false, false});
        engine.renderInto(output.data(), 35000, ended);
        samples = engine.drainVisualizerSamples();
        assert(samples.channels.size() == std::min(channels, 2u));
        assert(samples.channels[0].size() == 32768);
        assert(samples.channels[0].front() == output[(35000 - 32768) * channels]);
        assert(samples.channels[0].back() == output[(35000 - 1) * channels]);

        engine.renderInto(output.data(), 100, ended);
        engine.seek(0);
        assert(engine.drainVisualizerSamples().channels.empty());
        engine.setVisualizerTapDemand({false, false, false, false});
        engine.renderInto(output.data(), 100, ended);
        assert(engine.drainVisualizerSamples().channels.empty());
        engine.stop();
    }
}

void testProcessedVisualizerTransport() {
    PlaybackEngine engine;
    NativeOutputRequest request;
    request.policy = OutputPolicy::Processed;
    request.requestedSampleRate = 96000;
    engine.configureOutput(request);
    NativeDspConfig config;
    config.volume = 0.5;
    config.eqEnabled = true;
    config.eqBands.push_back({"peaking", 1000, 3, 1});
    engine.setDspConfig(config);
    engine.loadTrack(makeFloatSine(48000, 1000, 48000, 0.5));
    engine.setVisualizerTapDemand({true, true, true, true});
    engine.play();
    assert(gFakeSink->format_.sampleRate == 96000);
    assert(gFakeSink->format_.sampleFormat == SampleFormat::Float32);
    std::vector<float> output(512);
    bool ended = false;
    const size_t rendered = engine.renderInto(output.data(), output.size(), ended);
    const auto captured = engine.drainVisualizerSamples();
    assert(rendered == output.size());
    assert(captured.channels.size() == 1);
    assert(captured.channels[0] == output); // Exactly the post-DSP samples sent to the sink.
}

ProgressiveTrack progressiveTrack(const TrackBuffer& track, uint64_t id, size_t initiallyAvailable,
    bool ended, uint64_t startFrame = 0, size_t capacity = 8192) {
    ProgressiveTrack result;
    result.sessionId = id;
    result.format = track.format;
    result.duration = track.duration;
    result.gain = track.gain;
    result.input = std::make_shared<ProgressivePcmInput>(track.format.bytesPerFrame(), capacity, startFrame);
    assert(result.input->append(track.data.data(), initiallyAvailable) == initiallyAvailable);
    if (ended) result.input->finish();
    return result;
}

size_t eventCount(const std::vector<PlaybackEvent>& events, const char* type) {
    return static_cast<size_t>(std::count_if(events.begin(), events.end(), [&](const auto& event) { return event.type == type; }));
}

void testEndpointSilenceAndGapless() {
    for (const auto policy : {OutputPolicy::Direct, OutputPolicy::Processed}) {
        PlaybackEngine engine;
        gFakeSink->primeFrames = 0;
        engine.configureOutput({policy, 48000});
        NativeDspConfig config;
        config.limiterEnabled = false;
        engine.setDspConfig(config);
        const auto source = makeTrack();
        auto first = progressiveTrack(source, 80, 2, false);
        engine.loadProgressiveTrack(first);
        engine.preloadNextProgressiveTrack(progressiveTrack(source, 81, 4, true));
        engine.play();
        engine.drainEvents();
        EndpointFrameQueue endpoint(8);
        std::vector<uint8_t> block(4 * gFakeSink->format_.bytesPerFrame());
        bool ended = false;
        assert(engine.renderInto(block.data(), 4, ended) == 2 && !ended);
        assert(endpoint.append(4, 2));
        engine.onFramesConsumed(endpoint.consume(2));
        assert(engine.getSnapshot().currentTime == 2.0 / 48000);
        assert(first.input->append(source.data.data() + 8, 2) == 2);
        first.input->finish();
        assert(engine.renderInto(block.data(), 4, ended) == 4 && !ended);
        assert(endpoint.append(4, 4)); // Remaining A then B, preceded by old silence.
        engine.onFramesConsumed(endpoint.updatePadding(4));
        assert(engine.getSnapshot().currentTime == 2.0 / 48000);
        assert(engine.getSnapshot().progressiveSessionId == 80);
        assert(first.input->snapshot().retainedFrame == 2);
        assert(eventCount(engine.drainEvents(), "gaplessTransition") == 0);
        engine.onFramesConsumed(endpoint.consume(2));
        assert(engine.getSnapshot().progressiveSessionId == 80);
        engine.onFramesConsumed(endpoint.consume(1));
        assert(engine.getSnapshot().progressiveSessionId == 81);
        assert(engine.getSnapshot().currentTime == 1.0 / 48000);
        assert(eventCount(engine.drainEvents(), "gaplessTransition") == 1);
        assert(engine.renderInto(block.data(), 4, ended) == 2 && ended);
        assert(endpoint.append(4, 2));
        engine.onFramesConsumed(endpoint.consume(3));
        assert(engine.getSnapshot().currentTime == 4.0 / 48000);
        assert(endpoint.consume(2) == 0); // Device drains trailing padding, not music.
        engine.onNativeStreamEnded();
        assert(engine.getSnapshot().playbackState == "stopped");
        assert(eventCount(engine.drainEvents(), "ended") == 1);
    }
}

void testEndpointWriteRollback() {
    PlaybackEngine engine;
    gFakeSink->primeFrames = 0;
    const auto source = makeFloatSine(48000, 4000, 8, 0.2);
    engine.loadProgressiveTrack(progressiveTrack(source, 90, 8, true));
    engine.play();
    EndpointFrameQueue endpoint(8);
    std::array<float, 4> block {};
    bool ended = false;
    assert(engine.renderInto(block.data(), 4, ended) == 4);
    assert(endpoint.append(4, 4));
    engine.onFramesConsumed(endpoint.consume(2));
    std::vector<float> accepted;
    const std::array<int, 4> writeResults {1, -1, 2, 2};
    size_t write = 0;
    assert(WriteEndpointPcm(endpoint, 4,
        [&] { return engine.renderInto(block.data(), 4, ended); },
        [&](size_t offset, size_t) {
            const int count = writeResults.at(write++);
            if (count > 0) accepted.insert(accepted.end(), block.begin() + offset, block.begin() + offset + count);
            return count;
        }, [&](int error) {
            assert(error == -1 && ended); // The abandoned block had included EOF.
            endpoint.reset();
            accepted.clear();
            engine.rollbackSpeculativeRender();
            return EndpointWriteRecovery::RenderAgain;
        }) == EndpointWriteResult::Complete);
    assert(!ended); // Rewinding withdrew EOF and re-rendered the unheard prefix.
    assert(accepted.size() == 4);
    assert(std::memcmp(accepted.data(), source.data.data() + 2 * sizeof(float), 4 * sizeof(float)) == 0);
    assert(engine.getSnapshot().currentTime == 2.0 / 48000);
    engine.onFramesConsumed(endpoint.consume(4));
    assert(engine.getSnapshot().currentTime == 6.0 / 48000);
    assert(engine.renderInto(block.data(), 4, ended) == 2 && ended);
    assert(endpoint.append(4, 2));
    engine.onFramesConsumed(endpoint.consume(4));
    engine.onNativeStreamEnded();
    assert(engine.getSnapshot().currentTime == 8.0 / 48000);
    assert(engine.getSnapshot().playbackState == "stopped");
}

void testEndpointLocalPlayback() {
    for (const auto policy : {OutputPolicy::Direct, OutputPolicy::Processed}) {
        PlaybackEngine engine;
        gFakeSink->primeFrames = 0;
        engine.configureOutput({policy, 96000});
        NativeDspConfig config;
        config.eqEnabled = true;
        config.eqBands = {{"peaking", 2000, 3, 1}};
        engine.setDspConfig(config);
        const auto source = makeFloatSine(48000, 2000, 1703, 0.2);
        engine.loadTrack(source);
        engine.play();
        const auto expected = policy == OutputPolicy::Direct ? source.data
            : renderProcessed(source, gFakeSink->format_, config);
        const auto bytesPerFrame = gFakeSink->format_.bytesPerFrame();
        EndpointFrameQueue endpoint(1024);
        std::vector<uint8_t> rendered;
        std::vector<uint8_t> block(512 * bytesPerFrame);
        bool ended = false;
        while (!ended || endpoint.queuedFrames()) {
            if (!ended && endpoint.queuedFrames() <= 512) {
                const size_t count = engine.renderInto(block.data(), 512, ended);
                assert(count || ended);
                rendered.insert(rendered.end(), block.begin(), block.begin() + count * bytesPerFrame);
                assert(endpoint.append(512, count));
            }
            const auto before = engine.getSnapshot();
            const auto freeSpace = 1024 - endpoint.queuedFrames();
            // Unchanged device availability, even with a final partial write,
            // is not fresh consumption. Then acknowledge a real half period.
            assert(endpoint.updateAvailable(freeSpace) == 0);
            assert(endpoint.updateAvailable(freeSpace) == 0);
            assert(engine.getSnapshot().currentTime == before.currentTime);
            engine.onFramesConsumed(endpoint.consume(256));
            assert(engine.getSnapshot().progressiveSessionId == 0);
        }
        assert(rendered == expected);
        engine.onNativeStreamEnded();
        assert(engine.getSnapshot().playbackState == "stopped");
        assert(engine.getSnapshot().currentTime == source.duration);
        assert(eventCount(engine.drainEvents(), "ended") == 1);
    }
}

void testProgressiveConsumptionAndGapless() {
    PlaybackEngine engine;
    gFakeSink->primeFrames = 0;
    const auto original = makeTrack();
    auto first = progressiveTrack(original, 1, 2, false, 0, 8);
    auto next = progressiveTrack(original, 2, 4, true, 0, 8);
    engine.loadProgressiveTrack(first);
    engine.preloadNextProgressiveTrack(next);
    engine.play();
    engine.drainEvents();
    std::vector<uint8_t> block(8 * original.format.bytesPerFrame());
    bool ended = false;
    assert(engine.renderInto(block.data(), 8, ended) == 2);
    assert(!ended && engine.getSnapshot().buffering);
    assert(engine.getSnapshot().currentTime == 0);
    engine.onFramesConsumed(2);
    assert(engine.getSnapshot().currentTime == 2.0 / 48000);
    for (size_t iteration = 0; iteration < 20; ++iteration) {
        assert(engine.renderInto(block.data(), 8, ended) == 0 && !ended);
        assert(engine.getSnapshot().progressiveSessionId == 1);
    }
    assert(eventCount(engine.drainEvents(), "gaplessTransition") == 0);
    first.input->append(original.data.data() + 2 * original.format.bytesPerFrame(), 2);
    first.input->finish();
    std::weak_ptr<ProgressivePcmInput> oldOwner = first.input;
    first.input.reset();
    assert(engine.renderInto(block.data(), 8, ended) == 6 && ended);
    assert(std::memcmp(block.data(), original.data.data() + 2 * original.format.bytesPerFrame(), 2 * original.format.bytesPerFrame()) == 0);
    assert(std::memcmp(block.data() + 2 * original.format.bytesPerFrame(), original.data.data(), original.data.size()) == 0);
    assert(engine.getSnapshot().progressiveSessionId == 1 && "rendering next is not device consumption");
    engine.onNativeStreamEnded(); // The device has queued EOF, but not consumed it.
    assert(engine.getSnapshot().playbackState == "playing");
    engine.onFramesConsumed(1);
    assert(engine.getSnapshot().currentTime == 3.0 / 48000);
    engine.onFramesConsumed(2); // One remaining A frame, then one B frame.
    assert(engine.getSnapshot().progressiveSessionId == 2);
    assert(engine.getSnapshot().currentTime == 1.0 / 48000);
    assert(next.input->snapshot().retainedFrame == 1);
    assert(!oldOwner.expired() && "a consumed owner must not be destroyed on the audio callback");
    const auto transitions = engine.drainEvents();
    assert(oldOwner.expired());
    assert(eventCount(transitions, "gaplessTransition") == 1);
    assert(std::any_of(transitions.begin(), transitions.end(), [](const auto& event) {
        return event.type == "gaplessTransition" && event.progressiveSessionId == 2;
    }));
    engine.onFramesConsumed(3);
    assert(engine.getSnapshot().playbackState == "stopped");
    assert(engine.getSnapshot().currentTime == original.duration);
    assert(eventCount(engine.drainEvents(), "ended") == 1);
}

void testProgressiveFailedStartAcrossBoundary() {
    for (const auto policy : {OutputPolicy::Direct, OutputPolicy::Processed}) {
        PlaybackEngine engine;
        engine.configureOutput({policy, 48000});
        NativeDspConfig config;
        config.limiterEnabled = false;
        engine.setDspConfig(config);
        const auto a = makeFloatSine(48000, 901, 3, 0.1);
        const auto b = makeFloatSine(48000, 1301, 8, 0.1);
        auto first = progressiveTrack(a, 10, 3, true);
        auto next = progressiveTrack(b, 11, 8, true);
        engine.loadProgressiveTrack(first);
        engine.preloadNextProgressiveTrack(next);
        gFakeSink->primeFrames = 6;
        gFakeSink->consumeDuringStart = true;
        gFakeSink->failNextStart = true;
        gFakeSink->afterPrime = [&] {
            assert(engine.getSnapshot().progressiveSessionId == 10);
            assert(engine.getSnapshot().currentTime == 0);
            assert(first.input->snapshot().retainedFrame == 0);
            assert(next.input->snapshot().retainedFrame == 0);
            assert(eventCount(engine.drainEvents(), "gaplessTransition") == 0);
        };
        bool failed = false;
        try { engine.play(); } catch (const std::runtime_error&) { failed = true; }
        assert(failed);
        assert(engine.getSnapshot().progressiveSessionId == 10);
        assert(engine.getSnapshot().currentTime == 0);
        assert(engine.getSnapshot().playbackState == "stopped");
        engine.play();
        assert(gFakeSink->primes.size() == 2 && gFakeSink->primes[0] == gFakeSink->primes[1]);
        assert(engine.getSnapshot().progressiveSessionId == 11);
        assert(engine.getSnapshot().currentTime == 3.0 / 48000);
        assert(eventCount(engine.drainEvents(), "gaplessTransition") == 1);
        assert(engine.getSnapshot().outputStatus.bitPerfectActive == (policy == OutputPolicy::Direct));
        gFakeSink->afterPrime = {};
    }
}

void testProgressiveSeekPauseQueueAndStop() {
    PlaybackEngine engine;
    gFakeSink->primeFrames = 0;
    const auto source = makeTrack();
    auto first = progressiveTrack(source, 20, 4, true);
    auto next = progressiveTrack(source, 21, 4, true);
    engine.loadProgressiveTrack(first);
    engine.preloadNextProgressiveTrack(next);
    engine.play();
    std::array<uint8_t, 8 * 4> bytes {};
    bool ended = false;
    assert(engine.renderInto(bytes.data(), 2, ended) == 2);
    engine.onFramesConsumed(1);
    engine.pause();
    assert(engine.getSnapshot().currentTime == 1.0 / 48000);
    auto seeked = progressiveTrack(source, 22, 4, true, 48000 * 30);
    engine.seekProgressiveTrack(20, seeked);
    assert(engine.getSnapshot().playbackState == "paused");
    assert(engine.getSnapshot().currentTime == 30);
    assert(first.input->snapshot().state == PcmInputState::Cancelled);
    assert(next.input->snapshot().state == PcmInputState::Ended);
    assert(engine.renderInto(bytes.data(), 8, ended) == 0);
    bool staleRejected = false;
    try { engine.seekProgressiveTrack(20, progressiveTrack(source, 23, 4, true)); }
    catch (const std::invalid_argument&) { staleRejected = true; }
    assert(staleRejected && engine.getSnapshot().progressiveSessionId == 22);
    engine.play();
    assert(engine.renderInto(bytes.data(), 8, ended) == 8 && ended);
    assert(engine.getSnapshot().progressiveSessionId == 22);
    engine.clearNextTrack(); // B was rendered, but still unheard; flush and withdraw it.
    assert(next.input->snapshot().state == PcmInputState::Cancelled);
    assert(engine.getSnapshot().progressiveSessionId == 22);
    assert(engine.renderInto(bytes.data(), 8, ended) == 4 && ended);
    assert(std::memcmp(bytes.data(), source.data.data(), source.data.size()) == 0);
    assert(eventCount(engine.drainEvents(), "gaplessTransition") == 0);
    engine.stop();
    assert(seeked.input->snapshot().state == PcmInputState::Cancelled);
    assert(seeked.input->append(source.data.data(), 1) == 0);
    engine.onFramesConsumed(8);
    assert(engine.getSnapshot().currentTime == 0);
    assert(engine.renderInto(bytes.data(), 8, ended) == 0);
    engine.loadTrack(source);
    engine.play();
    assert(engine.getSnapshot().progressiveSessionId == 0);
    assert(engine.renderInto(bytes.data(), 8, ended) == 4 && ended);
    assert(std::memcmp(bytes.data(), source.data.data(), source.data.size()) == 0);
}

void testProgressiveProcessedConsumptionAndPause() {
    PlaybackEngine engine;
    gFakeSink->primeFrames = 0;
    engine.configureOutput({OutputPolicy::Processed, 96000});
    NativeDspConfig config;
    config.limiterEnabled = false;
    engine.setDspConfig(config);
    const auto source = makeFloatSine(48000, 1000, 4096, 0.2);
    auto input = progressiveTrack(source, 30, 4096, true);
    engine.loadProgressiveTrack(input);
    engine.play();
    std::array<float, 128> first {};
    bool ended = false;
    assert(engine.renderInto(first.data(), 128, ended) == 128 && !ended);
    assert(engine.getSnapshot().currentTime == 0);
    engine.onFramesConsumed(64);
    assert(engine.getSnapshot().currentTime == 32.0 / 48000);
    assert(input.input->snapshot().retainedFrame == 32);
    engine.pause();
    engine.play();
    std::array<float, 128> resumed {};
    assert(engine.renderInto(resumed.data(), 128, ended) == 128);
    ProcessedAudioPipeline reference;
    reference.configure(source.format, BuildTrackFormat(96000, 1, "f32"), config, {}, 32);
    uint64_t frame = 32;
    std::array<float, 128> expected {};
    assert(reference.render(source, frame, expected.data(), 128, ended) == 128);
    assert(resumed == expected);
    engine.onFramesConsumed(128);
    const auto position = engine.getSnapshot().currentTime;
    engine.setSelectedDeviceId("other-device");
    assert(engine.getSnapshot().playbackState == "playing");
    assert(engine.getSnapshot().currentTime == position);
}

void testProgressiveQueueRaces() {
    PlaybackEngine engine;
    gFakeSink->primeFrames = 0;
    const auto source = makeTrack();
    auto first = progressiveTrack(source, 50, 4, true);
    auto next = progressiveTrack(source, 51, 1, false);
    engine.loadProgressiveTrack(first);
    engine.preloadNextProgressiveTrack(next);
    engine.play();
    std::array<uint8_t, 8 * 4> bytes {};
    bool ended = false;
    assert(engine.renderInto(bytes.data(), 8, ended) == 4 && !ended);
    engine.onFramesConsumed(4);
    assert(engine.getSnapshot().buffering);
    assert(engine.renderInto(bytes.data(), 8, ended) == 0 && !ended);
    // A short next song becomes ready on true EOF, even below the normal buffer threshold.
    next.input->append(source.data.data() + 4, 3);
    next.input->finish();
    assert(engine.renderInto(bytes.data(), 8, ended) == 4 && ended);
    gFakeSink->onPause = [&] { engine.onFramesConsumed(1); };
    bool staleRejected = false;
    try { engine.seekProgressiveTrack(50, progressiveTrack(source, 52, 4, true)); }
    catch (const std::invalid_argument&) { staleRejected = true; }
    gFakeSink->onPause = {};
    assert(staleRejected);
    assert(engine.getSnapshot().progressiveSessionId == 51);
    assert(engine.getSnapshot().playbackState == "playing");
    assert(engine.getSnapshot().currentTime == 1.0 / 48000);
    assert(engine.renderInto(bytes.data(), 8, ended) == 3 && ended);
    assert(std::memcmp(bytes.data(), source.data.data() + 4, 12) == 0);
    auto late = progressiveTrack(source, 53, 4, true);
    bool lateRejected = false;
    try { engine.preloadNextProgressiveTrack(late); }
    catch (const std::logic_error&) { lateRejected = true; }
    assert(lateRejected);
    assert(late.input->snapshot().state == PcmInputState::Ended);
    engine.onFramesConsumed(3);
    engine.onNativeStreamEnded();
    assert(engine.getSnapshot().playbackState == "stopped");
    assert(eventCount(engine.drainEvents(), "gaplessTransition") == 1);
}

void testProgressiveShortStartupEof() {
    for (const auto policy : {OutputPolicy::Direct, OutputPolicy::Processed}) {
        PlaybackEngine engine;
        engine.configureOutput({policy, 48000});
        const auto source = makeFloatSine(48000, 1000, 4, 0.1);
        auto track = progressiveTrack(source, 60, 4, true);
        engine.loadProgressiveTrack(track);
        gFakeSink->primeFrames = 8;
        gFakeSink->consumeDuringStart = true;
        gFakeSink->signalEndDuringStart = true;
        gFakeSink->failNextStart = true;
        bool failed = false;
        try { engine.play(); } catch (const std::runtime_error&) { failed = true; }
        assert(failed && engine.getSnapshot().currentTime == 0);
        assert(track.input->snapshot().retainedFrame == 0);
        assert(eventCount(engine.drainEvents(), "ended") == 0);
        engine.play();
        assert(gFakeSink->primes[0] == gFakeSink->primes[1]);
        assert(engine.getSnapshot().playbackState == "stopped");
        assert(engine.getSnapshot().currentTime == source.duration);
        assert(track.input->snapshot().retainedFrame == 4);
        assert(eventCount(engine.drainEvents(), "ended") == 1);
    }
}

void testProgressiveProcessedRateHandoff() {
    PlaybackEngine engine;
    gFakeSink->primeFrames = 0;
    engine.configureOutput({OutputPolicy::Processed, 96000});
    NativeDspConfig config;
    config.eqEnabled = true;
    config.preampDb = -3;
    config.eqBands = {{"peaking", 1000, 4, 1}};
    engine.setDspConfig(config);
    auto a = makeFloatSine(44100, 880, 4410, 0.1);
    auto b = makeFloatSine(48000, 1760, 4800, 0.2);
    b.gain.gainDb = -2;
    b.gain.mode = TrackGainMode::ReplayGain;
    auto first = progressiveTrack(a, 70, 4410, true);
    auto next = progressiveTrack(b, 71, 4800, true);
    engine.loadProgressiveTrack(first);
    engine.preloadNextProgressiveTrack(next);
    engine.play();
    ProcessedAudioPipeline reference;
    reference.configure(a.format, BuildTrackFormat(96000, 1, "f32"), config, a.gain, 0);
    reference.prepareGaplessTrack(b.format);
    std::vector<float> expected;
    std::array<float, 257> block {};
    uint64_t read = 0;
    bool ended = false;
    while (!ended) {
        const auto count = reference.render(a, read, block.data(), block.size(), ended);
        assert(count || ended);
        expected.insert(expected.end(), block.begin(), block.begin() + count);
    }
    reference.beginGaplessTrack(b.format, b.gain);
    read = 0;
    ended = false;
    while (!ended) {
        const auto count = reference.render(b, read, block.data(), block.size(), ended);
        assert(count || ended);
        expected.insert(expected.end(), block.begin(), block.begin() + count);
    }
    size_t played = 0;
    ended = false;
    while (!ended) {
        const auto count = engine.renderInto(block.data(), block.size(), ended);
        assert(count || ended);
        assert(played + count <= expected.size());
        assert(std::equal(block.begin(), block.begin() + count, expected.begin() + played));
        const auto beforeConsumption = engine.getSnapshot();
        assert(beforeConsumption.outputStatus.processing.sourceSampleRate == (played <= 9600 ? 44100 : 48000));
        assert(beforeConsumption.outputStatus.processing.trackGainDb == (played <= 9600 ? 0 : -2));
        engine.onFramesConsumed(count);
        played += count;
        const auto snapshot = engine.getSnapshot();
        if (played <= 9600) {
            assert(snapshot.progressiveSessionId == 70);
        } else {
            assert(snapshot.progressiveSessionId == 71);
            assert(snapshot.currentTime == static_cast<double>((played - 9600) / 2) / 48000);
        }
    }
    assert(played == expected.size() && played == 19200);
    engine.onNativeStreamEnded();
    assert(engine.getSnapshot().playbackState == "stopped");
    assert(eventCount(engine.drainEvents(), "gaplessTransition") == 1);
}

void testProgressiveConcurrentDecodeAndPlayback() {
    PlaybackEngine engine;
    gFakeSink->primeFrames = 0;
    TrackBuffer source;
    source.format = BuildTrackFormat(48000, 2, "s16");
    constexpr size_t frames = 200003;
    source.duration = 10000; // Metadata does not define EOF.
    source.data.resize(frames * 4);
    for (size_t index = 0; index < source.data.size(); ++index) source.data[index] = static_cast<uint8_t>(index * 137);
    auto track = progressiveTrack(source, 40, 0, false, 0, 257);
    engine.loadProgressiveTrack(track);
    engine.play();
    std::thread producer([&] {
        size_t written = 0;
        while (written < frames) {
            written += track.input->append(source.data.data() + written * 4, std::min<size_t>(131, frames - written));
            std::this_thread::yield();
        }
        track.input->finish();
    });
    std::atomic<bool> done {false};
    std::thread observer([&] {
        while (!done.load()) {
            assert(engine.getSnapshot().progressiveSessionId == 40);
            engine.drainEvents();
            std::this_thread::yield();
        }
    });
    size_t played = 0;
    std::array<uint8_t, 127 * 4> block {};
    bool ended = false;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (!ended) {
        assert(std::chrono::steady_clock::now() < deadline);
        const size_t count = engine.renderInto(block.data(), 127, ended);
        assert(std::memcmp(block.data(), source.data.data() + played * 4, count * 4) == 0);
        played += count;
        engine.onFramesConsumed(count);
        const auto view = track.input->snapshot();
        assert(view.publishedFrame - view.retainedFrame <= 257);
        if (!count) std::this_thread::yield();
    }
    done.store(true);
    producer.join();
    observer.join();
    assert(played == frames);
    engine.onNativeStreamEnded();
    assert(engine.getSnapshot().playbackState == "stopped");
    assert(engine.getSnapshot().currentTime == static_cast<double>(frames) / 48000);
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
    RunEndpointFrameQueueTests();
    testEndpointSilenceAndGapless();
    testEndpointWriteRollback();
    testEndpointLocalPlayback();
    testDeviceCapabilityQueryAllowsRendering();
    testVisualizerTransport();
    testProcessedVisualizerTransport();
    testProgressiveConsumptionAndGapless();
    testProgressiveFailedStartAcrossBoundary();
    testProgressiveSeekPauseQueueAndStop();
    testProgressiveProcessedConsumptionAndPause();
    testProgressiveQueueRaces();
    testProgressiveShortStartupEof();
    testProgressiveProcessedRateHandoff();
    testProgressiveConcurrentDecodeAndPlayback();

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
