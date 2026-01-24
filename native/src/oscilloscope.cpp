#include "oscilloscope.h"
#include <algorithm>
#include <cmath>

namespace Visualizer {

Oscilloscope::Oscilloscope()
    : sampleRate_(48000.0f)
    , pitchLock_(true)
    , displaySamples_(1024)
    , filterFrequency_(150.0f)
    , writePos_(0)
    , lastTrigger_(0)
    , smoothedPitch_(200.0f)
    , invertPhase_(false) {

    // Initialize circular buffers
    circularBuffer_.resize(OSCILLOSCOPE_BUFFER_SIZE, 0.0f);
    filteredBuffer_.resize(OSCILLOSCOPE_BUFFER_SIZE, 0.0f);

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

// Push samples into circular buffer (called from AudioWorklet)
void Oscilloscope::pushSamples(const float* samples, size_t count) {
    for (size_t i = 0; i < count; i++) {
        // Store raw sample
        circularBuffer_[writePos_] = samples[i];

        // Apply lowpass filter and store filtered sample
        filteredBuffer_[writePos_] = lowpassFilter_.process(samples[i]);

        writePos_ = (writePos_ + 1) % OSCILLOSCOPE_BUFFER_SIZE;
    }
}

// Update filtered buffer from circular buffer (for backwards compatibility)
void Oscilloscope::updateFiltered() {
    // This is called when using snapshot mode - filter is applied in pushSamples for continuous mode
}

// Find trigger by searching BACKWARDS from target position (pulse-visualizer style)
// Detects phase and sets invertPhase_ flag for consistent display
float Oscilloscope::findTriggerBackwards(size_t target, size_t range) {
    // Calculate quarter period to check peak after crossing
    float periodSamples = sampleRate_ / smoothedPitch_;
    size_t quarterPeriod = static_cast<size_t>(periodSamples / 4.0f);
    if (quarterPeriod < 4) quarterPeriod = 4;
    if (quarterPeriod > 256) quarterPeriod = 256;

    // Search backwards from target to find ANY zero crossing
    for (size_t i = 0; i < range && i < OSCILLOSCOPE_BUFFER_SIZE; i++) {
        size_t pos = (target + OSCILLOSCOPE_BUFFER_SIZE - i) % OSCILLOSCOPE_BUFFER_SIZE;
        size_t prev = (pos + OSCILLOSCOPE_BUFFER_SIZE - 1) % OSCILLOSCOPE_BUFFER_SIZE;

        float prevVal = filteredBuffer_[prev];
        float currVal = filteredBuffer_[pos];

        // Check for any zero crossing (rising or falling)
        bool risingCross = (prevVal < 0.0f && currVal >= 0.0f);
        bool fallingCross = (prevVal >= 0.0f && currVal < 0.0f);

        if (risingCross || fallingCross) {
            // Check the peak value in the next quarter period
            float maxAfter = 0.0f;
            float minAfter = 0.0f;
            for (size_t j = 0; j < quarterPeriod; j++) {
                size_t checkPos = (pos + j) % OSCILLOSCOPE_BUFFER_SIZE;
                float val = filteredBuffer_[checkPos];
                if (val > maxAfter) maxAfter = val;
                if (val < minAfter) minAfter = val;
            }

            // Determine if signal is significant enough
            float peakMagnitude = std::max(maxAfter, -minAfter);
            if (peakMagnitude > 0.01f) {
                // Set phase inversion based on which direction the signal goes
                // We want the waveform to go UP after the trigger
                if (risingCross && maxAfter >= -minAfter) {
                    // Rising cross, goes positive - normal phase
                    invertPhase_ = false;
                } else if (fallingCross && -minAfter > maxAfter) {
                    // Falling cross, goes negative - invert to show positive
                    invertPhase_ = true;
                } else if (risingCross) {
                    // Rising cross but goes more negative - invert
                    invertPhase_ = true;
                } else {
                    // Falling cross but goes more positive - normal
                    invertPhase_ = false;
                }

                // Linear interpolation for sub-sample precision
                float t;
                if (risingCross) {
                    t = -prevVal / (currVal - prevVal);
                } else {
                    t = prevVal / (prevVal - currVal);
                }
                return static_cast<float>(prev) + t;
            }
        }
    }

    return -1.0f; // No crossing found
}

// Process using circular buffer (continuous capture mode)
OscilloscopeResult Oscilloscope::process() {
    OscilloscopeResult result;
    result.triggerIndex = 0;
    result.samplesToShow = displaySamples_;
    result.detectedPitch = smoothedPitch_;

    if (!pitchLock_) {
        return result;
    }

    // Detect pitch from recent samples in circular buffer
    // Use last 2048 samples for pitch detection
    std::vector<float> recentSamples(2048);
    for (size_t i = 0; i < 2048; i++) {
        size_t idx = (writePos_ + OSCILLOSCOPE_BUFFER_SIZE - 2048 + i) % OSCILLOSCOPE_BUFFER_SIZE;
        recentSamples[i] = filteredBuffer_[idx];
    }

    float newPitch = DSP::detectPitch(recentSamples.data(), 2048, sampleRate_, 40.0f, 1000.0f);
    if (newPitch > 0.0f) {
        smoothedPitch_ = smoothedPitch_ * 0.95f + newPitch * 0.05f;
    }
    result.detectedPitch = smoothedPitch_;

    // Calculate target position (pulse-visualizer style)
    // Target = writePos - samples - some offset
    float periodSamples = sampleRate_ / smoothedPitch_;
    size_t samples = static_cast<size_t>(displaySamples_);

    // Calculate target: look back from current write position
    size_t target = (writePos_ + OSCILLOSCOPE_BUFFER_SIZE - samples) % OSCILLOSCOPE_BUFFER_SIZE;

    // Search range: 2 periods
    size_t range = static_cast<size_t>(periodSamples * 2.0f);

    // Find zero crossing by searching backwards from target
    float zeroCross = findTriggerBackwards(target, range);

    if (zeroCross >= 0.0f) {
        // Calculate the offset from writePos to zeroCross
        float offset = static_cast<float>((writePos_ + OSCILLOSCOPE_BUFFER_SIZE - static_cast<size_t>(zeroCross)) % OSCILLOSCOPE_BUFFER_SIZE);
        result.triggerIndex = zeroCross;
    } else {
        result.triggerIndex = static_cast<float>(target);
    }

    return result;
}

// Legacy snapshot processing (for backwards compatibility)
OscilloscopeResult Oscilloscope::processSnapshot(const float* audioData, size_t length) {
    OscilloscopeResult result;
    result.triggerIndex = 0;
    result.samplesToShow = std::min(displaySamples_, static_cast<int>(length));
    result.detectedPitch = smoothedPitch_;

    if (!pitchLock_ || length == 0) {
        return result;
    }

    // Push samples to circular buffer
    pushSamples(audioData, length);

    // Use the new continuous process method
    return process();
}

// Get samples from circular buffer starting at position
// Automatically inverts samples if phase inversion was detected
void Oscilloscope::getSamples(float* output, size_t startPos, size_t count) const {
    if (invertPhase_) {
        for (size_t i = 0; i < count; i++) {
            size_t idx = (startPos + i) % OSCILLOSCOPE_BUFFER_SIZE;
            output[i] = -circularBuffer_[idx];  // Invert for consistent phase
        }
    } else {
        for (size_t i = 0; i < count; i++) {
            size_t idx = (startPos + i) % OSCILLOSCOPE_BUFFER_SIZE;
            output[i] = circularBuffer_[idx];
        }
    }
}

void Oscilloscope::reset() {
    writePos_ = 0;
    lastTrigger_ = 0.0f;
    smoothedPitch_ = 200.0f;
    invertPhase_ = false;
    lowpassFilter_.reset();

    // Clear buffers
    std::fill(circularBuffer_.begin(), circularBuffer_.end(), 0.0f);
    std::fill(filteredBuffer_.begin(), filteredBuffer_.end(), 0.0f);
}

} // namespace Visualizer
