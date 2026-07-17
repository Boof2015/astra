#include <napi.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>
#include <string>
#include "oscilloscope.h"
#include "spectrum.h"
#include "spectrogram.h"
#include "vectorscope.h"
#include "waveform.h"
#include "vumeter.h"
#include "lufsmeter.h"
#include "playback_engine.h"
#include "parallax_loopback.h"
#include "process_memory.h"

// Global instances (we could make these per-instance if needed)
static Visualizer::Oscilloscope oscilloscope;
static Visualizer::Spectrum spectrum(2048);
static Visualizer::SpectrogramAnalyzer spectrogramAnalyzer;
static Visualizer::Vectorscope vectorscope;
static Visualizer::WaveformMultibandAnalyzer waveform;
static Visualizer::VUMeterAnalyzer vuMeter;
static Visualizer::LUFSMeterAnalyzer lufsMeter;
static NativePlayback::PlaybackEngine playbackEngine;

namespace {

float GetObjectFloat(const Napi::Object& obj, const char* key, float fallback) {
    Napi::Value value = obj.Get(key);
    return value.IsNumber() ? value.As<Napi::Number>().FloatValue() : fallback;
}

size_t GetObjectSize(const Napi::Object& obj, const char* key, size_t fallback) {
    Napi::Value value = obj.Get(key);
    return value.IsNumber() ? static_cast<size_t>(value.As<Napi::Number>().Uint32Value()) : fallback;
}

std::string GetObjectString(const Napi::Object& obj, const char* key, const std::string& fallback) {
    Napi::Value value = obj.Get(key);
    return value.IsString() ? value.As<Napi::String>().Utf8Value() : fallback;
}

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
    const int activeDeviceSampleRate = playbackEngine.getActiveDeviceSampleRate();

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("bitPerfectAvailable", Napi::Boolean::New(env, bitPerfectAvailable));
    obj.Set("reasonUnavailable", bitPerfectAvailable ? env.Null() : ToNullableString(env, reason));
    obj.Set("activeBackend", Napi::String::New(env, playbackEngine.backendKind()));
    obj.Set("activeDeviceExclusive", Napi::Boolean::New(env, snapshot.activeDeviceExclusive));
    obj.Set("activeSampleRate", activeDeviceSampleRate > 0 ? Napi::Number::New(env, activeDeviceSampleRate) : env.Null());
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

// Fill a caller-provided output buffer (avoids per-frame allocation)
Napi::Value OscilloscopeFillSamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected startPos (float) and output Float32Array").ThrowAsJavaScriptException();
        return env.Null();
    }
    float startPos = info[0].As<Napi::Number>().FloatValue();
    Napi::Float32Array output = info[1].As<Napi::Float32Array>();
    const size_t count = output.ElementLength();
    oscilloscope.getSamplesInterpolated(output.Data(), startPos, count);
    return Napi::Number::New(env, static_cast<double>(count));
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

Napi::Value SpectrumPushSamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected Float32Array").ThrowAsJavaScriptException();
        return env.Null();
    }
    Napi::Float32Array audioData = info[0].As<Napi::Float32Array>();
    spectrum.pushSamples(audioData.Data(), audioData.ElementLength());
    return env.Undefined();
}

Napi::Value SpectrumPushStereoSamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected left and right Float32Array").ThrowAsJavaScriptException();
        return env.Null();
    }
    Napi::Float32Array leftData = info[0].As<Napi::Float32Array>();
    Napi::Float32Array rightData = info[1].As<Napi::Float32Array>();
    const size_t length = std::min(leftData.ElementLength(), rightData.ElementLength());
    spectrum.pushStereoSamples(leftData.Data(), rightData.Data(), length);
    return env.Undefined();
}

Napi::Value SpectrumGetMagnitudes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const auto& magnitudes = spectrum.getMagnitudes();
    Napi::Float32Array result = Napi::Float32Array::New(env, magnitudes.size());
    memcpy(result.Data(), magnitudes.data(), magnitudes.size() * sizeof(float));
    return result;
}

Napi::Value SpectrumGetRawMagnitudes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const auto& magnitudes = spectrum.getRawMagnitudes();
    Napi::Float32Array result = Napi::Float32Array::New(env, magnitudes.size());
    memcpy(result.Data(), magnitudes.data(), magnitudes.size() * sizeof(float));
    return result;
}

