import assert from 'node:assert/strict'
import test from 'node:test'
import { beginPlexSignIn, createPlexDevice, pollPlexSignIn,
  discoverPlexServers, connectPlexServer, listPlexLibraries, fetchPlexCatalog, mapPlexTrack,
  plexUrl, PlexRequestError, reportPlexPlayback, fetchPlexUserStates, writePlexRating, type PlexCredentials } from './plex.ts'
import { createPlexAudioSource } from './plexAudioSource.ts'
import { remoteAudioCacheKey } from './remoteAudioCache.ts'
import { playbackReportSource } from './providerPlayback.ts'
import { retainedRemoteSourceFromPath } from '../../shared/audio/retainedRemoteSource.ts'
import { parseStreamingQualitySettings, resolveStreamingQuality, streamingQualitySourceFromPath } from '../../types/streamingQuality.ts'

const device = createPlexDevice()
const account = { ...device, accountId: 'person', username: 'Listener', token: 'account-secret' }
const server = { id: 'server-id', name: 'Home', owned: true, token: 'server-secret', connections: [{ uri: 'https://server.example', local: true, relay: false }] }
const credentials: PlexCredentials = { account, server, baseUrl: 'https://server.example' }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const mockFetch = (fn: (url: URL, init: RequestInit) => Response | Promise<Response>) =>
  ((input: any, init: RequestInit = {}) => Promise.resolve(fn(new URL(String(input)), init))) as typeof fetch
const fixture = (id: number) => ({ type: 'track', ratingKey: String(id), title: `Track ${id}`, grandparentTitle: 'Artist', parentTitle: 'Album',
  duration: 310000, index: id, parentIndex: 1, parentYear: 2026, parentThumb: '/library/metadata/50/thumb/42',
  Media: [{ container: 'flac', bitrate: 1400, audioChannels: 2, Part: [{ key: `/library/parts/${id}/123/file.flac`, Stream: [{ streamType: 2, codec: 'flac', samplingRate: 44100, bitDepth: 16 }] }] }] })

test('Plex browser PIN requests a traditional token compatible with PMS', async () => {
  const pin = await beginPlexSignIn(device, { fetch: mockFetch((url, init) => {
    assert.equal(url.pathname, '/api/v2/pins')
    assert.deepEqual(JSON.parse(String(init.body)), { strong: true })
    assert.equal(init.method, 'POST')
    assert.equal(new Headers(init.headers).get('X-Plex-Client-Identifier'), device.clientId)
    assert.equal(init.redirect, 'error')
    return json({ id: 9, code: 'code', expiresAt: new Date(Date.now() + 60000).toISOString() })
  }) })
  assert.equal(new URL(pin.url).origin, 'https://app.plex.tv')
  assert.ok(!pin.url.includes('PRIVATE')); assert.ok(!pin.url.includes('secret'))
  const parameters = new URLSearchParams(new URL(pin.url).hash.slice(2))
  assert.equal(parameters.get('clientID'), device.clientId)
  assert.equal(parameters.get('code'), 'code')
})

test('Plex PIN polling waits, then obtains account identity without exposing passwords', async () => {
  let approved = false
  const fetch = mockFetch((url, init) => {
    if (url.pathname.includes('/pins/')) { assert.equal(url.search, ''); return json({ authToken: approved ? 'token' : null }) }
    assert.equal(new Headers(init.headers).get('X-Plex-Token'), 'token')
    return json({ id: 77, username: 'Listener' })
  })
  assert.equal(await pollPlexSignIn(device, 9, { fetch }), null)
  approved = true
  const result = await pollPlexSignIn(device, 9, { fetch })
  assert.equal(result?.accountId, '77'); assert.equal(result?.clientId, device.clientId)
})

