import assert from 'node:assert/strict'
import test from 'node:test'
import { createJellyfinPlaybackClient, createSubsonicPlaybackClient } from './providerPlaybackClients.ts'
import type { PlaybackReport } from './providerPlayback.ts'
import packageMetadata from '../../../package.json' with { type: 'json' }

const base: PlaybackReport = { sessionId: 'play-one', path: 'subsonic://7/track/song%2Fid',
  state: 'playing', position: 12.345, duration: 180, startedAt: 1_800_000_000_000 }
const signal = () => new AbortController().signal
const ok = (extra = {}) => Response.json({ 'subsonic-response': { status: 'ok', ...extra } })

test('OpenSubsonic live timeline is capability-gated and never submits a counted play', async t => {
  const calls: URL[] = []
  t.mock.method(globalThis, 'fetch', async (input: URL, options: RequestInit) => {
    assert.equal(new Headers(options.headers).get('User-Agent'),
      `Astra/${packageMetadata.version} (${process.platform}; ${process.arch})`)
    const url = new URL(String(input)); calls.push(url)
    return ok({ type: 'navidrome', openSubsonicExtensions: [{ name: 'playbackReport', versions: [1] }] })
  })
  const client = createSubsonicPlaybackClient({ baseUrl: 'https://example.test/music', username: 'timeline', password: 'test' }, 'song/id')
  await client.start(base, signal())
  await client.progress({ ...base, state: 'paused' }, signal())
  await client.progress({ ...base, state: 'loading' }, signal())
  await client.progress({ ...base, position: 75 }, signal())
  await client.stop({ ...base, state: 'stopped' }, signal())
  assert.equal(calls.filter(url => url.pathname.includes('getOpenSubsonicExtensions')).length, 1)
  const live = calls.filter(url => url.pathname.includes('reportPlayback'))
  assert.deepEqual(live.map(url => url.searchParams.get('state')), ['starting', 'playing', 'paused', 'paused', 'playing', 'stopped'])
  for (const url of live) {
    assert.equal(url.searchParams.get('ignoreScrobble'), 'true')
    assert.equal(url.searchParams.get('mediaId'), 'song/id')
    assert.equal(url.searchParams.get('mediaType'), 'song')
    assert.equal(url.searchParams.get('playbackRate'), '1')
    assert.equal(url.pathname, '/music/rest/reportPlayback.view')
  }
  assert.equal(live[0].searchParams.get('positionMs'), '12345')
  assert.equal(live[4].searchParams.get('positionMs'), '75000')
  assert.equal(calls.some(url => url.pathname.includes('/scrobble')), false)
  await client.scrobble!(base, signal())
  assert.equal(calls.at(-1)?.searchParams.get('submission'), 'true')
  assert.equal(calls.at(-1)?.searchParams.get('time'), String(base.startedAt))
})

test('legacy Subsonic sends immediate and refreshed now-playing separately from its counted submission', async t => {
  const calls: URL[] = []
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    const url = new URL(String(input)); calls.push(url)
    if (url.pathname.includes('getOpenSubsonicExtensions')) return new Response('', { status: 404 })
    return ok()
  })
  const client = createSubsonicPlaybackClient({ baseUrl: 'https://example.test', username: 'legacy', password: 'test' }, 'song/id')
  await client.start(base, signal())
  await client.progress({ ...base, position: 25 }, signal())
  await client.progress({ ...base, state: 'paused' }, signal())
  await client.stop({ ...base, state: 'stopped' }, signal())
  const nowPlaying = calls.filter(url => url.pathname.includes('/scrobble'))
  assert.equal(nowPlaying.length, 2)
  assert.ok(nowPlaying.every(url => url.searchParams.get('submission') === 'false'))
  assert.ok(nowPlaying.every(url => !url.searchParams.has('position')))
  await client.scrobble!(base, signal())
  assert.equal(calls.at(-1)?.searchParams.get('submission'), 'true')
})

test('legacy Navidrome position is in seconds; unsupported extension versions are not assumed supported', async t => {
  const calls: URL[] = []
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    calls.push(new URL(String(input)))
    return ok({ type: 'navidrome', openSubsonicExtensions: [{ name: 'playbackReport', versions: [2] }] })
  })
  const client = createSubsonicPlaybackClient({ baseUrl: 'https://example.test', username: 'old-navi', password: 'test' }, 'song/id')
  await client.start(base, signal())
  await client.progress({ ...base, position: 75.9 }, signal())
  assert.equal(calls.at(-2)?.searchParams.get('position'), '12')
  assert.equal(calls.at(-1)?.searchParams.get('position'), '75')
  assert.equal(calls.at(-1)?.searchParams.get('submission'), 'false')
})