Napi::Value SpectrumGetSideMagnitudes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const auto& magnitudes = spectrum.getSideMagnitudes();
    Napi::Float32Array result = Napi::Float32Array::New(env, magnitudes.size());
    memcpy(result.Data(), magnitudes.data(), magnitudes.size() * sizeof(float));
    return result;
}

Napi::Value SpectrumFillRawMagnitudes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected output Float32Array").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array output = info[0].As<Napi::Float32Array>();
    const auto& magnitudes = spectrum.getRawMagnitudes();
    const size_t count = std::min(output.ElementLength(), magnitudes.size());
    if (count > 0) {
        memcpy(output.Data(), magnitudes.data(), count * sizeof(float));
    }
    return Napi::Number::New(env, static_cast<double>(count));
}

Napi::Value SpectrumFillMagnitudes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected output Float32Array").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array output = info[0].As<Napi::Float32Array>();
    const auto& magnitudes = spectrum.getMagnitudes();
    const size_t count = std::min(output.ElementLength(), magnitudes.size());
    if (count > 0) {
        memcpy(output.Data(), magnitudes.data(), count * sizeof(float));
    }
    return Napi::Number::New(env, static_cast<double>(count));
}

Napi::Value SpectrumFillSideMagnitudes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected output Float32Array").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array output = info[0].As<Napi::Float32Array>();
    const auto& magnitudes = spectrum.getSideMagnitudes();
    const size_t count = std::min(output.ElementLength(), magnitudes.size());
    if (count > 0) {
        memcpy(output.Data(), magnitudes.data(), count * sizeof(float));
    }
    return Napi::Number::New(env, static_cast<double>(count));
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

Napi::Value SpectrumConfigureBars(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Expected bar configuration object").ThrowAsJavaScriptException();
        return env.Null();
    }

    const Napi::Object input = info[0].As<Napi::Object>();
    Visualizer::SpectrumBarConfig config;
    auto readNumber = [&](const char* key, double fallback) {
        const Napi::Value value = input.Get(key);
        return value.IsNumber() ? value.As<Napi::Number>().DoubleValue() : fallback;
    };
    const double requestedBarCount = readNumber("barCount", config.requestedBarCount);
    config.requestedBarCount = std::isfinite(requestedBarCount)
        ? static_cast<size_t>(std::clamp(requestedBarCount, 1.0, 512.0))
        : config.requestedBarCount;
    config.minFrequency = static_cast<float>(readNumber("minFrequency", config.minFrequency));
    config.maxFrequency = static_cast<float>(readNumber("maxFrequency", config.maxFrequency));
    config.minDecibels = static_cast<float>(readNumber("minDecibels", config.minDecibels));
    config.maxDecibels = static_cast<float>(readNumber("maxDecibels", config.maxDecibels));
    config.tiltDbPerOctave = static_cast<float>(readNumber("tiltDbPerOctave", config.tiltDbPerOctave));
    config.heatmapTiltDbPerOctave = static_cast<float>(readNumber("heatmapTiltDbPerOctave", config.heatmapTiltDbPerOctave));
    config.tiltReferenceHz = static_cast<float>(readNumber("tiltReferenceHz", config.tiltReferenceHz));
    config.heatmapSmoothing = static_cast<float>(readNumber("heatmapSmoothing", config.heatmapSmoothing));
    const Napi::Value showPeaks = input.Get("showPeaks");
    config.showPeaks = showPeaks.IsBoolean() && showPeaks.As<Napi::Boolean>().Value();
    spectrum.configureBars(config);
    return env.Undefined();
}

Napi::Value SpectrumGetBarFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const auto& frame = info.Length() > 0 && info[0].IsNumber()
        ? spectrum.getBarFrameAtTime(info[0].As<Napi::Number>().DoubleValue())
        : spectrum.getBarFrame();
    Napi::Float32Array result = Napi::Float32Array::New(env, frame.size());
    if (!frame.empty()) {
        memcpy(result.Data(), frame.data(), frame.size() * sizeof(float));
    }
    return result;
}

Napi::Value SpectrumReset(const Napi::CallbackInfo& info) {
    spectrum.reset();
    return info.Env().Undefined();
}

