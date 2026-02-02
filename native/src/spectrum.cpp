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
    windowedInput_.resize(fftSize);
    magnitudes_.resize(fftSize / 2);
    // Initialize to silence (-100.0f dB)
    smoothedMagnitudes_.resize(fftSize / 2, -100.0f);
}

void Spectrum::setFFTSize(size_t size) {
    if (size != fftSize_) {
        fftSize_ = size;
        fft_ = std::make_unique<DSP::FFT>(size);
        historyBuffer_.assign(size, 0.0f);
        windowedInput_.resize(size);
        magnitudes_.resize(size / 2);
        // Initialize to silence (-100.0f dB)
        smoothedMagnitudes_.resize(size / 2, -100.0f);
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

void Spectrum::pushSamples(const float* input, size_t length) {
    if (length == 0 || fftSize_ == 0) {
        return;
    }

    // Keep only the most recent fftSize_ samples.
    if (length >= fftSize_) {
        std::memcpy(historyBuffer_.data(), input + (length - fftSize_), fftSize_ * sizeof(float));
        bufferedSamples_ = fftSize_;
        return;
    }

    const size_t keep = fftSize_ - length;
    std::move(historyBuffer_.begin() + length, historyBuffer_.end(), historyBuffer_.begin());
    std::memcpy(historyBuffer_.data() + keep, input, length * sizeof(float));
    bufferedSamples_ = std::min(fftSize_, bufferedSamples_ + length);
}

const std::vector<float>& Spectrum::process(const float* audioData, size_t length) {
    if (audioData != nullptr && length > 0) {
        pushSamples(audioData, length);
    }

    if (historyBuffer_.empty() || magnitudes_.empty()) {
        return smoothedMagnitudes_;
    }

    // Always analyze a full FFT frame from the rolling buffer.
    applyWindow(historyBuffer_.data(), windowedInput_.data(), fftSize_);

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

        if (bufferedSamples_ < fftSize_) {
            smoothedMagnitudes_[i] = db;
            continue;
        }

        // Apply temporal smoothing only (no bin-to-bin averaging).
        smoothedMagnitudes_[i] = smoothing_ * smoothedMagnitudes_[i] + (1.0f - smoothing_) * db;

        // Safety check
        if (!std::isfinite(smoothedMagnitudes_[i])) {
            smoothedMagnitudes_[i] = -100.0f;
        }
    }

    return smoothedMagnitudes_;
}

float Spectrum::binToFrequency(int bin) const {
    return bin * sampleRate_ / fftSize_;
}

void Spectrum::reset() {
    std::fill(historyBuffer_.begin(), historyBuffer_.end(), 0.0f);
    std::fill(smoothedMagnitudes_.begin(), smoothedMagnitudes_.end(), -100.0f);
    bufferedSamples_ = 0;
}

} // namespace Visualizer
