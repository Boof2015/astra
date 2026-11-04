#include "endpoint_pcm_writer.h"

#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <deque>
#include <random>
#include <vector>

namespace NativePlayback {

void RunEndpointFrameQueueTests() {
    // A partially filled device starts with free space; that space has never
    // played anything. This is also the local short-track/final-buffer case.
    EndpointFrameQueue partial(16);
    assert(partial.append(8, 5));
    assert(partial.updateAvailable(8) == 0);
    assert(partial.updateAvailable(8) == 0);
    assert(partial.updateAvailable(10) == 2);
    assert(partial.updateAvailable(10) == 0);
    assert(partial.updateAvailable(16) == 3);
    assert(partial.queuedFrames() == 0);

    // Original audio, buffering silence, then newly available audio. Repeated
    // padding snapshots and silence consumption cannot credit the resumed music.
    EndpointFrameQueue buffered(12);
    assert(buffered.append(8, 3));
    assert(buffered.updatePadding(5) == 3);
    assert(buffered.append(4, 4));
    assert(buffered.updatePadding(7) == 0);
    assert(buffered.updatePadding(4) == 0);
    assert(buffered.updatePadding(4) == 0);
    assert(buffered.updatePadding(2) == 2);
    assert(buffered.updatePadding(0) == 2);
    assert(buffered.queuedAudioFrames() == 0);

    // Full audio periods preserve the old local path's consumption exactly;
    // numeric sample values (including actual silence) never enter this ledger.
    EndpointFrameQueue periods(512);
    for (size_t index = 0; index < 100; ++index) {
        assert(periods.append(512, 512));
        assert(periods.consume(512) == 512);
    }
    assert(periods.append(512, 11));
    assert(periods.consume(512) == 11);
    assert(periods.consume(512) == 0);

    // Compare arbitrary writes, partial consumption, ring wrap and reset to a
    // per-frame reference, including word boundaries and non-power-of-two sizes.
    std::mt19937 random(0xa57a);
    for (const size_t capacity : {1, 2, 7, 63, 64, 65, 127, 128, 257, 4096}) {
        EndpointFrameQueue queue(capacity);
        std::deque<bool> expected;
        for (size_t iteration = 0; iteration < 12000; ++iteration) {
            const auto action = random() % 6;
            if (action <= 1) {
                const size_t frames = random() % (capacity - expected.size() + 1);
                const size_t music = random() % (frames + 1);
                assert(queue.append(frames, music));
                for (size_t frame = 0; frame < frames; ++frame) expected.push_back(frame < music);
            } else if (action == 5) {
                queue.reset();
                expected.clear();
            } else {
                const size_t argument = random() % (capacity + 5);
                size_t frames = 0;
                size_t actual = 0;
                if (action == 2) {
                    frames = std::min(argument, expected.size());
                    actual = queue.consume(argument);
                } else {
                    const size_t padding = action == 3 ? argument : capacity - std::min(capacity, argument);
                    frames = expected.size() > padding ? expected.size() - padding : 0;
                    actual = action == 3 ? queue.updatePadding(argument) : queue.updateAvailable(argument);
                }
                size_t musical = 0;
                for (size_t frame = 0; frame < frames; ++frame) {
                    musical += expected.front();
                    expected.pop_front();
                }
                assert(actual == musical);
            }
            assert(queue.queuedFrames() == expected.size());
            assert(queue.queuedAudioFrames() == static_cast<size_t>(std::count(expected.begin(), expected.end(), true)));
            assert(!queue.append(capacity + 1, 0));
            assert(!queue.append(0, 1));
            assert(queue.queuedFrames() == expected.size());
        }
    }

    // Short writes split inside both music and padding. A temporary unavailable
    // device retries the same block, without another render or phantom credit.
    EndpointFrameQueue writes(16);
    std::vector<int> results {2, 0, 4, 2};
    size_t call = 0;
    size_t renderCalls = 0;
    size_t accepted = 0;
    assert(WriteEndpointPcm(writes, 8, [&] { ++renderCalls; return 5; },
        [&](size_t offset, size_t remaining) {
            assert(offset == accepted && remaining == 8 - accepted);
            const auto result = results.at(call++);
            if (result > 0) accepted += result;
            return result;
        }, [](int result) {
            assert(result == 0);
            return EndpointWriteRecovery::Retry;
        }) == EndpointWriteResult::Complete);
    assert(renderCalls == 1 && accepted == 8);
    assert(writes.consume(3) == 3);
    assert(writes.consume(3) == 2);
    assert(writes.consume(2) == 0);

    // A device reset discards previously submitted PCM. Both queue and renderer
    // restart together; the replacement can have a different audio prefix/EOF.
    writes.reset();
    assert(writes.append(4, 4));
    results = {2, -1, 4, 4};
    call = renderCalls = 0;
    accepted = 0;
    assert(WriteEndpointPcm(writes, 8, [&] { return ++renderCalls == 1 ? 7 : 3; },
        [&](size_t offset, size_t) {
            assert(offset == accepted);
            const auto result = results.at(call++);
            if (result > 0) accepted += result;
            return result;
        }, [&](int result) {
            assert(result == -1);
            writes.reset();
            accepted = 0;
            return EndpointWriteRecovery::RenderAgain;
        }) == EndpointWriteResult::Complete);
    assert(renderCalls == 2 && writes.queuedFrames() == 8);
    assert(writes.consume(8) == 3);

    // Cancellation stops retrying immediately and leaves only accepted frames
    // accounted. Impossible device counts do not append invented samples.
    results = {2, -1};
    call = 0;
    assert(WriteEndpointPcm(writes, 8, [] { return 8; },
        [&](size_t, size_t) { return results.at(call++); },
        [](int) { return EndpointWriteRecovery::Abort; }) == EndpointWriteResult::Aborted);
    assert(writes.queuedFrames() == 2 && writes.consume(8) == 2);
    assert(WriteEndpointPcm(writes, 8, [] { return 8; },
        [](size_t, size_t) { return 9; },
        [](int) { return EndpointWriteRecovery::Abort; }) == EndpointWriteResult::InvalidFrameCount);
    assert(writes.queuedFrames() == 0);
}

} // namespace NativePlayback
