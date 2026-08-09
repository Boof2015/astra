#include "ffmpeg_pcm_capture.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <exception>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#if defined(_WIN32)
#define NOMINMAX
#include <windows.h>
#endif

namespace FfmpegPcmCapture {
namespace {

using SteadyClock = std::chrono::steady_clock;

constexpr uint64_t kMaxPcmBytes = 192ull * 1024ull * 1024ull;
constexpr uint32_t kRequestedPipeBufferBytes = 1024u * 1024u;
constexpr uint32_t kReadRequestBytes = 1024u * 1024u;
constexpr size_t kPcmCommitChunkBytes = 1024u * 1024u;
constexpr size_t kProgressBatchBytes = 8u * 1024u * 1024u;
constexpr size_t kProgressMaxInFlightBatches = 2;
constexpr size_t kMaxStderrBytes = 32u * 1024u;
constexpr size_t kMaxIdentifierBytes = 256;
constexpr size_t kMaxPathBytes = 32768;
constexpr size_t kMaxArgumentCount = 512;
constexpr size_t kMaxArgumentBytes = 32768;

enum class DeliveryMode {
    CompleteBuffer,
    ProgressBatches
};

const char* DeliveryModeName(DeliveryMode mode) {
    return mode == DeliveryMode::ProgressBatches
        ? "progress_batches"
        : "complete_buffer";
}

struct CaptureRequest {
    std::string jobId;
    std::string slotId;
    std::string ffmpegPath;
    std::vector<std::string> args;
    DeliveryMode deliveryMode = DeliveryMode::CompleteBuffer;
};

struct CaptureResult {
    bool ok = false;
    bool cancelled = false;
    bool stderrTruncated = false;
    bool hasExitCode = false;
    bool hasProcessId = false;
    bool hasWindowsErrorCode = false;
    bool hasEffectivePipeBufferBytes = false;
    bool hasFirstByteMs = false;
    bool hasStdoutReadSpanMs = false;
    bool hasStdoutReadMinBytes = false;
    bool hasStdoutReadMaxBytes = false;
    uint32_t exitCode = 0;
    uint32_t processId = 0;
    uint32_t windowsErrorCode = 0;
    uint32_t effectivePipeBufferBytes = 0;
    uint32_t stdoutReadMinBytes = 0;
    uint32_t stdoutReadMaxBytes = 0;
    uint64_t outputBytes = 0;
    uint64_t stdoutReadCount = 0;
    double spawnMs = 0.0;
    double firstByteMs = 0.0;
    double stdoutReadSpanMs = 0.0;
    double processMs = 0.0;
    double bufferCopyMs = 0.0;
    uint64_t batchCount = 0;
    uint64_t batchBytes = 0;
    uint32_t batchMinBytes = 0;
    uint32_t batchMaxBytes = 0;
    uint64_t batchCreditWaitCount = 0;
    double batchCreditWaitMs = 0.0;
    double batchCreditWaitMaxMs = 0.0;
    double batchCopyMs = 0.0;
    double batchCopyMaxMs = 0.0;
    double batchCallbackMs = 0.0;
    double batchCallbackMaxMs = 0.0;
    bool usedExternalBuffer = false;
    std::string stderrText;
    std::string errorCode;
    std::string errorMessage;
};

struct JobState {
    JobState(std::string job, std::string slot)
        : jobId(std::move(job)), slotId(std::move(slot)) {}

    ~JobState() {
#if defined(_WIN32)
        std::lock_guard<std::mutex> lock(handleMutex);
        if (jobHandle != nullptr) {
            CloseHandle(jobHandle);
            jobHandle = nullptr;
        }
#endif
    }

    std::string jobId;
    std::string slotId;
    std::atomic<bool> cancelRequested { false };
    std::atomic<uint32_t> processId { 0 };
    std::mutex batchMutex;
    std::condition_variable batchCondition;
    uint64_t nextBatchSequence = 0;
    uint64_t nextBatchAckSequence = 0;
    size_t unacknowledgedBatchCount = 0;
    bool batchCallbackFailed = false;
    std::string batchCallbackError;
    uint64_t batchCount = 0;
    uint64_t batchBytes = 0;
    uint32_t batchMinBytes = 0;
    uint32_t batchMaxBytes = 0;
    uint64_t batchCreditWaitCount = 0;
    double batchCreditWaitMs = 0.0;
    double batchCreditWaitMaxMs = 0.0;
    double batchCopyMs = 0.0;
    double batchCopyMaxMs = 0.0;
    double batchCallbackMs = 0.0;
    double batchCallbackMaxMs = 0.0;
#if defined(_WIN32)
    std::mutex handleMutex;
    HANDLE jobHandle = nullptr;
#endif
};

struct RegistryStorage {
    std::mutex mutex;
    std::unordered_map<std::string, std::shared_ptr<JobState>> activeJobs;
    std::unordered_map<std::string, std::weak_ptr<JobState>> latestJobsBySlot;
};

RegistryStorage& JobRegistry() {
    // Intentionally process-lifetime. N-API environment shutdown may cancel a
    // queued AsyncWorker before Execute starts, so destructing registry state
    // at DLL teardown would be less safe than retaining this tiny control block.
    static RegistryStorage* storage = new RegistryStorage();
    return *storage;
}

double ElapsedMs(const SteadyClock::time_point& start, const SteadyClock::time_point& end) {
    return std::chrono::duration<double, std::milli>(end - start).count();
}

void SetFailure(
    CaptureResult& result,
    std::string code,
    std::string message,
    uint32_t windowsErrorCode = 0
) {
    if (!result.errorCode.empty()) {
        return;
    }
    result.errorCode = std::move(code);
    result.errorMessage = std::move(message);
    if (windowsErrorCode != 0) {
        result.hasWindowsErrorCode = true;
        result.windowsErrorCode = windowsErrorCode;
    }
}

void RequestCancel(const std::shared_ptr<JobState>& state) {
    if (!state) {
        return;
    }

    state->cancelRequested.store(true, std::memory_order_release);
    state->batchCondition.notify_all();
#if defined(_WIN32)
    std::lock_guard<std::mutex> lock(state->handleMutex);
    if (state->jobHandle != nullptr) {
        // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE makes this the single cancellation
        // primitive for FFmpeg and any descendants it created.
        CloseHandle(state->jobHandle);
        state->jobHandle = nullptr;
    }
#endif
}

bool RegisterJob(
    const std::shared_ptr<JobState>& state,
    std::shared_ptr<JobState>& superseded
) {
    RegistryStorage& registry = JobRegistry();
    {
        std::lock_guard<std::mutex> lock(registry.mutex);
        const auto duplicate = registry.activeJobs.find(state->jobId);
        if (duplicate != registry.activeJobs.end()) {
            return false;
        }

        const auto latest = registry.latestJobsBySlot.find(state->slotId);
        if (latest != registry.latestJobsBySlot.end()) {
            superseded = latest->second.lock();
        }

        registry.activeJobs.emplace(state->jobId, state);
        registry.latestJobsBySlot[state->slotId] = state;
    }

    if (superseded && superseded.get() != state.get()) {
        RequestCancel(superseded);
    }
    return true;
}

void UnregisterJob(const std::shared_ptr<JobState>& state) {
    RegistryStorage& registry = JobRegistry();
    std::lock_guard<std::mutex> lock(registry.mutex);

    const auto job = registry.activeJobs.find(state->jobId);
    if (job != registry.activeJobs.end() && job->second.get() == state.get()) {
        registry.activeJobs.erase(job);
    }

    const auto latest = registry.latestJobsBySlot.find(state->slotId);
    if (latest != registry.latestJobsBySlot.end()) {
        const std::shared_ptr<JobState> current = latest->second.lock();
        if (!current || current.get() == state.get()) {
            registry.latestJobsBySlot.erase(latest);
        }
    }
}

std::shared_ptr<JobState> FindJob(const std::string& jobId) {
    RegistryStorage& registry = JobRegistry();
    std::lock_guard<std::mutex> lock(registry.mutex);
    const auto found = registry.activeJobs.find(jobId);
    return found == registry.activeJobs.end() ? nullptr : found->second;
}

std::vector<std::shared_ptr<JobState>> SnapshotJobs() {
    RegistryStorage& registry = JobRegistry();
    std::lock_guard<std::mutex> lock(registry.mutex);
    std::vector<std::shared_ptr<JobState>> jobs;
    jobs.reserve(registry.activeJobs.size());
    for (const auto& entry : registry.activeJobs) {
        jobs.push_back(entry.second);
    }
    return jobs;
}

size_t CancelAllJobs() {
    const std::vector<std::shared_ptr<JobState>> jobs = SnapshotJobs();
    for (const auto& job : jobs) {
        RequestCancel(job);
    }
    return jobs.size();
}

struct RegistryGuard {
    explicit RegistryGuard(std::shared_ptr<JobState> jobState)
        : state(std::move(jobState)) {}

