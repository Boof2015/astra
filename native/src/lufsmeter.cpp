#include "lufsmeter.h"

#include <algorithm>
#include <chrono>
#include <cmath>

namespace Visualizer {

namespace {
constexpr double PI = 3.14159265358979323846;
constexpr double METER_MIN_LUFS = -60.0;
constexpr double VU_METER_MIN_DB = -60.0;
constexpr double VU_METER_MAX_DB = 0.0;
constexpr double MOMENTARY_WINDOW_S = 0.4;
constexpr double SHORT_TERM_WINDOW_S = 3.0;
constexpr double INTEGRATED_BLOCK_S = 0.4;
constexpr double INTEGRATED_HOP_S = 0.1;
constexpr double ABSOLUTE_GATE_LUFS = -70.0;
constexpr double RELATIVE_GATE_OFFSET = -10.0;
constexpr double INTEGRATED_HISTOGRAM_MIN_LUFS = ABSOLUTE_GATE_LUFS;
constexpr double INTEGRATED_HISTOGRAM_MAX_LUFS = 10.0;
constexpr double INTEGRATED_HISTOGRAM_BIN_WIDTH = 0.1;
constexpr size_t INTEGRATED_HISTOGRAM_BIN_COUNT =
    static_cast<size_t>((INTEGRATED_HISTOGRAM_MAX_LUFS - INTEGRATED_HISTOGRAM_MIN_LUFS)
        / INTEGRATED_HISTOGRAM_BIN_WIDTH + 0.5) + 1;

constexpr double PRE_FILTER_F0_HZ = 1681.9744509555319;
constexpr double PRE_FILTER_GAIN_DB = 3.999843853973347;
constexpr double PRE_FILTER_Q = 0.7071752369554193;
constexpr double RLB_FILTER_F0_HZ = 38.13547087613982;
constexpr double RLB_FILTER_Q = 0.5003270373223665;

constexpr double VU_INTEGRATION_WINDOW_MS = 300.0;
constexpr double VU_PEAK_HOLD_MS = 750.0;
constexpr double VU_PEAK_DECAY_DB_PER_SECOND = 18.0;
constexpr double BAR_ATTACK_MS = 5.0;
constexpr double BAR_RELEASE_MS = 180.0;

LUFSMeterSnapshot makeInitialSnapshot() {
    return {
        static_cast<float>(METER_MIN_LUFS),
        static_cast<float>(METER_MIN_LUFS),
        static_cast<float>(METER_MIN_LUFS),
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

LUFSMeterAnalyzer::LUFSMeterAnalyzer() {
    configureForSampleRate(sampleRate_);
}

void LUFSMeterAnalyzer::setSampleRate(float sampleRate) {
    configureForSampleRate(sampleRate);
}

void LUFSMeterAnalyzer::configureForSampleRate(float sampleRate) {
    sampleRate_ = sanitizeSampleRate(sampleRate);
    configureKWeighting();

    const size_t ringSize = std::max<size_t>(
        1,
        static_cast<size_t>(std::ceil(static_cast<double>(sampleRate_) * SHORT_TERM_WINDOW_S))
    );
    ringBufferL_.assign(ringSize, 0.0);
    ringBufferR_.assign(ringSize, 0.0);

    integratedHistogramCounts_.assign(INTEGRATED_HISTOGRAM_BIN_COUNT, 0);
    integratedHistogramPowerSums_.assign(INTEGRATED_HISTOGRAM_BIN_COUNT, 0.0);

    configureFastMeter();
    reset();
}

void LUFSMeterAnalyzer::configureKWeighting() {
    preCoeffs_ = preFilterCoeffs(sampleRate_);
    rlbCoeffs_ = rlbFilterCoeffs(sampleRate_);
}

void LUFSMeterAnalyzer::configureFastMeter() {
    integrationWindowSamples_ = std::max<size_t>(
        1,
        static_cast<size_t>(std::round((static_cast<double>(sampleRate_) * VU_INTEGRATION_WINDOW_MS) / 1000.0))
    );
    fastSqL_.assign(integrationWindowSamples_, 0.0);
    fastSqR_.assign(integrationWindowSamples_, 0.0);
    fastCross_.assign(integrationWindowSamples_, 0.0);
    barAttackCoeff_ = std::exp(-1.0 / (static_cast<double>(sampleRate_) * (BAR_ATTACK_MS / 1000.0)));
    barReleaseCoeff_ = std::exp(-1.0 / (static_cast<double>(sampleRate_) * (BAR_RELEASE_MS / 1000.0)));
}

void LUFSMeterAnalyzer::reset() {
    std::fill(ringBufferL_.begin(), ringBufferL_.end(), 0.0);
    std::fill(ringBufferR_.begin(), ringBufferR_.end(), 0.0);
    ringBufferPos_ = 0;
    ringBufferFilled_ = 0;
    integratedHopCounter_ = 0;
    std::fill(integratedHistogramCounts_.begin(), integratedHistogramCounts_.end(), 0);
    std::fill(integratedHistogramPowerSums_.begin(), integratedHistogramPowerSums_.end(), 0.0);

    preFilterL_ = {};
    preFilterR_ = {};
    rlbFilterL_ = {};
    rlbFilterR_ = {};

    std::fill(fastSqL_.begin(), fastSqL_.end(), 0.0);
    std::fill(fastSqR_.begin(), fastSqR_.end(), 0.0);
    std::fill(fastCross_.begin(), fastCross_.end(), 0.0);
    fastWriteIndex_ = 0;
    fastSampleCount_ = 0;
    fastSumSqL_ = 0.0;
    fastSumSqR_ = 0.0;
    fastSumCross_ = 0.0;
    barEnvelopeL_ = 0.0;
    barEnvelopeR_ = 0.0;
    peakHoldUntilL_ = 0.0;
    peakHoldUntilR_ = 0.0;
    lastPeakUpdateMs_ = 0.0;
    hasLastPeakUpdate_ = false;

    snapshot_ = makeInitialSnapshot();
}

void LUFSMeterAnalyzer::pushSamples(const float* leftChannel, const float* rightChannel, size_t length) {
    if (!leftChannel || !rightChannel || length == 0) {
        return;
    }

    const double nowMs = currentTimeMs();
    advancePeaks(nowMs);

    double maxPeakL = 0.0;
    double maxPeakR = 0.0;

    for (size_t index = 0; index < length; index += 1) {
        const float left = leftChannel[index];
        const float right = rightChannel[index];
        processLoudnessSample(left, right);
        processFastMeterSample(left, right, maxPeakL, maxPeakR);
    }

    maybeUpdatePeak(amplitudeToDb(maxPeakL), nowMs, true);
    maybeUpdatePeak(amplitudeToDb(maxPeakR), nowMs, false);
    recomputeFastSnapshot();
    updateMomentaryShortTermLoudness();
    snapshot_.integratedLUFS = static_cast<float>(computeGatedIntegratedLoudness());
}

LUFSMeterSnapshot LUFSMeterAnalyzer::getSnapshot() {
    advancePeaks(currentTimeMs());
    recomputeFastSnapshot();
    return snapshot_;
}

void LUFSMeterAnalyzer::processLoudnessSample(float left, float right) {
    if (ringBufferL_.empty()) {
        return;
    }

    const double kwL = applyBiquad(rlbCoeffs_, rlbFilterL_, applyBiquad(preCoeffs_, preFilterL_, left));
    const double kwR = applyBiquad(rlbCoeffs_, rlbFilterR_, applyBiquad(preCoeffs_, preFilterR_, right));
    ringBufferL_[ringBufferPos_] = kwL * kwL;
    ringBufferR_[ringBufferPos_] = kwR * kwR;
    ringBufferPos_ = (ringBufferPos_ + 1) % ringBufferL_.size();
    if (ringBufferFilled_ < ringBufferL_.size()) {
        ringBufferFilled_ += 1;
    }

    integratedHopCounter_ += 1;
    const size_t hopSamples = std::max<size_t>(
        1,
        static_cast<size_t>(std::round(static_cast<double>(sampleRate_) * INTEGRATED_HOP_S))
    );
    const size_t blockSamples = std::max<size_t>(
        1,
        static_cast<size_t>(std::round(static_cast<double>(sampleRate_) * INTEGRATED_BLOCK_S))
    );
    if (integratedHopCounter_ < hopSamples || ringBufferFilled_ < blockSamples) {
        return;
    }

    double sumL = 0.0;
    double sumR = 0.0;
    const size_t bufferLength = ringBufferL_.size();
    for (size_t index = 0; index < blockSamples; index += 1) {
        const size_t bufferIndex = (ringBufferPos_ + bufferLength - 1 - index) % bufferLength;
        sumL += ringBufferL_[bufferIndex];
        sumR += ringBufferR_[bufferIndex];
    }

    const double blockPower = std::max((sumL / blockSamples) + (sumR / blockSamples), 1e-10);
    const double blockLUFS = -0.691 + 10.0 * std::log10(blockPower);
    if (blockLUFS > ABSOLUTE_GATE_LUFS) {
        const size_t histogramIndex = histogramIndexFromLufs(blockLUFS);
        integratedHistogramCounts_[histogramIndex] += 1;
        integratedHistogramPowerSums_[histogramIndex] += blockPower;
    }
    integratedHopCounter_ = 0;
}

void LUFSMeterAnalyzer::updateMomentaryShortTermLoudness() {
    if (ringBufferL_.empty() || ringBufferFilled_ == 0) {
        snapshot_.momentaryLUFS = static_cast<float>(METER_MIN_LUFS);
        snapshot_.shortTermLUFS = static_cast<float>(METER_MIN_LUFS);
        return;
    }

    const size_t bufferLength = ringBufferL_.size();
    const auto computeWindow = [&](double seconds) -> double {
        const size_t samples = std::min(
            static_cast<size_t>(std::round(static_cast<double>(sampleRate_) * seconds)),
            ringBufferFilled_
        );
        if (samples == 0) {
            return METER_MIN_LUFS;
        }

        double sumL = 0.0;
        double sumR = 0.0;
        for (size_t index = 0; index < samples; index += 1) {
            const size_t bufferIndex = (ringBufferPos_ + bufferLength - 1 - index) % bufferLength;
            sumL += ringBufferL_[bufferIndex];
            sumR += ringBufferR_[bufferIndex];
        }

        const double power = std::max((sumL / samples) + (sumR / samples), 1e-10);
        return std::max(METER_MIN_LUFS, -0.691 + 10.0 * std::log10(power));
    };

    snapshot_.momentaryLUFS = static_cast<float>(computeWindow(MOMENTARY_WINDOW_S));
    snapshot_.shortTermLUFS = static_cast<float>(computeWindow(SHORT_TERM_WINDOW_S));
}

double LUFSMeterAnalyzer::computeGatedIntegratedLoudness() const {
    uint64_t absoluteCount = 0;
    double absolutePowerSum = 0.0;
    for (size_t index = 0; index < integratedHistogramCounts_.size(); index += 1) {
        const uint32_t count = integratedHistogramCounts_[index];
        if (count == 0) {
            continue;
        }
        absoluteCount += count;
        absolutePowerSum += integratedHistogramPowerSums_[index];
    }
    if (absoluteCount == 0 || absolutePowerSum <= 0.0) {
        return METER_MIN_LUFS;
    }

    const double ungatedMean = -0.691 + 10.0 * std::log10(absolutePowerSum / absoluteCount);
    const double relativeThreshold = ungatedMean + RELATIVE_GATE_OFFSET;

    uint64_t relativeCount = 0;
    double relativePowerSum = 0.0;
    for (size_t index = 0; index < integratedHistogramCounts_.size(); index += 1) {
        const uint32_t count = integratedHistogramCounts_[index];
        if (count == 0 || histogramLufsAtIndex(index) <= relativeThreshold) {
            continue;
        }
        relativeCount += count;
        relativePowerSum += integratedHistogramPowerSums_[index];
    }
    if (relativeCount == 0 || relativePowerSum <= 0.0) {
        return METER_MIN_LUFS;
    }

    return std::max(METER_MIN_LUFS, -0.691 + 10.0 * std::log10(relativePowerSum / relativeCount));
}

size_t LUFSMeterAnalyzer::histogramIndexFromLufs(double lufs) const {
    const double normalized = (lufs - INTEGRATED_HISTOGRAM_MIN_LUFS) / INTEGRATED_HISTOGRAM_BIN_WIDTH;
    const long rounded = static_cast<long>(std::llround(normalized));
    return static_cast<size_t>(std::clamp<long>(
        rounded,
        0,
        static_cast<long>(integratedHistogramCounts_.size() - 1)
    ));
}

double LUFSMeterAnalyzer::histogramLufsAtIndex(size_t index) const {
    return INTEGRATED_HISTOGRAM_MIN_LUFS + (static_cast<double>(index) * INTEGRATED_HISTOGRAM_BIN_WIDTH);
}

double LUFSMeterAnalyzer::applyBiquad(const BiquadCoeffs& coeffs, BiquadState& state, double input) {
    const double output = coeffs.b0 * input + coeffs.b1 * state.x1 + coeffs.b2 * state.x2
        - coeffs.a1 * state.y1 - coeffs.a2 * state.y2;
    state.x2 = state.x1;
    state.x1 = input;
    state.y2 = state.y1;
    state.y1 = output;
    return output;
}

void LUFSMeterAnalyzer::processFastMeterSample(float left, float right, double& maxPeakL, double& maxPeakR) {
    if (fastSqL_.empty()) {
        return;
    }

    const double sqL = static_cast<double>(left) * left;
    const double sqR = static_cast<double>(right) * right;
    const double cross = static_cast<double>(left) * right;

    if (fastSampleCount_ == integrationWindowSamples_) {
        fastSumSqL_ = std::max(0.0, fastSumSqL_ - fastSqL_[fastWriteIndex_]);
        fastSumSqR_ = std::max(0.0, fastSumSqR_ - fastSqR_[fastWriteIndex_]);
        fastSumCross_ -= fastCross_[fastWriteIndex_];
    } else {
        fastSampleCount_ += 1;
    }

    fastSqL_[fastWriteIndex_] = sqL;
    fastSqR_[fastWriteIndex_] = sqR;
    fastCross_[fastWriteIndex_] = cross;
    fastSumSqL_ += sqL;
    fastSumSqR_ += sqR;
    fastSumCross_ += cross;
    fastWriteIndex_ = (fastWriteIndex_ + 1) % integrationWindowSamples_;

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

void LUFSMeterAnalyzer::advancePeaks(double nowMs) {
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

void LUFSMeterAnalyzer::maybeUpdatePeak(double peakDb, double nowMs, bool leftChannel) {
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

double LUFSMeterAnalyzer::applyPeakDecay(double currentDb, double holdUntilMs, double nowMs) const {
    const double decayStartMs = std::max(lastPeakUpdateMs_, holdUntilMs);
    if (nowMs <= decayStartMs) {
        return currentDb;
    }

    const double decayAmount = ((nowMs - decayStartMs) / 1000.0) * VU_PEAK_DECAY_DB_PER_SECOND;
    return std::max(VU_METER_MIN_DB, currentDb - decayAmount);
}

void LUFSMeterAnalyzer::recomputeFastSnapshot() {
    if (fastSampleCount_ == 0) {
        snapshot_.vuLDb = static_cast<float>(VU_METER_MIN_DB);
        snapshot_.vuRDb = static_cast<float>(VU_METER_MIN_DB);
        snapshot_.barLDb = static_cast<float>(amplitudeToDb(barEnvelopeL_));
        snapshot_.barRDb = static_cast<float>(amplitudeToDb(barEnvelopeR_));
        snapshot_.correlation = 0.0f;
        return;
    }

    const double meanSqL = std::max(0.0, fastSumSqL_) / fastSampleCount_;
    const double meanSqR = std::max(0.0, fastSumSqR_) / fastSampleCount_;
    const double denominator = std::sqrt(std::max(0.0, fastSumSqL_) * std::max(0.0, fastSumSqR_));

    snapshot_.vuLDb = static_cast<float>(amplitudeToDb(std::sqrt(meanSqL)));
    snapshot_.vuRDb = static_cast<float>(amplitudeToDb(std::sqrt(meanSqR)));
    snapshot_.barLDb = static_cast<float>(amplitudeToDb(barEnvelopeL_));
    snapshot_.barRDb = static_cast<float>(amplitudeToDb(barEnvelopeR_));
    snapshot_.correlation = denominator > 1e-10
        ? static_cast<float>(std::clamp(fastSumCross_ / denominator, -1.0, 1.0))
        : 0.0f;
}

double LUFSMeterAnalyzer::currentTimeMs() {
    using Clock = std::chrono::steady_clock;
    const auto now = Clock::now().time_since_epoch();
    return std::chrono::duration<double, std::milli>(now).count();
}

double LUFSMeterAnalyzer::amplitudeToDb(double amplitude) {
    if (!std::isfinite(amplitude) || amplitude <= 0.0) {
        return VU_METER_MIN_DB;
    }
    return clampDb(20.0 * std::log10(std::max(amplitude, 1e-10)), VU_METER_MIN_DB, VU_METER_MAX_DB);
}

double LUFSMeterAnalyzer::clampDb(double db, double minDb, double maxDb) {
    return std::max(minDb, std::min(maxDb, db));
}

LUFSMeterAnalyzer::BiquadCoeffs LUFSMeterAnalyzer::preFilterCoeffs(double sampleRate) {
    const double K = std::tan(PI * PRE_FILTER_F0_HZ / sampleRate);
    const double Vh = std::pow(10.0, PRE_FILTER_GAIN_DB / 20.0);
    const double Vb = std::pow(Vh, 0.499666774155997);
    const double KK = K * K;
    const double a0 = 1.0 + K / PRE_FILTER_Q + KK;
    return {
        (Vh + (Vb * K) / PRE_FILTER_Q + KK) / a0,
        (2.0 * (KK - Vh)) / a0,
        (Vh - (Vb * K) / PRE_FILTER_Q + KK) / a0,
        (2.0 * (KK - 1.0)) / a0,
        (1.0 - K / PRE_FILTER_Q + KK) / a0,
    };
}

LUFSMeterAnalyzer::BiquadCoeffs LUFSMeterAnalyzer::rlbFilterCoeffs(double sampleRate) {
    const double K = std::tan(PI * RLB_FILTER_F0_HZ / sampleRate);
    const double KK = K * K;
    const double a0 = 1.0 + K / RLB_FILTER_Q + KK;
    return {
        1.0,
        -2.0,
        1.0,
        (2.0 * (KK - 1.0)) / a0,
        (1.0 - K / RLB_FILTER_Q + KK) / a0,
    };
}

} // namespace Visualizer
