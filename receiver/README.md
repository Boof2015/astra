# astra-receiver

Standalone headless Parallax receiver ("parallax headless node"): a 24/7 daemon for Raspberry
Pi–class Linux devices that pairs with an Astra host and plays zone audio in sync — no Electron,
no screen. It speaks Parallax protocol v2 unchanged and reuses the app's protocol, crypto,
pairing-listener, and mDNS modules directly from `../src`.

## How it fits together

- `src/main.ts` — daemon assembly: config, mDNS advertise (`_astra-zone._tcp`, role=sink),
  pairing listener (:38404), status/pairing web page (:38405), boot connect-retry loop.
- `src/sinkClient.ts` — host network client (join / SSE events / PXLX audio / clock probes /
  telemetry, watchdogs + reconnect-forever + mDNS host relocation), ported from the app's
  `ParallaxService` sink role.
- `src/sinkSession.ts` — drift control loop (NTP offset + host-emit-anchor Theil-Sen predictor,
  hold/slew/snap with the fail-closed trust latch), ported from `parallaxStore` + `AudioEngine`.
- `src/playout.ts` — `SinkPlayoutEngine` (port of the `parallax-sink-player` AudioWorklet) +
  `PlayoutDriver` (write-ahead loop replacing Web Audio's pull model).
- `src/output/` — `AlsaOutput` (Linux, via `receiver/native` addon, `snd_pcm_delay` as the
  latency source) and `NullOutput` (mac dev / tests).

Pairing works exactly like an Astra sink: the host's wizard discovers this device, and the PIN
and explicit Approve/Reject controls appear on the receiver web page. For a standalone install,
open `http://<pi>:38405/`; Parallax OS exposes the same page at `http://parallax.local/`. The
credential persists in `~/.config/astra-receiver/config.json` only after approval.

Approval must happen before the pairing window expires, but HDMI-CEC and a TV remote are
optional:

- **Headless:** read the PIN and approve or reject on the receiver web page.
- **TV with working CEC:** read the PIN on the display and use the TV remote to approve or reject;
  the web page remains available as an alternative.
- **TV without CEC or without a usable remote:** read the PIN on the display or web page, enter it
  in Astra, then approve or reject from the web page on another device on the same LAN.

## Dev (any OS, no audio)

```sh
npm run receiver:dev        # runs with the null output backend on macOS
npm run typecheck:receiver
npm test                    # includes receiver unit tests
```

Protocol-level end-to-end on the dev machine: run `receiver:dev`, then pair + stream from Astra —
join/SSE/audio/clock/telemetry all flow; only the DAC is fake.

## Install on a Raspberry Pi (the normal way)

One line, on any 64-bit Pi OS (or other arm64 Linux):

```sh
curl -fsSL https://raw.githubusercontent.com/Boof2015/astra/dev/receiver/deploy/install.sh -o /tmp/astra-receiver-install.sh && sudo bash /tmp/astra-receiver-install.sh
```

(Download-then-run, not `| sudo bash` — modern sudo puts commands on a private pty, and a
stdin-piped script cannot receive keyboard input, which would skip the audio-output question.)

The installer downloads the latest prebuilt `receiver-v*` GitHub release (JS bundle + N-API ALSA
addon — ABI-stable, so one arm64 binary serves any modern Node), installs Node 24 LTS unless a
Node ≥ 22.19 is present (the bundled undici requires it), **asks which audio output to use when
the device has more than one** (HDMI vs. headphone jack vs. USB DAC), sets up a service user in
the `audio` group, and enables a systemd service. Then open `http://<pi>:38405/` and pair from
Astra (Parallax → Add Sink). **Updating — or changing the audio output — = re-run the same
line** (it merges config, so pairing survives). Logs: `journalctl -u astra-receiver -f`.

Since 0.2.0 the audio output can also be switched from the web page (Audio output → Apply); the
daemon persists the choice and restarts itself onto the new device — the ALSA handle and the
frames-written emission clock can't be swapped live, so a ~10 s blip is expected.

### On-disk layout & updates (0.2.0+)

`deploy/install.sh` delegates fetching to `deploy/update.sh` — the same script the Parallax OS
appliance runs from a daily systemd timer. It keeps releases side by side and swaps atomically:

```
/opt/astra-receiver/
  config.json                    # pairing + device config (never touched by updates)
  current -> releases/<tag>      # the installed version IS this symlink's target
  releases/<tag>/                # bundle + addon + update.sh (each release carries its updater)
  releases/<previous-tag>/       # kept for rollback
```

`update.sh` sha256-verifies the tarball against the published `.sha256`, unpacks to a staging
dir, atomically renames the `current` symlink, restarts the service and — if it doesn't come
back healthy — swaps back to the previous release. Already-on-latest is a no-op that never
touches the running service. The unit is `Type=notify` with `WatchdogSec=30`: the daemon reports
READY/WATCHDOG through the addon's `sdNotify` (an AF_UNIX datagram Node core can't send), so a
hung process is killed and restarted by systemd.

