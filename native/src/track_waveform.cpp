#include "track_waveform.h"

#include <algorithm>
#include <cmath>

namespace Astra {

std::vector<float> StaticTrackWaveformAnalyzer::analyzeInterleaved(
    const float* samples,
    std::size_t frameCount,
    std::size_t channelCount,
    std::size_t resolution
) {
    std::vector<float> peaks(resolution, 0.0f);
    if (samples == nullptr || frameCount == 0 || channelCount == 0 || resolution == 0) {
        return peaks;
    }

    const std::size_t samplesPerBin = frameCount / resolution;
    const std::size_t stride = std::max<std::size_t>(
        1,
        samplesPerBin / MAX_SAMPLED_FRAMES_PER_BIN
    );

    float globalMax = 0.0f;
    for (std::size_t binIndex = 0; binIndex < resolution; ++binIndex) {
        const std::size_t startFrame = binIndex * samplesPerBin;
        const std::size_t endFrame = std::min(startFrame + samplesPerBin, frameCount);
        double sumSquares = 0.0;
        std::size_t count = 0;

        // Keep channel-major accumulation order to minimize floating-point
        // differences from the previous planar AudioBuffer implementation.
        for (std::size_t channelIndex = 0; channelIndex < channelCount; ++channelIndex) {
            for (std::size_t frameIndex = startFrame; frameIndex < endFrame; frameIndex += stride) {
                const double sample = static_cast<double>(
                    samples[(frameIndex * channelCount) + channelIndex]
                );
                sumSquares += sample * sample;
                ++count;
            }
        }

        const double divisor = static_cast<double>(std::max<std::size_t>(1, count));
        const float rms = static_cast<float>(std::sqrt(sumSquares / divisor));
        peaks[binIndex] = rms;
        if (rms > globalMax) globalMax = rms;
    }

    if (globalMax > 0.0f) {
        for (float& peak : peaks) peak /= globalMax;
    }

    return peaks;
}

} // namespace Astra
