#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace Visualizer {

struct LUFSMeterSnapshot {
    float momentaryLUFS;
    float shortTermLUFS;
    float integratedLUFS;
    float vuLDb;
    float vuRDb;
    float barLDb;
    float barRDb;
    float peakLDb;
    float peakRDb;
    float correlation;
};

class LUFSMeterAnalyzer {
public:
    LUFSMeterAnalyzer();

    void setSampleRate(float sampleRate);
    void pushSamples(const float* leftChannel, const float* rightChannel, size_t length);
    LUFSMeterSnapshot getSnapshot();
    void reset();

private:
    struct BiquadCoeffs {
        double b0;
        double b1;
        double b2;
        double a1;
        double a2;
    };

    struct BiquadState {
        double x1 = 0.0;
        double x2 = 0.0;
        double y1 = 0.0;
        double y2 = 0.0;
    };

    void configureForSampleRate(float sampleRate);
    void configureKWeighting();
    void configureFastMeter();
    void processLoudnessSample(float left, float right);
    void updateMomentaryShortTermLoudness();
    double computeGatedIntegratedLoudness() const;
    size_t histogramIndexFromLufs(double lufs) const;
    double histogramLufsAtIndex(size_t index) const;
    double applyBiquad(const BiquadCoeffs& coeffs, BiquadState& state, double input);

    void processFastMeterSample(float left, float right, double& maxPeakL, double& maxPeakR);
    void advancePeaks(double nowMs);
    void maybeUpdatePeak(double peakDb, double nowMs, bool leftChannel);
    double applyPeakDecay(double currentDb, double holdUntilMs, double nowMs) const;
    void recomputeFastSnapshot();
    static double currentTimeMs();
    static double amplitudeToDb(double amplitude);
    static double clampDb(double db, double minDb, double maxDb);
    static BiquadCoeffs preFilterCoeffs(double sampleRate);
    static BiquadCoeffs rlbFilterCoeffs(double sampleRate);

    float sampleRate_ = 48000.0f;
    BiquadCoeffs preCoeffs_{};
    BiquadCoeffs rlbCoeffs_{};
    BiquadState preFilterL_;
    BiquadState preFilterR_;
    BiquadState rlbFilterL_;
    BiquadState rlbFilterR_;

    std::vector<double> ringBufferL_;
    std::vector<double> ringBufferR_;
    size_t ringBufferPos_ = 0;
    size_t ringBufferFilled_ = 0;
    size_t integratedHopCounter_ = 0;
    std::vector<uint32_t> integratedHistogramCounts_;
    std::vector<double> integratedHistogramPowerSums_;

    size_t integrationWindowSamples_ = 1;
    std::vector<double> fastSqL_;
    std::vector<double> fastSqR_;
    std::vector<double> fastCross_;
    size_t fastWriteIndex_ = 0;
    size_t fastSampleCount_ = 0;
    double fastSumSqL_ = 0.0;
    double fastSumSqR_ = 0.0;
    double fastSumCross_ = 0.0;
    double barEnvelopeL_ = 0.0;
    double barEnvelopeR_ = 0.0;
    double barAttackCoeff_ = 0.0;
    double barReleaseCoeff_ = 0.0;
    double peakHoldUntilL_ = 0.0;
    double peakHoldUntilR_ = 0.0;
    double lastPeakUpdateMs_ = 0.0;
    bool hasLastPeakUpdate_ = false;

    LUFSMeterSnapshot snapshot_{};
};

} // namespace Visualizer
