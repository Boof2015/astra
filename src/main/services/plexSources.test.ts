import assert from 'node:assert/strict'
import test from 'node:test'
import { PlexSources } from './plexSources.ts'
import type { PlexSourceRow } from './library.ts'

type Options = ConstructorParameters<typeof PlexSources>[0]
function harness() {
  const rows = new Map<number, PlexSourceRow>()
  const commits: unknown[] = [], missing: unknown[] = [], opened: string[] = [], finishes: boolean[] = []
  const mutations = { brokenCatalog: false, pending: true, revokedAccount: false, rejectServer: false, failArtwork: false,
    serverToken: 'server-token', shared: false }
  let jwtSignIn = false
  const requests: string[] = []
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } })
  const publicRow = (row: PlexSourceRow) => { const { secret_encrypted, deleted, ...source } = row; return { ...source, has_stored_secret: !!secret_encrypted } }
  const options: Options = {
    library: {
      listPlexSources: () => [...rows.values()].map(publicRow), getPlexSourceById: id => rows.get(id) ?? null,
      savePlexSource: async input => {
        const id = [...rows.values()].find(row => row.server_id === input.server_id && row.account_id === input.account_id && row.library_id === input.library_id)?.id ?? rows.size + 1
        const row: PlexSourceRow = { ...input, id, enabled: 1, deleted: 0, created_at: 1, updated_at: 1, last_status: 'unknown',
          last_error: null, last_sync_at: null, last_checked_at: null }
        rows.set(id, row); return publicRow(row)
      },
      updatePlexSource: async (id, patch) => { const row = rows.get(id)!; Object.assign(row, patch); return publicRow(row) },
      deletePlexSource: async id => { rows.delete(id) },
      markPlexTracksAvailability: async () => {},
      upsertPlexTracks: async (_id, tracks) => { commits.push(tracks); return { inserted: tracks.length, updated: 0 } },
      markMissingPlexTracksUnavailable: async (_id, ids) => { missing.push([...ids]) },
      cacheArtworkBuffer: async () => 'hash'
    },
    encrypt: value => `encrypted:${value}`, decrypt: value => value.slice(10), openExternal: async url => { opened.push(url) }, changed: () => {},
    beginLibrarySync: () => 'sync-key', finishLibrarySync: async (_key, success) => { finishes.push(success) },
    request: { fetch: (async (input: any, init: RequestInit = {}) => {
      const url = new URL(String(input)); requests.push(url.pathname)
      const token = new Headers(init.headers).get('X-Plex-Token')
      if (url.pathname === '/api/v2/pins') {
        jwtSignIn = !!JSON.parse(String(init.body)).jwk
        return json({ id: 1, code: 'browser-code', expiresAt: new Date(Date.now() + 60000).toISOString() })
      }
      if (url.pathname === '/api/v2/pins/1') return json({ authToken: mutations.pending ? null : jwtSignIn ? 'jwt-account-token' : 'account-token' })
      if (url.pathname === '/api/v2/user') return json({ id: 42, username: 'listener' })
      if (url.pathname === '/api/v2/resources') {
        if (mutations.revokedAccount) return new Response(null, { status: 401 })
        assert.ok(token === 'account-token' || token === 'jwt-account-token')
        return json([{ provides: 'server', clientIdentifier: 'server', name: 'Home', owned: !mutations.shared,
          accessToken: token === 'jwt-account-token' ? 'jwt-server-token' : mutations.serverToken,
          connections: [{ uri: 'https://server.example', local: true }] }])
      }
      // Identity is public, so successful discovery does not prove PMS accepts
      // the token. Emulate servers that accept only traditional resource tokens.
      if (url.pathname === '/identity') return json({ MediaContainer: { machineIdentifier: 'server' } })
      if (mutations.rejectServer || token !== mutations.serverToken) return new Response(null, { status: 401 })
      if (url.pathname === '/library/sections') return json({ MediaContainer: { Directory: [{ key: '2', title: 'Music', type: 'artist' }] } })
      if (url.pathname === '/library/sections/2/all') {
        if (mutations.brokenCatalog) return json({ MediaContainer: { totalSize: 10, size: 0 } })
        return json({ MediaContainer: { totalSize: 1, Metadata: [{ type: 'track', ratingKey: '123', title: 'Song', parentThumb: '/library/metadata/12/thumb/1' }] } })
      }
      if (url.pathname === '/library/metadata/12/thumb/1') return mutations.failArtwork ? new Response(null, { status: 503 }) : new Response('image', { headers: { 'Content-Type': 'image/png' } })
      throw new Error('unexpected request')
    }) as typeof fetch }
  }
  const service = new PlexSources(options)
  const connect = async () => {
    const started = await service.begin(10)
    mutations.pending = false
    const ready = await service.poll(10, started.id)
    const libraries = await service.libraries(10, started.id, 'server')
    const source = await service.connect(10, { signInId: started.id, serverId: 'server', libraryId: libraries[0].id })
    return { started, ready, source }
  }
  return { service, connect, rows, commits, missing, opened, finishes, mutations, requests, options }
}

