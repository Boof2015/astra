#include "playback_engine.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>

namespace NativePlayback {

namespace {

float readNormalizedSample(const uint8_t* sampleData, SampleFormat sampleFormat) {
    switch (sampleFormat) {
        case SampleFormat::Int16: {
            int16_t value = 0;
            std::memcpy(&value, sampleData, sizeof(int16_t));
            return static_cast<float>(value) / 32768.0f;
        }
        case SampleFormat::Int32: {
            int32_t value = 0;
            std::memcpy(&value, sampleData, sizeof(int32_t));
            return static_cast<float>(value) / 2147483648.0f;
        }
        case SampleFormat::Float32:
        default: {
            float value = 0.0f;
            std::memcpy(&value, sampleData, sizeof(float));
            return value;
        }
    }
}

} // namespace

uint32_t TrackFormat::bytesPerSample() const {
    switch (sampleFormat) {
        case SampleFormat::Int16:
            return 2;
        case SampleFormat::Int32:
        case SampleFormat::Float32:
        default:
            return 4;
    }
}

uint32_t TrackFormat::bytesPerFrame() const {
    return std::max<uint32_t>(1, channels) * bytesPerSample();
}

std::string TrackFormat::sampleFormatId() const {
    switch (sampleFormat) {
        case SampleFormat::Int16:
            return "s16";
        case SampleFormat::Int32:
            return "s32";
        case SampleFormat::Float32:
        default:
            return "f32";
    }
}

uint64_t TrackBuffer::totalFrames() const {
    const uint32_t bytesPerFrame = format.bytesPerFrame();
    if (bytesPerFrame == 0) return 0;
    return static_cast<uint64_t>(data.size() / bytesPerFrame);
}

TrackFormat BuildTrackFormat(uint32_t sampleRate, uint32_t channels, const std::string& sampleFormatId) {
    TrackFormat format;
    format.sampleRate = sampleRate;
    format.channels = std::max<uint32_t>(1, channels);
    if (sampleFormatId == "s16") {
        format.sampleFormat = SampleFormat::Int16;
    } else if (sampleFormatId == "s32") {
        format.sampleFormat = SampleFormat::Int32;
    } else {
        format.sampleFormat = SampleFormat::Float32;
    }
    return format;
}

PlaybackEngine::PlaybackEngine()
    : sink_(CreatePlatformAudioSink()) {}

PlaybackEngine::~PlaybackEngine() = default;

std::vector<OutputDeviceInfo> PlaybackEngine::getOutputDevices(std::string* reason) const {
    return sink_->enumerateOutputDevices(reason);
}

uint32_t PlaybackEngine::getSelectedDeviceMaxChannels() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return sink_->deviceMaxChannels(selectedDeviceId_);
}

std::string PlaybackEngine::getSelectedDeviceId() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return selectedDeviceId_;
}

void PlaybackEngine::setSelectedDeviceId(const std::string& deviceId) {
    std::string error;
    bool shouldRestart = false;
    bool wasPaused = false;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        selectedDeviceId_ = deviceId;
        shouldRestart = hasCurrentTrack_ && state_ == State::Playing;
        wasPaused = hasCurrentTrack_ && state_ == State::Paused;
    }

    if (!hasCurrentTrack_) {
        return;
    }

    if (!ensureSinkOpen(&error)) {
        throw std::runtime_error(error.empty() ? "Failed to select native output device." : error);
    }

    if (shouldRestart) {
        sink_->reset();
        if (!sink_->start(&error)) {
            throw std::runtime_error(error.empty() ? "Failed to restart native output after device change." : error);
        }
    } else if (wasPaused) {
        sink_->reset();
    }
}

bool PlaybackEngine::isBitPerfectAvailable(std::string* reason) const {
    if (sink_->supportsBitPerfect()) {
        if (reason) reason->clear();
        return true;
    }
    if (reason) {
        *reason = lastUnavailableReason_.empty()
            ? "Native bit-perfect playback is unavailable on this platform."
            : lastUnavailableReason_;
    }
    return false;
}

std::string PlaybackEngine::backendKind() const {
    return sink_->backendKind();
}

void PlaybackEngine::loadTrack(TrackBuffer track) {
    bool hadTrack = false;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        hadTrack = hasCurrentTrack_;
        currentTrack_ = std::move(track);
        hasCurrentTrack_ = true;
        nextTrack_ = TrackBuffer{};
        hasNextTrack_ = false;
        nextRenderFrame_ = 0;
        playedFrame_ = 0;
        state_ = State::Stopped;
        clearTapBuffersLocked();
        pendingEvents_.clear();
    }

    if (hadTrack) {
        sink_->close();
    }
}

void PlaybackEngine::preloadNextTrack(TrackBuffer track) {
    std::lock_guard<std::mutex> lock(mutex_);
    nextTrack_ = std::move(track);
    hasNextTrack_ = true;
}

