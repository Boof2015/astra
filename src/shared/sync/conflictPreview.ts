import type {
  PhoneSyncConflictResolution,
  SyncPlaylist,
  SyncPlaylistEntry,
  SyncPlaylistSnapshot
} from '../../types/phoneSync'
import { buildTrackSyncKey } from './identity.ts'

export type SyncPlaylistEntryDiffStatus = 'same' | 'moved' | 'desktop-only' | 'phone-only'

export interface SyncPlaylistEntryDiff {
  key: string
  title: string
  artist: string
  album: string
  desktopIndex: number | null
  phoneIndex: number | null
  status: SyncPlaylistEntryDiffStatus
}

export interface SyncPlaylistEntryDiffSummary {
  rows: SyncPlaylistEntryDiff[]
  sameCount: number
  movedCount: number
  desktopOnlyCount: number
  phoneOnlyCount: number
}

export interface SyncConflictResolutionPreview {
  resolution: PhoneSyncConflictResolution
  title: string
  detail: string
  resultName: string
  resultTrackCount: number | null
  mergedEntries: SyncPlaylistEntry[] | null
}

export function syncPlaylistToSnapshot(
  playlist: Pick<SyncPlaylist, 'name' | 'kind' | 'dynamicRules' | 'updatedAt' | 'entries'>
): SyncPlaylistSnapshot {
  const entries = playlist.kind === 'normal' ? playlist.entries ?? [] : null
  return {
    name: playlist.name,
    kind: playlist.kind,
    dynamicRules: playlist.kind === 'dynamic' ? playlist.dynamicRules : null,
    updatedAt: playlist.updatedAt,
    trackCount: entries?.length ?? 0,
    entries
  }
}

function orderedEntries(entries: readonly SyncPlaylistEntry[] | null | undefined): SyncPlaylistEntry[] {
  return [...(entries ?? [])].sort((left, right) => left.position - right.position)
}

function entryIdentity(entry: Pick<SyncPlaylistEntry, 'title' | 'artist' | 'album'>): string {
  return buildTrackSyncKey(entry.title, entry.artist, entry.album)
}

function occurrenceRows(entries: readonly SyncPlaylistEntry[] | null | undefined) {
  const counts = new Map<string, number>()
  return orderedEntries(entries).map((entry, index) => {
    const identity = entryIdentity(entry)
    const occurrence = counts.get(identity) ?? 0
    counts.set(identity, occurrence + 1)
    return {
      key: `${identity}\u0000${occurrence}`,
      index,
      entry
    }
  })
}

export function buildSyncPlaylistEntryDiff(
  desktopEntries: readonly SyncPlaylistEntry[] | null | undefined,
  phoneEntries: readonly SyncPlaylistEntry[] | null | undefined
): SyncPlaylistEntryDiffSummary {
  const desktop = occurrenceRows(desktopEntries)
  const phone = occurrenceRows(phoneEntries)
  const desktopByKey = new Map(desktop.map((row) => [row.key, row]))
  const phoneByKey = new Map(phone.map((row) => [row.key, row]))
  const keys = new Set<string>([...desktopByKey.keys(), ...phoneByKey.keys()])
  const rows: SyncPlaylistEntryDiff[] = []

  for (const key of keys) {
    const desktopRow = desktopByKey.get(key) ?? null
    const phoneRow = phoneByKey.get(key) ?? null
    const source = desktopRow?.entry ?? phoneRow?.entry
    if (!source) continue
    const desktopIndex = desktopRow ? desktopRow.index : null
    const phoneIndex = phoneRow ? phoneRow.index : null
    let status: SyncPlaylistEntryDiffStatus = 'same'
    if (!desktopRow) status = 'phone-only'
    else if (!phoneRow) status = 'desktop-only'
    else if (desktopIndex !== phoneIndex) status = 'moved'
    rows.push({
      key,
      title: source.title,
      artist: source.artist,
      album: source.album,
      desktopIndex,
      phoneIndex,
      status
    })
  }

  rows.sort((left, right) => {
    const leftIndex = Math.min(left.desktopIndex ?? Number.MAX_SAFE_INTEGER, left.phoneIndex ?? Number.MAX_SAFE_INTEGER)
    const rightIndex = Math.min(right.desktopIndex ?? Number.MAX_SAFE_INTEGER, right.phoneIndex ?? Number.MAX_SAFE_INTEGER)
    return leftIndex - rightIndex
  })

  return {
    rows,
    sameCount: rows.filter((row) => row.status === 'same').length,
    movedCount: rows.filter((row) => row.status === 'moved').length,
    desktopOnlyCount: rows.filter((row) => row.status === 'desktop-only').length,
    phoneOnlyCount: rows.filter((row) => row.status === 'phone-only').length
  }
}

