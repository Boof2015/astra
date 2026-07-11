// Wire types for the desktop<->mobile favorites/playlists LAN sync carried by
// the phone-remote HTTP server (GET /v1/sync/state, POST /v1/sync/apply).
// Track-level items are keyed by the metadata identity key from
// shared/sync/identity.ts; playlists are keyed by sync_uid. All timestamps are
// wall-clock ms and travel verbatim between devices (last-writer-wins merges
// must never mix in the receiving side's clock).

export const PHONE_SYNC_FORMAT = 1

export interface SyncFavorite {
  key: string
  title: string
  artist: string
  album: string
  addedAt: number
}

export interface SyncKeyTombstone {
  key: string
  deletedAt: number
}

export interface SyncPlaylistEntry {
  title: string
  artist: string
  album: string
  durationSeconds: number | null
  position: number
  addedAt: number
  sourcePath: string | null
}

export type SyncPlaylistKind = 'normal' | 'dynamic'

export interface SyncPlaylist {
  syncUid: string
  name: string
  kind: SyncPlaylistKind
  dynamicRules: string | null
  createdAt: number
  updatedAt: number
  entries: SyncPlaylistEntry[] | null
}

export interface SyncPlaylistSnapshot {
  name: string
  kind: SyncPlaylistKind
  dynamicRules: string | null
  updatedAt: number
  trackCount: number
  entries: SyncPlaylistEntry[] | null
}

export interface SyncUidTombstone {
  syncUid: string
  deletedAt: number
}

export interface PhoneSyncState {
  syncFormat: number
  now: number
  favorites: SyncFavorite[]
  favoriteTombstones: SyncKeyTombstone[]
  playlists: SyncPlaylist[]
  playlistTombstones: SyncUidTombstone[]
  /** Conflict resolutions the desktop user chose, awaiting phone pickup
   *  (injected by the phone-remote service, not buildPhoneSyncState). */
  pendingResolutions?: PhoneSyncPendingResolution[]
}

// ── Desktop-side conflict surface ────────────────────────────────────────────
// The phone is the merge authority and detects conflicts; it reports them here
// (POST /v1/sync/conflicts) so the desktop can show them, and the desktop's
// chosen resolutions ride back in /v1/sync/state for the phone to apply.

export type PhoneSyncConflictKind = 'first-pairing' | 'concurrent-edit'

export type PhoneSyncConflictResolution = 'desktop' | 'phone' | 'both' | 'merge'

export interface PhoneSyncReportedConflict {
  kind: PhoneSyncConflictKind
  syncUid: string
  name: string
  playlistKind: SyncPlaylistKind
  phoneName: string
  desktopName: string
  phoneUpdatedAt: number
  desktopUpdatedAt: number
  phoneTrackCount: number
  desktopTrackCount: number
  phoneSnapshot?: SyncPlaylistSnapshot | null
  desktopSnapshot?: SyncPlaylistSnapshot | null
}

export interface PhoneSyncPendingResolution {
  syncUid: string
  resolution: PhoneSyncConflictResolution
  decidedAt: number
}

export interface PhoneSyncConflictReportPayload {
  syncFormat: number
  conflicts: PhoneSyncReportedConflict[]
  /** Uids of desktop-chosen resolutions the phone just applied. */
  consumedResolutions: string[]
}

export interface PhoneSyncApplyPayload {
  syncFormat: number
  favoriteAdds: SyncFavorite[]
  favoriteRemoves: SyncKeyTombstone[]
  playlistUpserts: SyncPlaylist[]
  playlistDeletes: SyncUidTombstone[]
}

export type PhoneSyncPlaylistApplyStatus = 'created' | 'replaced' | 'deleted' | 'skipped-incompatible'

export interface PhoneSyncPlaylistApplyResult {
  syncUid: string
  status: PhoneSyncPlaylistApplyStatus
  entriesMatched: number
  entriesFallback: number
}

export interface PhoneSyncApplyResult {
  ok: true
  favorites: {
    added: number
    pending: number
    removed: number
  }
  playlists: PhoneSyncPlaylistApplyResult[]
}
