#include <napi.h>
#include <cstring>
#include <vector>
#include <string>
#include "oscilloscope.h"
#include "spectrum.h"
#include "vectorscope.h"
#include "playback_engine.h"

// Global instances (we could make these per-instance if needed)
static Visualizer::Oscilloscope oscilloscope;
static Visualizer::Spectrum spectrum(2048);
static Visualizer::Vectorscope vectorscope;
static NativePlayback::PlaybackEngine playbackEngine;

namespace {

Napi::Value ToNullableString(Napi::Env env, const std::string& value) {
    if (value.empty()) {
        return env.Null();
    }
    return Napi::String::New(env, value);
}

Napi::Object CreatePlaybackSnapshotObject(Napi::Env env, const NativePlayback::PlaybackSnapshot& snapshot) {
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("playbackState", Napi::String::New(env, snapshot.playbackState));
    obj.Set("currentTime", Napi::Number::New(env, snapshot.currentTime));
    obj.Set("duration", Napi::Number::New(env, snapshot.duration));
    obj.Set("sampleRate", snapshot.sampleRate > 0 ? Napi::Number::New(env, snapshot.sampleRate) : env.Null());
    obj.Set("channels", snapshot.channels > 0 ? Napi::Number::New(env, snapshot.channels) : env.Null());
    obj.Set("sampleFormat", ToNullableString(env, snapshot.sampleFormat));
    obj.Set("deviceId", ToNullableString(env, snapshot.deviceId));
    obj.Set("deviceLabel", ToNullableString(env, snapshot.deviceLabel));
    obj.Set("activeBackend", Napi::String::New(env, snapshot.activeBackend));
    obj.Set("activeDeviceExclusive", Napi::Boolean::New(env, snapshot.activeDeviceExclusive));
    obj.Set("bitPerfectActive", Napi::Boolean::New(env, snapshot.bitPerfectActive));
    return obj;
}

Napi::Object CreatePlaybackEventObject(Napi::Env env, const NativePlayback::PlaybackEvent& event) {
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("type", Napi::String::New(env, event.type));
    if (!event.playbackState.empty()) {
        obj.Set("playbackState", Napi::String::New(env, event.playbackState));
    }
    if (event.currentTime > 0.0) {
        obj.Set("currentTime", Napi::Number::New(env, event.currentTime));
    }
    if (event.duration > 0.0) {
        obj.Set("duration", Napi::Number::New(env, event.duration));
    }
    if (event.sampleRate > 0) {
        obj.Set("sampleRate", Napi::Number::New(env, event.sampleRate));
    }
    if (!event.sampleFormat.empty()) {
        obj.Set("sampleFormat", Napi::String::New(env, event.sampleFormat));
    }
    if (!event.deviceId.empty()) {
        obj.Set("deviceId", Napi::String::New(env, event.deviceId));
    }
    if (!event.message.empty()) {
        obj.Set("message", Napi::String::New(env, event.message));
    }
    return obj;
}

Napi::Object CreateCapabilitiesObject(Napi::Env env) {
    std::string reason;
    const bool bitPerfectAvailable = playbackEngine.isBitPerfectAvailable(&reason);
    const auto devices = playbackEngine.getOutputDevices(&reason);
    const auto snapshot = playbackEngine.getSnapshot();

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("bitPerfectAvailable", Napi::Boolean::New(env, bitPerfectAvailable));
    obj.Set("reasonUnavailable", bitPerfectAvailable ? env.Null() : ToNullableString(env, reason));
    obj.Set("activeBackend", Napi::String::New(env, playbackEngine.backendKind()));
    obj.Set("activeDeviceExclusive", Napi::Boolean::New(env, snapshot.activeDeviceExclusive));
    obj.Set("activeSampleRate", snapshot.sampleRate > 0 ? Napi::Number::New(env, snapshot.sampleRate) : env.Null());
    obj.Set("activeSampleFormat", ToNullableString(env, snapshot.sampleFormat));
    obj.Set("selectedDeviceId", ToNullableString(env, playbackEngine.getSelectedDeviceId()));

    Napi::Array deviceArray = Napi::Array::New(env, devices.size());
    for (size_t i = 0; i < devices.size(); i++) {
        const auto& device = devices[i];
        Napi::Object entry = Napi::Object::New(env);
        entry.Set("deviceId", Napi::String::New(env, device.id));
        entry.Set("label", Napi::String::New(env, device.label));
        entry.Set("maxChannels", Napi::Number::New(env, device.maxChannels));
        entry.Set("isDefault", Napi::Boolean::New(env, device.isDefault));
        deviceArray.Set(i, entry);
    }
    obj.Set("devices", deviceArray);
    obj.Set("selectedDeviceMaxChannels", Napi::Number::New(env, playbackEngine.getSelectedDeviceMaxChannels()));

    return obj;
}

NativePlayback::TrackBuffer ParseTrackBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (
        info.Length() < 5
        || !info[0].IsTypedArray()
        || !info[1].IsNumber()
        || !info[2].IsNumber()
        || !info[3].IsString()
        || !info[4].IsNumber()
    ) {
        Napi::TypeError::New(env, "Expected Uint8Array, sampleRate, channels, sampleFormat, duration")
            .ThrowAsJavaScriptException();
        return {};
    }

