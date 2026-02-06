#include "vectorscope.h"
#include <algorithm>
#include <cmath>

namespace Visualizer {

Vectorscope::Vectorscope()
    : sampleRate_(48000.0f)
    , bufferSize_(1024)
    , writePos_(0)
    , validSamples_(0) {

    leftBuffer_.resize(VECTORSCOPE_BUFFER_SIZE, 0.0f);
    rightBuffer_.resize(VECTORSCOPE_BUFFER_SIZE, 0.0f);
    points_.reserve(1024);

    // Cascaded lowpass at 8kHz, Butterworth (Q=0.707)
    // Two stages per channel = 4th order = 24 dB/oct rolloff
    // Removes HF noise that causes erratic Lissajous motion
    leftLowpass1_.setLowpass(8000.0f, sampleRate_, 0.707f);
    leftLowpass2_.setLowpass(8000.0f, sampleRate_, 0.707f);
    rightLowpass1_.setLowpass(8000.0f, sampleRate_, 0.707f);
    rightLowpass2_.setLowpass(8000.0f, sampleRate_, 0.707f);
}

void Vectorscope::setSampleRate(float sampleRate) {
    sampleRate_ = sampleRate;
    // Redesign all filters with new sample rate
    leftLowpass1_.setLowpass(8000.0f, sampleRate_, 0.707f);
    leftLowpass2_.setLowpass(8000.0f, sampleRate_, 0.707f);
    rightLowpass1_.setLowpass(8000.0f, sampleRate_, 0.707f);
    rightLowpass2_.setLowpass(8000.0f, sampleRate_, 0.707f);
}

void Vectorscope::setBufferSize(size_t size) {
    bufferSize_ = size;
    points_.reserve(size);
}

void Vectorscope::pushSamples(
    const float* leftChannel,
    const float* rightChannel,
    size_t length
) {
    for (size_t i = 0; i < length; i++) {
        // Apply cascaded lowpass filtering
        float filteredL = leftLowpass1_.process(leftChannel[i]);
        filteredL = leftLowpass2_.process(filteredL);

        float filteredR = rightLowpass1_.process(rightChannel[i]);
        filteredR = rightLowpass2_.process(filteredR);

        leftBuffer_[writePos_] = filteredL;
        rightBuffer_[writePos_] = filteredR;

        writePos_ = (writePos_ + 1) % VECTORSCOPE_BUFFER_SIZE;
        if (validSamples_ < VECTORSCOPE_BUFFER_SIZE) {
            validSamples_++;
        }
    }
}

size_t Vectorscope::getPoints(float* xOut, float* yOut, size_t maxPoints) const {
    size_t count = std::min(maxPoints, validSamples_);

    // Read the most recent `count` samples from the circular buffer
    for (size_t i = 0; i < count; i++) {
        size_t idx = (writePos_ + VECTORSCOPE_BUFFER_SIZE - count + i) % VECTORSCOPE_BUFFER_SIZE;
        xOut[i] = rightBuffer_[idx];  // X = Right (standard Lissajous)
        yOut[i] = leftBuffer_[idx];   // Y = Left
    }

    return count;
}

// Legacy process method (routes through new pipeline)
const std::vector<VectorscopePoint>& Vectorscope::process(
    const float* leftChannel,
    const float* rightChannel,
    size_t length
) {
    // Push through the filtering pipeline
    pushSamples(leftChannel, rightChannel, length);

    // Build legacy output from buffer
    points_.clear();
    size_t count = std::min(length, validSamples_);
    for (size_t i = 0; i < count; i++) {
        size_t idx = (writePos_ + VECTORSCOPE_BUFFER_SIZE - count + i) % VECTORSCOPE_BUFFER_SIZE;
        VectorscopePoint p;
        p.x = rightBuffer_[idx];
        p.y = leftBuffer_[idx];
        points_.push_back(p);
    }
    return points_;
}

void Vectorscope::reset() {
    writePos_ = 0;
    validSamples_ = 0;
    std::fill(leftBuffer_.begin(), leftBuffer_.end(), 0.0f);
    std::fill(rightBuffer_.begin(), rightBuffer_.end(), 0.0f);
    leftLowpass1_.reset();
    leftLowpass2_.reset();
    rightLowpass1_.reset();
    rightLowpass2_.reset();
    points_.clear();
}

} // namespace Visualizer
