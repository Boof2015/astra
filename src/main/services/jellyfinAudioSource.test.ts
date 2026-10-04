import assert from 'node:assert/strict'
import test from 'node:test'
import { createJellyfinAudioSource } from './jellyfinAudioSource.ts'
import { remoteAudioCacheKey } from './remoteAudioCache.ts'

const connection = { baseUrl: 'https://music.example/jellyfin/', username: 'listener', password: 'secret' }
const options = { sourceId: 7, connection, trackId: 'song', revision: '1',
  authenticate: async () => ({ accessToken: 'token', userId: 'user' }) }

test('Jellyfin original audio uses static streaming and authenticates only when fetching bytes', async t => {
  let authentications = 0
  const signal = new AbortController().signal
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const url = new URL(input)
    assert.equal(url.pathname, '/jellyfin/Audio/song/stream')
    assert.deepEqual([...url.searchParams], [['static', 'true']])
    assert.equal(init.signal, signal)
    const headers = new Headers(init.headers)
    assert.equal(headers.get('X-Emby-Token'), 'token')
    assert.equal(headers.get('Accept-Encoding'), 'identity')
    return new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/flac' } })
  })
  const source = createJellyfinAudioSource({ ...options, authenticate: async (receivedSignal, refresh) => {
    authentications++
    assert.equal(receivedSignal, signal)
    assert.equal(refresh, false)
    return options.authenticate()
  } })
  assert.equal(authentications, 0)
  assert.equal(source.representation, 'original')
  assert.ok(!source.account.includes('secret'))
  assert.deepEqual(new Uint8Array(await (await source.open(signal)).arrayBuffer()), new Uint8Array([1, 2]))
  assert.equal(authentications, 1)
})

test('Jellyfin refreshes a rejected token once and releases the unauthorized response', async t => {
  const refreshes: boolean[] = []
  let cancelled = 0
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (_input: string, init: RequestInit) => {
    requests++
    assert.equal(new Headers(init.headers).get('X-Emby-Token'), requests === 1 ? 'old' : 'new')
    return new Response(new ReadableStream({ cancel: () => { cancelled++ } }), { status: 401 })
  })
  const source = createJellyfinAudioSource({ ...options, authenticate: async (_signal, refresh) => {
    refreshes.push(refresh)
    return { accessToken: refresh ? 'new' : 'old', userId: 'user' }
  } })
  const response = await source.open(new AbortController().signal)
  assert.equal(response.status, 401, 'the cache receives the final error, never a transcoded fallback')
  assert.deepEqual(refreshes, [false, true])
  assert.equal(requests, 2)
  assert.equal(cancelled, 1)
  await response.body!.cancel()
})

test('Jellyfin does not retry permissions failures or fetch after auth was cancelled', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 403 }))
  const source = createJellyfinAudioSource(options)
  assert.equal((await source.open(new AbortController().signal)).status, 403)
  assert.equal(fetch.mock.callCount(), 1)
  const controller = new AbortController()
  const cancelled = createJellyfinAudioSource({ ...options, authenticate: async () => {
    controller.abort()
    return options.authenticate()
  } })
  await assert.rejects(cancelled.open(controller.signal), { name: 'AbortError' })
  assert.equal(fetch.mock.callCount(), 1)
})

test('Jellyfin cache identity separates accounts, providers and audio revisions without depending on auth tokens', () => {
  const original = createJellyfinAudioSource(options)
  const key = remoteAudioCacheKey(original)
  const renewed = createJellyfinAudioSource({ ...options, authenticate: async () => ({ accessToken: 'renewed', userId: 'user' }) })
  assert.equal(remoteAudioCacheKey(renewed), key)
  for (const changed of [
    { ...original, provider: 'subsonic' },
    createJellyfinAudioSource({ ...options, sourceId: 8 }),
    createJellyfinAudioSource({ ...options, connection: { ...connection, username: 'another-listener' } }),
    createJellyfinAudioSource({ ...options, connection: { ...connection, baseUrl: 'https://another.example' } }),
    createJellyfinAudioSource({ ...options, revision: '2' })
  ]) assert.notEqual(remoteAudioCacheKey(changed), key)
})
