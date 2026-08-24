/*
 * Off-audio-thread HRTF preparation for Astra's spatial renderer.
 *
 * This module owns the heavyweight HRTF dataset (embedded MIT KEMAR or an
 * in-memory AES69 SOFA file), computes Astra's tonal correction, and exports
 * final frequency-domain filters. It runs in a normal Worker; the real-time
 * AudioWorklet only receives and convolves the prepared spectra.
 */

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>

#include "SpatialaudioConfig.h"
#include "hrtf/mit_hrtf.h"
#include "kiss_fft/kiss_fftr.h"
#include "mysofa.h"

namespace {

constexpr int MAX_HRTF_TAPS = 8192;
constexpr int FILTER_PRE_DELAY = 64;
constexpr int FILTER_FADE_SAMPLES = 48;
constexpr float FILTER_RING_SECONDS = 0.006f;
constexpr float BASS_XOVER_HZ = 200.0f;
constexpr float DFEQ_MAX_GAIN = 3.981f;
constexpr float DFEQ_MIN_GAIN = 0.2512f;
constexpr float REF_BAND_LO_HZ = 400.0f;
constexpr float REF_BAND_HI_HZ = 3000.0f;

enum PrepError {
  PREP_OK = 0,
  PREP_UNSUPPORTED_SAMPLE_RATE = 1,
  PREP_INVALID_SOFA = 2,
  PREP_UNSUPPORTED_SOFA = 3,
  PREP_FILTER_TOO_LONG = 4,
  PREP_OUT_OF_MEMORY = 5,
  PREP_FILTER_LOOKUP_FAILED = 6,
};

struct PrepState {
  int error = PREP_OK;
  int sampleRate = 0;
  int blockSize = 0;
  int taps = 0;
  int sofaFilterLength = 0;
  int fftSize = 0;
  int fftBins = 0;
  int filterLen = 0;
  float fftScaler = 1.0f;
  float globalScale = 1.0f;

  spaudio::MIT_HRTF* mit = nullptr;
  MYSOFA_EASY* sofa = nullptr;
  kiss_fftr_cfg fftFwd = nullptr;
  kiss_fftr_cfg fftInv = nullptr;

