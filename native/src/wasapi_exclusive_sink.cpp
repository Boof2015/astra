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
#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif
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
    if (FAILED(hr)) {
        if (mixFormat != nullptr) {
            CoTaskMemFree(mixFormat);
        }
        return 2;
    }
    if (mixFormat == nullptr) {
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

// One concrete wire format an exclusive endpoint might accept. `sampleFormat` is the PCM
// layout Astra has to hand over; `containerBits`/`validBits` differ for 24-in-32, which is
// a distinct format from plain s32 as far as drivers are concerned.
struct ExclusiveFormatOption {
    uint16_t containerBits;
    uint16_t validBits;
    bool isFloat;
    SampleFormat sampleFormat;
    const char* id;
};

constexpr ExclusiveFormatOption kOptionS16     { 16, 16, false, SampleFormat::Int16,       "s16" };
constexpr ExclusiveFormatOption kOptionS24     { 24, 24, false, SampleFormat::Int24Packed, "s24" };
constexpr ExclusiveFormatOption kOptionS24In32 { 32, 24, false, SampleFormat::Int32,       "s24in32" };
constexpr ExclusiveFormatOption kOptionS32     { 32, 32, false, SampleFormat::Int32,       "s32" };
constexpr ExclusiveFormatOption kOptionF32     { 32, 32, true,  SampleFormat::Float32,     "f32" };

// Every format worth asking a device about, for capability probing.
constexpr ExclusiveFormatOption kProbeOptions[] = {
    kOptionS16, kOptionS24, kOptionS24In32, kOptionS32, kOptionF32
};

constexpr uint32_t kProbeSampleRates[] = {
    44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000
};

void fillWaveFormatExtensible(
    WAVEFORMATEXTENSIBLE* out,
    uint32_t sampleRate,
    uint32_t channels,
    const ExclusiveFormatOption& option
) {
    const WORD blockAlign = static_cast<WORD>((option.containerBits / 8) * channels);
    std::memset(out, 0, sizeof(WAVEFORMATEXTENSIBLE));
    out->Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    out->Format.nChannels = static_cast<WORD>(channels);
    out->Format.nSamplesPerSec = sampleRate;
    out->Format.wBitsPerSample = option.containerBits;
    out->Format.nBlockAlign = blockAlign;
    out->Format.nAvgBytesPerSec = sampleRate * blockAlign;
    out->Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    out->Samples.wValidBitsPerSample = option.validBits;
    out->dwChannelMask = buildChannelMask(channels);
    out->SubFormat = option.isFloat
        ? KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
        : KSDATAFORMAT_SUBTYPE_PCM;
}

// Builds the legacy non-extensible header, but into a WAVEFORMATEXTENSIBLE-sized buffer.
// Drivers have been observed touching the full extensible footprint even when cbSize is 0,
// so WASAPI is never handed a bare 18-byte WAVEFORMATEX object.
void fillWaveFormatPlain(
    WAVEFORMATEXTENSIBLE* out,
    uint32_t sampleRate,
    uint32_t channels,
    const ExclusiveFormatOption& option
) {
    const WORD blockAlign = static_cast<WORD>((option.containerBits / 8) * channels);
    std::memset(out, 0, sizeof(WAVEFORMATEXTENSIBLE));
    out->Format.wFormatTag = option.isFloat ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM;
    out->Format.nChannels = static_cast<WORD>(channels);
    out->Format.nSamplesPerSec = sampleRate;
    out->Format.wBitsPerSample = option.containerBits;
    out->Format.nBlockAlign = blockAlign;
    out->Format.nAvgBytesPerSec = sampleRate * blockAlign;
    out->Format.cbSize = 0;
}

bool isExclusiveFormatAccepted(IAudioClient* audioClient, const WAVEFORMATEX* waveFormat) {
    if (audioClient == nullptr || waveFormat == nullptr) {
        return false;
    }

    // ppClosestMatch must be null in exclusive mode. WASAPI documents it as unused there,
    // and drivers may leave a non-CoTaskMem value in it — freeing that corrupts the heap.
    // The candidate ladder is what finds a working format; there is no suggestion to read.
    const HRESULT hr = audioClient->IsFormatSupported(
        AUDCLNT_SHAREMODE_EXCLUSIVE,
        waveFormat,
        nullptr
    );
    // Exclusive mode answers S_OK or AUDCLNT_E_UNSUPPORTED_FORMAT; S_FALSE is shared-mode only.
    return hr == S_OK;
}

// Formats Astra can feed a device without altering a single sample. Widening a container is
// bit-exact zero padding; narrowing it is not, so the ladder only ever grows.
std::vector<ExclusiveFormatOption> buildFormatLadder(SampleFormat sourceFormat) {
    switch (sourceFormat) {
        case SampleFormat::Int16:
            return { kOptionS16, kOptionS24, kOptionS24In32, kOptionS32 };
        case SampleFormat::Int24Packed:
            return { kOptionS24, kOptionS24In32, kOptionS32 };
        case SampleFormat::Int32:
            return { kOptionS32 };
        case SampleFormat::Float32:
        default:
            return { kOptionF32 };
    }
}

struct NegotiatedExclusiveFormat {
    WAVEFORMATEXTENSIBLE extensible {};
    WAVEFORMATEXTENSIBLE plain {};
    bool useExtensible = true;
    ExclusiveFormatOption option = kOptionF32;
    uint32_t bytesPerFrame = 0;
    bool needsConversion = false;
    bool probeAccepted = false;

    WAVEFORMATEX* waveFormat() {
        return reinterpret_cast<WAVEFORMATEX*>(useExtensible ? &extensible : &plain);
    }
};

std::vector<NegotiatedExclusiveFormat> buildNegotiatedFormatCandidates(
    IAudioClient* probeClient,
    const TrackFormat& track
);

std::string symbolicHRESULT(HRESULT hr) {
    switch (hr) {
        case S_OK: return "S_OK";
        case AUDCLNT_E_DEVICE_IN_USE: return "AUDCLNT_E_DEVICE_IN_USE";
        case AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED: return "AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED";
        case AUDCLNT_E_UNSUPPORTED_FORMAT: return "AUDCLNT_E_UNSUPPORTED_FORMAT";
        case AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED: return "AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED";
        case AUDCLNT_E_DEVICE_INVALIDATED: return "AUDCLNT_E_DEVICE_INVALIDATED";
        case AUDCLNT_E_SERVICE_NOT_RUNNING: return "AUDCLNT_E_SERVICE_NOT_RUNNING";
        default: return formatHRESULT(hr);
    }
}

// Left-justify each sample into a wider container, zero-filling the new low bits. This is
// bit-exact: the original sample is recoverable by shifting back down.
void widenSampleBlock(
    const uint8_t* source,
    SampleFormat sourceFormat,
    uint8_t* destination,
    uint16_t destinationContainerBits,
    size_t sampleCount
) {
    const int sourceBits = sourceFormat == SampleFormat::Int16
        ? 16
        : (sourceFormat == SampleFormat::Int24Packed ? 24 : 32);
    if (WidenIntegerSamplesLeftJustified(
            source, sourceBits, destination, destinationContainerBits, sampleCount)) return;

    // Same width: straight copy.
    const size_t bytesPerSample = destinationContainerBits / 8;
    std::memcpy(destination, source, sampleCount * bytesPerSample);
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
    bool isAvailable() const override {
        return true;
    }

    std::string backendKind() const override {
        return "wasapi-exclusive";
    }

    std::vector<OutputDeviceInfo> enumerateOutputDevices(std::string* reason) const override {
        return enumerateWasapiDevices(reason);
    }

    uint32_t deviceMaxChannels(const std::string& deviceId) const override {
        // resolveOutputDevice scopes its own COM init, so without an outer one the returned
        // IMMDevice would be released after CoUninitialize has already torn the apartment
        // down. That is undefined behavior and corrupts the heap intermittently.
        ScopedCoInit coInit;
        if (!coInit.ok()) {
            return 2;
        }

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

    DeviceFormatProbe probeDeviceFormats(const std::string& deviceId, uint32_t channels) const override {
        DeviceFormatProbe probe;

        ScopedCoInit coInit;
        if (!coInit.ok()) {
            probe.reason = "Failed to initialize COM for WASAPI format probing ("
                + formatHRESULT(coInit.hr()) + ").";
            return probe;
        }

        ComPtr<IMMDevice> device;
        std::string resolvedId;
        std::string label;
        if (!resolveOutputDevice(deviceId, &device, &resolvedId, &label, nullptr, &probe.reason)) {
            return probe;
        }

        probe.deviceId = resolvedId;
        probe.deviceLabel = label;

        ComPtr<IAudioClient> audioClient;
        const HRESULT hr = device->Activate(
            __uuidof(IAudioClient),
            CLSCTX_ALL,
            nullptr,
            reinterpret_cast<void**>(audioClient.GetAddressOf())
        );
        if (FAILED(hr) || audioClient == nullptr) {
            probe.reason = "Failed to activate the WASAPI device for format probing ("
                + formatHRESULT(hr) + ").";
            return probe;
        }

        for (const uint32_t sampleRate : kProbeSampleRates) {
            for (const ExclusiveFormatOption& option : kProbeOptions) {
                WAVEFORMATEXTENSIBLE candidate {};
                fillWaveFormatExtensible(&candidate, sampleRate, channels, option);
                bool accepted = isExclusiveFormatAccepted(
                    audioClient.Get(), reinterpret_cast<WAVEFORMATEX*>(&candidate));
                if (!accepted && option.containerBits == option.validBits) {
                    WAVEFORMATEXTENSIBLE plainCandidate {};
                    fillWaveFormatPlain(&plainCandidate, sampleRate, channels, option);
                    accepted = isExclusiveFormatAccepted(
                        audioClient.Get(), reinterpret_cast<WAVEFORMATEX*>(&plainCandidate));
                }
                if (accepted) {
                    probe.formats.push_back({ sampleRate, channels, option.id });
                }
            }
        }

        probe.supported = true;
        if (probe.formats.empty()) {
            probe.reason = "The device rejected every exclusive-mode format Astra can produce.";
        }
        return probe;
    }

    bool open(
        const std::string& deviceId,
        const TrackFormat& format,
        PlaybackEngine* engine,
        std::string* error
    ) override {
        auto recordOpenFailure = [&format, this](
            const std::string& failedDeviceId,
            const std::string& failedDeviceLabel,
            const std::string& stage,
            HRESULT osCode,
            const std::string& summary,
            bool deviceResolved
        ) {
            std::lock_guard<std::mutex> lock(mutex_);
            status_ = NativeOutputStatus {};
            status_.backend = backendKind();
            status_.deviceId = failedDeviceId;
            status_.deviceLabel = failedDeviceLabel;
            status_.exclusiveRequested = true;
            status_.deviceResolved = deviceResolved;
            status_.sourceFormat = DescribeTrackFormat(format);
            status_.processingFormat = status_.sourceFormat;
            status_.failureStage = stage;
            status_.osErrorCode = static_cast<int64_t>(osCode);
            status_.osErrorSymbol = symbolicHRESULT(osCode);
            status_.failureSummary = summary;
            NativeOutputAttempt attempt;
            attempt.index = 1;
            attempt.backend = status_.backend;
            attempt.deviceId = failedDeviceId;
            attempt.deviceLabel = failedDeviceLabel;
            attempt.sourceFormat = status_.sourceFormat;
            attempt.processingFormat = status_.processingFormat;
            attempt.transport = "not started";
            attempt.probeResult = "not reached";
            attempt.deviceResolved = deviceResolved;
            attempt.failureStage = stage;
            attempt.osErrorCode = static_cast<int64_t>(osCode);
            attempt.osErrorSymbol = status_.osErrorSymbol;
            attempt.message = summary;
            status_.attempts = {std::move(attempt)};
            RecomputeBitPerfectActive(status_);
        };

        // Keep a COM apartment alive for the whole call so the device and client pointers
        // below stay valid past resolveOutputDevice's own scoped init.
        ScopedCoInit coInit;
        if (!coInit.ok()) {
            const std::string summary = "Failed to initialize COM for WASAPI device access ("
                + formatHRESULT(coInit.hr()) + ").";
            if (error != nullptr) *error = summary;
            recordOpenFailure(deviceId, deviceId, "device-resolution", coInit.hr(), summary, false);
            return false;
        }

        std::string resolvedDeviceId;
        std::string resolvedLabel;
        uint32_t maxChannels = 2;
        ComPtr<IMMDevice> resolvedDevice;
        if (!resolveOutputDevice(deviceId, &resolvedDevice, &resolvedDeviceId, &resolvedLabel, &maxChannels, error)) {
            const std::string summary = error != nullptr && !error->empty()
                ? *error
                : "WASAPI could not resolve the selected output device.";
            recordOpenFailure(deviceId, deviceId, "device-resolution", E_FAIL, summary, false);
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
        HANDLE newStopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (newStopEvent == nullptr) {
            const HRESULT eventError = HRESULT_FROM_WIN32(GetLastError());
            const std::string summary = "WASAPI exclusive output could not create its stop event.";
            if (error != nullptr) *error = summary;
            recordOpenFailure(resolvedDeviceId, resolvedLabel, "initialization", eventError, summary, true);
            return false;
        }
        std::lock_guard<std::mutex> lock(mutex_);
        engine_ = engine;
        openFormat_ = format;
        hasOpenFormat_ = true;
        activeDeviceId_ = resolvedDeviceId;
        activeDeviceLabel_ = resolvedLabel;
        activeDeviceMaxChannels_ = maxChannels;
        status_.outputOpen = true;
        status_.deviceResolved = true;
        status_.exclusiveRequested = true;
        status_.backend = backendKind();
        status_.deviceId = resolvedDeviceId;
        status_.deviceLabel = resolvedLabel;
        status_.sourceFormat = DescribeTrackFormat(format);
        status_.processingFormat = status_.sourceFormat;
        status_.sourceSamplesModified = false;
        status_.failureStage.clear();
        status_.osErrorSymbol.clear();
        status_.osErrorCode = 0;
        status_.failureSummary.clear();
        stopEvent_ = newStopEvent;
        RecomputeBitPerfectActive(status_);
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
        if (stopEvent != nullptr) {
            CloseHandle(stopEvent);
        }
    }

    void pause() override {
        stopRenderThread(true);
        std::lock_guard<std::mutex> lock(mutex_);
        status_.streamStarted = false;
        status_.streamRunning = false;
        status_.streamInitialized = false;
        status_.exclusiveAcquired = false;
        status_.systemMixerBypassed = false;
        RecomputeBitPerfectActive(status_);
    }

    void stop() override {
        stopRenderThread(false);
        std::lock_guard<std::mutex> lock(mutex_);
        status_.streamStarted = false;
        status_.streamRunning = false;
        status_.streamInitialized = false;
        status_.exclusiveAcquired = false;
        status_.systemMixerBypassed = false;
        RecomputeBitPerfectActive(status_);
    }

    void reset() override {
        stop();
    }

    NativeOutputStatus outputStatus() const override {
        std::lock_guard<std::mutex> lock(mutex_);
        NativeOutputStatus copy = status_;
        RecomputeBitPerfectActive(copy);
        return copy;
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
        if (!success) {
            status_.streamRunning = false;
            status_.streamStarted = false;
            status_.exclusiveAcquired = false;
            status_.systemMixerBypassed = false;
            if (status_.failureStage.empty()) status_.failureStage = "initialization";
            status_.failureSummary = startError_;
            if (!status_.attempts.empty()) {
                auto& attempt = status_.attempts.back();
                if (attempt.failureStage.empty()) attempt.failureStage = status_.failureStage;
                attempt.message = startError_;
            }
        }
        RecomputeBitPerfectActive(status_);
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
            {
                std::lock_guard<std::mutex> lock(mutex_);
                status_.failureStage = "device-resolution";
                status_.osErrorSymbol = "DEVICE_NOT_FOUND";
            }
            finishStart(false, "WASAPI could not resolve the selected output device on the render thread.");
            return;
        }

        {
            std::lock_guard<std::mutex> lock(mutex_);
            status_.deviceResolved = true;
            status_.attempts.clear();
        }

        if (format.sampleRate == 0 || format.channels == 0) {
            finishStart(false, "WASAPI exclusive output requires a valid track sample rate and channel count.");
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
            {
                std::lock_guard<std::mutex> lock(mutex_);
                status_.failureStage = "initialization";
                status_.osErrorCode = static_cast<int64_t>(hr);
                status_.osErrorSymbol = symbolicHRESULT(hr);
                NativeOutputAttempt attempt;
                attempt.index = 1;
                attempt.backend = backendKind();
                attempt.deviceId = resolvedDeviceId;
                attempt.deviceLabel = resolvedLabel;
                attempt.sourceFormat = DescribeTrackFormat(format);
                attempt.processingFormat = attempt.sourceFormat;
                attempt.deviceResolved = true;
                attempt.failureStage = status_.failureStage;
                attempt.osErrorCode = status_.osErrorCode;
                attempt.osErrorSymbol = status_.osErrorSymbol;
                attempt.message = "IAudioClient activation failed.";
                status_.attempts.push_back(std::move(attempt));
            }
            finishStart(false, "Failed to activate the selected WASAPI output device (" + formatHRESULT(hr) + ").");
            return;
        }

        const std::vector<NegotiatedExclusiveFormat> negotiatedCandidates =
            buildNegotiatedFormatCandidates(audioClient.Get(), format);
        if (negotiatedCandidates.empty()) {
            finishStart(false, "WASAPI has no exact-carry format candidates for this decoded PCM stream.");
            return;
        }
        NegotiatedExclusiveFormat negotiated;
        // Set when the device took a wider container than the decoded PCM; the render path
        // then stages track-format frames here and left-justifies them on copy-out.
        std::vector<uint8_t> conversionBuffer;

        REFERENCE_TIME defaultPeriod = 0;
        REFERENCE_TIME minimumPeriod = 0;
        hr = audioClient->GetDevicePeriod(&defaultPeriod, &minimumPeriod);
        if (FAILED(hr)) {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                status_.failureStage = "period";
                status_.osErrorCode = static_cast<int64_t>(hr);
                status_.osErrorSymbol = symbolicHRESULT(hr);
            }
            finishStart(false, "WASAPI could not query the device period (" + formatHRESULT(hr) + ").");
            return;
        }

        if (defaultPeriod <= 0 && minimumPeriod <= 0) {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                status_.failureStage = "period";
                status_.osErrorSymbol = "INVALID_DEVICE_PERIOD";
            }
            finishStart(false, "WASAPI reported an invalid exclusive buffer period.");
            return;
        }

        std::vector<REFERENCE_TIME> preferredPeriods;
        auto appendPeriod = [&](REFERENCE_TIME period) {
            if (period > 0 && std::find(preferredPeriods.begin(), preferredPeriods.end(), period) == preferredPeriods.end()) {
                preferredPeriods.push_back(period);
            }
        };
        appendPeriod(defaultPeriod);
        appendPeriod(minimumPeriod);
        const REFERENCE_TIME conservativePeriod = std::max(
            kMinimumStableExclusivePeriod,
            std::max(defaultPeriod, minimumPeriod));

        REFERENCE_TIME targetPeriod = 0;
        bool eventDriven = true;

        HANDLE sampleReadyEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (sampleReadyEvent == nullptr) {
            finishStart(false, "WASAPI exclusive output could not create its sample-ready event.");
            return;
        }

        bool initialized = false;
        int attemptIndex = 0;
        const std::vector<int64_t> plannedPeriods(preferredPeriods.begin(), preferredPeriods.end());
        const auto attemptPlan = BuildExclusiveAttemptPlan(
            negotiatedCandidates.size(), plannedPeriods, conservativePeriod);
        for (const auto& plannedAttempt : attemptPlan) {
                eventDriven = plannedAttempt.transport == "event-driven";
                NegotiatedExclusiveFormat formatCandidate = negotiatedCandidates[plannedAttempt.formatCandidateIndex];
                const REFERENCE_TIME requestedPeriod = static_cast<REFERENCE_TIME>(plannedAttempt.requestedPeriod);
                NativeOutputAttempt attempt;
                attempt.index = ++attemptIndex;
                attempt.backend = backendKind();
                attempt.deviceId = resolvedDeviceId;
                attempt.deviceLabel = resolvedLabel;
                attempt.sourceFormat = DescribeTrackFormat(format);
                attempt.processingFormat = attempt.sourceFormat;
                attempt.wireFormat = DescribeTrackFormat(format);
                attempt.wireFormat.sampleFormat = formatCandidate.option.id;
                attempt.wireFormat.containerBits = formatCandidate.option.containerBits;
                attempt.wireFormat.validBits = formatCandidate.option.validBits;
                attempt.wireFormat.channelMask = buildChannelMask(format.channels);
                attempt.wireFormat.representation = formatCandidate.useExtensible
                    ? "WAVEFORMATEXTENSIBLE/interleaved"
                    : "WAVEFORMATEX/interleaved";
                attempt.transport = eventDriven ? "event-driven" : "timer-driven";
                attempt.probeResult = formatCandidate.probeAccepted ? "accepted" : "rejected (advisory)";
                attempt.requestedPeriodMs = static_cast<double>(requestedPeriod) / kReferenceTimesPerMillisecond;
                attempt.deviceResolved = true;
                attempt.formatNegotiated = true;

                audioClient.Reset();
                hr = resolvedDevice->Activate(
                    __uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                    reinterpret_cast<void**>(audioClient.GetAddressOf()));
                if (SUCCEEDED(hr) && audioClient != nullptr) {
                    const DWORD flags = AUDCLNT_STREAMFLAGS_NOPERSIST
                        | (eventDriven ? AUDCLNT_STREAMFLAGS_EVENTCALLBACK : 0);
                    hr = audioClient->Initialize(
                        AUDCLNT_SHAREMODE_EXCLUSIVE, flags,
                        requestedPeriod, requestedPeriod, formatCandidate.waveFormat(), nullptr);
                }

                if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED && audioClient != nullptr) {
                    UINT32 alignedBufferFrames = 0;
                    if (SUCCEEDED(audioClient->GetBufferSize(&alignedBufferFrames)) && alignedBufferFrames > 0) {
                        const REFERENCE_TIME alignedPeriod = static_cast<REFERENCE_TIME>(
                            ComputeAlignedExclusivePeriod(
                                alignedBufferFrames, format.sampleRate, kReferenceTimesPerSecond));
                        attempt.alignedPeriodMs = static_cast<double>(alignedPeriod) / kReferenceTimesPerMillisecond;
                        audioClient.Reset();
                        hr = resolvedDevice->Activate(
                            __uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                            reinterpret_cast<void**>(audioClient.GetAddressOf()));
                        if (SUCCEEDED(hr) && audioClient != nullptr) {
                            const DWORD flags = AUDCLNT_STREAMFLAGS_NOPERSIST
                                | (eventDriven ? AUDCLNT_STREAMFLAGS_EVENTCALLBACK : 0);
                            hr = audioClient->Initialize(
                                AUDCLNT_SHAREMODE_EXCLUSIVE, flags,
                                alignedPeriod, alignedPeriod, formatCandidate.waveFormat(), nullptr);
                            if (SUCCEEDED(hr)) targetPeriod = alignedPeriod;
                        }
                    }
                }

                if (SUCCEEDED(hr) && audioClient != nullptr) {
                    targetPeriod = targetPeriod > 0 ? targetPeriod : requestedPeriod;
                    attempt.streamInitialized = true;
                    initialized = true;
                    negotiated = formatCandidate;
                } else {
                    attempt.failureStage = "initialization";
                    attempt.osErrorCode = static_cast<int64_t>(hr);
                    attempt.osErrorSymbol = symbolicHRESULT(hr);
                    attempt.message = "IAudioClient::Initialize rejected this exact exclusive attempt.";
                }
                {
                    std::lock_guard<std::mutex> lock(mutex_);
                    status_.attempts.push_back(std::move(attempt));
                }
                if (initialized) break;
                targetPeriod = 0;
        }

        if (!initialized) {
            CloseHandle(sampleReadyEvent);
            finishStart(false, "WASAPI exclusive initialization failed (" + formatHRESULT(hr) + ").");
            return;
        }
        {
            std::lock_guard<std::mutex> lock(mutex_);
            NativePcmFormat wire = DescribeTrackFormat(format);
            wire.sampleFormat = negotiated.option.id;
            wire.containerBits = negotiated.option.containerBits;
            wire.validBits = negotiated.option.validBits;
            wire.channelMask = buildChannelMask(format.channels);
            wire.representation = negotiated.useExtensible
                ? "WAVEFORMATEXTENSIBLE/interleaved"
                : "WAVEFORMATEX/interleaved";
            status_.formatNegotiated = true;
            status_.wireFormatCanCarrySourceExactly = true;
            status_.wireFormat = wire;
        }

        {
            std::lock_guard<std::mutex> lock(mutex_);
            status_.streamInitialized = true;
            status_.exclusiveAcquired = true;
            status_.systemMixerBypassed = true;
            status_.transport = eventDriven ? "event-driven" : "timer-driven";
            status_.requestedPeriodMs = static_cast<double>(targetPeriod) / kReferenceTimesPerMillisecond;
            status_.requestedPeriodFrames = static_cast<int>((static_cast<uint64_t>(targetPeriod) * format.sampleRate) / kReferenceTimesPerSecond);
            status_.attempts.back().transport = status_.transport;
            status_.attempts.back().requestedPeriodMs = status_.requestedPeriodMs;
            status_.attempts.back().streamInitialized = true;
        }

        hr = eventDriven ? audioClient->SetEventHandle(sampleReadyEvent) : S_OK;
        if (FAILED(hr)) {
            CloseHandle(sampleReadyEvent);
            finishStart(false, "WASAPI exclusive output could not register its render event (" + formatHRESULT(hr) + ").");
            return;
        }
        if (!eventDriven) {
            CloseHandle(sampleReadyEvent);
            sampleReadyEvent = CreateWaitableTimerExW(
                nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
            if (sampleReadyEvent == nullptr) {
                sampleReadyEvent = CreateWaitableTimerW(nullptr, FALSE, nullptr);
            }
            const LONG intervalMs = static_cast<LONG>(std::max<REFERENCE_TIME>(
                1, targetPeriod / (2 * kReferenceTimesPerMillisecond)));
            LARGE_INTEGER firstDueTime {};
            firstDueTime.QuadPart = -static_cast<LONGLONG>(intervalMs) * kReferenceTimesPerMillisecond;
            if (sampleReadyEvent == nullptr
                || !SetWaitableTimer(sampleReadyEvent, &firstDueTime, intervalMs, nullptr, nullptr, FALSE)) {
                if (sampleReadyEvent != nullptr) CloseHandle(sampleReadyEvent);
                finishStart(false, "WASAPI timer-driven output could not create its high-resolution wait timer.");
                return;
            }
        }

        UINT32 bufferFrameCount = 0;
        hr = audioClient->GetBufferSize(&bufferFrameCount);
        if (FAILED(hr) || bufferFrameCount == 0) {
            CloseHandle(sampleReadyEvent);
            finishStart(false, "WASAPI exclusive output reported an invalid endpoint buffer size.");
            return;
        }
        {
            std::lock_guard<std::mutex> lock(mutex_);
            status_.bufferFrames = static_cast<int>(bufferFrameCount);
            status_.actualPeriodFrames = static_cast<int>(bufferFrameCount);
            status_.actualPeriodMs = static_cast<double>(bufferFrameCount) * 1000.0 / format.sampleRate;
            status_.attempts.back().bufferFrames = static_cast<int>(bufferFrameCount);
            status_.attempts.back().actualPeriodMs = status_.actualPeriodMs;
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

        std::string fillError;
        // An exclusive event-driven stream completes exactly one buffer period per event, and
        // GetCurrentPadding always reports the buffer as full on this path, so it cannot be
        // used to measure consumption -- doing so yields zero consumed frames forever and the
        // reported position never moves. Credit one period per event instead.
        auto accountConsumedPeriod = [&](UINT32& queuedEndpointFrames, UINT32& queuedAudioFrames) {
            queuedEndpointFrames = queuedEndpointFrames > bufferFrameCount
                ? queuedEndpointFrames - bufferFrameCount
                : 0;

            const UINT32 consumedAudioFrames = std::min(queuedAudioFrames, bufferFrameCount);
            if (consumedAudioFrames == 0) {
                return;
            }
            queuedAudioFrames -= consumedAudioFrames;
            engine->onFramesConsumed(consumedAudioFrames);
        };

        auto queryTimerAvailability = [&](UINT32& queuedEndpointFrames, UINT32& queuedAudioFrames, UINT32* availableFrames) -> bool {
            UINT32 padding = 0;
            const HRESULT paddingHr = audioClient->GetCurrentPadding(&padding);
            if (FAILED(paddingHr) || padding > bufferFrameCount) {
                fillError = "WASAPI timer-driven output could not query current padding (" + formatHRESULT(paddingHr) + ").";
                return false;
            }
            const UINT32 consumedEndpointFrames = queuedEndpointFrames > padding
                ? queuedEndpointFrames - padding
                : 0;
            const UINT32 consumedAudioFrames = std::min(queuedAudioFrames, consumedEndpointFrames);
            queuedEndpointFrames = padding;
            queuedAudioFrames -= consumedAudioFrames;
            if (consumedAudioFrames > 0) engine->onFramesConsumed(consumedAudioFrames);
            if (availableFrames != nullptr) *availableFrames = bufferFrameCount - padding;
            return true;
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
            size_t framesWritten = 0;
            if (negotiated.needsConversion) {
                // Render in the track's own format, then left-justify into the device's
                // wider container. The engine's read-only taps still see native samples.
                const size_t trackBytesPerFrame = format.bytesPerFrame();
                const size_t requiredBytes = static_cast<size_t>(requestedFrames) * trackBytesPerFrame;
                if (conversionBuffer.size() < requiredBytes) {
                    conversionBuffer.resize(requiredBytes);
                }
                framesWritten = engine->renderInto(conversionBuffer.data(), requestedFrames, streamEnded);
                const size_t convertedFrames = std::min<size_t>(framesWritten, requestedFrames);
                widenSampleBlock(
                    conversionBuffer.data(),
                    format.sampleFormat,
                    renderBuffer,
                    negotiated.option.containerBits,
                    convertedFrames * format.channels
                );
            } else {
                framesWritten = engine->renderInto(renderBuffer, requestedFrames, streamEnded);
            }

            const UINT32 bytesPerFrame = negotiated.bytesPerFrame;
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
        bool naturallyDrained = false;
        UINT32 primedFrames = 0;
        if (!fillBuffer(bufferFrameCount, &primedFrames, &endOfStreamReached, &fillError)) {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                status_.failureStage = "priming";
            }
            CloseHandle(sampleReadyEvent);
            finishStart(false, fillError);
            return;
        }

        if (primedFrames == 0) {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                status_.failureStage = "priming";
            }
            CloseHandle(sampleReadyEvent);
            finishStart(false, "WASAPI exclusive output started without any audio frames to enqueue.");
            return;
        }

        queuedEndpointFrames = bufferFrameCount;
        queuedAudioFrames = primedFrames;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            status_.attempts.back().bufferPrimed = true;
        }

        mmcssHandle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
        if (mmcssHandle != nullptr) {
            AvSetMmThreadPriority(mmcssHandle, AVRT_PRIORITY_HIGH);
        }

        hr = audioClient->Start();
        if (FAILED(hr)) {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                status_.failureStage = "start";
                status_.osErrorCode = static_cast<int64_t>(hr);
                status_.osErrorSymbol = symbolicHRESULT(hr);
            }
            CloseHandle(sampleReadyEvent);
            if (mmcssHandle != nullptr) {
                AvRevertMmThreadCharacteristics(mmcssHandle);
            }
            finishStart(false, "WASAPI exclusive output failed to start (" + formatHRESULT(hr) + ").");
            return;
        }

        {
            std::lock_guard<std::mutex> lock(mutex_);
            status_.streamStarted = true;
            status_.streamRunning = true;
            status_.failureStage.clear();
            status_.failureSummary.clear();
            status_.attempts.back().streamStarted = true;
            status_.attempts.back().finalVerified = true;
            RecomputeBitPerfectActive(status_);
        }

        engine->onPlatformStartVerified();
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
                    if (eventDriven) {
                        accountConsumedPeriod(queuedEndpointFrames, queuedAudioFrames);
                    } else {
                        queryTimerAvailability(queuedEndpointFrames, queuedAudioFrames, nullptr);
                    }
                }
                break;
            }

            if (waitResult == WAIT_TIMEOUT) {
                // No event means the endpoint stalled; nothing was played, so credit nothing.
                continue;
            }

            if (waitResult != WAIT_OBJECT_0 + 1) {
                fillError = waitResult == WAIT_TIMEOUT
                    ? "WASAPI exclusive output timed out waiting for the next render period."
                    : "WASAPI exclusive output wait failed (code " + std::to_string(waitResult) + ").";
                break;
            }

            UINT32 availableFrames = bufferFrameCount;
            if (eventDriven) {
                accountConsumedPeriod(queuedEndpointFrames, queuedAudioFrames);
            } else if (!queryTimerAvailability(queuedEndpointFrames, queuedAudioFrames, &availableFrames)) {
                break;
            }

            if (endOfStreamReached) {
                if (queuedAudioFrames == 0 && queuedEndpointFrames == 0) {
                    naturallyDrained = true;
                    break;
                }
                continue;
            }

            // Event-driven exclusive mode is whole-buffer ping-pong. Timer-driven exclusive
            // mode is deliberately separate and sizes each write from GetCurrentPadding.
            const UINT32 requestedFrames = eventDriven ? bufferFrameCount : availableFrames;
            if (requestedFrames == 0) continue;
            UINT32 writtenFrames = 0;
            fillError.clear();
            bool streamEnded = false;
            if (!fillBuffer(requestedFrames, &writtenFrames, &streamEnded, &fillError)) {
                break;
            }
            queuedEndpointFrames = std::min<UINT32>(bufferFrameCount, queuedEndpointFrames + requestedFrames);
            queuedAudioFrames = std::min<UINT32>(bufferFrameCount, queuedAudioFrames + writtenFrames);
            endOfStreamReached = streamEnded;
        }

        audioClient->Stop();
        audioClient->Reset();
        CloseHandle(sampleReadyEvent);

        if (mmcssHandle != nullptr) {
            AvRevertMmThreadCharacteristics(mmcssHandle);
        }
        {
            std::lock_guard<std::mutex> lock(mutex_);
            status_.streamRunning = false;
            status_.streamStarted = false;
            status_.streamInitialized = false;
            status_.exclusiveAcquired = false;
            status_.systemMixerBypassed = false;
            if (!fillError.empty()) {
                status_.failureStage = "runtime";
                status_.failureSummary = fillError;
            }
            RecomputeBitPerfectActive(status_);
        }
        if (naturallyDrained && fillError.empty()) {
            engine->onNativeStreamEnded();
        } else if (!fillError.empty()) {
            engine->onNativeOutputRuntimeFailure(fillError);
        } else {
            engine->onNativeOutputStatusChanged(fillError);
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
    NativeOutputStatus status_ {};
};

