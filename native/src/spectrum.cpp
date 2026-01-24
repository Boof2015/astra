#define _USE_MATH_DEFINES
#include "spectrum.h"
#include <cmath>
#include <algorithm>

namespace Visualizer {

Spectrum::Spectrum(size_t fftSize)
    : fftSize_(fftSize)
    , sampleRate_(44100.0f)
    , smoothing_(0.8f) {
    fft_ = std::make_unique<DSP::FFT>(fftSize);
    windowedInput_.resize(fftSize);
    magnitudes_.resize(fftSize / 2);
    // Initialize to silence (-100.0f dB)
    smoothedMagnitudes_.resize(fftSize / 2, -100.0f);
}

void Spectrum::setFFTSize(size_t size) {
    if (size != fftSize_) {
        fftSize_ = size;
        fft_ = std::make_unique<DSP::FFT>(size);
        windowedInput_.resize(size);
        magnitudes_.resize(size / 2);
        // Initialize to silence (-100.0f dB)
        smoothedMagnitudes_.resize(size / 2, -100.0f);
    }
}

void Spectrum::setSampleRate(float sampleRate) {
    sampleRate_ = sampleRate;
}

void Spectrum::setSmoothing(float smoothing) {
    smoothing_ = std::clamp(smoothing, 0.0f, 0.99f);
}

void Spectrum::applyWindow(const float* input, float* output, size_t length) {
    // Hann window
    for (size_t i = 0; i < length; i++) {
        float window = 0.5f * (1.0f - cosf(2.0f * M_PI * i / (length - 1)));
        output[i] = input[i] * window;
    }
}

const std::vector<float>& Spectrum::process(const float* audioData, size_t length) {
    // Ensure we have enough data (pad with zero if not)
    size_t samplesToUse = std::min(length, fftSize_);

    // Zero-pad entire buffer first
    std::fill(windowedInput_.begin(), windowedInput_.end(), 0.0f);

    // Apply window function to available data
    if (samplesToUse > 0) {
        applyWindow(audioData, windowedInput_.data(), samplesToUse);
    }

    // Perform FFT
    fft_->forward(windowedInput_.data(), magnitudes_.data());

    // Convert to dB and apply smoothing
    for (size_t i = 0; i < magnitudes_.size(); i++) {
        float mag = magnitudes_[i];
        
        // Convert to dB
        // Add epsilon to avoid log(0)
        float db = 20.0f * log10f(std::max(mag, 1e-10f));

        // Clamp to strictly -100dB min (silence) to avoid issues
        // Max 0dB
        // db = std::clamp(db, -100.0f, 0.0f); 
        // Actually, let's allow it to float a bit, but anchor the silence.

        // Apply smoothing directly to dB values
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
    std::fill(smoothedMagnitudes_.begin(), smoothedMagnitudes_.end(), -100.0f);
}

} // namespace Visualizer
