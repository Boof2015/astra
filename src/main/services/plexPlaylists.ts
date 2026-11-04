import { plexJson, plexWrite, PlexRequestError, type PlexCredentials, type PlexRequestOptions } from './plex'
import { RemotePlaylistCreationRejectedError, type RemotePlaylistClient } from './remotePlaylists'
import type { RemotePlaylistSnapshot, RemotePlaylistTrack } from '../../types/remotePlaylists'

interface Options extends PlexRequestOptions {
  signal: AbortSignal
  authenticate(forceRefresh?: boolean): Promise<PlexCredentials>
  check(): void
  trackPath(trackId: string, libraryId: string | null): string
  trackId(path: string): string | null
}
type Row = Record<string, unknown>
const PAGE_SIZE = 500, MAX_ITEMS = 250_000
const conflict = () => new Error('Plex playlist changed during the edit. Astra will refresh it; please try again.')
const id = (value: unknown): string => {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'number' && !Number.isSafeInteger(value))
    || !/^[1-9]\d*$/.test(String(value))) {
    throw new Error('Plex returned an invalid playlist or track ID.')
  }
  return String(value)
}
const record = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plex returned invalid playlist data.')
  return value as Row
}
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : null
const sameEntries = (a: RemotePlaylistTrack[], b: RemotePlaylistTrack[]) => a.length === b.length
  && a.every((track, i) => track.path === b[i].path && track.remoteEntryId === b[i].remoteEntryId)

/** User-scoped music playlists. See https://developer.plex.tv/pms/ (Playlist).
 * Keep occurrence IDs: ratingKey alone cannot identify a repeated song. */
