#include "playback_engine.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
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
constexpr size_t kSampleRateSettleMaxAttempts = 60;
constexpr useconds_t kSampleRatePostChangeSettleSleepUs = 50 * 1000;
constexpr useconds_t kStreamConfigurationSettleSleepUs = 10 * 1000;
constexpr size_t kStreamConfigurationSettleMaxAttempts = 30;
constexpr size_t kStreamConfigurationStableThreshold = 2;
constexpr useconds_t kHogModeSettleSleepUs = 10 * 1000;
constexpr size_t kHogModeAcquireMaxAttempts = 40;
constexpr size_t kHogModeSettleMaxAttempts = 150;
constexpr std::chrono::milliseconds kSampleRateWaiterTimeout { 750 };
constexpr std::chrono::milliseconds kRenderDrainWaitTimeout { 500 };
constexpr std::chrono::milliseconds kInitialPrimeWaitTimeout { 750 };
constexpr uint32_t kFallbackMaximumFramesPerSlice = 1024;
constexpr uint32_t kMaximumRequestedDeviceBufferFrames = 1024;

bool isAudioDebugLoggingEnabled() {
    static const bool enabled = []() {
        const char* value = std::getenv("ASTRA_AUDIO_DEBUG");
        const bool on = value != nullptr && value[0] != '\0' && value[0] != '0';
        if (on) {
            std::fprintf(stderr,
                "[astra-audio] ASTRA_AUDIO_DEBUG enabled - "
                "slow open()/start()/stop()/pause()/reset() and drain timeouts will be logged\n");
        }
        return on;
    }();
    return enabled;
}

class ScopedSlowOpTimer {
public:
    ScopedSlowOpTimer(const char* label, int thresholdMs)
        : label_(label), thresholdMs_(thresholdMs), enabled_(isAudioDebugLoggingEnabled()) {
        if (enabled_) {
            start_ = std::chrono::steady_clock::now();
        }
    }

    ~ScopedSlowOpTimer() {
        if (!enabled_) return;
        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - start_);
        if (elapsed.count() > thresholdMs_) {
            std::fprintf(stderr, "[astra-audio] slow %s: %lldms\n",
                label_,
                static_cast<long long>(elapsed.count()));
        }
    }

private:
    const char* label_;
    int thresholdMs_;
    bool enabled_;
    std::chrono::steady_clock::time_point start_;
};

class DevicePropertyWaiter {
public:
    DevicePropertyWaiter(AudioDeviceID deviceId, std::vector<AudioObjectPropertyAddress> addresses)
        : deviceId_(deviceId), addresses_(std::move(addresses)) {}

    ~DevicePropertyWaiter() {
        stop();
    }

    bool start() {
        if (deviceId_ == kAudioObjectUnknown) {
            return false;
        }

        for (const AudioObjectPropertyAddress& address : addresses_) {
            if (AudioObjectAddPropertyListener(deviceId_, &address, &DevicePropertyWaiter::listener, this) == noErr) {
                registeredAddresses_.push_back(address);
            }
        }
        return !registeredAddresses_.empty();
    }

    void stop() {
        if (deviceId_ == kAudioObjectUnknown || registeredAddresses_.empty()) {
            return;
        }

        for (const AudioObjectPropertyAddress& address : registeredAddresses_) {
            AudioObjectRemovePropertyListener(deviceId_, &address, &DevicePropertyWaiter::listener, this);
        }
        registeredAddresses_.clear();
    }

    bool wait(std::chrono::milliseconds timeout) {
        std::unique_lock<std::mutex> lock(mutex_);
        return cv_.wait_for(lock, timeout, [this]() {
            return notified_;
        });
    }

private:
    static OSStatus listener(
        AudioObjectID,
        UInt32,
        const AudioObjectPropertyAddress*,
        void* clientData
    ) {
        auto* waiter = static_cast<DevicePropertyWaiter*>(clientData);
        if (waiter == nullptr) {
            return noErr;
        }

        {
            std::lock_guard<std::mutex> lock(waiter->mutex_);
            waiter->notified_ = true;
        }
        waiter->cv_.notify_all();
        return noErr;
    }

    AudioDeviceID deviceId_ = kAudioObjectUnknown;
    std::vector<AudioObjectPropertyAddress> addresses_;
    std::vector<AudioObjectPropertyAddress> registeredAddresses_;
    std::mutex mutex_;
    std::condition_variable cv_;
    bool notified_ = false;
};

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

bool getDeviceBufferFrameSize(AudioDeviceID deviceId, uint32_t* outFrameSize) {
    if (deviceId == kAudioObjectUnknown || outFrameSize == nullptr) {
        return false;
    }

    AudioObjectPropertyAddress address {
        kAudioDevicePropertyBufferFrameSize,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    UInt32 frameSize = 0;
    UInt32 size = sizeof(frameSize);
    if (AudioObjectGetPropertyData(deviceId, &address, 0, nullptr, &size, &frameSize) != noErr || frameSize == 0) {
        return false;
    }

    *outFrameSize = frameSize;
    return true;
}

bool getDeviceBufferFrameSizeRange(AudioDeviceID deviceId, AudioValueRange* outRange) {
    if (deviceId == kAudioObjectUnknown || outRange == nullptr) {
        return false;
    }

    AudioObjectPropertyAddress address {
        kAudioDevicePropertyBufferFrameSizeRange,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    UInt32 size = sizeof(*outRange);
    return AudioObjectGetPropertyData(deviceId, &address, 0, nullptr, &size, outRange) == noErr
        && outRange->mMinimum > 0.0
        && outRange->mMaximum >= outRange->mMinimum;
}

bool getDeviceVariableBufferFrameSize(AudioDeviceID deviceId, uint32_t* outLargestFrameSize) {
    if (deviceId == kAudioObjectUnknown || outLargestFrameSize == nullptr) {
        return false;
    }

    AudioObjectPropertyAddress address {
        kAudioDevicePropertyUsesVariableBufferFrameSizes,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    UInt32 frameSize = 0;
    UInt32 size = sizeof(frameSize);
    if (AudioObjectGetPropertyData(deviceId, &address, 0, nullptr, &size, &frameSize) != noErr || frameSize == 0) {
        return false;
    }

    *outLargestFrameSize = frameSize;
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

bool setDeviceNominalSampleRate(AudioDeviceID deviceId, double sampleRate, bool* changed = nullptr) {
    if (changed != nullptr) {
        *changed = false;
    }
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
    const OSStatus status = AudioObjectSetPropertyData(deviceId, &address, 0, nullptr, sizeof(requestedSampleRate), &requestedSampleRate);
    if (status == noErr && changed != nullptr) {
        *changed = true;
    }
    return status == noErr;
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

bool waitForDeviceOutputConfigurationStable(AudioDeviceID deviceId) {
    uint32_t previousChannelCount = getOutputChannelCount(deviceId);
    size_t stableCount = 0;
    for (size_t attempt = 0; attempt < kStreamConfigurationSettleMaxAttempts; attempt++) {
        usleep(kStreamConfigurationSettleSleepUs);
        const uint32_t currentChannelCount = getOutputChannelCount(deviceId);
        if (currentChannelCount > 0 && currentChannelCount == previousChannelCount) {
            stableCount += 1;
            if (stableCount >= kStreamConfigurationStableThreshold) {
                return true;
            }
        } else {
            stableCount = 0;
            previousChannelCount = currentChannelCount;
        }
    }
    return getOutputChannelCount(deviceId) > 0;
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
        waitForDeviceOutputConfigurationStable(deviceId);
        return true;
    }

    DevicePropertyWaiter waiter(deviceId, {
        {
            kAudioDevicePropertyNominalSampleRate,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        },
        {
            kAudioDevicePropertyActualSampleRate,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        },
        {
            kAudioDevicePropertyStreamConfiguration,
            kAudioDevicePropertyScopeOutput,
            kAudioObjectPropertyElementMain
        }
    });
    waiter.start();

    bool sampleRateChangeRequested = false;
    if (!setDeviceNominalSampleRate(deviceId, targetSampleRate, &sampleRateChangeRequested)) {
        waiter.stop();
        if (error != nullptr) {
            const std::string currentLabel = currentSampleRate > 0.0
                ? formatSampleRateLabel(currentSampleRate)
                : "unknown";
            *error = "Failed to switch the CoreAudio device to " + formatSampleRateLabel(targetSampleRate)
                + " (current " + currentLabel + ").";
        }
        return false;
    }

    const auto rateChangeStart = std::chrono::steady_clock::now();
    std::chrono::milliseconds waiterElapsed { 0 };
    std::chrono::milliseconds pollElapsed { 0 };
    std::chrono::milliseconds outputConfigElapsed { 0 };

    if (sampleRateChangeRequested) {
        const auto waitStart = std::chrono::steady_clock::now();
        waiter.wait(kSampleRateWaiterTimeout);
        waiterElapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - waitStart);
    }

    double settledSampleRate = currentSampleRate;
    const auto pollStart = std::chrono::steady_clock::now();
    const bool pollSettled = waitForDeviceNominalSampleRate(deviceId, targetSampleRate, &settledSampleRate);
    pollElapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - pollStart);

    const auto outputConfigStart = std::chrono::steady_clock::now();
    const bool outputSettled = pollSettled && waitForDeviceOutputConfigurationStable(deviceId);
    outputConfigElapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - outputConfigStart);

    if (pollSettled && outputSettled) {
        usleep(kSampleRatePostChangeSettleSleepUs);
        waiter.stop();
        const auto totalElapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - rateChangeStart);
        if (isAudioDebugLoggingEnabled() && totalElapsed.count() > 500) {
            std::fprintf(stderr,
                "[astra-audio] slow sample-rate change to %d Hz: total=%lldms "
                "(waiter=%lldms poll=%lldms outputCfg=%lldms)\n",
                static_cast<int>(std::llround(targetSampleRate)),
                static_cast<long long>(totalElapsed.count()),
                static_cast<long long>(waiterElapsed.count()),
                static_cast<long long>(pollElapsed.count()),
                static_cast<long long>(outputConfigElapsed.count()));
        }
        return true;
    }

    waiter.stop();
    if (error != nullptr) {
        const std::string settledLabel = settledSampleRate > 0.0
            ? formatSampleRateLabel(settledSampleRate)
            : "unknown";
        *error = "Timed out waiting for the CoreAudio device to switch to "
            + formatSampleRateLabel(targetSampleRate) + " (stayed at " + settledLabel + ").";
    }
    return false;
}

