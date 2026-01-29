#include "oscilloscope.h"
#include <algorithm>
#include <cmath>

namespace Visualizer {

Oscilloscope::Oscilloscope()
    : sampleRate_(48000.0f)
    , pitchLock_(true)
    , displaySamples_(1024)
    , writePos_(0)
    , lastFilterPitch_(200.0f)
    , lastTrigger_(0)
    , smoothedPitch_(200.0f) {

    // Initialize circular buffers
    circularBuffer_.resize(OSCILLOSCOPE_BUFFER_SIZE, 0.0f);
    filteredBuffer_.resize(OSCILLOSCOPE_BUFFER_SIZE, 0.0f);

    // Initialize FIR bandpass filter centered at 200Hz with 100Hz bandwidth
    bandpassFilter_.designBandpass(200.0f, 100.0f, sampleRate_, 60.0f);
}

void Oscilloscope::setSampleRate(float sampleRate) {
    sampleRate_ = sampleRate;
    // Redesign filter with new sample rate
    float bandwidth = lastFilterPitch_ * 0.5f;
    bandpassFilter_.designBandpass(lastFilterPitch_, bandwidth, sampleRate_, 60.0f);
}

void Oscilloscope::setPitchLock(bool enabled) {
    pitchLock_ = enabled;
}

void Oscilloscope::setDisplaySamples(int samples) {
    displaySamples_ = samples;
}

// Push samples into circular buffer (called from AudioWorklet)
void Oscilloscope::pushSamples(const float* samples, size_t count) {
    for (size_t i = 0; i < count; i++) {
        // Store raw sample
        circularBuffer_[writePos_] = samples[i];

        // Apply FIR bandpass filter and store filtered sample
        // Linear-phase filter provides consistent zero crossings
        filteredBuffer_[writePos_] = bandpassFilter_.process(samples[i]);

        writePos_ = (writePos_ + 1) % OSCILLOSCOPE_BUFFER_SIZE;
    }
}

// Update filtered buffer from circular buffer (for backwards compatibility)
void Oscilloscope::updateFiltered() {
    // This is called when using snapshot mode - filter is applied in pushSamples for continuous mode
}

// Find trigger by searching BACKWARDS from target position (pulse-visualizer style)
// Only looks for RISING zero crossings for consistent phase
float Oscilloscope::findTriggerBackwards(size_t target, size_t range) {
    // Search backwards from target to find rising zero crossing
    for (size_t i = 0; i < range && i < OSCILLOSCOPE_BUFFER_SIZE; i++) {
        size_t pos = (target + OSCILLOSCOPE_BUFFER_SIZE - i) % OSCILLOSCOPE_BUFFER_SIZE;
        size_t prev = (pos + OSCILLOSCOPE_BUFFER_SIZE - 1) % OSCILLOSCOPE_BUFFER_SIZE;

        float prevVal = filteredBuffer_[prev];
        float currVal = filteredBuffer_[pos];

        // Only look for rising zero crossings
        if (prevVal < 0.0f && currVal >= 0.0f) {
            // Check if signal is significant enough (look ahead ~1/4 period)
            float periodSamples = sampleRate_ / smoothedPitch_;
            size_t lookAhead = static_cast<size_t>(periodSamples / 4.0f);
            if (lookAhead < 4) lookAhead = 4;
            if (lookAhead > 256) lookAhead = 256;

            float peakAfter = 0.0f;
            for (size_t j = 0; j < lookAhead; j++) {
                size_t checkPos = (pos + j) % OSCILLOSCOPE_BUFFER_SIZE;
                float val = std::abs(filteredBuffer_[checkPos]);
                if (val > peakAfter) peakAfter = val;
            }

            // Only accept if signal has significant amplitude
            if (peakAfter > 0.01f) {
                // Linear interpolation for sub-sample precision
                float t = -prevVal / (currVal - prevVal);
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

        // Redesign FIR bandpass filter if pitch changed significantly (>10%)
        // This keeps the filter centered on the fundamental for stable trigger
        if (std::abs(smoothedPitch_ - lastFilterPitch_) / lastFilterPitch_ > 0.1f) {
            float bandwidth = smoothedPitch_ * 0.5f;  // 50% of center freq
            bandpassFilter_.designBandpass(smoothedPitch_, bandwidth, sampleRate_, 60.0f);
            lastFilterPitch_ = smoothedPitch_;
        }
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
        // DETERMINISTIC phase offset calculation (no smoothing!)
        // This is the pulse-visualizer approach that gives rock-solid trigger
        size_t phaseOffset = (target + OSCILLOSCOPE_BUFFER_SIZE -
                             static_cast<size_t>(zeroCross)) % OSCILLOSCOPE_BUFFER_SIZE;

        // Apply FIR filter delay compensation
        size_t firDelay = bandpassFilter_.getDelay();

        // Calculate final trigger position (recalculated fresh every frame)
        // No temporal smoothing = no lag = no flickering
        result.triggerIndex = static_cast<float>(
            (writePos_ + OSCILLOSCOPE_BUFFER_SIZE - phaseOffset - firDelay - samples) % OSCILLOSCOPE_BUFFER_SIZE
        );
    } else {
        // No crossing found - use target as fallback
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
// Returns RAW samples for display (shows all frequencies)
// Trigger uses filtered signal, display uses raw signal
void Oscilloscope::getSamples(float* output, size_t startPos, size_t count) const {
    for (size_t i = 0; i < count; i++) {
        size_t idx = (startPos + i) % OSCILLOSCOPE_BUFFER_SIZE;
        output[i] = circularBuffer_[idx];  // Raw signal for display
    }
}

void Oscilloscope::reset() {
    writePos_ = 0;
    lastTrigger_ = 0.0f;
    smoothedPitch_ = 200.0f;
    lastFilterPitch_ = 200.0f;
    bandpassFilter_.reset();

    // Clear buffers
    std::fill(circularBuffer_.begin(), circularBuffer_.end(), 0.0f);
    std::fill(filteredBuffer_.begin(), filteredBuffer_.end(), 0.0f);
}

} // namespace Visualizer
