#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace NativePlayback {

enum class SampleFormat {
    Int16,
    Int24Packed,
    Int32,
    Float32
};

enum class OutputPolicy { Direct, Processed };
enum class TrackGainMode { Off, Normalization, ReplayGain };

struct NativeOutputRequest {
    OutputPolicy policy = OutputPolicy::Direct;
    uint32_t requestedSampleRate = 0;
};

struct DspEqBand {
    std::string type;
    double frequency = 1000.0;
    double gain = 0.0;
    double q = 1.0;
};

struct NativeDspConfig {
    double volume = 1.0;
    bool muted = false;
    bool eqEnabled = false;
    double preampDb = 0.0;
    std::vector<DspEqBand> eqBands;
    bool limiterEnabled = true;
};

struct NativeTrackGain {
    TrackGainMode mode = TrackGainMode::Off;
    double gainDb = 0.0;
};

struct TrackFormat {
    uint32_t sampleRate = 0;
    uint32_t channels = 0;
    SampleFormat sampleFormat = SampleFormat::Float32;

    uint32_t bytesPerSample() const;
    uint32_t bytesPerFrame() const;
    std::string sampleFormatId() const;
};

struct TrackBuffer {
    TrackFormat format;
    double duration = 0.0;
    std::vector<uint8_t> data;
    NativeTrackGain gain;

    uint64_t totalFrames() const;
};

struct OutputDeviceInfo {
    std::string id;
    std::string label;
    uint32_t maxChannels = 2;
    bool isDefault = false;
};

// One rate/format pair an output device accepts in exclusive mode.
struct DeviceFormatSupport {
    uint32_t sampleRate = 0;
    uint32_t channels = 0;
    std::string sampleFormat;
};

struct DeviceFormatProbe {
    std::string deviceId;
    std::string deviceLabel;
    bool supported = false;
    std::vector<DeviceFormatSupport> formats;
    std::string reason;
};

// A complete PCM description for the decoded source, any internal processing
// representation, and the bytes ultimately submitted to the native device.
struct NativePcmFormat {
    int sampleRate = 0;
    int channels = 0;
    std::string sampleFormat;
    int containerBits = 0;
    int validBits = 0;
    uint64_t channelMask = 0;
    std::string channelLayout;
    std::string representation;
};

struct NativeOutputAttempt {
    int index = 0;
    std::string backend;
    std::string deviceId;
    std::string deviceLabel;
    NativePcmFormat sourceFormat;
    NativePcmFormat processingFormat;
    NativePcmFormat wireFormat;
    std::string transport;
    std::string probeResult;
    double requestedPeriodMs = 0.0;
    double alignedPeriodMs = 0.0;
    double actualPeriodMs = 0.0;
    int bufferFrames = 0;
    bool deviceResolved = false;
    bool formatNegotiated = false;
    bool streamInitialized = false;
    bool bufferPrimed = false;
    bool streamStarted = false;
    bool finalVerified = false;
    std::string outputPolicy = "direct";
    bool resamplingActive = false;
    int requestedSampleRate = 0;
    int targetSampleRate = 0;
    std::string rateSelectionReason;
    std::string failureStage;
    std::string osErrorSymbol;
    int64_t osErrorCode = 0;
    std::string message;
};

struct NativeProcessingStatus {
    std::string outputPolicy = "direct";
    bool exclusiveActive = false;
    bool processingActive = false;
    bool resamplingActive = false;
    std::string resamplerName;
    std::string resamplerQuality;
    int sourceSampleRate = 0;
    int targetSampleRate = 0;
    int requestedSampleRate = 0;
    std::string rateSelectionMode = "auto";
    std::string rateSelectionReason;
    int processingLatencyFrames = 0;
    std::string gainMode = "off";
    double trackGainDb = 0.0;
    double preampDb = 0.0;
    double volume = 1.0;
    bool muted = false;
    bool eqEnabled = false;
    int eqBandCount = 0;
    bool limiterEnabled = false;
    double limiterGainReductionDb = 0.0;
    std::string dither;
    uint64_t clippedSamples = 0;
};

struct NativeOutputStatus {
    bool outputOpen = false;
    bool deviceResolved = false;
    bool formatNegotiated = false;
    bool streamInitialized = false;
    bool streamStarted = false;
    bool streamRunning = false;

    bool exclusiveRequested = true;
    bool exclusiveAcquired = false;
    bool systemMixerBypassed = false;

    bool sourceSamplesModified = false;
    bool wireFormatCanCarrySourceExactly = false;
    bool bitPerfectActive = false;
    NativeProcessingStatus processing;

    NativePcmFormat sourceFormat;
    NativePcmFormat processingFormat;
    NativePcmFormat wireFormat;

