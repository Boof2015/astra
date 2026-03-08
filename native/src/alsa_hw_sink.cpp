#include "playback_engine.h"

#include <algorithm>
#include <cctype>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

#if defined(__linux__)
#include <alsa/asoundlib.h>
#endif

namespace NativePlayback {

#if defined(__linux__)

namespace {

constexpr int kRenderThreadWaitTimeoutMs = 100;
constexpr snd_pcm_uframes_t kPreferredPeriodFrames = 256;
constexpr snd_pcm_uframes_t kPreferredBufferPeriods = 4;

std::string formatAlsaError(const std::string& message, int errorCode) {
    return message + " (" + snd_strerror(errorCode) + ").";
}

std::string trimWhitespace(const std::string& value) {
    size_t start = 0;
    while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start])) != 0) {
        start++;
    }

    size_t end = value.size();
    while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1])) != 0) {
        end--;
    }

    return value.substr(start, end - start);
}

std::string firstDescriptionLine(const std::string& description) {
    size_t lineStart = 0;
    while (lineStart < description.size()) {
        const size_t lineEnd = description.find('\n', lineStart);
        const size_t currentEnd = lineEnd == std::string::npos ? description.size() : lineEnd;
        const std::string trimmed = trimWhitespace(description.substr(lineStart, currentEnd - lineStart));
        if (!trimmed.empty()) {
            return trimmed;
        }
        if (lineEnd == std::string::npos) {
            break;
        }
        lineStart = lineEnd + 1;
    }

    return {};
}

std::string getHintString(void* hint, const char* id) {
    if (hint == nullptr || id == nullptr) {
        return {};
    }

    char* rawValue = snd_device_name_get_hint(hint, id);
    if (rawValue == nullptr) {
        return {};
    }

    std::string value(rawValue);
    free(rawValue);
    return value;
}

snd_pcm_format_t toAlsaFormat(SampleFormat sampleFormat) {
    switch (sampleFormat) {
        case SampleFormat::Int16:
            return SND_PCM_FORMAT_S16_LE;
        case SampleFormat::Int32:
            return SND_PCM_FORMAT_S32_LE;
        case SampleFormat::Float32:
        default:
            return SND_PCM_FORMAT_FLOAT_LE;
    }
}

uint32_t queryDeviceMaxChannels(const std::string& deviceId) {
    if (deviceId.empty()) {
        return 2;
    }

    snd_pcm_t* pcmHandle = nullptr;
    const int openResult = snd_pcm_open(&pcmHandle, deviceId.c_str(), SND_PCM_STREAM_PLAYBACK, 0);
    if (openResult < 0 || pcmHandle == nullptr) {
        return 2;
    }

    uint32_t maxChannels = 2;
    snd_pcm_hw_params_t* hwParams = nullptr;
    snd_pcm_hw_params_alloca(&hwParams);
    if (snd_pcm_hw_params_any(pcmHandle, hwParams) >= 0) {
        unsigned int channels = 0;
        if (snd_pcm_hw_params_get_channels_max(hwParams, &channels) >= 0 && channels > 0) {
            maxChannels = std::max<uint32_t>(2, channels);
        }
    }

    snd_pcm_close(pcmHandle);
    return maxChannels;
}

std::vector<OutputDeviceInfo> enumerateAlsaHwDevices(std::string* reason) {
    void** hints = nullptr;
    const int hintResult = snd_device_name_hint(-1, "pcm", &hints);
    if (hintResult < 0 || hints == nullptr) {
        if (reason != nullptr) {
            *reason = "No ALSA hardware playback devices are available.";
        }
        return {};
    }

    std::vector<OutputDeviceInfo> devices;
    std::unordered_set<std::string> seenIds;

    for (void** currentHint = hints; *currentHint != nullptr; ++currentHint) {
        const std::string name = getHintString(*currentHint, "NAME");
        if (name.empty() || name.rfind("hw:", 0) != 0) {
            continue;
        }

        const std::string ioId = getHintString(*currentHint, "IOID");
        if (!ioId.empty() && ioId != "Output") {
            continue;
        }

        if (!seenIds.insert(name).second) {
            continue;
        }

        const std::string description = firstDescriptionLine(getHintString(*currentHint, "DESC"));
        devices.push_back({
            name,
            description.empty() ? name : description,
            queryDeviceMaxChannels(name),
            devices.empty()
        });
    }

    snd_device_name_free_hint(hints);

    if (devices.empty()) {
        if (reason != nullptr) {
            *reason = "No ALSA hardware playback devices are available.";
        }
        return {};
    }

    if (reason != nullptr) {
        reason->clear();
    }
    return devices;
}

