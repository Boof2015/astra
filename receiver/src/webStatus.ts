import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
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
  // TV control settings; the card is offered only when a CEC adapter exists (`available`).
  cec: {
    available: boolean
    control: boolean
    wakeOn: CecWakeOn
    switchInput: boolean
    standbyMinutes: number
  }
  // Active stream's artwork identity (its streamId) when the sink has bytes cached; the display
  // page uses it as an <img> cache-buster and only swaps the image when it changes.
  artworkId: string | null
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
  // 'restart' exits cleanly (systemd's Restart=always brings it back); 'reboot' and 'update'
  // shell out via systemd and fail without the image's polkit grants — `error` carries the
  // user-facing explanation.
  systemAction: (action: 'restart' | 'reboot' | 'update') => Promise<{ ok: boolean; error?: string }>
  forgetHost: () => Promise<void>
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
  label.check { display: flex; gap: 0.55rem; align-items: center; font-size: 0.9rem;
                padding: 0.3rem 0; cursor: pointer; }
</style>
</head>
<body>
<main>
  <h1>Astra Receiver</h1>
  <div id="pair" class="card pair-banner" style="display:none">
    <div class="muted" id="pair-host"></div>
    <div class="pin" id="pair-pin"></div>
    <div class="muted" style="text-align:center">Enter this PIN on the host to pair.</div>
    <div class="actions" id="pair-actions" style="display:none">
      <button class="primary" onclick="act('approve')">Approve pairing</button>
      <button class="danger" onclick="act('reject')">Reject</button>
    </div>
  </div>
  <div class="card">
    <div class="row"><span class="k">Status</span><span id="s-status"></span></div>
    <div class="row"><span class="k">Host</span><span id="s-host"></span></div>
    <div class="row"><span class="k">Now playing</span><span id="s-np"></span></div>
    <div class="row"><span class="k">Clock offset</span><span id="s-clock"></span></div>
    <div class="row"><span class="k">Output</span><span id="s-out"></span></div>
    <div class="row" id="s-err-row" style="display:none"><span class="k">Last error</span><span id="s-err" class="bad"></span></div>
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
  </div>
  <div class="card">
    <div class="row"><span class="k">Version</span><span id="s-ver"></span></div>
    <div class="actions" style="justify-content:flex-start; flex-wrap:wrap">
      <button onclick="systemAct('update')">Check for updates</button>
      <button onclick="systemAct('restart')">Restart receiver</button>
      <button class="danger" onclick="if(confirm('Reboot the speaker?')) systemAct('reboot')">Reboot device</button>
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
  hint.textContent = s.audioDevices.length && s.outputDevice.indexOf('ALSA ') === 0
    && s.outputDevice !== 'ALSA ' + s.configuredDevice
    ? 'Configured output unavailable — using ' + s.outputDevice
    : ''
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
    : action === 'restart' ? 'Restarting the receiver…' : 'Rebooting…'
  try {
    const res = await fetch('/api/system', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }) })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) { hint.textContent = payload.error || 'Failed.'; return }
    hint.textContent = action === 'update'
      ? 'Checking — if an update is found, the receiver restarts itself within a minute or two.'
      : action === 'restart' ? 'Restarting — back in ~15 seconds.'
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
    const pair = document.getElementById('pair')
    if (s.incomingPair) {
      pair.style.display = ''
      document.getElementById('pair-host').textContent = s.incomingPair.hostName + ' wants to pair'
      document.getElementById('pair-pin').textContent = s.incomingPair.pin
      document.getElementById('pair-actions').style.display = s.incomingPair.awaitingApproval ? '' : 'none'
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
    refreshOutput(s)
    const errRow = document.getElementById('s-err-row')
    errRow.style.display = s.lastError ? '' : 'none'
    document.getElementById('s-err').textContent = s.lastError || ''
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
  } catch { /* daemon restarting — keep polling */ }
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

function render() {
  const s = lastStatus
  const now = new Date()
  if (!s) {
    // No status yet (kiosk up before the daemon, or daemon restarting): live clock over the
    // constellation instead of a dead black screen.
    document.getElementById('idle').classList.remove('hidden')
    starsSetRunning(true)
    document.getElementById('idle-clock').textContent = fmtClockTime(now, null, null)
    document.getElementById('idle-date').textContent = fmtClockDate(now, null)
    return
  }
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
  private server: Server | null = null

  constructor(callbacks: WebStatusCallbacks) {
    this.callbacks = callbacks
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
    if (!this.server) return
    const server = this.server
    this.server = null
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'receiver'}`)
    const method = req.method ?? 'GET'
    const path = url.pathname

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
    if (method === 'POST' && path === '/api/system') {
      const body = await readJsonBody(req).catch(() => null)
      const action = (body as { action?: unknown } | null)?.action
      if (action !== 'restart' && action !== 'reboot' && action !== 'update') {
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
    toJsonResponse(res, 404, { error: 'Not found' })
  }
}
