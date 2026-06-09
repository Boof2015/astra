// §22 Commit 1 — WASAPI loopback capture implementation.
//
// Windows-only. On macOS and Linux, the exports surface still exists but `isSupported()`
// returns false with a platform reason — keeps the renderer code free of platform conditionals.

#include "parallax_loopback.h"

#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <chrono>
#include <atomic>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <Audioclient.h>
#include <Mmdeviceapi.h>
#include <Functiondiscoverykeys_devpkey.h>
#include <propidl.h>
#include <wrl/client.h>
#endif

namespace ParallaxLoopback {

namespace {

// ============================================================================
// Shared host wall clock — anchor for all timestamps this module reports.
// ============================================================================
//
// We need a clock that BOTH native capture and the renderer's scheduling timestamps agree on.
// Strategy:
//   - On all platforms, derive timestamps from `std::chrono::steady_clock`.
//   - On Windows, also map QueryPerformanceCounter (which WASAPI capture timestamps come from)
//     into the same domain via a one-shot anchor measured at module load.
//   - The renderer fetches its scheduling timestamps via `wallNowMs()` exposed through IPC, so
//     a `T_observed − T_scheduled` subtraction is honest.

double wallNowMs() {
    using clock = std::chrono::steady_clock;
    const auto now = clock::now().time_since_epoch();
    return std::chrono::duration<double, std::milli>(now).count();
}

#if defined(_WIN32)

using Microsoft::WRL::ComPtr;

// WASAPI `pu64QPCPosition` returned by `IAudioCaptureClient::GetBuffer` is in 100-nanosecond
// units relative to some boot-time origin — NOT raw QueryPerformanceCounter ticks. To map
// captures into our steady_clock wall-time domain (the same domain renderer scheduling
// timestamps live in via the IPC), we compute a one-shot offset between the WASAPI clock and
// steady_clock at the first sample we receive, then add that offset to every subsequent
// `pu64QPCPosition / 10000.0` to get wall ms. The offset stays stable for the session.

// ============================================================================
// Capture state — one active loopback at a time. Worker thread reads from WASAPI and pushes
// (frameIndex, captureWallMs, pcm) tuples into a drain queue. JS pulls via `drain()`.
// ============================================================================

struct CapturedSegment {
    uint64_t firstFrameIndex = 0;  // monotonic counter across the capture session
    double captureWallMs = 0.0;    // host-wall-time when first frame of this segment was produced
    uint32_t frameCount = 0;
    uint32_t channelCount = 0;
    std::vector<float> pcm;        // interleaved float32, channelCount channels
};

struct EndpointInfo {
    std::string deviceId;
    std::string deviceName;
    uint32_t sampleRate = 0;
    uint32_t channelCount = 0;
};

class WasapiLoopback {
public:
    bool start(std::string& errorOut, EndpointInfo& endpointOut) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (running_.load()) {
            errorOut = "Loopback already running.";
            return false;
        }

        // CoInitialize lives for the lifetime of the worker thread, not the start call. The
        // thread is spawned next and does its own initialization.
        stopRequested_.store(false);
        nextFrameIndex_.store(0);
        segments_.clear();

        std::string startError;
        EndpointInfo info;
        std::condition_variable startCv;
        std::mutex startMutex;
        bool startDone = false;
        bool startOk = false;

        worker_ = std::thread([this, &startError, &info, &startCv, &startMutex, &startDone, &startOk]() {
            std::string err;
            EndpointInfo ep;
            const bool ok = workerInit(err, ep);
            {
                std::lock_guard<std::mutex> sLock(startMutex);
                startError = err;
                info = ep;
                startOk = ok;
                startDone = true;
            }
            startCv.notify_one();
            if (!ok) return;
            workerLoop();
            workerShutdown();
        });

        {
            std::unique_lock<std::mutex> sLock(startMutex);
            startCv.wait(sLock, [&] { return startDone; });
        }

        if (!startOk) {
            if (worker_.joinable()) worker_.join();
            errorOut = startError;
            return false;
        }

        running_.store(true);
        endpointOut = info;
        endpointInfo_ = info;
        return true;
    }

    void stop() {
        if (!running_.load()) return;
        stopRequested_.store(true);
        if (worker_.joinable()) worker_.join();
        running_.store(false);
    }

    std::vector<CapturedSegment> drain() {
        std::lock_guard<std::mutex> lock(mutex_);
        std::vector<CapturedSegment> out;
        out.swap(segments_);
        return out;
    }

    bool isRunning() const { return running_.load(); }

