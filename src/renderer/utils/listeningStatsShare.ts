import type {
  ListeningStatsDashboard,
  ListeningStatsRange,
  ListeningStatsRankingMetric
} from '../../types/listeningStats'

export type ListeningStatsShareLens = 'overview' | 'track' | 'album'
export type ListeningStatsShareItemKind = 'track' | 'album' | 'artist'

export interface ListeningStatsShareItem {
  kind: ListeningStatsShareItemKind
  rank: number
  available: boolean
  key: string
  title: string
  subtitle: string
  artworkHash: string | null
  listenedSeconds: number
  qualifiedPlays: number
}

export interface ListeningStatsShareStat {
  label: string
  value: string
}

export interface ListeningStatsShareModel {
  lens: ListeningStatsShareLens
  range: ListeningStatsRange
  rankingMetric: ListeningStatsRankingMetric
  rankingLabel: string
  rangeLabel: string
  title: string
  heroLabel: string
  hero: ListeningStatsShareItem | null
  overviewItems: ListeningStatsShareItem[]
  secondaryItems: ListeningStatsShareItem[]
  summaryStats: ListeningStatsShareStat[]
  personality: string
  personalityValue: string
  personalityText: string
  artworkHashes: string[]
  suggestedFileName: string
}

const COUNT_FORMATTER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const FULL_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

function safeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function formatCompactListeningDuration(seconds: number): string {
  const totalMinutes = Math.floor(safeNumber(seconds) / 60)
  if (totalMinutes < 1) return '<1m'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 1) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}

export function formatListeningShare(partSeconds: number, totalSeconds: number): string {
  const total = safeNumber(totalSeconds)
  const part = Math.min(safeNumber(partSeconds), total)
  if (total <= 0 || part <= 0) return '0%'
  const percentage = (part / total) * 100
  if (percentage < 1) return '<1%'
  return `${Math.min(100, Math.round(percentage))}%`
}

function formatRangeLabel(dashboard: ListeningStatsDashboard): string {
  if (dashboard.range === 'all') {
    const start = dashboard.status.startedAt ?? dashboard.rangeStartAt
    return start == null ? 'ALL RECORDED LISTENING' : `SINCE ${FULL_DATE_FORMATTER.format(start).toUpperCase()}`
  }

  const start = dashboard.rangeStartAt
  if (start == null) return dashboard.range.toUpperCase()
  const end = dashboard.rangeEndAt
  const startYear = new Date(start).getFullYear()
  const endYear = new Date(end).getFullYear()
  if (startYear !== endYear) {
    return `${FULL_DATE_FORMATTER.format(start)} – ${FULL_DATE_FORMATTER.format(end)}`.toUpperCase()
  }
  return `${SHORT_DATE_FORMATTER.format(start)} – ${FULL_DATE_FORMATTER.format(end)}`.toUpperCase()
}

function trackItem(track: ListeningStatsDashboard['topTracks'][number], rank = 1): ListeningStatsShareItem {
  return {
    kind: 'track',
    rank,
    available: track.available,
    key: track.key,
    title: track.title,
    subtitle: `${track.artist} • ${track.album}`,
    artworkHash: track.artworkHash,
    listenedSeconds: track.listenedSeconds,
    qualifiedPlays: track.qualifiedPlays
  }
}

function albumItem(album: ListeningStatsDashboard['topAlbums'][number], rank = 1): ListeningStatsShareItem {
  return {
    kind: 'album',
    rank,
    available: album.available,
    key: album.key,
    title: album.album,
    subtitle: album.artist,
    artworkHash: album.artworkHash,
    listenedSeconds: album.listenedSeconds,
    qualifiedPlays: album.qualifiedPlays
  }
}

function artistItem(artist: ListeningStatsDashboard['topArtists'][number], rank = 1): ListeningStatsShareItem {
  return {
    kind: 'artist',
    rank,
    available: artist.available,
    key: artist.key,
    title: artist.artist,
    subtitle: 'Artist',
    artworkHash: artist.artworkHash,
    listenedSeconds: artist.listenedSeconds,
    qualifiedPlays: artist.qualifiedPlays
  }
}

function collectOverviewArtworkHashes(
  dashboard: ListeningStatsDashboard,
  overviewItems: ListeningStatsShareItem[]
): string[] {
  const candidates = [
    ...overviewItems.map((item) => item.artworkHash),
    ...dashboard.topAlbums.map((album) => album.artworkHash),
    ...dashboard.topTracks.map((track) => track.artworkHash)
  ]
  const unique: string[] = []
  for (const hash of candidates) {
    if (!hash || unique.includes(hash)) continue
    unique.push(hash)
    if (unique.length === 4) break
  }
  return unique
}

