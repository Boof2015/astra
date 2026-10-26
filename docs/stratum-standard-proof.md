# Stratum: first Standard playback connection

Processed Exclusive has its own [implementation and verification notes](stratum-exclusive-proof.md).

Development experiment, not a released client. Checkpoint B's authenticated
Sidecar segments now feed Astra's existing Standard PCM sessions and worklet.
Track/catalog identity, playlists and playback reporting remain with Navidrome.
The broader integration checkpoint C is still in progress.

## Silent proof

Build `sidecar-access` from Stratum checkpoint B (`7babad5`) or later. FFmpeg and
FFprobe must be on the service's PATH. Astra uses its bundled `ffmpeg-static`;
the proof therefore also exercises different server/client FFmpeg builds.

```sh
ASTRA_STRATUM_SIDECAR=/absolute/path/to/sidecar-access npm run test:stratum-proof
```

This starts one bounded Sidecar and a controlled loopback Subsonic upstream with
generated WAV files and disposable credentials. It executes Astra's actual main
session functions with a simulated Electron sender/library, then renders the
delivered PCM through the actual worklet in a VM. No Electron app, audio device,
personal library or existing server is used. The upstream is a fixture, not
Navidrome itself; checkpoint B's separate proof covered real Navidrome. The
service has a hard deadline and its temporary directory is removed at teardown.

Checks cover:

- Native 44.1/48/96 kHz to 48 kHz output, Original and Opus 64/128, exact lossless
  PCM against independent whole-source decoding, measured Opus alignment inside
  each interval, and exact remaining frame counts through EOF.
- Non-boundary seeks with source-zero conversion phase and real pre-roll.
- A worklet handoff between different native rates, compared sample for sample.
- Scripted lossless → Opus 64 → Opus 128 through one continuous output converter.
- Both automatic modes starting cold at Opus 128, climbing to Original, lowering
  quality and recovering in one main PCM session, with exact frame counts and
  seek-relative quality markers. A loopback proxy paces the real segment bytes
  (fast, then 150 kbps for nine seconds, then fast); the in-flight Original interval
  must be abandoned and the same interval requested cheaper. Consumption is
  simulated; this is not a shaped real network. Controller unit tests separately
  exercise costs, abandonment and failures; `shapedBaseline.ts` covers 3G/Edge.
- Held-consumer backpressure, cancellation without late chunks, and seeking
  current while the prepared successor owns the other service playback slot.
- Midstream permission refusal/outage produces failure, never EOF or a bypass
  through conventional retained audio.

Normal `npm test` also covers client validation, the development route, and
renderer seeking, next-track preparation and failures for restartable PCM
without a cache file, alongside existing conventional/local playback tests.
It also checks quality markers against the real worklet cursor, pause/seek and
successor isolation, plus the player store's transport-readout updates.

## Isolated listening proof

`scripts/stratum/listen.cjs` runs a separate, bounded test window with Astra's
actual `AudioEngine`, real Electron IPC, main progressive-session functions and
worklet. It uses real Sidecar/FFmpeg, a controlled loopback Subsonic upstream and
a simulated catalog. It does not open the full application or personal database.

Two Bluetooth listens passed on 2026-10-17, with native 48 kHz stereo music and
the device's existing 44.1 kHz output rate, at test gain 0.25:

- A 32-second album transition, Original → Opus 64 between tracks: one gapless
  handoff, no reported buffering, and a user-confirmed clean transition.
- A 32-second excerpt within one song: Original for 12 seconds, Opus 64 for
  12 seconds, then Original for 8 seconds. One playback session delivered exactly
  1,411,200 output frames with no reported buffering; the user heard no gaps,
  clicks or repeated audio at either switch.

The same-song fixture supplies scheduled choices through the adapter's quality
callback. It proves continuity through Astra, not automatic selection or the
product's quality display. Its silent preflight checks frame counts, the quality
schedule, and exact lossless PCM before and after the reduced-quality section.

To repeat, create a private temporary directory containing `listen.json`:

```json
{
  "sources": ["/path/to/first.flac", "/path/to/second.flac"],
  "sidecar": "/path/to/sidecar-access",
  "outputUid": "expected CoreAudio output device UID",
  "scenario": "gapless"
}
```

Use native 48 kHz stereo sources. `gapless` copies the last 16 seconds of the
first song and first 16 seconds of the second. `quality` uses only the first
source, copying 1:20–1:52; it therefore needs at least 1:52 of audio. Originals
are read only. This fixture and its read-only output guard currently target macOS.

