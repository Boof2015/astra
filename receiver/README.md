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

Pairing works exactly like an Astra sink: the host's wizard discovers this device, the PIN and
the Approve button appear on the web page (`http://<pi>:38405/`), and the credential persists in
`~/.config/astra-receiver/config.json`.

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

## Known limits

- No artwork / Zone Display (headless by definition; the web page shows title/artist only).

## Gapless playback (§21)

The daemon implements the full gapless sink handoff: the host's pre-announced next stream is
pre-fetched on a second reader into a staged playout engine, scheduled to start emitting at the
exact boundary output frame, and mixed into the same device blocks as the retiring stream — the
track change is sample-aligned. If the daemon joins mid-handoff without the pre-announcement, it
falls back to the protocol's promote re-fetch (sub-second seam). The web page's diagnostics card
shows "Gapless next" while a stream is staged.
