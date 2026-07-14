export const COMPANION_API_VERSION = '2.0'
export const COMPANION_API_DEFAULT_SEARCH_LIMIT = 20
export const COMPANION_API_MAX_SEARCH_LIMIT = 50
export const COMPANION_API_MAX_MUTATION_REFS = 100
export const COMPANION_API_DEFAULT_POSITION_INTERVAL_MS = 1_000
export const COMPANION_API_MIN_POSITION_INTERVAL_MS = 250
export const COMPANION_API_MAX_POSITION_INTERVAL_MS = 5_000

export type CompanionApiScope =
  | 'observe'
  | 'playback-control'
  | 'library-search'
  | 'library-write'

export const COMPANION_API_SCOPES: readonly CompanionApiScope[] = [
  'observe',
  'playback-control',
  'library-search',
  'library-write'
]

export type CompanionApiTransport = 'loopback' | 'paired-lan'
export type CompanionApiTargetType = 'track' | 'album' | 'artist' | 'playlist'
export type CompanionApiPlaybackState = 'stopped' | 'playing' | 'paused' | 'loading'
export type CompanionApiRepeatMode = 'none' | 'one' | 'all'

export interface CompanionApiTrackSummary {
  ref: string | null
  title: string
  artist: string
  artists: string[]
  album: string
  albumArtists: string[]
  durationSeconds: number | null
  year: number | null
  genres: string[]
  format: string | null
  sampleRateHz: number | null
  bitDepth: number | null
  channels: number | null
  favorite: boolean
  artworkUrl: string | null
}

export interface CompanionApiPlaybackSnapshot {
  state: CompanionApiPlaybackState
  positionSeconds: number
  durationSeconds: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: CompanionApiRepeatMode
  outputDeviceLabel: string | null
  queueCount: number
  currentTrack: CompanionApiTrackSummary | null
  updatedAt: number
}

export interface CompanionApiQueueItem {
  id: string
  track: CompanionApiTrackSummary
  current: boolean
}

export interface CompanionApiQueueSnapshot {
  items: CompanionApiQueueItem[]
  updatedAt: number
}

export interface CompanionApiSearchResult {
  type: CompanionApiTargetType
  ref: string
  title: string
  subtitle: string | null
  artworkUrl: string | null
  writable?: boolean
}

export interface CompanionApiSearchResponse {
  query: string
  results: CompanionApiSearchResult[]
  limit: number
}

export type CompanionApiPlaybackAction =
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'stop' }
  | { action: 'next' }
  | { action: 'previous' }
  | { action: 'seek'; positionSeconds: number }
  | { action: 'set-volume'; volume: number }
  | { action: 'set-muted'; muted: boolean }
  | { action: 'set-shuffle'; enabled: boolean }
  | { action: 'set-repeat'; mode: CompanionApiRepeatMode }

export type CompanionApiRendererCommand =
  | { type: 'playback-action'; action: CompanionApiPlaybackAction }
  | {
      type: 'open-target'
      target:
        | { type: 'track'; trackPath: string }
        | { type: 'album'; album: string; artist: string; identityKey: string }
        | { type: 'artist'; artist: string }
        | { type: 'playlist'; playlistId: number }
    }
  | { type: 'play-paths'; trackPaths: string[]; contextLabel: string }
  | { type: 'enqueue-paths'; trackPaths: string[]; position: 'next' | 'end' }
  | { type: 'move-queue-item'; queueItemId: string; position: number }
  | { type: 'remove-queue-item'; queueItemId: string }
  | { type: 'clear-upcoming-queue' }

export interface CompanionApiLibraryEvent {
  kind: 'favorite' | 'playlist'
  change: 'created' | 'renamed' | 'items-changed' | 'deleted' | 'favorite-set'
  ref: string | null
  favorite?: boolean
  updatedAt: number
}

export interface CompanionApiErrorBody {
  error: {
    code: string
    message: string
  }
}
