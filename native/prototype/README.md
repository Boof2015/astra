# Native progressive input feasibility

These headless checks investigate bounded PCM input and its native engine
lifecycle for remote playback. The C++ engine, addon and controller now accept
progressive input through the retained cache. Subsonic native output is connected
to the app's existing buffering/Retry UI and **awaits live device validation**.
Local native playback still loads complete `TrackBuffer` objects; Standard remote
playback continues through its existing worklet.

Run from the repository root with a C++17 compiler available:

```sh
npm run test:native-progressive-input
npm run test:native-progressive-input -- --sanitize
npm run test:native-progressive-input -- --thread-sanitize
npm run test:native-progressive-input -- --engine
npm run test:native-progressive-input -- --engine --sanitize
npm run test:native-progressive-input -- --engine --thread-sanitize
```

The runner builds a fresh temporary executable, uses the real native DSP and
vendored resampler, opens no output device, and does not replace the app's addon.
`CXX` can select the compiler executable. On Windows the default is `clang++`;
sanitizer availability depends on the compiler/platform.
`--engine` selects the production `PlaybackEngine` tests with a fake output sink,
including the existing complete-track regression tests. Those tests also run in
the normal `test:native-playback` target after rebuilding the addon.

## Input contract

- One producer appends interleaved source PCM. One consumer reads and releases
  it. Storage is allocated once, capped at 32 MiB per input; a full input accepts
  a partial append or none. The producer must retain/retry any unaccepted suffix.
- Reading uses lock-free publication cursors and borrowed contiguous spans. It
  performs no allocation, decoding, network/disk access, or waits. A span remains
  valid until the consumer releases its range.
- `Open` plus no published frames means starvation. Only explicit decoder EOF
  means `Ended`. Metadata duration never determines the playback boundary.
- Rendering does not release PCM. Release follows device acknowledgement, leaving
  speculative primes available for rollback. A boundary-crossing prime must retain
  both source owners/cursors until committed. DSP input read-ahead is not playback.
- Seek replaces the input with a new instance at an absolute starting frame.
  Cancelled inputs are not recycled for a new decoder. Control must keep each
  instance alive until both producer and consumer detach. No append changes
  paused/stopped playback intent.
- The decoder/controller must size input capacity for device/DSP read-ahead and
  the next-track readiness threshold (currently 0.75 seconds or a nonempty EOF).
  The 32 MiB cap is per input, not an aggregate budget for all decoder owners.

`native/src/pcm_input.h` supplies the read boundary and a complete-buffer adapter.
The existing `ProcessedAudioPipeline::render(TrackBuffer, ...)` uses that adapter;
the new overload accepts incremental input. It preserves DSP queues over starvation,
holds limiter lookahead until available, and flushes only at decoder EOF. Short
resampled tracks may require several zero-input blocks to drain the filter; these
are now supplied in the same render call instead of inserting an empty callback.

## Evidence and remaining work

The probe compares real incremental DSP output byte for byte with complete-input
output across 96 combinations of rates, PCM output formats, channels and seek
positions. It also checks 15 empty/short-stream cases, two processed album boundaries,
direct PCM byte preservation, bounded wraparound, producer/consumer concurrency,
starvation, cancellation, and retained-input replay after speculative rendering.

The default probe's direct lifecycle driver models consumption/rollback. The
`--engine` suite additionally exercises the real engine: starvation, partial
consumption across a gapless block, failed boundary-crossing primes, startup EOF,
paused replacement seeks, a seek racing a device-acknowledged transition, queue
withdrawal, late preparation, stop/cancellation, device changes, processed
pause/resume, different-rate gapless output with EQ/gain, and concurrent decoding
and event polling. It compares processed audio against the real complete-input
pipeline and checks source diagnostics before and after consumption. Consumed
source owners are retained until a control/poll call can destroy them.
There is no hardware bit-perfect certification or live remote/native playback here.

The engine target also exercises the production endpoint audio/padding ledger
against a per-frame reference (120,000 randomized operations across ten queue
sizes). It covers partial writes, unchanged padding/free-space reports, wrapping,
reset, cancellation and recovery. Real-engine checks combine that ledger with
starvation followed by gapless handoff, failed-write rollback/re-render, and
ordinary local direct/processed playback. Local output is compared byte for byte
with complete-track PCM/DSP output. The shared partial-write driver is the one
used by ALSA; these tests do not invoke the actual ALSA or WASAPI APIs.