export function mergePlaylistEntriesForPreview(
  newer: readonly SyncPlaylistEntry[] | null | undefined,
  older: readonly SyncPlaylistEntry[] | null | undefined
): SyncPlaylistEntry[] {
  const merged: SyncPlaylistEntry[] = []
  const retainedCounts = new Map<string, number>()

  for (const entry of orderedEntries(newer)) {
    const key = entryIdentity(entry)
    retainedCounts.set(key, (retainedCounts.get(key) ?? 0) + 1)
    merged.push({ ...entry, position: merged.length })
  }

  const olderCounts = new Map<string, number>()
  for (const entry of orderedEntries(older)) {
    const key = entryIdentity(entry)
    const occurrence = (olderCounts.get(key) ?? 0) + 1
    olderCounts.set(key, occurrence)
    if (occurrence <= (retainedCounts.get(key) ?? 0)) continue
    merged.push({ ...entry, position: merged.length })
  }

  return merged
}

export function buildSyncConflictResolutionPreview(
  resolution: PhoneSyncConflictResolution,
  desktop: SyncPlaylistSnapshot,
  phone: SyncPlaylistSnapshot
): SyncConflictResolutionPreview {
  switch (resolution) {
    case 'desktop':
      return {
        resolution,
        title: 'Keep desktop',
        detail: 'The desktop version will replace the phone copy on the next sync.',
        resultName: desktop.name,
        resultTrackCount: desktop.kind === 'normal' ? desktop.trackCount : null,
        mergedEntries: null
      }
    case 'phone':
      return {
        resolution,
        title: 'Keep phone',
        detail: 'The phone version will replace the desktop copy on the next sync.',
        resultName: phone.name,
        resultTrackCount: phone.kind === 'normal' ? phone.trackCount : null,
        mergedEntries: null
      }
    case 'both':
      return {
        resolution,
        title: 'Keep both',
        detail: 'Both versions will remain as separate playlists after the next sync.',
        resultName: phone.name,
        resultTrackCount: phone.kind === 'normal' ? phone.trackCount + desktop.trackCount : null,
        mergedEntries: null
      }
    case 'merge': {
      if (desktop.kind !== 'normal' || phone.kind !== 'normal') {
        return {
          resolution,
          title: 'Merge unavailable',
          detail: 'Dynamic playlists cannot be merged. Keep one side or keep both instead.',
          resultName: phone.name,
          resultTrackCount: null,
          mergedEntries: null
        }
      }
      const phoneIsNewer = phone.updatedAt >= desktop.updatedAt
      const mergedEntries = mergePlaylistEntriesForPreview(
        phoneIsNewer ? phone.entries : desktop.entries,
        phoneIsNewer ? desktop.entries : phone.entries
      )
      return {
        resolution,
        title: 'Merge',
        detail: 'The newer order stays first, then missing songs from the other side are appended.',
        resultName: phoneIsNewer ? phone.name : desktop.name,
        resultTrackCount: mergedEntries.length,
        mergedEntries
      }
    }
  }
}
