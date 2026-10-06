export interface ProviderSyncRef { provider: 'subsonic' | 'jellyfin'; sourceId: number }
export type ProviderSyncField = 'favorite' | 'rating'
export type ProviderSyncValue = boolean | number | null
export interface ProviderUserState { favorite: boolean; rating?: number | null }
export interface ProviderSyncTrack extends ProviderUserState {
  path: string; id: string; title: string; artist: string
  favoriteMixed?: boolean
}
export interface ProviderSyncDifference {
  key: string
  path: string
  id: string
  title: string
  artist: string
  field: ProviderSyncField
  local: ProviderSyncValue
  server: ProviderSyncValue
  reason: 'initial' | 'changed' | 'precision'
}
export type ProviderSyncChoice = 'local' | 'server' | 'up' | 'down' | 'clear'
export interface ProviderSyncReview {
  token: string
  ref: ProviderSyncRef
  differences: ProviderSyncDifference[]
  matchedTracks: number
  missingTracks: number
  enabling: boolean
}
export interface ProviderSyncStatus extends ProviderSyncRef {
  enabled: boolean
  busy: boolean
  conflicts: number
  error: string | null
  lastSyncAt: number | null
}
export interface ProviderSyncAPI {
  status(): Promise<ProviderSyncStatus[]>
  review(ref: ProviderSyncRef): Promise<ProviderSyncReview>
  apply(token: string, choices: Record<string, ProviderSyncChoice>): Promise<void>
  disable(ref: ProviderSyncRef): Promise<void>
  refresh(ref: ProviderSyncRef): Promise<void>
  onChanged(callback: () => void): () => void
}
