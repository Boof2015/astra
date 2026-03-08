#include "playback_engine.h"

#include <algorithm>
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

class ScopedCoInit final {
public:
    ScopedCoInit() {
        hr_ = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
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
        ComPtr<IMMDevice> resolvedDevice;
        std::string resolvedDeviceId;
        std::string resolvedLabel;
        if (!resolveOutputDevice(deviceId, &resolvedDevice, &resolvedDeviceId, &resolvedLabel, nullptr, error)) {
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
            if (!formatChanged && !deviceChanged && audioClient_ != nullptr && renderClient_ != nullptr) {
                return true;
            }
        }

        close();

        ScopedCoInit coInit;
        if (!coInit.ok()) {
            if (error != nullptr) {
                *error = "Failed to initialize COM for WASAPI exclusive playback (" + formatHRESULT(coInit.hr()) + ").";
            }
            return false;
        }

        WAVEFORMATEXTENSIBLE waveFormat {};
        if (!buildWaveFormat(format, &waveFormat, error)) {
            return false;
        }

        ComPtr<IAudioClient> audioClient;
        HRESULT hr = resolvedDevice->Activate(
            __uuidof(IAudioClient),
            CLSCTX_ALL,
            nullptr,
            reinterpret_cast<void**>(audioClient.GetAddressOf())
        );
        if (FAILED(hr) || audioClient == nullptr) {
            if (error != nullptr) {
                *error = "Failed to activate the selected WASAPI output device (" + formatHRESULT(hr) + ").";
            }
            return false;
        }

        hr = audioClient->IsFormatSupported(
            AUDCLNT_SHAREMODE_EXCLUSIVE,
            reinterpret_cast<WAVEFORMATEX*>(&waveFormat),
            nullptr
        );
        if (hr != S_OK) {
            if (error != nullptr) {
                *error = "The selected WASAPI device does not support "
                    + std::to_string(format.sampleRate)
                    + " Hz "
                    + std::to_string(format.channels)
                    + "-channel "
                    + format.sampleFormatId()
                    + " in exclusive mode ("
                    + formatHRESULT(hr)
                    + ").";
            }
            return false;
        }

        REFERENCE_TIME defaultPeriod = 0;
        REFERENCE_TIME minimumPeriod = 0;
        hr = audioClient->GetDevicePeriod(&defaultPeriod, &minimumPeriod);
        if (FAILED(hr)) {
            if (error != nullptr) {
                *error = "WASAPI could not query the device period (" + formatHRESULT(hr) + ").";
            }
            return false;
        }

        const REFERENCE_TIME exclusivePeriod = minimumPeriod > 0 ? minimumPeriod : defaultPeriod;
        if (exclusivePeriod <= 0) {
            if (error != nullptr) {
                *error = "WASAPI reported an invalid exclusive buffer period.";
            }
            return false;
        }

        HANDLE sampleReadyEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        HANDLE stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (sampleReadyEvent == nullptr || stopEvent == nullptr) {
            if (sampleReadyEvent != nullptr) {
                CloseHandle(sampleReadyEvent);
            }
            if (stopEvent != nullptr) {
                CloseHandle(stopEvent);
            }
            if (error != nullptr) {
                *error = "WASAPI exclusive output could not create synchronization events.";
            }
            return false;
        }

        hr = audioClient->Initialize(
            AUDCLNT_SHAREMODE_EXCLUSIVE,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_NOPERSIST,
            exclusivePeriod,
            exclusivePeriod,
            reinterpret_cast<WAVEFORMATEX*>(&waveFormat),
            nullptr
        );
        if (FAILED(hr)) {
            CloseHandle(sampleReadyEvent);
            CloseHandle(stopEvent);
            if (error != nullptr) {
                *error = "WASAPI exclusive initialization failed (" + formatHRESULT(hr) + ").";
            }
            return false;
        }

        hr = audioClient->SetEventHandle(sampleReadyEvent);
        if (FAILED(hr)) {
            CloseHandle(sampleReadyEvent);
            CloseHandle(stopEvent);
            if (error != nullptr) {
                *error = "WASAPI exclusive output could not register its render event (" + formatHRESULT(hr) + ").";
            }
            return false;
        }

        UINT32 bufferFrameCount = 0;
        hr = audioClient->GetBufferSize(&bufferFrameCount);
        if (FAILED(hr) || bufferFrameCount == 0) {
            CloseHandle(sampleReadyEvent);
            CloseHandle(stopEvent);
            if (error != nullptr) {
                *error = "WASAPI exclusive output reported an invalid endpoint buffer size.";
            }
            return false;
        }

        ComPtr<IAudioRenderClient> renderClient;
        hr = audioClient->GetService(
            __uuidof(IAudioRenderClient),
            reinterpret_cast<void**>(renderClient.GetAddressOf())
        );
        if (FAILED(hr) || renderClient == nullptr) {
            CloseHandle(sampleReadyEvent);
            CloseHandle(stopEvent);
            if (error != nullptr) {
                *error = "WASAPI exclusive output could not open its render client (" + formatHRESULT(hr) + ").";
            }
            return false;
        }

        std::lock_guard<std::mutex> lock(mutex_);
        engine_ = engine;
        activeDevice_ = resolvedDevice;
        audioClient_ = audioClient;
        renderClient_ = renderClient;
        openFormat_ = format;
        hasOpenFormat_ = true;
        activeDeviceId_ = resolvedDeviceId;
        activeDeviceLabel_ = resolvedLabel;
        bufferFrameCount_ = bufferFrameCount;
        sampleReadyEvent_ = sampleReadyEvent;
        stopEvent_ = stopEvent;
        resetQueueStateLocked();
        clientStarted_ = false;
        return true;
    }

