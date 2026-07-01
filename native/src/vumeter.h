#pragma once

#include <cstddef>
#include <vector>

namespace Visualizer {

struct VUMeterSnapshot {
    float vuLDb;
    float vuRDb;
    float barLDb;
    float barRDb;
    float peakLDb;
    float peakRDb;
    float correlation;
};

class VUMeterAnalyzer {
public:
    VUMeterAnalyzer();

    void setSampleRate(float sampleRate);
    void pushSamples(const float* leftChannel, const float* rightChannel, size_t length);
    VUMeterSnapshot getSnapshot();
    void reset();

private:
    void configureForSampleRate(float sampleRate);
    void processSample(float left, float right, double& maxPeakL, double& maxPeakR);
    void advancePeaks(double nowMs);
    void maybeUpdatePeak(double peakDb, double nowMs, bool leftChannel);
    double applyPeakDecay(double currentDb, double holdUntilMs, double nowMs) const;
    void recomputeSnapshot();

    static double currentTimeMs();
    static double amplitudeToDb(double amplitude);
    static double clampDb(double db, double minDb, double maxDb);

    float sampleRate_ = 48000.0f;
    size_t integrationWindowSamples_ = 1;
    std::vector<double> sqL_;
    std::vector<double> sqR_;
    std::vector<double> cross_;
    size_t writeIndex_ = 0;
    size_t sampleCount_ = 0;
    double sumSqL_ = 0.0;
    double sumSqR_ = 0.0;
    double sumCross_ = 0.0;
    double barEnvelopeL_ = 0.0;
    double barEnvelopeR_ = 0.0;
    double barAttackCoeff_ = 0.0;
    double barReleaseCoeff_ = 0.0;
    double peakHoldUntilL_ = 0.0;
    double peakHoldUntilR_ = 0.0;
    double lastPeakUpdateMs_ = 0.0;
    bool hasLastPeakUpdate_ = false;
    VUMeterSnapshot snapshot_{};
};

} // namespace Visualizer
