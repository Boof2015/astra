import type { Track } from '../types/audio'
import type { LyricsLine, LyricsLookupResult, LyricsSource, LyricsTrackQuery } from '../../types/lyrics'

export interface LyricsBodyCopy {
  noTrackMessage: string
  loadingMessage: string
  idleMessage: string
  noReadableTextMessage: string
  onlineDisabledMessage: string
  providerNotFoundMessage: string
  embeddedMissingMessage: string
}

export interface ResolveLyricsBodyStateOptions {
  currentTrack: Track | { path: string } | null
  activeLyricsResult: LyricsLookupResult | null
  isLoading: boolean
  errorMessage: string
  copy: LyricsBodyCopy
}

export type LyricsBodyState =
  | { kind: 'no-track'; message: string }
  | { kind: 'loading'; message: string }
  | { kind: 'transient_error'; message: string }
  | { kind: 'not_found'; message: string; reason: 'embedded-missing' | 'online-disabled' | 'provider-not-found' }
  | { kind: 'hit_synced'; sourceLabel: string; cached: boolean; syncedLines: LyricsLine[] }
  | { kind: 'hit_plain'; sourceLabel: string; cached: boolean; plainLyrics: string }
  | { kind: 'hit_empty'; message: string; sourceLabel: string; cached: boolean }
  | { kind: 'idle'; message: string }

export const DEFAULT_LYRICS_BODY_COPY: LyricsBodyCopy = {
  noTrackMessage: 'No track selected.',
  loadingMessage: 'Loading lyrics...',
  idleMessage: 'Lyrics are ready when a track is selected.',
  noReadableTextMessage: 'Lyrics were found, but no readable text is available.',
  onlineDisabledMessage: 'No embedded lyrics found. Enable Online Lyrics Lookup in Settings to fetch from LRCLIB.',
  providerNotFoundMessage: 'No lyrics found on LRCLIB for this track.',
  embeddedMissingMessage: 'No embedded lyrics found for this track.'
}

export const INFO_SIDEBAR_LYRICS_BODY_COPY: LyricsBodyCopy = {
  ...DEFAULT_LYRICS_BODY_COPY,
  idleMessage: 'Open the Lyrics tab to load lyrics for the current track.'
}

export function getLyricsSourceLabel(source: LyricsSource): string {
  if (source === 'embedded') return 'Embedded'
  if (source === 'manual') return 'Manual'
  return 'LRCLIB'
}

export function buildLyricsQuery(track: Track | null): LyricsTrackQuery | null {
  if (!track) return null
  return {
    path: track.path,
    title: track.title,
    artist: track.artist,
    album: track.album || undefined,
    durationSeconds: Number.isFinite(track.duration) ? track.duration : undefined
  }
}

export function getLyricsRequestKey(query: LyricsTrackQuery | null): string {
  if (!query) return '__none__'
  return `${query.path}\u0000${query.title}\u0000${query.artist}\u0000${query.album ?? ''}\u0000${query.durationSeconds ?? ''}`
}

export function getActiveLyricsResult(
  currentTrackPath: string | null | undefined,
  lyricsTrackPath: string | null,
  lyricsResult: LyricsLookupResult | null
): LyricsLookupResult | null {
  if (!currentTrackPath) return null
  if (lyricsTrackPath !== currentTrackPath) return null
  return lyricsResult
}

export function findActiveSyncedLineIndex(lines: LyricsLine[], currentTimeSeconds: number): number {
  if (lines.length === 0) return -1
  const currentTimeMs = Number.isFinite(currentTimeSeconds)
    ? Math.max(0, Math.floor(currentTimeSeconds * 1000))
    : 0

  let low = 0
  let high = lines.length - 1
  let best = -1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (lines[mid].timestampMs <= currentTimeMs) {
      best = mid
      low = mid + 1
      continue
    }
    high = mid - 1
  }

  return best
}

export function getLyricsMetaChipText(options: {
  currentTrack: Track | { path: string } | null
  activeLyricsResult: LyricsLookupResult | null
  hasSyncedLyrics: boolean
  isLoading: boolean
  errorMessage: string
}): string {
  const { currentTrack, activeLyricsResult, hasSyncedLyrics, isLoading, errorMessage } = options
  if (!currentTrack) return 'No Track'
  if (isLoading && !activeLyricsResult) return 'Loading'
  if (activeLyricsResult?.status === 'hit') {
    const sourceLabel = getLyricsSourceLabel(activeLyricsResult.lyrics.source)
    const syncLabel = hasSyncedLyrics ? 'Synced' : 'Unsynced'
    const cachedLabel = activeLyricsResult.cached ? ' • Cached' : ''
    return `${sourceLabel} • ${syncLabel}${cachedLabel}`
  }
  if (activeLyricsResult?.status === 'transient_error') return 'Error'
  if (activeLyricsResult?.status === 'not_found') {
    return activeLyricsResult.reason === 'online-disabled' ? 'Online Off' : 'Not Found'
  }
  if (errorMessage) return 'Error'
  return 'Ready'
}

export function resolveLyricsBodyState(options: ResolveLyricsBodyStateOptions): LyricsBodyState {
  const { currentTrack, activeLyricsResult, isLoading, errorMessage, copy } = options

  if (!currentTrack) {
    return {
      kind: 'no-track',
      message: copy.noTrackMessage
    }
  }

  if (isLoading && !activeLyricsResult) {
    return {
      kind: 'loading',
      message: copy.loadingMessage
    }
  }

  if (activeLyricsResult?.status === 'transient_error') {
    return {
      kind: 'transient_error',
      message: activeLyricsResult.message
    }
  }

  if (activeLyricsResult?.status === 'not_found') {
    const message = activeLyricsResult.reason === 'online-disabled'
      ? copy.onlineDisabledMessage
      : activeLyricsResult.reason === 'provider-not-found'
        ? copy.providerNotFoundMessage
        : copy.embeddedMissingMessage

    return {
      kind: 'not_found',
      message,
      reason: activeLyricsResult.reason
    }
  }

  if (activeLyricsResult?.status === 'hit') {
    const sourceLabel = getLyricsSourceLabel(activeLyricsResult.lyrics.source)
    const cached = activeLyricsResult.cached
    const syncedLines = activeLyricsResult.lyrics.syncedLines
    if (syncedLines.length > 0) {
      return {
        kind: 'hit_synced',
        sourceLabel,
        cached,
        syncedLines
      }
    }

    const plainLyrics = activeLyricsResult.lyrics.plainLyrics?.trim() ?? ''
    if (plainLyrics.length > 0) {
      return {
        kind: 'hit_plain',
        sourceLabel,
        cached,
        plainLyrics
      }
    }

    return {
      kind: 'hit_empty',
      message: copy.noReadableTextMessage,
      sourceLabel,
      cached
    }
  }

  if (errorMessage) {
    return {
      kind: 'transient_error',
      message: errorMessage
    }
  }

  return {
    kind: 'idle',
    message: copy.idleMessage
  }
}
