import type { PlaybackSourceContext } from './playbackSource'

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
  activeSource?: PlaybackSourceContext | null
  artistBrowseMode?: 'strict' | 'canonical'
  rotation?: number
  excludedReleaseIdentityKeys?: string[]
  jumpBackInReleaseLimit?: number
  rediscoverLimit?: number
  newlyAddedLimit?: number
}

export interface HomeDashboard {
  day_key: string
  recent_sources: HomePlaybackSourceSummary[]
  active_source: HomePlaybackSourceSummary | null
  recent_releases: HomeReleaseSummary[]
  rediscover_releases: HomeRediscoveryRelease[]
  newly_added_releases: HomeReleaseSummary[]
}

export interface HomePlaybackSourceSummary {
  key: string
  source: PlaybackSourceContext
  title: string
  subtitle: string
  detail: string
  artwork_hash: string | null
  last_played_at: number
}
