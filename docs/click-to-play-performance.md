# Click-to-play performance — 2026-09-05

The implemented change removes redundant preparation of path-based queues. With a 50,000-track context, controlled warm preparation fell from **46.3 ms to 20.0 ms** (p95 **50 → 25 ms**). In the corresponding real FLAC playback case, command-to-scheduled-play fell from **234 → 204 ms** median. Small album queues showed no consistent end-to-end improvement.

Complete-track playback, normalization, decoder selection, queue publication, shuffle, manual insertions, metadata hydration and cancellation remain in place. No commits were made. The existing library/artwork improvements in baseline `7e9d3dd314cb08b97a16109609d22396898469d1` were preserved.

## Method and limits

- Hardware: Apple M5 Pro, 15 CPU cores, 48 GiB RAM, arm64 macOS (Darwin 25.5.0); built-in MacBook Pro speakers, two physical output channels. Electron 40.10.0, Chromium 144.0.7559.236, V8 14.4.258.32. This is a fast development machine, not a reproduction on a slower Windows or Linux computer.
- Production Electron/Vite builds with the real main process, preload, renderer app, player store, AudioEngine, FFmpeg decode and native addons. The baseline build substitutes only the original queue-preparation sections from the baseline commit; both versions have the same measurements.
- Ten cases × two versions × five fresh processes = **100 processes and 500 commands**. Each case/version has five first-play observations and twenty subsequent clicks, with all twenty warm clicks in its first process. Warm clicks alternate between two fixture paths while playback is active. Results ran sequentially, before then after, on a development workstation; small differences and tails should not be treated as isolated causal effects.
- “Cold” means a fresh process and profile, after normal app startup settles for one second. It does **not** mean an empty operating-system file cache. Cached-normalization cases prime only the temporary loudness cache before first play.
- Generated 48 kHz fixtures: three-minute stereo MP3 and FLAC, eight-minute stereo FLAC, and two-minute six-channel FLAC. Synthetic signals make runs reproducible; they do not span real music entropy, codecs, disks or hardware. The long case stays below the existing complete-track size threshold. Six-channel processing ran through a stereo device, not six physical speakers.
- Contexts contain 12 or 50,000 cached metadata entries. The selected track is last, so upcoming-track prebuffering and loudness warmup do not contaminate the startup measurements. All context queue entries are still constructed and published. Other queue positions can incur additional unchanged upcoming-list work.
- Every process uses a fresh temporary profile/database/cache. No user library or loudness cache is opened. HTTP(S) requests are blocked in the harness. Standard output is muted at the Electron window; native compatibility uses silent fixtures.
- Diagnostics sampling is disabled. Attempt completion explicitly requests `captureSample: false`. No forced garbage collection or profiler is used. The harness measures loudness IPC duration separately without changing the returned result.

`commandToLoadingStateMs` ends at publication of the loading state. The harness also updates a DOM loading indicator on that state change and records a double-animation-frame opportunity. This is a feedback scheduling measurement, not proof of a compositor-presented pixel. `commandToScheduledPlayMs` ends when playback scheduling completes; it is **not hardware-audible latency**. Configured output delay was **0 ms**, recorded separately throughout.

## Queue preparation in isolation

The controlled loader replaces only `_loadAndPlayTrack`. The measured interval includes the real store command, queue preparation/publication and transition scheduling up to that loader. It does not include decoding. Times are milliseconds; p95 uses nearest rank.

| Context | Version | Five fresh-process observations | Warm median | Warm p95 |
| --- | --- | --- | ---: | ---: |
| 12 tracks | Before | 1.0, 1.0, 1.2, 1.1, 1.2 | 1.0 | 1.4 |
| 12 tracks | After | 1.1, 1.0, 0.9, 0.8, 1.3 | 0.8 | 1.4 |
| 50,000 tracks | Before | 42.9, 41.1, 41.5, 41.5, 42.2 | 46.3 | 50.0 |
| 50,000 tracks | After | 12.0, 12.8, 12.4, 12.5, 12.5 | 20.0 | 25.0 |