## Addon and decoder transport

`playback.createProgressiveInput` creates an internal producer handle with strict
format/size validation and append/status/finish/cancel operations. It can attach
once as current, prepared next, or an asynchronous replacement seek with an
expected session ID. No JS PCM pointer is retained. Shared native ownership
outlives a collected handle; external-memory accounting encourages collection of
discarded producer rings. Handles must not cross the renderer context bridge.

`src/preload/nativePcmDecoder.ts` transports raw decoder output into those rings.
It retains unaccepted suffixes, carries incomplete frames between pipe chunks,
and pauses decoding when the input is full. Readiness defaults to 0.75 seconds
or a shorter validated EOF. A long backpressure wait does not trigger the decoder
inactivity timeout. Abort/native cancellation terminate the subprocess; failed,
empty or truncated output leaves accepted PCM available without marking EOF.
The caller must surface failure and arrange a replacement decoder for Retry.

The pump does not choose sample formats, start playback, or own the cache lease.
The controller retains that lease throughout current/next playback ownership,
including after decode EOF. It allocates up to eight seconds per ring, capped at
32 MiB, with a temporary replacement during seeks. This cap is per input, not an
aggregate process-memory claim. Main-process sender ownership bounds active and
pending leases and cleans up after cancellation, navigation and renderer teardown.
Logical provider paths stay separate from the internal decoder URL.

After rebuilding the addon, run:

```sh
npm run test:native-dsp
node --experimental-strip-types --loader ./scripts/node/electron-test-loader.mjs --test src/preload/nativePcmDecoder.test.ts src/preload/nativeAudioStatus.test.ts
node --experimental-strip-types --loader ./scripts/node/electron-test-loader.mjs --test src/preload/nativePcmDecoder.integration.test.ts
node --experimental-strip-types --loader ./scripts/node/electron-test-loader.mjs --test src/main/nativeRemoteLeaseRegistry.test.ts src/preload/nativeRemotePlayback.test.ts
```

The addon tests include forced collection of a producer while the engine still
owns its audio. The integration test generates FLAC, serves it through the real
retained cache, and compares s16/s24/s32/f32 decoding and a replacement seek to
reference PCM. It also verifies protected cache/offline reuse and the production
controller's probing/load/preparation/seek/stop paths. It opens a temporary loopback
HTTP listener, but no output device and no external music server.

## Remaining validation

Before treating native remote support as release-validated:

1. Validate the OS sinks on their target platforms. WASAPI and ALSA now use the
   ordered endpoint ledger, so consuming buffering silence does not credit later
   audio. ALSA free space is interpreted against outstanding queue depth; write
   recovery re-renders after rollback, and final playback underrun drains EOF
   instead of replaying the tail. WASAPI pause credits an event-driven period
   only if a device event is pending; an unconfirmed partial period is replayed
   on resume rather than silently skipped. These platform branches have been
   reviewed but not compiled/executed on Windows/Linux in this macOS checkout.
2. Exercise real server playback through startup, seeking, pause/resume,
   cancellation, offline cache reuse and Retry. Automated tests cover retained
   next preparation through seeks, stale work, decoder failure without EOF,
   handoff during withdrawal and renderer identity/buffering. Incompatible or late
   preparation uses ordinary next-track loading. Mixed local/remote native tracks
   are not prepared gaplessly in this implementation.
3. Verify readiness/buffer budgets, aggregate live/retired input ownership, and
   format/output-mode changes end to end. Direct gapless requires equal source
   formats; processed gapless currently requires matching channel counts. Existing
   render code still has locks/event/vector operations; this work does not claim
   the entire native callback is lock-free or free of allocations/deallocations.
4. Validate CoreAudio, WASAPI and ALSA start/retry, underflow and consumption
   accounting, then test the UI and actual output. Existing bit-perfect diagnostics
   must reflect negotiated device output, not merely an original-quality request.

Headless success does not establish hardware bit-perfect output or validate every
server, codec and device combination. Check existing local playback alongside
the first native remote listening tests.
