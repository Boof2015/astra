import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { StratumProofSession } from './stratumProofSession.ts'
import { StratumProofClient } from './stratumProofClient.ts'

const password = 'disposable-test-password'
const bearer = 'a'.repeat(64)
const signal = () => AbortSignal.timeout(4000)
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(t: TestContext) {
  const state = { creates: 0, renews: 0, deletes: 0, passwords: 0, media: 0, ttl: 1, status: 200,
    malformed: false, rotated: false, supported: true, username: 'listener', salts: new Set<string>(),
    hold: undefined as ReturnType<typeof gate> | undefined, reached: gate() }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    assert.ok(!raw.includes(password)); assert.ok(!req.url?.includes(bearer))
    if (req.url === '/access/v1/capabilities') {
      assert.equal(req.headers.authorization, undefined)
      res.end(JSON.stringify({ protocol: 'stratum-access-proof-1', audioExperiment: 'stratum-authenticated-audio-1',
        authentication: 'subsonic-token', sessionRenewal: state.supported ? 'fresh-credentials-same-user' : undefined })); return
    }
    if (req.method === 'DELETE') {
      assert.equal(req.headers.authorization, `Bearer ${bearer}`)
      state.deletes++; res.writeHead(204); res.end(); return
    }
    if (req.url?.startsWith('/audio/')) {
      state.media++; res.writeHead(401); res.end('SECRET-UPSTREAM-ERROR'); return
    }
    assert.equal(req.headers['content-type'], 'application/json')
    const value = JSON.parse(raw)
    assert.equal(value.username, 'listener')
    assert.equal(value.token, createHash('md5').update(password + value.salt).digest('hex'))
    assert.ok(!state.salts.has(value.salt), 'each exchange needs a fresh salt')
    state.salts.add(value.salt)
    if (req.url === '/access/v1/sessions') {
      assert.equal(req.headers.authorization, undefined); state.creates++
    } else {
      assert.equal(req.url, '/access/v1/session')
      assert.equal(req.headers.authorization, `Bearer ${bearer}`); state.renews++
    }
    state.reached.resolve()
    if (state.hold) await state.hold.promise
    res.writeHead(state.status)
    res.end(state.malformed ? 'SECRET-MALFORMED-RESPONSE' : JSON.stringify({
      session: state.rotated ? 'b'.repeat(64) : bearer, expiresInSeconds: state.ttl
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const owner = new StratumProofSession(endpoint, async () => {
    state.passwords++; return { username: state.username, password }
  })
  t.after(async () => { state.hold?.resolve(); await owner.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { owner, state, endpoint }
}

test('current and next share one login; cancelling one waiter does not cancel the other', { timeout: 6000 }, async t => {
  const { owner, state } = await fixture(t)
  state.hold = gate()
  const cancelled = new AbortController()
  const first = owner.getBearer(cancelled.signal)
  const rejected = assert.rejects(first, /cancelled/)
  const next = owner.getBearer(signal())
  await state.reached.promise
  cancelled.abort()
  await rejected
  state.hold.resolve()
  assert.equal(await next, bearer)
  assert.equal(state.creates, 1); assert.equal(state.passwords, 1)
  assert.equal(owner.signal.aborted, false)
})

test('idle connection renews ahead of expiry with fresh credentials and the same bearer', { timeout: 6000 }, async t => {
  const { owner, state } = await fixture(t)
  assert.equal(await owner.getBearer(signal()), bearer)
  await delay(1250)
  assert.equal(await owner.getBearer(signal()), bearer)
  assert.equal(state.creates, 1)
  assert.ok(state.renews >= 2)
  assert.equal(state.passwords, state.renews + 1)
  await owner.close()
  assert.equal(state.deletes, 1)
  await assert.rejects(owner.getBearer(signal()), /ended/)
})

test('closing during renewal cannot publish the late answer or restart login', { timeout: 6000 }, async t => {
  const { owner, state } = await fixture(t)
  await owner.getBearer(signal())
  state.hold = gate(); state.reached = gate()
  await state.reached.promise
  const pending = owner.getBearer(signal())
  const failed = assert.rejects(pending, /cancelled|ended/)
  await owner.close()
  state.hold.resolve()
  await failed
  await assert.rejects(owner.getBearer(signal()), /ended/)
  assert.equal(state.creates, 1); assert.equal(state.renews, 1)
})

test('refused renewal ends the connection without silently reauthenticating old handles', { timeout: 6000 }, async t => {
  const { owner, state } = await fixture(t)
  await owner.getBearer(signal())
  state.status = 401
  await delay(650)
  assert.equal(owner.signal.aborted, true)
  await assert.rejects(owner.getBearer(signal()), /sign-in expired/)
  assert.equal(state.creates, 1); assert.equal(state.renews, 1)
})

test('an expired pending renewal fails rather than reviving the session', { timeout: 6000 }, async t => {
  const { owner, state } = await fixture(t)
  await owner.getBearer(signal())
  state.hold = gate()
  await delay(1150)
  assert.equal(owner.signal.aborted, true)
  state.hold.resolve()
  await assert.rejects(owner.getBearer(signal()))
  assert.equal(state.creates, 1)
})

test('unsupported service receives no sign-in; changed account is not sent during renewal', { timeout: 6000 }, async t => {
  const { owner, state, endpoint } = await fixture(t)
  state.supported = false
  await assert.rejects(owner.getBearer(signal()), /renewable sessions/)
  assert.equal(state.passwords, 0); assert.equal(state.creates, 0)
  state.supported = true
  const second = new StratumProofSession(endpoint, async () => ({ username: state.username, password }))
  t.after(() => second.close())
  await second.getBearer(signal())
  state.username = 'different-user'
  await delay(650)
  assert.equal(second.signal.aborted, true)
  assert.equal(state.renews, 0)
})

test('malformed replies and supplier errors never expose secret text', { timeout: 6000 }, async t => {
  const { owner, state, endpoint } = await fixture(t)
  state.malformed = true
  await assert.rejects(owner.getBearer(signal()), { message: 'Invalid Stratum session response.' })
  const second = new StratumProofSession(endpoint, async () => { throw new Error(password) })
  t.after(() => second.close())
  await assert.rejects(second.getBearer(signal()), { message: 'Could not read the disposable Navidrome sign-in.' })
})

test('renewal cannot replace the bearer underneath existing playback handles', { timeout: 6000 }, async t => {
  const { owner, state } = await fixture(t)
  await owner.getBearer(signal())
  state.rotated = true
  await delay(650)
  assert.equal(owner.signal.aborted, true)
  assert.equal(state.creates, 1)
})

test('media authorization failure invalidates the shared owner for all consumers', { timeout: 6000 }, async t => {
  const { owner, state } = await fixture(t)
  const current = new StratumProofClient(owner)
  const next = new StratumProofClient(owner)
  await assert.rejects(current.open('track', signal()), /sign-in expired/)
  await assert.rejects(next.open('track', signal()), /ended/)
  assert.equal(state.creates, 1); assert.equal(state.media, 1)
})

test('remote endpoints are rejected before a credential supplier can be called', () => {
  for (const endpoint of ['http://192.168.1.10:8000', 'https://music.example', 'http://localhost:8000',
    'http://127.0.0.1:8000/?token=secret', 'http://127.0.0.1:8000/path']) {
    assert.throws(() => new StratumProofSession(endpoint, async () => { assert.fail('must not read credentials') }), /loopback/)
  }
})
