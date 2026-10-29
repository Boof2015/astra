import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createJellyfinPlaylistClient } from './jellyfinPlaylists.ts'
import { RemotePlaylists } from './remotePlaylists.ts'
import type { RemotePlaylistLocal } from '../../types/remotePlaylists.ts'

const id = (n: number) => n.toString(16).padStart(32, '0')
const userId = id(1), playlistId = id(10), a = id(20), b = id(21), c = id(22)
const path = (trackId: string) => `jellyfin://1/track/${trackId}`
const config = { baseUrl: 'https://server.test/jellyfin', username: 'listener', password: 'secret' }
const auth = { userId, accessToken: 'test-token' }
type ServerPlaylist = { name: string; tracks: string[]; writable: boolean; deletable: boolean; hidden?: string[] }

function fixture(t: TestContext) {
  const playlists = new Map<string, ServerPlaylist>([[playlistId, { name: 'Mix', tracks: [a, b, a], writable: true, deletable: true }]])
  const calls: { url: URL; method: string; body?: Record<string, unknown> }[] = []
  const authCalls: boolean[] = []
  let override: ((url: URL, method: string) => Response | null) | null = null
  let connected = true
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    const url = new URL(input)
    const method = init.method ?? 'GET'
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ url, method, body })
    assert.equal(new Headers(init.headers).get('X-Emby-Token'), 'test-token')
    assert.equal(url.searchParams.has('api_key'), false)
    assert.equal(init.redirect, 'error')
    const custom = override?.(url, method)
    if (custom) return custom
    const endpoint = url.pathname.replace('/jellyfin', '')
    if (method === 'POST' && endpoint === '/Playlists') {
      assert.deepEqual(body, { Name: 'New playlist', Ids: [], UserId: userId, MediaType: 'Audio', IsPublic: false })
      playlists.set(id(50), { name: String(body!.Name), tracks: [], writable: true, deletable: true })
      return Response.json({ Id: id(50) })
    }
    const page = (items: unknown[]) => {
      const start = Number(url.searchParams.get('StartIndex') ?? 0)
      const limit = Number(url.searchParams.get('Limit') ?? 500)
      return Response.json({ Items: items.slice(start, start + limit), TotalRecordCount: items.length, StartIndex: start })
    }
    if (method === 'GET' && endpoint === `/Users/${userId}/Items`) {
      const selected = url.searchParams.get('Ids')
      if (!selected) {
        assert.equal(url.searchParams.get('IncludeItemTypes'), 'Playlist')
        assert.equal(url.searchParams.get('MediaTypes'), 'Audio')
      } else assert.equal(url.searchParams.get('Fields'), 'CanDelete')
      return page([...playlists].filter(([key]) => !selected || selected === key)
        .map(([key, value]) => ({ Id: key, Name: value.name, Type: 'Playlist', MediaType: 'Audio', CanDelete: value.deletable })))
    }
    const key = endpoint.split('/')[2]
    const playlist = playlists.get(key)
    if (!playlist) return new Response(null, { status: 404 })
    if (method === 'GET' && endpoint === `/Playlists/${key}/Items`) {
      assert.equal(url.searchParams.get('UserId'), userId)
      return page(playlist.tracks.filter(track => !playlist.hidden?.includes(track))
        .map((track, i) => ({ Id: track, Name: `Song ${track}`, Artists: ['Artist'], Album: 'Album', Type: 'Audio', PlaylistItemId: id(1000 + i) })))
    }
    if (method === 'GET' && endpoint === `/Playlists/${key}`) return Response.json({ ItemIds: playlist.tracks, Shares: [], OpenAccess: true })
    if (method === 'GET' && endpoint === `/Playlists/${key}/Users/${userId}`) return Response.json({ UserId: userId, CanEdit: playlist.writable })
    if (method === 'POST' && endpoint === `/Playlists/${key}`) {
      assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json')
      assert.equal(body?.Users, undefined); assert.equal(body?.IsPublic, undefined)
      if (body?.Name !== undefined) playlist.name = body.Name as string
      if (body?.Ids !== undefined) playlist.tracks = body.Ids as string[]
      return new Response(null, { status: 204 })
    }
    if (method === 'DELETE' && endpoint === `/Items/${key}`) {
      playlists.delete(key)
      return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected fixture route: ${method} ${endpoint}`)
  })
  const client = createJellyfinPlaylistClient(1, config, {
    signal: controller.signal,
    authenticate: async force => { authCalls.push(force ?? false); return auth },
    check: () => { if (!connected) throw new Error('Server changed') }
  })
  return { client, playlists, calls, authCalls, controller,
    override: (value: typeof override) => { override = value }, disconnect: () => { connected = false } }
}

test('Jellyfin creates a private audio playlist and does not replay rejected or ambiguous creation', async t => {
  const f = fixture(t)
  assert.equal(await f.client.create!('New playlist'), id(50))
  assert.equal((await f.client.read(id(50)))!.tracks.length, 0)
  assert.equal((await f.client.read(id(50)))!.writable, true)
  f.override((_url, method) => method === 'POST' ? new Response(null, { status: 401 }) : null)
  await assert.rejects(f.client.create!('New playlist'), /401/)
  assert.deepEqual(f.authCalls, [false])
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 2)
  f.override((_url, method) => method === 'POST' ? Response.json({}) : null)
  await assert.rejects(f.client.create!('New playlist'), /invalid playlist/)
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 3)
})

test('Jellyfin imports music playlists with duplicate songs and separate edit/delete permissions', async t => {
  const f = fixture(t)
  f.playlists.set(id(11), { name: 'Shared', tracks: [b], writable: true, deletable: false })
  f.playlists.set(id(12), { name: 'Read only', tracks: [], writable: false, deletable: false })
  const result = await f.client.list()
  assert.deepEqual(result.map(p => [p.name, p.writable, p.deletable]), [['Mix', true, true], ['Shared', true, false], ['Read only', false, false]])
  assert.deepEqual(result[0].tracks.map(track => track.path), [a, b, a].map(path))
  assert.equal(result[0].tracks[0].artist, 'Artist')
  assert.deepEqual(f.authCalls, [false])
})

test('Jellyfin reads all pages and writes a large ordered playlist in one JSON request', async t => {
  const f = fixture(t)
  const tracks = Array.from({ length: 1100 }, (_, i) => i % 2 ? a : b)
  f.playlists.get(playlistId)!.tracks = tracks
  const before = (await f.client.read(playlistId))!
  assert.equal(before.tracks.length, 1100)
  assert.deepEqual(f.calls.filter(call => call.url.pathname.endsWith('/Items') && call.url.pathname.includes('/Playlists/'))
    .map(call => call.url.searchParams.get('StartIndex')), ['0', '500', '1000'])
  await f.client.write(before, { ...before, tracks: [...before.tracks].reverse() })
  const writes = f.calls.filter(call => call.method !== 'GET')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].url.search, '')
  assert.deepEqual(writes[0].body, { Ids: [...tracks].reverse() })
})

test('Jellyfin incomplete, repeated or changing pages never become a successful list refresh', async t => {
  const f = fixture(t)
  for (const response of [{}, { Items: [], TotalRecordCount: 1 }, { Items: [{ Id: playlistId }], TotalRecordCount: 0 }]) {
    f.override(() => Response.json(response))
    await assert.rejects(f.client.list(), /playlist/)
  }
  f.override(url => Response.json({ Items: [{ Id: playlistId }], TotalRecordCount: 2, StartIndex: Number(url.searchParams.get('StartIndex')) }))
  await assert.rejects(f.client.list(), /repeated/)
  f.override(url => Response.json({ Items: [{ Id: url.searchParams.get('StartIndex') === '0' ? playlistId : id(11) }],
    TotalRecordCount: url.searchParams.get('StartIndex') === '0' ? 2 : 3 }))
  await assert.rejects(f.client.list(), /incomplete/)
})

test('Jellyfin hidden tracks and unavailable permission endpoints remain read-only', async t => {
  const f = fixture(t)
  f.playlists.get(playlistId)!.hidden = [b]
  const filtered = (await f.client.read(playlistId))!
  assert.equal(filtered.writable, false)
  assert.equal(filtered.tracks.length, 2)
  await assert.rejects(f.client.write(filtered, { ...filtered, name: 'Unsafe' }), /read-only/)
  f.playlists.get(playlistId)!.hidden = []
  for (const status of [403, 404]) {
    f.override(url => url.pathname.includes('/Playlists/') && !url.pathname.endsWith('/Items') ? new Response(null, { status }) : null)
    assert.equal((await f.client.read(playlistId))!.writable, false)
  }
  f.override(url => url.pathname.endsWith(`/Playlists/${playlistId}`) ? Response.json({}) : null)
  await assert.rejects(f.client.read(playlistId), /incomplete/)
  assert.equal(f.calls.some(call => call.method !== 'GET'), false)
})

test('Jellyfin distinguishes missing playlists, access failures and non-playlist items', async t => {
  const f = fixture(t)
  assert.equal(await f.client.read(id(999)), null)
  f.override(() => new Response(null, { status: 403 }))
  await assert.rejects(f.client.read(playlistId), /403/)
  f.override(url => url.searchParams.has('Ids') ? Response.json({ Items: [{ Id: playlistId, Name: 'Audio file', Type: 'Audio' }], TotalRecordCount: 1 }) : null)
  await assert.rejects(f.client.read(playlistId), /requested music playlist/)
})

test('Jellyfin rejects foreign tracks and denied deletion before writes; rename preserves contents/sharing', async t => {
  const f = fixture(t)
  const before = (await f.client.read(playlistId))!
  for (const foreign of ['/music.flac', `jellyfin://2/track/${a}`, `subsonic://1/track/${a}`, 'jellyfin://1/track/not-a-guid']) {
    await assert.rejects(f.client.write(before, { ...before, tracks: [{ path: foreign }] }), /same server|invalid/)
  }
  await assert.rejects(f.client.write({ ...before, deletable: false }, null), /permission/)
  assert.equal(f.calls.some(call => call.method !== 'GET'), false)
  await f.client.write(before, { ...before, name: 'Renamed' })
  assert.deepEqual(f.calls.at(-1)!.body, { Name: 'Renamed' })
  assert.deepEqual(f.playlists.get(playlistId)!.tracks, [a, b, a])
  await f.client.write(before, { ...before, tracks: [] })
  assert.deepEqual(f.calls.at(-1)!.body, { Ids: [] })
  assert.deepEqual(f.playlists.get(playlistId)!.tracks, [])
})