test('Plex sign-in sessions are renderer-owned, cancellable and public responses contain no credentials', async t => {
  const h = harness(); t.after(() => h.service.dispose())
  const first = await h.service.begin(10)
  assert.equal(first.state, 'waiting'); assert.equal(h.opened.length, 1)
  await assert.rejects(h.service.poll(11, first.id), /no longer active/)
  h.service.cancel(11, first.id)
  assert.equal((await h.service.poll(10, first.id)).state, 'waiting')
  const { ready, source } = await h.connect()
  await assert.rejects(h.service.poll(10, first.id), /no longer active/)
  assert.deepEqual(ready.servers, [{ id: 'server', name: 'Home', owned: true }])
  const publicData = JSON.stringify([ready, source, h.service.status()])
  assert.doesNotMatch(publicData, /token|PRIVATE KEY|privateKey|encrypted:/)
  assert.ok(h.rows.get(source.id)!.secret_encrypted.startsWith('encrypted:'))
  await assert.rejects(h.service.poll(10, ready.id), /no longer active/)
})

test('Plex refreshes opted-in playlists after a successful catalog scan; playlist errors do not fail the scan', async t => {
  const h = harness(); t.after(() => h.service.dispose())
  const { source } = await h.connect()
  const refreshed: number[] = []
  h.options.afterCatalogSync = async id => { refreshed.push(id); throw new Error('playlist unavailable') }
  await h.service.sync(source.id)
  assert.deepEqual(refreshed, [source.id])
  assert.equal(h.rows.get(source.id)!.last_status, 'ok')
  h.mutations.brokenCatalog = true
  await assert.rejects(h.service.sync(source.id))
  assert.deepEqual(refreshed, [source.id])
})

test('Plex cannot connect a renderer-invented server/library and cancellation wins an in-flight sign-in', async t => {
  const h = harness(); t.after(() => h.service.dispose())
  const started = await h.service.begin(10); h.mutations.pending = false; await h.service.poll(10, started.id)
  await assert.rejects(h.service.libraries(10, started.id, 'invented'), /Select a Plex server/)
  await assert.rejects(h.service.connect(10, { signInId: started.id, serverId: 'server', libraryId: '2' }), /Select a Plex server and music library/)
  await h.service.libraries(10, started.id, 'server')
  await assert.rejects(h.service.connect(10, { signInId: started.id, serverId: 'server', libraryId: '999' }), /Select/)
  const pending = h.service.begin(10)
  h.service.cancelOwner(10)
  await assert.rejects(pending, /no longer active/)
  assert.equal(h.rows.size, 0)
})

test('Plex refuses to begin browser sign-in without encrypted storage', async () => {
  const h = harness()
  const service = new PlexSources({ ...h.options, encrypt: () => { throw new Error('keychain unavailable') } })
  await assert.rejects(service.begin(10), /keychain/)
  assert.equal(h.opened.length, 0); assert.equal(h.requests.length, 0)
})

test('Plex incomplete sync preserves existing catalog and only successful catalogs mark missing tracks', async t => {
  const h = harness(); t.after(() => h.service.dispose())
  const { source } = await h.connect()
  h.mutations.brokenCatalog = true
  await assert.rejects(h.service.sync(source.id), /incomplete/)
  assert.equal(h.commits.length, 0); assert.equal(h.missing.length, 0)
  assert.equal(h.service.status().sources[0].status, 'error')
  h.mutations.brokenCatalog = false
  await Promise.all([h.service.sync(source.id), h.service.sync(source.id)])
  assert.equal(h.commits.length, 1); assert.deepEqual(h.missing, [['123']])
  assert.deepEqual(h.finishes, [false, true]); assert.equal(h.service.status().isSyncing, false)
  const artworkRequests = h.requests.filter(path => path.includes('/thumb/')).length
  await h.service.sync(source.id)
  assert.equal(h.requests.filter(path => path.includes('/thumb/')).length, artworkRequests)
})

