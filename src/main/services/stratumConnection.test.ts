import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createServer } from 'node:https'
import { createServer as createTcpServer } from 'node:net'
import { createHash, X509Certificate } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createParallaxTlsIdentity } from './parallaxSecurity.ts'
import { createStratumTransport } from './stratumTransport.ts'
import { discoverStratum, parseStratumManifest, verifyStratumCapabilities, type StratumManifest } from './stratumDiscovery.ts'
import { StratumConnections, stratumSourceBinding } from './stratumConnections.ts'
import { StratumProofClient } from './stratumProofClient.ts'
import { StratumNetworkError, stratumConnectionFailure, stratumTimeoutContext } from './stratumNetwork.ts'
import { inspectManualSidecar, inspectSidecarIdentity } from './stratumManual.ts'

const installation = 'a'.repeat(32)
const bearer = 'b'.repeat(64)
const credential = { username: 'listener', password: 'test-password-not-a-real-account' }
const binding = 'c'.repeat(64)
const signal = () => AbortSignal.timeout(5000)
const capabilities = (manifest: StratumManifest) => ({
  protocol: 'stratum-access-proof-1', audioExperiment: 'stratum-authenticated-audio-1',
  authentication: 'subsonic-token', sessionRenewal: 'fresh-credentials-same-user',
  service: 'astra-sidecar', installation: manifest.installation, spkiSha256: manifest.spkiSha256,
  ready: true, playback: true
})
const radio = (manifest: StratumManifest) => {
  const url = manifest.endpoints[0].url + '/stratum/access/v1/capabilities'
  return { name: 'Stratum', streamUrl: url, homePageUrl: `${url}#stratum-v1=${encodeURIComponent(JSON.stringify(manifest))}` }
}
const sample = (): StratumManifest => ({ version: 1, kind: 'astra-sidecar', installation,
  spkiSha256: 'd'.repeat(64), endpoints: [{ url: 'https://music.home.test:7843/base', trust: 'sidecar_key' }] })

test('discovery recognizes only marked, valid, unambiguous announcements and preserves proxy paths', () => {
  const manifest = sample()
  assert.equal(discoverStratum([{ name: 'Stratum', streamUrl: 'https://radio.test' }]), null)
  assert.deepEqual(discoverStratum([radio(manifest)]), manifest)
  assert.throws(() => discoverStratum([radio(manifest), radio(manifest)]), /More than one/)
  assert.throws(() => discoverStratum([{ ...radio(manifest), streamUrl: 'https://other.test' }]), /invalid/)
  assert.throws(() => discoverStratum([{ homePageUrl: 'https://x/#stratum-v1=%zz' }, radio(manifest)]), /invalid/)
  for (const patch of [{ version: 2 }, { kind: 'other' }, { spkiSha256: null }, { endpoints: [] },
    { endpoints: [{ url: 'http://music.test', trust: 'sidecar_key' }] },
    { endpoints: [{ url: 'https://user:password@music.test', trust: 'sidecar_key' }] },
    { endpoints: [{ url: 'https://music.test?token=secret', trust: 'sidecar_key' }] },
    { endpoints: [{ url: 'https://music.test', trust: 'anything' }] }]) {
    assert.throws(() => parseStratumManifest({ ...manifest, ...patch }))
  }
  assert.throws(() => verifyStratumCapabilities(Buffer.from(JSON.stringify({ ...capabilities(manifest), installation: 'e'.repeat(32) })), manifest), /does not match/)
  assert.throws(() => verifyStratumCapabilities(Buffer.from(JSON.stringify({ ...capabilities(manifest), ready: false })), manifest), /Finish/)
})

