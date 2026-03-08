#include "playback_engine.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#if defined(__APPLE__)
#include <CoreAudio/CoreAudio.h>
#include <AudioToolbox/AudioToolbox.h>
#include <CoreFoundation/CoreFoundation.h>
#include <unistd.h>
#endif

namespace NativePlayback {

#if defined(__APPLE__)

namespace {

constexpr useconds_t kSampleRateSettleSleepUs = 10 * 1000;
constexpr size_t kSampleRateSettleMaxAttempts = 150;
constexpr useconds_t kHogModeSettleSleepUs = 10 * 1000;
constexpr size_t kHogModeSettleMaxAttempts = 150;

std::string cfStringToStdString(CFStringRef value) {
    if (value == nullptr) {
        return {};
    }

    char buffer[1024];
    if (CFStringGetCString(value, buffer, sizeof(buffer), kCFStringEncodingUTF8)) {
        return std::string(buffer);
    }

    return {};
}

bool getDeviceStringProperty(
    AudioDeviceID deviceId,
    AudioObjectPropertySelector selector,
    std::string* out
) {
    if (out == nullptr) return false;

    AudioObjectPropertyAddress address {
        selector,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    CFStringRef stringValue = nullptr;
    UInt32 size = sizeof(stringValue);
    OSStatus status = AudioObjectGetPropertyData(deviceId, &address, 0, nullptr, &size, &stringValue);
    if (status != noErr || stringValue == nullptr) {
        return false;
    }

    *out = cfStringToStdString(stringValue);
    CFRelease(stringValue);
    return !out->empty();
}

AudioDeviceID getDefaultOutputDeviceId() {
    AudioDeviceID deviceId = kAudioObjectUnknown;
    AudioObjectPropertyAddress address {
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    UInt32 size = sizeof(deviceId);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, &deviceId) != noErr) {
        return kAudioObjectUnknown;
    }
    return deviceId;
}

std::string formatSampleRateLabel(double sampleRate) {
    if (sampleRate <= 0.0) {
        return "unknown";
    }
    return std::to_string(static_cast<int>(std::llround(sampleRate))) + " Hz";
}

bool getDeviceNominalSampleRate(AudioDeviceID deviceId, double* outSampleRate) {
    if (deviceId == kAudioObjectUnknown || outSampleRate == nullptr) {
        return false;
    }

    AudioObjectPropertyAddress address {
        kAudioDevicePropertyNominalSampleRate,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    Float64 sampleRate = 0.0;
    UInt32 size = sizeof(sampleRate);
    const OSStatus status = AudioObjectGetPropertyData(deviceId, &address, 0, nullptr, &size, &sampleRate);
    if (status != noErr || sampleRate <= 0.0) {
        return false;
    }

    *outSampleRate = static_cast<double>(sampleRate);
    return true;
}

bool getDeviceHogModePid(AudioDeviceID deviceId, pid_t* outPid) {
    if (deviceId == kAudioObjectUnknown || outPid == nullptr) {
        return false;
    }

    AudioObjectPropertyAddress address {
        kAudioDevicePropertyHogMode,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    pid_t hogPid = -1;
    UInt32 size = sizeof(hogPid);
    const OSStatus status = AudioObjectGetPropertyData(deviceId, &address, 0, nullptr, &size, &hogPid);
    if (status != noErr) {
        return false;
    }

    *outPid = hogPid;
    return true;
}

uint32_t getOutputChannelCount(AudioDeviceID deviceId) {
    AudioObjectPropertyAddress address {
        kAudioDevicePropertyStreamConfiguration,
        kAudioDevicePropertyScopeOutput,
        kAudioObjectPropertyElementMain
    };

    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(deviceId, &address, 0, nullptr, &size) != noErr || size == 0) {
        return 0;
    }

    std::vector<uint8_t> buffer(size);
    auto* bufferList = reinterpret_cast<AudioBufferList*>(buffer.data());
    if (AudioObjectGetPropertyData(deviceId, &address, 0, nullptr, &size, bufferList) != noErr) {
        return 0;
    }

    uint32_t channels = 0;
    for (UInt32 i = 0; i < bufferList->mNumberBuffers; i++) {
        channels += bufferList->mBuffers[i].mNumberChannels;
    }
    return channels;
}

std::vector<OutputDeviceInfo> enumerateCoreAudioDevices() {
    AudioObjectPropertyAddress address {
        kAudioHardwarePropertyDevices,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, nullptr, &size) != noErr || size == 0) {
        return {};
    }

    const UInt32 deviceCount = size / sizeof(AudioDeviceID);
    std::vector<AudioDeviceID> deviceIds(deviceCount);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, deviceIds.data()) != noErr) {
        return {};
    }