The large-context improvement exceeds the observed variation across fresh processes and warm clicks. The optimization is retained on that evidence. The small-context difference is below useful significance.

For a fully cached context, path preparation previously traversed the context eight times, including collection constructors. It now traverses it once. This avoids seven full traversals, four length-N intermediate arrays plus the missing-path filter array, a temporary Map and cached-path Set, N key/value pair arrays, and N redundant Track/snapshot copies. At 50,000 occurrences that removes 50,000 pair arrays and 50,000 extra object copies. These are source-level allocation counts, not measured heap-byte savings. The final entries, one snapshot per occurrence, missing-path Set, and downstream queue structures remain necessary.

## Real playback

All values below are milliseconds. Each row contains the five fresh-process command-to-scheduled-play observations, then warm median/p95. Normalization defaults to enabled; “ReplayGain” supplies track gain of -3 dB and enables its override.

| Case | Version | Five fresh-process observations | Warm median | Warm p95 |
| --- | --- | --- | ---: | ---: |
| FLAC, uncached normalization | Before | 266, 237, 246, 239, 239 | 205 | 361 |
| FLAC, uncached normalization | After | 237, 241, 245, 241, 279 | 203 | 354 |
| FLAC, cached normalization | Before | 225, 236, 228, 231, 237 | 191 | 359 |
| FLAC, cached normalization | After | 232, 227, 229, 225, 241 | 194 | 346 |
| FLAC, normalization disabled | Before | 233, 229, 233, 232, 228 | 189.5 | 338 |
| FLAC, normalization disabled | After | 231, 233, 231, 230, 230 | 193 | 336 |
| FLAC, ReplayGain | Before | 231, 272, 252, 239, 230 | 190 | 343 |
| FLAC, ReplayGain | After | 292, 234, 227, 226, 228 | 199.5 | 362 |
| FLAC, 50k context, cached normalization | Before | 281, 268, 271, 271, 334 | 234 | 241 |
| FLAC, 50k context, cached normalization | After | 242, 237, 263, 243, 263 | 204 | 213 |
| MP3, uncached normalization | Before | 360, 326, 332, 327, 334 | 302.5 | 455 |
| MP3, uncached normalization | After | 356, 331, 333, 327, 340 | 317 | 459 |
| Eight-minute FLAC, uncached normalization | Before | 450, 453, 452, 454, 554 | 416 | 689 |
| Eight-minute FLAC, uncached normalization | After | 465, 469, 472, 465, 464 | 437.5 | 721 |
| Six-channel FLAC, uncached normalization | Before | 348, 405, 392, 406, 359 | 342.5 | 635 |
| Six-channel FLAC, uncached normalization | After | 341, 349, 339, 341, 344 | 310 | 593 |

There is no consistent small-album improvement: some cases are faster, others slower. The decoder and normalization algorithms were not changed. The 50k case has a directly attributable reduction in preparation work as well as lower end-to-end latency.

Loading feedback is separate from those playback times:

| Context / cached FLAC | Loading-state median, before → after | Feedback frame median, before → after | Feedback frame p95, before → after |
| --- | ---: | ---: | ---: |
| 12 tracks | 0.6 → 0.7 | 13.1 → 14.0 | 16.3 → 16.2 |
| 50,000 tracks | 44.3 → 16.0 | 52.9 → 20.6 | 56.8 → 22.7 |

## Remaining work and validation

Detailed stage distributions, including initialization, preflight, probe, decoding, PCM conversion, loudness and synchronization waits, are preserved in [click-to-play-timings.json](click-to-play-timings.json). The full raw per-process observations and temporary fixtures from this run are at `/private/tmp/astra-playback-verified`.

The remaining cost is primarily complete-track decoding and PCM installation. After-change warm medians/p95s show where a follow-up should investigate:

