#define _USE_MATH_DEFINES
#include "dsp_utils.h"
#include <cstring>
#include <cmath>
#include <algorithm>

namespace DSP {

// FFT Implementation
FFT::FFT(size_t size) : size_(size) {
    // Precompute twiddle factors
    twiddles_.resize(size / 2);
    for (size_t i = 0; i < size / 2; i++) {
        float angle = -2.0f * M_PI * i / size;
        twiddles_[i] = std::complex<float>(cosf(angle), sinf(angle));
    }
    buffer_.resize(size);
    scratch_.resize(size);
}

void FFT::bitReverse(std::complex<float>* data) {
    size_t n = size_;
    for (size_t i = 1, j = 0; i < n; i++) {
        size_t bit = n >> 1;
        while (j & bit) {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if (i < j) {
            std::swap(data[i], data[j]);
        }
    }
}

void FFT::forward(const float* input, std::complex<float>* output) {
    // Copy input to internal buffer
    for (size_t i = 0; i < size_; i++) {
        buffer_[i] = std::complex<float>(input[i], 0.0f);
    }

    bitReverse(buffer_.data());

    // Cooley-Tukey FFT
    for (size_t len = 2; len <= size_; len *= 2) {
        size_t halfLen = len / 2;
        size_t step = size_ / len;
        for (size_t i = 0; i < size_; i += len) {
            for (size_t j = 0; j < halfLen; j++) {
                std::complex<float> t = twiddles_[j * step] * buffer_[i + j + halfLen];
                buffer_[i + j + halfLen] = buffer_[i + j] - t;
                buffer_[i + j] = buffer_[i + j] + t;
            }
        }
    }

    memcpy(output, buffer_.data(), size_ * sizeof(std::complex<float>));
}

void FFT::forward(const float* input, float* magnitudes) {
    // Use scratch buffer for complex output to avoid allocation
    forward(input, scratch_.data());

    // Calculate magnitudes (only first half is useful)
    // Scale by 2/N for correct magnitude
    float scale = 2.0f / size_;
    for (size_t i = 0; i < size_ / 2; i++) {
        magnitudes[i] = std::abs(scratch_[i]) * scale;
    }
}

// BiquadFilter Implementation
BiquadFilter::BiquadFilter()
    : b0_(1), b1_(0), b2_(0), a1_(0), a2_(0)
    , x1_(0), x2_(0), y1_(0), y2_(0) {}

void BiquadFilter::setLowpass(float frequency, float sampleRate, float Q) {
    float omega = 2.0f * M_PI * frequency / sampleRate;
    float sinOmega = sinf(omega);
    float cosOmega = cosf(omega);
    float alpha = sinOmega / (2.0f * Q);

    float a0 = 1.0f + alpha;
    b0_ = (1.0f - cosOmega) / 2.0f / a0;
    b1_ = (1.0f - cosOmega) / a0;
    b2_ = (1.0f - cosOmega) / 2.0f / a0;
    a1_ = -2.0f * cosOmega / a0;
    a2_ = (1.0f - alpha) / a0;
}

void BiquadFilter::setBandpass(float frequency, float sampleRate, float Q) {
    float omega = 2.0f * M_PI * frequency / sampleRate;
    float sinOmega = sinf(omega);
    float cosOmega = cosf(omega);
    float alpha = sinOmega / (2.0f * Q);

    float a0 = 1.0f + alpha;
    b0_ = alpha / a0;
    b1_ = 0.0f;
    b2_ = -alpha / a0;
    a1_ = -2.0f * cosOmega / a0;
    a2_ = (1.0f - alpha) / a0;
}

float BiquadFilter::process(float input) {
    float output = b0_ * input + b1_ * x1_ + b2_ * x2_ - a1_ * y1_ - a2_ * y2_;
    x2_ = x1_;
    x1_ = input;
    y2_ = y1_;
    y1_ = output;
    
    // Denormal protection
    if (std::abs(y1_) < 1e-20f) y1_ = 0.0f;
    if (std::abs(y2_) < 1e-20f) y2_ = 0.0f;
    
    return output;
}

void BiquadFilter::reset() {
    x1_ = x2_ = y1_ = y2_ = 0.0f;
}

void BiquadFilter::processBuffer(const float* input, float* output, size_t length, bool bidirectional) {
    reset();

    // Forward pass
    for (size_t i = 0; i < length; i++) {
        output[i] = process(input[i]);
    }

    if (bidirectional) {
        // Backward pass for zero phase delay
        reset();
        for (int i = length - 1; i >= 0; i--) {
            output[i] = process(output[i]);
        }
    }
}

// Pitch detection using autocorrelation
float detectPitch(const float* data, size_t length, float sampleRate, float minFreq, float maxFreq) {
    int minPeriod = static_cast<int>(sampleRate / maxFreq);
    int maxPeriod = static_cast<int>(sampleRate / minFreq);

    maxPeriod = std::min(maxPeriod, static_cast<int>(length / 2));
    if (maxPeriod <= minPeriod) return 0.0f;

    float bestCorrelation = -1.0f;
    int bestPeriod = 0;

    // Use a simplified autocorrelation: only compute for lags in range
    for (int period = minPeriod; period < maxPeriod; period++) {
        float correlation = 0.0f;
        float energy1 = 0.0f;
        float energy2 = 0.0f;

        // Use fewer samples for performance, but enough for accuracy
        int samples = std::min(static_cast<int>(length) - period, 512); 
        
        for (int i = 0; i < samples; i++) {
            correlation += data[i] * data[i + period];
            energy1 += data[i] * data[i];
            energy2 += data[i + period] * data[i + period];
        }

        // Normalized correlation
        if (energy1 > 1e-9f && energy2 > 1e-9f) {
            float norm = sqrtf(energy1 * energy2);
            correlation /= norm;
            
            if (correlation > bestCorrelation) {
                bestCorrelation = correlation;
                bestPeriod = period;
            }
        }
    }
    
    // Threshold for valid pitch
    if (bestCorrelation < 0.5f || bestPeriod == 0) {
        return 0.0f; // No confident pitch found
    }

    // Parabolic interpolation for sub-sample accuracy could be added here
    // but basic integer period is often enough for visual stabilization

    return sampleRate / bestPeriod;
}

// Find zero-crossing trigger point (sub-sample precision)
// searches in [searchStart, searchEnd)
// Uses Hysteresis (Schmidt Trigger): Signal must dip below -threshold before re-arming.
float findTriggerPoint(const float* data, size_t length, int searchStart, int searchEnd) {
    searchStart = std::max(1, searchStart); // Need i-1
    searchEnd = std::min(static_cast<int>(length), searchEnd);
    
    if (searchStart >= searchEnd) return -1.0f;

    // Hysteresis threshold
    const float threshold = 0.05f; // Must dip 5% below zero to arm
    bool armed = false;

    // Check pre-search history to see if we are already armed
    // (If the sample before searchStart was low enough)
    if (data[searchStart - 1] < -threshold) {
        armed = true;
    }

    for (int i = searchStart; i < searchEnd; i++) {
        float val = data[i];
        
        // Arm the trigger if we swing low
        if (val < -threshold) {
            armed = true;
        }
        
        // Fire if Armed + Rising Zero Crossing
        if (armed && data[i - 1] < 0.0f && val >= 0.0f) {
            // Found crossing between i-1 and i
            float y0 = data[i - 1];
            float y1 = val;
            
            // Linear interpolation
            float t = -y0 / (y1 - y0);
            
            return static_cast<float>(i - 1) + t;
        }
    }
    
    return -1.0f; // No trigger found
}

// Calculate RMS
float calculateRMS(const float* data, size_t length) {
    if (length == 0) return 0.0f;
    float sum = 0.0f;
    for (size_t i = 0; i < length; i++) {
        sum += data[i] * data[i];
    }
    return sqrtf(sum / length);
}

} // namespace DSP