bool resolveOutputDevice(
    const std::string& requestedDeviceId,
    OutputDeviceInfo* resolvedDevice,
    std::string* error
) {
    if (resolvedDevice == nullptr) {
        if (error != nullptr) {
            *error = "ALSA hw output could not resolve the selected device.";
        }
        return false;
    }

    std::string ignoredReason;
    const std::vector<OutputDeviceInfo> devices = enumerateAlsaHwDevices(&ignoredReason);
    if (devices.empty()) {
        if (error != nullptr) {
            *error = ignoredReason.empty()
                ? "No ALSA hardware playback devices are available."
                : ignoredReason;
        }
        return false;
    }

    if (requestedDeviceId.empty()) {
        *resolvedDevice = devices.front();
        return true;
    }

    for (const OutputDeviceInfo& device : devices) {
        if (device.id == requestedDeviceId) {
            *resolvedDevice = device;
            return true;
        }
    }

    snd_pcm_t* testHandle = nullptr;
    const int openResult = snd_pcm_open(&testHandle, requestedDeviceId.c_str(), SND_PCM_STREAM_PLAYBACK, 0);
    if (openResult >= 0 && testHandle != nullptr) {
        snd_pcm_close(testHandle);
        *resolvedDevice = {
            requestedDeviceId,
            requestedDeviceId,
            queryDeviceMaxChannels(requestedDeviceId),
            false
        };
        return true;
    }

    if (error != nullptr) {
        *error = "The selected ALSA hardware device is unavailable: " + requestedDeviceId + ".";
    }
    return false;
}

