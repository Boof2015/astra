#include "playback_engine.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <iomanip>
#include <limits>
#include <sstream>
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
        case SampleFormat::Int24Packed: {
            // Packed 24-bit little-endian: sign-extend the top byte into a 32-bit word.
            const int32_t value = static_cast<int32_t>(
                (static_cast<uint32_t>(sampleData[0]) << 8)
                | (static_cast<uint32_t>(sampleData[1]) << 16)
                | (static_cast<uint32_t>(sampleData[2]) << 24)
            ) >> 8;
            return static_cast<float>(value) / 8388608.0f;
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
        case SampleFormat::Int24Packed:
            return 3;
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
        case SampleFormat::Int24Packed:
            return "s24";
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
    } else if (sampleFormatId == "s24") {
        format.sampleFormat = SampleFormat::Int24Packed;
    } else if (sampleFormatId == "s32") {
        format.sampleFormat = SampleFormat::Int32;
    } else {
        format.sampleFormat = SampleFormat::Float32;
    }
    return format;
}

NativePcmFormat DescribeTrackFormat(const TrackFormat& format) {
    NativePcmFormat described;
    described.sampleRate = static_cast<int>(format.sampleRate);
    described.channels = static_cast<int>(format.channels);
    described.sampleFormat = format.sampleFormatId();
    described.containerBits = static_cast<int>(format.bytesPerSample() * 8);
    described.validBits = format.sampleFormat == SampleFormat::Int24Packed
        ? 24
        : described.containerBits;
    described.channelLayout = format.channels == 1
        ? "mono"
        : (format.channels == 2 ? "stereo" : "discrete");
    described.representation = "interleaved";
    return described;
}

void RecomputeBitPerfectActive(NativeOutputStatus& status) {
    status.bitPerfectActive = status.streamRunning
        && status.exclusiveAcquired
        && status.systemMixerBypassed
        && !status.sourceSamplesModified
        && status.wireFormatCanCarrySourceExactly;
}

namespace {

std::string describePcm(const NativePcmFormat& format) {
    if (format.sampleRate <= 0 || format.channels <= 0) {
        return "unavailable";
    }
    std::ostringstream text;
    text << format.sampleRate << " Hz, " << format.channels << " ch, "
         << format.sampleFormat << " (" << format.validBits << " valid / "
         << format.containerBits << " container bits, "
         << (format.representation.empty() ? "unspecified" : format.representation) << ")";
    if (!format.channelLayout.empty()) text << ", layout=" << format.channelLayout;
    if (format.channelMask != 0) text << ", mask=0x" << std::hex << format.channelMask << std::dec;
    return text.str();
}

} // namespace

std::string BuildNativeAudioDiagnosticReport(const NativeOutputStatus& status) {
    std::ostringstream report;
    report << "Astra Native Audio Diagnostic Report\n"
           << "Backend: " << (status.backend.empty() ? "unavailable" : status.backend) << "\n"
           << "Device: " << (status.deviceLabel.empty() ? status.deviceId : status.deviceLabel)
           << " [" << status.deviceId << "]\n"
           << "Transport: " << (status.transport.empty() ? "not started" : status.transport) << "\n"
           << "Source PCM: " << describePcm(status.sourceFormat) << "\n"
           << "Processing PCM: " << describePcm(status.processingFormat) << "\n"
           << "Wire PCM: " << describePcm(status.wireFormat) << "\n"
           << std::boolalpha
           << "Lifecycle: open=" << status.outputOpen
           << ", deviceResolved=" << status.deviceResolved
           << ", formatNegotiated=" << status.formatNegotiated
           << ", initialized=" << status.streamInitialized
           << ", started=" << status.streamStarted
           << ", running=" << status.streamRunning << "\n"
           << "Integrity: exclusiveRequested=" << status.exclusiveRequested
           << ", exclusiveAcquired=" << status.exclusiveAcquired
           << ", mixerBypassed=" << status.systemMixerBypassed
           << ", sourceModified=" << status.sourceSamplesModified
           << ", exactCarry=" << status.wireFormatCanCarrySourceExactly
           << ", bitPerfectActive=" << status.bitPerfectActive << "\n"
           << "Period: requested=" << status.requestedPeriodMs << " ms ("
           << status.requestedPeriodFrames << " frames), actual=" << status.actualPeriodMs
           << " ms (" << status.actualPeriodFrames << " frames), buffer="
           << status.bufferFrames << " frames\n";
    if (!status.failureStage.empty() || !status.failureSummary.empty()) {
        report << "Latest failure: stage=" << status.failureStage
               << ", symbol=" << status.osErrorSymbol
               << ", code=" << status.osErrorCode
               << ", summary=" << status.failureSummary << "\n";
    }
    report << "Attempts (" << status.attempts.size() << "):\n";
    for (const auto& attempt : status.attempts) {
        report << "  #" << attempt.index
               << " transport=" << attempt.transport
               << " probe=" << attempt.probeResult
               << " wire={" << describePcm(attempt.wireFormat) << "}"
               << " requested=" << attempt.requestedPeriodMs << "ms"
               << " aligned=" << attempt.alignedPeriodMs << "ms"
               << " actual=" << attempt.actualPeriodMs << "ms"
               << " buffer=" << attempt.bufferFrames
               << " resolved=" << attempt.deviceResolved
               << " negotiated=" << attempt.formatNegotiated
               << " initialized=" << attempt.streamInitialized
               << " primed=" << attempt.bufferPrimed
               << " started=" << attempt.streamStarted
               << " verified=" << attempt.finalVerified;
        if (!attempt.failureStage.empty()) {
            report << " failureStage=" << attempt.failureStage
                   << " os=" << attempt.osErrorSymbol << "(" << attempt.osErrorCode << ")"
                   << " message=" << attempt.message;
        }
        report << "\n";
    }
    return report.str();
}

