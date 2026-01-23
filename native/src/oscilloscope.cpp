#include "oscilloscope.h"
#include <algorithm>

namespace Visualizer {

Oscilloscope::Oscilloscope()
    : sampleRate_(44100.0f)
    , pitchLock_(true)
    , displaySamples_(4096)
    , filterFrequency_(300.0f)
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
    if (!enabled) {
        lastTrigger_ = 0;
    }
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
    result.samplesToShow = std::min(displaySamples_, static_cast<int>(length));
    result.detectedPitch = smoothedPitch_;

    if (!pitchLock_ || length == 0) {
        return result;
    }

    // Resize filtered buffer if needed
    if (filteredBuffer_.size() != length) {
        filteredBuffer_.resize(length);
    }

    // Apply lowpass filter (bidirectional for zero phase)
    lowpassFilter_.processBuffer(audioData, filteredBuffer_.data(), length, true);

    // Detect pitch using autocorrelation
    float newPitch = DSP::detectPitch(filteredBuffer_.data(), length, sampleRate_, 40.0f, 1000.0f);

    // Smooth pitch detection
    smoothedPitch_ = smoothedPitch_ * 0.9f + newPitch * 0.1f;
    result.detectedPitch = smoothedPitch_;

    // Calculate search range based on detected pitch (2 periods)
    int period = static_cast<int>(sampleRate_ / smoothedPitch_);
    int searchRange = std::min(period * 2, static_cast<int>(length) / 2);

    // Find trigger point
    lastTrigger_ = DSP::findTriggerPoint(filteredBuffer_.data(), length, lastTrigger_, searchRange);
    result.triggerIndex = lastTrigger_;

    // Adjust samples to show based on pitch (show ~6 cycles)
    int cyclesToShow = 6;
    int pitchBasedSamples = period * cyclesToShow;
    result.samplesToShow = std::min(pitchBasedSamples, static_cast<int>(length) - result.triggerIndex);
    result.samplesToShow = std::max(100, result.samplesToShow);

    return result;
}

void Oscilloscope::reset() {
    lastTrigger_ = 0;
    smoothedPitch_ = 200.0f;
    lowpassFilter_.reset();
}

} // namespace Visualizer
