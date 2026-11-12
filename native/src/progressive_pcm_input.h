#pragma once

#include "pcm_input.h"

#include <atomic>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <vector>

namespace NativePlayback {

// One producer appends/finishes; one consumer reads/releases. Cancellation may
// come from control. Seek creates a new instance; never reset live atomics or
// recycle a cancelled instance for another decoder. The owner keeps instances
// alive until both producer and consumer have detached.
class ProgressivePcmInput final : public PcmInput {
public:
    static constexpr size_t kMaxBytes = 32 * 1024 * 1024;

    ProgressivePcmInput(size_t bytesPerFrame, size_t capacityFrames, uint64_t startFrame = 0)
        : bytesPerFrame_(bytesPerFrame), capacityFrames_(capacityFrames), startFrame_(startFrame),
          releasedFrame_(startFrame), publishedFrame_(startFrame) {
        static_assert(std::atomic<uint64_t>::is_always_lock_free, "The audio reader requires lock-free cursors");
        static_assert(std::atomic<PcmInputState>::is_always_lock_free, "The audio reader requires lock-free state");
        if (bytesPerFrame == 0 || capacityFrames == 0 || capacityFrames > kMaxBytes / bytesPerFrame
            || startFrame > std::numeric_limits<uint64_t>::max() - capacityFrames) {
            throw std::invalid_argument("Invalid progressive PCM capacity or starting frame");
        }
        data_.resize(bytesPerFrame * capacityFrames);
    }

    size_t append(const void* source, size_t frames) noexcept {
        if (!source || state_.load(std::memory_order_acquire) != PcmInputState::Open) return 0;
        const uint64_t write = publishedFrame_.load(std::memory_order_relaxed);
        const uint64_t released = releasedFrame_.load(std::memory_order_acquire);
        const auto free = capacityFrames_ - static_cast<size_t>(write - released);
        const auto count = static_cast<size_t>(std::min<uint64_t>(
            std::min(frames, free), std::numeric_limits<uint64_t>::max() - write));
        const auto offset = static_cast<size_t>((write - startFrame_) % capacityFrames_);
        const auto first = std::min(count, capacityFrames_ - offset);
        const auto* bytes = static_cast<const uint8_t*>(source);
        std::memcpy(data_.data() + offset * bytesPerFrame_, bytes, first * bytesPerFrame_);
        std::memcpy(data_.data(), bytes + first * bytesPerFrame_, (count - first) * bytesPerFrame_);
        publishedFrame_.store(write + count, std::memory_order_release);
        return count;
    }

    bool finish() noexcept {
        auto expected = PcmInputState::Open;
        return state_.compare_exchange_strong(expected, PcmInputState::Ended, std::memory_order_release);
    }

    void cancel() noexcept { state_.store(PcmInputState::Cancelled, std::memory_order_release); }

    PcmInputSnapshot snapshot() const noexcept override {
        // Observe EOF before the publication cursor: the acquire pairs with
        // finish(), so an ended snapshot always includes the final append.
        const auto state = state_.load(std::memory_order_acquire);
        const auto released = releasedFrame_.load(std::memory_order_acquire);
        return {released, publishedFrame_.load(std::memory_order_acquire), state};
    }

    PcmInputChunk read(uint64_t frame, size_t maxFrames) const noexcept override {
        const auto view = snapshot();
        if (view.state == PcmInputState::Cancelled) return {nullptr, 0, PcmReadState::Cancelled};
        if (frame < view.retainedFrame || frame > view.publishedFrame) {
            return {nullptr, 0, PcmReadState::OutsideRetainedRange};
        }
        if (frame == view.publishedFrame) {
            return {nullptr, 0, view.state == PcmInputState::Ended ? PcmReadState::Ended : PcmReadState::Waiting};
        }
        const auto offset = static_cast<size_t>((frame - startFrame_) % capacityFrames_);
        const auto count = static_cast<size_t>(std::min<uint64_t>(
            std::min(maxFrames, capacityFrames_ - offset), view.publishedFrame - frame));
        return {data_.data() + offset * bytesPerFrame_, count, PcmReadState::Ready};
    }

    // Consumer only, after device acknowledgement (and after all reads of this
    // range). A speculative render never calls this; rollback remains readable.
    bool releaseBefore(uint64_t frame) noexcept {
        const auto view = snapshot();
        if (frame < view.retainedFrame || frame > view.publishedFrame) return false;
        releasedFrame_.store(frame, std::memory_order_release);
        return true;
    }

    size_t capacityBytes() const noexcept { return data_.size(); }
    size_t bytesPerFrame() const noexcept { return bytesPerFrame_; }
    uint64_t startFrame() const noexcept { return startFrame_; }

private:
    const size_t bytesPerFrame_;
    const size_t capacityFrames_;
    const uint64_t startFrame_;
    std::vector<uint8_t> data_;
    std::atomic<uint64_t> releasedFrame_;
    std::atomic<uint64_t> publishedFrame_;
    std::atomic<PcmInputState> state_ {PcmInputState::Open};
};

} // namespace NativePlayback