async function fixture(t: TestContext) {
  const identity = await createParallaxTlsIdentity('Disposable Sidecar')
  const spkiSha256 = createHash('sha256').update(new X509Certificate(identity.certificatePem).publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  const state = { requests: [] as { path: string; authorization?: string; body: string }[], creates: 0, deletes: 0,
    capabilityDelay: 0, preparationDelay: 0, playable: false, reset: false, stall: false,
    wrongIdentity: false, redirect: false, oversized: false, hold: null as Promise<void> | null, reads: 0, writeFails: false,
    sources: new Map([[1, { binding, enabled: true }], [2, { binding: 'f'.repeat(64), enabled: true }]]),
    settings: '', rows: [] as unknown[], events: [] as unknown[], signInStatus: 201 }
  let manifest: StratumManifest
  const server = createServer({ key: identity.privateKeyPem, cert: identity.certificatePem }, async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    state.requests.push({ path: req.url!, authorization: req.headers.authorization, body })
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.origin, undefined)
    assert.ok(!body.includes(credential.password)); assert.ok(!req.url?.includes(bearer))
    if (state.stall) return
    if (state.reset) { req.socket.destroy(); return }
    if (state.redirect) { res.writeHead(302, { Location: '/redirected' }); res.end(); return }
    if (state.oversized) { res.end('x'.repeat(4097)); return }
    if (req.url === '/base/stratum/access/v1/capabilities') {
      const wait = state.capabilityDelay
      state.capabilityDelay = 0
      if (wait) await delay(wait)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ...capabilities(manifest), ...(state.wrongIdentity ? { installation: '0'.repeat(32) } : {}) })); return
    }
    if (req.method === 'DELETE') { state.deletes++; res.writeHead(204); res.end(); return }
    if (req.url === '/base/stratum/access/v1/sessions') {
      state.creates++
      const value = JSON.parse(body)
      assert.equal(value.token, createHash('md5').update(credential.password + value.salt).digest('hex'))
      if (state.hold) await state.hold
      res.writeHead(state.signInStatus); res.end(JSON.stringify({ session: bearer, expiresInSeconds: 600 })); return
    }
    if (req.url?.startsWith('/base/stratum/audio/')) {
      assert.equal(req.headers.authorization, `Bearer ${bearer}`)
      if (state.playable && req.url.includes('/playbacks/')) {
        if (state.preparationDelay) await delay(state.preparationDelay)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ playback: 'e'.repeat(64), source: { sha256: 'f'.repeat(64), codec: 'flac',
          sample_rate: 48000, channels: 2, bits_per_sample: 24, frames: 480000 },
          sourcePolicy: 'complete-private-copy', maxSegmentSeconds: 4 }))
        return
      }
      res.writeHead(404); res.end('PRIVATE-UPSTREAM-DETAILS'); return
    }
    res.writeHead(400); res.end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const base = `https://127.0.0.1:${(server.address() as { port: number }).port}/base`
  manifest = { ...sample(), spkiSha256, endpoints: [{ url: base, trust: 'sidecar_key' }] }
  state.rows = [radio(manifest)]
  const deps = {
    source: (id: number) => state.sources.get(id) ?? null,
    credentials: async () => { state.reads++; return credential },
    radios: async () => state.rows,
    read: () => state.settings,
    write: async (value: string) => { if (state.writeFails) throw new Error('Could not save Stratum settings.'); state.settings = value },
    changed: (value: unknown) => { state.events.push(value) }
  }
  const manager = new StratumConnections(deps)
  t.after(async () => {
    manager.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { state, manager, manifest, deps, server, transport: createStratumTransport(manifest.endpoints[0], spkiSha256) }
}

test('cold installed playback verifies capabilities once, shares that result, and rechecks on a fresh connection', async t => {
  const { state, manager, deps } = await fixture(t)
  await manager.discover(1); await manager.setEnabled(1, true)
  manager.close()
  const restarted = new StratumConnections(deps)
  t.after(() => restarted.close())
  state.playable = true
  state.requests.length = 0
  const client = new StratumProofClient(restarted.cachedConnection(1)!.connection)
  const first = await client.open('first-track', signal())
  const second = await client.open('second-track', signal())
  assert.equal(state.requests.filter(request => request.path.endsWith('/capabilities')).length, 1,
    'verification, sign-in and both track opens share the same verified capability response')
  assert.equal(state.requests.filter(request => request.path.endsWith('/sessions')).length, 1)
  await client.close(first.playback); await client.close(second.playback)
  const before = state.requests.filter(request => request.path.endsWith('/capabilities')).length, reads = state.reads
  restarted.invalidate(1)
  state.wrongIdentity = true
  await assert.rejects(new StratumProofClient(restarted.cachedConnection(1)!.connection).open('third-track', signal()), /does not match/)
  assert.equal(state.requests.filter(request => request.path.endsWith('/capabilities')).length, before + 1,
    'a new connection must verify the installation again; session cleanup can make its own DELETE')
  assert.equal(state.reads, reads, 'changed identity cannot receive a fresh sign-in')
})

test('timeouts identify capability verification, sign-in and preparation without exposing request paths', async t => {
  const { state, transport } = await fixture(t)
  state.stall = true
  for (const [path, method, message] of [
    ['/access/v1/capabilities', 'GET', /connection check/],
    ['/access/v1/sessions', 'POST', /sign-in/],
    ['/audio/v1/playbacks/private-track-id', 'POST', /prepare this track/]
  ] as const) {
    await assert.rejects(transport.request(path, method, AbortSignal.timeout(100), undefined, bearer), error => {
      assert.ok(error instanceof StratumNetworkError)
      assert.match(error.message, message)
      assert.doesNotMatch(error.message, /private-track-id|\/access|\/audio/)
      return true
    })
  }
})

test('a saved Stratum connection can start playback after a slow capability response', { timeout: 10000 }, async t => {
  const { state, manager, deps } = await fixture(t)
  await manager.discover(1); await manager.setEnabled(1, true)
  manager.close()
  const restarted = new StratumConnections(deps)
  t.after(() => restarted.close())
  state.capabilityDelay = 4500
  state.playable = true
  const client = new StratumProofClient(restarted.cachedConnection(1)!.connection)
  const playback = await client.open('track', AbortSignal.timeout(8000))
  assert.equal(playback.source.frames, 480000)
  assert.equal(restarted.status(1).state, 'enabled')
  await client.close(playback.playback)
})

test('slow track preparation can finish over verified HTTPS without falling back', { timeout: 18000 }, async t => {
  const { state, manager } = await fixture(t)
  await manager.discover(1); await manager.setEnabled(1, true)
  state.playable = true
  state.preparationDelay = 12500
  const client = new StratumProofClient(manager.cachedConnection(1)!.connection)
  const playback = await client.open('track', AbortSignal.timeout(16000))
  assert.equal(playback.source.frames, 480000)
  await client.close(playback.playback)
})

test('startup deadlines remain cancellable and timeout errors are distinguished from user cancellation', async t => {
  const { state, transport } = await fixture(t)
  state.capabilityDelay = 300
  await assert.rejects(transport.request('/access/v1/capabilities', 'GET', AbortSignal.timeout(50)),
    error => error instanceof StratumNetworkError && /too long/.test(error.message))
  state.capabilityDelay = 300
  const controller = new AbortController()
  const pending = transport.request('/access/v1/capabilities', 'GET', controller.signal)
  const rejected = assert.rejects(pending, /cancelled/)
  controller.abort()
  await rejected
})

test('connection resets distinguish failed TLS from a dropped HTTP request', { timeout: 5000 }, async t => {
  const { state, transport, manifest } = await fixture(t)
  state.reset = true
  await assert.rejects(transport.request('/access/v1/capabilities', 'GET', signal()), /before sending a response.*ECONNRESET/)
  const tcp = createTcpServer(socket => socket.destroy())
  await new Promise<void>(resolve => tcp.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => tcp.close(() => resolve())))
  const broken = createStratumTransport({ url: `https://127.0.0.1:${(tcp.address() as { port: number }).port}`, trust: 'sidecar_key' }, manifest.spkiSha256)
  await assert.rejects(broken.request('/access/v1/capabilities', 'GET', signal()), /HTTPS handshake.*ECONNRESET/)
})