void PlaybackEngine::clearNextTrack() {
    std::lock_guard<std::mutex> lock(mutex_);
    nextTrack_ = TrackBuffer{};
    hasNextTrack_ = false;
}

PlaybackSnapshot PlaybackEngine::play() {
    std::string error;
    bool alreadyPlaying = false;
    State previousState = State::Stopped;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!hasCurrentTrack_) {
            alreadyPlaying = true;
        } else if (state_ == State::Playing) {
            alreadyPlaying = true;
        } else {
            previousState = state_;
        }
    }
    if (alreadyPlaying) {
        return getSnapshot();
    }

    if (!ensureSinkOpen(&error)) {
        throw std::runtime_error(error.empty() ? "Failed to open native output." : error);
    }

    {
        std::lock_guard<std::mutex> lock(mutex_);
        const State previousState = state_;
        state_ = State::Playing;
        if (previousState != State::Paused) {
            sink_->reset();
        }
        pushEvent({
            "stateChange",
            "playing",
            static_cast<double>(playedFrame_) / static_cast<double>(std::max<uint32_t>(1, currentTrack_.format.sampleRate)),
            currentTrack_.duration,
            static_cast<int>(currentTrack_.format.sampleRate),
            currentTrack_.format.sampleFormatId(),
            sink_->activeDeviceId(),
            ""
        });
    }

    if (!sink_->start(&error)) {
        std::lock_guard<std::mutex> lock(mutex_);
        state_ = previousState;
        nextRenderFrame_ = playedFrame_;
        pushEvent({
            "stateChange",
            previousState == State::Paused ? "paused" : "stopped",
            static_cast<double>(playedFrame_) / static_cast<double>(std::max<uint32_t>(1, currentTrack_.format.sampleRate)),
            currentTrack_.duration,
            static_cast<int>(currentTrack_.format.sampleRate),
            currentTrack_.format.sampleFormatId(),
            sink_->activeDeviceId(),
            ""
        });
        throw std::runtime_error(error.empty() ? "Failed to start native output." : error);
    }
    return getSnapshot();
}

PlaybackSnapshot PlaybackEngine::pause() {
    bool shouldPause = false;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        shouldPause = state_ == State::Playing;
    }
    if (!shouldPause) {
        return getSnapshot();
    }
    sink_->pause();
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ == State::Playing) {
            state_ = State::Paused;
        }
        nextRenderFrame_ = playedFrame_;
        pushEvent({
            "stateChange",
            "paused",
            static_cast<double>(playedFrame_) / static_cast<double>(std::max<uint32_t>(1, currentTrack_.format.sampleRate)),
            currentTrack_.duration,
            static_cast<int>(currentTrack_.format.sampleRate),
            currentTrack_.format.sampleFormatId(),
            sink_->activeDeviceId(),
            ""
        });
    }
    return getSnapshot();
}

PlaybackSnapshot PlaybackEngine::stop() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        state_ = State::Stopped;
        nextRenderFrame_ = 0;
        playedFrame_ = 0;
        clearTapBuffersLocked();
        if (hasCurrentTrack_) {
            pushEvent({
                "stateChange",
                "stopped",
                0.0,
                currentTrack_.duration,
                static_cast<int>(currentTrack_.format.sampleRate),
                currentTrack_.format.sampleFormatId(),
                sink_->activeDeviceId(),
                ""
            });
            pushEvent({
                "timeUpdate",
                "",
                0.0,
                0.0,
                0,
                "",
                "",
                ""
            });
        }
    }

    sink_->stop();
    return getSnapshot();
}

PlaybackSnapshot PlaybackEngine::seek(double seconds) {
    bool shouldRestart = false;
    bool wasPlaying = false;
    bool hasTrack = true;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!hasCurrentTrack_) {
            hasTrack = false;
        } else {
            const uint64_t targetFrame = clampTargetFrameLocked(seconds);
            nextRenderFrame_ = targetFrame;
            playedFrame_ = targetFrame;
            clearTapBuffersLocked();
            pushEvent({
                "timeUpdate",
                "",
                static_cast<double>(targetFrame) / static_cast<double>(std::max<uint32_t>(1, currentTrack_.format.sampleRate)),
                0.0,
                0,
                "",
                "",
                ""
            });

            shouldRestart = state_ == State::Playing || state_ == State::Paused;
            wasPlaying = state_ == State::Playing;
        }
    }
    if (!hasTrack) {
        return getSnapshot();
    }
    if (shouldRestart) {
        sink_->reset();
        if (wasPlaying) {
            std::string error;
            if (!sink_->start(&error)) {
                throw std::runtime_error(error.empty() ? "Failed to restart native output after seek." : error);
            }
        }
    }

    return getSnapshot();
}

