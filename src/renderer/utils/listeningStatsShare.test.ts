import assert from 'node:assert/strict'
import test from 'node:test'
import type { ListeningStatsDashboard } from '../../types/listeningStats'
import {
  buildListeningStatsShareModel,
  formatCompactListeningDuration,
  formatListeningShare,
  formatPlayShare,
  MAX_ACTIVITY_BARS,
  mergeActivityBars
} from './listeningStatsShare'

function createDashboard(overrides: Partial<ListeningStatsDashboard> = {}): ListeningStatsDashboard {
  const rangeStartAt = new Date(2026, 5, 18, 12, 0, 0).getTime()
  const rangeEndAt = new Date(2026, 6, 18, 12, 0, 0).getTime()
  return {
    status: { generation: 'fixture', startedAt: rangeStartAt },
    range: '30d',
    rankingMetric: 'plays',
    rangeStartAt,
    rangeEndAt,
    granularity: 'day',
    summary: { listenedSeconds: 10_000, qualifiedPlays: 74, tracksPlayed: 42, activeDays: 11 },
    activity: [],
    topTracks: [
      { key: 'track-1', trackPath: '/one', title: 'First Track', artist: 'First Artist', album: 'First Album', artworkHash: 'shared-art', listenedSeconds: 1_800, qualifiedPlays: 12, available: true },
      { key: 'track-2', trackPath: '/two', title: 'Second Track', artist: 'Second Artist', album: 'Second Album', artworkHash: 'track-art-2', listenedSeconds: 1_400, qualifiedPlays: 10, available: true },
      { key: 'track-3', trackPath: '/three', title: 'Third Track', artist: 'Third Artist', album: 'Third Album', artworkHash: 'track-art-3', listenedSeconds: 1_200, qualifiedPlays: 8, available: true },
      { key: 'track-4', trackPath: '/four', title: 'Fourth Track', artist: 'Fourth Artist', album: 'Fourth Album', artworkHash: null, listenedSeconds: 1_000, qualifiedPlays: 6, available: false },
      { key: 'track-5', trackPath: '/five', title: 'Fifth Track', artist: 'Fifth Artist', album: 'Fifth Album', artworkHash: 'track-art-5', listenedSeconds: 900, qualifiedPlays: 5, available: true }
    ],
    topArtists: [
      { key: 'artist-1', artist: 'First Artist', artworkHash: 'artist-art', listenedSeconds: 2_500, qualifiedPlays: 18, available: true }
    ],
    topAlbums: [
      { key: 'album-1', album: 'First Album', artist: 'First Artist', artworkHash: 'shared-art', listenedSeconds: 2_100, qualifiedPlays: 14, available: true },
      { key: 'album-2', album: 'Second Album', artist: 'Second Artist', artworkHash: 'album-art-2', listenedSeconds: 1_700, qualifiedPlays: 11, available: true },
      { key: 'album-3', album: 'Third Album', artist: 'Third Artist', artworkHash: 'album-art-3', listenedSeconds: 1_300, qualifiedPlays: 9, available: true },
      { key: 'album-4', album: 'Fourth Album', artist: 'Fourth Artist', artworkHash: null, listenedSeconds: 800, qualifiedPlays: 4, available: false }
    ],
    ...overrides
  }
}

test('compact share-card values favor readable hours, minutes, and small percentages', () => {
  assert.equal(formatCompactListeningDuration(12), '<1m')
  assert.equal(formatCompactListeningDuration(42 * 60), '42m')
  assert.equal(formatCompactListeningDuration((18 * 60 + 42) * 60), '18h 42m')
  assert.equal(formatListeningShare(1, 1_000), '<1%')
  assert.equal(formatListeningShare(180, 1_000), '18%')
  assert.equal(formatListeningShare(0, 0), '0%')
  assert.equal(formatPlayShare(12, 74), '16%')
  assert.equal(formatPlayShare(0, 74), '0%')
  assert.equal(formatPlayShare(5, 0), '0%')
  assert.equal(formatPlayShare(74, 74), '100%')
})