    ~RegistryGuard() {
        UnregisterJob(state);
    }

    std::shared_ptr<JobState> state;
};

#if defined(_WIN32)

class UniqueHandle {
public:
    UniqueHandle() = default;
    explicit UniqueHandle(HANDLE handle) : handle_(handle) {}
    ~UniqueHandle() { Reset(); }

    UniqueHandle(const UniqueHandle&) = delete;
    UniqueHandle& operator=(const UniqueHandle&) = delete;

    UniqueHandle(UniqueHandle&& other) noexcept : handle_(other.Release()) {}
    UniqueHandle& operator=(UniqueHandle&& other) noexcept {
        if (this != &other) {
            Reset(other.Release());
        }
        return *this;
    }

    HANDLE Get() const { return handle_; }
    explicit operator bool() const { return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE; }

    HANDLE Release() {
        HANDLE handle = handle_;
        handle_ = nullptr;
        return handle;
    }

    void Reset(HANDLE replacement = nullptr) {
        if (handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE) {
            CloseHandle(handle_);
        }
        handle_ = replacement;
    }

private:
    HANDLE handle_ = nullptr;
};

class PcmAllocation {
public:
    ~PcmAllocation() {
        if (base_ != nullptr) {
            VirtualFree(base_, 0, MEM_RELEASE);
        }
    }

    bool EnsureWritable(size_t requestedBytes, uint32_t& errorCode) {
        if (requestedBytes == 0 || size_ + requestedBytes > kMaxPcmBytes) {
            errorCode = ERROR_BUFFER_OVERFLOW;
            return false;
        }

        if (base_ == nullptr) {
            base_ = static_cast<uint8_t*>(VirtualAlloc(
                nullptr,
                static_cast<SIZE_T>(kMaxPcmBytes),
                MEM_RESERVE,
                PAGE_READWRITE
            ));
            if (base_ == nullptr) {
                errorCode = GetLastError();
                return false;
            }
        }

        const size_t required = size_ + requestedBytes;
        if (required <= committedBytes_) {
            return true;
        }

        const size_t rounded = std::min<size_t>(
            static_cast<size_t>(kMaxPcmBytes),
            ((required + kPcmCommitChunkBytes - 1) / kPcmCommitChunkBytes) * kPcmCommitChunkBytes
        );
        const size_t commitBytes = rounded - committedBytes_;
        void* committed = VirtualAlloc(
            base_ + committedBytes_,
            commitBytes,
            MEM_COMMIT,
            PAGE_READWRITE
        );
        if (committed == nullptr) {
            errorCode = GetLastError();
            return false;
        }
        committedBytes_ = rounded;
        return true;
    }

    uint8_t* WritePointer() { return base_ + size_; }
    const uint8_t* ReadPointer(size_t offset) const { return base_ + offset; }
    void Advance(size_t byteCount) { size_ += byteCount; }
    size_t Size() const { return size_; }

    uint8_t* Release() {
        uint8_t* base = base_;
        base_ = nullptr;
        size_ = 0;
        committedBytes_ = 0;
        return base;
    }

    void Discard() {
        if (base_ != nullptr) {
            VirtualFree(base_, 0, MEM_RELEASE);
            base_ = nullptr;
        }
        size_ = 0;
        committedBytes_ = 0;
    }

private:
    uint8_t* base_ = nullptr;
    size_t size_ = 0;
    size_t committedBytes_ = 0;
};

#else

class PcmAllocation {
public:
    size_t Size() const { return 0; }
    const uint8_t* ReadPointer(size_t) const { return nullptr; }
    uint8_t* Release() { return nullptr; }
    void Discard() {}
};

#endif

void FreePcmAllocation(uint8_t* data) {
#if defined(_WIN32)
    if (data != nullptr) {
        VirtualFree(data, 0, MEM_RELEASE);
    }
#else
    (void)data;
#endif
}

struct PcmTransferControl {
    explicit PcmTransferControl(uint8_t* allocation) : data(allocation) {}
    ~PcmTransferControl() { FreePcmAllocation(data); }

