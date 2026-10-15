import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import test from 'node:test'
import { JellyfinHttpError, testJellyfinConnection } from './jellyfin.ts'
import { connectPlexServer, PlexAccessError, PlexRequestError } from './plex.ts'
import { classifySourceError, describeConnectionFailure, isSignInFailure, syncFailureMessage } from './sourceErrorKind.ts'
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

test('a failed connection check reads as a plain sentence that says what to fix', async () => {
  const said = (error: unknown, provider: 'subsonic' | 'jellyfin') => {
    const failure = describeConnectionFailure(error, provider)
    assert.doesNotMatch(failure.message, /fetch failed|request failed|authentication failed|payload/i, failure.message)
    return [failure.kind, failure.message]
  }
  const subsonicError = (code: number, message: string) => subsonicAnswer({ 'subsonic-response': { status: 'failed', error: { code, message } } })

  // Signing in
  await withServer(subsonicError(40, 'Wrong username or password'), async url => {
    assert.deepEqual(said(await subsonicFailure(url), 'subsonic'), ['auth', 'The server didn’t accept this username and password.'])
  })
  await withServer(plain(401, ''), async url => {
    assert.deepEqual(said(await jellyfinFailure(url), 'jellyfin'), ['auth', 'The server didn’t accept this username and password.'])
  })
  // A permission refusal isn't called a wrong password.
  await withServer(subsonicError(50, 'User is not authorized for the given operation.'), async url => {
    assert.deepEqual(said(await subsonicFailure(url), 'subsonic'), ['auth', 'The server didn’t allow this account to sign in.'])
  })
  await withServer(subsonicError(41, 'Token authentication not supported for LDAP users.'), async url => {
    assert.match(said(await subsonicFailure(url), 'subsonic')[1], /LDAP/)
  })

  // Reaching it
  const closed = await closedAddress()
  for (const provider of ['subsonic', 'jellyfin'] as const) {
    const error = provider === 'subsonic' ? await subsonicFailure(closed) : await jellyfinFailure(closed)
    assert.deepEqual(said(error, provider), ['unreachable', 'The server refused the connection. Check the address and port, and that the server is running.'])
  }
  await withServer(null, async url => {
    assert.deepEqual(said(await subsonicFailure(url, 150), 'subsonic'), ['unreachable', 'The server didn’t respond. Check that it’s running and reachable from this computer.'])
  })
  await withServer(plain(503), async url => {
    assert.deepEqual(said(await jellyfinFailure(url), 'jellyfin'), ['unreachable', 'The server is unavailable right now (HTTP 503).'])
  })
  assert.deepEqual(said(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), 'subsonic'),
    ['unreachable', 'No server was found at that address. Check the address.'])
  assert.deepEqual(said(Object.assign(new TypeError('fetch failed'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }), 'jellyfin'),
    ['certificate', 'The server’s security certificate isn’t trusted by this computer.'])

  // The wrong kind of server, or the wrong path
  await withServer(plain(200), async url => {
    assert.deepEqual(said(await subsonicFailure(url), 'subsonic'), ['not-server', 'The server answered, but not as a Subsonic or Navidrome server. Check the address, including any path.'])
    assert.deepEqual(said(await jellyfinFailure(url), 'jellyfin'), ['not-server', 'The server answered, but not as a Jellyfin server. Check the address, including any path (like /jellyfin).'])
  })
  await withServer(plain(404), async url => {
    assert.equal(said(await subsonicFailure(url), 'subsonic')[0], 'not-server')
    assert.equal(said(await jellyfinFailure(url), 'jellyfin')[0], 'not-server')
  })
  await withServer(plain(200, '{}', 'application/json'), async url => {
    assert.equal(said(await subsonicFailure(url), 'subsonic')[0], 'not-server')
    assert.equal(said(await jellyfinFailure(url), 'jellyfin')[0], 'not-server')
  })

  // The server's own answer is kept
  await withServer(subsonicError(20, 'Incompatible Subsonic REST protocol version. Client must upgrade.'), async url => {
    assert.deepEqual(said(await subsonicFailure(url), 'subsonic'),
      ['incompatible', 'Astra and the server don’t use compatible Subsonic versions. The server said: “Incompatible Subsonic REST protocol version. Client must upgrade.”'])
  })
  await withServer(subsonicError(60, 'The trial period for the Subsonic server is over.'), async url => {
    assert.deepEqual(said(await subsonicFailure(url), 'subsonic'), ['server-error', 'The server said: “The trial period for the Subsonic server is over.”'])
  })
  await withServer(plain(500), async url => {
    assert.deepEqual(said(await subsonicFailure(url), 'subsonic'), ['server-error', 'The server answered with an error (HTTP 500).'])
    assert.deepEqual(said(await jellyfinFailure(url), 'jellyfin'), ['server-error', 'The server answered with an error (HTTP 500).'])
  })
  // Anything else keeps its message (here, the address check before any request).
  assert.deepEqual(said(new Error('Server URL must use http:// or https://'), 'subsonic'), ['other', 'Server URL must use http:// or https://'])
})

test('a stored sync failure only rewords what the server never said', () => {
  const dropped = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
  assert.equal(syncFailureMessage(dropped, 'subsonic', 'sync'), 'The connection to the server failed. Check the address and your network.')
  assert.equal(syncFailureMessage(new Error('Server returned an incomplete playlist.'), 'subsonic', 'sync'), 'Server returned an incomplete playlist.')
  assert.equal(syncFailureMessage(new JellyfinHttpError('Jellyfin request failed (500)', 500), 'jellyfin', 'connect'), 'The server answered with an error (HTTP 500).')
  assert.equal(syncFailureMessage(Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }), 'jellyfin', 'sync'),
    'The server’s security certificate isn’t trusted by this computer.')
})

test('https:// to a plain-HTTP port is a secure-connection problem, not an untrusted certificate or an offline server', async () => {
  await withServer(plain(200), async url => {
    const secureUrl = url.replace('http://', 'https://')
    for (const provider of ['subsonic', 'jellyfin'] as const) {
      const error = provider === 'subsonic' ? await subsonicFailure(secureUrl) : await jellyfinFailure(secureUrl)
      assert.deepEqual(describeConnectionFailure(error, provider), { kind: 'secure-connection',
        message: 'Astra couldn’t set up a secure connection. If the server doesn’t use HTTPS, start the address with http:// instead.' }, String((error as any).cause?.code))
      // The server answered, so it isn't offline: the page shows this reason instead of retry advice.
      assert.equal(classifySourceError(error, 'connect'), 'sync')
      assert.match(syncFailureMessage(error, provider, 'connect'), /start the address with http:\/\//)
    }
  })
  // A real certificate problem, including a name mismatch, still says so.
  for (const code of ['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
    assert.equal(describeConnectionFailure(Object.assign(new TypeError('fetch failed'), { cause: { code } }), 'subsonic').kind, 'certificate', code)
  }
})

test('a sign-in refused partway through a sync is stored in plain words too', () => {
  assert.equal(syncFailureMessage(new JellyfinHttpError('Jellyfin request failed (401)', 401), 'jellyfin', 'sync'), 'The server didn’t accept this username and password.')
  assert.equal(syncFailureMessage(new SubsonicRequestError('User is not authorized for the given operation.', { apiCode: 50 }), 'subsonic', 'sync'),
    'The server didn’t allow this account to sign in.')
})
