// Desktop side of the desktop<->mobile favorites/playlists LAN sync. The
// mobile app is the merge authority: it pulls the full desktop state
// (buildPhoneSyncState → GET /v1/sync/state), runs the merge locally, and
// pushes back only the desktop-bound diff (POST /v1/sync/apply →
// applyPhoneSyncChanges). All heavy lifting lives in library.ts; this module
// owns wire-payload validation and apply orchestration.

import {
  applySyncedFavoriteAdd,
  applySyncedFavoriteRemove,
  applySyncedPlaylistDelete,
  createTrackMetadataMatcher,
  ensurePlaylistSyncUids,
  getFavoriteTrackPathsBySyncKey,
  getSyncFavoritesState,
  getSyncPlaylistsState,
  replaceSyncedPlaylist,
  resolvePendingSyncFavorites,
  upsertPendingSyncFavorite
} from './library'
import {
  PHONE_SYNC_FORMAT,
  type PhoneSyncApplyPayload,
  type PhoneSyncApplyResult,
  type PhoneSyncPlaylistApplyResult,
  type PhoneSyncState,
  type SyncFavorite,
  type SyncKeyTombstone,
  type SyncPlaylist,
  type SyncPlaylistEntry,
  type SyncUidTombstone
} from '../../types/phoneSync'

export function buildPhoneSyncState(): PhoneSyncState {
  ensurePlaylistSyncUids()
  resolvePendingSyncFavorites()
  const { favorites, tombstones: favoriteTombstones } = getSyncFavoritesState()
  const { playlists, tombstones: playlistTombstones } = getSyncPlaylistsState()
  return {
    syncFormat: PHONE_SYNC_FORMAT,
    now: Date.now(),
    favorites,
    favoriteTombstones,
    playlists,
    playlistTombstones
  }
}

export function applyPhoneSyncChanges(payload: PhoneSyncApplyPayload): PhoneSyncApplyResult {
  const matcher = createTrackMetadataMatcher()

  let added = 0
  let pending = 0
  for (const add of payload.favoriteAdds) {
    const match = matcher({ title: add.title, artist: add.artist, album: add.album })
    if (match.kind === 'matched') {
      applySyncedFavoriteAdd(match.trackPath, add.key, add.addedAt)
      added += 1
    } else {
      upsertPendingSyncFavorite(add)
      pending += 1
    }
  }

  let removed = 0
  if (payload.favoriteRemoves.length > 0) {
    const favoritePathsByKey = getFavoriteTrackPathsBySyncKey()
    for (const remove of payload.favoriteRemoves) {
      const trackPaths = favoritePathsByKey.get(remove.key) ?? []
      if (trackPaths.length > 0) removed += 1
      applySyncedFavoriteRemove(trackPaths, remove.key, remove.deletedAt)
    }
  }

  const playlists: PhoneSyncPlaylistApplyResult[] = []
  for (const upsert of payload.playlistUpserts) {
    const result = replaceSyncedPlaylist(upsert, matcher)
    playlists.push({ syncUid: upsert.syncUid, ...result })
  }
  for (const remove of payload.playlistDeletes) {
    applySyncedPlaylistDelete(remove.syncUid, remove.deletedAt)
    playlists.push({ syncUid: remove.syncUid, status: 'deleted', entriesMatched: 0, entriesFallback: 0 })
  }

  return { ok: true, favorites: { added, pending, removed }, playlists }
}

// ── Wire-payload validation ──────────────────────────────────────────────────

function sanitizeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function sanitizeTimestamp(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

function sanitizeFavorite(raw: unknown): SyncFavorite | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const key = sanitizeString(item.key)
  const title = sanitizeString(item.title)
  if (!key || !title.trim()) return null
  return {
    key,
    title,
    artist: sanitizeString(item.artist),
    album: sanitizeString(item.album),
    addedAt: sanitizeTimestamp(item.addedAt)
  }
}

function sanitizeKeyTombstone(raw: unknown): SyncKeyTombstone | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const key = sanitizeString(item.key)
  if (!key) return null
  return { key, deletedAt: sanitizeTimestamp(item.deletedAt) }
}

function sanitizePlaylistEntry(raw: unknown): SyncPlaylistEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const durationSeconds = Number(item.durationSeconds)
  const position = Number(item.position)
  return {
    title: sanitizeString(item.title),
    artist: sanitizeString(item.artist),
    album: sanitizeString(item.album),
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
    position: Number.isFinite(position) ? position : 0,
    addedAt: sanitizeTimestamp(item.addedAt),
    sourcePath: typeof item.sourcePath === 'string' && item.sourcePath.trim().length > 0 ? item.sourcePath : null
  }
}

function sanitizePlaylist(raw: unknown): SyncPlaylist | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const syncUid = sanitizeString(item.syncUid)
  const name = sanitizeString(item.name).trim()
  if (!syncUid || !name) return null
  const kind = item.kind === 'dynamic' ? 'dynamic' : 'normal'
  let entries: SyncPlaylistEntry[] | null = null
  if (kind === 'normal') {
    entries = Array.isArray(item.entries)
      ? item.entries.map(sanitizePlaylistEntry).filter((entry): entry is SyncPlaylistEntry => entry !== null)
      : []
  }
  return {
    syncUid,
    name,
    kind,
    dynamicRules: kind === 'dynamic' ? sanitizeString(item.dynamicRules) || null : null,
    createdAt: sanitizeTimestamp(item.createdAt) || Date.now(),
    updatedAt: sanitizeTimestamp(item.updatedAt) || Date.now(),
    entries
  }
}

function sanitizeUidTombstone(raw: unknown): SyncUidTombstone | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const syncUid = sanitizeString(item.syncUid)
  if (!syncUid) return null
  return { syncUid, deletedAt: sanitizeTimestamp(item.deletedAt) }
}

function sanitizeArray<T>(raw: unknown, sanitize: (item: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return []
  const result: T[] = []
  for (const item of raw) {
    const sanitized = sanitize(item)
    if (sanitized !== null) result.push(sanitized)
  }
  return result
}

export function parsePhoneSyncApplyPayload(raw: unknown): PhoneSyncApplyPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  if (Number(body.syncFormat) !== PHONE_SYNC_FORMAT) return null
  return {
    syncFormat: PHONE_SYNC_FORMAT,
    favoriteAdds: sanitizeArray(body.favoriteAdds, sanitizeFavorite),
    favoriteRemoves: sanitizeArray(body.favoriteRemoves, sanitizeKeyTombstone),
    playlistUpserts: sanitizeArray(body.playlistUpserts, sanitizePlaylist),
    playlistDeletes: sanitizeArray(body.playlistDeletes, sanitizeUidTombstone)
  }
}
