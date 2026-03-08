#include <algorithm>
#include <string>
#include <vector>

#include <napi.h>

#include "native_audio.h"

namespace {

using NativeAudio::DecodedSamples;
using NativeAudio::DeviceInfo;
using NativeAudio::EQBandConfig;
using NativeAudio::EQBandType;
using NativeAudio::Engine;
using NativeAudio::PlaybackState;
using NativeAudio::SpectrumSamples;
using NativeAudio::VisualizerSamples;

Engine engine;

std::string stateToString(PlaybackState state) {
    switch (state) {
        case PlaybackState::Playing:
            return "playing";
        case PlaybackState::Paused:
            return "paused";
        case PlaybackState::Stopped:
        default:
            return "stopped";
    }
}

EQBandType parseBandType(const std::string& value) {
    if (value == "lowshelf") return EQBandType::LowShelf;
    if (value == "highshelf") return EQBandType::HighShelf;
    return EQBandType::Peaking;
}

Napi::Value Initialize(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), engine.initialize());
}

Napi::Value Shutdown(const Napi::CallbackInfo& info) {
    engine.shutdown();
    return info.Env().Undefined();
}

Napi::Value LoadFromBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsArrayBuffer()) {
        Napi::TypeError::New(env, "Expected ArrayBuffer").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::ArrayBuffer arrayBuffer = info[0].As<Napi::ArrayBuffer>();
    if (!engine.loadFromMemory(arrayBuffer.Data(), arrayBuffer.ByteLength())) {
        Napi::Error::New(env, "Failed to decode audio data").ThrowAsJavaScriptException();
        return env.Null();
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value PreBufferFromBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsArrayBuffer()) {
        Napi::TypeError::New(env, "Expected ArrayBuffer").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::ArrayBuffer arrayBuffer = info[0].As<Napi::ArrayBuffer>();
    if (!engine.preBufferFromMemory(arrayBuffer.Data(), arrayBuffer.ByteLength())) {
        Napi::Error::New(env, "Failed to pre-buffer audio data").ThrowAsJavaScriptException();
        return env.Null();
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value ClearNextBuffer(const Napi::CallbackInfo& info) {
    engine.clearNextBuffer();
    return info.Env().Undefined();
}

Napi::Value Play(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), engine.play());
}

Napi::Value Pause(const Napi::CallbackInfo& info) {
    engine.pause();
    return info.Env().Undefined();
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
    engine.stop();
    return info.Env().Undefined();
}

Napi::Value Seek(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected seconds").ThrowAsJavaScriptException();
        return env.Null();
    }

    engine.seek(info[0].As<Napi::Number>().DoubleValue());
    return env.Undefined();
}

Napi::Value GetPosition(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), engine.getPosition());
}

Napi::Value GetDuration(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), engine.getDuration());
}

Napi::Value GetState(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), stateToString(engine.getState()));
}

Napi::Value SetVolume(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected volume").ThrowAsJavaScriptException();
        return env.Null();
    }

    engine.setVolume(info[0].As<Napi::Number>().FloatValue());
    return env.Undefined();
}

Napi::Value SetMuted(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBoolean()) {
        Napi::TypeError::New(env, "Expected muted boolean").ThrowAsJavaScriptException();
        return env.Null();
    }

    engine.setMuted(info[0].As<Napi::Boolean>().Value());
    return env.Undefined();
}

Napi::Value SetExclusiveMode(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBoolean()) {
        Napi::TypeError::New(env, "Expected exclusive mode boolean").ThrowAsJavaScriptException();
        return env.Null();
    }

    engine.setExclusiveMode(info[0].As<Napi::Boolean>().Value());
    return Napi::Boolean::New(env, engine.isExclusiveModeActive());
}

Napi::Value IsExclusiveModeActive(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), engine.isExclusiveModeActive());
}

Napi::Value SetDspEnabled(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBoolean()) {
        Napi::TypeError::New(env, "Expected DSP enabled boolean").ThrowAsJavaScriptException();
        return env.Null();
    }

    engine.setDspEnabled(info[0].As<Napi::Boolean>().Value());
    return env.Undefined();
}

Napi::Value SetNormalizationGain(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected normalization gain").ThrowAsJavaScriptException();
        return env.Null();
    }

    engine.setNormalizationGain(info[0].As<Napi::Number>().FloatValue());
    return env.Undefined();
}

Napi::Value SetAnalysisDelayMs(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected delay in ms").ThrowAsJavaScriptException();
        return env.Null();
    }

    engine.setAnalysisDelayMs(info[0].As<Napi::Number>().Uint32Value());
    return env.Undefined();
}

