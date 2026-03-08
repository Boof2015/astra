#define MINIAUDIO_IMPLEMENTATION
#include "../vendor/miniaudio.h"

#include "native_audio.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <iomanip>
#include <iterator>
#include <limits>
#include <memory>
#include <sstream>
#include <utility>

namespace {

constexpr ma_uint32 kVisualizerRingFrames = 65536;
constexpr ma_uint32 kSpectrumRingFrames = 65536;
constexpr ma_uint64 kDecodeChunkFrames = 4096;
constexpr ma_uint32 kDefaultPeriodMs = 10;  // 10ms - safe for WASAPI, CoreAudio, ALSA
constexpr ma_uint32 kCallbackScratchMaxFrames = 2048;  // Pre-alloc ceiling for scratch buffers

#if defined(MA_HAS_COREAUDIO)
constexpr ma_backend kPreferredBackends[] = {
    ma_backend_coreaudio,
};
#elif defined(MA_HAS_WASAPI) || defined(MA_HAS_DSOUND) || defined(MA_HAS_WINMM)
constexpr ma_backend kPreferredBackends[] = {
#if defined(MA_HAS_WASAPI)
    ma_backend_wasapi,
#endif
#if defined(MA_HAS_DSOUND)
    ma_backend_dsound,
#endif
#if defined(MA_HAS_WINMM)
    ma_backend_winmm,
#endif
};
#elif defined(MA_HAS_PULSEAUDIO) || defined(MA_HAS_ALSA) || defined(MA_HAS_JACK) || defined(MA_HAS_SNDIO) || defined(MA_HAS_OSS)
constexpr ma_backend kPreferredBackends[] = {
#if defined(MA_HAS_PULSEAUDIO)
    ma_backend_pulseaudio,
#endif
#if defined(MA_HAS_ALSA)
    ma_backend_alsa,
#endif
#if defined(MA_HAS_JACK)
    ma_backend_jack,
#endif
#if defined(MA_HAS_SNDIO)
    ma_backend_sndio,
#endif
#if defined(MA_HAS_OSS)
    ma_backend_oss,
#endif
};
#else
constexpr ma_backend kPreferredBackends[] = {};
#endif

float clampUnit(float value) {
    if (!std::isfinite(value)) {
        return 0.0f;
    }
    return std::max(0.0f, std::min(1.0f, value));
}

float dbToLinear(float db) {
    return std::pow(10.0f, db / 20.0f);
}

}  // namespace

namespace NativeAudio {

struct Engine::PcmRing {
    ma_pcm_rb rb{};
    bool initialized = false;
    ma_uint32 channels = 0;
    ma_uint32 sampleRate = 0;

    bool init(ma_uint32 channelCount, ma_uint32 capacityFrames) {
        uninit();
        ma_result result = ma_pcm_rb_init(ma_format_f32, channelCount, capacityFrames, nullptr, nullptr, &rb);
        if (result != MA_SUCCESS) {
            initialized = false;
            channels = 0;
            sampleRate = 0;
            return false;
        }

        initialized = true;
        channels = channelCount;
        sampleRate = 0;
        return true;
    }

    void uninit() {
        if (initialized) {
            ma_pcm_rb_uninit(&rb);
            initialized = false;
        }
        channels = 0;
        sampleRate = 0;
    }

    void reset() {
        if (initialized) {
            ma_pcm_rb_reset(&rb);
        }
    }

    void setSampleRate(ma_uint32 rate) {
        sampleRate = rate;
        if (initialized) {
            ma_pcm_rb_set_sample_rate(&rb, rate);
        }
    }

    void write(const float* data, ma_uint32 frames) {
        if (!initialized || data == nullptr || frames == 0) {
            return;
        }

        ma_uint32 availableWrite = ma_pcm_rb_available_write(&rb);
        if (availableWrite < frames) {
            ma_pcm_rb_seek_read(&rb, frames - availableWrite);
        }

        ma_uint32 remaining = frames;
        ma_uint32 offsetFrames = 0;
        while (remaining > 0) {
            ma_uint32 chunkFrames = remaining;
            void* writePtr = nullptr;
            if (ma_pcm_rb_acquire_write(&rb, &chunkFrames, &writePtr) != MA_SUCCESS || chunkFrames == 0 || writePtr == nullptr) {
                break;
            }

            std::memcpy(
                writePtr,
                data + (static_cast<size_t>(offsetFrames) * channels),
                static_cast<size_t>(chunkFrames) * channels * sizeof(float)
            );
            ma_pcm_rb_commit_write(&rb, chunkFrames);
            offsetFrames += chunkFrames;
            remaining -= chunkFrames;
        }
    }

