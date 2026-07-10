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
 * Filter changes fade over FADE_BLOCKS render quanta (per-bin linear
 * interpolation of the frequency-domain filters, equivalent to impulse
 * response interpolation) to avoid clicks while dragging.
 *
 * LFE feeds bypass the HRTF entirely and mix equally into both ears.
 *
 * Deferred hooks (v2+): elevation is plumbed through but the UI pins it to 0;
 * distance/per-speaker gain are accepted but gain is currently always 1.0;
 * SOFA HRTFs can replace MIT_HRTF behind the same spaudio::HRTF interface.
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

constexpr int MAX_SPEAKERS = 8;
constexpr int FADE_BLOCKS = 4;
// Equal-power feed of the non-positional LFE channel into both ears.
const float LFE_EAR_GAIN = std::sqrt(0.5f);
// Extra safety margin on top of the 0.35 filter normalization so several
// correlated speaker feeds summing at both ears stay below full scale.
// Tuned by ear against Direct-mode loudness (stage 4).
constexpr float OUTPUT_HEADROOM = 0.7f;
// Matches SpeakersBinauralizer's post-normalization target.
constexpr float FILTER_NORM_TARGET = 0.35f;

struct SpeakerState {
  bool active = false;
  bool isLfe = false;
  float gain = 1.0f;
  // Frequency-domain HRTF filters, [ear][bin]. `current` is what process()
  // uses; while fadeRemaining > 0 it steps linearly toward `target`.
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
  int tailLen = 0;  // taps - 1
  float fftScaler = 1.0f;
  float normScaler = 1.0f;

  kiss_fftr_cfg fftFwd = nullptr;
  kiss_fftr_cfg fftInv = nullptr;
  spaudio::MIT_HRTF* hrtf = nullptr;

  SpeakerState speakers[MAX_SPEAKERS];

  float* input[MAX_SPEAKERS] = {nullptr};
  float* output[2] = {nullptr, nullptr};
  float* tail[2] = {nullptr, nullptr};
  float* lfeMix = nullptr;

  float* timeScratch = nullptr;          // fftSize
  kiss_fft_cpx* freqScratch = nullptr;   // fftBins
  kiss_fft_cpx* freqAcc[2] = {nullptr, nullptr};  // fftBins per ear
  float* hrtfScratch[2] = {nullptr, nullptr};     // taps per ear
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
    g.output[ear] = nullptr;
    g.tail[ear] = nullptr;
    g.freqAcc[ear] = nullptr;
    g.hrtfScratch[ear] = nullptr;
  }
  std::free(g.lfeMix);
  std::free(g.timeScratch);
  std::free(g.freqScratch);
  g.lfeMix = nullptr;
  g.timeScratch = nullptr;
  g.freqScratch = nullptr;
  if (g.fftFwd) kiss_fftr_free(g.fftFwd);
  if (g.fftInv) kiss_fftr_free(g.fftInv);
  g.fftFwd = nullptr;
  g.fftInv = nullptr;
  delete g.hrtf;
  g.hrtf = nullptr;
  g.ready = false;
}

// Bakes the frequency-domain HRTF filter pair for a speaker position into
// `dst[2]`. Returns false if the HRTF lookup fails.
bool bakeFilters(float azimuthRad, float elevationRad, kiss_fft_cpx* dst[2]) {
  float* pfHRTF[2] = {g.hrtfScratch[0], g.hrtfScratch[1]};
  if (!g.hrtf->get(azimuthRad, elevationRad, pfHRTF)) return false;
  for (int ear = 0; ear < 2; ear++) {
    for (int t = 0; t < g.taps; t++) g.timeScratch[t] = pfHRTF[ear][t] * g.normScaler;
    std::memset(g.timeScratch + g.taps, 0, (g.fftSize - g.taps) * sizeof(float));
    kiss_fftr(g.fftFwd, g.timeScratch, dst[ear]);
  }
  return true;
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
  g.tailLen = g.taps - 1;
  g.fftSize = 1;
  while (g.fftSize < g.blockSize + g.taps - 1) g.fftSize <<= 1;
  g.fftBins = g.fftSize / 2 + 1;
  g.fftScaler = 1.0f / static_cast<float>(g.fftSize);

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
  }
  g.lfeMix = static_cast<float*>(std::calloc(g.blockSize, sizeof(float)));
  g.timeScratch = static_cast<float*>(std::calloc(g.fftSize, sizeof(float)));
  g.freqScratch = static_cast<kiss_fft_cpx*>(std::calloc(g.fftBins, sizeof(kiss_fft_cpx)));

  // Fixed normalization independent of the active layout: scale so the
  // loudest single-source direction (directly beside an ear) peaks at
  // FILTER_NORM_TARGET. Keeping this constant across re-bakes means moving a
  // speaker never shifts the overall level of the others.
  float* pfHRTF[2] = {g.hrtfScratch[0], g.hrtfScratch[1]};
  float maxTap = 0.0f;
  if (g.hrtf->get(static_cast<float>(M_PI) / 2.0f, 0.0f, pfHRTF)) {
    for (int ear = 0; ear < 2; ear++) {
      for (int t = 0; t < g.taps; t++) {
        float v = std::fabs(pfHRTF[ear][t]);
        if (v > maxTap) maxTap = v;
      }
    }
  }
  if (maxTap <= 0.0f) {
    freeAll();
    return 0;
  }
  g.normScaler = FILTER_NORM_TARGET / maxTap;

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

// Clears convolution tails and pending LFE (call on seek/flush so stale
// reverb-like tails don't bleed into the new position).
void spatial_reset() {
  if (!g.ready) return;
  for (int ear = 0; ear < 2; ear++) std::memset(g.tail[ear], 0, g.tailLen * sizeof(float));
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
  std::memset(g.lfeMix, 0, g.blockSize * sizeof(float));

  for (int i = 0; i < numChannels; i++) {
    SpeakerState& sp = g.speakers[i];
    if (!sp.active) continue;

    if (sp.isLfe) {
      for (int n = 0; n < g.blockSize; n++) g.lfeMix[n] += g.input[i][n] * sp.gain;
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

  return 1;
}

}  // extern "C"
