import type { LibraryArtistBrowseMode } from '../stores/libraryStore'
import type {
  QuickLaunchFilterKind,
  QuickLaunchLockedFilter,
  QuickLaunchTrackRecord
} from '../types/quickLaunch'
import { normalizeSearchValue, multiFieldScore } from './fuzzySearch'
import { scoreTrackIdentityQuery } from './trackSearch'

export interface QuickLaunchTrackOccurrence {
  occurrenceKey: string
  track: QuickLaunchTrackRecord
  sourceIndex: number
}

export interface QuickLaunchFilterOption {
  id: string
  label: string
  subtitle?: string
  value: string | number | null
}

export interface QuickLaunchPlayRequest {
  paths: string[]
  startIndex: number
}

export const QUICK_LAUNCH_FILTER_REGISTRY: ReadonlyArray<{
  kind: QuickLaunchFilterKind
  token: `@${QuickLaunchFilterKind}`
  label: string
  description: string
}> = [
  { kind: 'artist', token: '@artist', label: 'Artist', description: 'Only tracks credited to an artist' },
  { kind: 'album', token: '@album', label: 'Album', description: 'Only tracks from one album release' },
  { kind: 'playlist', token: '@playlist', label: 'Playlist', description: 'Search within a playlist' },
  { kind: 'genre', token: '@genre', label: 'Genre', description: 'Only tracks in an exact genre' },
  { kind: 'year', token: '@year', label: 'Year', description: 'Only tracks from an exact year' }
]

export const QUICK_LAUNCH_RESULT_ACTIONS = [
  { id: 'play' as const, token: '/play', label: 'Play', description: 'Play from the selected result' },
  { id: 'next' as const, token: '/next', label: 'Queue next', description: 'Queue the selected result next' },
  { id: 'queue' as const, token: '/queue', label: 'Queue last', description: 'Add the selected result to the end' }
]

export const QUICK_LAUNCH_IMMEDIATE_COMMANDS = [
  { id: 'play-pause' as const, token: '/play-pause', label: 'Play / pause', actionId: 'playback-toggle' as const },
  { id: 'skip' as const, token: '/skip', label: 'Skip', actionId: 'next-track' as const },
  { id: 'previous' as const, token: '/previous', label: 'Previous', actionId: 'previous-track' as const },
  { id: 'toggle-shuffle' as const, token: '/toggle-shuffle', label: 'Toggle shuffle', actionId: 'shuffle' as const }
]

export function upsertQuickLaunchFilter(
  filters: readonly QuickLaunchLockedFilter[],
  filter: QuickLaunchLockedFilter
): QuickLaunchLockedFilter[] {
  return [...filters.filter((candidate) => candidate.kind !== filter.kind), filter]
}

export function buildQuickLaunchPlayRequest(
  occurrences: readonly QuickLaunchTrackOccurrence[],
  selectedOccurrenceKey: string
): QuickLaunchPlayRequest | null {
  const startIndex = occurrences.findIndex((occurrence) => occurrence.occurrenceKey === selectedOccurrenceKey)
  if (startIndex < 0) return null
  return {
    paths: occurrences.map((occurrence) => occurrence.track.path),
    startIndex
  }
}

function normalizedEquals(left: string | null | undefined, right: string): boolean {
  return normalizeSearchValue(left ?? '') === right
}

export function trackMatchesArtistFilter(
  track: QuickLaunchTrackRecord,
  artist: string,
  mode: LibraryArtistBrowseMode
): boolean {
  const target = normalizeSearchValue(artist)
  if (!target) return false

  if (mode === 'strict') {
    return normalizedEquals(track.album_artist?.trim() || track.artist, target)
  }

  const candidates = [
    ...track.artist_names,
    ...track.album_artist_names,
    track.artist,
    track.album_artist ?? ''
  ]
  return candidates.some((candidate) => normalizedEquals(candidate, target))
}