    ma_uint32 read(float* out, ma_uint32 maxFrames) {
        if (!initialized || out == nullptr || maxFrames == 0) {
            return 0;
        }

        ma_uint32 availableRead = ma_pcm_rb_available_read(&rb);
        ma_uint32 framesToRead = std::min(maxFrames, availableRead);
        ma_uint32 remaining = framesToRead;
        ma_uint32 offsetFrames = 0;

        while (remaining > 0) {
            ma_uint32 chunkFrames = remaining;
            void* readPtr = nullptr;
            if (ma_pcm_rb_acquire_read(&rb, &chunkFrames, &readPtr) != MA_SUCCESS || chunkFrames == 0 || readPtr == nullptr) {
                break;
            }

            std::memcpy(
                out + (static_cast<size_t>(offsetFrames) * channels),
                readPtr,
                static_cast<size_t>(chunkFrames) * channels * sizeof(float)
            );
            ma_pcm_rb_commit_read(&rb, chunkFrames);
            offsetFrames += chunkFrames;
            remaining -= chunkFrames;
        }

        return offsetFrames;
    }
};

double Engine::DecodedAudio::durationSeconds() const {
    if (sampleRate == 0) {
        return 0.0;
    }
    return static_cast<double>(frameCount) / static_cast<double>(sampleRate);
}

void Engine::DecodedAudio::clear() {
    samples.clear();
    channels = 0;
    sampleRate = 0;
    frameCount = 0;
}

bool Engine::DeviceConfigSignature::operator==(const DeviceConfigSignature& other) const {
    return deviceId == other.deviceId
        && sampleRate == other.sampleRate
        && outputChannels == other.outputChannels
        && exclusive == other.exclusive;
}

void Engine::AnalysisDelayBuffer::configure(uint32_t nextChannels, uint32_t nextDelayFrames) {
    nextChannels = std::max<uint32_t>(1, nextChannels);
    if (channels == nextChannels && delayFrames == nextDelayFrames) {
        return;
    }

    channels = nextChannels;
    delayFrames = nextDelayFrames;
    buffer.assign(static_cast<size_t>(channels) * delayFrames, 0.0f);
    writeIndex = 0;
    filled = 0;
}

void Engine::AnalysisDelayBuffer::reset() {
    std::fill(buffer.begin(), buffer.end(), 0.0f);
    writeIndex = 0;
    filled = 0;
}

void Engine::AnalysisDelayBuffer::process(const float* input, uint32_t inputFrames, float* output) {
    if (input == nullptr || output == nullptr || inputFrames == 0 || channels == 0) {
        return;
    }

    if (delayFrames == 0 || buffer.empty()) {
        std::memcpy(output, input, static_cast<size_t>(inputFrames) * channels * sizeof(float));
        return;
    }

    for (uint32_t frame = 0; frame < inputFrames; ++frame) {
        const float* inFrame = input + (static_cast<size_t>(frame) * channels);
        float* outFrame = output + (static_cast<size_t>(frame) * channels);
        size_t delayOffset = static_cast<size_t>(writeIndex) * channels;

        if (filled < delayFrames) {
            std::copy_n(inFrame, channels, buffer.begin() + static_cast<std::ptrdiff_t>(delayOffset));
            std::fill_n(outFrame, channels, 0.0f);
            writeIndex = (writeIndex + 1) % delayFrames;
            filled += 1;
            continue;
        }

        std::copy_n(buffer.data() + delayOffset, channels, outFrame);
        std::copy_n(inFrame, channels, buffer.begin() + static_cast<std::ptrdiff_t>(delayOffset));
        writeIndex = (writeIndex + 1) % delayFrames;
    }
}

Engine::Engine()
    : context_(nullptr)
    , device_(nullptr)
    , visualizerRing_(nullptr)
    , spectrumRing_(nullptr)
    , currentFrameIndex_(0)
    , durationSeconds_(0.0)
    , playbackState_(static_cast<int>(PlaybackState::Stopped))
    , gaplessTransitionFlag_(false)
    , needsDeferredStop_(false)
    , exclusiveModeRequested_(false)
    , exclusiveModeActive_(false)
    , volume_(0.7f)
    , muted_(false)
    , normalizationGain_(1.0f)
    , dspEnabled_(true)
    , multichannelEnabled_(false)
    , analysisDelayMs_(0)
    , currentTrackChannels_(0)
    , currentSampleRate_(0)
    , deviceInternalSampleRate_(0)
    , outputMaxChannels_(2)
    , contextInitialized_(false)
    , deviceInitialized_(false)
    , eqPreampDB_(0.0f)
    , eqPreampLinear_(1.0f)
    , eqEnabled_(false) {}

Engine::~Engine() {
    shutdown();
}

bool Engine::initialize() {
    std::lock_guard<std::mutex> lock(mutex_);
    return initContextLocked();
}

void Engine::shutdown() {
    std::lock_guard<std::mutex> lock(mutex_);
    uninitDeviceLocked();
    currentAudio_.clear();
    nextAudio_.clear();
    eqFiltersByChannel_.clear();
    mappedFrameScratch_.clear();
    activeDeviceConfig_ = {};
    clearAnalysisRingsLocked();
    uninitContextLocked();
}

bool Engine::loadFromMemory(const void* data, size_t size) {
    if (data == nullptr || size == 0) {
        return false;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    if (!initContextLocked()) {
        return false;
    }

    DecodedAudio decoded;
    if (!decodeAudioData(data, size, decoded)) {
        return false;
    }

    pumpDeferredDeviceStop();
    PlaybackState state = static_cast<PlaybackState>(playbackState_.load(std::memory_order_relaxed));
    bool wasPlaying = state == PlaybackState::Playing;
    uninitDeviceLocked();

    currentAudio_ = std::move(decoded);
    nextAudio_.clear();
    currentFrameIndex_.store(0, std::memory_order_relaxed);
    currentTrackChannels_.store(currentAudio_.channels, std::memory_order_relaxed);
    currentSampleRate_.store(currentAudio_.sampleRate, std::memory_order_relaxed);
    durationSeconds_.store(currentAudio_.durationSeconds(), std::memory_order_relaxed);
    playbackState_.store(static_cast<int>(PlaybackState::Stopped), std::memory_order_relaxed);
    gaplessTransitionFlag_.store(false, std::memory_order_relaxed);
    needsDeferredStop_.store(false, std::memory_order_relaxed);

    clearAnalysisRingsLocked();
    rebuildEqFiltersLocked();

    if (wasPlaying) {
        playbackState_.store(static_cast<int>(PlaybackState::Paused), std::memory_order_relaxed);
    }

    return true;
}

bool Engine::preBufferFromMemory(const void* data, size_t size) {
    if (data == nullptr || size == 0) {
        return false;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    if (!initContextLocked()) {
        return false;
    }

    DecodedAudio decoded;
    if (!decodeAudioData(data, size, decoded)) {
        return false;
    }

    nextAudio_ = std::move(decoded);
    return true;
}

void Engine::clearNextBuffer() {
    std::lock_guard<std::mutex> lock(mutex_);
    nextAudio_.clear();
}

bool Engine::play() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (currentAudio_.empty()) {
        return false;
    }

    pumpDeferredDeviceStop();

    if (currentFrameIndex_.load(std::memory_order_relaxed) >= currentAudio_.frameCount) {
        currentFrameIndex_.store(0, std::memory_order_relaxed);
    }

    if (!ensureDeviceReadyLocked(true)) {
        return false;
    }

    if (device_ != nullptr && ma_device_start(device_) != MA_SUCCESS) {
        return false;
    }

    playbackState_.store(static_cast<int>(PlaybackState::Playing), std::memory_order_relaxed);
    return true;
}

void Engine::pause() {
    std::lock_guard<std::mutex> lock(mutex_);
    pumpDeferredDeviceStop();
    if (deviceInitialized_ && device_ != nullptr) {
        ma_device_stop(device_);
    }
    if (!currentAudio_.empty()) {
        playbackState_.store(static_cast<int>(PlaybackState::Paused), std::memory_order_relaxed);
    }
}

void Engine::stop() {
    std::lock_guard<std::mutex> lock(mutex_);
    pumpDeferredDeviceStop();
    if (deviceInitialized_ && device_ != nullptr) {
        ma_device_stop(device_);
    }
    currentFrameIndex_.store(0, std::memory_order_relaxed);
    playbackState_.store(static_cast<int>(PlaybackState::Stopped), std::memory_order_relaxed);
}

void Engine::seek(double seconds) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (currentAudio_.empty()) {
        return;
    }

    if (!std::isfinite(seconds)) {
        seconds = 0.0;
    }
    double clamped = std::max(0.0, std::min(seconds, currentAudio_.durationSeconds()));
    uint64_t targetFrame = static_cast<uint64_t>(clamped * static_cast<double>(currentAudio_.sampleRate));
    currentFrameIndex_.store(std::min<uint64_t>(targetFrame, currentAudio_.frameCount), std::memory_order_relaxed);
}

double Engine::getPosition() {
    // Lock-free: uses atomics only. No mutex needed.
    uint32_t sampleRate = currentSampleRate_.load(std::memory_order_relaxed);
    if (sampleRate == 0) {
        return 0.0;
    }
    return static_cast<double>(currentFrameIndex_.load(std::memory_order_relaxed)) / static_cast<double>(sampleRate);
}

double Engine::getDuration() const {
    return durationSeconds_.load(std::memory_order_relaxed);
}

PlaybackState Engine::getState() {
    // Lock-free: playbackState_ is atomic.
    // Pump deferred stop only when there's actually work to do (atomic check is cheap).
    if (needsDeferredStop_.load(std::memory_order_relaxed)) {
        std::lock_guard<std::mutex> lock(mutex_);
        pumpDeferredDeviceStop();
    }
    return static_cast<PlaybackState>(playbackState_.load(std::memory_order_relaxed));
}

void Engine::setVolume(float value) {
    volume_.store(clampUnit(value), std::memory_order_relaxed);
}

void Engine::setMuted(bool muted) {
    muted_.store(muted, std::memory_order_relaxed);
}

void Engine::setExclusiveMode(bool enabled) {
    std::lock_guard<std::mutex> lock(mutex_);
    exclusiveModeRequested_.store(enabled, std::memory_order_relaxed);
    if (!enabled) {
        exclusiveModeActive_.store(false, std::memory_order_relaxed);
    }
    if (!currentAudio_.empty()) {
        PlaybackState state = static_cast<PlaybackState>(playbackState_.load(std::memory_order_relaxed));
        reconfigureDeviceLocked(state == PlaybackState::Playing, true);
    }
}

bool Engine::isExclusiveModeActive() const {
    return exclusiveModeActive_.load(std::memory_order_relaxed);
}

void Engine::setDspEnabled(bool enabled) {
    dspEnabled_.store(enabled, std::memory_order_relaxed);
}

void Engine::setNormalizationGain(float linearGain) {
    if (!std::isfinite(linearGain) || linearGain <= 0.0f) {
        linearGain = 1.0f;
    }
    normalizationGain_.store(linearGain, std::memory_order_relaxed);
}

void Engine::setAnalysisDelayMs(uint32_t delayMs) {
    std::lock_guard<std::mutex> lock(mutex_);
    analysisDelayMs_.store(delayMs, std::memory_order_relaxed);
    uint32_t sampleRate = currentSampleRate_.load(std::memory_order_relaxed);
    if (sampleRate == 0) {
        sampleRate = currentAudio_.sampleRate == 0 ? 48000 : currentAudio_.sampleRate;
    }
    syncAnalysisDelayBuffersLocked(sampleRate);
    visualizerDelayBuffer_.reset();
    spectrumDelayBuffer_.reset();
}

void Engine::setMultichannelEnabled(bool enabled) {
    std::lock_guard<std::mutex> lock(mutex_);
    multichannelEnabled_.store(enabled, std::memory_order_relaxed);
    if (!currentAudio_.empty() && !exclusiveModeRequested_.load(std::memory_order_relaxed)) {
        PlaybackState state = static_cast<PlaybackState>(playbackState_.load(std::memory_order_relaxed));
        reconfigureDeviceLocked(state == PlaybackState::Playing, true);
    }
}

void Engine::setChannelRoutingMap(const std::vector<int>& map) {
    std::lock_guard<std::mutex> lock(mutex_);
    channelRoutingMap_ = map;
    if (!currentAudio_.empty() && !exclusiveModeRequested_.load(std::memory_order_relaxed)) {
        PlaybackState state = static_cast<PlaybackState>(playbackState_.load(std::memory_order_relaxed));
        reconfigureDeviceLocked(state == PlaybackState::Playing, true);
    }
}

void Engine::updateEQ(const std::vector<EQBandConfig>& bands, float preampDB, bool enabled) {
    std::lock_guard<std::mutex> lock(mutex_);
    eqBands_ = bands;
    eqPreampDB_ = std::isfinite(preampDB) ? preampDB : 0.0f;
    eqPreampLinear_ = enabled ? dbToLinear(eqPreampDB_) : 1.0f;
    eqEnabled_ = enabled;
    rebuildEqFiltersLocked();
}

std::vector<DeviceInfo> Engine::enumerateDevices() {
    std::lock_guard<std::mutex> lock(mutex_);
    return enumerateDevicesLocked();
}

std::vector<DeviceInfo> Engine::enumerateDevicesLocked() {
    std::vector<DeviceInfo> out;
    if (!initContextLocked() || context_ == nullptr) {
        return out;
    }

    ma_device_info* playbackInfos = nullptr;
    ma_uint32 playbackCount = 0;
    if (ma_context_get_devices(context_, &playbackInfos, &playbackCount, nullptr, nullptr) != MA_SUCCESS || playbackInfos == nullptr) {
        return out;
    }

    uint32_t selectedMaxChannels = 2;
    const std::string selectedDeviceId = hasSelectedDevice_ ? selectedDeviceId_ : std::string();

    out.reserve(playbackCount);
    for (ma_uint32 i = 0; i < playbackCount; ++i) {
        ma_device_info detailedInfo = playbackInfos[i];
        ma_context_get_device_info(context_, ma_device_type_playback, &playbackInfos[i].id, &detailedInfo);

        uint32_t maxChannels = 2;
        if (detailedInfo.nativeDataFormatCount > 0) {
            for (ma_uint32 fmtIndex = 0; fmtIndex < detailedInfo.nativeDataFormatCount; ++fmtIndex) {
                maxChannels = std::max<uint32_t>(maxChannels, detailedInfo.nativeDataFormats[fmtIndex].channels);
            }
        } else if (detailedInfo.isDefault) {
            maxChannels = std::max<uint32_t>(maxChannels, outputMaxChannels_.load(std::memory_order_relaxed));
        }

        DeviceInfo info;
        info.deviceId = encodeDeviceId(playbackInfos[i].id);
        info.label = detailedInfo.name;
        info.groupId = "";
        info.isDefaultAlias = detailedInfo.isDefault == MA_TRUE;
        info.maxChannels = maxChannels;
        info.supportsExclusive = true;
        out.push_back(info);

        if ((selectedDeviceId.empty() && info.isDefaultAlias) || (!selectedDeviceId.empty() && selectedDeviceId == info.deviceId)) {
            selectedMaxChannels = maxChannels;
        }
    }

    outputMaxChannels_.store(std::max<uint32_t>(1, selectedMaxChannels), std::memory_order_relaxed);
    return out;
}

bool Engine::selectDevice(const std::string& deviceId) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (deviceId.empty()) {
        hasSelectedDevice_ = false;
        selectedDeviceId_.clear();
        enumerateDevicesLocked();
        if (!currentAudio_.empty()) {
            PlaybackState state = static_cast<PlaybackState>(playbackState_.load(std::memory_order_relaxed));
            reconfigureDeviceLocked(state == PlaybackState::Playing, true);
        }
        return true;
    }

