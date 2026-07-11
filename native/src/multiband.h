#pragma once

#include "dsp_utils.h"
#include <cstddef>

namespace Visualizer {

constexpr float MULTIBAND_LOW_MID_CROSSOVER = 250.0f;
constexpr float MULTIBAND_MID_HIGH_CROSSOVER = 2500.0f;
constexpr size_t MULTIBAND_POINT_STRIDE = 6;

struct MultibandSample {
    float lowL;
    float lowR;
    float midL;
    float midR;
    float highL;
    float highR;
};

class MultibandSplitter {
public:
    MultibandSplitter();

    void configure(float sampleRate);
    MultibandSample process(float left, float right);
    void reset();

private:
    float configuredSampleRate_;

    DSP::BiquadFilter lowLpL_;
    DSP::BiquadFilter lowLpR_;
    DSP::BiquadFilter midHpL_;
    DSP::BiquadFilter midHpR_;
    DSP::BiquadFilter midLpL_;
    DSP::BiquadFilter midLpR_;
    DSP::BiquadFilter highHpL_;
    DSP::BiquadFilter highHpR_;
};

} // namespace Visualizer
