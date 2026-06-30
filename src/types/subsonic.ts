export type TrackSourceType = 'local' | 'subsonic' | 'jellyfin'

export type SubsonicSourceLastStatus =
  | 'unknown'
  | 'ok'
  | 'error'
  | 'disabled'
  | 'syncing'

export type SubsonicSyncPhase =
  | 'connecting'
  | 'artists'
  | 'albums'
  | 'tracks'
  | 'playlists'
  | 'artwork'
  | 'finalizing'

export interface SubsonicSourceSyncProgress {
  phase: SubsonicSyncPhase
  activity: string
  current: number | null
  total: number | null
  detail: string | null
  updatedAt: number
}

export interface SubsonicSourceStatus {
  sourceId: number
  enabled: boolean
  status: SubsonicSourceLastStatus
  error: string | null
  lastSyncAt: number | null
  lastCheckedAt: number | null
  progress: SubsonicSourceSyncProgress | null
}

export interface SubsonicSource {
  id: number
  name: string
  base_url: string
  username: string
  enabled: number
  last_status: SubsonicSourceLastStatus
  last_error: string | null
  last_sync_at: number | null
  last_checked_at: number | null
  created_at: number
  updated_at: number
  has_stored_secret: boolean
}

export interface SubsonicSourceCreateInput {
  name: string
  baseUrl: string
  username: string
  password: string
  enabled: boolean
}

export interface SubsonicSourceUpdateInput {
  name?: string
  baseUrl?: string
  username?: string
  password?: string
  enabled?: boolean
}

export interface SubsonicSourceTestInput {
  sourceId?: number
  baseUrl?: string
  username?: string
  password?: string
}

export interface SubsonicSourceTestResult {
  ok: boolean
  message: string
  error?: string
}

export interface SubsonicStatusSnapshot {
  isSyncing: boolean
  updatedAt: number
  sources: SubsonicSourceStatus[]
}

export type JellyfinSourceLastStatus =
  | 'unknown'
  | 'ok'
  | 'error'
  | 'disabled'
  | 'syncing'

export type JellyfinSyncPhase =
  | 'connecting'
  | 'items'
  | 'artwork'
  | 'finalizing'

export interface JellyfinSourceSyncProgress {
  phase: JellyfinSyncPhase
  activity: string
  current: number | null
  total: number | null
  detail: string | null
  updatedAt: number
}

export interface JellyfinSourceStatus {
  sourceId: number
  enabled: boolean
  status: JellyfinSourceLastStatus
  error: string | null
  lastSyncAt: number | null
  lastCheckedAt: number | null
  progress: JellyfinSourceSyncProgress | null
}

export interface JellyfinSource {
  id: number
  name: string
  base_url: string
  username: string
  enabled: number
  last_status: JellyfinSourceLastStatus
  last_error: string | null
  last_sync_at: number | null
  last_checked_at: number | null
  created_at: number
  updated_at: number
  has_stored_secret: boolean
}

export interface JellyfinSourceCreateInput {
  name: string
  baseUrl: string
  username: string
  password: string
  enabled: boolean
}

export interface JellyfinSourceUpdateInput {
  name?: string
  baseUrl?: string
  username?: string
  password?: string
  enabled?: boolean
}

export interface JellyfinSourceTestInput {
  sourceId?: number
  baseUrl?: string
  username?: string
  password?: string
}

export interface JellyfinSourceTestResult {
  ok: boolean
  message: string
  error?: string
}

export interface JellyfinStatusSnapshot {
  isSyncing: boolean
  updatedAt: number
  sources: JellyfinSourceStatus[]
}