test('Plex sync rediscovers a changed resource token without upgrading account auth to JWT', async t => {
  const h = harness(); t.after(() => h.service.dispose())
  const { source } = await h.connect(); h.mutations.serverToken = 'new-server-token'
  await h.service.sync(source.id)
  assert.equal(h.requests.filter(path => path.endsWith('/resources')).length, 2)
  assert.equal(h.requests.filter(path => path.includes('/auth/')).length, 0)
  const stored = JSON.parse(h.options.decrypt(h.rows.get(source.id)!.secret_encrypted))
  assert.equal(stored.account.token, 'account-token')
  assert.equal(stored.server.token, 'new-server-token')
  assert.equal(h.commits.length, 1)
  await h.service.update(source.id, { enabled: false })
  await assert.rejects(h.service.credentials(source.id), /disabled/)
  assert.equal(h.service.status().sources[0].status, 'disabled')
})

test('Plex traditional browser sign-in can list and sync a shared server that rejects JWTs', async t => {
  const h = harness(); t.after(() => h.service.dispose())
  h.mutations.shared = true
  const { source, ready } = await h.connect()
  assert.equal(ready.servers?.[0].owned, false)
  await h.service.sync(source.id)
  assert.equal(h.commits.length, 1)
})

test('Plex persisted traditional credentials reopen without JWT renewal or an account request', async t => {
  const h = harness(); t.after(() => h.service.dispose())
  const { source } = await h.connect()
  h.service.dispose()
  const reopened = new PlexSources(h.options); t.after(() => reopened.dispose())
  const stored = JSON.parse(h.options.decrypt(h.rows.get(source.id)!.secret_encrypted))
  const accountRequests = h.requests.filter(path => path.startsWith('/api/v2/')).length
  await reopened.sync(source.id)
  assert.equal(h.commits.length, 1)
  assert.equal((await reopened.credentials(source.id)).account.clientId, stored.account.clientId)
  assert.equal(h.requests.filter(path => path.startsWith('/api/v2/')).length, accountRequests)
})

test('Plex revoked account asks for sign-in without committing a partial catalog', async t => {
  const h = harness(); t.after(() => h.service.dispose())
  const { source } = await h.connect()
  h.mutations.serverToken = 'new-server-token'
  h.mutations.revokedAccount = true
  await assert.rejects(h.service.sync(source.id), /Sign in to Plex again/)
  assert.equal(h.requests.filter(path => path.endsWith('/resources')).length, 2)
  assert.equal(h.commits.length, 0); assert.equal(h.missing.length, 0)
})

test('Plex persistent server rejection retries authorization only once', async t => {
  const h = harness(); t.after(() => h.service.dispose())
  const { source } = await h.connect()
  h.mutations.rejectServer = true
  await assert.rejects(h.service.sync(source.id), /Sign in to Plex again/)
  assert.equal(h.requests.filter(path => path.endsWith('/resources')).length, 2)
  assert.equal(h.requests.filter(path => path.endsWith('/all')).length, 2)
  assert.equal(h.commits.length, 0); assert.equal(h.missing.length, 0)
})

test('Plex reconnect must preserve account, server and Music library identity', async t => {
  const h = harness(); t.after(() => h.service.dispose())
  const { source } = await h.connect()
  const next = await h.service.begin(10); await h.service.poll(10, next.id); await h.service.libraries(10, next.id, 'server')
  await assert.rejects(h.service.connect(10, { signInId: next.id, serverId: 'server', libraryId: '2', sourceId: 999 }), /same Plex account/)
  const saved = await h.service.connect(10, { signInId: next.id, serverId: 'server', libraryId: '2', sourceId: source.id })
  assert.equal(saved.id, source.id); assert.equal(h.rows.size, 1)
})

test('Plex Sync All shares a latest-library session across sources and stops after disposal', async t => {
  const h = harness(); t.after(() => h.service.dispose())
  const { source } = await h.connect()
  h.rows.set(2, { ...h.rows.get(source.id)!, id: 2 })
  const events: string[] = []
  h.options.beginLibrarySync = key => { events.push(`begin:${key}`); return key! }
  h.options.finishLibrarySync = async key => { events.push(`finish:${key}`) }
  await h.service.syncAll('shared-session')
  assert.equal(h.commits.length, 2)
  assert.deepEqual(events, ['begin:shared-session', 'begin:shared-session', 'finish:shared-session',
    'begin:shared-session', 'finish:shared-session', 'finish:shared-session'])
  h.service.dispose()
  await h.service.sync(source.id)
  assert.equal(h.commits.length, 2)
  await assert.rejects(h.service.begin(10), /shutting down/)
})