    ma_device_id parsedId{};
    if (!decodeDeviceId(deviceId, parsedId)) {
        return false;
    }

    hasSelectedDevice_ = true;
    selectedDeviceId_ = deviceId;
    enumerateDevicesLocked();

    if (!currentAudio_.empty()) {
        PlaybackState state = static_cast<PlaybackState>(playbackState_.load(std::memory_order_relaxed));
        reconfigureDeviceLocked(state == PlaybackState::Playing, true);
    }

    return true;
}

uint32_t Engine::getOutputMaxChannelCount() {
    return std::max<uint32_t>(1, outputMaxChannels_.load(std::memory_order_relaxed));
}

uint32_t Engine::getCurrentTrackChannelCount() const {
    return currentTrackChannels_.load(std::memory_order_relaxed);
}

uint32_t Engine::getSampleRate() const {
    uint32_t sampleRate = currentSampleRate_.load(std::memory_order_relaxed);
    return sampleRate == 0 ? 48000 : sampleRate;
}

uint32_t Engine::getDeviceSampleRate() const {
    return deviceInternalSampleRate_.load(std::memory_order_relaxed);
}

VisualizerSamples Engine::readVisualizerSamples(uint32_t maxFrames) {
    // Lock-free: ma_pcm_rb is a SPSC ring buffer, safe for concurrent read/write.
    VisualizerSamples out;
    if (visualizerRing_ == nullptr || maxFrames == 0) {
        return out;
    }

    std::vector<float> interleaved(static_cast<size_t>(maxFrames) * 3);
    ma_uint32 framesRead = visualizerRing_->read(interleaved.data(), maxFrames);
    out.count = framesRead;
    out.mono.resize(framesRead);
    out.left.resize(framesRead);
    out.right.resize(framesRead);

    for (ma_uint32 i = 0; i < framesRead; ++i) {
        out.mono[i] = interleaved[static_cast<size_t>(i) * 3 + 0];
        out.left[i] = interleaved[static_cast<size_t>(i) * 3 + 1];
        out.right[i] = interleaved[static_cast<size_t>(i) * 3 + 2];
    }

    return out;
}

