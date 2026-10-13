import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlexPlaylistClient } from './plexPlaylists.ts'
import { RemotePlaylists } from './remotePlaylists.ts'
import { parsePlexTrackPath, type PlexCredentials } from './plex.ts'
import type { RemotePlaylistLocal, RemotePlaylistSnapshot } from '../../types/remotePlaylists.ts'

const clone = <T>(value: T): T => structuredClone(value)
const json = (value: unknown) => Response.json({ MediaContainer: value })
function fixture() {
  const credentials: PlexCredentials = { account: { clientId: 'astra', accountId: 'account', username: 'listener', token: 'private-account' },
    server: { id: 'machine', name: 'Home', owned: false, token: 'private-resource', connections: [] }, baseUrl: 'https://plex.test' }
  let name = 'Mix', deleted = false, next = 1000, smart = false, count: number | undefined, readOnly = false
  let rows = ['10', '20', '10'].map((ratingKey, i) => ({ type: 'track', ratingKey, playlistItemID: i + 100, librarySectionID: '2', title: `Track ${ratingKey}` }))
  const requests: { url: URL; method: string }[] = [], auth: boolean[] = []
  const controller = new AbortController()
  const changes: { beforeRequest?: (url: URL, method: string) => Response | undefined; afterWrite?: () => void; check?: () => void;
    page?: (page: Record<string, unknown>) => void; onAuth?: () => void } = {}
  const metadata = () => ({ type: 'playlist', playlistType: 'audio', ratingKey: '1', title: name, smart, leafCount: count ?? rows.length, readOnly })
  const client = createPlexPlaylistClient({ signal: controller.signal, authenticate: async force => {
    auth.push(!!force); changes.onAuth?.(); return clone(credentials)
  }, check: () => changes.check?.(),
  trackPath: (id, library) => library === '2' ? `plex://1/${id}` : library === '3' ? `plex://2/${id}` : `plex://1/unavailable/${id}`,
  trackId: path => { const parsed = parsePlexTrackPath(path); return parsed && [1, 2].includes(parsed.sourceId) ? parsed.sourceTrackId : null },
  fetch: async (url, init) => {
    const method = init.method ?? 'GET'
    requests.push({ url, method })
    assert.equal(new Headers(init.headers).get('X-Plex-Token'), credentials.server.token)
    assert.equal(url.searchParams.has('X-Plex-Token'), false)
    assert.equal(init.redirect, 'error')
    const early = changes.beforeRequest?.(url, method)
    if (early) return early
    if (method === 'GET') {
      if (deleted) return new Response(null, { status: 404 })
      if (url.pathname === '/playlists/1') return json({ size: 1, Metadata: [metadata()] })
      const start = Number(new Headers(init.headers).get('X-Plex-Container-Start'))
      const size = Number(new Headers(init.headers).get('X-Plex-Container-Size'))
      const entries = url.pathname === '/playlists' ? [metadata()] : rows
      if (url.pathname === '/playlists') {
        assert.equal(url.searchParams.get('type'), '15'); assert.equal(url.searchParams.get('playlistType'), 'audio')
      } else assert.equal(url.pathname, '/playlists/1/items')
      const page = { size: entries.slice(start, start + size).length, offset: start, totalSize: entries.length, Metadata: entries.slice(start, start + size) }
      changes.page?.(page)
      return json(page)
    }
    if (url.pathname === '/playlists/1') {
      if (method === 'DELETE') deleted = true
      else { assert.equal(method, 'PUT'); name = url.searchParams.get('title')! }
    } else if (url.pathname === '/playlists/1/items' && method === 'PUT') {
      const uri = url.searchParams.get('uri')!
      assert.ok(uri.startsWith('server://machine/com.plexapp.plugins.library/library/metadata/'))
      for (const ratingKey of uri.split('/').at(-1)!.split(',')) {
        rows.push({ type: 'track', ratingKey, playlistItemID: next++, librarySectionID: ratingKey === '30' ? '3' : '2', title: `Track ${ratingKey}` })
      }
    } else {
      const match = /^\/playlists\/1\/items\/(\d+)(\/move)?$/.exec(url.pathname)!
      assert.ok(match)
      const index = rows.findIndex(row => row.playlistItemID === Number(match[1]))
      assert.ok(index >= 0)
      const [track] = rows.splice(index, 1)
      if (match[2]) {
        assert.equal(method, 'PUT')
        const after = url.searchParams.get('after')
        const previous = after ? rows.findIndex(row => row.playlistItemID === Number(after)) : -1
        assert.ok(!after || previous >= 0)
        rows.splice(previous + 1, 0, track)
      } else assert.equal(method, 'DELETE')
    }
    changes.afterWrite?.()
    return new Response(null, { status: 204 })
  } })
  return { client, changes, requests, auth, controller, credentials, rows: () => rows, setRows: (value: typeof rows) => { rows = value },
    writable: (value: boolean) => { readOnly = !value }, smart: () => { smart = true }, count: (value: number) => { count = value },
    rename: (value: string) => { name = value }, name: () => name, writes: () => requests.filter(request => request.method !== 'GET') }
}
async function shared(f: ReturnType<typeof fixture>) {
  const ref = { provider: 'plex' as const, sourceId: 1 }
  let enabled = false, local: RemotePlaylistLocal | null = null, nextEntry = 1
  const service = new RemotePlaylists({ sources: () => [ref], fingerprint: () => 'account/server', enabled: () => enabled,
    setEnabled: async (_ref, value) => { enabled = value }, client: async () => f.client, local: () => clone(local),
    apply: async (_ref, snapshots) => {
      if (snapshots[0]) {
        const previous = local
        local = { ...clone(snapshots[0]), ref, localId: 7, tracks: snapshots[0].tracks.map(track => ({ ...track,
          entryId: track.entryId ?? previous?.tracks.find(old => old.remoteEntryId === track.remoteEntryId)?.entryId ?? nextEntry++ })) }
      }
    }, remove: async () => { local = null }, changed: () => {} })
  await service.setEnabled(ref, true)
  return { service, local: () => local!, ref }
}

