#pragma once

#include "playback_engine.h"

#include <cstddef>
#include <cstdint>
#include <memory>

namespace NativePlayback {

class ProcessedAudioPipeline {
public:
    ProcessedAudioPipeline();
    ~ProcessedAudioPipeline();

    void configure(
        const TrackFormat& sourceFormat,
        const TrackFormat& outputFormat,
        const NativeDspConfig& config,
        const NativeTrackGain& gain,
        uint64_t sourceFrame
    );
    void updateDspConfig(const NativeDspConfig& config);
    void updateTrackGain(const NativeTrackGain& gain);
    void prepareGaplessTrack(const TrackFormat& sourceFormat);
    void beginGaplessTrack(const TrackFormat& sourceFormat, const NativeTrackGain& gain);
    void reset(uint64_t sourceFrame);

    size_t render(
        const TrackBuffer& track,
        uint64_t& sourceFrame,
        void* output,
        size_t requestedFrames,
        bool& streamEnded
    );

    NativeProcessingStatus status() const;
    const TrackFormat& outputFormat() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace NativePlayback