  float* sofaRaw[2] = {nullptr, nullptr};
  float* hrtf[2] = {nullptr, nullptr};
  float* time = nullptr;
  float* ir = nullptr;
  float* dfeq = nullptr;
  kiss_fft_cpx* frequency = nullptr;
  kiss_fft_cpx* baked[2] = {nullptr, nullptr};
};

PrepState g;

void freeAll() {
  delete g.mit;
  if (g.sofa) mysofa_close(g.sofa);
  if (g.fftFwd) kiss_fftr_free(g.fftFwd);
  if (g.fftInv) kiss_fftr_free(g.fftInv);
  for (int ear = 0; ear < 2; ear++) {
    std::free(g.sofaRaw[ear]);
    std::free(g.hrtf[ear]);
    std::free(g.baked[ear]);
  }
  std::free(g.time);
  std::free(g.ir);
  std::free(g.dfeq);
  std::free(g.frequency);
  g = PrepState{};
}

void setError(int error) { g.error = error; }

float binFrequencyHz(int bin) {
  return static_cast<float>(bin) * static_cast<float>(g.sampleRate) / static_cast<float>(g.fftSize);
}

float bassLowpassShare(float freqHz) {
  const float ratio = freqHz / BASS_XOVER_HZ;
  return 1.0f / (1.0f + ratio * ratio * ratio * ratio);
}

bool allocateCommon(int sampleRate, int blockSize, int taps) {
  if (blockSize <= 0 || blockSize > 1024 || taps <= 0 || taps > MAX_HRTF_TAPS) {
    setError(taps > MAX_HRTF_TAPS ? PREP_FILTER_TOO_LONG : PREP_UNSUPPORTED_SAMPLE_RATE);
    return false;
  }
  g.sampleRate = sampleRate;
  g.blockSize = blockSize;
  g.taps = taps;
  const int ringSamples = static_cast<int>(FILTER_RING_SECONDS * static_cast<float>(sampleRate));
  const int neededFilterLen = taps + FILTER_PRE_DELAY + ringSamples;
  g.fftSize = 1;
  while (g.fftSize - blockSize < neededFilterLen) g.fftSize <<= 1;
  g.filterLen = g.fftSize - blockSize;
  g.fftBins = g.fftSize / 2 + 1;
  g.fftScaler = 1.0f / static_cast<float>(g.fftSize);

  g.fftFwd = kiss_fftr_alloc(g.fftSize, 0, nullptr, nullptr);
  g.fftInv = kiss_fftr_alloc(g.fftSize, 1, nullptr, nullptr);
  g.time = static_cast<float*>(std::calloc(g.fftSize, sizeof(float)));
  g.ir = static_cast<float*>(std::calloc(g.fftSize, sizeof(float)));
  g.dfeq = static_cast<float*>(std::calloc(g.fftBins, sizeof(float)));
  g.frequency = static_cast<kiss_fft_cpx*>(std::calloc(g.fftBins, sizeof(kiss_fft_cpx)));
  for (int ear = 0; ear < 2; ear++) {
    g.hrtf[ear] = static_cast<float*>(std::calloc(g.taps, sizeof(float)));
    g.baked[ear] = static_cast<kiss_fft_cpx*>(std::calloc(g.fftBins, sizeof(kiss_fft_cpx)));
  }
  if (!g.fftFwd || !g.fftInv || !g.time || !g.ir || !g.dfeq || !g.frequency ||
      !g.hrtf[0] || !g.hrtf[1] || !g.baked[0] || !g.baked[1]) {
    setError(PREP_OUT_OF_MEMORY);
    return false;
  }
  return true;
}

bool queryHrtf(float azimuthRad, float elevationRad) {
  float* outputs[2] = {g.hrtf[0], g.hrtf[1]};
  if (g.mit) return g.mit->get(azimuthRad, elevationRad, outputs);
  if (!g.sofa) return false;

  float position[3] = {
    azimuthRad * 180.0f / static_cast<float>(M_PI),
    elevationRad * 180.0f / static_cast<float>(M_PI),
    1.0f,
  };
  mysofa_s2c(position);
  float delaysSeconds[2] = {0.0f, 0.0f};
  mysofa_getfilter_float(
    g.sofa,
    position[0], position[1], position[2],
    g.sofaRaw[0], g.sofaRaw[1],
    &delaysSeconds[0], &delaysSeconds[1]
  );
  for (int ear = 0; ear < 2; ear++) {
    const int delaySamples = std::max(0, static_cast<int>(std::round(delaysSeconds[ear] * g.sampleRate)));
    if (delaySamples + g.sofaFilterLength > g.taps) return false;
    std::memset(g.hrtf[ear], 0, g.taps * sizeof(float));
    std::memcpy(g.hrtf[ear] + delaySamples, g.sofaRaw[ear], g.sofaFilterLength * sizeof(float));
  }
  return true;
}

bool bake(float azimuthRad, float elevationRad, kiss_fft_cpx* destination[2]) {
  if (!queryHrtf(azimuthRad, elevationRad)) return false;
  for (int ear = 0; ear < 2; ear++) {
    int onset = 0;
    float peak = 0.0f;
    for (int tap = 0; tap < g.taps; tap++) {
      const float magnitude = std::fabs(g.hrtf[ear][tap]);
      if (magnitude > peak) {
        peak = magnitude;
        onset = tap;
      }
    }

    std::memcpy(g.time, g.hrtf[ear], g.taps * sizeof(float));
    std::memset(g.time + g.taps, 0, (g.fftSize - g.taps) * sizeof(float));
    kiss_fftr(g.fftFwd, g.time, g.frequency);
    for (int bin = 0; bin < g.fftBins; bin++) {
      const float low = bassLowpassShare(binFrequencyHz(bin));
      const float high = 1.0f - low;
      const float equalizedHigh = g.dfeq[bin] * high;
      float real = g.frequency[bin].r * equalizedHigh;
      float imaginary = g.frequency[bin].i * equalizedHigh;
      const float phase = (-2.0f * static_cast<float>(M_PI) * bin * onset) / g.fftSize;
      real += low * std::cos(phase);
      imaginary += low * std::sin(phase);
      g.frequency[bin].r = real * g.globalScale;
      g.frequency[bin].i = imaginary * g.globalScale;
    }

    kiss_fftri(g.fftInv, g.frequency, g.time);
    for (int sample = 0; sample < g.filterLen; sample++) {
      const int source = (sample - FILTER_PRE_DELAY + g.fftSize) % g.fftSize;
      float value = g.time[source] * g.fftScaler;
      const int fromEnd = g.filterLen - 1 - sample;
      if (fromEnd < FILTER_FADE_SAMPLES) {
        const float x = static_cast<float>(fromEnd) / FILTER_FADE_SAMPLES;
        value *= 0.5f - 0.5f * std::cos(static_cast<float>(M_PI) * x);
      }
      g.ir[sample] = value;
    }
    std::memset(g.ir + g.filterLen, 0, (g.fftSize - g.filterLen) * sizeof(float));
    kiss_fftr(g.fftFwd, g.ir, destination[ear]);
  }
  return true;
}

bool computeDiffuseFieldEq() {
  double* power = static_cast<double*>(std::calloc(g.fftBins, sizeof(double)));
  double* smoothed = static_cast<double*>(std::calloc(g.fftBins, sizeof(double)));
  if (!power || !smoothed) {
    std::free(power);
    std::free(smoothed);
    return false;
  }
  int sampledDirections = 0;
  for (int azimuth = -180; azimuth < 180; azimuth += 10) {
    if (!queryHrtf(azimuth * static_cast<float>(M_PI) / 180.0f, 0.0f)) continue;
    for (int ear = 0; ear < 2; ear++) {
      std::memcpy(g.time, g.hrtf[ear], g.taps * sizeof(float));
      std::memset(g.time + g.taps, 0, (g.fftSize - g.taps) * sizeof(float));
      kiss_fftr(g.fftFwd, g.time, g.frequency);
      for (int bin = 0; bin < g.fftBins; bin++) {
        power[bin] += static_cast<double>(g.frequency[bin].r) * g.frequency[bin].r +
                      static_cast<double>(g.frequency[bin].i) * g.frequency[bin].i;
      }
    }
    sampledDirections++;
  }
  if (sampledDirections == 0) {
    std::free(power);
    std::free(smoothed);
    return false;
  }
  for (int pass = 0; pass < 2; pass++) {
    for (int bin = 0; bin < g.fftBins; bin++) {
      const int halfWidth = std::max(2, bin / 8);
      const int low = std::max(0, bin - halfWidth);
      const int high = std::min(g.fftBins - 1, bin + halfWidth);
      double sum = 0.0;
      for (int index = low; index <= high; index++) sum += power[index];
      smoothed[bin] = sum / static_cast<double>(high - low + 1);
    }
    std::memcpy(power, smoothed, g.fftBins * sizeof(double));
  }
  double referenceSum = 0.0;
  int referenceCount = 0;
  for (int bin = 0; bin < g.fftBins; bin++) {
    const float frequency = binFrequencyHz(bin);
    if (frequency >= REF_BAND_LO_HZ && frequency <= REF_BAND_HI_HZ) {
      referenceSum += power[bin];
      referenceCount++;
    }
  }
  if (referenceCount == 0 || referenceSum <= 0.0) {
    std::free(power);
    std::free(smoothed);
    return false;
  }
  const double referencePower = referenceSum / referenceCount;
  for (int bin = 0; bin < g.fftBins; bin++) {
    const double value = std::max(1e-12, power[bin]);
    g.dfeq[bin] = std::clamp(
      static_cast<float>(std::sqrt(referencePower / value)),
      DFEQ_MIN_GAIN,
      DFEQ_MAX_GAIN
    );
  }
  std::free(power);
  std::free(smoothed);
  return true;
}

bool computeGlobalScale() {
  kiss_fft_cpx* probe[2] = {
    static_cast<kiss_fft_cpx*>(std::calloc(g.fftBins, sizeof(kiss_fft_cpx))),
    static_cast<kiss_fft_cpx*>(std::calloc(g.fftBins, sizeof(kiss_fft_cpx))),
  };
  if (!probe[0] || !probe[1]) {
    std::free(probe[0]);
    std::free(probe[1]);
    return false;
  }
  g.globalScale = 1.0f;
  const bool baked = bake(0.0f, 0.0f, probe);
  double sumSquares = 0.0;
  int count = 0;
  if (baked) {
    for (int ear = 0; ear < 2; ear++) {
      for (int bin = 0; bin < g.fftBins; bin++) {
        const float frequency = binFrequencyHz(bin);
        if (frequency < REF_BAND_LO_HZ || frequency > REF_BAND_HI_HZ) continue;
        sumSquares += static_cast<double>(probe[ear][bin].r) * probe[ear][bin].r +
                      static_cast<double>(probe[ear][bin].i) * probe[ear][bin].i;
        count++;
      }
    }
  }
  std::free(probe[0]);
  std::free(probe[1]);
  if (count == 0 || sumSquares <= 0.0) return false;
  g.globalScale = static_cast<float>(1.0 / std::sqrt(sumSquares / count));
  return true;
}

bool finishInitialization() {
  if (!computeDiffuseFieldEq() || !computeGlobalScale()) {
    setError(PREP_FILTER_LOOKUP_FAILED);
    return false;
  }
  setError(PREP_OK);
  return true;
}

int mapMySofaError(int error) {
  if (error == MYSOFA_NO_MEMORY) return PREP_OUT_OF_MEMORY;
  if (error == MYSOFA_INVALID_DIMENSIONS || error == MYSOFA_INVALID_DIMENSION_LIST ||
      error == MYSOFA_INVALID_COORDINATE_TYPE || error == MYSOFA_ONLY_EMITTER_WITH_ECI_SUPPORTED ||
      error == MYSOFA_ONLY_DELAYS_WITH_IR_OR_MR_SUPPORTED ||
      error == MYSOFA_ONLY_THE_SAME_SAMPLING_RATE_SUPPORTED ||
      error == MYSOFA_RECEIVERS_WITH_RCI_SUPPORTED || error == MYSOFA_RECEIVERS_WITH_CARTESIAN_SUPPORTED ||
      error == MYSOFA_INVALID_RECEIVER_POSITIONS || error == MYSOFA_ONLY_SOURCES_WITH_MC_SUPPORTED) {
    return PREP_UNSUPPORTED_SOFA;
  }
  return PREP_INVALID_SOFA;
}

}  // namespace