    bool start(std::string* error) override {
        stopRenderThread();

        ScopedCoInit coInit;
        if (!coInit.ok()) {
            if (error != nullptr) {
                *error = "Failed to initialize COM for WASAPI playback start (" + formatHRESULT(coInit.hr()) + ").";
            }
            return false;
        }

        std::lock_guard<std::mutex> lock(mutex_);
        if (audioClient_ == nullptr || renderClient_ == nullptr || engine_ == nullptr || bufferFrameCount_ == 0) {
            if (error != nullptr) {
                *error = "WASAPI exclusive output is unavailable.";
            }
            return false;
        }

        HRESULT hr = audioClient_->Stop();
        if (FAILED(hr) && hr != AUDCLNT_E_NOT_STOPPED) {
            if (error != nullptr) {
                *error = "WASAPI exclusive output could not stop before restart (" + formatHRESULT(hr) + ").";
            }
            return false;
        }

        hr = audioClient_->Reset();
        if (FAILED(hr)) {
            if (error != nullptr) {
                *error = "WASAPI exclusive output could not reset before playback (" + formatHRESULT(hr) + ").";
            }
            return false;
        }

        resetQueueStateLocked();
        if (stopEvent_ != nullptr) {
            ResetEvent(stopEvent_);
        }

        BYTE* renderBuffer = nullptr;
        hr = renderClient_->GetBuffer(bufferFrameCount_, &renderBuffer);
        if (FAILED(hr) || renderBuffer == nullptr) {
            if (error != nullptr) {
                *error = "WASAPI exclusive output could not acquire its initial render buffer (" + formatHRESULT(hr) + ").";
            }
            return false;
        }

        bool streamEnded = false;
        const size_t framesWritten = engine_->renderInto(renderBuffer, bufferFrameCount_, streamEnded);
        hr = renderClient_->ReleaseBuffer(static_cast<UINT32>(framesWritten), 0);
        if (FAILED(hr)) {
            if (error != nullptr) {
                *error = "WASAPI exclusive output could not release its initial render buffer (" + formatHRESULT(hr) + ").";
            }
            return false;
        }

        if (framesWritten == 0) {
            if (error != nullptr) {
                *error = "WASAPI exclusive output started without any audio frames to enqueue.";
            }
            return false;
        }

        queuedEndpointFrames_ = static_cast<UINT32>(framesWritten);
        queuedAudioFrames_ = static_cast<UINT32>(framesWritten);
        endOfStreamReached_ = streamEnded;

        hr = audioClient_->Start();
        if (FAILED(hr)) {
            if (error != nullptr) {
                *error = "WASAPI exclusive output failed to start (" + formatHRESULT(hr) + ").";
            }
            return false;
        }

        clientStarted_ = true;
        try {
            renderThread_ = std::thread(&WasapiExclusiveSink::renderLoop, this);
        } catch (const std::exception& threadError) {
            audioClient_->Stop();
            audioClient_->Reset();
            clientStarted_ = false;
            resetQueueStateLocked();
            if (error != nullptr) {
                *error = std::string("WASAPI exclusive output could not start its render thread: ") + threadError.what();
            }
            return false;
        }

        return true;
    }

