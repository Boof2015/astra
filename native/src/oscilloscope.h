#pragma once

#include "dsp_utils.h"
#include <vector>
#include <cstdint>

namespace Visualizer {

struct OscilloscopeResult {
    float triggerIndex;
    int samplesToShow;
    float detectedPitch;
};

// Circular buffer size (same as pulse-visualizer)
constexpr size_t OSCILLOSCOPE_BUFFER_SIZE = 32768;

class Oscilloscope {
public:
    Oscilloscope();

    // Configuration
    void setSampleRate(float sampleRate);
    void setPitchLock(bool enabled);
    void setDisplaySamples(int samples);

    // Push samples into circular buffer (continuous capture)
    void pushSamples(const float* samples, size_t count);

    // Process and find trigger point (uses circular buffer)
    OscilloscopeResult process();

    // Legacy: Process snapshot (for backwards compatibility)
    OscilloscopeResult processSnapshot(const float* audioData, size_t length);

    // Get current write position
    size_t getWritePos() const { return writePos_; }

    // Get samples from circular buffer (for rendering)
    void getSamples(float* output, size_t startPos, size_t count) const;

    // Get samples with sub-sample interpolation (preserves trigger precision)
    void getSamplesInterpolated(float* output, float startPos, size_t count) const;

    // Reset state
    void reset();

private:
    float sampleRate_;
    bool pitchLock_;
    int displaySamples_;

    // Circular buffer for continuous audio
    std::vector<float> circularBuffer_;
    std::vector<float> filteredBuffer_;
    size_t writePos_;

    // Linear-phase FIR bandpass filter for stable trigger detection
    DSP::FIRFilter bandpassFilter_;
    float lastFilterPitch_;  // Track pitch for filter redesign

    // High shelf filter to reduce HF before pitch detection
    DSP::BiquadFilter pitchAnalysisShelf_;

    // Display filtering (high shelf + steep lowpass)
    DSP::BiquadFilter displayShelf_;      // High shelf for display
    DSP::BiquadFilter displayLowpass1_;   // First stage of cascaded lowpass
    DSP::BiquadFilter displayLowpass2_;   // Second stage (4th order total = 24dB/oct)
    std::vector<float> displayBuffer_;    // Lowpass filtered samples for tracking
    std::vector<float> visualBuffer_;     // Visual-only samples (display shelf applied)

    // Pitch detection lowpass (after existing high shelf)
    DSP::BiquadFilter pitchLowpass1_;     // First stage
    DSP::BiquadFilter pitchLowpass2_;     // Second stage

    float lastTrigger_;
    float smoothedPitch_;
    int pitchSamplesProcessed_;  // Track samples for adaptive smoothing

    // Internal helpers
    void updateFiltered();
    float findTriggerBackwards(size_t target, size_t range);
};

} // namespace Visualizer
