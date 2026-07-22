import assert from 'node:assert/strict'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import test from 'node:test'
import type { ParallaxJoinValidationDiagnostic } from '../../src/types/parallax.ts'
import {
  createParallaxTlsIdentity,
  type ParallaxTlsIdentity
} from '../../src/main/services/parallaxSecurity.ts'
import { ParallaxSinkClient, type SinkClientStatus } from './sinkClient.ts'

const TEST_TOKEN = 'test-bearer-token-never-log'
const RAW_PAYLOAD_MARKER = 'raw-response-body-never-log'

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

async function listen(server: HttpsServer, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

async function close(server: HttpsServer): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for condition.')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function createFixture(
  t: test.TestContext,
  handler: Parameters<typeof createHttpsServer>[1]
): Promise<{ port: number; baseUrl: string; tlsIdentity: ParallaxTlsIdentity; server: HttpsServer } | null> {
  let port: number
  try {
    port = await getFreePort()
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      t.skip('Local socket binding is blocked in this environment.')
      return null
    }
    throw error
  }
  const tlsIdentity = await createParallaxTlsIdentity('Receiver Join Diagnostic Test')
  const server = createHttpsServer({
    key: tlsIdentity.privateKeyPem,
    cert: tlsIdentity.certificatePem,
    minVersion: 'TLSv1.2'
  }, handler)
  await listen(server, port)
  return { port, baseUrl: `https://127.0.0.1:${port}`, tlsIdentity, server }
}

function createClient(
  diagnostics: ParallaxJoinValidationDiagnostic[],
  statuses: SinkClientStatus[]
): ParallaxSinkClient {
  return new ParallaxSinkClient({
    softwareVersion: 'receiver-v-test',
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onEvent: () => undefined,
    onAudioChunk: () => undefined,
    onStatus: (status) => statuses.push(status),
    onAuthRevoked: () => undefined
  })
}

test('receiver initial join reports a structured sanitized validation diagnostic', async (t) => {
  const fixture = await createFixture(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${TEST_TOKEN}`)
    res.writeHead(200, { 'Content-Type': 'application/problem+json; charset=utf-8' })
    res.end(JSON.stringify({
      sinkId: 'receiver-sink',
      groupLatencyMs: 1000,
      hostTimeMs: Date.now(),
      stream: { marker: RAW_PAYLOAD_MARKER },
      timeline: null,
      secret: TEST_TOKEN
    }))
  })
  if (!fixture) return

  const diagnostics: ParallaxJoinValidationDiagnostic[] = []
  const statuses: SinkClientStatus[] = []
  const client = createClient(diagnostics, statuses)
  try {
    await assert.rejects(client.connect({
      protocolVersion: 2,
      baseUrl: fixture.baseUrl,
      sinkId: 'receiver-sink',
      token: TEST_TOKEN,
      hostCertificatePem: fixture.tlsIdentity.certificatePem,
      hostCertificateFingerprint: fixture.tlsIdentity.fingerprint256
    }), /invalid join response \(invalid-stream-fields\)/)

    assert.deepEqual(diagnostics, [{
      event: 'parallax_join_validation_failed',
      joinPhase: 'initial',
      reason: 'invalid-stream-fields',
      httpStatus: 200,
      contentType: 'application/problem+json; charset=utf-8',
      protocolVersion: 2,
      softwareVersion: 'receiver-v-test'
    }])
    assert.match(statuses.at(-1)?.lastError ?? '', /invalid-stream-fields/)
    const surfaced = JSON.stringify({ diagnostics, status: statuses.at(-1) })
    assert.equal(surfaced.includes(TEST_TOKEN), false)
    assert.equal(surfaced.includes(RAW_PAYLOAD_MARKER), false)
  } finally {
    await client.disconnect()
    await close(fixture.server)
  }
})

test('receiver reconnect reports an exact sink mismatch diagnostic', async (t) => {
  let joinCount = 0
  const fixture = await createFixture(t, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/v1/parallax/join') {
      joinCount += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        sinkId: joinCount === 1 ? 'receiver-sink' : 'unexpected-sink',
        groupLatencyMs: 1000,
        hostTimeMs: Date.now(),
        stream: null,
        timeline: null,
        marker: RAW_PAYLOAD_MARKER
      }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/parallax/clock') {
      const now = Date.now()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ sinkSentAtMs: now, hostReceivedAtMs: now, hostSentAtMs: now }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/parallax/events') {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end('offline')
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })
  if (!fixture) return

  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    return originalSetTimeout(handler, timeout === 2_000 || timeout === 120 ? 0 : timeout, ...args)
  }) as typeof setTimeout
  const diagnostics: ParallaxJoinValidationDiagnostic[] = []
  const statuses: SinkClientStatus[] = []
  const client = createClient(diagnostics, statuses)
  try {
    await client.connect({
      protocolVersion: 2,
      baseUrl: fixture.baseUrl,
      sinkId: 'receiver-sink',
      token: TEST_TOKEN,
      hostCertificatePem: fixture.tlsIdentity.certificatePem,
      hostCertificateFingerprint: fixture.tlsIdentity.fingerprint256
    })
    await waitFor(() => diagnostics.some((diagnostic) => diagnostic.joinPhase === 'reconnect'))

    const diagnostic = diagnostics.find((candidate) => candidate.joinPhase === 'reconnect')
    assert.deepEqual(diagnostic, {
      event: 'parallax_join_validation_failed',
      joinPhase: 'reconnect',
      reason: 'sink-id-mismatch',
      httpStatus: 200,
      contentType: 'application/json',
      protocolVersion: 2,
      softwareVersion: 'receiver-v-test',
      expectedSinkId: 'receiver-sink',
      actualSinkId: 'unexpected-sink'
    })
    assert.match(client.getStatus().lastError ?? '', /sink-id-mismatch/)
    const surfaced = JSON.stringify({ diagnostic, status: client.getStatus() })
    assert.equal(surfaced.includes(TEST_TOKEN), false)
    assert.equal(surfaced.includes(RAW_PAYLOAD_MARKER), false)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    await client.disconnect()
    await close(fixture.server)
  }
})
