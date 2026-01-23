#pragma once

#include "dsp_utils.h"
#include <vector>

namespace Visualizer {

struct OscilloscopeResult {
    int triggerIndex;
    int samplesToShow;
    float detectedPitch;
};

class Oscilloscope {
public:
    Oscilloscope();

    // Configuration
    void setSampleRate(float sampleRate);
    void setPitchLock(bool enabled);
    void setDisplaySamples(int samples);
    void setFilterFrequency(float freq);

    // Process audio and find trigger point
    OscilloscopeResult process(const float* audioData, size_t length);

    // Reset state
    void reset();

private:
    float sampleRate_;
    bool pitchLock_;
    int displaySamples_;
    float filterFrequency_;

    DSP::BiquadFilter lowpassFilter_;
    std::vector<float> filteredBuffer_;

    int lastTrigger_;
    float smoothedPitch_;
};

} // namespace Visualizer
