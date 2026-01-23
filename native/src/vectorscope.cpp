#include "vectorscope.h"
#include <algorithm>
#include <cmath>

namespace Visualizer {

Vectorscope::Vectorscope()
    : bufferSize_(1024) {
    points_.reserve(bufferSize_);
}

void Vectorscope::setBufferSize(size_t size) {
    bufferSize_ = size;
    points_.reserve(size);
}

const std::vector<VectorscopePoint>& Vectorscope::process(
    const float* leftChannel,
    const float* rightChannel,
    size_t length
) {
    points_.clear();

    size_t samplesToProcess = std::min(length, bufferSize_);

    for (size_t i = 0; i < samplesToProcess; i++) {
        VectorscopePoint point;
        // Standard Lissajous: X = Right, Y = Left
        // This creates the traditional vectorscope display
        point.x = rightChannel[i];
        point.y = leftChannel[i];
        points_.push_back(point);
    }

    return points_;
}

void Vectorscope::reset() {
    points_.clear();
}

} // namespace Visualizer