uint32_t configureDeviceBufferFrameSize(AudioDeviceID deviceId) {
    uint32_t currentFrameSize = 0;
    getDeviceBufferFrameSize(deviceId, &currentFrameSize);

    AudioValueRange range {};
    uint32_t targetFrameSize = currentFrameSize > 0 ? currentFrameSize : kFallbackMaximumFramesPerSlice;
    if (getDeviceBufferFrameSizeRange(deviceId, &range)) {
        targetFrameSize = static_cast<uint32_t>(std::llround(range.mMaximum));
        targetFrameSize = std::max<uint32_t>(1, targetFrameSize);
        targetFrameSize = std::min<uint32_t>(targetFrameSize, kMaximumRequestedDeviceBufferFrames);
        targetFrameSize = std::max<uint32_t>(
            targetFrameSize,
            static_cast<uint32_t>(std::llround(range.mMinimum))
        );
    }

    if (targetFrameSize > 0 && currentFrameSize != targetFrameSize) {
        AudioObjectPropertyAddress address {
            kAudioDevicePropertyBufferFrameSize,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        Boolean isSettable = false;
        if (AudioObjectIsPropertySettable(deviceId, &address, &isSettable) == noErr && isSettable) {
            DevicePropertyWaiter waiter(deviceId, { address });
            waiter.start();
            UInt32 requestedFrameSize = targetFrameSize;
            if (AudioObjectSetPropertyData(deviceId, &address, 0, nullptr, sizeof(requestedFrameSize), &requestedFrameSize) == noErr) {
                waiter.wait(std::chrono::milliseconds(1000));
                getDeviceBufferFrameSize(deviceId, &currentFrameSize);
            }
        }
    }

    uint32_t variableFrameSize = 0;
    if (getDeviceVariableBufferFrameSize(deviceId, &variableFrameSize)) {
        targetFrameSize = std::max(targetFrameSize, variableFrameSize);
    }
    if (currentFrameSize > 0) {
        targetFrameSize = std::max(targetFrameSize, currentFrameSize);
    }
    return std::max<uint32_t>(targetFrameSize, kFallbackMaximumFramesPerSlice);
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
        std::lock_guard<std::mutex> lock(lifecycleMutex_);
        disposeUnitLocked();
        releaseHogModeLocked();
    }

    bool isAvailable() const override {
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
        const bool logEnabled = isAudioDebugLoggingEnabled();
        const auto openStart = std::chrono::steady_clock::now();
        std::chrono::milliseconds hogElapsed { 0 };
        std::chrono::milliseconds disposeElapsed { 0 };
        std::chrono::milliseconds rateElapsed { 0 };
        std::chrono::milliseconds bufferElapsed { 0 };
        std::chrono::milliseconds initElapsed { 0 };

        const AudioDeviceID resolvedDeviceId = resolveDeviceIdFromUid(deviceId);
        if (resolvedDeviceId == kAudioObjectUnknown) {
            const std::string summary = "Could not resolve the selected CoreAudio output device.";
            if (error != nullptr) *error = summary;
            std::lock_guard<std::mutex> lock(lifecycleMutex_);
            recordOpenFailureLocked(format, deviceId, deviceId, "device-resolution", 0,
                "AUDIO_DEVICE_NOT_FOUND", summary, false, false);
            return false;
        }

        std::string resolvedUid;
        std::string resolvedLabel;
        getDeviceStringProperty(resolvedDeviceId, kAudioDevicePropertyDeviceUID, &resolvedUid);
        getDeviceStringProperty(resolvedDeviceId, kAudioObjectPropertyName, &resolvedLabel);

        std::lock_guard<std::mutex> lock(lifecycleMutex_);
        std::string currentDeviceUid;
        {
            std::lock_guard<std::mutex> metadataLock(metadataMutex_);
            currentDeviceUid = activeDeviceUid_;
        }

        const bool formatChanged = !hasOpenFormat_
            || openFormat_.sampleRate != format.sampleRate
            || openFormat_.channels != format.channels
            || openFormat_.sampleFormat != format.sampleFormat;
        const bool deviceChanged = unit_ != nullptr && resolvedUid != currentDeviceUid;

        if (!formatChanged && !deviceChanged && unit_ != nullptr) {
            if (!renderEnabled_.load(std::memory_order_acquire)) {
                publishRenderStateLocked(engine, format);
            }
            if (logEnabled) {
                const auto totalElapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - openStart);
                if (totalElapsed.count() > 100) {
                    std::fprintf(stderr,
                        "[astra-audio] slow open()-noop for %d Hz: total=%lldms (already-open path)\n",
                        static_cast<int>(format.sampleRate),
                        static_cast<long long>(totalElapsed.count()));
                }
            }
            return true;
        }

        OSStatus status = noErr;
        if (deviceChanged || unit_ == nullptr) {
            const auto disposeStart = std::chrono::steady_clock::now();
            disposeUnitLocked();
            releaseHogModeLocked();
            clearActiveDeviceMetadataLocked();
            disposeElapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - disposeStart);

            const auto hogStart = std::chrono::steady_clock::now();
            const bool hogAcquired = acquireHogModeLocked(resolvedDeviceId);
            hogElapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - hogStart);
            if (!hogAcquired) {
                const std::string summary = "Could not acquire exclusive (hog) mode for the CoreAudio device. "
                    "It may be held by another process - close other audio apps or disable bit-perfect mode.";
                if (error != nullptr) *error = summary;
                recordOpenFailureLocked(format, resolvedUid, resolvedLabel, "ownership", 0,
                    "HOG_MODE_NOT_ACQUIRED", summary, true, false);
                return false;
            }

            AudioComponentDescription desc {};
            desc.componentType = kAudioUnitType_Output;
            desc.componentSubType = kAudioUnitSubType_HALOutput;
            desc.componentManufacturer = kAudioUnitManufacturer_Apple;
            AudioComponent component = AudioComponentFindNext(nullptr, &desc);
            if (component == nullptr) {
                const std::string summary = "AUHAL output component is unavailable on this system.";
                if (error != nullptr) *error = summary;
                releaseHogModeLocked();
                recordOpenFailureLocked(format, resolvedUid, resolvedLabel, "initialization", 0,
                    "AUHAL_COMPONENT_UNAVAILABLE", summary, true, false);
                return false;
            }

            status = AudioComponentInstanceNew(component, &unit_);
            if (status != noErr || unit_ == nullptr) {
                const std::string summary = "Failed to instantiate the AUHAL output unit.";
                if (error != nullptr) *error = summary;
                unit_ = nullptr;
                releaseHogModeLocked();
                recordOpenFailureLocked(format, resolvedUid, resolvedLabel, "initialization", status,
                    "AudioComponentInstanceNew", summary, true, false);
                return false;
            }

            UInt32 outputEnabled = 1;
            status = AudioUnitSetProperty(unit_,
                kAudioOutputUnitProperty_EnableIO,
                kAudioUnitScope_Output, 0,
                &outputEnabled, sizeof(outputEnabled));
            if (status != noErr) {
                const std::string summary = "Failed to enable AUHAL output I/O.";
                if (error != nullptr) *error = summary;
                disposeUnitLocked();
                releaseHogModeLocked();
                recordOpenFailureLocked(format, resolvedUid, resolvedLabel, "initialization", status,
                    "EnableAUHALOutput", summary, true, false);
                return false;
            }

            UInt32 inputEnabled = 0;
            AudioUnitSetProperty(unit_,
                kAudioOutputUnitProperty_EnableIO,
                kAudioUnitScope_Input, 1,
                &inputEnabled, sizeof(inputEnabled));

            status = AudioUnitSetProperty(unit_,
                kAudioOutputUnitProperty_CurrentDevice,
                kAudioUnitScope_Global, 0,
                &resolvedDeviceId, sizeof(resolvedDeviceId));
            if (status != noErr) {
                const std::string summary = "Failed to bind AUHAL output unit to the selected CoreAudio device.";
                if (error != nullptr) *error = summary;
                disposeUnitLocked();
                releaseHogModeLocked();
                recordOpenFailureLocked(format, resolvedUid, resolvedLabel, "device-resolution", status,
                    "BindAUHALDevice", summary, true, false);
                return false;
            }
        } else {
            stopUnitLocked(false);
            if (unitInitialized_) {
                AudioUnitUninitialize(unit_);
                unitInitialized_ = false;
            }
            needsReinit_ = false;
        }

        const auto rateStart = std::chrono::steady_clock::now();
        const bool rateOk = ensureDeviceNominalSampleRate(resolvedDeviceId, static_cast<double>(format.sampleRate), error);
        rateElapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - rateStart);
        if (!rateOk) {
            const std::string summary = error != nullptr && !error->empty()
                ? *error
                : "CoreAudio did not settle at the requested nominal sample rate.";
            disposeUnitLocked();
            releaseHogModeLocked();
            recordOpenFailureLocked(format, resolvedUid, resolvedLabel, "format-negotiation", 0,
                "NOMINAL_RATE_MISMATCH", summary, true, false);
            return false;
        }
        const auto bufferStart = std::chrono::steady_clock::now();
        const uint32_t maximumFramesPerSlice = configureDeviceBufferFrameSize(resolvedDeviceId);
        bufferElapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - bufferStart);

        AudioStreamBasicDescription asbd {};
        asbd.mSampleRate = static_cast<Float64>(format.sampleRate);
        asbd.mFormatID = kAudioFormatLinearPCM;
        asbd.mChannelsPerFrame = format.channels;
        asbd.mFramesPerPacket = 1;
        asbd.mBitsPerChannel = static_cast<UInt32>(format.bytesPerSample() * 8);
        asbd.mBytesPerFrame = format.bytesPerFrame();
        asbd.mBytesPerPacket = format.bytesPerFrame();
        asbd.mFormatFlags = kAudioFormatFlagIsPacked | static_cast<AudioFormatFlags>(kAudioFormatFlagsNativeEndian);
        if (format.sampleFormat == SampleFormat::Float32) {
            asbd.mFormatFlags |= kLinearPCMFormatFlagIsFloat;
        } else {
            asbd.mFormatFlags |= kLinearPCMFormatFlagIsSignedInteger;
        }

        status = AudioUnitSetProperty(unit_,
            kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Input, 0,
            &asbd, sizeof(asbd));
        if (status != noErr) {
            const std::string summary = "Failed to set the requested stream format on the AUHAL input scope.";
            if (error != nullptr) *error = summary;
            disposeUnitLocked();
            releaseHogModeLocked();
            recordOpenFailureLocked(format, resolvedUid, resolvedLabel, "format-negotiation", status,
                "SetAUHALStreamFormat", summary, true, false);
            return false;
        }

        AudioStreamBasicDescription verifyFormat {};
        UInt32 verifyFormatSize = sizeof(verifyFormat);
        status = AudioUnitGetProperty(unit_,
            kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Input, 0,
            &verifyFormat, &verifyFormatSize);
        if (status != noErr
            || std::abs(verifyFormat.mSampleRate - asbd.mSampleRate) > 0.01
            || verifyFormat.mFormatID != asbd.mFormatID
            || verifyFormat.mFormatFlags != asbd.mFormatFlags
            || verifyFormat.mChannelsPerFrame != asbd.mChannelsPerFrame
            || verifyFormat.mBitsPerChannel != asbd.mBitsPerChannel
            || verifyFormat.mBytesPerFrame != asbd.mBytesPerFrame
            || verifyFormat.mBytesPerPacket != asbd.mBytesPerPacket
            || verifyFormat.mFramesPerPacket != asbd.mFramesPerPacket) {
            const std::string summary = "AUHAL did not accept the requested stream format ("
                + std::to_string(static_cast<int>(asbd.mSampleRate)) + " Hz, "
                + std::to_string(asbd.mChannelsPerFrame) + " ch, "
                + std::to_string(asbd.mBytesPerFrame) + " B/frame).";
            if (error != nullptr) *error = summary;
            disposeUnitLocked();
            releaseHogModeLocked();
            recordOpenFailureLocked(format, resolvedUid, resolvedLabel, "format-negotiation", status,
                "ASBD_READBACK_MISMATCH", summary, true, false);
            return false;
        }

        if (format.channels == 2) {
            AudioChannelLayout layout {};
            layout.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo;
            const OSStatus layoutStatus = AudioUnitSetProperty(unit_,
                kAudioUnitProperty_AudioChannelLayout,
                kAudioUnitScope_Input, 0,
                &layout, sizeof(layout));
            if (layoutStatus == noErr) {
                AudioChannelLayout verifiedLayout {};
                UInt32 verifiedLayoutSize = sizeof(verifiedLayout);
                const OSStatus layoutReadStatus = AudioUnitGetProperty(unit_,
                    kAudioUnitProperty_AudioChannelLayout,
                    kAudioUnitScope_Input, 0,
                    &verifiedLayout, &verifiedLayoutSize);
                if (layoutReadStatus != noErr || verifiedLayout.mChannelLayoutTag != kAudioChannelLayoutTag_Stereo) {
                    const std::string summary = "AUHAL did not preserve the requested stereo channel layout.";
                    if (error != nullptr) *error = summary;
                    disposeUnitLocked();
                    releaseHogModeLocked();
                    recordOpenFailureLocked(format, resolvedUid, resolvedLabel, "format-negotiation", layoutReadStatus,
                        "CHANNEL_LAYOUT_MISMATCH", summary, true, false);
                    return false;
                }
            }
        }

        UInt32 auMaximumFramesPerSlice = maximumFramesPerSlice;
        status = AudioUnitSetProperty(unit_,
            kAudioUnitProperty_MaximumFramesPerSlice,
            kAudioUnitScope_Global, 0,
            &auMaximumFramesPerSlice, sizeof(auMaximumFramesPerSlice));
        if (status != noErr) {
            auMaximumFramesPerSlice = kFallbackMaximumFramesPerSlice;
        }
        prepareRenderScratchLocked(auMaximumFramesPerSlice, format);

        AURenderCallbackStruct callback {};
        callback.inputProc = &CoreAudioHalSink::renderCallback;
        callback.inputProcRefCon = this;
        status = AudioUnitSetProperty(unit_,
            kAudioUnitProperty_SetRenderCallback,
            kAudioUnitScope_Input, 0,
            &callback, sizeof(callback));
        if (status != noErr) {
            const std::string summary = "Failed to attach the render callback to the AUHAL output unit.";
            if (error != nullptr) *error = summary;
            disposeUnitLocked();
            releaseHogModeLocked();
            recordOpenFailureLocked(format, resolvedUid, resolvedLabel, "initialization", status,
                "SetAUHALRenderCallback", summary, true, true);
            return false;
        }

        const auto initStart = std::chrono::steady_clock::now();
        status = AudioUnitInitialize(unit_);
        initElapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - initStart);
        if (status != noErr) {
            const std::string summary = "Failed to initialize the AUHAL output unit.";
            if (error != nullptr) *error = summary;
            disposeUnitLocked();
            releaseHogModeLocked();
            recordOpenFailureLocked(format, resolvedUid, resolvedLabel, "initialization", status,
                "AudioUnitInitialize", summary, true, true);
            return false;
        }
        unitInitialized_ = true;
        needsReinit_ = false;
        renderEnabled_.store(false, std::memory_order_release);

        publishRenderStateLocked(engine, format);
        setActiveDeviceMetadataLocked(
            resolvedDeviceId,
            resolvedUid,
            resolvedLabel.empty() ? resolvedUid : resolvedLabel
        );
        status_.outputOpen = true;
        status_.deviceResolved = true;
        status_.formatNegotiated = true;
        status_.streamInitialized = true;
        status_.streamStarted = false;
        status_.streamRunning = false;
        status_.exclusiveRequested = true;
        status_.exclusiveAcquired = hogModeAcquired_.load(std::memory_order_acquire);
        status_.systemMixerBypassed = status_.exclusiveAcquired;
        status_.sourceSamplesModified = false;
        status_.wireFormatCanCarrySourceExactly = true;
        status_.backend = backendKind();
        status_.deviceId = resolvedUid;
        status_.deviceLabel = resolvedLabel.empty() ? resolvedUid : resolvedLabel;
        status_.transport = "AUHAL callback";
        status_.sourceFormat = DescribeTrackFormat(format);
        status_.processingFormat = status_.sourceFormat;
        status_.wireFormat = status_.sourceFormat;
        status_.wireFormat.representation = "CoreAudio ASBD/interleaved";
        status_.requestedPeriodFrames = static_cast<int>(maximumFramesPerSlice);
        status_.requestedPeriodMs = static_cast<double>(maximumFramesPerSlice) * 1000.0 / format.sampleRate;
        status_.bufferFrames = static_cast<int>(maximumFramesPerSlice);
        status_.actualPeriodFrames = static_cast<int>(maximumFramesPerSlice);
        status_.actualPeriodMs = static_cast<double>(maximumFramesPerSlice) * 1000.0 / format.sampleRate;
        status_.failureStage.clear();
        status_.osErrorCode = 0;
        status_.osErrorSymbol.clear();
        status_.failureSummary.clear();
        status_.attempts.clear();
        NativeOutputAttempt attempt;
        attempt.index = 1;
        attempt.backend = backendKind();
        attempt.deviceId = status_.deviceId;
        attempt.deviceLabel = status_.deviceLabel;
        attempt.sourceFormat = status_.sourceFormat;
        attempt.processingFormat = status_.processingFormat;
        attempt.wireFormat = status_.wireFormat;
        attempt.transport = status_.transport;
        attempt.probeResult = "read-back verified";
        attempt.deviceResolved = true;
        attempt.formatNegotiated = true;
        attempt.streamInitialized = true;
        attempt.requestedPeriodMs = status_.requestedPeriodMs;
        attempt.actualPeriodMs = status_.actualPeriodMs;
        attempt.bufferFrames = status_.bufferFrames;
        status_.attempts.push_back(std::move(attempt));
        RecomputeBitPerfectActive(status_);

        if (logEnabled) {
            const auto totalElapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - openStart);
            if (totalElapsed.count() > 100) {
                std::fprintf(stderr,
                    "[astra-audio] slow open() for %d Hz on '%s': total=%lldms "
                    "(dispose=%lldms hog=%lldms rate=%lldms buffer=%lldms init=%lldms) "
                    "deviceChanged=%d formatChanged=%d\n",
                    static_cast<int>(format.sampleRate),
                    resolvedUid.c_str(),
                    static_cast<long long>(totalElapsed.count()),
                    static_cast<long long>(disposeElapsed.count()),
                    static_cast<long long>(hogElapsed.count()),
                    static_cast<long long>(rateElapsed.count()),
                    static_cast<long long>(bufferElapsed.count()),
                    static_cast<long long>(initElapsed.count()),
                    deviceChanged ? 1 : 0,
                    formatChanged ? 1 : 0);
            }
        }
        return true;
    }

    bool start(std::string* error) override {
        ScopedSlowOpTimer timer("sink.start()", 50);
        std::lock_guard<std::mutex> lock(lifecycleMutex_);
        if (unit_ == nullptr || engine_ == nullptr) {
            const std::string summary = "CoreAudio output unit is unavailable.";
            if (error != nullptr) *error = summary;
            status_.failureStage = "initialization";
            status_.failureSummary = summary;
            RecomputeBitPerfectActive(status_);
            return false;
        }
        if (unitRunning_) {
            if (!verifyConfigurationLocked()) {
                renderEnabled_.store(false, std::memory_order_release);
                verifiedRunning_.store(false, std::memory_order_release);
                started_ = false;
                status_.failureStage = "verification";
                status_.failureSummary = "CoreAudio ownership, device binding, rate, or ASBD changed while paused.";
                if (error != nullptr) *error = status_.failureSummary;
                RecomputeBitPerfectActive(status_);
                return false;
            }
            needsReinit_ = false;
            initialBufferPrimed_.store(false, std::memory_order_release);
            renderEnabled_.store(true, std::memory_order_release);
            if (!waitForInitialPrimeLocked()) {
                renderEnabled_.store(false, std::memory_order_release);
                waitForRenderCallbacksDrainedLocked();
                verifiedRunning_.store(false, std::memory_order_release);
                started_ = false;
                status_.failureStage = "priming";
                status_.failureSummary = "AUHAL did not request an initial PCM buffer while resuming.";
                if (engine_ != nullptr) engine_->rollbackSpeculativeRender();
                if (error != nullptr) *error = status_.failureSummary;
                RecomputeBitPerfectActive(status_);
                return false;
            }
            started_ = true;
            verifiedRunning_.store(true, std::memory_order_release);
            status_.streamStarted = true;
            status_.streamRunning = true;
            if (!status_.attempts.empty()) {
                status_.attempts.back().bufferPrimed = true;
                status_.attempts.back().streamStarted = true;
                status_.attempts.back().finalVerified = true;
            }
            engine_->onPlatformStartVerified();
            RecomputeBitPerfectActive(status_);
            return true;
        }

        if (needsReinit_) {
            disableRenderAndWaitLocked();
            if (unitInitialized_) {
                AudioUnitUninitialize(unit_);
                unitInitialized_ = false;
            }

            OSStatus initStatus = AudioUnitInitialize(unit_);
            if (initStatus != noErr) {
                const std::string summary = "Failed to re-initialize the AUHAL output unit before start.";
                if (error != nullptr) *error = summary;
                status_.failureStage = "initialization";
                status_.osErrorCode = initStatus;
                status_.osErrorSymbol = "AudioUnitInitialize";
                status_.failureSummary = summary;
                if (!status_.attempts.empty()) {
                    status_.attempts.back().failureStage = status_.failureStage;
                    status_.attempts.back().osErrorCode = initStatus;
                    status_.attempts.back().osErrorSymbol = status_.osErrorSymbol;
                    status_.attempts.back().message = summary;
                }
                RecomputeBitPerfectActive(status_);
                return false;
            }
            unitInitialized_ = true;
            needsReinit_ = false;
        }

        if (!unitInitialized_) {
            const std::string summary = "AUHAL output unit is not initialized.";
            if (error != nullptr) *error = summary;
            status_.failureStage = "initialization";
            status_.failureSummary = summary;
            RecomputeBitPerfectActive(status_);
            return false;
        }

        initialBufferPrimed_.store(false, std::memory_order_release);
        renderEnabled_.store(true, std::memory_order_release);
        const OSStatus status = AudioOutputUnitStart(unit_);
        if (status != noErr) {
            renderEnabled_.store(false, std::memory_order_release);
            waitForRenderCallbacksDrainedLocked();
            if (error != nullptr) {
                *error = "AudioOutputUnitStart failed for CoreAudio playback.";
            }
            started_ = false;
            verifiedRunning_.store(false, std::memory_order_release);
            status_.failureStage = "start";
            status_.osErrorCode = status;
            status_.osErrorSymbol = "AudioOutputUnitStart";
            status_.failureSummary = "AudioOutputUnitStart failed for CoreAudio playback.";
            if (!status_.attempts.empty()) {
                status_.attempts.back().failureStage = status_.failureStage;
                status_.attempts.back().osErrorCode = status;
                status_.attempts.back().osErrorSymbol = status_.osErrorSymbol;
                status_.attempts.back().message = status_.failureSummary;
            }
            RecomputeBitPerfectActive(status_);
            return false;
        }
        AudioDeviceID boundDevice = kAudioObjectUnknown;
        UInt32 boundDeviceSize = sizeof(boundDevice);
        AudioStreamBasicDescription finalFormat {};
        UInt32 finalFormatSize = sizeof(finalFormat);
        double finalRate = 0.0;
        AudioFormatFlags expectedFlags = kAudioFormatFlagIsPacked
            | static_cast<AudioFormatFlags>(kAudioFormatFlagsNativeEndian);
        expectedFlags |= openFormat_.sampleFormat == SampleFormat::Float32
            ? kLinearPCMFormatFlagIsFloat
            : kLinearPCMFormatFlagIsSignedInteger;
        const bool finalVerified = AudioUnitGetProperty(unit_,
                kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                &boundDevice, &boundDeviceSize) == noErr
            && boundDevice == activeDeviceId_
            && AudioUnitGetProperty(unit_, kAudioUnitProperty_StreamFormat,
                kAudioUnitScope_Input, 0, &finalFormat, &finalFormatSize) == noErr
            && std::abs(finalFormat.mSampleRate - static_cast<double>(openFormat_.sampleRate)) <= 0.01
            && finalFormat.mFormatID == kAudioFormatLinearPCM
            && finalFormat.mFormatFlags == expectedFlags
            && finalFormat.mChannelsPerFrame == openFormat_.channels
            && finalFormat.mBitsPerChannel == openFormat_.bytesPerSample() * 8
            && finalFormat.mBytesPerFrame == openFormat_.bytesPerFrame()
            && finalFormat.mBytesPerPacket == openFormat_.bytesPerFrame()
            && finalFormat.mFramesPerPacket == 1
            && getDeviceNominalSampleRate(activeDeviceId_, &finalRate)
            && std::abs(finalRate - static_cast<double>(openFormat_.sampleRate)) <= 0.01
            && hogModeAcquired_.load(std::memory_order_acquire)
            && hogDeviceId_ == activeDeviceId_
            && hogPid_ == getpid();
        if (!finalVerified) {
            AudioOutputUnitStop(unit_);
            renderEnabled_.store(false, std::memory_order_release);
            waitForRenderCallbacksDrainedLocked();
            unitRunning_ = false;
            started_ = false;
            verifiedRunning_.store(false, std::memory_order_release);
            status_.failureStage = "verification";
            status_.failureSummary = "CoreAudio changed the device, nominal rate, ownership, or complete ASBD during start.";
            if (!status_.attempts.empty()) {
                status_.attempts.back().failureStage = status_.failureStage;
                status_.attempts.back().message = status_.failureSummary;
            }
            if (engine_ != nullptr) engine_->rollbackSpeculativeRender();
            if (error != nullptr) *error = status_.failureSummary;
            RecomputeBitPerfectActive(status_);
            return false;
        }
        if (!waitForInitialPrimeLocked()) {
            AudioOutputUnitStop(unit_);
            renderEnabled_.store(false, std::memory_order_release);
            waitForRenderCallbacksDrainedLocked();
            unitRunning_ = false;
            started_ = false;
            verifiedRunning_.store(false, std::memory_order_release);
            status_.failureStage = "priming";
            status_.failureSummary = "AUHAL started but did not request an initial PCM buffer before verification timed out.";
            if (!status_.attempts.empty()) {
                status_.attempts.back().failureStage = status_.failureStage;
                status_.attempts.back().message = status_.failureSummary;
            }
            if (engine_ != nullptr) engine_->rollbackSpeculativeRender();
            if (error != nullptr) *error = status_.failureSummary;
            RecomputeBitPerfectActive(status_);
            return false;
        }
        unitRunning_ = true;
        started_ = true;
        verifiedRunning_.store(true, std::memory_order_release);
        status_.streamStarted = true;
        status_.streamRunning = true;
        status_.failureStage.clear();
        status_.failureSummary.clear();
        if (!status_.attempts.empty()) {
            status_.attempts.back().bufferPrimed = true;
            status_.attempts.back().streamStarted = true;
            status_.attempts.back().finalVerified = true;
        }
        engine_->onPlatformStartVerified();
        RecomputeBitPerfectActive(status_);
        return true;
    }

    void close() override {
        ScopedSlowOpTimer timer("sink.close()", 100);
        std::lock_guard<std::mutex> lock(lifecycleMutex_);
        disposeUnitLocked();
        releaseHogModeLocked();
        clearRenderStateLocked();
        clearActiveDeviceMetadataLocked();
        verifiedRunning_.store(false, std::memory_order_release);
        status_.outputOpen = false;
        status_.deviceResolved = false;
        status_.formatNegotiated = false;
        status_.streamInitialized = false;
        status_.streamStarted = false;
        status_.streamRunning = false;
        status_.exclusiveAcquired = false;
        status_.systemMixerBypassed = false;
        RecomputeBitPerfectActive(status_);
    }

    void pause() override {
        ScopedSlowOpTimer timer("sink.pause()", 50);
        std::lock_guard<std::mutex> lock(lifecycleMutex_);
        suspendRenderingLocked();
        verifiedRunning_.store(false, std::memory_order_release);
        status_.streamRunning = false;
        status_.streamStarted = false;
        // AUHAL and hog mode remain reserved while paused.
        status_.exclusiveAcquired = hogModeAcquired_.load(std::memory_order_acquire);
        status_.systemMixerBypassed = status_.exclusiveAcquired;
        RecomputeBitPerfectActive(status_);
    }

    void stop() override {
        ScopedSlowOpTimer timer("sink.stop()", 50);
        std::lock_guard<std::mutex> lock(lifecycleMutex_);
        suspendRenderingLocked();
        verifiedRunning_.store(false, std::memory_order_release);
        status_.streamRunning = false;
        status_.streamStarted = false;
        status_.exclusiveAcquired = hogModeAcquired_.load(std::memory_order_acquire);
        status_.systemMixerBypassed = status_.exclusiveAcquired;
        RecomputeBitPerfectActive(status_);
    }

    void reset() override {
        ScopedSlowOpTimer timer("sink.reset()", 50);
        std::lock_guard<std::mutex> lock(lifecycleMutex_);
        suspendRenderingLocked();
    }

    void beginSeek(bool /*wasPlaying*/) override {
        // AUHAL stays running for seeks. PlaybackEngine serializes the cursor
        // update with renderInto(), so stopping render here only adds device churn.
    }

    void resetAfterSeek(bool /*wasPlaying*/) override {
        // AUHAL is pull-driven; seeking only needs the engine cursor update.
        // Stopping/reinitializing here is the crash-prone path on some USB devices.
    }

    bool shouldCloseOnTrackChange(const TrackFormat&, const TrackFormat&) const override {
        return false;
    }

    NativeOutputStatus outputStatus() const override {
        std::lock_guard<std::mutex> lock(lifecycleMutex_);
        NativeOutputStatus copy = status_;
        copy.streamRunning = verifiedRunning_.load(std::memory_order_acquire);
        copy.exclusiveAcquired = hogModeAcquired_.load(std::memory_order_acquire);
        copy.systemMixerBypassed = copy.exclusiveAcquired;
        RecomputeBitPerfectActive(copy);
        return copy;
    }

    std::string activeDeviceId() const override {
        std::lock_guard<std::mutex> lock(metadataMutex_);
        return activeDeviceUid_;
    }

    std::string activeDeviceLabel() const override {
        std::lock_guard<std::mutex> lock(metadataMutex_);
        return activeDeviceLabel_;
    }

