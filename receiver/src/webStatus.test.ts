import assert from 'node:assert/strict'
import { Agent, get } from 'node:http'
import test from 'node:test'
import {
  WebStatusServer,
  isLoopbackAddress,
  resolveReceiverStatusLabel,
  type WebStatusCallbacks,
  type WebStatusServerOptions,
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
    streamAlbum: null,
    position: null,
    assignedSinkName: null,
    appliedAdvanceMs: 0,
    volumePercent: 100,
    timezone: 'UTC',
    clockFormat: 'auto',
    version: 'v0.3.0',
    updating: false,
    transportSupported: null,
    cec: { available: true, control: true, wakeOn: 'play', switchInput: true, standbyMinutes: 10, lastKey: null },
    artworkId: null,
    audioAvailable: true,
    audioError: null,
    outputDevice: 'ALSA plughw:vc4hdmi0,0',
    configuredDevice: 'plughw:vc4hdmi0,0',
    audioDevices: [
      { id: 'plughw:vc4hdmi0,0', label: 'vc4hdmi0 — vc4-hdmi' },
      { id: 'plughw:Headphones,0', label: 'Headphones — bcm2835' }
    ],
    incomingPair: null,
    setup: null,
    diagnostics: null
  }
}

async function withServer(
  overrides: Partial<WebStatusCallbacks>,
  run: (baseUrl: string, server: WebStatusServer) => Promise<void>,
  options: WebStatusServerOptions = {}
): Promise<void> {
  const callbacks: WebStatusCallbacks = {
    getState: stubState,
    approvePair: () => true,
    rejectPair: () => undefined,
    setName: () => undefined,
    setVolume: () => undefined,
    setOutputDevice: () => true,
    getArtwork: () => null,
    getSetupNetworks: async () => [],
    applySetupCredentials: () => true,
    getTimezones: async () => [],
    setTimezone: async () => true,
    setCecSettings: () => undefined,
    setClockFormat: () => undefined,
    sendTransport: async () => 'ok',
    systemAction: async () => ({ ok: true }),
    forgetHost: async () => undefined,
    ...overrides
  }
  const server = new WebStatusServer(callbacks, options)
  await server.start(0)
  try {
    await run(`http://127.0.0.1:${server.port()}`, server)
  } finally {
    await server.stop()
  }
}

test('loopback address detection handles IPv4, IPv6, and mapped peers', () => {
  for (const address of [
    '127.0.0.1',
    '127.42.0.9',
    '::1',
    '::ffff:127.0.0.1'
  ]) {
    assert.equal(isLoopbackAddress(address), true, address)
  }

  for (const address of [
    '192.168.1.20',
    '::ffff:192.168.1.20',
    'fe80::1',
    'not-an-address',
    undefined
  ]) {
    assert.equal(isLoopbackAddress(address), false, String(address))
  }
})

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
    assert.equal(status.audioAvailable, true)
    assert.equal(status.audioError, null)
    assert.equal(status.configuredDevice, 'plughw:vc4hdmi0,0')
    assert.deepEqual(status.audioDevices.map((device) => device.id),
      ['plughw:vc4hdmi0,0', 'plughw:Headphones,0'])
  })
})

test('status payload distinguishes fallback, intentional null, and exhausted ALSA', async () => {
  let state = stubState()
  await withServer({ getState: () => state }, async (baseUrl) => {
    state = {
      ...stubState(),
      outputDevice: 'ALSA default',
      configuredDevice: 'plughw:Missing,0'
    }
    let status = await (await fetch(`${baseUrl}/api/status`)).json() as WebStatusState
    assert.equal(status.audioAvailable, true)
    assert.equal(status.audioError, null)
    assert.equal(status.outputDevice, 'ALSA default')
    assert.equal(status.configuredDevice, 'plughw:Missing,0')

    state = {
      ...stubState(),
      audioAvailable: false,
      audioError: null,
      outputDevice: 'Null output (no audio)'
    }
    status = await (await fetch(`${baseUrl}/api/status`)).json() as WebStatusState
    assert.equal(status.audioAvailable, false)
    assert.equal(status.audioError, null)

    state = {
      ...stubState(),
      audioAvailable: false,
      audioError: 'No ALSA output device could be opened.',
      outputDevice: 'Null output (no audio)',
      configuredDevice: 'plughw:Missing,0'
    }
    status = await (await fetch(`${baseUrl}/api/status`)).json() as WebStatusState
    assert.equal(status.audioAvailable, false)
    assert.match(status.audioError ?? '', /No ALSA output device/)
    assert.equal(status.outputDevice, 'Null output (no audio)')
    assert.equal(status.configuredDevice, 'plughw:Missing,0')
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
    // The page script lives in a TS template literal where an escaping slip is easy — make
    // sure what we serve is at least syntactically valid JS (compile, don't run).
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)
    assert.ok(script, 'display page has an inline script')
    assert.doesNotThrow(() => new Function(script[1]))
  })
})

