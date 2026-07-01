#define _USE_MATH_DEFINES
#include "spectrum.h"
#include <cmath>
#include <algorithm>
#include <cstring>

namespace Visualizer {

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
    }
}

void Spectrum::setSampleRate(float sampleRate) {
    sampleRate_ = sampleRate;
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
}

const std::vector<float>& Spectrum::process(const float* audioData, size_t length) {
    pushSamples(audioData, length);
    return smoothedMagnitudes_;
}

float Spectrum::binToFrequency(int bin) const {
    return bin * sampleRate_ / fftSize_;
}

void Spectrum::reset() {
    std::fill(historyBuffer_.begin(), historyBuffer_.end(), 0.0f);
    std::fill(sideHistoryBuffer_.begin(), sideHistoryBuffer_.end(), 0.0f);
    std::fill(rawMagnitudes_.begin(), rawMagnitudes_.end(), -100.0f);
    std::fill(smoothedMagnitudes_.begin(), smoothedMagnitudes_.end(), -100.0f);
    std::fill(sideRawMagnitudes_.begin(), sideRawMagnitudes_.end(), -100.0f);
    std::fill(sideSmoothedMagnitudes_.begin(), sideSmoothedMagnitudes_.end(), -100.0f);
    bufferedSamples_ = 0;
}

} // namespace Visualizer
