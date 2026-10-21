import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createServer } from 'node:https'
import { createHash, X509Certificate } from 'node:crypto'
import { createParallaxTlsIdentity } from './parallaxSecurity.ts'
import { createStratumTransport } from './stratumTransport.ts'
import { discoverStratum, parseStratumManifest, verifyStratumCapabilities, type StratumManifest } from './stratumDiscovery.ts'
import { StratumConnections, stratumSourceBinding } from './stratumConnections.ts'
import { StratumProofClient } from './stratumProofClient.ts'

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
    if (state.redirect) { res.writeHead(302, { Location: '/redirected' }); res.end(); return }
    if (state.oversized) { res.end('x'.repeat(4097)); return }
    if (req.url === '/base/stratum/access/v1/capabilities') {
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
  return { state, manager, manifest, deps, transport: createStratumTransport(manifest.endpoints[0], spkiSha256) }
}

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
  await assert.rejects(proxy.request('/access/v1/sessions', 'POST', signal(), { secret: 'must-not-leak' }), /securely/)
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
