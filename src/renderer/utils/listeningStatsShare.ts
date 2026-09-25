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
  /** Short range tag for the header, e.g. "30 DAYS". */
  rangeTag: string
  title: string
  hero: ListeningStatsShareItem | null
  heroTitle: string
  heroSubtitle: string
  /** The headline number beside the hero artwork. */
  heroStat: ListeningStatsShareStat
  /** Readout rows under the headline number. */
  heroReadouts: ListeningStatsShareStat[]
  listHeading: string
  overviewItems: ListeningStatsShareItem[]
  secondaryItems: ListeningStatsShareItem[]
  /** Whole-period totals; empty for the overview lens, whose readout already shows them. */
  periodStats: ListeningStatsShareStat[]
  /** Activity bar heights in the ranking metric, merged to at most MAX_ACTIVITY_BARS. */
  activity: number[]
  activityStartLabel: string
  activityEndLabel: string
  /** The busiest bar (first one on ties) and its caption; null when nothing was played. */
  activityPeak: { index: number; label: string } | null
  artworkHashes: string[]
  suggestedFileName: string
}

export const MAX_ACTIVITY_BARS = 60

const DAY_MS = 86_400_000
const RANGE_DAYS: Record<Exclude<ListeningStatsRange, 'all'>, number> = { '7d': 7, '30d': 30, '1y': 365 }
const RANGE_TAGS: Record<ListeningStatsRange, string> = {
  '7d': '7 DAYS',
  '30d': '30 DAYS',
  '1y': '12 MONTHS',
  all: 'ALL TIME'
}
const COUNT_FORMATTER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const FULL_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const MONTH_FORMATTER = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' })
const MONTH_ONLY_FORMATTER = new Intl.DateTimeFormat('en-US', { month: 'short' })

function safeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function formatCount(value: number): string {
  return COUNT_FORMATTER.format(Math.round(safeNumber(value)))
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

function formatShare(part: number, total: number): string {
  const safeTotal = safeNumber(total)
  const safePart = Math.min(safeNumber(part), safeTotal)
  if (safeTotal <= 0 || safePart <= 0) return '0%'
  const percentage = (safePart / safeTotal) * 100
  if (percentage < 1) return '<1%'
  return `${Math.min(100, Math.round(percentage))}%`
}

export function formatListeningShare(partSeconds: number, totalSeconds: number): string {
  return formatShare(partSeconds, totalSeconds)
}

export function formatPlayShare(partPlays: number, totalPlays: number): string {
  return formatShare(partPlays, totalPlays)
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

/**
 * Days the active-day count can be measured against: the range length, shortened
 * when detailed history started partway through it. Null for all-time ranges.
 */
function activeDayDenominator(dashboard: ListeningStatsDashboard): number | null {
  if (dashboard.range === 'all') return null
  const rangeDays = RANGE_DAYS[dashboard.range]
  const startedAt = dashboard.status.startedAt
  if (startedAt == null) return rangeDays
  const startedDay = new Date(startedAt)
  startedDay.setHours(0, 0, 0, 0)
  const recordedDays = Math.ceil((dashboard.rangeEndAt - startedDay.getTime()) / DAY_MS)
  return Math.max(1, Math.min(rangeDays, recordedDays))
}

function formatActiveDays(dashboard: ListeningStatsDashboard): string {
  const active = formatCount(dashboard.summary.activeDays)
  const denominator = activeDayDenominator(dashboard)
  return denominator == null ? active : `${active}/${formatCount(denominator)}`
}

function activityGroupSize(count: number, maxBars = MAX_ACTIVITY_BARS): number {
  return count <= maxBars ? 1 : Math.ceil(count / maxBars)
}

export function mergeActivityBars(values: readonly number[], maxBars = MAX_ACTIVITY_BARS): number[] {
  const safe = values.map(safeNumber)
  const groupSize = activityGroupSize(safe.length, maxBars)
  if (groupSize === 1) return safe
  const merged: number[] = []
  for (let index = 0; index < safe.length; index += groupSize) {
    merged.push(safe.slice(index, index + groupSize).reduce((sum, value) => sum + value, 0))
  }
  return merged
}

function activityLabels(dashboard: ListeningStatsDashboard): { start: string; end: string } {
  const first = dashboard.activity[0]
  if (!first) return { start: '', end: '' }
  const end = dashboard.rangeEndAt
  if (dashboard.granularity === 'month') {
    return {
      start: MONTH_FORMATTER.format(first.startAt).toUpperCase(),
      end: MONTH_FORMATTER.format(end).toUpperCase()
    }
  }
  const formatter = new Date(first.startAt).getFullYear() === new Date(end).getFullYear()
    ? SHORT_DATE_FORMATTER
    : FULL_DATE_FORMATTER
  return {
    start: formatter.format(first.startAt).toUpperCase(),
    end: formatter.format(end).toUpperCase()
  }
}

function formatMonthSpan(startAt: number, endAt: number): string {
  const sameYear = new Date(startAt).getFullYear() === new Date(endAt).getFullYear()
  const start = sameYear ? MONTH_ONLY_FORMATTER.format(startAt) : MONTH_FORMATTER.format(startAt)
  return `${start}–${MONTH_FORMATTER.format(endAt)}`
}

function activityPeak(
  dashboard: ListeningStatsDashboard,
  bars: readonly number[]
): ListeningStatsShareModel['activityPeak'] {
  const peakValue = Math.max(0, ...bars)
  if (peakValue <= 0) return null
  const index = bars.indexOf(peakValue)
  const groupSize = activityGroupSize(dashboard.activity.length)
  const bucket = dashboard.activity[index * groupSize]
  if (!bucket) return null
  // A merged bar covers several buckets, so name the span rather than its first month.
  const lastBucket = dashboard.activity[Math.min(dashboard.activity.length, (index + 1) * groupSize) - 1]
  const when = dashboard.granularity !== 'month'
    ? `${dashboard.granularity === 'week' ? 'WEEK OF ' : ''}${SHORT_DATE_FORMATTER.format(bucket.startAt)}`
    : groupSize > 1 && lastBucket && lastBucket !== bucket
      ? formatMonthSpan(bucket.startAt, lastBucket.startAt)
      : MONTH_FORMATTER.format(bucket.startAt)
  const amount = dashboard.rankingMetric === 'plays'
    ? `${formatCount(peakValue)} ${Math.round(peakValue) === 1 ? 'PLAY' : 'PLAYS'}`
    : formatCompactListeningDuration(peakValue)
  return { index, label: `PEAK ${when} · ${amount}`.toUpperCase() }
}

function trackItem(track: ListeningStatsDashboard['topTracks'][number], rank = 1): ListeningStatsShareItem {
  return {
    kind: 'track',
    rank,
    available: track.available,
    key: track.key,
    title: track.title,
    subtitle: `${track.artist} — ${track.album}`,
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

/**
 * Headline number and readout rows for a ranked hero. Everything is expressed in
 * the ranking metric so the card never ranks by plays but brags in minutes.
 * `runnerUp` comes from the unfiltered ranking so the lead stays truthful even
 * when #2 is hidden from the list for being unavailable.
 */
function rankedHeroStats(
  dashboard: ListeningStatsDashboard,
  hero: ListeningStatsShareItem | null,
  runnerUp: ListeningStatsShareItem | null
): { heroStat: ListeningStatsShareStat; heroReadouts: ListeningStatsShareStat[] } {
  const byPlays = dashboard.rankingMetric === 'plays'
  const metricOf = (item: ListeningStatsShareItem) => byPlays ? safeNumber(item.qualifiedPlays) : safeNumber(item.listenedSeconds)
  const formatMetric = (value: number) => byPlays ? formatCount(value) : formatCompactListeningDuration(value)

  if (!hero) {
    return { heroStat: { label: byPlays ? 'PLAYS' : 'LISTENED', value: '—' }, heroReadouts: [] }
  }

  let lead = '—'
  if (runnerUp) {
    const difference = metricOf(hero) - metricOf(runnerUp)
    lead = difference > 0 && formatMetric(difference) !== '<1m' ? `+${formatMetric(difference)}` : 'TIED'
  }

  const heroReadouts: ListeningStatsShareStat[] = [
    byPlays
      ? { label: 'LISTENED', value: formatCompactListeningDuration(hero.listenedSeconds) }
      : { label: 'PLAYS', value: formatCount(hero.qualifiedPlays) },
    { label: 'LEAD ON #2', value: lead },
    byPlays
      ? { label: 'SHARE OF PLAYS', value: formatPlayShare(hero.qualifiedPlays, dashboard.summary.qualifiedPlays) }
      : { label: 'SHARE OF LISTENING', value: formatListeningShare(hero.listenedSeconds, dashboard.summary.listenedSeconds) }
  ]

  return {
    heroStat: { label: byPlays ? 'PLAYS' : 'LISTENED', value: formatMetric(metricOf(hero)) },
    heroReadouts
  }
}

export function buildListeningStatsShareModel(
  dashboard: ListeningStatsDashboard,
  lens: ListeningStatsShareLens
): ListeningStatsShareModel {
  const rankingLabel = dashboard.rankingMetric === 'plays' ? 'RANKED BY PLAYS' : 'RANKED BY LISTENING TIME'
  const periodStats: ListeningStatsShareStat[] = [
    { label: 'LISTENED', value: formatCompactListeningDuration(dashboard.summary.listenedSeconds) },
    { label: 'PLAYS', value: formatCount(dashboard.summary.qualifiedPlays) },
    { label: 'ACTIVE DAYS', value: formatActiveDays(dashboard) },
    { label: 'TRACKS', value: formatCount(dashboard.summary.tracksPlayed) }
  ]
  const labels = activityLabels(dashboard)
  const activity = mergeActivityBars(dashboard.activity.map((bucket) =>
    dashboard.rankingMetric === 'plays' ? bucket.qualifiedPlays : bucket.listenedSeconds
  ))
  const common = {
    lens,
    range: dashboard.range,
    rankingMetric: dashboard.rankingMetric,
    rankingLabel,
    rangeLabel: formatRangeLabel(dashboard),
    rangeTag: RANGE_TAGS[dashboard.range],
    activity,
    activityStartLabel: labels.start,
    activityEndLabel: labels.end,
    activityPeak: activityPeak(dashboard, activity),
    suggestedFileName: createSuggestedFileName(dashboard)
  }

  if (lens === 'track' || lens === 'album') {
    const items = lens === 'track'
      ? dashboard.topTracks.map((track, index) => trackItem(track, index + 1))
      : dashboard.topAlbums.map((album, index) => albumItem(album, index + 1))
    const hero = items[0] ?? null
    const secondaryItems = items.slice(1, 4).filter((item) => item.available)
    return {
      ...common,
      ...rankedHeroStats(dashboard, hero, items[1] ?? null),
      title: lens === 'track' ? 'TOP TRACK' : 'TOP ALBUM',
      hero,
      heroTitle: hero?.title ?? 'Nothing played yet',
      heroSubtitle: hero?.subtitle ?? '',
      listHeading: 'NEXT UP',
      overviewItems: [],
      secondaryItems,
      periodStats,
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
  const topArtistShare = dashboard.rankingMetric === 'plays'
    ? `${formatPlayShare(topArtist?.qualifiedPlays ?? 0, dashboard.summary.qualifiedPlays)} of plays`
    : `${formatListeningShare(topArtist?.listenedSeconds ?? 0, dashboard.summary.listenedSeconds)} of listening time`

  return {
    ...common,
    title: 'OVERVIEW',
    hero: null,
    heroTitle: 'Your listening',
    heroSubtitle: topArtist ? `${topArtist.title} led with ${topArtistShare}` : '',
    heroStat: periodStats[0],
    heroReadouts: periodStats.slice(1),
    listHeading: 'TOP PICKS',
    overviewItems,
    secondaryItems: [],
    periodStats: [],
    artworkHashes: collectOverviewArtworkHashes(dashboard, overviewItems)
  }
}
