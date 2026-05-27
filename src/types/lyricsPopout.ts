import type { LyricsLookupResult, LyricsTrackQuery } from './lyrics'

export type LyricsPopoutPlaybackState = 'stopped' | 'playing' | 'paused' | 'loading'

export interface LyricsPopoutTrackSnapshot {
  path: string
  title: string
  artist: string
  album: string
}

export interface LyricsPopoutSnapshot {
  capturedAt: number
  preferredExpanded: boolean
  playbackState: LyricsPopoutPlaybackState
  currentTime: number
  duration: number
  effectiveDelayMs: number
  currentTrack: LyricsPopoutTrackSnapshot | null
  lyricsQuery: LyricsTrackQuery | null
  lyricsResult: LyricsLookupResult | null
  isLoading: boolean
  errorMessage: string
}

export interface LyricsPopoutWindowState {
  isOpen: boolean
}

export interface LyricsPopoutWindowPrefs {
  x?: number
  y?: number
  width: number
  height: number
}

export type LyricsPopoutCommand =
  | { type: 'refresh' }
  | { type: 'seek'; time: number }

export const LYRICS_POPOUT_WINDOW_MIN_WIDTH = 360
export const LYRICS_POPOUT_WINDOW_MIN_HEIGHT = 220
export const LYRICS_POPOUT_WINDOW_DEFAULT_WIDTH = 520
export const LYRICS_POPOUT_WINDOW_DEFAULT_HEIGHT = 420

const MAX_WIDTH = 1800
const MAX_HEIGHT = 1400

const DEFAULT_PREFS: LyricsPopoutWindowPrefs = {
  width: LYRICS_POPOUT_WINDOW_DEFAULT_WIDTH,
  height: LYRICS_POPOUT_WINDOW_DEFAULT_HEIGHT,
}

export interface LyricsPopoutWorkArea {
  x: number
  y: number
  width: number
  height: number
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function intersects(left: LyricsPopoutWorkArea, right: LyricsPopoutWorkArea): boolean {
  return left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
}

function isOnAnyDisplay(bounds: LyricsPopoutWorkArea, displays: LyricsPopoutWorkArea[]): boolean {
  return displays.some((display) => intersects(bounds, display))
}

export function normalizeLyricsPopoutWindowPrefs(
  value: unknown,
  displays: LyricsPopoutWorkArea[] = []
): LyricsPopoutWindowPrefs {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_PREFS }
  }

  const raw = value as Record<string, unknown>
  const width = clamp(
    Math.round(toFiniteNumber(raw.width) ?? DEFAULT_PREFS.width),
    LYRICS_POPOUT_WINDOW_MIN_WIDTH,
    MAX_WIDTH
  )
  const height = clamp(
    Math.round(toFiniteNumber(raw.height) ?? DEFAULT_PREFS.height),
    LYRICS_POPOUT_WINDOW_MIN_HEIGHT,
    MAX_HEIGHT
  )

  const x = toFiniteNumber(raw.x)
  const y = toFiniteNumber(raw.y)
  if (x === undefined || y === undefined) {
    return { width, height }
  }

  const bounds: LyricsPopoutWorkArea = {
    x: Math.round(x),
    y: Math.round(y),
    width,
    height
  }

  if (displays.length > 0 && !isOnAnyDisplay(bounds, displays)) {
    return { width, height }
  }

  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  }
}