`automatic` copies 1:20–3:00 of the first source (100 seconds). A test-only
loopback proxy paces actual segment-response bytes: the first four segments at
16 Mbps, then 900 kbps until 28 seconds after the first segment request, then
16 Mbps again. It changes no system network settings. Astra's normal Automatic
policy chooses each unfetched interval; the fixture injects no quality decisions
or timing observations. The exact switch points depend on measured delivery and
queued audio. Both service request and playback-quality histories are recorded.
The test window reads quality from AudioEngine's playback markers.

The automatic silent preflight consumes PCM through the real worklet at wall-clock
speed. It requires Original → reduced quality → Original in one session, zero
buffering and exactly 4,410,000 output frames at 44.1 kHz. This exercises real
paced HTTP bodies, but not a WAN, packet loss or a congested production server.
On 2026-10-17 it passed with Original at 0 seconds, Opus 128 at 24 seconds and
Original again at 80 seconds. An earlier run exposed a delayed downgrade and
buffered once; observing pressure during transfers fixed that regression.
With the Stratum-native controller (2026-10-21) the same silent preflight plays
Opus 128 at 0 seconds (cold start), Original at 8, Opus 128 at 20 and Original at
76, with zero buffering and exact frame counts. The Bluetooth listen below predates
that controller and should be repeated.

The matching 100-second Bluetooth listen also passed, using the same 48 kHz
source, existing 44.1 kHz output and gain 0.25. AudioEngine reported Opus 128 at
24.009 seconds and Original at 80.016 seconds, one completed PCM session,
4,410,000 decoded frames and zero buffering. The user heard no gaps, clicks or
repeats. The Original recovery request happened at about 57.8 seconds; the
readout correctly waited for that audio to play at 80 seconds. The one test
window exited and supervised cleanup completed. This verifies Automatic in this
controlled scenario; original-priority mode retains silent regression coverage.

### Mixed-source fixture

`scenario: "mixed"` copies the last eight seconds of the first song and first
eight seconds of the second. Its silent check runs ten directed handoffs:
Stratum ↔ complete local, progressive local, conventional Subsonic, Jellyfin and
Plex. All ten passed on 2026-10-17. The actual AudioEngine and worklet consume
real Sidecar/FFmpeg PCM; conventional routes use the real retained-audio cache
in a temporary directory. Only browser audio nodes/clock, IPC and catalog/provider
login are simulated. Conventional provider names exercise their route identity
through the shared cache path; this does not retest each provider's HTTP protocol.

The check compares every sample through each handoff, including the scheduled
bridge from an already-playing local BufferSource. It verifies one transition,
zero buffering, local buffer ownership, quality/transport identity, and a paused
seek/resume on the promoted track through EOF. A complete local seek reuses the
buffer with no decoder request. Conventional progressive seek output is compared
with an independent FFmpeg decode starting at the same position, preserving its
existing resampler edge behavior; Stratum and complete-local seeks match the
uninterrupted PCM reference. This is an engine integration test, not the full
player-store queue or application UI.

The mixed listening window runs four Original-quality album transitions:
Stratum → local, local → Stratum, Stratum → conventional Subsonic and the reverse.
Each is 16 seconds, with a deliberate two-second pause between cases (~70 seconds
total plus preparation). It uses real Web Audio and IPC. It is launched only by
`--play` after fresh readiness. The app/supervisor limits are 140/160 seconds.
The silent matrix writes `mixed-report.json`; failed steps write a short
`mixed-failure.json`. PCM differences report the first sample, never a multi-MB
Buffer diff. Preserve reference PCM separately: AudioEngine clears the incoming
PCM object's buffer field when it takes ownership.

The four-pair Bluetooth listen passed on 2026-10-17 at the device's existing
44.1 kHz output rate and gain 0.25. Each pair reported one handoff and zero
buffering; the user confirmed all four sounded clean. All six progressive
sessions completed with 352,800 frames (eight seconds) each. Only the two
conventional tracks acquired retained-cache leases, and the local handoff kept
its complete audio buffer. The test window exited and supervised cleanup
completed. No production playback changes were needed for this check.

```sh
node scripts/stratum/listen.cjs --prepare /private/test-directory
node scripts/stratum/listen.cjs --check /private/test-directory
# Only after explicit listening readiness:
node scripts/stratum/listen.cjs --play /private/test-directory
```

