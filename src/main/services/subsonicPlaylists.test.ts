import assert from 'node:assert/strict'
import test from 'node:test'
import { createSubsonicRemotePlaylist, listSubsonicRemotePlaylists, readSubsonicRemotePlaylist, writeSubsonicRemotePlaylist } from './subsonic.ts'
import { RemotePlaylists } from './remotePlaylists.ts'
import type { RemotePlaylistLocal, RemotePlaylistSnapshot } from '../../types/remotePlaylists.ts'
const config = { baseUrl: 'https://server.test', username: 'listener', password: 'secret' }
const ok = (value: object) => Response.json({ 'subsonic-response': { status: 'ok', ...value } })
const row = { id: 'mix', name: 'Mix', songCount: 3, owner: 'listener', entry: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }
const snapshot: RemotePlaylistSnapshot = { id: 'mix', name: 'Mix', writable: true,
  tracks: ['a', 'b', 'a'].map(id => ({ path: `subsonic://1/track/${id}` })) }

test('Subsonic creates a new empty playlist once and requires its server ID', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    calls++
    assert.equal(url.pathname, '/rest/createPlaylist.view')
    assert.equal(url.searchParams.get('name'), 'New & empty')
    assert.equal(url.searchParams.has('playlistId'), false)
    assert.equal(url.searchParams.has('songId'), false)
    return ok({ playlist: { ...row, id: 'new', name: 'New & empty', songCount: 0, entry: [] } })
  })
  assert.equal(await createSubsonicRemotePlaylist(config, 'New & empty'), 'new')
  assert.equal(calls, 1)
  calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return ok({}) })
  await assert.rejects(createSubsonicRemotePlaylist(config, 'Legacy'), /playlist ID/)
  assert.equal(calls, 1)
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('lost response') })
  await assert.rejects(createSubsonicRemotePlaylist(config, 'Failed', { retries: 3 }))
  assert.equal(calls, 2, 'creation overrides read retry settings')
})

test('Subsonic playlist import preserves repeated songs and reports server permissions', async t => {
  t.mock.method(globalThis, 'fetch', async (url: URL) => ok(url.pathname.includes('getPlaylists.') ? { playlists: { playlist: [{ id: 'mix' }] } } : { playlist: row }))
  const playlists = await listSubsonicRemotePlaylists(1, config)
  assert.deepEqual(playlists[0].tracks.map(t => t.path), snapshot.tracks.map(t => t.path))
  assert.equal(playlists[0].writable, true)
  for (const details of [{ owner: 'other' }, { readonly: true }]) {
    t.mock.method(globalThis, 'fetch', async () => ok({ playlist: { ...row, ...details } }))
    assert.equal((await readSubsonicRemotePlaylist(1, config, 'mix'))!.writable, false)
  }
})

test('Subsonic incomplete listings or playlist contents are errors, not empty mirrors', async t => {
  for (const value of [{}, { playlists: { playlist: false } }, { playlists: { playlist: [{ name: 'No id' }] } }, { playlists: { playlist: [{ id: 'a' }, { id: 'a' }] } }]) {
    t.mock.method(globalThis, 'fetch', async () => ok(value))
    await assert.rejects(listSubsonicRemotePlaylists(1, config), /playlist/)
  }
  for (const value of [{ ...row, entry: [{ id: 'a' }] }, { ...row, entry: [{}, { id: 'b' }, { id: 'a' }] }, { ...row, id: 'wrong' }]) {
    t.mock.method(globalThis, 'fetch', async () => ok({ playlist: value }))
    await assert.rejects(readSubsonicRemotePlaylist(1, config, 'mix'), /playlist/)
  }
  t.mock.method(globalThis, 'fetch', async () => ok({ playlists: {} }))
  assert.deepEqual(await listSubsonicRemotePlaylists(1, config), [])
})

