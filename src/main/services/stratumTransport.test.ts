import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createServer } from 'node:https'
import { createServer as tcpServer, connect, type Socket } from 'node:net'
import { createHash, X509Certificate } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createParallaxTlsIdentity } from './parallaxSecurity.ts'
import { createStratumTransport } from './stratumTransport.ts'
import { StratumProofSession } from './stratumProofSession.ts'

const signal = () => AbortSignal.timeout(5000)
async function until(check: () => boolean) {
  const end = performance.now() + 2000
  while (!check()) { assert.ok(performance.now() < end, 'fixture did not reach the expected state'); await delay(5) }
}
async function fixture(t: TestContext) {
  const identity = await createParallaxTlsIdentity('Disposable pooled Sidecar')
  const pin = createHash('sha256').update(new X509Certificate(identity.certificatePem)
    .publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  const state = { handshakes: 0, connected: 0, delay: 80, close: false, reset: false,
    requests: [] as string[], replies: [] as (() => void)[], deletes: 0 }
  const server = createServer({ key: identity.privateKeyPem, cert: identity.certificatePem }, async (req, res) => {
    for await (const _ of req) { /* Small fake requests. */ }
    state.requests.push(req.url!)
    if (state.reset) { req.socket.destroy(); return }
    if (state.close) res.setHeader('Connection', 'close')
    res.setHeader('Content-Type', 'application/json')
    if (req.url!.endsWith('/hold')) await new Promise<void>(resolve => state.replies.push(resolve))
    if (req.url!.endsWith('/capabilities')) res.end(JSON.stringify({ protocol: 'stratum-access-proof-1',
      audioExperiment: 'stratum-authenticated-audio-1', authentication: 'subsonic-token', sessionRenewal: 'fresh-credentials-same-user' }))
    else if (req.url!.endsWith('/sessions')) res.end(JSON.stringify({ session: 'a'.repeat(64), expiresInSeconds: 600 }))
    else if (req.method === 'DELETE') { state.deletes++; res.writeHead(204); res.end() }
    else res.end(Buffer.alloc(34 * 1024, 1))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const sockets = new Set<Socket>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const bridge = tcpServer(incoming => {
    state.handshakes++; state.connected++; sockets.add(incoming)
    let upstream: Socket | undefined
    incoming.on('error', () => {})
    incoming.once('close', () => { state.connected--; clearTimeout(timer); timers.delete(timer); sockets.delete(incoming); upstream?.destroy() })
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (incoming.destroyed) return
      upstream = connect({ host: '127.0.0.1', port: (server.address() as { port: number }).port })
      sockets.add(upstream)
      upstream.on('error', () => incoming.destroy())
      upstream.once('close', () => { sockets.delete(upstream!); incoming.destroy() })
      incoming.pipe(upstream).pipe(incoming)
    }, state.delay)
    timers.add(timer)
  })
  await new Promise<void>(resolve => bridge.listen(0, '127.0.0.1', resolve))
  const transport = createStratumTransport({ url: `https://127.0.0.1:${(bridge.address() as { port: number }).port}`, trust: 'sidecar_key' }, pin)
  t.after(async () => {
    transport.close!()
    state.replies.forEach(reply => reply())
    for (const timer of timers) clearTimeout(timer)
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => bridge.close(() => resolve())),
      new Promise<void>(resolve => server.close(() => resolve()))])
  })
  return { state, transport }
}

test('sequential segments pay for one verified TLS handshake and record zero setup on reuse', { timeout: 5000 }, async t => {
  const { state, transport } = await fixture(t)
  const setup: number[] = []
  for (let i = 0; i < 8; i++) {
    const response = await transport.request('/audio/v1/playback/test/segment', 'POST', signal(), { start: i }, 'a'.repeat(64), undefined,
      event => { if (event.phase === 'start') setup.push(event.connectionMs!) })
    assert.equal(response.bytes.length, 34 * 1024)
  }
  assert.equal(state.handshakes, 1)
  assert.ok(setup[0] >= 60)
  assert.deepEqual(setup.slice(1), Array(7).fill(0))
  transport.close!()
  await until(() => state.connected === 0)
  await assert.rejects(transport.request('/access/v1/capabilities', 'GET', signal()))
  assert.equal(state.requests.length, 8)
})