    uint8_t* data = nullptr;
    std::atomic<bool> localReleased { false };
};

void FinalizeTransferredPcm(
    Napi::Env,
    uint8_t*,
    PcmTransferControl* control
) {
    FreePcmAllocation(control->data);
    control->data = nullptr;
    if (control->localReleased.load(std::memory_order_acquire)) {
        delete control;
    }
}

Napi::Value NullableNumber(Napi::Env env, bool present, double value) {
    return present ? Napi::Number::New(env, value) : env.Null();
}

Napi::Value NullableString(Napi::Env env, const std::string& value) {
    return value.empty()
        ? static_cast<Napi::Value>(env.Null())
        : static_cast<Napi::Value>(Napi::String::New(env, value.data(), value.size()));
}

struct ProgressBatchDescriptor {
    uint64_t sequence = 0;
    uint64_t byteOffset = 0;
    uint32_t byteLength = 0;
};

class CaptureAsyncWorker final
    : public Napi::AsyncProgressQueueWorker<ProgressBatchDescriptor> {
public:
    CaptureAsyncWorker(
        Napi::Promise::Deferred deferred,
        CaptureRequest request,
        std::shared_ptr<JobState> state,
        const Napi::Function& batchCallback
    )
        : Napi::AsyncProgressQueueWorker<ProgressBatchDescriptor>(
              batchCallback,
              "astra:ffmpeg-pcm-capture"
          ),
          deferred_(std::move(deferred)),
          request_(std::move(request)),
          state_(std::move(state)) {}

    ~CaptureAsyncWorker() override {
        // Covers N-API cancelling queued work before Execute ever receives a
        // thread-pool turn. UnregisterJob is pointer-checked and idempotent.
        UnregisterJob(state_);
    }

    void Execute(const ExecutionProgress& progress) override;
    void OnProgress(const ProgressBatchDescriptor* data, size_t count) override;

    void OnOK() override {
        Napi::HandleScope scope(Env());
        SynchronizeBatchResult();

        Napi::Buffer<uint8_t> pcmBuffer;
        if (
            request_.deliveryMode == DeliveryMode::CompleteBuffer
            && result_.ok
            && pcm_.Size() > 0
        ) {
            const size_t pcmSize = pcm_.Size();
            // Allocate the control before releasing PcmAllocation ownership so
            // even std::bad_alloc cannot orphan the reserved VA.
            auto transferControl = std::make_unique<PcmTransferControl>(nullptr);
            uint8_t* pcmData = pcm_.Release();
            transferControl->data = pcmData;
            const SteadyClock::time_point transferStartedAt = SteadyClock::now();
            try {
                pcmBuffer = Napi::Buffer<uint8_t>::NewOrCopy(
                    Env(),
                    pcmData,
                    pcmSize,
                    FinalizeTransferredPcm,
                    transferControl.get()
                );
            } catch (const Napi::Error& error) {
                deferred_.Reject(error.Value());
                return;
            }
            if (Env().IsExceptionPending()) {
                const Napi::Error pendingError = Env().GetAndClearPendingException();
                deferred_.Reject(pendingError.Value());
                return;
            }
            if (pcmBuffer.IsEmpty()) {
                deferred_.Reject(Napi::Error::New(
                    Env(),
                    "Unable to create the JavaScript PCM Buffer."
                ).Value());
                return;
            }

            result_.usedExternalBuffer = pcmBuffer.Data() == pcmData;
            result_.bufferCopyMs = result_.usedExternalBuffer
                ? 0.0
                : ElapsedMs(transferStartedAt, SteadyClock::now());
            if (result_.usedExternalBuffer) {
                // The external Buffer finalizer owns both the VA and the
                // transfer control from this point forward.
                transferControl->localReleased.store(true, std::memory_order_release);
                transferControl.release();
            }
            // In the copy fallback the finalizer already released the VA;
            // transferControl remains local and now contains a null pointer.
        } else {
            pcm_.Discard();
            pcmBuffer = Napi::Buffer<uint8_t>::New(Env(), 0);
        }

        Napi::Object value = Napi::Object::New(Env());

        value.Set("ok", Napi::Boolean::New(Env(), result_.ok));
        value.Set("jobId", Napi::String::New(Env(), request_.jobId));
        value.Set("stderr", Napi::String::New(
            Env(),
            result_.stderrText.data(),
            result_.stderrText.size()
        ));
        value.Set("stderrTruncated", Napi::Boolean::New(Env(), result_.stderrTruncated));
        value.Set("exitCode", NullableNumber(Env(), result_.hasExitCode, result_.exitCode));
        value.Set("processId", NullableNumber(Env(), result_.hasProcessId, result_.processId));
        value.Set("cancelled", Napi::Boolean::New(Env(), result_.cancelled));
        value.Set("errorCode", NullableString(Env(), result_.errorCode));
        value.Set("errorMessage", NullableString(Env(), result_.errorMessage));
        value.Set(
            "windowsErrorCode",
            NullableNumber(Env(), result_.hasWindowsErrorCode, result_.windowsErrorCode)
        );
        value.Set("outputBytes", Napi::Number::New(Env(), static_cast<double>(result_.outputBytes)));
        value.Set(
            "stdoutReadCount",
            Napi::Number::New(Env(), static_cast<double>(result_.stdoutReadCount))
        );
        value.Set(
            "requestedPipeBufferBytes",
            Napi::Number::New(Env(), static_cast<double>(kRequestedPipeBufferBytes))
        );
        value.Set(
            "effectivePipeBufferBytes",
            NullableNumber(
                Env(),
                result_.hasEffectivePipeBufferBytes,
                result_.effectivePipeBufferBytes
            )
        );
        value.Set(
            "stdoutReadMinBytes",
            NullableNumber(Env(), result_.hasStdoutReadMinBytes, result_.stdoutReadMinBytes)
        );
        value.Set(
            "stdoutReadMaxBytes",
            NullableNumber(Env(), result_.hasStdoutReadMaxBytes, result_.stdoutReadMaxBytes)
        );
        value.Set("spawnMs", Napi::Number::New(Env(), result_.spawnMs));
        value.Set("firstByteMs", NullableNumber(Env(), result_.hasFirstByteMs, result_.firstByteMs));
        value.Set(
            "stdoutReadSpanMs",
            NullableNumber(Env(), result_.hasStdoutReadSpanMs, result_.stdoutReadSpanMs)
        );
        value.Set("processMs", Napi::Number::New(Env(), result_.processMs));
        value.Set("bufferCopyMs", Napi::Number::New(Env(), result_.bufferCopyMs));
        value.Set("usedExternalBuffer", Napi::Boolean::New(Env(), result_.usedExternalBuffer));
        value.Set("deliveryMode", Napi::String::New(
            Env(),
            DeliveryModeName(request_.deliveryMode)
        ));
        value.Set(
            "batchTargetBytes",
            Napi::Number::New(Env(), static_cast<double>(kProgressBatchBytes))
        );
        value.Set("batchCount", Napi::Number::New(
            Env(),
            static_cast<double>(result_.batchCount)
        ));
        value.Set("batchBytes", Napi::Number::New(
            Env(),
            static_cast<double>(result_.batchBytes)
        ));
        value.Set(
            "batchMinBytes",
            NullableNumber(Env(), result_.batchCount > 0, result_.batchMinBytes)
        );
        value.Set(
            "batchMaxBytes",
            NullableNumber(Env(), result_.batchCount > 0, result_.batchMaxBytes)
        );
        value.Set("batchCreditWaitCount", Napi::Number::New(
            Env(),
            static_cast<double>(result_.batchCreditWaitCount)
        ));
        value.Set("batchCreditWaitMs", Napi::Number::New(Env(), result_.batchCreditWaitMs));
        value.Set(
            "batchCreditWaitMaxMs",
            Napi::Number::New(Env(), result_.batchCreditWaitMaxMs)
        );
        value.Set("batchCopyMs", Napi::Number::New(Env(), result_.batchCopyMs));
        value.Set("batchCopyMaxMs", Napi::Number::New(Env(), result_.batchCopyMaxMs));
        value.Set("batchCallbackMs", Napi::Number::New(Env(), result_.batchCallbackMs));
        value.Set(
            "batchCallbackMaxMs",
            Napi::Number::New(Env(), result_.batchCallbackMaxMs)
        );
        value.Set("pcm", pcmBuffer);

        deferred_.Resolve(value);
    }

    void OnError(const Napi::Error& error) override {
        Napi::HandleScope scope(Env());
        pcm_.Discard();
        deferred_.Reject(error.Value());
    }

private:
    void ExecutePlatformCapture(
        const SteadyClock::time_point& startedAt,
        const ExecutionProgress& progress
    );
    bool DispatchProgressBatch(
        const ExecutionProgress& progress,
        uint64_t byteOffset,
        uint32_t byteLength
    );
    bool WaitForBatchCredits(size_t maximumOutstanding);
    void SynchronizeBatchResult();
    void FailBatchCallback(const std::string& message);

    Napi::Promise::Deferred deferred_;
    CaptureRequest request_;
    std::shared_ptr<JobState> state_;
    CaptureResult result_;
    PcmAllocation pcm_;
};

bool ReadRequiredString(
    const Napi::Env& env,
    const Napi::Object& object,
    const char* key,
    size_t maxBytes,
    std::string& output
) {
    const Napi::Value value = object.Get(key);
    if (!value.IsString()) {
        Napi::TypeError::New(env, std::string("Expected ") + key + " to be a string.")
            .ThrowAsJavaScriptException();
        return false;
    }

    output = value.As<Napi::String>().Utf8Value();
    if (output.empty() || output.size() > maxBytes || output.find('\0') != std::string::npos) {
        Napi::RangeError::New(
            env,
            std::string(key) + " must be non-empty, contain no NUL bytes, and stay within its length limit."
        ).ThrowAsJavaScriptException();
        return false;
    }
    return true;
}

bool ParseCaptureRequest(const Napi::CallbackInfo& info, CaptureRequest& request) {
    const Napi::Env env = info.Env();
    if (
        (info.Length() != 1 && info.Length() != 2)
        || !info[0].IsObject()
        || info[0].IsArray()
    ) {
        Napi::TypeError::New(
            env,
            "Expected capture({ jobId, slotId, ffmpegPath, args, deliveryMode }, onBatch?)."
        ).ThrowAsJavaScriptException();
        return false;
    }

    const Napi::Object input = info[0].As<Napi::Object>();
    if (!ReadRequiredString(env, input, "jobId", kMaxIdentifierBytes, request.jobId)
        || !ReadRequiredString(env, input, "slotId", kMaxIdentifierBytes, request.slotId)
        || !ReadRequiredString(env, input, "ffmpegPath", kMaxPathBytes, request.ffmpegPath)) {
        return false;
    }

    const Napi::Value argsValue = input.Get("args");
    if (!argsValue.IsArray()) {
        Napi::TypeError::New(env, "Expected args to be an array of strings.")
            .ThrowAsJavaScriptException();
        return false;
    }

    const Napi::Array args = argsValue.As<Napi::Array>();
    if (args.Length() > kMaxArgumentCount) {
        Napi::RangeError::New(env, "Too many FFmpeg arguments.").ThrowAsJavaScriptException();
        return false;
    }

    request.args.reserve(args.Length());
    for (uint32_t index = 0; index < args.Length(); index++) {
        const Napi::Value value = args.Get(index);
        if (!value.IsString()) {
            Napi::TypeError::New(env, "Every FFmpeg argument must be a string.")
                .ThrowAsJavaScriptException();
            return false;
        }
        std::string argument = value.As<Napi::String>().Utf8Value();
        if (argument.size() > kMaxArgumentBytes || argument.find('\0') != std::string::npos) {
            Napi::RangeError::New(
                env,
                "FFmpeg arguments must contain no NUL bytes and stay within the length limit."
            ).ThrowAsJavaScriptException();
            return false;
        }
        request.args.push_back(std::move(argument));
    }

    const Napi::Value deliveryModeValue = input.Get("deliveryMode");
    if (!deliveryModeValue.IsUndefined()) {
        if (!deliveryModeValue.IsString()) {
            Napi::TypeError::New(env, "deliveryMode must be a string.")
                .ThrowAsJavaScriptException();
            return false;
        }
        const std::string deliveryMode = deliveryModeValue.As<Napi::String>().Utf8Value();
        if (deliveryMode == "complete_buffer") {
            request.deliveryMode = DeliveryMode::CompleteBuffer;
        } else if (deliveryMode == "progress_batches") {
            request.deliveryMode = DeliveryMode::ProgressBatches;
        } else {
            Napi::RangeError::New(
                env,
                "deliveryMode must be complete_buffer or progress_batches."
            ).ThrowAsJavaScriptException();
            return false;
        }
    }

    const Napi::Value batchBytesValue = input.Get("batchBytes");
    if (request.deliveryMode == DeliveryMode::ProgressBatches) {
        if (!batchBytesValue.IsUndefined()) {
            if (
                !batchBytesValue.IsNumber()
                || batchBytesValue.As<Napi::Number>().DoubleValue()
                    != static_cast<double>(kProgressBatchBytes)
            ) {
                Napi::RangeError::New(
                    env,
                    "progress_batches requires batchBytes to equal 8 MiB."
                ).ThrowAsJavaScriptException();
                return false;
            }
        }
    } else if (!batchBytesValue.IsUndefined()) {
        Napi::TypeError::New(env, "batchBytes is only valid for progress_batches.")
            .ThrowAsJavaScriptException();
        return false;
    }
    return true;
}

Napi::Value GetCapabilities(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
#if defined(_WIN32)
    result.Set("supported", Napi::Boolean::New(env, true));
    result.Set("reason", env.Null());
    result.Set("supportsProgressBatches", Napi::Boolean::New(env, true));
#else
    result.Set("supported", Napi::Boolean::New(env, false));
    result.Set("reason", Napi::String::New(env, "Native FFmpeg PCM capture is Windows-only."));
    result.Set("supportsProgressBatches", Napi::Boolean::New(env, false));
#endif
    result.Set("maxPcmBytes", Napi::Number::New(env, static_cast<double>(kMaxPcmBytes)));
    result.Set(
        "requestedPipeBufferBytes",
        Napi::Number::New(env, static_cast<double>(kRequestedPipeBufferBytes))
    );
    result.Set(
        "progressBatchBytes",
        Napi::Number::New(env, static_cast<double>(kProgressBatchBytes))
    );
    result.Set(
        "progressMaxInFlightBatches",
        Napi::Number::New(env, static_cast<double>(kProgressMaxInFlightBatches))
    );
    return result;
}

Napi::Value Capture(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    CaptureRequest request;
    if (!ParseCaptureRequest(info, request)) {
        return env.Null();
    }

    Napi::Function batchCallback;
    if (request.deliveryMode == DeliveryMode::ProgressBatches) {
        if (info.Length() != 2 || !info[1].IsFunction()) {
            Napi::TypeError::New(
                env,
                "progress_batches requires an onBatch callback."
            ).ThrowAsJavaScriptException();
            return env.Null();
        }
        batchCallback = info[1].As<Napi::Function>();
    } else {
        if (info.Length() != 1) {
            Napi::TypeError::New(
                env,
                "complete_buffer does not accept an onBatch callback."
            ).ThrowAsJavaScriptException();
            return env.Null();
        }
        batchCallback = Napi::Function::New(env, [](const Napi::CallbackInfo&) {});
    }

    auto state = std::make_shared<JobState>(request.jobId, request.slotId);
    std::shared_ptr<JobState> superseded;
    if (!RegisterJob(state, superseded)) {
        Napi::Error::New(env, "An active native FFmpeg capture already uses this jobId.")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    CaptureAsyncWorker* worker = nullptr;
    try {
        auto deferred = Napi::Promise::Deferred::New(env);
        worker = new CaptureAsyncWorker(
            deferred,
            std::move(request),
            state,
            batchCallback
        );
        worker->Queue();
        return deferred.Promise();
    } catch (const Napi::Error& error) {
        delete worker;
        UnregisterJob(state);
        error.ThrowAsJavaScriptException();
        return env.Null();
    } catch (...) {
        delete worker;
        UnregisterJob(state);
        Napi::Error::New(env, "Unable to allocate the native FFmpeg capture worker.")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
}

Napi::Value Cancel(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (info.Length() != 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected cancel(jobId).").ThrowAsJavaScriptException();
        return env.Null();
    }

    const std::string jobId = info[0].As<Napi::String>().Utf8Value();
    const std::shared_ptr<JobState> state = FindJob(jobId);
    if (!state) {
        return Napi::Boolean::New(env, false);
    }
    RequestCancel(state);
    return Napi::Boolean::New(env, true);
}

Napi::Value Acknowledge(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (info.Length() != 2 || !info[0].IsString() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "Expected acknowledge(jobId, sequence).")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    const double sequenceValue = info[1].As<Napi::Number>().DoubleValue();
    if (
        !std::isfinite(sequenceValue)
        || sequenceValue < 0.0
        || std::floor(sequenceValue) != sequenceValue
        || sequenceValue > 9007199254740991.0
    ) {
        Napi::RangeError::New(env, "Batch sequence must be a non-negative safe integer.")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    const std::string jobId = info[0].As<Napi::String>().Utf8Value();
    const std::shared_ptr<JobState> state = FindJob(jobId);
    if (!state) {
        return Napi::Boolean::New(env, false);
    }

    bool acknowledged = false;
    {
        std::lock_guard<std::mutex> lock(state->batchMutex);
        const uint64_t sequence = static_cast<uint64_t>(sequenceValue);
        if (
            !state->cancelRequested.load(std::memory_order_acquire)
            && !state->batchCallbackFailed
            && state->unacknowledgedBatchCount > 0
            && sequence == state->nextBatchAckSequence
            && sequence < state->nextBatchSequence
        ) {
            state->nextBatchAckSequence += 1;
            state->unacknowledgedBatchCount -= 1;
            acknowledged = true;
        }
    }
    if (acknowledged) {
        state->batchCondition.notify_all();
    }
    return Napi::Boolean::New(env, acknowledged);
}

Napi::Value CancelAll(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), static_cast<double>(CancelAllJobs()));
}

Napi::Value GetActiveProcessIds(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    const std::vector<std::shared_ptr<JobState>> jobs = SnapshotJobs();
    std::vector<uint32_t> processIds;
    processIds.reserve(jobs.size());
    for (const auto& job : jobs) {
        const uint32_t processId = job->processId.load(std::memory_order_acquire);
        if (processId != 0) {
            processIds.push_back(processId);
        }
    }
    std::sort(processIds.begin(), processIds.end());

    Napi::Array result = Napi::Array::New(env, processIds.size());
    for (size_t index = 0; index < processIds.size(); index++) {
        result.Set(static_cast<uint32_t>(index), Napi::Number::New(env, processIds[index]));
    }
    return result;
}

void CaptureAsyncWorker::SynchronizeBatchResult() {
    std::lock_guard<std::mutex> lock(state_->batchMutex);
    result_.batchCount = state_->batchCount;
    result_.batchBytes = state_->batchBytes;
    result_.batchMinBytes = state_->batchMinBytes;
    result_.batchMaxBytes = state_->batchMaxBytes;
    result_.batchCreditWaitCount = state_->batchCreditWaitCount;
    result_.batchCreditWaitMs = state_->batchCreditWaitMs;
    result_.batchCreditWaitMaxMs = state_->batchCreditWaitMaxMs;
    result_.batchCopyMs = state_->batchCopyMs;
    result_.batchCopyMaxMs = state_->batchCopyMaxMs;
    result_.batchCallbackMs = state_->batchCallbackMs;
    result_.batchCallbackMaxMs = state_->batchCallbackMaxMs;
    if (result_.batchCount == 0) {
        // Descriptor/credit activity that cancellation suppresses before any
        // JavaScript callback is an internal implementation detail. Keep the
        // result-facing telemetry self-consistent with zero delivered batches.
        result_.batchBytes = 0;
        result_.batchMinBytes = 0;
        result_.batchMaxBytes = 0;
        result_.batchCreditWaitCount = 0;
        result_.batchCreditWaitMs = 0.0;
        result_.batchCreditWaitMaxMs = 0.0;
        result_.batchCopyMs = 0.0;
        result_.batchCopyMaxMs = 0.0;
        result_.batchCallbackMs = 0.0;
        result_.batchCallbackMaxMs = 0.0;
    }
    if (state_->batchCallbackFailed && !result_.cancelled) {
        result_.ok = false;
        result_.errorCode = "batch_callback_failed";
        result_.errorMessage = state_->batchCallbackError.empty()
            ? "Native PCM progress callback failed."
            : state_->batchCallbackError;
        result_.hasWindowsErrorCode = false;
        result_.windowsErrorCode = 0;
    }
}

void CaptureAsyncWorker::FailBatchCallback(const std::string& message) {
    bool newlyFailed = false;
    {
        std::lock_guard<std::mutex> lock(state_->batchMutex);
        if (!state_->batchCallbackFailed) {
            state_->batchCallbackFailed = true;
            state_->batchCallbackError = message;
            newlyFailed = true;
        }
    }
    state_->batchCondition.notify_all();

#if defined(_WIN32)
    if (newlyFailed) {
        std::lock_guard<std::mutex> lock(state_->handleMutex);
        if (state_->jobHandle != nullptr) {
            CloseHandle(state_->jobHandle);
            state_->jobHandle = nullptr;
        }
    }
#else
    (void)newlyFailed;
#endif
}

bool CaptureAsyncWorker::WaitForBatchCredits(size_t maximumOutstanding) {
    std::unique_lock<std::mutex> lock(state_->batchMutex);
    const auto interrupted = [&] {
        return state_->cancelRequested.load(std::memory_order_acquire)
            || state_->batchCallbackFailed;
    };
    if (interrupted()) {
        return false;
    }
    if (state_->unacknowledgedBatchCount <= maximumOutstanding) {
        return true;
    }

    const SteadyClock::time_point waitStartedAt = SteadyClock::now();
    state_->batchCreditWaitCount += 1;
    state_->batchCondition.wait(lock, [&] {
        return state_->unacknowledgedBatchCount <= maximumOutstanding
            || interrupted();
    });
    const double waitedMs = ElapsedMs(waitStartedAt, SteadyClock::now());
    state_->batchCreditWaitMs += waitedMs;
    state_->batchCreditWaitMaxMs = std::max(
        state_->batchCreditWaitMaxMs,
        waitedMs
    );
    return !interrupted();
}

bool CaptureAsyncWorker::DispatchProgressBatch(
    const ExecutionProgress& progress,
    uint64_t byteOffset,
    uint32_t byteLength
) {
    if (request_.deliveryMode != DeliveryMode::ProgressBatches || byteLength == 0) {
        return true;
    }
    if (!WaitForBatchCredits(kProgressMaxInFlightBatches - 1)) {
        return false;
    }

    ProgressBatchDescriptor descriptor;
    {
        std::lock_guard<std::mutex> lock(state_->batchMutex);
        if (
            state_->cancelRequested.load(std::memory_order_acquire)
            || state_->batchCallbackFailed
        ) {
            return false;
        }
        descriptor.sequence = state_->nextBatchSequence;
        descriptor.byteOffset = byteOffset;
        descriptor.byteLength = byteLength;
        state_->nextBatchSequence += 1;
        state_->unacknowledgedBatchCount += 1;
    }

    try {
        progress.Send(&descriptor, 1);
    } catch (const std::exception& error) {
        FailBatchCallback(error.what());
        return false;
    } catch (...) {
        FailBatchCallback("Unable to queue a native PCM progress batch.");
        return false;
    }
    return true;
}

void CaptureAsyncWorker::OnProgress(
    const ProgressBatchDescriptor* data,
    size_t count
) {
    if (data == nullptr || count != 1) {
        FailBatchCallback("Native PCM progress descriptor was invalid.");
        return;
    }

    const ProgressBatchDescriptor descriptor = data[0];
    {
        std::lock_guard<std::mutex> lock(state_->batchMutex);
        if (
            state_->cancelRequested.load(std::memory_order_acquire)
            || state_->batchCallbackFailed
        ) {
            return;
        }
    }
    if (
        descriptor.byteLength == 0
        || descriptor.byteLength > kProgressBatchBytes
        || descriptor.byteOffset + descriptor.byteLength > kMaxPcmBytes
    ) {
        FailBatchCallback("Native PCM progress descriptor exceeded its bounded range.");
        return;
    }

    try {
        const SteadyClock::time_point copyStartedAt = SteadyClock::now();
        Napi::Buffer<uint8_t> payload = Napi::Buffer<uint8_t>::Copy(
            Env(),
            pcm_.ReadPointer(static_cast<size_t>(descriptor.byteOffset)),
            descriptor.byteLength
        );
        const double copyMs = ElapsedMs(copyStartedAt, SteadyClock::now());
        {
            std::lock_guard<std::mutex> lock(state_->batchMutex);
            state_->batchCopyMs += copyMs;
            state_->batchCopyMaxMs = std::max(state_->batchCopyMaxMs, copyMs);
        }

        Napi::Object batch = Napi::Object::New(Env());
        batch.Set("jobId", Napi::String::New(Env(), request_.jobId));
        batch.Set("sequence", Napi::Number::New(
            Env(),
            static_cast<double>(descriptor.sequence)
        ));
        batch.Set("byteOffset", Napi::Number::New(
            Env(),
            static_cast<double>(descriptor.byteOffset)
        ));
        batch.Set("byteLength", Napi::Number::New(
            Env(),
            static_cast<double>(descriptor.byteLength)
        ));
        batch.Set("payload", payload);

        {
            // Result-facing batch telemetry counts only callbacks admitted to
            // JavaScript. A queued descriptor suppressed by cancellation is
            // intentionally excluded so terminal failure data reconciles with
            // what the consumer actually observed.
            std::lock_guard<std::mutex> lock(state_->batchMutex);
            state_->batchCount += 1;
            state_->batchBytes += descriptor.byteLength;
            if (
                state_->batchCount == 1
                || descriptor.byteLength < state_->batchMinBytes
            ) {
                state_->batchMinBytes = descriptor.byteLength;
            }
            state_->batchMaxBytes = std::max(
                state_->batchMaxBytes,
                descriptor.byteLength
            );
        }

        const SteadyClock::time_point callbackStartedAt = SteadyClock::now();
        Callback().Call(Receiver().Value(), { batch });
        const double callbackMs = ElapsedMs(callbackStartedAt, SteadyClock::now());
        {
            std::lock_guard<std::mutex> lock(state_->batchMutex);
            state_->batchCallbackMs += callbackMs;
            state_->batchCallbackMaxMs = std::max(
                state_->batchCallbackMaxMs,
                callbackMs
            );
        }

        if (Env().IsExceptionPending()) {
            const Napi::Error error = Env().GetAndClearPendingException();
            FailBatchCallback(error.Message());
        }
    } catch (const Napi::Error& error) {
        if (Env().IsExceptionPending()) {
            Env().GetAndClearPendingException();
        }
        FailBatchCallback(error.Message());
    } catch (const std::exception& error) {
        if (Env().IsExceptionPending()) {
            Env().GetAndClearPendingException();
        }
        FailBatchCallback(error.what());
    } catch (...) {
        if (Env().IsExceptionPending()) {
            Env().GetAndClearPendingException();
        }
        FailBatchCallback("Native PCM progress callback failed.");
    }
}

void CaptureAsyncWorker::Execute(const ExecutionProgress& progress) {
    RegistryGuard registryGuard(state_);
    const SteadyClock::time_point startedAt = SteadyClock::now();

    try {
        ExecutePlatformCapture(startedAt, progress);
    } catch (const std::exception& error) {
        SetFailure(result_, "native_exception", error.what());
    } catch (...) {
        SetFailure(result_, "native_exception", "Native FFmpeg PCM capture failed unexpectedly.");
    }

    result_.cancelled = state_->cancelRequested.load(std::memory_order_acquire);
    if (result_.cancelled) {
        result_.ok = false;
        result_.errorCode = "cancelled";
        result_.errorMessage = "Native FFmpeg PCM capture was cancelled.";
        result_.hasWindowsErrorCode = false;
        result_.windowsErrorCode = 0;
    }
    // outputBytes is bytes observed from the child even when the result cannot
    // be consumed. Failed/cancelled results still discard and return empty PCM.
    result_.outputBytes = static_cast<uint64_t>(pcm_.Size());
    // The canonical allocation remains alive until OnOK because queued progress
    // descriptors copy immutable completed ranges from it on the JavaScript
    // thread. OnOK runs only after AsyncProgressQueueWorker drains that queue.
    if (result_.processMs == 0.0) {
        result_.processMs = ElapsedMs(startedAt, SteadyClock::now());
    }
    state_->processId.store(0, std::memory_order_release);
}

#if defined(_WIN32)

std::string WideToUtf8(const std::wstring& value) {
    if (value.empty()) {
        return {};
    }

    const int required = WideCharToMultiByte(
        CP_UTF8,
        0,
        value.data(),
        static_cast<int>(value.size()),
        nullptr,
        0,
        nullptr,
        nullptr
    );
    if (required <= 0) {
        return {};
    }

    std::string converted(static_cast<size_t>(required), '\0');
    WideCharToMultiByte(
        CP_UTF8,
        0,
        value.data(),
        static_cast<int>(value.size()),
        converted.data(),
        required,
        nullptr,
        nullptr
    );
    return converted;
}

bool Utf8ToWide(const std::string& value, std::wstring& output, DWORD& errorCode) {
    if (value.size() > static_cast<size_t>(std::numeric_limits<int>::max())) {
        errorCode = ERROR_FILENAME_EXCED_RANGE;
        return false;
    }
    if (value.empty()) {
        output.clear();
        return true;
    }

    const int required = MultiByteToWideChar(
        CP_UTF8,
        MB_ERR_INVALID_CHARS,
        value.data(),
        static_cast<int>(value.size()),
        nullptr,
        0
    );
    if (required <= 0) {
        errorCode = GetLastError();
        return false;
    }

    output.resize(static_cast<size_t>(required));
    if (MultiByteToWideChar(
        CP_UTF8,
        MB_ERR_INVALID_CHARS,
        value.data(),
        static_cast<int>(value.size()),
        output.data(),
        required
    ) <= 0) {
        errorCode = GetLastError();
        output.clear();
        return false;
    }
    return true;
}

std::string WindowsErrorMessage(const char* context, DWORD errorCode) {
    LPWSTR rawMessage = nullptr;
    const DWORD length = FormatMessageW(
        FORMAT_MESSAGE_ALLOCATE_BUFFER
            | FORMAT_MESSAGE_FROM_SYSTEM
            | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr,
        errorCode,
        MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        reinterpret_cast<LPWSTR>(&rawMessage),
        0,
        nullptr
    );

    std::wstring systemMessage;
    if (length > 0 && rawMessage != nullptr) {
        systemMessage.assign(rawMessage, length);
        LocalFree(rawMessage);
        while (!systemMessage.empty()
            && (systemMessage.back() == L'\r' || systemMessage.back() == L'\n')) {
            systemMessage.pop_back();
        }
    }

    std::string message(context);
    message += " (Windows error ";
    message += std::to_string(errorCode);
    message += ")";
    const std::string utf8SystemMessage = WideToUtf8(systemMessage);
    if (!utf8SystemMessage.empty()) {
        message += ": ";
        message += utf8SystemMessage;
    }
    return message;
}

std::wstring QuoteWindowsArgument(const std::wstring& argument) {
    const bool needsQuotes = argument.empty()
        || argument.find_first_of(L" \t\n\v\"") != std::wstring::npos;
    if (!needsQuotes) {
        return argument;
    }

    std::wstring quoted;
    quoted.push_back(L'"');
    size_t backslashCount = 0;
    for (const wchar_t character : argument) {
        if (character == L'\\') {
            backslashCount += 1;
            continue;
        }

        if (character == L'"') {
            quoted.append((backslashCount * 2) + 1, L'\\');
            quoted.push_back(L'"');
        } else {
            quoted.append(backslashCount, L'\\');
            quoted.push_back(character);
        }
        backslashCount = 0;
    }

    quoted.append(backslashCount * 2, L'\\');
    quoted.push_back(L'"');
    return quoted;
}

bool BuildCommandLine(
    const CaptureRequest& request,
    std::wstring& executablePath,
    std::wstring& commandLine,
    DWORD& errorCode
) {
    if (!Utf8ToWide(request.ffmpegPath, executablePath, errorCode)) {
        return false;
    }

    commandLine = QuoteWindowsArgument(executablePath);
    if (commandLine.size() >= 32767) {
        errorCode = ERROR_FILENAME_EXCED_RANGE;
        return false;
    }
    for (const std::string& argument : request.args) {
        std::wstring wideArgument;
        if (!Utf8ToWide(argument, wideArgument, errorCode)) {
            return false;
        }
        commandLine.push_back(L' ');
        commandLine += QuoteWindowsArgument(wideArgument);
        if (commandLine.size() >= 32767) {
            errorCode = ERROR_FILENAME_EXCED_RANGE;
            return false;
        }
    }
    return true;
}

bool CreateCapturePipe(UniqueHandle& readHandle, UniqueHandle& writeHandle, DWORD& errorCode) {
    SECURITY_ATTRIBUTES attributes {};
    attributes.nLength = sizeof(attributes);
    attributes.bInheritHandle = TRUE;

    HANDLE rawRead = nullptr;
    HANDLE rawWrite = nullptr;
    if (!CreatePipe(
        &rawRead,
        &rawWrite,
        &attributes,
        kRequestedPipeBufferBytes
    )) {
        errorCode = GetLastError();
        return false;
    }

    readHandle.Reset(rawRead);
    writeHandle.Reset(rawWrite);
    if (!SetHandleInformation(readHandle.Get(), HANDLE_FLAG_INHERIT, 0)) {
        errorCode = GetLastError();
        readHandle.Reset();
        writeHandle.Reset();
        return false;
    }
    return true;
}

class ProcessAttributeList {
public:
    ~ProcessAttributeList() {
        if (list_ != nullptr) {
            DeleteProcThreadAttributeList(list_);
        }
    }

    bool Initialize(const std::vector<HANDLE>& inheritedHandles, DWORD& errorCode) {
        SIZE_T requiredBytes = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &requiredBytes);
        if (requiredBytes == 0) {
            errorCode = GetLastError();
            return false;
        }

        storage_.resize(requiredBytes);
        list_ = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage_.data());
        if (!InitializeProcThreadAttributeList(list_, 1, 0, &requiredBytes)) {
            errorCode = GetLastError();
            list_ = nullptr;
            storage_.clear();
            return false;
        }

        if (!UpdateProcThreadAttribute(
            list_,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            const_cast<HANDLE*>(inheritedHandles.data()),
            inheritedHandles.size() * sizeof(HANDLE),
            nullptr,
            nullptr
        )) {
            errorCode = GetLastError();
            DeleteProcThreadAttributeList(list_);
            list_ = nullptr;
            storage_.clear();
            return false;
        }
        return true;
    }

