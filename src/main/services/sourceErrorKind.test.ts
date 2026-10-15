import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import test from 'node:test'
import { JellyfinHttpError, testJellyfinConnection } from './jellyfin.ts'
import { connectPlexServer, PlexAccessError, PlexRequestError } from './plex.ts'
import { classifySourceError, isSignInFailure } from './sourceErrorKind.ts'
import { SubsonicRequestError, testSubsonicConnection } from './subsonic.ts'

/** A local server answering every request with `respond`; `null` never answers. */
async function withServer(respond: ((req: IncomingMessage, res: ServerResponse) => void) | null,
  run: (baseUrl: string) => Promise<void>): Promise<void> {
  const sockets = new Set<Socket>()
  const server = createServer((req, res) => { if (respond) respond(req, res) })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`) }
  finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}

/** A loopback address nothing listens on. */
async function closedAddress(): Promise<string> {
  let address = ''
  await withServer(null, async baseUrl => { address = baseUrl })
  return address
}

const subsonicAnswer = (body: unknown, status = 200) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
}
const plain = (status: number, body = '<html>Not here</html>', type = 'text/html') => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { 'Content-Type': type }); res.end(body)
}

async function subsonicFailure(baseUrl: string, timeoutMs = 2000): Promise<unknown> {
  return testSubsonicConnection({ baseUrl, username: 'listener', password: 'secret' }, { timeoutMs, retries: 0 }).then(
    () => assert.fail('the connection check should fail'), error => error)
}
async function jellyfinFailure(baseUrl: string): Promise<unknown> {
  return testJellyfinConnection({ baseUrl, username: 'listener', password: 'secret' }, { timeoutMs: 2000, retries: 0 }).then(
    () => assert.fail('the connection check should fail'), error => error)
}

const device = { clientId: 'device' }
const account = { ...device, accountId: 'person', username: 'Listener', token: 'account-secret' }
const plexServer = { id: 'server-id', name: 'Home', owned: true, token: 'server-secret', connections: [{ uri: 'https://server.example', local: true, relay: false }] }
async function plexFailure(fetch: (url: URL) => Response): Promise<unknown> {
  return connectPlexServer(account, plexServer, { fetch: ((input: any) => Promise.resolve().then(() => fetch(new URL(String(input))))) as typeof globalThis.fetch })
    .then(() => assert.fail('the connection should fail'), error => error)
}
const throwing = (error: Error) => () => { throw error }

test('a refused sign-in is "auth" for every provider, wherever it happens', async () => {
  const refusals: unknown[] = [
    new SubsonicRequestError('Wrong username or password', { apiCode: 40 }),
    new SubsonicRequestError('Token authentication not supported', { apiCode: 41 }),
    new SubsonicRequestError('User is not authorized', { apiCode: 50 }),
    new SubsonicRequestError('Subsonic request failed (401)', { httpStatus: 401 }),
    new JellyfinHttpError('Jellyfin authentication failed (401)', 401),
    new JellyfinHttpError('Jellyfin request failed (403)', 403),
    new PlexRequestError(401),
    new PlexRequestError(498),
    new PlexAccessError('This Plex account no longer has access to the server.')
  ]
  await withServer(subsonicAnswer({ 'subsonic-response': { status: 'failed', error: { code: 40, message: 'Wrong username or password' } } }),
    async baseUrl => { refusals.push(await subsonicFailure(baseUrl)) })
  await withServer(plain(401, ''), async baseUrl => { refusals.push(await jellyfinFailure(baseUrl)) })
  for (const error of refusals) {
    assert.equal(isSignInFailure(error), true, String(error))
    assert.equal(classifySourceError(error, 'connect'), 'auth')
    assert.equal(classifySourceError(error, 'sync'), 'auth')
  }
})

test('while connecting, a server that couldn\'t be reached is "unreachable"', async () => {
  const unreachable: unknown[] = [
    new SubsonicRequestError('Subsonic request failed (502)', { httpStatus: 502 }),
    new JellyfinHttpError('Jellyfin request failed (503)', 503),
    new PlexRequestError(504),
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  ]
  // Nothing listening, and a server that never answers (the client's timeout aborts).
  const closed = await closedAddress()
  unreachable.push(await subsonicFailure(closed), await jellyfinFailure(closed))
  await withServer(null, async baseUrl => { unreachable.push(await subsonicFailure(baseUrl, 150)) })
  // A proxy in front of a server that's down.
  await withServer(plain(502), async baseUrl => { unreachable.push(await subsonicFailure(baseUrl), await jellyfinFailure(baseUrl)) })
  // Plex: no address connects, or none resolves.
  unreachable.push(await plexFailure(throwing(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))))
  unreachable.push(await plexFailure(throwing(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }))))
  for (const error of unreachable) {
    assert.equal(classifySourceError(error, 'connect'), 'unreachable', String(error))
    // Once connected, a failure is a sync problem for that attempt (the next connect decides).
    assert.equal(classifySourceError(error, 'sync'), 'sync', String(error))
  }
})

test('a server that answered with an error keeps it: "sync", not offline', async () => {
  const answered: unknown[] = [
    new SubsonicRequestError('Required parameter is missing', { apiCode: 10 }),
    new JellyfinHttpError('Jellyfin request failed (500)', 500),
    new PlexRequestError(500),
    // Node's fetch got no response because this computer doesn't trust the certificate.
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } })
  ]
  // The protocol versions don't match.
  await withServer(subsonicAnswer({ 'subsonic-response': { status: 'failed', error: { code: 20, message: 'Incompatible Subsonic REST protocol version. Client must upgrade.' } } }),
    async baseUrl => {
      const error = await subsonicFailure(baseUrl)
      assert.match(String(error), /Client must upgrade/)
      answered.push(error)
    })
  // Not a Subsonic or Jellyfin server: a web page, a broken envelope, a missing endpoint, a server error.
  await withServer(plain(200), async baseUrl => { answered.push(await subsonicFailure(baseUrl), await jellyfinFailure(baseUrl)) })
  await withServer(plain(200, '{}', 'application/json'), async baseUrl => { answered.push(await subsonicFailure(baseUrl), await jellyfinFailure(baseUrl)) })
  await withServer(plain(404), async baseUrl => { answered.push(await subsonicFailure(baseUrl), await jellyfinFailure(baseUrl)) })
  await withServer(plain(500), async baseUrl => { answered.push(await subsonicFailure(baseUrl), await jellyfinFailure(baseUrl)) })
  // Plex: an untrusted certificate, the wrong server, or an answer it couldn't read.
  answered.push(await plexFailure(throwing(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } }))))
  answered.push(await plexFailure(() => new Response(JSON.stringify({ MediaContainer: { machineIdentifier: 'other' } }))))
  answered.push(await plexFailure(() => new Response('<html></html>')))
  for (const error of answered) {
    assert.equal(isSignInFailure(error), false, String(error))
    assert.equal(classifySourceError(error, 'connect'), 'sync', String(error))
    assert.equal(classifySourceError(error, 'sync'), 'sync', String(error))
  }
})

test('Plex keeps an address\'s HTTP error while it tries the others', async () => {
  const refused = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }
  const status = (code: number) => () => new Response('', { status: code })
  // An address answered with an error: that status, not "unavailable". It isn't a
  // PlexRequestError, which callers read as the requested item's status.
  for (const code of [404, 429, 500]) {
    const error = await plexFailure(status(code))
    assert.match(String(error), new RegExp(`answered with an error \\(HTTP ${code}\\)`))
    assert.equal(error instanceof PlexRequestError, false)
    assert.equal(classifySourceError(error, 'connect'), 'sync')
  }
  // A gateway saying the server is down is still unavailable.
  for (const code of [502, 503, 504]) {
    const error = await plexFailure(status(code))
    assert.match(String(error), /This Plex server is unavailable/)
    assert.equal(classifySourceError(error, 'connect'), 'unreachable')
  }
  // Two addresses: the local one answers 500, the remote one is refused. The 500 is kept.
  const twoAddresses = { ...plexServer, connections: [{ uri: 'https://local.example', local: true, relay: false }, { uri: 'https://remote.example', local: false, relay: false }] }
  const respond = (byHost: Record<string, () => Response>) => ((input: any) => Promise.resolve().then(() => byHost[new URL(String(input)).hostname]())) as typeof globalThis.fetch
  const kept = await connectPlexServer(account, twoAddresses, { fetch: respond({ 'local.example': status(500), 'remote.example': refused }) })
    .then(() => assert.fail('neither address works'), error => error)
  assert.match(String(kept), /HTTP 500/)
  assert.equal(classifySourceError(kept, 'connect'), 'sync')
  // And when another address works, it connects there.
  const connected = await connectPlexServer(account, twoAddresses, { fetch: respond({ 'local.example': status(500),
    'remote.example': () => new Response(JSON.stringify({ MediaContainer: { machineIdentifier: plexServer.id } })) }) })
  assert.equal(connected.baseUrl, 'https://remote.example')
})
