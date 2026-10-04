#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <vector>

namespace NativePlayback {

// Metadata for successfully submitted endpoint frames, in device order. A bit
// marks musical PCM (including naturally silent samples); zero marks padding
// inserted by the sink after a short render. Only musical consumption advances
// the engine. One bit per endpoint frame bounds memory even for one-frame writes
// alternating between audio and silence. Allocate once before starting output;
// append/consume/reset do not allocate. Used by one sink thread, not concurrently.
class EndpointFrameQueue {
public:
    explicit EndpointFrameQueue(size_t capacityFrames) : capacity_(capacityFrames) {
        if (!capacity_ || capacity_ > std::numeric_limits<size_t>::max() / 2) {
            throw std::invalid_argument("Invalid endpoint frame capacity.");
        }
        audio_.resize(capacity_ / 64 + (capacity_ % 64 != 0));
    }

    size_t queuedFrames() const noexcept { return queued_; }
    size_t queuedAudioFrames() const noexcept { return queuedAudio_; }

    // Each sink write contains an audio prefix followed by optional silence.
    // Record only frames the device accepted. Invalid writes leave state intact.
    bool append(size_t frames, size_t audioFrames) noexcept {
        if (audioFrames > frames || frames > capacity_ - queued_) return false;
        const size_t tail = (head_ + queued_) % capacity_;
        writeBits(tail, audioFrames, true);
        writeBits((tail + audioFrames) % capacity_, frames - audioFrames, false);
        queued_ += frames;
        queuedAudio_ += audioFrames;
        return true;
    }

    size_t consume(size_t frames) noexcept {
        frames = std::min(frames, queued_);
        queued_ -= frames;
        size_t audioFrames = 0;
        while (frames) {
            const size_t offset = head_ % 64;
            const size_t count = std::min({frames, 64 - offset, capacity_ - head_});
            audioFrames += population(audio_[head_ / 64] & mask(offset, count));
            head_ = (head_ + count) % capacity_;
            frames -= count;
        }
        queuedAudio_ -= audioFrames;
        return audioFrames;
    }

    // Padding is a snapshot of outstanding device frames, not a fresh count of
    // consumed frames. Repeated identical snapshots must never advance playback.
    size_t updatePadding(size_t padding) noexcept {
        return consume(queued_ > padding ? queued_ - padding : 0);
    }

    // ALSA reports free space, including space that has never held submitted PCM.
    size_t updateAvailable(size_t available) noexcept {
        return updatePadding(capacity_ - std::min(capacity_, available));
    }

    void reset() noexcept { head_ = queued_ = queuedAudio_ = 0; }

private:
    static uint64_t mask(size_t offset, size_t count) noexcept {
        return (std::numeric_limits<uint64_t>::max() >> (64 - count)) << offset;
    }

    static size_t population(uint64_t bits) noexcept {
        // Portable C++17 popcount; no platform instruction-set requirement.
        bits -= (bits >> 1) & UINT64_C(0x5555555555555555);
        bits = (bits & UINT64_C(0x3333333333333333)) + ((bits >> 2) & UINT64_C(0x3333333333333333));
        bits = (bits + (bits >> 4)) & UINT64_C(0x0f0f0f0f0f0f0f0f);
        return static_cast<size_t>((bits * UINT64_C(0x0101010101010101)) >> 56);
    }

    void writeBits(size_t start, size_t frames, bool audio) noexcept {
        while (frames) {
            const size_t offset = start % 64;
            const size_t count = std::min({frames, 64 - offset, capacity_ - start});
            const uint64_t bits = mask(offset, count);
            if (audio) audio_[start / 64] |= bits;
            else audio_[start / 64] &= ~bits;
            start = (start + count) % capacity_;
            frames -= count;
        }
    }

    const size_t capacity_;
    std::vector<uint64_t> audio_;
    size_t head_ = 0;
    size_t queued_ = 0;
    size_t queuedAudio_ = 0;
};

} // namespace NativePlayback
