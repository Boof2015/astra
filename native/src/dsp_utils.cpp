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

void BiquadFilter::setHighShelf(float frequency, float sampleRate, float gainDB, float Q) {
    float A = powf(10.0f, gainDB / 40.0f);  // sqrt(10^(dB/20))
    float omega = 2.0f * M_PI * frequency / sampleRate;
    float sinOmega = sinf(omega);
    float cosOmega = cosf(omega);
    float alpha = sinOmega / (2.0f * Q);

    float a0 = (A + 1.0f) - (A - 1.0f) * cosOmega + 2.0f * sqrtf(A) * alpha;
    b0_ = A * ((A + 1.0f) + (A - 1.0f) * cosOmega + 2.0f * sqrtf(A) * alpha) / a0;
    b1_ = -2.0f * A * ((A - 1.0f) + (A + 1.0f) * cosOmega) / a0;
    b2_ = A * ((A + 1.0f) + (A - 1.0f) * cosOmega - 2.0f * sqrtf(A) * alpha) / a0;
    a1_ = 2.0f * ((A - 1.0f) - (A + 1.0f) * cosOmega) / a0;
    a2_ = ((A + 1.0f) - (A - 1.0f) * cosOmega - 2.0f * sqrtf(A) * alpha) / a0;
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

// FIRFilter Implementation
FIRFilter::FIRFilter() : idx_(0), order_(0) {}

// Modified Bessel function of the first kind, order 0 (I0)
// Approximation from Abramowitz and Stegun
double FIRFilter::besselI0(double x) {
    double ax = std::abs(x);
    if (ax <= 3.75) {
        double y = (x / 3.75);
        y *= y;
        return 1.0 + y * (3.5156229 + y * (3.0899424 + y * (1.2067492 +
               y * (0.2659732 + y * (0.0360768 + y * 0.0045813)))));
    } else {
        double y = 3.75 / ax;
        return (std::exp(ax) / std::sqrt(ax)) * (0.39894228 +
               y * (0.01328592 + y * (0.00225319 + y * (-0.00157565 +
               y * (0.00916281 + y * (-0.02057706 + y * (0.02635537 +
               y * (-0.01647633 + y * 0.00392377))))))));
    }
}

std::vector<float> FIRFilter::kaiserWindow(size_t length, float beta) {
    std::vector<float> window(length);
    if (length == 0) return window;
    const double denom = besselI0(static_cast<double>(beta));
    const double M = static_cast<double>(length - 1);
    for (size_t n = 0; n < length; ++n) {
        double ratio = (M == 0.0) ? 0.0 : (2.0 * static_cast<double>(n) / M - 1.0);
        double val = besselI0(static_cast<double>(beta) *
                    std::sqrt(std::max(0.0, 1.0 - ratio * ratio))) / denom;
        window[n] = static_cast<float>(val);
    }
    return window;
}

void FIRFilter::designBandpass(float centerFreq, float bandwidth, float sampleRate, float sidelobeAtten) {
    // Kaiser beta from sidelobe attenuation
    float beta = sidelobeAtten < 21.0f ? 0.0f
               : sidelobeAtten < 50.0f ? 0.5842f * powf(sidelobeAtten - 21.0f, 0.4f) +
                                         0.07886f * (sidelobeAtten - 21.0f)
               : 0.1102f * (sidelobeAtten - 8.7f);

    // Normalized frequencies
    float wc1 = 2.0f * static_cast<float>(M_PI) * (centerFreq - bandwidth / 2.0f) / sampleRate;
    float wc2 = 2.0f * static_cast<float>(M_PI) * (centerFreq + bandwidth / 2.0f) / sampleRate;
    wc1 = std::max(wc1, 0.001f);
    wc2 = std::min(wc2, static_cast<float>(M_PI) - 0.001f);

    // Calculate filter order
    float deltaF = (wc2 - wc1) / static_cast<float>(M_PI);
    int order = static_cast<int>((sidelobeAtten - 8) / (2.285 * deltaF * M_PI));
    order = std::clamp(order, 1, 512);
    order_ = static_cast<size_t>(order);

    size_t len = order + 1;
    size_t centerTap = len / 2;

    // Ideal bandpass impulse response
    std::vector<float> ideal(len);
    for (size_t i = 0; i < len; ++i) {
        if (i == centerTap) {
            ideal[i] = (wc2 - wc1) / static_cast<float>(M_PI);
        } else {
            float n = static_cast<float>(static_cast<int>(i) - static_cast<int>(centerTap));
            ideal[i] = (sinf(wc2 * n) - sinf(wc1 * n)) / (static_cast<float>(M_PI) * n);
        }
    }

    // Apply Kaiser window
    std::vector<float> window = kaiserWindow(len, beta);
    coeffs_.resize(len);
    for (size_t i = 0; i < len; ++i) {
        coeffs_[i] = ideal[i] * window[i];
    }

    // Normalize to unity gain at center frequency
    float centerOmega = 2.0f * static_cast<float>(M_PI) * centerFreq / sampleRate;
    float response = 0.0f;
    for (size_t i = 0; i < len; ++i) {
        response += coeffs_[i] * cosf(centerOmega *
                   (static_cast<float>(i) - static_cast<float>(centerTap)));
    }
    if (std::abs(response) > 1e-6f) {
        float scale = 1.0f / response;
        for (float& coeff : coeffs_) {
            coeff *= scale;
        }
    }

    // Reset delay line
    delay_.resize(len, 0.0f);
    idx_ = 0;
}

float FIRFilter::process(float input) {
    if (coeffs_.empty()) return input;

    size_t nTaps = coeffs_.size();
    idx_ %= nTaps;
    delay_[idx_] = input;

    float out = 0.0f;
    size_t firstLen = nTaps - idx_;

    // Process first segment [idx_ .. end]
    for (size_t i = 0; i < firstLen; ++i) {
        out += coeffs_[i] * delay_[idx_ + i];
    }
    // Process second segment [0 .. idx_-1]
    for (size_t i = 0; i < idx_; ++i) {
        out += coeffs_[firstLen + i] * delay_[i];
    }

    idx_ = (idx_ + 1) % nTaps;
    return out;
}

void FIRFilter::reset() {
    std::fill(delay_.begin(), delay_.end(), 0.0f);
    idx_ = 0;
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

// FFT-based pitch detection (more stable than autocorrelation)
float detectPitchFFT(const float* data, size_t length, float sampleRate, float minFreq, float maxFreq) {
    // Use power-of-2 FFT size
    size_t fftSize = 2048;
    if (length < fftSize) {
        fftSize = 1024;
        if (length < fftSize) {
            fftSize = 512;
        }
    }

    FFT fft(fftSize);
    std::vector<float> magnitudes(fftSize / 2);

    // Apply Hann window and run FFT
    std::vector<float> windowed(fftSize, 0.0f);
    size_t copyLen = std::min(length, fftSize);
    for (size_t i = 0; i < copyLen; i++) {
        float win = 0.5f * (1.0f - cosf(2.0f * static_cast<float>(M_PI) * i / fftSize));
        windowed[i] = data[i] * win;
    }
    fft.forward(windowed.data(), magnitudes.data());

    // Find peak in frequency range
    int minBin = std::max(1, static_cast<int>(minFreq * fftSize / sampleRate));
    int maxBin = std::min(static_cast<int>(fftSize / 2 - 1), static_cast<int>(maxFreq * fftSize / sampleRate));

    if (minBin >= maxBin) {
        return 0.0f;
    }

    float peakMag = 0.0f;
    int peakBin = minBin;
    for (int i = minBin; i <= maxBin; i++) {
        if (magnitudes[i] > peakMag) {
            peakMag = magnitudes[i];
            peakBin = i;
        }
    }

    // Check if peak is significant (avoid noise)
    if (peakMag < 1e-6f) {
        return 0.0f;
    }

    // Quadratic interpolation for sub-bin accuracy
    if (peakBin > 0 && peakBin < static_cast<int>(fftSize / 2) - 1) {
        float y1 = magnitudes[peakBin - 1];
        float y2 = magnitudes[peakBin];
        float y3 = magnitudes[peakBin + 1];
        float denom = y1 - 2.0f * y2 + y3;
        if (std::abs(denom) > 1e-9f) {
            float offset = 0.5f * (y1 - y3) / denom;
            offset = std::clamp(offset, -0.5f, 0.5f);
            return (static_cast<float>(peakBin) + offset) * sampleRate / static_cast<float>(fftSize);
        }
    }

    return static_cast<float>(peakBin) * sampleRate / static_cast<float>(fftSize);
}

// Find zero-crossing trigger point (sub-sample precision)
// searches in [searchStart, searchEnd)
// Finds the STRONGEST (steepest slope) rising zero crossing for consistency
float findTriggerPoint(const float* data, size_t length, int searchStart, int searchEnd) {
    searchStart = std::max(1, searchStart); // Need i-1
    searchEnd = std::min(static_cast<int>(length), searchEnd);

    if (searchStart >= searchEnd) return -1.0f;

    // Find the zero crossing with the steepest positive slope
    float bestSlope = 0.0f;
    int bestIdx = -1;

    for (int i = searchStart; i < searchEnd; i++) {
        float prev = data[i - 1];
        float curr = data[i];

        // Rising zero crossing: prev < 0 and curr >= 0
        if (prev < 0.0f && curr >= 0.0f) {
            float slope = curr - prev; // Always positive for rising crossing
            if (slope > bestSlope) {
                bestSlope = slope;
                bestIdx = i;
            }
        }
    }

    if (bestIdx < 0) return -1.0f;

    // Linear interpolation for sub-sample precision
    float prev = data[bestIdx - 1];
    float curr = data[bestIdx];
    float t = -prev / (curr - prev);
    return static_cast<float>(bestIdx - 1) + t;
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
