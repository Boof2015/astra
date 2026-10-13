import { randomUUID } from 'node:crypto'
import type * as Library from './library'
import type { PlexConnectInput, PlexLibraryChoice, PlexSignInStatus, PlexSource, PlexStatusSnapshot } from '../../types/plex'
import { beginPlexSignIn, connectPlexServer, createPlexDevice, discoverPlexServers, fetchPlexArtwork,
  fetchPlexCatalog, listPlexLibraries, pollPlexSignIn, PlexRequestError,
  type PlexAccount, type PlexCredentials, type PlexDevice, type PlexRequestOptions, type PlexServer } from './plex'

interface SignIn {
  owner: number; id: string; device: PlexDevice; pinId: number; expiresAt: number; controller: AbortController
  account?: PlexAccount; servers?: PlexServer[]; pending?: Promise<PlexSignInStatus>
  connections: Map<string, { credentials: PlexCredentials; libraries: PlexLibraryChoice[] }>
}
interface Options {
  library: Pick<typeof Library, 'listPlexSources' | 'getPlexSourceById' | 'savePlexSource' | 'updatePlexSource'
    | 'deletePlexSource' | 'markPlexTracksAvailability' | 'upsertPlexTracks' | 'markMissingPlexTracksUnavailable' | 'cacheArtworkBuffer'>
  encrypt: (value: string) => string
  decrypt: (value: string) => string
  openExternal: (url: string) => Promise<void>
  changed: (status: PlexStatusSnapshot) => void
  beginLibrarySync: (key?: string) => string
  finishLibrarySync: (key: string, success: boolean) => Promise<void>
  request?: PlexRequestOptions
}
/** All account and resource tokens are main-process-only. */
export class PlexSources {
  private closed = false
  private signIns = new Map<string, SignIn>()
  private credentialCache = new Map<number, { credentials: PlexCredentials; checkedAt: number }>()
  private credentialRequests = new Map<number, Promise<PlexCredentials>>()
  private syncs = new Map<number, { controller: AbortController; promise: Promise<void> }>()
  private artworkHashes = new Map<string, string>()
  private progress = new Map<number, PlexStatusSnapshot['sources'][number]['progress']>()
  private options: Options
  constructor(options: Options) { this.options = options }
  status(): PlexStatusSnapshot {
    return { isSyncing: this.syncs.size > 0, updatedAt: Date.now(), sources: this.options.library.listPlexSources().map(source => ({
      sourceId: source.id, enabled: source.enabled === 1, status: this.syncs.has(source.id) ? 'syncing' : source.last_status,
      error: source.last_error, lastSyncAt: source.last_sync_at, lastCheckedAt: source.last_checked_at,
      progress: this.progress.get(source.id) ?? null
    })) }
  }
  private changed() { this.options.changed(this.status()) }
  private session(owner: number, id: string): SignIn {
    const session = this.signIns.get(id)
    if (!session || session.owner !== owner) throw new Error('Plex sign-in is no longer active. Please try again.')
    if (Date.now() >= session.expiresAt || session.controller.signal.aborted) {
      this.cancel(owner, id); throw new Error('Plex sign-in expired. Please sign in again.')
    }
    return session
  }
  private publicSignIn(session: SignIn): PlexSignInStatus {
    return { id: session.id, state: session.account && session.servers ? 'ready' : 'waiting', expiresAt: session.expiresAt,
      ...(session.account && session.servers ? { username: session.account.username,
        servers: session.servers.map(({ id, name, owned }) => ({ id, name, owned })) } : {}) }
  }
  async begin(owner: number): Promise<PlexSignInStatus> {
    if (this.closed) throw new Error('Plex is shutting down.')
    for (const session of this.signIns.values()) if (session.expiresAt <= Date.now()) this.cancel(session.owner, session.id)
    this.cancelOwner(owner)
    this.options.encrypt('Plex credential storage check')
    const device = createPlexDevice(), controller = new AbortController(), id = randomUUID()
    const session: SignIn = { id, owner, device, controller, pinId: 0, expiresAt: Date.now() + 5 * 60_000, connections: new Map() }
    this.signIns.set(id, session)
    try {
      const pin = await beginPlexSignIn(device, { ...this.options.request, signal: controller.signal })
      this.session(owner, id)
      session.pinId = pin.pinId; session.expiresAt = pin.expiresAt
      await this.options.openExternal(pin.url)
      this.session(owner, id)
      return this.publicSignIn(session)
    } catch (error) { this.cancel(owner, id); throw error }
  }
  async poll(owner: number, id: string): Promise<PlexSignInStatus> {
    const session = this.session(owner, id)
    if (session.account && session.servers) return this.publicSignIn(session)
    if (session.pending) return session.pending
    session.pending = (async () => {
      const options = { ...this.options.request, signal: session.controller.signal }
      const account = session.account ?? await pollPlexSignIn(session.device, session.pinId, options)
      this.session(owner, id)
      if (account) {
        session.account = account
        session.servers = await discoverPlexServers(account, options)
        this.session(owner, id)
        session.expiresAt = Date.now() + 15 * 60_000
      }
      return this.publicSignIn(session)
    })().finally(() => { session.pending = undefined })
    return session.pending
  }
  cancel(owner: number, id: string): void {
    const session = this.signIns.get(id)
    if (session?.owner !== owner) return
    session.controller.abort(); this.signIns.delete(id)
  }
  cancelOwner(owner: number): void {
    for (const session of this.signIns.values()) if (session.owner === owner) this.cancel(owner, session.id)
  }
  async libraries(owner: number, id: string, serverId: string): Promise<PlexLibraryChoice[]> {
    const session = this.session(owner, id)
    const server = session.servers?.find(item => item.id === serverId)
    if (!session.account || !server) throw new Error('Select a Plex server from this account.')
    const options = { ...this.options.request, signal: session.controller.signal }
    const credentials = await connectPlexServer(session.account, server, options)
    const libraries = await listPlexLibraries(credentials, options)
    this.session(owner, id)
    session.connections.set(serverId, { credentials, libraries })
    return libraries
  }
  async connect(owner: number, input: PlexConnectInput): Promise<PlexSource> {
    if (!input || typeof input.signInId !== 'string') throw new Error('Invalid Plex connection.')
    const session = this.session(owner, input.signInId)
    const selection = session.connections.get(input.serverId)
    const library = selection?.libraries.find(item => item.id === input.libraryId)
    if (!selection || !library || !session.account) throw new Error('Select a Plex server and music library first.')
    if (input.sourceId !== undefined) {
      const previous = this.options.library.getPlexSourceById(input.sourceId)
      if (!previous || previous.account_id !== session.account.accountId || previous.server_id !== input.serverId
        || previous.library_id !== input.libraryId) throw new Error('Reconnect using the same Plex account, server and music library.')
    }
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 200) : `${selection.credentials.server.name} · ${library.name}`
    const source = await this.options.library.savePlexSource({ name, username: session.account.username,
      account_id: session.account.accountId, server_id: input.serverId, library_id: input.libraryId, library_name: library.name,
      base_url: selection.credentials.baseUrl, secret_encrypted: this.options.encrypt(JSON.stringify(selection.credentials)) })
    this.credentialCache.set(source.id, { credentials: selection.credentials, checkedAt: Date.now() })
    this.cancel(owner, input.signInId)
    this.changed()
    return source
  }
  async credentials(id: number, signal?: AbortSignal, force = false): Promise<PlexCredentials> {
    signal?.throwIfAborted()
    if (this.closed) throw new Error('Plex is shutting down.')
    const source = this.options.library.getPlexSourceById(id)
    if (!source || source.enabled !== 1) throw new Error('Plex source is disabled or no longer exists.')
    const cached = this.credentialCache.get(id)
    if (!force && cached && cached.checkedAt > Date.now() - 10 * 60_000) return cached.credentials
    let pending = this.credentialRequests.get(id)
    if (!pending) {
      // Shared renewal is independent of a single seek/prefetch cancellation.
      pending = (async () => {
        let stored: PlexCredentials
        try { stored = JSON.parse(this.options.decrypt(source.secret_encrypted)) } catch { throw new Error('Plex sign-in could not be read. Reconnect this source.') }
        const options = { ...this.options.request }
        // Traditional account tokens stay valid until revoked. Refresh only the
        // server resource token after a rejection; revoked accounts need sign-in.
        if (force) {
          const servers = await discoverPlexServers(stored.account, options)
          const server = servers.find(item => item.id === source.server_id)
          if (!server) throw new Error('This Plex account no longer has access to the server. Reconnect this source.')
          stored.server = server
        }
        let credentials: PlexCredentials
        try { credentials = await connectPlexServer(stored.account, stored.server, options) }
        catch (error) {
          if (force) throw error
          const servers = await discoverPlexServers(stored.account, options)
          const server = servers.find(item => item.id === source.server_id)
          if (!server) throw new Error('This Plex account no longer has access to the server.')
          credentials = await connectPlexServer(stored.account, server, options)
        }
        const latest = this.options.library.getPlexSourceById(id)
        if (this.closed || !latest || latest.enabled !== 1 || latest.secret_encrypted !== source.secret_encrypted) throw new Error('Plex connection changed. Please retry.')
        await this.options.library.updatePlexSource(id, { base_url: credentials.baseUrl,
          secret_encrypted: this.options.encrypt(JSON.stringify(credentials)) })
        this.credentialCache.set(id, { credentials, checkedAt: Date.now() })
        return credentials
      })().finally(() => { this.credentialRequests.delete(id) })
      this.credentialRequests.set(id, pending)
    }
    const credentials = await pending
    signal?.throwIfAborted()
    return credentials
  }
  async withCredentials<T>(id: number, signal: AbortSignal | undefined, action: (credentials: PlexCredentials) => Promise<T>): Promise<T> {
    const credentials = await this.credentials(id, signal)
    try { return await action(credentials) }
    catch (error) {
      if (!(error instanceof PlexRequestError) || ![401, 498].includes(error.status)) throw error
      return action(await this.credentials(id, signal, true))
    }
  }
  async update(id: number, input: { name?: string; enabled?: boolean }): Promise<PlexSource> {
    if (!input || (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim()))
      || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) throw new Error('Invalid Plex source settings.')
    this.syncs.get(id)?.controller.abort()
    await this.syncs.get(id)?.promise.catch(() => {})
    this.credentialCache.delete(id)
    const source = await this.options.library.updatePlexSource(id, { ...(input.name !== undefined ? { name: input.name.trim().slice(0, 200) } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled ? 1 : 0, last_status: input.enabled ? 'unknown' : 'disabled', last_error: null } : {}) })
    if (input.enabled === false) await this.options.library.markPlexTracksAvailability(id, false, 'source_disabled')
    this.changed()
    return source
  }
  async remove(id: number, purge: boolean): Promise<void> {
    this.syncs.get(id)?.controller.abort()
    await this.syncs.get(id)?.promise.catch(() => {})
    this.credentialCache.delete(id)
    await this.options.library.deletePlexSource(id, purge)
    this.changed()
  }
  sync(id: number, key?: string): Promise<void> {
    if (this.closed) return Promise.resolve()
    const pending = this.syncs.get(id)
    if (pending) return pending.promise
    const controller = new AbortController()
    const promise = Promise.resolve().then(() => this.syncOne(id, controller.signal, key)).finally(() => {
      this.syncs.delete(id); this.progress.delete(id); this.changed()
    })
    this.syncs.set(id, { controller, promise }); this.changed()
    return promise
  }
  async syncAll(requestedKey?: string): Promise<void> {
    const sources = this.options.library.listPlexSources().filter(source => source.enabled === 1)
    if (!sources.length) return
    const key = this.options.beginLibrarySync(requestedKey)
    let success = false
    try {
      for (const source of sources) {
        if (this.closed) break
        try { await this.sync(source.id, key); success = true } catch { /* Per-source errors remain visible in status. */ }
      }
    } finally { await this.options.finishLibrarySync(key, success) }
  }
  private async syncOne(id: number, signal: AbortSignal, requestedKey?: string): Promise<void> {
    const source = this.options.library.getPlexSourceById(id)
    if (!source || source.enabled !== 1) return
    const key = this.options.beginLibrarySync(requestedKey)
    let success = false
    try {
      this.progress.set(id, { phase: 'connecting', activity: 'Connecting to Plex…', current: null, total: null, detail: null, updatedAt: Date.now() }); this.changed()
      const tracks = await this.withCredentials(id, signal, credentials => fetchPlexCatalog(id, credentials, source.library_id,
        { ...this.options.request, signal, onProgress: (current, total) => {
          this.progress.set(id, { phase: 'items', activity: 'Loading music…', current, total, detail: null, updatedAt: Date.now() }); this.changed()
        } }))
      const credentials = await this.credentials(id, signal)
      const hashes = new Map<string, string>()
      const artwork = [...new Set(tracks.map(t => t.artwork_source_id).filter((v): v is string => !!v))]
      for (const [index, path] of artwork.entries()) {
        signal.throwIfAborted()
        this.progress.set(id, { phase: 'artwork', activity: 'Loading artwork…', current: index, total: artwork.length, detail: null, updatedAt: Date.now() }); this.changed()
        try {
          const artworkKey = JSON.stringify([source.account_id, source.server_id, path])
          const cachedHash = this.artworkHashes.get(artworkKey)
          if (cachedHash) { hashes.set(path, cachedHash); continue }
          const bytes = await fetchPlexArtwork(credentials, path, { ...this.options.request, signal })
          const hash = await this.options.library.cacheArtworkBuffer(bytes)
          if (hash) {
            hashes.set(path, hash); this.artworkHashes.set(artworkKey, hash)
            if (this.artworkHashes.size > 5000) this.artworkHashes.delete(this.artworkHashes.keys().next().value!)
          }
        } catch { signal.throwIfAborted() }
      }
      signal.throwIfAborted()
      await this.options.library.upsertPlexTracks(id, tracks.map(track => ({ ...track,
        artwork_hash: track.artwork_source_id ? hashes.get(track.artwork_source_id) ?? null : null })), { syncSessionKey: key })
      await this.options.library.markMissingPlexTracksUnavailable(id, new Set(tracks.map(track => track.source_track_id)))
      await this.options.library.updatePlexSource(id, { last_status: 'ok', last_error: null, last_checked_at: Date.now(), last_sync_at: Date.now() })
      success = true
    } catch (error) {
      if (!signal.aborted) await this.options.library.updatePlexSource(id, { last_status: 'error', last_checked_at: Date.now(),
        last_error: error instanceof Error ? error.message : 'Plex refresh failed.' })
      throw error
    } finally { await this.options.finishLibrarySync(key, success) }
  }
  dispose(): void {
    this.closed = true
    for (const session of this.signIns.values()) session.controller.abort()
    this.signIns.clear()
    for (const sync of this.syncs.values()) sync.controller.abort()
    this.credentialCache.clear()
  }
}