    void close() override {
        stopRenderThread();

        ScopedCoInit coInit;
        if (coInit.ok()) {
            std::lock_guard<std::mutex> lock(mutex_);
            if (audioClient_ != nullptr) {
                audioClient_->Stop();
                audioClient_->Reset();
            }
        }

        HANDLE sampleReadyEvent = nullptr;
        HANDLE stopEvent = nullptr;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            sampleReadyEvent = sampleReadyEvent_;
            stopEvent = stopEvent_;
            sampleReadyEvent_ = nullptr;
            stopEvent_ = nullptr;
            activeDevice_.Reset();
            renderClient_.Reset();
            audioClient_.Reset();
            activeDeviceId_.clear();
            activeDeviceLabel_.clear();
            bufferFrameCount_ = 0;
            hasOpenFormat_ = false;
            openFormat_ = TrackFormat{};
            engine_ = nullptr;
            clientStarted_ = false;
            resetQueueStateLocked();
        }

        if (sampleReadyEvent != nullptr) {
            CloseHandle(sampleReadyEvent);
        }
        if (stopEvent != nullptr) {
            CloseHandle(stopEvent);
        }
    }

    void pause() override {
        stopRenderThread();

        ScopedCoInit coInit;
        if (!coInit.ok()) {
            return;
        }

        std::lock_guard<std::mutex> lock(mutex_);
        if (audioClient_ == nullptr) {
            return;
        }
        updatePlaybackProgressLocked();
        audioClient_->Stop();
        audioClient_->Reset();
        clientStarted_ = false;
        resetQueueStateLocked();
    }

    void stop() override {
        stopRenderThread();

        ScopedCoInit coInit;
        if (!coInit.ok()) {
            return;
        }

        std::lock_guard<std::mutex> lock(mutex_);
        if (audioClient_ == nullptr) {
            return;
        }
        audioClient_->Stop();
        audioClient_->Reset();
        clientStarted_ = false;
        resetQueueStateLocked();
    }

    void reset() override {
        stop();
    }

    bool isExclusive() const override {
        std::lock_guard<std::mutex> lock(mutex_);
        return audioClient_ != nullptr;
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
    void stopRenderThread() {
        std::thread threadToJoin;
        HANDLE stopEvent = nullptr;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            stopEvent = stopEvent_;
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

    void resetQueueStateLocked() {
        queuedEndpointFrames_ = 0;
        queuedAudioFrames_ = 0;
        endOfStreamReached_ = false;
    }

    void updatePlaybackProgressLocked() {
        if (audioClient_ == nullptr || engine_ == nullptr || queuedEndpointFrames_ == 0) {
            return;
        }

        UINT32 padding = 0;
        const HRESULT hr = audioClient_->GetCurrentPadding(&padding);
        if (FAILED(hr)) {
            return;
        }

        if (padding > queuedEndpointFrames_) {
            queuedEndpointFrames_ = padding;
            return;
        }

        const UINT32 consumedEndpointFrames = queuedEndpointFrames_ - padding;
        queuedEndpointFrames_ = padding;
        if (consumedEndpointFrames == 0) {
            return;
        }

        const UINT32 consumedAudioFrames = std::min(queuedAudioFrames_, consumedEndpointFrames);
        queuedAudioFrames_ -= consumedAudioFrames;
        if (consumedAudioFrames > 0) {
            engine_->onFramesConsumed(consumedAudioFrames);
        }
    }

    void renderLoop() {
        ScopedCoInit coInit;
        HANDLE mmcssHandle = nullptr;
        DWORD taskIndex = 0;
        if (coInit.ok()) {
            mmcssHandle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
            if (mmcssHandle != nullptr) {
                AvSetMmThreadPriority(mmcssHandle, AVRT_PRIORITY_HIGH);
            }
        }

        HANDLE waitHandles[2] = {};
        {
            std::lock_guard<std::mutex> lock(mutex_);
            waitHandles[0] = stopEvent_;
            waitHandles[1] = sampleReadyEvent_;
        }

        bool shouldStopClient = true;
        while (waitHandles[0] != nullptr && waitHandles[1] != nullptr) {
            const DWORD waitResult = WaitForMultipleObjects(2, waitHandles, FALSE, kRenderThreadWaitTimeoutMs);
            if (waitResult == WAIT_OBJECT_0) {
                std::lock_guard<std::mutex> lock(mutex_);
                updatePlaybackProgressLocked();
                break;
            }

            if (waitResult == WAIT_TIMEOUT) {
                std::lock_guard<std::mutex> lock(mutex_);
                updatePlaybackProgressLocked();
                continue;
            }

            if (waitResult != WAIT_OBJECT_0 + 1) {
                break;
            }

            bool playbackDrained = false;
            {
                std::lock_guard<std::mutex> lock(mutex_);
                if (audioClient_ == nullptr || renderClient_ == nullptr || engine_ == nullptr) {
                    break;
                }

                updatePlaybackProgressLocked();

                UINT32 padding = 0;
                HRESULT hr = audioClient_->GetCurrentPadding(&padding);
                if (FAILED(hr)) {
                    break;
                }

                if (endOfStreamReached_) {
                    queuedEndpointFrames_ = padding;
                    if (queuedAudioFrames_ == 0 && padding == 0) {
                        playbackDrained = true;
                    }
                } else {
                    const UINT32 availableFrames = bufferFrameCount_ > padding
                        ? bufferFrameCount_ - padding
                        : 0;

                    if (availableFrames > 0) {
                        BYTE* renderBuffer = nullptr;
                        hr = renderClient_->GetBuffer(availableFrames, &renderBuffer);
                        if (FAILED(hr) || renderBuffer == nullptr) {
                            break;
                        }

                        bool streamEnded = false;
                        const size_t framesWritten = engine_->renderInto(renderBuffer, availableFrames, streamEnded);
                        hr = renderClient_->ReleaseBuffer(static_cast<UINT32>(framesWritten), 0);
                        if (FAILED(hr)) {
                            break;
                        }

                        queuedEndpointFrames_ = padding + static_cast<UINT32>(framesWritten);
                        queuedAudioFrames_ = std::min<UINT32>(
                            bufferFrameCount_,
                            queuedAudioFrames_ + static_cast<UINT32>(framesWritten)
                        );
                        endOfStreamReached_ = streamEnded;

                        if (endOfStreamReached_ && queuedAudioFrames_ == 0 && queuedEndpointFrames_ == 0) {
                            playbackDrained = true;
                        }
                    } else {
                        queuedEndpointFrames_ = padding;
                    }
                }
            }

            if (playbackDrained) {
                break;
            }
        }

        ScopedCoInit cleanupCoInit;
        if (cleanupCoInit.ok()) {
            std::lock_guard<std::mutex> lock(mutex_);
            if (audioClient_ != nullptr && clientStarted_) {
                audioClient_->Stop();
            }
            clientStarted_ = false;
        }

        if (mmcssHandle != nullptr) {
            AvRevertMmThreadCharacteristics(mmcssHandle);
        }
    }

    mutable std::mutex mutex_;
    PlaybackEngine* engine_ = nullptr;
    TrackFormat openFormat_ {};
    bool hasOpenFormat_ = false;

    ComPtr<IMMDevice> activeDevice_;
    ComPtr<IAudioClient> audioClient_;
    ComPtr<IAudioRenderClient> renderClient_;

    std::string activeDeviceId_;
    std::string activeDeviceLabel_;
    UINT32 bufferFrameCount_ = 0;
    HANDLE sampleReadyEvent_ = nullptr;
    HANDLE stopEvent_ = nullptr;
    std::thread renderThread_;
    bool clientStarted_ = false;

    UINT32 queuedEndpointFrames_ = 0;
    UINT32 queuedAudioFrames_ = 0;
    bool endOfStreamReached_ = false;
};

} // namespace

std::unique_ptr<AudioOutputSink> CreatePlatformAudioSink() {
    return std::make_unique<WasapiExclusiveSink>();
}

#endif

} // namespace NativePlayback
