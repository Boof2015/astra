#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>

namespace NativePlayback {

enum class PcmInputState { Open, Ended, Cancelled };
enum class PcmReadState { Ready, Waiting, Ended, Cancelled, OutsideRetainedRange };

struct PcmInputSnapshot {
    uint64_t retainedFrame = 0;
    uint64_t publishedFrame = 0;
    PcmInputState state = PcmInputState::Open;
};

struct PcmInputChunk {
    const uint8_t* data = nullptr;
    size_t frames = 0;
    PcmReadState state = PcmReadState::Waiting;
};

// A read never waits for a decoder. The consumer owns the returned span until
// it explicitly releases that range; rendering alone must not release input
// that a failed device start or pause can still need to replay.
class PcmInput {
public:
    virtual ~PcmInput() = default;
    virtual PcmInputSnapshot snapshot() const noexcept = 0;
    virtual PcmInputChunk read(uint64_t frame, size_t maxFrames) const noexcept = 0;
};

// Keeps the complete-track DSP entry point on its existing immutable PCM.
class CompletePcmInput final : public PcmInput {
public:
    CompletePcmInput(const uint8_t* data, uint64_t frames, size_t bytesPerFrame)
        : data_(data), frames_(frames), bytesPerFrame_(bytesPerFrame) {}

    PcmInputSnapshot snapshot() const noexcept override {
        return {0, frames_, PcmInputState::Ended};
    }

    PcmInputChunk read(uint64_t frame, size_t maxFrames) const noexcept override {
        if (frame >= frames_) return {nullptr, 0, PcmReadState::Ended};
        const auto count = static_cast<size_t>(std::min<uint64_t>(maxFrames, frames_ - frame));
        return {data_ + frame * bytesPerFrame_, count, PcmReadState::Ready};
    }

private:
    const uint8_t* data_;
    uint64_t frames_;
    size_t bytesPerFrame_;
};

} // namespace NativePlayback
