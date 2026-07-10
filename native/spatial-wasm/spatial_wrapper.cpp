/*
 * Astra spatial binaural renderer — WASM wrapper over libspatialaudio.
 *
 * Renders N virtual speaker feeds to binaural stereo by direct per-speaker
 * HRTF convolution (the SpeakersBinauralizer algorithm from libspatialaudio,
 * reimplemented here so filters can be re-baked per speaker while playback
 * runs — dragging a speaker in the Virtual Speaker Room must not reset the
 * convolution overlap state or the other speakers' filters).
 *
 * Azimuth convention: this API takes RADIANS in libspatialaudio's ambisonic
 * convention — positive azimuth is counterclockwise, i.e. to the listener's
 * LEFT. The renderer UI works in degrees clockwise-from-front (FR = +30°),
 * mapped as `rad = -deg * PI / 180` (see uiDegreesToAmbisonicRadians in
 * src/renderer/utils/virtualSpeakerLayout.ts). MIT_HRTF::get() negates again
 * into the MIT dataset's clockwise-positive degrees.
 *
 * Timbre correction (baked into the filters, zero runtime cost):
 *  - Diffuse-field EQ: the raw KEMAR responses carry the dummy head's ear
 *    canal/concha resonance (~2-3 kHz), which headphones re-apply on top of
 *    the listener's own ears — heard as a tinny, "pressurized" sound. At init
 *    we average the HRTF power over a full azimuth ring, smooth it, and bake
 *    the (clamped) inverse into every filter. Both ears share one EQ curve,
 *    so ILD/ITD cues are preserved exactly.
 *  - Bass crossover: the MIT measurement speaker rolls off low frequencies
 *    and there are almost no directional cues below ~200 Hz anyway. Below
 *    BASS_XOVER_HZ each filter cross-fades to a dry unity path (delayed to
 *    the HRIR's bulk delay so the crossover region stays phase-coherent).
 *  - Loudness: filters are normalized so a front-center source renders at
 *    ~unity broadband gain, then OUTPUT_HEADROOM (-3 dB) is applied.
 *
 * Filter changes fade over FADE_BLOCKS render quanta (per-bin linear
 * interpolation of the frequency-domain filters, equivalent to impulse
 * response interpolation) to avoid clicks while dragging.
 *
 * LFE feeds bypass the HRTF entirely and mix equally into both ears.
 *
 * Elevation is UI-exposed; callers must clamp to the MIT HRTF's measured
 * range (-40°..+90°) — spatial_set_speaker returns 0 and keeps the previous
 * filter when the bake fails outside it.
 *
 * Deferred hooks (v2+): distance/per-speaker gain are accepted but gain is
 * currently always 1.0; SOFA HRTFs can replace MIT_HRTF behind the same
 * spaudio::HRTF interface.
 *
 * Supported sample rates (embedded MIT KEMAR HRTF): 44100, 48000, 88200,
 * 96000. spatial_init() returns 0 for anything else and the caller must
 * bypass.
 */

#include <cmath>
#include <cstdlib>
#include <cstring>

#include "SpatialaudioConfig.h"
#include "hrtf/mit_hrtf.h"
#include "kiss_fft/kiss_fftr.h"

