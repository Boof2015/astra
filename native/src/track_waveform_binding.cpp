#include <napi.h>

#include <cmath>
#include <cstring>
#include <limits>
#include <utility>
#include <vector>

#include "track_waveform.h"

namespace {

struct AnalyzeRequest {
    Napi::Float32Array samples;
    std::size_t channelCount = 0;
    std::size_t resolution = Astra::StaticTrackWaveformAnalyzer::DEFAULT_RESOLUTION;
};

bool ParseAnalyzeRequest(const Napi::CallbackInfo& info, AnalyzeRequest& request) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "Expected Float32Array samples and a channel count")
            .ThrowAsJavaScriptException();
        return false;
    }

    const Napi::TypedArray typedSamples = info[0].As<Napi::TypedArray>();
    if (typedSamples.TypedArrayType() != napi_float32_array) {
        Napi::TypeError::New(env, "Static track waveform input must be a Float32Array")
            .ThrowAsJavaScriptException();
        return false;
    }

    const double channelValue = info[1].As<Napi::Number>().DoubleValue();
    if (
        !std::isfinite(channelValue)
        || channelValue < 1.0
        || channelValue > static_cast<double>(Astra::StaticTrackWaveformAnalyzer::MAX_CHANNELS)
        || std::floor(channelValue) != channelValue
    ) {
        Napi::RangeError::New(env, "Static track waveform channel count must be an integer from 1 to 32")
            .ThrowAsJavaScriptException();
        return false;
    }
    request.channelCount = static_cast<std::size_t>(channelValue);

    if (info.Length() > 2 && !info[2].IsUndefined()) {
        if (!info[2].IsNumber()) {
            Napi::TypeError::New(env, "Static track waveform resolution must be a number")
                .ThrowAsJavaScriptException();
            return false;
        }
        const double resolutionValue = info[2].As<Napi::Number>().DoubleValue();
        if (
            !std::isfinite(resolutionValue)
            || resolutionValue < 1.0
            || resolutionValue > static_cast<double>(Astra::StaticTrackWaveformAnalyzer::MAX_RESOLUTION)
            || std::floor(resolutionValue) != resolutionValue
        ) {
            Napi::RangeError::New(env, "Static track waveform resolution must be an integer from 1 to 16384")
                .ThrowAsJavaScriptException();
            return false;
        }
        request.resolution = static_cast<std::size_t>(resolutionValue);
    }

    request.samples = info[0].As<Napi::Float32Array>();
    if (request.samples.ElementLength() % request.channelCount != 0) {
        Napi::RangeError::New(env, "Static track waveform samples must contain complete interleaved frames")
            .ThrowAsJavaScriptException();
        return false;
    }
    return true;
}

Napi::Float32Array CopyWaveformToJavaScript(
    Napi::Env env,
    const std::vector<float>& peaks
) {
    Napi::Float32Array output = Napi::Float32Array::New(env, peaks.size());
    if (!peaks.empty()) {
        std::memcpy(output.Data(), peaks.data(), peaks.size() * sizeof(float));
    }
    return output;
}

Napi::Value AnalyzeInterleaved(const Napi::CallbackInfo& info) {
    AnalyzeRequest request;
    if (!ParseAnalyzeRequest(info, request)) return info.Env().Null();

    const auto peaks = Astra::StaticTrackWaveformAnalyzer::analyzeInterleaved(
        request.samples.Data(),
        request.samples.ElementLength() / request.channelCount,
        request.channelCount,
        request.resolution
    );
    return CopyWaveformToJavaScript(info.Env(), peaks);
}

class StaticTrackWaveformWorker final : public Napi::AsyncWorker {
public:
    StaticTrackWaveformWorker(
        Napi::Env env,
        const Napi::Float32Array& samples,
        std::size_t channelCount,
        std::size_t resolution
    )
        : Napi::AsyncWorker(env, "astra:StaticTrackWaveformAnalyzer"),
          deferred_(Napi::Promise::Deferred::New(env)),
          samplesReference_(Napi::Reference<Napi::Float32Array>::New(samples, 1)),
          samples_(samples.Data()),
          frameCount_(samples.ElementLength() / channelCount),
          channelCount_(channelCount),
          resolution_(resolution) {}

    Napi::Promise promise() const {
        return deferred_.Promise();
    }

protected:
    void Execute() override {
        peaks_ = Astra::StaticTrackWaveformAnalyzer::analyzeInterleaved(
            samples_,
            frameCount_,
            channelCount_,
            resolution_
        );
    }

    void OnOK() override {
        deferred_.Resolve(CopyWaveformToJavaScript(Env(), peaks_));
        samplesReference_.Reset();
    }

    void OnError(const Napi::Error& error) override {
        deferred_.Reject(error.Value());
        samplesReference_.Reset();
    }

private:
    Napi::Promise::Deferred deferred_;
    Napi::Reference<Napi::Float32Array> samplesReference_;
    const float* samples_;
    std::size_t frameCount_;
    std::size_t channelCount_;
    std::size_t resolution_;
    std::vector<float> peaks_;
};

Napi::Value AnalyzeInterleavedAsync(const Napi::CallbackInfo& info) {
    AnalyzeRequest request;
    if (!ParseAnalyzeRequest(info, request)) return info.Env().Null();

    auto* worker = new StaticTrackWaveformWorker(
        info.Env(),
        request.samples,
        request.channelCount,
        request.resolution
    );
    const Napi::Promise promise = worker->promise();
    worker->Queue();
    return promise;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("analyzeInterleaved", Napi::Function::New(env, AnalyzeInterleaved));
    exports.Set("analyzeInterleavedAsync", Napi::Function::New(env, AnalyzeInterleavedAsync));
    return exports;
}

} // namespace

NODE_API_MODULE(track_waveform, Init)