    const AudioDeviceID defaultDeviceId = getDefaultOutputDeviceId();
    std::vector<OutputDeviceInfo> devices;

    for (AudioDeviceID deviceId : deviceIds) {
        const uint32_t channelCount = getOutputChannelCount(deviceId);
        if (channelCount == 0) {
            continue;
        }

        std::string uid;
        std::string name;
        if (!getDeviceStringProperty(deviceId, kAudioDevicePropertyDeviceUID, &uid)) {
            continue;
        }
        if (!getDeviceStringProperty(deviceId, kAudioObjectPropertyName, &name)) {
            name = uid;
        }

        devices.push_back({
            uid,
            name,
            std::max<uint32_t>(2, channelCount),
            deviceId == defaultDeviceId
        });
    }

    return devices;
}

AudioDeviceID resolveDeviceIdFromUid(const std::string& uid) {
    if (uid.empty()) {
        return getDefaultOutputDeviceId();
    }

    for (const OutputDeviceInfo& device : enumerateCoreAudioDevices()) {
        if (device.id != uid) {
            continue;
        }

        AudioDeviceID matchedDeviceId = kAudioObjectUnknown;
        AudioObjectPropertyAddress address {
            kAudioHardwarePropertyDevices,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        UInt32 size = 0;
        if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, nullptr, &size) != noErr || size == 0) {
            return kAudioObjectUnknown;
        }
        const UInt32 deviceCount = size / sizeof(AudioDeviceID);
        std::vector<AudioDeviceID> deviceIds(deviceCount);
        if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, deviceIds.data()) != noErr) {
            return kAudioObjectUnknown;
        }
        for (AudioDeviceID candidate : deviceIds) {
            std::string candidateUid;
            if (getDeviceStringProperty(candidate, kAudioDevicePropertyDeviceUID, &candidateUid) && candidateUid == uid) {
                matchedDeviceId = candidate;
                break;
            }
        }
        return matchedDeviceId;
    }

    return kAudioObjectUnknown;
}