    Napi::Uint8Array pcmData = info[0].As<Napi::Uint8Array>();
    const uint32_t sampleRate = info[1].As<Napi::Number>().Uint32Value();
    const uint32_t channels = info[2].As<Napi::Number>().Uint32Value();
    const std::string sampleFormat = info[3].As<Napi::String>().Utf8Value();
    const double duration = info[4].As<Napi::Number>().DoubleValue();

    NativePlayback::TrackBuffer track;
    track.format = NativePlayback::BuildTrackFormat(sampleRate, channels, sampleFormat);
    track.duration = duration;
    track.data.assign(pcmData.Data(), pcmData.Data() + pcmData.ByteLength());
    if (track.duration <= 0.0 && track.format.sampleRate > 0) {
        track.duration = static_cast<double>(track.totalFrames()) / static_cast<double>(track.format.sampleRate);
    }
    return track;
}

} // namespace

// ============== Oscilloscope ==============

Napi::Value OscilloscopeSetSampleRate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected sample rate").ThrowAsJavaScriptException();
        return env.Null();
    }
    oscilloscope.setSampleRate(info[0].As<Napi::Number>().FloatValue());
    return env.Undefined();
}

Napi::Value OscilloscopeSetPitchLock(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBoolean()) {
        Napi::TypeError::New(env, "Expected boolean").ThrowAsJavaScriptException();
        return env.Null();
    }
    oscilloscope.setPitchLock(info[0].As<Napi::Boolean>().Value());
    return env.Undefined();
}

Napi::Value OscilloscopeSetDisplaySamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected number").ThrowAsJavaScriptException();
        return env.Null();
    }
    oscilloscope.setDisplaySamples(info[0].As<Napi::Number>().Int32Value());
    return env.Undefined();
}

// Push samples to circular buffer (for continuous capture)
Napi::Value OscilloscopePushSamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected Float32Array").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array audioData = info[0].As<Napi::Float32Array>();
    size_t length = audioData.ElementLength();

    oscilloscope.pushSamples(audioData.Data(), length);
    return env.Undefined();
}

// Process using circular buffer (continuous mode)
Napi::Value OscilloscopeProcessContinuous(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    auto result = oscilloscope.process();

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("triggerIndex", Napi::Number::New(env, result.triggerIndex));
    obj.Set("samplesToShow", Napi::Number::New(env, result.samplesToShow));
    obj.Set("detectedPitch", Napi::Number::New(env, result.detectedPitch));
    obj.Set("writePos", Napi::Number::New(env, static_cast<double>(oscilloscope.getWritePos())));

    return obj;
}

// Legacy snapshot process (backwards compatible)
Napi::Value OscilloscopeProcess(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected Float32Array").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array audioData = info[0].As<Napi::Float32Array>();
    size_t length = audioData.ElementLength();

    auto result = oscilloscope.processSnapshot(audioData.Data(), length);

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("triggerIndex", Napi::Number::New(env, result.triggerIndex));
    obj.Set("samplesToShow", Napi::Number::New(env, result.samplesToShow));
    obj.Set("detectedPitch", Napi::Number::New(env, result.detectedPitch));
    obj.Set("writePos", Napi::Number::New(env, static_cast<double>(oscilloscope.getWritePos())));

    return obj;
}

