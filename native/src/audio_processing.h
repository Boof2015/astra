#pragma once

#include "playback_engine.h"
#include "pcm_input.h"

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

    // Incremental-input boundary used by progressive native playback.
    // Callers must match sourceFormat, retain uncommitted input, and count only
    // returned musical frames when the device fills a short render with silence.
    size_t render(
        const PcmInput& input,
        uint64_t& sourceFrame,
        void* output,
        size_t requestedFrames,
        bool& streamEnded
    );

    NativeProcessingStatus status() const;
    // A progressive render can be ahead of the device's current track. Describe
    // that acknowledged source while retaining the pipeline's output/DSP state.
    NativeProcessingStatus status(const TrackFormat& source, const NativeTrackGain& gain, int resamplerLatency) const;
    int resamplerLatencyFrames() const;
    const TrackFormat& outputFormat() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace NativePlayback
