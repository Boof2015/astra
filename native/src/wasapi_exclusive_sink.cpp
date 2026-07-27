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

    WAVEFORMATEX* waveFormat() {
        return reinterpret_cast<WAVEFORMATEX*>(useExtensible ? &extensible : &plain);
    }
};

bool negotiateExclusiveFormat(
    IAudioClient* audioClient,
    const TrackFormat& track,
    NegotiatedExclusiveFormat* out
) {
    if (audioClient == nullptr || out == nullptr || track.sampleRate == 0 || track.channels == 0) {
        return false;
    }

    for (const ExclusiveFormatOption& option : buildFormatLadder(track.sampleFormat)) {
        // Some drivers only accept WAVEFORMATEXTENSIBLE, others only the plain struct. The
        // plain form cannot express validBits != containerBits, so 24-in-32 is extensible-only.
        fillWaveFormatExtensible(&out->extensible, track.sampleRate, track.channels, option);
        if (isExclusiveFormatAccepted(audioClient, reinterpret_cast<WAVEFORMATEX*>(&out->extensible))) {
            out->useExtensible = true;
        } else if (option.containerBits == option.validBits) {
            fillWaveFormatPlain(&out->plain, track.sampleRate, track.channels, option);
            if (!isExclusiveFormatAccepted(audioClient, reinterpret_cast<WAVEFORMATEX*>(&out->plain))) {
                continue;
            }
            out->useExtensible = false;
        } else {
            continue;
        }

        out->option = option;
        out->bytesPerFrame = (option.containerBits / 8) * track.channels;
        out->needsConversion = option.sampleFormat != track.sampleFormat
            || option.containerBits != track.bytesPerSample() * 8;
        return true;
    }

    return false;
}

