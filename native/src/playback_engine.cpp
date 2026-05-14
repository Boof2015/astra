#include "playback_engine.h"

#include <algorithm>
#include <array>
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

FloatSampleRingBuffer::FloatSampleRingBuffer(size_t capacity) {
    setCapacity(capacity);
}

void FloatSampleRingBuffer::setCapacity(size_t capacity) {
    data_.assign(capacity, 0.0f);
    start_ = 0;
    size_ = 0;
}

void FloatSampleRingBuffer::clear() {
    start_ = 0;
    size_ = 0;
}

void FloatSampleRingBuffer::push(float sample) {
    if (data_.empty()) {
        return;
    }

    if (size_ < data_.size()) {
        const size_t index = (start_ + size_) % data_.size();
        data_[index] = sample;
        size_++;
        return;
    }

    data_[start_] = sample;
    start_ = (start_ + 1) % data_.size();
}

std::vector<float> FloatSampleRingBuffer::drain() {
    std::vector<float> drained(size_);
    if (size_ == 0 || data_.empty()) {
        clear();
        return drained;
    }

    const size_t firstCount = std::min(size_, data_.size() - start_);
    std::copy_n(data_.begin() + static_cast<std::ptrdiff_t>(start_), firstCount, drained.begin());
    if (size_ > firstCount) {
        std::copy_n(data_.begin(), size_ - firstCount, drained.begin() + static_cast<std::ptrdiff_t>(firstCount));
    }

    clear();
    return drained;
}

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
    : sink_(CreatePlatformAudioSink())
    , oscilloscopeTap_(kMaxTapSamples)
    , spectrumTap_(kMaxTapSamples)
    , vectorscopeLeftTap_(kMaxTapSamples)
    , vectorscopeRightTap_(kMaxTapSamples) {
    pendingEvents_.reserve(128);
}

PlaybackEngine::~PlaybackEngine() = default;

std::vector<OutputDeviceInfo> PlaybackEngine::getOutputDevices(std::string* reason) const {
    return sink_->enumerateOutputDevices(reason);
}

uint32_t PlaybackEngine::getSelectedDeviceMaxChannels() const {
    std::lock_guard<std::mutex> lock(stateMutex_);
    return sink_->deviceMaxChannels(selectedDeviceId_);
}

std::string PlaybackEngine::getSelectedDeviceId() const {
    std::lock_guard<std::mutex> lock(stateMutex_);
    return selectedDeviceId_;
}

void PlaybackEngine::setSelectedDeviceId(const std::string& deviceId) {
    std::lock_guard<std::mutex> controlLock(controlMutex_);
    std::string error;
    bool hasTrack = false;
    bool shouldRestart = false;
    bool wasPaused = false;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        selectedDeviceId_ = deviceId;
        hasTrack = hasCurrentTrack_;
        shouldRestart = hasCurrentTrack_ && state_ == State::Playing;
        wasPaused = hasCurrentTrack_ && state_ == State::Paused;
    }

    if (!hasTrack) {
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

int PlaybackEngine::getActiveDeviceSampleRate() const {
    return sink_->activeDeviceSampleRate();
}

void PlaybackEngine::loadTrack(TrackBuffer track) {
    std::lock_guard<std::mutex> controlLock(controlMutex_);
    bool hadTrack = false;
    TrackFormat previousFormat {};
    const TrackFormat nextFormat = track.format;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        hadTrack = hasCurrentTrack_;
        if (hadTrack) {
            previousFormat = currentTrack_.format;
        }
        currentTrack_ = std::move(track);
        hasCurrentTrack_ = true;
        nextTrack_ = TrackBuffer{};
        hasNextTrack_ = false;
        nextRenderFrame_ = 0;
        playedFrame_ = 0;
        lastTimeUpdateFrame_ = 0;
        fadeInRemaining_ = 0;
        state_ = State::Stopped;
    }
    clearTapBuffers();
    clearPendingEvents();

    if (hadTrack) {
        if (sink_->shouldCloseOnTrackChange(previousFormat, nextFormat)) {
            sink_->close();
        } else {
            sink_->stop();
        }
    }
}

void PlaybackEngine::preloadNextTrack(TrackBuffer track) {
    std::lock_guard<std::mutex> controlLock(controlMutex_);
    std::lock_guard<std::mutex> lock(stateMutex_);
    nextTrack_ = std::move(track);
    hasNextTrack_ = true;
}