test('Jellyfin refreshes rejected read authentication once but never retries a write', async t => {
  const f = fixture(t)
  let rejected = false
  f.override((_url, method) => {
    if (method === 'GET' && !rejected) { rejected = true; return new Response(null, { status: 401 }) }
    return null
  })
  const before = (await f.client.read(playlistId))!
  assert.deepEqual(f.authCalls, [false, true])
  for (const status of [401, 500]) {
    f.override((_url, method) => method === 'POST' ? new Response(null, { status }) : null)
    const count = f.calls.length
    await assert.rejects(f.client.write(before, { ...before, name: 'Lost' }), new RegExp(String(status)))
    assert.equal(f.calls.length, count + 1)
    assert.equal(f.authCalls.length, 2)
  }
  f.disconnect()
  const count = f.calls.length
  await assert.rejects(f.client.write(before, null), /Server changed/)
  assert.equal(f.calls.length, count)
})

test('Jellyfin direct edits integrate with opt-in, conflict checks and verified local occurrence identities', async t => {
  const f = fixture(t)
  const ref = { provider: 'jellyfin' as const, sourceId: 1 }
  let enabled = false, local: RemotePlaylistLocal | null = null, nextEntry = 0
  const service = new RemotePlaylists({
    sources: () => [ref], fingerprint: () => 'account', enabled: () => enabled,
    setEnabled: async (_ref, value) => { enabled = value }, local: () => local ? structuredClone(local) : null,
    client: async () => f.client, changed: () => {}, remove: async () => { local = null },
    apply: async (_ref, snapshots) => {
      local = snapshots[0] ? { ...snapshots[0], localId: 1, ref,
        tracks: snapshots[0].tracks.map(track => ({ ...track, entryId: track.entryId ?? ++nextEntry })) } : null
    }
  })
  const current = () => local!
  await service.refresh(ref)
  assert.equal(f.calls.length, 0)
  await service.setEnabled(ref, true)
  const firstOccurrence = current().tracks[0].entryId!
  await service.edit(1, { kind: 'remove', entryId: firstOccurrence })
  assert.deepEqual(f.playlists.get(playlistId)!.tracks, [b, a])
  await service.edit(1, { kind: 'insert', paths: [path(c)], position: 1 })
  assert.deepEqual(f.playlists.get(playlistId)!.tracks, [b, c, a])
  await service.edit(1, { kind: 'reorder', entryIds: current().tracks.map(track => track.entryId!).reverse() })
  assert.deepEqual(f.playlists.get(playlistId)!.tracks, [a, c, b])
  f.playlists.get(playlistId)!.name = 'Changed elsewhere'
  await assert.rejects(service.edit(1, { kind: 'rename', name: 'Stale' }), /changed on the server/)
  assert.equal(current().name, 'Changed elsewhere')
  await service.edit(1, { kind: 'rename', name: 'Fresh' })
  assert.equal(f.playlists.get(playlistId)!.name, 'Fresh')
  await service.setEnabled(ref, false)
  assert.equal(f.playlists.size, 1)
  await service.setEnabled(ref, true)
  await service.edit(1, { kind: 'delete' })
  assert.equal(local, null)
  assert.equal(f.playlists.size, 0)
})