test('a stalled TLS handshake reports secure connection timeout rather than a server preparation timeout', async t => {
  const sockets = new Set<import('node:net').Socket>()
  const tcp = createTcpServer(socket => { sockets.add(socket); socket.resume(); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => tcp.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); tcp.close(() => resolve()) }))
  const transport = createStratumTransport({ url: `https://127.0.0.1:${(tcp.address() as { port: number }).port}`, trust: 'sidecar_key' }, 'a'.repeat(64))
  await assert.rejects(transport.request('/audio/v1/playbacks/private-track-id', 'POST', AbortSignal.timeout(100)),
    /too long to establish a secure connection/)
})

test('connection messages classify native codes without leaking raw errors or alleging certificate failures', () => {
  for (const code of ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EACCES', 'EPERM']) {
    const error = stratumConnectionFailure({ code, message: 'PRIVATE-DATA' }, false)
    assert.ok(error instanceof StratumNetworkError)
    assert.ok(error.message.includes(code))
    assert.doesNotMatch(error.message, /certificate|PRIVATE-DATA/)
  }
  assert.match(stratumConnectionFailure({ code: 'CERT_HAS_EXPIRED' }, false).message, /certificate has expired/)
  assert.doesNotMatch(stratumConnectionFailure({ code: 'PRIVATE-DATA', message: 'PRIVATE-DATA' }, false).message, /PRIVATE-DATA/)
  const prepare = stratumTimeoutContext(new StratumNetworkError('timeout'), 'preparation') as Error
  assert.match(prepare.message, /prepare this track/)
  assert.equal(stratumTimeoutContext(prepare, 'setup'), prepare, 'outer waits preserve the actual failing step')
  const cancelled = new DOMException('Cancelled', 'AbortError')
  assert.equal(stratumTimeoutContext(cancelled, 'setup'), cancelled)
  assert.match((stratumTimeoutContext(new DOMException('PRIVATE-DATA', 'TimeoutError'), 'signin') as Error).message, /complete sign-in/)
})