namespace {

constexpr int MAX_SPEAKERS = 12; // fits 7.1.4 (bed + 4 heights)
constexpr int FADE_BLOCKS = 4;
// Equal-power feed of the non-positional LFE channel into both ears.
const float LFE_EAR_GAIN = std::sqrt(0.5f);
// Static headroom: binaural rendering has real peak gain over the source —
// the ipsilateral ear of an off-center speaker sits several dB above the
// front-center reference, and correlated content sums across speakers at
// each ear. Measured single-channel worst case is ~1.9x input peak before
// this scale. 0.55 keeps typical material below the limiter threshold so the
// limiter only catches genuine overs.
constexpr float OUTPUT_HEADROOM = 0.55f;
// Look-ahead brick-wall limiter (one render quantum of look-ahead, ~2.9 ms
// added latency): output blocks are emitted one block late, so the gain can
// ramp down across a full block BEFORE a peak plays — no reactive kinks, no
// waveshaping. One gain for both ears keeps imaging intact; below the
// threshold it is bit-transparent.
constexpr float LIMIT_THRESHOLD = 0.98f;
constexpr float LIMIT_RELEASE_SECONDS = 0.25f;
// Emergency ceiling for block-granularity slack; effectively never active.
constexpr float SOFT_CEIL_START = 0.995f;
// Below this the dry path takes over (no directional cues, weak HRIR data).
constexpr float BASS_XOVER_HZ = 200.0f;
// The DF-EQ and crossover are zero-phase magnitude curves, so the composed
// filter rings before and after the raw HRIR. Baked filters are therefore
// re-windowed in the time domain: shifted right by FILTER_PRE_DELAY (makes
// the pre-ring causal), truncated to filterLen with a fade, and only then
// used for overlap-add. This keeps the convolution exactly linear —
// without it the dropped/wrapped remainder is block-position-dependent and
// audible as broadband static (-26 dB!) on all material.
constexpr int FILTER_PRE_DELAY = 64;
constexpr int FILTER_FADE_SAMPLES = 48;
// Post-HRIR ring budget, in seconds, used to size the FFT.
constexpr float FILTER_RING_SECONDS = 0.006f;
// Diffuse-field EQ inversion limits.
constexpr float DFEQ_MAX_GAIN = 3.981f;   // +12 dB
constexpr float DFEQ_MIN_GAIN = 0.2512f;  // -12 dB
// Band used both as the EQ's unity reference and the loudness probe.
constexpr float REF_BAND_LO_HZ = 400.0f;
constexpr float REF_BAND_HI_HZ = 3000.0f;

struct SpeakerState {
  bool active = false;
  bool isLfe = false;
  float gain = 1.0f;
  // Frequency-domain filters, [ear][bin]. `current` is what process() uses;
  // while fadeRemaining > 0 it steps linearly toward `target`.
  kiss_fft_cpx* current[2] = {nullptr, nullptr};
  kiss_fft_cpx* target[2] = {nullptr, nullptr};
  int fadeRemaining = 0;
};

struct RendererState {
  bool ready = false;
  int sampleRate = 0;
  int blockSize = 0;
  int taps = 0;
  int fftSize = 0;
  int fftBins = 0;
  int filterLen = 0;  // windowed filter length; fftSize - blockSize
  int tailLen = 0;    // filterLen - 1
  float fftScaler = 1.0f;
  float globalScale = 1.0f;

  kiss_fftr_cfg fftFwd = nullptr;
  kiss_fftr_cfg fftInv = nullptr;
  spaudio::MIT_HRTF* hrtf = nullptr;

  SpeakerState speakers[MAX_SPEAKERS];

  float* input[MAX_SPEAKERS] = {nullptr};
  float* output[2] = {nullptr, nullptr};
  float* tail[2] = {nullptr, nullptr};
  float* lfeMix = nullptr;

  float* timeScratch = nullptr;                    // fftSize
  float* irScratch = nullptr;                      // fftSize (filter windowing)
  kiss_fft_cpx* freqScratch = nullptr;             // fftBins
  kiss_fft_cpx* freqAcc[2] = {nullptr, nullptr};   // fftBins per ear
  float* hrtfScratch[2] = {nullptr, nullptr};      // taps per ear
  float* dfeqMag = nullptr;                        // fftBins, shared both ears
  float* lfeDelay = nullptr;                       // FILTER_PRE_DELAY samples

