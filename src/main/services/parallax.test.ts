import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { ParallaxService } from './parallax.ts'
import type { ParallaxHostConfig, ParallaxPairResponse } from '../../types/parallax.ts'
import { decodeParallaxAudioPacket } from '../../types/parallax.ts'

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function listenHttpServer(server: HttpServer, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 1_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition.')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function createStartedParallaxService(): Promise<{ service: ParallaxService; port: number; baseUrl: string }> {
  const port = await getFreePort()
  const config: ParallaxHostConfig = { enabled: true, port }
  const service = new ParallaxService({ config: { enabled: false, port }, pairedSinks: [] })
  await service.applyHostConfig(config)
  return {
    service,
    port,
    baseUrl: `http://127.0.0.1:${port}`
  }
}

async function tryCreateStartedParallaxService(): Promise<{ service: ParallaxService; port: number; baseUrl: string } | null> {
  try {
    return await createStartedParallaxService()
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      return null
    }
    throw error
  }
}

async function pairSink(service: ParallaxService, baseUrl: string, sinkName: string = 'Desk'): Promise<ParallaxPairResponse> {
  const pin = service.createPairingPin()
  const pairedResponse = await fetch(`${baseUrl}/v1/parallax/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: pin.pin, sinkName })
  })
  assert.equal(pairedResponse.status, 200)
  return await pairedResponse.json() as ParallaxPairResponse
}

async function readParallaxSseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number
): Promise<Array<{ type: string; stream?: { streamId: string } }>> {
  const decoder = new TextDecoder()
  const events: Array<{ type: string; stream?: { streamId: string } }> = []
  let buffer = ''

  for (let attempt = 0; attempt < 16 && events.length < count; attempt += 1) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const dataLine = rawEvent.split(/\r?\n/).find((line) => line.startsWith('data: '))
      if (dataLine) {
        events.push(JSON.parse(dataLine.slice('data: '.length)) as { type: string; stream?: { streamId: string } })
      }
      boundary = buffer.indexOf('\n\n')
    }
  }

  return events
}

test('Parallax host pairs sinks with an active PIN and requires bearer auth for join', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  try {
    const pin = service.createPairingPin()
    const rejected = await fetch(`${baseUrl}/v1/parallax/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '000000', sinkName: 'Kitchen' })
    })
    assert.equal(rejected.status, 403)

    const pairedResponse = await fetch(`${baseUrl}/v1/parallax/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: pin.pin, sinkName: 'Kitchen' })
    })
    assert.equal(pairedResponse.status, 200)
    const paired = await pairedResponse.json() as ParallaxPairResponse
    assert.ok(paired.sinkId)
    assert.ok(paired.token)
    assert.equal(service.listPairedSinks().length, 1)

    const unauthorizedJoin = await fetch(`${baseUrl}/v1/parallax/join`, { method: 'POST' })
    assert.equal(unauthorizedJoin.status, 401)

    const authorizedJoin = await fetch(`${baseUrl}/v1/parallax/join`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${paired.token}` }
    })
    assert.equal(authorizedJoin.status, 200)
  } finally {
    await service.stop()
  }
})