test('GET /display permits IPv6 and IPv4-mapped loopback peers', async () => {
  for (const address of ['::1', '::ffff:127.0.0.1']) {
    await withServer({}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/display`)
      assert.equal(res.status, 200, address)
      assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    }, { getPeerAddress: () => address })
  }
})

test('remote /display is an unknown route and forwarding headers are ignored', async () => {
  let approved = 0
  await withServer({
    approvePair: () => { approved += 1; return true }
  }, async (baseUrl) => {
    const display = await fetch(`${baseUrl}/display`, {
      headers: {
        Forwarded: 'for=127.0.0.1',
        'X-Forwarded-For': '127.0.0.1'
      }
    })
    const unknown = await fetch(`${baseUrl}/does-not-exist`)
    assert.equal(display.status, 404)
    assert.equal(unknown.status, 404)
    assert.equal(display.headers.get('content-type'), unknown.headers.get('content-type'))
    const displayBody = await display.json()
    const unknownBody = await unknown.json()
    assert.deepEqual(displayBody, { error: 'Not found' })
    assert.deepEqual(displayBody, unknownBody)

    assert.equal((await fetch(`${baseUrl}/`)).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/status`)).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/approve`, { method: 'POST' })).status, 200)
    assert.equal(approved, 1)
  }, { getPeerAddress: () => '192.168.1.20' })
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

function setupState(overrides: Partial<NonNullable<WebStatusState['setup']>> = {}): WebStatusState {
  return {
    ...stubState(),
    setup: {
      apActive: false, apSsid: 'Parallax-Setup', connecting: false, lastError: null,
      apEtaSeconds: null, ...overrides
    }
  }
}

test('setup routes 404 when the feature is off', async () => {
  await withServer({}, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/setup/networks`)).status, 404)
    assert.equal((await fetch(`${baseUrl}/api/setup/connect`, { method: 'POST' })).status, 404)
  })
})

test('setup routes serve networks and accept credentials when enabled', async () => {
  const applied: string[][] = []
  await withServer({
    getState: () => setupState(),
    getSetupNetworks: async () => [{ ssid: 'HomeNet', signal: 80, secured: true }],
    applySetupCredentials: (ssid, password) => {
      applied.push([ssid, password])
      return true
    }
  }, async (baseUrl) => {
    const networks = await (await fetch(`${baseUrl}/api/setup/networks`)).json() as { networks: unknown[] }
    assert.equal((networks.networks[0] as { ssid: string }).ssid, 'HomeNet')
    const res = await fetch(`${baseUrl}/api/setup/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid: 'HomeNet', password: 'hunter22' })
    })
    assert.equal(res.status, 200)
    assert.deepEqual(applied, [['HomeNet', 'hunter22']])
    const missing = await fetch(`${baseUrl}/api/setup/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'x' })
    })
    assert.equal(missing.status, 400)
  })
})