Napi::Value SetMultichannelEnabled(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBoolean()) {
        Napi::TypeError::New(env, "Expected multichannel enabled boolean").ThrowAsJavaScriptException();
        return env.Null();
    }

    engine.setMultichannelEnabled(info[0].As<Napi::Boolean>().Value());
    return env.Undefined();
}

Napi::Value SetChannelRoutingMap(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || (!info[0].IsArray() && !info[0].IsNull() && !info[0].IsUndefined())) {
        Napi::TypeError::New(env, "Expected channel routing array").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::vector<int> routingMap;
    if (info[0].IsArray()) {
        Napi::Array array = info[0].As<Napi::Array>();
        routingMap.reserve(array.Length());
        for (uint32_t i = 0; i < array.Length(); ++i) {
            Napi::Value value = array.Get(i);
            if (!value.IsNumber()) {
                routingMap.push_back(-1);
                continue;
            }
            routingMap.push_back(value.As<Napi::Number>().Int32Value());
        }
    }

    engine.setChannelRoutingMap(routingMap);
    return env.Undefined();
}

Napi::Value UpdateEQ(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsArray() || !info[1].IsNumber() || !info[2].IsBoolean()) {
        Napi::TypeError::New(env, "Expected (bands, preampDb, enabled)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::vector<EQBandConfig> bands;
    Napi::Array bandArray = info[0].As<Napi::Array>();
    bands.reserve(bandArray.Length());

    for (uint32_t i = 0; i < bandArray.Length(); ++i) {
        Napi::Value value = bandArray.Get(i);
        if (!value.IsObject()) continue;
        Napi::Object bandObject = value.As<Napi::Object>();
        EQBandConfig band;
        if (bandObject.Has("type") && bandObject.Get("type").IsString()) {
            band.type = parseBandType(bandObject.Get("type").As<Napi::String>().Utf8Value());
        }
        if (bandObject.Has("frequency") && bandObject.Get("frequency").IsNumber()) {
            band.frequency = bandObject.Get("frequency").As<Napi::Number>().FloatValue();
        }
        if (bandObject.Has("gain") && bandObject.Get("gain").IsNumber()) {
            band.gainDB = bandObject.Get("gain").As<Napi::Number>().FloatValue();
        }
        if (bandObject.Has("Q") && bandObject.Get("Q").IsNumber()) {
            band.q = bandObject.Get("Q").As<Napi::Number>().FloatValue();
        }
        bands.push_back(band);
    }

    engine.updateEQ(
        bands,
        info[1].As<Napi::Number>().FloatValue(),
        info[2].As<Napi::Boolean>().Value()
    );
    return env.Undefined();
}

Napi::Value EnumerateDevices(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::vector<DeviceInfo> devices = engine.enumerateDevices();
    Napi::Array result = Napi::Array::New(env, devices.size());

    for (size_t i = 0; i < devices.size(); ++i) {
        Napi::Object device = Napi::Object::New(env);
        device.Set("deviceId", devices[i].deviceId);
        device.Set("label", devices[i].label);
        device.Set("groupId", devices[i].groupId);
        device.Set("isDefaultAlias", Napi::Boolean::New(env, devices[i].isDefaultAlias));
        device.Set("maxChannels", Napi::Number::New(env, devices[i].maxChannels));
        device.Set("supportsExclusive", Napi::Boolean::New(env, devices[i].supportsExclusive));
        result.Set(i, device);
    }

    return result;
}

Napi::Value SelectDevice(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected device id").ThrowAsJavaScriptException();
        return env.Null();
    }

    return Napi::Boolean::New(env, engine.selectDevice(info[0].As<Napi::String>().Utf8Value()));
}

Napi::Value GetOutputMaxChannelCount(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), engine.getOutputMaxChannelCount());
}

Napi::Value GetCurrentTrackChannelCount(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), engine.getCurrentTrackChannelCount());
}

Napi::Value GetSampleRate(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), engine.getSampleRate());
}

Napi::Value GetDeviceSampleRate(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), engine.getDeviceSampleRate());
}

Napi::Value ReadVisualizerSamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected max frames").ThrowAsJavaScriptException();
        return env.Null();
    }

    VisualizerSamples samples = engine.readVisualizerSamples(info[0].As<Napi::Number>().Uint32Value());
    Napi::Object result = Napi::Object::New(env);
    Napi::Float32Array mono = Napi::Float32Array::New(env, samples.mono.size());
    Napi::Float32Array left = Napi::Float32Array::New(env, samples.left.size());
    Napi::Float32Array right = Napi::Float32Array::New(env, samples.right.size());

    if (!samples.mono.empty()) {
        std::copy(samples.mono.begin(), samples.mono.end(), mono.Data());
        std::copy(samples.left.begin(), samples.left.end(), left.Data());
        std::copy(samples.right.begin(), samples.right.end(), right.Data());
    }

    result.Set("mono", mono);
    result.Set("left", left);
    result.Set("right", right);
    result.Set("count", Napi::Number::New(env, samples.count));
    return result;
}

Napi::Value ReadPostEqSpectrumSamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected max frames").ThrowAsJavaScriptException();
        return env.Null();
    }

    SpectrumSamples samples = engine.readPostEqSpectrumSamples(info[0].As<Napi::Number>().Uint32Value());
    Napi::Object result = Napi::Object::New(env);
    Napi::Float32Array mono = Napi::Float32Array::New(env, samples.mono.size());
    if (!samples.mono.empty()) {
        std::copy(samples.mono.begin(), samples.mono.end(), mono.Data());
    }
    result.Set("mono", mono);
    result.Set("count", Napi::Number::New(env, samples.count));
    return result;
}

Napi::Value GetDecodedSamples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    DecodedSamples decoded = engine.getDecodedSamples();
    if (decoded.samples.empty() || decoded.channels == 0 || decoded.sampleRate == 0) {
        return env.Null();
    }

    Napi::Object result = Napi::Object::New(env);
    Napi::Float32Array samples = Napi::Float32Array::New(env, decoded.samples.size());
    std::copy(decoded.samples.begin(), decoded.samples.end(), samples.Data());

    result.Set("samples", samples);
    result.Set("channels", Napi::Number::New(env, decoded.channels));
    result.Set("sampleRate", Napi::Number::New(env, decoded.sampleRate));
    return result;
}

Napi::Value DidGaplessTransition(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), engine.didGaplessTransition());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("initialize", Napi::Function::New(env, Initialize));
    exports.Set("shutdown", Napi::Function::New(env, Shutdown));
    exports.Set("loadFromBuffer", Napi::Function::New(env, LoadFromBuffer));
    exports.Set("preBufferFromBuffer", Napi::Function::New(env, PreBufferFromBuffer));
    exports.Set("clearNextBuffer", Napi::Function::New(env, ClearNextBuffer));
    exports.Set("play", Napi::Function::New(env, Play));
    exports.Set("pause", Napi::Function::New(env, Pause));
    exports.Set("stop", Napi::Function::New(env, Stop));
    exports.Set("seek", Napi::Function::New(env, Seek));
    exports.Set("getPosition", Napi::Function::New(env, GetPosition));
    exports.Set("getDuration", Napi::Function::New(env, GetDuration));
    exports.Set("getState", Napi::Function::New(env, GetState));
    exports.Set("setVolume", Napi::Function::New(env, SetVolume));
    exports.Set("setMuted", Napi::Function::New(env, SetMuted));
    exports.Set("setExclusiveMode", Napi::Function::New(env, SetExclusiveMode));
    exports.Set("isExclusiveModeActive", Napi::Function::New(env, IsExclusiveModeActive));
    exports.Set("setDspEnabled", Napi::Function::New(env, SetDspEnabled));
    exports.Set("setNormalizationGain", Napi::Function::New(env, SetNormalizationGain));
    exports.Set("setAnalysisDelayMs", Napi::Function::New(env, SetAnalysisDelayMs));
    exports.Set("setMultichannelEnabled", Napi::Function::New(env, SetMultichannelEnabled));
    exports.Set("setChannelRoutingMap", Napi::Function::New(env, SetChannelRoutingMap));
    exports.Set("updateEQ", Napi::Function::New(env, UpdateEQ));
    exports.Set("enumerateDevices", Napi::Function::New(env, EnumerateDevices));
    exports.Set("selectDevice", Napi::Function::New(env, SelectDevice));
    exports.Set("getOutputMaxChannelCount", Napi::Function::New(env, GetOutputMaxChannelCount));
    exports.Set("getCurrentTrackChannelCount", Napi::Function::New(env, GetCurrentTrackChannelCount));
    exports.Set("getSampleRate", Napi::Function::New(env, GetSampleRate));
    exports.Set("getDeviceSampleRate", Napi::Function::New(env, GetDeviceSampleRate));
    exports.Set("readVisualizerSamples", Napi::Function::New(env, ReadVisualizerSamples));
    exports.Set("readPostEqSpectrumSamples", Napi::Function::New(env, ReadPostEqSpectrumSamples));
    exports.Set("getDecodedSamples", Napi::Function::New(env, GetDecodedSamples));
    exports.Set("didGaplessTransition", Napi::Function::New(env, DidGaplessTransition));
    return exports;
}

}  // namespace

NODE_API_MODULE(native_audio, Init)