// Get current write position
Napi::Value OscilloscopeGetWritePos(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), static_cast<double>(oscilloscope.getWritePos()));
}

// Get samples from circular buffer for rendering (with sub-sample interpolation)
Napi::Value OscilloscopeGetSamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "Expected startPos (float) and count").ThrowAsJavaScriptException();
        return env.Null();
    }

    // Accept float startPos to preserve sub-sample trigger precision
    float startPos = info[0].As<Napi::Number>().FloatValue();
    size_t count = static_cast<size_t>(info[1].As<Napi::Number>().Uint32Value());

    // Create output array
    Napi::Float32Array output = Napi::Float32Array::New(env, count);

    // Use interpolated version for smooth sub-pixel rendering
    oscilloscope.getSamplesInterpolated(output.Data(), startPos, count);

    return output;
}

Napi::Value OscilloscopeReset(const Napi::CallbackInfo& info) {
    oscilloscope.reset();
    return info.Env().Undefined();
}

// ============== Spectrum ==============

Napi::Value SpectrumSetFFTSize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected FFT size").ThrowAsJavaScriptException();
        return env.Null();
    }
    spectrum.setFFTSize(info[0].As<Napi::Number>().Uint32Value());
    return env.Undefined();
}

Napi::Value SpectrumGetFFTSize(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), spectrum.getFFTSize());
}

Napi::Value SpectrumSetSampleRate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected sample rate").ThrowAsJavaScriptException();
        return env.Null();
    }
    spectrum.setSampleRate(info[0].As<Napi::Number>().FloatValue());
    return env.Undefined();
}

Napi::Value SpectrumSetSmoothing(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected smoothing value").ThrowAsJavaScriptException();
        return env.Null();
    }
    spectrum.setSmoothing(info[0].As<Napi::Number>().FloatValue());
    return env.Undefined();
}

Napi::Value SpectrumProcess(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected Float32Array").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array audioData = info[0].As<Napi::Float32Array>();
    size_t length = audioData.ElementLength();

    const auto& magnitudes = spectrum.process(audioData.Data(), length);

    // Return as Float32Array
    Napi::Float32Array result = Napi::Float32Array::New(env, magnitudes.size());
    memcpy(result.Data(), magnitudes.data(), magnitudes.size() * sizeof(float));

    return result;
}

Napi::Value SpectrumBinToFrequency(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected bin number").ThrowAsJavaScriptException();
        return env.Null();
    }
    float freq = spectrum.binToFrequency(info[0].As<Napi::Number>().Int32Value());
    return Napi::Number::New(env, freq);
}

Napi::Value SpectrumReset(const Napi::CallbackInfo& info) {
    spectrum.reset();
    return info.Env().Undefined();
}

// ============== Vectorscope ==============

Napi::Value VectorscopeSetSampleRate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected sample rate").ThrowAsJavaScriptException();
        return env.Null();
    }
    vectorscope.setSampleRate(info[0].As<Napi::Number>().FloatValue());
    return env.Undefined();
}

Napi::Value VectorscopePushSamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected two Float32Arrays (left, right)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    Napi::Float32Array leftData = info[0].As<Napi::Float32Array>();
    Napi::Float32Array rightData = info[1].As<Napi::Float32Array>();
    size_t length = std::min(leftData.ElementLength(), rightData.ElementLength());
    vectorscope.pushSamples(leftData.Data(), rightData.Data(), length);
    return env.Undefined();
}

Napi::Value VectorscopeGetPoints(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected max points count").ThrowAsJavaScriptException();
        return env.Null();
    }
    size_t maxPoints = static_cast<size_t>(info[0].As<Napi::Number>().Uint32Value());

    Napi::Float32Array xArray = Napi::Float32Array::New(env, maxPoints);
    Napi::Float32Array yArray = Napi::Float32Array::New(env, maxPoints);

    size_t actual = vectorscope.getPoints(xArray.Data(), yArray.Data(), maxPoints);

    Napi::Object result = Napi::Object::New(env);
    if (actual < maxPoints) {
        Napi::Float32Array xTrimmed = Napi::Float32Array::New(env, actual);
        Napi::Float32Array yTrimmed = Napi::Float32Array::New(env, actual);
        memcpy(xTrimmed.Data(), xArray.Data(), actual * sizeof(float));
        memcpy(yTrimmed.Data(), yArray.Data(), actual * sizeof(float));
        result.Set("x", xTrimmed);
        result.Set("y", yTrimmed);
    } else {
        result.Set("x", xArray);
        result.Set("y", yArray);
    }
    result.Set("count", Napi::Number::New(env, static_cast<double>(actual)));

    return result;
}