test('Plex discovery distinguishes account/server tokens and filters invalid endpoints', async () => {
  const servers = await discoverPlexServers(account, { fetch: mockFetch((_url, init) => {
    assert.equal(new Headers(init.headers).get('X-Plex-Token'), 'account-secret')
    return json([{ provides: 'player', clientIdentifier: 'player' }, { provides: 'server', clientIdentifier: server.id, name: 'Home', accessToken: 'server-secret', owned: true,
      connections: [{ uri: 'file:///tmp/library' }, { uri: 'https://name:password@example.org' }, { uri: 'https://server.example/?X-Plex-Token=bad' },
        { uri: 'https://relay.example', relay: true }, { uri: 'https://remote.example' }, { uri: 'https://local.example', local: true }] }])
  }) })
  assert.equal(servers.length, 1); assert.equal(servers[0].connections.length, 3)
  const tried: string[] = []
  const connected = await connectPlexServer(account, servers[0], { fetch: mockFetch((url, init) => {
    tried.push(url.hostname)
    assert.equal(new Headers(init.headers).get('X-Plex-Token'), 'server-secret')
    if (url.hostname === 'local.example') throw new Error('offline with sensitive URL')
    return json({ MediaContainer: { machineIdentifier: server.id } })
  }) })
  assert.deepEqual(tried, ['local.example', 'remote.example'])
  assert.equal(connected.baseUrl, 'https://remote.example')
  assert.throws(() => plexUrl(credentials.baseUrl, 'https://other.example/file'))
})

test('Plex rejects wrong-server identity and sanitizes authentication errors', async () => {
  await assert.rejects(connectPlexServer(account, server, { fetch: mockFetch(() => json({ MediaContainer: { machineIdentifier: 'other' } })) }), /did not match/)
  await assert.rejects(connectPlexServer(account, server, { fetch: mockFetch(() => new Response('secret detail', { status: 401 })) }), error =>
    error instanceof PlexRequestError && error.status === 401 && !error.message.includes('secret'))
})

test('Plex reports certificate and DNS connection failures without exposing upstream details', async () => {
  for (const [code, expected] of [['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', /trusted secure connection/], ['ENOTFOUND', /could not be resolved/]] as const) {
    await assert.rejects(connectPlexServer(account, server, { fetch: mockFetch(() => {
      throw Object.assign(new Error('https://private.example/?X-Plex-Token=secret'), { cause: { code } })
    }) }), error => error instanceof Error && expected.test(error.message) && !/secret|private\.example/.test(error.message))
  }
  await assert.rejects(connectPlexServer(account, server, { fetch: mockFetch(() => {
    throw new Error('net::ERR_CERT_AUTHORITY_INVALID at https://private.example/?X-Plex-Token=secret')
  }) }), /trusted secure connection/)
})

test('Plex secure LAN discovery succeeds without any remote or relay connection', async () => {
  const local = { ...server, connections: [{ uri: 'https://192-168-1-20.fixture.plex.direct:32400', local: true, relay: false }] }
  const result = await connectPlexServer(account, local, { fetch: mockFetch((url, init) => {
    assert.equal(url.hostname, '192-168-1-20.fixture.plex.direct')
    assert.equal(init.redirect, 'error')
    return json({ MediaContainer: { machineIdentifier: server.id } })
  }) })
  assert.equal(result.baseUrl, local.connections[0].uri)
})

test('Plex lists only Music libraries and maps catalog metadata', async () => {
  const choices = await listPlexLibraries(credentials, { fetch: mockFetch(() => json({ MediaContainer: { Directory: [
    { key: '1', type: 'movie', title: 'Films' }, { key: '2', type: 'artist', title: 'Music' }
  ] } })) })
  assert.deepEqual(choices, [{ id: '2', name: 'Music' }])
  const track = mapPlexTrack(4, fixture(3))!
  assert.equal(track.path, 'plex://4/3'); assert.equal(track.duration, 310)
  assert.equal(track.sample_rate, 44100); assert.equal(track.bit_depth, 16)
  assert.equal(track.artist, 'Artist'); assert.equal(track.album, 'Album')
  assert.deepEqual(playbackReportSource(track.path), { provider: 'plex', sourceId: 4, trackId: '3' })
  assert.equal(retainedRemoteSourceFromPath(track.path), 'plex')
  assert.equal(resolveStreamingQuality(parseStreamingQualitySettings('{"overrides":{"plex:4":64}}'), streamingQualitySourceFromPath(track.path)!), 64)
})