bool WidenIntegerSamplesLeftJustified(
    const uint8_t* source,
    int sourceBits,
    uint8_t* destination,
    int destinationBits,
    size_t sampleCount
) {
    if (source == nullptr || destination == nullptr || sourceBits >= destinationBits) return false;
    if (sourceBits == 16 && destinationBits == 24) {
        for (size_t i = 0; i < sampleCount; i++) {
            destination[i * 3] = 0;
            destination[i * 3 + 1] = source[i * 2];
            destination[i * 3 + 2] = source[i * 2 + 1];
        }
        return true;
    }
    if (sourceBits == 16 && destinationBits == 32) {
        for (size_t i = 0; i < sampleCount; i++) {
            destination[i * 4] = 0;
            destination[i * 4 + 1] = 0;
            destination[i * 4 + 2] = source[i * 2];
            destination[i * 4 + 3] = source[i * 2 + 1];
        }
        return true;
    }
    if (sourceBits == 24 && destinationBits == 32) {
        for (size_t i = 0; i < sampleCount; i++) {
            destination[i * 4] = 0;
            destination[i * 4 + 1] = source[i * 3];
            destination[i * 4 + 2] = source[i * 3 + 1];
            destination[i * 4 + 3] = source[i * 3 + 2];
        }
        return true;
    }
    return false;
}

std::vector<size_t> OrderExactFormatCandidates(const std::vector<ExactFormatOrderKey>& candidates) {
    std::vector<size_t> order(candidates.size());
    for (size_t index = 0; index < candidates.size(); index++) order[index] = index;
    std::stable_sort(order.begin(), order.end(), [&candidates](size_t left, size_t right) {
        const auto& a = candidates[left];
        const auto& b = candidates[right];
        if (a.probeAccepted != b.probeAccepted) return a.probeAccepted > b.probeAccepted;
        if (a.extensible != b.extensible) return a.extensible > b.extensible;
        return a.ladderRank < b.ladderRank;
    });
    return order;
}

std::vector<ExclusiveAttemptPlanEntry> BuildExclusiveAttemptPlan(
    size_t formatCandidateCount,
    const std::vector<int64_t>& preferredPeriods,
    int64_t conservativePeriod
) {
    std::vector<ExclusiveAttemptPlanEntry> plan;
    auto appendPhase = [&](const char* transport, const std::vector<int64_t>& periods, bool conservative) {
        for (size_t formatIndex = 0; formatIndex < formatCandidateCount; formatIndex++) {
            for (const int64_t period : periods) {
                if (period > 0) plan.push_back({formatIndex, transport, period, conservative});
            }
        }
    };
    appendPhase("event-driven", preferredPeriods, false);
    appendPhase("timer-driven", preferredPeriods, false);
    if (conservativePeriod > 0) appendPhase("timer-driven", {conservativePeriod}, true);
    return plan;
}