bool PlaybackEngine::promoteNextTrack() {
    std::lock_guard<std::mutex> controlLock(controlMutex_);
    bool hadTrack = false;
    TrackFormat previousFormat {};
    TrackFormat nextFormat {};
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (!hasNextTrack_) {
            return false;
        }

        hadTrack = hasCurrentTrack_;
        if (hadTrack) {
            previousFormat = currentTrack_.format;
        }
        nextFormat = nextTrack_.format;
        currentTrack_ = std::move(nextTrack_);
        hasCurrentTrack_ = true;
        nextTrack_ = TrackBuffer{};
        hasNextTrack_ = false;
        nextRenderFrame_ = 0;
        playedFrame_ = 0;
        lastTimeUpdateFrame_ = 0;
        fadeInRemaining_ = 0;
        state_ = State::Stopped;
    }
    clearTapBuffers();
    clearPendingEvents();

    if (hadTrack) {
        if (sink_->shouldCloseOnTrackChange(previousFormat, nextFormat)) {
            sink_->close();
        } else {
            sink_->stop();
        }
    }

    return true;
}

void PlaybackEngine::clearNextTrack() {
    std::lock_guard<std::mutex> controlLock(controlMutex_);
    std::lock_guard<std::mutex> lock(stateMutex_);
    nextTrack_ = TrackBuffer{};
    hasNextTrack_ = false;
}

PlaybackSnapshot PlaybackEngine::play() {
    std::lock_guard<std::mutex> controlLock(controlMutex_);
    std::string error;
    bool alreadyPlaying = false;
    State previousState = State::Stopped;
    bool shouldReset = false;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (!hasCurrentTrack_) {
            alreadyPlaying = true;
        } else if (state_ == State::Playing) {
            alreadyPlaying = true;
        } else {
            previousState = state_;
            shouldReset = previousState != State::Paused;
        }
    }
    if (alreadyPlaying) {
        return getSnapshot();
    }

    if (!ensureSinkOpen(&error)) {
        throw std::runtime_error(error.empty() ? "Failed to open native output." : error);
    }

    if (shouldReset) {
        sink_->reset();
    }

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        state_ = State::Playing;
        if (shouldReset) {
            fadeInRemaining_ = kFadeInFrames;
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
        std::lock_guard<std::mutex> lock(stateMutex_);
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
    std::lock_guard<std::mutex> controlLock(controlMutex_);
    bool shouldPause = false;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        shouldPause = state_ == State::Playing;
    }
    if (!shouldPause) {
        return getSnapshot();
    }
    sink_->pause();
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
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
    std::lock_guard<std::mutex> controlLock(controlMutex_);
    double duration = 0.0;
    int sampleRate = 0;
    std::string sampleFormatId;
    std::string activeDeviceId;
    bool hadTrack = false;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        state_ = State::Stopped;
        nextRenderFrame_ = 0;
        playedFrame_ = 0;
        lastTimeUpdateFrame_ = 0;
        fadeInRemaining_ = 0;
        hadTrack = hasCurrentTrack_;
        if (hadTrack) {
            duration = currentTrack_.duration;
            sampleRate = static_cast<int>(currentTrack_.format.sampleRate);
            sampleFormatId = currentTrack_.format.sampleFormatId();
            activeDeviceId = sink_->activeDeviceId();
        }
    }
    clearTapBuffers();
    if (hadTrack) {
        pushEvent({
            "stateChange",
            "stopped",
            0.0,
            duration,
            sampleRate,
            sampleFormatId,
            activeDeviceId,
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

    sink_->stop();
    return getSnapshot();
}

PlaybackSnapshot PlaybackEngine::seek(double seconds) {
    std::lock_guard<std::mutex> controlLock(controlMutex_);
    bool shouldRestart = false;
    bool wasPlaying = false;
    bool hasTrack = true;
    double currentTime = 0.0;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (!hasCurrentTrack_) {
            hasTrack = false;
        } else {
            shouldRestart = state_ == State::Playing || state_ == State::Paused;
            wasPlaying = state_ == State::Playing;
        }
    }

    if (hasTrack && shouldRestart) {
        sink_->beginSeek(wasPlaying);
    }

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (!hasCurrentTrack_) {
            hasTrack = false;
        } else {
            const uint64_t targetFrame = clampTargetFrameLocked(seconds);
            nextRenderFrame_ = targetFrame;
            playedFrame_ = targetFrame;
            lastTimeUpdateFrame_ = targetFrame;
            fadeInRemaining_ = kFadeInFrames;
            currentTime = static_cast<double>(targetFrame) / static_cast<double>(std::max<uint32_t>(1, currentTrack_.format.sampleRate));
        }
    }

    clearTapBuffers();
    if (hasTrack) {
        pushEvent({
            "timeUpdate",
            "",
            currentTime,
            0.0,
            0,
            "",
            "",
            ""
        });
    }
    if (!hasTrack) {
        return getSnapshot();
    }
    if (shouldRestart) {
        sink_->resetAfterSeek(wasPlaying);
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
    std::lock_guard<std::mutex> lock(stateMutex_);
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
    snapshot.bitPerfectActive = hasCurrentTrack_ && sink_->supportsBitPerfect() && sink_->isExclusive();
    return snapshot;
}

void PlaybackEngine::setVisualizerTapDemand(const VisualizerTapDemand& demand) {
    bool clearOscilloscope = false;
    bool clearSpectrum = false;
    bool clearVectorscope = false;
    bool clearVUMeter = false;

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        clearOscilloscope = visualizerTapDemand_.oscilloscope && !demand.oscilloscope;
        clearSpectrum = visualizerTapDemand_.spectrum && !demand.spectrum;
        clearVectorscope = visualizerTapDemand_.vectorscope && !demand.vectorscope;
        clearVUMeter = visualizerTapDemand_.vumeter && !demand.vumeter;
        visualizerTapDemand_ = demand;
    }

    if (!clearOscilloscope && !clearSpectrum && !clearVectorscope && !clearVUMeter) {
        return;
    }

    std::lock_guard<std::mutex> lock(tapMutex_);
    if (clearOscilloscope) {
        oscilloscopeTap_.clear();
    }
    if (clearSpectrum) {
        spectrumTap_.clear();
    }
    if (clearVectorscope) {
        vectorscopeLeftTap_.clear();
        vectorscopeRightTap_.clear();
    }
    if (clearVUMeter) {
        vumeterTaps_.clear();
    }
}