Napi::Value VectorscopeSetBufferSize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected buffer size").ThrowAsJavaScriptException();
        return env.Null();
    }
    vectorscope.setBufferSize(info[0].As<Napi::Number>().Uint32Value());
    return env.Undefined();
}

Napi::Value VectorscopeGetBufferSize(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), vectorscope.getBufferSize());
}

Napi::Value VectorscopeProcess(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected two Float32Arrays (left, right)").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array leftData = info[0].As<Napi::Float32Array>();
    Napi::Float32Array rightData = info[1].As<Napi::Float32Array>();
    size_t length = std::min(leftData.ElementLength(), rightData.ElementLength());

    const auto& points = vectorscope.process(leftData.Data(), rightData.Data(), length);

    // Return as object with x and y arrays
    Napi::Float32Array xArray = Napi::Float32Array::New(env, points.size());
    Napi::Float32Array yArray = Napi::Float32Array::New(env, points.size());

    for (size_t i = 0; i < points.size(); i++) {
        xArray[i] = points[i].x;
        yArray[i] = points[i].y;
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("x", xArray);
    result.Set("y", yArray);

    return result;
}

Napi::Value VectorscopeReset(const Napi::CallbackInfo& info) {
    vectorscope.reset();
    return info.Env().Undefined();
}

// ============== Native Playback ==============

Napi::Value PlaybackGetCapabilities(const Napi::CallbackInfo& info) {
    return CreateCapabilitiesObject(info.Env());
}

Napi::Value PlaybackSetOutputDevice(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected device id").ThrowAsJavaScriptException();
        return env.Null();
    }

    try {
        playbackEngine.setSelectedDeviceId(info[0].As<Napi::String>().Utf8Value());
    } catch (const std::exception& error) {
        Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
        return env.Null();
    }

    return CreateCapabilitiesObject(env);
}

Napi::Value PlaybackLoadTrack(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    NativePlayback::TrackBuffer track = ParseTrackBuffer(info);
    if (env.IsExceptionPending()) {
        return env.Null();
    }

    playbackEngine.loadTrack(std::move(track));
    return CreatePlaybackSnapshotObject(env, playbackEngine.getSnapshot());
}

Napi::Value PlaybackPreloadNextTrack(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    NativePlayback::TrackBuffer track = ParseTrackBuffer(info);
    if (env.IsExceptionPending()) {
        return env.Null();
    }

    playbackEngine.preloadNextTrack(std::move(track));
    return env.Undefined();
}

Napi::Value PlaybackPromoteNextTrack(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!playbackEngine.promoteNextTrack()) {
        Napi::Error::New(env, "No native preloaded next track is available.").ThrowAsJavaScriptException();
        return env.Null();
    }

    return CreatePlaybackSnapshotObject(env, playbackEngine.getSnapshot());
}