private:
    void recordOpenFailureLocked(
        const TrackFormat& format,
        const std::string& deviceId,
        const std::string& deviceLabel,
        const std::string& stage,
        OSStatus osCode,
        const std::string& osSymbol,
        const std::string& summary,
        bool deviceResolved,
        bool formatNegotiated
    ) {
        status_ = NativeOutputStatus {};
        status_.backend = backendKind();
        status_.deviceId = deviceId;
        status_.deviceLabel = deviceLabel;
        status_.exclusiveRequested = true;
        status_.deviceResolved = deviceResolved;
        status_.formatNegotiated = formatNegotiated;
        status_.exclusiveAcquired = hogModeAcquired_.load(std::memory_order_acquire);
        status_.systemMixerBypassed = status_.exclusiveAcquired;
        status_.sourceSamplesModified = false;
        status_.wireFormatCanCarrySourceExactly = formatNegotiated;
        status_.sourceFormat = DescribeTrackFormat(format);
        status_.processingFormat = status_.sourceFormat;
        if (formatNegotiated) {
            status_.wireFormat = status_.sourceFormat;
            status_.wireFormat.representation = "CoreAudio ASBD/interleaved";
        }
        status_.failureStage = stage;
        status_.osErrorCode = static_cast<int64_t>(osCode);
        status_.osErrorSymbol = osSymbol;
        status_.failureSummary = summary;

        NativeOutputAttempt attempt;
        attempt.index = 1;
        attempt.backend = status_.backend;
        attempt.deviceId = deviceId;
        attempt.deviceLabel = deviceLabel;
        attempt.sourceFormat = status_.sourceFormat;
        attempt.processingFormat = status_.processingFormat;
        attempt.wireFormat = status_.wireFormat;
        attempt.transport = "AUHAL callback";
        attempt.probeResult = "attempted directly";
        attempt.deviceResolved = deviceResolved;
        attempt.formatNegotiated = formatNegotiated;
        attempt.failureStage = stage;
        attempt.osErrorCode = static_cast<int64_t>(osCode);
        attempt.osErrorSymbol = osSymbol;
        attempt.message = summary;
        status_.attempts.push_back(std::move(attempt));
        RecomputeBitPerfectActive(status_);
    }

    bool verifyConfigurationLocked() const {
        if (unit_ == nullptr || !hasOpenFormat_ || activeDeviceId_ == kAudioObjectUnknown) return false;
        AudioDeviceID boundDevice = kAudioObjectUnknown;
        UInt32 boundDeviceSize = sizeof(boundDevice);
        AudioStreamBasicDescription currentFormat {};
        UInt32 currentFormatSize = sizeof(currentFormat);
        double currentRate = 0.0;
        AudioFormatFlags expectedFlags = kAudioFormatFlagIsPacked
            | static_cast<AudioFormatFlags>(kAudioFormatFlagsNativeEndian);
        expectedFlags |= openFormat_.sampleFormat == SampleFormat::Float32
            ? kLinearPCMFormatFlagIsFloat
            : kLinearPCMFormatFlagIsSignedInteger;
        return AudioUnitGetProperty(unit_, kAudioOutputUnitProperty_CurrentDevice,
                kAudioUnitScope_Global, 0, &boundDevice, &boundDeviceSize) == noErr
            && boundDevice == activeDeviceId_
            && AudioUnitGetProperty(unit_, kAudioUnitProperty_StreamFormat,
                kAudioUnitScope_Input, 0, &currentFormat, &currentFormatSize) == noErr
            && std::abs(currentFormat.mSampleRate - static_cast<double>(openFormat_.sampleRate)) <= 0.01
            && currentFormat.mFormatID == kAudioFormatLinearPCM
            && currentFormat.mFormatFlags == expectedFlags
            && currentFormat.mChannelsPerFrame == openFormat_.channels
            && currentFormat.mBitsPerChannel == openFormat_.bytesPerSample() * 8
            && currentFormat.mBytesPerFrame == openFormat_.bytesPerFrame()
            && currentFormat.mBytesPerPacket == openFormat_.bytesPerFrame()
            && currentFormat.mFramesPerPacket == 1
            && getDeviceNominalSampleRate(activeDeviceId_, &currentRate)
            && std::abs(currentRate - static_cast<double>(openFormat_.sampleRate)) <= 0.01
            && hogModeAcquired_.load(std::memory_order_acquire)
            && hogDeviceId_ == activeDeviceId_
            && hogPid_ == getpid();
    }

    void clearActiveDeviceMetadataLocked() {
        std::lock_guard<std::mutex> lock(metadataMutex_);
        activeDeviceId_ = kAudioObjectUnknown;
        activeDeviceUid_.clear();
        activeDeviceLabel_.clear();
    }

    void setActiveDeviceMetadataLocked(
        AudioDeviceID deviceId,
        const std::string& uid,
        const std::string& label
    ) {
        std::lock_guard<std::mutex> lock(metadataMutex_);
        activeDeviceId_ = deviceId;
        activeDeviceUid_ = uid;
        activeDeviceLabel_ = label;
    }

    static void silenceOutput(AudioBufferList* ioData, AudioUnitRenderActionFlags* ioActionFlags) {
        if (ioData != nullptr) {
            for (UInt32 bufferIndex = 0; bufferIndex < ioData->mNumberBuffers; bufferIndex++) {
                AudioBuffer& buffer = ioData->mBuffers[bufferIndex];
                if (buffer.mData != nullptr && buffer.mDataByteSize > 0) {
                    std::memset(buffer.mData, 0, buffer.mDataByteSize);
                }
            }
        }
        if (ioActionFlags != nullptr) {
            *ioActionFlags |= kAudioUnitRenderAction_OutputIsSilence;
        }
    }

    static OSStatus renderCallback(
        void* inRefCon,
        AudioUnitRenderActionFlags* ioActionFlags,
        const AudioTimeStamp* /*inTimeStamp*/,
        UInt32 /*inBusNumber*/,
        UInt32 inNumberFrames,
        AudioBufferList* ioData
    ) {
        auto* sink = static_cast<CoreAudioHalSink*>(inRefCon);
        if (sink == nullptr || ioData == nullptr || ioData->mNumberBuffers == 0) {
            return noErr;
        }

        if (!sink->beginRenderCallback()) {
            silenceOutput(ioData, ioActionFlags);
            return noErr;
        }

        PlaybackEngine* engine = sink->engine_;
        const TrackFormat format = sink->openFormat_;
        const bool hasOpenFormat = sink->hasOpenFormat_;

        AudioBuffer& buffer = ioData->mBuffers[0];
        if (buffer.mData == nullptr) {
            sink->endRenderCallback();
            return noErr;
        }

        if (engine == nullptr || !hasOpenFormat) {
            silenceOutput(ioData, ioActionFlags);
            sink->endRenderCallback();
            return noErr;
        }

        const UInt32 bytesPerFrame = format.bytesPerFrame();
        const UInt32 bytesPerSample = format.bytesPerSample();
        if (bytesPerFrame == 0 || bytesPerSample == 0) {
            silenceOutput(ioData, ioActionFlags);
            sink->endRenderCallback();
            return noErr;
        }

        const size_t requestedFrames = static_cast<size_t>(inNumberFrames);
        size_t framesWritten = 0;
        bool streamEnded = false;

        if (ioData->mNumberBuffers == 1) {
            const size_t capacityFrames = static_cast<size_t>(buffer.mDataByteSize) / bytesPerFrame;
            const size_t framesToRender = std::min(requestedFrames, capacityFrames);
            if (framesToRender == 0) {
                silenceOutput(ioData, ioActionFlags);
                sink->endRenderCallback();
                return noErr;
            }

            try {
                framesWritten = engine->renderInto(buffer.mData, framesToRender, streamEnded);
            } catch (...) {
                sink->renderEnabled_.store(false, std::memory_order_release);
                silenceOutput(ioData, ioActionFlags);
                sink->endRenderCallback();
                return noErr;
            }

            const UInt32 totalBytes = static_cast<UInt32>(framesToRender * bytesPerFrame);
            const UInt32 usedBytes = static_cast<UInt32>(framesWritten * bytesPerFrame);
            if (framesWritten < framesToRender && totalBytes > usedBytes) {
                std::memset(static_cast<uint8_t*>(buffer.mData) + usedBytes, 0, totalBytes - usedBytes);
            }
        } else {
            size_t frameCapacity = requestedFrames;
            for (UInt32 bufferIndex = 0; bufferIndex < ioData->mNumberBuffers; bufferIndex++) {
                AudioBuffer& channelBuffer = ioData->mBuffers[bufferIndex];
                if (channelBuffer.mData == nullptr || channelBuffer.mDataByteSize == 0) {
                    frameCapacity = 0;
                    break;
                }
                const UInt32 channelCount = std::max<UInt32>(1, channelBuffer.mNumberChannels);
                const UInt32 bufferBytesPerFrame = bytesPerSample * channelCount;
                frameCapacity = std::min<size_t>(
                    frameCapacity,
                    static_cast<size_t>(channelBuffer.mDataByteSize) / bufferBytesPerFrame
                );
            }

            if (frameCapacity == 0) {
                silenceOutput(ioData, ioActionFlags);
                sink->endRenderCallback();
                return noErr;
            }

            frameCapacity = std::min(frameCapacity, static_cast<size_t>(sink->renderScratchCapacityFrames_));
            if (frameCapacity == 0 || sink->renderScratch_.empty()) {
                silenceOutput(ioData, ioActionFlags);
                sink->endRenderCallback();
                return noErr;
            }

            uint8_t* interleaved = sink->renderScratch_.data();
            try {
                framesWritten = engine->renderInto(interleaved, frameCapacity, streamEnded);
            } catch (...) {
                sink->renderEnabled_.store(false, std::memory_order_release);
                silenceOutput(ioData, ioActionFlags);
                sink->endRenderCallback();
                return noErr;
            }

            UInt32 sourceChannel = 0;
            for (UInt32 bufferIndex = 0; bufferIndex < ioData->mNumberBuffers; bufferIndex++) {
                AudioBuffer& channelBuffer = ioData->mBuffers[bufferIndex];
                if (channelBuffer.mData == nullptr || channelBuffer.mDataByteSize == 0) {
                    continue;
                }
                std::memset(channelBuffer.mData, 0, channelBuffer.mDataByteSize);

                const UInt32 channelCount = std::max<UInt32>(1, channelBuffer.mNumberChannels);
                const UInt32 bufferBytesPerFrame = bytesPerSample * channelCount;
                const size_t writableFrames = std::min<size_t>(
                    framesWritten,
                    static_cast<size_t>(channelBuffer.mDataByteSize) / bufferBytesPerFrame
                );
                auto* destination = static_cast<uint8_t*>(channelBuffer.mData);

                for (size_t frame = 0; frame < writableFrames; frame++) {
                    for (UInt32 channel = 0; channel < channelCount; channel++) {
                        const UInt32 trackChannel = sourceChannel + channel;
                        if (trackChannel >= format.channels) {
                            continue;
                        }
                        const uint8_t* source = interleaved
                            + (frame * bytesPerFrame)
                            + (trackChannel * bytesPerSample);
                        std::memcpy(
                            destination + (frame * bufferBytesPerFrame) + (channel * bytesPerSample),
                            source,
                            bytesPerSample
                        );
                    }
                }
                sourceChannel += channelCount;
            }
        }

        if (framesWritten > 0) {
            sink->initialBufferPrimed_.store(true, std::memory_order_release);
            sink->initialPrimeCv_.notify_all();
            engine->onFramesConsumed(framesWritten);
        }

        if (streamEnded) {
            sink->renderEnabled_.store(false, std::memory_order_release);
            sink->verifiedRunning_.store(false, std::memory_order_release);
            if (framesWritten == 0 && ioActionFlags != nullptr) {
                *ioActionFlags |= kAudioUnitRenderAction_OutputIsSilence;
            }
        }
        sink->endRenderCallback();
        if (streamEnded) engine->onNativeStreamEnded();
        return noErr;
    }

    bool beginRenderCallback() {
        if (!renderEnabled_.load(std::memory_order_acquire)) {
            return false;
        }

        activeRenderCallbacks_.fetch_add(1, std::memory_order_acq_rel);
        if (!renderEnabled_.load(std::memory_order_acquire)) {
            endRenderCallback();
            return false;
        }
        return true;
    }

    void endRenderCallback() {
        const uint32_t previous = activeRenderCallbacks_.fetch_sub(1, std::memory_order_acq_rel);
        if (previous == 1) {
            renderDrainCv_.notify_all();
        }
    }

    void waitForRenderCallbacksDrainedLocked() {
        if (activeRenderCallbacks_.load(std::memory_order_acquire) == 0) {
            return;
        }

        std::unique_lock<std::mutex> lock(renderDrainMutex_);
        const bool drained = renderDrainCv_.wait_for(lock, kRenderDrainWaitTimeout, [this]() {
            return activeRenderCallbacks_.load(std::memory_order_acquire) == 0;
        });
        if (!drained) {
            const uint32_t stuckCount = activeRenderCallbacks_.load(std::memory_order_acquire);
            if (isAudioDebugLoggingEnabled()) {
                std::fprintf(stderr,
                    "[astra-audio] render-drain timed out after %lldms; "
                    "force-resetting activeRenderCallbacks_ (was %u)\n",
                    static_cast<long long>(kRenderDrainWaitTimeout.count()),
                    stuckCount);
            }
            activeRenderCallbacks_.store(0, std::memory_order_release);
        }
    }

    bool waitForInitialPrimeLocked() {
        if (initialBufferPrimed_.load(std::memory_order_acquire)) return true;
        std::unique_lock<std::mutex> lock(initialPrimeMutex_);
        return initialPrimeCv_.wait_for(lock, kInitialPrimeWaitTimeout, [this]() {
            return initialBufferPrimed_.load(std::memory_order_acquire);
        });
    }

    void disableRenderAndWaitLocked() {
        renderEnabled_.store(false, std::memory_order_release);
        waitForRenderCallbacksDrainedLocked();
    }

    void publishRenderStateLocked(PlaybackEngine* engine, const TrackFormat& format) {
        engine_ = engine;
        openFormat_ = format;
        hasOpenFormat_ = true;
    }

    void clearRenderStateLocked() {
        engine_ = nullptr;
        openFormat_ = TrackFormat {};
        hasOpenFormat_ = false;
        renderScratch_.clear();
        renderScratchCapacityFrames_ = 0;
    }

    void prepareRenderScratchLocked(uint32_t maximumFramesPerSlice, const TrackFormat& format) {
        renderScratchCapacityFrames_ = std::max<uint32_t>(1, maximumFramesPerSlice);
        renderScratch_.resize(static_cast<size_t>(renderScratchCapacityFrames_) * format.bytesPerFrame());
    }

    void suspendRenderingLocked() {
        disableRenderAndWaitLocked();
        started_ = false;
        needsReinit_ = false;
    }

    void stopUnitLocked(bool markNeedsReinit) {
        if (unit_ == nullptr || !unitRunning_) {
            renderEnabled_.store(false, std::memory_order_release);
            waitForRenderCallbacksDrainedLocked();
            started_ = false;
            return;
        }

        disableRenderAndWaitLocked();
        AudioOutputUnitStop(unit_);
        unitRunning_ = false;
        disableRenderAndWaitLocked();
        started_ = false;
        if (markNeedsReinit && unitInitialized_) {
            needsReinit_ = true;
        }
    }

    void disposeUnitLocked() {
        disableRenderAndWaitLocked();
        if (unit_ == nullptr) {
            return;
        }
        if (unitRunning_) {
            AudioOutputUnitStop(unit_);
            unitRunning_ = false;
            disableRenderAndWaitLocked();
        }
        if (unitInitialized_) {
            AudioUnitUninitialize(unit_);
            unitInitialized_ = false;
        }
        AudioComponentInstanceDispose(unit_);
        unit_ = nullptr;
        clearRenderStateLocked();
        started_ = false;
        needsReinit_ = false;
    }

    bool acquireHogModeLocked(AudioDeviceID deviceId) {
        hogModeAcquired_.store(false, std::memory_order_release);
        hogPid_ = -1;
        hogDeviceId_ = kAudioObjectUnknown;
        if (deviceId == kAudioObjectUnknown) {
            return false;
        }

        AudioObjectPropertyAddress address {
            kAudioDevicePropertyHogMode,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        pid_t pid = getpid();
        for (size_t attempt = 0; attempt < kHogModeAcquireMaxAttempts; attempt++) {
            AudioObjectSetPropertyData(deviceId, &address, 0, nullptr, sizeof(pid), &pid);

            pid_t observedPid = -1;
            if (getDeviceHogModePid(deviceId, &observedPid) && observedPid == pid) {
                hogModeAcquired_.store(true, std::memory_order_release);
                hogPid_ = pid;
                hogDeviceId_ = deviceId;
                return true;
            }
            usleep(kHogModeSettleSleepUs);
        }

        return false;
    }

    void releaseHogModeLocked() {
        if (!hogModeAcquired_.load(std::memory_order_acquire) || hogDeviceId_ == kAudioObjectUnknown) {
            hogModeAcquired_.store(false, std::memory_order_release);
            hogPid_ = -1;
            hogDeviceId_ = kAudioObjectUnknown;
            return;
        }

        const AudioDeviceID deviceId = hogDeviceId_;
        AudioObjectPropertyAddress address {
            kAudioDevicePropertyHogMode,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        pid_t pid = -1;
        AudioObjectSetPropertyData(deviceId, &address, 0, nullptr, sizeof(pid), &pid);
        waitForDeviceHogMode(deviceId, -1);
        hogModeAcquired_.store(false, std::memory_order_release);
        hogPid_ = -1;
        hogDeviceId_ = kAudioObjectUnknown;
    }

    mutable std::mutex lifecycleMutex_;
    mutable std::mutex metadataMutex_;
    std::mutex renderDrainMutex_;
    std::condition_variable renderDrainCv_;
    std::atomic<bool> renderEnabled_ { false };
    std::atomic<bool> verifiedRunning_ { false };
    std::atomic<uint32_t> activeRenderCallbacks_ { 0 };
    std::atomic<bool> initialBufferPrimed_ { false };
    std::mutex initialPrimeMutex_;
    std::condition_variable initialPrimeCv_;
    std::vector<uint8_t> renderScratch_;
    uint32_t renderScratchCapacityFrames_ = 0;
    PlaybackEngine* engine_ = nullptr;
    AudioComponentInstance unit_ = nullptr;
    bool unitInitialized_ = false;
    bool unitRunning_ = false;
    bool needsReinit_ = false;
    TrackFormat openFormat_ {};
    bool hasOpenFormat_ = false;
    bool started_ = false;
    AudioDeviceID activeDeviceId_ = kAudioObjectUnknown;
    std::string activeDeviceUid_;
    std::string activeDeviceLabel_;
    std::atomic<bool> hogModeAcquired_ { false };
    pid_t hogPid_ = -1;
    AudioDeviceID hogDeviceId_ = kAudioObjectUnknown;
    NativeOutputStatus status_ {};
};

} // namespace

std::unique_ptr<AudioOutputSink> CreatePlatformAudioSink() {
    return std::make_unique<CoreAudioHalSink>();
}

#elif !defined(_WIN32) && !defined(__linux__)

namespace {

class UnsupportedSink final : public AudioOutputSink {
public:
    bool isAvailable() const override {
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
    NativeOutputStatus outputStatus() const override {
        NativeOutputStatus status;
        status.backend = backendKind();
        status.exclusiveRequested = true;
        return status;
    }
    std::string activeDeviceId() const override { return {}; }
    std::string activeDeviceLabel() const override { return {}; }
};

} // namespace

std::unique_ptr<AudioOutputSink> CreatePlatformAudioSink() {
    return std::make_unique<UnsupportedSink>();
}

#endif

} // namespace NativePlayback
