import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { BlockList, isIP, type AddressInfo } from 'net'
import type { AlsaDeviceOption } from './output/alsaDevices'
import type { CecWakeOn } from './cecController'
import type { ClockFormat } from './config'
import type { WifiNetwork } from './networkSetup'
import type { SinkSessionDiagnostics } from './sinkSession'

// Tiny status/pairing page for the headless receiver. Replaces the Electron sink's PIN card and
// Zone Display surface: during a pair window it shows the 6-digit PIN and — once the host has
// submitted it — the explicit Approve/Reject affordance the §20 physical-presence model requires.
// No framework, no external assets; a single inline page polling /api/status.

export interface WebStatusState {
  sinkName: string
  endpointUuid: string
  paired: boolean
  hostName: string | null
  connected: boolean
  playbackEnabled: boolean
  statusLabel: string
  hostReachable: boolean
  clockOffsetMs: number | null
  rttMs: number | null
  lastError: string | null
  playbackState: string
  streamTitle: string | null
  streamArtist: string | null
  streamAlbum: string | null
  // Server-side-interpolated track position (see SinkSessionInfo.position).
  position: { elapsedSeconds: number; durationSeconds: number | null; advancing: boolean } | null
  assignedSinkName: string | null
  appliedAdvanceMs: number
  volumePercent: number
  // The daemon's IANA timezone (system tz at process start); clock pages render with it so a
  // remote browser — or a kiosk started before a tz change — still shows the speaker's time.
  timezone: string
  clockFormat: ClockFormat
  // Installed release tag ('v0.3.0') or 'dev' when running from source.
  version: string
  // True while an on-demand update run is in flight (mirrors the updater unit's ActiveState).
  updating: boolean
  // Phase-3 transport lane capability: null = untried, false = host predates the control
  // route (hide the buttons), true = confirmed working.
  transportSupported: boolean | null
  // TV control settings; the card is offered only when a CEC adapter exists (`available`).
  cec: {
    available: boolean
    control: boolean
    wakeOn: CecWakeOn
    switchInput: boolean
    standbyMinutes: number
    // Most recent TV-remote key received via cec-follower — the hardware-debugging window
    // into whether (and what) the TV actually sends.
    lastKey: { raw: string; atMs: number } | null
  }
  // Active stream's artwork identity (its streamId) when the sink has bytes cached; the display
  // page uses it as an <img> cache-buster and only swaps the image when it changes.
  artworkId: string | null
  // Startup audio health. Intentional null output is false/null; exhausted ALSA candidates are
  // false with a sanitized error so management remains usable without conflating the two states.
  audioAvailable: boolean
  audioError: string | null
  outputDevice: string
  // The persisted audioDevice selection; `outputDevice` stays the ACTIVE backend's label so the
  // page can show when the configured device failed to open and a fallback is playing instead.
  configuredDevice: string
  audioDevices: AlsaDeviceOption[]
  incomingPair: {
    pin: string
    hostName: string
    awaitingApproval: boolean
    expiresAtMs: number
  } | null
  // Captive-portal onboarding state; null when the apSetup feature is off (everywhere but the
  // Parallax OS image). `apActive` drives the captive redirect and the TV's setup hint;
  // `apEtaSeconds` drives the TV's "setup starts in ~Ns" countdown while offline.
  setup: {
    apActive: boolean
    apSsid: string
    connecting: boolean
    lastError: string | null
    apEtaSeconds: number | null
  } | null
  diagnostics: SinkSessionDiagnostics | null
}

export function resolveReceiverStatusLabel(state: Pick<
  WebStatusState,
  'paired' | 'connected' | 'hostReachable' | 'playbackEnabled'
>): string {
  if (!state.paired) return 'Not paired'
  if (state.connected && state.hostReachable && !state.playbackEnabled) {
    return 'Connected, not selected for playback'
  }
  if (state.connected && state.hostReachable) return 'Connected'
  if (state.connected) return 'Reconnecting…'
  return 'Waiting for host'
}

const LOOPBACK_ADDRESSES = new BlockList()
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6')

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const family = isIP(address)
  if (family === 4) return LOOPBACK_ADDRESSES.check(address, 'ipv4')
  if (family === 6) return LOOPBACK_ADDRESSES.check(address, 'ipv6')
  return false
}

export interface WebStatusCallbacks {
  getState: () => WebStatusState
  approvePair: () => boolean
  rejectPair: () => void
  setName: (name: string) => void
  setVolume: (percent: number) => void
  // Persists the device and restarts the daemon onto it (the ALSA handle and the frames-written
  // clock cannot be swapped live). Returns false when the id is not an offered device.
  setOutputDevice: (device: string) => boolean
  // Active stream's artwork bytes (Zone Display port); null when none is cached yet.
  getArtwork: () => { contentType: string; bytes: Buffer } | null
  // Wi-Fi onboarding (no-ops when apSetup is off).
  getSetupNetworks: () => Promise<WifiNetwork[]>
  applySetupCredentials: (ssid: string, password: string) => boolean
  // System timezone via timedatectl; empty list = unsupported (picker hidden). Setting it
  // restarts the daemon so every clock picks up the new zone.
  getTimezones: () => Promise<string[]>
  setTimezone: (timezone: string) => Promise<boolean>
  // TV-control settings, applied live (values are validated in the route — no restart).
  setCecSettings: (settings: {
    control: boolean
    wakeOn: CecWakeOn
    switchInput: boolean
    standbyMinutes: number
  }) => void
  setClockFormat: (format: ClockFormat) => void
  // Pushes a transport command to the connected host over the authenticated sink channel.
  sendTransport: (command: 'toggle-play' | 'next' | 'previous') => Promise<'ok' | 'unsupported' | 'failed'>
  // 'restart' exits cleanly (systemd's Restart=always brings it back); 'reboot' and 'update'
  // shell out via systemd and fail without the image's polkit grants — `error` carries the
  // user-facing explanation. 'reset-wifi' drops every saved Wi-Fi profile (setup AP re-raises);
  // 'factory-reset' additionally wipes config (pairing, identity, settings) and restarts fresh.
  systemAction: (
    action: 'restart' | 'reboot' | 'update' | 'reset-wifi' | 'factory-reset'
  ) => Promise<{ ok: boolean; error?: string }>
  forgetHost: () => Promise<void>
}

