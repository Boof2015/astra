#include "playback_engine.h"

#include <algorithm>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <exception>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <Audioclient.h>
#include <Mmdeviceapi.h>
#include <Functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#include <ks.h>
#include <ksmedia.h>
#include <propidl.h>
#include <wrl/client.h>
#endif

namespace NativePlayback {

#if defined(_WIN32)

namespace {

using Microsoft::WRL::ComPtr;

constexpr DWORD kRenderThreadWaitTimeoutMs = 2000;
constexpr REFERENCE_TIME kReferenceTimesPerSecond = 10000000;
constexpr REFERENCE_TIME kReferenceTimesPerMillisecond = 10000;
constexpr REFERENCE_TIME kMinimumStableExclusivePeriod = 10 * kReferenceTimesPerMillisecond;

class ScopedCoInit final {
public:
    explicit ScopedCoInit(DWORD coinitFlags = COINIT_MULTITHREADED) {
        hr_ = CoInitializeEx(nullptr, coinitFlags);
        initialized_ = SUCCEEDED(hr_);
    }

    ~ScopedCoInit() {
        if (initialized_) {
            CoUninitialize();
        }
    }

    bool ok() const {
        return SUCCEEDED(hr_) || hr_ == RPC_E_CHANGED_MODE;
    }

    HRESULT hr() const {
        return hr_;
    }

private:
    HRESULT hr_ = S_OK;
    bool initialized_ = false;
};

std::string formatHRESULT(HRESULT hr) {
    char buffer[32];
    std::snprintf(buffer, sizeof(buffer), "0x%08lx", static_cast<unsigned long>(hr));
    return std::string(buffer);
}

std::string wideToUtf8(const wchar_t* value) {
    if (value == nullptr || *value == L'\0') {
        return {};
    }

    const int required = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
    if (required <= 1) {
        return {};
    }

    std::string result(static_cast<size_t>(required), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value, -1, result.data(), required, nullptr, nullptr);
    result.pop_back();
    return result;
}

std::wstring utf8ToWide(const std::string& value) {
    if (value.empty()) {
        return {};
    }

    const int required = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
    if (required <= 1) {
        return {};
    }

    std::wstring result(static_cast<size_t>(required), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, result.data(), required);
    result.pop_back();
    return result;
}

ComPtr<IMMDeviceEnumerator> createDeviceEnumerator() {
    ComPtr<IMMDeviceEnumerator> enumerator;
    const HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator),
        nullptr,
        CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator),
        reinterpret_cast<void**>(enumerator.GetAddressOf())
    );
    if (FAILED(hr)) {
        return {};
    }
    return enumerator;
}

bool getDeviceIdString(IMMDevice* device, std::string* outId) {
    if (device == nullptr || outId == nullptr) {
        return false;
    }

    LPWSTR deviceId = nullptr;
    const HRESULT hr = device->GetId(&deviceId);
    if (FAILED(hr) || deviceId == nullptr) {
        return false;
    }

    *outId = wideToUtf8(deviceId);
    CoTaskMemFree(deviceId);
    return !outId->empty();
}

bool getDeviceFriendlyName(IMMDevice* device, std::string* outLabel) {
    if (device == nullptr || outLabel == nullptr) {
        return false;
    }

    ComPtr<IPropertyStore> propertyStore;
    const HRESULT hr = device->OpenPropertyStore(STGM_READ, propertyStore.GetAddressOf());
    if (FAILED(hr) || propertyStore == nullptr) {
        return false;
    }

    PROPVARIANT variant;
    PropVariantInit(&variant);
    const HRESULT propertyHr = propertyStore->GetValue(PKEY_Device_FriendlyName, &variant);
    if (FAILED(propertyHr)) {
        PropVariantClear(&variant);
        return false;
    }

    if (variant.vt == VT_LPWSTR && variant.pwszVal != nullptr) {
        *outLabel = wideToUtf8(variant.pwszVal);
    }
    PropVariantClear(&variant);
    return !outLabel->empty();
}

