export type LyricsProvider = 'lrclib' | 'xlrcdb'
export type LyricsSource = 'embedded' | 'lrclib' | 'manual' | 'lrc' | 'xlrc' | 'xlrcdb'
export type LyricsFormat = 'plain' | 'lrc' | 'xlrc'
export type LyricsLookupStatus = 'hit' | 'not_found' | 'transient_error'

export const LRCLIB_OFFICIAL_BASE_URL = 'https://lrclib.net'

export function parseLrclibBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!parsed.hostname || parsed.username || parsed.password) return null

    parsed.search = ''
    parsed.hash = ''
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

export function normalizeLrclibBaseUrl(value: unknown): string {
  return parseLrclibBaseUrl(value) ?? LRCLIB_OFFICIAL_BASE_URL
}

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
  | { status: 'not_found'; reason: 'embedded-missing' | 'online-disabled' | 'provider-not-found' | 'provider-unavailable' }
  | { status: 'transient_error'; message: string; code?: string }

export interface LyricsStatus {
  enabled: boolean
  provider: LyricsProvider
  lrclibBaseUrl: string
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