// ============== Spectrogram ==============

Napi::Value SpectrogramConfigure(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Expected spectrogram options object").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Object options = info[0].As<Napi::Object>();
    Visualizer::SpectrogramConfig config;
    config.fftSize = GetObjectSize(options, "fftSize", config.fftSize);
    config.sampleRate = GetObjectFloat(options, "sampleRate", config.sampleRate);
    config.rowCount = GetObjectSize(options, "rowCount", config.rowCount);
    config.minFrequency = GetObjectFloat(options, "minFrequency", config.minFrequency);
    config.maxFrequency = GetObjectFloat(options, "maxFrequency", config.maxFrequency);
    config.minDecibels = GetObjectFloat(options, "minDecibels", config.minDecibels);
    config.maxDecibels = GetObjectFloat(options, "maxDecibels", config.maxDecibels);
    config.scrollSpeed = GetObjectFloat(options, "scrollSpeed", config.scrollSpeed);
    config.contrast = GetObjectFloat(options, "contrast", config.contrast);
    config.tiltDbPerOctave = GetObjectFloat(options, "tiltDbPerOctave", config.tiltDbPerOctave);
    config.clarityMode = GetObjectString(options, "clarityMode", config.clarityMode);
    config.scaleMode = GetObjectString(options, "scaleMode", config.scaleMode);
    config.orientation = GetObjectString(options, "orientation", config.orientation);

    spectrogramAnalyzer.configure(config);
    return env.Undefined();
}

Napi::Value SpectrogramProcess(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected Float32Array").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array audioData = info[0].As<Napi::Float32Array>();
    auto result = spectrogramAnalyzer.process(audioData.Data(), audioData.ElementLength());

    Napi::Float32Array display = Napi::Float32Array::New(env, result.display.size());
    Napi::Float32Array heat = Napi::Float32Array::New(env, result.heat.size());
    if (!result.display.empty()) {
        memcpy(display.Data(), result.display.data(), result.display.size() * sizeof(float));
    }
    if (!result.heat.empty()) {
        memcpy(heat.Data(), result.heat.data(), result.heat.size() * sizeof(float));
    }

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("display", display);
    obj.Set("heat", heat);
    obj.Set("columnCount", Napi::Number::New(env, static_cast<double>(result.columnCount)));
    obj.Set("rowCount", Napi::Number::New(env, static_cast<double>(result.rowCount)));
    return obj;
}

Napi::Value SpectrogramReset(const Napi::CallbackInfo& info) {
    spectrogramAnalyzer.reset();
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

Napi::Value VectorscopePushMultibandSamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected two Float32Arrays (left, right)").ThrowAsJavaScriptException();
        return env.Null();
    }
    Napi::Float32Array leftData = info[0].As<Napi::Float32Array>();
    Napi::Float32Array rightData = info[1].As<Napi::Float32Array>();
    size_t length = std::min(leftData.ElementLength(), rightData.ElementLength());
    vectorscope.pushMultibandSamples(leftData.Data(), rightData.Data(), length);
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

Napi::Value VectorscopeGetMultibandPoints(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected max points count").ThrowAsJavaScriptException();
        return env.Null();
    }

    const size_t maxPoints = static_cast<size_t>(info[0].As<Napi::Number>().Uint32Value());
    Napi::Float32Array data = Napi::Float32Array::New(env, maxPoints * Visualizer::MULTIBAND_POINT_STRIDE);
    const size_t actual = vectorscope.getMultibandPoints(data.Data(), maxPoints);

    Napi::Object result = Napi::Object::New(env);
    if (actual < maxPoints) {
        Napi::Float32Array trimmed = Napi::Float32Array::New(env, actual * Visualizer::MULTIBAND_POINT_STRIDE);
        if (actual > 0) {
            memcpy(trimmed.Data(), data.Data(), actual * Visualizer::MULTIBAND_POINT_STRIDE * sizeof(float));
        }
        result.Set("data", trimmed);
    } else {
        result.Set("data", data);
    }
    result.Set("count", Napi::Number::New(env, static_cast<double>(actual)));
    return result;
}