| Case | FFprobe median | FFmpeg decode median | PCM deinterleave median / p95 | Full loudness request median | Additional loudness wait p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Stereo FLAC, uncached | 41.8 | 128.8 | 16.2 / 168.3 | 139.2 | 0.2 |
| Stereo FLAC, cached | 41.4 | 122.7 | 12.6 / 170.5 | 0.2 | 0.2 |
| Stereo MP3, uncached | 44.2 | 235.6 | 14.3 / 173.0 | 249.0 | 0.1 |
| Eight-minute FLAC, uncached | 42.4 | 337.4 | 36.5 / 322.3 | 361.7 | 0.1 |
| Six-channel FLAC, uncached | 41.6 | 216.2 | 31.2 / 314.0 | 204.7 | 0.1 |

The PCM-conversion intervals have substantial tails. Those wall-clock measurements can include GC and thread scheduling; they do not prove the arithmetic loop alone caused the spikes. Profiling allocation/GC and PCM installation with real music is a useful next step before choosing a larger playback change.

Fresh loudness analysis still performs a separate complete-file pass. It used measurable time and CPU, but overlapped decoding in these fixtures: the extra critical-path wait was at most 0.2 ms at p95. Cache hits were identified as `cache`, fresh passes as `analysis`, and disabled/ReplayGain cases as `not_required`. These results do not establish uncached normalization as the dominant delay on this hardware. Normalization behavior was preserved.

Audio-context readiness contributed approximately 0 ms during these clicks because normal app startup had already initialized it. Local preflight medians were about 1–2 ms. No context or native-control synchronization was removed. Superseded PCM and hydration completions remain guarded by their existing generations.

A separate first-play subprocess trace observed two `ffmpeg -version` checks starting about 2 ms apart, alongside one FFprobe check. Decode and loudness can concurrently enter the uncached binary resolver. Completed paths are cached, but an in-flight lookup is not shared. Coalescing those lookups is a possible focused follow-up; its effect on playback latency was not measured here, so no initialization behavior was changed.

Final validation:

- Full suite: **1,390 passed, 2 skipped, 0 failed** (Node: 1,280 passed/1 skipped; Electron SQLite: 110 passed/1 skipped).
- Type checking passed for production sources and the benchmark TypeScript. Production build passed.
- Added duplicate-path snapshot independence, rapid A→B→C path-click/late-hydration coverage, and loudness-origin diagnostics checks. Existing coverage exercises uncached selected tracks, bounded background hydration, manual/shuffled queues, immediate Pause/Stop, stale decode completion, native serialization and prebuffer handoff.
- Live production checks passed in **Standard, processed-exclusive CoreAudio and bit-perfect CoreAudio**: cold play, seek, prebuffer readiness, manual next promotion, Pause/Resume, natural gapless event and Stop. Silent eight-second fixtures were used. This verifies software behavior, not physical gaplessness or bit-exact electrical output.
- Parallax had no paired sink available for an end-to-end check. Existing Parallax and playback regression coverage passed. Windows WASAPI, Linux ALSA and slower-machine performance remain unmeasured.

## Reproduce

Run from the repository root with the existing dependencies and native addons built:

```sh
ASTRA_PLAY_BENCH_BUILD=before npx electron-vite build --config scripts/research/click-to-play.config.ts
ASTRA_PLAY_BENCH_BUILD=after npx electron-vite build --config scripts/research/click-to-play.config.ts
node scripts/research/click-to-play.cjs before,after /private/tmp/astra-playback-repeat
node scripts/research/click-to-play.summarize.cjs /private/tmp/astra-playback-repeat
```

The baseline queue sections come from `7e9d3dd`; override with `ASTRA_PLAY_BENCH_BASELINE_REF` when building `before` if needed. `ASTRA_PLAY_BENCH_CASE=controlled` limits the runner to the two controlled cases. Each process result includes its fixture configuration, temporary profile path, hardware, load-stage diagnostics and feedback timing. A `STOP` file in the results directory prevents the next process from starting. Builds and resource links live in ignored `.astra-playback-benchmark/`, outside the packaged `out/` tree. The benchmark entry points are excluded from the regular application build.