bool setDeviceNominalSampleRate(AudioDeviceID deviceId, double sampleRate) {
    if (deviceId == kAudioObjectUnknown || sampleRate <= 0) {
        return false;
    }

    AudioObjectPropertyAddress address {
        kAudioDevicePropertyNominalSampleRate,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    Float64 currentSampleRate = 0.0;
    UInt32 size = sizeof(currentSampleRate);
    if (AudioObjectGetPropertyData(deviceId, &address, 0, nullptr, &size, &currentSampleRate) == noErr) {
        if (std::abs(currentSampleRate - sampleRate) < 1.0) {
            return true;
        }
    }

    Float64 requestedSampleRate = sampleRate;
    return AudioObjectSetPropertyData(deviceId, &address, 0, nullptr, sizeof(requestedSampleRate), &requestedSampleRate) == noErr;
}

bool waitForDeviceNominalSampleRate(AudioDeviceID deviceId, double targetSampleRate, double* outSampleRate = nullptr) {
    for (size_t attempt = 0; attempt < kSampleRateSettleMaxAttempts; attempt++) {
        double currentSampleRate = 0.0;
        if (getDeviceNominalSampleRate(deviceId, &currentSampleRate)) {
            if (outSampleRate != nullptr) {
                *outSampleRate = currentSampleRate;
            }
            if (std::abs(currentSampleRate - targetSampleRate) < 1.0) {
                return true;
            }
        }
        usleep(kSampleRateSettleSleepUs);
    }

    if (outSampleRate != nullptr) {
        *outSampleRate = 0.0;
        getDeviceNominalSampleRate(deviceId, outSampleRate);
    }
    return false;
}

bool ensureDeviceNominalSampleRate(AudioDeviceID deviceId, double targetSampleRate, std::string* error) {
    if (deviceId == kAudioObjectUnknown || targetSampleRate <= 0.0) {
        if (error != nullptr) {
            *error = "Invalid CoreAudio device sample-rate request.";
        }
        return false;
    }

    double currentSampleRate = 0.0;
    if (getDeviceNominalSampleRate(deviceId, &currentSampleRate) && std::abs(currentSampleRate - targetSampleRate) < 1.0) {
        return true;
    }

    if (!setDeviceNominalSampleRate(deviceId, targetSampleRate)) {
        if (error != nullptr) {
            const std::string currentLabel = currentSampleRate > 0.0
                ? formatSampleRateLabel(currentSampleRate)
                : "unknown";
            *error = "Failed to switch the CoreAudio device to " + formatSampleRateLabel(targetSampleRate)
                + " (current " + currentLabel + ").";
        }
        return false;
    }

    double settledSampleRate = currentSampleRate;
    if (waitForDeviceNominalSampleRate(deviceId, targetSampleRate, &settledSampleRate)) {
        return true;
    }

    if (error != nullptr) {
        const std::string settledLabel = settledSampleRate > 0.0
            ? formatSampleRateLabel(settledSampleRate)
            : "unknown";
        *error = "Timed out waiting for the CoreAudio device to switch to "
            + formatSampleRateLabel(targetSampleRate) + " (stayed at " + settledLabel + ").";
    }
    return false;
}

bool waitForDeviceHogMode(AudioDeviceID deviceId, pid_t expectedPid, pid_t* outObservedPid = nullptr) {
    for (size_t attempt = 0; attempt < kHogModeSettleMaxAttempts; attempt++) {
        pid_t observedPid = -1;
        if (getDeviceHogModePid(deviceId, &observedPid)) {
            if (outObservedPid != nullptr) {
                *outObservedPid = observedPid;
            }
            if (observedPid == expectedPid) {
                return true;
            }
        }
        usleep(kHogModeSettleSleepUs);
    }

    if (outObservedPid != nullptr) {
        *outObservedPid = -1;
        getDeviceHogModePid(deviceId, outObservedPid);
    }
    return false;
}

class CoreAudioHalSink final : public AudioOutputSink {
public:
    CoreAudioHalSink() = default;

    ~CoreAudioHalSink() override {
        releaseHogMode();
        disposeQueue();
    }

    bool supportsBitPerfect() const override {
        return true;
    }

    std::string backendKind() const override {
        return "coreaudio";
    }

    std::vector<OutputDeviceInfo> enumerateOutputDevices(std::string* reason) const override {
        if (reason != nullptr) {
            reason->clear();
        }
        return enumerateCoreAudioDevices();
    }

    uint32_t deviceMaxChannels(const std::string& deviceId) const override {
        const AudioDeviceID resolvedId = resolveDeviceIdFromUid(deviceId);
        const uint32_t channels = getOutputChannelCount(resolvedId);
        return std::max<uint32_t>(2, channels);
    }

    bool open(
        const std::string& deviceId,
        const TrackFormat& format,
        PlaybackEngine* engine,
        std::string* error
    ) override {
        AudioDeviceID resolvedDeviceId = resolveDeviceIdFromUid(deviceId);
        if (resolvedDeviceId == kAudioObjectUnknown) {
            if (error != nullptr) {
                *error = "Could not resolve the selected CoreAudio output device.";
            }
            return false;
        }

        std::string resolvedUid;
        std::string resolvedLabel;
        getDeviceStringProperty(resolvedDeviceId, kAudioDevicePropertyDeviceUID, &resolvedUid);
        getDeviceStringProperty(resolvedDeviceId, kAudioObjectPropertyName, &resolvedLabel);

        const bool formatChanged = !hasOpenFormat_
            || openFormat_.sampleRate != format.sampleRate
            || openFormat_.channels != format.channels
            || openFormat_.sampleFormat != format.sampleFormat;
        const bool deviceChanged = resolvedUid != activeDeviceUid_;

        engine_ = engine;
        if (!formatChanged && !deviceChanged && queue_ != nullptr) {
            return true;
        }

        stop();
        releaseHogMode();
        disposeQueue();

        acquireHogMode(resolvedDeviceId);
        if (!ensureDeviceNominalSampleRate(resolvedDeviceId, static_cast<double>(format.sampleRate), error)) {
            releaseHogMode();
            disposeQueue();
            return false;
        }

        AudioStreamBasicDescription asbd {};
        asbd.mSampleRate = static_cast<Float64>(format.sampleRate);
        asbd.mFormatID = kAudioFormatLinearPCM;
        asbd.mChannelsPerFrame = format.channels;
        asbd.mFramesPerPacket = 1;
        asbd.mBitsPerChannel = static_cast<UInt32>(format.bytesPerSample() * 8);
        asbd.mBytesPerFrame = format.bytesPerFrame();
        asbd.mBytesPerPacket = format.bytesPerFrame();
        asbd.mFormatFlags = kAudioFormatFlagIsPacked;
        if (format.sampleFormat == SampleFormat::Float32) {
            asbd.mFormatFlags |= kLinearPCMFormatFlagIsFloat;
        } else {
            asbd.mFormatFlags |= kLinearPCMFormatFlagIsSignedInteger;
        }

        OSStatus status = AudioQueueNewOutput(&asbd, &CoreAudioHalSink::handleOutputCallback, this, nullptr, nullptr, 0, &queue_);
        if (status != noErr || queue_ == nullptr) {
            if (error != nullptr) {
                *error = "AudioQueueNewOutput failed for CoreAudio playback.";
            }
            releaseHogMode();
            disposeQueue();
            return false;
        }

        if (!resolvedUid.empty()) {
            CFStringRef uidString = CFStringCreateWithCString(kCFAllocatorDefault, resolvedUid.c_str(), kCFStringEncodingUTF8);
            if (uidString != nullptr) {
                status = AudioQueueSetProperty(queue_, kAudioQueueProperty_CurrentDevice, &uidString, sizeof(uidString));
                CFRelease(uidString);
                if (status != noErr) {
                    if (error != nullptr) {
                        *error = "Failed to bind AudioQueue to the selected CoreAudio device.";
                    }
                    disposeQueue();
                    releaseHogMode();
                    return false;
                }
            }
        }

        for (BufferState& bufferState : buffers_) {
            status = AudioQueueAllocateBuffer(queue_, static_cast<UInt32>(kFramesPerBuffer * format.bytesPerFrame()), &bufferState.buffer);
            bufferState.lastFrames = 0;
            if (status != noErr || bufferState.buffer == nullptr) {
                if (error != nullptr) {
                    *error = "Failed to allocate CoreAudio output buffers.";
                }
                disposeQueue();
                releaseHogMode();
                return false;
            }
        }

        openFormat_ = format;
        hasOpenFormat_ = true;
        activeDeviceId_ = resolvedDeviceId;
        activeDeviceUid_ = resolvedUid;
        activeDeviceLabel_ = resolvedLabel.empty() ? resolvedUid : resolvedLabel;
        return true;
    }

    bool start(std::string* error) override {
        if (queue_ == nullptr || engine_ == nullptr) {
            if (error != nullptr) {
                *error = "CoreAudio output queue is unavailable.";
            }
            return false;
        }

        AudioQueueStop(queue_, true);
        AudioQueueReset(queue_);
        size_t enqueuedBuffers = 0;
        for (BufferState& bufferState : buffers_) {
            if (!fillAndEnqueue(bufferState, error)) {
                AudioQueueReset(queue_);
                started_ = false;
                return false;
            }
            if (bufferState.lastFrames > 0) {
                enqueuedBuffers++;
            }
        }
        if (enqueuedBuffers == 0) {
            if (error != nullptr) {
                *error = "CoreAudio queue started without any audio frames to enqueue.";
            }
            started_ = false;
            return false;
        }

        OSStatus status = AudioQueuePrime(queue_, 0, nullptr);
        if (status != noErr && error != nullptr) {
            *error = "Failed to prime the CoreAudio output queue.";
            AudioQueueReset(queue_);
            started_ = false;
            return false;
        }

        status = AudioQueueStart(queue_, nullptr);
        if (status != noErr) {
            if (error != nullptr) {
                *error = "AudioQueueStart failed for CoreAudio playback.";
            }
            AudioQueueReset(queue_);
            started_ = false;
            return false;
        }
        started_ = true;
        return true;
    }

    void close() override {
        stop();
        releaseHogMode();
        disposeQueue();
        engine_ = nullptr;
        activeDeviceId_ = kAudioObjectUnknown;
        activeDeviceUid_.clear();
        activeDeviceLabel_.clear();
    }

    void pause() override {
        if (queue_ == nullptr) {
            return;
        }
        AudioQueuePause(queue_);
        started_ = false;
    }

    void stop() override {
        if (queue_ == nullptr) {
            return;
        }
        AudioQueueStop(queue_, true);
        started_ = false;
    }

    void reset() override {
        stop();
        if (queue_ != nullptr) {
            AudioQueueReset(queue_);
        }
    }

    bool isExclusive() const override {
        return hogModeAcquired_;
    }

    std::string activeDeviceId() const override {
        return activeDeviceUid_;
    }

    std::string activeDeviceLabel() const override {
        return activeDeviceLabel_;
    }

private:
    struct BufferState {
        AudioQueueBufferRef buffer = nullptr;
        size_t lastFrames = 0;
    };

    static constexpr size_t kBufferCount = 3;
    static constexpr size_t kFramesPerBuffer = 256;

    static void handleOutputCallback(void* userData, AudioQueueRef, AudioQueueBufferRef buffer) {
        auto* sink = static_cast<CoreAudioHalSink*>(userData);
        if (sink != nullptr) {
            sink->handleOutput(buffer);
        }
    }

    void handleOutput(AudioQueueBufferRef buffer) {
        BufferState* bufferState = nullptr;
        for (BufferState& state : buffers_) {
            if (state.buffer == buffer) {
                bufferState = &state;
                break;
            }
        }
        if (bufferState == nullptr || engine_ == nullptr) {
            return;
        }

        if (bufferState->lastFrames > 0) {
            engine_->onFramesConsumed(bufferState->lastFrames);
        }

        if (!fillAndEnqueue(*bufferState, nullptr)) {
            AudioQueueStop(queue_, false);
            started_ = false;
        }
    }

    bool fillAndEnqueue(BufferState& bufferState, std::string* error = nullptr) {
        if (queue_ == nullptr || bufferState.buffer == nullptr || engine_ == nullptr || !hasOpenFormat_) {
            if (error != nullptr) {
                *error = "CoreAudio output buffer is unavailable.";
            }
            return false;
        }

        bool streamEnded = false;
        const size_t framesWritten = engine_->renderInto(bufferState.buffer->mAudioData, kFramesPerBuffer, streamEnded);
        const UInt32 bytesPerFrame = openFormat_.bytesPerFrame();
        const UInt32 bytesToWrite = static_cast<UInt32>(kFramesPerBuffer * bytesPerFrame);

        if (framesWritten < kFramesPerBuffer) {
            const UInt32 usedBytes = static_cast<UInt32>(framesWritten * bytesPerFrame);
            const UInt32 remainingBytes = bytesToWrite - usedBytes;
            if (remainingBytes > 0) {
                std::memset(static_cast<uint8_t*>(bufferState.buffer->mAudioData) + usedBytes, 0, remainingBytes);
            }
        }

        bufferState.buffer->mAudioDataByteSize = bytesToWrite;
        bufferState.lastFrames = framesWritten;

        if (framesWritten == 0 && streamEnded) {
            AudioQueueStop(queue_, false);
            started_ = false;
            return true;
        }

        const OSStatus status = AudioQueueEnqueueBuffer(queue_, bufferState.buffer, 0, nullptr);
        if (status != noErr) {
            if (error != nullptr) {
                *error = "Failed to enqueue a CoreAudio output buffer.";
            }
            return false;
        }
        return true;
    }

    void disposeQueue() {
        if (queue_ == nullptr) {
            return;
        }

        AudioQueueDispose(queue_, true);
        queue_ = nullptr;
        for (BufferState& bufferState : buffers_) {
            bufferState.buffer = nullptr;
            bufferState.lastFrames = 0;
        }
        started_ = false;
        hasOpenFormat_ = false;
    }

    void acquireHogMode(AudioDeviceID deviceId) {
        hogModeAcquired_ = false;
        hogPid_ = -1;
        hogDeviceId_ = kAudioObjectUnknown;
        if (deviceId == kAudioObjectUnknown) {
            return;
        }

        AudioObjectPropertyAddress address {
            kAudioDevicePropertyHogMode,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        pid_t pid = getpid();
        if (AudioObjectSetPropertyData(deviceId, &address, 0, nullptr, sizeof(pid), &pid) == noErr) {
            pid_t observedPid = -1;
            if (waitForDeviceHogMode(deviceId, pid, &observedPid)) {
                hogModeAcquired_ = true;
                hogPid_ = pid;
                hogDeviceId_ = deviceId;
            }
        }
    }

    void releaseHogMode() {
        if (!hogModeAcquired_ || hogDeviceId_ == kAudioObjectUnknown) {
            hogModeAcquired_ = false;
            hogPid_ = -1;
            hogDeviceId_ = kAudioObjectUnknown;
            return;
        }

        AudioObjectPropertyAddress address {
            kAudioDevicePropertyHogMode,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        pid_t pid = -1;
        AudioObjectSetPropertyData(hogDeviceId_, &address, 0, nullptr, sizeof(pid), &pid);
        hogModeAcquired_ = false;
        hogPid_ = -1;
        hogDeviceId_ = kAudioObjectUnknown;
    }

    PlaybackEngine* engine_ = nullptr;
    AudioQueueRef queue_ = nullptr;
    TrackFormat openFormat_ {};
    bool hasOpenFormat_ = false;
    bool started_ = false;
    AudioDeviceID activeDeviceId_ = kAudioObjectUnknown;
    std::string activeDeviceUid_;
    std::string activeDeviceLabel_;
    bool hogModeAcquired_ = false;
    pid_t hogPid_ = -1;
    AudioDeviceID hogDeviceId_ = kAudioObjectUnknown;
    BufferState buffers_[kBufferCount];
};

} // namespace

std::unique_ptr<AudioOutputSink> CreatePlatformAudioSink() {
    return std::make_unique<CoreAudioHalSink>();
}

#elif !defined(_WIN32)

namespace {

class UnsupportedSink final : public AudioOutputSink {
public:
    bool supportsBitPerfect() const override {
        return false;
    }

    std::string backendKind() const override {
        return "unavailable";
    }

    std::vector<OutputDeviceInfo> enumerateOutputDevices(std::string* reason) const override {
        if (reason != nullptr) {
            *reason = "Native bit-perfect playback is not implemented for this platform in this build.";
        }
        return {};
    }

    uint32_t deviceMaxChannels(const std::string&) const override {
        return 2;
    }

    bool open(const std::string&, const TrackFormat&, PlaybackEngine*, std::string* error) override {
        if (error != nullptr) {
            *error = "Native bit-perfect playback is not implemented for this platform in this build.";
        }
        return false;
    }

    void close() override {}
    bool start(std::string* error) override {
        if (error != nullptr) {
            *error = "Native bit-perfect playback is not implemented for this platform in this build.";
        }
        return false;
    }
    void pause() override {}
    void stop() override {}
    void reset() override {}
    bool isExclusive() const override { return false; }
    std::string activeDeviceId() const override { return {}; }
    std::string activeDeviceLabel() const override { return {}; }
};

} // namespace

std::unique_ptr<AudioOutputSink> CreatePlatformAudioSink() {
    return std::make_unique<UnsupportedSink>();
}

#endif

} // namespace NativePlayback