export function createPlexPlaylistClient(options: Options): RemotePlaylistClient {
  let credentials: PlexCredentials | undefined
  const check = () => { options.signal.throwIfAborted(); options.check() }
  const authenticate = async (force = false) => {
    check()
    const next = await options.authenticate(force)
    check()
    if (credentials && (credentials.account.accountId !== next.account.accountId || credentials.server.id !== next.server.id)) {
      throw new Error('Plex account or server changed. Reconnect before editing playlists.')
    }
    credentials = next
    return next
  }
  const json = async (path: string, init?: RequestInit): Promise<Row> => {
    check()
    let value: unknown
    try { value = await plexJson(credentials ?? await authenticate(), path, options, init) }
    catch (error) {
      if (!(error instanceof PlexRequestError) || ![401, 498].includes(error.status)) throw error
      value = await plexJson(await authenticate(true), path, options, init)
    }
    check()
    return record(record(value).MediaContainer)
  }
  const mutate = async (path: string, method: 'PUT' | 'DELETE') => {
    check()
    const current = credentials ?? await authenticate()
    check()
    await plexWrite(current, path, method, options)
    check()
  }
  const pages = async (path: string, occurrenceIds: boolean): Promise<Row[]> => {
    const result: Row[] = [], seen = new Set<string>(), seenPages = new Set<string>()
    let total: number | undefined
    for (;;) {
      const page = await json(path, { headers: { 'X-Plex-Container-Start': String(result.length), 'X-Plex-Container-Size': String(PAGE_SIZE) } })
      if ((!Array.isArray(page.Metadata) && page.size !== 0) || (page.offset !== undefined && page.offset !== result.length)) {
        throw new Error('Plex returned an incomplete playlist page.')
      }
      const rows = (page.Metadata ?? []) as unknown[]
      if (page.size !== rows.length) throw new Error('Plex returned an inconsistent playlist page size.')
      const signature = JSON.stringify(rows.map(value => { const row = record(value); return [row.ratingKey, row.playlistItemID] }))
      if (rows.length && seenPages.has(signature)) throw new Error('Plex repeated a playlist page.')
      seenPages.add(signature)
      if (page.totalSize !== undefined) {
        if (!Number.isSafeInteger(page.totalSize) || Number(page.totalSize) < 0 || Number(page.totalSize) > MAX_ITEMS
          || (total !== undefined && total !== page.totalSize)) throw new Error('Plex playlists changed during refresh. Please try again.')
        total = Number(page.totalSize)
      }
      for (const value of rows) {
        const row = record(value)
        const key = occurrenceIds ? (row.playlistItemID == null ? null : id(row.playlistItemID)) : id(row.ratingKey)
        if (key && seen.has(key)) throw new Error('Plex repeated a playlist page.')
        if (key) seen.add(key)
        result.push(row)
      }
      if (result.length > MAX_ITEMS || (total !== undefined && result.length > total)) throw new Error('Plex returned an inconsistent playlist size.')
      if (total !== undefined) {
        if (result.length === total) break
        if (!rows.length) throw new Error('Plex returned an incomplete playlist.')
      } else if (!rows.length || (page.offset === undefined && rows.length < PAGE_SIZE)) break
    }
    return result
  }
  const read = async (playlistId: string): Promise<RemotePlaylistSnapshot | null> => {
    id(playlistId)
    let container: Row
    try { container = await json(`/playlists/${playlistId}`) }
    catch (error) { if (error instanceof PlexRequestError && error.status === 404) return null; throw error }
    if (!Array.isArray(container.Metadata) || container.Metadata.length !== 1) throw new Error('Plex did not return the requested playlist.')
    const item = record(container.Metadata[0])
    if (id(item.ratingKey) !== playlistId || item.type !== 'playlist' || item.playlistType !== 'audio' || !text(item.title)) {
      throw new Error('Plex did not return the requested music playlist.')
    }
    const rows = await pages(`/playlists/${playlistId}/items`, true)
    if (rows.some(row => row.type !== 'track')) throw new Error('Plex returned unsupported music playlist contents.')
    const tracks = rows.map(row => ({
      path: options.trackPath(id(row.ratingKey), row.librarySectionID == null ? null : id(row.librarySectionID)),
      title: text(row.title), artist: text(row.originalTitle) ?? text(row.grandparentTitle), album: text(row.parentTitle),
      ...(row.playlistItemID == null ? {} : { remoteEntryId: id(row.playlistItemID) })
    }))
    // /playlists lists the authenticated user's playlists. Server ownership is
    // irrelevant. Smart, partial and explicitly read-only lists stay read-only.
    const writable = (item.smart === false || item.smart === 0) && item.readOnly !== true && item.readOnly !== 1
      && item.leafCount === rows.length && tracks.every(track => !!track.remoteEntryId)
    return { id: playlistId, name: String(item.title), writable, deletable: writable, tracks }
  }
  return {
    create: async name => {
      check()
      const current = credentials ?? await authenticate()
      check()
      // POST must not use json(), whose auth refresh is intentionally read-only.
      let response: unknown
      try {
        // Plex requires a source parameter even for a blank playlist. Omitting
        // uri yields 400; an explicit empty uri creates a regular audio list.
        response = await plexJson(current, `/playlists?${new URLSearchParams({ title: name, type: 'audio', smart: '0', uri: '' })}`,
          options, { method: 'POST' })
      } catch (error) {
        if (error instanceof PlexRequestError && [400, 401, 403, 404, 405, 422, 498].includes(error.status)) {
          throw new RemotePlaylistCreationRejectedError(`${error.message} The playlist was not created.`)
        }
        throw error
      }
      const result = record(response)
      check()
      const container = record(result.MediaContainer)
      if (!Array.isArray(container.Metadata) || container.Metadata.length !== 1) throw new Error('Plex did not return the new playlist ID.')
      const playlist = record(container.Metadata[0])
      if (playlist.type !== 'playlist' || playlist.playlistType !== 'audio') throw new Error('Plex did not return a new music playlist.')
      return id(playlist.ratingKey)
    },
    read,
    list: async () => {
      const rows = await pages('/playlists?type=15&playlistType=audio', false)
      const result: RemotePlaylistSnapshot[] = []
      for (const row of rows) {
        const snapshot = await read(id(row.ratingKey))
        if (!snapshot) throw new Error('Plex playlists changed during refresh. Please try again.')
        result.push(snapshot)
      }
      return result
    },
    write: async (before, after) => {
      const endpoint = `/playlists/${id(before.id)}`
      if (!before.writable || (after === null && !before.deletable)) throw new Error('This Plex playlist is read-only.')
      if (!after) { await mutate(endpoint, 'DELETE'); return }
      if (after.id !== before.id || !after.name.trim()) throw new Error('Invalid Plex playlist edit.')
      const existing = new Map(before.tracks.map(track => [track.remoteEntryId, track]))
      if (existing.has(undefined) || existing.size !== before.tracks.length) throw conflict()
      const seen = new Set<string>()
      const desired = after.tracks.map(track => {
        if (track.remoteEntryId) {
          if (seen.has(track.remoteEntryId) || existing.get(track.remoteEntryId)?.path !== track.path) throw conflict()
          seen.add(track.remoteEntryId)
        } else if (!options.trackId(track.path)) {
          throw new Error('A Plex playlist can only contain tracks from connected libraries on the same account and server.')
        }
        return { ...track }
      })
      let current = before
      const verify = async (name: string, tracks: RemotePlaylistTrack[], appended?: RemotePlaylistTrack[]) => {
        const actual = await read(before.id)
        if (!actual || !actual.writable || actual.name !== name || !sameEntries(actual.tracks.slice(0, tracks.length), tracks)
          || actual.tracks.length !== tracks.length + (appended?.length ?? 0)) throw conflict()
        if (appended) for (const [index, track] of appended.entries()) {
          const added = actual.tracks[tracks.length + index]
          if (added.path !== track.path || !added.remoteEntryId || existing.has(added.remoteEntryId)) throw conflict()
          track.remoteEntryId = added.remoteEntryId
        }
        current = actual
      }
      // Add first in bounded batches. Never clear/recreate a playlist to reorder
      // it: that would discard occurrence identity and unrelated server edits.
      const added = desired.filter(track => !track.remoteEntryId)
      for (let offset = 0; offset < added.length; offset += 100) {
        const batch = added.slice(offset, offset + 100)
        const currentCredentials = credentials ?? await authenticate()
        const uri = `server://${encodeURIComponent(currentCredentials.server.id)}/com.plexapp.plugins.library/library/metadata/${batch.map(track => id(options.trackId(track.path))).join(',')}`
        await mutate(`${endpoint}/items?${new URLSearchParams({ uri })}`, 'PUT')
        await verify(current.name, current.tracks, batch)
      }
      const retained = new Set(desired.map(track => track.remoteEntryId))
      for (const track of [...current.tracks]) if (!retained.has(track.remoteEntryId)) {
        await mutate(`${endpoint}/items/${id(track.remoteEntryId)}`, 'DELETE')
        await verify(current.name, current.tracks.filter(entry => entry.remoteEntryId !== track.remoteEntryId))
      }
      for (let position = 0; position < desired.length; position++) {
        const track = desired[position]
        if (current.tracks[position].remoteEntryId === track.remoteEntryId) continue
        const tracks = current.tracks.filter(entry => entry.remoteEntryId !== track.remoteEntryId)
        tracks.splice(position, 0, track)
        const params = position ? `?after=${id(desired[position - 1].remoteEntryId)}` : ''
        await mutate(`${endpoint}/items/${id(track.remoteEntryId)}/move${params}`, 'PUT')
        await verify(current.name, tracks)
      }
      if (current.name !== after.name) {
        await mutate(`${endpoint}?${new URLSearchParams({ title: after.name })}`, 'PUT')
        await verify(after.name, current.tracks)
      }
    }
  }
}