test('Plex catalog consumes all pages and refuses incomplete or repeated pages', async () => {
  const starts: number[] = []
  const tracks = await fetchPlexCatalog(4, credentials, '2', { fetch: mockFetch((_url, init) => {
    const start = Number(new Headers(init.headers).get('X-Plex-Container-Start')); starts.push(start)
    return json({ MediaContainer: { offset: start, totalSize: 3, Metadata: start === 0 ? [fixture(1), fixture(2)] : [fixture(3)] } })
  }) })
  assert.deepEqual(starts, [0, 2]); assert.equal(tracks.length, 3)
  let call = 0
  await assert.rejects(fetchPlexCatalog(4, credentials, '2', { fetch: mockFetch(() => json({ MediaContainer: {
    totalSize: 3, size: call++ ? 0 : 1, Metadata: call === 1 ? [fixture(1)] : [] } })) }), /incomplete/)
  await assert.rejects(fetchPlexCatalog(4, credentials, '2', { fetch: mockFetch(() => json({ MediaContainer: { offset: 0, totalSize: 10, Metadata: [fixture(1)] } })) }), /inconsistent/)
  assert.deepEqual(await fetchPlexCatalog(4, credentials, '2', { fetch: mockFetch(() => json({ MediaContainer: { size: 0, totalSize: 0 } })) }), [])
})

const audioOptions = { sourceId: 4, accountId: account.accountId, serverId: server.id, libraryId: '2', trackId: '3', revision: '1', credentials: async () => credentials }
test('Plex uses the selected validating transport for original metadata, audio and converted streams', async t => {
  // Reproduce the production failure: Node rejects the certificate even though
  // the browser transport validates it. No request may accidentally use Node.
  t.mock.method(globalThis, 'fetch', async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } })
  })
  const requests: string[] = []
  const browserFetch = mockFetch((url, init) => {
    requests.push(url.pathname)
    assert.equal(new Headers(init.headers).get('X-Plex-Token'), 'server-secret')
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal)
    if (url.pathname === '/library/metadata/3') return json({ MediaContainer: { Metadata: [fixture(3)] } })
    return new Response('audio')
  })
  for (const quality of ['original', 64] as const) {
    const source = createPlexAudioSource({ ...audioOptions, quality, fetch: browserFetch })
    assert.equal(await (await source.open(new AbortController().signal)).text(), 'audio')
  }
  assert.deepEqual(requests, ['/library/metadata/3', '/library/parts/3/123/file.flac', '/music/:/transcode/universal/start.ogg'])
})

test('Plex original resolves a part only on cache miss and keeps credentials out of identity/URLs', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', mockFetch((url, init) => {
    calls++
    assert.equal(new Headers(init.headers).get('X-Plex-Token'), 'server-secret')
    assert.equal(url.searchParams.get('X-Plex-Token'), null)
    return url.pathname.startsWith('/library/metadata/') ? json({ MediaContainer: { Metadata: [fixture(3)] } }) : new Response('original')
  }))
  const source = createPlexAudioSource(audioOptions)
  assert.equal(calls, 0); assert.equal(source.representation, 'original'); assert.ok(!source.account.includes('secret'))
  assert.equal(await (await source.open(new AbortController().signal)).text(), 'original'); assert.equal(calls, 2)
})