test('old servers that close responses still work without connection reuse', { timeout: 5000 }, async t => {
  const { state, transport } = await fixture(t)
  state.close = true
  for (let i = 0; i < 3; i++) await transport.request('/access/v1/capabilities', 'GET', signal())
  assert.equal(state.handshakes, 3)
})

test('aborting a completed request does not kill the socket serving its successor', { timeout: 5000 }, async t => {
  const { state, transport } = await fixture(t)
  const old = new AbortController()
  await transport.request('/access/v1/capabilities', 'GET', old.signal)
  const next = transport.request('/audio/v1/hold', 'POST', signal())
  await until(() => state.replies.length === 1)
  old.abort()
  state.replies[0]()
  assert.equal((await next).bytes.length, 34 * 1024)
  assert.equal(state.handshakes, 1)
})

test('cancelling one transfer leaves concurrent audio and later requests working', { timeout: 5000 }, async t => {
  const { state, transport } = await fixture(t)
  const controller = new AbortController()
  const cancelled = assert.rejects(transport.request('/audio/v1/hold', 'POST', controller.signal))
  const other = transport.request('/audio/v1/hold', 'POST', signal())
  await until(() => state.replies.length === 2)
  controller.abort()
  state.replies.forEach(reply => reply())
  await cancelled
  assert.equal((await other).bytes.length, 34 * 1024)
  await transport.request('/access/v1/capabilities', 'GET', signal())
  assert.equal(state.handshakes, 2)
})

test('cancelled queued requests never start TLS; pending handshakes are bounded and cancelled', { timeout: 5000 }, async t => {
  const { state, transport } = await fixture(t)
  state.delay = 1000
  const controller = new AbortController()
  const pending = Array.from({ length: 8 }, () => assert.rejects(transport.request('/access/v1/capabilities', 'GET', controller.signal)))
  await until(() => state.handshakes === 3)
  controller.abort()
  await Promise.all(pending)
  await until(() => state.connected === 0)
  assert.equal(state.handshakes, 3)
  assert.equal(state.requests.length, 0)
  state.delay = 0
  await transport.request('/access/v1/capabilities', 'GET', signal())
})

test('retire old idle sockets before the next request can cross Sidecar’s lifetime limit', { timeout: 5000 }, async t => {
  const { state, transport } = await fixture(t)
  await transport.request('/access/v1/capabilities', 'GET', signal())
  const now = performance.now.bind(performance)
  t.mock.method(performance, 'now', () => now() + 25_000)
  await transport.request('/access/v1/capabilities', 'GET', signal())
  assert.equal(state.handshakes, 2)
})

test('closing the session sends logout on the verified connection then releases it', { timeout: 5000 }, async t => {
  const { state, transport } = await fixture(t)
  const owner = new StratumProofSession(transport.endpoint, async () => ({ username: 'fixture', password: 'disposable' }), transport)
  t.after(() => owner.close())
  await owner.getBearer(signal())
  await owner.close()
  assert.equal(state.deletes, 1)
  assert.equal(state.handshakes, 1)
  await until(() => state.connected === 0)
})

test('a broken reused socket fails once without replaying a potentially mutating request', { timeout: 5000 }, async t => {
  const { state, transport } = await fixture(t)
  await transport.request('/access/v1/capabilities', 'GET', signal())
  state.reset = true
  await assert.rejects(transport.request('/audio/v1/playbacks/track', 'POST', signal()), /closed the connection/)
  assert.equal(state.requests.length, 2)
  assert.equal(state.handshakes, 1)
  state.reset = false
  await transport.request('/access/v1/capabilities', 'GET', signal())
  assert.equal(state.handshakes, 2)
})
