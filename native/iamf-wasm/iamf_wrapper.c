/*
 * Astra IAMF (Eclipsa Audio) decoder — WASM wrapper around libiamf v1.1.0.
 *
 * Built by scripts/build/build-iamf-wasm.sh into
 * src/renderer/public/iamf-decoder.wasm and driven from a renderer Web Worker
 * (src/renderer/audio/iamfDecodeWorker.ts) as an OFFLINE whole-file decoder:
 * the worker copies the complete .iamf OBU stream (or the OBUs extracted from
 * an IAMF-in-MP4 file) into wasm memory, then pulls decoded frames one
 * temporal unit at a time.
 *
 * Contract (single decode stream at a time; the worker serializes):
 *   ptr = malloc(size); <copy bytes>; iamf_open(ptr, size)   -> 0 | IAErrCode
 *   iamf_channels()/iamf_max_frame()/iamf_pcm_ptr()          -> output geometry
 *   iamf_decode_next()  -> >0 samples/channel now in pcm | 0 EOS | <0 IAErrCode
 *   iamf_sample_rate()  -> valid AFTER the first decoded frame (v1.1.0 limit)
 *   iamf_loudness_q78() -> integrated loudness (Q7.8 LKFS) | INT32_MIN if absent
 *   iamf_close(); free(ptr)
 *
 * Output is SOUND_SYSTEM_J (7.1.4): 12 channels, interleaved int32.
 * NOTE the channel order is libiamf's BS.2051-J order
 *   L R C LFE SL SR BL BR TFL TFR TBL TBR
 * which differs from Astra's STANDARD_LAYOUTS[12] (FFmpeg order,
 * BL/BR before SL/SR) — the worker swaps indices 4<->6 and 5<->7.
 *
 * libiamf's own loudness normalization is DISABLED (0.0f): Astra's in-renderer
 * analyzer + normalization stage owns loudness. The default peak limiter stays
 * enabled (protects the rendering/downmix stage itself).
 *
 * Codec support in this build: Opus, FLAC, LPCM. AAC is intentionally NOT
 * compiled: libiamf's AAC path requires fdk-aac, whose license is incompatible
 * with Astra's GPL-3.0 distribution.
 */

#include <limits.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "IAMF_decoder.h"
#include "IAMF_defines.h"

#define OUTPUT_SOUND_SYSTEM SOUND_SYSTEM_J /* 7.1.4 */
#define PTS_TIME_BASE 90000
#define OUTPUT_BIT_DEPTH 32

static struct {
  IAMF_DecoderHandle handle;
  const uint8_t *data; /* JS-owned input buffer (malloc'd from JS) */
  uint32_t size;
  uint32_t used;
  int flushed;
  void *pcm; /* interleaved int32, max_frame * channels */
  uint32_t max_frame;
  int channels;
  uint32_t sample_rate;  /* 0 until the first decoded frame */
  int32_t loudness_q78;  /* INT32_MIN until seen in metadata */
} g;

static void reset_state(void) {
  if (g.handle) IAMF_decoder_close(g.handle);
  if (g.pcm) free(g.pcm);
  memset(&g, 0, sizeof(g));
  g.loudness_q78 = INT32_MIN;
}

/* Mirrors the reference tool's extradata_iamf_clean: get_last_metadata hands
 * the caller heap-allocated arrays that must be freed after each call. */
static void refresh_metadata(void) {
  IAMF_extradata meta;
  int64_t pts = 0;
  memset(&meta, 0, sizeof(meta));
  if (IAMF_decoder_get_last_metadata(g.handle, &pts, &meta) != IAMF_OK) return;
  if (meta.sampling_rate) g.sample_rate = meta.sampling_rate;
  if (meta.num_loudness_layouts > 0 && meta.loudness) {
    g.loudness_q78 = meta.loudness[0].integrated_loudness;
  }
  if (meta.loudness_layout) free(meta.loudness_layout);
  if (meta.loudness) {
    for (int i = 0; i < meta.num_loudness_layouts; i++) {
      if (meta.loudness[i].anchor_loudness) free(meta.loudness[i].anchor_loudness);
    }
    free(meta.loudness);
  }
  if (meta.param) free(meta.param);
}

int iamf_open(const uint8_t *data, uint32_t size) {
  reset_state();
  if (!data || size < 8) return IAMF_ERR_BAD_ARG;

  g.handle = IAMF_decoder_open();
  if (!g.handle) return IAMF_ERR_INTERNAL;

  IAMF_decoder_set_pts(g.handle, 0, PTS_TIME_BASE);
  IAMF_decoder_set_bit_depth(g.handle, OUTPUT_BIT_DEPTH);
  IAMF_decoder_set_normalization_loudness(g.handle, 0.0f);
  IAMF_decoder_output_layout_set_sound_system(g.handle, OUTPUT_SOUND_SYSTEM);

  uint32_t rsize = 0;
  int ret = IAMF_decoder_configure(g.handle, data, size, &rsize);
  if (ret != IAMF_OK) {
    int code = ret;
    reset_state();
    return code;
  }

  g.data = data;
  g.size = size;
  g.used = rsize;
  g.channels = IAMF_layout_sound_system_channels_count(OUTPUT_SOUND_SYSTEM);

  IAMF_StreamInfo *info = IAMF_decoder_get_stream_info(g.handle);
  g.max_frame = info && info->max_frame_size ? info->max_frame_size : 8192;

  g.pcm = malloc((size_t)(OUTPUT_BIT_DEPTH / 8) * g.max_frame * g.channels);
  if (!g.pcm) {
    reset_state();
    return IAMF_ERR_ALLOC_FAIL;
  }
  return IAMF_OK;
}

int iamf_channels(void) { return g.channels; }

uint32_t iamf_max_frame(void) { return g.max_frame; }

void *iamf_pcm_ptr(void) { return g.pcm; }

uint32_t iamf_sample_rate(void) { return g.sample_rate; }

int iamf_loudness_q78(void) {
  return g.loudness_q78 == INT32_MIN ? INT32_MIN : (int)g.loudness_q78;
}

int iamf_decode_next(void) {
  if (!g.handle || !g.pcm) return IAMF_ERR_INVALID_STATE;

  while (1) {
    uint32_t rsize = 0;
    int ret;

    if (g.used >= g.size) {
      if (g.flushed) return 0; /* EOS already delivered */
      /* Final flush call, exactly like the reference tool's end handling. */
      g.flushed = 1;
      ret = IAMF_decoder_decode(g.handle, NULL, 0, &rsize, g.pcm);
      if (ret > 0) {
        refresh_metadata();
        return ret;
      }
      return 0;
    }

    ret = IAMF_decoder_decode(g.handle, g.data + g.used, g.size - g.used,
                              &rsize, g.pcm);
    g.used += rsize;

    if (ret > 0) {
      refresh_metadata();
      return ret;
    }
    if (ret < 0) return ret;
    /* ret == 0: no samples this call. If bytes were consumed (parameter or
     * descriptor OBUs), keep going; if nothing was consumed we can make no
     * further progress — force the flush path. */
    if (!rsize) g.used = g.size;
  }
}

void iamf_close(void) { reset_state(); }
