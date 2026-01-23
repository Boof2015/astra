#include "dsp_utils.h"
#include <cstring>

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
    // Copy input to buffer
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
    std::vector<std::complex<float>> output(size_);
    forward(input, output.data());

    // Calculate magnitudes (only first half is useful)
    for (size_t i = 0; i < size_ / 2; i++) {
        magnitudes[i] = std::abs(output[i]) * 2.0f / size_;
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

    float bestCorrelation = -1.0f;
    int bestPeriod = minPeriod;

    for (int period = minPeriod; period < maxPeriod; period++) {
        float correlation = 0.0f;
        float energy1 = 0.0f;
        float energy2 = 0.0f;

        int samples = std::min(static_cast<int>(length) - period, 1024);
        for (int i = 0; i < samples; i++) {
            correlation += data[i] * data[i + period];
            energy1 += data[i] * data[i];
            energy2 += data[i + period] * data[i + period];
        }

        // Normalized correlation
        float norm = sqrtf(energy1 * energy2);
        if (norm > 1e-10f) {
            correlation /= norm;
        }

        if (correlation > bestCorrelation) {
            bestCorrelation = correlation;
            bestPeriod = period;
        }
    }

    return sampleRate / bestPeriod;
}

// Find trigger point - rising zero-crossing
int findTriggerPoint(const float* filtered, size_t length, int lastTrigger, int searchRange) {
    int searchEnd = std::min(searchRange, static_cast<int>(length) - 1);

    // Find all zero crossings
    std::vector<int> crossings;
    for (int i = 1; i < searchEnd; i++) {
        if (filtered[i - 1] < 0.0f && filtered[i] >= 0.0f) {
            crossings.push_back(i);
        }
    }

    if (crossings.empty()) {
        return lastTrigger;
    }

    // First frame - use first crossing
    if (lastTrigger == 0) {
        return crossings[0];
    }

    // Find crossing closest to last trigger
    int bestCrossing = crossings[0];
    int bestDist = std::abs(crossings[0] - lastTrigger);

    for (int crossing : crossings) {
        int dist = std::abs(crossing - lastTrigger);
        if (dist < bestDist) {
            bestDist = dist;
            bestCrossing = crossing;
        }
    }

    // Smooth the trigger position (70/30 blend)
    return static_cast<int>(lastTrigger * 0.7f + bestCrossing * 0.3f + 0.5f);
}

// Calculate RMS
float calculateRMS(const float* data, size_t length) {
    float sum = 0.0f;
    for (size_t i = 0; i < length; i++) {
        sum += data[i] * data[i];
    }
    return sqrtf(sum / length);
}

} // namespace DSP