VisualizerTapDemand PlaybackEngine::getVisualizerTapDemand() const {
    std::lock_guard<std::mutex> lock(stateMutex_);
    return visualizerTapDemand_;
}

std::vector<PlaybackEvent> PlaybackEngine::drainEvents() {
    std::lock_guard<std::mutex> lock(eventMutex_);
    std::vector<PlaybackEvent> drained;
    drained.swap(pendingEvents_);
    pendingEvents_.reserve(128);
    return drained;
}

std::vector<float> PlaybackEngine::drainOscilloscopeSamples() {
    std::lock_guard<std::mutex> lock(tapMutex_);
    return oscilloscopeTap_.drain();
}

std::vector<float> PlaybackEngine::drainSpectrumSamples() {
    std::lock_guard<std::mutex> lock(tapMutex_);
    return spectrumTap_.drain();
}

VectorscopeSamples PlaybackEngine::drainVectorscopeSamples() {
    std::lock_guard<std::mutex> lock(tapMutex_);
    VectorscopeSamples drained;
    drained.left = vectorscopeLeftTap_.drain();
    drained.right = vectorscopeRightTap_.drain();
    return drained;
}

MultichannelSamples PlaybackEngine::drainVUMeterSamples() {
    std::lock_guard<std::mutex> lock(tapMutex_);
    MultichannelSamples drained;
    drained.channels.reserve(vumeterTaps_.size());
    for (auto& tap : vumeterTaps_) {
        drained.channels.push_back(tap.drain());
    }
    return drained;
}

