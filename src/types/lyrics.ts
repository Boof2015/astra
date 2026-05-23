export type LyricsProvider = 'lrclib'
export type LyricsSource = 'embedded' | 'lrclib' | 'manual' | 'lrc' | 'xlrc'
export type LyricsFormat = 'plain' | 'lrc' | 'xlrc'
export type LyricsLookupStatus = 'hit' | 'not_found' | 'transient_error'

export interface LyricsFurigana {
  start: number
  end: number
  base: string
  reading: string
}

export interface LyricsWord {
  timestampMs: number
  text: string
  furigana?: LyricsFurigana[]
}

export interface LyricsTranslation {
  lang: string
  text: string
}

export interface LyricsLine {
  timestampMs: number
  text: string
  kind?: 'silence'
  words?: LyricsWord[]
  furigana?: LyricsFurigana[]
  translations?: LyricsTranslation[]
  voice?: string | null
}

export interface LyricsTrackQuery {
  path: string
  title: string
  artist: string
  album?: string
  durationSeconds?: number
}

export interface LyricsPayload {
  source: LyricsSource
  provider: LyricsProvider | null
  format: LyricsFormat
  plainLyrics: string | null
  syncedLyrics: string | null
  syncedLines: LyricsLine[]
}

export type LyricsLookupResult =
  | { status: 'hit'; lyrics: LyricsPayload; cached: boolean }
  | { status: 'not_found'; reason: 'embedded-missing' | 'online-disabled' | 'provider-not-found' }
  | { status: 'transient_error'; message: string; code?: string }

export interface LyricsStatus {
  enabled: boolean
  provider: LyricsProvider
  statusMessage: string
  lastError: string | null
}

export interface LyricsTrackOverride {
  trackPath: string
  hasManualLyrics: boolean
  format: LyricsFormat
  plainLyrics: string | null
  syncedLyrics: string | null
  syncedLines: LyricsLine[]
  syncOffsetMs: number
  updatedAt: number | null
}

export interface LyricsManualImportResult {
  updated: number
  hasPlainLyrics: boolean
  hasSyncedLyrics: boolean
}

export interface LyricsManualClearResult {
  cleared: number
}

export interface LyricsOffsetSetResult {
  updated: number
  offsetMs: number
}
