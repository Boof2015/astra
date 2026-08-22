#include "adaptive_upmixer.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>

namespace Astra::Upmix {
namespace {

constexpr float kEpsilon = 1.0e-12f;
constexpr float kSqrtHalf = 0.7071067811865475244f;
constexpr float kAmbientPhase = 0.6f * static_cast<float>(M_PI);
// The winning dominant-matrix render required +5.80570749 dB to reach the
// selected -6 dB rear/front level on the reference track. Keep this fixed in
// production: a moving level servo would pump and would no longer match the
// approved audition.
constexpr float kSelectedSurroundGain = 1.95112626187f;
constexpr size_t kStemCount = 4;

enum class BinClass {
    SteerableDirect,
    FrontLockedDirect,
    Diffuse,
};

float clamp01(float value) {
    return std::max(0.0f, std::min(1.0f, value));
}

float smoothstep(float edge0, float edge1, float value) {
    if (edge0 == edge1) return value < edge0 ? 0.0f : 1.0f;
    const float x = clamp01((value - edge0) / (edge1 - edge0));
    return x * x * (3.0f - 2.0f * x);
}

bool equals(const char* left, const char* right) {
    return left && right && std::strcmp(left, right) == 0;
}

bool isResearchResetCandidate(Algorithm algorithm) {
    return algorithm == Algorithm::FixedDifference ||
           algorithm == Algorithm::DominantMatrix ||
           algorithm == Algorithm::WeightedPca ||
           algorithm == Algorithm::Geometric;
}

bool usesSelectedRenderer(Algorithm algorithm) {
    return algorithm == Algorithm::Adaptive || isResearchResetCandidate(algorithm);
}

bool usesDominantMatrixExtraction(Algorithm algorithm) {
    return algorithm == Algorithm::Adaptive || algorithm == Algorithm::DominantMatrix;
}

size_t delayFrames(float sampleRate, double seconds) {
    // Explicit nearest-frame conversion avoids a native/WASM one-sample split
    // when a nominal integer product lands just below that integer in one
    // floating-point implementation.
    return static_cast<size_t>(static_cast<double>(sampleRate) * seconds + 0.5);
}

size_t maximumSurroundDelay(const Config& config) {
    const double seconds = usesSelectedRenderer(config.algorithm) ? 0.016 : 0.0037;
    return delayFrames(config.sampleRate, seconds);
}

} // namespace

size_t chooseTransformSize(float sampleRate) {
    const float safeRate = std::max(8000.0f, std::min(192000.0f, sampleRate));
    const float target = safeRate * 0.043f;
    size_t lower = 256;
    while (lower * 2 <= static_cast<size_t>(target) && lower < 8192) lower *= 2;
    const size_t upper = std::min<size_t>(8192, lower * 2);
    return std::abs(target - static_cast<float>(lower)) <=
                   std::abs(static_cast<float>(upper) - target)
        ? lower
        : upper;
}

SpeakerRole parseSpeakerRole(const char* role) {
    if (equals(role, "FL")) return SpeakerRole::FrontLeft;
    if (equals(role, "FR")) return SpeakerRole::FrontRight;
    if (equals(role, "FC")) return SpeakerRole::FrontCenter;
    if (equals(role, "LFE")) return SpeakerRole::Lfe;
    if (equals(role, "SL")) return SpeakerRole::SideLeft;
    if (equals(role, "SR")) return SpeakerRole::SideRight;
    if (equals(role, "BL")) return SpeakerRole::BackLeft;
    if (equals(role, "BR")) return SpeakerRole::BackRight;
    if (equals(role, "TFL") || equals(role, "TFR") ||
        equals(role, "TBL") || equals(role, "TBR")) return SpeakerRole::Height;
    return SpeakerRole::Unknown;
}

Algorithm parseAlgorithm(const char* algorithm) {
    if (equals(algorithm, "fixed-difference")) return Algorithm::FixedDifference;
    if (equals(algorithm, "dominant-matrix")) return Algorithm::DominantMatrix;
    if (equals(algorithm, "coherence-mask")) return Algorithm::CoherenceMask;
    if (equals(algorithm, "weighted-pca")) return Algorithm::WeightedPca;
    if (equals(algorithm, "panning-model")) return Algorithm::PanningModel;
    if (equals(algorithm, "geometric-decomposition")) return Algorithm::Geometric;
    if (equals(algorithm, "rejected-adaptive-control")) return Algorithm::RejectedAdaptiveControl;
    return Algorithm::Adaptive;
}

const char* algorithmName(Algorithm algorithm) {
    switch (algorithm) {
        case Algorithm::FixedDifference: return "fixed-difference";
        case Algorithm::DominantMatrix: return "dominant-matrix";
        case Algorithm::CoherenceMask: return "coherence-mask";
        case Algorithm::WeightedPca: return "weighted-pca";
        case Algorithm::PanningModel: return "panning-model";
        case Algorithm::Geometric: return "geometric-decomposition";
        case Algorithm::RejectedAdaptiveControl: return "rejected-adaptive-control";
        case Algorithm::Adaptive: return "adaptive";
    }
    return "adaptive";
}

AdaptiveUpmixer::AdaptiveUpmixer(const Config& config)
    : config_(config),
      fftSize_(chooseTransformSize(config.sampleRate)),
      hopSize_(fftSize_ / 4),
      maxSurroundDelay_(maximumSurroundDelay(config)),
      olaSize_(fftSize_ * 2 + maxSurroundDelay_ + hopSize_),
      fft_(fftSize_),
      window_(fftSize_),
      inputLeft_(fftSize_, 0.0f),
      inputRight_(fftSize_, 0.0f),
      frameLeft_(fftSize_, 0.0f),
      frameRight_(fftSize_, 0.0f),
      inverseScratch_(fftSize_, 0.0f),
      spectrumLeft_(fftSize_),
      spectrumRight_(fftSize_),
      renderedSpectra_(config.outputRoles.size(), std::vector<std::complex<float>>(fftSize_)),
      stemSpectra_(kStemCount, std::vector<std::complex<float>>(fftSize_)),
      overlapAdd_(config.outputRoles.size() + kStemCount, std::vector<float>(olaSize_, 0.0f)),
      powerLeft_(fftSize_ / 2 + 1, 0.0f),
      powerRight_(fftSize_ / 2 + 1, 0.0f),
      crossPower_(fftSize_ / 2 + 1),
      previousMagnitude_(fftSize_ / 2 + 1, 0.0f),
      previousPan_(fftSize_ / 2 + 1, 0.0f),
      panStability_(fftSize_ / 2 + 1, 1.0f),
      roleDelayFrames_(config.outputRoles.size(), 0) {
    if (!std::isfinite(config.sampleRate) || config.sampleRate < 8000.0f ||
        config.sampleRate > 192000.0f) {
        throw std::invalid_argument("AdaptiveUpmixer sample rate must be between 8 and 192 kHz");
    }
    if (config.outputRoles.empty() || config.outputRoles.size() > 32) {
        throw std::invalid_argument("AdaptiveUpmixer requires 1-32 output roles");
    }
    if (!std::isfinite(config.surroundCenterMixGain) ||
        config.surroundCenterMixGain < 0.0f || config.surroundCenterMixGain > 1.0f) {
        throw std::invalid_argument("AdaptiveUpmixer center-detail gain must be between 0 and 1");
    }

    for (size_t n = 0; n < fftSize_; ++n) {
        // Periodic Hann analysis/synthesis pair. At 75% overlap the sum of
        // Hann products is exactly 2, hence the 0.5 synthesis normalization.
        const float hann = 0.5f - 0.5f * std::cos(
            2.0f * static_cast<float>(M_PI) * static_cast<float>(n) /
            static_cast<float>(fftSize_));
        window_[n] = std::sqrt(std::max(0.0f, hann));
    }

    for (size_t channel = 0; channel < config_.outputRoles.size(); ++channel) {
        if (usesSelectedRenderer(config_.algorithm)) {
            switch (config_.outputRoles[channel]) {
                case SpeakerRole::SideLeft:
                case SpeakerRole::BackLeft:
                    roleDelayFrames_[channel] =
                        delayFrames(config.sampleRate, 0.012);
                    break;
                case SpeakerRole::SideRight:
                case SpeakerRole::BackRight:
                    roleDelayFrames_[channel] =
                        delayFrames(config.sampleRate, 0.016);
                    break;
                default:
                    break;
            }
            continue;
        }
        switch (config_.outputRoles[channel]) {
            // Long rear delays make the leading fronts dominate through the
            // precedence effect. These small, unequal offsets supplement the
            // phase decorrelator without perceptually pushing the bed behind
            // the direct image.
            case SpeakerRole::SideLeft: roleDelayFrames_[channel] = delayFrames(config.sampleRate, 0.0013); break;
            case SpeakerRole::SideRight: roleDelayFrames_[channel] = delayFrames(config.sampleRate, 0.0019); break;
            case SpeakerRole::BackLeft: roleDelayFrames_[channel] = delayFrames(config.sampleRate, 0.0029); break;
            case SpeakerRole::BackRight: roleDelayFrames_[channel] = delayFrames(config.sampleRate, 0.0037); break;
            default: break;
        }
    }
}

bool AdaptiveUpmixer::isSurround(SpeakerRole role) const {
    return role == SpeakerRole::SideLeft || role == SpeakerRole::SideRight ||
           role == SpeakerRole::BackLeft || role == SpeakerRole::BackRight;
}

void AdaptiveUpmixer::reset() {
    std::fill(inputLeft_.begin(), inputLeft_.end(), 0.0f);
    std::fill(inputRight_.begin(), inputRight_.end(), 0.0f);
    for (auto& channel : overlapAdd_) std::fill(channel.begin(), channel.end(), 0.0f);
    std::fill(powerLeft_.begin(), powerLeft_.end(), 0.0f);
    std::fill(powerRight_.begin(), powerRight_.end(), 0.0f);
    std::fill(crossPower_.begin(), crossPower_.end(), std::complex<float>{});
    std::fill(previousMagnitude_.begin(), previousMagnitude_.end(), 0.0f);
    std::fill(previousPan_.begin(), previousPan_.end(), 0.0f);
    std::fill(panStability_.begin(), panStability_.end(), 1.0f);
    inputWrite_ = 0;
    inputCount_ = 0;
    diagnostics_ = {};
}

void AdaptiveUpmixer::process(const float* stereoInterleaved,
                              float* outputInterleaved,
                              size_t frameCount,
                              float* stemsInterleaved) {
    synthesizeStems_ = stemsInterleaved != nullptr;
    const size_t outputChannels = config_.outputRoles.size();
    for (size_t frame = 0; frame < frameCount; ++frame) {
        float left = stereoInterleaved ? stereoInterleaved[frame * 2] : 0.0f;
        float right = stereoInterleaved ? stereoInterleaved[frame * 2 + 1] : 0.0f;
        if (!std::isfinite(left)) { left = 0.0f; ++diagnostics_.nonFiniteSamples; }
        if (!std::isfinite(right)) { right = 0.0f; ++diagnostics_.nonFiniteSamples; }

        diagnostics_.inputEnergy += static_cast<double>(left) * left +
                                    static_cast<double>(right) * right;
        ++diagnostics_.inputFrames;

        inputLeft_[inputWrite_] = left;
        inputRight_[inputWrite_] = right;
        inputWrite_ = (inputWrite_ + 1) % fftSize_;
        ++inputCount_;

        if (inputCount_ % hopSize_ == 0) renderFrame();

        const size_t olaIndex = static_cast<size_t>((inputCount_ - 1) % olaSize_);
        for (size_t channel = 0; channel < outputChannels; ++channel) {
            float sample = overlapAdd_[channel][olaIndex];
            overlapAdd_[channel][olaIndex] = 0.0f;
            if (!std::isfinite(sample) || std::abs(sample) < 1.0e-30f) {
                if (!std::isfinite(sample)) ++diagnostics_.nonFiniteSamples;
                sample = 0.0f;
            }
            outputInterleaved[frame * outputChannels + channel] = sample;
            diagnostics_.outputEnergy += static_cast<double>(sample) * sample;
            if (isSurround(config_.outputRoles[channel])) {
                diagnostics_.surroundEnergy += static_cast<double>(sample) * sample;
            }
        }

        for (size_t stem = 0; stem < kStemCount; ++stem) {
            const size_t olaChannel = outputChannels + stem;
            float sample = overlapAdd_[olaChannel][olaIndex];
            overlapAdd_[olaChannel][olaIndex] = 0.0f;
            if (!std::isfinite(sample) || std::abs(sample) < 1.0e-30f) sample = 0.0f;
            if (stemsInterleaved) stemsInterleaved[frame * kStemCount + stem] = sample;
        }
    }
}

float AdaptiveUpmixer::surroundFrequencyWeight(size_t bin) const {
    const float frequency = static_cast<float>(bin) * config_.sampleRate /
                            static_cast<float>(fftSize_);
    if (usesSelectedRenderer(config_.algorithm)) {
        // The selected profile and all bake-off candidates use the same
        // restrained surround voicing:
        // remove only sub-bass, then apply a fourth-order Butterworth-shaped
        // magnitude taper with a -3 dB point at 7 kHz.
        const float low = smoothstep(40.0f, 80.0f, frequency);
        const float normalized = frequency / 7000.0f;
        const float high = 1.0f / std::sqrt(1.0f + std::pow(normalized, 8.0f));
        return low * high;
    }
    // Preserve enough lower-mid body and air for the surrounds to register as
    // real channels rather than a thin effect, while keeping sub-bass in the
    // fronts and gently reducing the least useful extreme top octave.
    const float low = smoothstep(80.0f, 180.0f, frequency);
    const float high = 1.0f - 0.16f * smoothstep(11000.0f, 18000.0f, frequency);
    return low * high;
}

float AdaptiveUpmixer::centerDetailFrequencyWeight(size_t bin) const {
    const float frequency = static_cast<float>(bin) * config_.sampleRate /
                            static_cast<float>(fftSize_);
    if (frequency <= 0.0f) return 0.0f;

    // Match Ambient's tonal window without copying its extraction graph: two
    // cascaded Butterworth high-passes at 300 Hz and one low-pass at 7 kHz.
    // This keeps the trial focused on audible center detail, not added bass.
    const float highpassRatio = 300.0f / frequency;
    const float highpass = 1.0f /
        (1.0f + std::pow(highpassRatio, 4.0f));
    const float lowpassRatio = frequency / 7000.0f;
    const float lowpass = 1.0f /
        std::sqrt(1.0f + std::pow(lowpassRatio, 4.0f));
    return highpass * lowpass;
}

std::complex<float> AdaptiveUpmixer::decorrelate(std::complex<float> value,
                                                  size_t bin,
                                                  size_t outputChannel) const {
    if (bin == 0 || bin == fftSize_ / 2) return {value.real(), 0.0f};
    // A fixed, frequency-varying unit-magnitude phase response creates an
    // independent diffuse image without frame-to-frame modulation or reverb.
    const float seed = 0.73f + static_cast<float>(outputChannel + 1) * 1.117f;
    const float x = static_cast<float>(bin) / static_cast<float>(fftSize_ / 2);
    const float phase = static_cast<float>(M_PI) * (
        0.64f * std::sin(seed * 5.3f * x + seed) +
        0.31f * std::sin(seed * 17.7f * x + 0.4f));
    return value * std::complex<float>(std::cos(phase), std::sin(phase));
}

void AdaptiveUpmixer::setSpectrumBin(std::vector<std::complex<float>>& spectrum,
                                      size_t bin,
                                      std::complex<float> value) {
    if (bin == 0 || bin == fftSize_ / 2) value = {value.real(), 0.0f};
    spectrum[bin] = value;
    if (bin > 0 && bin < fftSize_ / 2) spectrum[fftSize_ - bin] = std::conj(value);
}

void AdaptiveUpmixer::synthesizeSpectrum(size_t channel, size_t delayFrames) {
    const size_t outputChannels = config_.outputRoles.size();
    const bool stem = channel >= outputChannels;
    const auto& spectrum = stem
        ? stemSpectra_[channel - outputChannels]
        : renderedSpectra_[channel];
    fft_.inverse(spectrum.data(), inverseScratch_.data());

    const uint64_t start = inputCount_ + delayFrames;
    for (size_t n = 0; n < fftSize_; ++n) {
        const size_t index = static_cast<size_t>((start + n) % olaSize_);
        overlapAdd_[channel][index] += inverseScratch_[n] * window_[n] * 0.5f;
    }
}

void AdaptiveUpmixer::renderFrame() {
    for (size_t n = 0; n < fftSize_; ++n) {
        const size_t source = (inputWrite_ + n) % fftSize_;
        frameLeft_[n] = inputLeft_[source] * window_[n];
        frameRight_[n] = inputRight_[source] * window_[n];
    }
    fft_.forward(frameLeft_.data(), spectrumLeft_.data());
    fft_.forward(frameRight_.data(), spectrumRight_.data());

    for (auto& spectrum : renderedSpectra_) {
        std::fill(spectrum.begin(), spectrum.end(), std::complex<float>{});
    }
    if (synthesizeStems_) {
        for (auto& spectrum : stemSpectra_) {
            std::fill(spectrum.begin(), spectrum.end(), std::complex<float>{});
        }
    }

    const float averagingSeconds = usesSelectedRenderer(config_.algorithm)
        ? 0.250f
        : 0.060f;
    const float averaging = std::exp(-static_cast<float>(hopSize_) /
                                     (config_.sampleRate * averagingSeconds));
    const bool hasCenter = std::find(config_.outputRoles.begin(), config_.outputRoles.end(),
                                     SpeakerRole::FrontCenter) != config_.outputRoles.end();
    const bool hasBacks = std::find(config_.outputRoles.begin(), config_.outputRoles.end(),
                                    SpeakerRole::BackLeft) != config_.outputRoles.end() ||
                          std::find(config_.outputRoles.begin(), config_.outputRoles.end(),
                                    SpeakerRole::BackRight) != config_.outputRoles.end();
    const bool selectedProfile = config_.algorithm == Algorithm::Adaptive;
    // Allocate ambient power, rather than amplitude, across each same-side
    // speaker set. Quad/5.x moves roughly two thirds of it to the surround;
    // 7.x divides that share between side and back. This keeps the overall
    // ambient target near unity while making the additional bed meaningful.
    const float frontAmbientGain = 0.58f;
    const float sideAmbientGain = hasBacks ? 0.60f : 0.8146f;
    const float backAmbientGain = 0.5510f;
    const std::complex<float> ambientPhase(std::cos(kAmbientPhase),
                                           std::sin(kAmbientPhase));

    for (size_t bin = 0; bin <= fftSize_ / 2; ++bin) {
        const std::complex<float> left = spectrumLeft_[bin];
        const std::complex<float> right = spectrumRight_[bin];
        const float instantaneousLeft = std::norm(left);
        const float instantaneousRight = std::norm(right);
        const std::complex<float> instantaneousCross = left * std::conj(right);

        powerLeft_[bin] = averaging * powerLeft_[bin] + (1.0f - averaging) * instantaneousLeft;
        powerRight_[bin] = averaging * powerRight_[bin] + (1.0f - averaging) * instantaneousRight;
        crossPower_[bin] = averaging * crossPower_[bin] + (1.0f - averaging) * instantaneousCross;

        const float totalPower = powerLeft_[bin] + powerRight_[bin];
        const float rootLeft = std::sqrt(std::max(0.0f, powerLeft_[bin]));
        const float rootRight = std::sqrt(std::max(0.0f, powerRight_[bin]));
        const float balance = 2.0f * rootLeft * rootRight / (totalPower + kEpsilon);
        const float coherence = std::abs(crossPower_[bin]) /
            (rootLeft * rootRight + kEpsilon);
        const float eigenSeparation = std::sqrt(
            (powerLeft_[bin] - powerRight_[bin]) *
            (powerLeft_[bin] - powerRight_[bin]) +
            4.0f * std::norm(crossPower_[bin])) / (totalPower + kEpsilon);
        const float directness = clamp01(eigenSeparation);
        const float dominantEigenvalue = 0.5f * totalPower * (1.0f + directness);
        const float eigenLeft = std::abs(crossPower_[bin]);
        const float eigenRight = std::abs(dominantEigenvalue - powerLeft_[bin]);
        const float eigenVectorSum = eigenLeft + eigenRight;
        const float pan = eigenVectorSum > kEpsilon
            ? (eigenRight - eigenLeft) / eigenVectorSum
            : (rootRight - rootLeft) / (rootRight + rootLeft + kEpsilon);
        const float panDelta = std::abs(pan - previousPan_[bin]);
        panStability_[bin] = 0.8f * panStability_[bin] +
                             0.2f * std::exp(-7.0f * panDelta);
        previousPan_[bin] = pan;

        const float magnitude = std::sqrt(instantaneousLeft + instantaneousRight);
        const float flux = clamp01((magnitude - previousMagnitude_[bin]) /
                                   (previousMagnitude_[bin] + 1.0e-6f));
        previousMagnitude_[bin] = magnitude;

        const float phaseCosine = std::abs(crossPower_[bin]) > kEpsilon
            ? crossPower_[bin].real() / (std::abs(crossPower_[bin]) + kEpsilon)
            : 0.0f;
        const float phaseReliability = (1.0f - balance) +
            balance * clamp01(phaseCosine);
        const BinClass classification = balance < 0.18f || flux > 0.62f
            ? BinClass::FrontLockedDirect
            : directness > 0.55f && panStability_[bin] > 0.55f && phaseReliability > 0.4f
                ? BinClass::SteerableDirect
                : BinClass::Diffuse;
        const float centerPan = 1.0f - smoothstep(0.10f, 0.46f, std::abs(pan));
        // Production center extraction must be continuous. A hard class gate
        // can chatter near a threshold and can even choose different sides of
        // the boundary under native and WASM floating-point implementations.
        // The same evidence is retained, but cross-faded over a useful range.
        float centerConfidence = 0.0f;
        if (hasCenter) {
            centerConfidence = selectedProfile
                ? smoothstep(0.50f, 0.72f, directness) *
                  smoothstep(0.35f, 0.65f, phaseReliability) *
                  smoothstep(0.48f, 0.76f, panStability_[bin]) * centerPan *
                  (1.0f - smoothstep(0.30f, 0.72f, flux))
                : classification == BinClass::SteerableDirect
                    ? directness * phaseReliability * panStability_[bin] * centerPan
                    : 0.0f;
        }

        float diffuseMask = 0.0f;
        switch (config_.algorithm) {
            case Algorithm::FixedDifference: {
                const float similarity = 1.0f - std::abs(rootLeft - rootRight) /
                    (rootLeft + rootRight + kEpsilon);
                diffuseMask = clamp01(similarity); // diagnostic confidence; extraction below is exact L-R.
                centerConfidence = hasCenter ? clamp01(similarity * phaseReliability) : 0.0f;
                break;
            }
            case Algorithm::DominantMatrix:
                // The ambient energy diagnostic is calculated from the
                // orthogonal residual below.
                break;
            case Algorithm::CoherenceMask:
                diffuseMask = clamp01((1.0f - coherence) * balance);
                break;
            case Algorithm::WeightedPca:
                // Ibrahim/Allam adaptive weighting is applied to the dominant
                // PCA projection below; this is not the former scalar mask.
                break;
            case Algorithm::PanningModel:
                // Calculated as a complementary generalized mid/side residual
                // below. The diagnostic value is derived from its energy.
                break;
            case Algorithm::Geometric:
                // Paulus/Torcoli's ambient unmixing matrix is applied below.
                break;
            case Algorithm::Adaptive:
                // Production uses the listening-approved dominant-direction
                // residual below.
                break;
            case Algorithm::RejectedAdaptiveControl:
                // Retained only so the failed panning/scene-expansion control
                // remains reproducible in the offline research harness.
                break;
        }

        if (totalPower < 1.0e-14f) {
            diffuseMask = 0.0f;
            centerConfidence = 0.0f;
        }

        std::complex<float> ambientLeft{};
        std::complex<float> ambientRight{};
        std::complex<float> modelDirect{};
        float modelPanLeft = 0.0f;
        float modelPanRight = 0.0f;
        if (config_.algorithm == Algorithm::FixedDifference) {
            ambientLeft = (left - right) * 0.5f;
            ambientRight = (right - left) * 0.5f;
        } else if (usesDominantMatrixExtraction(config_.algorithm)) {
            // Irwan/Aarts-style dominant-direction cancellation. A real,
            // non-negative principal direction represents conventional
            // amplitude panning; negative-phase material is not mislabeled as
            // a direct source. The residual is the orthogonal projection
            // (I - ww^T)x and therefore rejects dual mono and hard pans.
            const float realCross = std::max(0.0f, crossPower_[bin].real());
            const float separation = std::sqrt(
                (powerLeft_[bin] - powerRight_[bin]) *
                (powerLeft_[bin] - powerRight_[bin]) +
                4.0f * realCross * realCross);
            float directionLeft = 0.0f;
            float directionRight = 0.0f;
            if (realCross > kEpsilon) {
                // This is algebraically the same principal eigenvector as
                // [c, lambda-a], but avoids subtracting nearly equal values.
                // That cancellation made the approved extractor diverge
                // materially between native libm and WebAssembly.
                if (powerLeft_[bin] >= powerRight_[bin]) {
                    const float denominator = 0.5f *
                        (powerLeft_[bin] - powerRight_[bin] + separation);
                    const float ratio = realCross / std::max(denominator, kEpsilon);
                    const float normalization = 1.0f / std::sqrt(1.0f + ratio * ratio);
                    directionLeft = normalization;
                    directionRight = ratio * normalization;
                } else {
                    const float denominator = 0.5f *
                        (powerRight_[bin] - powerLeft_[bin] + separation);
                    const float ratio = realCross / std::max(denominator, kEpsilon);
                    const float normalization = 1.0f / std::sqrt(1.0f + ratio * ratio);
                    directionLeft = ratio * normalization;
                    directionRight = normalization;
                }
            } else {
                directionLeft = powerLeft_[bin] >= powerRight_[bin] ? 1.0f : 0.0f;
                directionRight = powerRight_[bin] > powerLeft_[bin] ? 1.0f : 0.0f;
                if (totalPower <= kEpsilon) {
                    directionLeft = kSqrtHalf;
                    directionRight = kSqrtHalf;
                }
            }
            const std::complex<float> deviation =
                directionRight * left - directionLeft * right;
            ambientLeft = directionRight * deviation;
            ambientRight = -directionLeft * deviation;
        } else if (config_.algorithm == Algorithm::WeightedPca) {
            // Adaptive weighted PCA from Ibrahim/Allam:
            // omega = 1 - lambda2/lambda1. Above theta=0.7, retain an
            // omega-weighted projection onto the dominant eigenvector as the
            // primary component; otherwise classify the whole bin ambient.
            const float lambdaOne = dominantEigenvalue;
            const float lambdaTwo = 0.5f * totalPower * (1.0f - directness);
            const float omega = lambdaOne > kEpsilon
                ? clamp01(1.0f - lambdaTwo / lambdaOne)
                : 0.0f;
            std::complex<float> vectorLeft{};
            std::complex<float> vectorRight{};
            if (std::abs(crossPower_[bin]) > kEpsilon) {
                vectorLeft = crossPower_[bin];
                vectorRight = {lambdaOne - powerLeft_[bin], 0.0f};
                const float norm = std::sqrt(
                    std::norm(vectorLeft) + std::norm(vectorRight));
                if (norm > kEpsilon) {
                    vectorLeft /= norm;
                    vectorRight /= norm;
                }
            } else if (powerLeft_[bin] >= powerRight_[bin]) {
                vectorLeft = {1.0f, 0.0f};
            } else {
                vectorRight = {1.0f, 0.0f};
            }
            if (omega > 0.7f) {
                const std::complex<float> projection =
                    std::conj(vectorLeft) * left + std::conj(vectorRight) * right;
                const std::complex<float> weighted = omega * projection;
                ambientLeft = left - vectorLeft * weighted;
                ambientRight = right - vectorRight * weighted;
            } else {
                ambientLeft = left;
                ambientRight = right;
            }
        } else if (config_.algorithm == Algorithm::Geometric) {
            // Paulus/Torcoli equations (23-24), simplified using
            // (trace-k)/(2*det) = 1/lambda_max. The signal model uses the real
            // positive covariance as the centered primary energy; negative
            // phase is consequently retained as ambience.
            const float covarianceLimit =
                std::sqrt(std::max(0.0f, powerLeft_[bin] * powerRight_[bin]));
            const float realCross = std::max(
                0.0f, std::min(covarianceLimit, crossPower_[bin].real()));
            const float k = std::sqrt(
                (powerLeft_[bin] - powerRight_[bin]) *
                (powerLeft_[bin] - powerRight_[bin]) +
                4.0f * realCross * realCross);
            const float lambdaMax = 0.5f * (totalPower + k);
            if (lambdaMax > kEpsilon) {
                ambientLeft = (powerRight_[bin] * left - realCross * right) /
                              lambdaMax;
                ambientRight = (powerLeft_[bin] * right - realCross * left) /
                               lambdaMax;
            }
        } else if (config_.algorithm == Algorithm::RejectedAdaptiveControl ||
                   config_.algorithm == Algorithm::PanningModel) {
            // Generalized mid/side decomposition from Kraft/Zolzer. The
            // dominant intensity-panned source is modeled by real, constant-
            // power coefficients; the complementary residual has a nominal
            // interchannel phase of 0.6*pi. Unlike the old (1-directness)
            // scalar mask, this extracts deviations from the dominant image
            // instead of nearly muting ordinary mastered music.
            const float normalization = std::sqrt(std::max(totalPower, kEpsilon));
            modelPanLeft = rootLeft / normalization;
            modelPanRight = rootRight / normalization;
            const std::complex<float> denominator =
                modelPanLeft * ambientPhase - modelPanRight;
            if (std::norm(denominator) > kEpsilon) {
                modelDirect =
                    (left * ambientPhase - right) / denominator;
                ambientLeft = left - modelPanLeft * modelDirect;
                ambientRight = right - modelPanRight * modelDirect;
            }

            if (config_.algorithm == Algorithm::RejectedAdaptiveControl) {
                // Strong attacks and extreme one-sided bins remain front
                // biased. Protection is continuous so it cannot chatter at a
                // class boundary, and stable phase-wide material is not
                // incorrectly rejected as direct sound.
                const float transientProtection =
                    1.0f - 0.84f * smoothstep(0.38f, 0.82f, flux);
                const float edgeProtection =
                    0.18f + 0.82f * smoothstep(0.12f, 0.32f, balance);
                const float extractionGain = transientProtection * edgeProtection;
                ambientLeft *= extractionGain;
                ambientRight *= extractionGain;
            }

            diffuseMask = clamp01(std::sqrt(
                (std::norm(ambientLeft) + std::norm(ambientRight)) /
                (instantaneousLeft + instantaneousRight + kEpsilon)));
        } else {
            ambientLeft = left * diffuseMask;
            ambientRight = right * diffuseMask;
        }
        if (usesDominantMatrixExtraction(config_.algorithm) ||
            config_.algorithm == Algorithm::WeightedPca ||
            config_.algorithm == Algorithm::Geometric) {
            diffuseMask = clamp01(std::sqrt(
                (std::norm(ambientLeft) + std::norm(ambientRight)) /
                (instantaneousLeft + instantaneousRight + kEpsilon)));
        }
        const std::complex<float> primaryLeft = left - ambientLeft;
        const std::complex<float> primaryRight = right - ambientRight;
        const bool researchCandidate = isResearchResetCandidate(config_.algorithm);
        if (researchCandidate) centerConfidence = 0.0f;
        const std::complex<float> center = researchCandidate
            ? std::complex<float>{}
            : (primaryLeft + primaryRight) * (kSqrtHalf * centerConfidence);
        float sceneExpansion = 0.0f;
        std::complex<float> relocatedDirectLeft{};
        std::complex<float> relocatedDirectRight{};
        std::complex<float> frontDirectAdjustmentLeft{};
        std::complex<float> frontDirectAdjustmentRight{};
        if (config_.algorithm == Algorithm::RejectedAdaptiveControl &&
            std::norm(modelDirect) > kEpsilon) {
            const float modelPan = (modelPanRight - modelPanLeft) /
                (modelPanRight + modelPanLeft + kEpsilon);
            const float absolutePan = std::abs(modelPan);
            const float lateralEligibility = smoothstep(0.10f, 0.38f, absolutePan);
            // A fully one-sided source remains a front-corner event. Stable
            // positions inside that edge are fair game for synthetic scene
            // placement, which is what makes this an upmixer rather than only
            // an ambience extractor.
            const float hardPanGuard =
                1.0f - smoothstep(0.78f, 0.98f, absolutePan);
            const float directionReliability =
                smoothstep(0.56f, 0.88f, directness) *
                smoothstep(0.48f, 0.78f, panStability_[bin]) *
                smoothstep(0.34f, 0.72f, phaseReliability);
            const float attackGuard =
                1.0f - smoothstep(0.24f, 0.70f, flux);
            const float frequency = static_cast<float>(bin) * config_.sampleRate /
                                    static_cast<float>(fftSize_);
            const float frequencyEligibility =
                smoothstep(180.0f, 420.0f, frequency) *
                (1.0f - 0.24f * smoothstep(12000.0f, 18000.0f, frequency));
            sceneExpansion = lateralEligibility * hardPanGuard *
                directionReliability * attackGuard * frequencyEligibility;

            // At full eligibility, move about 38% of this direct component's
            // power to its same-side surround. cos/sin gains make the move a
            // constant-power rotation instead of an energy-adding copy.
            const float moveAngle = 0.66f * sceneExpansion;
            const float frontDirectGain = std::cos(moveAngle);
            const float surroundDirectGain = std::sin(moveAngle);
            frontDirectAdjustmentLeft =
                modelPanLeft * modelDirect * (frontDirectGain - 1.0f);
            frontDirectAdjustmentRight =
                modelPanRight * modelDirect * (frontDirectGain - 1.0f);
            if (modelPan < 0.0f) relocatedDirectLeft = modelDirect * surroundDirectGain;
            else if (modelPan > 0.0f) relocatedDirectRight = modelDirect * surroundDirectGain;
        }

        const std::complex<float> frontLeft = researchCandidate
            ? left
            : selectedProfile
                ? left - center * kSqrtHalf
                : primaryLeft + frontDirectAdjustmentLeft - center * kSqrtHalf +
                  ambientLeft * frontAmbientGain;
        const std::complex<float> frontRight = researchCandidate
            ? right
            : selectedProfile
                ? right - center * kSqrtHalf
                : primaryRight + frontDirectAdjustmentRight - center * kSqrtHalf +
                  ambientRight * frontAmbientGain;
        const float surroundWeight = surroundFrequencyWeight(bin);
        std::complex<float> centerDetail{};
        if (selectedProfile && config_.surroundCenterMixGain > 0.0f) {
            centerDetail = (left + right) *
                (0.5f * config_.surroundCenterMixGain * centerDetailFrequencyWeight(bin));
        }

        if (synthesizeStems_) {
            setSpectrumBin(stemSpectra_[0], bin, primaryLeft);
            setSpectrumBin(stemSpectra_[1], bin, primaryRight);
            setSpectrumBin(stemSpectra_[2], bin, ambientLeft);
            setSpectrumBin(stemSpectra_[3], bin, ambientRight);
        }

        for (size_t channel = 0; channel < config_.outputRoles.size(); ++channel) {
            std::complex<float> value{};
            switch (config_.outputRoles[channel]) {
                case SpeakerRole::FrontLeft: value = frontLeft; break;
                case SpeakerRole::FrontRight: value = frontRight; break;
                case SpeakerRole::FrontCenter: value = center; break;
                case SpeakerRole::SideLeft:
                    value = decorrelate(ambientLeft * surroundWeight *
                                        (selectedProfile
                                             ? kSelectedSurroundGain * (hasBacks ? kSqrtHalf : 1.0f)
                                             : researchCandidate ? 1.0f : sideAmbientGain) +
                                        centerDetail * (hasBacks ? kSqrtHalf : 1.0f),
                                        bin, channel) + relocatedDirectLeft;
                    break;
                case SpeakerRole::SideRight:
                    value = decorrelate(ambientRight * surroundWeight *
                                        (selectedProfile
                                             ? kSelectedSurroundGain * (hasBacks ? kSqrtHalf : 1.0f)
                                             : researchCandidate ? 1.0f : sideAmbientGain) +
                                        centerDetail * (hasBacks ? kSqrtHalf : 1.0f),
                                        bin, channel) + relocatedDirectRight;
                    break;
                case SpeakerRole::BackLeft:
                    value = selectedProfile
                        ? decorrelate(ambientLeft *
                                      (kSelectedSurroundGain * kSqrtHalf * surroundWeight) +
                                      centerDetail * kSqrtHalf, bin, channel)
                        : researchCandidate
                            ? decorrelate(ambientLeft * (kSqrtHalf * surroundWeight), bin, channel)
                            : decorrelate((ambientLeft * 0.82f + ambientRight * 0.18f) *
                                          (backAmbientGain * surroundWeight), bin, channel);
                    break;
                case SpeakerRole::BackRight:
                    value = selectedProfile
                        ? decorrelate(ambientRight *
                                      (kSelectedSurroundGain * kSqrtHalf * surroundWeight) +
                                      centerDetail * kSqrtHalf, bin, channel)
                        : researchCandidate
                            ? decorrelate(ambientRight * (kSqrtHalf * surroundWeight), bin, channel)
                            : decorrelate((ambientRight * 0.82f + ambientLeft * 0.18f) *
                                          (backAmbientGain * surroundWeight), bin, channel);
                    break;
                case SpeakerRole::Lfe:
                case SpeakerRole::Height:
                case SpeakerRole::Unknown:
                    break;
            }
            setSpectrumBin(renderedSpectra_[channel], bin, value);
        }

        const double weight = static_cast<double>(instantaneousLeft + instantaneousRight);
        diagnostics_.weightedDirectness += weight * directness;
        diagnostics_.weightedDiffuseMask += weight * diffuseMask;
        diagnostics_.weightedCenterConfidence += weight * centerConfidence;
        diagnostics_.weightedSceneExpansion += weight * sceneExpansion;
        diagnostics_.analysisWeight += weight;
        if (classification == BinClass::SteerableDirect) diagnostics_.steerableWeight += weight;
        else if (classification == BinClass::FrontLockedDirect) diagnostics_.frontLockedWeight += weight;
        else diagnostics_.diffuseWeight += weight;
    }

    for (size_t channel = 0; channel < config_.outputRoles.size(); ++channel) {
        synthesizeSpectrum(channel, roleDelayFrames_[channel]);
    }
    if (synthesizeStems_) {
        for (size_t stem = 0; stem < kStemCount; ++stem) {
            synthesizeSpectrum(config_.outputRoles.size() + stem, 0);
        }
    }
    ++diagnostics_.analysisFrames;
}

} // namespace Astra::Upmix
