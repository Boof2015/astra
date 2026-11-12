# Stratum in native Exclusive and Bit-perfect output

Processed Exclusive uses the same installed Sidecar connection, retained segment
cache, automatic quality controller and next-track fetch priority as Standard.
Bit-perfect uses the same bridge with Original-only delivery and exact integer
packing. Standard and processed Exclusive negotiate Original and Opus
64/128/192/256/320 with updated Sidecars. Older Sidecars retain their
Original/64/128 ladder. The supported source formats and source limits are
unchanged.

## Bit-perfect rules

An eligible, enabled Stratum connection always uses Original in direct output,
even when the saved streaming preference is Automatic or Fixed. Both the quality
controller and the Automatic cache profile are disabled for this route. Retained
Opus never substitutes for a missing Original interval, including offline replay.

The bridge carries authenticated source precision alongside source-rate s32 PCM.
Preload uses the same native format selection as conventional playback: 16-bit
sources use s16; 24-bit sources use packed s24 for WASAPI/ALSA and s32 for
CoreAudio. Repacking removes only zero padding and rejects nonzero discarded
bits. It performs no floating-point conversion, gain, dither or resampling.
Track gain is explicitly off. Existing native device negotiation and format
compatibility rules still decide whether output and a handoff are possible.

If an attempted direct Stratum startup fails, conventional playback is requested
at Original instead of reverting to the saved reduced-quality preference.
Ineligible sources, disabled Stratum and explicit conventional compatibility
retries retain their existing behavior. A failure after playback starts remains
an error; it never changes to lossy Stratum or reports successful EOF.

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

It verifies exact 16/24-bit Original PCM and non-boundary seeks at 44.1/48/96 kHz,
native integer packing, exact Opus 64/128/192/256/320 frame counts, bounded delivery, cached
seeks, audible quality markers, diagnostic rates and startup fallback. Mixed
quality and Opus-only caches prove direct playback requests lossless intervals,
while processed Automatic can still use its retained Opus offline.

The Node suite adds native controller, cancellation, owner isolation, fallback,
normalization snapshot, promotion and renderer identity checks. Direct-format
tests cover all three backend policies, mono/stereo integer extrema, precision
loss rejection, and rejection of a reduced representation before native input
creation. Separately:

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
readout, DSP and a cached replay. Higher bitrates require the expanded-ladder
Sidecar build; Exclusive and Bit-perfect support alone require no server update.

The user confirmed processed Exclusive playback on 2026-10-26 and committed that
checkpoint, then confirmed Bit-perfect playback and committed that checkpoint.
The expanded ladder's new bitrates still need a physical-device listening check.