  float limiterGain = 1.0f;
  float limiterReleasePerBlock = 0.0f;
  // Look-ahead: the block currently held back, and the gain it needs.
  float* pendingOut[2] = {nullptr, nullptr};
  float pendingRequired = 1.0f;
  bool pendingValid = false;
};

RendererState g;

void freeAll() {
  for (int i = 0; i < MAX_SPEAKERS; i++) {
    for (int ear = 0; ear < 2; ear++) {
      std::free(g.speakers[i].current[ear]);
      std::free(g.speakers[i].target[ear]);
    }
    g.speakers[i] = SpeakerState{};
    std::free(g.input[i]);
    g.input[i] = nullptr;
  }
  for (int ear = 0; ear < 2; ear++) {
    std::free(g.output[ear]);
    std::free(g.tail[ear]);
    std::free(g.freqAcc[ear]);
    std::free(g.hrtfScratch[ear]);
    std::free(g.pendingOut[ear]);
    g.output[ear] = nullptr;
    g.tail[ear] = nullptr;
    g.freqAcc[ear] = nullptr;
    g.hrtfScratch[ear] = nullptr;
    g.pendingOut[ear] = nullptr;
  }
  g.pendingValid = false;
  g.pendingRequired = 1.0f;
  std::free(g.lfeMix);
  std::free(g.timeScratch);
  std::free(g.irScratch);
  std::free(g.freqScratch);
  std::free(g.dfeqMag);
  std::free(g.lfeDelay);
  g.lfeMix = nullptr;
  g.timeScratch = nullptr;
  g.irScratch = nullptr;
  g.freqScratch = nullptr;
  g.dfeqMag = nullptr;
  g.lfeDelay = nullptr;
  if (g.fftFwd) kiss_fftr_free(g.fftFwd);
  if (g.fftInv) kiss_fftr_free(g.fftInv);
  g.fftFwd = nullptr;
  g.fftInv = nullptr;
  delete g.hrtf;
  g.hrtf = nullptr;
  g.ready = false;
}

float binFrequencyHz(int bin) {
  return static_cast<float>(bin) * static_cast<float>(g.sampleRate) / static_cast<float>(g.fftSize);
}

// Zero-phase magnitude crossover: lowpass share in [0, 1]; highpass = 1 - lp.
float bassLowpassShare(float freqHz) {
  const float ratio = freqHz / BASS_XOVER_HZ;
  return 1.0f / (1.0f + ratio * ratio * ratio * ratio);
}

/*
 * Bakes the frequency-domain filter pair for a speaker position into
 * `dst[2]`: diffuse-field-equalized HRTF above the bass crossover, a
 * bulk-delayed dry path below it, everything scaled by globalScale.
 *
 * The composed response is then made explicitly time-limited: back to the
 * time domain, shifted right by FILTER_PRE_DELAY (zero-phase EQ/crossover
 * ring becomes causal), truncated to filterLen with a raised-cosine fade,
 * and re-transformed. Overlap-add is exactly linear for such a filter; see
 * the FILTER_PRE_DELAY comment for what happens without this step.
 *
 * Returns false if the HRTF lookup fails.
 */
bool bakeFilters(float azimuthRad, float elevationRad, kiss_fft_cpx* dst[2]) {
  float* pfHRTF[2] = {g.hrtfScratch[0], g.hrtfScratch[1]};
  if (!g.hrtf->get(azimuthRad, elevationRad, pfHRTF)) return false;
  for (int ear = 0; ear < 2; ear++) {
    // Bulk delay of this ear's response, so the dry bass path lines up with
    // the convolved highs through the crossover region.
    int onset = 0;
    float peak = 0.0f;
    for (int t = 0; t < g.taps; t++) {
      const float v = std::fabs(pfHRTF[ear][t]);
      if (v > peak) {
        peak = v;
        onset = t;
      }
    }

    std::memcpy(g.timeScratch, pfHRTF[ear], g.taps * sizeof(float));
    std::memset(g.timeScratch + g.taps, 0, (g.fftSize - g.taps) * sizeof(float));
    kiss_fftr(g.fftFwd, g.timeScratch, g.freqScratch);

    for (int b = 0; b < g.fftBins; b++) {
      const float lp = bassLowpassShare(binFrequencyHz(b));
      const float hp = 1.0f - lp;
      const float eq = (g.dfeqMag ? g.dfeqMag[b] : 1.0f) * hp;
      float real = g.freqScratch[b].r * eq;
      float imag = g.freqScratch[b].i * eq;
      const float phase = (-2.0f * static_cast<float>(M_PI) * static_cast<float>(b) * static_cast<float>(onset)) / static_cast<float>(g.fftSize);
      real += lp * std::cos(phase);
      imag += lp * std::sin(phase);
      g.freqScratch[b].r = real * g.globalScale;
      g.freqScratch[b].i = imag * g.globalScale;
    }

    // Time-limit: ifft -> rotate right by FILTER_PRE_DELAY -> window to
    // filterLen -> fft. Anything past filterLen becomes a fixed (inaudible)
    // response ripple instead of block-position-dependent noise.
    kiss_fftri(g.fftInv, g.freqScratch, g.timeScratch);
    for (int n = 0; n < g.filterLen; n++) {
      const int src = (n - FILTER_PRE_DELAY + g.fftSize) % g.fftSize;
      float v = g.timeScratch[src] * g.fftScaler;
      const int fromEnd = g.filterLen - 1 - n;
      if (fromEnd < FILTER_FADE_SAMPLES) {
        const float x = static_cast<float>(fromEnd) / static_cast<float>(FILTER_FADE_SAMPLES);
        v *= 0.5f - 0.5f * std::cos(static_cast<float>(M_PI) * x);
      }
      g.irScratch[n] = v;
    }
    std::memset(g.irScratch + g.filterLen, 0, (g.fftSize - g.filterLen) * sizeof(float));
    kiss_fftr(g.fftFwd, g.irScratch, dst[ear]);
  }
  return true;
}

/*
 * Averages HRTF power over a full azimuth ring (both ears), smooths it, and
 * stores the clamped inverse in dfeqMag with the reference band at unity.
 * Returns false if no HRTF could be sampled.
 */
bool computeDiffuseFieldEq() {
  double* power = static_cast<double*>(std::calloc(g.fftBins, sizeof(double)));
  double* smoothed = static_cast<double*>(std::calloc(g.fftBins, sizeof(double)));
  if (!power || !smoothed) {
    std::free(power);
    std::free(smoothed);
    return false;
  }

  float* pfHRTF[2] = {g.hrtfScratch[0], g.hrtfScratch[1]};
  int sampledDirections = 0;
  for (int azDeg = -180; azDeg < 180; azDeg += 10) {
    const float azRad = (static_cast<float>(azDeg) * static_cast<float>(M_PI)) / 180.0f;
    if (!g.hrtf->get(azRad, 0.0f, pfHRTF)) continue;
    for (int ear = 0; ear < 2; ear++) {
      std::memcpy(g.timeScratch, pfHRTF[ear], g.taps * sizeof(float));
      std::memset(g.timeScratch + g.taps, 0, (g.fftSize - g.taps) * sizeof(float));
      kiss_fftr(g.fftFwd, g.timeScratch, g.freqScratch);
      for (int b = 0; b < g.fftBins; b++) {
        power[b] += static_cast<double>(g.freqScratch[b].r) * g.freqScratch[b].r +
                    static_cast<double>(g.freqScratch[b].i) * g.freqScratch[b].i;
      }
    }
    sampledDirections++;
  }
  if (sampledDirections == 0) {
    std::free(power);
    std::free(smoothed);
    return false;
  }

  // Two passes of a widening moving average ≈ fractional-octave smoothing.
  for (int pass = 0; pass < 2; pass++) {
    for (int b = 0; b < g.fftBins; b++) {
      const int halfWidth = b / 8 > 2 ? b / 8 : 2;
      int lo = b - halfWidth;
      int hi = b + halfWidth;
      if (lo < 0) lo = 0;
      if (hi > g.fftBins - 1) hi = g.fftBins - 1;
      double sum = 0.0;
      for (int k = lo; k <= hi; k++) sum += power[k];
      smoothed[b] = sum / static_cast<double>(hi - lo + 1);
    }
    std::memcpy(power, smoothed, g.fftBins * sizeof(double));
  }

  // Reference: mean power across the mid band, so eq ≈ 1 there.
  double refSum = 0.0;
  int refCount = 0;
  for (int b = 0; b < g.fftBins; b++) {
    const float f = binFrequencyHz(b);
    if (f >= REF_BAND_LO_HZ && f <= REF_BAND_HI_HZ) {
      refSum += power[b];
      refCount++;
    }
  }
  if (refCount == 0 || refSum <= 0.0) {
    std::free(power);
    std::free(smoothed);
    return false;
  }
  const double refPower = refSum / static_cast<double>(refCount);

  for (int b = 0; b < g.fftBins; b++) {
    const double p = power[b] > 1e-12 ? power[b] : 1e-12;
    float eq = static_cast<float>(std::sqrt(refPower / p));
    if (eq > DFEQ_MAX_GAIN) eq = DFEQ_MAX_GAIN;
    if (eq < DFEQ_MIN_GAIN) eq = DFEQ_MIN_GAIN;
    g.dfeqMag[b] = eq;
  }

  std::free(power);
  std::free(smoothed);
  return true;
}

/*
 * Normalizes overall level: bakes a probe filter for a front-center source
 * and scales so its broadband magnitude across the reference band is ~1.
 */
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
  const bool baked = bakeFilters(0.0f, 0.0f, probe);
  bool ok = false;
  if (baked) {
    double sumSq = 0.0;
    int count = 0;
    for (int ear = 0; ear < 2; ear++) {
      for (int b = 0; b < g.fftBins; b++) {
        const float f = binFrequencyHz(b);
        if (f < REF_BAND_LO_HZ || f > REF_BAND_HI_HZ) continue;
        sumSq += static_cast<double>(probe[ear][b].r) * probe[ear][b].r +
                 static_cast<double>(probe[ear][b].i) * probe[ear][b].i;
        count++;
      }
    }
    if (count > 0 && sumSq > 0.0) {
      const double rms = std::sqrt(sumSq / static_cast<double>(count));
      g.globalScale = static_cast<float>(1.0 / rms);
      ok = true;
    }
  }

