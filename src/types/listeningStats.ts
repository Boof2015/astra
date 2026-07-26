export type ListeningStatsRange = '7d' | '30d' | '1y' | 'all'
export type ListeningStatsRankingMetric = 'plays' | 'time'
export type ListeningStatsBucketGranularity = 'day' | 'week' | 'month'

export interface ListeningHistoryStatus {
  generation: string
  startedAt: number | null
}

export interface ListeningSessionCheckpoint {
  generation: string
  sessionKey: string
  segmentKey: string
  trackPath: string
  sourcePlaylistId: number | null
  sessionStartedAt: number
  segmentStartedAt: number
  observedAt: number
  sessionListenedSeconds: number
  segmentListenedSeconds: number
  trackDurationSeconds: number
  qualificationEligible: boolean
  finalizeSegment?: boolean
  finalizeSession?: boolean
  completedNaturally?: boolean
}

export interface ListeningSessionCheckpointResult {
  accepted: boolean
  qualifiedNow: boolean
  status: ListeningHistoryStatus
}

export interface ListeningStatsQuery {
  range: ListeningStatsRange
  rankingMetric: ListeningStatsRankingMetric
  artistBrowseMode: 'strict' | 'canonical'
  now?: number
}

export interface ListeningStatsActivityBucket {
  startAt: number
  endAt: number
  label: string
  listenedSeconds: number
  qualifiedPlays: number
}

export interface ListeningStatsSummary {
  listenedSeconds: number
  qualifiedPlays: number
  tracksPlayed: number
  activeDays: number
}

export interface ListeningStatsRankedTrack {
  key: string
  trackPath: string | null
  title: string
  artist: string
  album: string
  artworkHash: string | null
  listenedSeconds: number
  qualifiedPlays: number
  available: boolean
}

export interface ListeningStatsRankedArtist {
  key: string
  artist: string
  artworkHash: string | null
  listenedSeconds: number
  qualifiedPlays: number
  available: boolean
}

export interface ListeningStatsRankedAlbum {
  key: string
  album: string
  artist: string
  artworkHash: string | null
  listenedSeconds: number
  qualifiedPlays: number
  available: boolean
}

export interface ListeningStatsDashboard {
  status: ListeningHistoryStatus
  range: ListeningStatsRange
  rankingMetric: ListeningStatsRankingMetric
  rangeStartAt: number | null
  rangeEndAt: number
  granularity: ListeningStatsBucketGranularity
  summary: ListeningStatsSummary
  activity: ListeningStatsActivityBucket[]
  topTracks: ListeningStatsRankedTrack[]
  topArtists: ListeningStatsRankedArtist[]
  topAlbums: ListeningStatsRankedAlbum[]
}

// ── Stats transfer (settings import/export) ──────────────

export interface ListeningStatsTransferAvailability {
  hasHistory: boolean
  sessionCount: number
}

export interface ListeningStatsExportRequest {
  includeHistory?: boolean
  maxSessions?: number
}

export interface ListeningStatsExportBundle {
  counts: {
    encoded: string
    trackCount: number
    playCount: number
    ratingCount: number
    favoriteCount: number
  }
  history: {
    encoded: string
    sessionCount: number
    segmentCount: number
    sessionsTotal: number
    truncated: boolean
  } | null
}

export interface ListeningStatsApplyRequest {
  counts?: string
  history?: string
}

/** One external data source that has been imported, as shown in Settings. */
export interface ImportedListeningSource {
  source: string
  generator: string
  importedAt: number
  sessionCount: number
  trackCount: number
  playCount: number
}

export interface ImportedListeningSourceRemoval {
  source: string
  sessionsRemoved: number
  tracksAffected: number
}

/** What an import file contains, read before the user commits to applying it. */
export type ListeningImportPreview =
  | { ok: false; error: string }
  | {
      ok: true
      warnings: string[]
      source: string
      generator: string
      trackCount: number
      playCount: number
      eventCount: number
    }
