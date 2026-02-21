#include "oscilloscope.h"
#include <algorithm>
#include <cmath>

namespace Visualizer {

Oscilloscope::Oscilloscope()
    : sampleRate_(48000.0f)
    , pitchLock_(true)
    , displaySamples_(2048)
    , writePos_(0)
    , lastFilterPitch_(200.0f)
    , lastTrigger_(0)
    , smoothedPitch_(200.0f)
    , pitchSamplesProcessed_(0) {

    // Initialize circular buffers
    circularBuffer_.resize(OSCILLOSCOPE_BUFFER_SIZE, 0.0f);
    filteredBuffer_.resize(OSCILLOSCOPE_BUFFER_SIZE, 0.0f);

    // Initialize FIR bandpass filter centered at 200Hz with 10% bandwidth (20Hz)
    // Tight bandwidth removes harmonics, leaving only ONE rising zero crossing per period
    bandpassFilter_.designBandpass(200.0f, 20.0f, sampleRate_, 60.0f);

    // Initialize high shelf for pitch analysis (-3dB at 400Hz, Q=0.71)
    // Reduces high frequency interference with pitch detection
    pitchAnalysisShelf_.setHighShelf(400.0f, sampleRate_, -3.0f, 0.71f);

    // Initialize analysis and render buffers
    displayBuffer_.resize(OSCILLOSCOPE_BUFFER_SIZE, 0.0f);
    visualBuffer_.resize(OSCILLOSCOPE_BUFFER_SIZE, 0.0f);

    // Initialize display filters (high shelf + cascaded lowpass for steep rolloff)
    displayShelf_.setHighShelf(400.0f, sampleRate_, -3.0f, 0.71f);
    displayLowpass1_.setLowpass(18000.0f, sampleRate_, 0.707f);
    displayLowpass2_.setLowpass(18000.0f, sampleRate_, 0.707f);

    // Initialize pitch detection lowpass (cascaded for steep slope)
    pitchLowpass1_.setLowpass(18000.0f, sampleRate_, 0.707f);
    pitchLowpass2_.setLowpass(18000.0f, sampleRate_, 0.707f);
}

void Oscilloscope::setSampleRate(float sampleRate) {
    sampleRate_ = sampleRate;
    // Redesign filter with new sample rate (10% bandwidth)
    float bandwidth = lastFilterPitch_ * 0.1f;
    bandpassFilter_.designBandpass(lastFilterPitch_, bandwidth, sampleRate_, 60.0f);
    // Update high shelf for new sample rate
    pitchAnalysisShelf_.setHighShelf(400.0f, sampleRate_, -3.0f, 0.71f);

    // Update display filters
    displayShelf_.setHighShelf(400.0f, sampleRate_, -3.0f, 0.71f);
    displayLowpass1_.setLowpass(18000.0f, sampleRate_, 0.707f);
    displayLowpass2_.setLowpass(18000.0f, sampleRate_, 0.707f);

    // Update pitch detection lowpass
    pitchLowpass1_.setLowpass(18000.0f, sampleRate_, 0.707f);
    pitchLowpass2_.setLowpass(18000.0f, sampleRate_, 0.707f);
}

void Oscilloscope::setPitchLock(bool enabled) {
    pitchLock_ = enabled;
}

void Oscilloscope::setDisplaySamples(int samples) {
    displaySamples_ = std::clamp(samples, 64, static_cast<int>(OSCILLOSCOPE_BUFFER_SIZE - 1));
}

// Push samples into circular buffer (called from AudioWorklet)
void Oscilloscope::pushSamples(const float* samples, size_t count) {
    for (size_t i = 0; i < count; i++) {
        // Store raw sample
        circularBuffer_[writePos_] = samples[i];

        // Apply FIR bandpass filter and store filtered sample
        // Linear-phase filter provides consistent zero crossings
        filteredBuffer_[writePos_] = bandpassFilter_.process(samples[i]);

        // Tracking path: cascaded lowpass only
        float displaySample = displayLowpass1_.process(samples[i]);
        displaySample = displayLowpass2_.process(displaySample);
        displayBuffer_[writePos_] = displaySample;

        // Visual path: high shelf on top of tracking sample
        float visualSample = displayShelf_.process(displaySample);
        visualBuffer_[writePos_] = visualSample;

        writePos_ = (writePos_ + 1) % OSCILLOSCOPE_BUFFER_SIZE;
    }
}

// Update filtered buffer from circular buffer (for backwards compatibility)
void Oscilloscope::updateFiltered() {
    // This is called when using snapshot mode - filter is applied in pushSamples for continuous mode
}

// Find trigger by searching BACKWARDS from target position
// With tight bandpass filter (10% bandwidth), there's only ONE rising zero crossing per period
// So we simply take the FIRST valid crossing found - no phase tracking needed
float Oscilloscope::findTriggerBackwards(size_t target, size_t range) {
    float periodSamples = sampleRate_ / smoothedPitch_;

    // Search backwards from target to find FIRST rising zero crossing
    for (size_t i = 0; i < range && i < OSCILLOSCOPE_BUFFER_SIZE; i++) {
        size_t pos = (target + OSCILLOSCOPE_BUFFER_SIZE - i) % OSCILLOSCOPE_BUFFER_SIZE;
        size_t prev = (pos + OSCILLOSCOPE_BUFFER_SIZE - 1) % OSCILLOSCOPE_BUFFER_SIZE;

        float prevVal = filteredBuffer_[prev];
        float currVal = filteredBuffer_[pos];

        // Rising zero crossing
        if (prevVal < 0.0f && currVal >= 0.0f) {
            // Check signal amplitude (look ahead ~1/4 period)
            size_t lookAhead = std::clamp(
                static_cast<size_t>(periodSamples / 4.0f),
                static_cast<size_t>(4),
                static_cast<size_t>(256)
            );

            float peakAfter = 0.0f;
            for (size_t j = 0; j < lookAhead; j++) {
                size_t checkPos = (pos + j) % OSCILLOSCOPE_BUFFER_SIZE;
                float val = std::abs(filteredBuffer_[checkPos]);
                if (val > peakAfter) peakAfter = val;
            }

            // Only accept if signal has significant amplitude
            if (peakAfter > 0.01f) {
                // Sub-sample interpolation for smooth rendering
                float t = -prevVal / (currVal - prevVal);
                return static_cast<float>(prev) + t;
            }
        }
    }

    return -1.0f;  // No crossing found
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
    // Use RAW buffer for pitch detection (filtered buffer may attenuate the fundamental)
    // Use last 2048 samples for pitch detection
    std::vector<float> recentSamples(2048);
    for (size_t i = 0; i < 2048; i++) {
        size_t idx = (writePos_ + OSCILLOSCOPE_BUFFER_SIZE - 2048 + i) % OSCILLOSCOPE_BUFFER_SIZE;
        recentSamples[i] = displayBuffer_[idx];  // Use RAW samples, not filtered
    }

    // Apply high shelf filter to reduce HF interference with pitch detection
    pitchAnalysisShelf_.reset();
    for (size_t i = 0; i < 2048; i++) {
        recentSamples[i] = pitchAnalysisShelf_.process(recentSamples[i]);
    }

    // Apply cascaded lowpass for steep HF rejection
    pitchLowpass1_.reset();
    pitchLowpass2_.reset();
    for (size_t i = 0; i < 2048; i++) {
        recentSamples[i] = pitchLowpass1_.process(recentSamples[i]);
        recentSamples[i] = pitchLowpass2_.process(recentSamples[i]);
    }

    float newPitch = DSP::detectPitchFFT(recentSamples.data(), 2048, sampleRate_, 40.0f, 1000.0f);
    if (newPitch > 0.0f) {
        pitchSamplesProcessed_++;

        // Adaptive smoothing: fast convergence initially, then conservative
        // First ~20 frames: use 0.5/0.5 for quick lock-on
        // After warmup: use 0.95/0.05 for stable tracking
        float smoothingOld = (pitchSamplesProcessed_ < 20) ? 0.5f : 0.95f;
        float smoothingNew = 1.0f - smoothingOld;
        smoothedPitch_ = smoothedPitch_ * smoothingOld + newPitch * smoothingNew;

        // Redesign FIR bandpass filter if pitch changed significantly (>10%)
        // This keeps the filter centered on the fundamental for stable trigger
        if (std::abs(smoothedPitch_ - lastFilterPitch_) / lastFilterPitch_ > 0.1f) {
            float bandwidth = smoothedPitch_ * 0.1f;  // 10% of center freq (tight = single zero crossing)
            bandpassFilter_.designBandpass(smoothedPitch_, bandwidth, sampleRate_, 60.0f);
            lastFilterPitch_ = smoothedPitch_;
        }
    }
    result.detectedPitch = smoothedPitch_;

    // Calculate target position for trigger search
    // We search backwards from (writePos - displaySamples - firDelay) to find a rising zero crossing
    float periodSamples = sampleRate_ / smoothedPitch_;
    size_t samples = static_cast<size_t>(displaySamples_);
    size_t firDelay = bandpassFilter_.getDelay();

    // Target: look back from current write position by display window size AND FIR delay
    // This ensures we're searching in the correct region where filtered data is valid
    size_t target = (writePos_ + OSCILLOSCOPE_BUFFER_SIZE - samples - firDelay) % OSCILLOSCOPE_BUFFER_SIZE;

    // Search range: 4 periods for robust detection
    size_t range = static_cast<size_t>(periodSamples * 4.0f);

    // Find zero crossing by searching backwards from target
    float zeroCross = findTriggerBackwards(target, range);

    // LEFT-ANCHORED TRIGGER (MiniMeters style):
    // The zero crossing IS the left edge of display
    // Waveform starts at rising edge and extends rightward
    if (zeroCross >= 0.0f) {
        // Apply FIR filter delay compensation
        // The filtered signal is delayed by order/2 samples relative to raw signal
        size_t firDelay = bandpassFilter_.getDelay();

        // The trigger index is where we start reading raw samples for display
        // Compensate for filter delay so trigger aligns with raw audio
        result.triggerIndex = zeroCross - static_cast<float>(firDelay);

        // Wrap if negative
        while (result.triggerIndex < 0) {
            result.triggerIndex += OSCILLOSCOPE_BUFFER_SIZE;
        }
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

// Get samples from circular buffer starting at position (integer version)
// Returns filtered samples for display (high shelf + lowpass applied)
void Oscilloscope::getSamples(float* output, size_t startPos, size_t count) const {
    for (size_t i = 0; i < count; i++) {
        size_t idx = (startPos + i) % OSCILLOSCOPE_BUFFER_SIZE;
        output[i] = visualBuffer_[idx];  // Visual-only filtered signal
    }
}

// Get samples with sub-sample interpolation (float start position)
// Uses Catmull-Rom spline for smooth rendering at sub-pixel precision
// This preserves the high-precision trigger position from zero-crossing detection
void Oscilloscope::getSamplesInterpolated(float* output, float startPos, size_t count) const {
    for (size_t i = 0; i < count; i++) {
        float pos = startPos + static_cast<float>(i);

        // Wrap position to buffer bounds
        while (pos < 0) pos += OSCILLOSCOPE_BUFFER_SIZE;
        while (pos >= OSCILLOSCOPE_BUFFER_SIZE) pos -= OSCILLOSCOPE_BUFFER_SIZE;

        size_t idx = static_cast<size_t>(pos) % OSCILLOSCOPE_BUFFER_SIZE;
        float frac = pos - std::floor(pos);

        if (frac < 0.0001f) {
            // No interpolation needed - exact sample position
            output[i] = visualBuffer_[idx];
        } else {
            // Cubic (Catmull-Rom) interpolation for smooth sub-sample rendering
            // This eliminates pixel-level ghosting/jitter from truncated trigger positions
            size_t i0 = (idx + OSCILLOSCOPE_BUFFER_SIZE - 1) % OSCILLOSCOPE_BUFFER_SIZE;
            size_t i1 = idx;
            size_t i2 = (idx + 1) % OSCILLOSCOPE_BUFFER_SIZE;
            size_t i3 = (idx + 2) % OSCILLOSCOPE_BUFFER_SIZE;

            float y0 = visualBuffer_[i0];
            float y1 = visualBuffer_[i1];
            float y2 = visualBuffer_[i2];
            float y3 = visualBuffer_[i3];

            // Catmull-Rom spline coefficients
            float t = frac;
            float t2 = t * t;
            float t3 = t2 * t;

            output[i] = 0.5f * (
                (2.0f * y1) +
                (-y0 + y2) * t +
                (2.0f * y0 - 5.0f * y1 + 4.0f * y2 - y3) * t2 +
                (-y0 + 3.0f * y1 - 3.0f * y2 + y3) * t3
            );
        }
    }
}

void Oscilloscope::reset() {
    writePos_ = 0;
    lastTrigger_ = 0.0f;
    smoothedPitch_ = 200.0f;
    lastFilterPitch_ = 200.0f;
    pitchSamplesProcessed_ = 0;  // Reset warmup counter for fast convergence on next use

    // Redesign filter to default 200Hz (reset() only clears delay line, not coefficients)
    bandpassFilter_.designBandpass(200.0f, 20.0f, sampleRate_, 60.0f);
    pitchAnalysisShelf_.reset();

    // Reset display and pitch detection filters
    displayShelf_.reset();
    displayLowpass1_.reset();
    displayLowpass2_.reset();
    pitchLowpass1_.reset();
    pitchLowpass2_.reset();

    // Clear buffers
    std::fill(circularBuffer_.begin(), circularBuffer_.end(), 0.0f);
    std::fill(filteredBuffer_.begin(), filteredBuffer_.end(), 0.0f);
    std::fill(displayBuffer_.begin(), displayBuffer_.end(), 0.0f);
    std::fill(visualBuffer_.begin(), visualBuffer_.end(), 0.0f);
}

} // namespace Visualizer
