#include "process_memory.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#if defined(__linux__)
#include <cctype>
#include <fstream>
#elif defined(__APPLE__)
#include <cerrno>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <unistd.h>
#elif defined(_WIN32)
#define NOMINMAX
#include <windows.h>
#include <psapi.h>
#endif

namespace ProcessMemory {
namespace {

struct ProcessFootprint {
    int pid = 0;
    bool ok = false;
    uint64_t bytes = 0;
    std::string error;
};

const char* PlatformSource() {
#if defined(__linux__)
    return "linux-pss";
#elif defined(__APPLE__)
    return "macos-private-resident";
#elif defined(_WIN32)
    return "windows-private-working-set";
#else
    return "unavailable";
#endif
}

#if defined(_WIN32)
struct AstraProcessMemoryCountersEx2 {
    DWORD cb;
    DWORD PageFaultCount;
    SIZE_T PeakWorkingSetSize;
    SIZE_T WorkingSetSize;
    SIZE_T QuotaPeakPagedPoolUsage;
    SIZE_T QuotaPagedPoolUsage;
    SIZE_T QuotaPeakNonPagedPoolUsage;
    SIZE_T QuotaNonPagedPoolUsage;
    SIZE_T PagefileUsage;
    SIZE_T PeakPagefileUsage;
    SIZE_T PrivateUsage;
    SIZE_T PrivateWorkingSetSize;
    ULONG64 SharedCommitUsage;
};

bool TryGetPrivateWorkingSetFromCounters(HANDLE process, uint64_t& bytes) {
    AstraProcessMemoryCountersEx2 counters {};
    counters.cb = sizeof(counters);
    if (!GetProcessMemoryInfo(
        process,
        reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&counters),
        sizeof(counters)
    )) {
        return false;
    }

    if (counters.PrivateWorkingSetSize == 0 && counters.WorkingSetSize > 0 && counters.PrivateUsage > 0) {
        return false;
    }

    bytes = static_cast<uint64_t>(counters.PrivateWorkingSetSize);
    return true;
}
#endif

#if defined(__linux__)
bool ParseKilobyteLine(const std::string& line, const char* key, uint64_t& bytes) {
    const size_t keyLength = std::strlen(key);
    if (line.compare(0, keyLength, key) != 0) {
        return false;
    }

    size_t index = keyLength;
    while (index < line.size() && std::isspace(static_cast<unsigned char>(line[index]))) {
        index += 1;
    }

    uint64_t kilobytes = 0;
    bool sawDigit = false;
    while (index < line.size() && std::isdigit(static_cast<unsigned char>(line[index]))) {
        sawDigit = true;
        kilobytes = (kilobytes * 10) + static_cast<uint64_t>(line[index] - '0');
        index += 1;
    }

    if (!sawDigit) {
        return false;
    }

    bytes = kilobytes * 1024;
    return true;
}
#endif

ProcessFootprint MeasureProcessFootprint(int pid) {
    ProcessFootprint result;
    result.pid = pid;

    if (pid <= 0) {
        result.error = "Invalid process id.";
        return result;
    }

#if defined(__linux__)
    const std::string path = "/proc/" + std::to_string(pid) + "/smaps_rollup";
    std::ifstream file(path);
    if (!file.is_open()) {
        result.error = "Unable to open smaps_rollup.";
        return result;
    }

    std::string line;
    while (std::getline(file, line)) {
        uint64_t bytes = 0;
        if (ParseKilobyteLine(line, "Pss:", bytes)) {
            result.ok = true;
            result.bytes = bytes;
            return result;
        }
    }

    result.error = "Pss was not present in smaps_rollup.";
    return result;
#elif defined(__APPLE__)
    const uint64_t pageSize = static_cast<uint64_t>(getpagesize());
    uint64_t address = 0;
    uint64_t totalBytes = 0;
    uint32_t sampledRegionCount = 0;

    while (true) {
        proc_regioninfo region {};
        const int byteCount = proc_pidinfo(pid, PROC_PIDREGIONINFO, address, &region, PROC_PIDREGIONINFO_SIZE);
        if (byteCount != PROC_PIDREGIONINFO_SIZE) {
            break;
        }

        sampledRegionCount += 1;
        totalBytes += static_cast<uint64_t>(region.pri_private_pages_resident) * pageSize;

        const uint64_t nextAddress = region.pri_address + region.pri_size;
        if (nextAddress <= address || region.pri_size == 0) {
            break;
        }
        address = nextAddress;
    }

    if (sampledRegionCount == 0) {
        result.error = "Unable to walk process memory regions.";
        return result;
    }

    result.ok = true;
    result.bytes = totalBytes;
    return result;
#elif defined(_WIN32)
    HANDLE process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, static_cast<DWORD>(pid));
    if (process == nullptr) {
        result.error = "Unable to open process.";
        return result;
    }