test('fallback explains safe connection failures without exposing raw errors or repeating stale reasons', async t => {
  const { state, manager } = await fixture(t)
  await manager.discover(1); await manager.setEnabled(1, true)
  manager.playbackFailed(1, new StratumNetworkError('timeout'))
  assert.equal(manager.status(1).error, 'Sidecar took too long to respond. Astra is using the server’s usual streaming.')
  manager.playbackFailed(1, new StratumNetworkError('timeout'))
  assert.equal(manager.status(1).error!.split('Astra is using').length, 2)
  manager.playbackFailed(1, new Error('PRIVATE-ACCOUNT-OR-FILESYSTEM-DETAILS'))
  assert.equal(manager.status(1).error, 'Stratum could not prepare this track. Astra is using the server’s usual streaming.')
  state.wrongIdentity = true
  await manager.discover(1)
  let failure: unknown
  try { await manager.connection(1, signal()) } catch (error) { failure = error }
  assert.ok(failure)
  manager.playbackFailed(1, failure)
  assert.match(manager.status(1).error!, /does not match/)
})

test('real TLS pin rejects the wrong key before any HTTP, credentials or body are sent', { timeout: 8000 }, async t => {
  const { state, manifest, transport } = await fixture(t)
  const wrong = createStratumTransport(manifest.endpoints[0], '0'.repeat(64))
  await assert.rejects(wrong.request('/access/v1/sessions', 'POST', signal(), { secret: 'must-not-leak' }, bearer), /identity/)
  assert.equal(state.requests.length, 0)
  const result = await transport.request('/access/v1/capabilities', 'GET', signal())
  verifyStratumCapabilities(result.bytes, manifest)
  assert.equal(state.requests[0].path, '/base/stratum/access/v1/capabilities')
  assert.equal(state.requests[0].authorization, undefined)
})

test('proxy trust rejects a self-signed certificate even when the advertised key matches', { timeout: 8000 }, async t => {
  const { state, manifest } = await fixture(t)
  const proxy = createStratumTransport({ ...manifest.endpoints[0], trust: 'https_proxy' }, manifest.spkiSha256)
  await assert.rejects(proxy.request('/access/v1/sessions', 'POST', signal(), { secret: 'must-not-leak' }), /certificate is not trusted/)
  assert.equal(state.requests.length, 0)
})

