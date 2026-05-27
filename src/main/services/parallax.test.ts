import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { ParallaxService } from './parallax.ts'
import type { ParallaxHostConfig, ParallaxPairResponse } from '../../types/parallax.ts'

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