    EndpointInfo currentEndpoint() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return endpointInfo_;
    }

private:
    bool workerInit(std::string& errorOut, EndpointInfo& endpointOut) {
        const HRESULT coHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (FAILED(coHr) && coHr != RPC_E_CHANGED_MODE) {
            errorOut = "CoInitializeEx failed.";
            return false;
        }
        coInitialized_ = SUCCEEDED(coHr);

        ComPtr<IMMDeviceEnumerator> enumerator;
        if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                    __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(enumerator.GetAddressOf())))) {
            errorOut = "CoCreateInstance(MMDeviceEnumerator) failed.";
            return false;
        }
        if (FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, device_.ReleaseAndGetAddressOf()))) {
            errorOut = "GetDefaultAudioEndpoint(eRender) failed.";
            return false;
        }

        // Endpoint metadata for CSV logging — id + friendly name.
        LPWSTR rawId = nullptr;
        if (SUCCEEDED(device_->GetId(&rawId)) && rawId != nullptr) {
            const int required = WideCharToMultiByte(CP_UTF8, 0, rawId, -1, nullptr, 0, nullptr, nullptr);
            if (required > 0) {
                std::string utf8(static_cast<size_t>(required - 1), '\0');
                WideCharToMultiByte(CP_UTF8, 0, rawId, -1, utf8.data(), required, nullptr, nullptr);
                endpointOut.deviceId = std::move(utf8);
            }
            CoTaskMemFree(rawId);
        }
        ComPtr<IPropertyStore> props;
        if (SUCCEEDED(device_->OpenPropertyStore(STGM_READ, props.GetAddressOf()))) {
            PROPVARIANT var;
            PropVariantInit(&var);
            if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &var)) && var.vt == VT_LPWSTR && var.pwszVal != nullptr) {
                const int required = WideCharToMultiByte(CP_UTF8, 0, var.pwszVal, -1, nullptr, 0, nullptr, nullptr);
                if (required > 0) {
                    std::string utf8(static_cast<size_t>(required - 1), '\0');
                    WideCharToMultiByte(CP_UTF8, 0, var.pwszVal, -1, utf8.data(), required, nullptr, nullptr);
                    endpointOut.deviceName = std::move(utf8);
                }
            }
            PropVariantClear(&var);
        }

        if (FAILED(device_->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                     reinterpret_cast<void**>(client_.ReleaseAndGetAddressOf())))) {
            errorOut = "IMMDevice::Activate(IAudioClient) failed.";
            return false;
        }

        WAVEFORMATEX* mixFormatRaw = nullptr;
        if (FAILED(client_->GetMixFormat(&mixFormatRaw)) || mixFormatRaw == nullptr) {
            errorOut = "GetMixFormat failed.";
            return false;
        }
        // We don't own mixFormatRaw — must CoTaskMemFree it; copy the bits we need first.
        endpointOut.sampleRate = mixFormatRaw->nSamplesPerSec;
        endpointOut.channelCount = mixFormatRaw->nChannels;

        // 200 ms buffer — small enough to keep capture latency low, large enough to absorb
        // a few quanta of jitter from the audio thread.
        constexpr REFERENCE_TIME k200msBuffer = 200 * 10000;
        const HRESULT initHr = client_->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            k200msBuffer,
            0,
            mixFormatRaw,
            nullptr);
        CoTaskMemFree(mixFormatRaw);
        if (FAILED(initHr)) {
            errorOut = "IAudioClient::Initialize(LOOPBACK) failed.";
            return false;
        }

        if (FAILED(client_->GetService(__uuidof(IAudioCaptureClient),
                                       reinterpret_cast<void**>(captureClient_.ReleaseAndGetAddressOf())))) {
            errorOut = "GetService(IAudioCaptureClient) failed.";
            return false;
        }
        if (FAILED(client_->Start())) {
            errorOut = "IAudioClient::Start failed.";
            return false;
        }
        return true;
    }

    void workerLoop() {
        const auto channelCount = endpointInfo_.channelCount;
        while (!stopRequested_.load()) {
            UINT32 packetFrames = 0;
            HRESULT hr = captureClient_->GetNextPacketSize(&packetFrames);
            if (FAILED(hr)) break;
            if (packetFrames == 0) {
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
                continue;
            }

            BYTE* data = nullptr;
            UINT32 numFrames = 0;
            DWORD flags = 0;
            UINT64 devicePosition = 0;
            UINT64 qpcPosition = 0;
            hr = captureClient_->GetBuffer(&data, &numFrames, &flags, &devicePosition, &qpcPosition);
            if (FAILED(hr) || data == nullptr || numFrames == 0) {
                if (numFrames > 0 && captureClient_) captureClient_->ReleaseBuffer(numFrames);
                continue;
            }

            // WASAPI `qpcPosition` is in 100ns units relative to boot. Map into steady_clock
            // wall-ms via a one-shot offset captured on the first sample (the offset stays
            // stable for the lifetime of the session).
            const double qpcMs = static_cast<double>(qpcPosition) / 10000.0;
            if (!bootOffsetCaptured_) {
                bootOffsetMs_ = wallNowMs() - qpcMs;
                bootOffsetCaptured_ = true;
            }

            CapturedSegment seg;
            seg.firstFrameIndex = nextFrameIndex_.fetch_add(numFrames);
            seg.captureWallMs = qpcMs + bootOffsetMs_;
            seg.frameCount = numFrames;
            seg.channelCount = channelCount;

            if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
                seg.pcm.assign(static_cast<size_t>(numFrames) * channelCount, 0.0f);
            } else {
                // WASAPI loopback under shared-mode mix delivers float32 by default (matches
                // GetMixFormat which Chromium also uses). Copy directly.
                seg.pcm.assign(reinterpret_cast<float*>(data),
                              reinterpret_cast<float*>(data) + static_cast<size_t>(numFrames) * channelCount);
            }

            captureClient_->ReleaseBuffer(numFrames);

            {
                std::lock_guard<std::mutex> lock(mutex_);
                segments_.push_back(std::move(seg));
                // Cap the drain queue so a slow JS-side consumer doesn't memory-balloon. Older
                // segments are dropped; calibration is only meaningful against recent captures.
                constexpr size_t kMaxQueuedSegments = 256;
                if (segments_.size() > kMaxQueuedSegments) {
                    segments_.erase(segments_.begin(),
                                    segments_.begin() + (segments_.size() - kMaxQueuedSegments));
                }
            }
        }
    }

    void workerShutdown() {
        if (client_) client_->Stop();
        captureClient_.Reset();
        client_.Reset();
        device_.Reset();
        if (coInitialized_) CoUninitialize();
        coInitialized_ = false;
    }

    mutable std::mutex mutex_;
    std::atomic<bool> running_{false};
    std::atomic<bool> stopRequested_{false};
    std::atomic<uint64_t> nextFrameIndex_{0};
    std::thread worker_;
    bool coInitialized_ = false;
    bool bootOffsetCaptured_ = false;
    double bootOffsetMs_ = 0.0;
    ComPtr<IMMDevice> device_;
    ComPtr<IAudioClient> client_;
    ComPtr<IAudioCaptureClient> captureClient_;
    std::vector<CapturedSegment> segments_;
    EndpointInfo endpointInfo_;
};

