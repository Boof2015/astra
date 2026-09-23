# VU and LUFS render-input caching

Needle VU reuses parsed theme colors, derived alpha colors, and measured widths for its fixed face labels. LUFS reuses its fixed readout-width sample, parsed accent color, and computed text contrast. Cached layout measurements skip both Canvas font access and text measurement. When a LUFS readout fits at the requested font size, the tag reuses the width already measured during layout. A scaled readout is still measured again at its final font size.

The Canvas drawing commands, draw order, meter scales, needle movement, sample processing, native analysis, readout precision, and frame cadence are unchanged. No extra canvas surfaces or GPU contexts are added.

Caches belong to each meter. Option changes and resize clear their inputs. Text widths are keyed by font and text, bounded to 256 entries, and invalidated when fonts finish or fail to load in the canvas's owning document. Disposal removes those document listeners. LUFS contrast is keyed separately by the accent color.

An offscreen image of the static scale was also tested. It changed pixels and did not consistently improve CPU time, so it was not retained. Caching a history of changing LUFS readout strings was replaced with direct reuse of the measurement within the same frame. Ordinary VU bar drawing and the shared correlation bar retain their original rendering code; color caches did not justify their overhead there.

## Validation

Compared with `561ff19`, 44 paired Electron canvas captures of the final code were byte-identical. The checks cover VU horizontal/vertical bars and stereo/combined needles, reference-level changes, LUFS integrated/short-term/momentary readouts, light and transparent backgrounds, narrow and wide canvases, DPR 1 and 2, resizing, theme/mode changes, reset, pause/resume, and Standard/native sample transport. Native snapshots were recorded from the baseline and replayed for the paired render to keep wall-clock-dependent peak decay identical. VU's JavaScript animation clock was also fixed across each pair.

Eleven tests passed, including existing LUFS layout, scheduler, and native-availability coverage, plus cache font invalidation, bounded retention, and listener cleanup. Typecheck and the production build passed.

## Measurement setup

The final comparison uses Electron 40.10.0 on an Apple M5 Pro, deterministic 48 kHz stereo PCM, 120 Hz rendering, 420×210 CSS pixels per scope at DPR 2, and the application's JetBrains Mono 400/500 fonts. Each layout has three paired rounds, reversing order in the middle round, with two seconds of warmup and six measured seconds per trial. The mixed layout contains spectrum, needle VU, and LUFS. Timed runs use the real native snapshots rather than the visual comparison's replay.

CPU totals include all Electron benchmark processes, including graphics-process CPU. The harness exercises sample transport, native analysis, and rendered scopes, but excludes playback decoding/EQ/device output and the rest of the application UI. CPU time and instruction counts are not energy measurements. Raw trials and images are under `/private/tmp/astra-meters`.

## Results

Means from the final three paired rounds:

| Layout | Baseline CPU ms/s | Cached CPU ms/s | CPU time reduction | CPU instructions change |
| --- | ---: | ---: | ---: | ---: |
| Needle VU alone | 333.2 | 287.6 | 13.7% | −11.4% |
| LUFS alone | 316.8 | 285.0 | 10.0% | +1.8% |
| Spectrum + needle VU + LUFS | 410.7 | 405.2 | 1.3% | −5.6% |

Needle VU improved CPU time and instruction counts in every pair. Its baseline CPU trials were 336.1 / 332.5 / 331.0 ms/s, versus 274.2 / 299.9 / 288.6 ms/s after caching.

LUFS CPU trials were 285.9 / 340.6 / 323.7 versus 212.8 / 320.9 / 321.3 ms/s. Its apparent CPU-time saving ranged from 0.7% to 25.6%, while instruction counts showed no consistent reduction. The 10% mean is too variable to treat as an established LUFS efficiency gain.

Mixed-layout CPU trials were 396.0 / 417.5 / 418.6 versus 408.7 / 386.4 / 420.6 ms/s. CPU-time differences changed direction across rounds; the 1.3% mean does not establish a meaningful CPU-time improvement. Instruction counts were lower in every mixed-layout pair. None of these results establish reduced watts or heat. Final raw measurements are in `/private/tmp/astra-meters/ready-results.json`.

The complete-app before/after comparison remains the next separate stage, using `e996ab5` as the recorded baseline and representative one-to-three-scope layouts in Standard and DSP playback, plus a hidden-scopes control.
