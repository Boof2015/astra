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

    virtual bool isExclusive() const = 0;
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

    void loadTrack(TrackBuffer track);
    void preloadNextTrack(TrackBuffer track);
    void clearNextTrack();

    PlaybackSnapshot play();
    PlaybackSnapshot pause();
    PlaybackSnapshot stop();
    PlaybackSnapshot seek(double seconds);
    PlaybackSnapshot getSnapshot() const;

    std::vector<PlaybackEvent> drainEvents();
    std::vector<float> drainOscilloscopeSamples();
    std::vector<float> drainSpectrumSamples();
    VectorscopeSamples drainVectorscopeSamples();

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
    void clearTapBuffersLocked();
    void appendTapSamplesLocked(const uint8_t* interleavedData, size_t frames);
    bool formatsMatch(const TrackFormat& a, const TrackFormat& b) const;
    uint64_t clampTargetFrameLocked(double seconds) const;
    void trimTapBuffer(std::vector<float>& buffer, size_t maxSize) const;

    mutable std::mutex mutex_;
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

    std::vector<PlaybackEvent> pendingEvents_;
    std::vector<float> oscilloscopeTap_;
    std::vector<float> spectrumTap_;
    std::vector<float> vectorscopeLeftTap_;
    std::vector<float> vectorscopeRightTap_;
    size_t maxTapSamples_ = 32768;
};

std::unique_ptr<AudioOutputSink> CreatePlatformAudioSink();
TrackFormat BuildTrackFormat(uint32_t sampleRate, uint32_t channels, const std::string& sampleFormatId);

} // namespace NativePlayback