std::vector<NegotiatedExclusiveFormat> buildNegotiatedFormatCandidates(
    IAudioClient* probeClient,
    const TrackFormat& track
) {
    std::vector<NegotiatedExclusiveFormat> candidates;
    std::vector<ExactFormatOrderKey> orderKeys;
    const auto ladder = buildFormatLadder(track.sampleFormat);
    for (int representation = 0; representation < 2; representation++) {
        for (size_t ladderRank = 0; ladderRank < ladder.size(); ladderRank++) {
            const ExclusiveFormatOption& option = ladder[ladderRank];
            if (representation == 1 && option.containerBits != option.validBits) continue;
            NegotiatedExclusiveFormat candidate;
            candidate.useExtensible = representation == 0;
            candidate.option = option;
            candidate.bytesPerFrame = (option.containerBits / 8) * track.channels;
            candidate.needsConversion = option.sampleFormat != track.sampleFormat
                || option.containerBits != track.bytesPerSample() * 8;
            if (candidate.useExtensible) {
                fillWaveFormatExtensible(&candidate.extensible, track.sampleRate, track.channels, option);
            } else {
                fillWaveFormatPlain(&candidate.plain, track.sampleRate, track.channels, option);
            }
            candidate.probeAccepted = isExclusiveFormatAccepted(probeClient, candidate.waveFormat());
            candidates.push_back(candidate);
            orderKeys.push_back({static_cast<int>(ladderRank), candidate.useExtensible, candidate.probeAccepted});
        }
    }
    std::vector<NegotiatedExclusiveFormat> ordered;
    ordered.reserve(candidates.size());
    for (const size_t index : OrderExactFormatCandidates(orderKeys)) ordered.push_back(candidates[index]);
    return ordered;
}

} // namespace

std::unique_ptr<AudioOutputSink> CreatePlatformAudioSink() {
    return std::make_unique<WasapiExclusiveSink>();
}

#endif

} // namespace NativePlayback