Napi::Value VectorscopeFillPoints(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected output x/y Float32Arrays").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array xArray = info[0].As<Napi::Float32Array>();
    Napi::Float32Array yArray = info[1].As<Napi::Float32Array>();
    const size_t maxPoints = std::min(xArray.ElementLength(), yArray.ElementLength());
    const size_t actual = vectorscope.getPoints(xArray.Data(), yArray.Data(), maxPoints);
    return Napi::Number::New(env, static_cast<double>(actual));
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

// ============== Waveform ==============

Napi::Value WaveformConfigure(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "Expected sample rate and samples per column").ThrowAsJavaScriptException();
        return env.Null();
    }

    const float sampleRate = info[0].As<Napi::Number>().FloatValue();
    const size_t samplesPerColumn = static_cast<size_t>(info[1].As<Napi::Number>().Uint32Value());
    waveform.configure(sampleRate, samplesPerColumn);
    return env.Undefined();
}

Napi::Value WaveformProcessMono(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected Float32Array").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array samples = info[0].As<Napi::Float32Array>();
    const auto& summaries = waveform.processMono(samples.Data(), samples.ElementLength());
    Napi::Float32Array result = Napi::Float32Array::New(env, summaries.size());
    if (!summaries.empty()) {
        memcpy(result.Data(), summaries.data(), summaries.size() * sizeof(float));
    }
    return result;
}

Napi::Value WaveformProcessStereo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected two Float32Arrays (left, right)").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array leftData = info[0].As<Napi::Float32Array>();
    Napi::Float32Array rightData = info[1].As<Napi::Float32Array>();
    const size_t length = std::min(leftData.ElementLength(), rightData.ElementLength());
    const auto& summaries = waveform.processStereo(leftData.Data(), rightData.Data(), length);
    Napi::Float32Array result = Napi::Float32Array::New(env, summaries.size());
    if (!summaries.empty()) {
        memcpy(result.Data(), summaries.data(), summaries.size() * sizeof(float));
    }
    return result;
}

Napi::Value WaveformReset(const Napi::CallbackInfo& info) {
    waveform.reset();
    return info.Env().Undefined();
}

// ============== VU Meter ==============

Napi::Value VUMeterSetSampleRate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected sample rate").ThrowAsJavaScriptException();
        return env.Null();
    }
    vuMeter.setSampleRate(info[0].As<Napi::Number>().FloatValue());
    return env.Undefined();
}

Napi::Value VUMeterPushSamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected two Float32Arrays (left, right)").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array leftData = info[0].As<Napi::Float32Array>();
    Napi::Float32Array rightData = info[1].As<Napi::Float32Array>();
    const size_t length = std::min(leftData.ElementLength(), rightData.ElementLength());
    vuMeter.pushSamples(leftData.Data(), rightData.Data(), length);
    return env.Undefined();
}

Napi::Value VUMeterGetSnapshot(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const auto snapshot = vuMeter.getSnapshot();

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("vuLDb", Napi::Number::New(env, snapshot.vuLDb));
    obj.Set("vuRDb", Napi::Number::New(env, snapshot.vuRDb));
    obj.Set("barLDb", Napi::Number::New(env, snapshot.barLDb));
    obj.Set("barRDb", Napi::Number::New(env, snapshot.barRDb));
    obj.Set("peakLDb", Napi::Number::New(env, snapshot.peakLDb));
    obj.Set("peakRDb", Napi::Number::New(env, snapshot.peakRDb));
    obj.Set("correlation", Napi::Number::New(env, snapshot.correlation));
    return obj;
}

Napi::Value VUMeterReset(const Napi::CallbackInfo& info) {
    vuMeter.reset();
    return info.Env().Undefined();
}

// ============== LUFS Meter ==============

Napi::Value LUFSMeterSetSampleRate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected sample rate").ThrowAsJavaScriptException();
        return env.Null();
    }
    lufsMeter.setSampleRate(info[0].As<Napi::Number>().FloatValue());
    return env.Undefined();
}

Napi::Value LUFSMeterPushSamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected two Float32Arrays (left, right)").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array leftData = info[0].As<Napi::Float32Array>();
    Napi::Float32Array rightData = info[1].As<Napi::Float32Array>();
    const size_t length = std::min(leftData.ElementLength(), rightData.ElementLength());
    lufsMeter.pushSamples(leftData.Data(), rightData.Data(), length);
    return env.Undefined();
}