export interface WebStatusServerOptions {
  getPeerAddress?: (request: IncomingMessage) => string | undefined
}

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Astra Receiver</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; background: #101014; color: #e8e8ee; margin: 0;
         display: flex; justify-content: center; padding: 2rem 1rem; }
  main { width: 100%; max-width: 30rem; }
  h1 { font-size: 1.15rem; font-weight: 600; letter-spacing: 0.02em; margin: 0 0 1rem; }
  .card { background: #1a1a21; border: 1px solid #2a2a33; border-radius: 12px;
          padding: 1rem 1.25rem; margin-bottom: 1rem; }
  .row { display: flex; justify-content: space-between; gap: 1rem; padding: 0.3rem 0;
         font-size: 0.9rem; }
  .row .k { color: #9a9aa8; }
  .pin { font-size: 2.6rem; font-weight: 700; letter-spacing: 0.35em; text-align: center;
         margin: 0.5rem 0; font-variant-numeric: tabular-nums; }
  .pair-banner { border-color: #4a6cf7; }
  button { background: #2b2b36; color: #e8e8ee; border: 1px solid #3a3a46; border-radius: 8px;
           padding: 0.5rem 1rem; font-size: 0.9rem; cursor: pointer; }
  button.primary { background: #4a6cf7; border-color: #4a6cf7; color: #fff; }
  button.danger { border-color: #a33; color: #f2b8b8; }
  .actions { display: flex; gap: 0.6rem; justify-content: center; margin-top: 0.6rem; }
  .muted { color: #9a9aa8; font-size: 0.8rem; }
  input[type=text] { background: #101014; color: #e8e8ee; border: 1px solid #3a3a46;
                     border-radius: 8px; padding: 0.4rem 0.6rem; width: 100%; box-sizing: border-box; }
  input[type=range] { width: 100%; }
  select { background: #101014; color: #e8e8ee; border: 1px solid #3a3a46; border-radius: 8px;
           padding: 0.4rem 0.6rem; flex: 1; min-width: 0; }
  .ok { color: #7fd88f; } .bad { color: #f2b8b8; }
  .audio-degraded { border-color: #b45a45; background: #241a1a; }
  .audio-degraded-title { color: #ffc0b4; font-weight: 700; margin-bottom: 0.45rem; }
  .audio-degraded-detail { color: #f2b8b8; font-size: 0.9rem; line-height: 1.4; }
  .audio-degraded-meta { color: #c9a9a3; font-size: 0.8rem; line-height: 1.4; margin-top: 0.45rem; }
  label.check { display: flex; gap: 0.55rem; align-items: center; font-size: 0.9rem;
                padding: 0.3rem 0; cursor: pointer; }
</style>
</head>
<body>
<main>
  <h1>Astra Receiver</h1>
  <div class="card" id="busy-banner" style="display:none; padding:0.7rem 1.25rem">
    <span id="busy-text"></span>
  </div>
  <div class="card audio-degraded" id="audio-degraded" style="display:none" role="alert">
    <div class="audio-degraded-title">Audio unavailable</div>
    <div class="audio-degraded-detail" id="audio-degraded-error"></div>
    <div class="audio-degraded-meta" id="audio-degraded-configured"></div>
    <div class="audio-degraded-meta" id="audio-degraded-devices"></div>
    <div class="audio-degraded-meta">Choose an available output below and apply it to restart audio. Pairing and management remain available.</div>
  </div>
  <div id="pair" class="card pair-banner" style="display:none">
    <div class="muted" id="pair-host"></div>
    <div class="pin" id="pair-pin"></div>
    <div class="muted" style="text-align:center">Enter this PIN on the host to pair.</div>
    <div class="actions" id="pair-actions" style="display:none">
      <button class="primary" onclick="act('approve')">Approve pairing</button>
      <button class="danger" onclick="act('reject')">Reject</button>
    </div>
    <div class="muted" id="pair-approval-hint" style="display:none; text-align:center; margin-top:0.6rem">
      Approve or reject here. A TV remote and HDMI-CEC are optional.
    </div>
  </div>
  <div class="card">
    <div class="row"><span class="k">Status</span><span id="s-status"></span></div>
    <div class="row"><span class="k">Host</span><span id="s-host"></span></div>
    <div class="row"><span class="k">Now playing</span><span id="s-np"></span></div>
    <div class="row"><span class="k">Clock offset</span><span id="s-clock"></span></div>
    <div class="row"><span class="k">Output</span><span id="s-out"></span></div>
    <div class="row" id="s-err-row" style="display:none"><span class="k">Last error</span><span id="s-err" class="bad"></span></div>
    <div class="actions" id="transport-actions" style="display:none">
      <button onclick="transport('previous')" title="Previous track">⏮</button>
      <button onclick="transport('toggle-play')" title="Play/pause">⏯</button>
      <button onclick="transport('next')" title="Next track">⏭</button>
    </div>
  </div>
  <div class="card">
    <div class="row"><span class="k">Device name</span></div>
    <div style="display:flex; gap:0.6rem">
      <input type="text" id="name-input" maxlength="80">
      <button onclick="saveName()">Save</button>
    </div>
    <div class="row" style="margin-top:0.8rem"><span class="k">Audio output</span></div>
    <div style="display:flex; gap:0.6rem">
      <select id="out-select"></select>
      <button onclick="applyOutput()">Apply</button>
    </div>
    <div class="muted" id="out-hint" style="margin-top:0.35rem"></div>
    <div id="tz-block">
      <div class="row" style="margin-top:0.8rem"><span class="k">Timezone</span></div>
      <div style="display:flex; gap:0.6rem">
        <select id="tz-select"></select>
        <button onclick="applyTimezone()">Apply</button>
      </div>
      <div class="muted" id="tz-hint" style="margin-top:0.35rem"></div>
    </div>
    <div class="row" style="margin-top:0.8rem"><span class="k">Clock format</span></div>
    <div style="display:flex; gap:0.6rem">
      <select id="clock-select">
        <option value="auto">Automatic</option>
        <option value="12">12-hour</option>
        <option value="24">24-hour</option>
      </select>
    </div>
    <div class="row" style="margin-top:0.8rem"><span class="k">Volume</span><span id="vol-label"></span></div>
    <input type="range" id="vol" min="0" max="100" step="1" onchange="saveVolume(this.value)">
    <div class="actions" id="forget-actions" style="display:none">
      <button class="danger" onclick="if(confirm('Forget the paired host?')) act('forget')">Forget host</button>
    </div>
  </div>
  <div class="card" id="cec-card" style="display:none">
    <div class="row"><span class="k">TV control (HDMI-CEC)</span></div>
    <label class="check"><input type="checkbox" id="cec-on"> Control the TV over HDMI-CEC</label>
    <div class="row" style="margin-top:0.5rem"><span class="k">Turn the TV on</span></div>
    <div style="display:flex; gap:0.6rem">
      <select id="cec-wake">
        <option value="play">When music starts playing</option>
        <option value="connect">When the host connects</option>
        <option value="off">Never</option>
      </select>
    </div>
    <label class="check" style="margin-top:0.4rem"><input type="checkbox" id="cec-input"> Switch the TV to this input when turning on</label>
    <div class="row" style="margin-top:0.5rem"><span class="k">Turn the TV off after idle</span></div>
    <div style="display:flex; gap:0.6rem">
      <select id="cec-standby">
        <option value="5">5 minutes</option>
        <option value="10">10 minutes</option>
        <option value="20">20 minutes</option>
        <option value="30">30 minutes</option>
        <option value="60">1 hour</option>
        <option value="120">2 hours</option>
        <option value="0">Never</option>
      </select>
      <button onclick="applyCec()">Apply</button>
    </div>
    <div class="muted" id="cec-hint" style="margin-top:0.35rem"></div>
    <div class="muted" id="cec-remote" style="margin-top:0.35rem"></div>
  </div>
  <div class="card">
    <div class="row"><span class="k">Version</span><span id="s-ver"></span></div>
    <div class="actions" style="justify-content:flex-start; flex-wrap:wrap">
      <button onclick="systemAct('update')">Check for updates</button>
      <button onclick="systemAct('restart')">Restart receiver</button>
      <button class="danger" onclick="if(confirm('Reboot the speaker?')) systemAct('reboot')">Reboot device</button>
    </div>
    <div class="actions" style="justify-content:flex-start; flex-wrap:wrap; margin-top:0.6rem">
      <button class="danger" id="reset-wifi-btn" style="display:none"
        onclick="if(confirm('Forget all saved Wi-Fi networks? The speaker goes back into setup mode.')) systemAct('reset-wifi')">Reset Wi-Fi</button>
      <button class="danger"
        onclick="if(confirm('Factory reset? This erases the pairing, name, settings, and Wi-Fi — the speaker starts over as brand new.')) systemAct('factory-reset')">Factory reset</button>
    </div>
    <div class="muted" id="sys-hint" style="margin-top:0.35rem"></div>
  </div>
  <div class="card" id="diag-card" style="display:none">
    <div class="row"><span class="k">Sync diagnostics</span><span class="muted">1 Hz</span></div>
    <div class="row"><span class="k">Drift (timeline)</span><span id="d-drift"></span></div>
    <div class="row"><span class="k">Drift (predictor)</span><span id="d-p2"></span></div>
    <div class="row"><span class="k">Loop</span><span id="d-loop"></span></div>
    <div class="row"><span class="k">Rate nudge</span><span id="d-ppm"></span></div>
    <div class="row"><span class="k">Buffered / latency</span><span id="d-buf"></span></div>
    <div class="row"><span class="k">Anchors</span><span id="d-anchors"></span></div>
    <div class="row"><span class="k">Hard syncs</span><span id="d-syncs"></span></div>
    <div class="row"><span class="k">Underruns</span><span id="d-under"></span></div>
    <div class="row"><span class="k">Gapless next</span><span id="d-next"></span></div>
  </div>
  <div class="muted" id="s-id" style="text-align:center"></div>
</main>
<script>
// ── Busy banner: an honest "hold on" for every action that takes real time (daemon restarts,
// update runs). Driven by actual signals — poll failures while the daemon is down, the
// the updating flag mirroring the updater unit, and completion predicates checked against fresh
// status — never by optimistic timers alone.
let webPollFailures = 0
let busy = null
let bootVersion = null
function showBanner(text, ok) {
  const banner = document.getElementById('busy-banner')
  banner.style.display = ''
  banner.style.borderColor = ok ? '#3d7a4a' : '#4a6cf7'
  document.getElementById('busy-text').textContent = text
}
function hideBanner() { document.getElementById('busy-banner').style.display = 'none' }
function beginBusy(label, done, patienceMs) {
  busy = { label: label, done: done, startedAt: Date.now(), sawFail: false, patienceMs: patienceMs || 90000 }
  showBanner('⟳ ' + label, false)
}
function finishBusy(text) {
  busy = null
  showBanner('✓ ' + text, true)
  setTimeout(() => { if (!busy) hideBanner() }, 6000)
}
function busyTick(s) {
  if (bootVersion === null) bootVersion = s.version
  else if (s.version !== bootVersion) {
    // The daemon we're talking to is a different release than the page came from — reload so
    // the UI matches it (this is also what keeps long-lived tabs current after auto-updates).
    busy = null
    showBanner('✓ Updated to ' + s.version + ' — refreshing…', true)
    setTimeout(() => location.reload(), 1500)
    bootVersion = s.version
    return
  }
  if (!busy) return
  const done = busy.done(s, busy)
  if (done) finishBusy(done)
  else if (Date.now() - busy.startedAt > busy.patienceMs) { busy = null; hideBanner() }
}
function busyPollFailed() {
  webPollFailures += 1
  if (busy) {
    busy.sawFail = true
    showBanner('⟳ ' + busy.label + ' — the speaker is restarting…', false)
  } else if (webPollFailures >= 3) {
    showBanner('⟳ Speaker unreachable — reconnecting…', false)
  }
}
function busyPollRecovered() {
  if (webPollFailures >= 3 && !busy) hideBanner()
  webPollFailures = 0
}
let nameDirty = false
document.getElementById('name-input').addEventListener('input', () => { nameDirty = true })
async function act(name) {
  await fetch('/api/' + name, { method: 'POST' })
  refresh()
}
async function saveName() {
  const value = document.getElementById('name-input').value.trim()
  if (!value) return
  await fetch('/api/name', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: value }) })
  nameDirty = false
  refresh()
}
async function saveVolume(value) {
  await fetch('/api/volume', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ percent: Number(value) }) })
}
async function transport(command) {
  await fetch('/api/transport', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }) })
}
let tzLoaded = false
let tzDirty = false
document.getElementById('tz-select').addEventListener('input', () => { tzDirty = true })
async function loadTimezones() {
  try {
    const payload = await (await fetch('/api/timezones')).json()
    const zones = payload.timezones || []
    if (!zones.length) {
      document.getElementById('tz-block').style.display = 'none'
      return
    }
    const select = document.getElementById('tz-select')
    select.innerHTML = ''
    for (const zone of zones) {
      const el = document.createElement('option')
      el.value = zone
      el.textContent = zone
      select.appendChild(el)
    }
    tzLoaded = true
  } catch { /* daemon busy — picker stays empty */ }
}
loadTimezones()
let tzPending = null
async function applyTimezone() {
  const timezone = document.getElementById('tz-select').value
  if (!timezone) return
  const res = await fetch('/api/timezone', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timezone }) })
  tzDirty = false
  if (res.ok) {
    tzPending = timezone
    beginBusy('Applying the timezone…', (s) => s.timezone === timezone ? 'Timezone updated' : false)
    document.getElementById('tz-hint').textContent =
      'Applying — the receiver restarts, this takes ~15 seconds…'
  } else {
    document.getElementById('tz-hint').textContent = 'Could not set that timezone.'
  }
}
let outDirty = false
let outRestartingUntil = 0
document.getElementById('out-select').addEventListener('input', () => { outDirty = true })
async function applyOutput() {
  const device = document.getElementById('out-select').value
  if (!device) return
  const res = await fetch('/api/output', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device }) })
  outDirty = false
  if (res.ok) {
    outRestartingUntil = Date.now() + 10000
    beginBusy('Switching the audio output…',
      (s, b) => b.sawFail && s.configuredDevice === device ? 'Audio output switched' : false)
    document.getElementById('out-hint').textContent = 'Restarting on the new output…'
  }
}
function refreshOutput(s) {
  const select = document.getElementById('out-select')
  const options = [{ id: 'default', label: 'System default' }].concat(s.audioDevices)
  if (s.configuredDevice && !options.some((o) => o.id === s.configuredDevice)) {
    options.push({ id: s.configuredDevice, label: s.configuredDevice + ' (configured, unavailable)' })
  }
  const ids = options.map((o) => o.id).join('\\n')
  if (select.dataset.ids !== ids) {
    select.dataset.ids = ids
    select.innerHTML = ''
    for (const option of options) {
      const el = document.createElement('option')
      el.value = option.id
      el.textContent = option.label
      select.appendChild(el)
    }
    outDirty = false
  }
  if (!outDirty && document.activeElement !== select) select.value = s.configuredDevice
  if (Date.now() < outRestartingUntil) return
  // The active backend label is 'ALSA <device>'; anything else while cards exist means the
  // configured device would not open and a fallback is playing.
  const hint = document.getElementById('out-hint')
  hint.textContent = !s.audioAvailable && !s.audioError
    ? 'Null output is configured intentionally; audio playback is disabled.'
    : s.audioAvailable && s.outputDevice.indexOf('ALSA ') === 0
    && s.outputDevice !== 'ALSA ' + s.configuredDevice
    ? 'Configured output unavailable — using ' + s.outputDevice
    : ''
}
function refreshAudioStatus(s) {
  const banner = document.getElementById('audio-degraded')
  const degraded = !s.audioAvailable && !!s.audioError
  banner.style.display = degraded ? '' : 'none'
  if (!degraded) return
  document.getElementById('audio-degraded-error').textContent = s.audioError
  document.getElementById('audio-degraded-configured').textContent =
    'Configured output: ' + s.configuredDevice
  document.getElementById('audio-degraded-devices').textContent = s.audioDevices.length
    ? 'Detected outputs: ' + s.audioDevices.map((device) => device.label).join(' · ')
    : 'No ALSA outputs are currently detected.'
}
let cecDirty = false
for (const id of ['cec-on', 'cec-wake', 'cec-input', 'cec-standby']) {
  document.getElementById(id).addEventListener('input', () => { cecDirty = true })
}
async function applyCec() {
  const res = await fetch('/api/cec', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      control: document.getElementById('cec-on').checked,
      wakeOn: document.getElementById('cec-wake').value,
      switchInput: document.getElementById('cec-input').checked,
      standbyMinutes: Number(document.getElementById('cec-standby').value)
    }) })
  cecDirty = false
  document.getElementById('cec-hint').textContent = res.ok
    ? 'TV settings saved ✓' : 'Could not save the TV settings.'
}
function refreshCec(s) {
  const card = document.getElementById('cec-card')
  if (!s.cec || !s.cec.available) { card.style.display = 'none'; return }
  card.style.display = ''
  document.getElementById('cec-remote').textContent = !s.cec.control ? ''
    : s.cec.lastKey
    ? 'Last TV-remote key: ' + s.cec.lastKey.raw + ' (' + Math.max(0, Math.round((Date.now() - s.cec.lastKey.atMs) / 1000)) + 's ago)'
    : 'No TV-remote keys received yet.'
  if (cecDirty) return
  const focus = document.activeElement
  const on = document.getElementById('cec-on')
  if (focus !== on) on.checked = s.cec.control
  const wake = document.getElementById('cec-wake')
  if (focus !== wake) wake.value = s.cec.wakeOn
  const input = document.getElementById('cec-input')
  if (focus !== input) input.checked = s.cec.switchInput
  const standby = document.getElementById('cec-standby')
  if (focus !== standby) {
    const wanted = String(s.cec.standbyMinutes)
    // A hand-edited config can hold a duration the preset list lacks — offer it rather than
    // silently displaying the wrong value.
    if (!Array.prototype.some.call(standby.options, (o) => o.value === wanted)) {
      const el = document.createElement('option')
      el.value = wanted
      el.textContent = wanted + ' minutes'
      standby.appendChild(el)
    }
    standby.value = wanted
  }
}
let clockDirty = false
document.getElementById('clock-select').addEventListener('change', async (e) => {
  clockDirty = true
  await fetch('/api/clock-format', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: e.target.value }) })
  clockDirty = false
})
async function systemAct(action) {
  const hint = document.getElementById('sys-hint')
  hint.textContent = action === 'update' ? 'Checking for updates…'
    : action === 'restart' ? 'Restarting the receiver…'
    : action === 'reset-wifi' ? 'Removing saved Wi-Fi networks…'
    : action === 'factory-reset' ? 'Resetting…' : 'Rebooting…'
  try {
    const res = await fetch('/api/system', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }) })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) { hint.textContent = payload.error || 'Failed.'; return }
    if (action === 'update') {
      // A found update shows up as the version-change reload; this predicate only needs the
      // "nothing to do" and "finished after a restart" endings.
      beginBusy('Checking for updates…', (s, b) => {
        if (!s.updating && Date.now() - b.startedAt > 8000) {
          return b.sawFail ? 'Update finished' : 'Already up to date'
        }
        return false
      }, 300000)
    } else if (action === 'restart') {
      beginBusy('Restarting the receiver…', (s, b) => b.sawFail ? 'Receiver restarted' : false)
    } else if (action === 'reboot') {
      beginBusy('Rebooting the speaker…', (s, b) => b.sawFail ? 'Speaker back online' : false, 180000)
    } else if (action === 'factory-reset') {
      beginBusy('Factory resetting…', (s, b) => b.sawFail && !s.paired ? 'Factory reset complete' : false, 180000)
    }
    hint.textContent = action === 'update'
      ? 'Checking — if an update is found, the receiver restarts itself within a minute or two.'
      : action === 'restart' ? 'Restarting — back in ~15 seconds.'
      : action === 'reset-wifi' ? 'Wi-Fi networks removed — the Parallax-Setup hotspot appears in ~30 seconds.'
      : action === 'factory-reset' ? 'Factory reset done — the speaker restarts as brand new (setup hotspot in ~1 minute).'
      : 'Rebooting — back in about a minute.'
  } catch {
    // A dead fetch right after a reboot request is the reboot working; anything else self-heals
    // through the 1 Hz polling.
    if (action === 'update') hint.textContent = 'Could not reach the receiver.'
  }
}
async function refresh() {
  try {
    const s = await (await fetch('/api/status')).json()
    busyPollRecovered()
    busyTick(s)
    const pair = document.getElementById('pair')
    if (s.incomingPair) {
      pair.style.display = ''
      document.getElementById('pair-host').textContent = s.incomingPair.hostName + ' wants to pair'
      document.getElementById('pair-pin').textContent = s.incomingPair.pin
      document.getElementById('pair-actions').style.display = s.incomingPair.awaitingApproval ? '' : 'none'
      document.getElementById('pair-approval-hint').style.display = s.incomingPair.awaitingApproval ? '' : 'none'
    } else {
      pair.style.display = 'none'
    }
    const status = document.getElementById('s-status')
    status.textContent = s.statusLabel
    status.className = s.statusLabel === 'Connected' ? 'ok'
      : s.statusLabel === 'Reconnecting…' ? 'bad' : ''
    document.getElementById('s-host').textContent = s.hostName || '—'
    document.getElementById('s-np').textContent = !s.playbackEnabled
      ? 'Not selected for playback'
      : s.streamTitle
      ? s.streamTitle + (s.streamArtist ? ' — ' + s.streamArtist : '') + ' (' + s.playbackState + ')'
      : '—'
    document.getElementById('s-clock').textContent = s.clockOffsetMs === null
      ? '—'
      : s.clockOffsetMs.toFixed(1) + ' ms offset' + (s.rttMs === null ? '' : ', ' + s.rttMs.toFixed(1) + ' ms RTT')
    document.getElementById('s-out').textContent = s.outputDevice
      + (s.appliedAdvanceMs ? ' (trim ' + s.appliedAdvanceMs + ' ms)' : '')
    refreshAudioStatus(s)
    refreshOutput(s)
    const errRow = document.getElementById('s-err-row')
    errRow.style.display = s.lastError ? '' : 'none'
    document.getElementById('s-err').textContent = s.lastError || ''
    document.getElementById('transport-actions').style.display =
      s.paired && s.connected && s.transportSupported !== false ? '' : 'none'
    const nameInput = document.getElementById('name-input')
    if (!nameDirty && document.activeElement !== nameInput) {
      nameInput.value = s.assignedSinkName || s.sinkName
    }
    const tzSelect = document.getElementById('tz-select')
    if (tzLoaded && !tzDirty && document.activeElement !== tzSelect) tzSelect.value = s.timezone
    if (tzPending && s.timezone === tzPending) {
      tzPending = null
      document.getElementById('tz-hint').textContent = 'Timezone updated ✓'
    }
    refreshCec(s)
    const clockSelect = document.getElementById('clock-select')
    if (!clockDirty && document.activeElement !== clockSelect) clockSelect.value = s.clockFormat
    document.getElementById('s-ver').textContent = s.version
    document.getElementById('reset-wifi-btn').style.display = s.setup ? '' : 'none'
    const vol = document.getElementById('vol')
    if (document.activeElement !== vol) vol.value = s.volumePercent
    document.getElementById('vol-label').textContent = s.volumePercent + '%'
    document.getElementById('forget-actions').style.display = s.paired ? '' : 'none'
    const diag = document.getElementById('diag-card')
    if (s.diagnostics && s.playbackState !== 'stopped') {
      diag.style.display = ''
      const d = s.diagnostics
      const ms = (v) => v === null ? '—' : v.toFixed(1) + ' ms'
      document.getElementById('d-drift').textContent = ms(d.driftMs)
      document.getElementById('d-p2').textContent = ms(d.phase2DriftMs)
      document.getElementById('d-loop').textContent = (d.loopSource || '—')
        + (d.rebuffering ? ' (rebuffering)' : '')
      document.getElementById('d-ppm').textContent = d.appliedPpm + ' ppm'
      document.getElementById('d-buf').textContent = d.bufferedMs.toFixed(0) + ' ms / ' + d.latencyMs.toFixed(1) + ' ms'
      document.getElementById('d-anchors').textContent = d.anchors + (d.predictorTrusted ? ' (trusted)' : ' (settling)')
      document.getElementById('d-syncs').textContent = d.hardSyncCount + (d.lastSyncEvent ? ' (last: ' + d.lastSyncEvent + ')' : '')
      document.getElementById('d-under').textContent = String(d.underruns)
      document.getElementById('d-next').textContent = d.stagedNextTitle ? d.stagedNextTitle + ' (staged)' : '—'
    } else {
      diag.style.display = 'none'
    }
    document.getElementById('s-id').textContent = s.endpointUuid
  } catch {
    // Daemon restarting — keep polling; the busy banner tells the user what's happening.
    busyPollFailed()
  }
}
refresh()
setInterval(refresh, 1000)
</script>
</body>
</html>
`

// Zone-Display-style TV page for the Parallax OS kiosk (Cage + WPE pointed at /display).
// Same no-framework single-page pattern as the status page: 1 Hz /api/status polling that
// survives daemon restarts. Artwork is swapped only when artworkId changes.
const DISPLAY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parallax</title>
<style>
  :root { color-scheme: dark; }
  * { cursor: none; }
  html, body { height: 100%; }
  body { margin: 0; background: #000; color: #f2f2f6; font-family: system-ui, sans-serif;
         overflow: hidden; }

  /* ── Now playing: full-bleed artwork + lower-third band ── */
  #backdrop { position: fixed; inset: -6vmax; background-size: cover; background-position: center;
              filter: blur(5vmax) brightness(0.5); opacity: 0; transition: opacity 1.2s ease; }
  #scrim { position: fixed; inset: 0;
           background: linear-gradient(to top, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.35) 34%,
                                       rgba(0,0,0,0.06) 60%); }
  #stage { position: fixed; inset: 0; display: flex; flex-direction: column;
           justify-content: flex-end; padding: 0 5vmin 3.5vmin; }
  #band { display: flex; align-items: flex-end; gap: 3.2vmin; }
  #art { width: 24vmin; height: 24vmin; border-radius: 1.6vmin; object-fit: cover;
         box-shadow: 0 1.5vmin 5vmin rgba(0,0,0,0.55); background: #16161c; display: none; }
  #band-main { flex: 1; min-width: 0; }
  #title { font-size: 5.5vmin; font-weight: 700; line-height: 1.12; margin: 0;
           overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
           text-shadow: 0 0.3vmin 1.5vmin rgba(0,0,0,0.5); }
  #subtitle { font-size: 2.9vmin; color: #c9c9d4; margin: 1vmin 0 0;
              overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #progress { margin-top: 2.6vmin; }
  #bar { height: 0.7vmin; border-radius: 0.35vmin; background: rgba(255,255,255,0.22);
         overflow: hidden; }
  #bar-fill { height: 100%; width: 0; border-radius: 0.35vmin; background: #f2f2f6;
              transition: width 0.25s linear; }
  #times { display: flex; justify-content: space-between; font-size: 2.1vmin; color: #a5a5b2;
           margin-top: 1vmin; font-variant-numeric: tabular-nums; }
  #band-footer { display: flex; justify-content: space-between; align-items: baseline;
                 gap: 3vmin; margin-top: 2.4vmin; font-size: 2vmin; color: #8b8b98; }
  #zone { text-transform: uppercase; letter-spacing: 0.2em; }
  #next { flex: 1; text-align: center; overflow: hidden; text-overflow: ellipsis;
          white-space: nowrap; color: #6f6f7c; }
  #np-clock { font-variant-numeric: tabular-nums; }

  /* ── Idle: clock hero over a parallax constellation ── */
  #idle { position: fixed; inset: 0; }
  /* Faint specks on depth layers (deeper = bigger, faster, brighter) that link up when they
     drift close — drawn on a canvas at ~30 fps, and ONLY while the idle screen is visible. */
  #constellation { position: absolute; inset: 0; width: 100%; height: 100%; }
  /* Two nested drift loops with co-prime-ish periods trace a slow Lissajous path — the
     content never parks on the same pixels (OLED burn-in). */
  #drift-x { position: absolute; inset: 0; animation: drift-x 380s ease-in-out infinite alternate; }
  #drift-y { position: absolute; inset: 0; display: flex; flex-direction: column;
             align-items: center; justify-content: center; gap: 2.2vmin;
             animation: drift-y 260s ease-in-out infinite alternate; }
  @keyframes drift-x { from { transform: translateX(-2vmin); } to { transform: translateX(2vmin); } }
  @keyframes drift-y { from { transform: translateY(-1.6vmin); } to { transform: translateY(1.6vmin); } }
  #idle-clock { font-size: 17vmin; font-weight: 200; letter-spacing: 0.02em;
                font-variant-numeric: tabular-nums; line-height: 1; }
  #idle-date { font-size: 3vmin; color: #b5b5c2; font-weight: 300; }
  #idle-zone { font-size: 2.2vmin; font-weight: 600; letter-spacing: 0.22em;
               text-transform: uppercase; color: #6f6f7c; margin-top: 2.5vmin; }
  #idle-hint { font-size: 2.3vmin; color: #8b6f6f; min-height: 2.8vmin; }
  #setup-qr-tile { display: none; background: #fff; padding: 2.2vmin; border-radius: 1.4vmin;
                   margin-top: 2vmin; }
  #setup-qr { width: 16vmin; height: 16vmin; display: block; image-rendering: pixelated; }

  /* ── Transport controls: revealed by control activity (touch/mouse/remote keys), gone after
     a few seconds of none — never a burn-in resident. Fixed above the lower-third band. ── */
  #controls { position: fixed; left: 50%; bottom: 32vmin; transform: translateX(-50%);
              display: flex; gap: 4vmin; opacity: 0; pointer-events: none;
              transition: opacity 0.35s ease; z-index: 5; }
  #controls.visible { opacity: 1; pointer-events: auto; }
  #controls button { width: 11vmin; height: 11vmin; border-radius: 50%;
                     border: 0.35vmin solid rgba(255,255,255,0.35);
                     background: rgba(10,10,14,0.55); color: #f2f2f6; padding: 0;
                     display: flex; align-items: center; justify-content: center; }
  #controls button:focus { outline: none; border-color: #fff;
                           background: rgba(255,255,255,0.18); }
  #controls svg { width: 45%; height: 45%; }

  /* ── Settings sheet: the web UI's settings, 10-foot sized, driven by the same /api routes.
     Same inactivity rule as the transport overlay, just with a longer (30 s) leash. ── */
  #sheet { position: fixed; top: 0; right: 0; bottom: 0; width: 52vmin; box-sizing: border-box;
           background: rgba(12,12,17,0.94); padding: 4vmin 3vmin 3vmin; z-index: 8;
           transform: translateX(105%); transition: transform 0.3s ease;
           display: flex; flex-direction: column; }
  #sheet.open { transform: none; }
  #sheet h2 { font-size: 2vmin; font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase;
              color: #9a9aa8; margin: 0 1.4vmin 1.6vmin; }
  #sheet-rows { flex: 1; overflow-y: auto; min-height: 0; }
  .srow { display: flex; justify-content: space-between; align-items: center; gap: 2vmin;
          width: 100%; box-sizing: border-box; padding: 1.5vmin 1.4vmin; border-radius: 1vmin;
          border: 0.28vmin solid transparent; background: none; color: #f2f2f6;
          font-size: 2.2vmin; text-align: left; font-family: inherit; }
  .srow:focus { outline: none; border-color: #fff; background: rgba(255,255,255,0.12); }
  .srow .sv { color: #9a9aa8; text-align: right; overflow: hidden; text-overflow: ellipsis;
              white-space: nowrap; max-width: 55%; }
  .srow.confirm { border-color: #a33; }
  .srow.confirm .sv { color: #f2b8b8; }
  .sinfo { display: flex; justify-content: space-between; gap: 2vmin; padding: 0.7vmin 1.4vmin;
           font-size: 1.9vmin; color: #8b8b98; }
  .sinfo .sv { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
  .shead { font-size: 1.7vmin; color: #6f6f7c; letter-spacing: 0.2em; text-transform: uppercase;
           margin: 2.4vmin 1.4vmin 0.7vmin; }
  #sheet-hint { min-height: 2.6vmin; font-size: 1.9vmin; color: #9a9aa8; margin: 1.4vmin 1.4vmin 0; }

  /* ── Picker overlay: one tall focusable list (audio output, timezone) ── */
  #list-overlay { position: fixed; inset: 0; z-index: 9; background: rgba(0,0,0,0.9);
                  display: none; flex-direction: column; align-items: center;
                  padding: 6vmin 0 5vmin; box-sizing: border-box; }
  #list-overlay.open { display: flex; }
  #list-title { font-size: 2.2vmin; letter-spacing: 0.2em; text-transform: uppercase;
                color: #9a9aa8; margin-bottom: 2.5vmin; }
  #list-items { flex: 1; min-height: 0; overflow-y: auto; width: 64vmin; }
  .litem { display: block; width: 100%; box-sizing: border-box; padding: 1.3vmin 2.2vmin;
           border-radius: 1vmin; border: 0.28vmin solid transparent; background: none;
           color: #f2f2f6; font-size: 2.3vmin; text-align: left; font-family: inherit; }
  .litem:focus { outline: none; border-color: #fff; background: rgba(255,255,255,0.12); }
  .litem.current { color: #fff; font-weight: 700; }

  /* ── On-screen keyboard for the name field (a TV has no other way to type) ── */
  #osk { position: fixed; inset: 0; z-index: 10; background: rgba(0,0,0,0.92); display: none;
         flex-direction: column; align-items: center; justify-content: center; gap: 2.4vmin; }
  #osk.open { display: flex; }
  #osk-value { font-size: 4vmin; min-height: 5.2vmin; border-bottom: 0.3vmin solid #4a4a56;
               padding: 0 2vmin; letter-spacing: 0.06em; }
  .osk-row { display: flex; gap: 1vmin; }
  .osk-key { min-width: 6vmin; height: 6vmin; padding: 0 1.6vmin; box-sizing: border-box;
             font-size: 2.5vmin; background: rgba(255,255,255,0.08); border-radius: 1vmin;
             border: 0.28vmin solid transparent; color: #f2f2f6; font-family: inherit;
             display: flex; align-items: center; justify-content: center; }
  .osk-key:focus { outline: none; border-color: #fff; background: rgba(255,255,255,0.22); }

  /* ── Pairing: PIN + approve directly on the TV — a touch/remote node never needs the web
     page. Sits above every other layer. ── */
  #pair-modal { position: fixed; inset: 0; z-index: 11; background: rgba(0,0,0,0.94);
                display: none; flex-direction: column; align-items: center; justify-content: center;
                gap: 2.4vmin; text-align: center; }
  #pair-modal.open { display: flex; }
  #pair-modal-host { font-size: 2.6vmin; color: #c9c9d4; }
  #pair-modal-pin { font-size: 13vmin; font-weight: 700; letter-spacing: 0.3em;
                    font-variant-numeric: tabular-nums; line-height: 1; }
  #pair-modal-hint { font-size: 2.2vmin; color: #8b8b98; }
  #pair-actions-tv { display: none; gap: 3vmin; margin-top: 2vmin; }
  #pair-actions-tv button { font-size: 2.6vmin; padding: 1.6vmin 4vmin; border-radius: 6vmin;
                            border: 0.3vmin solid rgba(255,255,255,0.35); font-family: inherit;
                            background: rgba(10,10,14,0.55); color: #f2f2f6; }
  #pair-actions-tv button:focus { outline: none; border-color: #fff;
                                  background: rgba(255,255,255,0.18); }
  #pair-approve.primary { background: #4a6cf7; border-color: #4a6cf7; }
  #pair-approve.primary:focus { background: #6a86f9; border-color: #fff; }

  /* ── Busy pill: "the speaker is doing something" — updates, restarts — over every state ── */
  #busy-pill { position: fixed; top: 3vmin; left: 50%; transform: translateX(-50%); z-index: 6;
               background: rgba(12,12,17,0.8); border: 0.25vmin solid rgba(255,255,255,0.3);
               border-radius: 5vmin; padding: 1vmin 2.8vmin; font-size: 2.1vmin; color: #c9c9d4;
               display: none; }
  #audio-pill { position: fixed; top: 9vmin; left: 50%; transform: translateX(-50%); z-index: 5;
                background: rgba(52,22,20,0.9); border: 0.25vmin solid #b45a45;
                border-radius: 5vmin; padding: 1vmin 2.8vmin; font-size: 2.1vmin; color: #ffc0b4;
                display: none; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div id="backdrop"></div>
<div id="scrim"></div>
<div id="stage" class="hidden">
  <div id="band">
    <img id="art" alt="">
    <div id="band-main">
      <h1 id="title"></h1>
      <p id="subtitle"></p>
      <div id="progress">
        <div id="bar"><div id="bar-fill"></div></div>
        <div id="times"><span id="t-elapsed"></span><span id="t-total"></span></div>
      </div>
    </div>
  </div>
  <div id="band-footer">
    <span id="zone"></span>
    <span id="next"></span>
    <span id="np-clock"></span>
  </div>
</div>
<div id="busy-pill"></div>
<div id="audio-pill">Audio unavailable — open settings to choose an output</div>
<div id="controls">
  <button id="ctl-prev" aria-label="Previous track">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2.4v14H6zM20 5v14L9.6 12z"/></svg>
  </button>
  <button id="ctl-play" aria-label="Play or pause">
    <svg id="ctl-play-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
  </button>
  <button id="ctl-next" aria-label="Next track">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.6 5H18v14h-2.4zM4 5v14l10.4-7z"/></svg>
  </button>
  <button id="ctl-settings" aria-label="Settings">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.4 13c.04-.32.07-.65.07-1s-.03-.68-.07-1l2.1-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.3 7.3 0 0 0-1.73-1l-.38-2.65A.5.5 0 0 0 13.93 2h-4a.5.5 0 0 0-.5.42l-.37 2.65c-.63.26-1.2.6-1.74 1l-2.48-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64L4.55 11c-.05.32-.08.65-.08 1s.03.68.08 1l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.13.22.39.31.61.22l2.48-1c.54.42 1.12.76 1.74 1l.37 2.65a.5.5 0 0 0 .5.42h4a.5.5 0 0 0 .49-.42l.38-2.65c.63-.26 1.2-.6 1.73-1l2.49 1c.22.09.48 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64zM11.93 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>
  </button>
</div>
<div id="sheet">
  <h2>Settings</h2>
  <div id="sheet-rows"></div>
  <div id="sheet-hint"></div>
</div>
<div id="list-overlay">
  <div id="list-title"></div>
  <div id="list-items"></div>
</div>
<div id="osk">
  <div id="osk-value"></div>
  <div id="osk-rows"></div>
</div>
<div id="pair-modal">
  <div id="pair-modal-host"></div>
  <div id="pair-modal-pin"></div>
  <div id="pair-modal-hint"></div>
  <div id="pair-actions-tv">
    <button id="pair-approve" class="primary">Approve</button>
    <button id="pair-reject">Reject</button>
  </div>
</div>
<div id="idle" class="hidden">
  <canvas id="constellation"></canvas>
  <div id="drift-x"><div id="drift-y">
    <div id="idle-clock"></div>
    <div id="idle-date"></div>
    <div id="idle-zone"></div>
    <div id="idle-hint"></div>
    <div id="setup-qr-tile"><canvas id="setup-qr" width="29" height="29"></canvas></div>
  </div></div>
</div>
<script>
let shownArtworkId = null
let pos = null
let lastStatus = null
let statusReceivedAt = 0
let pollFailures = 0
let kioskBootVersion = null
// Tracks how long the current status label has been showing, so everyday states (host app
// closed → "Waiting for host"/"Reconnecting…") quiet down to a clean clock after a while.
let hintLabel = null
let hintLabelSince = 0
// Page-load counts as "recently playing" so an already-paused track shows before the timer runs.
let lastAdvancingAt = Date.now()
const PAUSED_IDLE_MS = 2 * 60 * 1000
const HINT_QUIET_MS = 2 * 60 * 1000
const QUIETABLE_LABELS = ['Waiting for host', 'Reconnecting…']

function fmt(totalSeconds) {
  const t = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60
  const mm = h > 0 && m < 10 ? '0' + m : String(m)
  return (h > 0 ? h + ':' + mm : mm) + ':' + (s < 10 ? '0' + s : s)
}
// Clocks render in the SPEAKER's timezone (from status), not the viewing browser's — and a
// kiosk browser started before a tz change still shows the new zone without a restart.
function fmtClockTime(now, tz, fmt) {
  const base = { hour: 'numeric', minute: '2-digit' }
  // hourCycle (not hour12): hour12:false picks h23 OR h24 by locale, and 24:00 on a wall
  // clock looks broken. 'auto' leaves the locale's own preference.
  if (fmt === '12') base.hourCycle = 'h12'
  else if (fmt === '24') base.hourCycle = 'h23'
  try {
    return now.toLocaleTimeString([], tz ? Object.assign({ timeZone: tz }, base) : base)
  } catch { return now.toLocaleTimeString([], base) }
}
function fmtClockDate(now, tz) {
  const base = { weekday: 'long', month: 'long', day: 'numeric' }
  try {
    return now.toLocaleDateString([], tz ? Object.assign({ timeZone: tz }, base) : base)
  } catch { return now.toLocaleDateString([], base) }
}

// Parallax constellation: specks on depth layers drift and link up when close. ~70 particles at
// ~30 fps is a few thousand distance checks per frame — nothing, even on a Pi. Runs only while
// the idle screen is visible.
const stars = { canvas: null, ctx: null, parts: [], raf: 0, lastT: 0 }
function starsResize() {
  stars.canvas.width = window.innerWidth
  stars.canvas.height = window.innerHeight
  const wanted = Math.max(40, Math.min(90, Math.round(window.innerWidth * window.innerHeight / 26000)))
  while (stars.parts.length < wanted) {
    const depth = 0.35 + Math.random() * 0.65
    stars.parts.push({
      x: Math.random() * stars.canvas.width,
      y: Math.random() * stars.canvas.height,
      vx: (Math.random() - 0.5) * 26 * depth,
      vy: (Math.random() - 0.5) * 26 * depth,
      depth
    })
  }
  stars.parts.length = wanted
}
function starsFrame(t) {
  stars.raf = requestAnimationFrame(starsFrame)
  if (t - stars.lastT < 33) return
  const dt = stars.lastT ? Math.min(0.1, (t - stars.lastT) / 1000) : 0
  stars.lastT = t
  const ctx = stars.ctx
  const w = stars.canvas.width, h = stars.canvas.height
  ctx.clearRect(0, 0, w, h)
  ctx.lineWidth = 1
  const parts = stars.parts
  for (const p of parts) {
    p.x += p.vx * dt
    p.y += p.vy * dt
    if (p.x < -20) p.x = w + 20; else if (p.x > w + 20) p.x = -20
    if (p.y < -20) p.y = h + 20; else if (p.y > h + 20) p.y = -20
  }
  const linkDist = Math.min(w, h) * 0.16
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i]
    for (let j = i + 1; j < parts.length; j++) {
      const b = parts[j]
      const dx = a.x - b.x, dy = a.y - b.y
      const d2 = dx * dx + dy * dy
      if (d2 > linkDist * linkDist) continue
      const alpha = (1 - Math.sqrt(d2) / linkDist) * 0.4 * Math.min(a.depth, b.depth)
      ctx.strokeStyle = 'rgba(170,185,225,' + alpha.toFixed(3) + ')'
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
    ctx.fillStyle = 'rgba(195,205,235,' + (0.16 + 0.26 * a.depth).toFixed(3) + ')'
    ctx.beginPath()
    ctx.arc(a.x, a.y, 1 + 1.8 * a.depth, 0, 6.2832)
    ctx.fill()
  }
}
function starsSetRunning(run) {
  if (run && !stars.raf) {
    stars.lastT = 0
    stars.raf = requestAnimationFrame(starsFrame)
  } else if (!run && stars.raf) {
    cancelAnimationFrame(stars.raf)
    stars.raf = 0
  }
}
stars.canvas = document.getElementById('constellation')
stars.ctx = stars.canvas.getContext('2d')
starsResize()
window.addEventListener('resize', starsResize)

// Pre-generated QR for WIFI:T:nopass;S:Parallax-Setup;; (version 3, ECC M, 29x29) — the AP name
// is constant, so the matrix is baked instead of shipping an encoder. Hex rows, MSB-first,
// 29 bits used of each 32.
const SETUP_QR_ROWS = ['fea9dbf8','8288da08','ba81cae8','ba28aae8','badbe2e8','8251b208','feaaabf8',
  '003de000','9ff414b8','f0a484f0','cf9ddc08','95ecdcd0','5ee5b450','4ce69e88','d28cd348','298937f8',
  'def24ca0','d1f6d580','e6119738','c81a07d8','f29f1f90','00bbb8f8','fec28a88','8283c8f0','baef5fd8',
  'ba9112a0','ba4244f8','82658f40','fe8b68d0']
{
  const qr = document.getElementById('setup-qr').getContext('2d')
  qr.fillStyle = '#000'
  for (let y = 0; y < 29; y++) {
    const bits = parseInt(SETUP_QR_ROWS[y], 16).toString(2).padStart(32, '0')
    for (let x = 0; x < 29; x++) {
      if (bits[x] === '1') qr.fillRect(x, y, 1, 1)
    }
  }
}

// ── Interactive layers, all driven by CONTROL activity (pointer/touch/keys) and deliberately
// independent of the playback-idle logic. Stack (top wins): pairing modal > on-screen keyboard
// > picker list > settings sheet > transport overlay. Transport fades after 8 s of control
// inactivity, settings layers close after 30 s. Transport needs a connected host that supports
// the control lane; the settings gear and pairing work always — a TV/touch node never needs
// parallax.local. Keys work today with a keyboard and become the TV-remote path via the CEC RC
// passthrough keymap (image ships arrows/Enter/Esc/media keys).
const CONTROLS_HIDE_MS = 8000
const SHEET_HIDE_MS = 30000
const TRANSPORT_IDS = ['ctl-prev', 'ctl-play', 'ctl-next']
const MEDIA_TOGGLE_KEYS = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'Play', 'Pause']
const MEDIA_NEXT_KEYS = ['MediaTrackNext', 'MediaNextTrack', 'MediaFastForward']
const MEDIA_PREV_KEYS = ['MediaTrackPrevious', 'MediaPreviousTrack', 'MediaRewind']
let controlsHideTimer = null
let sheetHideTimer = null
let controlsUsable = false

function isOpen(id) { return document.getElementById(id).classList.contains('open') }
function topLayer() {
  if (isOpen('pair-modal')) return 'pair'
  if (isOpen('osk')) return 'osk'
  if (isOpen('list-overlay')) return 'list'
  if (isOpen('sheet')) return 'sheet'
  return 'controls'
}
function controlsShow() {
  document.getElementById('controls').classList.add('visible')
  if (controlsHideTimer) clearTimeout(controlsHideTimer)
  controlsHideTimer = setTimeout(() => {
    controlsHideTimer = null
    document.getElementById('controls').classList.remove('visible')
    const active = document.activeElement
    if (active && active.blur && document.getElementById('controls').contains(active)) active.blur()
  }, CONTROLS_HIDE_MS)
}
function controlsHide() {
  if (controlsHideTimer) { clearTimeout(controlsHideTimer); controlsHideTimer = null }
  document.getElementById('controls').classList.remove('visible')
}
function armSheetTimer() {
  if (sheetHideTimer) clearTimeout(sheetHideTimer)
  sheetHideTimer = setTimeout(closeAllLayers, SHEET_HIDE_MS)
}
function closeAllLayers() {
  if (sheetHideTimer) { clearTimeout(sheetHideTimer); sheetHideTimer = null }
  document.getElementById('osk').classList.remove('open')
  document.getElementById('list-overlay').classList.remove('open')
  document.getElementById('sheet').classList.remove('open')
  controlsHide()
}
function activity() {
  const layer = topLayer()
  if (layer === 'controls') controlsShow()
  else if (layer !== 'pair') armSheetTimer()
}
async function sendTransport(command) {
  if (!controlsUsable) return
  if (topLayer() === 'controls') controlsShow()
  try {
    await fetch('/api/transport', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }) })
  } catch { /* daemon restarting — the poll loop recovers */ }
}
async function postJson(path, body) {
  try {
    return await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) })
  } catch { return null }
}
document.getElementById('ctl-prev').addEventListener('click', () => sendTransport('previous'))
document.getElementById('ctl-play').addEventListener('click', () => sendTransport('toggle-play'))
document.getElementById('ctl-next').addEventListener('click', () => sendTransport('next'))
document.getElementById('ctl-settings').addEventListener('click', openSheet)

function visibleControls() {
  const buttons = []
  for (const id of TRANSPORT_IDS.concat(['ctl-settings'])) {
    const el = document.getElementById(id)
    if (el.style.display !== 'none') buttons.push(el)
  }
  return buttons
}
function moveFocusIn(items, delta, fallbackIndex) {
  if (!items.length) return
  const index = items.indexOf(document.activeElement)
  const next = index === -1
    ? (fallbackIndex !== undefined ? fallbackIndex : (delta > 0 ? 0 : items.length - 1))
    : Math.max(0, Math.min(items.length - 1, index + delta))
  items[next].focus()
  if (items[next].scrollIntoView) items[next].scrollIntoView({ block: 'nearest' })
}

// ── Settings sheet: 1:1 with the web page, driven by the same /api routes ──
let tvZones = []
function loadTvZones() {
  fetch('/api/timezones').then((r) => r.json())
    .then((payload) => { tvZones = payload.timezones || [] })
    .catch(() => { /* daemon busy — retried on next sheet open */ })
}
loadTvZones()
let sheetSig = ''
let sheetEls = {}
let armedAction = null
let armedTimer = null
const CEC_STANDBY_STEPS = [5, 10, 20, 30, 60, 120, 0]

function wakeLabel(v) { return v === 'play' ? 'When music plays' : v === 'connect' ? 'When host connects' : 'Never' }
function standbyLabel(v) { return v === 0 ? 'Never' : v >= 60 ? (v / 60) + ' h' : v + ' min' }
function clockLabel(v) { return v === '12' ? '12-hour' : v === '24' ? '24-hour' : 'Automatic' }
function sheetHint(text) { document.getElementById('sheet-hint').textContent = text }

async function postCec(patch) {
  const s = lastStatus
  if (!s || !s.cec) return
  const body = {
    control: s.cec.control, wakeOn: s.cec.wakeOn,
    switchInput: s.cec.switchInput, standbyMinutes: s.cec.standbyMinutes
  }
  for (const key in patch) body[key] = patch[key]
  const res = await postJson('/api/cec', body)
  sheetHint(res && res.ok ? 'TV settings saved' : 'Could not save.')
}
function toggleCecControl() { lastStatus.cec.control = !lastStatus.cec.control; postCec({ control: lastStatus.cec.control }); updateSheet() }
function toggleCecInput() { lastStatus.cec.switchInput = !lastStatus.cec.switchInput; postCec({ switchInput: lastStatus.cec.switchInput }); updateSheet() }
function cycleCecWake(delta) {
  const order = ['play', 'connect', 'off']
  const next = order[(order.indexOf(lastStatus.cec.wakeOn) + delta + order.length) % order.length]
  lastStatus.cec.wakeOn = next
  postCec({ wakeOn: next })
  updateSheet()
}
function cycleCecStandby(delta) {
  const index = CEC_STANDBY_STEPS.indexOf(lastStatus.cec.standbyMinutes)
  const next = CEC_STANDBY_STEPS[((index === -1 ? 1 : index) + delta + CEC_STANDBY_STEPS.length) % CEC_STANDBY_STEPS.length]
  lastStatus.cec.standbyMinutes = next
  postCec({ standbyMinutes: next })
  updateSheet()
}
function cycleClock(delta) {
  const order = ['auto', '12', '24']
  const next = order[(order.indexOf(lastStatus.clockFormat) + delta + order.length) % order.length]
  lastStatus.clockFormat = next
  postJson('/api/clock-format', { format: next }).then((res) => sheetHint(res && res.ok ? 'Saved' : 'Could not save.'))
  updateSheet()
}
function adjustVolume(delta) {
  const s = lastStatus
  s.volumePercent = Math.max(0, Math.min(100, s.volumePercent + delta * 5))
  postJson('/api/volume', { percent: s.volumePercent })
  updateSheet()
}
async function systemAct(action) {
  sheetHint(action === 'update' ? 'Checking for updates…'
    : action === 'restart' ? 'Restarting — back in ~15 seconds…'
    : action === 'reset-wifi' ? 'Wi-Fi removed — setup hotspot appears in ~30 seconds…'
    : action === 'factory-reset' ? 'Resetting — the speaker starts over as brand new…'
    : 'Rebooting — back in about a minute…')
  const res = await postJson('/api/system', { action })
  if (!res) return
  if (!res.ok) {
    let payload = null
    try { payload = await res.json() } catch { /* no body */ }
    sheetHint(payload && payload.error ? payload.error : 'Failed.')
    return
  }
  if (action === 'update') sheetHint('Checking — the speaker restarts itself if an update is found.')
}
async function forgetHost() {
  await postJson('/api/forget', {})
  closeAllLayers()
}

function sheetSpec(s) {
  const rows = []
  rows.push({ head: 'Status' })
  rows.push({ info: 'Status', value: s.statusLabel })
  rows.push({ info: 'Host', value: s.hostName || '—' })
  rows.push({ info: 'Output', value: s.outputDevice })
  if (s.audioError) rows.push({ info: 'Audio error', value: s.audioError })
  else if (!s.audioAvailable) rows.push({ info: 'Audio', value: 'Null output (development)' })
  rows.push({ info: 'Version', value: s.version })
  rows.push({ head: 'Speaker' })
  rows.push({ id: 'name', label: 'Device name', value: s.assignedSinkName || s.sinkName, act: openNameOsk })
  rows.push({ id: 'out', label: 'Audio output', value: s.configuredDevice === 'default' ? 'System default' : s.configuredDevice, act: openOutputList })
  if (tvZones.length) rows.push({ id: 'tz', label: 'Timezone', value: s.timezone, act: openTimezoneList })
  rows.push({ id: 'clockfmt', label: 'Clock format', value: clockLabel(s.clockFormat), act: () => cycleClock(1), adj: cycleClock })
  rows.push({ id: 'vol', label: 'Volume', value: s.volumePercent + '%', act: () => adjustVolume(1), adj: adjustVolume })
  if (s.cec && s.cec.available) {
    rows.push({ head: 'TV control' })
    rows.push({ id: 'cec', label: 'Control the TV (CEC)', value: s.cec.control ? 'On' : 'Off', act: toggleCecControl, adj: toggleCecControl })
    rows.push({ id: 'cecwake', label: 'Turn the TV on', value: wakeLabel(s.cec.wakeOn), act: () => cycleCecWake(1), adj: cycleCecWake })
    rows.push({ id: 'cecinput', label: 'Switch TV input', value: s.cec.switchInput ? 'On' : 'Off', act: toggleCecInput, adj: toggleCecInput })
    rows.push({ id: 'cecstandby', label: 'TV off after idle', value: standbyLabel(s.cec.standbyMinutes), act: () => cycleCecStandby(1), adj: cycleCecStandby })
  }
  rows.push({ head: 'Maintenance' })
  rows.push({ id: 'update', label: 'Check for updates', value: '', act: () => systemAct('update') })
  rows.push({ id: 'restart', label: 'Restart receiver', value: '', confirm: true, act: () => systemAct('restart') })
  rows.push({ id: 'reboot', label: 'Reboot device', value: '', confirm: true, act: () => systemAct('reboot') })
  if (s.setup) rows.push({ id: 'resetwifi', label: 'Reset Wi-Fi', value: '', confirm: true, act: () => systemAct('reset-wifi') })
  rows.push({ id: 'factory', label: 'Factory reset', value: '', confirm: true, act: () => systemAct('factory-reset') })
  if (s.paired) rows.push({ id: 'forget', label: 'Forget host', value: '', confirm: true, act: forgetHost })
  return rows
}
function buildSheet(spec) {
  const container = document.getElementById('sheet-rows')
  container.innerHTML = ''
  sheetEls = {}
  for (const row of spec) {
    if (row.head) {
      const el = document.createElement('div')
      el.className = 'shead'
      el.textContent = row.head
      container.appendChild(el)
      continue
    }
    if (row.info) {
      const el = document.createElement('div')
      el.className = 'sinfo'
      el.innerHTML = '<span class="sk"></span><span class="sv"></span>'
      el.firstChild.textContent = row.info
      el.lastChild.textContent = row.value
      sheetEls['info-' + row.info] = el.lastChild
      container.appendChild(el)
      continue
    }
    const btn = document.createElement('button')
    btn.className = 'srow'
    btn.id = 'srow-' + row.id
    btn.innerHTML = '<span class="sk"></span><span class="sv"></span>'
    btn.firstChild.textContent = row.label
    btn.lastChild.textContent = row.value
    btn.addEventListener('click', () => activateRow(sheetEls[row.id].row))
    sheetEls[row.id] = { btn: btn, sv: btn.lastChild, row: row }
    container.appendChild(btn)
  }
}
function activateRow(row) {
  armSheetTimer()
  if (row.confirm && armedAction !== row.id) {
    armedAction = row.id
    if (armedTimer) clearTimeout(armedTimer)
    armedTimer = setTimeout(() => { armedAction = null; updateSheet() }, 5000)
    updateSheet()
    return
  }
  if (row.confirm) {
    armedAction = null
    if (armedTimer) { clearTimeout(armedTimer); armedTimer = null }
  }
  row.act()
}
function updateSheet() {
  const s = lastStatus
  if (!s || !isOpen('sheet')) return
  const spec = sheetSpec(s)
  const sig = spec.map((row) => row.id || row.head || row.info).join('|')
  if (sig !== sheetSig) {
    sheetSig = sig
    const focusedId = document.activeElement ? document.activeElement.id : ''
    buildSheet(spec)
    const again = focusedId && focusedId.indexOf('srow-') === 0 ? document.getElementById(focusedId) : null
    if (again) again.focus()
    else { const first = document.querySelector('#sheet-rows .srow'); if (first) first.focus() }
    return
  }
  for (const row of spec) {
    if (row.head) continue
    if (row.info) { const el = sheetEls['info-' + row.info]; if (el) el.textContent = row.value; continue }
    const entry = sheetEls[row.id]
    if (!entry) continue
    entry.row = row
    const armed = armedAction === row.id
    entry.btn.classList.toggle('confirm', armed)
    entry.sv.textContent = armed ? 'Press again to confirm' : row.value
  }
}
function openSheet() {
  if (!lastStatus) return
  if (!tvZones.length) loadTvZones()
  controlsHide()
  sheetSig = ''
  sheetHint('')
  document.getElementById('sheet').classList.add('open')
  updateSheet()
  armSheetTimer()
}
function closeSheet() {
  document.getElementById('sheet').classList.remove('open')
  if (sheetHideTimer) { clearTimeout(sheetHideTimer); sheetHideTimer = null }
  controlsShow()
}

// ── Picker list overlay (audio output, timezone) ──
let listReturnFocus = ''
function openList(title, items, onPick) {
  listReturnFocus = document.activeElement ? document.activeElement.id : ''
  document.getElementById('list-title').textContent = title
  const container = document.getElementById('list-items')
  container.innerHTML = ''
  let currentEl = null
  for (const item of items) {
    const btn = document.createElement('button')
    btn.className = 'litem' + (item.current ? ' current' : '')
    btn.textContent = item.label
    btn.addEventListener('click', () => { closeList(); onPick(item.id) })
    container.appendChild(btn)
    if (item.current) currentEl = btn
  }
  document.getElementById('list-overlay').classList.add('open')
  armSheetTimer()
  const target = currentEl || container.firstChild
  if (target) { target.focus(); if (target.scrollIntoView) target.scrollIntoView({ block: 'center' }) }
}
function closeList() {
  document.getElementById('list-overlay').classList.remove('open')
  const back = listReturnFocus ? document.getElementById(listReturnFocus) : null
  if (back) back.focus()
  armSheetTimer()
}
function openOutputList() {
  const s = lastStatus
  const items = [{ id: 'default', label: 'System default', current: s.configuredDevice === 'default' }]
  for (const device of s.audioDevices) {
    items.push({ id: device.id, label: device.label, current: device.id === s.configuredDevice })
  }
  openList('Audio output', items, (id) => {
    sheetHint('Restarting on the new output…')
    postJson('/api/output', { device: id })
  })
}
function openTimezoneList() {
  const s = lastStatus
  openList('Timezone', tvZones.map((zone) => ({ id: zone, label: zone, current: zone === s.timezone })), (zone) => {
    sheetHint('Applying — this takes ~15 seconds…')
    postJson('/api/timezone', { timezone: zone })
  })
}

// ── On-screen keyboard (device name — a TV has no other way to type) ──
let oskValue = ''
let oskUpper = true
let oskGrid = []
function oskRenderValue() { document.getElementById('osk-value').textContent = oskValue || ' ' }
function oskAppend(ch) { if (oskValue.length < 80) { oskValue += ch; oskRenderValue() } }
function buildOsk() {
  const rowsSpec = ['1234567890', 'qwertyuiop', 'asdfghjkl', "zxcvbnm-'."]
  const container = document.getElementById('osk-rows')
  container.innerHTML = ''
  oskGrid = []
  for (const rowText of rowsSpec) {
    const rowEl = document.createElement('div')
    rowEl.className = 'osk-row'
    const rowButtons = []
    for (const raw of rowText) {
      const ch = oskUpper ? raw.toUpperCase() : raw
      const key = document.createElement('button')
      key.className = 'osk-key'
      key.textContent = ch
      key.addEventListener('click', () => { oskAppend(ch); armSheetTimer() })
      rowEl.appendChild(key)
      rowButtons.push(key)
    }
    container.appendChild(rowEl)
    oskGrid.push(rowButtons)
  }
  const special = document.createElement('div')
  special.className = 'osk-row'
  const specials = [
    { label: oskUpper ? 'abc' : 'ABC', fn: rebuildOskPreserve },
    { label: 'Space', fn: () => oskAppend(' ') },
    { label: 'Delete', fn: () => { oskValue = oskValue.slice(0, -1); oskRenderValue() } },
    { label: 'Cancel', fn: closeOsk },
    { label: 'Save', fn: saveOskName }
  ]
  const rowButtons = []
  for (const item of specials) {
    const key = document.createElement('button')
    key.className = 'osk-key'
    key.textContent = item.label
    key.addEventListener('click', () => { item.fn(); armSheetTimer() })
    special.appendChild(key)
    rowButtons.push(key)
  }
  container.appendChild(special)
  oskGrid.push(rowButtons)
}
function oskPosition() {
  for (let r = 0; r < oskGrid.length; r += 1) {
    const c = oskGrid[r].indexOf(document.activeElement)
    if (c !== -1) return { r: r, c: c }
  }
  return null
}
function oskMove(dr, dc) {
  const position = oskPosition() || { r: 1, c: 0 }
  const r = Math.max(0, Math.min(oskGrid.length - 1, position.r + dr))
  let c = position.c
  if (dr !== 0 && oskGrid[r].length !== oskGrid[position.r].length) {
    c = Math.round(position.c * (oskGrid[r].length - 1) / Math.max(1, oskGrid[position.r].length - 1))
  }
  c = Math.max(0, Math.min(oskGrid[r].length - 1, c + dc))
  oskGrid[r][c].focus()
}
function rebuildOskPreserve() {
  oskUpper = !oskUpper
  const position = oskPosition()
  buildOsk()
  const r = position ? position.r : 0
  const c = position ? Math.min(position.c, oskGrid[r].length - 1) : 0
  oskGrid[r][c].focus()
}
function openNameOsk() {
  const s = lastStatus
  oskValue = s.assignedSinkName || s.sinkName || ''
  oskUpper = true
  buildOsk()
  oskRenderValue()
  document.getElementById('osk').classList.add('open')
  oskGrid[1][0].focus()
  armSheetTimer()
}
function closeOsk() {
  document.getElementById('osk').classList.remove('open')
  const back = document.getElementById('srow-name')
  if (back) back.focus()
  armSheetTimer()
}
async function saveOskName() {
  const name = oskValue.trim()
  if (name) {
    const res = await postJson('/api/name', { name: name })
    sheetHint(res && res.ok ? 'Name saved' : 'Could not save the name.')
  }
  closeOsk()
}

// ── Pairing on the TV: PIN + approve, so a touch/remote node never needs the web page ──
function updatePairModal(s) {
  const modal = document.getElementById('pair-modal')
  const pair = s ? s.incomingPair : null
  if (!pair) {
    modal.classList.remove('open')
    return
  }
  modal.classList.add('open')
  document.getElementById('pair-modal-host').textContent = pair.hostName + ' wants to pair'
  document.getElementById('pair-modal-pin').textContent = pair.pin
  document.getElementById('pair-modal-hint').textContent = pair.awaitingApproval
    ? 'Approve to finish pairing'
    : 'Enter this PIN in Astra to continue'
  const actions = document.getElementById('pair-actions-tv')
  const wasHidden = actions.style.display !== 'flex'
  actions.style.display = pair.awaitingApproval ? 'flex' : 'none'
  if (pair.awaitingApproval && wasHidden) document.getElementById('pair-approve').focus()
}
document.getElementById('pair-approve').addEventListener('click', () => postJson('/api/approve', {}))
document.getElementById('pair-reject').addEventListener('click', () => postJson('/api/reject', {}))

window.addEventListener('pointerdown', activity)
window.addEventListener('pointermove', activity)
// Real keyboard events and TV-remote keys (streamed from the daemon's cec-follower over
// /api/keys SSE) share one handler. Synthetic keys can't rely on native button activation, so
// Enter/Space explicitly .click() the focused element on that path. The cross-source dedupe
// guards the day both pipes deliver (kernel RC passthrough AND cec-follower): the same key
// from the *other* source within 150 ms is the same physical press.
let lastKeyStamp = { key: '', at: 0, synthetic: false }
window.addEventListener('keydown', (e) => handleKey(e.key, () => e.preventDefault(), false))
const remoteKeys = new EventSource('/api/keys')
remoteKeys.onmessage = (msg) => {
  try {
    const data = JSON.parse(msg.data)
    if (data.key) handleKey(data.key, () => undefined, true)
  } catch { /* ignore malformed frames */ }
}
function syntheticActivate(containerId) {
  const active = document.activeElement
  if (active && active.click && document.getElementById(containerId).contains(active)) {
    active.click()
    return true
  }
  return false
}
function handleKey(key, preventDefault, synthetic) {
  const now = Date.now()
  if (key === lastKeyStamp.key && synthetic !== lastKeyStamp.synthetic && now - lastKeyStamp.at < 150) {
    lastKeyStamp = { key: key, at: now, synthetic: synthetic }
    return
  }
  lastKeyStamp = { key: key, at: now, synthetic: synthetic }
  // Media keys act from every layer — they are what the TV remote's deck buttons become.
  if (MEDIA_TOGGLE_KEYS.indexOf(key) !== -1) { preventDefault(); sendTransport('toggle-play'); return }
  if (MEDIA_NEXT_KEYS.indexOf(key) !== -1) { preventDefault(); sendTransport('next'); return }
  if (MEDIA_PREV_KEYS.indexOf(key) !== -1) { preventDefault(); sendTransport('previous'); return }
  const layer = topLayer()
  if (layer === 'pair') {
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      preventDefault()
      moveFocusIn([document.getElementById('pair-approve'), document.getElementById('pair-reject')],
        key === 'ArrowRight' ? 1 : -1, 0)
      return
    }
    if ((key === 'Enter' || key === ' ') && synthetic
        && document.getElementById('pair-actions-tv').style.display === 'flex') {
      if (!syntheticActivate('pair-modal')) document.getElementById('pair-approve').click()
    }
    return // real Enter = native click on the focused button
  }
  if (layer === 'osk') {
    armSheetTimer()
    if (key === 'ArrowUp') { preventDefault(); oskMove(-1, 0); return }
    if (key === 'ArrowDown') { preventDefault(); oskMove(1, 0); return }
    if (key === 'ArrowLeft') { preventDefault(); oskMove(0, -1); return }
    if (key === 'ArrowRight') { preventDefault(); oskMove(0, 1); return }
    if (key === 'Escape') { preventDefault(); closeOsk(); return }
    if (key === 'Backspace') { preventDefault(); oskValue = oskValue.slice(0, -1); oskRenderValue(); return }
    if ((key === 'Enter' || key === ' ') && synthetic) { syntheticActivate('osk'); return }
    if (!synthetic && key.length === 1 && key !== ' ') { preventDefault(); oskAppend(key); return } // physical keyboards type directly
    return
  }
  if (layer === 'list') {
    armSheetTimer()
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      preventDefault()
      moveFocusIn(Array.prototype.slice.call(document.querySelectorAll('#list-items .litem')),
        key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (key === 'Escape') { preventDefault(); closeList(); return }
    if ((key === 'Enter' || key === ' ') && synthetic) syntheticActivate('list-overlay')
    return
  }
  if (layer === 'sheet') {
    armSheetTimer()
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      preventDefault()
      moveFocusIn(Array.prototype.slice.call(document.querySelectorAll('#sheet-rows .srow')),
        key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const active = document.activeElement
      const entry = active && active.id && active.id.indexOf('srow-') === 0 ? sheetEls[active.id.slice(5)] : null
      if (entry && entry.row.adj) { preventDefault(); entry.row.adj(key === 'ArrowRight' ? 1 : -1) }
      return
    }
    if (key === 'Escape') { preventDefault(); closeSheet(); return }
    if ((key === 'Enter' || key === ' ') && synthetic) syntheticActivate('sheet')
    return
  }
  // Bottom layer: transport overlay + gear.
  const visible = document.getElementById('controls').classList.contains('visible')
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    preventDefault()
    controlsShow()
    if (visible) moveFocusIn(visibleControls(), key === 'ArrowRight' ? 1 : -1)
    else document.getElementById(controlsUsable ? 'ctl-play' : 'ctl-settings').focus()
    return
  }
  if (key === 'Enter' || key === ' ') {
    const inControls = document.activeElement && document.getElementById('controls').contains(document.activeElement)
    if (visible && inControls) {
      controlsShow()
      if (synthetic) syntheticActivate('controls')
      return // real presses: native click fires
    }
    preventDefault()
    controlsShow()
    if (visible) sendTransport('toggle-play')
    else document.getElementById(controlsUsable ? 'ctl-play' : 'ctl-settings').focus()
    return
  }
  if (key === 'Escape') { controlsHide(); return }
  controlsShow()
}

function updateBusyPill() {
  const pill = document.getElementById('busy-pill')
  if (pollFailures >= 2) {
    pill.style.display = 'block'
    pill.textContent = 'Speaker restarting…'
  } else if (lastStatus && lastStatus.updating) {
    pill.style.display = 'block'
    pill.textContent = 'Updating the speaker…'
  } else {
    pill.style.display = 'none'
  }
}
function render() {
  updateBusyPill()
  const s = lastStatus
  const now = new Date()
  if (!s) {
    document.getElementById('audio-pill').style.display = 'none'
    // No status yet (kiosk up before the daemon, or daemon restarting): live clock over the
    // constellation instead of a dead black screen.
    document.getElementById('idle').classList.remove('hidden')
    starsSetRunning(true)
    document.getElementById('idle-clock').textContent = fmtClockTime(now, null, null)
    document.getElementById('idle-date').textContent = fmtClockDate(now, null)
    controlsUsable = false
    controlsHide()
    return
  }
  document.getElementById('audio-pill').style.display = s.audioError ? 'block' : 'none'
  controlsUsable = !!(s.paired && s.connected && s.transportSupported !== false)
  for (const id of TRANSPORT_IDS) {
    document.getElementById(id).style.display = controlsUsable ? '' : 'none'
  }
  updatePairModal(s)
  updateSheet()
  document.getElementById('ctl-play-icon').innerHTML = s.playbackState === 'playing'
    ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>'
    : '<path d="M8 5v14l11-7z"/>'
  // hostReachable false = the host app has been gone past its grace window — the "now
  // playing" is definitionally over, drop to idle instead of showing a frozen track.
  const hasTrack = s.playbackEnabled && s.streamTitle && s.playbackState !== 'stopped'
    && s.hostReachable !== false
  if (pos && pos.advancing) lastAdvancingAt = Date.now()
  // Hard stop / disconnect idles immediately; paused idles after the grace period.
  const showStage = hasTrack && (Date.now() - lastAdvancingAt < PAUSED_IDLE_MS)
  document.getElementById('stage').classList.toggle('hidden', !showStage)
  document.getElementById('idle').classList.toggle('hidden', showStage)
  starsSetRunning(!showStage)
  document.getElementById('scrim').style.display = showStage ? '' : 'none'
  document.getElementById('backdrop').style.opacity = showStage && shownArtworkId ? '1' : '0'
  const zone = s.assignedSinkName || s.sinkName
  const clockText = fmtClockTime(now, s.timezone, s.clockFormat)
  if (showStage) {
    document.getElementById('title').textContent = s.streamTitle
    document.getElementById('subtitle').textContent = (s.streamArtist || '')
      + (s.streamAlbum ? ' — ' + s.streamAlbum : '')
    document.getElementById('zone').textContent = zone
    document.getElementById('np-clock').textContent = clockText
    const next = s.diagnostics && s.diagnostics.stagedNextTitle
    document.getElementById('next').textContent = pollFailures >= 3
      ? 'Reconnecting to speaker…'
      : next ? 'Up next: ' + next : ''
    const progress = document.getElementById('progress')
    if (pos) {
      progress.style.visibility = ''
      let elapsed = pos.elapsedSeconds + (pos.advancing ? (Date.now() - pos.receivedAt) / 1000 : 0)
      if (pos.durationSeconds !== null) elapsed = Math.min(elapsed, pos.durationSeconds)
      document.getElementById('t-elapsed').textContent = (s.playbackState === 'paused' ? 'Paused · ' : '') + fmt(elapsed)
      document.getElementById('t-total').textContent = pos.durationSeconds !== null ? fmt(pos.durationSeconds) : '--:--'
      document.getElementById('bar-fill').style.width = pos.durationSeconds
        ? Math.min(100, (elapsed / pos.durationSeconds) * 100) + '%'
        : '0'
    } else {
      progress.style.visibility = 'hidden'
    }
  } else {
    document.getElementById('idle-clock').textContent = clockText
    document.getElementById('idle-date').textContent = fmtClockDate(now, s.timezone)
    document.getElementById('idle-zone').textContent = zone
    // Setup mode owns the hint (with the join QR); otherwise quiet when everything is fine —
    // only surface an abnormal state (not paired, host away, zone not selected).
    const inSetup = s.setup && s.setup.apActive
    document.getElementById('setup-qr-tile').style.display = inSetup ? 'block' : 'none'
    const hint = document.getElementById('idle-hint')
    if (inSetup) {
      hint.textContent = 'To set up, join the Wi-Fi network "' + s.setup.apSsid + '" with your phone'
      hint.style.color = '#b5b5c2'
    } else if (s.setup && s.setup.connecting) {
      hint.textContent = 'Connecting to Wi-Fi…'
      hint.style.color = '#b5b5c2'
    } else if (s.setup && s.setup.apEtaSeconds !== null) {
      // Server-anchored countdown; the 1 Hz poll keeps it fresh.
      hint.textContent = 'No network found — Wi-Fi setup starts in ~' + s.setup.apEtaSeconds + 's'
      hint.style.color = '#b5b5c2'
    } else if (pollFailures >= 3) {
      // The daemon itself is away (settings change, update, crash-restart) — say so instead
      // of showing stale state with no explanation.
      hint.textContent = 'Speaker restarting…'
      hint.style.color = '#b5b5c2'
    } else if (!s.audioAvailable && s.audioError) {
      hint.textContent = 'Audio unavailable — open settings to choose an output'
      hint.style.color = '#f2b8b8'
    } else {
      let label = s.statusLabel === 'Connected' ? '' : s.statusLabel
      if (label !== hintLabel) {
        hintLabel = label
        hintLabelSince = Date.now()
      }
      // A closed host app is an everyday state for an appliance — after a couple of minutes
      // the hint retires and the idle screen is just a clean clock.
      if (QUIETABLE_LABELS.indexOf(label) !== -1 && Date.now() - hintLabelSince > HINT_QUIET_MS) {
        label = ''
      }
      hint.textContent = label
      hint.style.color = ''
    }
  }
}

async function refresh() {
  try {
    const s = await (await fetch('/api/status')).json()
    // The kiosk browser loads this page once at boot — when the daemon comes back as a newer
    // release, reload so the TV runs the new UI (this is how updates reach the screen without
    // a node reboot).
    if (kioskBootVersion === null) kioskBootVersion = s.version
    else if (s.version !== kioskBootVersion) {
      kioskBootVersion = s.version
      setTimeout(() => location.reload(), 1000)
    }
    lastStatus = s
    statusReceivedAt = Date.now()
    pollFailures = 0
    const hasTrack = s.playbackEnabled && s.streamTitle && s.playbackState !== 'stopped'
    pos = hasTrack && s.position ? Object.assign({ receivedAt: Date.now() }, s.position) : null
    const art = document.getElementById('art')
    const backdrop = document.getElementById('backdrop')
    const wantedId = hasTrack ? s.artworkId : null
    if (wantedId !== shownArtworkId) {
      shownArtworkId = wantedId
      if (wantedId) {
        const url = '/api/artwork?id=' + encodeURIComponent(wantedId)
        art.src = url
        // 'block', never '' — clearing the inline style falls back to the stylesheet's
        // display:none and the tile can never appear (the original missing-artwork bug).
        art.style.display = 'block'
        backdrop.style.backgroundImage = 'url("' + url + '")'
      } else {
        art.removeAttribute('src')
        art.style.display = 'none'
        backdrop.style.backgroundImage = ''
      }
    }
    art.onerror = () => {
      // Transient failure (daemon restarting, gapless promote race): forget the id so the
      // next poll retries instead of hiding the artwork for the rest of the track.
      art.style.display = 'none'
      shownArtworkId = null
    }
    render()
  } catch {
    // Daemon restarting (settings change, update) — keep polling; render() surfaces it after
    // a few consecutive failures.
    pollFailures += 1
    render()
  }
}
refresh()
setInterval(refresh, 1000)
setInterval(render, 250)
</script>
</body>
</html>
`