    LPPROC_THREAD_ATTRIBUTE_LIST Get() const { return list_; }

private:
    std::vector<uint8_t> storage_;
    LPPROC_THREAD_ATTRIBUTE_LIST list_ = nullptr;
};

bool PublishJobHandle(const std::shared_ptr<JobState>& state, HANDLE jobHandle) {
    std::lock_guard<std::mutex> lock(state->handleMutex);
    if (state->cancelRequested.load(std::memory_order_acquire)) {
        CloseHandle(jobHandle);
        return false;
    }
    state->jobHandle = jobHandle;
    return true;
}

void ClosePublishedJobHandle(const std::shared_ptr<JobState>& state) {
    std::lock_guard<std::mutex> lock(state->handleMutex);
    if (state->jobHandle != nullptr) {
        CloseHandle(state->jobHandle);
        state->jobHandle = nullptr;
    }
}

struct PublishedProcessGuard {
    explicit PublishedProcessGuard(std::shared_ptr<JobState> value)
        : state(std::move(value)) {}
    ~PublishedProcessGuard() {
        // On exception, kill first so both blocking pipe readers wake before
        // the stderr thread is joined.
        ClosePublishedJobHandle(state);
        if (stderrThread.joinable()) {
            stderrThread.join();
        }
    }
    std::shared_ptr<JobState> state;
    std::thread stderrThread;
};

void DrainStderr(HANDLE stderrRead, CaptureResult& result, DWORD& readError) {
    try {
        std::vector<char> buffer(16384);
        while (true) {
            DWORD bytesRead = 0;
            if (!ReadFile(
                stderrRead,
                buffer.data(),
                static_cast<DWORD>(buffer.size()),
                &bytesRead,
                nullptr
            )) {
                const DWORD errorCode = GetLastError();
                if (errorCode != ERROR_BROKEN_PIPE && errorCode != ERROR_HANDLE_EOF) {
                    readError = errorCode;
                }
                return;
            }
            if (bytesRead == 0) {
                return;
            }

            const size_t newBytes = static_cast<size_t>(bytesRead);
            if (newBytes >= kMaxStderrBytes) {
                result.stderrText.assign(
                    buffer.data() + (newBytes - kMaxStderrBytes),
                    kMaxStderrBytes
                );
                result.stderrTruncated = true;
                continue;
            }

            const size_t overflow = result.stderrText.size() + newBytes > kMaxStderrBytes
                ? (result.stderrText.size() + newBytes) - kMaxStderrBytes
                : 0;
            if (overflow > 0) {
                result.stderrText.erase(0, overflow);
                result.stderrTruncated = true;
            }
            result.stderrText.append(buffer.data(), newBytes);
        }
    } catch (...) {
        readError = ERROR_NOT_ENOUGH_MEMORY;
    }
}

void CaptureAsyncWorker::ExecutePlatformCapture(
    const SteadyClock::time_point& startedAt,
    const ExecutionProgress& progress
) {
    if (state_->cancelRequested.load(std::memory_order_acquire)) {
        return;
    }

    DWORD errorCode = ERROR_SUCCESS;
    std::wstring executablePath;
    std::wstring commandLine;
    if (!BuildCommandLine(request_, executablePath, commandLine, errorCode)) {
        SetFailure(
            result_,
            "invalid_command_line",
            WindowsErrorMessage("Unable to construct the FFmpeg command line", errorCode),
            errorCode
        );
        return;
    }

    UniqueHandle stdoutRead;
    UniqueHandle stdoutWrite;
    UniqueHandle stderrRead;
    UniqueHandle stderrWrite;
    if (!CreateCapturePipe(stdoutRead, stdoutWrite, errorCode)
        || !CreateCapturePipe(stderrRead, stderrWrite, errorCode)) {
        SetFailure(
            result_,
            "pipe_setup_failed",
            WindowsErrorMessage("Unable to create FFmpeg capture pipes", errorCode),
            errorCode
        );
        return;
    }

    DWORD outgoingBufferBytes = 0;
    DWORD incomingBufferBytes = 0;
    if (GetNamedPipeInfo(
        stdoutRead.Get(),
        nullptr,
        &outgoingBufferBytes,
        &incomingBufferBytes,
        nullptr
    )) {
        result_.hasEffectivePipeBufferBytes = true;
        result_.effectivePipeBufferBytes = std::max(outgoingBufferBytes, incomingBufferBytes);
    }

    SECURITY_ATTRIBUTES inheritableAttributes {};
    inheritableAttributes.nLength = sizeof(inheritableAttributes);
    inheritableAttributes.bInheritHandle = TRUE;
    UniqueHandle stdinNull(CreateFileW(
        L"NUL",
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        &inheritableAttributes,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr
    ));
    if (!stdinNull) {
        errorCode = GetLastError();
        SetFailure(
            result_,
            "stdin_setup_failed",
            WindowsErrorMessage("Unable to open NUL for FFmpeg stdin", errorCode),
            errorCode
        );
        return;
    }

    UniqueHandle job(CreateJobObjectW(nullptr, nullptr));
    if (!job) {
        errorCode = GetLastError();
        SetFailure(
            result_,
            "job_setup_failed",
            WindowsErrorMessage("Unable to create the FFmpeg Job Object", errorCode),
            errorCode
        );
        return;
    }

    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobLimits {};
    jobLimits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(
        job.Get(),
        JobObjectExtendedLimitInformation,
        &jobLimits,
        sizeof(jobLimits)
    )) {
        errorCode = GetLastError();
        SetFailure(
            result_,
            "job_setup_failed",
            WindowsErrorMessage("Unable to configure the FFmpeg Job Object", errorCode),
            errorCode
        );
        return;
    }

