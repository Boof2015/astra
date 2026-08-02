#include "playback_engine.h"

#include <algorithm>
#include <cctype>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <cerrno>
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
constexpr snd_pcm_uframes_t kPreferredPeriodFrames = 1024;
constexpr unsigned int kPreferredBufferPeriods = 4;

std::string formatAlsaError(const std::string& message, int errorCode) {
    return message + " (" + snd_strerror(errorCode) + ").";
}

std::string symbolicAlsaError(int errorCode) {
    switch (errorCode < 0 ? -errorCode : errorCode) {
        case EPIPE: return "EPIPE";
        case ESTRPIPE: return "ESTRPIPE";
        case ENODEV: return "ENODEV";
        case EBUSY: return "EBUSY";
        case EINVAL: return "EINVAL";
        case EIO: return "EIO";
        case EAGAIN: return "EAGAIN";
        default: return "ALSA_ERROR";
    }
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
        case SampleFormat::Int24Packed:
            // Packed 3-byte little-endian, not S24_LE (which is 24-in-32).
            return SND_PCM_FORMAT_S24_3LE;
        case SampleFormat::Int32:
            return SND_PCM_FORMAT_S32_LE;
        case SampleFormat::Float32:
        default:
            return SND_PCM_FORMAT_FLOAT_LE;
    }
}

struct AlsaWireOption {
    snd_pcm_format_t format;
    int containerBits;
    int validBits;
    const char* id;
};

std::vector<AlsaWireOption> buildAlsaWireLadder(SampleFormat sourceFormat) {
    switch (sourceFormat) {
        case SampleFormat::Int16:
            return {
                { SND_PCM_FORMAT_S16_LE, 16, 16, "s16" },
                { SND_PCM_FORMAT_S24_3LE, 24, 24, "s24" },
                { SND_PCM_FORMAT_S24_LE, 32, 24, "s24in32" },
                { SND_PCM_FORMAT_S32_LE, 32, 32, "s32" }
            };
        case SampleFormat::Int24Packed:
            return {
                { SND_PCM_FORMAT_S24_3LE, 24, 24, "s24" },
                { SND_PCM_FORMAT_S24_LE, 32, 24, "s24in32" },
                { SND_PCM_FORMAT_S32_LE, 32, 32, "s32" }
            };
        case SampleFormat::Int32:
            return {{ SND_PCM_FORMAT_S32_LE, 32, 32, "s32" }};
        case SampleFormat::Float32:
        default:
            return {{ SND_PCM_FORMAT_FLOAT_LE, 32, 32, "f32" }};
    }
}

bool isCanonicalHwName(const std::string& name) {
    if (name.rfind("hw:", 0) != 0 || name.size() <= 3) return false;
    // Reject plugin aliases and configuration expressions. Canonical ids emitted by Astra
    // are numeric hw:CARD,DEV or hw:CARD=<id>,DEV=<n> forms.
    return name.find_first_of(" \t\r\n{}[]();") == std::string::npos;
}