test('Parallax sink forget revokes host pairing and removes connected presence', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  const eventsAbort = new AbortController()
  let eventsResponse: Response | null = null
  try {
    const paired = await pairSink(service, baseUrl, 'Office')
    eventsResponse = await fetch(`${baseUrl}/v1/parallax/events`, {
      headers: { Authorization: `Bearer ${paired.token}` },
      signal: eventsAbort.signal
    })
    assert.equal(eventsResponse.status, 200)
    await waitFor(() => {
      const status = service.getStatus()
      return status.host.connectedSinkCount === 1
        && status.host.connectedSinks.some((sink) => sink.sinkId === paired.sinkId && sink.online)
    })

    const forgot = await fetch(`${baseUrl}/v1/parallax/sink/forget`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${paired.token}` }
    })
    assert.equal(forgot.status, 200)

    await waitFor(() => {
      const status = service.getStatus()
      return status.host.pairedSinkCount === 0
        && status.host.connectedSinkCount === 0
        && !status.host.connectedSinks.some((sink) => sink.sinkId === paired.sinkId)
    })
    const hostRow = service.listPairedSinks().find((sink) => sink.id === paired.sinkId)
    assert.ok(hostRow?.revokedAt, 'host-side row should be retired by sink forget')
  } finally {
    eventsAbort.abort()
    await eventsResponse?.body?.cancel().catch(() => undefined)
    await service.stop()
  }
})

test('Parallax host presence cache can be cleared without removing pairing credentials', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  const eventsAbort = new AbortController()
  let eventsResponse: Response | null = null
  try {
    const paired = await pairSink(service, baseUrl, 'Office')
    eventsResponse = await fetch(`${baseUrl}/v1/parallax/events`, {
      headers: { Authorization: `Bearer ${paired.token}` },
      signal: eventsAbort.signal
    })
    assert.equal(eventsResponse.status, 200)
    await waitFor(() => service.getStatus().host.connectedSinks.some((sink) => sink.sinkId === paired.sinkId))

    const cleared = service.clearHostPresenceCache(paired.sinkId)
    assert.equal(cleared.host.connectedSinks.some((sink) => sink.sinkId === paired.sinkId), false)
    assert.equal(service.listPairedSinks().some((sink) => sink.id === paired.sinkId && sink.revokedAt === null), true)
  } finally {
    eventsAbort.abort()
    await eventsResponse?.body?.cancel().catch(() => undefined)
    await service.stop()
  }
})

test('Parallax host renames paired sink and updates connected status', async (t) => {
  let port: number
  try {
    port = await getFreePort()
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      t.skip('Local socket binding is blocked in this environment.')
      return
    }
    throw error
  }
  const config: ParallaxHostConfig = { enabled: true, port }
  let persistedNames: string[] = []
  const service = new ParallaxService({
    config: { enabled: false, port },
    pairedSinks: [],
    onPairedSinksChange: (sinks) => {
      persistedNames = sinks.map((sink) => sink.name)
    }
  })
  try {
    try {
      await service.applyHostConfig(config)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
        t.skip('Local socket binding is blocked in this environment.')
        return
      }
      throw error
    }

    const baseUrl = `http://127.0.0.1:${port}`
    const paired = await pairSink(service, baseUrl, 'Desk')
    const eventsAbort = new AbortController()
    const eventsResponse = await fetch(`${baseUrl}/v1/parallax/events`, {
      headers: { Authorization: `Bearer ${paired.token}` },
      signal: eventsAbort.signal
    })
    assert.equal(eventsResponse.status, 200)
    try {
      await waitFor(() => service.getStatus().host.connectedSinks.some((sink) => sink.sinkId === paired.sinkId))

      const renamed = service.renamePairedSink(paired.sinkId, '  Living    Room   Sink  ')
      assert.equal(renamed?.name, 'Living Room Sink')
      assert.equal(service.listPairedSinks().find((sink) => sink.id === paired.sinkId)?.name, 'Living Room Sink')
      assert.equal(service.getStatus().host.connectedSinks.find((sink) => sink.sinkId === paired.sinkId)?.name, 'Living Room Sink')
      assert.equal(persistedNames[0], 'Living Room Sink')

      const capped = service.renamePairedSink(paired.sinkId, ` ${'A'.repeat(90)} `)
      assert.equal(capped?.name, 'A'.repeat(80))
      assert.equal(service.getStatus().host.connectedSinks.find((sink) => sink.sinkId === paired.sinkId)?.name, 'A'.repeat(80))
    } finally {
      eventsAbort.abort()
      await eventsResponse.body?.cancel().catch(() => undefined)
    }
  } finally {
    await service.stop()
  }
})

test('Parallax host rename returns null for missing or revoked sinks', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  try {
    assert.equal(service.renamePairedSink('missing', 'Desk'), null)

    const paired = await pairSink(service, baseUrl, 'Desk')
    assert.ok(service.revokePairedSink(paired.sinkId))
    assert.equal(service.renamePairedSink(paired.sinkId, 'Renamed'), null)
  } finally {
    await service.stop()
  }
})

