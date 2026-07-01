#define _USE_MATH_DEFINES
#include "spectrogram.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>

namespace Visualizer {

namespace {
constexpr size_t FFT_PAD_FACTOR = 4;
constexpr float DISPLAY_GAIN_DB = 2.0f;
constexpr float SPECTROGRAM_HEAT_GAMMA = 1.45f;
constexpr float SPECTROGRAM_DISPLAY_STROKE_WEIGHT = 0.42f;
constexpr float SPECTROGRAM_HEAT_STROKE_WEIGHT = 0.32f;
constexpr float TILT_REFERENCE_HZ = 1000.0f;
constexpr float HEAT_MIN_DB = -100.0f;
constexpr float HEAT_MAX_DB = -20.0f;
constexpr float SLANEY_F_SP = 200.0f / 3.0f;
constexpr float SLANEY_MIN_LOG_HZ = 1000.0f;
constexpr float SLANEY_MIN_LOG_MEL = SLANEY_MIN_LOG_HZ / SLANEY_F_SP;
constexpr float SLANEY_LOG_STEP = 1.8562979903656263f / 27.0f; // log(6.4) / 27

bool isPowerOfTwo(size_t value) {
    return value >= 2 && (value & (value - 1)) == 0;
}

float clamp01(float value) {
    return std::max(0.0f, std::min(1.0f, value));
}

float normalizeHeatDb(float db) {
    if (!std::isfinite(db)) {
        return 0.0f;
    }
    return clamp01((db - HEAT_MIN_DB) / (HEAT_MAX_DB - HEAT_MIN_DB));
}

float hzToMelSlaney(float frequencyHz) {
    if (frequencyHz < SLANEY_MIN_LOG_HZ) {
        return frequencyHz / SLANEY_F_SP;
    }
    return SLANEY_MIN_LOG_MEL + (std::log(frequencyHz / SLANEY_MIN_LOG_HZ) / SLANEY_LOG_STEP);
}

float melToHzSlaney(float mel) {
    if (mel < SLANEY_MIN_LOG_MEL) {
        return mel * SLANEY_F_SP;
    }
    return SLANEY_MIN_LOG_HZ * std::exp(SLANEY_LOG_STEP * (mel - SLANEY_MIN_LOG_MEL));
}

float wrapPhase(float value) {
    const float twoPi = static_cast<float>(2.0 * M_PI);
    float wrapped = std::remainder(value, twoPi);
    if (!std::isfinite(wrapped)) {
        return 0.0f;
    }
    return wrapped;
}
} // namespace

SpectrogramAnalyzer::SpectrogramAnalyzer()
    : fftSize_(0)
    , paddedSize_(0)
    , frameFill_(0)
    , haveLastPhase_(false) {
    configureFft(config_.fftSize);
    rebuildFrequencyMapping();
}

void SpectrogramAnalyzer::configure(const SpectrogramConfig& config) {
    SpectrogramConfig next = config;

    if (!isPowerOfTwo(next.fftSize)) {
        next.fftSize = 4096;
    }
    next.fftSize = std::clamp(next.fftSize, static_cast<size_t>(128), static_cast<size_t>(16384));
    next.sampleRate = std::isfinite(next.sampleRate) && next.sampleRate > 0.0f ? next.sampleRate : 48000.0f;
    next.rowCount = std::clamp(next.rowCount, static_cast<size_t>(1), static_cast<size_t>(8192));
    next.minFrequency = std::isfinite(next.minFrequency) && next.minFrequency > 0.0f ? next.minFrequency : 20.0f;
    next.maxFrequency = std::isfinite(next.maxFrequency) && next.maxFrequency > 0.0f ? next.maxFrequency : 20000.0f;
    next.minDecibels = std::isfinite(next.minDecibels) ? next.minDecibels : -90.0f;
    next.maxDecibels = std::isfinite(next.maxDecibels) ? next.maxDecibels : -12.0f;
    if (next.maxDecibels <= next.minDecibels) {
        next.maxDecibels = next.minDecibels + 1.0f;
    }
    next.scrollSpeed = std::isfinite(next.scrollSpeed) ? next.scrollSpeed : 2.0f;
    next.contrast = std::isfinite(next.contrast) ? next.contrast : 1.0f;
    next.contrast = std::clamp(next.contrast, 0.1f, 8.0f);
    next.tiltDbPerOctave = std::isfinite(next.tiltDbPerOctave) ? next.tiltDbPerOctave : 4.0f;
    next.tiltDbPerOctave = std::clamp(next.tiltDbPerOctave, -12.0f, 12.0f);
    if (next.scaleMode != "linear" && next.scaleMode != "mel" && next.scaleMode != "log") {
        next.scaleMode = "log";
    }
    if (next.orientation != "vertical") {
        next.orientation = "horizontal";
    }
    if (next.clarityMode != "classic" && next.clarityMode != "sharp" && next.clarityMode != "sharper") {
        next.clarityMode = "sharper";
    }

    const bool fftChanged = next.fftSize != fftSize_;
    const bool sampleRateChanged = next.sampleRate != config_.sampleRate;
    const bool mappingChanged = fftChanged
        || sampleRateChanged
        || next.rowCount != config_.rowCount
        || next.minFrequency != config_.minFrequency
        || next.maxFrequency != config_.maxFrequency
        || next.scaleMode != config_.scaleMode
        || next.orientation != config_.orientation;

    config_ = next;

    if (fftChanged) {
        configureFft(config_.fftSize);
    } else if (sampleRateChanged) {
        haveLastPhase_ = false;
    }

    if (mappingChanged) {
        rebuildFrequencyMapping();
    }
}

void SpectrogramAnalyzer::configureFft(size_t fftSize) {
    fftSize_ = fftSize;
    paddedSize_ = fftSize_ * FFT_PAD_FACTOR;
    fft_ = std::make_unique<DSP::FFT>(paddedSize_);
    frameBuffer_.assign(fftSize_, 0.0f);
    window_.assign(fftSize_, 1.0f);
    windowedInput_.assign(paddedSize_, 0.0f);
    fftOutput_.assign(paddedSize_, std::complex<float>(0.0f, 0.0f));
    magnitudesDb_.assign(paddedSize_ / 2, -200.0f);
    magnitudesLinear_.assign(paddedSize_ / 2, 0.0f);
    phases_.assign(paddedSize_ / 2, 0.0f);
    lastPhases_.assign(paddedSize_ / 2, 0.0f);
    frameFill_ = 0;
    haveLastPhase_ = false;

    if (fftSize_ <= 1) {
        return;
    }

    for (size_t index = 0; index < fftSize_; index += 1) {
        window_[index] = 0.5f * (1.0f - std::cos((2.0f * static_cast<float>(M_PI) * index) / (fftSize_ - 1)));
    }
}

void SpectrogramAnalyzer::reset() {
    std::fill(frameBuffer_.begin(), frameBuffer_.end(), 0.0f);
    std::fill(lastPhases_.begin(), lastPhases_.end(), 0.0f);
    frameFill_ = 0;
    haveLastPhase_ = false;
}

size_t SpectrogramAnalyzer::resolveHopSize() const {
    const float baseHopDivisor = 8.0f;
    const float speed = std::isfinite(config_.scrollSpeed) ? config_.scrollSpeed : 2.0f;
    const int divisor = std::clamp(static_cast<int>(std::lround(baseHopDivisor * speed)), 2, 64);
    return std::max(static_cast<size_t>(1), fftSize_ / static_cast<size_t>(divisor));
}

void SpectrogramAnalyzer::rebuildFrequencyMapping() {
    const size_t rowCount = std::max(static_cast<size_t>(1), config_.rowCount);
    const float sampleRate = std::max(1.0f, config_.sampleRate);
    const float nyquist = sampleRate * 0.5f;
    const float minFrequency = std::max(1.0f, std::min(config_.minFrequency, nyquist));
    const float maxFrequency = std::max(minFrequency + 1.0f, std::min(config_.maxFrequency, nyquist));
    config_.minFrequency = minFrequency;
    config_.maxFrequency = maxFrequency;

    rowCenterBins_.assign(rowCount, 0.0f);
    rowBandStartBins_.assign(rowCount, 0.0f);
    rowBandEndBins_.assign(rowCount, 0.0f);
    rowCenterFrequencies_.assign(rowCount, minFrequency);
    standardRaw_.assign(rowCount, 0.0f);
    standardHeat_.assign(rowCount, 0.0f);
    reassignedPower_.assign(rowCount, 0.0f);
    blendedRaw_.assign(rowCount, 0.0f);
    blendedHeat_.assign(rowCount, 0.0f);
    shapedDisplay_.assign(rowCount, 0.0f);
    shapedHeat_.assign(rowCount, 0.0f);
    strokedDisplay_.assign(rowCount, 0.0f);
    strokedHeat_.assign(rowCount, 0.0f);

    const float rowSpan = static_cast<float>(std::max(static_cast<size_t>(1), rowCount - 1));
    const float numBins = static_cast<float>(std::max(static_cast<size_t>(1), paddedSize_ / 2));
    const float binWidth = nyquist / numBins;

    for (size_t row = 0; row < rowCount; row += 1) {
        const float rowF = static_cast<float>(row);
        const float normalizedPosition = config_.orientation == "vertical"
            ? rowF / rowSpan
            : 1.0f - (rowF / rowSpan);

        float upperEdgeNormalized;
        float lowerEdgeNormalized;
        if (config_.orientation == "vertical") {
            upperEdgeNormalized = row == rowCount - 1 ? 1.0f : (rowF + 0.5f) / rowSpan;
            lowerEdgeNormalized = row == 0 ? 0.0f : (rowF - 0.5f) / rowSpan;
        } else {
            upperEdgeNormalized = row == 0 ? 1.0f : 1.0f - ((rowF - 0.5f) / rowSpan);
            lowerEdgeNormalized = row == rowCount - 1 ? 0.0f : 1.0f - ((rowF + 0.5f) / rowSpan);
        }

        const float centerFrequency = frequencyFromScale(normalizedPosition);
        const float lowerFrequency = frequencyFromScale(clamp01(lowerEdgeNormalized));
        const float upperFrequency = frequencyFromScale(clamp01(upperEdgeNormalized));

        rowCenterFrequencies_[row] = centerFrequency;
        rowCenterBins_[row] = std::clamp(centerFrequency / binWidth, 0.0f, numBins - 1.0f);
        rowBandStartBins_[row] = std::clamp(std::min(lowerFrequency, upperFrequency) / binWidth, 0.0f, numBins);
        rowBandEndBins_[row] = std::clamp(std::max(lowerFrequency, upperFrequency) / binWidth, 0.0f, numBins);
    }
}

float SpectrogramAnalyzer::frequencyFromScale(float normalizedPosition) const {
    const float t = clamp01(normalizedPosition);
    const float minFrequency = std::max(1.0f, config_.minFrequency);
    const float maxFrequency = std::max(minFrequency + 1.0f, config_.maxFrequency);

    if (config_.scaleMode == "linear") {
        return minFrequency + (t * (maxFrequency - minFrequency));
    }

    if (config_.scaleMode == "mel") {
        const float melMin = hzToMelSlaney(minFrequency);
        const float melMax = hzToMelSlaney(maxFrequency);
        return melToHzSlaney(melMin + (t * (melMax - melMin)));
    }

    const float logMin = std::log10(minFrequency);
    const float logMax = std::log10(maxFrequency);
    return std::pow(10.0f, logMin + (t * (logMax - logMin)));
}

float SpectrogramAnalyzer::frequencyToRow(float frequency) const {
    const float minFrequency = std::max(1.0f, config_.minFrequency);
    const float maxFrequency = std::max(minFrequency + 1.0f, config_.maxFrequency);
    const float clampedFrequency = std::clamp(frequency, minFrequency, maxFrequency);
    float normalized = 0.0f;

    if (config_.scaleMode == "linear") {
        normalized = (clampedFrequency - minFrequency) / std::max(maxFrequency - minFrequency, std::numeric_limits<float>::epsilon());
    } else if (config_.scaleMode == "mel") {
        const float melMin = hzToMelSlaney(minFrequency);
        const float melMax = hzToMelSlaney(maxFrequency);
        normalized = (hzToMelSlaney(clampedFrequency) - melMin) / std::max(melMax - melMin, std::numeric_limits<float>::epsilon());
    } else {
        const float logMin = std::log10(minFrequency);
        const float logMax = std::log10(maxFrequency);
        normalized = (std::log10(clampedFrequency) - logMin) / std::max(logMax - logMin, std::numeric_limits<float>::epsilon());
    }

    const float rowSpan = static_cast<float>(std::max(static_cast<size_t>(1), config_.rowCount - 1));
    return config_.orientation == "vertical"
        ? clamp01(normalized) * rowSpan
        : (1.0f - clamp01(normalized)) * rowSpan;
}

float SpectrogramAnalyzer::applyDisplayTilt(float db, float frequency) const {
    const float safeFrequency = std::max(1.0f, frequency);
    const float tiltAmount = config_.tiltDbPerOctave * std::log2(safeFrequency / TILT_REFERENCE_HZ);
    return db + tiltAmount + DISPLAY_GAIN_DB;
}

float SpectrogramAnalyzer::displayDbToIntensity(float db) const {
    const float range = std::max(1.0e-6f, config_.maxDecibels - config_.minDecibels);
    return clamp01((db - config_.minDecibels) / range);
}

float SpectrogramAnalyzer::sampleDbAtBin(float bin) const {
    if (magnitudesDb_.empty()) {
        return -200.0f;
    }

    const float clampedBin = std::clamp(bin, 0.0f, static_cast<float>(magnitudesDb_.size() - 1));
    const size_t i1 = static_cast<size_t>(std::floor(clampedBin));
    const float frac = clampedBin - static_cast<float>(i1);
    const size_t i0 = i1 > 0 ? i1 - 1 : i1;
    const size_t i2 = std::min(magnitudesDb_.size() - 1, i1 + 1);
    const size_t i3 = std::min(magnitudesDb_.size() - 1, i1 + 2);
    const float m0 = magnitudesDb_[i0];
    const float m1 = magnitudesDb_[i1];
    const float m2 = magnitudesDb_[i2];
    const float m3 = magnitudesDb_[i3];
    const float f2 = frac * frac;
    const float f3 = f2 * frac;

    return 0.5f * (
        (2.0f * m1)
        + ((-m0 + m2) * frac)
        + ((2.0f * m0 - 5.0f * m1 + 4.0f * m2 - m3) * f2)
        + ((-m0 + 3.0f * m1 - 3.0f * m2 + m3) * f3)
    );
}

void SpectrogramAnalyzer::computeStandardSpectrum() {
    const size_t rowCount = config_.rowCount;
    for (size_t row = 0; row < rowCount; row += 1) {
        const float displayDb = applyDisplayTilt(sampleDbAtBin(rowCenterBins_[row]), rowCenterFrequencies_[row]);
        standardRaw_[row] = displayDbToIntensity(displayDb);
        standardHeat_[row] = normalizeHeatDb(displayDb);
    }
}

void SpectrogramAnalyzer::computeReassignedSpectrum() {
    std::fill(reassignedPower_.begin(), reassignedPower_.end(), 0.0f);
    if (!haveLastPhase_ || magnitudesLinear_.size() < 3 || config_.rowCount == 0) {
        return;
    }

    const float sampleRate = std::max(1.0f, config_.sampleRate);
    const float binWidth = sampleRate / static_cast<float>(paddedSize_);
    const float hopDt = static_cast<float>(resolveHopSize()) / sampleRate;
    const float ampThreshold = std::pow(10.0f, config_.minDecibels / 20.0f);
    const float twoPi = static_cast<float>(2.0 * M_PI);

    for (size_t bin = 1; bin + 1 < magnitudesLinear_.size(); bin += 1) {
        const float mag = magnitudesLinear_[bin];
        if (mag <= ampThreshold) {
            continue;
        }
        if (mag < magnitudesLinear_[bin - 1] || mag < magnitudesLinear_[bin + 1]) {
            continue;
        }

        const float nominalFrequency = static_cast<float>(bin) * binWidth;
        if (nominalFrequency < config_.minFrequency || nominalFrequency > config_.maxFrequency) {
            continue;
        }

        const float expected = twoPi * nominalFrequency * hopDt;
        float correctionHz = wrapPhase(phases_[bin] - lastPhases_[bin] - expected) / (twoPi * hopDt);
        correctionHz = std::clamp(correctionHz, -1.5f * binWidth, 1.5f * binWidth);
        float reassignedFrequency = nominalFrequency + correctionHz;

        const float leftWeight = magnitudesLinear_[bin - 1];
        const float centerWeight = mag;
        const float rightWeight = magnitudesLinear_[bin + 1];
        const float weightSum = leftWeight + centerWeight + rightWeight;
        if (weightSum > std::numeric_limits<float>::epsilon()) {
            const float centroidFrequency = (
                (static_cast<float>(bin - 1) * binWidth * leftWeight)
                + (nominalFrequency * centerWeight)
                + (static_cast<float>(bin + 1) * binWidth * rightWeight)
            ) / weightSum;
            reassignedFrequency = 0.5f * reassignedFrequency + 0.5f * centroidFrequency;
        }

        reassignedFrequency = std::clamp(reassignedFrequency, config_.minFrequency, config_.maxFrequency);
        const float rowF = frequencyToRow(reassignedFrequency);
        const size_t row0 = static_cast<size_t>(std::floor(std::clamp(rowF, 0.0f, static_cast<float>(config_.rowCount - 1))));
        const float frac = rowF - static_cast<float>(row0);
        const float power = mag * mag;

        reassignedPower_[row0] += power * (1.0f - frac);
        if (row0 + 1 < config_.rowCount) {
            reassignedPower_[row0 + 1] += power * frac;
        }
    }
}

SpectrogramAnalyzer::ClarityProfile SpectrogramAnalyzer::clarityProfile(const std::string& mode) {
    if (mode == "classic") {
        return {1.4f, 0.0f, 3.0f};
    }
    if (mode == "sharp") {
        return {1.5f, 2.5f, 3.0f};
    }
    return {2.0f, 5.0f, 2.0f};
}

void SpectrogramAnalyzer::blendAndShapeColumn(std::vector<float>& display, std::vector<float>& heat) {
    const size_t rowCount = config_.rowCount;
    const ClarityProfile clarity = clarityProfile(config_.clarityMode);
    const float standardWeight = config_.clarityMode == "classic" ? 0.8f : (config_.clarityMode == "sharp" ? 0.6f : 0.45f);
    const float reassignedWeight = config_.clarityMode == "classic" ? 0.85f : 1.0f;

    for (size_t row = 0; row < rowCount; row += 1) {
        float reassignedRaw = 0.0f;
        float reassignedHeat = 0.0f;
        if (reassignedPower_[row] > 0.0f) {
            const float reassignedMag = std::sqrt(reassignedPower_[row]);
            const float reassignedDb = 20.0f * std::log10(std::max(reassignedMag, 1.0e-10f));
            const float displayDb = applyDisplayTilt(reassignedDb, rowCenterFrequencies_[row]);
            reassignedRaw = displayDbToIntensity(displayDb);
            reassignedHeat = normalizeHeatDb(displayDb);
        }

        blendedRaw_[row] = std::max(standardRaw_[row] * standardWeight, reassignedRaw * reassignedWeight);
        blendedHeat_[row] = std::max(standardHeat_[row] * standardWeight, reassignedHeat * reassignedWeight);
    }

    if (clarity.sharpness > 0.0f) {
        const std::vector<float> peakSource = blendedRaw_;
        const float mainlobePaddedBins = 4.0f * static_cast<float>(FFT_PAD_FACTOR);
        const float detailPreserve = config_.clarityMode == "sharp" ? 0.18f : 0.14f;

        for (size_t row = 0; row < rowCount; row += 1) {
            const float bandWidthPerRow = std::max(0.1f, rowBandEndBins_[row] - rowBandStartBins_[row]);
            const float mainlobePixels = mainlobePaddedBins / bandWidthPerRow;
            const int halfWindow = std::max(2, std::min(50, static_cast<int>(std::lround(mainlobePixels * 0.5f))));
            const float scaleFactor = std::max(1.0f, mainlobePixels / clarity.lineWidth);
            const float effectiveSharpness = clarity.sharpness * scaleFactor;

            float localMax = peakSource[row];
            for (int offset = 1; offset <= halfWindow; offset += 1) {
                if (row >= static_cast<size_t>(offset)) {
                    localMax = std::max(localMax, peakSource[row - static_cast<size_t>(offset)]);
                }
                if (row + static_cast<size_t>(offset) < rowCount) {
                    localMax = std::max(localMax, peakSource[row + static_cast<size_t>(offset)]);
                }
            }

            if (localMax > 1.0e-6f) {
                const float ratio = blendedRaw_[row] / localMax;
                const float suppression = std::pow(clamp01(ratio), effectiveSharpness);
                const float rawBefore = blendedRaw_[row];
                const float heatBefore = blendedHeat_[row];
                blendedRaw_[row] = std::max(rawBefore * suppression, rawBefore * detailPreserve);
                blendedHeat_[row] = std::max(heatBefore * suppression, heatBefore * detailPreserve);
            }
        }
    }

    const float effectiveGamma = clarity.gamma * config_.contrast;
    for (size_t row = 0; row < rowCount; row += 1) {
        shapedDisplay_[row] = std::pow(clamp01(blendedRaw_[row]), effectiveGamma);
        shapedHeat_[row] = std::pow(clamp01(blendedHeat_[row]), SPECTROGRAM_HEAT_GAMMA);
        strokedDisplay_[row] = shapedDisplay_[row];
        strokedHeat_[row] = shapedHeat_[row];
    }

    for (size_t row = 0; row < rowCount; row += 1) {
        const float displayShoulder = shapedDisplay_[row] * SPECTROGRAM_DISPLAY_STROKE_WEIGHT;
        const float heatShoulder = shapedHeat_[row] * SPECTROGRAM_HEAT_STROKE_WEIGHT;
        if (row > 0) {
            strokedDisplay_[row - 1] = std::max(strokedDisplay_[row - 1], displayShoulder);
            strokedHeat_[row - 1] = std::max(strokedHeat_[row - 1], heatShoulder);
        }
        if (row + 1 < rowCount) {
            strokedDisplay_[row + 1] = std::max(strokedDisplay_[row + 1], displayShoulder);
            strokedHeat_[row + 1] = std::max(strokedHeat_[row + 1], heatShoulder);
        }
    }

    const size_t offset = display.size();
    display.resize(offset + rowCount);
    heat.resize(offset + rowCount);
    for (size_t row = 0; row < rowCount; row += 1) {
        display[offset + row] = strokedDisplay_[row];
        heat[offset + row] = strokedHeat_[row];
    }
}

void SpectrogramAnalyzer::processFrame(std::vector<float>& display, std::vector<float>& heat) {
    std::fill(windowedInput_.begin(), windowedInput_.end(), 0.0f);
    for (size_t index = 0; index < fftSize_; index += 1) {
        windowedInput_[index] = frameBuffer_[index] * window_[index];
    }

    fft_->forward(windowedInput_.data(), fftOutput_.data());

    const size_t numBins = paddedSize_ / 2;
    const float scale = 2.0f / static_cast<float>(fftSize_);
    for (size_t bin = 0; bin < numBins; bin += 1) {
        const float re = fftOutput_[bin].real();
        const float im = fftOutput_[bin].imag();
        const float magnitude = std::sqrt((re * re) + (im * im)) * scale;
        magnitudesLinear_[bin] = magnitude;
        magnitudesDb_[bin] = 20.0f * std::log10(std::max(magnitude, 1.0e-10f));
        phases_[bin] = std::atan2(im, re);
    }

    computeStandardSpectrum();
    computeReassignedSpectrum();
    blendAndShapeColumn(display, heat);

    lastPhases_ = phases_;
    haveLastPhase_ = true;
}

SpectrogramProcessResult SpectrogramAnalyzer::process(const float* samples, size_t length) {
    SpectrogramProcessResult result;
    result.rowCount = config_.rowCount;
    if (!samples || length == 0 || fftSize_ == 0 || config_.rowCount == 0) {
        return result;
    }

    const size_t hopSize = resolveHopSize();
    const size_t overlapSamples = fftSize_ - hopSize;

    for (size_t index = 0; index < length; index += 1) {
        frameBuffer_[frameFill_] = samples[index];
        frameFill_ += 1;

        if (frameFill_ >= fftSize_) {
            processFrame(result.display, result.heat);
            result.columnCount += 1;

            if (overlapSamples > 0) {
                std::memmove(frameBuffer_.data(), frameBuffer_.data() + hopSize, overlapSamples * sizeof(float));
            }
            frameFill_ = overlapSamples;
        }
    }

    return result;
}

} // namespace Visualizer