PlaybackSnapshot PlaybackEngine::getSnapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    PlaybackSnapshot snapshot;
    switch (state_) {
        case State::Playing:
            snapshot.playbackState = "playing";
            break;
        case State::Paused:
            snapshot.playbackState = "paused";
            break;
        case State::Stopped:
        default:
            snapshot.playbackState = "stopped";
            break;
    }
    snapshot.currentTime = hasCurrentTrack_
        ? static_cast<double>(playedFrame_) / static_cast<double>(std::max<uint32_t>(1, currentTrack_.format.sampleRate))
        : 0.0;
    snapshot.duration = hasCurrentTrack_ ? currentTrack_.duration : 0.0;
    snapshot.sampleRate = hasCurrentTrack_ ? static_cast<int>(currentTrack_.format.sampleRate) : 0;
    snapshot.channels = hasCurrentTrack_ ? static_cast<int>(currentTrack_.format.channels) : 0;
    snapshot.sampleFormat = hasCurrentTrack_ ? currentTrack_.format.sampleFormatId() : "";
    snapshot.deviceId = sink_->activeDeviceId();
    snapshot.deviceLabel = sink_->activeDeviceLabel();
    snapshot.activeBackend = sink_->backendKind();
    snapshot.activeDeviceExclusive = sink_->isExclusive();
    snapshot.bitPerfectActive = hasCurrentTrack_ && sink_->supportsBitPerfect();
    return snapshot;
}

std::vector<PlaybackEvent> PlaybackEngine::drainEvents() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<PlaybackEvent> drained = std::move(pendingEvents_);
    pendingEvents_.clear();
    return drained;
}

std::vector<float> PlaybackEngine::drainOscilloscopeSamples() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<float> drained = std::move(oscilloscopeTap_);
    oscilloscopeTap_.clear();
    return drained;
}

std::vector<float> PlaybackEngine::drainSpectrumSamples() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<float> drained = std::move(spectrumTap_);
    spectrumTap_.clear();
    return drained;
}

VectorscopeSamples PlaybackEngine::drainVectorscopeSamples() {
    std::lock_guard<std::mutex> lock(mutex_);
    VectorscopeSamples drained;
    drained.left = std::move(vectorscopeLeftTap_);
    drained.right = std::move(vectorscopeRightTap_);
    vectorscopeLeftTap_.clear();
    vectorscopeRightTap_.clear();
    return drained;
}

size_t PlaybackEngine::renderInto(void* outputBuffer, size_t requestedFrames, bool& streamEnded) {
    std::lock_guard<std::mutex> lock(mutex_);
    streamEnded = false;
    if (state_ != State::Playing || !hasCurrentTrack_) {
        return 0;
    }

    const uint32_t bytesPerFrame = currentTrack_.format.bytesPerFrame();
    uint8_t* output = static_cast<uint8_t*>(outputBuffer);
    size_t framesWritten = 0;

    while (framesWritten < requestedFrames) {
        const uint64_t totalFrames = currentTrack_.totalFrames();
        if (nextRenderFrame_ >= totalFrames) {
            if (hasNextTrack_ && formatsMatch(currentTrack_.format, nextTrack_.format)) {
                currentTrack_ = nextTrack_;
                hasNextTrack_ = false;
                nextTrack_ = TrackBuffer{};
                nextRenderFrame_ = 0;
                playedFrame_ = 0;
                clearTapBuffersLocked();
                pushEvent({
                    "durationChange",
                    "",
                    0.0,
                    currentTrack_.duration,
                    0,
                    "",
                    "",
                    ""
                });
                pushEvent({
                    "gaplessTransition",
                    "",
                    0.0,
                    currentTrack_.duration,
                    static_cast<int>(currentTrack_.format.sampleRate),
                    currentTrack_.format.sampleFormatId(),
                    sink_->activeDeviceId(),
                    ""
                });
                continue;
            }

            state_ = State::Stopped;
            streamEnded = true;
            pushEvent({
                "stateChange",
                "stopped",
                currentTrack_.duration,
                currentTrack_.duration,
                static_cast<int>(currentTrack_.format.sampleRate),
                currentTrack_.format.sampleFormatId(),
                sink_->activeDeviceId(),
                ""
            });
            pushEvent({
                "ended",
                "",
                0.0,
                0.0,
                0,
                "",
                "",
                ""
            });
            break;
        }

        const uint64_t framesRemaining = totalFrames - nextRenderFrame_;
        const size_t framesToCopy = static_cast<size_t>(std::min<uint64_t>(
            static_cast<uint64_t>(requestedFrames - framesWritten),
            framesRemaining
        ));
        const uint8_t* source = currentTrack_.data.data() + (nextRenderFrame_ * bytesPerFrame);
        std::memcpy(output + (framesWritten * bytesPerFrame), source, framesToCopy * bytesPerFrame);
        appendTapSamplesLocked(source, framesToCopy);
        nextRenderFrame_ += framesToCopy;
        framesWritten += framesToCopy;
    }

    return framesWritten;
}