test('Plex playlists support verified direct edits, exact duplicates, cross-library additions and empty/delete', async () => {
  const f = fixture(), h = await shared(f)
  const initialIds = h.local().tracks.map(track => track.entryId!)
  // Swap two occurrences of the same song: provider IDs must follow the edit.
  await h.service.edit(7, { kind: 'reorder', entryIds: [initialIds[2], initialIds[1], initialIds[0]] })
  assert.deepEqual(f.rows().map(row => row.playlistItemID), [102, 101, 100])
  await h.service.edit(7, { kind: 'remove', entryId: initialIds[2] })
  assert.deepEqual(f.rows().map(row => row.playlistItemID), [101, 100])
  await h.service.edit(7, { kind: 'insert', paths: ['plex://2/30'], position: 0 })
  assert.deepEqual(f.rows().map(row => row.ratingKey), ['30', '20', '10'])
  assert.equal(h.local().tracks[0].path, 'plex://2/30')
  const writesBeforeRename = f.writes().length
  await h.service.edit(7, { kind: 'rename', name: 'Renamed & liked' })
  assert.equal(f.name(), 'Renamed & liked')
  assert.equal(f.writes().length, writesBeforeRename + 1, 'rename must not replace items')
  for (const track of [...h.local().tracks]) await h.service.edit(7, { kind: 'remove', entryId: track.entryId! })
  assert.equal(f.rows().length, 0)
  await h.service.edit(7, { kind: 'delete' })
  assert.equal(h.local(), null)
})

test('Plex preserves missing-library entries; smart, read-only and incomplete playlists cannot be edited', async () => {
  const f = fixture()
  f.rows()[1].librarySectionID = '99'
  assert.equal((await f.client.read('1'))!.tracks[1].path, 'plex://1/unavailable/20')
  const before = (await f.client.read('1'))!
  await f.client.write(before, { ...before, name: 'Still complete' })
  assert.equal(f.rows().length, 3)
  for (const mode of ['smart', 'partial', 'permission', 'noOccurrence']) {
    const g = fixture()
    if (mode === 'smart') g.smart()
    if (mode === 'partial') g.count(4)
    if (mode === 'permission') g.writable(false)
    if (mode === 'noOccurrence') delete (g.rows()[0] as Partial<ReturnType<typeof g.rows>[number]>).playlistItemID
    const snapshot = (await g.client.read('1'))!
    assert.equal(snapshot.writable, false)
    await assert.rejects(g.client.write(snapshot, null), /read-only/)
    assert.equal(g.writes().length, 0)
  }
  await assert.rejects(f.client.write(before, { ...before, tracks: [...before.tracks, { path: 'plex://999/999' }] }), /same account and server/)
  await assert.rejects(f.client.write(before, { ...before, tracks: [...before.tracks, { path: '/local/song.flac' }] }), /same account and server/)
})

