#pragma once

#include "audio_processing.h"
#include "progressive_pcm_input.h"

namespace NativePlayback {

// Serialized by PlaybackEngine's state lock. The producer talks only to its
// input, never this lifecycle object. Session allocation/destruction and DSP
// preparation run on the control thread, not render/consumption callbacks.
class ProgressivePlayback {
public:
    explicit ProgressivePlayback(ProgressiveTrack track);
    ProgressivePlayback(TrackBuffer track, OutputPolicy policy, const TrackFormat& output,
        const NativeDspConfig& dsp, ProcessedAudioPipeline& pipeline,
        uint64_t readFrame, uint64_t playedFrame, double consumedSourceFrameExact);
    ~ProgressivePlayback();

    const ProgressiveTrack& current() const { return current_->track; }
    uint64_t playedFrame() const;
    uint64_t readFrame() const { return current_->readFrame; }
    bool buffering() const { return buffering_; }
    bool cancelled() const;
    bool drained() const;
    NativeProcessingStatus processingStatus() const {
        return pipeline_.status(current_->track.format, current_->track.gain, current_->resamplerLatency);
    }

    void configure(OutputPolicy policy, const TrackFormat& output, const NativeDspConfig& dsp);
    void setDspConfig(const NativeDspConfig& dsp);
    void setGain(const NativeTrackGain& gain);
    void stageNext(ProgressiveTrack track);
    void stageNext(TrackBuffer track);
    void seekComplete(uint64_t frame);
    void clearNext();
    bool promoteNext();
    void replaceCurrent(ProgressiveTrack track);
    void validateReplacement(const ProgressiveTrack& track) const;
    bool hasNext() const { return static_cast<bool>(next_); }
    void rollback();
    void cancel();
    void collectRetired();

    size_t render(void* output, size_t frames, bool& ended);
    // Only musical frames actually consumed by the device belong here. Returns
    // true exactly once when consumption crosses into the prepared successor.
    bool consume(size_t frames);

private:
    struct Session {
        explicit Session(ProgressiveTrack source);
        ProgressiveTrack track;
        CompletePcmInput completeInput;
        const PcmInput& input() const { return track.complete ? static_cast<const PcmInput&>(completeInput) : *track.input; }
        uint64_t startFrame() const { return track.input ? track.input->startFrame() : 0; }
        void cancel() { if (track.input) track.input->cancel(); }
        uint64_t originFrame = 0;
        uint64_t readFrame = 0;
        uint64_t renderedOutputFrames = 0;
        uint64_t consumedOutputFrames = 0;
        int resamplerLatency = 0;
        bool renderEnded = false;
    };

    uint64_t playedFrame(const Session& session) const;
    void resetSession(Session& session, uint64_t frame);
    void configurePipeline();
    bool nextReady() const;
    size_t renderSession(Session& session, uint8_t* output, size_t frames);

    std::unique_ptr<Session> current_;
    std::unique_ptr<Session> next_;
    std::unique_ptr<Session> retired_;
    bool renderingNext_ = false;
    bool buffering_ = false;
    OutputPolicy policy_ = OutputPolicy::Direct;
    TrackFormat output_;
    NativeDspConfig dsp_;
    ProcessedAudioPipeline pipeline_;
};

} // namespace NativePlayback
