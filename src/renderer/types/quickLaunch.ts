import type { SettingsSectionId } from '../constants/settingsSections'

export type QuickLaunchTrackAction = 'play-now' | 'queue-next'

export interface QuickLaunchTrackRecord {
  id: number
  path: string
  title: string
  artist: string
  album: string
  album_artist: string | null
  duration: number
  track_number: number | null
  disc_number: number | null
  year: number | null
  genre: string | null
  artwork_hash: string | null
  format: string
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  replaygain_track_gain_db: number | null
  replaygain_album_gain_db: number | null
  codec?: string | null
  codec_profile?: string | null
  is_atmos_joc?: number | null
}

export interface QuickLaunchAlbumRecord {
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
  | QuickLaunchNavResult
  | QuickLaunchSeeAllResult