    const std::vector<HANDLE> inheritedHandles {
        stdoutWrite.Get(),
        stderrWrite.Get(),
        stdinNull.Get()
    };
    ProcessAttributeList attributeList;
    if (!attributeList.Initialize(inheritedHandles, errorCode)) {
        SetFailure(
            result_,
            "handle_list_setup_failed",
            WindowsErrorMessage("Unable to restrict FFmpeg inherited handles", errorCode),
            errorCode
        );
        return;
    }

    STARTUPINFOEXW startupInfo {};
    startupInfo.StartupInfo.cb = sizeof(startupInfo);
    startupInfo.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startupInfo.StartupInfo.hStdInput = stdinNull.Get();
    startupInfo.StartupInfo.hStdOutput = stdoutWrite.Get();
    startupInfo.StartupInfo.hStdError = stderrWrite.Get();
    startupInfo.lpAttributeList = attributeList.Get();

    PROCESS_INFORMATION processInfo {};
    const DWORD creationFlags = CREATE_NO_WINDOW
        | CREATE_SUSPENDED
        | EXTENDED_STARTUPINFO_PRESENT;
    if (!CreateProcessW(
        executablePath.c_str(),
        commandLine.data(),
        nullptr,
        nullptr,
        TRUE,
        creationFlags,
        nullptr,
        nullptr,
        &startupInfo.StartupInfo,
        &processInfo
    )) {
        errorCode = GetLastError();
        SetFailure(
            result_,
            "spawn_failed",
            WindowsErrorMessage("Unable to start FFmpeg", errorCode),
            errorCode
        );
        return;
    }