Preparation launches no Electron or audio. Checking uses disposable loopback
services without audio. Play launches exactly one Electron child with a separate
profile, a Stop button and bounded lifetime (60-second app / 90-second supervisor
deadlines; 140/160 seconds for automatic and mixed scenarios). The output guard
stops the run if the selected device changes; no
system volume or device setting is changed. Microphone permissions are denied.
Processes are reaped and the active bearer file removed at teardown. The private
directory retains music excerpts and the listening report for inspection.

## Full application check

`scripts/stratum/fullApp.cjs` builds and runs the actual application with its
player store, database, preload/IPC, native modules, AudioEngine and transport UI.
It owns a fresh profile, two generated eight-second FLAC files, a loopback
Subsonic catalog and one real Sidecar. Normal catalog parsing creates two remote
sources; the local folder is scanned normally. Only the first source is
allowlisted for Stratum. This remains a controlled server fixture, not a real
Navidrome deployment.

Create a private temporary directory containing `config.json`:

```json
{ "sidecar": "/absolute/path/to/sidecar-access" }
```

```sh
node scripts/stratum/fullApp.cjs --prepare /private/test-directory
node scripts/stratum/fullApp.cjs --check /private/test-directory
```

Prepare builds into that directory without launching Electron. Check launches
exactly one hidden, muted Electron window with app volume zero. It denies
microphone permission, does not alter device settings, and requires no listening
step. App/supervisor deadlines are 160/180 seconds. There is no relaunch loop.
The normal build never imports the test driver or database seed hook. Reports
and a screenshot stay in the temporary directory; active credentials and the
Sidecar bearer configuration are removed at teardown.

The full-app check passed on 2026-10-17 with native modules available and no
renderer errors. It verifies:

- Clicking a real catalog row starts a Stratum session. The main-process result
  must identify the transport; conventional playback cannot masquerade as success.
- A five-entry queue crosses Stratum → local → Stratum → conventional Subsonic
  → Stratum with four natural handoffs and zero buffering. Repeated paths retain
  distinct queue entry IDs, and each handoff advances exactly one entry.
- Local promotion restores its complete buffer/waveform and clears remote state
  and the streaming indicator. Remote promotion retains provider identity and
  displays Automatic · Original in the actual transport bar.
- Pause/seek/resume preserves the selected track and paused intent. Rapid skips
  finish on the latest requested queue entry without stale audio taking over.
- Changing the server setting while its next track is already prepared replaces
  that preparation with Opus 64. The current track stays Original; the promoted
  track reports Opus/64, the pipeline shelf agrees, and the Automatic badge clears.
- Provider playback reports still reach the Subsonic fixture. Stratum does not
  replace catalog/reporting identity.

This check exposed a route bug missed by the earlier fixtures: real catalog paths
are `subsonic://<source>/track/<id>`, while the original proof accepted a shorter
fixture-only path. The development route now uses Astra's actual Subsonic parser,
and the silent/listening fixtures use the canonical path. The regression uses
the real catalog path builder and fails on the old route. Existing allowlist and
quality restrictions remain in place.

This muted check validates application wiring, not audible continuity or the
automatic slowdown/recovery timeline inside the full app. Those retain the
separate engine-level listening evidence above. Native modules loading here does
not constitute Exclusive or Bit-perfect playback coverage.

## Shaped-link baseline

`scripts/stratum/shapedBaseline.ts` measures delivery on a slow link, silently. It
starts a disposable Navidrome and an installed HTTPS `sidecar serve`, then drives
Astra's actual installed-route main session (discovery, pinned TLS, renewable
session, retained cache, analysis, fetch-ahead and next-track gate) and consumes
PCM through the real worklet at wall-clock speed. The next track is scheduled as
the player store does (five seconds of PCM headroom, then a one-second settle) and
handed off through the worklet. Conventional Subsonic Opus streaming crosses the
same link as a baseline. Each scenario plays tagged copies of the sources so the
Sidecar's retained cache starts cold. No audio device, Electron window, personal
library or live server is used; sources are read only.