test('Plex refreshes expired metadata auth once and refuses off-server parts', async t => {
  const forced: boolean[] = []
  let calls = 0
  t.mock.method(globalThis, 'fetch', mockFetch(url => {
    if (++calls === 1) return new Response(null, { status: 401 })
    return url.pathname.startsWith('/library/metadata/') ? json({ MediaContainer: { Metadata: [fixture(3)] } }) : new Response('audio')
  }))
  const source = createPlexAudioSource({ ...audioOptions, credentials: async (_signal, force) => { forced.push(force); return credentials } })
  await (await source.open(new AbortController().signal)).text()
  assert.deepEqual(forced, [false, true])
  t.mock.method(globalThis, 'fetch', mockFetch(() => json({ MediaContainer: { Metadata: [{ ...fixture(3), Media: [{ Part: [{ key: 'https://other.example/steal' }] }] }] } })))
  await assert.rejects(source.open(new AbortController().signal), /could not open/)
})

test('Plex reduced and compatibility streams use progressive codec profiles and distinct cache keys', async t => {
  for (const [quality, compatibility, codec] of [[64, undefined, 'opus'], ['original', 'flac', 'flac'], [128, 'mp3', 'mp3']] as const) {
    t.mock.method(globalThis, 'fetch', mockFetch((url, init) => {
      assert.equal(url.pathname, `/music/:/transcode/universal/start.${codec === 'opus' ? 'ogg' : codec}`)
      assert.equal(url.searchParams.get('protocol'), 'http')
      assert.equal(url.searchParams.get('directPlay'), '0')
      assert.equal(url.searchParams.get('musicBitrate'), codec === 'flac' ? null : String(quality))
      assert.ok(url.searchParams.get('X-Plex-Client-Profile-Extra')?.includes(`audioCodec=${codec}`))
      assert.equal(new Headers(init.headers).get('X-Plex-Token'), 'server-secret')
      return new Response('audio')
    }))
    const source = createPlexAudioSource({ ...audioOptions, quality, compatibility })
    assert.notEqual(remoteAudioCacheKey(source), remoteAudioCacheKey(createPlexAudioSource(audioOptions)))
    assert.equal(await (await source.open(new AbortController().signal)).text(), 'audio')
  }
})

test('Plex timeline sends actual position, output state and Astra identity', async () => {
  for (const state of ['playing', 'paused', 'loading', 'stopped']) await reportPlexPlayback(credentials, '3', { sessionId: 'play', state, position: 12.5, duration: 310 }, {
    fetch: mockFetch((url, init) => {
      assert.equal(init.method, 'POST'); assert.equal(url.pathname, '/:/timeline')
      assert.equal(url.searchParams.get('time'), '12500'); assert.equal(url.searchParams.get('duration'), '310000')
      assert.equal(url.searchParams.get('state'), state === 'loading' ? 'buffering' : state)
      assert.equal(new Headers(init.headers).get('X-Plex-Product'), 'Astra')
      assert.equal(new Headers(init.headers).get('X-Plex-Session-Identifier'), 'play')
      return new Response(null, { status: 204 })
    })
  })
})

test('Plex ratings read all library pages and preserve half-stars without inventing favorites', async () => {
  const starts: number[] = []
  const states = await fetchPlexUserStates(credentials, '2', { fetch: mockFetch((url, init) => {
    assert.equal(url.pathname, '/library/sections/2/all')
    assert.equal(url.searchParams.get('type'), '10')
    assert.equal(new Headers(init.headers).get('X-Plex-Token'), 'server-secret')
    const start = Number(new Headers(init.headers).get('X-Plex-Container-Start')); starts.push(start)
    return json({ MediaContainer: { offset: start, totalSize: 4, Metadata: start === 0
      ? [{ ...fixture(1), userRating: 9 }, { ...fixture(2), userRating: 1 }]
      : [{ ...fixture(3), userRating: 0 }, fixture(4)] } })
  }) })
  assert.deepEqual(starts, [0, 2])
  assert.deepEqual([...states], [['1', { rating: 4.5 }], ['2', { rating: 0.5 }], ['3', { rating: null }], ['4', { rating: null }]])
})

