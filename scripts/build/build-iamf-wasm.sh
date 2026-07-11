#!/usr/bin/env bash
# Builds src/renderer/public/iamf-decoder.wasm from the libiamf submodule +
# native/iamf-wasm/iamf_wrapper.c, with emscripten-built libopus and libFLAC.
#
# The .wasm artifact is committed to the repo (it is platform-independent);
# this script only needs to be re-run when the wrapper or the pinned
# submodules change. Requires emscripten (emcc/emcmake) and cmake on PATH
# (`brew install emscripten cmake`) and the submodules checked out:
#   git submodule update --init third_party/libiamf third_party/opus third_party/flac
#
# Codec support: Opus + FLAC + LPCM. AAC is deliberately NOT built — libiamf's
# AAC path requires fdk-aac, whose Fraunhofer license is incompatible with
# Astra's GPL-3.0 distribution. Real-world Eclipsa content is IAMF-Opus.
# libiamf's binaural bridges (BEAR/Resonance; boost + VISR) are also excluded:
# Astra renders binaural itself from the 7.1.4 output.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$ROOT/third_party/libiamf/code"
OPUS="$ROOT/third_party/opus"
FLAC="$ROOT/third_party/flac"
WRAPPER_DIR="$ROOT/native/iamf-wasm"
BUILD="$WRAPPER_DIR/build"   # gitignored cache (codec libs + include staging)
OUT="$ROOT/src/renderer/public/iamf-decoder.wasm"

for tool in emcc emcmake cmake; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool not found. Install emscripten + cmake (brew install emscripten cmake)." >&2
    exit 1
  fi
done
if [ ! -f "$LIB/include/IAMF_decoder.h" ]; then
  echo "error: libiamf submodule missing. Run: git submodule update --init third_party/libiamf" >&2
  exit 1
fi
if [ ! -f "$OPUS/include/opus.h" ] || [ ! -f "$FLAC/include/FLAC/stream_decoder.h" ]; then
  echo "error: opus/flac submodules missing. Run: git submodule update --init third_party/opus third_party/flac" >&2
  exit 1
fi

# ---- 1. Codec static libs (cached; delete $BUILD to force a rebuild) ----

OPUS_LIB="$BUILD/opus/libopus.a"
if [ ! -f "$OPUS_LIB" ]; then
  echo "Building libopus (wasm)"
  emcmake cmake -S "$OPUS" -B "$BUILD/opus" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DOPUS_BUILD_PROGRAMS=OFF \
    -DOPUS_BUILD_TESTING=OFF \
    -DOPUS_STACK_PROTECTOR=OFF \
    -DOPUS_HARDENING=OFF >/dev/null
  cmake --build "$BUILD/opus" -j >/dev/null
fi

FLAC_LIB="$BUILD/flac/src/libFLAC/libFLAC.a"
if [ ! -f "$FLAC_LIB" ]; then
  echo "Building libFLAC (wasm)"
  emcmake cmake -S "$FLAC" -B "$BUILD/flac" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DBUILD_SHARED_LIBS=OFF \
    -DWITH_OGG=OFF \
    -DBUILD_PROGRAMS=OFF \
    -DBUILD_EXAMPLES=OFF \
    -DBUILD_TESTING=OFF \
    -DBUILD_DOCS=OFF \
    -DBUILD_CXXLIBS=OFF \
    -DINSTALL_MANPAGES=OFF >/dev/null
  cmake --build "$BUILD/flac" -j --target FLAC >/dev/null
fi

# Staging dir so the glue's `#include "opus/opus.h"` resolves to the submodule
# headers (libiamf expects the dep_codecs/include layout with an opus/ prefix).
mkdir -p "$BUILD/include"
ln -sfn "$OPUS/include" "$BUILD/include/opus"

# ---- 2. Compile libiamf core + wrapper ----

C_SOURCES=(
  "$WRAPPER_DIR/iamf_wrapper.c"
  "$LIB/src/common/fixedp11_5.c"
  # Core decoder (everything in src/iamf_dec except the verifier/debug units).
  "$LIB/src/iamf_dec/IAMF_OBU.c"
  "$LIB/src/iamf_dec/IAMF_core_decoder.c"
  "$LIB/src/iamf_dec/IAMF_decoder.c"
  "$LIB/src/iamf_dec/IAMF_layout.c"
  "$LIB/src/iamf_dec/IAMF_utils.c"
  "$LIB/src/iamf_dec/audio_effect_peak_limiter.c"
  "$LIB/src/iamf_dec/bitstream.c"
  "$LIB/src/iamf_dec/demixer.c"
  "$LIB/src/iamf_dec/downmix_renderer.c"
  "$LIB/src/iamf_dec/h2b_rdr.c"
  "$LIB/src/iamf_dec/h2m_rdr.c"
  "$LIB/src/iamf_dec/m2b_rdr.c"
  "$LIB/src/iamf_dec/m2m_rdr.c"
  "$LIB/src/iamf_dec/queue_t.c"
  "$LIB/src/iamf_dec/resample.c"
  # Codec glue (AAC intentionally absent).
  "$LIB/src/iamf_dec/opus/IAMF_opus_decoder.c"
  "$LIB/src/iamf_dec/opus/opus_multistream2_decoder.c"
  "$LIB/src/iamf_dec/flac/IAMF_flac_decoder.c"
  "$LIB/src/iamf_dec/flac/flac_multistream_decoder.c"
  "$LIB/src/iamf_dec/pcm/IAMF_pcm_decoder.c"
)

COMMON_FLAGS=(
  -O3
  -DCONFIG_OPUS_CODEC
  -DCONFIG_FLAC_CODEC
  -DFLAC__NO_DLL
  -I "$LIB/include"
  -I "$LIB/src/common"
  -I "$LIB/src/iamf_dec"
  -I "$BUILD/include"
  -I "$FLAC/include"
)

OBJ_DIR="$(mktemp -d)"
trap 'rm -rf "$OBJ_DIR"' EXIT
OBJECTS=()

echo "Building $OUT"
for src in "${C_SOURCES[@]}"; do
  obj="$OBJ_DIR/$(basename "${src%.*}").o"
  emcc -std=gnu11 "${COMMON_FLAGS[@]}" -c "$src" -o "$obj"
  OBJECTS+=("$obj")
done

# ---- 3. Link ----
# ALLOW_MEMORY_GROWTH: unlike the spatial renderer (fixed realtime footprint),
# the decoder holds the whole input file plus per-frame buffers.

emcc \
  -O3 \
  -sSTANDALONE_WASM \
  --no-entry \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_iamf_open,_iamf_channels,_iamf_max_frame,_iamf_pcm_ptr,_iamf_decode_next,_iamf_sample_rate,_iamf_loudness_q78,_iamf_close \
  -sINITIAL_MEMORY=32MB \
  -sALLOW_MEMORY_GROWTH=1 \
  -o "$OUT" \
  "${OBJECTS[@]}" \
  "$OPUS_LIB" \
  "$FLAC_LIB"

ls -la "$OUT"
echo "Done."