uint32_t getDeviceMaxChannels(IMMDevice* device) {
    if (device == nullptr) {
        return 2;
    }

    ComPtr<IAudioClient> audioClient;
    HRESULT hr = device->Activate(
        __uuidof(IAudioClient),
        CLSCTX_ALL,
        nullptr,
        reinterpret_cast<void**>(audioClient.GetAddressOf())
    );
    if (FAILED(hr) || audioClient == nullptr) {
        return 2;
    }

    WAVEFORMATEX* mixFormat = nullptr;
    hr = audioClient->GetMixFormat(&mixFormat);
    if (FAILED(hr) || mixFormat == nullptr) {
        return 2;
    }

    const uint32_t channels = std::max<uint32_t>(1, mixFormat->nChannels);
    CoTaskMemFree(mixFormat);
    return channels;
}

DWORD buildChannelMask(uint32_t channels) {
    switch (channels) {
        case 1:
            return KSAUDIO_SPEAKER_MONO;
        case 2:
            return KSAUDIO_SPEAKER_STEREO;
        case 3:
            return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER;
        case 4:
            return KSAUDIO_SPEAKER_QUAD;
        case 5:
            return KSAUDIO_SPEAKER_QUAD | SPEAKER_FRONT_CENTER;
        case 6:
            return KSAUDIO_SPEAKER_5POINT1;
        case 7:
            return KSAUDIO_SPEAKER_5POINT1 | SPEAKER_BACK_CENTER;
        case 8:
            return KSAUDIO_SPEAKER_7POINT1;
        default:
            return 0;
    }
}

bool buildWaveFormat(const TrackFormat& format, WAVEFORMATEXTENSIBLE* outFormat, std::string* error) {
    if (outFormat == nullptr) {
        if (error != nullptr) {
            *error = "WASAPI exclusive output could not build a native format description.";
        }
        return false;
    }
    if (format.sampleRate == 0 || format.channels == 0) {
        if (error != nullptr) {
            *error = "WASAPI exclusive output requires a valid track sample rate and channel count.";
        }
        return false;
    }

    std::memset(outFormat, 0, sizeof(WAVEFORMATEXTENSIBLE));
    outFormat->Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    outFormat->Format.nChannels = static_cast<WORD>(format.channels);
    outFormat->Format.nSamplesPerSec = format.sampleRate;
    outFormat->Format.wBitsPerSample = static_cast<WORD>(format.bytesPerSample() * 8);
    outFormat->Format.nBlockAlign = static_cast<WORD>(format.bytesPerFrame());
    outFormat->Format.nAvgBytesPerSec = format.sampleRate * format.bytesPerFrame();
    outFormat->Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    outFormat->Samples.wValidBitsPerSample = outFormat->Format.wBitsPerSample;
    outFormat->dwChannelMask = buildChannelMask(format.channels);
    outFormat->SubFormat = format.sampleFormat == SampleFormat::Float32
        ? KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
        : KSDATAFORMAT_SUBTYPE_PCM;

    return true;
}

std::vector<OutputDeviceInfo> enumerateWasapiDevices(std::string* reason) {
    ScopedCoInit coInit;
    if (!coInit.ok()) {
        if (reason != nullptr) {
            *reason = "Failed to initialize COM for WASAPI device enumeration (" + formatHRESULT(coInit.hr()) + ").";
        }
        return {};
    }

    ComPtr<IMMDeviceEnumerator> enumerator = createDeviceEnumerator();
    if (enumerator == nullptr) {
        if (reason != nullptr) {
            *reason = "Failed to create the WASAPI device enumerator.";
        }
        return {};
    }

    ComPtr<IMMDevice> defaultDevice;
    std::string defaultDeviceId;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, defaultDevice.GetAddressOf()))) {
        getDeviceIdString(defaultDevice.Get(), &defaultDeviceId);
    }

    ComPtr<IMMDeviceCollection> deviceCollection;
    const HRESULT collectionHr = enumerator->EnumAudioEndpoints(
        eRender,
        DEVICE_STATE_ACTIVE,
        deviceCollection.GetAddressOf()
    );
    if (FAILED(collectionHr) || deviceCollection == nullptr) {
        if (reason != nullptr) {
            *reason = "WASAPI could not enumerate active output devices (" + formatHRESULT(collectionHr) + ").";
        }
        return {};
    }

    UINT count = 0;
    deviceCollection->GetCount(&count);

    std::vector<OutputDeviceInfo> devices;
    devices.reserve(count);
    for (UINT index = 0; index < count; index++) {
        ComPtr<IMMDevice> device;
        if (FAILED(deviceCollection->Item(index, device.GetAddressOf())) || device == nullptr) {
            continue;
        }

        std::string deviceId;
        if (!getDeviceIdString(device.Get(), &deviceId)) {
            continue;
        }

        std::string label;
        if (!getDeviceFriendlyName(device.Get(), &label)) {
            label = deviceId;
        }

        devices.push_back({
            deviceId,
            label,
            getDeviceMaxChannels(device.Get()),
            deviceId == defaultDeviceId
        });
    }

    if (reason != nullptr) {
        reason->clear();
    }
    return devices;
}

