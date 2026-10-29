import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createServer } from 'node:https'
import { createServer as tcpServer, connect, type Socket } from 'node:net'
import { createHash, X509Certificate } from 'node:crypto'
import { createParallaxTlsIdentity } from './parallaxSecurity.ts'
import { createStratumTransport } from './stratumTransport.ts'
import { StratumProofClient } from './stratumProofClient.ts'
import { StratumProofSession } from './stratumProofSession.ts'

/** Delay the next TLS connection, before HTTP can deliver its DELETE. The
 * server has the same two-playback limit as Sidecar. No real account or audio. */
async function fixture(t: TestContext) {
  const identity = await createParallaxTlsIdentity('Disposable slow Sidecar')
  const pin = createHash('sha256').update(new X509Certificate(identity.certificatePem)
    .publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  const state = { delayNext: 0, nextHandle: 0, handles: new Set<string>(), sessionDeletes: 0 }
  const server = createServer({ key: identity.privateKeyPem, cert: identity.certificatePem }, async (req, res) => {
    for await (const _ of req) { /* Consume the small request. */ }
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Connection', 'close')
    const route = req.url!.replace('/stratum', '')
    if (route === '/access/v1/capabilities') {
      res.end(JSON.stringify({ protocol: 'stratum-access-proof-1', audioExperiment: 'stratum-authenticated-audio-1',
        authentication: 'subsonic-token', sessionRenewal: 'fresh-credentials-same-user' }))
    } else if (route === '/access/v1/sessions') {
      res.end(JSON.stringify({ session: 'a'.repeat(64), expiresInSeconds: 600 }))
    } else if (route === '/access/v1/session' && req.method === 'DELETE') {
      state.sessionDeletes++; state.handles.clear(); res.writeHead(204); res.end()
    } else if (req.method === 'DELETE') {
      state.handles.delete(route.split('/').at(-1)!); res.writeHead(204); res.end()
    } else if (state.handles.size >= 2) {
      res.writeHead(429); res.end('{}')
    } else {
      const playback = (++state.nextHandle).toString(16).padStart(64, '0')
      state.handles.add(playback)
      res.end(JSON.stringify({ playback, sourcePolicy: 'complete-private-copy', maxSegmentSeconds: 4,
        source: { sha256: 'b'.repeat(64), codec: 'flac', sample_rate: 48000, channels: 2,
          bits_per_sample: 16, frames: 480000 } }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const sockets = new Set<Socket>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const bridge = tcpServer(incoming => {
    sockets.add(incoming)
    let upstream: Socket | undefined
    incoming.on('error', () => {})
    incoming.once('close', () => { clearTimeout(timer); timers.delete(timer); sockets.delete(incoming); upstream?.destroy() })
    const wait = state.delayNext
    state.delayNext = 0
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (incoming.destroyed) return
      upstream = connect({ host: '127.0.0.1', port: (server.address() as { port: number }).port })
      sockets.add(upstream)
      upstream.on('error', () => incoming.destroy())
      upstream.once('close', () => { sockets.delete(upstream!); incoming.destroy() })
      incoming.pipe(upstream).pipe(incoming)
    }, wait)
    timers.add(timer)
  })
  await new Promise<void>(resolve => bridge.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer)
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => bridge.close(() => resolve())),
      new Promise<void>(resolve => server.close(() => resolve()))])
  })
  const transport = createStratumTransport({ url: `https://127.0.0.1:${(bridge.address() as { port: number }).port}`, trust: 'sidecar_key' }, pin)
  return { state, transport }
}

for (const cleanup of ['close', 'closeAfter'] as const) test(`slow TLS ${cleanup} frees a playback slot before a queued replacement opens`, { timeout: 8000 }, async t => {
  const { state, transport } = await fixture(t)
  const connection = { ...transport, signal: new AbortController().signal,
    getBearer: async () => 'a'.repeat(64), reject: () => {} }
  const client = new StratumProofClient(connection)
  await client.open('next', AbortSignal.timeout(5000))
  const current = await client.open('current', AbortSignal.timeout(5000))
  state.delayNext = 1800
  const closing = cleanup === 'close' ? client.close(current.playback) : client.closeAfter(Promise.resolve(current), [])
  const next = new StratumProofClient(connection).open('replacement', AbortSignal.timeout(5000))
  await closing
  const replacement = await next
  assert.equal(state.handles.has(current.playback), false, 'the old slot must be freed before replacing it')
  assert.equal(state.handles.has(replacement.playback), true)
  assert.equal(state.handles.size, 2)
})

test('closing a session allows a delayed TLS handshake to deliver logout', { timeout: 8000 }, async t => {
  const { state, transport } = await fixture(t)
  const owner = new StratumProofSession(transport.endpoint,
    async () => ({ username: 'fixture', password: 'disposable' }), transport)
  await owner.getBearer(AbortSignal.timeout(5000))
  const client = new StratumProofClient(owner)
  await client.open('current', AbortSignal.timeout(5000))
  state.delayNext = 1800
  const closed = owner.close()
  assert.equal(owner.signal.aborted, true, 'stop local playback immediately while logout completes')
  await closed
  assert.equal(state.sessionDeletes, 1)
  assert.equal(state.handles.size, 0)
})

test('HTTPS observations identify delayed connection setup separately from response waiting', { timeout: 5000 }, async t => {
  const { state, transport } = await fixture(t)
  state.delayNext = 100
  let connectionMs: number | undefined, responseWaitMs: number | undefined
  const start = performance.now()
  await transport.request('/access/v1/capabilities', 'GET', AbortSignal.timeout(4000), undefined, undefined, 4096,
    event => {
      if (event.phase === 'start') { connectionMs = event.connectionMs; responseWaitMs = event.responseWaitMs }
    })
  assert.ok(connectionMs! >= 80)
  assert.ok(responseWaitMs! >= 0)
  assert.ok(connectionMs! + responseWaitMs! <= performance.now() - start)
})