// Wi-Fi onboarding portal, served while the daemon hosts the Parallax-Setup hotspot (and
// reachable at /setup any time apSetup is on). Captive-portal probes from phones get 302'd
// here. Crucial UX quirk: applying credentials TEARS DOWN the AP, so the phone loses this
// page the moment it submits — the page warns first and the copy explains both outcomes.
const SETUP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parallax Setup</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; background: #101014; color: #e8e8ee; margin: 0;
         display: flex; justify-content: center; padding: 2rem 1rem; }
  main { width: 100%; max-width: 26rem; }
  h1 { font-size: 1.3rem; font-weight: 700; margin: 0 0 0.3rem; }
  .sub { color: #9a9aa8; font-size: 0.9rem; margin: 0 0 1.2rem; }
  .card { background: #1a1a21; border: 1px solid #2a2a33; border-radius: 12px;
          padding: 1rem 1.25rem; margin-bottom: 1rem; }
  .net { display: flex; align-items: center; gap: 0.7rem; padding: 0.65rem 0.4rem;
         border-radius: 8px; cursor: pointer; font-size: 0.95rem; }
  .net:hover, .net.sel { background: #26262f; }
  .net .bars { color: #7fd88f; font-size: 0.8rem; width: 2.2rem; }
  .net .lock { color: #9a9aa8; margin-left: auto; font-size: 0.8rem; }
  input[type=password], input[type=text] {
    background: #101014; color: #e8e8ee; border: 1px solid #3a3a46; border-radius: 8px;
    padding: 0.6rem 0.7rem; width: 100%; box-sizing: border-box; font-size: 1rem; }
  button { background: #4a6cf7; color: #fff; border: none; border-radius: 8px; width: 100%;
           padding: 0.7rem 1rem; font-size: 1rem; font-weight: 600; cursor: pointer;
           margin-top: 0.8rem; }
  button:disabled { background: #2b2b36; color: #6f6f7c; }
  .err { background: #2a1a1d; border: 1px solid #5a2a30; color: #f2b8b8; border-radius: 8px;
         padding: 0.7rem 0.9rem; font-size: 0.9rem; margin-bottom: 1rem; display: none; }
  .muted { color: #9a9aa8; font-size: 0.82rem; line-height: 1.45; }
  #applied { display: none; }
</style>
</head>
<body>
<main>
  <h1>Parallax Setup</h1>
  <p class="sub">Connect this speaker to your Wi-Fi.</p>
  <div class="err" id="error"></div>
  <div id="chooser">
    <div class="card" id="nets"><div class="muted">Scanning for networks…</div></div>
    <div class="card" id="join" style="display:none">
      <div style="margin-bottom:0.6rem"><strong id="join-ssid"></strong></div>
      <input type="password" id="password" placeholder="Wi-Fi password" style="display:none">
      <button id="connect" onclick="apply()">Connect</button>
      <p class="muted" style="margin-bottom:0">When you tap Connect, the <strong>Parallax-Setup</strong>
      network disappears while the speaker joins your Wi-Fi. If the password was wrong,
      Parallax-Setup comes back — rejoin it to retry. Otherwise you're done: find the speaker at
      <strong>http://parallax.local/</strong> from your normal Wi-Fi and pair from Astra.</p>
    </div>
  </div>
  <div class="card" id="applied">
    <strong>Connecting…</strong>
    <p class="muted">The Parallax-Setup network is going away now. If it reappears in a minute,
    the password didn't work — rejoin it and try again.</p>
  </div>
</main>
<script>
let networks = []
let selected = null
async function loadNetworks() {
  try {
    const payload = await (await fetch('/api/setup/networks')).json()
    networks = payload.networks || []
    const nets = document.getElementById('nets')
    if (!networks.length) {
      nets.innerHTML = '<div class="muted">No networks found yet — still scanning…</div>'
      return
    }
    nets.innerHTML = ''
    for (const network of networks) {
      const row = document.createElement('div')
      row.className = 'net' + (selected === network.ssid ? ' sel' : '')
      const bars = network.signal > 66 ? '&#9679;&#9679;&#9679;' : network.signal > 33 ? '&#9679;&#9679;&#9675;' : '&#9679;&#9675;&#9675;'
      row.innerHTML = '<span class="bars">' + bars + '</span><span class="ssid"></span>'
        + (network.secured ? '<span class="lock">&#128274;</span>' : '')
      row.querySelector('.ssid').textContent = network.ssid
      row.onclick = () => select(network)
      nets.appendChild(row)
    }
  } catch { /* daemon busy — keep polling */ }
  try {
    const s = await (await fetch('/api/status')).json()
    const err = document.getElementById('error')
    if (s.setup && s.setup.lastError) {
      err.textContent = s.setup.lastError
      err.style.display = 'block'
    }
  } catch { /* ignore */ }
}
function select(network) {
  selected = network.ssid
  document.getElementById('join').style.display = ''
  document.getElementById('join-ssid').textContent = network.ssid
  const password = document.getElementById('password')
  password.style.display = network.secured ? '' : 'none'
  password.value = ''
  loadNetworks()
}
async function apply() {
  if (!selected) return
  const password = document.getElementById('password').value
  document.getElementById('connect').disabled = true
  try {
    const res = await fetch('/api/setup/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid: selected, password })
    })
    if (res.ok) {
      document.getElementById('chooser').style.display = 'none'
      document.getElementById('applied').style.display = 'block'
      return
    }
  } catch { /* fall through */ }
  document.getElementById('connect').disabled = false
}
loadNetworks()
setInterval(loadNetworks, 10000)
</script>
</body>
</html>
`

function toJsonResponse(res: ServerResponse<IncomingMessage>, statusCode: number, payload: unknown): void {
  if (res.headersSent) return
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

function toNotFoundResponse(res: ServerResponse<IncomingMessage>): void {
  toJsonResponse(res, 404, { error: 'Not found' })
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > 8 * 1024) throw new Error('Body too large.')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : null
}

export class WebStatusServer {
  private readonly callbacks: WebStatusCallbacks
  private readonly getPeerAddress: (request: IncomingMessage) => string | undefined
  private server: Server | null = null
  private stopPromise: Promise<void> | null = null
  // SSE subscribers of /api/keys (the display page) — TV-remote keys stream here.
  private readonly keyClients = new Set<ServerResponse<IncomingMessage>>()

  constructor(callbacks: WebStatusCallbacks, options: WebStatusServerOptions = {}) {
    this.callbacks = callbacks
    this.getPeerAddress = options.getPeerAddress ?? ((request) => request.socket.remoteAddress)
  }

  /** Broadcast a TV-remote key to every display page listening on /api/keys. */
  pushRemoteKey(key: string | null, raw: string): void {
    if (this.keyClients.size === 0) return
    const payload = `data: ${JSON.stringify({ key, raw })}\n\n`
    for (const client of this.keyClients) {
      try { client.write(payload) } catch { this.keyClients.delete(client) }
    }
  }

  async start(port: number): Promise<void> {
    await this.stop()
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res).catch(() => {
          if (!res.headersSent) toJsonResponse(res, 500, { error: 'Internal error.' })
        })
      })
      server.once('error', (error) => reject(error))
      server.listen(port, '0.0.0.0', () => {
        server.removeAllListeners('error')
        this.server = server
        resolve()
      })
    })
  }

  port(): number | null {
    const address = this.server?.address()
    return address && typeof address === 'object' ? (address as AddressInfo).port : null
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    if (!this.server) return
    const server = this.server
    this.server = null
    // Open SSE streams hold connections forever — end them or close() never resolves.
    for (const client of this.keyClients) {
      try { client.end() } catch { /* already gone */ }
    }
    this.keyClients.clear()
    const stopping = new Promise<void>((resolve) => server.close(() => resolve()))
    // close() stops accepts first; closeAllConnections() then destroys active requests and any
    // keep-alive sockets that would otherwise let a client hold shutdown open.
    server.closeAllConnections()
    this.stopPromise = stopping.finally(() => {
      this.stopPromise = null
    })
    return this.stopPromise
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'receiver'}`)
    const method = req.method ?? 'GET'
    const path = url.pathname

    // The kiosk surface belongs only to the browser running on the receiver. The direct socket
    // peer is authoritative; proxy forwarding headers are deliberately ignored.
    if (path === '/display' && !isLoopbackAddress(this.getPeerAddress(req))) {
      toNotFoundResponse(res)
      return
    }

    // Captive portal: while the setup AP is hosted, the image's dnsmasq drop-in resolves EVERY
    // name to us, so phones' connectivity probes (generate_204, hotspot-detect.html, …) land
    // here with foreign Host headers. Redirecting anything that isn't the portal itself makes
    // iOS/Android pop the setup sheet automatically.
    const setup = this.callbacks.getState().setup
    if (
      setup?.apActive
      && !(req.headers.host ?? '').startsWith('10.42.0.1')
      && path !== '/setup'
      && !path.startsWith('/api/')
    ) {
      res.statusCode = 302
      res.setHeader('Location', 'http://10.42.0.1/setup')
      res.setHeader('Cache-Control', 'no-store')
      res.end()
      return
    }

    if (method === 'GET' && path === '/setup') {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(SETUP_HTML)
      return
    }
    if (method === 'GET' && path === '/api/setup/networks') {
      if (!setup) {
        toJsonResponse(res, 404, { error: 'Wi-Fi setup is not enabled on this receiver.' })
        return
      }
      toJsonResponse(res, 200, { networks: await this.callbacks.getSetupNetworks() })
      return
    }
    if (method === 'POST' && path === '/api/setup/connect') {
      if (!setup) {
        toJsonResponse(res, 404, { error: 'Wi-Fi setup is not enabled on this receiver.' })
        return
      }
      const body = await readJsonBody(req).catch(() => null)
      const record = (body ?? {}) as { ssid?: unknown; password?: unknown }
      const ssid = typeof record.ssid === 'string' ? record.ssid.trim().slice(0, 64) : ''
      const password = typeof record.password === 'string' ? record.password.slice(0, 128) : ''
      if (!ssid) {
        toJsonResponse(res, 400, { error: 'ssid is required.' })
        return
      }
      if (!this.callbacks.applySetupCredentials(ssid, password)) {
        toJsonResponse(res, 409, { error: 'Already applying credentials.' })
        return
      }
      toJsonResponse(res, 200, { ok: true, applying: true })
      return
    }

    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(PAGE_HTML)
      return
    }
    if (method === 'GET' && path === '/display') {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(DISPLAY_HTML)
      return
    }
    if (method === 'GET' && path === '/api/status') {
      toJsonResponse(res, 200, this.callbacks.getState())
      return
    }
    if (method === 'GET' && path === '/api/keys') {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Connection', 'keep-alive')
      res.write(': connected\n\n')
      this.keyClients.add(res)
      req.on('close', () => this.keyClients.delete(res))
      return
    }
    if (method === 'GET' && path === '/api/artwork') {
      const artwork = this.callbacks.getArtwork()
      if (!artwork) {
        toJsonResponse(res, 404, { error: 'No artwork for the active stream.' })
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', artwork.contentType)
      // The URL carries ?id=<streamId>, so a given URL's bytes never change.
      res.setHeader('Cache-Control', 'private, max-age=86400')
      res.end(artwork.bytes)
      return
    }
    if (method === 'POST' && path === '/api/approve') {
      toJsonResponse(res, 200, { ok: this.callbacks.approvePair() })
      return
    }
    if (method === 'POST' && path === '/api/reject') {
      this.callbacks.rejectPair()
      toJsonResponse(res, 200, { ok: true })
      return
    }
    if (method === 'POST' && path === '/api/name') {
      const body = await readJsonBody(req).catch(() => null)
      const name = typeof (body as { name?: unknown } | null)?.name === 'string'
        ? String((body as { name: string }).name).trim().slice(0, 80)
        : ''
      if (!name) {
        toJsonResponse(res, 400, { error: 'name is required.' })
        return
      }
      this.callbacks.setName(name)
      toJsonResponse(res, 200, { ok: true })
      return
    }
    if (method === 'POST' && path === '/api/volume') {
      const body = await readJsonBody(req).catch(() => null)
      const percent = Number((body as { percent?: unknown } | null)?.percent)
      if (!Number.isFinite(percent)) {
        toJsonResponse(res, 400, { error: 'percent must be a number.' })
        return
      }
      this.callbacks.setVolume(Math.max(0, Math.min(100, percent)))
      toJsonResponse(res, 200, { ok: true })
      return
    }
    if (method === 'GET' && path === '/api/timezones') {
      toJsonResponse(res, 200, { timezones: await this.callbacks.getTimezones() })
      return
    }
    if (method === 'POST' && path === '/api/timezone') {
      const body = await readJsonBody(req).catch(() => null)
      const timezone = typeof (body as { timezone?: unknown } | null)?.timezone === 'string'
        ? String((body as { timezone: string }).timezone).trim().slice(0, 64)
        : ''
      if (!timezone || !(await this.callbacks.setTimezone(timezone))) {
        toJsonResponse(res, 400, { error: 'unknown timezone.' })
        return
      }
      toJsonResponse(res, 200, { ok: true, restarting: true })
      return
    }
    if (method === 'POST' && path === '/api/output') {
      const body = await readJsonBody(req).catch(() => null)
      const device = typeof (body as { device?: unknown } | null)?.device === 'string'
        ? String((body as { device: string }).device).trim().slice(0, 128)
        : ''
      if (!device) {
        toJsonResponse(res, 400, { error: 'device is required.' })
        return
      }
      if (!this.callbacks.setOutputDevice(device)) {
        toJsonResponse(res, 400, { error: 'unknown device.' })
        return
      }
      toJsonResponse(res, 200, { ok: true, restarting: true })
      return
    }
    if (method === 'POST' && path === '/api/cec') {
      const body = await readJsonBody(req).catch(() => null)
      const record = (body ?? {}) as {
        control?: unknown
        wakeOn?: unknown
        switchInput?: unknown
        standbyMinutes?: unknown
      }
      const wakeOn = record.wakeOn
      const standbyMinutes = Number(record.standbyMinutes)
      if (
        (wakeOn !== 'play' && wakeOn !== 'connect' && wakeOn !== 'off')
        || !Number.isInteger(standbyMinutes) || standbyMinutes < 0 || standbyMinutes > 720
      ) {
        toJsonResponse(res, 400, { error: 'invalid TV control settings.' })
        return
      }
      this.callbacks.setCecSettings({
        control: record.control === true,
        wakeOn,
        switchInput: record.switchInput === true,
        standbyMinutes
      })
      toJsonResponse(res, 200, { ok: true })
      return
    }
    if (method === 'POST' && path === '/api/clock-format') {
      const body = await readJsonBody(req).catch(() => null)
      const format = (body as { format?: unknown } | null)?.format
      if (format !== 'auto' && format !== '12' && format !== '24') {
        toJsonResponse(res, 400, { error: 'invalid clock format.' })
        return
      }
      this.callbacks.setClockFormat(format)
      toJsonResponse(res, 200, { ok: true })
      return
    }
    if (method === 'POST' && path === '/api/transport') {
      const body = await readJsonBody(req).catch(() => null)
      const command = (body as { command?: unknown } | null)?.command
      if (command !== 'toggle-play' && command !== 'next' && command !== 'previous') {
        toJsonResponse(res, 400, { error: 'unknown transport command.' })
        return
      }
      const result = await this.callbacks.sendTransport(command)
      toJsonResponse(res, result === 'ok' ? 200 : result === 'unsupported' ? 404 : 502, {
        ok: result === 'ok',
        result
      })
      return
    }
    if (method === 'POST' && path === '/api/system') {
      const body = await readJsonBody(req).catch(() => null)
      const action = (body as { action?: unknown } | null)?.action
      if (
        action !== 'restart' && action !== 'reboot' && action !== 'update'
        && action !== 'reset-wifi' && action !== 'factory-reset'
      ) {
        toJsonResponse(res, 400, { error: 'invalid action.' })
        return
      }
      const result = await this.callbacks.systemAction(action)
      toJsonResponse(res, result.ok ? 200 : 500, result)
      return
    }
    if (method === 'POST' && path === '/api/forget') {
      await this.callbacks.forgetHost()
      toJsonResponse(res, 200, { ok: true })
      return
    }
    toNotFoundResponse(res)
  }
}
