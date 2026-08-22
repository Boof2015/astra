#include "adaptive_upmixer.h"

#include <array>
#include <cstdint>
#include <memory>

namespace {

constexpr int kRenderQuantum = 128;
constexpr int kMaxOutputs = 12;
std::array<int32_t, kMaxOutputs> gRoles{};
std::array<float, kRenderQuantum * 2> gInput{};
std::array<float, kRenderQuantum * kMaxOutputs> gOutput{};
std::unique_ptr<Astra::Upmix::AdaptiveUpmixer> gUpmixer;
int gOutputChannels = 0;

Astra::Upmix::SpeakerRole roleFromCode(int32_t code) {
    using Astra::Upmix::SpeakerRole;
    switch (code) {
        case 1: return SpeakerRole::FrontLeft;
        case 2: return SpeakerRole::FrontRight;
        case 3: return SpeakerRole::FrontCenter;
        case 4: return SpeakerRole::Lfe;
        case 5: return SpeakerRole::SideLeft;
        case 6: return SpeakerRole::SideRight;
        case 7: return SpeakerRole::BackLeft;
        case 8: return SpeakerRole::BackRight;
        case 9: return SpeakerRole::Height;
        default: return SpeakerRole::Unknown;
    }
}

} // namespace

extern "C" {

int32_t* adaptive_roles_ptr() { return gRoles.data(); }
float* adaptive_input_ptr() { return gInput.data(); }
float* adaptive_output_ptr() { return gOutput.data(); }

int adaptive_init(float sampleRate, int outputChannels, int algorithmCode) {
    if (sampleRate < 8000.0f || sampleRate > 192000.0f ||
        outputChannels < 1 || outputChannels > kMaxOutputs) return 0;
    Astra::Upmix::Config config;
    config.sampleRate = sampleRate;
    config.algorithm = static_cast<Astra::Upmix::Algorithm>(algorithmCode);
    config.outputRoles.reserve(static_cast<size_t>(outputChannels));
    for (int channel = 0; channel < outputChannels; ++channel) {
        config.outputRoles.push_back(roleFromCode(gRoles[static_cast<size_t>(channel)]));
    }
    gUpmixer = std::make_unique<Astra::Upmix::AdaptiveUpmixer>(config);
    gOutputChannels = outputChannels;
    return static_cast<int>(gUpmixer->latencyFrames());
}

int adaptive_process(int frames) {
    if (!gUpmixer || frames < 1 || frames > kRenderQuantum) return 0;
    gUpmixer->process(gInput.data(), gOutput.data(), static_cast<size_t>(frames));
    return 1;
}

void adaptive_reset() {
    if (gUpmixer) gUpmixer->reset();
}

int adaptive_latency_frames() {
    return gUpmixer ? static_cast<int>(gUpmixer->latencyFrames()) : 0;
}

int adaptive_fft_size() {
    return gUpmixer ? static_cast<int>(gUpmixer->fftSize()) : 0;
}

int adaptive_output_channels() { return gOutputChannels; }

} // extern "C"