Napi::Value PlaybackPlay(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    try {
        return CreatePlaybackSnapshotObject(env, playbackEngine.play());
    } catch (const std::exception& error) {
        Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

Napi::Value PlaybackPause(const Napi::CallbackInfo& info) {
    return CreatePlaybackSnapshotObject(info.Env(), playbackEngine.pause());
}

Napi::Value PlaybackStop(const Napi::CallbackInfo& info) {
    return CreatePlaybackSnapshotObject(info.Env(), playbackEngine.stop());
}

Napi::Value PlaybackSeek(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected seek time in seconds").ThrowAsJavaScriptException();
        return env.Null();
    }

    return CreatePlaybackSnapshotObject(env, playbackEngine.seek(info[0].As<Napi::Number>().DoubleValue()));
}

Napi::Value PlaybackClearNextTrack(const Napi::CallbackInfo& info) {
    playbackEngine.clearNextTrack();
    return info.Env().Undefined();
}

Napi::Value PlaybackGetSnapshot(const Napi::CallbackInfo& info) {
    return CreatePlaybackSnapshotObject(info.Env(), playbackEngine.getSnapshot());
}

Napi::Value PlaybackSetVisualizerTapDemand(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Expected visualizer tap demand object").ThrowAsJavaScriptException();
        return env.Null();
    }

    const Napi::Object demandObject = info[0].As<Napi::Object>();
    NativePlayback::VisualizerTapDemand demand;

    const Napi::Value oscilloscopeValue = demandObject.Get("oscilloscope");
    if (!oscilloscopeValue.IsUndefined()) {
        demand.oscilloscope = oscilloscopeValue.ToBoolean().Value();
    }

    const Napi::Value spectrumValue = demandObject.Get("spectrum");
    if (!spectrumValue.IsUndefined()) {
        demand.spectrum = spectrumValue.ToBoolean().Value();
    }

    const Napi::Value vectorscopeValue = demandObject.Get("vectorscope");
    if (!vectorscopeValue.IsUndefined()) {
        demand.vectorscope = vectorscopeValue.ToBoolean().Value();
    }

    const Napi::Value vumeterValue = demandObject.Get("vumeter");
    if (!vumeterValue.IsUndefined()) {
        demand.vumeter = vumeterValue.ToBoolean().Value();
    }

    playbackEngine.setVisualizerTapDemand(demand);
    return env.Undefined();
}

Napi::Value PlaybackDrainEvents(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const auto events = playbackEngine.drainEvents();
    Napi::Array result = Napi::Array::New(env, events.size());
    for (size_t i = 0; i < events.size(); i++) {
        result.Set(i, CreatePlaybackEventObject(env, events[i]));
    }
    return result;
}

Napi::Value PlaybackFlushOscilloscopeSamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const auto samples = playbackEngine.drainOscilloscopeSamples();
    Napi::Float32Array output = Napi::Float32Array::New(env, samples.size());
    if (!samples.empty()) {
        std::memcpy(output.Data(), samples.data(), samples.size() * sizeof(float));
    }
    return output;
}

Napi::Value PlaybackFlushSpectrumSamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const auto samples = playbackEngine.drainSpectrumSamples();
    Napi::Float32Array output = Napi::Float32Array::New(env, samples.size());
    if (!samples.empty()) {
        std::memcpy(output.Data(), samples.data(), samples.size() * sizeof(float));
    }
    return output;
}

Napi::Value PlaybackFlushVectorscopeSamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const auto samples = playbackEngine.drainVectorscopeSamples();
    Napi::Object result = Napi::Object::New(env);
    Napi::Float32Array left = Napi::Float32Array::New(env, samples.left.size());
    Napi::Float32Array right = Napi::Float32Array::New(env, samples.right.size());
    if (!samples.left.empty()) {
        std::memcpy(left.Data(), samples.left.data(), samples.left.size() * sizeof(float));
    }
    if (!samples.right.empty()) {
        std::memcpy(right.Data(), samples.right.data(), samples.right.size() * sizeof(float));
    }
    result.Set("left", left);
    result.Set("right", right);
    return result;
}

Napi::Value PlaybackFlushVUMeterSamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const auto samples = playbackEngine.drainVUMeterSamples();
    Napi::Object result = Napi::Object::New(env);
    Napi::Array channels = Napi::Array::New(env, samples.channels.size());

    for (size_t channelIndex = 0; channelIndex < samples.channels.size(); channelIndex++) {
        const auto& channelSamples = samples.channels[channelIndex];
        Napi::Float32Array output = Napi::Float32Array::New(env, channelSamples.size());
        if (!channelSamples.empty()) {
            std::memcpy(output.Data(), channelSamples.data(), channelSamples.size() * sizeof(float));
        }
        channels.Set(channelIndex, output);
    }

    result.Set("channels", channels);
    return result;
}