// Human-readable summary of what the endpoint will actually accept, for error messages.
std::string describeExclusiveSupport(IAudioClient* audioClient, uint32_t channels) {
    if (audioClient == nullptr || channels == 0) {
        return {};
    }

    std::string summary;
    for (const uint32_t sampleRate : kProbeSampleRates) {
        std::string formats;
        for (const ExclusiveFormatOption& option : kProbeOptions) {
            WAVEFORMATEXTENSIBLE candidate {};
            fillWaveFormatExtensible(&candidate, sampleRate, channels, option);
            bool accepted = isExclusiveFormatAccepted(
                audioClient, reinterpret_cast<WAVEFORMATEX*>(&candidate));
            if (!accepted && option.containerBits == option.validBits) {
                WAVEFORMATEXTENSIBLE plainCandidate {};
                fillWaveFormatPlain(&plainCandidate, sampleRate, channels, option);
                accepted = isExclusiveFormatAccepted(
                    audioClient, reinterpret_cast<WAVEFORMATEX*>(&plainCandidate));
            }
            if (accepted) {
                if (!formats.empty()) {
                    formats += ", ";
                }
                formats += option.id;
            }
        }

        if (!formats.empty()) {
            if (!summary.empty()) {
                summary += "; ";
            }
            summary += std::to_string(sampleRate) + " Hz (" + formats + ")";
        }
    }

    return summary;
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
    if (sourceFormat == SampleFormat::Int16 && destinationContainerBits == 24) {
        for (size_t i = 0; i < sampleCount; i++) {
            destination[i * 3 + 0] = 0;
            destination[i * 3 + 1] = source[i * 2 + 0];
            destination[i * 3 + 2] = source[i * 2 + 1];
        }
        return;
    }

    if (sourceFormat == SampleFormat::Int16 && destinationContainerBits == 32) {
        for (size_t i = 0; i < sampleCount; i++) {
            destination[i * 4 + 0] = 0;
            destination[i * 4 + 1] = 0;
            destination[i * 4 + 2] = source[i * 2 + 0];
            destination[i * 4 + 3] = source[i * 2 + 1];
        }
        return;
    }

    if (sourceFormat == SampleFormat::Int24Packed && destinationContainerBits == 32) {
        for (size_t i = 0; i < sampleCount; i++) {
            destination[i * 4 + 0] = 0;
            destination[i * 4 + 1] = source[i * 3 + 0];
            destination[i * 4 + 2] = source[i * 3 + 1];
            destination[i * 4 + 3] = source[i * 3 + 2];
        }
        return;
    }

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
        // Keep a COM apartment alive for the whole call so the device and client pointers
        // below stay valid past resolveOutputDevice's own scoped init.
        ScopedCoInit coInit;
        if (!coInit.ok()) {
            if (error != nullptr) {
                *error = "Failed to initialize COM for WASAPI device access ("
                    + formatHRESULT(coInit.hr()) + ").";
            }
            return false;
        }

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

        // Negotiate here rather than on the render thread so an unplayable track fails at
        // load time with a message that names what the device will actually accept.
        if (!validateExclusiveFormat(resolvedDevice.Get(), resolvedLabel, format, error)) {
            return false;
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

    // Confirms the device will take this track, and if not, explains what it will take.
    // The message is parsed by the renderer to build the bit-perfect failure dialog, so the
    // "Supported in exclusive mode: ..." / "no exclusive-mode formats" phrasing is load-bearing.
    static bool validateExclusiveFormat(
        IMMDevice* device,
        const std::string& deviceLabel,
        const TrackFormat& format,
        std::string* error
    ) {
        if (device == nullptr) {
            return true;
        }

        ComPtr<IAudioClient> audioClient;
        const HRESULT hr = device->Activate(
            __uuidof(IAudioClient),
            CLSCTX_ALL,
            nullptr,
            reinterpret_cast<void**>(audioClient.GetAddressOf())
        );
        if (FAILED(hr) || audioClient == nullptr) {
            if (error != nullptr) {
                *error = "Failed to activate the selected WASAPI output device ("
                    + formatHRESULT(hr) + ").";
            }
            return false;
        }

        NegotiatedExclusiveFormat negotiated;
        if (negotiateExclusiveFormat(audioClient.Get(), format, &negotiated)) {
            return true;
        }

        if (error != nullptr) {
            const std::string supported = describeExclusiveSupport(audioClient.Get(), format.channels);
            *error = (deviceLabel.empty() ? std::string("The selected WASAPI device") : deviceLabel)
                + " cannot play "
                + std::to_string(format.sampleRate)
                + " Hz "
                + std::to_string(format.channels)
                + "-channel "
                + format.sampleFormatId()
                + " in exclusive mode. ";
            if (supported.empty()) {
                *error += "It reports no exclusive-mode formats at this channel count.";
            } else {
                *error += "Supported in exclusive mode: " + supported + ".";
            }
        }
        return false;
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
            finishStart(false, "Failed to activate the selected WASAPI output device (" + formatHRESULT(hr) + ").");
            return;
        }

        NegotiatedExclusiveFormat negotiated;
        if (!negotiateExclusiveFormat(audioClient.Get(), format, &negotiated)) {
            std::string negotiateError;
            validateExclusiveFormat(resolvedDevice.Get(), resolvedLabel, format, &negotiateError);
            finishStart(false, negotiateError);
            return;
        }

        WAVEFORMATEX* waveFormat = negotiated.waveFormat();
        // Set when the device took a wider container than the decoded PCM; the render path
        // then stages track-format frames here and left-justifies them on copy-out.
        std::vector<uint8_t> conversionBuffer;

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
                waveFormat,
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
                // wider container. The engine's taps and fade still see native samples.
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
                    accountConsumedPeriod(queuedEndpointFrames, queuedAudioFrames);
                }
                break;
            }

            if (waitResult == WAIT_TIMEOUT) {
                // No event means the endpoint stalled; nothing was played, so credit nothing.
                continue;
            }

            if (waitResult != WAIT_OBJECT_0 + 1) {
                break;
            }

            accountConsumedPeriod(queuedEndpointFrames, queuedAudioFrames);

            if (endOfStreamReached) {
                if (queuedAudioFrames == 0 && queuedEndpointFrames == 0) {
                    break;
                }
                continue;
            }

            // Exclusive event-driven mode releases the entire endpoint buffer every period,
            // so each wakeup must refill all of it. Sizing the write from GetCurrentPadding
            // is the shared-mode/timer-driven pattern: it under-fills, the endpoint starves,
            // and the device repeats stale buffer content as short audible glitches.
            UINT32 writtenFrames = 0;
            fillError.clear();
            bool streamEnded = false;
            if (!fillBuffer(bufferFrameCount, &writtenFrames, &streamEnded, &fillError)) {
                break;
            }
            queuedEndpointFrames = bufferFrameCount;
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
