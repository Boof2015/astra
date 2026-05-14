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
    Int32,
    Float32
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

    uint64_t totalFrames() const;
};

struct OutputDeviceInfo {
    std::string id;
    std::string label;
    uint32_t maxChannels = 2;
    bool isDefault = false;
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
    std::string activeBackend;
    bool activeDeviceExclusive = false;
    bool bitPerfectActive = false;
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

class AudioOutputSink {
public:
    virtual ~AudioOutputSink() = default;

    virtual bool supportsBitPerfect() const = 0;
    virtual std::string backendKind() const = 0;
    virtual std::vector<OutputDeviceInfo> enumerateOutputDevices(std::string* reason) const = 0;
    virtual uint32_t deviceMaxChannels(const std::string& deviceId) const = 0;

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

    virtual bool isExclusive() const = 0;
    virtual int activeDeviceSampleRate() const = 0;
    virtual std::string activeDeviceId() const = 0;
    virtual std::string activeDeviceLabel() const = 0;
};

class PlaybackEngine {
public:
    PlaybackEngine();
    ~PlaybackEngine();

    std::vector<OutputDeviceInfo> getOutputDevices(std::string* reason) const;
    uint32_t getSelectedDeviceMaxChannels() const;
    std::string getSelectedDeviceId() const;
    void setSelectedDeviceId(const std::string& deviceId);

    bool isBitPerfectAvailable(std::string* reason) const;
    std::string backendKind() const;
    int getActiveDeviceSampleRate() const;

    void loadTrack(TrackBuffer track);
    void preloadNextTrack(TrackBuffer track);
    bool promoteNextTrack();
    void clearNextTrack();

    PlaybackSnapshot play();
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

private:
    enum class State {
        Stopped,
        Playing,
        Paused
    };

    bool ensureSinkOpen(std::string* error);
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
    uint64_t clampTargetFrameLocked(double seconds) const;

    mutable std::mutex controlMutex_;
    mutable std::mutex stateMutex_;
    mutable std::mutex eventMutex_;
    mutable std::mutex tapMutex_;
    std::unique_ptr<AudioOutputSink> sink_;
    std::string selectedDeviceId_;
    std::string lastUnavailableReason_;

    State state_ = State::Stopped;
    TrackBuffer currentTrack_;
    bool hasCurrentTrack_ = false;
    TrackBuffer nextTrack_;
    bool hasNextTrack_ = false;
    uint64_t nextRenderFrame_ = 0;
    uint64_t playedFrame_ = 0;
    uint64_t lastTimeUpdateFrame_ = 0;

    static constexpr size_t kMaxTapSamples = 32768;
    static constexpr uint32_t kTimeUpdateRateHz = 30;
    static constexpr size_t kFadeInFrames = 64;
    uint64_t fadeInRemaining_ = 0;
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

} // namespace NativePlayback
