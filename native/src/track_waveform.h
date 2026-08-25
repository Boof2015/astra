#pragma once

#include <cstddef>
#include <vector>

namespace Astra {

/**
 * Produces the canonical static whole-track RMS waveform used by the player
 * seekbar. Input PCM is interleaved float32 and is never retained.
 *
 * The bin and stride rules intentionally mirror the renderer's historical
 * extractWaveformPeaks implementation, including its treatment of tracks
 * shorter than the requested resolution and trailing non-divisible frames.
 */
class StaticTrackWaveformAnalyzer {
public:
    static constexpr std::size_t DEFAULT_RESOLUTION = 512;
    static constexpr std::size_t MAX_RESOLUTION = 16'384;
    static constexpr std::size_t MAX_CHANNELS = 32;
    static constexpr std::size_t MAX_SAMPLED_FRAMES_PER_BIN = 4096;

    static std::vector<float> analyzeInterleaved(
        const float* samples,
        std::size_t frameCount,
        std::size_t channelCount,
        std::size_t resolution = DEFAULT_RESOLUTION
    );
};

} // namespace Astra
