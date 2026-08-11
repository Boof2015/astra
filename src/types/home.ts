export interface HomeReleaseSummary {
  identity_key: string
  album: string
  artist: string
  year: number | null
  artwork_hash: string | null
  track_count: number
  available_track_count: number
  play_count: number
  favorite_track_count: number
  last_played_at: number | null
  latest_added_at: number
}

export interface HomeRediscoveryRelease extends HomeReleaseSummary {
  reason: string
  reason_kind: 'favorite' | 'never-played' | 'long-unheard' | 'fallback'
}

export interface HomeDashboardQuery {
  rotation?: number
  excludedReleaseIdentityKeys?: string[]
}

export interface HomeDashboard {
  day_key: string
  recent_releases: HomeReleaseSummary[]
  rediscover_releases: HomeRediscoveryRelease[]
  newly_added_releases: HomeReleaseSummary[]
}
