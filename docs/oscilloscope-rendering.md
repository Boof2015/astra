# Oscilloscope underfill gradient cache

The oscilloscope reuses its underfill gradient while the canvas height and fill colors are unchanged. Each drawn frame previously created a new gradient and added seven color stops. The cached version keeps the same stops, fill path, trace, boosted amplitude, pitch locking, sample counts, and frame cadence.

The gradient is created lazily when underfill is drawn. Height and color changes rebuild it; disabling underfill and disposing the scope clear the cache. Width-only changes, line-width changes, and audio resets reuse the vertical gradient because its coordinates and colors remain valid. Underfill-off rendering does not access or create it.

Sixteen paired Electron images were byte-identical to `f1711e7`. Cases include explicit and accent-derived colors, light/transparent backgrounds, pitch lock on/off, small canvases, 44.1/48/96 kHz input, Standard/native transport, toggling, resize, theme changes, and reset. An instrumented lifecycle check verified zero gradient creations during unchanged frames, width-only changes, line-width changes, and reset; height/color changes and re-enabling underfill each created one gradient. Three existing scheduler/native-availability tests, typecheck, and the production build passed.

Drawing an explicit theme color directly instead of its uniform gradient was also tried. It changed some pixels and was not retained. The production change only caches the original gradient.

## Measurements

The harness uses Electron 40.10.0 on an Apple M5 Pro, deterministic 48 kHz stereo PCM, 120 Hz rendering, 420×210 CSS pixels at DPR 2, pitch lock enabled, and the default explicit underfill color. The comparison includes three paired rounds against `f1711e7`, reversing order in the middle round, with two seconds of warmup and six measured seconds per trial. Mixed layouts contain spectrum, oscilloscope with underfill, and ordinary vectorscope. CPU totals include all Electron benchmark processes, including graphics-process CPU.

| Layout | Baseline CPU ms/s | Cached CPU ms/s | CPU time reduction | CPU instruction reduction |
| --- | ---: | ---: | ---: | ---: |
| Oscilloscope alone | 347.0 | 343.6 | 1.0% | 2.0% |
| With spectrum and ordinary vectorscope | 454.5 | 453.9 | 0.1% | 0.2% |

Single-scope CPU trials were 349.2 / 347.5 / 344.3 versus 340.5 / 352.4 / 337.9 ms/s; mixed trials were 462.0 / 445.3 / 456.2 versus 449.7 / 452.1 / 460.0 ms/s. These small differences changed direction across rounds. They do not establish a meaningful CPU-time or power improvement. The retained benefit is removing redundant gradient construction without changing the rendered output or adding drawing work.

This excludes playback decoding/EQ/device output and the rest of the application UI. Instruction counts and CPU time are not energy measurements. Raw results and visual fixtures are under `/private/tmp/astra-oscilloscope`. The complete-app before/after comparison remains a separate follow-up after the remaining scope stages, using the baseline recorded in `spectrum-rendering.md`.
