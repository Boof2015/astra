#include "progressive_pcm_input.h"
#include "audio_processing.h"

#ifdef NDEBUG
#undef NDEBUG
#endif
#include <array>
#include <cassert>
#include <chrono>
#include <cmath>
#include <iostream>
#include <thread>

// This executable exercises input/DSP without opening a real output device.
namespace NativePlayback {
std::unique_ptr<AudioOutputSink> CreatePlatformAudioSink() { return nullptr; }
}

namespace {
using namespace NativePlayback;

struct DirectResult { size_t frames; PcmReadState state; };

DirectResult renderDirect(const PcmInput& input, uint64_t& frame, void* output, size_t frames, size_t bytesPerFrame) {
    size_t copied = 0;
    while (copied < frames) {
        const auto chunk = input.read(frame, frames - copied);
        if (chunk.state != PcmReadState::Ready) return {copied, chunk.state};
        assert(chunk.frames > 0);
        std::memcpy(static_cast<uint8_t*>(output) + copied * bytesPerFrame, chunk.data, chunk.frames * bytesPerFrame);
        frame += chunk.frames;
        copied += chunk.frames;
    }
    return {copied, PcmReadState::Ready};
}

std::vector<uint8_t> pattern(size_t frames, size_t bytesPerFrame, uint64_t startFrame = 0) {
    std::vector<uint8_t> bytes(frames * bytesPerFrame);
    for (size_t frame = 0; frame < frames; ++frame) {
        for (size_t byte = 0; byte < bytesPerFrame; ++byte) {
            bytes[frame * bytesPerFrame + byte] = static_cast<uint8_t>((startFrame + frame) * 131 + byte * 17);
        }
    }
    return bytes;
}

void testCapacityAndStates() {
    for (const auto invalid : std::array<std::pair<size_t, size_t>, 4>{{
        {0, 10}, {4, 0}, {8, ProgressivePcmInput::kMaxBytes}, {std::numeric_limits<size_t>::max(), 1}
    }}) {
        bool threw = false;
        try { ProgressivePcmInput input(invalid.first, invalid.second); }
        catch (const std::invalid_argument&) { threw = true; }
        assert(threw);
    }
    ProgressivePcmInput input(4, 8);
    const auto bytes = pattern(12, 4);
    assert(input.read(0, 8).state == PcmReadState::Waiting);
    assert(input.append(bytes.data(), 12) == 8);
    assert(input.append(bytes.data(), 1) == 0);
    assert(input.capacityBytes() == 32);
    assert(!input.releaseBefore(9));
    assert(input.releaseBefore(5));
    assert(!input.releaseBefore(4));
    assert(input.append(bytes.data() + 8 * 4, 4) == 4);
    assert(input.read(4, 1).state == PcmReadState::OutsideRetainedRange);
    uint64_t cursor = 5;
    std::array<uint8_t, 7 * 4> rendered {};
    const auto result = renderDirect(input, cursor, rendered.data(), 7, 4);
    assert(result.frames == 7);
    assert(std::memcmp(rendered.data(), bytes.data() + 5 * 4, rendered.size()) == 0);
    assert(input.read(12, 1).state == PcmReadState::Waiting);
    assert(input.finish());
    assert(!input.finish());
    assert(input.read(12, 1).state == PcmReadState::Ended);
    assert(input.append(bytes.data(), 1) == 0);
    input.cancel();
    assert(input.read(5, 1).state == PcmReadState::Cancelled);
    assert(!input.finish());
}

void testDirectFormatsAndBoundedMemory() {
    // Byte equality includes packed 24-bit, multichannel integers and arbitrary
    // float bit patterns. Direct input performs no gain/float conversion.
    for (size_t bytesPerFrame : {2u, 4u, 6u, 8u, 18u, 24u}) {
        constexpr size_t total = 250003;
        ProgressivePcmInput input(bytesPerFrame, 257);
        const auto original = pattern(total, bytesPerFrame);
        std::vector<uint8_t> rendered(113 * bytesPerFrame);
        size_t written = 0;
        uint64_t cursor = 0;
        while (cursor < total) {
            written += input.append(original.data() + written * bytesPerFrame, total - written);
            const auto count = static_cast<size_t>(std::min<uint64_t>(113, total - cursor));
            const auto before = cursor;
            const auto result = renderDirect(input, cursor, rendered.data(), count, bytesPerFrame);
            assert(result.frames > 0);
            assert(std::memcmp(rendered.data(), original.data() + before * bytesPerFrame,
                result.frames * bytesPerFrame) == 0);
            assert(input.releaseBefore(cursor)); // Device acknowledged these musical frames.
            assert(input.capacityBytes() == 257 * bytesPerFrame);
            const auto view = input.snapshot();
            assert(view.publishedFrame - view.retainedFrame <= 257);
        }
        input.finish();
        assert(input.read(cursor, 1).state == PcmReadState::Ended);
    }
}

void testStarvationRollbackSeekAndHandoff() {
    ProgressivePcmInput first(4, 8);
    ProgressivePcmInput next(4, 8);
    const auto original = pattern(8, 4);
    first.append(original.data(), 3);
    next.append(original.data() + 3 * 4, 5);
    next.finish();
    std::array<uint8_t, 8 * 4> output {};
    uint64_t cursor = 0;
    auto result = renderDirect(first, cursor, output.data(), 8, 4);
    assert(result.frames == 3 && result.state == PcmReadState::Waiting);
    for (int stall = 0; stall < 100; ++stall) {
        result = renderDirect(first, cursor, output.data(), 8, 4);
        assert(result.frames == 0 && result.state == PcmReadState::Waiting);
        assert(cursor == 3); // Silence from the device is not musical progress.
    }
    assert(first.snapshot().retainedFrame == 0); // Failed/unverified start: no release.
    cursor = 0;
    first.finish();
    result = renderDirect(first, cursor, output.data(), 8, 4);
    assert(result.frames == 3 && result.state == PcmReadState::Ended);
    uint64_t nextCursor = 0;
    assert(renderDirect(next, nextCursor, output.data() + 3 * 4, 5, 4).frames == 5);
    assert(std::memcmp(output.data(), original.data(), output.size()) == 0);
    // Roll back a speculative prime that crossed the boundary, retaining BOTH
    // owners/cursors until the platform has confirmed the start.
    std::array<uint8_t, 8 * 4> replay {};
    cursor = 0;
    nextCursor = 0;
    assert(renderDirect(first, cursor, replay.data(), 8, 4).frames == 3);
    assert(renderDirect(next, nextCursor, replay.data() + 3 * 4, 5, 4).frames == 5);
    assert(replay == output);
    assert(first.releaseBefore(3));
    assert(next.releaseBefore(2)); // Partial device acknowledgement into next.
    nextCursor = 2;
    assert(renderDirect(next, nextCursor, replay.data(), 3, 4).frames == 3);
    assert(std::memcmp(replay.data(), original.data() + 5 * 4, 3 * 4) == 0);

    // Decoder generations have distinct buffers; delayed old writes cannot
    // become audio after a seek/stop or resume a paused replacement.
    first.cancel();
    ProgressivePcmInput seeked(4, 8, 1000000000);
    assert(first.append(original.data(), 8) == 0);
    assert(seeked.read(1000000000, 8).state == PcmReadState::Waiting);
    seeked.append(original.data(), 8);
    uint64_t seekCursor = 1000000000;
    assert(seeked.snapshot().retainedFrame == seekCursor); // Paused: no render/commit.
    assert(renderDirect(seeked, seekCursor, replay.data(), 8, 4).frames == 8);
    assert(replay == output);
    seeked.cancel();
    result = renderDirect(seeked, seekCursor, replay.data(), 8, 4);
    assert(result.frames == 0 && result.state == PcmReadState::Cancelled);
}

void testConcurrentProducerAndConsumer() {
    constexpr size_t frames = 200003;
    ProgressivePcmInput input(4, 1021);
    const auto original = pattern(frames, 4);
    std::thread producer([&] {
        size_t written = 0;
        while (written < frames) {
            const size_t count = input.append(original.data() + written * 4, std::min<size_t>(257, frames - written));
            written += count;
            if (count == 0) std::this_thread::yield();
        }
        input.finish();
    });
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    uint64_t cursor = 0;
    std::array<uint8_t, 131 * 4> block {};
    while (true) {
        assert(std::chrono::steady_clock::now() < deadline);
        const auto before = cursor;
        const auto result = renderDirect(input, cursor, block.data(), 131, 4);
        assert(std::memcmp(block.data(), original.data() + before * 4, result.frames * 4) == 0);
        input.releaseBefore(cursor);
        if (result.state == PcmReadState::Ended) break;
        assert(result.state == PcmReadState::Waiting || result.state == PcmReadState::Ready);
        if (!result.frames) std::this_thread::yield();
    }
    producer.join();
    assert(cursor == frames);
}

TrackBuffer makeTrack(uint32_t rate, uint32_t channels, size_t frames) {
    TrackBuffer track;
    track.format = BuildTrackFormat(rate, channels, "f32");
    // Deliberately wrong metadata duration: only decoded EOF defines output.
    track.duration = 9999;
    track.data.resize(frames * track.format.bytesPerFrame());
    for (size_t frame = 0; frame < frames; ++frame) {
        for (size_t channel = 0; channel < channels; ++channel) {
            const float value = static_cast<float>(0.1 * std::sin((frame * (channel + 1) * 991.0) / rate));
            std::memcpy(track.data.data() + (frame * channels + channel) * sizeof(float), &value, sizeof(value));
        }
    }
    return track;
}

std::vector<uint8_t> renderComplete(const TrackBuffer& track, const TrackFormat& outputFormat,
    const NativeDspConfig& config, uint64_t start = 0) {
    ProcessedAudioPipeline pipeline;
    pipeline.configure(track.format, outputFormat, config, {}, start);
    uint64_t cursor = start;
    std::vector<uint8_t> output;
    std::vector<uint8_t> block(257 * outputFormat.bytesPerFrame());
    bool ended = false;
    while (!ended) {
        const auto frames = pipeline.render(track, cursor, block.data(), 257, ended);
        assert(frames || ended);
        output.insert(output.end(), block.begin(), block.begin() + frames * outputFormat.bytesPerFrame());
    }
    return output;
}

std::vector<uint8_t> renderIncremental(const TrackBuffer& track, const TrackFormat& outputFormat,
    const NativeDspConfig& config, uint64_t start = 0) {
    ProcessedAudioPipeline pipeline;
    pipeline.configure(track.format, outputFormat, config, {}, start);
    ProgressivePcmInput input(track.format.bytesPerFrame(), 8191, start);
    std::vector<uint8_t> output;
    std::vector<uint8_t> block(257 * outputFormat.bytesPerFrame());
    uint64_t written = start;
    uint64_t cursor = start;
    bool ended = false;
    size_t starved = 0;
    int delayedEof = 0;
    for (int iteration = 0; !ended && iteration < 100000; ++iteration) {
        if (iteration % 7 == 1 && written < track.totalFrames()) {
            const auto count = static_cast<size_t>(std::min<uint64_t>(509, track.totalFrames() - written));
            written += input.append(track.data.data() + written * track.format.bytesPerFrame(), count);
        }
        if (written == track.totalFrames() && ++delayedEof == 20) input.finish();
        const auto before = cursor;
        const auto frames = pipeline.render(input, cursor, block.data(), 257, ended);
        assert(!ended || input.snapshot().state == PcmInputState::Ended);
        if (frames == 0 && !ended) {
            ++starved;
            if (input.snapshot().publishedFrame == before) assert(cursor == before);
        }
        output.insert(output.end(), block.begin(), block.begin() + frames * outputFormat.bytesPerFrame());
        const auto playedOutputFrames = output.size() / outputFormat.bytesPerFrame();
        const auto playedSourceFrame = start + static_cast<uint64_t>(
            static_cast<long double>(playedOutputFrames) * track.format.sampleRate / outputFormat.sampleRate);
        assert(input.releaseBefore(std::min(cursor, playedSourceFrame)));
        const auto view = input.snapshot();
        assert(view.publishedFrame - view.retainedFrame <= 8191);
    }
    assert(ended && starved > 0);
    return output;
}

void testRealDspWithIncrementalInput() {
    for (uint32_t channels : {1u, 2u, 6u}) {
        for (const auto rates : {std::pair{48000u, 48000u}, {44100u, 48000u}, {48000u, 96000u}, {96000u, 44100u}}) {
            const auto track = makeTrack(rates.first, channels, 24013);
            for (const auto format : {"f32", "s16", "s24", "s32"}) {
                const auto output = BuildTrackFormat(rates.second, channels, format);
                NativeDspConfig config;
                config.limiterEnabled = false;
                config.volume = 0.6;
                config.eqEnabled = true;
                config.eqBands.push_back({"peaking", 1000, 3, 1});
                for (uint64_t start : {0u, 1237u}) {
                    const auto reference = renderComplete(track, output, config, start);
                    const auto incremental = renderIncremental(track, output, config, start);
                    assert(incremental == reference);
                    const auto expected = static_cast<size_t>(std::llround(
                        static_cast<double>(track.totalFrames() - start) * rates.second / rates.first));
                    assert(incremental.size() == expected * output.bytesPerFrame());
                }
            }
        }
    }
}

void testLimiterWaitsForLookaheadAndDspRollback() {
    const auto track = makeTrack(48000, 2, 4096);
    const auto outputFormat = BuildTrackFormat(48000, 2, "f32");
    ProgressivePcmInput input(track.format.bytesPerFrame(), 4096);
    ProcessedAudioPipeline pipeline;
    NativeDspConfig config;
    pipeline.configure(track.format, outputFormat, config, {}, 0);
    uint64_t cursor = 0;
    std::vector<uint8_t> first(128 * outputFormat.bytesPerFrame());
    bool ended = false;
    input.append(track.data.data(), 100);
    assert(pipeline.render(input, cursor, first.data(), 128, ended) == 0);
    assert(!ended); // The limiter requires 240 future frames, not guessed silence.
    input.append(track.data.data() + 100 * track.format.bytesPerFrame(), 3996);
    assert(pipeline.render(input, cursor, first.data(), 128, ended) == 128);
    assert(input.snapshot().retainedFrame == 0);
    pipeline.reset(0); // Device start failed before acknowledging any samples.
    cursor = 0;
    std::vector<uint8_t> retry(first.size());
    assert(pipeline.render(input, cursor, retry.data(), 128, ended) == 128);
    assert(retry == first);
    input.cancel();
    assert(pipeline.render(input, cursor, retry.data(), 128, ended) == 0);
    assert(!ended); // Cancellation is neither a track end nor a queue advance.

    config.limiterEnabled = false;
    const auto rateConverted = BuildTrackFormat(96000, 2, "f32");
    ProgressivePcmInput resampledInput(track.format.bytesPerFrame(), 4096);
    resampledInput.append(track.data.data(), 4096);
    resampledInput.finish();
    pipeline.configure(track.format, rateConverted, config, {}, 0);
    cursor = 0;
    assert(pipeline.render(resampledInput, cursor, first.data(), 128, ended) == 128);
    pipeline.reset(0);
    cursor = 0;
    assert(pipeline.render(resampledInput, cursor, retry.data(), 128, ended) == 128);
    assert(retry == first);
}

void testShortAndEmptyStreams() {
    NativeDspConfig config;
    for (const auto rates : {std::pair{48000u, 48000u}, {44100u, 96000u}, {96000u, 44100u}}) {
        for (size_t frames : {0u, 1u, 3u, 128u, 1023u}) {
            const auto track = makeTrack(rates.first, 2, frames);
            const auto output = BuildTrackFormat(rates.second, 2, "f32");
            assert(renderIncremental(track, output, config) == renderComplete(track, output, config));
        }
    }
}

void testProcessedGaplessBoundary() {
    for (const uint32_t nextRate : {44100u, 48000u}) {
        const std::array<TrackBuffer, 2> tracks {makeTrack(48000, 2, 251), makeTrack(nextRate, 2, 1103)};
        const auto outputFormat = BuildTrackFormat(48000, 2, "f32");
        NativeDspConfig config;
        config.limiterEnabled = false;
        const auto album = [&](bool incremental) {
            ProcessedAudioPipeline pipeline;
            pipeline.configure(tracks[0].format, outputFormat, config, {}, 0);
            pipeline.prepareGaplessTrack(tracks[1].format);
            std::array<ProgressivePcmInput, 2> streamed {
                ProgressivePcmInput(8, 2048), ProgressivePcmInput(8, 2048)};
            const std::array<CompletePcmInput, 2> complete {
                CompletePcmInput(tracks[0].data.data(), tracks[0].totalFrames(), 8),
                CompletePcmInput(tracks[1].data.data(), tracks[1].totalFrames(), 8)};
            for (size_t index = 0; index < tracks.size(); ++index) {
                streamed[index].append(tracks[index].data.data(), tracks[index].totalFrames());
                streamed[index].finish();
            }
            std::vector<uint8_t> output;
            std::array<uint8_t, 128 * 8> block {};
            uint64_t cursor = 0;
            size_t index = 0;
            size_t handoffs = 0;
            while (index < tracks.size()) {
                size_t written = 0;
                while (written < 128 && index < tracks.size()) {
                    const PcmInput& input = incremental ? static_cast<const PcmInput&>(streamed[index])
                        : static_cast<const PcmInput&>(complete[index]);
                    bool ended = false;
                    const auto frames = pipeline.render(input, cursor, block.data() + written * 8, 128 - written, ended);
                    assert(frames || ended);
                    written += frames;
                    if (ended && ++index < tracks.size()) {
                        cursor = 0;
                        pipeline.beginGaplessTrack(tracks[index].format, {});
                        ++handoffs;
                    }
                }
                output.insert(output.end(), block.begin(), block.begin() + written * 8);
            }
            assert(handoffs == 1);
            assert(output.size() / 8 == 251 + static_cast<size_t>(std::llround(1103.0 * 48000 / nextRate)));
            return output;
        };
        assert(album(true) == album(false));
    }
}

// Can be compiled against the previous DSP source for a byte-for-byte local
// regression comparison, independent of the incremental adapter under test.
void writeCompleteOutputFingerprints() {
    for (uint32_t channels : {1u, 2u, 6u}) {
        for (const auto rates : {std::pair{48000u, 48000u}, {44100u, 48000u}, {96000u, 44100u}}) {
            const auto track = makeTrack(rates.first, channels, 12017);
            for (const auto format : {"f32", "s16", "s24", "s32"}) {
                for (const bool limiter : {false, true}) {
                    NativeDspConfig config;
                    config.eqEnabled = true;
                    config.preampDb = 12;
                    config.eqBands.push_back({"peaking", 1000, 9, 1});
                    config.limiterEnabled = limiter;
                    const auto bytes = renderComplete(track, BuildTrackFormat(rates.second, channels, format), config, 1237);
                    uint64_t hash = 14695981039346656037ull;
                    for (const auto byte : bytes) hash = (hash ^ byte) * 1099511628211ull;
                    std::cout << channels << ' ' << rates.first << ' ' << rates.second << ' ' << format
                        << ' ' << limiter << ' ' << bytes.size() << ' ' << hash << '\n';
                }
            }
        }
    }
}

} // namespace

int main() {
#ifdef ASTRA_COMPLETE_PCM_REFERENCE
    writeCompleteOutputFingerprints();
#else
    testCapacityAndStates();
    testDirectFormatsAndBoundedMemory();
    testStarvationRollbackSeekAndHandoff();
    testConcurrentProducerAndConsumer();
    testRealDspWithIncrementalInput();
    testLimiterWaitsForLookaheadAndDspRollback();
    testShortAndEmptyStreams();
    testProcessedGaplessBoundary();
    std::cout << "native progressive input prototype passed (113 DSP/format/seek/boundary comparisons plus lifecycle and concurrency probes)\n";
#endif
}