`scripts/stratum/shapedLink.cjs` is the link: a loopback TCP proxy in which every
connection shares one bottleneck per direction (rate, a 75 kB FIFO queue and
one-way delay), with a SYN round trip, per-connection slow start that restarts
after idle, and a bounded receiver window. Profiles follow Network Link
Conditioner's 3G (780/330 kbps, 100 ms) and Edge (240/200 kbps, 400/440 ms), plus
a fast LAN control; a schedule can switch profiles mid-run (delivery stays FIFO).
It models queueing delay under load, not loss or retransmission.

```sh
node --experimental-strip-types --loader ./scripts/node/electron-test-loader.mjs \
  scripts/stratum/shapedBaseline.ts /private/test-directory
```

The directory holds `config.json` (`navidrome`, `sidecar`, two `sources`,
`profile`, optional `schedule`, `scenarios`, `playSeconds`, `nextSeconds`) and
receives `shaped-report.json`: startup stages, every Stratum request's connection,
header wait and body time, stalls, played qualities and link statistics.

## Development route and trust boundary

Only an unpackaged development build reads `ASTRA_STRATUM_PROOF_CONFIG`. This
private JSON file has `experiment: "astra-stratum-standard-proof-1"`, `sourceId`,
`endpoint`, `session`, and `tracks` (up to sixteen explicit test track IDs).
Use a disposable profile/server and keep bearer values out of logs and command
arguments. The bearer is issued separately by the disposable service; this
route never derives or forwards Astra's saved Navidrome credentials.

The endpoint must be HTTP on literal `127.0.0.1` or `::1` with an explicit port,
no path, userinfo or query. Direct Node HTTP avoids proxies and redirects. This
is a development boundary, not production pairing; capabilities prove no trust.

Only allowlisted tracks on that enabled Subsonic source enter the route, for
Original, 64 or 128 kbps and both automatic modes. Other tracks/providers, bitrates and
compatibility conversions retain conventional behavior. Packaged builds cannot
enable this route. Native output is unchanged. There is no public setting or
special transport badge yet.

## Audio and lifetime

The client bounds responses and checks source/payload hashes, native rate and
channels, requested interval, representation and trim counts. FFmpeg decodes
each explicit FLAC/Ogg container (applying Opus pre-skip/end trimming once),
converts to the native clock if needed, and retains only the presentation PCM.
Decoder output/time are bounded and cancellation kills the decoder.

One continuous converter uses Astra's selected AudioContext rate and emits float
PCM through the existing renderer-ready and 30-second/32 MiB backpressure gates.
It never restarts at a segment boundary or flushes during starvation. Seeks use
real context and a source-zero-aligned conversion phase. Duration is floored once
per track: mixed-rate track boundaries can discard less than one output frame
per track, not per network segment. No device rate or volume is changed.

IPC identifies `restartable: true`, `seekableCache: false` and
`transport: "stratum-proof"`. The renderer's historical internal `seekableCache`
flag also describes restartable segmented PCM; it does not imply an offline
file. Existing current/next identity, gain/routing and natural handoff remain
in Astra. This route does not populate retained audio or analysis caches.

Writes await backpressure; at most one decoded segment is pending in the adapter.
Failed acquisition never signals successful EOF. Handles release before input
EOF or on cancellation; seeking waits for release so it can reuse the service
slot. Cleanup is bounded and falls back to server expiry. An interrupted open
can leave an unknown handle until expiry if the server finished it before
observing disconnection.

## Automatic quality and the readout

Stratum has its own controller, `StratumQualityController`. Conventional streaming
keeps `AutomaticStreamingQuality`, unchanged, for whole-file replacement. Existing
global and per-source settings select Automatic or Automatic (Prioritize Original);
fixed qualities never adapt.

Each interval is chosen from what it costs to fetch: measured request overhead plus
its expected bytes at the measured body rate. A rung is sustainable when that cost,
times a headroom factor (1.5 Automatic, 1.25 Prioritize Original), fits within a
full four-second interval. The link estimate is a harmonic average (time per bit),
so one slow transfer lowers it at once while recovery needs several fast ones. It
is shared by the current and next playback of one Sidecar account and reused for a
cold start for five minutes. Cache reads and PCM waits are never evidence.

- **Cold start without fresh evidence:** the account's last known link, which is
  kept across pauses and saved (by key digest, for 30 days) across restarts, must
  clear 1.25× extra headroom; without one, Opus 128, never Original first. On an
  unthrottled link a hint-less start reaches Original by the third interval. A
  wrong hint costs one abandoned interval, priced from that transfer itself.
