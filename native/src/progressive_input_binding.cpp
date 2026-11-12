#include "progressive_input_binding.h"
#include "progressive_pcm_input.h"

#include <atomic>
#include <cmath>
#include <stdexcept>

namespace NativePlayback {
namespace {
constexpr uint64_t kMaxSafeInteger = 9007199254740991ULL;
std::atomic<uint64_t> nextSessionId {1};

struct BindingContext {
    PlaybackEngine& engine;
    SnapshotObjectFactory snapshotFactory;
};

uint64_t Integer(Napi::Value value, const char* name, uint64_t min, uint64_t max) {
    if (!value.IsNumber()) throw std::invalid_argument(std::string("Expected numeric ") + name);
    const double number = value.As<Napi::Number>().DoubleValue();
    if (!std::isfinite(number) || number < min || number > max || std::floor(number) != number) {
        throw std::invalid_argument(std::string("Invalid ") + name);
    }
    return static_cast<uint64_t>(number);
}

class SeekWorker final : public Napi::AsyncWorker {
public:
    SeekWorker(Napi::Env env, BindingContext& context, uint64_t expected, ProgressiveTrack track)
        : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), context_(context),
          expected_(expected), track_(std::move(track)) {}
    Napi::Promise promise() const { return deferred_.Promise(); }
    void Execute() override {
        try { snapshot_ = context_.engine.seekProgressiveTrack(expected_, std::move(track_)); }
        catch (const std::exception& error) { SetError(error.what()); }
        catch (...) { SetError("Native progressive seek failed."); }
    }
    void OnOK() override { deferred_.Resolve(context_.snapshotFactory(Env(), snapshot_)); }
    void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }
private:
    Napi::Promise::Deferred deferred_;
    BindingContext& context_;
    uint64_t expected_;
    ProgressiveTrack track_;
    PlaybackSnapshot snapshot_;
};

class ProgressiveInputBinding final : public Napi::ObjectWrap<ProgressiveInputBinding> {
public:
    explicit ProgressiveInputBinding(const Napi::CallbackInfo& info)
        : Napi::ObjectWrap<ProgressiveInputBinding>(info), context_(*static_cast<BindingContext*>(info.Data())) {
        try {
            if (!info[0].IsObject()) throw std::invalid_argument("Expected progressive input options.");
            const auto options = info[0].As<Napi::Object>();
            const auto rate = Integer(options.Get("sampleRate"), "sample rate", 8000, 768000);
            const auto channels = Integer(options.Get("channels"), "channels", 1, 8);
            const auto formatValue = options.Get("sampleFormat");
            if (!formatValue.IsString()) throw std::invalid_argument("Expected PCM sample format.");
            const auto format = formatValue.As<Napi::String>().Utf8Value();
            if (format != "s16" && format != "s24" && format != "s32" && format != "f32") {
                throw std::invalid_argument("Unsupported progressive PCM format.");
            }
            track_.format = BuildTrackFormat(static_cast<uint32_t>(rate), static_cast<uint32_t>(channels), format);
            const auto capacity = Integer(options.Get("capacityFrames"), "capacity", 1,
                ProgressivePcmInput::kMaxBytes / track_.format.bytesPerFrame());
            const auto start = options.Has("startFrame")
                ? Integer(options.Get("startFrame"), "starting frame", 0, kMaxSafeInteger - capacity) : 0;
            if (options.Has("duration")) {
                const auto duration = options.Get("duration");
                if (!duration.IsNumber()) throw std::invalid_argument("Expected track duration.");
                track_.duration = duration.As<Napi::Number>().DoubleValue();
                if (!std::isfinite(track_.duration) || track_.duration < 0) throw std::invalid_argument("Invalid track duration.");
            }
            if (options.Has("gain")) {
                const auto value = options.Get("gain");
                if (!value.IsObject()) throw std::invalid_argument("Expected track gain.");
                const auto gain = value.As<Napi::Object>();
                const auto mode = gain.Get("mode");
                const auto db = gain.Get("gainDb");
                if (!mode.IsString() || !db.IsNumber()) throw std::invalid_argument("Invalid track gain.");
                const auto modeId = mode.As<Napi::String>().Utf8Value();
                if (modeId != "off" && modeId != "normalization" && modeId != "replaygain") throw std::invalid_argument("Invalid gain mode.");
                track_.gain.mode = modeId == "normalization" ? TrackGainMode::Normalization
                    : modeId == "replaygain" ? TrackGainMode::ReplayGain : TrackGainMode::Off;
                const double gainDb = db.As<Napi::Number>().DoubleValue();
                if (!std::isfinite(gainDb)) throw std::invalid_argument("Invalid gain value.");
                track_.gain.gainDb = std::clamp(gainDb, -24.0, 12.0);
            }
            track_.sessionId = nextSessionId.fetch_add(1);
            if (track_.sessionId > kMaxSafeInteger) throw std::runtime_error("Native session IDs exhausted.");
            track_.input = std::make_shared<ProgressivePcmInput>(track_.format.bytesPerFrame(), capacity, start);
            externalBytes_ = static_cast<int64_t>(track_.input->capacityBytes());
            Napi::MemoryManagement::AdjustExternalMemory(info.Env(), externalBytes_);
        } catch (const std::exception& error) {
            Napi::TypeError::New(info.Env(), error.what()).ThrowAsJavaScriptException();
        }
    }

    ~ProgressiveInputBinding() override {
        if (externalBytes_) Napi::MemoryManagement::AdjustExternalMemory(Env(), -externalBytes_);
    }

