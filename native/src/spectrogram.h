#pragma once

#include "dsp_utils.h"
#include <complex>
#include <memory>
#include <string>
#include <vector>

namespace Visualizer {

struct SpectrogramConfig {
    size_t fftSize = 4096;
    float sampleRate = 48000.0f;
    size_t rowCount = 1;
    float minFrequency = 20.0f;
    float maxFrequency = 20000.0f;
    float minDecibels = -90.0f;
    float maxDecibels = -12.0f;
    float scrollSpeed = 2.0f;
    float contrast = 1.0f;
    float tiltDbPerOctave = 4.0f;
    std::string clarityMode = "sharper";
    std::string scaleMode = "log";
    std::string orientation = "horizontal";
};

struct SpectrogramProcessResult {
    std::vector<float> display;
    std::vector<float> heat;
    size_t columnCount = 0;
    size_t rowCount = 0;
};

class SpectrogramAnalyzer {
public:
    SpectrogramAnalyzer();

    void configure(const SpectrogramConfig& config);
    SpectrogramProcessResult process(const float* samples, size_t length);
    void reset();

private:
    struct ClarityProfile {
        float gamma;
        float sharpness;
        float lineWidth;
    };

    SpectrogramConfig config_;
    size_t fftSize_;
    size_t paddedSize_;
    size_t frameFill_;
    bool haveLastPhase_;

    std::unique_ptr<DSP::FFT> fft_;
    std::vector<float> frameBuffer_;
    std::vector<float> window_;
    std::vector<float> windowedInput_;
    std::vector<std::complex<float>> fftOutput_;
    std::vector<float> magnitudesDb_;
    std::vector<float> magnitudesLinear_;
    std::vector<float> phases_;
    std::vector<float> lastPhases_;

    std::vector<float> rowCenterBins_;
    std::vector<float> rowBandStartBins_;
    std::vector<float> rowBandEndBins_;
    std::vector<float> rowCenterFrequencies_;
    std::vector<float> standardRaw_;
    std::vector<float> standardHeat_;
    std::vector<float> reassignedPower_;
    std::vector<float> blendedRaw_;
    std::vector<float> blendedHeat_;
    std::vector<float> shapedDisplay_;
    std::vector<float> shapedHeat_;
    std::vector<float> strokedDisplay_;
    std::vector<float> strokedHeat_;

    void configureFft(size_t fftSize);
    void rebuildFrequencyMapping();
    void processFrame(std::vector<float>& display, std::vector<float>& heat);
    void computeStandardSpectrum();
    void computeReassignedSpectrum();
    void blendAndShapeColumn(std::vector<float>& display, std::vector<float>& heat);
    size_t resolveHopSize() const;
    float sampleDbAtBin(float bin) const;
    float frequencyFromScale(float normalizedPosition) const;
    float frequencyToRow(float frequency) const;
    float applyDisplayTilt(float db, float frequency) const;
    float displayDbToIntensity(float db) const;
    static ClarityProfile clarityProfile(const std::string& mode);
};

} // namespace Visualizer
