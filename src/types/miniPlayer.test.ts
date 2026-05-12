import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_MINI_PLAYER_TIME_DISPLAY_MODE,
  getNextMiniPlayerTimeDisplayMode,
  mergeMiniPlayerSnapshots,
  normalizeMiniPlayerTimeDisplayMode,
  selectMiniPlayerTrackArtworkData,
  type MiniPlayerResolvedArtwork,
  type MiniPlayerSnapshot,
  type MiniPlayerTrackSnapshot
} from './miniPlayer.ts'

function createTrackSnapshot(
  overrides: Partial<MiniPlayerTrackSnapshot> = {}
): MiniPlayerTrackSnapshot {
  return {
    id: 'track-1',
    path: '/music/track-1.flac',
    title: 'Track One',
    artist: 'Artist',
    album: 'Album',
    artworkHash: 'artwork-1',
    artworkData: null,
    isFavorite: false,
    ...overrides
  }
}

function createSnapshot(
  overrides: Partial<MiniPlayerSnapshot> = {}
): MiniPlayerSnapshot {
  return {
    playbackState: 'playing',
    currentTime: 42,
    duration: 185,
    queueLength: 3,
    outputDeviceLabel: 'Test Output',
    timeDisplayMode: DEFAULT_MINI_PLAYER_TIME_DISPLAY_MODE,
    visualizerLineColor: '#38bdf8',
    currentTrack: createTrackSnapshot(),
    ...overrides
  }
}

test('normalizeMiniPlayerTimeDisplayMode defaults to remaining for unknown values', () => {
  assert.equal(normalizeMiniPlayerTimeDisplayMode('duration'), 'duration')
  assert.equal(normalizeMiniPlayerTimeDisplayMode('remaining'), 'remaining')
  assert.equal(normalizeMiniPlayerTimeDisplayMode('elapsed'), DEFAULT_MINI_PLAYER_TIME_DISPLAY_MODE)
  assert.equal(normalizeMiniPlayerTimeDisplayMode(null), DEFAULT_MINI_PLAYER_TIME_DISPLAY_MODE)
})

test('getNextMiniPlayerTimeDisplayMode toggles between remaining and duration', () => {
  assert.equal(getNextMiniPlayerTimeDisplayMode('remaining'), 'duration')
  assert.equal(getNextMiniPlayerTimeDisplayMode('duration'), 'remaining')
  assert.equal(getNextMiniPlayerTimeDisplayMode('elapsed'), 'duration')
})

test('mergeMiniPlayerSnapshots preserves artwork for the same track when the next snapshot omits it', () => {
  const previous = createSnapshot({
    currentTrack: createTrackSnapshot({ artworkData: 'data:image/png;base64,previous-art' })
  })
  const next = createSnapshot({
    currentTrack: createTrackSnapshot({ artworkData: undefined })
  })

  const merged = mergeMiniPlayerSnapshots(previous, next)

  assert.equal(merged.currentTrack?.artworkData, 'data:image/png;base64,previous-art')
})

test('selectMiniPlayerTrackArtworkData ignores stale artwork resolved for a different track', () => {
  const currentTrack = createTrackSnapshot({
    id: 'track-2',
    path: '/music/track-2.flac',
    artworkData: undefined
  })
  const staleArtwork: MiniPlayerResolvedArtwork = {
    trackPath: '/music/track-1.flac',
    dataUrl: 'data:image/png;base64,stale-art'
  }

  const selectedArtwork = selectMiniPlayerTrackArtworkData(currentTrack, staleArtwork)

  assert.equal(selectedArtwork, null)
})

test('selectMiniPlayerTrackArtworkData publishes resolved artwork once it matches the active track', () => {
  const currentTrack = createTrackSnapshot({
    id: 'track-2',
    path: '/music/track-2.flac',
    artworkData: undefined
  })
  const resolvedArtwork: MiniPlayerResolvedArtwork = {
    trackPath: '/music/track-2.flac',
    dataUrl: 'data:image/png;base64,track-2-art'
  }

  const selectedArtwork = selectMiniPlayerTrackArtworkData(currentTrack, resolvedArtwork)

  assert.equal(selectedArtwork, 'data:image/png;base64,track-2-art')
})

test('selectMiniPlayerTrackArtworkData prefers embedded track artwork immediately', () => {
  const currentTrack = createTrackSnapshot({
    artworkData: 'data:image/png;base64,embedded-art'
  })
  const staleArtwork: MiniPlayerResolvedArtwork = {
    trackPath: '/music/track-2.flac',
    dataUrl: 'data:image/png;base64,other-art'
  }

  const selectedArtwork = selectMiniPlayerTrackArtworkData(currentTrack, staleArtwork)

  assert.equal(selectedArtwork, 'data:image/png;base64,embedded-art')
})
