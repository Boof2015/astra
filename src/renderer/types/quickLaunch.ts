import type { SettingsSectionId } from '../constants/settingsSections'
import type { TrackSourceType } from '../../types/subsonic'

export type QuickLaunchTrackAction = 'play-now' | 'queue-next'

export interface QuickLaunchTrackRecord {
  id: number
  path: string
  album_identity_key: string
  title: string
  artist: string
  artist_names: string[]
  album: string
  album_artist: string | null
  album_artist_names: string[]
  duration: number
  track_number: number | null
  disc_number: number | null
  year: number | null
  genre: string | null
  genres: string[]
  artwork_hash: string | null
  format: string
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  replaygain_track_gain_db: number | null
  replaygain_album_gain_db: number | null
  source_type: TrackSourceType
  source_id: number | null
  source_track_id: string | null
  source_path: string | null
  is_available: number
  availability_reason: string | null
  codec?: string | null
  codec_profile?: string | null
  is_atmos_joc?: number | null
  is_iamf?: number | null
}

export interface QuickLaunchAlbumRecord {
  identity_key: string
  album: string
  artist: string
  year: number | null
  artwork_hash: string | null
  track_count: number
}

export interface QuickLaunchArtistRecord {
  artist: string
  track_count: number
  artwork_hash: string | null
}

export interface QuickLaunchPlaylistRecord {
  id: number
  name: string
  kind?: 'normal' | 'dynamic'
  track_count: number
  custom_cover_hash: string | null
  auto_cover_hash: string | null
}

interface QuickLaunchBaseResult {
  id: string
  score: number
}

export interface QuickLaunchSettingResult extends QuickLaunchBaseResult {
  kind: 'setting'
  sectionId: SettingsSectionId
  label: string
  subtitle: string
}

export interface QuickLaunchTrackResult extends QuickLaunchBaseResult {
  kind: 'track'
  track: QuickLaunchTrackRecord
}

export interface QuickLaunchAlbumResult extends QuickLaunchBaseResult {
  kind: 'album'
  album: QuickLaunchAlbumRecord
}

export interface QuickLaunchArtistResult extends QuickLaunchBaseResult {
  kind: 'artist'
  artist: QuickLaunchArtistRecord
}

export interface QuickLaunchPlaylistResult extends QuickLaunchBaseResult {
  kind: 'playlist'
  playlist: QuickLaunchPlaylistRecord
}

export interface QuickLaunchNavResult extends QuickLaunchBaseResult {
  kind: 'nav'
  label: string
  view: string
}

export interface QuickLaunchSeeAllResult {
  kind: 'see-all'
  id: 'see-all-in-library'
  query: string
}

export type QuickLaunchResult =
  | QuickLaunchSettingResult
  | QuickLaunchTrackResult
  | QuickLaunchAlbumResult
  | QuickLaunchArtistResult
  | QuickLaunchPlaylistResult
  | QuickLaunchNavResult
  | QuickLaunchSeeAllResult
