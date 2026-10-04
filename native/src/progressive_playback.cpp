#include "progressive_playback.h"

#include <cmath>
#include <stdexcept>

namespace NativePlayback {

ProgressivePlayback::Session::Session(ProgressiveTrack source) : track(std::move(source)) {
    if (!track.sessionId || !track.input || !track.format.sampleRate || !track.format.channels
        || track.format.bytesPerFrame() != track.input->bytesPerFrame()
        || track.input->snapshot().state == PcmInputState::Cancelled
        || track.input->snapshot().retainedFrame != track.input->startFrame()) {
        throw std::invalid_argument("Invalid or already consumed progressive native input.");
    }
    originFrame = readFrame = track.input->startFrame();
}

ProgressivePlayback::ProgressivePlayback(ProgressiveTrack track)
    : current_(std::make_unique<Session>(std::move(track))), output_(current_->track.format) {}

ProgressivePlayback::~ProgressivePlayback() { cancel(); }

uint64_t ProgressivePlayback::playedFrame(const Session& session) const {
    const auto view = session.track.input->snapshot();
    if (session.renderEnded && session.consumedOutputFrames == session.renderedOutputFrames
        && view.state == PcmInputState::Ended) return view.publishedFrame;
    // Count output consumption, not DSP source read-ahead or device silence.
    const auto advance = static_cast<uint64_t>(std::floor(
        static_cast<long double>(session.consumedOutputFrames) * session.track.format.sampleRate / output_.sampleRate));
    return std::min(session.readFrame, session.originFrame + advance);
}

uint64_t ProgressivePlayback::playedFrame() const { return playedFrame(*current_); }

bool ProgressivePlayback::cancelled() const {
    return current_->track.input->snapshot().state == PcmInputState::Cancelled;
}

bool ProgressivePlayback::drained() const {
    return current_->renderEnded && !next_
        && current_->renderedOutputFrames == current_->consumedOutputFrames && !cancelled();
}

void ProgressivePlayback::resetSession(Session& session, uint64_t frame) {
    session.originFrame = session.readFrame = frame;
    session.renderedOutputFrames = session.consumedOutputFrames = 0;
    session.renderEnded = false;
}

void ProgressivePlayback::configurePipeline() {
    if (policy_ != OutputPolicy::Processed) return;
    pipeline_.configure(current_->track.format, output_, dsp_, current_->track.gain, current_->readFrame);
    current_->resamplerLatency = pipeline_.resamplerLatencyFrames();
    if (next_) pipeline_.prepareGaplessTrack(next_->track.format);
}

void ProgressivePlayback::configure(OutputPolicy policy, const TrackFormat& output, const NativeDspConfig& dsp) {
    const auto frame = playedFrame();
    policy_ = policy;
    output_ = output;
    dsp_ = dsp;
    resetSession(*current_, frame);
    if (next_) resetSession(*next_, next_->track.input->startFrame());
    renderingNext_ = buffering_ = false;
    // A newly selected direct route may require a format change between songs.
    if (next_ && (next_->track.format.channels != output.channels
        || (policy == OutputPolicy::Direct && (next_->track.format.sampleRate != output.sampleRate
            || next_->track.format.sampleFormat != output.sampleFormat)))) clearNext();
    configurePipeline();
}

void ProgressivePlayback::setDspConfig(const NativeDspConfig& dsp) {
    dsp_ = dsp;
    if (policy_ == OutputPolicy::Processed) pipeline_.updateDspConfig(dsp);
}

void ProgressivePlayback::setGain(const NativeTrackGain& gain) {
    current_->track.gain = gain;
    if (policy_ == OutputPolicy::Processed && !renderingNext_) pipeline_.updateTrackGain(gain);
}

void ProgressivePlayback::stageNext(ProgressiveTrack track) {
    if (next_) throw std::logic_error("Clear the existing progressive successor before replacing it.");
    if (current_->renderEnded) {
        throw std::logic_error("Native output has already rendered EOF; start the successor separately.");
    }
    if (track.sessionId == current_->track.sessionId || !track.input || track.input == current_->track.input || track.input->startFrame() != 0
        || track.format.channels != output_.channels
        || (policy_ == OutputPolicy::Direct && (track.format.sampleRate != output_.sampleRate
            || track.format.sampleFormat != output_.sampleFormat))) {
        throw std::invalid_argument("Prepared progressive input must match the active output route.");
    }
    auto next = std::make_unique<Session>(std::move(track));
    if (policy_ == OutputPolicy::Processed) pipeline_.prepareGaplessTrack(next->track.format);
    collectRetired();
    next_ = std::move(next);
}

void ProgressivePlayback::clearNext() {
    if (next_) next_->track.input->cancel();
    next_.reset();
    renderingNext_ = false;
}

bool ProgressivePlayback::promoteNext() {
    if (!next_ || next_->track.input->snapshot().state == PcmInputState::Cancelled) return false;
    current_->track.input->cancel();
    current_ = std::move(next_);
    collectRetired();
    resetSession(*current_, current_->track.input->startFrame());
    renderingNext_ = buffering_ = false;
    configurePipeline();
    return true;
}

void ProgressivePlayback::replaceCurrent(ProgressiveTrack track) {
    validateReplacement(track);
    auto replacement = std::make_unique<Session>(std::move(track));
    current_->track.input->cancel();
    current_ = std::move(replacement);
    if (next_) resetSession(*next_, next_->track.input->startFrame());
    renderingNext_ = buffering_ = false;
    collectRetired();
    configurePipeline();
}

void ProgressivePlayback::validateReplacement(const ProgressiveTrack& track) const {
    const Session validated(track);
    if (track.sessionId == current_->track.sessionId || track.input == current_->track.input
        || (next_ && (track.sessionId == next_->track.sessionId || track.input == next_->track.input))) {
        throw std::invalid_argument("A seek requires a new progressive decoder session.");
    }
}

void ProgressivePlayback::rollback() {
    resetSession(*current_, playedFrame());
    if (next_) resetSession(*next_, next_->track.input->startFrame());
    renderingNext_ = buffering_ = false;
    configurePipeline();
}

void ProgressivePlayback::cancel() {
    current_->track.input->cancel();
    if (next_) next_->track.input->cancel();
    collectRetired();
    buffering_ = false;
}

void ProgressivePlayback::collectRetired() { retired_.reset(); }

bool ProgressivePlayback::nextReady() const {
    if (!next_) return false;
    const auto view = next_->track.input->snapshot();
    if (view.state == PcmInputState::Cancelled || view.publishedFrame == view.retainedFrame) return false;
    return view.state == PcmInputState::Ended
        || view.publishedFrame - view.retainedFrame >= next_->track.format.sampleRate * 3 / 4;
}

size_t ProgressivePlayback::renderSession(Session& session, uint8_t* output, size_t frames) {
    size_t written = 0;
    if (policy_ == OutputPolicy::Processed) {
        written = pipeline_.render(*session.track.input, session.readFrame, output, frames, session.renderEnded);
    } else {
        while (written < frames) {
            const auto chunk = session.track.input->read(session.readFrame, frames - written);
            if (chunk.state != PcmReadState::Ready || !chunk.frames) break;
            std::memcpy(output + written * output_.bytesPerFrame(), chunk.data, chunk.frames * output_.bytesPerFrame());
            session.readFrame += chunk.frames;
            written += chunk.frames;
        }
        const auto view = session.track.input->snapshot();
        session.renderEnded = view.state == PcmInputState::Ended && session.readFrame == view.publishedFrame;
    }
    session.renderedOutputFrames += written;
    return written;
}

size_t ProgressivePlayback::render(void* output, size_t frames, bool& ended) {
    ended = false;
    if (!output || !frames || cancelled()) return 0;
    size_t written = 0;
    while (written < frames) {
        Session& session = renderingNext_ ? *next_ : *current_;
        if (session.track.input->snapshot().state == PcmInputState::Cancelled) break;
        if (!session.renderEnded) {
            written += renderSession(session, static_cast<uint8_t*>(output) + written * output_.bytesPerFrame(), frames - written);
        }
        if (!session.renderEnded) break;
        if (renderingNext_ || !next_) { ended = true; break; }
        if (!nextReady()) break;
        renderingNext_ = true;
        if (policy_ == OutputPolicy::Processed) {
            pipeline_.beginGaplessTrack(next_->track.format, next_->track.gain);
            next_->resamplerLatency = pipeline_.resamplerLatencyFrames();
        }
    }
    buffering_ = written < frames && !ended;
    return written;
}

bool ProgressivePlayback::consume(size_t frames) {
    if (!frames || cancelled()) return false;
    bool transitioned = false;
    while (frames) {
        const auto available = current_->renderedOutputFrames - current_->consumedOutputFrames;
        const auto count = std::min<uint64_t>(available, frames);
        current_->consumedOutputFrames += count;
        frames -= static_cast<size_t>(count);
        current_->track.input->releaseBefore(playedFrame());
        if (!frames || !renderingNext_ || !next_ || !next_->renderedOutputFrames) break;
        // stageNext() collected the previous retired owner on the control
        // thread. Keep this one alive until a later control/poll call.
        retired_ = std::move(current_);
        current_ = std::move(next_);
        renderingNext_ = false;
        transitioned = true;
    }
    return transitioned;
}

} // namespace NativePlayback