test('Subsonic playlist writes preserve order, duplicates and clearing without extra requests', async t => {
  const urls: URL[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL) => { urls.push(url); return ok({}) })
  await writeSubsonicRemotePlaylist(1, config, snapshot, { ...snapshot, tracks: [snapshot.tracks[0], snapshot.tracks[2], snapshot.tracks[1]] })
  assert.equal(urls[0].pathname, '/rest/createPlaylist.view')
  assert.equal(urls[0].searchParams.get('playlistId'), 'mix')
  assert.deepEqual(urls[0].searchParams.getAll('songId'), ['a', 'a', 'b'])
  await writeSubsonicRemotePlaylist(1, config, snapshot, { ...snapshot, tracks: [] })
  assert.equal(urls[1].pathname, '/rest/updatePlaylist.view')
  assert.equal(urls[1].searchParams.get('playlistId'), 'mix')
  assert.deepEqual(urls[1].searchParams.getAll('songIndexToRemove'), ['2', '1', '0'])
  assert.equal(urls[1].searchParams.has('songId'), false)
  await writeSubsonicRemotePlaylist(1, config, snapshot, { ...snapshot, name: 'Renamed' })
  assert.equal(urls[2].pathname, '/rest/updatePlaylist.view')
  assert.equal(urls[2].searchParams.get('name'), 'Renamed')
  assert.equal(urls[2].searchParams.has('public'), false)
  await writeSubsonicRemotePlaylist(1, config, snapshot, null)
  assert.equal(urls[3].pathname, '/rest/deletePlaylist.view')
  assert.equal(urls[3].searchParams.get('id'), 'mix')
})

test('Navidrome removal verifies the final song is gone and the empty playlist survives', async t => {
  let songs = ['a', 'b', 'a']
  const writes: URL[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    const query = url.searchParams
    if (url.pathname.endsWith('/createPlaylist.view')) {
      writes.push(url)
      // Navidrome's playlist repository only replaces tracks when specified.
      // An empty songId array serializes to no songId parameters: a no-op.
      const ids = query.getAll('songId')
      if (ids.length) songs = ids
    } else if (url.pathname.endsWith('/updatePlaylist.view')) {
      writes.push(url)
      const removed = new Set(query.getAll('songIndexToRemove').map(Number))
      songs = songs.filter((_, index) => !removed.has(index))
    } else assert.equal(url.pathname, '/rest/getPlaylist.view')
    return ok({ playlist: { ...row, songCount: songs.length, entry: songs.map(id => ({ id })) } })
  })
  const ref = { provider: 'subsonic' as const, sourceId: 1 }
  let local: RemotePlaylistLocal = { ...snapshot, localId: 1, ref,
    tracks: snapshot.tracks.map((track, i) => ({ ...track, entryId: i + 1 })) }
  const service = new RemotePlaylists({ sources: () => [ref], fingerprint: () => 'server', enabled: () => true,
    setEnabled: async () => {}, local: () => structuredClone(local), changed: () => {},
    apply: async (_ref, playlists) => { local = { ...playlists[0], localId: 1, ref } },
    remove: async () => { assert.fail('Removing songs must retain the playlist') },
    client: async () => ({ list: async () => [],
      read: id => readSubsonicRemotePlaylist(1, config, id),
      write: (before, after) => writeSubsonicRemotePlaylist(1, config, before, after) }) })
  await service.edit(1, { kind: 'remove', entryId: 1 })
  assert.deepEqual(songs, ['b', 'a'], 'only one occurrence of the repeated song is removed')
  await service.edit(1, { kind: 'remove', entryId: 2 })
  assert.deepEqual(songs, ['a'])
  await service.edit(1, { kind: 'remove', entryId: 3 })
  assert.deepEqual(songs, [])
  assert.deepEqual(local.tracks, [])
  assert.equal(local.id, 'mix')
  assert.equal(local.name, 'Mix')
  assert.equal(writes.length, 3, 'each removal is a single write')
  assert.deepEqual(writes[2].searchParams.getAll('songIndexToRemove'), ['0'])
})

test('clearing a large Subsonic playlist uses supported form POST and never retries removal', async t => {
  const before = { ...snapshot, tracks: Array.from({ length: 500 }, () => snapshot.tracks[0]) }
  const connection = { ...config, baseUrl: 'https://clear-formpost.test' }
  const calls: { url: URL; init: RequestInit }[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    calls.push({ url, init })
    if (url.pathname.includes('getOpenSubsonicExtensions')) return ok({ openSubsonicExtensions: [{ name: 'formPost', versions: [1] }] })
    assert.equal(url.pathname, '/rest/updatePlaylist.view')
    assert.equal(init.method, 'POST')
    assert.equal(url.search, '')
    const body = new URLSearchParams(String(init.body))
    assert.equal(body.get('playlistId'), 'mix')
    assert.deepEqual(body.getAll('songIndexToRemove'), before.tracks.map((_, i) => String(499 - i)))
    throw new Error('lost removal response')
  })
  await assert.rejects(writeSubsonicRemotePlaylist(1, connection, before, { ...before, tracks: [] }, { retries: 5 }), /lost removal response/)
  assert.equal(calls.length, 2, 'one capability read and one removal attempt')
  await writeSubsonicRemotePlaylist(1, connection, { ...before, tracks: [] }, { ...before, tracks: [] })
  assert.equal(calls.length, 2, 'already-empty playlists need no mutation')
})

