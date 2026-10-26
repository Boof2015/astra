# Stratum in processed Exclusive output

Processed Exclusive uses the same installed Sidecar connection, retained segment
cache, automatic quality controller and next-track fetch priority as Standard.
Bit-perfect keeps its existing conventional source path. The supported source
formats, source limits and Original/Opus 64/128 ladder are unchanged.

## Playback ownership

`NativeStratumRegistry` owns authentication, fetching, interval decoding and cache
pins in main. Preload pulls source-rate signed 32-bit PCM in packets no larger
than 64 KiB into the existing native progressive input. That input retains at
most eight seconds (also capped at 32 MiB). IPC and decoding run outside the
native audio callback. Main's stream is backpressured; the existing Stratum
fetch-ahead can continue filling the encoded cache independently.

The native engine keeps responsibility for processing, device-rate conversion,
output, and gapless transitions. There is no additional continuous FFmpeg output
resampler in this route. Opus interval decoding still restores the protocol's
native source frame domain before the native engine sees it.

- Renderer ownership scopes every main-process handle. Cancellation releases
  pending work; decoded EOF does not release the retained cache pins while the
  track still owns playback.
- Seeking closes the obsolete Sidecar feed before opening its replacement,
  preserving room for the already-prepared successor. Native swaps inputs using
  its existing session guard. A stale seek cannot replace a promoted track.
- The successor becomes current only on native promotion. It shares Standard's
  network prefetch gate until then.
- Quality markers follow the consumed source frame, not the downloaded segment.
  Stratum's interval controller handles adaptation; the conventional whole-stream
  quality replacement controller stays inactive for this route.
- Gain is selected at track preparation and preserved across seeks and quality
  updates. Finishing background analysis does not change gain mid-track. Cached
  analysis and waveform notifications use the existing player-store path.
- Startup failures can fall back before PCM is handed to native. Failures after
  playback starts remain errors, not successful EOF or a silent source switch.
- Native input IDs and main diagnostics IDs remain separate. Diagnostics receive
  the native device's output rate while retaining the source rate.

## Silent verification

Build `sidecar-access` in the Stratum repository, then run:

```sh
ASTRA_STRATUM_SIDECAR=/absolute/path/to/sidecar-access npm run test:stratum-exclusive
```

The proof starts a bounded local Sidecar and a generated Subsonic fixture. It
uses the real main registry, cache, PCM decoder and preload bridge, with a
capacity-limited fake native input. It opens no Electron window or audio device,
does not use a personal database or server, and removes its temporary files.

It verifies exact Original PCM and non-boundary seeks at 44.1/48/96 kHz, exact
Opus 64/128 frame counts, bounded delivery, cached seeks, audible quality markers,
diagnostic rates, startup refusals and refusal of direct/bit-perfect requests.

The Node suite adds native controller, cancellation, owner isolation, fallback,
normalization snapshot, promotion and renderer identity checks. Separately:

```sh
npm run test:native-progressive-input
node scripts/node/run-native-progressive-input-prototype.cjs --engine
```

These compile the real native PCM/DSP and playback engine against a silent fake
output sink. Together they cover the processing side of the bridge, including
resampling and transitions. They do not prove device behavior or audible quality.
The existing `test:stratum-proof` and `test:stratum-session` remain Standard and
session regression checks.

## Listening still to do

With an installed Sidecar already enabled in Astra, restart the development app
and select Exclusive output. Check Original and fixed Opus, Automatic through a
network slowdown/recovery, pause/resume and seeks, a known gapless album pair,
and transitions to/from local or conventional remote tracks. Verify the quality
readout, DSP and a cached replay. No Sidecar upgrade is required for this change.

As of 2026-10-25, automated verification is silent; this new route has not yet
been listened to on a physical output device.