    uint64_t privateWorkingSetBytes = 0;
    if (!TryGetPrivateWorkingSetFromCounters(process, privateWorkingSetBytes)) {
        CloseHandle(process);
        result.error = "Unable to query process private working set counters.";
        return result;
    }

    CloseHandle(process);
    result.ok = true;
    result.bytes = privateWorkingSetBytes;
    return result;
#else
    result.error = "Process memory footprint is unsupported on this platform.";
    return result;
#endif
}

std::vector<int> ReadPidArray(const Napi::Env& env, const Napi::Value& value) {
    std::vector<int> pids;
    if (!value.IsArray()) {
        Napi::TypeError::New(env, "Expected an array of process ids.").ThrowAsJavaScriptException();
        return pids;
    }

    const Napi::Array input = value.As<Napi::Array>();
    const uint32_t length = input.Length();
    pids.reserve(length);
    for (uint32_t index = 0; index < length; index++) {
        const Napi::Value entry = input.Get(index);
        if (!entry.IsNumber()) {
            Napi::TypeError::New(env, "Process ids must be numbers.").ThrowAsJavaScriptException();
            pids.clear();
            return pids;
        }
        pids.push_back(entry.As<Napi::Number>().Int32Value());
    }

    return pids;
}

Napi::Value GetProcessFootprints(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    const std::vector<int> pids = ReadPidArray(env, info.Length() > 0 ? info[0] : env.Undefined());
    if (env.IsExceptionPending()) {
        return env.Null();
    }

    const char* source = PlatformSource();
    uint64_t totalBytes = 0;
    bool complete = true;

    Napi::Array processArray = Napi::Array::New(env, pids.size());
    Napi::Array failedPidArray = Napi::Array::New(env);
    uint32_t failedPidIndex = 0;

    for (size_t index = 0; index < pids.size(); index++) {
        const ProcessFootprint footprint = MeasureProcessFootprint(pids[index]);

        Napi::Object process = Napi::Object::New(env);
        process.Set("pid", Napi::Number::New(env, footprint.pid));
        process.Set("source", Napi::String::New(env, source));
        process.Set("ok", Napi::Boolean::New(env, footprint.ok));
        if (footprint.ok) {
            process.Set("bytes", Napi::Number::New(env, static_cast<double>(footprint.bytes)));
            process.Set("error", env.Null());
            totalBytes += footprint.bytes;
        } else {
            process.Set("bytes", env.Null());
            process.Set("error", Napi::String::New(env, footprint.error));
            failedPidArray.Set(failedPidIndex, Napi::Number::New(env, footprint.pid));
            failedPidIndex += 1;
            complete = false;
        }
        processArray.Set(index, process);
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("source", Napi::String::New(env, source));
    result.Set("totalBytes", Napi::Number::New(env, static_cast<double>(totalBytes)));
    result.Set("complete", Napi::Boolean::New(env, complete));
    result.Set("failedPids", failedPidArray);
    result.Set("processes", processArray);
    return result;
}

} // namespace

Napi::Object Register(Napi::Env env) {
    Napi::Object exports = Napi::Object::New(env);
    exports.Set("getProcessFootprints", Napi::Function::New(env, GetProcessFootprints));
    return exports;
}

} // namespace ProcessMemory