SpectrumSamples Engine::readPostEqSpectrumSamples(uint32_t maxFrames) {
    // Lock-free: ma_pcm_rb is a SPSC ring buffer, safe for concurrent read/write.
    SpectrumSamples out;
    if (spectrumRing_ == nullptr || maxFrames == 0) {
        return out;
    }

    out.mono.resize(maxFrames);
    ma_uint32 framesRead = spectrumRing_->read(out.mono.data(), maxFrames);
    out.count = framesRead;
    out.mono.resize(framesRead);
    return out;
}

DecodedSamples Engine::getDecodedSamples() const {
    std::lock_guard<std::mutex> lock(mutex_);
    DecodedSamples out;
    out.samples = currentAudio_.samples;
    out.channels = currentAudio_.channels;
    out.sampleRate = currentAudio_.sampleRate;
    return out;
}

bool Engine::didGaplessTransition() {
    return gaplessTransitionFlag_.exchange(false, std::memory_order_relaxed);
}

bool Engine::initContextLocked() {
    if (contextInitialized_) {
        return true;
    }

    if (context_ == nullptr) {
        context_ = new ma_context();
    }
    if (device_ == nullptr) {
        device_ = new ma_device();
    }
    if (visualizerRing_ == nullptr) {
        visualizerRing_ = new PcmRing();
    }
    if (spectrumRing_ == nullptr) {
        spectrumRing_ = new PcmRing();
    }

    ma_context_config config = ma_context_config_init();

    ma_result result = ma_context_init(
        std::size(kPreferredBackends) > 0 ? kPreferredBackends : nullptr,
        static_cast<ma_uint32>(std::size(kPreferredBackends)),
        &config,
        context_
    );
    if (result != MA_SUCCESS) {
        return false;
    }

    if (!visualizerRing_->init(3, kVisualizerRingFrames) || !spectrumRing_->init(1, kSpectrumRingFrames)) {
        ma_context_uninit(context_);
        contextInitialized_ = false;
        return false;
    }

    contextInitialized_ = true;
    clearAnalysisRingsLocked();
    return true;
}

void Engine::uninitContextLocked() {
    if (visualizerRing_ != nullptr) {
        visualizerRing_->uninit();
        delete visualizerRing_;
        visualizerRing_ = nullptr;
    }
    if (spectrumRing_ != nullptr) {
        spectrumRing_->uninit();
        delete spectrumRing_;
        spectrumRing_ = nullptr;
    }

    if (contextInitialized_ && context_ != nullptr) {
        ma_context_uninit(context_);
    }
    contextInitialized_ = false;

    if (context_ != nullptr) {
        delete context_;
        context_ = nullptr;
    }
    if (device_ != nullptr) {
        delete device_;
        device_ = nullptr;
    }
}

bool Engine::ensureDeviceReadyLocked(bool allowExclusiveFallback) {
    if (currentAudio_.empty()) {
        return false;
    }
    if (!initContextLocked() || device_ == nullptr) {
        return false;
    }

    DeviceConfigSignature desired;
    desired.deviceId = hasSelectedDevice_ ? selectedDeviceId_ : std::string();
    desired.sampleRate = currentAudio_.sampleRate;
    desired.outputChannels = resolveOutputChannelsLocked();
    desired.exclusive = exclusiveModeRequested_.load(std::memory_order_relaxed);

    if (deviceInitialized_ && desired == activeDeviceConfig_) {
        return true;
    }

    PlaybackState state = static_cast<PlaybackState>(playbackState_.load(std::memory_order_relaxed));
    bool wasPlaying = state == PlaybackState::Playing;
    reconfigureDeviceLocked(wasPlaying, allowExclusiveFallback);
    return deviceInitialized_;
}

void Engine::uninitDeviceLocked() {
    if (deviceInitialized_ && device_ != nullptr) {
        ma_device_stop(device_);
        ma_device_uninit(device_);
    }
    deviceInitialized_ = false;
    exclusiveModeActive_.store(false, std::memory_order_relaxed);
    deviceInternalSampleRate_.store(0, std::memory_order_relaxed);
    activeDeviceConfig_ = {};
}

