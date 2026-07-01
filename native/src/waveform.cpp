#include "waveform.h"
#include <algorithm>
#include <cmath>

namespace Visualizer {

WaveformMultibandAnalyzer::WaveformMultibandAnalyzer()
    : sampleRate_(48000.0f)
    , samplesPerColumn_(1)
    , columnPos_(0)
    , leftMin_(0.0f)
    , leftMax_(0.0f)
    , rightMin_(0.0f)
    , rightMax_(0.0f)
    , leftLowSum_(0.0f)
    , leftMidSum_(0.0f)
    , leftHighSum_(0.0f)
    , rightLowSum_(0.0f)
    , rightMidSum_(0.0f)
    , rightHighSum_(0.0f) {
    splitter_.configure(sampleRate_);
}

void WaveformMultibandAnalyzer::configure(float sampleRate, size_t samplesPerColumn) {
    const float nextSampleRate = std::max(1.0f, sampleRate);
    const size_t nextSamplesPerColumn = std::max<size_t>(1, samplesPerColumn);

    if (nextSampleRate == sampleRate_ && nextSamplesPerColumn == samplesPerColumn_) {
        return;
    }

    sampleRate_ = nextSampleRate;
    samplesPerColumn_ = nextSamplesPerColumn;
    splitter_.configure(sampleRate_);
    reset();
}

const std::vector<float>& WaveformMultibandAnalyzer::processMono(const float* samples, size_t length) {
    summaries_.clear();

    for (size_t i = 0; i < length; i++) {
        const float sample = samples[i];
        const MultibandSample bands = splitter_.process(sample, sample);
        accumulateLeft(sample, bands);

        columnPos_++;
        if (columnPos_ >= samplesPerColumn_) {
            flushMonoColumn();
            resetColumn();
        }
    }

    return summaries_;
}

const std::vector<float>& WaveformMultibandAnalyzer::processStereo(
    const float* left,
    const float* right,
    size_t length
) {
    summaries_.clear();

    for (size_t i = 0; i < length; i++) {
        const MultibandSample bands = splitter_.process(left[i], right[i]);
        accumulateLeft(left[i], bands);
        accumulateRight(right[i], bands);

        columnPos_++;
        if (columnPos_ >= samplesPerColumn_) {
            flushStereoColumn();
            resetColumn();
        }
    }

    return summaries_;
}

void WaveformMultibandAnalyzer::reset() {
    splitter_.reset();
    summaries_.clear();
    resetColumn();
}

void WaveformMultibandAnalyzer::resetColumn() {
    columnPos_ = 0;
    leftMin_ = 0.0f;
    leftMax_ = 0.0f;
    rightMin_ = 0.0f;
    rightMax_ = 0.0f;
    leftLowSum_ = 0.0f;
    leftMidSum_ = 0.0f;
    leftHighSum_ = 0.0f;
    rightLowSum_ = 0.0f;
    rightMidSum_ = 0.0f;
    rightHighSum_ = 0.0f;
}

void WaveformMultibandAnalyzer::accumulateLeft(float sample, const MultibandSample& bands) {
    if (columnPos_ == 0) {
        leftMin_ = sample;
        leftMax_ = sample;
    } else {
        leftMin_ = std::min(leftMin_, sample);
        leftMax_ = std::max(leftMax_, sample);
    }

    leftLowSum_ += bands.lowL * bands.lowL;
    leftMidSum_ += bands.midL * bands.midL;
    leftHighSum_ += bands.highL * bands.highL;
}

void WaveformMultibandAnalyzer::accumulateRight(float sample, const MultibandSample& bands) {
    if (columnPos_ == 0) {
        rightMin_ = sample;
        rightMax_ = sample;
    } else {
        rightMin_ = std::min(rightMin_, sample);
        rightMax_ = std::max(rightMax_, sample);
    }

    rightLowSum_ += bands.lowR * bands.lowR;
    rightMidSum_ += bands.midR * bands.midR;
    rightHighSum_ += bands.highR * bands.highR;
}

void WaveformMultibandAnalyzer::flushMonoColumn() {
    summaries_.push_back(leftMin_);
    summaries_.push_back(leftMax_);
    summaries_.push_back(rms(leftLowSum_));
    summaries_.push_back(rms(leftMidSum_));
    summaries_.push_back(rms(leftHighSum_));
}

void WaveformMultibandAnalyzer::flushStereoColumn() {
    summaries_.push_back(leftMin_);
    summaries_.push_back(leftMax_);
    summaries_.push_back(rms(leftLowSum_));
    summaries_.push_back(rms(leftMidSum_));
    summaries_.push_back(rms(leftHighSum_));
    summaries_.push_back(rightMin_);
    summaries_.push_back(rightMax_);
    summaries_.push_back(rms(rightLowSum_));
    summaries_.push_back(rms(rightMidSum_));
    summaries_.push_back(rms(rightHighSum_));
}

float WaveformMultibandAnalyzer::rms(float sum) const {
    const size_t count = std::max<size_t>(1, columnPos_);
    return std::sqrt(sum / static_cast<float>(count));
}

} // namespace Visualizer