int64_t ComputeAlignedExclusivePeriod(
    uint64_t alignedBufferFrames,
    uint32_t sampleRate,
    int64_t timeUnitsPerSecond
) {
    if (alignedBufferFrames == 0 || sampleRate == 0 || timeUnitsPerSecond <= 0) return 0;
    return static_cast<int64_t>(
        (alignedBufferFrames * static_cast<uint64_t>(timeUnitsPerSecond) + sampleRate - 1)
        / sampleRate);
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

DeviceFormatProbe PlaybackEngine::probeDeviceFormats(const std::string& deviceId, uint32_t channels) const {
    std::string resolvedDeviceId = deviceId;
    if (resolvedDeviceId.empty()) {
        std::lock_guard<std::mutex> lock(stateMutex_);
        resolvedDeviceId = selectedDeviceId_;
    }
    return sink_->probeDeviceFormats(resolvedDeviceId, std::max<uint32_t>(1, channels));
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

    if (shouldRestart) {
        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            state_ = State::Starting;
            platformStartVerified_ = false;
            nativeEndPending_ = false;
        }
        pushEvent({"outputStatusChanged", "", 0.0, 0.0, 0, "", deviceId, ""});
    }

    if (!ensureSinkOpen(&error)) {
        if (shouldRestart) {
            {
                std::lock_guard<std::mutex> lock(stateMutex_);
                state_ = State::Paused;
                nextRenderFrame_ = playedFrame_;
                nativeEndPending_ = false;
            }
            clearTapBuffers();
            pushEvent({"outputStatusChanged", "", 0.0, 0.0, 0, "", deviceId, error});
        }
        throw std::runtime_error(error.empty() ? "Failed to select native output device." : error);
    }

    if (shouldRestart) {
        sink_->reset();
        if (!sink_->start(&error)) {
            {
                std::lock_guard<std::mutex> lock(stateMutex_);
                state_ = State::Paused;
                nextRenderFrame_ = playedFrame_;
                nativeEndPending_ = false;
            }
            clearTapBuffers();
            pushEvent({"outputStatusChanged", "", 0.0, 0.0, 0, "", sink_->activeDeviceId(), error});
            throw std::runtime_error(error.empty() ? "Failed to restart native output after device change." : error);
        }
        bool endPending = false;
        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            state_ = State::Playing;
            endPending = nativeEndPending_;
            nativeEndPending_ = false;
        }
        pushEvent({"outputStatusChanged", "", 0.0, 0.0, 0, "", sink_->activeDeviceId(), ""});
        if (endPending) onNativeStreamEnded();
    } else if (wasPaused) {
        sink_->reset();
    }
}

