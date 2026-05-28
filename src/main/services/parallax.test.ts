import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { ParallaxService } from './parallax.ts'
import type { ParallaxHostConfig, ParallaxPairResponse } from '../../types/parallax.ts'
import { decodeParallaxAudioPacket } from '../../types/parallax.ts'

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
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
    const pin = service.createPairingPin()
    const pairedResponse = await fetch(`${baseUrl}/v1/parallax/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: pin.pin, sinkName: 'Desk' })
    })
    assert.equal(pairedResponse.status, 200)
    const paired = await pairedResponse.json() as ParallaxPairResponse

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
