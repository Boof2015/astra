import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WebStatusServer,
  resolveReceiverStatusLabel,
  type WebStatusCallbacks,
  type WebStatusState
} from './webStatus.ts'

function stubState(): WebStatusState {
  return {
    sinkName: 'parallax',
    endpointUuid: 'uuid',
    paired: false,
    hostName: null,
    connected: false,
    playbackEnabled: true,
    statusLabel: 'Not paired',
    hostReachable: false,
    clockOffsetMs: null,
    rttMs: null,
    lastError: null,
    playbackState: 'stopped',
    streamTitle: null,
    streamArtist: null,
    assignedSinkName: null,
    appliedAdvanceMs: 0,
    volumePercent: 100,
    artworkId: null,
    outputDevice: 'ALSA plughw:vc4hdmi0,0',
    configuredDevice: 'plughw:vc4hdmi0,0',
    audioDevices: [
      { id: 'plughw:vc4hdmi0,0', label: 'vc4hdmi0 — vc4-hdmi' },
      { id: 'plughw:Headphones,0', label: 'Headphones — bcm2835' }
    ],
    incomingPair: null,
    diagnostics: null
  }
}

async function withServer(
  overrides: Partial<WebStatusCallbacks>,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const callbacks: WebStatusCallbacks = {
    getState: stubState,
    approvePair: () => true,
    rejectPair: () => undefined,
    setName: () => undefined,
    setVolume: () => undefined,
    setOutputDevice: () => true,
    getArtwork: () => null,
    forgetHost: async () => undefined,
    ...overrides
  }
  const server = new WebStatusServer(callbacks)
  await server.start(0)
  try {
    await run(`http://127.0.0.1:${server.port()}`)
  } finally {
    await server.stop()
  }
}

test('headless receiver distinguishes connected inactive zones from generic idle', () => {
  assert.equal(resolveReceiverStatusLabel({
    paired: true,
    connected: true,
    hostReachable: true,
    playbackEnabled: false
  }), 'Connected, not selected for playback')

  assert.equal(resolveReceiverStatusLabel({
    paired: true,
    connected: true,
    hostReachable: true,
    playbackEnabled: true
  }), 'Connected')
})

test('status payload carries the output picker fields', async () => {
  await withServer({}, async (baseUrl) => {
    const status = await (await fetch(`${baseUrl}/api/status`)).json() as WebStatusState
    assert.equal(status.configuredDevice, 'plughw:vc4hdmi0,0')
    assert.deepEqual(status.audioDevices.map((device) => device.id),
      ['plughw:vc4hdmi0,0', 'plughw:Headphones,0'])
  })
})

test('POST /api/output applies a valid device', async () => {
  const applied: string[] = []
  await withServer({
    setOutputDevice: (device) => {
      applied.push(device)
      return true
    }
  }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'plughw:Headphones,0' })
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, restarting: true })
    assert.deepEqual(applied, ['plughw:Headphones,0'])
  })
})

test('GET /display serves the kiosk page', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/display`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    const html = await res.text()
    assert.match(html, /api\/status/)
    assert.match(html, /api\/artwork/)
  })
})

test('GET /api/artwork serves cached bytes and 404s when absent', async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
  await withServer({ getArtwork: () => ({ contentType: 'image/jpeg', bytes }) }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/artwork?id=stream-1`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/jpeg')
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes)
  })
  await withServer({ getArtwork: () => null }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/artwork`)
    assert.equal(res.status, 404)
  })
})

test('POST /api/output rejects missing and unknown devices', async () => {
  await withServer({ setOutputDevice: () => false }, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/api/output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    assert.equal(missing.status, 400)
    const unknown = await fetch(`${baseUrl}/api/output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'plughw:Nope,0' })
    })
    assert.equal(unknown.status, 400)
  })
})