bool resolveOutputDevice(
    const std::string& requestedDeviceId,
    ComPtr<IMMDevice>* outDevice,
    std::string* resolvedDeviceId,
    std::string* resolvedLabel,
    uint32_t* maxChannels,
    std::string* error
) {
    if (outDevice == nullptr) {
        if (error != nullptr) {
            *error = "WASAPI exclusive output could not store the selected device.";
        }
        return false;
    }

    ScopedCoInit coInit;
    if (!coInit.ok()) {
        if (error != nullptr) {
            *error = "Failed to initialize COM for WASAPI device access (" + formatHRESULT(coInit.hr()) + ").";
        }
        return false;
    }

    ComPtr<IMMDeviceEnumerator> enumerator = createDeviceEnumerator();
    if (enumerator == nullptr) {
        if (error != nullptr) {
            *error = "Failed to create the WASAPI device enumerator.";
        }
        return false;
    }

    ComPtr<IMMDevice> device;
    HRESULT hr = S_OK;
    if (requestedDeviceId.empty()) {
        hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, device.GetAddressOf());
        if (FAILED(hr) || device == nullptr) {
            if (error != nullptr) {
                *error = "WASAPI could not resolve the default output device (" + formatHRESULT(hr) + ").";
            }
            return false;
        }
    } else {
        const std::wstring deviceIdWide = utf8ToWide(requestedDeviceId);
        if (deviceIdWide.empty()) {
            if (error != nullptr) {
                *error = "The selected WASAPI device id is invalid.";
            }
            return false;
        }

        hr = enumerator->GetDevice(deviceIdWide.c_str(), device.GetAddressOf());
        if (FAILED(hr) || device == nullptr) {
            if (error != nullptr) {
                *error = "WASAPI could not resolve the selected output device (" + formatHRESULT(hr) + ").";
            }
            return false;
        }
    }

    std::string deviceId;
    if (!getDeviceIdString(device.Get(), &deviceId)) {
        if (error != nullptr) {
            *error = "WASAPI could not read the selected device id.";
        }
        return false;
    }

    std::string label;
    if (!getDeviceFriendlyName(device.Get(), &label)) {
        label = deviceId;
    }

    if (resolvedDeviceId != nullptr) {
        *resolvedDeviceId = deviceId;
    }
    if (resolvedLabel != nullptr) {
        *resolvedLabel = label;
    }
    if (maxChannels != nullptr) {
        *maxChannels = getDeviceMaxChannels(device.Get());
    }
    *outDevice = device;
    return true;
}

class WasapiExclusiveSink final : public AudioOutputSink {
public:
    bool supportsBitPerfect() const override {
        return true;
    }

    std::string backendKind() const override {
        return "wasapi-exclusive";
    }

    std::vector<OutputDeviceInfo> enumerateOutputDevices(std::string* reason) const override {
        return enumerateWasapiDevices(reason);
    }

    uint32_t deviceMaxChannels(const std::string& deviceId) const override {
        ComPtr<IMMDevice> device;
        std::string resolvedId;
        std::string label;
        uint32_t maxChannels = 2;
        std::string error;
        if (!resolveOutputDevice(deviceId, &device, &resolvedId, &label, &maxChannels, &error)) {
            return 2;
        }
        return maxChannels;
    }

