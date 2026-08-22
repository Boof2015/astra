#include "adaptive_upmixer.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <new>
#include <vector>

namespace {
std::atomic<size_t> allocationCount{0};
}

void* operator new(std::size_t size) {
    allocationCount.fetch_add(1, std::memory_order_relaxed);
    if (void* pointer = std::malloc(size)) return pointer;
    throw std::bad_alloc();
}
void operator delete(void* pointer) noexcept { std::free(pointer); }
void operator delete(void* pointer, std::size_t) noexcept { std::free(pointer); }
void* operator new[](std::size_t size) {
    allocationCount.fetch_add(1, std::memory_order_relaxed);
    if (void* pointer = std::malloc(size)) return pointer;
    throw std::bad_alloc();
}
void operator delete[](void* pointer) noexcept { std::free(pointer); }
void operator delete[](void* pointer, std::size_t) noexcept { std::free(pointer); }

int main() {
    using Astra::Upmix::SpeakerRole;
    const std::vector<SpeakerRole> roles = {
        SpeakerRole::FrontLeft, SpeakerRole::FrontRight, SpeakerRole::FrontCenter,
        SpeakerRole::Lfe, SpeakerRole::BackLeft, SpeakerRole::BackRight,
        SpeakerRole::SideLeft, SpeakerRole::SideRight,
    };
    constexpr size_t block = 128;
    constexpr double seconds = 4.0;
    const std::vector<Astra::Upmix::Algorithm> algorithms = {
        Astra::Upmix::Algorithm::Adaptive,
        Astra::Upmix::Algorithm::FixedDifference,
        Astra::Upmix::Algorithm::DominantMatrix,
        Astra::Upmix::Algorithm::WeightedPca,
        Astra::Upmix::Algorithm::Geometric,
    };

    for (const Astra::Upmix::Algorithm algorithm : algorithms) {
      for (float sampleRate : {44100.0f, 48000.0f, 88200.0f, 96000.0f}) {
        Astra::Upmix::AdaptiveUpmixer upmixer({sampleRate, roles, algorithm});
        std::vector<float> input(block * 2);
        std::vector<float> output(block * roles.size());
        const size_t blocks = static_cast<size_t>(std::ceil(seconds * sampleRate / block));
        uint64_t sampleIndex = 0;

        // Warm caches and reach steady covariance state before timing.
        for (size_t warm = 0; warm < 64; ++warm) {
            for (size_t frame = 0; frame < block; ++frame, ++sampleIndex) {
                input[frame * 2] = 0.2f * std::sin(2.0 * 3.141592653589793 * 440.0 * sampleIndex / sampleRate);
                input[frame * 2 + 1] = 0.2f * std::sin(2.0 * 3.141592653589793 * 733.0 * sampleIndex / sampleRate);
            }
            upmixer.process(input.data(), output.data(), block);
        }

        const size_t allocationsBefore = allocationCount.load(std::memory_order_relaxed);
        const auto start = std::chrono::steady_clock::now();
        for (size_t iteration = 0; iteration < blocks; ++iteration) {
            for (size_t frame = 0; frame < block; ++frame, ++sampleIndex) {
                input[frame * 2] = 0.2f * std::sin(2.0 * 3.141592653589793 * 440.0 * sampleIndex / sampleRate);
                input[frame * 2 + 1] = 0.2f * std::sin(2.0 * 3.141592653589793 * 733.0 * sampleIndex / sampleRate);
            }
            upmixer.process(input.data(), output.data(), block);
        }
        const auto end = std::chrono::steady_clock::now();
        const size_t allocationsAfter = allocationCount.load(std::memory_order_relaxed);
        const double elapsed = std::chrono::duration<double>(end - start).count();
        const double processed = static_cast<double>(blocks * block) / sampleRate;
        const double realtime = processed / elapsed;
        std::cout << Astra::Upmix::algorithmName(algorithm) << ' '
                  << static_cast<int>(sampleRate) << " Hz: " << realtime
                  << "x realtime, process allocations "
                  << (allocationsAfter - allocationsBefore) << '\n';
        if (allocationsAfter != allocationsBefore || realtime < 4.0) return 1;
      }
    }
    return 0;
}
