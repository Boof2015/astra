import assert from 'node:assert/strict'
import test from 'node:test'
import { listSubsonicRemotePlaylists, readSubsonicRemotePlaylist, writeSubsonicRemotePlaylist } from './subsonic.ts'
import type { RemotePlaylistSnapshot } from '../../types/remotePlaylists.ts'
const config = { baseUrl: 'https://server.test', username: 'listener', password: 'secret' }
const ok = (value: object) => Response.json({ 'subsonic-response': { status: 'ok', ...value } })
const row = { id: 'mix', name: 'Mix', songCount: 3, owner: 'listener', entry: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }
const snapshot: RemotePlaylistSnapshot = { id: 'mix', name: 'Mix', writable: true,
  tracks: ['a', 'b', 'a'].map(id => ({ path: `subsonic://1/track/${id}` })) }

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
  assert.equal(urls[1].searchParams.get('playlistId'), 'mix')
  assert.deepEqual(urls[1].searchParams.getAll('songId'), [])
  await writeSubsonicRemotePlaylist(1, config, snapshot, { ...snapshot, name: 'Renamed' })
  assert.equal(urls[2].pathname, '/rest/updatePlaylist.view')
  assert.equal(urls[2].searchParams.get('name'), 'Renamed')
  assert.equal(urls[2].searchParams.has('public'), false)
  await writeSubsonicRemotePlaylist(1, config, snapshot, null)
  assert.equal(urls[3].pathname, '/rest/deletePlaylist.view')
  assert.equal(urls[3].searchParams.get('id'), 'mix')
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