void PlaybackEngine::onFramesConsumed(size_t frames) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!hasCurrentTrack_ || currentTrack_.format.sampleRate == 0 || frames == 0) {
        return;
    }
    playedFrame_ = std::min<uint64_t>(nextRenderFrame_, playedFrame_ + frames);
    pushEvent({
        "timeUpdate",
        "",
        static_cast<double>(playedFrame_) / static_cast<double>(currentTrack_.format.sampleRate),
        0.0,
        0,
        "",
        "",
        ""
    });
}

bool PlaybackEngine::ensureSinkOpen(std::string* error) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!hasCurrentTrack_) {
        if (error) *error = "No track loaded for native playback.";
        return false;
    }

    const std::string previousDeviceId = sink_->activeDeviceId();
    const int previousSampleRate = currentTrack_.format.sampleRate;
    const std::string previousSampleFormat = currentTrack_.format.sampleFormatId();

    if (!sink_->open(selectedDeviceId_, currentTrack_.format, this, error)) {
        lastUnavailableReason_ = (error && !error->empty())
            ? *error
            : "Failed to open the selected native output device.";
        return false;
    }

    const std::string activeDeviceId = sink_->activeDeviceId();
    if (activeDeviceId != previousDeviceId) {
        pushEvent({
            "deviceReopened",
            "",
            0.0,
            0.0,
            previousSampleRate,
            previousSampleFormat,
            activeDeviceId,
            ""
        });
    }
    pushEvent({
        "sampleRateChanged",
        "",
        0.0,
        0.0,
        static_cast<int>(currentTrack_.format.sampleRate),
        currentTrack_.format.sampleFormatId(),
        activeDeviceId,
        ""
    });
    return true;
}

void PlaybackEngine::pushEvent(const PlaybackEvent& event) {
    pendingEvents_.push_back(event);
}

void PlaybackEngine::clearTapBuffersLocked() {
    oscilloscopeTap_.clear();
    spectrumTap_.clear();
    vectorscopeLeftTap_.clear();
    vectorscopeRightTap_.clear();
}

void PlaybackEngine::appendTapSamplesLocked(const uint8_t* interleavedData, size_t frames) {
    const uint32_t channels = std::max<uint32_t>(1, currentTrack_.format.channels);
    const uint32_t bytesPerSample = currentTrack_.format.bytesPerSample();

    for (size_t frameIndex = 0; frameIndex < frames; frameIndex++) {
        const uint8_t* framePtr = interleavedData + (frameIndex * currentTrack_.format.bytesPerFrame());
        const float left = readNormalizedSample(framePtr, currentTrack_.format.sampleFormat);
        const float right = channels >= 2
            ? readNormalizedSample(framePtr + bytesPerSample, currentTrack_.format.sampleFormat)
            : left;
        const float mono = channels >= 2 ? (left + right) * 0.5f : left;

        oscilloscopeTap_.push_back(left);
        spectrumTap_.push_back(mono);
        vectorscopeLeftTap_.push_back(left);
        vectorscopeRightTap_.push_back(right);
    }

    trimTapBuffer(oscilloscopeTap_, maxTapSamples_);
    trimTapBuffer(spectrumTap_, maxTapSamples_);
    trimTapBuffer(vectorscopeLeftTap_, maxTapSamples_);
    trimTapBuffer(vectorscopeRightTap_, maxTapSamples_);
}

bool PlaybackEngine::formatsMatch(const TrackFormat& a, const TrackFormat& b) const {
    return a.sampleRate == b.sampleRate
        && a.channels == b.channels
        && a.sampleFormat == b.sampleFormat;
}

uint64_t PlaybackEngine::clampTargetFrameLocked(double seconds) const {
    if (!hasCurrentTrack_ || currentTrack_.format.sampleRate == 0) return 0;
    if (!std::isfinite(seconds) || seconds <= 0) return 0;
    const double clampedSeconds = std::min(seconds, currentTrack_.duration);
    const double exactFrame = clampedSeconds * static_cast<double>(currentTrack_.format.sampleRate);
    const uint64_t target = exactFrame <= 0.0
        ? 0
        : static_cast<uint64_t>(std::floor(exactFrame));
    return std::min<uint64_t>(target, currentTrack_.totalFrames());
}

void PlaybackEngine::trimTapBuffer(std::vector<float>& buffer, size_t maxSize) const {
    if (buffer.size() <= maxSize) {
        return;
    }
    buffer.erase(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(buffer.size() - maxSize));
}

} // namespace NativePlayback