// ============== Module Init ==============

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    // Oscilloscope
    Napi::Object oscExports = Napi::Object::New(env);
    oscExports.Set("setSampleRate", Napi::Function::New(env, OscilloscopeSetSampleRate));
    oscExports.Set("setPitchLock", Napi::Function::New(env, OscilloscopeSetPitchLock));
    oscExports.Set("setDisplaySamples", Napi::Function::New(env, OscilloscopeSetDisplaySamples));
    oscExports.Set("process", Napi::Function::New(env, OscilloscopeProcess));
    oscExports.Set("pushSamples", Napi::Function::New(env, OscilloscopePushSamples));
    oscExports.Set("processContinuous", Napi::Function::New(env, OscilloscopeProcessContinuous));
    oscExports.Set("getWritePos", Napi::Function::New(env, OscilloscopeGetWritePos));
    oscExports.Set("getSamples", Napi::Function::New(env, OscilloscopeGetSamples));
    oscExports.Set("reset", Napi::Function::New(env, OscilloscopeReset));
    exports.Set("oscilloscope", oscExports);

    // Spectrum
    Napi::Object specExports = Napi::Object::New(env);
    specExports.Set("setFFTSize", Napi::Function::New(env, SpectrumSetFFTSize));
    specExports.Set("getFFTSize", Napi::Function::New(env, SpectrumGetFFTSize));
    specExports.Set("setSampleRate", Napi::Function::New(env, SpectrumSetSampleRate));
    specExports.Set("setSmoothing", Napi::Function::New(env, SpectrumSetSmoothing));
    specExports.Set("process", Napi::Function::New(env, SpectrumProcess));
    specExports.Set("binToFrequency", Napi::Function::New(env, SpectrumBinToFrequency));
    specExports.Set("reset", Napi::Function::New(env, SpectrumReset));
    exports.Set("spectrum", specExports);

    // Vectorscope
    Napi::Object vecExports = Napi::Object::New(env);
    vecExports.Set("setSampleRate", Napi::Function::New(env, VectorscopeSetSampleRate));
    vecExports.Set("pushSamples", Napi::Function::New(env, VectorscopePushSamples));
    vecExports.Set("getPoints", Napi::Function::New(env, VectorscopeGetPoints));
    vecExports.Set("setBufferSize", Napi::Function::New(env, VectorscopeSetBufferSize));
    vecExports.Set("getBufferSize", Napi::Function::New(env, VectorscopeGetBufferSize));
    vecExports.Set("process", Napi::Function::New(env, VectorscopeProcess));
    vecExports.Set("reset", Napi::Function::New(env, VectorscopeReset));
    exports.Set("vectorscope", vecExports);

    // Native playback
    Napi::Object playbackExports = Napi::Object::New(env);
    playbackExports.Set("getCapabilities", Napi::Function::New(env, PlaybackGetCapabilities));
    playbackExports.Set("setOutputDevice", Napi::Function::New(env, PlaybackSetOutputDevice));
    playbackExports.Set("loadTrack", Napi::Function::New(env, PlaybackLoadTrack));
    playbackExports.Set("preloadNextTrack", Napi::Function::New(env, PlaybackPreloadNextTrack));
    playbackExports.Set("promoteNextTrack", Napi::Function::New(env, PlaybackPromoteNextTrack));
    playbackExports.Set("play", Napi::Function::New(env, PlaybackPlay));
    playbackExports.Set("pause", Napi::Function::New(env, PlaybackPause));
    playbackExports.Set("stop", Napi::Function::New(env, PlaybackStop));
    playbackExports.Set("seek", Napi::Function::New(env, PlaybackSeek));
    playbackExports.Set("clearNextTrack", Napi::Function::New(env, PlaybackClearNextTrack));
    playbackExports.Set("getPlaybackSnapshot", Napi::Function::New(env, PlaybackGetSnapshot));
    playbackExports.Set("setVisualizerTapDemand", Napi::Function::New(env, PlaybackSetVisualizerTapDemand));
    playbackExports.Set("drainEvents", Napi::Function::New(env, PlaybackDrainEvents));
    playbackExports.Set("flushOscilloscopeSamples", Napi::Function::New(env, PlaybackFlushOscilloscopeSamples));
    playbackExports.Set("flushSpectrumSamples", Napi::Function::New(env, PlaybackFlushSpectrumSamples));
    playbackExports.Set("flushVectorscopeSamples", Napi::Function::New(env, PlaybackFlushVectorscopeSamples));
    playbackExports.Set("flushVUMeterSamples", Napi::Function::New(env, PlaybackFlushVUMeterSamples));
    exports.Set("playback", playbackExports);

    return exports;
}

NODE_API_MODULE(visualizer_dsp, Init)