bool configurePcmHandle(
    snd_pcm_t* pcmHandle,
    const TrackFormat& format,
    snd_pcm_uframes_t* outPeriodFrames,
    snd_pcm_uframes_t* outBufferFrames,
    std::string* error
) {
    if (pcmHandle == nullptr) {
        if (error != nullptr) {
            *error = "ALSA hw output could not configure a null PCM handle.";
        }
        return false;
    }

    snd_pcm_hw_params_t* hwParams = nullptr;
    snd_pcm_hw_params_alloca(&hwParams);

    int result = snd_pcm_hw_params_any(pcmHandle, hwParams);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError("ALSA hw output could not query hardware capabilities", result);
        }
        return false;
    }

    result = snd_pcm_hw_params_set_rate_resample(pcmHandle, hwParams, 0);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError("ALSA hw output could not disable hardware resampling", result);
        }
        return false;
    }

    result = snd_pcm_hw_params_set_access(pcmHandle, hwParams, SND_PCM_ACCESS_RW_INTERLEAVED);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError("ALSA hw output could not enable interleaved PCM access", result);
        }
        return false;
    }

    const snd_pcm_format_t alsaFormat = toAlsaFormat(format.sampleFormat);
    result = snd_pcm_hw_params_set_format(pcmHandle, hwParams, alsaFormat);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError(
                "The selected ALSA hardware device does not support " + format.sampleFormatId() + " samples",
                result
            );
        }
        return false;
    }

    result = snd_pcm_hw_params_set_channels(pcmHandle, hwParams, format.channels);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError(
                "The selected ALSA hardware device does not support "
                    + std::to_string(format.channels) + " output channels",
                result
            );
        }
        return false;
    }

    unsigned int requestedSampleRate = format.sampleRate;
    int sampleRateDirection = 0;
    result = snd_pcm_hw_params_set_rate_near(pcmHandle, hwParams, &requestedSampleRate, &sampleRateDirection);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError(
                "The selected ALSA hardware device could not set " + std::to_string(format.sampleRate) + " Hz",
                result
            );
        }
        return false;
    }

    snd_pcm_uframes_t periodFrames = kPreferredPeriodFrames;
    int periodDirection = 0;
    result = snd_pcm_hw_params_set_period_size_near(pcmHandle, hwParams, &periodFrames, &periodDirection);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError("ALSA hw output could not configure its period size", result);
        }
        return false;
    }

    snd_pcm_uframes_t bufferFrames = std::max<snd_pcm_uframes_t>(periodFrames * kPreferredBufferPeriods, periodFrames * 2);
    result = snd_pcm_hw_params_set_buffer_size_near(pcmHandle, hwParams, &bufferFrames);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError("ALSA hw output could not configure its buffer size", result);
        }
        return false;
    }

    result = snd_pcm_hw_params(pcmHandle, hwParams);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError("ALSA hw output could not apply the selected hardware format", result);
        }
        return false;
    }

    snd_pcm_hw_params_t* currentParams = nullptr;
    snd_pcm_hw_params_alloca(&currentParams);
    result = snd_pcm_hw_params_current(pcmHandle, currentParams);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError("ALSA hw output could not read back the active hardware format", result);
        }
        return false;
    }

    snd_pcm_format_t activeFormat = SND_PCM_FORMAT_UNKNOWN;
    unsigned int activeChannels = 0;
    unsigned int activeSampleRate = 0;
    int activeSampleRateDirection = 0;
    snd_pcm_hw_params_get_format(currentParams, &activeFormat);
    snd_pcm_hw_params_get_channels(currentParams, &activeChannels);
    snd_pcm_hw_params_get_rate(currentParams, &activeSampleRate, &activeSampleRateDirection);

    if (activeFormat != alsaFormat || activeChannels != format.channels || activeSampleRate != format.sampleRate) {
        if (error != nullptr) {
            *error = "The selected ALSA hardware device does not support "
                + std::to_string(format.sampleRate)
                + " Hz "
                + std::to_string(format.channels)
                + "-channel "
                + format.sampleFormatId()
                + " in direct hardware mode.";
        }
        return false;
    }

    snd_pcm_sw_params_t* swParams = nullptr;
    snd_pcm_sw_params_alloca(&swParams);
    result = snd_pcm_sw_params_current(pcmHandle, swParams);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError("ALSA hw output could not query software playback parameters", result);
        }
        return false;
    }

    result = snd_pcm_get_params(pcmHandle, &bufferFrames, &periodFrames);
    if (result < 0 || periodFrames == 0 || bufferFrames == 0) {
        if (error != nullptr) {
            *error = formatAlsaError("ALSA hw output could not query its buffer geometry", result);
        }
        return false;
    }

    result = snd_pcm_sw_params_set_start_threshold(pcmHandle, swParams, bufferFrames + 1);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError("ALSA hw output could not configure manual stream start", result);
        }
        return false;
    }

    result = snd_pcm_sw_params_set_avail_min(pcmHandle, swParams, periodFrames);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError("ALSA hw output could not configure its availability threshold", result);
        }
        return false;
    }

    result = snd_pcm_sw_params(pcmHandle, swParams);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError("ALSA hw output could not apply software playback parameters", result);
        }
        return false;
    }

    result = snd_pcm_prepare(pcmHandle);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError("ALSA hw output could not prepare the device", result);
        }
        return false;
    }

    if (outPeriodFrames != nullptr) {
        *outPeriodFrames = std::max<snd_pcm_uframes_t>(1, periodFrames);
    }
    if (outBufferFrames != nullptr) {
        *outBufferFrames = std::max<snd_pcm_uframes_t>(std::max<snd_pcm_uframes_t>(1, periodFrames), bufferFrames);
    }
    return true;
}

class AlsaHwSink final : public AudioOutputSink {
public:
    AlsaHwSink() = default;

    ~AlsaHwSink() override {
        close();
    }

    bool supportsBitPerfect() const override {
        return true;
    }

    std::string backendKind() const override {
        return "alsa-hw";
    }

    std::vector<OutputDeviceInfo> enumerateOutputDevices(std::string* reason) const override {
        return enumerateAlsaHwDevices(reason);
    }