test('temporary capability discovery failures never downgrade to legacy requests or suppress later recovery', async t => {
  const calls: URL[] = []
  let available = false
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    const url = new URL(String(input)); calls.push(url)
    if (!available) return new Response('', { status: 503 })
    return ok({ type: 'navidrome', openSubsonicExtensions: [{ name: 'playbackReport', versions: [1] }] })
  })
  const client = createSubsonicPlaybackClient({ baseUrl: 'https://example.test', username: 'recover-capability', password: 'test' }, 'id')
  await assert.rejects(client.start(base, signal()), /503/)
  assert.equal(calls.length, 1)
  available = true
  await client.progress(base, signal())
  assert.deepEqual(calls.slice(2).map(url => url.searchParams.get('state')), ['starting', 'playing'])
  assert.ok(calls.every(url => !url.pathname.includes('/scrobble')))
})

test('Jellyfin reports start/progress/stop via authenticated POST and accepts empty 204 responses', async t => {
  const calls: { url: URL; body: Record<string, unknown>; headers: Headers }[] = []
  t.mock.method(globalThis, 'fetch', async (input: URL, options: RequestInit) => {
    calls.push({ url: new URL(String(input)), body: JSON.parse(String(options.body)), headers: new Headers(options.headers) })
    assert.equal(options.method, 'POST')
    return new Response(null, { status: 204 })
  })
  const client = createJellyfinPlaybackClient({ baseUrl: 'https://example.test/jellyfin', username: 'user', password: 'test' },
    'item-id', async () => ({ accessToken: 'secret-token', userId: 'user-id' }))
  await client.start(base, signal())
  await client.progress({ ...base, state: 'paused', position: 19.5 }, signal())
  await client.stop({ ...base, state: 'stopped', position: 21 }, signal())
  assert.deepEqual(calls.map(x => x.url.pathname), ['/jellyfin/Sessions/Playing', '/jellyfin/Sessions/Playing/Progress', '/jellyfin/Sessions/Playing/Stopped'])
  assert.equal(calls[0].body.PositionTicks, 123450000)
  assert.equal(calls[0].body.PlayMethod, 'DirectPlay')
  assert.equal(calls[0].body.ItemId, 'item-id')
  assert.equal(calls[0].body.CanSeek, true)
  assert.equal(calls[1].body.IsPaused, true)
  assert.equal(calls[2].body.PositionTicks, 210000000)
  assert.ok(calls.every(x => x.body.PlaySessionId === base.sessionId))
  assert.ok(calls.every(x => x.headers.get('X-Emby-Token') === 'secret-token' && x.url.search === ''))
  assert.ok(calls.every(x => x.headers.get('X-Emby-Authorization')?.includes(`Version="${packageMetadata.version}"`)))
  assert.ok(calls.every(x => x.headers.get('User-Agent') === `Astra/${packageMetadata.version} (${process.platform}; ${process.arch})`))
})

test('Jellyfin refreshes rejected auth once but does not retry ambiguous writes', async t => {
  let calls = 0
  let result = 401
  const refreshes: boolean[] = []
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (result === 401 && calls > 1) return new Response(null, { status: 204 })
    return new Response('', { status: result })
  })
  const client = createJellyfinPlaybackClient({ baseUrl: 'https://example.test', username: 'user', password: 'test' }, 'id',
    async (_signal, refresh) => { refreshes.push(refresh); return { accessToken: 'token', userId: 'user' } })
  await client.start(base, signal())
  assert.deepEqual(refreshes, [false, true])
  assert.equal(calls, 2)
  result = 500
  await assert.rejects(client.start(base, signal()), /500/)
  assert.equal(calls, 3)
})

test('counted submissions never retry and revoked credentials cannot publish queued reports', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('timeout after possible server acceptance') })
  let enabled = true
  const client = createSubsonicPlaybackClient({ baseUrl: 'https://example.test', username: 'failure', password: 'test' }, 'id', () => enabled)
  await assert.rejects(client.scrobble!(base, signal()), /timeout/)
  assert.equal(calls, 1)
  enabled = false
  await client.scrobble!(base, signal())
  await client.start(base, signal())
  assert.equal(calls, 1)
})