WasapiLoopback& instance() {
    static WasapiLoopback inst;
    return inst;
}

#endif  // _WIN32

// ============================================================================
// N-API bindings — same surface on every platform; behavior differs.
// ============================================================================

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
#if defined(_WIN32)
    result.Set("supported", Napi::Boolean::New(env, true));
#else
    result.Set("supported", Napi::Boolean::New(env, false));
    result.Set("reason", Napi::String::New(env, "Parallax loopback is Windows-only in v1."));
#endif
    return result;
}

Napi::Value WallNowMs(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), wallNowMs());
}

Napi::Value Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
#if defined(_WIN32)
    std::string err;
    EndpointInfo ep;
    const bool ok = instance().start(err, ep);
    result.Set("ok", Napi::Boolean::New(env, ok));
    if (!ok) {
        result.Set("error", Napi::String::New(env, err));
        return result;
    }
    Napi::Object endpoint = Napi::Object::New(env);
    endpoint.Set("deviceId", Napi::String::New(env, ep.deviceId));
    endpoint.Set("deviceName", Napi::String::New(env, ep.deviceName));
    endpoint.Set("sampleRate", Napi::Number::New(env, ep.sampleRate));
    endpoint.Set("channelCount", Napi::Number::New(env, ep.channelCount));
    result.Set("endpoint", endpoint);
#else
    (void)info;
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "Parallax loopback is Windows-only in v1."));
#endif
    return result;
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#if defined(_WIN32)
    instance().stop();
#else
    (void)info;
#endif
    return env.Undefined();
}

Napi::Value Drain(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#if defined(_WIN32)
    auto segments = instance().drain();
    Napi::Array array = Napi::Array::New(env, segments.size());
    for (size_t i = 0; i < segments.size(); ++i) {
        const auto& seg = segments[i];
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("firstFrameIndex", Napi::Number::New(env, static_cast<double>(seg.firstFrameIndex)));
        obj.Set("captureWallMs", Napi::Number::New(env, seg.captureWallMs));
        obj.Set("frameCount", Napi::Number::New(env, seg.frameCount));
        obj.Set("channelCount", Napi::Number::New(env, seg.channelCount));
        // Float32Array view over a copy of the PCM. JS-side correlator slices freely.
        Napi::Float32Array pcm = Napi::Float32Array::New(env, seg.pcm.size());
        std::memcpy(pcm.Data(), seg.pcm.data(), seg.pcm.size() * sizeof(float));
        obj.Set("pcm", pcm);
        array.Set(i, obj);
    }
    return array;
#else
    (void)info;
    return Napi::Array::New(env, 0);
#endif
}

Napi::Value IsRunning(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#if defined(_WIN32)
    return Napi::Boolean::New(env, instance().isRunning());
#else
    (void)info;
    return Napi::Boolean::New(env, false);
#endif
}

}  // namespace

Napi::Object Register(Napi::Env env) {
    Napi::Object exports = Napi::Object::New(env);
    exports.Set("isSupported", Napi::Function::New(env, IsSupported));
    exports.Set("wallNowMs", Napi::Function::New(env, WallNowMs));
    exports.Set("start", Napi::Function::New(env, Start));
    exports.Set("stop", Napi::Function::New(env, Stop));
    exports.Set("drain", Napi::Function::New(env, Drain));
    exports.Set("isRunning", Napi::Function::New(env, IsRunning));
    return exports;
}

}  // namespace ParallaxLoopback