    uint32_t deviceMaxChannels(const std::string& deviceId) const override {
        if (!deviceId.empty()) {
            return queryDeviceMaxChannels(deviceId);
        }

        std::string ignoredReason;
        const std::vector<OutputDeviceInfo> devices = enumerateAlsaHwDevices(&ignoredReason);
        return devices.empty() ? 2 : devices.front().maxChannels;
    }

    bool open(
        const std::string& deviceId,
        const TrackFormat& format,
        PlaybackEngine* engine,
        std::string* error
    ) override {
        OutputDeviceInfo resolvedDevice;
        if (!resolveOutputDevice(deviceId, &resolvedDevice, error)) {
            return false;
        }

        {
            std::lock_guard<std::mutex> lock(mutex_);
            const bool formatChanged = !hasOpenFormat_
                || openFormat_.sampleRate != format.sampleRate
                || openFormat_.channels != format.channels
                || openFormat_.sampleFormat != format.sampleFormat;
            const bool deviceChanged = resolvedDevice.id != activeDeviceId_;
            engine_ = engine;
            if (!formatChanged && !deviceChanged && pcmHandle_ != nullptr) {
                return true;
            }
        }

        close();

        snd_pcm_t* pcmHandle = nullptr;
        const int openResult = snd_pcm_open(&pcmHandle, resolvedDevice.id.c_str(), SND_PCM_STREAM_PLAYBACK, 0);
        if (openResult < 0 || pcmHandle == nullptr) {
            if (error != nullptr) {
                *error = formatAlsaError(
                    "Failed to open the selected ALSA hardware device " + resolvedDevice.id,
                    openResult
                );
            }
            return false;
        }

        snd_pcm_uframes_t configuredPeriodFrames = kPreferredPeriodFrames;
        snd_pcm_uframes_t configuredBufferFrames = kPreferredPeriodFrames * kPreferredBufferPeriods;
        if (!configurePcmHandle(pcmHandle, format, &configuredPeriodFrames, &configuredBufferFrames, error)) {
            snd_pcm_close(pcmHandle);
            return false;
        }

        std::lock_guard<std::mutex> lock(mutex_);
        pcmHandle_ = pcmHandle;
        engine_ = engine;
        openFormat_ = format;
        hasOpenFormat_ = true;
        activeDeviceId_ = resolvedDevice.id;
        activeDeviceLabel_ = resolvedDevice.label;
        activeDeviceMaxChannels_ = resolvedDevice.maxChannels;
        periodFrames_ = configuredPeriodFrames;
        bufferFrames_ = configuredBufferFrames;
        stopRequested_ = false;
        accountProgressOnStop_ = false;
        return true;
    }

    void close() override {
        stopRenderThread(false);

        snd_pcm_t* pcmHandle = nullptr;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            pcmHandle = pcmHandle_;
            pcmHandle_ = nullptr;
            engine_ = nullptr;
            hasOpenFormat_ = false;
            openFormat_ = TrackFormat{};
            activeDeviceId_.clear();
            activeDeviceLabel_.clear();
            activeDeviceMaxChannels_ = 2;
            periodFrames_ = kPreferredPeriodFrames;
            bufferFrames_ = kPreferredPeriodFrames * kPreferredBufferPeriods;
        }

        if (pcmHandle != nullptr) {
            snd_pcm_drop(pcmHandle);
            snd_pcm_close(pcmHandle);
        }
    }

    bool start(std::string* error) override {
        stopRenderThread(false);

        try {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                if (!hasOpenFormat_ || engine_ == nullptr || pcmHandle_ == nullptr) {
                    if (error != nullptr) {
                        *error = "ALSA hw output is unavailable.";
                    }
                    return false;
                }

                stopRequested_ = false;
                accountProgressOnStop_ = false;
                startFinished_ = false;
                startSucceeded_ = false;
                startError_.clear();
            }

            renderThread_ = std::thread(&AlsaHwSink::renderLoop, this);
        } catch (const std::exception& threadError) {
            if (error != nullptr) {
                *error = std::string("ALSA hw output could not start its render thread: ") + threadError.what();
            }
            return false;
        }

        std::unique_lock<std::mutex> lock(mutex_);
        startCv_.wait(lock, [this]() { return startFinished_; });
        const bool success = startSucceeded_;
        const std::string startError = startError_;
        lock.unlock();

        if (!success) {
            if (renderThread_.joinable()) {
                renderThread_.join();
            }
            if (error != nullptr) {
                *error = startError.empty()
                    ? "ALSA hw output failed to start."
                    : startError;
            }
            return false;
        }

        return true;
    }

    void pause() override {
        stopRenderThread(true);
        resetPcmHandle();
    }

    void stop() override {
        stopRenderThread(false);
        resetPcmHandle();
    }

    void reset() override {
        stop();
    }

    bool isExclusive() const override {
        std::lock_guard<std::mutex> lock(mutex_);
        return renderThread_.joinable() || pcmHandle_ != nullptr;
    }

    std::string activeDeviceId() const override {
        std::lock_guard<std::mutex> lock(mutex_);
        return activeDeviceId_;
    }

    std::string activeDeviceLabel() const override {
        std::lock_guard<std::mutex> lock(mutex_);
        return activeDeviceLabel_;
    }

