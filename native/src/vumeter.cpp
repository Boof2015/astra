#include "vumeter.h"

#include <algorithm>
#include <chrono>
#include <cmath>

namespace Visualizer {

namespace {
constexpr double VU_METER_MIN_DB = -60.0;
constexpr double VU_METER_MAX_DB = 0.0;
constexpr double VU_INTEGRATION_WINDOW_MS = 300.0;
constexpr double VU_PEAK_HOLD_MS = 750.0;
constexpr double VU_PEAK_DECAY_DB_PER_SECOND = 18.0;
constexpr double BAR_ATTACK_MS = 5.0;
constexpr double BAR_RELEASE_MS = 180.0;

VUMeterSnapshot makeInitialSnapshot() {
    return {
        static_cast<float>(VU_METER_MIN_DB),
        static_cast<float>(VU_METER_MIN_DB),
        static_cast<float>(VU_METER_MIN_DB),
        static_cast<float>(VU_METER_MIN_DB),
        static_cast<float>(VU_METER_MIN_DB),
        static_cast<float>(VU_METER_MIN_DB),
        0.0f,
    };
}

float sanitizeSampleRate(float sampleRate) {
    if (!std::isfinite(sampleRate) || sampleRate <= 0.0f) {
        return 1.0f;
    }
    return std::max(1.0f, std::floor(sampleRate));
}
} // namespace

VUMeterAnalyzer::VUMeterAnalyzer() {
    configureForSampleRate(sampleRate_);
}

void VUMeterAnalyzer::setSampleRate(float sampleRate) {
    configureForSampleRate(sampleRate);
}

void VUMeterAnalyzer::configureForSampleRate(float sampleRate) {
    sampleRate_ = sanitizeSampleRate(sampleRate);
    integrationWindowSamples_ = std::max<size_t>(
        1,
        static_cast<size_t>(std::round((static_cast<double>(sampleRate_) * VU_INTEGRATION_WINDOW_MS) / 1000.0))
    );
    sqL_.assign(integrationWindowSamples_, 0.0);
    sqR_.assign(integrationWindowSamples_, 0.0);
    cross_.assign(integrationWindowSamples_, 0.0);
    barAttackCoeff_ = std::exp(-1.0 / (static_cast<double>(sampleRate_) * (BAR_ATTACK_MS / 1000.0)));
    barReleaseCoeff_ = std::exp(-1.0 / (static_cast<double>(sampleRate_) * (BAR_RELEASE_MS / 1000.0)));
    reset();
}

void VUMeterAnalyzer::reset() {
    std::fill(sqL_.begin(), sqL_.end(), 0.0);
    std::fill(sqR_.begin(), sqR_.end(), 0.0);
    std::fill(cross_.begin(), cross_.end(), 0.0);
    writeIndex_ = 0;
    sampleCount_ = 0;
    sumSqL_ = 0.0;
    sumSqR_ = 0.0;
    sumCross_ = 0.0;
    barEnvelopeL_ = 0.0;
    barEnvelopeR_ = 0.0;
    peakHoldUntilL_ = 0.0;
    peakHoldUntilR_ = 0.0;
    lastPeakUpdateMs_ = 0.0;
    hasLastPeakUpdate_ = false;
    snapshot_ = makeInitialSnapshot();
}

void VUMeterAnalyzer::pushSamples(const float* leftChannel, const float* rightChannel, size_t length) {
    if (!leftChannel || !rightChannel || length == 0) {
        return;
    }

    const double nowMs = currentTimeMs();
    advancePeaks(nowMs);

    double maxPeakL = 0.0;
    double maxPeakR = 0.0;
    for (size_t index = 0; index < length; index += 1) {
        processSample(leftChannel[index], rightChannel[index], maxPeakL, maxPeakR);
    }

    maybeUpdatePeak(amplitudeToDb(maxPeakL), nowMs, true);
    maybeUpdatePeak(amplitudeToDb(maxPeakR), nowMs, false);
    recomputeSnapshot();
}

VUMeterSnapshot VUMeterAnalyzer::getSnapshot() {
    advancePeaks(currentTimeMs());
    recomputeSnapshot();
    return snapshot_;
}

void VUMeterAnalyzer::processSample(float left, float right, double& maxPeakL, double& maxPeakR) {
    if (sqL_.empty()) {
        return;
    }

    const double sqL = static_cast<double>(left) * left;
    const double sqR = static_cast<double>(right) * right;
    const double cross = static_cast<double>(left) * right;

    if (sampleCount_ == integrationWindowSamples_) {
        sumSqL_ = std::max(0.0, sumSqL_ - sqL_[writeIndex_]);
        sumSqR_ = std::max(0.0, sumSqR_ - sqR_[writeIndex_]);
        sumCross_ -= cross_[writeIndex_];
    } else {
        sampleCount_ += 1;
    }

    sqL_[writeIndex_] = sqL;
    sqR_[writeIndex_] = sqR;
    cross_[writeIndex_] = cross;
    sumSqL_ += sqL;
    sumSqR_ += sqR;
    sumCross_ += cross;
    writeIndex_ = (writeIndex_ + 1) % integrationWindowSamples_;

    const double absL = std::abs(static_cast<double>(left));
    const double absR = std::abs(static_cast<double>(right));
    const double coeffL = absL > barEnvelopeL_ ? barAttackCoeff_ : barReleaseCoeff_;
    const double coeffR = absR > barEnvelopeR_ ? barAttackCoeff_ : barReleaseCoeff_;
    barEnvelopeL_ = coeffL * barEnvelopeL_ + (1.0 - coeffL) * absL;
    barEnvelopeR_ = coeffR * barEnvelopeR_ + (1.0 - coeffR) * absR;

    if (absL > maxPeakL) {
        maxPeakL = absL;
    }
    if (absR > maxPeakR) {
        maxPeakR = absR;
    }
}

void VUMeterAnalyzer::advancePeaks(double nowMs) {
    if (!std::isfinite(nowMs)) {
        return;
    }

    if (!hasLastPeakUpdate_) {
        lastPeakUpdateMs_ = nowMs;
        hasLastPeakUpdate_ = true;
        return;
    }

    if (nowMs <= lastPeakUpdateMs_) {
        return;
    }

    snapshot_.peakLDb = static_cast<float>(applyPeakDecay(snapshot_.peakLDb, peakHoldUntilL_, nowMs));
    snapshot_.peakRDb = static_cast<float>(applyPeakDecay(snapshot_.peakRDb, peakHoldUntilR_, nowMs));
    lastPeakUpdateMs_ = nowMs;
}

void VUMeterAnalyzer::maybeUpdatePeak(double peakDb, double nowMs, bool leftChannel) {
    if (leftChannel) {
        if (peakDb > snapshot_.peakLDb) {
            snapshot_.peakLDb = static_cast<float>(peakDb);
            peakHoldUntilL_ = nowMs + VU_PEAK_HOLD_MS;
        }
        return;
    }

    if (peakDb > snapshot_.peakRDb) {
        snapshot_.peakRDb = static_cast<float>(peakDb);
        peakHoldUntilR_ = nowMs + VU_PEAK_HOLD_MS;
    }
}

double VUMeterAnalyzer::applyPeakDecay(double currentDb, double holdUntilMs, double nowMs) const {
    const double decayStartMs = std::max(lastPeakUpdateMs_, holdUntilMs);
    if (nowMs <= decayStartMs) {
        return currentDb;
    }

    const double decayAmount = ((nowMs - decayStartMs) / 1000.0) * VU_PEAK_DECAY_DB_PER_SECOND;
    return std::max(VU_METER_MIN_DB, currentDb - decayAmount);
}

void VUMeterAnalyzer::recomputeSnapshot() {
    if (sampleCount_ == 0) {
        snapshot_.vuLDb = static_cast<float>(VU_METER_MIN_DB);
        snapshot_.vuRDb = static_cast<float>(VU_METER_MIN_DB);
        snapshot_.barLDb = static_cast<float>(amplitudeToDb(barEnvelopeL_));
        snapshot_.barRDb = static_cast<float>(amplitudeToDb(barEnvelopeR_));
        snapshot_.correlation = 0.0f;
        return;
    }

    const double meanSqL = std::max(0.0, sumSqL_) / sampleCount_;
    const double meanSqR = std::max(0.0, sumSqR_) / sampleCount_;
    const double denominator = std::sqrt(std::max(0.0, sumSqL_) * std::max(0.0, sumSqR_));

    snapshot_.vuLDb = static_cast<float>(amplitudeToDb(std::sqrt(meanSqL)));
    snapshot_.vuRDb = static_cast<float>(amplitudeToDb(std::sqrt(meanSqR)));
    snapshot_.barLDb = static_cast<float>(amplitudeToDb(barEnvelopeL_));
    snapshot_.barRDb = static_cast<float>(amplitudeToDb(barEnvelopeR_));
    snapshot_.correlation = denominator > 1e-10
        ? static_cast<float>(std::clamp(sumCross_ / denominator, -1.0, 1.0))
        : 0.0f;
}

double VUMeterAnalyzer::currentTimeMs() {
    using Clock = std::chrono::steady_clock;
    const auto now = Clock::now().time_since_epoch();
    return std::chrono::duration<double, std::milli>(now).count();
}

double VUMeterAnalyzer::amplitudeToDb(double amplitude) {
    if (!std::isfinite(amplitude) || amplitude <= 0.0) {
        return VU_METER_MIN_DB;
    }
    return clampDb(20.0 * std::log10(std::max(amplitude, 1e-10)), VU_METER_MIN_DB, VU_METER_MAX_DB);
}

double VUMeterAnalyzer::clampDb(double db, double minDb, double maxDb) {
    return std::max(minDb, std::min(maxDb, db));
}

} // namespace Visualizer