Napi::Value LUFSMeterGetSnapshot(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const auto snapshot = lufsMeter.getSnapshot();

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("momentaryLUFS", Napi::Number::New(env, snapshot.momentaryLUFS));
    obj.Set("shortTermLUFS", Napi::Number::New(env, snapshot.shortTermLUFS));
    obj.Set("integratedLUFS", Napi::Number::New(env, snapshot.integratedLUFS));
    obj.Set("vuLDb", Napi::Number::New(env, snapshot.vuLDb));
    obj.Set("vuRDb", Napi::Number::New(env, snapshot.vuRDb));
    obj.Set("barLDb", Napi::Number::New(env, snapshot.barLDb));
    obj.Set("barRDb", Napi::Number::New(env, snapshot.barRDb));
    obj.Set("peakLDb", Napi::Number::New(env, snapshot.peakLDb));
    obj.Set("peakRDb", Napi::Number::New(env, snapshot.peakRDb));
    obj.Set("correlation", Napi::Number::New(env, snapshot.correlation));
    return obj;
}

Napi::Value LUFSMeterReset(const Napi::CallbackInfo& info) {
    lufsMeter.reset();
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

class PlaybackPlayAsyncWorker : public Napi::AsyncWorker {
public:
    PlaybackPlayAsyncWorker(Napi::Promise::Deferred deferred)
        : Napi::AsyncWorker(deferred.Env()), deferred_(std::move(deferred)) {}

    void Execute() override {
        // Runs on a libuv worker thread; V8 is free during this call.
        // On the Scarlett 4th gen and similar USB DACs, AudioOutputUnitStart
        // can take ~1s per format change. Keeping it off V8 keeps the UI responsive.
        try {
            snapshot_ = playbackEngine.play();
        } catch (const std::exception& e) {
            errorMessage_ = e.what();
            if (errorMessage_.empty()) {
                errorMessage_ = "Native playback start failed.";
            }
        } catch (...) {
            errorMessage_ = "Native playback start failed with an unknown error.";
        }
    }

    void OnOK() override {
        Napi::HandleScope scope(Env());
        if (!errorMessage_.empty()) {
            deferred_.Reject(Napi::Error::New(Env(), errorMessage_).Value());
            return;
        }
        deferred_.Resolve(CreatePlaybackSnapshotObject(Env(), snapshot_));
    }

    void OnError(const Napi::Error& error) override {
        Napi::HandleScope scope(Env());
        deferred_.Reject(error.Value());
    }

private:
    Napi::Promise::Deferred deferred_;
    NativePlayback::PlaybackSnapshot snapshot_ {};
    std::string errorMessage_;
};

Napi::Value PlaybackPlay(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto* worker = new PlaybackPlayAsyncWorker(deferred);
    worker->Queue();
    return deferred.Promise();
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
    oscExports.Set("fillSamples", Napi::Function::New(env, OscilloscopeFillSamples));
    oscExports.Set("getSamples", Napi::Function::New(env, OscilloscopeGetSamples));
    oscExports.Set("reset", Napi::Function::New(env, OscilloscopeReset));
    exports.Set("oscilloscope", oscExports);

    // Spectrum
    Napi::Object specExports = Napi::Object::New(env);
    specExports.Set("setFFTSize", Napi::Function::New(env, SpectrumSetFFTSize));
    specExports.Set("getFFTSize", Napi::Function::New(env, SpectrumGetFFTSize));
    specExports.Set("setSampleRate", Napi::Function::New(env, SpectrumSetSampleRate));
    specExports.Set("setSmoothing", Napi::Function::New(env, SpectrumSetSmoothing));
    specExports.Set("pushSamples", Napi::Function::New(env, SpectrumPushSamples));
    specExports.Set("pushStereoSamples", Napi::Function::New(env, SpectrumPushStereoSamples));
    specExports.Set("fillRawMagnitudes", Napi::Function::New(env, SpectrumFillRawMagnitudes));
    specExports.Set("fillMagnitudes", Napi::Function::New(env, SpectrumFillMagnitudes));
    specExports.Set("fillSideMagnitudes", Napi::Function::New(env, SpectrumFillSideMagnitudes));
    specExports.Set("getRawMagnitudes", Napi::Function::New(env, SpectrumGetRawMagnitudes));
    specExports.Set("getMagnitudes", Napi::Function::New(env, SpectrumGetMagnitudes));
    specExports.Set("getSideMagnitudes", Napi::Function::New(env, SpectrumGetSideMagnitudes));
    specExports.Set("process", Napi::Function::New(env, SpectrumProcess));
    specExports.Set("binToFrequency", Napi::Function::New(env, SpectrumBinToFrequency));
    specExports.Set("configureBars", Napi::Function::New(env, SpectrumConfigureBars));
    specExports.Set("getBarFrame", Napi::Function::New(env, SpectrumGetBarFrame));
    specExports.Set("reset", Napi::Function::New(env, SpectrumReset));
    exports.Set("spectrum", specExports);

    // Spectrogram
    Napi::Object spectrogramExports = Napi::Object::New(env);
    spectrogramExports.Set("configure", Napi::Function::New(env, SpectrogramConfigure));
    spectrogramExports.Set("process", Napi::Function::New(env, SpectrogramProcess));
    spectrogramExports.Set("reset", Napi::Function::New(env, SpectrogramReset));
    exports.Set("spectrogram", spectrogramExports);

    // Vectorscope
    Napi::Object vecExports = Napi::Object::New(env);
    vecExports.Set("setSampleRate", Napi::Function::New(env, VectorscopeSetSampleRate));
    vecExports.Set("pushSamples", Napi::Function::New(env, VectorscopePushSamples));
    vecExports.Set("pushMultibandSamples", Napi::Function::New(env, VectorscopePushMultibandSamples));
    vecExports.Set("fillPoints", Napi::Function::New(env, VectorscopeFillPoints));
    vecExports.Set("getPoints", Napi::Function::New(env, VectorscopeGetPoints));
    vecExports.Set("getMultibandPoints", Napi::Function::New(env, VectorscopeGetMultibandPoints));
    vecExports.Set("setBufferSize", Napi::Function::New(env, VectorscopeSetBufferSize));
    vecExports.Set("getBufferSize", Napi::Function::New(env, VectorscopeGetBufferSize));
    vecExports.Set("process", Napi::Function::New(env, VectorscopeProcess));
    vecExports.Set("reset", Napi::Function::New(env, VectorscopeReset));
    exports.Set("vectorscope", vecExports);

    // Waveform
    Napi::Object waveformExports = Napi::Object::New(env);
    waveformExports.Set("configure", Napi::Function::New(env, WaveformConfigure));
    waveformExports.Set("processMono", Napi::Function::New(env, WaveformProcessMono));
    waveformExports.Set("processStereo", Napi::Function::New(env, WaveformProcessStereo));
    waveformExports.Set("reset", Napi::Function::New(env, WaveformReset));
    exports.Set("waveform", waveformExports);

    // VU Meter
    Napi::Object vuExports = Napi::Object::New(env);
    vuExports.Set("setSampleRate", Napi::Function::New(env, VUMeterSetSampleRate));
    vuExports.Set("pushSamples", Napi::Function::New(env, VUMeterPushSamples));
    vuExports.Set("getSnapshot", Napi::Function::New(env, VUMeterGetSnapshot));
    vuExports.Set("reset", Napi::Function::New(env, VUMeterReset));
    exports.Set("vumeter", vuExports);

    // LUFS Meter
    Napi::Object lufsExports = Napi::Object::New(env);
    lufsExports.Set("setSampleRate", Napi::Function::New(env, LUFSMeterSetSampleRate));
    lufsExports.Set("pushSamples", Napi::Function::New(env, LUFSMeterPushSamples));
    lufsExports.Set("getSnapshot", Napi::Function::New(env, LUFSMeterGetSnapshot));
    lufsExports.Set("reset", Napi::Function::New(env, LUFSMeterReset));
    exports.Set("lufsmeter", lufsExports);

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

    // §22 Commit 1 — Parallax loopback capture. Windows-only behavior; stubbed on
    // macOS/Linux so the JS surface is platform-uniform (renderer just sees `supported: false`).
    exports.Set("parallaxLoopback", ParallaxLoopback::Register(env));
    exports.Set("processMemory", ProcessMemory::Register(env));

    return exports;
}

NODE_API_MODULE(visualizer_dsp, Init)