    UniqueHandle process(processInfo.hProcess);
    UniqueHandle primaryThread(processInfo.hThread);
    stdoutWrite.Reset();
    stderrWrite.Reset();
    stdinNull.Reset();

    result_.hasProcessId = true;
    result_.processId = processInfo.dwProcessId;
    state_->processId.store(processInfo.dwProcessId, std::memory_order_release);

    if (!AssignProcessToJobObject(job.Get(), process.Get())) {
        errorCode = GetLastError();
        TerminateProcess(process.Get(), errorCode);
        WaitForSingleObject(process.Get(), INFINITE);
        SetFailure(
            result_,
            "job_assignment_failed",
            WindowsErrorMessage("Unable to assign FFmpeg to its Job Object", errorCode),
            errorCode
        );
        return;
    }

    const bool jobPublished = PublishJobHandle(state_, job.Release());
    if (!jobPublished) {
        WaitForSingleObject(process.Get(), INFINITE);
        DWORD exitCode = 0;
        if (GetExitCodeProcess(process.Get(), &exitCode)) {
            result_.hasExitCode = true;
            result_.exitCode = exitCode;
        }
        return;
    }
    PublishedProcessGuard publishedProcessGuard(state_);

    DWORD stderrReadError = ERROR_SUCCESS;
    publishedProcessGuard.stderrThread = std::thread([&] {
        DrainStderr(stderrRead.Get(), result_, stderrReadError);
    });

