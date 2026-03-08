#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include "../vendor/miniaudio.h"
#include "dsp_utils.h"

namespace NativeAudio {

enum class PlaybackState {
    Stopped = 0,
    Playing = 1,
    Paused = 2,
};

enum class EQBandType {
    LowShelf = 0,
    Peaking = 1,
    HighShelf = 2,
};

struct EQBandConfig {
    EQBandType type = EQBandType::Peaking;
    float frequency = 1000.0f;
    float gainDB = 0.0f;
    float q = 1.0f;
};

struct DeviceInfo {
    std::string deviceId;
    std::string label;
    std::string groupId;
    bool isDefaultAlias = false;
    uint32_t maxChannels = 2;
    bool supportsExclusive = true;
};

struct VisualizerSamples {
    std::vector<float> mono;
    std::vector<float> left;
    std::vector<float> right;
    uint32_t count = 0;
};

struct SpectrumSamples {
    std::vector<float> mono;
    uint32_t count = 0;
};

struct DecodedSamples {
    std::vector<float> samples;
    uint32_t channels = 0;
    uint32_t sampleRate = 0;
};

class Engine {
public:
    Engine();
    ~Engine();

    bool initialize();
    void shutdown();

    bool loadFromMemory(const void* data, size_t size);
    bool preBufferFromMemory(const void* data, size_t size);
    void clearNextBuffer();

    bool play();
    void pause();
    void stop();
    void seek(double seconds);

    double getPosition();
    double getDuration() const;
    PlaybackState getState();

    void setVolume(float value);
    void setMuted(bool muted);

    void setExclusiveMode(bool enabled);
    bool isExclusiveModeActive() const;
    void setDspEnabled(bool enabled);
    void setNormalizationGain(float linearGain);
    void setAnalysisDelayMs(uint32_t delayMs);
    void setMultichannelEnabled(bool enabled);
    void setChannelRoutingMap(const std::vector<int>& map);
    void updateEQ(const std::vector<EQBandConfig>& bands, float preampDB, bool enabled);

    std::vector<DeviceInfo> enumerateDevices();
    bool selectDevice(const std::string& deviceId);
    uint32_t getOutputMaxChannelCount();
    uint32_t getCurrentTrackChannelCount() const;
    uint32_t getSampleRate() const;
    uint32_t getDeviceSampleRate() const;

    VisualizerSamples readVisualizerSamples(uint32_t maxFrames);
    SpectrumSamples readPostEqSpectrumSamples(uint32_t maxFrames);
    DecodedSamples getDecodedSamples() const;

    bool didGaplessTransition();

private:
    struct DecodedAudio {
        std::vector<float> samples;
        uint32_t channels = 0;
        uint32_t sampleRate = 0;
        uint64_t frameCount = 0;

        bool empty() const { return samples.empty() || channels == 0 || sampleRate == 0; }
        double durationSeconds() const;
        void clear();
    };

    struct DeviceConfigSignature {
        std::string deviceId;
        uint32_t sampleRate = 0;
        uint32_t outputChannels = 0;
        bool exclusive = false;

        bool operator==(const DeviceConfigSignature& other) const;
        bool operator!=(const DeviceConfigSignature& other) const;
    };

    struct AnalysisDelayBuffer {
        std::vector<float> buffer;
        uint32_t channels = 0;
        uint32_t delayFrames = 0;
        uint32_t writeIndex = 0;
        uint32_t filled = 0;

        void configure(uint32_t nextChannels, uint32_t nextDelayFrames);
        void reset();
        void process(const float* input, uint32_t inputFrames, float* output);
    };

    struct PcmRing;

    bool initContextLocked();
    void uninitContextLocked();
    bool ensureDeviceReadyLocked(bool allowExclusiveFallback);
    void uninitDeviceLocked();
    void reconfigureDeviceLocked(bool restartIfPlaying, bool allowExclusiveFallback);
    std::vector<DeviceInfo> enumerateDevicesLocked();
    void rebuildEqFiltersLocked();
    void clearAnalysisRingsLocked();
    uint32_t getAnalysisDelayFramesLocked(uint32_t sampleRate) const;
    void syncAnalysisDelayBuffersLocked(uint32_t sampleRate);
    uint32_t resolveOutputChannelsLocked() const;
    uint32_t resolveOutputChannelsForAudio(const DecodedAudio& audio) const;
    uint32_t resolveOutputChannelsForChannels(uint32_t sourceChannels) const;
    uint32_t clampOutputChannelsLocked(uint32_t requestedChannels) const;
    bool decodeAudioData(const void* data, size_t size, DecodedAudio& decoded) const;
    void pumpDeferredDeviceStop();
    void onPlaybackEndedInCallback();

    static void dataCallback(struct ma_device* device, void* output, const void* input, uint32_t frameCount);
    void handleDataCallback(float* output, uint32_t frameCount);

    std::vector<float> mapSourceFrameLocked(const float* sourceFrame, uint32_t sourceChannels, uint32_t outputChannels) const;
    void writeVisualizerFrameLocked(float left, float right, float mono);
    void writeSpectrumFrameLocked(float mono);

    static std::string encodeDeviceId(const ma_device_id& id);
    static bool decodeDeviceId(const std::string& encoded, ma_device_id& id);

    mutable std::mutex mutex_;
    ma_context* context_;
    ma_device* device_;
    PcmRing* visualizerRing_;
    PcmRing* spectrumRing_;

    DecodedAudio currentAudio_;
    DecodedAudio nextAudio_;

    DeviceConfigSignature activeDeviceConfig_;
    std::string selectedDeviceId_;
    bool hasSelectedDevice_ = false;

    std::vector<EQBandConfig> eqBands_;
    std::vector<std::vector<DSP::BiquadFilter>> eqFiltersByChannel_;
    std::vector<float> mappedFrameScratch_;
    AnalysisDelayBuffer visualizerDelayBuffer_;
    AnalysisDelayBuffer spectrumDelayBuffer_;
    std::vector<float> delayedVisualizerFramesScratch_;
    std::vector<float> delayedSpectrumFramesScratch_;

    // Pre-allocated scratch buffers for the audio callback (avoid heap allocs on RT thread)
    std::vector<float> callbackVisualizerScratch_;
    std::vector<float> callbackSpectrumScratch_;
    uint32_t callbackMaxFrames_ = 0;

    std::atomic<uint64_t> currentFrameIndex_;
    std::atomic<double> durationSeconds_;
    std::atomic<int> playbackState_;
    std::atomic<bool> gaplessTransitionFlag_;
    std::atomic<bool> needsDeferredStop_;
    std::atomic<bool> exclusiveModeRequested_;
    std::atomic<bool> exclusiveModeActive_;
    std::atomic<float> volume_;
    std::atomic<bool> muted_;
    std::atomic<float> normalizationGain_;
    std::atomic<bool> dspEnabled_;
    std::atomic<bool> multichannelEnabled_;
    std::atomic<uint32_t> analysisDelayMs_;
    std::atomic<uint32_t> currentTrackChannels_;
    std::atomic<uint32_t> currentSampleRate_;
    std::atomic<uint32_t> deviceInternalSampleRate_;
    std::atomic<uint32_t> outputMaxChannels_;

    bool contextInitialized_;
    bool deviceInitialized_;
    float eqPreampDB_;
    float eqPreampLinear_;
    bool eqEnabled_;
    std::vector<int> channelRoutingMap_;
};

}  // namespace NativeAudio