test('track lens uses the first ranked track as hero and omits unavailable secondary rows', () => {
  const model = buildListeningStatsShareModel(createDashboard(), 'track')
  assert.equal(model.hero?.key, 'track-1')
  assert.deepEqual(model.secondaryItems.map((item) => item.key), ['track-2', 'track-3'])
  assert.deepEqual(model.secondaryItems.map((item) => item.rank), [2, 3])
  assert.deepEqual(model.artworkHashes, ['shared-art', 'track-art-2', 'track-art-3'])
  assert.equal(model.rankingLabel, 'RANKED BY PLAYS')
  assert.equal(model.heroTitle, 'First Track')
  assert.deepEqual(model.periodStats, [
    { label: 'LISTENED', value: '2h 46m' },
    { label: 'PLAYS', value: '74' },
    { label: 'ACTIVE DAYS', value: '11/30' },
    { label: 'TRACKS', value: '42' }
  ])
})

test('hero readout speaks in the ranking metric and is kept apart from period totals', () => {
  const byPlays = buildListeningStatsShareModel(createDashboard(), 'track')
  assert.deepEqual(byPlays.heroStat, { label: 'PLAYS', value: '12' })
  assert.deepEqual(byPlays.heroReadouts, [
    { label: 'LISTENED', value: '30m' },
    { label: 'LEAD ON #2', value: '+2' },
    { label: 'SHARE OF PLAYS', value: '16%' }
  ])

  const byTime = buildListeningStatsShareModel(createDashboard({ rankingMetric: 'time' }), 'track')
  assert.deepEqual(byTime.heroStat, { label: 'LISTENED', value: '30m' })
  assert.deepEqual(byTime.heroReadouts, [
    { label: 'PLAYS', value: '12' },
    { label: 'LEAD ON #2', value: '+6m' },
    { label: 'SHARE OF LISTENING', value: '18%' }
  ])
})

test('lead is measured against the true #2 even when it is hidden from the list', () => {
  const dashboard = createDashboard()
  dashboard.topTracks[1] = { ...dashboard.topTracks[1], available: false, qualifiedPlays: 12 }
  const model = buildListeningStatsShareModel(dashboard, 'track')
  assert.deepEqual(model.secondaryItems.map((item) => item.key), ['track-3'])
  assert.equal(model.heroReadouts.find((row) => row.label === 'LEAD ON #2')?.value, 'TIED')

  const solo = buildListeningStatsShareModel(createDashboard({ topTracks: [createDashboard().topTracks[0]] }), 'track')
  assert.equal(solo.heroReadouts.find((row) => row.label === 'LEAD ON #2')?.value, '—')
})

test('active days are measured against the recorded part of bounded ranges only', () => {
  const dashboard = createDashboard()
  const week = { ...dashboard, range: '7d' as const, summary: { ...dashboard.summary, activeDays: 4 } }
  assert.equal(buildListeningStatsShareModel(week, 'track').periodStats[2].value, '4/7')
  const lateStart = {
    ...dashboard,
    summary: { ...dashboard.summary, activeDays: 3 },
    status: { ...dashboard.status, startedAt: dashboard.rangeEndAt - 4.5 * 86_400_000 }
  }
  assert.equal(buildListeningStatsShareModel(lateStart, 'track').periodStats[2].value, '3/5')
  assert.equal(buildListeningStatsShareModel({ ...dashboard, range: 'all' }, 'track').periodStats[2].value, '11')
})