test('Plex paginates repeated songs by occurrence and rejects malformed/incomplete page results', async () => {
  const f = fixture()
  f.setRows(Array.from({ length: 1001 }, (_, i) => ({ ...f.rows()[0], playlistItemID: i + 1 })))
  assert.equal((await f.client.list())[0].tracks.length, 1001)
  for (const mode of ['repeat', 'count', 'offset', 'empty', 'nonmusic']) {
    const g = fixture()
    g.changes.page = page => {
      const rows = page.Metadata as Record<string, unknown>[]
      if (mode === 'repeat') rows[2].playlistItemID = rows[0].playlistItemID
      if (mode === 'count') page.size = 100
      if (mode === 'offset') page.offset = 10
      if (mode === 'empty') { page.Metadata = []; page.size = 0 }
      if (mode === 'nonmusic') rows[0].type = 'movie'
    }
    await assert.rejects(g.client.read('1'), /Plex/)
  }
})

test('Plex read authentication refreshes once; mutation failures are not replayed or leaked', async () => {
  const f = fixture()
  let first = true
  f.changes.beforeRequest = () => { if (first) { first = false; return new Response(null, { status: 401 }) } }
  const before = (await f.client.read('1'))!
  assert.deepEqual(f.auth, [false, true])
  f.changes.beforeRequest = (_url, method) => method === 'GET' ? undefined : new Response('secret-server-body', { status: 498 })
  await assert.rejects(f.client.write(before, { ...before, name: 'Fail' }), error => {
    assert.doesNotMatch(String(error), /private|secret|plex.test/); return true
  })
  assert.equal(f.writes().length, 1)
  assert.deepEqual(f.auth, [false, true])
})

test('Plex checks cancellation and account identity after awaited credential refresh', async () => {
  const f = fixture()
  f.changes.onAuth = () => f.controller.abort()
  await assert.rejects(f.client.list())
  assert.equal(f.requests.length, 0)
  const g = fixture()
  await g.client.read('1')
  g.changes.beforeRequest = () => new Response(null, { status: 401 })
  g.credentials.account.accountId = 'different'
  await assert.rejects(g.client.read('1'), /account or server changed/)
})

test('Plex server conflicts prevent a stale write and failed multi-step edits refresh the actual mirror', async () => {
  const f = fixture(), h = await shared(f)
  f.rename('Elsewhere')
  await assert.rejects(h.service.edit(7, { kind: 'rename', name: 'Stale' }), /changed on the server/)
  assert.equal(f.writes().length, 0)
  assert.equal(h.local().name, 'Elsewhere')
  // Add succeeds; moving that new track fails. Keep the appended server result.
  f.changes.beforeRequest = (url, method) => method === 'PUT' && url.pathname.endsWith('/move') ? new Response(null, { status: 503 }) : undefined
  await assert.rejects(h.service.edit(7, { kind: 'insert', paths: ['plex://2/30'], position: 0 }), /503/)
  assert.deepEqual(f.rows().map(row => row.ratingKey), ['10', '20', '10', '30'])
  assert.equal(h.local().tracks.at(-1)!.path, 'plex://2/30')
  assert.equal(f.writes().filter(request => request.url.pathname.endsWith('/move')).length, 1)
})

test('Plex detects concurrent changes between mutation steps and stops further writes', async () => {
  const f = fixture(), h = await shared(f)
  f.changes.afterWrite = () => { f.rename('Another client') }
  await assert.rejects(h.service.edit(7, { kind: 'insert', paths: ['plex://2/30'], position: 0 }), /changed during the edit/)
  assert.equal(f.writes().length, 1)
  assert.equal(h.local().name, 'Another client')
})

test('Plex rejects stale occurrence identity even when the song order is unchanged', async () => {
  const f = fixture(), h = await shared(f)
  const entryId = h.local().tracks[0].entryId!
  f.rows()[0].playlistItemID = 999
  await assert.rejects(h.service.edit(7, { kind: 'remove', entryId }), /changed on the server/)
  assert.equal(f.writes().length, 0)
  assert.equal(h.local().tracks[0].remoteEntryId, '999')
})

test('Plex batches large additions and verifies the complete order', async () => {
  const f = fixture()
  f.setRows([])
  const before = (await f.client.read('1'))!
  const after: RemotePlaylistSnapshot = { ...before, tracks: Array.from({ length: 205 }, (_, i) => ({ path: `plex://1/${2000 + i}` })) }
  await f.client.write(before, after)
  assert.equal(f.writes().length, 3)
  assert.deepEqual((await f.client.read('1'))!.tracks.map(track => track.path), after.tracks.map(track => track.path))
})