- **Replay:** a retained interval is reused unless the link clearly supports a
  better one (the upgrade margin). That upgrade's deadline is when playback
  reaches the interval, and a slow, failed or offline upgrade plays the retained
  copy instead.
- **Down:** immediately, to the highest sustainable rung, or to a rung that arrives
  before the buffered audio runs out (one second kept in reserve).
- **Up:** one rung at a time, after two fresh transfers, with extra margin and
  enough buffered audio. There are no wall-clock cooldowns.
- **In flight:** an interval is abandoned whenever it would arrive after the buffer
  runs out and a lower rung, including a new connection, would arrive sooner. The
  same interval is requested again; the abandoned transfer stops at once rather
  than after the cache's sharing grace period. A silent transfer moves to a cheaper
  rung after at least eight seconds (more with buffer); at the lowest rung the
  transport deadline applies, since restarting would only lose its queue position. Failures move down a rung (or retry the
  lowest) for at most three attempts; refusals and cancellation are not retried, and
  the cache's own same-quality retries are disabled for automatic intervals.

Starting or seeking a remote track also holds display artwork downloads (at most
six run at a time): queued art waits and in-flight art restarts later, until the
track has eight seconds decoded, ten seconds after its first audio, or thirty
seconds after the request. On a saturated link this keeps a page of covers from
delaying or failing playback; preparing the next track never holds artwork.

Seeks keep their pinned initial quality and automatic mode, then evaluate later
intervals. Only unfetched intervals can change: already queued PCM keeps its
quality. The controller's buffer includes retained intervals beyond the PCM cap.

Validated segment boundaries are mapped through the continuous converter and
seek trim into output-frame markers, then sent alongside PCM chunks. The engine
updates quality when its worklet cursor reaches them, using the existing position
report cadence. A next track's markers stay separate until promotion; old-session
markers cannot survive a seek. Download progress cannot overwrite the playback
quality shown by the existing transport indicator and pipeline shelf. This follows
the playback clock, without claiming measurement of Bluetooth's physical latency.

## Renewable session checkpoint

The main-process `StratumProofSession` owns one disposable connection shared by
current/next/seek clients. It establishes the session with fresh Subsonic
username/token/salt credentials supplied by a caller, then renews halfway through
each lease. Concurrent clients share the pending exchange; cancelling one waiter
does not cancel the other. The password and session never go to the renderer.

Renewal retains the bearer and existing playback handles. Sidecar requires fresh
same-user authentication, checks that bogus credentials still fail, and updates
the stored tuple and expiry. Logout, shutdown and expiry win over late replies.
An expired or failed renewal cannot silently log in again underneath old handles.
The experimental owner ends the connection on a renewal failure; automatic
transient-error recovery and user-facing reconnect behavior remain future work.

Run the silent service/client check with a newly built Sidecar supporting renewal:

```sh
ASTRA_STRATUM_SIDECAR=/path/to/stratum/target/debug/sidecar-access npm run test:stratum-session
```

This starts one bounded Sidecar and a disposable Subsonic protocol server in
Node, with generated WAV data and no Electron/audio device. Two-second leases
force several renewals while Astra's real PCM adapter is held under backpressure.
The test compares current/next lossless PCM exactly, verifies their staged sources
are not fetched again, then checks seeking and denial of revoked track access.
Unit tests also cover shared authentication, caller cancellation, close/expiry
races, account changes, malformed replies, refusal and bearer continuity.

This owner is not yet connected to saved server credentials or settings. Existing
development config files still supply static bearers. Literal-loopback restrictions
remain; real-server connection requires owner pairing and protected transport.
Owner-provided pairing is the agreed setup option without existing HTTPS, with no
new reverse-proxy requirement for LAN/Docker installations. Pairing must bind the
Sidecar identity and its declared Navidrome association before credentials move.

## Remaining work

- Paced-link listening in Automatic (prioritize original), and broader
  real-network testing beyond the controlled Automatic scenario above.
- Discovery, owner pairing, protected real-network transport, and wiring the
  renewable session owner into source settings/lifecycle. Static proof config
  bearers still expire without automatic renewal.
- Evaluate full-source staging latency: Sidecar still stages the original;
  the client receives requested encoded segments only.
- Full application audible mixed-source/automatic checks, user-facing setup,
  cache/offline and analysis policy. The muted app queue/readout check is complete.
- Deliberate native-output integration and broader format/platform/device tests.
  The real-service silent fixture currently covers stereo on macOS.