void Engine::reconfigureDeviceLocked(bool restartIfPlaying, bool allowExclusiveFallback) {
    pumpDeferredDeviceStop();
    uninitDeviceLocked();

    if (currentAudio_.empty() || device_ == nullptr) {
        return;
    }

    ma_device_config config = ma_device_config_init(ma_device_type_playback);
    config.sampleRate = currentAudio_.sampleRate;
    config.playback.format = ma_format_f32;
    config.playback.channels = resolveOutputChannelsLocked();
    config.dataCallback = Engine::dataCallback;
    config.pUserData = this;
    config.performanceProfile = ma_performance_profile_low_latency;
    config.noPreSilencedOutputBuffer = MA_TRUE;
    config.noClip = MA_TRUE;
    config.periodSizeInMilliseconds = kDefaultPeriodMs;
    config.periods = 2;
#if defined(MA_HAS_COREAUDIO)
    config.coreaudio.allowNominalSampleRateChange = MA_TRUE;
#endif
    ma_device_id selectedId{};
    const ma_device_id* pSelectedId = nullptr;
    if (hasSelectedDevice_) {
        if (decodeDeviceId(selectedDeviceId_, selectedId)) {
            config.playback.pDeviceID = &selectedId;
            pSelectedId = &selectedId;
        }
    }

    // Query the device's actual native sample rate BEFORE opening.
    // On WASAPI shared, ma_device reports our requested rate, not the real hardware rate.
    // ma_context_get_device_info returns the device's preferred/mix format which IS the real rate.
    uint32_t nativeDeviceRate = 0;
    {
        ma_device_info deviceInfo{};
        ma_result infoResult = ma_context_get_device_info(
            context_, ma_device_type_playback, pSelectedId, &deviceInfo);
        if (infoResult == MA_SUCCESS && deviceInfo.nativeDataFormatCount > 0) {
            nativeDeviceRate = deviceInfo.nativeDataFormats[0].sampleRate;
            fprintf(stderr, "[NativeAudio] device native rate: %u Hz (%s)\n",
                nativeDeviceRate, deviceInfo.name);
        }
    }

    bool requestedExclusive = exclusiveModeRequested_.load(std::memory_order_relaxed);
    ma_result result = MA_ERROR;

    if (requestedExclusive) {
        // Exclusive mode: tell WASAPI not to resample — we want the real device rate.
        // Also disable channel conversion and SRC to get true bit-perfect output.
#if defined(MA_HAS_WASAPI)
        config.wasapi.noAutoConvertSRC = MA_TRUE;
        config.wasapi.noDefaultQualitySRC = MA_TRUE;
        config.wasapi.noAutoStreamRouting = MA_TRUE;
#endif

        // Attempt 1: exclusive with file's native sample rate
        config.playback.shareMode = ma_share_mode_exclusive;
        config.sampleRate = currentAudio_.sampleRate;
        result = ma_device_init(context_, &config, device_);
        fprintf(stderr, "[NativeAudio] exclusive init @ %u Hz, %u ch: %s\n",
            currentAudio_.sampleRate, config.playback.channels,
            result == MA_SUCCESS ? "OK" : "FAILED");

        if (result != MA_SUCCESS) {
            // Attempt 2: exclusive with common sample rates the device is likely to support
            static constexpr ma_uint32 kFallbackRates[] = { 48000, 44100, 96000, 192000 };
            for (ma_uint32 rate : kFallbackRates) {
                if (rate == currentAudio_.sampleRate) continue;
                config.sampleRate = rate;
                result = ma_device_init(context_, &config, device_);
                fprintf(stderr, "[NativeAudio] exclusive fallback @ %u Hz: %s\n",
                    rate, result == MA_SUCCESS ? "OK" : "FAILED");
                if (result == MA_SUCCESS) break;
            }
        }

        if (result == MA_SUCCESS) {
            exclusiveModeActive_.store(true, std::memory_order_relaxed);
        } else if (allowExclusiveFallback) {
            // Attempt 3: fall back to shared mode (with SRC disabled so we see the real behavior)
            config.playback.shareMode = ma_share_mode_shared;
            config.sampleRate = currentAudio_.sampleRate;
#if defined(MA_HAS_WASAPI)
            // Keep noAutoConvertSRC = TRUE in shared mode too:
            // If the device can't handle the file's rate natively, the init will fail,
            // and we fall through to the final shared attempt with SRC enabled.
#endif
            result = ma_device_init(context_, &config, device_);
            fprintf(stderr, "[NativeAudio] shared fallback (no SRC) @ %u Hz: %s\n",
                currentAudio_.sampleRate, result == MA_SUCCESS ? "OK" : "FAILED");

            if (result != MA_SUCCESS) {
                // Final attempt: shared with Windows SRC enabled (guaranteed to work)
#if defined(MA_HAS_WASAPI)
                config.wasapi.noAutoConvertSRC = MA_FALSE;
                config.wasapi.noDefaultQualitySRC = MA_FALSE;
#endif
                result = ma_device_init(context_, &config, device_);
                fprintf(stderr, "[NativeAudio] shared fallback (with SRC) @ %u Hz: %s\n",
                    currentAudio_.sampleRate, result == MA_SUCCESS ? "OK" : "FAILED");
            }
            exclusiveModeActive_.store(false, std::memory_order_relaxed);
        } else {
            exclusiveModeActive_.store(false, std::memory_order_relaxed);
        }
    } else {
        // Native shared mode: disable Windows auto-SRC so the device runs at its native rate.
        // Our callback still delivers audio at the file's sample rate — miniaudio handles
        // the conversion between callback rate and device rate internally.
#if defined(MA_HAS_WASAPI)
        config.wasapi.noAutoConvertSRC = MA_TRUE;
        config.wasapi.noDefaultQualitySRC = MA_TRUE;
#endif
        config.playback.shareMode = ma_share_mode_shared;
        result = ma_device_init(context_, &config, device_);
        fprintf(stderr, "[NativeAudio] shared init (no SRC) @ %u Hz, %u ch: %s\n",
            currentAudio_.sampleRate, config.playback.channels,
            result == MA_SUCCESS ? "OK" : "FAILED");

        if (result != MA_SUCCESS) {
            // Fallback: let Windows handle SRC (guaranteed to work)
#if defined(MA_HAS_WASAPI)
            config.wasapi.noAutoConvertSRC = MA_FALSE;
            config.wasapi.noDefaultQualitySRC = MA_FALSE;
#endif
            result = ma_device_init(context_, &config, device_);
            fprintf(stderr, "[NativeAudio] shared init (with SRC) @ %u Hz, %u ch: %s\n",
                currentAudio_.sampleRate, config.playback.channels,
                result == MA_SUCCESS ? "OK" : "FAILED");
        }
        exclusiveModeActive_.store(false, std::memory_order_relaxed);
    }

    if (result != MA_SUCCESS) {
        deviceInitialized_ = false;
        activeDeviceConfig_ = {};
        return;
    }

    deviceInitialized_ = true;
    currentSampleRate_.store(device_->sampleRate, std::memory_order_relaxed);
    outputMaxChannels_.store(std::max<uint32_t>(1, device_->playback.channels), std::memory_order_relaxed);

    // For exclusive mode, the device IS running at device->sampleRate (we own it).
    // For shared mode, the OS may or may not resample — use the queried native rate
    // as the ground truth for what the hardware is actually doing.
    bool isExclusive = exclusiveModeActive_.load(std::memory_order_relaxed);
    uint32_t realDeviceRate = isExclusive
        ? device_->sampleRate
        : (nativeDeviceRate > 0 ? nativeDeviceRate : device_->sampleRate);
    deviceInternalSampleRate_.store(realDeviceRate, std::memory_order_relaxed);

    fprintf(stderr, "[NativeAudio] device ready: callback=%u Hz, device=%u Hz, %u ch, %s\n",
        device_->sampleRate, realDeviceRate,
        device_->playback.channels,
        isExclusive ? "exclusive" : "shared");

    activeDeviceConfig_.deviceId = hasSelectedDevice_ ? selectedDeviceId_ : std::string();
    activeDeviceConfig_.sampleRate = device_->sampleRate;
    activeDeviceConfig_.outputChannels = device_->playback.channels;
    activeDeviceConfig_.exclusive = exclusiveModeActive_.load(std::memory_order_relaxed);

    // Pre-allocate scratch buffers for audio callback (avoid RT heap allocs)
    callbackMaxFrames_ = std::max<uint32_t>(kCallbackScratchMaxFrames,
        device_->playback.internalPeriodSizeInFrames * 2);
    callbackVisualizerScratch_.resize(static_cast<size_t>(callbackMaxFrames_) * 3);
    callbackSpectrumScratch_.resize(callbackMaxFrames_);
    mappedFrameScratch_.resize(device_->playback.channels);
    delayedVisualizerFramesScratch_.resize(static_cast<size_t>(callbackMaxFrames_) * 3);
    delayedSpectrumFramesScratch_.resize(callbackMaxFrames_);

    rebuildEqFiltersLocked();

    if (restartIfPlaying) {
        ma_device_start(device_);
        playbackState_.store(static_cast<int>(PlaybackState::Playing), std::memory_order_relaxed);
    }
}