test('Parallax host telemetry exposes connected sink RTT and preserves output trim state', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  try {
    const paired = await pairSink(service, baseUrl, 'Desk')
    service.setSinkTrim(paired.sinkId, 'speaker-default', 'Desk DAC', 15)

    const telemetry = await fetch(`${baseUrl}/v1/parallax/telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${paired.token}`
      },
      body: JSON.stringify({
        streamId: null,
        bufferedMs: 500,
        driftFrames: 0,
        rttMs: 27.4,
        underruns: 0,
        playbackRatePpm: 0,
        reportedAtMs: Date.now(),
        outputDeviceId: 'speaker-default',
        outputDeviceLabel: 'Desk DAC',
        appliedAdvanceMs: 15
      })
    })
    assert.equal(telemetry.status, 200)

    const row = service.getStatus().host.connectedSinks.find((sink) => sink.sinkId === paired.sinkId)
    assert.ok(row)
    assert.equal(row.rttMs, 27.4)
    assert.equal(row.outputDeviceId, 'speaker-default')
    assert.equal(row.outputDeviceLabel, 'Desk DAC')
    assert.equal(row.appliedAdvanceMs, 15)
    assert.equal(
      service.listPairedSinks()
        .find((sink) => sink.id === paired.sinkId)
        ?.trims?.find((trim) => trim.outputDeviceId === 'speaker-default')
        ?.advanceMs,
      15
    )
  } finally {
    await service.stop()
  }
})