  std::free(probe[0]);
  std::free(probe[1]);
  return ok;
}

}  // namespace

extern "C" {

// Returns the HRTF tap count on success, 0 on failure (e.g. unsupported
// sample rate). blockSize must match the Web Audio render quantum (128).
int spatial_init(int sampleRate, int blockSize) {
  freeAll();
  if (blockSize <= 0 || blockSize > 1024) return 0;

  g.hrtf = new spaudio::MIT_HRTF(static_cast<unsigned>(sampleRate));
  if (!g.hrtf->isLoaded()) {
    freeAll();
    return 0;
  }

  g.sampleRate = sampleRate;
  g.blockSize = blockSize;
  g.taps = static_cast<int>(g.hrtf->getHRTFLen());
  // The windowed filter must hold the HRIR plus the EQ/crossover ring plus
  // the causalizing pre-delay (see bakeFilters).
  const int ringSamples = static_cast<int>(FILTER_RING_SECONDS * static_cast<float>(sampleRate));
  const int neededFilterLen = g.taps + FILTER_PRE_DELAY + ringSamples;
  g.fftSize = 1;
  while (g.fftSize - g.blockSize < neededFilterLen) g.fftSize <<= 1;
  g.filterLen = g.fftSize - g.blockSize;
  g.tailLen = g.filterLen - 1;
  g.fftBins = g.fftSize / 2 + 1;
  g.fftScaler = 1.0f / static_cast<float>(g.fftSize);
  g.globalScale = 1.0f;
  g.limiterGain = 1.0f;
  g.limiterReleasePerBlock =
    1.0f - std::exp(-(static_cast<float>(blockSize) / static_cast<float>(sampleRate)) / LIMIT_RELEASE_SECONDS);
  g.pendingRequired = 1.0f;
  g.pendingValid = false;

  g.fftFwd = kiss_fftr_alloc(g.fftSize, 0, nullptr, nullptr);
  g.fftInv = kiss_fftr_alloc(g.fftSize, 1, nullptr, nullptr);

  for (int i = 0; i < MAX_SPEAKERS; i++) {
    g.input[i] = static_cast<float*>(std::calloc(g.blockSize, sizeof(float)));
  }
  for (int ear = 0; ear < 2; ear++) {
    g.output[ear] = static_cast<float*>(std::calloc(g.blockSize, sizeof(float)));
    g.tail[ear] = static_cast<float*>(std::calloc(g.tailLen, sizeof(float)));
    g.freqAcc[ear] = static_cast<kiss_fft_cpx*>(std::calloc(g.fftBins, sizeof(kiss_fft_cpx)));
    g.hrtfScratch[ear] = static_cast<float*>(std::calloc(g.taps, sizeof(float)));
    g.pendingOut[ear] = static_cast<float*>(std::calloc(g.blockSize, sizeof(float)));
  }
  g.lfeMix = static_cast<float*>(std::calloc(g.blockSize, sizeof(float)));
  g.timeScratch = static_cast<float*>(std::calloc(g.fftSize, sizeof(float)));
  g.irScratch = static_cast<float*>(std::calloc(g.fftSize, sizeof(float)));
  g.freqScratch = static_cast<kiss_fft_cpx*>(std::calloc(g.fftBins, sizeof(kiss_fft_cpx)));
  g.dfeqMag = static_cast<float*>(std::calloc(g.fftBins, sizeof(float)));
  g.lfeDelay = static_cast<float*>(std::calloc(FILTER_PRE_DELAY, sizeof(float)));

  if (!computeDiffuseFieldEq() || !computeGlobalScale()) {
    freeAll();
    return 0;
  }

  g.ready = true;
  return g.taps;
}

// Position/update one speaker. Returns 1 on success, 0 on failure. The first
// call for a speaker applies instantly; later calls fade over FADE_BLOCKS
// blocks. LFE speakers skip the HRTF entirely.
int spatial_set_speaker(int index, float azimuthRad, float elevationRad, float gain, int isLfe) {
  if (!g.ready || index < 0 || index >= MAX_SPEAKERS) return 0;
  SpeakerState& sp = g.speakers[index];
  sp.gain = gain;
  sp.isLfe = isLfe != 0;

  if (sp.isLfe) {
    sp.active = true;
    sp.fadeRemaining = 0;
    return 1;
  }

  for (int ear = 0; ear < 2; ear++) {
    if (!sp.current[ear]) {
      sp.current[ear] = static_cast<kiss_fft_cpx*>(std::calloc(g.fftBins, sizeof(kiss_fft_cpx)));
    }
    if (!sp.target[ear]) {
      sp.target[ear] = static_cast<kiss_fft_cpx*>(std::calloc(g.fftBins, sizeof(kiss_fft_cpx)));
    }
  }

  if (!bakeFilters(azimuthRad, elevationRad, sp.target)) return 0;

  if (!sp.active) {
    // First bake for this speaker: no fade, start exactly at the target.
    for (int ear = 0; ear < 2; ear++) {
      std::memcpy(sp.current[ear], sp.target[ear], g.fftBins * sizeof(kiss_fft_cpx));
    }
    sp.fadeRemaining = 0;
    sp.active = true;
  } else {
    sp.fadeRemaining = FADE_BLOCKS;
  }
  return 1;
}

// Marks a speaker slot unused (e.g. when the layout shrinks).
void spatial_clear_speaker(int index) {
  if (index < 0 || index >= MAX_SPEAKERS) return;
  g.speakers[index].active = false;
  g.speakers[index].fadeRemaining = 0;
}

float* spatial_input_ptr(int channel) {
  if (channel < 0 || channel >= MAX_SPEAKERS) return nullptr;
  return g.input[channel];
}

float* spatial_output_ptr(int ear) {
  if (ear < 0 || ear > 1) return nullptr;
  return g.output[ear];
}

// Clears convolution tails and the limiter's look-ahead block (call on
// seek/flush so stale audio doesn't bleed into the new position).
void spatial_reset() {
  if (!g.ready) return;
  for (int ear = 0; ear < 2; ear++) {
    std::memset(g.tail[ear], 0, g.tailLen * sizeof(float));
    std::memset(g.pendingOut[ear], 0, g.blockSize * sizeof(float));
  }
  std::memset(g.lfeDelay, 0, FILTER_PRE_DELAY * sizeof(float));
  g.pendingRequired = 1.0f;
  g.limiterGain = 1.0f;
}

int spatial_tail_taps() { return g.ready ? g.taps : 0; }

// Renders one block: numChannels planar inputs (written via
// spatial_input_ptr) -> binaural stereo (read via spatial_output_ptr).
// frames must equal the blockSize passed to spatial_init.
int spatial_process(int numChannels, int frames) {
  if (!g.ready || frames != g.blockSize) return 0;
  if (numChannels < 0) numChannels = 0;
  if (numChannels > MAX_SPEAKERS) numChannels = MAX_SPEAKERS;

  for (int ear = 0; ear < 2; ear++) {
    std::memset(g.freqAcc[ear], 0, g.fftBins * sizeof(kiss_fft_cpx));
  }
  // lfeMix is written one FILTER_PRE_DELAY behind the incoming samples so
  // the dry LFE stays time-aligned with the (pre-delayed) binaural filters.
  std::memset(g.lfeMix, 0, g.blockSize * sizeof(float));
  std::memcpy(g.lfeMix, g.lfeDelay, FILTER_PRE_DELAY * sizeof(float));
  std::memset(g.lfeDelay, 0, FILTER_PRE_DELAY * sizeof(float));

  for (int i = 0; i < numChannels; i++) {
    SpeakerState& sp = g.speakers[i];
    if (!sp.active) continue;

    if (sp.isLfe) {
      for (int n = 0; n < g.blockSize - FILTER_PRE_DELAY; n++) {
        g.lfeMix[n + FILTER_PRE_DELAY] += g.input[i][n] * sp.gain;
      }
      for (int n = 0; n < FILTER_PRE_DELAY; n++) {
        g.lfeDelay[n] += g.input[i][g.blockSize - FILTER_PRE_DELAY + n] * sp.gain;
      }
      continue;
    }

    // Advance the filter fade one step (per-bin linear interpolation toward
    // the target — equivalent to interpolating the impulse responses).
    if (sp.fadeRemaining > 0) {
      const float step = 1.0f / static_cast<float>(sp.fadeRemaining);
      for (int ear = 0; ear < 2; ear++) {
        for (int b = 0; b < g.fftBins; b++) {
          sp.current[ear][b].r += (sp.target[ear][b].r - sp.current[ear][b].r) * step;
          sp.current[ear][b].i += (sp.target[ear][b].i - sp.current[ear][b].i) * step;
        }
      }
      sp.fadeRemaining--;
    }

    for (int n = 0; n < g.blockSize; n++) g.timeScratch[n] = g.input[i][n] * sp.gain;
    std::memset(g.timeScratch + g.blockSize, 0, (g.fftSize - g.blockSize) * sizeof(float));
    kiss_fftr(g.fftFwd, g.timeScratch, g.freqScratch);

    for (int ear = 0; ear < 2; ear++) {
      const kiss_fft_cpx* h = sp.current[ear];
      kiss_fft_cpx* acc = g.freqAcc[ear];
      for (int b = 0; b < g.fftBins; b++) {
        acc[b].r += g.freqScratch[b].r * h[b].r - g.freqScratch[b].i * h[b].i;
        acc[b].i += g.freqScratch[b].r * h[b].i + g.freqScratch[b].i * h[b].r;
      }
    }
  }

  for (int ear = 0; ear < 2; ear++) {
    kiss_fftri(g.fftInv, g.freqAcc[ear], g.timeScratch);

    // The tail buffer stays in raw convolution units; headroom is applied
    // only once, at the final output.
    float* out = g.output[ear];
    float* tail = g.tail[ear];
    for (int n = 0; n < g.blockSize; n++) {
      float wet = g.timeScratch[n] * g.fftScaler;
      if (n < g.tailLen) wet += tail[n];
      out[n] = (wet + g.lfeMix[n] * LFE_EAR_GAIN) * OUTPUT_HEADROOM;
    }

    // Slide the overlap tail forward one block and add this block's new tail
    // (general overlap-add: tailLen may exceed blockSize at 88.2/96 kHz).
    // Reads at j + blockSize stay ahead of the ascending writes at j.
    for (int j = 0; j < g.tailLen; j++) {
      const int shifted = j + g.blockSize;
      float v = shifted < g.tailLen ? tail[shifted] : 0.0f;
      const int fftIndex = g.blockSize + j;
      if (fftIndex < g.fftSize) v += g.timeScratch[fftIndex] * g.fftScaler;
      tail[j] = v;
    }
  }

  // Look-ahead brick-wall limiter (see LIMIT_* constants). The freshly
  // rendered block is held back one quantum; what plays now is the previous
  // block, with a gain ramp that already anticipates the new block's peak.
  float peak = 0.0f;
  for (int ear = 0; ear < 2; ear++) {
    for (int n = 0; n < g.blockSize; n++) {
      const float v = std::fabs(g.output[ear][n]);
      if (v > peak) peak = v;
    }
  }
  const float incomingRequired = peak > LIMIT_THRESHOLD ? LIMIT_THRESHOLD / peak : 1.0f;

  if (!g.pendingValid) {
    // First block after (re)start: prime the look-ahead with one quantum of
    // silence (~2.9 ms, inaudible).
    for (int ear = 0; ear < 2; ear++) {
      std::memcpy(g.pendingOut[ear], g.output[ear], g.blockSize * sizeof(float));
      std::memset(g.output[ear], 0, g.blockSize * sizeof(float));
    }
    g.pendingRequired = incomingRequired;
    g.pendingValid = true;
    return 1;
  }

  // Gain at the end of the emitted block: attack ramps down across the whole
  // block so it lands exactly when the loud (incoming) block plays; release
  // recovers exponentially. Never above what the emitted block itself allows.
  const float gainStart = g.limiterGain;
  float gainEnd;
  if (incomingRequired < gainStart) {
    gainEnd = incomingRequired;
  } else {
    gainEnd = gainStart + (1.0f - gainStart) * g.limiterReleasePerBlock;
    if (gainEnd > incomingRequired) gainEnd = incomingRequired;
  }
  if (gainEnd > g.pendingRequired) gainEnd = g.pendingRequired;

  const float gainStep = (gainEnd - gainStart) / static_cast<float>(g.blockSize);
  for (int n = 0; n < g.blockSize; n++) {
    const float gain = gainStart + gainStep * static_cast<float>(n + 1);
    for (int ear = 0; ear < 2; ear++) {
      const float wet = g.output[ear][n];
      float v = g.pendingOut[ear][n] * gain;
      // Emergency ceiling for block-granularity slack; effectively inactive.
      const float mag = std::fabs(v);
      if (mag > SOFT_CEIL_START) {
        const float span = 1.0f - SOFT_CEIL_START;
        const float squeezed = SOFT_CEIL_START + span * std::tanh((mag - SOFT_CEIL_START) / span);
        v = v < 0.0f ? -squeezed : squeezed;
      }
      g.output[ear][n] = v;
      g.pendingOut[ear][n] = wet;
    }
  }
  g.limiterGain = gainEnd;
  g.pendingRequired = incomingRequired;

  return 1;
}

}  // extern "C"