size_t PlaybackEngine::renderInto(void* outputBuffer, size_t requestedFrames, bool& streamEnded) {
    streamEnded = false;
    struct TapChunk {
        const uint8_t* source = nullptr;
        size_t frames = 0;
        TrackFormat format {};
    };

    std::array<TapChunk, 2> tapChunks {};
    size_t tapChunkCount = 0;
    VisualizerTapDemand tapDemand {};
    bool shouldCaptureTaps = false;
    bool shouldClearTapBuffers = false;
    size_t totalFramesWritten = 0;

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (state_ != State::Playing || !hasCurrentTrack_) {
            return 0;
        }

        tapDemand = visualizerTapDemand_;
        shouldCaptureTaps = tapDemand.oscilloscope || tapDemand.spectrum || tapDemand.vectorscope || tapDemand.vumeter;

        uint8_t* output = static_cast<uint8_t*>(outputBuffer);
        size_t framesWritten = 0;

        while (framesWritten < requestedFrames) {
            const uint32_t bytesPerFrame = currentTrack_.format.bytesPerFrame();
            const uint64_t totalFrames = currentTrack_.totalFrames();
            if (nextRenderFrame_ >= totalFrames) {
                if (hasNextTrack_ && formatsMatch(currentTrack_.format, nextTrack_.format)) {
                    currentTrack_ = std::move(nextTrack_);
                    hasNextTrack_ = false;
                    nextTrack_ = TrackBuffer{};
                    nextRenderFrame_ = 0;
                    playedFrame_ = 0;
                    lastTimeUpdateFrame_ = 0;
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

            if (fadeInRemaining_ > 0) {
                const size_t fadeFrames = std::min(framesToCopy, static_cast<size_t>(fadeInRemaining_));
                uint8_t* fadeStart = output + (framesWritten * bytesPerFrame);
                const uint32_t channels = currentTrack_.format.channels;
                const size_t fadeOffset = kFadeInFrames - fadeInRemaining_;

                for (size_t i = 0; i < fadeFrames; i++) {
                    const float gain = static_cast<float>(fadeOffset + i + 1)
                                     / static_cast<float>(kFadeInFrames);
                    uint8_t* framePtr = fadeStart + (i * bytesPerFrame);

                    for (uint32_t ch = 0; ch < channels; ch++) {
                        switch (currentTrack_.format.sampleFormat) {
                            case SampleFormat::Float32: {
                                float value = 0.0f;
                                std::memcpy(&value, framePtr + ch * sizeof(float), sizeof(float));
                                value *= gain;
                                std::memcpy(framePtr + ch * sizeof(float), &value, sizeof(float));
                                break;
                            }
                            case SampleFormat::Int16: {
                                int16_t value = 0;
                                std::memcpy(&value, framePtr + ch * sizeof(int16_t), sizeof(int16_t));
                                value = static_cast<int16_t>(static_cast<float>(value) * gain);
                                std::memcpy(framePtr + ch * sizeof(int16_t), &value, sizeof(int16_t));
                                break;
                            }
                            case SampleFormat::Int32: {
                                int32_t value = 0;
                                std::memcpy(&value, framePtr + ch * sizeof(int32_t), sizeof(int32_t));
                                value = static_cast<int32_t>(static_cast<float>(value) * gain);
                                std::memcpy(framePtr + ch * sizeof(int32_t), &value, sizeof(int32_t));
                                break;
                            }
                        }
                    }
                }
                fadeInRemaining_ -= fadeFrames;
            }

            if (shouldCaptureTaps && tapChunkCount < tapChunks.size()) {
                tapChunks[tapChunkCount++] = {
                    output + (framesWritten * bytesPerFrame),
                    framesToCopy,
                    currentTrack_.format
                };
            }
            nextRenderFrame_ += framesToCopy;
            framesWritten += framesToCopy;
        }

        if (streamEnded) {
            shouldClearTapBuffers = true;
        }
        totalFramesWritten = framesWritten;
    }

    if (shouldClearTapBuffers) {
        clearTapBuffers();
    }

    for (size_t i = 0; i < tapChunkCount; i++) {
        const TapChunk& chunk = tapChunks[i];
        if (chunk.source != nullptr) {
            appendTapSamples(chunk.source, chunk.frames, chunk.format, tapDemand);
        }
    }

    return totalFramesWritten;
}

void PlaybackEngine::onFramesConsumed(size_t frames) {
    bool shouldEmitTimeUpdate = false;
    double currentTime = 0.0;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (!hasCurrentTrack_ || currentTrack_.format.sampleRate == 0 || frames == 0) {
            return;
        }

        playedFrame_ = std::min<uint64_t>(nextRenderFrame_, playedFrame_ + frames);
        const uint64_t minFramesBetweenUpdates = std::max<uint64_t>(
            1,
            static_cast<uint64_t>(currentTrack_.format.sampleRate / kTimeUpdateRateHz)
        );
        if (playedFrame_ >= nextRenderFrame_
            || playedFrame_ <= lastTimeUpdateFrame_
            || (playedFrame_ - lastTimeUpdateFrame_) >= minFramesBetweenUpdates) {
            currentTime = static_cast<double>(playedFrame_) / static_cast<double>(currentTrack_.format.sampleRate);
            lastTimeUpdateFrame_ = playedFrame_;
            shouldEmitTimeUpdate = true;
        }
    }

    if (!shouldEmitTimeUpdate) {
        return;
    }

    tryPushEvent({
        "timeUpdate",
        "",
        currentTime,
        0.0,
        0,
        "",
        "",
        ""
    });
}

