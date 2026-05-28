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