void widenAlsaSampleBlock(
    const uint8_t* source,
    SampleFormat sourceFormat,
    uint8_t* destination,
    const AlsaWireOption& wire,
    size_t sampleCount
) {
    if (sourceFormat == SampleFormat::Int16 && wire.containerBits == 24) {
        for (size_t i = 0; i < sampleCount; i++) {
            destination[i * 3] = 0;
            destination[i * 3 + 1] = source[i * 2];
            destination[i * 3 + 2] = source[i * 2 + 1];
        }
        return;
    }
    if (sourceFormat == SampleFormat::Int16 && wire.containerBits == 32) {
        const int shift = wire.validBits == 24 ? 8 : 16;
        for (size_t i = 0; i < sampleCount; i++) {
            uint16_t sourceWord = 0;
            std::memcpy(&sourceWord, source + i * 2, sizeof(sourceWord));
            const uint32_t widened = static_cast<uint32_t>(sourceWord) << shift;
            std::memcpy(destination + i * 4, &widened, sizeof(widened));
        }
        return;
    }
    if (sourceFormat == SampleFormat::Int24Packed && wire.containerBits == 32) {
        for (size_t i = 0; i < sampleCount; i++) {
            const uint8_t* sample = source + i * 3;
            uint32_t value =
                static_cast<uint32_t>(sample[0])
                | (static_cast<uint32_t>(sample[1]) << 8)
                | (static_cast<uint32_t>(sample[2]) << 16);
            if ((value & 0x00800000) != 0) value |= 0xFF000000u;
            if (wire.validBits == 32) value <<= 8;
            std::memcpy(destination + i * 4, &value, sizeof(value));
        }
        return;
    }
    const size_t sourceBytes = sourceFormat == SampleFormat::Int16
        ? 2
        : (sourceFormat == SampleFormat::Int24Packed ? 3 : 4);
    std::memcpy(destination, source, sampleCount * sourceBytes);
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

void appendEnumeratedDevice(
    std::vector<OutputDeviceInfo>* devices,
    std::unordered_set<std::string>* seenIds,
    const std::string& deviceId,
    const std::string& label
) {
    if (devices == nullptr || seenIds == nullptr || deviceId.empty()) {
        return;
    }
    if (!seenIds->insert(deviceId).second) {
        return;
    }

    devices->push_back({
        deviceId,
        label.empty() ? deviceId : label,
        queryDeviceMaxChannels(deviceId),
        devices->empty()
    });
}

void enumerateAlsaHwDevicesFromCards(
    std::vector<OutputDeviceInfo>* devices,
    std::unordered_set<std::string>* seenIds
) {
    if (devices == nullptr || seenIds == nullptr) {
        return;
    }

    int cardIndex = -1;
    if (snd_card_next(&cardIndex) < 0) {
        return;
    }

    while (cardIndex >= 0) {
        const std::string controlName = "hw:" + std::to_string(cardIndex);
        snd_ctl_t* controlHandle = nullptr;
        if (snd_ctl_open(&controlHandle, controlName.c_str(), 0) >= 0 && controlHandle != nullptr) {
            snd_ctl_card_info_t* cardInfo = nullptr;
            snd_ctl_card_info_alloca(&cardInfo);

            if (snd_ctl_card_info(controlHandle, cardInfo) >= 0) {
                const char* rawCardId = snd_ctl_card_info_get_id(cardInfo);
                const char* rawCardName = snd_ctl_card_info_get_name(cardInfo);
                const std::string cardId = rawCardId != nullptr && *rawCardId != '\0'
                    ? std::string(rawCardId)
                    : std::to_string(cardIndex);
                const std::string cardName = rawCardName != nullptr && *rawCardName != '\0'
                    ? trimWhitespace(rawCardName)
                    : ("Card " + std::to_string(cardIndex));

                int deviceIndex = -1;
                while (snd_ctl_pcm_next_device(controlHandle, &deviceIndex) >= 0 && deviceIndex >= 0) {
                    snd_pcm_info_t* pcmInfo = nullptr;
                    snd_pcm_info_alloca(&pcmInfo);
                    snd_pcm_info_set_device(pcmInfo, static_cast<unsigned int>(deviceIndex));
                    snd_pcm_info_set_subdevice(pcmInfo, 0);
                    snd_pcm_info_set_stream(pcmInfo, SND_PCM_STREAM_PLAYBACK);

                    if (snd_ctl_pcm_info(controlHandle, pcmInfo) < 0) {
                        continue;
                    }

                    const char* rawPcmName = snd_pcm_info_get_name(pcmInfo);
                    const std::string pcmName = rawPcmName != nullptr && *rawPcmName != '\0'
                        ? trimWhitespace(rawPcmName)
                        : ("Device " + std::to_string(deviceIndex));
                    const std::string deviceId = "hw:CARD=" + cardId + ",DEV=" + std::to_string(deviceIndex);
                    const std::string label = cardName == pcmName
                        ? cardName
                        : (cardName + " - " + pcmName);
                    appendEnumeratedDevice(devices, seenIds, deviceId, label);
                }
            }

            snd_ctl_close(controlHandle);
        }

        if (snd_card_next(&cardIndex) < 0) {
            break;
        }
    }
}

void enumerateAlsaHwDevicesFromHints(
    std::vector<OutputDeviceInfo>* devices,
    std::unordered_set<std::string>* seenIds
) {
    if (devices == nullptr || seenIds == nullptr) {
        return;
    }

    void** hints = nullptr;
    const int hintResult = snd_device_name_hint(-1, "pcm", &hints);
    if (hintResult < 0 || hints == nullptr) {
        return;
    }

    for (void** currentHint = hints; *currentHint != nullptr; ++currentHint) {
        const std::string name = getHintString(*currentHint, "NAME");
        if (name.empty() || name.rfind("hw:", 0) != 0) {
            continue;
        }

        const std::string ioId = getHintString(*currentHint, "IOID");
        if (!ioId.empty() && ioId != "Output") {
            continue;
        }

        const std::string description = firstDescriptionLine(getHintString(*currentHint, "DESC"));
        appendEnumeratedDevice(devices, seenIds, name, description.empty() ? name : description);
    }

    snd_device_name_free_hint(hints);
}

std::vector<OutputDeviceInfo> enumerateAlsaHwDevices(std::string* reason) {
    std::vector<OutputDeviceInfo> devices;
    std::unordered_set<std::string> seenIds;
    enumerateAlsaHwDevicesFromCards(&devices, &seenIds);
    enumerateAlsaHwDevicesFromHints(&devices, &seenIds);

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
        if (error != nullptr) {
            *error = "Select a direct ALSA hardware output device for bit-perfect playback.";
        }
        return false;
    }

    if (!isCanonicalHwName(requestedDeviceId)) {
        if (error != nullptr) {
            *error = "Exclusive ALSA playback requires a canonical hw: PCM name; default, plug, "
                "plughw, dmix, and PulseAudio/PipeWire compatibility devices are not allowed.";
        }
        return false;
    }

    for (const OutputDeviceInfo& device : devices) {
        if (device.id == requestedDeviceId) {
            *resolvedDevice = device;
            return true;
        }
    }

    snd_pcm_t* testHandle = nullptr;
    const int openResult = snd_pcm_open(&testHandle, requestedDeviceId.c_str(), SND_PCM_STREAM_PLAYBACK, 0);
    if (openResult >= 0 && testHandle != nullptr && snd_pcm_type(testHandle) == SND_PCM_TYPE_HW) {
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
    const AlsaWireOption& wireOption,
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

    const snd_pcm_format_t alsaFormat = wireOption.format;
    result = snd_pcm_hw_params_set_format(pcmHandle, hwParams, alsaFormat);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError(
                "The selected ALSA hardware device does not support " + std::string(wireOption.id) + " samples",
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

    unsigned int periodCount = std::max<unsigned int>(2, kPreferredBufferPeriods);
    int periodsDirection = 0;
    result = snd_pcm_hw_params_set_periods_near(pcmHandle, hwParams, &periodCount, &periodsDirection);
    if (result < 0) {
        if (error != nullptr) {
            *error = formatAlsaError("ALSA hw output could not configure its period count", result);
        }
        return false;
    }

    snd_pcm_uframes_t bufferFrames = std::max<snd_pcm_uframes_t>(
        periodFrames * static_cast<snd_pcm_uframes_t>(std::max<unsigned int>(2, periodCount)),
        periodFrames * 2
    );
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
    snd_pcm_access_t activeAccess = SND_PCM_ACCESS_MMAP_INTERLEAVED;
    unsigned int activeChannels = 0;
    unsigned int activeSampleRate = 0;
    int activeSampleRateDirection = 0;
    snd_pcm_hw_params_get_format(currentParams, &activeFormat);
    snd_pcm_hw_params_get_access(currentParams, &activeAccess);
    snd_pcm_hw_params_get_channels(currentParams, &activeChannels);
    snd_pcm_hw_params_get_rate(currentParams, &activeSampleRate, &activeSampleRateDirection);
    snd_pcm_uframes_t activePeriodFrames = 0;
    snd_pcm_uframes_t activeBufferFrames = 0;
    unsigned int activePeriodCount = 0;
    int activePeriodDirection = 0;
    int activePeriodCountDirection = 0;
    snd_pcm_hw_params_get_period_size(currentParams, &activePeriodFrames, &activePeriodDirection);
    snd_pcm_hw_params_get_periods(currentParams, &activePeriodCount, &activePeriodCountDirection);
    snd_pcm_hw_params_get_buffer_size(currentParams, &activeBufferFrames);

    const int activeValidBits = snd_pcm_format_width(activeFormat);
    const int activePhysicalBits = snd_pcm_format_physical_width(activeFormat);
    if (activeAccess != SND_PCM_ACCESS_RW_INTERLEAVED
        || activeFormat != alsaFormat
        || activeValidBits != wireOption.validBits
        || activePhysicalBits != wireOption.containerBits
        || activeChannels != format.channels
        || activeSampleRate != format.sampleRate
        || activePeriodFrames == 0
        || activePeriodCount < 2
        || activeBufferFrames < activePeriodFrames * 2) {
        if (error != nullptr) {
            *error = "The selected ALSA hardware device does not support "
                + std::to_string(format.sampleRate)
                + " Hz "
                + std::to_string(format.channels)
                + "-channel "
                + wireOption.id
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

    bool isAvailable() const override {
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
        snd_pcm_uframes_t configuredPeriodFrames = kPreferredPeriodFrames;
        snd_pcm_uframes_t configuredBufferFrames = kPreferredPeriodFrames * kPreferredBufferPeriods;
        AlsaWireOption selectedWire = buildAlsaWireLadder(format.sampleFormat).front();
        std::vector<NativeOutputAttempt> attempts;
        std::string latestError;
        int attemptIndex = 0;
        for (const AlsaWireOption& wire : buildAlsaWireLadder(format.sampleFormat)) {
            NativeOutputAttempt attempt;
            attempt.index = ++attemptIndex;
            attempt.backend = backendKind();
            attempt.deviceId = resolvedDevice.id;
            attempt.deviceLabel = resolvedDevice.label;
            attempt.sourceFormat = DescribeTrackFormat(format);
            attempt.processingFormat = attempt.sourceFormat;
            attempt.wireFormat = attempt.sourceFormat;
            attempt.wireFormat.sampleFormat = wire.id;
            attempt.wireFormat.containerBits = wire.containerBits;
            attempt.wireFormat.validBits = wire.validBits;
            attempt.wireFormat.representation = "ALSA RW_INTERLEAVED";
            attempt.transport = "ALSA direct write";
            attempt.probeResult = "attempted directly";
            attempt.deviceResolved = true;
            attempt.requestedPeriodMs = static_cast<double>(kPreferredPeriodFrames) * 1000.0 / format.sampleRate;

            int openResult = snd_pcm_open(&pcmHandle, resolvedDevice.id.c_str(), SND_PCM_STREAM_PLAYBACK, 0);
            if (openResult < 0 || pcmHandle == nullptr) {
                latestError = formatAlsaError("Failed to open the selected ALSA hardware device " + resolvedDevice.id, openResult);
                attempt.failureStage = "ownership";
                attempt.osErrorCode = openResult;
                attempt.osErrorSymbol = symbolicAlsaError(openResult);
                attempt.message = latestError;
                attempts.push_back(std::move(attempt));
                pcmHandle = nullptr;
                break;
            }
            if (snd_pcm_type(pcmHandle) != SND_PCM_TYPE_HW) {
                latestError = "The selected ALSA PCM resolved to a plugin instead of a hardware PCM.";
                attempt.failureStage = "device-resolution";
                attempt.message = latestError;
                attempts.push_back(std::move(attempt));
                snd_pcm_close(pcmHandle);
                pcmHandle = nullptr;
                break;
            }

            configuredPeriodFrames = kPreferredPeriodFrames;
            configuredBufferFrames = kPreferredPeriodFrames * kPreferredBufferPeriods;
            std::string configureError;
            if (!configurePcmHandle(pcmHandle, format, wire, &configuredPeriodFrames, &configuredBufferFrames, &configureError)) {
                latestError = configureError;
                attempt.failureStage = "format-negotiation";
                attempt.message = configureError;
                attempts.push_back(std::move(attempt));
                snd_pcm_close(pcmHandle);
                pcmHandle = nullptr;
                continue;
            }

            selectedWire = wire;
            attempt.formatNegotiated = true;
            attempt.streamInitialized = true;
            attempt.actualPeriodMs = static_cast<double>(configuredPeriodFrames) * 1000.0 / format.sampleRate;
            attempt.bufferFrames = static_cast<int>(configuredBufferFrames);
            attempt.message = "Verified ALSA read-back: hw PCM, RW_INTERLEAVED, exact rate/channels/format, "
                + std::to_string(selectedWire.validBits) + " significant bits, "
                + std::to_string(selectedWire.containerBits) + " physical bits, "
                + std::to_string(configuredPeriodFrames) + " period frames, "
                + std::to_string(configuredBufferFrames / std::max<snd_pcm_uframes_t>(1, configuredPeriodFrames))
                + " periods, " + std::to_string(configuredBufferFrames) + " buffer frames.";
            attempts.push_back(std::move(attempt));
            break;
        }

        if (pcmHandle == nullptr) {
            std::lock_guard<std::mutex> lock(mutex_);
            status_.backend = backendKind();
            status_.deviceId = resolvedDevice.id;
            status_.deviceLabel = resolvedDevice.label;
            status_.exclusiveRequested = true;
            status_.sourceFormat = DescribeTrackFormat(format);
            status_.processingFormat = status_.sourceFormat;
            status_.failureStage = attempts.empty() ? "ownership" : attempts.back().failureStage;
            status_.failureSummary = latestError;
            status_.attempts = std::move(attempts);
            RecomputeBitPerfectActive(status_);
            if (error != nullptr) *error = latestError.empty() ? "ALSA could not negotiate an exact hardware format." : latestError;
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
        wireOption_ = selectedWire;
        stopRequested_ = false;
        accountProgressOnStop_ = false;
        status_.outputOpen = true;
        status_.deviceResolved = true;
        status_.formatNegotiated = true;
        status_.streamInitialized = true;
        status_.streamStarted = false;
        status_.streamRunning = false;
        status_.exclusiveRequested = true;
        status_.exclusiveAcquired = true;
        status_.systemMixerBypassed = true;
        status_.sourceSamplesModified = false;
        status_.wireFormatCanCarrySourceExactly = true;
        status_.backend = backendKind();
        status_.deviceId = resolvedDevice.id;
        status_.deviceLabel = resolvedDevice.label;
        status_.transport = "ALSA direct write";
        status_.sourceFormat = DescribeTrackFormat(format);
        status_.processingFormat = status_.sourceFormat;
        status_.wireFormat = status_.sourceFormat;
        status_.wireFormat.sampleFormat = selectedWire.id;
        status_.wireFormat.containerBits = selectedWire.containerBits;
        status_.wireFormat.validBits = selectedWire.validBits;
        status_.wireFormat.representation = "ALSA RW_INTERLEAVED";
        status_.requestedPeriodFrames = static_cast<int>(kPreferredPeriodFrames);
        status_.requestedPeriodMs = static_cast<double>(kPreferredPeriodFrames) * 1000.0 / format.sampleRate;
        status_.actualPeriodFrames = static_cast<int>(configuredPeriodFrames);
        status_.actualPeriodMs = static_cast<double>(configuredPeriodFrames) * 1000.0 / format.sampleRate;
        status_.bufferFrames = static_cast<int>(configuredBufferFrames);
        status_.failureStage.clear();
        status_.failureSummary.clear();
        status_.attempts = std::move(attempts);
        RecomputeBitPerfectActive(status_);
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
        std::lock_guard<std::mutex> lock(mutex_);
        status_.streamRunning = false;
        status_.streamStarted = false;
        // The hw handle remains reserved and prepared on pause.
        status_.exclusiveAcquired = pcmHandle_ != nullptr;
        status_.systemMixerBypassed = status_.exclusiveAcquired;
        RecomputeBitPerfectActive(status_);
    }

    void stop() override {
        stopRenderThread(false);
        resetPcmHandle();
        std::lock_guard<std::mutex> lock(mutex_);
        status_.streamRunning = false;
        status_.streamStarted = false;
        status_.exclusiveAcquired = pcmHandle_ != nullptr;
        status_.systemMixerBypassed = status_.exclusiveAcquired;
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
        if (!success) {
            status_.streamRunning = false;
            status_.streamStarted = false;
            if (status_.failureStage.empty()) status_.failureStage = "start";
            status_.failureSummary = startError_;
            if (!status_.attempts.empty()) {
                status_.attempts.back().failureStage = status_.failureStage;
                status_.attempts.back().message = startError_;
            }
        }
        RecomputeBitPerfectActive(status_);
        startCv_.notify_one();
    }

    void renderLoop() {
        PlaybackEngine* engine = nullptr;
        snd_pcm_t* pcmHandle = nullptr;
        TrackFormat format {};
        snd_pcm_uframes_t periodFrames = 0;
        snd_pcm_uframes_t bufferFrames = 0;
        AlsaWireOption wireOption { SND_PCM_FORMAT_UNKNOWN, 0, 0, "" };

        {
            std::lock_guard<std::mutex> lock(mutex_);
            engine = engine_;
            pcmHandle = pcmHandle_;
            format = openFormat_;
            periodFrames = periodFrames_;
            bufferFrames = bufferFrames_;
            wireOption = wireOption_;
        }

        if (engine == nullptr || pcmHandle == nullptr || format.sampleRate == 0 || format.channels == 0) {
            finishStart(false, "ALSA hw output is unavailable.");
            return;
        }

        const size_t maxFramesPerChunk = static_cast<size_t>(std::max(periodFrames, bufferFrames));
        const size_t sourceBytesPerFrame = static_cast<size_t>(format.bytesPerFrame());
        const size_t wireBytesPerFrame = static_cast<size_t>(wireOption.containerBits / 8) * format.channels;
        const bool needsWidening = wireBytesPerFrame != sourceBytesPerFrame
            || std::string(wireOption.id) != format.sampleFormatId();
        std::vector<uint8_t> renderBuffer(maxFramesPerChunk * wireBytesPerFrame, 0);
        std::vector<uint8_t> sourceBuffer(needsWidening ? maxFramesPerChunk * sourceBytesPerFrame : 0, 0);

        snd_pcm_uframes_t queuedEndpointFrames = 0;
        snd_pcm_uframes_t queuedAudioFrames = 0;
        bool endOfStreamReached = false;
        bool streamStarted = false;
        bool naturallyDrained = false;
        std::string terminalError;

        auto recoverStream = [&](int errorCode) -> bool {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                status_.streamRunning = false;
                status_.streamStarted = false;
                status_.failureStage = "runtime-recovery";
                status_.osErrorCode = errorCode;
                status_.osErrorSymbol = symbolicAlsaError(errorCode);
                RecomputeBitPerfectActive(status_);
            }
            engine->onNativeOutputStatusChanged("ALSA stream recovery started.");
            // ALSA discards the queued hardware frames while recovering. Rewind the engine
            // to the last confirmed hardware-consumed frame before re-priming so no source
            // samples are silently skipped.
            engine->rollbackSpeculativeRender();
            const int recoverResult = snd_pcm_recover(pcmHandle, errorCode, 1);
            if (recoverResult < 0) {
                std::lock_guard<std::mutex> lock(mutex_);
                status_.failureStage = "runtime";
                status_.osErrorCode = recoverResult;
                status_.osErrorSymbol = symbolicAlsaError(recoverResult);
                status_.failureSummary = formatAlsaError("ALSA stream recovery failed", recoverResult);
                terminalError = status_.failureSummary;
                RecomputeBitPerfectActive(status_);
                return false;
            }

            queuedEndpointFrames = 0;
            queuedAudioFrames = 0;
            streamStarted = false;
            const int prepareResult = snd_pcm_prepare(pcmHandle);
            if (prepareResult < 0) {
                terminalError = formatAlsaError("ALSA hw output could not prepare after recovery", prepareResult);
                std::lock_guard<std::mutex> lock(mutex_);
                status_.failureStage = "runtime";
                status_.osErrorCode = prepareResult;
                status_.osErrorSymbol = symbolicAlsaError(prepareResult);
                status_.failureSummary = terminalError;
                RecomputeBitPerfectActive(status_);
                return false;
            }
            return true;
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
            {
                std::lock_guard<std::mutex> lock(mutex_);
                status_.streamStarted = true;
                status_.streamRunning = true;
                status_.failureStage.clear();
                status_.failureSummary.clear();
                RecomputeBitPerfectActive(status_);
            }
            engine->onNativeOutputStatusChanged();
            return true;
        };

        auto consumeAvailableFrames = [&](snd_pcm_uframes_t available) {
            if (queuedEndpointFrames == 0 || available == 0) {
                return;
            }

            const snd_pcm_uframes_t consumedEndpointFrames = std::min(queuedEndpointFrames, available);
            queuedEndpointFrames -= consumedEndpointFrames;
            if (consumedEndpointFrames == 0) {
                return;
            }

            const snd_pcm_uframes_t consumedAudioFrames = std::min(queuedAudioFrames, consumedEndpointFrames);
            queuedAudioFrames -= consumedAudioFrames;
            if (consumedAudioFrames > 0) {
                engine->onFramesConsumed(consumedAudioFrames);
            }
        };

        auto updatePlaybackProgress = [&]() -> bool {
            const snd_pcm_sframes_t availableFrames = snd_pcm_avail_update(pcmHandle);
            if (availableFrames < 0) {
                return recoverStream(static_cast<int>(availableFrames));
            }

            snd_pcm_uframes_t available = static_cast<snd_pcm_uframes_t>(availableFrames);
            if (available > bufferFrames) {
                available = bufferFrames;
            }

            consumeAvailableFrames(available);
            return true;
        };

        auto updatePlaybackProgressFromAvailable = [&](snd_pcm_uframes_t available) {
            if (available > bufferFrames) {
                available = bufferFrames;
            }
            consumeAvailableFrames(available);
        };

        auto fillAndWriteFrames = [&](snd_pcm_uframes_t requestedFrames, snd_pcm_uframes_t* writtenAudioFrames, bool* reachedEndOfStream, std::string* fillError) -> bool {
            bool streamEnded = false;
            uint8_t* engineBuffer = needsWidening ? sourceBuffer.data() : renderBuffer.data();
            const size_t framesWritten = engine->renderInto(engineBuffer, requestedFrames, streamEnded);
            const snd_pcm_uframes_t usedFrames = static_cast<snd_pcm_uframes_t>(std::min<size_t>(framesWritten, requestedFrames));

            if (needsWidening && usedFrames > 0) {
                widenAlsaSampleBlock(sourceBuffer.data(), format.sampleFormat, renderBuffer.data(), wireOption,
                    static_cast<size_t>(usedFrames) * format.channels);
            }

            if (usedFrames < requestedFrames && wireBytesPerFrame > 0) {
                const size_t usedBytes = static_cast<size_t>(usedFrames) * wireBytesPerFrame;
                const size_t remainingBytes = static_cast<size_t>(requestedFrames - usedFrames) * wireBytesPerFrame;
                std::memset(renderBuffer.data() + usedBytes, 0, remainingBytes);
            }

            snd_pcm_uframes_t totalWritten = 0;
            while (totalWritten < requestedFrames) {
                const uint8_t* writePointer = renderBuffer.data() + (static_cast<size_t>(totalWritten) * wireBytesPerFrame);
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

        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (!status_.attempts.empty()) {
                status_.attempts.back().bufferPrimed = true;
                status_.attempts.back().streamStarted = true;
                status_.attempts.back().finalVerified = true;
            }
            RecomputeBitPerfectActive(status_);
        }

        engine->onPlatformStartVerified();
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

            if (endOfStreamReached) {
                if (queuedAudioFrames == 0 && queuedEndpointFrames == 0) {
                    naturallyDrained = true;
                    break;
                }

                const int waitResult = snd_pcm_wait(pcmHandle, kRenderThreadWaitTimeoutMs);
                if (waitResult < 0) {
                    if (!recoverStream(waitResult)) break;
                    continue;
                }
                if (waitResult > 0) {
                    if (!updatePlaybackProgress()) break;
                }
                continue;
            }

            if (!streamStarted) {
                snd_pcm_uframes_t writtenAudioFrames = 0;
                std::string fillError;
                bool streamEnded = false;
                if (!fillAndWriteFrames(periodFrames, &writtenAudioFrames, &streamEnded, &fillError)) {
                    terminalError = fillError;
                    break;
                }

                queuedEndpointFrames = std::min(bufferFrames, queuedEndpointFrames + periodFrames);
                queuedAudioFrames = std::min(bufferFrames, queuedAudioFrames + writtenAudioFrames);
                endOfStreamReached = streamEnded;

                if (!startStream(&fillError)) {
                    terminalError = fillError;
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
            const snd_pcm_uframes_t availableToWrite = static_cast<snd_pcm_uframes_t>(
                std::min<snd_pcm_sframes_t>(availableFrames, static_cast<snd_pcm_sframes_t>(bufferFrames))
            );
            updatePlaybackProgressFromAvailable(availableToWrite);

            if (availableToWrite == 0) {
                continue;
            }

            const snd_pcm_uframes_t requestedFrames = static_cast<snd_pcm_uframes_t>(
                std::min<snd_pcm_uframes_t>(availableToWrite, periodFrames)
            );
            if (requestedFrames == 0) {
                continue;
            }

            snd_pcm_uframes_t writtenAudioFrames = 0;
            std::string fillError;
            bool streamEnded = false;
            if (!fillAndWriteFrames(requestedFrames, &writtenAudioFrames, &streamEnded, &fillError)) {
                terminalError = fillError;
                break;
            }

            queuedEndpointFrames = std::min(bufferFrames, queuedEndpointFrames + requestedFrames);
            queuedAudioFrames = std::min(bufferFrames, queuedAudioFrames + writtenAudioFrames);
            endOfStreamReached = streamEnded;
        }

        snd_pcm_drop(pcmHandle);
        snd_pcm_prepare(pcmHandle);

        {
            std::lock_guard<std::mutex> lock(mutex_);
            stopRequested_ = false;
            accountProgressOnStop_ = false;
            status_.streamRunning = false;
            status_.streamStarted = false;
            if (!terminalError.empty()) {
                status_.failureStage = "runtime";
                status_.failureSummary = terminalError;
            }
            RecomputeBitPerfectActive(status_);
        }
        if (naturallyDrained) {
            engine->onNativeStreamEnded();
        } else if (!terminalError.empty()) {
            engine->onNativeOutputRuntimeFailure(terminalError);
        } else {
            engine->onNativeOutputStatusChanged();
        }
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
    AlsaWireOption wireOption_ { SND_PCM_FORMAT_FLOAT_LE, 32, 32, "f32" };
    std::thread renderThread_;
    bool stopRequested_ = false;
    bool accountProgressOnStop_ = false;
    bool startFinished_ = false;
    bool startSucceeded_ = false;
    std::string startError_;
    NativeOutputStatus status_ {};
};

} // namespace

std::unique_ptr<AudioOutputSink> CreatePlatformAudioSink() {
    return std::make_unique<AlsaHwSink>();
}

#endif

} // namespace NativePlayback