void Engine::rebuildEqFiltersLocked() {
    uint32_t channelCount = activeDeviceConfig_.outputChannels > 0
        ? activeDeviceConfig_.outputChannels
        : resolveOutputChannelsForAudio(currentAudio_);
    uint32_t sampleRate = currentSampleRate_.load(std::memory_order_relaxed);
    if (sampleRate == 0) {
        sampleRate = currentAudio_.sampleRate;
    }
    if (sampleRate == 0 || channelCount == 0) {
        eqFiltersByChannel_.clear();
        return;
    }

    if (!eqEnabled_ || eqBands_.empty()) {
        eqFiltersByChannel_.clear();
        eqPreampLinear_ = 1.0f;
        return;
    }

    eqPreampLinear_ = dbToLinear(eqPreampDB_);
    eqFiltersByChannel_.assign(channelCount, std::vector<DSP::BiquadFilter>(eqBands_.size()));
    for (uint32_t channel = 0; channel < channelCount; ++channel) {
        for (size_t bandIndex = 0; bandIndex < eqBands_.size(); ++bandIndex) {
            DSP::BiquadFilter& filter = eqFiltersByChannel_[channel][bandIndex];
            const EQBandConfig& band = eqBands_[bandIndex];
            switch (band.type) {
                case EQBandType::LowShelf:
                    filter.setLowShelf(band.frequency, static_cast<float>(sampleRate), band.gainDB, band.q);
                    break;
                case EQBandType::Peaking:
                    filter.setPeaking(band.frequency, static_cast<float>(sampleRate), band.gainDB, band.q);
                    break;
                case EQBandType::HighShelf:
                    filter.setHighShelf(band.frequency, static_cast<float>(sampleRate), band.gainDB, band.q);
                    break;
            }
        }
    }
}

void Engine::clearAnalysisRingsLocked() {
    uint32_t sampleRate = currentAudio_.sampleRate == 0 ? 48000 : currentAudio_.sampleRate;
    if (visualizerRing_ != nullptr) {
        visualizerRing_->reset();
        visualizerRing_->setSampleRate(sampleRate);
    }
    if (spectrumRing_ != nullptr) {
        spectrumRing_->reset();
        spectrumRing_->setSampleRate(sampleRate);
    }

    syncAnalysisDelayBuffersLocked(sampleRate);
    visualizerDelayBuffer_.reset();
    spectrumDelayBuffer_.reset();
}

uint32_t Engine::getAnalysisDelayFramesLocked(uint32_t sampleRate) const {
    uint32_t safeSampleRate = sampleRate == 0 ? 48000 : sampleRate;
    uint32_t delayMs = analysisDelayMs_.load(std::memory_order_relaxed);
    if (delayMs == 0) {
        return 0;
    }

    double delayFrames = (static_cast<double>(safeSampleRate) * static_cast<double>(delayMs)) / 1000.0;
    if (!std::isfinite(delayFrames) || delayFrames <= 0.0) {
        return 0;
    }

    return static_cast<uint32_t>(std::llround(delayFrames));
}

void Engine::syncAnalysisDelayBuffersLocked(uint32_t sampleRate) {
    uint32_t delayFrames = getAnalysisDelayFramesLocked(sampleRate);
    visualizerDelayBuffer_.configure(3, delayFrames);
    spectrumDelayBuffer_.configure(1, delayFrames);
}

uint32_t Engine::resolveOutputChannelsLocked() const {
    return resolveOutputChannelsForAudio(currentAudio_);
}

uint32_t Engine::resolveOutputChannelsForAudio(const DecodedAudio& audio) const {
    return resolveOutputChannelsForChannels(audio.channels == 0 ? 2 : audio.channels);
}

uint32_t Engine::resolveOutputChannelsForChannels(uint32_t sourceChannels) const {
    sourceChannels = std::max<uint32_t>(1, sourceChannels);

    if (exclusiveModeRequested_.load(std::memory_order_relaxed)) {
        return clampOutputChannelsLocked(sourceChannels);
    }

    if (!multichannelEnabled_.load(std::memory_order_relaxed)) {
        return clampOutputChannelsLocked(std::min<uint32_t>(2, sourceChannels));
    }

    if (!channelRoutingMap_.empty()) {
        return clampOutputChannelsLocked(static_cast<uint32_t>(channelRoutingMap_.size()));
    }

    return clampOutputChannelsLocked(sourceChannels);
}

