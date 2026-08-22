#!/usr/bin/env bash
# Build the portable Adaptive upmixer core for its AudioWorklet host. The
# platform-independent output is committed so production builds do not require
# Emscripten. Re-run whenever adaptive_upmixer, dsp_utils, or the wrapper changes.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/src/renderer/public/adaptive-upmixer.wasm"

if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found. Install emscripten (brew install emscripten)." >&2
  exit 1
fi

emcc \
  -std=gnu++17 \
  -O3 \
  -fno-rtti \
  -fno-fast-math \
  -I "$ROOT/native/src" \
  "$ROOT/native/adaptive-upmix-wasm/adaptive_upmix_wrapper.cpp" \
  "$ROOT/native/src/adaptive_upmixer.cpp" \
  "$ROOT/native/src/dsp_utils.cpp" \
  -sSTANDALONE_WASM \
  --no-entry \
  -sEXPORTED_FUNCTIONS=_adaptive_roles_ptr,_adaptive_input_ptr,_adaptive_output_ptr,_adaptive_init,_adaptive_process,_adaptive_reset,_adaptive_latency_frames,_adaptive_fft_size,_adaptive_output_channels \
  -sINITIAL_MEMORY=8MB \
  -sALLOW_MEMORY_GROWTH=0 \
  -o "$OUT"

ls -la "$OUT"