extern "C" {

int hrtf_prep_init_builtin(int sampleRate, int blockSize) {
  freeAll();
  g.mit = new spaudio::MIT_HRTF(static_cast<unsigned>(sampleRate));
  if (!g.mit || !g.mit->isLoaded()) {
    setError(PREP_UNSUPPORTED_SAMPLE_RATE);
    return 0;
  }
  if (!allocateCommon(sampleRate, blockSize, static_cast<int>(g.mit->getHRTFLen()))) return 0;
  return finishInitialization() ? g.taps : 0;
}

int hrtf_prep_init_sofa(int sampleRate, int blockSize, const unsigned char* bytes, int byteLength) {
  freeAll();
  if (!bytes || byteLength <= 0) {
    setError(PREP_INVALID_SOFA);
    return 0;
  }
  int mysofaError = MYSOFA_OK;
  int filterLength = 0;
  g.sofa = mysofa_open_data(
    reinterpret_cast<const char*>(bytes), byteLength, static_cast<float>(sampleRate), &filterLength, &mysofaError
  );
  if (!g.sofa) {
    setError(mapMySofaError(mysofaError));
    return 0;
  }
  if (!g.sofa->hrtf || g.sofa->hrtf->R != 2 || filterLength <= 0) {
    setError(PREP_UNSUPPORTED_SOFA);
    return 0;
  }

  int maxDelaySamples = 0;
  for (unsigned index = 0; index < g.sofa->hrtf->DataDelay.elements; index++) {
    maxDelaySamples = std::max(
      maxDelaySamples,
      static_cast<int>(std::ceil(std::max(0.0f, g.sofa->hrtf->DataDelay.values[index]) * sampleRate))
    );
  }
  // The managed-library limit applies to the effective HRIR: the resampled
  // FIR plus its explicit SOFA delay. `ceil` above already leaves enough
  // room for the rounded delay returned by mysofa_getfilter_float().
  const int taps = filterLength + maxDelaySamples;
  if (taps > MAX_HRTF_TAPS) {
    setError(PREP_FILTER_TOO_LONG);
    return 0;
  }
  g.sofaFilterLength = filterLength;
  for (int ear = 0; ear < 2; ear++) {
    g.sofaRaw[ear] = static_cast<float*>(std::calloc(filterLength, sizeof(float)));
  }
  if (!g.sofaRaw[0] || !g.sofaRaw[1]) {
    setError(PREP_OUT_OF_MEMORY);
    return 0;
  }
  if (!allocateCommon(sampleRate, blockSize, taps)) return 0;
  return finishInitialization() ? g.taps : 0;
}

int hrtf_prep_bake(float azimuthRad, float elevationRad) {
  if (!g.fftFwd || !g.baked[0] || !g.baked[1]) return 0;
  kiss_fft_cpx* destination[2] = {g.baked[0], g.baked[1]};
  if (!bake(azimuthRad, elevationRad, destination)) {
    setError(PREP_FILTER_LOOKUP_FAILED);
    return 0;
  }
  setError(PREP_OK);
  return 1;
}

float* hrtf_prep_filter_ptr(int ear) {
  if (ear < 0 || ear > 1) return nullptr;
  return reinterpret_cast<float*>(g.baked[ear]);
}

int hrtf_prep_last_error() { return g.error; }
int hrtf_prep_taps() { return g.taps; }
int hrtf_prep_fft_size() { return g.fftSize; }
int hrtf_prep_fft_bins() { return g.fftBins; }
int hrtf_prep_filter_len() { return g.filterLen; }
void hrtf_prep_reset() { freeAll(); }

}
