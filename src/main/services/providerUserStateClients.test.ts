import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchSubsonicUserStates, writeSubsonicUserState } from './subsonic.ts'
import { fetchJellyfinUserStates, writeJellyfinFavorite } from './jellyfin.ts'

const config = { baseUrl: 'https://example.test/music', username: 'test', password: 'test' }
const auth = { userId: 'user', accessToken: 'test-token' }
const ok = (value: object) => Response.json({ 'subsonic-response': { status: 'ok', ...value } })

test('Subsonic pages user states, retains explicit unfavorites/unrated, and reads a track again before writes', async t => {
  const urls: URL[] = []
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    const url = new URL(String(input)); urls.push(url)
    assert.match(new Headers(init.headers).get('User-Agent')!, /^Astra\//)
    if (url.pathname.endsWith('/getSong.view')) return ok({ song: { id: 'a', userRating: 2 } })
    const offset = url.searchParams.get('songOffset')
    assert.equal(url.searchParams.get('query'), '')
    return ok({ searchResult3: { song: offset === '0'
      ? [{ id: 'a', starred: '2026-01-01', userRating: 5 }, { id: 'b', userRating: 0 }] : [] } })
  })
  const state = await fetchSubsonicUserStates(config, {})
  assert.deepEqual(state.get('a'), { favorite: true, rating: 5 })
  assert.deepEqual(state.get('b'), { favorite: false, rating: null })
  assert.equal(urls[1].searchParams.get('songOffset'), '2')
  assert.deepEqual((await fetchSubsonicUserStates(config, {}, ['a'])).get('a'), { favorite: false, rating: 2 })
})

test('Subsonic rejects invalid rating data and repeated pagination instead of corrupting local state', async t => {
  let rating = 4.5
  t.mock.method(globalThis, 'fetch', async () => ok({ searchResult3: { song: [{ id: 'a', userRating: rating }] } }))
  await assert.rejects(fetchSubsonicUserStates(config, {}), /unsupported rating/)
  rating = 4
  await assert.rejects(fetchSubsonicUserStates(config, {}), /pagination/)
})

test('legacy Subsonic reads known tracks with bounded concurrency and leaves explicitly missing tracks unknown', async t => {
  const endpoints: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    const url = new URL(String(input)); endpoints.push(url.pathname)
    if (url.pathname.endsWith('/ping.view')) return ok({})
    if (url.searchParams.get('id') === 'missing') return Response.json({ 'subsonic-response': { status: 'failed', error: { code: 70, message: 'Not found' } } })
    return ok({ song: { id: url.searchParams.get('id'), userRating: 3 } })
  })
  const state = await fetchSubsonicUserStates(config, {}, undefined, ['a', 'missing'])
  assert.deepEqual(state.get('a'), { favorite: false, rating: 3 })
  assert.equal(state.has('missing'), false)
  assert.equal(endpoints.some(path => path.includes('search3')), false)
})

test('Subsonic star/unstar and integer/clear writes are separate and do not retry ambiguous failures', async t => {
  const urls: URL[] = []
  let fail = false
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    urls.push(new URL(String(input)))
    if (fail) throw new Error('network failure after possible acceptance')
    return ok({})
  })
  await writeSubsonicUserState(config, 'a/b', 'favorite', true, {})
  await writeSubsonicUserState(config, 'a/b', 'favorite', false, {})
  await writeSubsonicUserState(config, 'a/b', 'rating', 4, {})
  await writeSubsonicUserState(config, 'a/b', 'rating', null, {})
  assert.deepEqual(urls.map(u => u.pathname), ['/music/rest/star.view', '/music/rest/unstar.view', '/music/rest/setRating.view', '/music/rest/setRating.view'])
  assert.deepEqual(urls.slice(2).map(u => u.searchParams.get('rating')), ['4', '0'])
  await assert.rejects(writeSubsonicUserState(config, 'a', 'rating', 4.5, {}), /Invalid/)
  assert.equal(urls.length, 4)
  fail = true
  await assert.rejects(writeSubsonicUserState(config, 'a', 'favorite', true, {}), /network/)
  assert.equal(urls.length, 5)
})

test('Jellyfin favorites use authenticated POST/DELETE and only explicit favorite data is imported', async t => {
  const calls: { url: URL; method: string }[] = []
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    const url = new URL(String(input)); calls.push({ url, method: init.method! })
    assert.equal(new Headers(init.headers).get('X-Emby-Token'), 'test-token')
    if (init.method !== 'GET') return Response.json({ IsFavorite: init.method === 'POST' })
    if (url.pathname.endsWith('/Items/a')) return Response.json({ Id: 'a', UserData: { IsFavorite: true, Rating: 9 } })
    return Response.json({ Items: url.searchParams.get('StartIndex') === '0' ? [{ Id: 'a', UserData: { IsFavorite: false, Rating: 9 } }] : [] })
  })
  const state = await fetchJellyfinUserStates(config, auth, {})
  assert.deepEqual(state.get('a'), { favorite: false }) // No unverified numeric rating mapping.
  assert.deepEqual((await fetchJellyfinUserStates(config, auth, {}, ['a'])).get('a'), { favorite: true })
  await writeJellyfinFavorite(config, auth, 'a', true, {})
  await writeJellyfinFavorite(config, auth, 'a', false, {})
  assert.deepEqual(calls.slice(-2).map(c => [c.url.pathname, c.method]), [
    ['/music/Users/user/FavoriteItems/a', 'POST'], ['/music/Users/user/FavoriteItems/a', 'DELETE']
  ])
  t.mock.method(globalThis, 'fetch', async () => Response.json({ Items: [{ Id: 'a' }] }))
  await assert.rejects(fetchJellyfinUserStates(config, auth, {}), /favorite state/)
})