## Deploy from source (fallback / development)

On the dev machine:

```sh
npm run receiver:build      # → receiver/dist/astra-receiver.mjs (single file, deps bundled)
rsync -a receiver/dist/astra-receiver.mjs receiver/native pi@<pi>:~/astra-receiver/
```

On the Pi (Node ≥ 22.19 — undici's floor — once; needed only on 32-bit/armv7 systems the
prebuilds don't cover, or when hacking on the addon):

```sh
sudo apt install -y build-essential libasound2-dev
cd ~/astra-receiver/native && npm install && npx node-gyp rebuild
cp build/Release/astra_receiver_alsa.node ~/astra-receiver/
node ~/astra-receiver/astra-receiver.mjs   # first run; then install the systemd unit
```

Systemd template for manual installs: `deploy/astra-receiver.service`. Config lives at
`~/.config/astra-receiver/config.json` for manual runs, `/opt/astra-receiver/config.json` for
installer-managed services (`audioDevice`: use `default` or `plughw:…` — the plug layer converts
Float32 for DACs that don't take it natively).

## Env flags

- `PARALLAX_DISABLE_HOST_PREDICTOR=1` — fall back to the Phase-1 nominal-timeline loop.
- `PARALLAX_DISCOVERY_INTERFACE=<ip>` — pin mDNS to an interface.
- `ASTRA_RECEIVER_CONFIG=<path>` — config file override.
- `ASTRA_RECEIVER_ALSA_ADDON=<path>` — explicit .node addon path (used by the systemd unit).

## TV display + CEC (0.2.0+)

`GET /display` serves a fullscreen Zone-Display-style now-playing page (artwork + title/artist,
idle screen with the zone name) — the Parallax OS kiosk points its receiver-local WPE browser at
it. `/display` is restricted to loopback peers; LAN browsers should use `/` for status, settings,
and pairing approval. Artwork is fetched lazily from the host's `/v1/parallax/artwork/current`
endpoint (§19.18(e)) and cached per stream; `GET /api/artwork` serves the active stream's bytes.

With `cecControl: true` in config.json (default on Parallax OS, off elsewhere) the daemon drives
the TV over HDMI-CEC via `cec-ctl` (v4l-utils; the service user needs the `video` group for
/dev/cec0): wake + claim active source when playback starts, standby after `cecStandbyMinutes`
(default 10) of not playing. CEC is best-effort and optional for both playback and pairing; when
no adapter or usable remote is present, use the receiver web page for pairing approval.

## Gapless playback (§21)

The daemon implements the full gapless sink handoff: the host's pre-announced next stream is
pre-fetched on a second reader into a staged playout engine, scheduled to start emitting at the
exact boundary output frame, and mixed into the same device blocks as the retiring stream — the
track change is sample-aligned. If the daemon joins mid-handoff without the pre-announcement, it
falls back to the protocol's promote re-fetch (sub-second seam). The web page's diagnostics card
shows "Gapless next" while a stream is staged.