test('Parallax pairing PIN expires', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  const originalNow = Date.now
  try {
    const pin = service.createPairingPin()
    Date.now = () => pin.expiresAt + 1
    const response = await fetch(`${baseUrl}/v1/parallax/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: pin.pin, sinkName: 'Desk' })
    })
    assert.equal(response.status, 409)
  } finally {
    Date.now = originalNow
    await service.stop()
  }
})

test('Parallax audio endpoint streams timestamped PCM packets', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  try {
    const paired = await pairSink(service, baseUrl)

    const timeline = service.publishHostStreamStart({
      streamId: 'stream-audio-test',
      trackId: 'track-audio-test',
      trackPath: '/tmp/audio-test.flac',
      title: 'Audio Test',
      artist: 'Astra',
      album: 'Parallax',
      sampleRate: 48000,
      channels: 2,
      durationSeconds: 1,
      totalFrames: 48000
    })

    const pcm = new Float32Array([0.25, -0.25, 0.5, -0.5])
    service.publishHostAudioChunk({
      streamId: 'stream-audio-test',
      sampleRate: 48000,
      channels: 2,
      startFrame: 0,
      frameCount: 2,
      hostTimeMs: timeline.startHostTimeMs,
      pcmData: pcm.buffer
    })

    const response = await fetch(`${baseUrl}/v1/parallax/audio?streamId=stream-audio-test&fromFrame=0`, {
      headers: { Authorization: `Bearer ${paired.token}` }
    })
    assert.equal(response.status, 200)
    assert.ok(response.body)

    const reader = response.body.getReader()
    const pendingChunks: Uint8Array[] = []
    let pendingBytes = 0
    let decoded: ReturnType<typeof decodeParallaxAudioPacket> = null
    try {
      for (let attempt = 0; attempt < 4 && !decoded; attempt += 1) {
        const { done, value } = await reader.read()
        assert.equal(done, false)
        assert.ok(value)
        pendingChunks.push(value)
        pendingBytes += value.byteLength
        const pending = new Uint8Array(pendingBytes)
        let offset = 0
        for (const chunk of pendingChunks) {
          pending.set(chunk, offset)
          offset += chunk.byteLength
        }
        decoded = decodeParallaxAudioPacket(pending)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }

    assert.ok(decoded)
    assert.equal(decoded.chunk.sampleRate, 48000)
    assert.equal(decoded.chunk.channels, 2)
    assert.equal(decoded.chunk.startFrame, 0)
    assert.equal(decoded.chunk.frameCount, 2)
    assert.equal(decoded.chunk.hostTimeMs, timeline.startHostTimeMs)
    assert.deepEqual(Array.from(new Float32Array(decoded.chunk.pcmData)), Array.from(pcm))
  } finally {
    await service.stop()
  }
})

test('Parallax events endpoint delivers consecutive stream-start metadata updates', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  try {
    const paired = await pairSink(service, baseUrl)
    const response = await fetch(`${baseUrl}/v1/parallax/events`, {
      headers: { Authorization: `Bearer ${paired.token}` }
    })
    assert.equal(response.status, 200)
    assert.ok(response.body)
    const reader = response.body.getReader()
    try {
      await new Promise((resolve) => setTimeout(resolve, 10))
      service.publishHostStreamStart({
        streamId: 'stream-one',
        trackId: 'track-one',
        trackPath: '/tmp/one.flac',
        title: 'One',
        artist: 'Astra',
        album: 'Parallax',
        sampleRate: 48000,
        channels: 2,
        durationSeconds: 1,
        totalFrames: 48000
      })
      service.publishHostStreamStart({
        streamId: 'stream-two',
        trackId: 'track-two',
        trackPath: '/tmp/two.flac',
        title: 'Two',
        artist: 'Astra',
        album: 'Parallax',
        sampleRate: 48000,
        channels: 2,
        durationSeconds: 1,
        totalFrames: 48000
      })

      const events = await readParallaxSseEvents(reader, 2)
      assert.deepEqual(
        events.filter((event) => event.type === 'stream-start').map((event) => event.stream?.streamId),
        ['stream-one', 'stream-two']
      )
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  } finally {
    await service.stop()
  }
})

test('Parallax sink auto-rejoins after an event stream failure', async () => {
  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  let joinCount = 0
  let eventRequestCount = 0
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', baseUrl)
    if (req.method === 'POST' && url.pathname === '/v1/parallax/join') {
      joinCount += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        sinkId: 'sink-retry',
        groupLatencyMs: 1000,
        hostTimeMs: Date.now(),
        stream: null,
        timeline: null
      }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/parallax/clock') {
      const now = Date.now()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        sinkSentAtMs: now,
        hostReceivedAtMs: now,
        hostSentAtMs: now
      }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/parallax/events') {
      eventRequestCount += 1
      if (eventRequestCount === 1) {
        res.writeHead(503, { 'Content-Type': 'text/plain' })
        res.end('offline')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache'
      })
      res.write(': connected\n\n')
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })
  await listenHttpServer(server, port)

  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    return originalSetTimeout(handler, timeout === 2_000 ? 0 : timeout, ...args)
  }) as typeof setTimeout

  const sinkService = new ParallaxService({ config: { enabled: false, port }, pairedSinks: [] })
  try {
    await sinkService.connectSink({
      baseUrl,
      sinkId: 'sink-retry',
      token: 'token'
    })
    await waitFor(() => joinCount >= 2 && eventRequestCount >= 2 && sinkService.getStatus().sink.lastError === null)
    assert.equal(sinkService.getStatus().sink.connected, true)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    await sinkService.stop()
    await closeHttpServer(server)
  }
})

// ============================================================================================
// §20 Commit 3 — sink listener + host-side pair flow. Codex 'tests early' list:
//   1. pair-request creates PIN; no token persisted yet.
//   2. wrong PIN never activates host candidate.
//   3. success persists sink credential AND activates host paired sink.
//   4. busy: second pair-request returns 409 while pending.
//   5. expiry: pair-confirm after TTL returns 410.
//   6. 3-fail lockout: 3 wrong PINs → next pair-confirm returns 404 (pending cleared).
// ============================================================================================

import { ParallaxSinkListener, type ParallaxSinkListenerPairedInfo } from './parallaxSinkListener.ts'

interface PairFixture {
  listener: ParallaxSinkListener
  port: number
  sinkBaseUrl: string
  host: ParallaxService
  hostPort: number
  paired: ParallaxSinkListenerPairedInfo[]
  incoming: Array<unknown>
  endpointUuid: string
}

async function createPairFixture(overrides: { sinkName?: string; hasPersisted?: boolean; pinTtlMs?: number } = {}): Promise<PairFixture> {
  const sinkPort = await getFreePort()
  const hostPort = await getFreePort()
  const paired: ParallaxSinkListenerPairedInfo[] = []
  const incoming: Array<unknown> = []
  const endpointUuid = '11111111-2222-3333-4444-555555555555'
  const listener = new ParallaxSinkListener({
    getEndpointUuid: () => endpointUuid,
    getSinkName: () => overrides.sinkName ?? 'Test Sink',
    getHasPersistedConnection: () => overrides.hasPersisted ?? false,
    onPaired: async (info) => { paired.push(info) },
    onIncomingPairChange: (state) => { incoming.push(state) }
  }, { pinTtlMs: overrides.pinTtlMs })
  await listener.start(sinkPort)

  const host = new ParallaxService({
    config: { enabled: true, port: hostPort },
    pairedSinks: [],
    getHostDisplayName: () => 'Test Host',
    getEndpointUuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  })
  await host.applyHostConfig({ enabled: true, port: hostPort })

  return {
    listener,
    port: sinkPort,
    sinkBaseUrl: `http://127.0.0.1:${sinkPort}`,
    host,
    hostPort,
    paired,
    incoming,
    endpointUuid
  }
}

async function destroyPairFixture(fixture: PairFixture): Promise<void> {
  await fixture.listener.stop()
  await fixture.host.stop()
}

async function postJson(url: string, body: unknown): Promise<{ status: number; payload: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const payload = await response.json().catch(() => null)
  return { status: response.status, payload }
}

test('§20 pair-request creates PIN on sink; no token stored', async () => {
  const fixture = await createPairFixture()
  try {
    const initiate = await fixture.host.initiatePair(fixture.sinkBaseUrl)
    assert.equal(typeof initiate.pairingId, 'string')
    assert.equal(initiate.expiresInSeconds > 0, true)

    // Host has staged a candidate but it is NOT yet in pairedSinks.
    const status = fixture.host.getStatus()
    assert.equal(status.host.pairedSinkCount, 0)
    const pending = fixture.host.getPendingPairSnapshot(initiate.pairingId)
    assert.ok(pending)

    // Sink has shown a PIN and the incoming-pair callback has fired.
    const lastIncoming = fixture.incoming.at(-1) as { pin?: string } | null
    assert.ok(lastIncoming, 'sink should have emitted an incoming-pair state')
    assert.equal(typeof lastIncoming!.pin, 'string')
    assert.equal((lastIncoming!.pin as string).length, 6)

    // Sink did NOT receive a token in the pair-request.
    assert.equal(fixture.paired.length, 0, 'pair-request must not persist credentials')
  } finally {
    await destroyPairFixture(fixture)
  }
})

test('§20 pair-confirm wrong PIN never activates host candidate', async () => {
  const fixture = await createPairFixture()
  try {
    const initiate = await fixture.host.initiatePair(fixture.sinkBaseUrl)
    await assert.rejects(
      fixture.host.submitPairPin(initiate.pairingId, '000000'),
      (error: any) => error?.status === 401
    )
    assert.equal(fixture.paired.length, 0, 'sink must not persist on wrong PIN')
    const status = fixture.host.getStatus()
    assert.equal(status.host.pairedSinkCount, 0, 'host must not activate candidate on wrong PIN')
    // Candidate still present (only 1 of 3 fails consumed).
    const pending = fixture.host.getPendingPairSnapshot(initiate.pairingId)
    assert.ok(pending)
  } finally {
    await destroyPairFixture(fixture)
  }
})

test('§20 pair-confirm success persists sink credential AND activates host paired sink', async () => {
  const fixture = await createPairFixture()
  try {
    const initiate = await fixture.host.initiatePair(fixture.sinkBaseUrl)
    const lastIncoming = fixture.incoming.at(-1) as { pin: string }
    const submitted = await fixture.host.submitPairPin(initiate.pairingId, lastIncoming.pin, 'Studio Desk')
    assert.equal(typeof submitted.sinkId, 'string')
    assert.equal(submitted.sinkName, 'Studio Desk')

    // Sink persisted via onPaired callback.
    assert.equal(fixture.paired.length, 1)
    const persistedInfo = fixture.paired[0]
    assert.equal(persistedInfo.sinkId, submitted.sinkId)
    assert.equal(typeof persistedInfo.token, 'string')
    assert.equal(persistedInfo.token.length > 0, true)
    assert.equal(persistedInfo.hostName, 'Test Host')
    // Host URL derived from socket remote address — must be 127.0.0.1, NOT 0.0.0.0.
    assert.match(persistedInfo.hostUrl, /^http:\/\/127\.0\.0\.1:\d+$/)

    // Host activated the candidate into pairedSinks.
    const status = fixture.host.getStatus()
    assert.equal(status.host.pairedSinkCount, 1)
    assert.equal(fixture.host.getPendingPairSnapshot(initiate.pairingId), null)
  } finally {
    await destroyPairFixture(fixture)
  }
})

test('§20 / Pillar 4 a repeat pair-request from the same host supersedes the pending PIN', async () => {
  const fixture = await createPairFixture()
  try {
    await fixture.host.initiatePair(fixture.sinkBaseUrl)
    // Same host (same loopback remote address) sending a fresh pair-request means its previous
    // attempt died — it crashed / restarted / slept mid-pair — and is retrying. The sink supersedes
    // the stale pending and issues a new PIN instead of wedging on 409 "busy", so the user never has
    // to manually reset the speaker to re-pair (Pillar 4). A genuinely *different* host (different
    // remote IP) still gets 409; that path can't be exercised over loopback here.
    const second = await postJson(`${fixture.sinkBaseUrl}/v1/parallax/pair-request`, {
      pairingId: 'second',
      hostName: 'Same Host Retry',
      hostPort: fixture.hostPort,
      parallaxEndpointUuid: 'second-uuid'
    })
    assert.equal(second.status, 200)
    assert.equal(typeof second.payload?.sinkName, 'string')
    assert.equal(typeof second.payload?.expiresInSeconds, 'number')
  } finally {
    await destroyPairFixture(fixture)
  }
})

test('§20 pair-confirm after expiry returns 410 via the tombstone', async () => {
  // Short PIN TTL so the listener's own expiry timer fires inside the test window. The
  // tombstone (Codex round 1 finding, low) lets the confirm POST-expiry still resolve as 410
  // instead of degrading to a generic 404.
  const fixture = await createPairFixture({ pinTtlMs: 60 })
  try {
    const initiate = await fixture.host.initiatePair(fixture.sinkBaseUrl)
    const lastIncoming = fixture.incoming.at(-1) as { pin: string; pairingId: string }
    await new Promise((resolve) => setTimeout(resolve, 120))
    const confirmAttempt = await postJson(`${fixture.sinkBaseUrl}/v1/parallax/pair-confirm`, {
      pairingId: lastIncoming.pairingId,
      pin: lastIncoming.pin,
      sinkId: 'spoof-sink-id',
      token: 'spoof-token'
    })
    assert.equal(confirmAttempt.status, 410, 'post-expiry confirm should be 410, not 404')
    assert.equal(confirmAttempt.payload?.error, 'expired')

    // Host candidate stays pending until TTL or explicit cancel.
    const status = fixture.host.getStatus()
    assert.equal(status.host.pairedSinkCount, 0)
    fixture.host.cancelPair(initiate.pairingId)
  } finally {
    await destroyPairFixture(fixture)
  }
})

test('§20 confirm for a pairingId that never existed still returns 404', async () => {
  // Negative case for the tombstone — without a matching pending OR tombstone, the generic
  // "no pending" path is correct.
  const fixture = await createPairFixture()
  try {
    const confirmAttempt = await postJson(`${fixture.sinkBaseUrl}/v1/parallax/pair-confirm`, {
      pairingId: 'never-existed',
      pin: '000000',
      sinkId: 'spoof-sink-id',
      token: 'spoof-token'
    })
    assert.equal(confirmAttempt.status, 404)
  } finally {
    await destroyPairFixture(fixture)
  }
})

test('§20 stop() drains pending pair timers (Codex round 1, medium)', async () => {
  // The 90s candidate TTL setTimeout used to keep the event loop alive after stop(); the test
  // process took ~91s to exit. clearAllPendingPairs() in stop() fixes that.
  const fixture = await createPairFixture()
  await fixture.host.initiatePair(fixture.sinkBaseUrl)
  // Stop both ends.
  await destroyPairFixture(fixture)
  // If stop() did not drain the candidate timers, the suite would hang here for ~90s. The
  // fact that this test returns immediately is the real assertion; the explicit check below
  // just confirms the host's view of pendingPairs is consistent post-stop.
  const stopped = fixture.host.getPendingPairSnapshot('any-id')
  assert.equal(stopped, null)
})

test('§20 3 wrong PINs lock out further attempts', async () => {
  const fixture = await createPairFixture()
  try {
    const initiate = await fixture.host.initiatePair(fixture.sinkBaseUrl)
    const lastIncoming = fixture.incoming.at(-1) as { pin: string; pairingId: string }
    const wrongPin = lastIncoming.pin === '000000' ? '111111' : '000000'

    // Drain three wrong-PIN attempts; pending state clears after the 3rd.
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(
        fixture.host.submitPairPin(initiate.pairingId, wrongPin),
        (error: any) => error?.status === 401
      )
    }

    // 4th attempt — with the correct PIN, even — must NOT activate because pending was cleared.
    await assert.rejects(
      fixture.host.submitPairPin(initiate.pairingId, lastIncoming.pin),
      (error: any) => /Sink has no record|Pair candidate not found/.test(String(error?.message ?? ''))
    )
    const status = fixture.host.getStatus()
    assert.equal(status.host.pairedSinkCount, 0)
    assert.equal(fixture.paired.length, 0)
  } finally {
    await destroyPairFixture(fixture)
  }
})
