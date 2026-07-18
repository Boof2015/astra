import assert from 'node:assert/strict'
import test from 'node:test'
import type { ListeningStatsDashboard } from '../../types/listeningStats'
import {
  buildListeningStatsShareModel,
  formatCompactListeningDuration,
  formatListeningShare
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
})

test('track lens uses the first ranked track as hero and omits unavailable secondary rows', () => {
  const model = buildListeningStatsShareModel(createDashboard(), 'track')
  assert.equal(model.hero?.key, 'track-1')
  assert.deepEqual(model.secondaryItems.map((item) => item.key), ['track-2', 'track-3'])
  assert.deepEqual(model.secondaryItems.map((item) => item.rank), [2, 3])
  assert.deepEqual(model.artworkHashes, ['shared-art', 'track-art-2', 'track-art-3'])
  assert.equal(model.personality, 'You gave this track 18% of your listening time.')
  assert.equal(model.rankingLabel, 'RANKED BY PLAYS')
  assert.deepEqual(model.summaryStats, [
    { label: 'LISTENED', value: '2h 46m' },
    { label: 'PLAYS', value: '74' },
    { label: 'ACTIVE DAYS', value: '11' }
  ])
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
  assert.equal(model.personality, 'You spent <1% of your listening time inside this album.')
  assert.deepEqual(model.secondaryItems, [])
})

test('overview selects each category winner and deduplicates four leading covers', () => {
  const model = buildListeningStatsShareModel(createDashboard(), 'overview')
  assert.deepEqual(model.overviewItems.map((item) => item.kind), ['track', 'album', 'artist'])
  assert.deepEqual(model.artworkHashes, ['shared-art', 'artist-art', 'album-art-2', 'album-art-3'])
  assert.equal(model.personality, 'First Artist accounted for 25% of your listening time.')
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
  assert.equal(model.personality, '')
})
