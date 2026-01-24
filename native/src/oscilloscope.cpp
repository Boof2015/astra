#include "oscilloscope.h"
#include <algorithm>
#include <cmath>

namespace Visualizer {

Oscilloscope::Oscilloscope()
    : sampleRate_(44100.0f)
    , pitchLock_(true)
    , displaySamples_(4096)
    , filterFrequency_(150.0f)
    , lastTrigger_(0)
    , smoothedPitch_(200.0f) {
    lowpassFilter_.setLowpass(filterFrequency_, sampleRate_, 0.5f);
}

void Oscilloscope::setSampleRate(float sampleRate) {
    sampleRate_ = sampleRate;
    lowpassFilter_.setLowpass(filterFrequency_, sampleRate_, 0.5f);
}

void Oscilloscope::setPitchLock(bool enabled) {
    pitchLock_ = enabled;
}

void Oscilloscope::setDisplaySamples(int samples) {
    displaySamples_ = samples;
}

void Oscilloscope::setFilterFrequency(float freq) {
    filterFrequency_ = freq;
    lowpassFilter_.setLowpass(filterFrequency_, sampleRate_, 0.5f);
}

OscilloscopeResult Oscilloscope::process(const float* audioData, size_t length) {
    OscilloscopeResult result;
    result.triggerIndex = 0;
    // Default to fixed window size (Fixed Zoom)
    result.samplesToShow = std::min(displaySamples_, static_cast<int>(length));
    result.detectedPitch = smoothedPitch_;

    if (!pitchLock_ || length == 0) {
        return result;
    }

    // Resize filtered buffer if needed
    if (filteredBuffer_.size() != length) {
        filteredBuffer_.resize(length);
    }

    // 1. Lowpass filter for stable triggering
    // Use persistent forward filtering to avoid start-up transients (ringing)
    // that cause trigger jitter. We do NOT reset the filter.
    for (size_t i = 0; i < length; i++) {
        filteredBuffer_[i] = lowpassFilter_.process(audioData[i]);
    }

    // 2. Detect pitch (needed for hysteresis/hold-off)
    // Range 40Hz - 1000Hz covers most bass/fundamental frequencies
    float newPitch = DSP::detectPitch(filteredBuffer_.data(), length, sampleRate_, 40.0f, 1000.0f);

    if (newPitch > 0.0f) {
        smoothedPitch_ = smoothedPitch_ * 0.9f + newPitch * 0.1f;
    }
    result.detectedPitch = smoothedPitch_;

    // 3. Find Trigger Point (Pulse Style)
    // We strictly want the first rising zero-crossing on the stable filtered signal.
    // This locks the phase.
    int searchEnd = std::min(static_cast<int>(length) / 2, static_cast<int>(length) - 1);
    
    float trigger = DSP::findTriggerPoint(filteredBuffer_.data(), length, 1, searchEnd);
    
    if (trigger >= 0.0f) {
        result.triggerIndex = trigger;
    } else {
        result.triggerIndex = 0.0f; 
    }

    // 4. Set Fixed Display Size
    // We do NOT change samplesToShow based on pitch anymore.
    // This ensures "Fixed Zoom" behavior (MiniMeters style).
    // The view will just "slide" to start at the trigger point.
    
    // Note: triggerIndex is float, we truncate for available calculation safely
    int available = static_cast<int>(length) - static_cast<int>(result.triggerIndex);
    result.samplesToShow = std::min(displaySamples_, available);
    
    // Safety clamp
    result.samplesToShow = std::max(100, result.samplesToShow);

    return result;
}

void Oscilloscope::reset() {
    lastTrigger_ = 0.0f;
    smoothedPitch_ = 200.0f;
    lowpassFilter_.reset();
}

} // namespace Visualizer