test('verified transport does not follow redirects and bounds response bodies', { timeout: 8000 }, async t => {
  const { state, transport } = await fixture(t)
  state.redirect = true
  await assert.rejects(transport.request('/access/v1/capabilities', 'GET', signal()), /302/)
  assert.equal(state.requests.length, 1)
  state.redirect = false; state.oversized = true
  await assert.rejects(transport.request('/access/v1/capabilities', 'GET', signal(), undefined, undefined, 4096), /size limit/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(transport.request('/access/v1/capabilities', 'GET', abort.signal))
  assert.equal(state.requests.length, 2)
})

test('discovery needs no listener secret; enable shares a verified HTTPS session across playback clients', { timeout: 8000 }, async t => {
  const { state, manager } = await fixture(t)
  assert.equal((await manager.discover(1)).state, 'available')
  assert.equal(state.reads, 0); assert.equal(state.creates, 0)
  const enabled = await manager.setEnabled(1, true)
  assert.equal(enabled.enabled, true); assert.equal(enabled.state, 'enabled')
  const [first, next] = await Promise.all([manager.connection(1, signal()), manager.connection(1, signal())])
  assert.equal(first, next); assert.equal(state.creates, 1)
  assert.equal(await manager.connection(2, signal()), null)
  assert.equal(state.settings.includes(bearer), false); assert.equal(state.settings.includes(credential.password), false)
  assert.equal(JSON.stringify(state.events).includes(bearer), false)
  await assert.rejects(new StratumProofClient(first!).open('track', signal()), /no longer available/)
  const disabled = await manager.setEnabled(1, false)
  assert.equal(disabled.enabled, false); assert.equal(first!.signal.aborted, true)
  assert.equal(disabled.state, 'available', 'turning off keeps discovery and the switch available')
  assert.equal(await manager.connection(1, signal()), null)
  const reads = state.reads
  assert.equal((await manager.setEnabled(1, true)).enabled, true, 'no extra Check again is needed')
  assert.equal(state.reads, reads + 1, 're-enable still signs in afresh')
})

test('turning off a restored approval keeps discovery, but re-enable must reverify it', { timeout: 8000 }, async t => {
  const { state, manager, deps } = await fixture(t)
  await manager.discover(1); await manager.setEnabled(1, true)
  manager.close()
  const restarted = new StratumConnections(deps)
  t.after(() => restarted.close())
  assert.equal((await restarted.setEnabled(1, false)).state, 'available')
  const reads = state.reads
  state.wrongIdentity = true
  assert.equal((await restarted.setEnabled(1, true)).state, 'error')
  assert.equal(state.reads, reads, 'remembering availability never bypasses identity verification')
  assert.equal((await restarted.setEnabled(1, false)).state, 'unchecked', 'an identity error requires rediscovery')
})

test('saved approval survives restart, but account changes and disablement stop old sessions', { timeout: 8000 }, async t => {
  const { state, manager, deps } = await fixture(t)
  await manager.discover(1); await manager.setEnabled(1, true)
  manager.close()
  const restarted = new StratumConnections(deps)
  t.after(() => restarted.close())
  assert.equal(restarted.status(1).enabled, true)
  const [first, next] = await Promise.all([restarted.connection(1, signal()), restarted.connection(1, signal())])
  assert.equal(first, next); assert.equal(state.creates, 2)
  state.sources.get(1)!.enabled = false; restarted.invalidate(1)
  assert.equal(first!.signal.aborted, true)
  assert.equal(await restarted.connection(1, signal()), null)
  state.sources.set(1, { binding: '0'.repeat(64), enabled: true })
  assert.equal(restarted.status(1).enabled, false)
  assert.equal(await restarted.connection(1, signal()), null)
})

test('changed announcements or capability identities cannot obtain the saved listener credentials', { timeout: 8000 }, async t => {
  const { state, manager, manifest } = await fixture(t)
  await manager.discover(1)
  state.wrongIdentity = true
  assert.equal((await manager.setEnabled(1, true)).state, 'error')
  assert.equal(state.reads, 0); assert.equal(state.creates, 0)
  state.wrongIdentity = false
  await manager.discover(1)
  state.rows = [radio({ ...manifest, installation: 'e'.repeat(32) })]
  assert.equal((await manager.setEnabled(1, true)).state, 'error')
  assert.equal(state.reads, 0)
})

test('failed sign-in and failed settings save never show enabled', { timeout: 8000 }, async t => {
  const { state, manager } = await fixture(t)
  await manager.discover(1)
  state.signInStatus = 401
  assert.equal((await manager.setEnabled(1, true)).enabled, false)
  state.signInStatus = 201; state.writeFails = true
  assert.equal((await manager.setEnabled(1, true)).enabled, false)
  assert.equal(manager.status(1).state, 'error')
})

test('disabling while sign-in is in flight cannot re-enable or publish its late session', { timeout: 8000 }, async t => {
  const { state, manager } = await fixture(t)
  await manager.discover(1)
  let release!: () => void
  state.hold = new Promise(resolve => { release = resolve })
  const enabling = manager.setEnabled(1, true)
  const rejected = assert.rejects(enabling, /changed/)
  while (!state.creates) await new Promise(resolve => setTimeout(resolve, 10))
  await manager.setEnabled(1, false)
  release(); await rejected
  assert.equal(manager.status(1).enabled, false)
  assert.equal(await manager.connection(1, signal()), null)
})

test('source approval includes credentials, account, address and source creation identity', () => {
  const source = { base_url: 'http://nav.test', username: 'listener', secret_encrypted: 'encrypted', created_at: 1 }
  const original = stratumSourceBinding(source)
  for (const patch of [{ base_url: 'http://other.test' }, { username: 'another' }, { secret_encrypted: 'changed' }, { created_at: 2 }]) {
    assert.notEqual(stratumSourceBinding({ ...source, ...patch }), original)
  }
})

test('alternate addresses are tried after connection failure, but never after a wrong key', { timeout: 8000 }, async t => {
  const { state, manager, manifest } = await fixture(t)
  const unreachable = { url: 'https://127.0.0.1:1', trust: 'sidecar_key' as const }
  state.rows = [radio({ ...manifest, endpoints: [unreachable, ...manifest.endpoints] })]
  assert.equal((await manager.discover(1)).state, 'available')
  assert.equal(state.reads, 0)
  state.requests.length = 0
  state.rows = [radio({ ...manifest, spkiSha256: '0'.repeat(64), endpoints: [manifest.endpoints[0],
    { url: manifest.endpoints[0].url + '/proxy', trust: 'https_proxy' }] })]
  assert.equal((await manager.discover(1)).state, 'error')
  assert.equal(state.requests.length, 0)
})

test('concurrent enable requests share one login and a changed announcement ends an active session', { timeout: 8000 }, async t => {
  const { state, manager, manifest } = await fixture(t)
  await manager.discover(1)
  const both = await Promise.all([manager.setEnabled(1, true), manager.setEnabled(1, true)])
  assert.ok(both.every(value => value.enabled)); assert.equal(state.creates, 1)
  const active = await manager.connection(1, signal())
  manager.playbackFailed(1)
  assert.equal(manager.status(1).state, 'error')
  manager.playbackStarted(1)
  assert.equal(manager.status(1).state, 'enabled')
  state.rows = [radio({ ...manifest, installation: 'e'.repeat(32) })]
  assert.equal((await manager.discover(1)).state, 'error')
  assert.equal(active!.signal.aborted, true)
  await assert.rejects(manager.connection(1, signal()), /announcement changed/)
  assert.equal(state.creates, 1)
})

test('retained playback approval is local, stable across current/next, and bound to account plus Sidecar identity', async t => {
  const { state, manager, deps } = await fixture(t)
  await manager.discover(1); await manager.setEnabled(1, true)
  const restarted = new StratumConnections(deps)
  t.after(() => restarted.close())
  const before = state.requests.length, reads = state.reads
  const first = restarted.cachedConnection(1)!
  assert.ok(first)
  assert.equal(restarted.cachedConnection(1), first)
  assert.equal(state.requests.length, before); assert.equal(state.reads, reads)
  assert.equal(restarted.cachedConnection(2), null)
  assert.equal(await first.connection.getBearer(signal()), bearer)
  assert.equal(state.reads, reads + 1)
  await restarted.setEnabled(1, false)
  assert.equal(first.connection.signal.aborted, true)
  assert.equal(restarted.cachedConnection(1), null)
  await assert.rejects(first.connection.getBearer(signal()))
  await restarted.discover(1); await restarted.setEnabled(1, true)
  assert.equal(restarted.cachedConnection(1)!.scope, first.scope, 're-enable of the same account/installation can reuse retained music')
  state.sources.set(1, { binding: 'e'.repeat(64), enabled: true })
  assert.equal(restarted.cachedConnection(1), null, 'different credentials require a new approval and cache scope')
})

test('manual self-signed setup reads no credentials until accepted, and remembers disabled connections across restart', async t => {
  const { state, manager, manifest, deps } = await fixture(t)
  state.rows = []
  const checked = await manager.inspectManual(1, manifest.endpoints[0].url + '/')
  assert.equal(checked.requiresTrust, true)
  assert.equal(checked.fingerprint, manifest.spkiSha256)
  assert.equal(state.reads, 0); assert.equal(state.creates, 0)
  assert.ok(state.requests.every(request => request.path.endsWith('/capabilities') && !request.authorization && !request.body))
  assert.equal(manager.status(1).enabled, false)
  assert.equal((await manager.connectManual(1, checked.token)).connection, 'manual')
  assert.equal(state.reads, 1)
  assert.equal((await manager.setEnabled(1, false)).enabled, false)
  manager.close()
  const restarted = new StratumConnections({ ...deps, radios: async () => { throw new Error('must not use discovery') } })
  t.after(() => restarted.close())
  assert.equal(restarted.status(1).connection, 'manual')
  assert.equal(restarted.status(1).endpoint, manifest.endpoints[0].url)
  assert.equal(restarted.status(1).enabled, false)
  assert.equal(restarted.cachedConnection(1), null)
  assert.equal(await restarted.connection(1, signal()), null)
  assert.equal((await restarted.discover(1)).state, 'available')
  assert.equal((await restarted.setEnabled(1, true)).enabled, true)
  assert.ok(await restarted.connection(1, signal()))
  assert.equal((await restarted.inspectManual(1, manifest.endpoints[0].url)).requiresTrust, false)
  assert.ok(!state.settings.includes(credential.password) && !state.settings.includes(bearer))
})

test('manual key replacement between check and acceptance never receives listener credentials', async t => {
  const { state, manager, manifest, server } = await fixture(t)
  const checked = await manager.inspectManual(1, manifest.endpoints[0].url)
  const other = await createParallaxTlsIdentity('Changed Sidecar')
  server.setSecureContext({ key: other.privateKeyPem, cert: other.certificatePem })
  await assert.rejects(manager.connectManual(1, checked.token), /identity/)
  assert.equal(state.reads, 0); assert.equal(state.creates, 0)
  assert.equal(manager.status(1).enabled, false)
})

test('a manual identity change cannot be accepted by toggling off and on or checking again', async t => {
  const { state, manager, manifest, server, deps } = await fixture(t)
  const checked = await manager.inspectManual(1, manifest.endpoints[0].url)
  await manager.connectManual(1, checked.token)
  await manager.setEnabled(1, false)
  const other = await createParallaxTlsIdentity('Changed Sidecar')
  server.setSecureContext({ key: other.privateKeyPem, cert: other.certificatePem })
  manifest.spkiSha256 = createHash('sha256').update(new X509Certificate(other.certificatePem)
    .publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  const reads = state.reads
  assert.equal((await manager.setEnabled(1, true)).state, 'error')
  assert.equal((await manager.discover(1)).state, 'error')
  assert.equal((await manager.setEnabled(1, false)).connection, 'manual')
  manager.close()
  const restarted = new StratumConnections(deps)
  t.after(() => restarted.close())
  assert.equal((await restarted.setEnabled(1, true)).state, 'error')
  assert.equal(state.reads, reads)
  const replacement = await restarted.inspectManual(1, manifest.endpoints[0].url)
  assert.equal(replacement.requiresTrust, true); assert.equal(replacement.identityChanged, true)
  await restarted.connectManual(1, replacement.token)
  assert.equal(state.reads, reads + 1)
})

test('manual proposals cannot cross sources, survive new checks or be replayed', async t => {
  const { state, manager, manifest } = await fixture(t)
  const first = await manager.inspectManual(1, manifest.endpoints[0].url)
  await assert.rejects(manager.connectManual(2, first.token), /expired/)
  const next = await manager.inspectManual(1, manifest.endpoints[0].url)
  await assert.rejects(manager.connectManual(1, first.token), /expired/)
  assert.equal(state.reads, 0)
  await manager.connectManual(1, next.token)
  await assert.rejects(manager.connectManual(1, next.token), /expired/)
  assert.equal(state.reads, 1)
})

test('disabled sources and changed Navidrome credentials invalidate a manual proposal', async t => {
  const { state, manager, manifest } = await fixture(t)
  const first = await manager.inspectManual(1, manifest.endpoints[0].url)
  await manager.setEnabled(1, false)
  await assert.rejects(manager.connectManual(1, first.token), /expired/)
  const next = await manager.inspectManual(1, manifest.endpoints[0].url)
  state.sources.set(1, { binding: '0'.repeat(64), enabled: true })
  await assert.rejects(manager.connectManual(1, next.token), /expired/)
  state.sources.get(1)!.enabled = false
  await assert.rejects(manager.inspectManual(1, manifest.endpoints[0].url), /Turn on/)
  assert.equal(state.reads, 0)
})

test('a late manual sign-in cannot undo disabling Stratum', async t => {
  const { state, manager, manifest } = await fixture(t)
  const checked = await manager.inspectManual(1, manifest.endpoints[0].url)
  let release!: () => void
  state.hold = new Promise(resolve => { release = resolve })
  const pending = manager.connectManual(1, checked.token)
  const rejected = assert.rejects(pending)
  for (let i = 0; !state.creates && i < 100; i++) await delay(10)
  assert.equal(state.creates, 1)
  await manager.setEnabled(1, false)
  release(); await rejected
  assert.equal(manager.status(1).enabled, false)
  assert.equal(manager.cachedConnection(1), null)
})

test('failed manual sign-in and save retain the previous saved connection', async t => {
  const { state, manager, manifest } = await fixture(t)
  await manager.discover(1); await manager.setEnabled(1, true)
  const previous = state.settings
  let checked = await manager.inspectManual(1, manifest.endpoints[0].url)
  state.signInStatus = 401
  await assert.rejects(manager.connectManual(1, checked.token))
  assert.equal(state.settings, previous)
  state.signInStatus = 201
  checked = await manager.inspectManual(1, manifest.endpoints[0].url)
  state.writeFails = true
  await assert.rejects(manager.connectManual(1, checked.token), /save/)
  assert.equal(state.settings, previous)
  assert.equal(manager.status(1).connection, 'discovery')
  assert.ok(await manager.connection(1, signal()))
})

test('forgetting a manual connection restores discovery without enabling or signing in', async t => {
  const { state, manager, manifest } = await fixture(t)
  const checked = await manager.inspectManual(1, manifest.endpoints[0].url)
  await manager.connectManual(1, checked.token)
  const reads = state.reads
  const status = await manager.forgetManual(1)
  assert.equal(status.state, 'available'); assert.equal(status.enabled, false)
  assert.equal(status.connection, 'discovery'); assert.equal(state.reads, reads)
  assert.equal(manager.cachedConnection(1), null)
})

test('manual checks reject bad addresses, redirects and wrong public identities without signing in', async t => {
  const { state, manager, manifest } = await fixture(t)
  for (const value of ['http://127.0.0.1:7843', 'https://user:password@sidecar.test', 'https://sidecar.test?secret=x']) {
    await assert.rejects(manager.inspectManual(1, value))
  }
  state.redirect = true
  await assert.rejects(manager.inspectManual(1, manifest.endpoints[0].url), /302/)
  state.redirect = false
  const original = manifest.spkiSha256
  manifest.spkiSha256 = '0'.repeat(64)
  await assert.rejects(manager.inspectManual(1, manifest.endpoints[0].url), /identity/)
  manifest.spkiSha256 = original
  assert.equal(state.reads, 0); assert.equal(state.creates, 0)
})

test('manual trusted HTTPS keeps proxy verification and uses only the entered URL', async () => {
  const manifest = sample()
  const targets: unknown[] = []
  let closed = 0
  const result = await inspectManualSidecar('https://music.home.test:7843/base/', signal(), {
    identity: async () => ({ fingerprint: 'e'.repeat(64), trusted: true }),
    transport: (target, pin) => {
      targets.push({ target, pin })
      return { endpoint: target.url, close: () => { closed++ }, request: async (...args) => {
        assert.equal(args[0], '/access/v1/capabilities'); assert.equal(args[1], 'GET')
        assert.equal(args[3], undefined); assert.equal(args[4], undefined)
        return { bytes: Buffer.from(JSON.stringify({ ...capabilities(manifest), endpoints: ['https://untrusted.test'] })), type: 'application/json' }
      } }
    }
  })
  assert.equal(result.requiresTrust, false)
  assert.deepEqual(result.manifest.endpoints, [{ url: manifest.endpoints[0].url, trust: 'https_proxy' }])
  assert.equal(result.manifest.spkiSha256, manifest.spkiSha256, 'proxy certificate key can differ from the Sidecar key')
  assert.deepEqual(targets, [{ target: result.manifest.endpoints[0], pin: 'e'.repeat(64) }])
  assert.equal(closed, 1)
})

test('manual certificate inspection has a bounded, cancellable TLS handshake', async t => {
  const sockets = new Set<import('node:net').Socket>()
  const tcp = createTcpServer(socket => { sockets.add(socket); socket.resume(); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => tcp.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); tcp.close(() => resolve()) }))
  await assert.rejects(inspectSidecarIdentity(`https://127.0.0.1:${(tcp.address() as { port: number }).port}`, AbortSignal.timeout(80)),
    /too long to establish a secure connection/)
})
