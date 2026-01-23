#pragma once

#include <vector>
#include <cstddef>

namespace Visualizer {

struct VectorscopePoint {
    float x; // Right channel (or M+S side)
    float y; // Left channel (or M+S mid)
};

class Vectorscope {
public:
    Vectorscope();

    // Configuration
    void setBufferSize(size_t size);
    size_t getBufferSize() const { return bufferSize_; }

    // Process stereo audio
    // Returns vector of points for plotting
    const std::vector<VectorscopePoint>& process(
        const float* leftChannel,
        const float* rightChannel,
        size_t length
    );

    // Reset state
    void reset();

private:
    size_t bufferSize_;
    std::vector<VectorscopePoint> points_;
};

} // namespace Visualizer