    std::string backend;
    std::string deviceId;
    std::string deviceLabel;
    std::string transport;
    double requestedPeriodMs = 0.0;
    double actualPeriodMs = 0.0;
    int requestedPeriodFrames = 0;
    int actualPeriodFrames = 0;
    int bufferFrames = 0;

    std::string failureStage;
    std::string osErrorSymbol;
    int64_t osErrorCode = 0;
    std::string failureSummary;
    std::vector<NativeOutputAttempt> attempts;
};

struct ExactFormatOrderKey {
    int ladderRank = 0;
    bool extensible = true;
    bool probeAccepted = false;
};

struct ExclusiveAttemptPlanEntry {
    size_t formatCandidateIndex = 0;
    std::string transport;
    int64_t requestedPeriod = 0;
    bool conservative = false;
};

struct PlaybackSnapshot {
    std::string playbackState;
    double currentTime = 0.0;
    double duration = 0.0;
    int sampleRate = 0;
    int channels = 0;
    std::string sampleFormat;
    std::string deviceId;
    std::string deviceLabel;
    NativeOutputStatus outputStatus;
};

struct PlaybackEvent {
    std::string type;
    std::string playbackState;
    double currentTime = 0.0;
    double duration = 0.0;
    int sampleRate = 0;
    std::string sampleFormat;
    std::string deviceId;
    std::string message;
};

struct VectorscopeSamples {
    std::vector<float> left;
    std::vector<float> right;
};

struct MultichannelSamples {
    std::vector<std::vector<float>> channels;
};

struct VisualizerTapDemand {
    bool oscilloscope = false;
    bool spectrum = false;
    bool vectorscope = false;
    bool vumeter = false;
};

class FloatSampleRingBuffer {
public:
    FloatSampleRingBuffer() = default;
    explicit FloatSampleRingBuffer(size_t capacity);

    void setCapacity(size_t capacity);
    void clear();
    void push(float sample);
    std::vector<float> drain();

private:
    std::vector<float> data_;
    size_t start_ = 0;
    size_t size_ = 0;
};

class PlaybackEngine;
class ProcessedAudioPipeline;

class AudioOutputSink {
public:
    virtual ~AudioOutputSink() = default;

    virtual bool isAvailable() const = 0;
    virtual std::string backendKind() const = 0;
    virtual std::vector<OutputDeviceInfo> enumerateOutputDevices(std::string* reason) const = 0;
    virtual uint32_t deviceMaxChannels(const std::string& deviceId) const = 0;

    // Backends that can enumerate exact hardware format support override this. The default
    // reports "unknown", which callers treat as "try it and see".
    virtual DeviceFormatProbe probeDeviceFormats(const std::string& /*deviceId*/, uint32_t /*channels*/) const {
        DeviceFormatProbe probe;
        probe.reason = "This audio backend cannot enumerate device formats.";
        return probe;
    }

    virtual bool open(
        const std::string& deviceId,
        const TrackFormat& format,
        PlaybackEngine* engine,
        std::string* error
    ) = 0;
    virtual void close() = 0;
    virtual bool start(std::string* error) = 0;
    virtual void pause() = 0;
    virtual void stop() = 0;
    virtual void reset() = 0;
    virtual void beginSeek(bool /*wasPlaying*/) {}
    virtual void resetAfterSeek(bool /*wasPlaying*/) { reset(); }
    virtual bool shouldCloseOnTrackChange(const TrackFormat&, const TrackFormat&) const { return true; }

    virtual NativeOutputStatus outputStatus() const = 0;
    virtual std::string activeDeviceId() const = 0;
    virtual std::string activeDeviceLabel() const = 0;
};

class PlaybackEngine {
public:
    PlaybackEngine();
    ~PlaybackEngine();

    std::vector<OutputDeviceInfo> getOutputDevices(std::string* reason) const;
    DeviceFormatProbe probeDeviceFormats(const std::string& deviceId, uint32_t channels) const;
    uint32_t getSelectedDeviceMaxChannels() const;
    std::string getSelectedDeviceId() const;
    void setSelectedDeviceId(const std::string& deviceId);

    bool isBitPerfectAvailable(std::string* reason) const;
    bool isProcessedExclusiveAvailable(std::string* reason) const;
    std::string backendKind() const;
    NativeOutputStatus getOutputStatus() const;
    std::string getNativeAudioDiagnosticReport() const;

    void configureOutput(const NativeOutputRequest& request);
    void setDspConfig(const NativeDspConfig& config);
    void setCurrentTrackGain(const NativeTrackGain& gain);

    void loadTrack(TrackBuffer track);
    void preloadNextTrack(TrackBuffer track);
    bool promoteNextTrack();
    void clearNextTrack();

