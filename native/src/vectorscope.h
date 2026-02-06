#pragma once

#include "dsp_utils.h"
#include <vector>
#include <cstddef>

namespace Visualizer {

struct VectorscopePoint {
    float x; // Right channel
    float y; // Left channel
};

// Circular buffer size (~170ms at 48kHz)
constexpr size_t VECTORSCOPE_BUFFER_SIZE = 8192;

class Vectorscope {
public:
    Vectorscope();

    // Configuration
    void setSampleRate(float sampleRate);
    void setBufferSize(size_t size); // Legacy, kept for compat
    size_t getBufferSize() const { return bufferSize_; }

    // Push stereo samples into circular buffer (called per worklet chunk)
    void pushSamples(const float* leftChannel, const float* rightChannel, size_t length);

    // Get the most recent N points for rendering (from circular buffer)
    // Returns count of valid points written to output arrays
    size_t getPoints(float* xOut, float* yOut, size_t maxPoints) const;

    // Get number of valid samples in buffer
    size_t getValidSamples() const { return validSamples_; }

    // Legacy process (kept for backwards compatibility)
    const std::vector<VectorscopePoint>& process(
        const float* leftChannel,
        const float* rightChannel,
        size_t length
    );

    // Reset state
    void reset();

private:
    float sampleRate_;
    size_t bufferSize_; // Legacy
    size_t writePos_;
    size_t validSamples_;

    // Circular buffers for filtered L/R
    std::vector<float> leftBuffer_;
    std::vector<float> rightBuffer_;

    // Cascaded lowpass filters (4th order Butterworth at 8kHz per channel)
    DSP::BiquadFilter leftLowpass1_;
    DSP::BiquadFilter leftLowpass2_;
    DSP::BiquadFilter rightLowpass1_;
    DSP::BiquadFilter rightLowpass2_;

    // Legacy
    std::vector<VectorscopePoint> points_;
};

} // namespace Visualizer