    static Napi::Value Create(const Napi::CallbackInfo& info) {
        // Each handle owns its native shared input; no unbounded global handle
        // registry or JS PCM pointer is retained. The engine owns its own copy.
        auto constructor = DefineClass(info.Env(), "NativeProgressiveInput", {
            InstanceMethod("append", &ProgressiveInputBinding::Append),
            InstanceMethod("finish", &ProgressiveInputBinding::Finish),
            InstanceMethod("cancel", &ProgressiveInputBinding::Cancel),
            InstanceMethod("status", &ProgressiveInputBinding::Status),
            InstanceMethod("load", &ProgressiveInputBinding::Load),
            InstanceMethod("preloadNext", &ProgressiveInputBinding::PreloadNext),
            InstanceMethod("seek", &ProgressiveInputBinding::Seek)
        }, info.Data());
        return constructor.New({info[0]});
    }

private:
    Napi::Value Append(const Napi::CallbackInfo& info) {
        if (!info[0].IsTypedArray() || info[0].As<Napi::TypedArray>().TypedArrayType() != napi_uint8_array) {
            Napi::TypeError::New(info.Env(), "Expected Uint8Array PCM.").ThrowAsJavaScriptException();
            return info.Env().Null();
        }
        const auto bytes = info[0].As<Napi::Uint8Array>();
        const auto stride = track_.format.bytesPerFrame();
        if (bytes.ByteLength() % stride) {
            Napi::TypeError::New(info.Env(), "PCM append must contain complete frames.").ThrowAsJavaScriptException();
            return info.Env().Null();
        }
        if (bytes.ByteLength() / stride > kMaxSafeInteger - track_.input->snapshot().publishedFrame) {
            Napi::RangeError::New(info.Env(), "Progressive frame position exceeds JavaScript precision.").ThrowAsJavaScriptException();
            return info.Env().Null();
        }
        return Napi::Number::New(info.Env(), track_.input->append(bytes.Data(), bytes.ByteLength() / stride));
    }
    Napi::Value Finish(const Napi::CallbackInfo& info) { return Napi::Boolean::New(info.Env(), track_.input->finish()); }
    Napi::Value Cancel(const Napi::CallbackInfo& info) { track_.input->cancel(); return info.Env().Undefined(); }
    Napi::Value Status(const Napi::CallbackInfo& info) {
        const auto view = track_.input->snapshot();
        auto result = Napi::Object::New(info.Env());
        result.Set("sessionId", Napi::Number::New(info.Env(), track_.sessionId));
        result.Set("startFrame", Napi::Number::New(info.Env(), track_.input->startFrame()));
        result.Set("retainedFrame", Napi::Number::New(info.Env(), view.retainedFrame));
        result.Set("publishedFrame", Napi::Number::New(info.Env(), view.publishedFrame));
        result.Set("capacityFrames", Napi::Number::New(info.Env(), track_.input->capacityBytes() / track_.format.bytesPerFrame()));
        result.Set("sampleRate", Napi::Number::New(info.Env(), track_.format.sampleRate));
        result.Set("bytesPerFrame", Napi::Number::New(info.Env(), track_.format.bytesPerFrame()));
        result.Set("state", view.state == PcmInputState::Open ? "open" : view.state == PcmInputState::Ended ? "ended" : "cancelled");
        return result;
    }
    Napi::Value Load(const Napi::CallbackInfo& info) {
        try {
            RequireUnused();
            context_.engine.loadProgressiveTrack(track_);
            attached_ = true;
            return context_.snapshotFactory(info.Env(), context_.engine.getSnapshot());
        } catch (const std::exception& error) { return Throw(info, error); }
    }
    Napi::Value PreloadNext(const Napi::CallbackInfo& info) {
        try {
            RequireUnused();
            context_.engine.preloadNextProgressiveTrack(track_);
            attached_ = true;
            return info.Env().Undefined();
        }
        catch (const std::exception& error) { return Throw(info, error); }
    }
    Napi::Value Seek(const Napi::CallbackInfo& info) {
        try {
            RequireUnused();
            const auto expected = Integer(info[0], "expected session ID", 1, kMaxSafeInteger);
            auto* worker = new SeekWorker(info.Env(), context_, expected, track_);
            auto promise = worker->promise();
            worker->Queue();
            attached_ = true;
            return promise;
        } catch (const std::exception& error) { return Throw(info, error); }
    }
    Napi::Value Throw(const Napi::CallbackInfo& info, const std::exception& error) {
        Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException();
        return info.Env().Null();
    }
    BindingContext& context_;
    ProgressiveTrack track_;
    bool attached_ = false;
    // Charge the JS producer handle for its ring so discarded seek/prepare
    // handles trigger GC promptly. After handle collection the engine may still
    // retain its bounded current/next/retired owners until control-thread release.
    int64_t externalBytes_ = 0;
    void RequireUnused() const {
        if (attached_) throw std::logic_error("A progressive input can only be attached once.");
    }
};
}

void RegisterProgressiveInputBinding(Napi::Env env, Napi::Object exports,
    PlaybackEngine& engine, SnapshotObjectFactory snapshotFactory) {
    // Like the existing playback export, this context refers to the addon-wide
    // engine. It contains no environment-bound V8 references.
    static BindingContext context {engine, snapshotFactory};
    exports.Set("createProgressiveInput", Napi::Function::New(env, ProgressiveInputBinding::Create,
        "createProgressiveInput", &context));
}
}