uint32_t Engine::clampOutputChannelsLocked(uint32_t requestedChannels) const {
    uint32_t maxChannels = outputMaxChannels_.load(std::memory_order_relaxed);
    if (maxChannels == 0) {
        maxChannels = 2;
    }
    return std::max<uint32_t>(1, std::min(requestedChannels, maxChannels));
}

bool Engine::decodeAudioData(const void* data, size_t size, DecodedAudio& decoded) const {
    std::vector<ma_uint8> ownedBytes(size);
    std::memcpy(ownedBytes.data(), data, size);

    ma_decoder_config decoderConfig = ma_decoder_config_init(ma_format_f32, 0, 0);
    ma_decoder decoder;
    if (ma_decoder_init_memory(ownedBytes.data(), ownedBytes.size(), &decoderConfig, &decoder) != MA_SUCCESS) {
        return false;
    }

    ma_format format = ma_format_unknown;
    ma_uint32 channels = 0;
    ma_uint32 sampleRate = 0;
    if (ma_decoder_get_data_format(&decoder, &format, &channels, &sampleRate, nullptr, 0) != MA_SUCCESS || channels == 0 || sampleRate == 0) {
        ma_decoder_uninit(&decoder);
        return false;
    }

    decoded.clear();
    decoded.channels = channels;
    decoded.sampleRate = sampleRate;

    ma_uint64 totalFrames = 0;
    if (ma_decoder_get_length_in_pcm_frames(&decoder, &totalFrames) == MA_SUCCESS && totalFrames > 0) {
        decoded.samples.resize(static_cast<size_t>(totalFrames) * channels);
        ma_uint64 totalRead = 0;
        while (totalRead < totalFrames) {
            ma_uint64 framesToRead = totalFrames - totalRead;
            ma_uint64 framesRead = 0;
            if (ma_decoder_read_pcm_frames(
                    &decoder,
                    decoded.samples.data() + (static_cast<size_t>(totalRead) * channels),
                    framesToRead,
                    &framesRead
                ) != MA_SUCCESS || framesRead == 0) {
                break;
            }
            totalRead += framesRead;
        }

        decoded.samples.resize(static_cast<size_t>(totalRead) * channels);
        decoded.frameCount = totalRead;
    } else {
        std::vector<float> chunk(static_cast<size_t>(kDecodeChunkFrames) * channels);
        while (true) {
            ma_uint64 framesRead = 0;
            if (ma_decoder_read_pcm_frames(&decoder, chunk.data(), kDecodeChunkFrames, &framesRead) != MA_SUCCESS || framesRead == 0) {
                break;
            }

            size_t insertCount = static_cast<size_t>(framesRead) * channels;
            decoded.samples.insert(decoded.samples.end(), chunk.begin(), chunk.begin() + insertCount);
            decoded.frameCount += framesRead;
        }
    }

    ma_decoder_uninit(&decoder);
    return decoded.frameCount > 0;
}

void Engine::pumpDeferredDeviceStop() {
    if (!needsDeferredStop_.exchange(false, std::memory_order_relaxed)) {
        return;
    }

    if (deviceInitialized_ && device_ != nullptr) {
        ma_device_stop(device_);
    }
}

void Engine::onPlaybackEndedInCallback() {
    playbackState_.store(static_cast<int>(PlaybackState::Stopped), std::memory_order_relaxed);
    needsDeferredStop_.store(true, std::memory_order_relaxed);
}

void Engine::dataCallback(ma_device* device, void* output, const void* /*input*/, uint32_t frameCount) {
    if (device == nullptr || device->pUserData == nullptr || output == nullptr) {
        return;
    }

    Engine* engine = reinterpret_cast<Engine*>(device->pUserData);
    engine->handleDataCallback(reinterpret_cast<float*>(output), frameCount);
}