test('activity follows the ranking metric and merges long histories into a bounded bar count', () => {
  const day = 86_400_000
  const start = createDashboard().rangeStartAt as number
  const activity = Array.from({ length: 30 }, (_, index) => ({
    startAt: start + index * day,
    endAt: start + (index + 1) * day,
    label: '',
    listenedSeconds: index * 60,
    qualifiedPlays: index % 3
  }))
  const byPlays = buildListeningStatsShareModel(createDashboard({ activity }), 'track')
  assert.equal(byPlays.activity.length, 30)
  assert.equal(byPlays.activity[2], 2)
  assert.equal(byPlays.activityStartLabel, 'JUN 18')
  assert.equal(byPlays.activityEndLabel, 'JUL 18')
  assert.deepEqual(byPlays.activityPeak, { index: 2, label: 'PEAK JUN 20 · 2 PLAYS' })
  const byTime = buildListeningStatsShareModel(createDashboard({ activity, rankingMetric: 'time' }), 'track')
  assert.equal(byTime.activity[2], 120)
  assert.deepEqual(byTime.activityPeak, { index: 29, label: 'PEAK JUL 17 · 29M' })
  assert.equal(buildListeningStatsShareModel(createDashboard(), 'track').activityPeak, null)

  const merged = mergeActivityBars(Array.from({ length: 130 }, () => 1))
  assert.ok(merged.length <= MAX_ACTIVITY_BARS)
  assert.equal(merged.reduce((sum, value) => sum + value, 0), 130)
  assert.deepEqual(mergeActivityBars([1, Number.NaN, -2]), [1, 0, 0])

  const months = Array.from({ length: 80 }, (_, index) => ({
    startAt: new Date(2020, index, 1).getTime(),
    endAt: new Date(2020, index + 1, 1).getTime(),
    label: '',
    listenedSeconds: 0,
    qualifiedPlays: index === 21 ? 50 : 1
  }))
  const allTime = buildListeningStatsShareModel(createDashboard({ range: 'all', granularity: 'month', activity: months }), 'track')
  assert.deepEqual(allTime.activityPeak, { index: 10, label: 'PEAK SEP–OCT 2021 · 51 PLAYS' })
})

test('album lens follows time ranking metadata and keeps missing hero art representable', () => {
  const dashboard = createDashboard({
    rankingMetric: 'time',
    topAlbums: [
      { key: 'album-no-art', album: 'No Art Album', artist: 'Artist', artworkHash: null, listenedSeconds: 50, qualifiedPlays: 1, available: true }
    ]
  })
  const model = buildListeningStatsShareModel(dashboard, 'album')
  assert.equal(model.hero?.key, 'album-no-art')
  assert.deepEqual(model.artworkHashes, [])
  assert.equal(model.rankingLabel, 'RANKED BY LISTENING TIME')
  assert.equal(model.title, 'TOP ALBUM')
  assert.deepEqual(model.heroReadouts.at(-1), { label: 'SHARE OF LISTENING', value: '<1%' })
  assert.deepEqual(model.secondaryItems, [])
})

test('overview selects each category winner and deduplicates four leading covers', () => {
  const model = buildListeningStatsShareModel(createDashboard(), 'overview')
  assert.deepEqual(model.overviewItems.map((item) => item.kind), ['track', 'album', 'artist'])
  assert.deepEqual(model.artworkHashes, ['shared-art', 'artist-art', 'album-art-2', 'album-art-3'])
  assert.equal(model.heroSubtitle, 'First Artist led with 24% of plays')
  assert.deepEqual(model.heroStat, { label: 'LISTENED', value: '2h 46m' })
  assert.deepEqual(model.heroReadouts.map((row) => row.label), ['PLAYS', 'ACTIVE DAYS', 'TRACKS'])
  assert.deepEqual(model.periodStats, [])
})

test('range footer uses exact local dates and all-time uses the detailed-history baseline', () => {
  const dashboard = createDashboard()
  assert.equal(buildListeningStatsShareModel(dashboard, 'overview').rangeLabel, 'JUN 18 – JUL 18, 2026')
  assert.equal(buildListeningStatsShareModel({ ...dashboard, range: 'all' }, 'overview').rangeLabel, 'SINCE JUN 18, 2026')
  assert.equal(buildListeningStatsShareModel(dashboard, 'overview').suggestedFileName, 'astra-listening-30d-2026-07-18.png')
})

test('sparse overview omits unavailable categories and still produces a safe empty-art model', () => {
  const dashboard = createDashboard({ topTracks: [], topArtists: [], topAlbums: [] })
  const model = buildListeningStatsShareModel(dashboard, 'overview')
  assert.deepEqual(model.overviewItems, [])
  assert.deepEqual(model.artworkHashes, [])
  assert.equal(model.heroSubtitle, '')
})
