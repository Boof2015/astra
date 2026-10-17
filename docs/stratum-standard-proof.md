# Stratum: first Standard playback connection

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
- Both automatic modes lowering quality and recovering to Original in one main
  PCM session, with exact frame counts and seek-relative quality markers. These
  cases use real service audio with simulated transfer timing/consumption, not
  a shaped real network. Policy unit tests separately exercise delivery costs.
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

```sh
node scripts/stratum/listen.cjs --prepare /private/test-directory
node scripts/stratum/listen.cjs --check /private/test-directory
# Only after explicit listening readiness:
node scripts/stratum/listen.cjs --play /private/test-directory
```

Preparation launches no Electron or audio. Checking uses disposable loopback
services without audio. Play launches exactly one Electron child with a separate
profile, a Stop button and bounded lifetime (60-second app / 90-second supervisor
deadlines). The output guard stops the run if the selected device changes; no
system volume or device setting is changed. Microphone permissions are denied.
Processes are reaped and the active bearer file removed at teardown. The private
directory retains music excerpts and the listening report for inspection.

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

Stratum reuses `AutomaticStreamingQuality`, including sustained-shortfall and
recovery rules, the original-priority bias, and settling times. Existing global
and per-source settings select the mode. Optional segment conditions replace
whole-file lookahead estimates and replacement catch-up cost with exact delivered
PCM headroom and the next interval's cost. Conventional callers keep their
existing defaults and replacement coordinator.

`StratumAutomaticQuality` uses the proof's supported Original/64/128 ladder.
Successful response bodies supply network evidence; total request-through-decode
time measures readiness separately, including server/decoder work. Waiting for
PCM capacity supplies neither bandwidth nor recovery evidence. Short bodies use
a 20 ms timing floor and repeated transfers spanning at least 15 seconds to prove
recovery. Conventional transfers retain their 250 ms floor and existing rules.
Upgrades also require sufficient buffered audio. Estimates begin conservatively
from native PCM bitrate and refine with lossless payload sizes.

Bandwidth history is isolated by Stratum endpoint/disposable session; each
playback owns its own decisions so prefetch cannot reset the current track's
cooldowns. A successful representation change commits policy state once, rather
than resetting the sustained-trouble timer for every segment. Seeks preserve the
pinned initial quality and automatic mode, then evaluate subsequent intervals.
Only unfetched intervals can change: already queued PCM keeps its quality.

Validated segment boundaries are mapped through the continuous converter and
seek trim into output-frame markers, then sent alongside PCM chunks. The engine
updates quality when its worklet cursor reaches them, using the existing position
report cadence. A next track's markers stay separate until promotion; old-session
markers cannot survive a seek. Download progress cannot overwrite the playback
quality shown by the existing transport indicator and pipeline shelf. This follows
the playback clock, without claiming measurement of Bluetooth's physical latency.

## Remaining work

- Automatic-mode listening and real throttled-network testing. The Bluetooth
  checks above used scheduled changes before the automatic policy was connected.
- Discovery, trusted association, protected real-network transport and session
  renewal. The current disposable bearer expires without automatic renewal.
- Evaluate full-source staging latency: Sidecar still stages the original;
  the client receives requested encoded segments only.
- Full application mixed-source listening, UI, cache/offline and analysis policy.
- Deliberate native-output integration and broader format/platform/device tests.
  The real-service silent fixture currently covers stereo on macOS.
