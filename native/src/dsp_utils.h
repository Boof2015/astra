#pragma once

#include <cmath>
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#include <vector>
#include <complex>
#include <algorithm>

namespace DSP {

// Simple FFT implementation (Cooley-Tukey radix-2)
class FFT {
public:
    explicit FFT(size_t size);
    void forward(const float* input, float* magnitudes);
    void forward(const float* input, std::complex<float>* output);
    size_t getSize() const { return size_; }

private:
    size_t size_;
    std::vector<std::complex<float>> twiddles_;
    std::vector<std::complex<float>> buffer_;
    void bitReverse(std::complex<float>* data);
};

// Biquad filter for lowpass/bandpass
class BiquadFilter {
public:
    BiquadFilter();
    void setLowpass(float frequency, float sampleRate, float Q = 0.707f);
    void setBandpass(float frequency, float sampleRate, float Q = 2.0f);
    float process(float input);
    void reset();

    // Process entire buffer (bidirectional for zero phase)
    void processBuffer(const float* input, float* output, size_t length, bool bidirectional = true);

private:
    float b0_, b1_, b2_;
    float a1_, a2_;
    float x1_, x2_;
    float y1_, y2_;
};

// Pitch detection using autocorrelation
float detectPitch(const float* data, size_t length, float sampleRate, float minFreq = 40.0f, float maxFreq = 2000.0f);

// Find zero-crossing trigger point
int findTriggerPoint(const float* filtered, size_t length, int lastTrigger, int searchRange);

// Calculate RMS
float calculateRMS(const float* data, size_t length);

} // namespace DSP
