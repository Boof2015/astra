#pragma once

#include "multiband.h"
#include <cstddef>
#include <vector>

namespace Visualizer {

constexpr size_t WAVEFORM_MONO_SUMMARY_STRIDE = 5;
constexpr size_t WAVEFORM_STEREO_SUMMARY_STRIDE = 10;

class WaveformMultibandAnalyzer {
public:
    WaveformMultibandAnalyzer();

    void configure(float sampleRate, size_t samplesPerColumn);
    const std::vector<float>& processMono(const float* samples, size_t length);
    const std::vector<float>& processStereo(const float* left, const float* right, size_t length);
    void reset();

private:
    void resetColumn();
    void accumulateLeft(float sample, const MultibandSample& bands);
    void accumulateRight(float sample, const MultibandSample& bands);
    void flushMonoColumn();
    void flushStereoColumn();
    float rms(float sum) const;

    MultibandSplitter splitter_;
    float sampleRate_;
    size_t samplesPerColumn_;
    size_t columnPos_;

    float leftMin_;
    float leftMax_;
    float rightMin_;
    float rightMax_;
    float leftLowSum_;
    float leftMidSum_;
    float leftHighSum_;
    float rightLowSum_;
    float rightMidSum_;
    float rightHighSum_;

    std::vector<float> summaries_;
};

} // namespace Visualizer