    const DWORD previousSuspendCount = ResumeThread(primaryThread.Get());
    if (previousSuspendCount == static_cast<DWORD>(-1)) {
        errorCode = GetLastError();
        if (!state_->cancelRequested.load(std::memory_order_acquire)) {
            SetFailure(
                result_,
                "resume_failed",
                WindowsErrorMessage("Unable to resume FFmpeg", errorCode),
                errorCode
            );
        }
        ClosePublishedJobHandle(state_);
    } else {
        result_.spawnMs = ElapsedMs(startedAt, SteadyClock::now());
    }
    primaryThread.Reset();

    SteadyClock::time_point firstByteAt {};
    SteadyClock::time_point lastByteAt {};
    uint64_t nextProgressBatchOffset = 0;
    while (!state_->cancelRequested.load(std::memory_order_acquire)) {
        if (pcm_.Size() == kMaxPcmBytes) {
            uint8_t overflowByte = 0;
            DWORD overflowBytesRead = 0;
            if (ReadFile(
                stdoutRead.Get(),
                &overflowByte,
                1,
                &overflowBytesRead,
                nullptr
            )) {
                if (overflowBytesRead > 0) {
                    SetFailure(
                        result_,
                        "pcm_limit_exceeded",
                        "FFmpeg PCM output exceeded the hard 192 MiB limit."
                    );
                    ClosePublishedJobHandle(state_);
                }
                break;
            }

            const DWORD readError = GetLastError();
            if (readError != ERROR_BROKEN_PIPE && readError != ERROR_HANDLE_EOF) {
                SetFailure(
                    result_,
                    "stdout_read_failed",
                    WindowsErrorMessage("Unable to read FFmpeg stdout", readError),
                    readError
                );
                ClosePublishedJobHandle(state_);
            }
            break;
        }

        const DWORD requestBytes = static_cast<DWORD>(std::min<uint64_t>(
            kReadRequestBytes,
            kMaxPcmBytes - pcm_.Size()
        ));
        uint32_t allocationError = ERROR_SUCCESS;
        if (!pcm_.EnsureWritable(requestBytes, allocationError)) {
            SetFailure(
                result_,
                "pcm_allocation_failed",
                WindowsErrorMessage("Unable to allocate the bounded PCM buffer", allocationError),
                allocationError
            );
            ClosePublishedJobHandle(state_);
            break;
        }

        DWORD bytesRead = 0;
        if (!ReadFile(
            stdoutRead.Get(),
            pcm_.WritePointer(),
            requestBytes,
            &bytesRead,
            nullptr
        )) {
            const DWORD readError = GetLastError();
            if (readError != ERROR_BROKEN_PIPE && readError != ERROR_HANDLE_EOF) {
                SetFailure(
                    result_,
                    "stdout_read_failed",
                    WindowsErrorMessage("Unable to read FFmpeg stdout", readError),
                    readError
                );
                ClosePublishedJobHandle(state_);
            }
            break;
        }
        if (bytesRead == 0) {
            break;
        }

        const SteadyClock::time_point readAt = SteadyClock::now();
        lastByteAt = readAt;
        pcm_.Advance(bytesRead);
        result_.stdoutReadCount += 1;
        if (!result_.hasStdoutReadMinBytes || bytesRead < result_.stdoutReadMinBytes) {
            result_.hasStdoutReadMinBytes = true;
            result_.stdoutReadMinBytes = bytesRead;
        }
        if (!result_.hasStdoutReadMaxBytes || bytesRead > result_.stdoutReadMaxBytes) {
            result_.hasStdoutReadMaxBytes = true;
            result_.stdoutReadMaxBytes = bytesRead;
        }
        if (!result_.hasFirstByteMs) {
            firstByteAt = readAt;
            result_.hasFirstByteMs = true;
            result_.firstByteMs = ElapsedMs(startedAt, readAt);
        }

        while (
            request_.deliveryMode == DeliveryMode::ProgressBatches
            && pcm_.Size() - nextProgressBatchOffset >= kProgressBatchBytes
        ) {
            if (!DispatchProgressBatch(
                progress,
                nextProgressBatchOffset,
                static_cast<uint32_t>(kProgressBatchBytes)
            )) {
                ClosePublishedJobHandle(state_);
                break;
            }
            nextProgressBatchOffset += kProgressBatchBytes;
        }
        {
            std::lock_guard<std::mutex> lock(state_->batchMutex);
            if (state_->batchCallbackFailed) {
                ClosePublishedJobHandle(state_);
                break;
            }
        }
    }

