#include "track_waveform.h"

#include <cassert>
#include <cmath>
#include <cstddef>
#include <iostream>
#include <vector>

namespace {

constexpr float kTolerance = 1e-6f;

void ExpectNear(float actual, float expected, float tolerance = kTolerance) {
    assert(std::isfinite(actual));
    assert(std::abs(actual - expected) <= tolerance);
}

void ExpectWaveform(
    const std::vector<float>& actual,
    const std::vector<float>& expected,
    float tolerance = kTolerance
) {
    assert(actual.size() == expected.size());
    for (std::size_t index = 0; index < expected.size(); ++index) {
        ExpectNear(actual[index], expected[index], tolerance);
    }
}

void TestSilenceAndShortTracks() {
    const std::vector<float> silence(16, 0.0f);
    ExpectWaveform(
        Astra::StaticTrackWaveformAnalyzer::analyzeInterleaved(silence.data(), 16, 1, 4),
        {0.0f, 0.0f, 0.0f, 0.0f}
    );

    const std::vector<float> shortTrack {1.0f, -1.0f, 0.5f};
    ExpectWaveform(
        Astra::StaticTrackWaveformAnalyzer::analyzeInterleaved(shortTrack.data(), 3, 1, 4),
        {0.0f, 0.0f, 0.0f, 0.0f}
    );
}

void TestMonoConstantAndRegionalEnergy() {
    const std::vector<float> constant(16, -0.25f);
    ExpectWaveform(
        Astra::StaticTrackWaveformAnalyzer::analyzeInterleaved(constant.data(), 16, 1, 4),
        {1.0f, 1.0f, 1.0f, 1.0f}
    );

    const std::vector<float> regional {
        0.0f, 0.0f, 0.0f, 0.0f,
        0.25f, 0.25f, 0.25f, 0.25f,
        0.5f, 0.5f, 0.5f, 0.5f,
        1.0f, 1.0f, 1.0f, 1.0f,
    };
    ExpectWaveform(
        Astra::StaticTrackWaveformAnalyzer::analyzeInterleaved(regional.data(), 16, 1, 4),
        {0.0f, 0.25f, 0.5f, 1.0f}
    );
}

void TestStereoAndMultichannelCombination() {
    const std::vector<float> stereo {
        1.0f, 0.0f,
        1.0f, 0.0f,
        0.0f, 0.5f,
        0.0f, 0.5f,
    };
    ExpectWaveform(
        Astra::StaticTrackWaveformAnalyzer::analyzeInterleaved(stereo.data(), 4, 2, 2),
        {1.0f, 0.5f}
    );

    const std::vector<float> fourChannel {
        1.0f, 0.0f, 0.0f, 0.0f,
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 0.5f, 0.5f,
        0.0f, 0.0f, 0.5f, 0.5f,
    };
    ExpectWaveform(
        Astra::StaticTrackWaveformAnalyzer::analyzeInterleaved(fourChannel.data(), 4, 4, 2),
        {1.0f, std::sqrt(0.5f)}
    );
}

void TestNonDivisibleTailMatchesHistoricalBins() {
    const std::vector<float> samples {1.0f, 1.0f, 0.5f, 0.5f, 9.0f};
    // floor(5 / 2) gives two two-frame bins; the historical renderer path
    // intentionally leaves the final remainder frame outside the waveform.
    ExpectWaveform(
        Astra::StaticTrackWaveformAnalyzer::analyzeInterleaved(samples.data(), 5, 1, 2),
        {1.0f, 0.5f}
    );
}

void TestLongTrackStrideSampling() {
    constexpr std::size_t frames = 16'384;
    std::vector<float> samples(frames, 0.25f);
    // 8192 frames per bin produces stride 2. Unsampled odd frames must not
    // affect the result, proving that the bounded historical sampling rule is
    // retained rather than silently becoming a full pass.
    for (std::size_t frame = 1; frame < frames; frame += 2) samples[frame] = 100.0f;
    for (std::size_t frame = frames / 2; frame < frames; frame += 2) samples[frame] = 0.5f;
    ExpectWaveform(
        Astra::StaticTrackWaveformAnalyzer::analyzeInterleaved(samples.data(), frames, 1, 2),
        {0.5f, 1.0f}
    );
}

} // namespace

int main() {
    TestSilenceAndShortTracks();
    TestMonoConstantAndRegionalEnergy();
    TestStereoAndMultichannelCombination();
    TestNonDivisibleTailMatchesHistoricalBins();
    TestLongTrackStrideSampling();
    std::cout << "Static track waveform tests passed.\n";
    return 0;
}
