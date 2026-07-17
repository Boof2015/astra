#pragma once

#include "dsp_utils.h"
#include <vector>
#include <memory>
#include <cstddef>
#include <cstdint>

namespace Visualizer {

struct SpectrumBarConfig {
    size_t requestedBarCount = 64;
    float minFrequency = 20.0f;
    float maxFrequency = 20000.0f;
    float minDecibels = -90.0f;
    float maxDecibels = -10.0f;
    float tiltDbPerOctave = 2.0f;
    float heatmapTiltDbPerOctave = 2.0f;
    float tiltReferenceHz = 1000.0f;
    float heatmapSmoothing = 0.5f;
    bool showPeaks = false;
};

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

    // Configure and read compact render-ready bar data. Each bar contributes
    // [display level 0..1, heat intensity 0..1, held peak 0..1].
    void configureBars(const SpectrumBarConfig& config);
    const std::vector<float>& getBarFrame();
    const std::vector<float>& getBarFrameAtTime(double nowMs);

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

    SpectrumBarConfig barConfig_;
    size_t barCount_ = 0;
    bool barMappingDirty_ = true;
    bool barStateInitialized_ = false;
    std::vector<float> barFrequencyEdges_;
    std::vector<float> barHeatDb_;
    std::vector<float> barPeakDb_;
    std::vector<double> barPeakHoldUntilMs_;
    std::vector<float> barFrame_;
    double lastBarPeakUpdateMs_ = 0.0;
    bool hasLastBarPeakUpdate_ = false;
    uint64_t magnitudeRevision_ = 0;
    uint64_t barHeatRevision_ = 0;

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
    void rebuildBarMapping();
    void resetBarState();
    float getInterpolatedMagnitude(const std::vector<float>& data, float bin) const;
    float getPeakMagnitudeInRange(const std::vector<float>& data, float startBin, float endBin) const;
    float applyTilt(float db, float frequency, float tiltDbPerOctave) const;
    float normalizeBarDb(float db) const;
    float normalizeHeatDb(float db) const;
    static double currentTimeMs();
};

} // namespace Visualizer
