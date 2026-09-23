# Vectorscope rendering

The multiband vectorscope can submit its dots as one WebGL2 instanced batch per frame. Each dot remains a separate rectangle with its original position, color, alpha, and position in the drawing order. This preserves the brightness from overlapping dots; combining them into a single Canvas path would not.

Ordinary mode retains Canvas. The GPU prototype retired fewer CPU instructions there, but mixed-layout CPU time regressed in repeated measurements. The three multiband point layers showed a more consistent benefit. Toggling multiband creates or releases the GPU renderer; no GPU context is created for an ordinary scope.

The existing native and JavaScript analyzers, point counts, projections, polar-coordinate cache, update cadence, and Canvas grid remain unchanged. The same renderer is used by docked and popout scopes.

## Frame and resource lifetime

`vectorscopeGpu.ts` owns a separate, transparent GPU canvas with a preserved drawing buffer. Each frame fades its previous contents with the existing persistence value, uploads the current point attributes, draws the ordered batch, and composites that surface over the existing Canvas grid. The CPU attribute array grows when needed and is reused.

Before uploading, `bufferData(..., STREAM_DRAW)` replaces the GPU buffer's backing storage. This lets the driver retire storage still referenced by the preceding frame. In the local comparison, updating the same storage with `bufferSubData` alone used substantially more CPU time even though it retired similarly few CPU instructions.

The context requests `low-power` and rejects major performance caveats. These are browser hints/constraints, not a promise about which physical GPU every driver selects. Disposal releases the buffer, vertex array, programs, event listener, and private GPU context.

## Visual matching and fallback

A separate 8×8 Canvas probe identifies the current backend's dot-corner antialiasing. The shader supports area coverage, intersecting edge ramps, and bevelled outer corners. The live history is never read back for calibration. Both Graphite/Dawn/Metal and Ganesh/GL were exercised locally; their antialiasing differs.

Unlike the waveform and spectrogram history changes, this is not guaranteed byte-identical rendering. Local comparisons normally differed by at most 1–3 out of 255 per channel. A full-persistence stress case reached 7, on a small portion of the image. Compare transparent surfaces using premultiplied RGBA so invisible RGB values do not masquerade as visible differences.

The existing Canvas renderer remains the fallback for:

- unavailable WebGL2, shader/resource initialization failure, or unfamiliar calibration output;
- unsupported color encodings, subpixel dot sizes below one device pixel, or dimensions exceeding the GPU viewport limit;
- GPU context loss.

A deliberate switch to Canvas copies the existing trail when its dimensions still match. Context loss cannot recover lost GPU pixels, but the analyzer history remains available and rendering continues through Canvas. A failed context is not recreated repeatedly in the frame loop. Resize and session/mode/zoom resets retain their existing behavior.

## Verification

`vectorscopeGpu.test.ts` checks calibration fallback, ordered overlapping dots with distinct colors/alphas, batch growth and reuse, reset, history transfer, context loss, initialization failure, and resource disposal. Real Electron comparisons additionally cover all five projection modes, native and JavaScript analysis, multiband, theme colors/transparency, persistence, resize, reset, DPR 1 and 2, an alternate Canvas backend, and forced GPU loss.

Temporary development fixtures and raw measurements are under `/private/tmp/astra-vectorscope`; that directory is not a permanent test dependency. The benchmark feeds deterministic 48 kHz stereo PCM through the real native analyzer and visualization transport, at 120 Hz and 420×210 CSS pixels. Pixel density is recorded from the renderer: the early visual checks used DPR 2, the initial timing runs used DPR 1, and a separate final timing run explicitly resets browser zoom to use DPR 2. Mixed layouts contain spectrum, oscilloscope, and vectorscope. It measures all Electron benchmark processes, including graphics-process CPU, and excludes playback decoding/EQ/device output and the rest of the application UI. CPU instructions, CPU time, whole-system GPU utilization, and watts are different measurements. Battery/thermal savings and Windows/Linux performance have not been measured.

### Local measurements, 2026-09-22

On an Apple M5 Pro, Electron 40.10.0, Graphite/Dawn/Metal, against `6a0ba26`: three paired rounds at DPR 2, with the middle round reversing order, two seconds of warmup and six measured seconds per trial:

| Multiband layout | Canvas CPU ms/s | GPU CPU ms/s | CPU time reduction | CPU instruction reduction |
| --- | ---: | ---: | ---: | ---: |
| Vectorscope alone | 522.7 | 445.8 | 14.7% | 88.2% |
| With spectrum and oscilloscope | 562.0 | 499.4 | 11.1% | 82.5% |

Individual CPU ms/s trials were 523.2 / 522.4 / 522.4 versus 451.8 / 430.5 / 455.0 alone, and 559.4 / 568.4 / 558.2 versus 501.1 / 505.8 / 491.3 mixed. The renderer remained on the GPU path, all trials rendered 720 frames, and WebGL reported no errors. Whole-system GPU activity averaged 50.7% versus 39.8% alone and 47.4% versus 43.2% mixed; these samples are not application-specific power measurements.

At DPR 1, multiband mixed-layout CPU time fell 6.2%, while whole-system GPU activity rose from 46.3% to 48.9%. Ordinary mixed-layout GPU rendering increased CPU time 9.6% despite fewer instructions, which is why ordinary mode keeps Canvas. The instruction reductions should not be presented as equivalent energy savings.

The final mode-toggle comparison was pixel-identical for ordinary mode and Canvas fallback; GPU multiband differed by at most 2/255 per channel. Earlier broader GPU comparisons described above include the larger full-persistence rounding difference. Ten focused tests, typecheck, and the production build passed.

API references: [instanced drawing](https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext/drawArraysInstanced), [blend factors](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/blendFunc), and [Canvas/WebGL context attributes](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/getContext). Skia's [Graphite rectangle renderer](https://github.com/google/skia/blob/main/src/gpu/graphite/render/AnalyticRRectRenderStep.cpp) and [Ganesh rectangle renderer](https://github.com/google/skia/blob/main/src/gpu/ganesh/ops/QuadPerEdgeAA.cpp) provide context for the different coverage rules; the runtime calibration selects the matching behavior.