    bool open(
        const std::string& deviceId,
        const TrackFormat& format,
        PlaybackEngine* engine,
        std::string* error
    ) override {
        std::string resolvedDeviceId;
        std::string resolvedLabel;
        uint32_t maxChannels = 2;
        ComPtr<IMMDevice> resolvedDevice;
        if (!resolveOutputDevice(deviceId, &resolvedDevice, &resolvedDeviceId, &resolvedLabel, &maxChannels, error)) {
            return false;
        }

        {
            std::lock_guard<std::mutex> lock(mutex_);
            const bool formatChanged = !hasOpenFormat_
                || openFormat_.sampleRate != format.sampleRate
                || openFormat_.channels != format.channels
                || openFormat_.sampleFormat != format.sampleFormat;
            const bool deviceChanged = resolvedDeviceId != activeDeviceId_;
            engine_ = engine;
            if (!formatChanged && !deviceChanged && hasOpenFormat_) {
                return true;
            }
        }

        close();
        std::lock_guard<std::mutex> lock(mutex_);
        engine_ = engine;
        openFormat_ = format;
        hasOpenFormat_ = true;
        activeDeviceId_ = resolvedDeviceId;
        activeDeviceLabel_ = resolvedLabel;
        activeDeviceMaxChannels_ = maxChannels;
        if (stopEvent_ == nullptr) {
            stopEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
            if (stopEvent_ == nullptr) {
                hasOpenFormat_ = false;
                if (error != nullptr) {
                    *error = "WASAPI exclusive output could not create its stop event.";
                }
                return false;
            }
        }
        return true;
    }

    bool start(std::string* error) override {
        stopRenderThread(false);

        try {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                if (!hasOpenFormat_ || engine_ == nullptr || stopEvent_ == nullptr) {
                    if (error != nullptr) {
                        *error = "WASAPI exclusive output is unavailable.";
                    }
                    return false;
                }

                ResetEvent(stopEvent_);
                accountProgressOnStop_ = false;
                startFinished_ = false;
                startSucceeded_ = false;
                startError_.clear();
            }

            renderThread_ = std::thread(&WasapiExclusiveSink::renderLoop, this);
        } catch (const std::exception& threadError) {
            if (error != nullptr) {
                *error = std::string("WASAPI exclusive output could not start its render thread: ") + threadError.what();
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
                    ? "WASAPI exclusive output failed to start."
                    : startError;
            }
            return false;
        }