private:
    void resetPcmHandle() {
        snd_pcm_t* pcmHandle = nullptr;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            pcmHandle = pcmHandle_;
        }

        if (pcmHandle != nullptr) {
            snd_pcm_drop(pcmHandle);
            snd_pcm_prepare(pcmHandle);
        }
    }

    void stopRenderThread(bool accountProgress) {
        std::thread threadToJoin;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            stopRequested_ = true;
            accountProgressOnStop_ = accountProgress;
            if (renderThread_.joinable()) {
                threadToJoin = std::move(renderThread_);
            }
        }

        if (threadToJoin.joinable()) {
            threadToJoin.join();
        }
    }

    void finishStart(bool success, std::string error = {}) {
        std::lock_guard<std::mutex> lock(mutex_);
        startFinished_ = true;
        startSucceeded_ = success;
        startError_ = std::move(error);
        startCv_.notify_one();
    }

    void renderLoop() {
        PlaybackEngine* engine = nullptr;
        snd_pcm_t* pcmHandle = nullptr;
        TrackFormat format {};
        snd_pcm_uframes_t periodFrames = 0;
        snd_pcm_uframes_t bufferFrames = 0;

        {
            std::lock_guard<std::mutex> lock(mutex_);
            engine = engine_;
            pcmHandle = pcmHandle_;
            format = openFormat_;
            periodFrames = periodFrames_;
            bufferFrames = bufferFrames_;
        }

        if (engine == nullptr || pcmHandle == nullptr || format.sampleRate == 0 || format.channels == 0) {
            finishStart(false, "ALSA hw output is unavailable.");
            return;
        }

        const size_t maxFramesPerChunk = static_cast<size_t>(std::max(periodFrames, bufferFrames));
        const size_t bytesPerFrame = static_cast<size_t>(format.bytesPerFrame());
        std::vector<uint8_t> renderBuffer(maxFramesPerChunk * bytesPerFrame, 0);

        snd_pcm_uframes_t queuedEndpointFrames = 0;
        snd_pcm_uframes_t queuedAudioFrames = 0;
        bool endOfStreamReached = false;
        bool streamStarted = false;

        auto recoverStream = [&](int errorCode) -> bool {
            const int recoverResult = snd_pcm_recover(pcmHandle, errorCode, 1);
            if (recoverResult < 0) {
                return false;
            }

            queuedEndpointFrames = 0;
            queuedAudioFrames = 0;
            streamStarted = false;
            return snd_pcm_prepare(pcmHandle) >= 0;
        };

        auto startStream = [&](std::string* startError) -> bool {
            const int startResult = snd_pcm_start(pcmHandle);
            if (startResult < 0) {
                if (startError != nullptr) {
                    *startError = formatAlsaError("ALSA hw output failed to start", startResult);
                }
                return false;
            }
            streamStarted = true;
            return true;
        };

        auto updatePlaybackProgress = [&]() {
            if (queuedEndpointFrames == 0) {
                return;
            }

            snd_pcm_sframes_t delayFrames = 0;
            const int delayResult = snd_pcm_delay(pcmHandle, &delayFrames);
            if (delayResult < 0) {
                recoverStream(delayResult);
                return;
            }

            if (delayFrames < 0) {
                delayFrames = 0;
            }

            const snd_pcm_uframes_t delay = static_cast<snd_pcm_uframes_t>(delayFrames);
            if (delay > queuedEndpointFrames) {
                queuedEndpointFrames = delay;
                return;
            }

            const snd_pcm_uframes_t consumedEndpointFrames = queuedEndpointFrames - delay;
            queuedEndpointFrames = delay;
            if (consumedEndpointFrames == 0) {
                return;
            }

            const snd_pcm_uframes_t consumedAudioFrames = std::min(queuedAudioFrames, consumedEndpointFrames);
            queuedAudioFrames -= consumedAudioFrames;
            if (consumedAudioFrames > 0) {
                engine->onFramesConsumed(consumedAudioFrames);
            }
        };

        auto fillAndWriteFrames = [&](snd_pcm_uframes_t requestedFrames, snd_pcm_uframes_t* writtenAudioFrames, bool* reachedEndOfStream, std::string* fillError) -> bool {
            bool streamEnded = false;
            const size_t framesWritten = engine->renderInto(renderBuffer.data(), requestedFrames, streamEnded);
            const snd_pcm_uframes_t usedFrames = static_cast<snd_pcm_uframes_t>(std::min<size_t>(framesWritten, requestedFrames));

            if (usedFrames < requestedFrames && bytesPerFrame > 0) {
                const size_t usedBytes = static_cast<size_t>(usedFrames) * bytesPerFrame;
                const size_t remainingBytes = static_cast<size_t>(requestedFrames - usedFrames) * bytesPerFrame;
                std::memset(renderBuffer.data() + usedBytes, 0, remainingBytes);
            }

            snd_pcm_uframes_t totalWritten = 0;
            while (totalWritten < requestedFrames) {
                const uint8_t* writePointer = renderBuffer.data() + (static_cast<size_t>(totalWritten) * bytesPerFrame);
                const snd_pcm_sframes_t writeResult = snd_pcm_writei(pcmHandle, writePointer, requestedFrames - totalWritten);
                if (writeResult > 0) {
                    totalWritten += static_cast<snd_pcm_uframes_t>(writeResult);
                    continue;
                }

                if (writeResult == 0 || writeResult == -EAGAIN || writeResult == -EINTR) {
                    snd_pcm_wait(pcmHandle, kRenderThreadWaitTimeoutMs);
                    continue;
                }

                if (!recoverStream(static_cast<int>(writeResult))) {
                    if (fillError != nullptr) {
                        *fillError = formatAlsaError("ALSA hw output could not write to the device", static_cast<int>(writeResult));
                    }
                    return false;
                }

                totalWritten = 0;
            }

            if (writtenAudioFrames != nullptr) {
                *writtenAudioFrames = usedFrames;
            }
            if (reachedEndOfStream != nullptr) {
                *reachedEndOfStream = streamEnded;
            }
            return true;
        };

        const snd_pcm_uframes_t initialPrimeTarget = std::max<snd_pcm_uframes_t>(periodFrames, bufferFrames);
        while (queuedEndpointFrames < initialPrimeTarget && !endOfStreamReached) {
            const snd_pcm_uframes_t requestedFrames = std::min<snd_pcm_uframes_t>(periodFrames, initialPrimeTarget - queuedEndpointFrames);
            snd_pcm_uframes_t writtenAudioFrames = 0;
            std::string fillError;
            if (!fillAndWriteFrames(requestedFrames, &writtenAudioFrames, &endOfStreamReached, &fillError)) {
                finishStart(false, fillError);
                snd_pcm_drop(pcmHandle);
                snd_pcm_prepare(pcmHandle);
                return;
            }

            queuedEndpointFrames += requestedFrames;
            queuedAudioFrames = std::min(bufferFrames, queuedAudioFrames + writtenAudioFrames);
        }

        if (queuedAudioFrames == 0) {
            finishStart(false, "ALSA hw output started without any audio frames to enqueue.");
            snd_pcm_drop(pcmHandle);
            snd_pcm_prepare(pcmHandle);
            return;
        }

        std::string startError;
        if (!startStream(&startError)) {
            finishStart(false, startError);
            snd_pcm_drop(pcmHandle);
            snd_pcm_prepare(pcmHandle);
            return;
        }

        finishStart(true);

        while (true) {
            bool shouldStop = false;
            bool accountProgress = false;
            {
                std::lock_guard<std::mutex> lock(mutex_);
                shouldStop = stopRequested_;
                accountProgress = accountProgressOnStop_;
            }

            if (shouldStop) {
                if (accountProgress) {
                    updatePlaybackProgress();
                }
                break;
            }

            updatePlaybackProgress();

            if (endOfStreamReached) {
                if (queuedAudioFrames == 0 && queuedEndpointFrames == 0) {
                    break;
                }

                const int waitResult = snd_pcm_wait(pcmHandle, kRenderThreadWaitTimeoutMs);
                if (waitResult < 0) {
                    recoverStream(waitResult);
                }
                continue;
            }

            if (!streamStarted) {
                snd_pcm_uframes_t writtenAudioFrames = 0;
                std::string fillError;
                bool streamEnded = false;
                if (!fillAndWriteFrames(periodFrames, &writtenAudioFrames, &streamEnded, &fillError)) {
                    break;
                }

                queuedEndpointFrames = std::min(bufferFrames, queuedEndpointFrames + periodFrames);
                queuedAudioFrames = std::min(bufferFrames, queuedAudioFrames + writtenAudioFrames);
                endOfStreamReached = streamEnded;

                if (!startStream(&fillError)) {
                    break;
                }
                continue;
            }

            const int waitResult = snd_pcm_wait(pcmHandle, kRenderThreadWaitTimeoutMs);
            if (waitResult == 0) {
                continue;
            }
            if (waitResult < 0) {
                if (!recoverStream(waitResult)) {
                    break;
                }
                continue;
            }

            snd_pcm_sframes_t availableFrames = snd_pcm_avail_update(pcmHandle);
            if (availableFrames < 0) {
                if (!recoverStream(static_cast<int>(availableFrames))) {
                    break;
                }
                continue;
            }
            if (availableFrames == 0) {
                continue;
            }

            const snd_pcm_uframes_t requestedFrames = static_cast<snd_pcm_uframes_t>(
                std::min<snd_pcm_sframes_t>(availableFrames, static_cast<snd_pcm_sframes_t>(periodFrames))
            );
            if (requestedFrames == 0) {
                continue;
            }

            snd_pcm_uframes_t writtenAudioFrames = 0;
            std::string fillError;
            bool streamEnded = false;
            if (!fillAndWriteFrames(requestedFrames, &writtenAudioFrames, &streamEnded, &fillError)) {
                break;
            }

            queuedEndpointFrames = std::min(bufferFrames, queuedEndpointFrames + requestedFrames);
            queuedAudioFrames = std::min(bufferFrames, queuedAudioFrames + writtenAudioFrames);
            endOfStreamReached = streamEnded;
        }

        snd_pcm_drop(pcmHandle);
        snd_pcm_prepare(pcmHandle);

        std::lock_guard<std::mutex> lock(mutex_);
        stopRequested_ = false;
        accountProgressOnStop_ = false;
    }

    mutable std::mutex mutex_;
    std::condition_variable startCv_;
    PlaybackEngine* engine_ = nullptr;
    snd_pcm_t* pcmHandle_ = nullptr;
    TrackFormat openFormat_ {};
    bool hasOpenFormat_ = false;
    std::string activeDeviceId_;
    std::string activeDeviceLabel_;
    uint32_t activeDeviceMaxChannels_ = 2;
    snd_pcm_uframes_t periodFrames_ = kPreferredPeriodFrames;
    snd_pcm_uframes_t bufferFrames_ = kPreferredPeriodFrames * kPreferredBufferPeriods;
    std::thread renderThread_;
    bool stopRequested_ = false;
    bool accountProgressOnStop_ = false;
    bool startFinished_ = false;
    bool startSucceeded_ = false;
    std::string startError_;
};

} // namespace

std::unique_ptr<AudioOutputSink> CreatePlatformAudioSink() {
    return std::make_unique<AlsaHwSink>();
}

#endif

} // namespace NativePlayback