test('Plex single-track reads distinguish unrated, missing and moved tracks', async () => {
  const states = await fetchPlexUserStates(credentials, '2', { fetch: mockFetch(url => {
    const id = Number(url.pathname.split('/').at(-1))
    if (id === 2) return new Response(null, { status: 404 })
    return json({ MediaContainer: { Metadata: [{ ...fixture(id), librarySectionID: id === 3 ? 7 : 2 }] } })
  }) }, ['1', '2', '3', '1'])
  assert.deepEqual([...states], [['1', { rating: null }]])
  await assert.rejects(fetchPlexUserStates(credentials, '2', { fetch: mockFetch(() => json({ MediaContainer: { Metadata: [fixture(9)] } })) }, ['1']), /requested track/)
  await assert.rejects(fetchPlexUserStates(credentials, '2', { fetch: mockFetch(() => new Response(null, { status: 401 })) }, ['1']), error => error instanceof PlexRequestError && error.status === 401)
})

test('Plex malformed ratings and incomplete listings cannot be mistaken for clears', async () => {
  for (const raw of ['9', 9.5, -1, 11, false]) {
    await assert.rejects(fetchPlexUserStates(credentials, '2', { fetch: mockFetch(() => json({ MediaContainer: {
      totalSize: 1, Metadata: [{ ...fixture(1), userRating: raw }] } })) }), /unsupported rating/)
  }
  for (const response of [{}, { MediaContainer: {} }, { MediaContainer: { totalSize: 2, size: 0 } },
    { MediaContainer: { offset: 1, totalSize: 1, Metadata: [fixture(1)] } }]) {
    await assert.rejects(fetchPlexUserStates(credentials, '2', { fetch: mockFetch(() => json(response)) }), /incomplete|inconsistent/)
  }
  await assert.rejects(fetchPlexUserStates(credentials, '2', { fetch: mockFetch(() => json({ MediaContainer: {
    totalSize: 2, Metadata: [fixture(1)] } })) }), /repeated/)
  assert.deepEqual(await fetchPlexUserStates(credentials, '2', { fetch: mockFetch(() => json({ MediaContainer: { totalSize: 0, size: 0 } })) }), new Map())
})

test('Plex rating writes use server auth and the 0–10 scale, including empty-body clear responses', async () => {
  for (const [rating, expected] of [[0.5, '1'], [4.5, '9'], [5, '10'], [null, '0']] as const) {
    await writePlexRating(credentials, '3', rating, { fetch: mockFetch((url, init) => {
      assert.equal(url.pathname, '/:/rate')
      assert.equal(url.searchParams.get('identifier'), 'com.plexapp.plugins.library')
      assert.equal(url.searchParams.get('key'), '3')
      assert.equal(url.searchParams.get('rating'), expected)
      assert.equal(url.searchParams.get('X-Plex-Token'), null)
      assert.equal(init.method, 'PUT'); assert.equal(init.redirect, 'error')
      assert.equal(new Headers(init.headers).get('X-Plex-Token'), 'server-secret')
      assert.ok(init.signal)
      return new Response(null, { status: 204 })
    }) })
  }
  const noRequest = { fetch: mockFetch(() => { assert.fail('Invalid input must not send a request') }) }
  await assert.rejects(writePlexRating(credentials, '../1', 4, noRequest), /Invalid/)
  await assert.rejects(writePlexRating(credentials, '3', 4.75, noRequest), /Invalid/)
  await assert.rejects(fetchPlexUserStates(credentials, '2', noRequest, ['1', '../2']), /Invalid/)
  await assert.rejects(writePlexRating(credentials, '3', 4, { fetch: mockFetch(() => new Response('secret', { status: 403 })) }), error =>
    error instanceof PlexRequestError && error.status === 403 && !error.message.includes('secret'))
})
