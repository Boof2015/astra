import {
  buildJellyfinStreamRequestHeaders, buildJellyfinTrackPath, normalizeJellyfinBaseUrl, parseJellyfinTrackPath,
  type JellyfinAuthContext, type JellyfinConnectionConfig
} from './jellyfin'
import type { RemotePlaylistClient } from './remotePlaylists'
import type { RemotePlaylistSnapshot } from '../../types/remotePlaylists'

interface Options {
  signal: AbortSignal
  timeoutMs?: number
  authenticate(forceRefresh?: boolean): Promise<JellyfinAuthContext>
  check(): void
}

class PlaylistRequestError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`Jellyfin playlist request failed (${status})`)
    this.status = status
  }
}

const PAGE_SIZE = 500
const MAX_ITEMS = 250_000
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Jellyfin returned invalid playlist data.')
  return value as Record<string, unknown>
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}
function guid(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[\da-f]{32}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.test(value)) {
    throw new Error('Jellyfin returned an invalid playlist or track ID.')
  }
  return value.replaceAll('-', '').toLowerCase()
}
const unavailableEndpoint = (error: unknown) => error instanceof PlaylistRequestError && [403, 404].includes(error.status)

/** A client is scoped to one serialized refresh/edit and one source identity. */
export function createJellyfinPlaylistClient(sourceId: number, config: JellyfinConnectionConfig, options: Options): RemotePlaylistClient {
  let auth: JellyfinAuthContext | null = null
  const check = () => { options.signal.throwIfAborted(); options.check() }
  const authenticate = async (force = false) => {
    check()
    const refreshed = await options.authenticate(force)
    check()
    if (auth && guid(auth.userId) !== guid(refreshed.userId)) throw new Error('Jellyfin account changed. Reconnect before editing playlists.')
    auth = refreshed
    return auth
  }
  const request = async (method: 'GET' | 'POST' | 'DELETE', endpoint: string,
    params: Record<string, string | number | boolean> = {}, body?: unknown, readResponse = method === 'GET'): Promise<unknown> => {
    check()
    const currentAuth = auth ?? await authenticate()
    check()
    const url = new URL(`${normalizeJellyfinBaseUrl(config.baseUrl)}${endpoint}`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    const response = await fetch(url, {
      method, redirect: 'error',
      headers: { ...buildJellyfinStreamRequestHeaders(config, currentAuth), Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 12_000)])
    })
    check()
    if (!response.ok) throw new PlaylistRequestError(response.status)
    if (!readResponse) { await response.body?.cancel(); return }
    const value: unknown = await response.json()
    check()
    return value
  }
  const readJson = async (endpoint: string, params: Record<string, string | number | boolean> = {}): Promise<Record<string, unknown>> => {
    try { return record(await request('GET', endpoint, params)) }
    catch (error) {
      // Only reads retry after an explicit auth rejection. Never replay a write.
      if (!(error instanceof PlaylistRequestError) || error.status !== 401) throw error
      await authenticate(true)
      return record(await request('GET', endpoint, params))
    }
  }
  const items = async (endpoint: string, params: Record<string, string | number | boolean>, uniqueIds: boolean) => {
    const result: Record<string, unknown>[] = []
    const seen = new Set<string>()
    let total: number | undefined
    do {
      const page = await readJson(endpoint, { ...params, StartIndex: result.length, Limit: PAGE_SIZE })
      if (!Array.isArray(page.Items) || !Number.isSafeInteger(page.TotalRecordCount)
        || Number(page.TotalRecordCount) < 0 || Number(page.TotalRecordCount) > MAX_ITEMS
        || (total !== undefined && total !== page.TotalRecordCount)
        || (page.StartIndex !== undefined && page.StartIndex !== result.length)) {
        throw new Error('Jellyfin returned an incomplete playlist listing.')
      }
      total = Number(page.TotalRecordCount)
      if ((!page.Items.length && result.length < total) || result.length + page.Items.length > total) {
        throw new Error('Jellyfin returned an incomplete playlist listing.')
      }
      for (const value of page.Items) {
        const item = record(value)
        const id = guid(item.Id)
        if (uniqueIds && seen.has(id)) throw new Error('Jellyfin repeated a playlist page.')
        seen.add(id)
        result.push(item)
      }
    } while (result.length < total)
    return result
  }
  const userItemsEndpoint = async () => `/Users/${encodeURIComponent((auth ?? await authenticate()).userId)}/Items`
  const read = async (id: string): Promise<RemotePlaylistSnapshot | null> => {
    guid(id)
    const metadata = await items(await userItemsEndpoint(), { Ids: id, Fields: 'CanDelete', EnableImages: false, EnableUserData: false }, true)
    if (!metadata.length) return null
    const item = metadata[0]
    if (metadata.length !== 1 || guid(item.Id) !== guid(id) || item.Type !== 'Playlist' || !text(item.Name)
      || (item.MediaType != null && item.MediaType !== 'Audio')) throw new Error('Jellyfin did not return the requested music playlist.')

    const endpoint = `/Playlists/${encodeURIComponent(id)}`
    const rows = await items(`${endpoint}/Items`, { UserId: auth!.userId, EnableImages: false, EnableUserData: false }, false)
    if (rows.some(row => !text(row.Type))) throw new Error('Jellyfin returned incomplete playlist contents.')
    let details: Record<string, unknown> | null = null
    let canEdit = false
    try { details = await readJson(endpoint) }
    catch (error) { if (!unavailableEndpoint(error)) throw error }
    if (details) {
      if (!Array.isArray(details.ItemIds)) throw new Error('Jellyfin returned incomplete playlist contents.')
      const allIds = details.ItemIds.map(guid)
      // User-visible entries may omit tracks this account cannot access. Never
      // replace the full server list with that filtered subset.
      const complete = allIds.length === rows.length && allIds.every((trackId, i) => trackId === guid(rows[i].Id))
      if (complete && rows.every(row => row.Type === 'Audio')) {
        try {
          const permission = await readJson(`${endpoint}/Users/${encodeURIComponent(auth!.userId)}`)
          canEdit = guid(permission.UserId) === guid(auth!.userId) && permission.CanEdit === true
        } catch (error) { if (!unavailableEndpoint(error)) throw error }
      }
    }
    const tracks = rows.filter(row => row.Type === 'Audio').map(row => ({
      path: buildJellyfinTrackPath(sourceId, String(row.Id)), title: text(row.Name), album: text(row.Album),
      artist: Array.isArray(row.Artists) ? row.Artists.filter((name): name is string => typeof name === 'string').join(', ') || null : null
    }))
    return { id, name: String(item.Name), writable: canEdit, deletable: item.CanDelete === true, tracks }
  }
  return {
    create: async name => {
      const current = auth ?? await authenticate()
      const result = record(await request('POST', '/Playlists', {}, {
        Name: name, Ids: [], UserId: current.userId, MediaType: 'Audio', IsPublic: false
      }, true))
      return guid(result.Id)
    },
    list: async () => {
      const rows = await items(await userItemsEndpoint(), {
        Recursive: true, IncludeItemTypes: 'Playlist', MediaTypes: 'Audio', SortBy: 'SortName', SortOrder: 'Ascending',
        EnableImages: false, EnableUserData: false
      }, true)
      const playlists: RemotePlaylistSnapshot[] = []
      for (const row of rows) {
        const playlist = await read(String(row.Id))
        if (!playlist) throw new Error('Jellyfin playlists changed during refresh. Please try again.')
        playlists.push(playlist)
      }
      return playlists
    },
    read,
    write: async (before, after) => {
      guid(before.id)
      if (!after) {
        if (!before.deletable) throw new Error('You do not have permission to delete this server playlist.')
        await request('DELETE', `/Items/${encodeURIComponent(before.id)}`)
        return
      }
      if (!before.writable) throw new Error('This server playlist is read-only.')
      if (after.id !== before.id) throw new Error('Invalid server playlist.')
      const ids = after.tracks.map(track => {
        const parsed = parseJellyfinTrackPath(track.path)
        if (!parsed || parsed.sourceId !== sourceId) throw new Error('A server playlist can only contain tracks from that same server.')
        return guid(parsed.sourceTrackId)
      })
      const body: { Name?: string; Ids?: string[] } = {}
      if (before.name !== after.name) body.Name = after.name
      if (before.tracks.length !== after.tracks.length || before.tracks.some((track, i) => track.path !== after.tracks[i].path)) body.Ids = ids
      if (!Object.keys(body).length) return
      // Omitted Users/IsPublic/Ids retain sharing and unrelated values. The
      // server accepts ordered IDs in JSON, so large lists need no URL batching.
      await request('POST', `/Playlists/${encodeURIComponent(before.id)}`, {}, body)
    }
  }
}