test('captive redirect fires only while the AP is hosted and spares the portal + APIs', async () => {
  await withServer({ getState: () => setupState({ apActive: true }) }, async (baseUrl) => {
    // A phone's connectivity probe (foreign Host) gets pushed to the portal.
    const probe = await fetch(`${baseUrl}/generate_204`, {
      headers: { Host: 'connectivitycheck.gstatic.com' },
      redirect: 'manual'
    })
    assert.equal(probe.status, 302)
    assert.equal(probe.headers.get('location'), 'http://10.42.0.1/setup')
    // The portal itself and API calls are never redirected.
    assert.equal((await fetch(`${baseUrl}/setup`, { redirect: 'manual' })).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/status`, { redirect: 'manual' })).status, 200)
  })
  await withServer({ getState: () => setupState({ apActive: false }) }, async (baseUrl) => {
    const normal = await fetch(`${baseUrl}/`, { redirect: 'manual' })
    assert.equal(normal.status, 200, 'no redirect while the AP is down')
  })
})

test('timezone routes list zones and validate on set', async () => {
  const applied: string[] = []
  await withServer({
    getTimezones: async () => ['UTC', 'America/New_York'],
    setTimezone: async (timezone) => {
      applied.push(timezone)
      return timezone === 'America/New_York'
    }
  }, async (baseUrl) => {
    const zones = await (await fetch(`${baseUrl}/api/timezones`)).json() as { timezones: string[] }
    assert.deepEqual(zones.timezones, ['UTC', 'America/New_York'])
    const good = await fetch(`${baseUrl}/api/timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: 'America/New_York' })
    })
    assert.equal(good.status, 200)
    const bad = await fetch(`${baseUrl}/api/timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: 'Nope/Nowhere' })
    })
    assert.equal(bad.status, 400)
    assert.deepEqual(applied, ['America/New_York', 'Nope/Nowhere'])
  })
})

test('the status page script survives the template-literal escaping too', async () => {
  await withServer({}, async (baseUrl) => {
    const html = await (await fetch(`${baseUrl}/`)).text()
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)
    assert.ok(script, 'status page has an inline script')
    assert.doesNotThrow(() => new Function(script[1]))
  })
})

test('management and display pages expose degraded-audio recovery without hiding controls', async () => {
  await withServer({
    getState: () => ({
      ...stubState(),
      audioAvailable: false,
      audioError: 'No ALSA output device could be opened.',
      outputDevice: 'Null output (no audio)',
      configuredDevice: 'plughw:Missing,0',
      setup: {
        apActive: false,
        apSsid: 'Parallax-Setup',
        connecting: false,
        lastError: null,
        apEtaSeconds: null
      }
    })
  }, async (baseUrl) => {
    const management = await (await fetch(`${baseUrl}/`)).text()
    assert.match(management, /id="audio-degraded"/)
    assert.match(management, /Audio unavailable/)
    assert.match(management, /No ALSA outputs are currently detected/)
    assert.match(management, /Null output is configured intentionally/)
    assert.match(management, /s\.audioAvailable/)
    assert.match(management, /s\.audioError/)
    for (const required of [
      'api/output', 'Approve pairing', 'Reset Wi-Fi', 'systemAct', 'Forget host', 'diag-card'
    ]) assert.match(management, new RegExp(required))
    assert.equal((await fetch(`${baseUrl}/setup`)).status, 200)

    const display = await (await fetch(`${baseUrl}/display`)).text()
    assert.match(display, /id="audio-pill"/)
    assert.match(display, /Audio error/)
    assert.match(display, /openOutputList/)
    assert.match(display, /s\.audioError/)
    const script = /<script>([\s\S]*?)<\/script>/.exec(display)
    assert.ok(script)
    assert.doesNotThrow(() => new Function(script[1]))
  })
})

test('root pairing controls explain and provide the fallback when CEC is unavailable', async () => {
  let approved = 0
  let rejected = 0
  await withServer({
    getState: () => ({
      ...stubState(),
      cec: { ...stubState().cec, available: false },
      incomingPair: {
        pin: '123456',
        hostName: 'Test Host',
        awaitingApproval: true,
        expiresAtMs: Date.now() + 30_000
      }
    }),
    approvePair: () => { approved += 1; return true },
    rejectPair: () => { rejected += 1 }
  }, async (baseUrl) => {
    const html = await (await fetch(`${baseUrl}/`)).text()
    assert.match(html, /Approve or reject here\. A TV remote and HDMI-CEC are optional\./)

    const status = await (await fetch(`${baseUrl}/api/status`)).json() as WebStatusState
    assert.equal(status.cec.available, false)

    const approve = await fetch(`${baseUrl}/api/approve`, { method: 'POST' })
    assert.equal(approve.status, 200)
    assert.deepEqual(await approve.json(), { ok: true })

    const reject = await fetch(`${baseUrl}/api/reject`, { method: 'POST' })
    assert.equal(reject.status, 200)
    assert.deepEqual(await reject.json(), { ok: true })
    assert.equal(approved, 1)
    assert.equal(rejected, 1)
  })
})

test('POST /api/cec validates and forwards the settings', async () => {
  const applied: unknown[] = []
  await withServer({ setCecSettings: (settings) => { applied.push(settings) } }, async (baseUrl) => {
    const good = await fetch(`${baseUrl}/api/cec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ control: true, wakeOn: 'connect', switchInput: false, standbyMinutes: 0 })
    })
    assert.equal(good.status, 200)
    assert.deepEqual(applied, [{ control: true, wakeOn: 'connect', switchInput: false, standbyMinutes: 0 }])
    for (const bad of [
      { control: true, wakeOn: 'sometimes', switchInput: true, standbyMinutes: 10 },
      { control: true, wakeOn: 'play', switchInput: true, standbyMinutes: -1 },
      { control: true, wakeOn: 'play', switchInput: true, standbyMinutes: 2.5 }
    ]) {
      const res = await fetch(`${baseUrl}/api/cec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bad)
      })
      assert.equal(res.status, 400, JSON.stringify(bad))
    }
    assert.equal(applied.length, 1, 'invalid settings must never reach the callback')
  })
})

test('POST /api/clock-format accepts the three formats only', async () => {
  const applied: string[] = []
  await withServer({ setClockFormat: (format) => { applied.push(format) } }, async (baseUrl) => {
    for (const format of ['auto', '12', '24']) {
      const res = await fetch(`${baseUrl}/api/clock-format`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format })
      })
      assert.equal(res.status, 200)
    }
    const bad = await fetch(`${baseUrl}/api/clock-format`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: '13' })
    })
    assert.equal(bad.status, 400)
    assert.deepEqual(applied, ['auto', '12', '24'])
  })
})

test('/api/keys streams pushed TV-remote keys as SSE', async () => {
  await withServer({}, async (baseUrl, server) => {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/api/keys`, { signal: controller.signal })
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    const reader = res.body!.getReader()
    server.pushRemoteKey('Enter', 'select')
    const decoder = new TextDecoder()
    let buffer = ''
    while (!buffer.includes('data:')) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value)
    }
    assert.match(buffer, /data: \{"key":"Enter","raw":"select"\}/)
    controller.abort()
  })
})