void Engine::handleDataCallback(float* output, uint32_t frameCount) {
    // Determine output channels from device (safe - device_ is stable while callback runs)
    uint32_t outputChannels = device_ != nullptr
        ? device_->playback.channels
        : 2;
    outputChannels = std::max<uint32_t>(1, outputChannels);

    // Zero output first (silence by default)
    std::memset(output, 0, static_cast<size_t>(frameCount) * outputChannels * sizeof(float));

    // Non-blocking lock: if the UI thread holds the mutex (loading, EQ update, etc.),
    // we output silence rather than blocking the real-time audio thread.
    std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
    if (!lock.owns_lock()) {
        return;
    }

    if (static_cast<PlaybackState>(playbackState_.load(std::memory_order_relaxed)) != PlaybackState::Playing || currentAudio_.empty()) {
        return;
    }

    // Use pre-allocated scratch buffers; cap frameCount to avoid overflow
    uint32_t safeFrameCount = std::min(frameCount, callbackMaxFrames_);
    if (safeFrameCount == 0 || mappedFrameScratch_.size() < outputChannels) {
        return;
    }

    float* visualizerFrames = callbackVisualizerScratch_.data();
    float* spectrumFrames = callbackSpectrumScratch_.data();
    ma_uint32 producedFrames = 0;

    bool dspEnabled = dspEnabled_.load(std::memory_order_relaxed);
    bool exclusiveActive = exclusiveModeActive_.load(std::memory_order_relaxed);
    float normalization = dspEnabled ? normalizationGain_.load(std::memory_order_relaxed) : 1.0f;
    float volume = exclusiveActive ? 1.0f : volume_.load(std::memory_order_relaxed);
    bool muted = exclusiveActive ? false : muted_.load(std::memory_order_relaxed);
    float gain = muted ? 0.0f : volume;

    for (ma_uint32 frame = 0; frame < safeFrameCount; ++frame) {
        uint64_t frameIndex = currentFrameIndex_.load(std::memory_order_relaxed);
        if (frameIndex >= currentAudio_.frameCount) {
            bool canGapless = !nextAudio_.empty()
                && nextAudio_.sampleRate == currentAudio_.sampleRate
                && resolveOutputChannelsForAudio(nextAudio_) == outputChannels;

            if (canGapless) {
                currentAudio_ = std::move(nextAudio_);
                nextAudio_.clear();
                currentFrameIndex_.store(0, std::memory_order_relaxed);
                currentTrackChannels_.store(currentAudio_.channels, std::memory_order_relaxed);
                currentSampleRate_.store(currentAudio_.sampleRate, std::memory_order_relaxed);
                durationSeconds_.store(currentAudio_.durationSeconds(), std::memory_order_relaxed);
                gaplessTransitionFlag_.store(true, std::memory_order_relaxed);
                clearAnalysisRingsLocked();
                rebuildEqFiltersLocked();
                frameIndex = 0;
            } else {
                onPlaybackEndedInCallback();
                break;
            }
        }

        const float* sourceFrame = currentAudio_.samples.data() + (static_cast<size_t>(frameIndex) * currentAudio_.channels);
        float left = sourceFrame[0];
        float right = currentAudio_.channels > 1 ? sourceFrame[1] : left;
        float mono = (left + right) * 0.5f;

        float analyzedLeft = left * normalization;
        float analyzedRight = right * normalization;
        float analyzedMono = mono * normalization;

        visualizerFrames[static_cast<size_t>(producedFrames) * 3 + 0] = analyzedMono;
        visualizerFrames[static_cast<size_t>(producedFrames) * 3 + 1] = analyzedLeft;
        visualizerFrames[static_cast<size_t>(producedFrames) * 3 + 2] = analyzedRight;

        std::fill_n(mappedFrameScratch_.data(), outputChannels, 0.0f);

        if (exclusiveModeRequested_.load(std::memory_order_relaxed)) {
            for (uint32_t outputChannel = 0; outputChannel < outputChannels; ++outputChannel) {
                uint32_t sourceIndex = std::min<uint32_t>(outputChannel, currentAudio_.channels - 1);
                mappedFrameScratch_[outputChannel] = sourceFrame[sourceIndex];
            }
        } else if (!multichannelEnabled_.load(std::memory_order_relaxed)) {
            if (outputChannels >= 1) mappedFrameScratch_[0] = sourceFrame[0];
            if (outputChannels >= 2) mappedFrameScratch_[1] = currentAudio_.channels > 1 ? sourceFrame[1] : sourceFrame[0];
        } else if (!channelRoutingMap_.empty()) {
            for (uint32_t outputChannel = 0; outputChannel < outputChannels; ++outputChannel) {
                int mappedIndex = outputChannel < channelRoutingMap_.size() ? channelRoutingMap_[outputChannel] : -1;
                if (mappedIndex >= 0 && static_cast<uint32_t>(mappedIndex) < currentAudio_.channels) {
                    mappedFrameScratch_[outputChannel] = sourceFrame[mappedIndex];
                }
            }
        } else {
            for (uint32_t outputChannel = 0; outputChannel < outputChannels; ++outputChannel) {
                uint32_t sourceIndex = std::min<uint32_t>(outputChannel, currentAudio_.channels - 1);
                mappedFrameScratch_[outputChannel] = sourceFrame[sourceIndex];
            }
        }

        float postEqMono = 0.0f;
        for (uint32_t outputChannel = 0; outputChannel < outputChannels; ++outputChannel) {
            float sample = mappedFrameScratch_[outputChannel];
            if (dspEnabled) {
                sample *= normalization;
                if (eqEnabled_ && !eqFiltersByChannel_.empty() && outputChannel < eqFiltersByChannel_.size()) {
                    sample *= eqPreampLinear_;
                    for (DSP::BiquadFilter& filter : eqFiltersByChannel_[outputChannel]) {
                        sample = filter.process(sample);
                    }
                }
            }

            postEqMono += sample;
            output[static_cast<size_t>(frame) * outputChannels + outputChannel] = sample * gain;
        }

        spectrumFrames[producedFrames] = outputChannels > 0 ? (postEqMono / static_cast<float>(outputChannels)) : 0.0f;
        producedFrames += 1;
        currentFrameIndex_.store(frameIndex + 1, std::memory_order_relaxed);
    }

    if (producedFrames > 0) {
        uint32_t analysisSampleRate = currentSampleRate_.load(std::memory_order_relaxed);
        if (analysisSampleRate == 0) {
            analysisSampleRate = currentAudio_.sampleRate == 0 ? 48000 : currentAudio_.sampleRate;
        }
        syncAnalysisDelayBuffersLocked(analysisSampleRate);

        if (visualizerRing_ != nullptr) {
            const float* visualizerWriteFrames = visualizerFrames;
            if (visualizerDelayBuffer_.delayFrames > 0) {
                visualizerDelayBuffer_.process(
                    visualizerFrames,
                    producedFrames,
                    delayedVisualizerFramesScratch_.data()
                );
                visualizerWriteFrames = delayedVisualizerFramesScratch_.data();
            }
            visualizerRing_->write(visualizerWriteFrames, producedFrames);
        }
        if (spectrumRing_ != nullptr) {
            const float* spectrumWriteFrames = spectrumFrames;
            if (spectrumDelayBuffer_.delayFrames > 0) {
                spectrumDelayBuffer_.process(
                    spectrumFrames,
                    producedFrames,
                    delayedSpectrumFramesScratch_.data()
                );
                spectrumWriteFrames = delayedSpectrumFramesScratch_.data();
            }
            spectrumRing_->write(spectrumWriteFrames, producedFrames);
        }
    }
}

std::vector<float> Engine::mapSourceFrameLocked(const float* sourceFrame, uint32_t sourceChannels, uint32_t outputChannels) const {
    std::vector<float> mapped(outputChannels, 0.0f);
    if (sourceFrame == nullptr || sourceChannels == 0 || outputChannels == 0) {
        return mapped;
    }

    for (uint32_t outputChannel = 0; outputChannel < outputChannels; ++outputChannel) {
        uint32_t sourceIndex = std::min<uint32_t>(outputChannel, sourceChannels - 1);
        mapped[outputChannel] = sourceFrame[sourceIndex];
    }
    return mapped;
}

void Engine::writeVisualizerFrameLocked(float left, float right, float mono) {
    if (visualizerRing_ == nullptr) {
        return;
    }
    float frame[3] = {mono, left, right};
    visualizerRing_->write(frame, 1);
}

void Engine::writeSpectrumFrameLocked(float mono) {
    if (spectrumRing_ == nullptr) {
        return;
    }
    spectrumRing_->write(&mono, 1);
}

std::string Engine::encodeDeviceId(const ma_device_id& id) {
    std::ostringstream stream;
    stream << std::hex << std::setfill('0');
    const ma_uint8* bytes = reinterpret_cast<const ma_uint8*>(&id);
    for (size_t i = 0; i < sizeof(ma_device_id); ++i) {
        stream << std::setw(2) << static_cast<unsigned int>(bytes[i]);
    }
    return stream.str();
}

bool Engine::decodeDeviceId(const std::string& encoded, ma_device_id& id) {
    if (encoded.size() != sizeof(ma_device_id) * 2) {
        return false;
    }

    std::memset(&id, 0, sizeof(ma_device_id));
    ma_uint8* bytes = reinterpret_cast<ma_uint8*>(&id);
    for (size_t i = 0; i < sizeof(ma_device_id); ++i) {
        unsigned int value = 0;
        std::istringstream stream(encoded.substr(i * 2, 2));
        stream >> std::hex >> value;
        if (stream.fail()) {
            return false;
        }
        bytes[i] = static_cast<ma_uint8>(value);
    }

    return true;
}

}  // namespace NativeAudio
