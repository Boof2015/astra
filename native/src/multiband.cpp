#include "multiband.h"
#include <algorithm>
#include <cmath>

namespace Visualizer {

namespace {
constexpr float MULTIBAND_FILTER_Q = 1.41421356237f;
}

MultibandSplitter::MultibandSplitter()
    : configuredSampleRate_(0.0f) {
    configure(48000.0f);
}

void MultibandSplitter::configure(float sampleRate) {
    const float nextSampleRate = std::max(1.0f, sampleRate);
    if (nextSampleRate == configuredSampleRate_) {
        return;
    }

    configuredSampleRate_ = nextSampleRate;

    lowLpL_.setLowpass(MULTIBAND_LOW_MID_CROSSOVER, configuredSampleRate_, MULTIBAND_FILTER_Q);
    lowLpR_.setLowpass(MULTIBAND_LOW_MID_CROSSOVER, configuredSampleRate_, MULTIBAND_FILTER_Q);

    midHpL_.setHighpass(MULTIBAND_LOW_MID_CROSSOVER, configuredSampleRate_, MULTIBAND_FILTER_Q);
    midHpR_.setHighpass(MULTIBAND_LOW_MID_CROSSOVER, configuredSampleRate_, MULTIBAND_FILTER_Q);
    midLpL_.setLowpass(MULTIBAND_MID_HIGH_CROSSOVER, configuredSampleRate_, MULTIBAND_FILTER_Q);
    midLpR_.setLowpass(MULTIBAND_MID_HIGH_CROSSOVER, configuredSampleRate_, MULTIBAND_FILTER_Q);

    highHpL_.setHighpass(MULTIBAND_MID_HIGH_CROSSOVER, configuredSampleRate_, MULTIBAND_FILTER_Q);
    highHpR_.setHighpass(MULTIBAND_MID_HIGH_CROSSOVER, configuredSampleRate_, MULTIBAND_FILTER_Q);

    reset();
}

MultibandSample MultibandSplitter::process(float left, float right) {
    const float midTmpL = midHpL_.process(left);
    const float midTmpR = midHpR_.process(right);

    return {
        lowLpL_.process(left),
        lowLpR_.process(right),
        midLpL_.process(midTmpL),
        midLpR_.process(midTmpR),
        highHpL_.process(left),
        highHpR_.process(right),
    };
}

void MultibandSplitter::reset() {
    lowLpL_.reset();
    lowLpR_.reset();
    midHpL_.reset();
    midHpR_.reset();
    midLpL_.reset();
    midLpR_.reset();
    highHpL_.reset();
    highHpR_.reset();
}

} // namespace Visualizer
