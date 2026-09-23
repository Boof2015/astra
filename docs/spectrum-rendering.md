# Spectrum heatmap color caching

The curve heatmap reuses its formatted CSS colors instead of rebuilding RGB/RGBA strings for every column on every frame. The cache key includes both the palette index and the final rounded alpha: nearby intensities can select the same palette entry while requiring different opacity. The cache preserves the existing channels and three-decimal CSS alpha formatting exactly.

Colors are formatted lazily. Palette changes replace the lookup table and clear the cached styles; disabling heatmap or disposing the scope clears the cache. The change adds no drawing surfaces, GPU contexts, uploads, frame loops, or compositing passes. Ordinary curve, gradient, bar, and heat-colored bar rendering remain unchanged, as do column bounds, analysis, resolution, frame cadence, and all display options.

## Why this implementation

Against `6ce5c8d`, the initial two-round isolated comparison measured:

| Candidate | Mean CPU ms/s, before → after |
| --- | ---: |
| Reuse the curve path for gradient fill and stroke | 226.6 → 228.9 |
| Cache heatmap color strings | 346.4 → 319.4 |
| Draw heatmap as a clipped image row | 346.4 → 282.1 |
| Batch separated bars and peak caps | 239.0 → 245.3 |
| Batch separated heat-colored bars and peak caps | 267.1 → 267.4 |

The image-row candidate received broader validation, but the final three-round comparison showed 11.8% less CPU time alone and 0.8% more with spectrum, oscilloscope, and vectorscope together. In the mixed layout, graphics-process CPU increased enough to offset renderer CPU savings. Simplifying its clip outline did not resolve this. That implementation was removed.

The smaller color-cache candidate reduced mixed-layout CPU time from 458.8 to 452.7 ms/s in a two-round comparison, with fewer instructions and the original Canvas drawing path. Its gain was modest, but it avoided the image/compositing tradeoff. Curve-path reuse and bar batching were also left out because they did not consistently reduce CPU time.

## Verification and final measurement

`spectrumHeatmapColors.test.ts` checks exact CSS output, distinct alphas within one palette bin, and palette invalidation. Existing spectrum tests continue to cover heatmap toggling, native-frame selection, Side, and bars.

All 19 paired Electron images of the final implementation were byte-identical. These cover classic/custom palettes, light backgrounds, transparency, base colors, linear/log scales, canvas sizes, Side, 44.1/48/96 kHz input, Standard/native transport, and mode/theme/FFT/resize/reset transitions. Seventeen focused tests, typecheck, and the production build passed.

The local harness uses Electron 40.10.0 on an Apple M5 Pro, deterministic 48 kHz stereo PCM, FFT 2048, 420×210 CSS pixels at DPR 2, and 120 Hz rendering. It measures all Electron processes, including graphics-process CPU. Mixed layouts contain spectrum with heatmap enabled, oscilloscope, and ordinary vectorscope. The final integrated comparison uses three paired rounds, reverses order in the middle round, and allows two seconds of warmup and six measured seconds per trial.

Final integrated results, 2026-09-22:

| Layout | Baseline CPU ms/s | Cached CPU ms/s | CPU time change | CPU instruction reduction |
| --- | ---: | ---: | ---: | ---: |
| Heatmap spectrum alone | 398.1 | 375.2 | 5.8% lower | 21.5% |
| With oscilloscope and ordinary vectorscope | 448.1 | 447.2 | Essentially flat (0.2% lower) | 6.2% |

Individual CPU ms/s trials were 387.3 / 409.8 / 397.2 versus 379.6 / 377.5 / 368.4 alone, and 448.1 / 455.4 / 440.8 versus 448.8 / 438.9 / 454.0 mixed. All trials rendered 720 frames. Whole-system GPU activity was also approximately flat: 29.6% versus 29.3% alone and 38.6% versus 38.9% mixed. These are system-wide samples, not app-specific energy measurements. The mixed-layout CPU-time difference is too small and variable to call a demonstrated improvement.

The benchmark excludes playback decoding/EQ/device output and the rest of the application UI. CPU time and instruction counts are not watts or battery measurements. Temporary fixtures and raw results are under `/private/tmp/astra-spectrum`; they are not runtime dependencies.

## Overall before/after follow-up

Once the remaining scope stages are covered, compare the complete application with the pre-renderer baseline `e996ab5`, as well as recording each stage's local comparison. Use identical tracks, playback modes, window sizes, themes, and display refresh rates, with common one-, two-, and three-scope layouts. Include a scopes-hidden control and separate Standard/DSP runs. Do not add the individual stage percentages together or extrapolate these Mac results to Intel/AMD power consumption. Actual energy/temperature changes require a separate measurement.