    PlaybackSnapshot play();
    // Message for the exception play() last threw. `what()` on an exception unwound out of
    // play() aliases storage that is freed during unwinding, so callers must read the
    // message from here rather than from the caught exception.
    std::string takeLastPlayError();
    PlaybackSnapshot pause();
    PlaybackSnapshot stop();
    PlaybackSnapshot seek(double seconds);
    PlaybackSnapshot getSnapshot() const;
    void setVisualizerTapDemand(const VisualizerTapDemand& demand);
    VisualizerTapDemand getVisualizerTapDemand() const;

    std::vector<PlaybackEvent> drainEvents();
    std::vector<float> drainOscilloscopeSamples();
    std::vector<float> drainSpectrumSamples();
    VectorscopeSamples drainVectorscopeSamples();
    MultichannelSamples drainVUMeterSamples();

    size_t renderInto(void* outputBuffer, size_t requestedFrames, bool& streamEnded);
    void onFramesConsumed(size_t frames);
    void onPlatformStartVerified();
    void onNativeStreamEnded();
    void rollbackSpeculativeRender();
    void onNativeOutputStatusChanged(const std::string& message = {});
    void onNativeOutputRuntimeFailure(const std::string& message);

private:
    enum class State {
        Stopped,
        Starting,
        Playing,
        Paused
    };

    bool ensureSinkOpen(std::string* error);
    std::string recordPlayError(const std::string& error, const char* fallback);
    void pushEvent(const PlaybackEvent& event);
    bool tryPushEvent(const PlaybackEvent& event);
    void clearPendingEvents();
    void clearTapBuffers();
    void appendTapSamples(
        const uint8_t* interleavedData,
        size_t frames,
        const TrackFormat& format,
        const VisualizerTapDemand& demand
    );
    bool formatsMatch(const TrackFormat& a, const TrackFormat& b) const;
    TrackFormat selectProcessedOutputFormat(const TrackFormat& source, std::string* reason) const;
    TrackFormat activeRenderFormatLocked() const;
    void resetProcessedPipelineLocked(uint64_t sourceFrame);
    uint64_t clampTargetFrameLocked(double seconds) const;

    mutable std::mutex controlMutex_;
    mutable std::mutex stateMutex_;
    mutable std::mutex eventMutex_;
    mutable std::mutex tapMutex_;
    std::unique_ptr<AudioOutputSink> sink_;
    std::unique_ptr<ProcessedAudioPipeline> processedPipeline_;
    std::string selectedDeviceId_;
    std::string lastUnavailableReason_;
    mutable std::mutex lastPlayErrorMutex_;
    std::string lastPlayError_;

    State state_ = State::Stopped;
    TrackBuffer currentTrack_;
    bool hasCurrentTrack_ = false;
    TrackBuffer nextTrack_;
    bool hasNextTrack_ = false;
    uint64_t nextRenderFrame_ = 0;
    uint64_t playedFrame_ = 0;
    uint64_t lastTimeUpdateFrame_ = 0;
    bool platformStartVerified_ = false;
    bool nativeEndPending_ = false;
    NativeOutputRequest outputRequest_ {};
    NativeDspConfig dspConfig_ {};
    TrackFormat renderFormat_ {};
    std::string rateSelectionReason_;
    double consumedSourceFrameExact_ = 0.0;

    static constexpr size_t kMaxTapSamples = 32768;
    static constexpr uint32_t kTimeUpdateRateHz = 30;
    VisualizerTapDemand visualizerTapDemand_ {};

    std::vector<PlaybackEvent> pendingEvents_;
    FloatSampleRingBuffer oscilloscopeTap_;
    FloatSampleRingBuffer spectrumTap_;
    FloatSampleRingBuffer vectorscopeLeftTap_;
    FloatSampleRingBuffer vectorscopeRightTap_;
    std::vector<FloatSampleRingBuffer> vumeterTaps_;
};

std::unique_ptr<AudioOutputSink> CreatePlatformAudioSink();
TrackFormat BuildTrackFormat(uint32_t sampleRate, uint32_t channels, const std::string& sampleFormatId);
NativePcmFormat DescribeTrackFormat(const TrackFormat& format);
void RecomputeBitPerfectActive(NativeOutputStatus& status);
std::string BuildNativeAudioDiagnosticReport(const NativeOutputStatus& status);
bool WidenIntegerSamplesLeftJustified(
    const uint8_t* source,
    int sourceBits,
    uint8_t* destination,
    int destinationBits,
    size_t sampleCount
);
std::vector<size_t> OrderExactFormatCandidates(const std::vector<ExactFormatOrderKey>& candidates);
std::vector<ExclusiveAttemptPlanEntry> BuildExclusiveAttemptPlan(
    size_t formatCandidateCount,
    const std::vector<int64_t>& preferredPeriods,
    int64_t conservativePeriod
);
int64_t ComputeAlignedExclusivePeriod(uint64_t alignedBufferFrames, uint32_t sampleRate, int64_t timeUnitsPerSecond);

} // namespace NativePlayback
