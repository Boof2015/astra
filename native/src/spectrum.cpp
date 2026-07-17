#define _USE_MATH_DEFINES
#include "spectrum.h"
#include <cmath>
#include <algorithm>
#include <chrono>
#include <cstring>

namespace Visualizer {

namespace {
constexpr float BAR_HEAT_MIN_DB = -100.0f;
constexpr float BAR_HEAT_MAX_DB = -20.0f;
constexpr float BAR_HEAT_GAMMA = 1.4f;
constexpr double BAR_PEAK_HOLD_MS = 750.0;
constexpr float BAR_PEAK_DECAY_DB_PER_SECOND = 18.0f;
constexpr size_t MAX_BAR_COUNT = 512;
}

Spectrum::Spectrum(size_t fftSize)
    : fftSize_(fftSize)
    , sampleRate_(44100.0f)
    , smoothing_(0.9f)
    , bufferedSamples_(0) {
    fft_ = std::make_unique<DSP::FFT>(fftSize);
    historyBuffer_.resize(fftSize, 0.0f);
    sideHistoryBuffer_.resize(fftSize, 0.0f);
    windowedInput_.resize(fftSize);
    magnitudes_.resize(fftSize / 2);
    rawMagnitudes_.resize(fftSize / 2, -100.0f);
    // Initialize to silence (-100.0f dB)
    smoothedMagnitudes_.resize(fftSize / 2, -100.0f);
    sideRawMagnitudes_.resize(fftSize / 2, -100.0f);
    sideSmoothedMagnitudes_.resize(fftSize / 2, -100.0f);
}

void Spectrum::setFFTSize(size_t size) {
    if (size != fftSize_) {
        fftSize_ = size;
        fft_ = std::make_unique<DSP::FFT>(size);
        historyBuffer_.assign(size, 0.0f);
        sideHistoryBuffer_.assign(size, 0.0f);
        windowedInput_.resize(size);
        magnitudes_.resize(size / 2);
        rawMagnitudes_.assign(size / 2, -100.0f);
        // Initialize to silence (-100.0f dB)
        smoothedMagnitudes_.assign(size / 2, -100.0f);
        sideRawMagnitudes_.assign(size / 2, -100.0f);
        sideSmoothedMagnitudes_.assign(size / 2, -100.0f);
        bufferedSamples_ = 0;
        barMappingDirty_ = true;
        resetBarState();
    }
}

void Spectrum::setSampleRate(float sampleRate) {
    const float nextSampleRate = std::isfinite(sampleRate) ? std::max(1.0f, sampleRate) : 44100.0f;
    if (sampleRate_ != nextSampleRate) {
        sampleRate_ = nextSampleRate;
        barMappingDirty_ = true;
        resetBarState();
    }
}

void Spectrum::setSmoothing(float smoothing) {
    smoothing_ = std::clamp(smoothing, 0.0f, 0.99f);
}

void Spectrum::applyWindow(const float* input, float* output, size_t length) {
    if (length <= 1) {
        if (length == 1) {
            output[0] = input[0];
        }
        return;
    }

    // Hann window
    for (size_t i = 0; i < length; i++) {
        float window = 0.5f * (1.0f - cosf(2.0f * M_PI * i / (length - 1)));
        output[i] = input[i] * window;
    }
}

void Spectrum::pushHistory(std::vector<float>& history, const float* input, size_t length) {
    if (length == 0 || fftSize_ == 0) {
        return;
    }

    // Keep only the most recent fftSize_ samples.
    if (length >= fftSize_) {
        std::memcpy(history.data(), input + (length - fftSize_), fftSize_ * sizeof(float));
        return;
    }

    const size_t keep = fftSize_ - length;
    std::move(history.begin() + length, history.end(), history.begin());
    std::memcpy(history.data() + keep, input, length * sizeof(float));
}

void Spectrum::pushZeroHistory(std::vector<float>& history, size_t length) {
    if (length == 0 || fftSize_ == 0) {
        return;
    }

    if (length >= fftSize_) {
        std::fill(history.begin(), history.end(), 0.0f);
        return;
    }

    const size_t keep = fftSize_ - length;
    std::move(history.begin() + length, history.end(), history.begin());
    std::fill(history.begin() + keep, history.end(), 0.0f);
}

void Spectrum::updateMagnitudesForHistory(
    const std::vector<float>& history,
    std::vector<float>& rawMagnitudes,
    std::vector<float>& smoothedMagnitudes
) {
    if (history.empty() || magnitudes_.empty()) {
        return;
    }

    // Always analyze a full FFT frame from the rolling buffer.
    applyWindow(history.data(), windowedInput_.data(), fftSize_);

    // Perform FFT
    fft_->forward(windowedInput_.data(), magnitudes_.data());

    // Convert to dB and apply smoothing
    for (size_t i = 0; i < magnitudes_.size(); i++) {
        float mag = magnitudes_[i];

        // Convert to dB
        // Add epsilon to avoid log(0)
        float db = 20.0f * log10f(std::max(mag, 1e-10f));

        // Compensate Hann window coherent gain (about -6 dB).
        db += 6.0f;

        // Clamp to a stable display range.
        db = std::clamp(db, -120.0f, 12.0f);
        rawMagnitudes[i] = db;

        if (bufferedSamples_ < fftSize_) {
            smoothedMagnitudes[i] = db;
            continue;
        }

        // Apply temporal smoothing only (no bin-to-bin averaging).
        smoothedMagnitudes[i] = smoothing_ * smoothedMagnitudes[i] + (1.0f - smoothing_) * db;

        // Safety check
        if (!std::isfinite(smoothedMagnitudes[i])) {
            smoothedMagnitudes[i] = -100.0f;
        }
    }
}

void Spectrum::updateMagnitudes() {
    updateMagnitudesForHistory(historyBuffer_, rawMagnitudes_, smoothedMagnitudes_);
    updateMagnitudesForHistory(sideHistoryBuffer_, sideRawMagnitudes_, sideSmoothedMagnitudes_);
}

void Spectrum::updateSilentSideMagnitudes() {
    const float silentDb = -120.0f;
    for (size_t i = 0; i < sideSmoothedMagnitudes_.size(); i++) {
        sideRawMagnitudes_[i] = silentDb;
        if (bufferedSamples_ < fftSize_) {
            sideSmoothedMagnitudes_[i] = silentDb;
            continue;
        }

        sideSmoothedMagnitudes_[i] = smoothing_ * sideSmoothedMagnitudes_[i] + (1.0f - smoothing_) * silentDb;
        if (!std::isfinite(sideSmoothedMagnitudes_[i])) {
            sideSmoothedMagnitudes_[i] = -100.0f;
        }
    }
}

void Spectrum::pushSamples(const float* input, size_t length) {
    if (input != nullptr && length > 0) {
        pushHistory(historyBuffer_, input, length);
        pushZeroHistory(sideHistoryBuffer_, length);
        bufferedSamples_ = length >= fftSize_ ? fftSize_ : std::min(fftSize_, bufferedSamples_ + length);
        updateMagnitudesForHistory(historyBuffer_, rawMagnitudes_, smoothedMagnitudes_);
        updateSilentSideMagnitudes();
        magnitudeRevision_++;
        return;
    }
    updateMagnitudes();
}

void Spectrum::pushStereoSamples(const float* left, const float* right, size_t length) {
    if (left != nullptr && right != nullptr && length > 0 && fftSize_ > 0) {
        if (length >= fftSize_) {
            const size_t start = length - fftSize_;
            for (size_t i = 0; i < fftSize_; i++) {
                const float leftValue = left[start + i];
                const float rightValue = right[start + i];
                historyBuffer_[i] = (leftValue + rightValue) * 0.5f;
                sideHistoryBuffer_[i] = (leftValue - rightValue) * 0.5f;
            }
            bufferedSamples_ = fftSize_;
        } else {
            const size_t keep = fftSize_ - length;
            std::move(historyBuffer_.begin() + length, historyBuffer_.end(), historyBuffer_.begin());
            std::move(sideHistoryBuffer_.begin() + length, sideHistoryBuffer_.end(), sideHistoryBuffer_.begin());
            for (size_t i = 0; i < length; i++) {
                const float leftValue = left[i];
                const float rightValue = right[i];
                historyBuffer_[keep + i] = (leftValue + rightValue) * 0.5f;
                sideHistoryBuffer_[keep + i] = (leftValue - rightValue) * 0.5f;
            }
            bufferedSamples_ = std::min(fftSize_, bufferedSamples_ + length);
        }
    }
    updateMagnitudes();
    if (left != nullptr && right != nullptr && length > 0) {
        magnitudeRevision_++;
    }
}

const std::vector<float>& Spectrum::process(const float* audioData, size_t length) {
    pushSamples(audioData, length);
    return smoothedMagnitudes_;
}

float Spectrum::binToFrequency(int bin) const {
    return bin * sampleRate_ / fftSize_;
}

void Spectrum::configureBars(const SpectrumBarConfig& config) {
    SpectrumBarConfig next = config;
    next.requestedBarCount = std::clamp(next.requestedBarCount, static_cast<size_t>(1), MAX_BAR_COUNT);
    if (!std::isfinite(next.minFrequency)) next.minFrequency = 20.0f;
    next.minFrequency = std::max(1.0f, next.minFrequency);
    const float nyquist = std::max(next.minFrequency + 1.0f, sampleRate_ * 0.5f);
    if (!std::isfinite(next.maxFrequency)) next.maxFrequency = nyquist;
    next.maxFrequency = std::clamp(next.maxFrequency, next.minFrequency + 1.0f, nyquist);
    if (!std::isfinite(next.minDecibels)) next.minDecibels = -90.0f;
    if (!std::isfinite(next.maxDecibels)) next.maxDecibels = -10.0f;
    if (next.maxDecibels <= next.minDecibels) next.maxDecibels = next.minDecibels + 1.0f;
    if (!std::isfinite(next.tiltDbPerOctave)) next.tiltDbPerOctave = 0.0f;
    if (!std::isfinite(next.heatmapTiltDbPerOctave)) next.heatmapTiltDbPerOctave = 0.0f;
    if (!std::isfinite(next.tiltReferenceHz)) next.tiltReferenceHz = 1000.0f;
    next.tiltReferenceHz = std::max(1.0f, next.tiltReferenceHz);
    if (!std::isfinite(next.heatmapSmoothing)) next.heatmapSmoothing = 0.5f;
    next.heatmapSmoothing = std::clamp(next.heatmapSmoothing, 0.0f, 0.99f);

    const bool changed =
        next.requestedBarCount != barConfig_.requestedBarCount
        || next.minFrequency != barConfig_.minFrequency
        || next.maxFrequency != barConfig_.maxFrequency
        || next.minDecibels != barConfig_.minDecibels
        || next.maxDecibels != barConfig_.maxDecibels
        || next.tiltDbPerOctave != barConfig_.tiltDbPerOctave
        || next.heatmapTiltDbPerOctave != barConfig_.heatmapTiltDbPerOctave
        || next.tiltReferenceHz != barConfig_.tiltReferenceHz
        || next.heatmapSmoothing != barConfig_.heatmapSmoothing
        || next.showPeaks != barConfig_.showPeaks;

    barConfig_ = next;
    if (changed) {
        barMappingDirty_ = true;
        resetBarState();
    }
}

void Spectrum::rebuildBarMapping() {
    const float binWidth = fftSize_ > 0 ? sampleRate_ / static_cast<float>(fftSize_) : 0.0f;
    if (binWidth <= 0.0f || magnitudes_.empty()) {
        barCount_ = 0;
        barFrequencyEdges_.clear();
        barFrame_.clear();
        barMappingDirty_ = false;
        return;
    }

    const size_t firstVisibleBin = std::min(
        magnitudes_.size() - 1,
        static_cast<size_t>(std::ceil(barConfig_.minFrequency / binWidth))
    );
    const size_t lastVisibleBin = std::min(
        magnitudes_.size() - 1,
        static_cast<size_t>(std::floor(barConfig_.maxFrequency / binWidth))
    );
    const size_t visibleBinCount = lastVisibleBin >= firstVisibleBin
        ? (lastVisibleBin - firstVisibleBin + 1)
        : 1;
    barCount_ = std::max<size_t>(1, std::min(barConfig_.requestedBarCount, visibleBinCount));

    barFrequencyEdges_.resize(barCount_ + 1);
    const double logMin = std::log(static_cast<double>(barConfig_.minFrequency));
    const double logMax = std::log(static_cast<double>(barConfig_.maxFrequency));
    for (size_t index = 0; index <= barCount_; index++) {
        const double amount = static_cast<double>(index) / static_cast<double>(barCount_);
        barFrequencyEdges_[index] = static_cast<float>(std::exp(logMin + amount * (logMax - logMin)));
    }

    barHeatDb_.assign(barCount_, BAR_HEAT_MIN_DB);
    barPeakDb_.assign(barCount_, barConfig_.minDecibels);
    barPeakHoldUntilMs_.assign(barCount_, 0.0);
    barFrame_.assign(barCount_ * 3, 0.0f);
    barStateInitialized_ = false;
    barHeatRevision_ = 0;
    hasLastBarPeakUpdate_ = false;
    lastBarPeakUpdateMs_ = 0.0;
    barMappingDirty_ = false;
}

void Spectrum::resetBarState() {
    barStateInitialized_ = false;
    hasLastBarPeakUpdate_ = false;
    lastBarPeakUpdateMs_ = 0.0;
    std::fill(barHeatDb_.begin(), barHeatDb_.end(), BAR_HEAT_MIN_DB);
    std::fill(barPeakDb_.begin(), barPeakDb_.end(), barConfig_.minDecibels);
    std::fill(barPeakHoldUntilMs_.begin(), barPeakHoldUntilMs_.end(), 0.0);
    std::fill(barFrame_.begin(), barFrame_.end(), 0.0f);
}

float Spectrum::getInterpolatedMagnitude(const std::vector<float>& data, float bin) const {
    if (data.empty()) return -120.0f;
    const float clamped = std::clamp(bin, 0.0f, static_cast<float>(data.size() - 1));
    const size_t lower = static_cast<size_t>(std::floor(clamped));
    const size_t upper = std::min(lower + 1, data.size() - 1);
    const float amount = clamped - static_cast<float>(lower);
    return data[lower] + (data[upper] - data[lower]) * amount;
}

float Spectrum::getPeakMagnitudeInRange(const std::vector<float>& data, float startBin, float endBin) const {
    if (data.empty()) return -120.0f;
    const float lo = std::clamp(std::min(startBin, endBin), 0.0f, static_cast<float>(data.size() - 1));
    const float hi = std::clamp(std::max(startBin, endBin), 0.0f, static_cast<float>(data.size() - 1));
    if (hi - lo < 1.0f) {
        return getInterpolatedMagnitude(data, (lo + hi) * 0.5f);
    }

    float peak = std::max(getInterpolatedMagnitude(data, lo), getInterpolatedMagnitude(data, hi));
    const size_t first = static_cast<size_t>(std::ceil(lo));
    const size_t last = static_cast<size_t>(std::floor(hi));
    for (size_t bin = first; bin <= last && bin < data.size(); bin++) {
        peak = std::max(peak, data[bin]);
    }
    return peak;
}

float Spectrum::applyTilt(float db, float frequency, float tiltDbPerOctave) const {
    const float safeFrequency = std::max(1.0f, frequency);
    const float octaves = std::log2(safeFrequency / std::max(1.0f, barConfig_.tiltReferenceHz));
    return db + tiltDbPerOctave * octaves;
}

float Spectrum::normalizeBarDb(float db) const {
    const float range = std::max(1.0f, barConfig_.maxDecibels - barConfig_.minDecibels);
    return std::clamp((db - barConfig_.minDecibels) / range, 0.0f, 1.0f);
}

float Spectrum::normalizeHeatDb(float db) const {
    const float normalized = std::clamp((db - BAR_HEAT_MIN_DB) / (BAR_HEAT_MAX_DB - BAR_HEAT_MIN_DB), 0.0f, 1.0f);
    return std::pow(normalized, BAR_HEAT_GAMMA);
}

const std::vector<float>& Spectrum::getBarFrame() {
    return getBarFrameAtTime(currentTimeMs());
}

const std::vector<float>& Spectrum::getBarFrameAtTime(double nowMs) {
    if (barMappingDirty_) rebuildBarMapping();
    if (barCount_ == 0 || barFrequencyEdges_.size() != barCount_ + 1) return barFrame_;

    const float binWidth = sampleRate_ / static_cast<float>(fftSize_);
    const bool firstFrame = !barStateInitialized_;
    const bool hasNewMagnitudes = firstFrame || barHeatRevision_ != magnitudeRevision_;
    const double safeNowMs = std::isfinite(nowMs) ? nowMs : currentTimeMs();

    for (size_t index = 0; index < barCount_; index++) {
        const float lowFrequency = barFrequencyEdges_[index];
        const float highFrequency = barFrequencyEdges_[index + 1];
        const float centerFrequency = std::sqrt(lowFrequency * highFrequency);
        const float startBin = lowFrequency / binWidth;
        const float endBin = highFrequency / binWidth;

        const float displayRawDb = getPeakMagnitudeInRange(smoothedMagnitudes_, startBin, endBin);
        const float displayDb = applyTilt(displayRawDb, centerFrequency, barConfig_.tiltDbPerOctave);
        const float heatTargetDb = applyTilt(
            getPeakMagnitudeInRange(rawMagnitudes_, startBin, endBin),
            centerFrequency,
            barConfig_.heatmapTiltDbPerOctave
        );
        if (firstFrame) {
            barHeatDb_[index] = heatTargetDb;
        } else if (hasNewMagnitudes) {
            barHeatDb_[index] = barConfig_.heatmapSmoothing * barHeatDb_[index]
                + (1.0f - barConfig_.heatmapSmoothing) * heatTargetDb;
        }

        if (firstFrame || displayDb >= barPeakDb_[index]) {
            barPeakDb_[index] = displayDb;
            barPeakHoldUntilMs_[index] = safeNowMs + BAR_PEAK_HOLD_MS;
        } else if (barConfig_.showPeaks && safeNowMs > barPeakHoldUntilMs_[index] && hasLastBarPeakUpdate_) {
            const double decayStart = std::max(lastBarPeakUpdateMs_, barPeakHoldUntilMs_[index]);
            if (safeNowMs > decayStart) {
                const float decay = static_cast<float>((safeNowMs - decayStart) / 1000.0)
                    * BAR_PEAK_DECAY_DB_PER_SECOND;
                barPeakDb_[index] = std::max(displayDb, barPeakDb_[index] - decay);
            }
        }

        barFrame_[index * 3] = normalizeBarDb(displayDb);
        barFrame_[index * 3 + 1] = normalizeHeatDb(barHeatDb_[index]);
        barFrame_[index * 3 + 2] = barConfig_.showPeaks
            ? normalizeBarDb(barPeakDb_[index])
            : barFrame_[index * 3];
    }

    barStateInitialized_ = true;
    barHeatRevision_ = magnitudeRevision_;
    hasLastBarPeakUpdate_ = true;
    lastBarPeakUpdateMs_ = safeNowMs;
    return barFrame_;
}

double Spectrum::currentTimeMs() {
    using Clock = std::chrono::steady_clock;
    const auto now = Clock::now().time_since_epoch();
    return std::chrono::duration<double, std::milli>(now).count();
}

void Spectrum::reset() {
    std::fill(historyBuffer_.begin(), historyBuffer_.end(), 0.0f);
    std::fill(sideHistoryBuffer_.begin(), sideHistoryBuffer_.end(), 0.0f);
    std::fill(rawMagnitudes_.begin(), rawMagnitudes_.end(), -100.0f);
    std::fill(smoothedMagnitudes_.begin(), smoothedMagnitudes_.end(), -100.0f);
    std::fill(sideRawMagnitudes_.begin(), sideRawMagnitudes_.end(), -100.0f);
    std::fill(sideSmoothedMagnitudes_.begin(), sideSmoothedMagnitudes_.end(), -100.0f);
    bufferedSamples_ = 0;
    magnitudeRevision_ = 0;
    barHeatRevision_ = 0;
    resetBarState();
}

} // namespace Visualizer