function createSuggestedFileName(dashboard: ListeningStatsDashboard): string {
  const date = new Date(dashboard.rangeEndAt).toISOString().slice(0, 10)
  return `astra-listening-${dashboard.range}-${date}.png`
}

export function buildListeningStatsShareModel(
  dashboard: ListeningStatsDashboard,
  lens: ListeningStatsShareLens
): ListeningStatsShareModel {
  const rankingLabel = dashboard.rankingMetric === 'plays' ? 'RANKED BY PLAYS' : 'RANKED BY LISTENING TIME'
  const summaryStats: ListeningStatsShareStat[] = [
    { label: 'LISTENED', value: formatCompactListeningDuration(dashboard.summary.listenedSeconds) },
    { label: 'PLAYS', value: COUNT_FORMATTER.format(safeNumber(dashboard.summary.qualifiedPlays)) },
    { label: 'ACTIVE DAYS', value: COUNT_FORMATTER.format(safeNumber(dashboard.summary.activeDays)) }
  ]
  const common = {
    lens,
    range: dashboard.range,
    rankingMetric: dashboard.rankingMetric,
    rankingLabel,
    rangeLabel: formatRangeLabel(dashboard),
    summaryStats,
    suggestedFileName: createSuggestedFileName(dashboard)
  }

  if (lens === 'track') {
    const items = dashboard.topTracks.map((track, index) => trackItem(track, index + 1))
    const hero = items[0] ?? null
    const secondaryItems = items.slice(1, 4).filter((item) => item.available)
    const share = formatListeningShare(hero?.listenedSeconds ?? 0, dashboard.summary.listenedSeconds)
    return {
      ...common,
      title: 'YOUR TOP TRACK',
      heroLabel: dashboard.rankingMetric === 'plays' ? 'MOST PLAYED TRACK' : 'MOST LISTENED TRACK',
      hero,
      overviewItems: [],
      secondaryItems,
      personality: hero ? `You gave this track ${share} of your listening time.` : '',
      personalityValue: share,
      personalityText: 'of your listening time went to this track.',
      artworkHashes: [...new Set([hero, ...secondaryItems]
        .map((item) => item?.artworkHash)
        .filter((hash): hash is string => Boolean(hash)))]
    }
  }

  if (lens === 'album') {
    const items = dashboard.topAlbums.map((album, index) => albumItem(album, index + 1))
    const hero = items[0] ?? null
    const secondaryItems = items.slice(1, 4).filter((item) => item.available)
    const share = formatListeningShare(hero?.listenedSeconds ?? 0, dashboard.summary.listenedSeconds)
    return {
      ...common,
      title: 'YOUR TOP ALBUM',
      heroLabel: dashboard.rankingMetric === 'plays' ? 'MOST PLAYED ALBUM' : 'MOST LISTENED ALBUM',
      hero,
      overviewItems: [],
      secondaryItems,
      personality: hero ? `You spent ${share} of your listening time inside this album.` : '',
      personalityValue: share,
      personalityText: 'of your listening time was spent inside this album.',
      artworkHashes: [...new Set([hero, ...secondaryItems]
        .map((item) => item?.artworkHash)
        .filter((hash): hash is string => Boolean(hash)))]
    }
  }

  const overviewItems = [
    dashboard.topTracks[0] ? trackItem(dashboard.topTracks[0]) : null,
    dashboard.topAlbums[0] ? albumItem(dashboard.topAlbums[0]) : null,
    dashboard.topArtists[0] ? artistItem(dashboard.topArtists[0]) : null
  ].filter((item): item is ListeningStatsShareItem => item !== null)
  const topArtist = overviewItems.find((item) => item.kind === 'artist') ?? null
  const share = formatListeningShare(topArtist?.listenedSeconds ?? 0, dashboard.summary.listenedSeconds)

  return {
    ...common,
    title: 'YOUR LISTENING',
    heroLabel: 'LISTENING SNAPSHOT',
    hero: null,
    overviewItems,
    secondaryItems: [],
    personality: topArtist ? `${topArtist.title} accounted for ${share} of your listening time.` : '',
    personalityValue: share,
    personalityText: topArtist ? `of your listening time went to ${topArtist.title}.` : 'of your listening time is still waiting to be discovered.',
    artworkHashes: collectOverviewArtworkHashes(dashboard, overviewItems)
  }
}