bool PlaybackEngine::ensureSinkOpen(std::string* error) {
    std::string selectedDeviceId;
    TrackFormat currentFormat {};
    std::string previousDeviceId;
    int previousSampleRate = 0;
    std::string previousSampleFormat;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (!hasCurrentTrack_) {
            if (error) *error = "No track loaded for native playback.";
            return false;
        }

        selectedDeviceId = selectedDeviceId_;
        currentFormat = currentTrack_.format;
        previousDeviceId = sink_->activeDeviceId();
        previousSampleRate = static_cast<int>(currentFormat.sampleRate);
        previousSampleFormat = currentFormat.sampleFormatId();
    }

    if (!sink_->open(selectedDeviceId, currentFormat, this, error)) {
        std::lock_guard<std::mutex> lock(stateMutex_);
        lastUnavailableReason_ = (error && !error->empty())
            ? *error
            : "Failed to open the selected native output device.";
        return false;
    }

    const std::string activeDeviceId = sink_->activeDeviceId();
    if (selectedDeviceId.empty() && !activeDeviceId.empty()) {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (selectedDeviceId_.empty()) {
            selectedDeviceId_ = activeDeviceId;
        }
    }
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
        static_cast<int>(currentFormat.sampleRate),
        currentFormat.sampleFormatId(),
        activeDeviceId,
        ""
    });
    return true;
}

void PlaybackEngine::pushEvent(const PlaybackEvent& event) {
    std::lock_guard<std::mutex> lock(eventMutex_);
    if (event.type == "timeUpdate" && !pendingEvents_.empty() && pendingEvents_.back().type == "timeUpdate") {
        pendingEvents_.back() = event;
        return;
    }
    pendingEvents_.push_back(event);
}

bool PlaybackEngine::tryPushEvent(const PlaybackEvent& event) {
    std::unique_lock<std::mutex> lock(eventMutex_, std::try_to_lock);
    if (!lock.owns_lock()) {
        return false;
    }

    if (event.type == "timeUpdate" && !pendingEvents_.empty() && pendingEvents_.back().type == "timeUpdate") {
        pendingEvents_.back() = event;
        return true;
    }
    pendingEvents_.push_back(event);
    return true;
}

void PlaybackEngine::clearPendingEvents() {
    std::lock_guard<std::mutex> lock(eventMutex_);
    pendingEvents_.clear();
}

void PlaybackEngine::clearTapBuffers() {
    std::lock_guard<std::mutex> lock(tapMutex_);
    oscilloscopeTap_.clear();
    spectrumTap_.clear();
    vectorscopeLeftTap_.clear();
    vectorscopeRightTap_.clear();
    vumeterTaps_.clear();
}

void PlaybackEngine::appendTapSamples(
    const uint8_t* interleavedData,
    size_t frames,
    const TrackFormat& format,
    const VisualizerTapDemand& demand
) {
    if (!demand.oscilloscope && !demand.spectrum && !demand.vectorscope && !demand.vumeter) {
        return;
    }

    std::unique_lock<std::mutex> lock(tapMutex_, std::try_to_lock);
    if (!lock.owns_lock()) {
        return;
    }

    const uint32_t channels = std::max<uint32_t>(1, format.channels);
    const uint32_t bytesPerSample = format.bytesPerSample();

    if (demand.vumeter && vumeterTaps_.size() != channels) {
        vumeterTaps_.clear();
        vumeterTaps_.reserve(channels);
        for (uint32_t channelIndex = 0; channelIndex < channels; channelIndex++) {
            vumeterTaps_.emplace_back(kMaxTapSamples);
        }
    }

    for (size_t frameIndex = 0; frameIndex < frames; frameIndex++) {
        const uint8_t* framePtr = interleavedData + (frameIndex * format.bytesPerFrame());
        const float left = readNormalizedSample(framePtr, format.sampleFormat);
        const float right = channels >= 2
            ? readNormalizedSample(framePtr + bytesPerSample, format.sampleFormat)
            : left;

        if (demand.oscilloscope) {
            oscilloscopeTap_.push(left);
        }
        if (demand.spectrum) {
            const float mono = channels >= 2 ? (left + right) * 0.5f : left;
            spectrumTap_.push(mono);
        }
        if (demand.vectorscope) {
            vectorscopeLeftTap_.push(left);
            vectorscopeRightTap_.push(right);
        }
        if (demand.vumeter) {
            for (uint32_t channelIndex = 0; channelIndex < channels; channelIndex++) {
                const float sample = readNormalizedSample(
                    framePtr + (channelIndex * bytesPerSample),
                    format.sampleFormat
                );
                vumeterTaps_[channelIndex].push(sample);
            }
        }
    }
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

} // namespace NativePlayback