export function trackMatchesQuickLaunchFilters(
  track: QuickLaunchTrackRecord,
  filters: readonly QuickLaunchLockedFilter[],
  artistMode: LibraryArtistBrowseMode
): boolean {
  return filters.every((filter) => {
    switch (filter.kind) {
      case 'artist':
        return typeof filter.value === 'string' && trackMatchesArtistFilter(track, filter.value, artistMode)
      case 'album':
        return typeof filter.value === 'string' && track.album_identity_key === filter.value
      case 'playlist':
        return true // The playlist supplies the occurrence-preserving base scope.
      case 'genre': {
        if (typeof filter.value !== 'string') return false
        const target = normalizeSearchValue(filter.value)
        const genres = track.genres.length > 0 ? track.genres : track.genre ? [track.genre] : []
        return genres.some((genre) => normalizeSearchValue(genre) === target)
      }
      case 'year':
        return filter.value === null ? track.year === null : track.year === filter.value
    }
  })
}

export function rankQuickLaunchTrackOccurrences(
  occurrences: readonly QuickLaunchTrackOccurrence[],
  query: string,
  filters: readonly QuickLaunchLockedFilter[],
  artistMode: LibraryArtistBrowseMode
): QuickLaunchTrackOccurrence[] {
  const eligible = occurrences.filter(({ track }) => trackMatchesQuickLaunchFilters(track, filters, artistMode))
  const trimmedQuery = query.trim()

  if (!trimmedQuery) {
    const hasPlaylistScope = filters.some((filter) => filter.kind === 'playlist')
    const hasAlbumScope = filters.some((filter) => filter.kind === 'album')
    if (hasPlaylistScope || !hasAlbumScope) return eligible

    return [...eligible].sort((left, right) => {
      const leftDisc = left.track.disc_number ?? 1
      const rightDisc = right.track.disc_number ?? 1
      if (leftDisc !== rightDisc) return leftDisc - rightDisc
      const leftTrack = left.track.track_number ?? Number.MAX_SAFE_INTEGER
      const rightTrack = right.track.track_number ?? Number.MAX_SAFE_INTEGER
      if (leftTrack !== rightTrack) return leftTrack - rightTrack
      return left.sourceIndex - right.sourceIndex
    })
  }

  return eligible
    .map((occurrence) => ({
      occurrence,
      score: scoreTrackIdentityQuery(occurrence.track, trimmedQuery, 'global')
    }))
    .filter((entry): entry is { occurrence: QuickLaunchTrackOccurrence; score: number } => entry.score !== null)
    .sort((left, right) => right.score - left.score || left.occurrence.sourceIndex - right.occurrence.sourceIndex)
    .map(({ occurrence }) => occurrence)
}

export function rankQuickLaunchFilterOptions(
  options: readonly QuickLaunchFilterOption[],
  query: string
): QuickLaunchFilterOption[] {
  const trimmed = query.trim()
  if (!trimmed) return [...options]
  return options
    .map((option, index) => ({
      option,
      index,
      score: multiFieldScore(trimmed, [
        { value: option.label, weight: 1.5 },
        { value: option.subtitle ?? '', weight: 1 }
      ], 'global')
    }))
    .filter((entry): entry is { option: QuickLaunchFilterOption; index: number; score: number } => entry.score !== null)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ option }) => option)
}

export function findQuickLaunchTokenFragment(value: string): {
  trigger: '@' | '/'
  fragment: string
  start: number
} | null {
  const pattern = /(^|\s)([@/])([^\s]*)/g
  let found: RegExpExecArray | null = null
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    found = match
  }
  if (!found) return null
  return {
    trigger: found[2] as '@' | '/',
    fragment: found[3],
    start: found.index + found[1].length
  }
}

export function removeQuickLaunchTokenFragment(value: string, start: number): string {
  return `${value.slice(0, start)}${value.slice(start).replace(/^[@/]\S*/, '')}`
    .replace(/\s+/g, ' ')
    .trim()
}

export function replaceQuickLaunchTokenFragment(value: string, start: number, replacement: string): string {
  return `${value.slice(0, start)}${value.slice(start).replace(/^[@/]\S*/, replacement)}`
}