test('large playlists use form POST only after discovering support, preserving repeated parameters', async t => {
  const calls: { url: URL; init: RequestInit }[] = []
  const tracks = Array.from({ length: 400 }, (_, i) => ({ path: `subsonic://1/track/song-${i}-long-id` }))
  tracks.push(tracks[0])
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    calls.push({ url, init })
    return ok(url.pathname.includes('getOpenSubsonicExtensions')
      ? { openSubsonicExtensions: [{ name: 'formPost', versions: [1] }] } : {})
  })
  const connection = { ...config, baseUrl: 'https://formpost.test' }
  await writeSubsonicRemotePlaylist(1, connection, snapshot, { ...snapshot, tracks })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url.pathname, '/rest/getOpenSubsonicExtensions.view')
  const write = calls[1]
  assert.equal(write.init.method, 'POST')
  assert.equal(write.init.redirect, 'error')
  assert.equal(write.url.search, '')
  const body = new URLSearchParams(String(write.init.body))
  assert.equal(body.get('playlistId'), 'mix')
  assert.equal(body.get('u'), 'listener')
  assert.deepEqual(body.getAll('songId'), tracks.map(track => track.path.split('/').at(-1)))
  assert.equal(new Headers(write.init.headers).get('Content-Type'), 'application/x-www-form-urlencoded')
  await writeSubsonicRemotePlaylist(1, connection, snapshot, { ...snapshot, tracks })
  assert.equal(calls.length, 3, 'cached capability avoids repeated discovery')
})

test('large playlists retain legacy GET support and do not write after failed capability checks', async t => {
  const tracks = Array.from({ length: 400 }, (_, i) => ({ path: `subsonic://1/track/song-${i}-long-id` }))
  const calls: { url: URL; init: RequestInit }[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    calls.push({ url, init })
    return url.pathname.includes('getOpenSubsonicExtensions')
      ? Response.json({ 'subsonic-response': { status: 'failed', error: { code: 70, message: 'Unknown method' } } }) : ok({})
  })
  await writeSubsonicRemotePlaylist(1, { ...config, baseUrl: 'https://legacy.test' }, snapshot, { ...snapshot, tracks })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].init.method, 'GET')
  assert.equal(calls[1].url.searchParams.getAll('songId').length, tracks.length)
  calls.length = 0
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    calls.push({ url, init }); throw new Error('connection lost')
  })
  await assert.rejects(writeSubsonicRemotePlaylist(1, { ...config, baseUrl: 'https://failed-check.test' }, snapshot, { ...snapshot, tracks }, { retries: 5 }), /connection lost/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.pathname, '/rest/getOpenSubsonicExtensions.view')
})

test('Subsonic rejects cross-server and local tracks before writing and does not retry failures', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('connection lost') })
  for (const path of ['/song.flac', 'subsonic://2/track/a', 'jellyfin://1/a']) {
    await assert.rejects(writeSubsonicRemotePlaylist(1, config, snapshot, { ...snapshot, tracks: [{ path }] }), /same server/)
  }
  await assert.rejects(writeSubsonicRemotePlaylist(1, config, { ...snapshot, writable: false }, null), /read-only/)
  assert.equal(calls, 0)
  await assert.rejects(writeSubsonicRemotePlaylist(1, config, snapshot, null, { retries: 5 }), /connection lost/)
  assert.equal(calls, 1)
})

test('Subsonic missing playlists are distinct from denied access', async t => {
  for (const [code, missing] of [[70, true], [50, false]]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ 'subsonic-response': { status: 'failed', error: { code, message: 'Unavailable' } } }))
    if (missing) assert.equal(await readSubsonicRemotePlaylist(1, config, 'mix'), null)
    else await assert.rejects(readSubsonicRemotePlaylist(1, config, 'mix'))
  }
})