        return true;
    }

    void close() override {
        stopRenderThread(false);

        HANDLE stopEvent = nullptr;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            stopEvent = stopEvent_;
            stopEvent_ = nullptr;
            activeDeviceId_.clear();
            activeDeviceLabel_.clear();
            activeDeviceMaxChannels_ = 2;
            hasOpenFormat_ = false;
            openFormat_ = TrackFormat{};
            engine_ = nullptr;
        }
        if (stopEvent != nullptr) {
            CloseHandle(stopEvent);
        }
    }

    void pause() override {
        stopRenderThread(true);
    }

    void stop() override {
        stopRenderThread(false);
    }

    void reset() override {
        stop();
    }

    bool isExclusive() const override {
        std::lock_guard<std::mutex> lock(mutex_);
        return renderThread_.joinable() || hasOpenFormat_;
    }

    int activeDeviceSampleRate() const override {
        std::lock_guard<std::mutex> lock(mutex_);
        return hasOpenFormat_ ? static_cast<int>(openFormat_.sampleRate) : 0;
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
    void stopRenderThread(bool accountProgress) {
        std::thread threadToJoin;
        HANDLE stopEvent = nullptr;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            stopEvent = stopEvent_;
            accountProgressOnStop_ = accountProgress;
            if (renderThread_.joinable()) {
                threadToJoin = std::move(renderThread_);
            }
        }

        if (stopEvent != nullptr) {
            SetEvent(stopEvent);
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
        ScopedCoInit coInit(COINIT_APARTMENTTHREADED);
        HANDLE mmcssHandle = nullptr;
        DWORD taskIndex = 0;
        if (!coInit.ok()) {
            finishStart(false, "Failed to initialize COM for the WASAPI render thread (" + formatHRESULT(coInit.hr()) + ").");
            return;
        }

        PlaybackEngine* engine = nullptr;
        TrackFormat format {};
        std::string deviceId;
        HANDLE stopEvent = nullptr;
        bool hasOpenFormat = false;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            engine = engine_;
            format = openFormat_;
            deviceId = activeDeviceId_;
            stopEvent = stopEvent_;
            hasOpenFormat = hasOpenFormat_;
        }

        if (engine == nullptr || !hasOpenFormat || stopEvent == nullptr) {
            finishStart(false, "WASAPI exclusive output is unavailable.");
            return;
        }

        ComPtr<IMMDevice> resolvedDevice;
        std::string resolvedDeviceId;
        std::string resolvedLabel;
        if (!resolveOutputDevice(deviceId, &resolvedDevice, &resolvedDeviceId, &resolvedLabel, nullptr, nullptr)) {
            finishStart(false, "WASAPI could not resolve the selected output device on the render thread.");
            return;
        }

        WAVEFORMATEXTENSIBLE waveFormat {};
        std::string waveFormatError;
        if (!buildWaveFormat(format, &waveFormat, &waveFormatError)) {
            finishStart(false, waveFormatError);
            return;
        }

        ComPtr<IAudioClient> audioClient;
        HRESULT hr = resolvedDevice->Activate(
            __uuidof(IAudioClient),
            CLSCTX_ALL,
            nullptr,
            reinterpret_cast<void**>(audioClient.GetAddressOf())
        );
        if (FAILED(hr) || audioClient == nullptr) {
            finishStart(false, "Failed to activate the selected WASAPI output device (" + formatHRESULT(hr) + ").");
            return;
        }

        hr = audioClient->IsFormatSupported(
            AUDCLNT_SHAREMODE_EXCLUSIVE,
            reinterpret_cast<WAVEFORMATEX*>(&waveFormat),
            nullptr
        );
        if (hr != S_OK) {
            finishStart(false,
                "The selected WASAPI device does not support "
                + std::to_string(format.sampleRate)
                + " Hz "
                + std::to_string(format.channels)
                + "-channel "
                + format.sampleFormatId()
                + " in exclusive mode ("
                + formatHRESULT(hr)
                + ")."
            );
            return;
        }

        REFERENCE_TIME defaultPeriod = 0;
        REFERENCE_TIME minimumPeriod = 0;
        hr = audioClient->GetDevicePeriod(&defaultPeriod, &minimumPeriod);
        if (FAILED(hr)) {
            finishStart(false, "WASAPI could not query the device period (" + formatHRESULT(hr) + ").");
            return;
        }

        REFERENCE_TIME targetPeriod = defaultPeriod > 0 ? defaultPeriod : minimumPeriod;
        if (targetPeriod <= 0) {
            finishStart(false, "WASAPI reported an invalid exclusive buffer period.");
            return;
        }
        if (minimumPeriod > 0) {
            targetPeriod = std::max(targetPeriod, minimumPeriod);
        }
        targetPeriod = std::max(targetPeriod, kMinimumStableExclusivePeriod);

        HANDLE sampleReadyEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (sampleReadyEvent == nullptr) {
            finishStart(false, "WASAPI exclusive output could not create its sample-ready event.");
            return;
        }

        auto initializeExclusiveClient = [&](REFERENCE_TIME period) -> HRESULT {
            return audioClient->Initialize(
                AUDCLNT_SHAREMODE_EXCLUSIVE,
                AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_NOPERSIST,
                period,
                period,
                reinterpret_cast<WAVEFORMATEX*>(&waveFormat),
                nullptr
            );
        };

        hr = initializeExclusiveClient(targetPeriod);
        if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
            UINT32 alignedBufferFrames = 0;
            const HRESULT alignedBufferHr = audioClient->GetBufferSize(&alignedBufferFrames);
            if (FAILED(alignedBufferHr) || alignedBufferFrames == 0) {
                CloseHandle(sampleReadyEvent);
                finishStart(false, "WASAPI exclusive output reported an unaligned buffer size but did not return a valid aligned size.");
                return;
            }

            const REFERENCE_TIME alignedPeriod = static_cast<REFERENCE_TIME>(
                (static_cast<uint64_t>(alignedBufferFrames) * kReferenceTimesPerSecond + format.sampleRate - 1)
                / format.sampleRate
            );

            audioClient.Reset();
            hr = resolvedDevice->Activate(
                __uuidof(IAudioClient),
                CLSCTX_ALL,
                nullptr,
                reinterpret_cast<void**>(audioClient.GetAddressOf())
            );
            if (FAILED(hr) || audioClient == nullptr) {
                CloseHandle(sampleReadyEvent);
                finishStart(false, "Failed to reactivate the selected WASAPI output device after buffer alignment (" + formatHRESULT(hr) + ").");
                return;
            }

            hr = initializeExclusiveClient(alignedPeriod);
            targetPeriod = alignedPeriod;
        }

        if (FAILED(hr)) {
            CloseHandle(sampleReadyEvent);
            finishStart(false, "WASAPI exclusive initialization failed (" + formatHRESULT(hr) + ").");
            return;
        }

        hr = audioClient->SetEventHandle(sampleReadyEvent);
        if (FAILED(hr)) {
            CloseHandle(sampleReadyEvent);
            finishStart(false, "WASAPI exclusive output could not register its render event (" + formatHRESULT(hr) + ").");
            return;
        }

        UINT32 bufferFrameCount = 0;
        hr = audioClient->GetBufferSize(&bufferFrameCount);
        if (FAILED(hr) || bufferFrameCount == 0) {
            CloseHandle(sampleReadyEvent);
            finishStart(false, "WASAPI exclusive output reported an invalid endpoint buffer size.");
            return;
        }

        ComPtr<IAudioRenderClient> renderClient;
        hr = audioClient->GetService(
            __uuidof(IAudioRenderClient),
            reinterpret_cast<void**>(renderClient.GetAddressOf())
        );
        if (FAILED(hr) || renderClient == nullptr) {
            CloseHandle(sampleReadyEvent);
            finishStart(false, "WASAPI exclusive output could not open its render client (" + formatHRESULT(hr) + ").");
            return;
        }

        auto updatePlaybackProgress = [&](UINT32& queuedEndpointFrames, UINT32& queuedAudioFrames) {
            if (queuedEndpointFrames == 0) {
                return;
            }

            UINT32 padding = 0;
            const HRESULT paddingHr = audioClient->GetCurrentPadding(&padding);
            if (FAILED(paddingHr)) {
                return;
            }

            if (padding > queuedEndpointFrames) {
                queuedEndpointFrames = padding;
                return;
            }

            const UINT32 consumedEndpointFrames = queuedEndpointFrames - padding;
            queuedEndpointFrames = padding;
            if (consumedEndpointFrames == 0) {
                return;
            }

            const UINT32 consumedAudioFrames = std::min(queuedAudioFrames, consumedEndpointFrames);
            queuedAudioFrames -= consumedAudioFrames;
            if (consumedAudioFrames > 0) {
                engine->onFramesConsumed(consumedAudioFrames);
            }
        };

        auto fillBuffer = [&](UINT32 requestedFrames, UINT32* writtenAudioFrames, bool* reachedEndOfStream, std::string* fillError) -> bool {
            BYTE* renderBuffer = nullptr;
            HRESULT bufferHr = renderClient->GetBuffer(requestedFrames, &renderBuffer);
            if (FAILED(bufferHr) || renderBuffer == nullptr) {
                if (fillError != nullptr) {
                    *fillError = "WASAPI exclusive output could not acquire a render buffer (" + formatHRESULT(bufferHr) + ").";
                }
                return false;
            }

            bool streamEnded = false;
            const size_t framesWritten = engine->renderInto(renderBuffer, requestedFrames, streamEnded);
            const UINT32 bytesPerFrame = format.bytesPerFrame();
            const UINT32 usedFrames = static_cast<UINT32>(std::min<size_t>(framesWritten, requestedFrames));
            if (usedFrames < requestedFrames && bytesPerFrame > 0) {
                const UINT32 usedBytes = usedFrames * bytesPerFrame;
                const UINT32 remainingBytes = (requestedFrames - usedFrames) * bytesPerFrame;
                std::memset(renderBuffer + usedBytes, 0, remainingBytes);
            }

            bufferHr = renderClient->ReleaseBuffer(requestedFrames, 0);
            if (FAILED(bufferHr)) {
                if (fillError != nullptr) {
                    *fillError = "WASAPI exclusive output could not release a render buffer (" + formatHRESULT(bufferHr) + ").";
                }
                return false;
            }

            if (writtenAudioFrames != nullptr) {
                *writtenAudioFrames = usedFrames;
            }
            if (reachedEndOfStream != nullptr) {
                *reachedEndOfStream = streamEnded;
            }
            return true;
        };

        UINT32 queuedEndpointFrames = 0;
        UINT32 queuedAudioFrames = 0;
        bool endOfStreamReached = false;
        std::string fillError;
        UINT32 primedFrames = 0;
        if (!fillBuffer(bufferFrameCount, &primedFrames, &endOfStreamReached, &fillError)) {
            CloseHandle(sampleReadyEvent);
            finishStart(false, fillError);
            return;
        }

        if (primedFrames == 0) {
            CloseHandle(sampleReadyEvent);
            finishStart(false, "WASAPI exclusive output started without any audio frames to enqueue.");
            return;
        }

        queuedEndpointFrames = bufferFrameCount;
        queuedAudioFrames = primedFrames;

        mmcssHandle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
        if (mmcssHandle != nullptr) {
            AvSetMmThreadPriority(mmcssHandle, AVRT_PRIORITY_HIGH);
        }

        hr = audioClient->Start();
        if (FAILED(hr)) {
            CloseHandle(sampleReadyEvent);
            if (mmcssHandle != nullptr) {
                AvRevertMmThreadCharacteristics(mmcssHandle);
            }
            finishStart(false, "WASAPI exclusive output failed to start (" + formatHRESULT(hr) + ").");
            return;
        }

        finishStart(true);

        HANDLE waitHandles[2] = { stopEvent, sampleReadyEvent };
        while (true) {
            const DWORD waitResult = WaitForMultipleObjects(2, waitHandles, FALSE, kRenderThreadWaitTimeoutMs);
            if (waitResult == WAIT_OBJECT_0) {
                bool accountProgress = false;
                {
                    std::lock_guard<std::mutex> lock(mutex_);
                    accountProgress = accountProgressOnStop_;
                    accountProgressOnStop_ = false;
                }
                if (accountProgress) {
                    updatePlaybackProgress(queuedEndpointFrames, queuedAudioFrames);
                }
                break;
            }

            if (waitResult == WAIT_TIMEOUT) {
                updatePlaybackProgress(queuedEndpointFrames, queuedAudioFrames);
                continue;
            }

            if (waitResult != WAIT_OBJECT_0 + 1) {
                break;
            }

            updatePlaybackProgress(queuedEndpointFrames, queuedAudioFrames);

            if (endOfStreamReached) {
                if (queuedAudioFrames == 0 && queuedEndpointFrames == 0) {
                    break;
                }
                continue;
            }

            UINT32 padding = 0;
            hr = audioClient->GetCurrentPadding(&padding);
            if (FAILED(hr)) {
                break;
            }

            const UINT32 availableFrames = bufferFrameCount > padding
                ? bufferFrameCount - padding
                : 0;
            if (availableFrames == 0) {
                queuedEndpointFrames = padding;
                continue;
            }

            UINT32 writtenFrames = 0;
            fillError.clear();
            bool streamEnded = false;
            if (!fillBuffer(availableFrames, &writtenFrames, &streamEnded, &fillError)) {
                break;
            }

            queuedEndpointFrames = padding + availableFrames;
            queuedAudioFrames = std::min<UINT32>(bufferFrameCount, queuedAudioFrames + writtenFrames);
            endOfStreamReached = streamEnded;
        }

        audioClient->Stop();
        audioClient->Reset();
        CloseHandle(sampleReadyEvent);

        if (mmcssHandle != nullptr) {
            AvRevertMmThreadCharacteristics(mmcssHandle);
        }
    }

    mutable std::mutex mutex_;
    std::condition_variable startCv_;
    PlaybackEngine* engine_ = nullptr;
    TrackFormat openFormat_ {};
    bool hasOpenFormat_ = false;

    std::string activeDeviceId_;
    std::string activeDeviceLabel_;
    uint32_t activeDeviceMaxChannels_ = 2;
    HANDLE stopEvent_ = nullptr;
    std::thread renderThread_;
    bool accountProgressOnStop_ = false;
    bool startFinished_ = false;
    bool startSucceeded_ = false;
    std::string startError_;
};

} // namespace

std::unique_ptr<AudioOutputSink> CreatePlatformAudioSink() {
    return std::make_unique<WasapiExclusiveSink>();
}

#endif

} // namespace NativePlayback