    if (result_.hasFirstByteMs) {
        result_.hasStdoutReadSpanMs = true;
        result_.stdoutReadSpanMs = ElapsedMs(firstByteAt, lastByteAt);
    }

    const DWORD waitResult = WaitForSingleObject(process.Get(), INFINITE);
    if (waitResult == WAIT_FAILED) {
        errorCode = GetLastError();
        SetFailure(
            result_,
            "wait_failed",
            WindowsErrorMessage("Unable to wait for FFmpeg", errorCode),
            errorCode
        );
        ClosePublishedJobHandle(state_);
    } else {
        DWORD exitCode = 0;
        if (GetExitCodeProcess(process.Get(), &exitCode)) {
            result_.hasExitCode = true;
            result_.exitCode = exitCode;
        } else {
            errorCode = GetLastError();
            SetFailure(
                result_,
                "exit_code_failed",
                WindowsErrorMessage("Unable to obtain the FFmpeg exit code", errorCode),
                errorCode
            );
        }
    }

    ClosePublishedJobHandle(state_);
    if (publishedProcessGuard.stderrThread.joinable()) {
        publishedProcessGuard.stderrThread.join();
    }

    if (stderrReadError != ERROR_SUCCESS) {
        SetFailure(
            result_,
            "stderr_read_failed",
            WindowsErrorMessage("Unable to read FFmpeg stderr", stderrReadError),
            stderrReadError
        );
    }
    if (result_.errorCode.empty() && result_.hasExitCode && result_.exitCode != 0) {
        SetFailure(
            result_,
            "nonzero_exit",
            "FFmpeg exited with code " + std::to_string(result_.exitCode) + "."
        );
    }
    if (result_.errorCode.empty() && !result_.hasExitCode) {
        SetFailure(result_, "missing_exit_code", "FFmpeg ended without an exit code.");
    }

    // Preserve processMs as child spawn/capture/close wall. Final progress
    // callback delivery and acknowledgement waits are reported separately.
    result_.processMs = ElapsedMs(startedAt, SteadyClock::now());

    bool progressDeliverySucceeded = true;
    if (
        request_.deliveryMode == DeliveryMode::ProgressBatches
        && result_.errorCode.empty()
        && result_.hasExitCode
        && result_.exitCode == 0
        && !state_->cancelRequested.load(std::memory_order_acquire)
        && pcm_.Size() > nextProgressBatchOffset
    ) {
        const size_t finalBatchBytes = pcm_.Size() - nextProgressBatchOffset;
        progressDeliverySucceeded = DispatchProgressBatch(
            progress,
            nextProgressBatchOffset,
            static_cast<uint32_t>(finalBatchBytes)
        );
        if (progressDeliverySucceeded) {
            nextProgressBatchOffset += finalBatchBytes;
        }
    }

    if (
        request_.deliveryMode == DeliveryMode::ProgressBatches
        && !state_->cancelRequested.load(std::memory_order_acquire)
    ) {
        progressDeliverySucceeded = WaitForBatchCredits(0)
            && progressDeliverySucceeded;
    }

    if (
        progressDeliverySucceeded
        && request_.deliveryMode == DeliveryMode::ProgressBatches
        && result_.errorCode.empty()
        && nextProgressBatchOffset != pcm_.Size()
    ) {
        progressDeliverySucceeded = false;
        SetFailure(
            result_,
            "batch_reconciliation_failed",
            "Native PCM progress batches did not reconcile with captured output."
        );
    }

    result_.ok = result_.errorCode.empty()
        && result_.hasExitCode
        && result_.exitCode == 0
        && !state_->cancelRequested.load(std::memory_order_acquire)
        && progressDeliverySucceeded;
}

#endif

#if !defined(_WIN32)

void CaptureAsyncWorker::ExecutePlatformCapture(
    const SteadyClock::time_point&,
    const ExecutionProgress&
) {
    SetFailure(
        result_,
        "unsupported_platform",
        "Native FFmpeg PCM capture is Windows-only."
    );
}

#endif

void CleanupEnvironment(void*) {
    CancelAllJobs();
    // Do not block the JavaScript thread here. Closing every published Job
    // Object wakes blocking pipe reads; the process-lifetime registry remains
    // valid even if Node cancels a queued worker before Execute begins.
}

} // namespace

Napi::Object Register(Napi::Env env, Napi::Object exports) {
    exports.Set("getCapabilities", Napi::Function::New(env, GetCapabilities));
    exports.Set("capture", Napi::Function::New(env, Capture));
    exports.Set("acknowledge", Napi::Function::New(env, Acknowledge));
    exports.Set("cancel", Napi::Function::New(env, Cancel));
    exports.Set("cancelAll", Napi::Function::New(env, CancelAll));
    exports.Set("getActiveProcessIds", Napi::Function::New(env, GetActiveProcessIds));
    napi_add_env_cleanup_hook(env, CleanupEnvironment, nullptr);
    return exports;
}

} // namespace FfmpegPcmCapture

Napi::Object InitFfmpegPcmCapture(Napi::Env env, Napi::Object exports) {
    return FfmpegPcmCapture::Register(env, exports);
}

NODE_API_MODULE(ffmpeg_pcm_capture, InitFfmpegPcmCapture)
