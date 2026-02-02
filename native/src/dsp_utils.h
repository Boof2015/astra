#pragma once
#define _USE_MATH_DEFINES
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
    std::vector<std::complex<float>> buffer_; // Reuse buffer to avoid allocations
    std::vector<std::complex<float>> scratch_; // Scratch buffer if needed
    void bitReverse(std::complex<float>* data);
};

// Biquad filter for lowpass/bandpass
class BiquadFilter {
public:
    BiquadFilter();
    void setLowpass(float frequency, float sampleRate, float Q = 0.707f);
    void setBandpass(float frequency, float sampleRate, float Q = 2.0f);
    void setHighShelf(float frequency, float sampleRate, float gainDB, float Q = 0.707f);
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

// Linear-phase FIR filter for stable trigger detection
// Uses Kaiser-windowed bandpass design for consistent zero crossings
class FIRFilter {
public:
    FIRFilter();

    // Design Kaiser-windowed bandpass filter centered on frequency
    void designBandpass(float centerFreq, float bandwidth, float sampleRate, float sidelobeAtten = 60.0f);

    // Process single sample
    float process(float input);

    // Get filter delay (for phase compensation)
    size_t getDelay() const { return order_ / 2; }

    // Reset filter state
    void reset();

private:
    std::vector<float> coeffs_;
    std::vector<float> delay_;
    size_t idx_;
    size_t order_;

    // Kaiser window helpers
    static std::vector<float> kaiserWindow(size_t length, float beta);
    static double besselI0(double x);
};

// Pitch detection using autocorrelation
float detectPitch(const float* data, size_t length, float sampleRate, float minFreq = 40.0f, float maxFreq = 2000.0f);

// FFT-based pitch detection (more stable than autocorrelation)
float detectPitchFFT(const float* data, size_t length, float sampleRate, float minFreq = 40.0f, float maxFreq = 2000.0f);

// Find zero-crossing trigger point with hysteresis/hold-off (sub-sample precision)
float findTriggerPoint(const float* data, size_t length, int searchStart, int searchEnd);

// Calculate RMS
float calculateRMS(const float* data, size_t length);

} // namespace DSP