test('stop closes active status-key SSE and keep-alive connections', async () => {
  const agent = new Agent({ keepAlive: true })
  try {
    await withServer({}, async (baseUrl, server) => {
      const sse = await fetch(`${baseUrl}/api/keys`)
      const reader = sse.body!.getReader()
      const connected = await reader.read()
      assert.equal(connected.done, false)

      await new Promise<void>((resolve, reject) => {
        const request = get(`${baseUrl}/api/status`, { agent }, (response) => {
          response.resume()
          response.once('end', resolve)
        })
        request.once('error', reject)
      })
      const keepAliveSockets = Object.values(agent.freeSockets).flat()
        .filter((socket) => socket !== undefined)
      assert.equal(keepAliveSockets.length > 0, true)

      await server.stop()
      const closed = await reader.read()
      assert.equal(closed.done, true)
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(keepAliveSockets.every((socket) => socket.destroyed), true)
    })
  } finally {
    agent.destroy()
  }
})

test('POST /api/transport validates commands and maps sink-client results', async () => {
  const sent: string[] = []
  await withServer({
    sendTransport: async (command) => {
      sent.push(command)
      return command === 'next' ? 'unsupported' : command === 'previous' ? 'failed' : 'ok'
    }
  }, async (baseUrl) => {
    const post = (command: unknown) => fetch(`${baseUrl}/api/transport`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command })
    })
    assert.equal((await post('toggle-play')).status, 200)
    assert.equal((await post('next')).status, 404)
    assert.equal((await post('previous')).status, 502)
    assert.equal((await post('eject')).status, 400)
    assert.deepEqual(sent, ['toggle-play', 'next', 'previous'])
  })
})

test('POST /api/system forwards actions and maps failures to 500', async () => {
  const actions: string[] = []
  await withServer({
    systemAction: async (action) => {
      actions.push(action)
      return action === 'reboot' ? { ok: false, error: 'Reboot is not permitted on this system.' } : { ok: true }
    }
  }, async (baseUrl) => {
    const post = (action: string) => fetch(`${baseUrl}/api/system`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    })
    assert.equal((await post('restart')).status, 200)
    assert.equal((await post('update')).status, 200)
    assert.equal((await post('reset-wifi')).status, 200)
    assert.equal((await post('factory-reset')).status, 200)
    const denied = await post('reboot')
    assert.equal(denied.status, 500)
    assert.match(((await denied.json()) as { error: string }).error, /not permitted/)
    assert.equal((await post('format-c')).status, 400)
    assert.deepEqual(actions, ['restart', 'update', 'reset-wifi', 'factory-reset', 'reboot'])
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
