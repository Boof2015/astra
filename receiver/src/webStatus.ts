import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import type { AlsaDeviceOption } from './output/alsaDevices'
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
  assignedSinkName: string | null
  appliedAdvanceMs: number
  volumePercent: number
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
    <div class="row" style="margin-top:0.8rem"><span class="k">Volume</span><span id="vol-label"></span></div>
    <input type="range" id="vol" min="0" max="100" step="1" onchange="saveVolume(this.value)">
    <div class="actions" id="forget-actions" style="display:none">
      <button class="danger" onclick="if(confirm('Forget the paired host?')) act('forget')">Forget host</button>
    </div>
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

    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(PAGE_HTML)
      return
    }
    if (method === 'GET' && path === '/api/status') {
      toJsonResponse(res, 200, this.callbacks.getState())
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
    if (method === 'POST' && path === '/api/forget') {
      await this.callbacks.forgetHost()
      toJsonResponse(res, 200, { ok: true })
      return
    }
    toJsonResponse(res, 404, { error: 'Not found' })
  }
}
