#pragma once

#include "dsp_utils.h"
#include <vector>
#include <memory>

namespace Visualizer {

class Spectrum {
public:
    explicit Spectrum(size_t fftSize = 2048);

    // Configuration
    void setFFTSize(size_t size);
    size_t getFFTSize() const { return fftSize_; }
    void setSampleRate(float sampleRate);
    void setSmoothing(float smoothing); // 0.0 - 1.0

    // Feed new samples into the rolling history and update the latest magnitudes.
    void pushSamples(const float* input, size_t length);
    void pushStereoSamples(const float* left, const float* right, size_t length);

    // Read the latest raw clamped dB magnitudes without mutating analyzer state.
    const std::vector<float>& getRawMagnitudes() const { return rawMagnitudes_; }

    // Read the latest smoothed magnitudes without mutating analyzer state.
    const std::vector<float>& getMagnitudes() const { return smoothedMagnitudes_; }
    const std::vector<float>& getSideMagnitudes() const { return sideSmoothedMagnitudes_; }

    // Process audio and get spectrum data
    // Returns magnitude data (size = fftSize / 2)
    const std::vector<float>& process(const float* audioData, size_t length);

    // Get frequency for a given bin
    float binToFrequency(int bin) const;

    // Reset state
    void reset();

private:
    size_t fftSize_;
    float sampleRate_;
    float smoothing_;

    std::unique_ptr<DSP::FFT> fft_;
    std::vector<float> historyBuffer_;
    std::vector<float> sideHistoryBuffer_;
    std::vector<float> windowedInput_;
    std::vector<float> magnitudes_;
    std::vector<float> rawMagnitudes_;
    std::vector<float> smoothedMagnitudes_;
    std::vector<float> sideRawMagnitudes_;
    std::vector<float> sideSmoothedMagnitudes_;
    size_t bufferedSamples_;

    void applyWindow(const float* input, float* output, size_t length);
    void pushHistory(std::vector<float>& history, const float* input, size_t length);
    void pushZeroHistory(std::vector<float>& history, size_t length);
    void updateMagnitudesForHistory(
        const std::vector<float>& history,
        std::vector<float>& rawMagnitudes,
        std::vector<float>& smoothedMagnitudes
    );
    void updateSilentSideMagnitudes();
    void updateMagnitudes();
};

} // namespace Visualizer
