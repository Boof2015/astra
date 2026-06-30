// §22 Commit 1 — Parallax loopback capture, Windows-only WASAPI.
//
// Read-only observation surface for the Parallax sync loop. Captures the OS render endpoint
// Web Audio is playing through, returns each captured frame stamped with a host-wall-time
// derived from QueryPerformanceCounter. The renderer-side calibration (Commit 2) uses these
// timestamps + a known calibration signal to compute `measured_host_output_bias` per share §22.
//
// Critical contract (Codex round 1 — clock domain): every timestamp this module returns is in
// the SAME clock domain as `parallax_loopback::wallNowMs()`. The renderer obtains its
// scheduling timestamps via the same function exposed through IPC, so a subtraction is honest.
// Do NOT mix QueryPerformanceCounter raw values, `AudioContext.currentTime`, or
// `getOutputTimestamp()` into the bias computation — those are different clocks.
//
// macOS / Linux are stub no-ops in v1; the §22 spec defers them to a separate phase.

#pragma once

#include <napi.h>

namespace ParallaxLoopback {

// Public N-API registration. main.cpp calls this once to bind exports under
// `module.parallaxLoopback.*`.
Napi::Object Register(Napi::Env env);

}  // namespace ParallaxLoopback