bool PlaybackEngine::isBitPerfectAvailable(std::string* reason) const {
    if (sink_->isAvailable()) {
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

NativeOutputStatus PlaybackEngine::getOutputStatus() const {
    NativeOutputStatus status = sink_->outputStatus();
    bool hasTrack = false;
    State state = State::Stopped;
    TrackFormat trackFormat {};
    std::string unavailableReason;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        hasTrack = hasCurrentTrack_;
        state = state_;
        if (hasTrack) trackFormat = currentTrack_.format;
        unavailableReason = lastUnavailableReason_;
    }
    if (hasTrack) {
        status.sourceFormat = DescribeTrackFormat(trackFormat);
        status.processingFormat = status.sourceFormat;
    }
    if (!status.outputOpen && status.failureSummary.empty() && !unavailableReason.empty()) {
        status.failureStage = "device-resolution";
        status.failureSummary = unavailableReason;
    }
    // Priming and pause may retain native ownership, but neither is active playback.
    if (state != State::Playing) {
        status.streamRunning = false;
    }
    RecomputeBitPerfectActive(status);
    return status;
}

std::string PlaybackEngine::getNativeAudioDiagnosticReport() const {
    return BuildNativeAudioDiagnosticReport(getOutputStatus());
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
        nativeEndPending_ = false;
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
        nativeEndPending_ = false;
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
        } else if (state_ == State::Playing || state_ == State::Starting) {
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
        throw std::runtime_error(recordPlayError(error, "Failed to open native output."));
    }

    if (shouldReset) {
        sink_->reset();
    }

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        state_ = State::Starting;
        platformStartVerified_ = false;
        nativeEndPending_ = false;
    }
    pushEvent({"outputStatusChanged", "", 0.0, 0.0, 0, "", sink_->activeDeviceId(), ""});

    if (!sink_->start(&error)) {
        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            state_ = previousState;
            nextRenderFrame_ = playedFrame_;
            nativeEndPending_ = false;
        }
        clearTapBuffers();
        pushEvent({"outputStatusChanged", "", 0.0, 0.0, 0, "", sink_->activeDeviceId(), error});
        throw std::runtime_error(recordPlayError(error, "Failed to start native output."));
    }
    bool endPending = false;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        state_ = State::Playing;
        endPending = nativeEndPending_;
        nativeEndPending_ = false;
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
    pushEvent({"outputStatusChanged", "", 0.0, 0.0, 0, "", sink_->activeDeviceId(), ""});
    if (endPending) onNativeStreamEnded();
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
    pushEvent({"outputStatusChanged", "", 0.0, 0.0, 0, "", sink_->activeDeviceId(), ""});
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
        nativeEndPending_ = false;
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
    pushEvent({"outputStatusChanged", "", 0.0, 0.0, 0, "", activeDeviceId, ""});
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
        if (wasPlaying) {
            {
                std::lock_guard<std::mutex> lock(stateMutex_);
                state_ = State::Starting;
                platformStartVerified_ = false;
                nativeEndPending_ = false;
            }
            pushEvent({"outputStatusChanged", "", 0.0, 0.0, 0, "", sink_->activeDeviceId(), ""});
        }
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
            nativeEndPending_ = false;
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
                {
                    std::lock_guard<std::mutex> lock(stateMutex_);
                    state_ = State::Paused;
                    nextRenderFrame_ = playedFrame_;
                    nativeEndPending_ = false;
                }
                clearTapBuffers();
                pushEvent({"outputStatusChanged", "", 0.0, 0.0, 0, "", sink_->activeDeviceId(), error});
                throw std::runtime_error(error.empty() ? "Failed to restart native output after seek." : error);
            }
            bool endPending = false;
            {
                std::lock_guard<std::mutex> lock(stateMutex_);
                state_ = State::Playing;
                endPending = nativeEndPending_;
                nativeEndPending_ = false;
            }
            pushEvent({"outputStatusChanged", "", 0.0, 0.0, 0, "", sink_->activeDeviceId(), ""});
            if (endPending) onNativeStreamEnded();
        }
    }

    return getSnapshot();
}

PlaybackSnapshot PlaybackEngine::getSnapshot() const {
    PlaybackSnapshot snapshot;
    State state = State::Stopped;
    bool hasTrack = false;
    TrackFormat trackFormat {};
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        state = state_;
        hasTrack = hasCurrentTrack_;
        if (hasTrack) trackFormat = currentTrack_.format;
        switch (state) {
            case State::Playing:
                snapshot.playbackState = "playing";
                break;
            case State::Starting:
                snapshot.playbackState = "starting";
                break;
            case State::Paused:
                snapshot.playbackState = "paused";
                break;
            case State::Stopped:
            default:
                snapshot.playbackState = "stopped";
                break;
        }
        snapshot.currentTime = hasTrack
            ? static_cast<double>(playedFrame_) / static_cast<double>(std::max<uint32_t>(1, trackFormat.sampleRate))
            : 0.0;
        snapshot.duration = hasTrack ? currentTrack_.duration : 0.0;
    }
    snapshot.sampleRate = hasTrack ? static_cast<int>(trackFormat.sampleRate) : 0;
    snapshot.channels = hasTrack ? static_cast<int>(trackFormat.channels) : 0;
    snapshot.sampleFormat = hasTrack ? trackFormat.sampleFormatId() : "";
    snapshot.outputStatus = getOutputStatus();
    if (state != State::Playing) snapshot.outputStatus.streamRunning = false;
    RecomputeBitPerfectActive(snapshot.outputStatus);
    snapshot.deviceId = snapshot.outputStatus.deviceId;
    snapshot.deviceLabel = snapshot.outputStatus.deviceLabel;
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
    size_t totalFramesWritten = 0;

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if ((state_ != State::Playing && state_ != State::Starting) || !hasCurrentTrack_) {
            return 0;
        }

        tapDemand = visualizerTapDemand_;
        shouldCaptureTaps = state_ == State::Playing
            && (tapDemand.oscilloscope || tapDemand.spectrum || tapDemand.vectorscope || tapDemand.vumeter);

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

                streamEnded = true;
                break;
            }

            const uint64_t framesRemaining = totalFrames - nextRenderFrame_;
            const size_t framesToCopy = static_cast<size_t>(std::min<uint64_t>(
                static_cast<uint64_t>(requestedFrames - framesWritten),
                framesRemaining
            ));
            const uint8_t* source = currentTrack_.data.data() + (nextRenderFrame_ * bytesPerFrame);
            std::memcpy(output + (framesWritten * bytesPerFrame), source, framesToCopy * bytesPerFrame);

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

        totalFramesWritten = framesWritten;
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
        if (state_ == State::Starting && !platformStartVerified_) return;

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

