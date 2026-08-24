#pragma once

#include "dsp_utils.h"

#include <complex>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace Astra::Upmix {

enum class SpeakerRole : uint8_t {
    Unknown,
    FrontLeft,
    FrontRight,
    FrontCenter,
    Lfe,
    SideLeft,
    SideRight,
    BackLeft,
    BackRight,
    Height,
};

enum class Algorithm : uint8_t {
    Adaptive,
    FixedDifference,
    DominantMatrix,
    CoherenceMask,
    WeightedPca,
    PanningModel,
    Geometric,
    RejectedAdaptiveControl,
};

struct Config {
    float sampleRate = 48000.0f;
    std::vector<SpeakerRole> outputRoles;
    Algorithm algorithm = Algorithm::Adaptive;
    // Optional research-only linear gain for a band-limited common-mode detail
    // layer in the surrounds. Production/WASM leaves this at zero until a
    // listening-approved value replaces the default.
    float surroundCenterMixGain = 0.0f;
};

struct Diagnostics {
    uint64_t inputFrames = 0;
    uint64_t analysisFrames = 0;
    double inputEnergy = 0.0;
    double outputEnergy = 0.0;
    double surroundEnergy = 0.0;
    double weightedDirectness = 0.0;
    double weightedDiffuseMask = 0.0;
    double weightedCenterConfidence = 0.0;
    double weightedSceneExpansion = 0.0;
    double analysisWeight = 0.0;
    double steerableWeight = 0.0;
    double frontLockedWeight = 0.0;
    double diffuseWeight = 0.0;
    uint64_t nonFiniteSamples = 0;
};

// Streaming, allocation-free-after-construction stereo upmixer. The processor
// is causal: every output, including the optional decomposition stems, is
// delayed by fftSize() samples. The selected Adaptive profile and research-
// reset candidates use 12/16 ms staggered surround offsets. The rejected
// pre-bake-off control remains available only as an offline research baseline.
class AdaptiveUpmixer {
public:
    explicit AdaptiveUpmixer(const Config& config);

    // Input is interleaved L/R. Output is interleaved in Config::outputRoles
    // order. stemsInterleaved, when non-null, receives Primary L/R followed by
    // Ambient L/R. Primary + Ambient reconstructs the delayed stereo input.
    void process(const float* stereoInterleaved,
                 float* outputInterleaved,
                 size_t frameCount,
                 float* stemsInterleaved = nullptr);

    void reset();
    size_t fftSize() const { return fftSize_; }
    size_t hopSize() const { return hopSize_; }
    size_t latencyFrames() const { return fftSize_; }
    size_t tailFrames() const { return fftSize_ + maxSurroundDelay_; }
    size_t outputChannelCount() const { return config_.outputRoles.size(); }
    const Diagnostics& diagnostics() const { return diagnostics_; }

private:
    Config config_;
    size_t fftSize_ = 0;
    size_t hopSize_ = 0;
    size_t maxSurroundDelay_ = 0;
    size_t olaSize_ = 0;
    DSP::FFT fft_;

    std::vector<float> window_;
    std::vector<float> inputLeft_;
    std::vector<float> inputRight_;
    size_t inputWrite_ = 0;
    uint64_t inputCount_ = 0;

    std::vector<float> frameLeft_;
    std::vector<float> frameRight_;
    std::vector<float> inverseScratch_;
    std::vector<std::complex<float>> spectrumLeft_;
    std::vector<std::complex<float>> spectrumRight_;
    std::vector<std::vector<std::complex<float>>> renderedSpectra_;
    std::vector<std::vector<std::complex<float>>> stemSpectra_;
    std::vector<std::vector<float>> overlapAdd_;

    std::vector<float> powerLeft_;
    std::vector<float> powerRight_;
    std::vector<std::complex<float>> crossPower_;
    std::vector<float> previousMagnitude_;
    std::vector<float> previousPan_;
    std::vector<float> panStability_;

    std::vector<size_t> roleDelayFrames_;
    bool synthesizeStems_ = false;
    Diagnostics diagnostics_;

    void renderFrame();
    void synthesizeSpectrum(size_t channel, size_t delayFrames);
    void setSpectrumBin(std::vector<std::complex<float>>& spectrum,
                        size_t bin,
                        std::complex<float> value);
    std::complex<float> decorrelate(std::complex<float> value,
                                    size_t bin,
                                    size_t outputChannel) const;
    float surroundFrequencyWeight(size_t bin) const;
    float centerDetailFrequencyWeight(size_t bin) const;
    bool isSurround(SpeakerRole role) const;
};

size_t chooseTransformSize(float sampleRate);
SpeakerRole parseSpeakerRole(const char* role);
Algorithm parseAlgorithm(const char* algorithm);
const char* algorithmName(Algorithm algorithm);

} // namespace Astra::Upmix