void PlaybackEngine::onPlatformStartVerified() {
    std::lock_guard<std::mutex> lock(stateMutex_);
    if (state_ == State::Starting) platformStartVerified_ = true;
}

void PlaybackEngine::onNativeStreamEnded() {
    double duration = 0.0;
    int sampleRate = 0;
    std::string sampleFormat;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (!hasCurrentTrack_) return;
        if (state_ == State::Starting) {
            nativeEndPending_ = true;
            return;
        }
        if (state_ != State::Playing) return;

        state_ = State::Stopped;
        playedFrame_ = currentTrack_.totalFrames();
        nextRenderFrame_ = playedFrame_;
        lastTimeUpdateFrame_ = playedFrame_;
        duration = currentTrack_.duration;
        sampleRate = static_cast<int>(currentTrack_.format.sampleRate);
        sampleFormat = currentTrack_.format.sampleFormatId();
    }

    clearTapBuffers();
    pushEvent({"timeUpdate", "", duration, 0.0, 0, "", "", ""});
    pushEvent({"stateChange", "stopped", duration, duration, sampleRate, sampleFormat, sink_->activeDeviceId(), ""});
    pushEvent({"outputStatusChanged", "", 0.0, 0.0, 0, "", sink_->activeDeviceId(), ""});
    pushEvent({"ended", "", 0.0, 0.0, 0, "", "", ""});
}

void PlaybackEngine::rollbackSpeculativeRender() {
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        nextRenderFrame_ = playedFrame_;
    }
    clearTapBuffers();
}

void PlaybackEngine::onNativeOutputStatusChanged(const std::string& message) {
    pushEvent({"outputStatusChanged", "", 0.0, 0.0, 0, "", sink_->activeDeviceId(), message});
}

void PlaybackEngine::onNativeOutputRuntimeFailure(const std::string& message) {
    double currentTime = 0.0;
    double duration = 0.0;
    int sampleRate = 0;
    std::string sampleFormat;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (state_ != State::Playing && state_ != State::Starting) return;
        state_ = State::Paused;
        nextRenderFrame_ = playedFrame_;
        nativeEndPending_ = false;
        if (hasCurrentTrack_) {
            sampleRate = static_cast<int>(currentTrack_.format.sampleRate);
            sampleFormat = currentTrack_.format.sampleFormatId();
            duration = currentTrack_.duration;
            currentTime = static_cast<double>(playedFrame_)
                / static_cast<double>(std::max<uint32_t>(1, currentTrack_.format.sampleRate));
        }
    }
    clearTapBuffers();
    pushEvent({"stateChange", "paused", currentTime, duration, sampleRate, sampleFormat, sink_->activeDeviceId(), message});
    pushEvent({"outputStatusChanged", "", 0.0, 0.0, 0, "", sink_->activeDeviceId(), message});
    pushEvent({"error", "", 0.0, 0.0, 0, "", sink_->activeDeviceId(), message});
}

std::string PlaybackEngine::recordPlayError(const std::string& error, const char* fallback) {
    std::string message = error.empty() ? std::string(fallback) : error;
    {
        std::lock_guard<std::mutex> lock(lastPlayErrorMutex_);
        lastPlayError_ = message;
    }
    return message;
}

std::string PlaybackEngine::takeLastPlayError() {
    std::lock_guard<std::mutex> lock(lastPlayErrorMutex_);
    std::string message = std::move(lastPlayError_);
    lastPlayError_.clear();
    return message;
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

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        lastUnavailableReason_.clear();
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
