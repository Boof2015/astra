import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SESSION_POSITION_CHECKPOINT_KIND,
  SESSION_POSITION_CHECKPOINT_SCHEMA_VERSION,
  SESSION_STATE_KIND,
  SESSION_STATE_SCHEMA_VERSION,
  clearSessionSnapshot,
  normalizeSessionPositionCheckpoint,
  normalizeSessionSnapshot,
  readSessionPositionCheckpoint,
  readSessionSnapshot,
  writeSessionPositionCheckpoint,
  writeSessionSnapshot,
  type SessionPositionCheckpointV1,
  type SessionSnapshotV1,
  type SessionStorageLike,
} from './sessionState.ts'
import {
  ASTRA_SESSION_POSITION_CHECKPOINT_STORAGE_KEY,
  ASTRA_SESSION_STATE_STORAGE_KEY
} from '../constants/settingsStorageKeys.ts'

class MemoryStorage implements SessionStorageLike {
  private values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function createQueuedSessionSnapshot(savedAt = 10): SessionSnapshotV1 {
  const snapshot = normalizeSessionSnapshot({
    kind: SESSION_STATE_KIND,
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    savedAt,
    ui: null,
    library: null,
    playlist: null,
    player: {
      currentTrack: {
        path: '/music/a.flac',
        title: 'A',
        artist: 'Artist',
        album: 'Album',
        duration: 120,
        format: 'flac',
      },
      currentTrackSource: 'context',
      savedPlaybackState: 'playing',
      currentTime: 12,
      duration: 120,
      queueItems: [{
        queueId: 'queue-a',
        origin: 'context',
        entry: {
          path: '/music/a.flac',
          snapshot: {
            path: '/music/a.flac',
            title: 'A',
            artist: 'Artist',
            album: 'Album',
            duration: 120,
            format: 'flac',
          },
        },
      }],
      baseUpcomingQueueIds: ['queue-a'],
      upcomingQueueIds: ['queue-a'],
      currentQueueItemId: 'queue-a',
      queueSourcePlaylistId: null,
      queueSourceContext: null,
      queueContextLabel: null,
      shuffle: false,
      repeat: 'none',
      playbackHistory: [],
    },
  })
  assert.ok(snapshot)
  return snapshot
}

function createPositionCheckpoint(
  overrides: Partial<SessionPositionCheckpointV1> = {}
): SessionPositionCheckpointV1 {
  return {
    kind: SESSION_POSITION_CHECKPOINT_KIND,
    schemaVersion: SESSION_POSITION_CHECKPOINT_SCHEMA_VERSION,
    savedAt: 20,
    baseSessionSavedAt: 10,
    currentTrackPath: '/music/a.flac',
    currentQueueItemId: 'queue-a',
    currentTrackSource: 'context',
    currentTime: 45,
    ...overrides,
  }
}

test('session snapshot normalization rejects unknown schema versions', () => {
  assert.equal(normalizeSessionSnapshot({ kind: SESSION_STATE_KIND, schemaVersion: 99 }), null)
  assert.equal(normalizeSessionSnapshot({ kind: 'other', schemaVersion: SESSION_STATE_SCHEMA_VERSION }), null)
})

test('session snapshot normalization tolerates corrupt fields and strips artwork data', () => {
  const snapshot = normalizeSessionSnapshot({
    kind: SESSION_STATE_KIND,
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    savedAt: -1,
    ui: {
      activeView: 'missing',
      showQueue: true,
      showInfoSidebar: false,
      showPipelineShelf: true,
      showLyricsShelf: true,
      lyricsShelfExpanded: true,
      fullscreenLyricsVisible: 'yes',
    },
    library: {
      viewMode: 'albums',
      selectedAlbum: { album: 'Album', artist: 'Artist', identity_key: 'album-key' },
      selectedArtist: '',
      selectedGenre: 'Electronic',
      selectedYear: 2025,
      trackListSortState: { key: 'bad', direction: 'desc' },
      selectedSourceFilters: ['local', '', 42],
      albumSortMode: 'artist',
      includeSinglesInAlbums: true,
      includeCollabArtists: true,
      artistRootViewMode: 'grid',
    },
    playlist: {
      selectedPlaylistId: 7,
      sortState: { key: 'added', direction: 'desc' },
    },
    player: {
      currentTrack: {
        id: 'track-a',
        path: '/music/a.flac',
        origin: 'library',
        title: 'A',
        artist: 'Artist',
        album: 'Album',
        duration: 120,
        format: 'flac',
        artworkData: 'data:image/jpeg;base64,large',
        replayGainTrackDb: 0,
        sourceType: 'local',
        genres: ['Electronic', 'Ambient'],
      },
      currentTrackSource: 'context',
      savedPlaybackState: 'playing',
      currentTime: 42,
      duration: 120,
      queueItems: [
        {
          queueId: 'queue-1',
          origin: 'context',
          entry: {
            path: '/music/a.flac',
            snapshot: {
              id: 'track-a',
              path: '/music/a.flac',
              title: 'A',
              artist: 'Artist',
              album: 'Album',
              duration: 120,
              format: 'flac',
            },
          },
          sourcePlaylistId: 3,
          sourceContext: { type: 'genre', genre: 'Electronic' },
          contextLabel: 'Playlist',
        },
        {
          queueId: 'queue-1',
          origin: 'manual',
          entry: {
            path: '/music/duplicate.flac',
            snapshot: {
              path: '/music/duplicate.flac',
            },
          },
        },
      ],
      baseUpcomingQueueIds: ['queue-1', 'queue-missing'],
      upcomingQueueIds: ['queue-1', 'queue-1'],
      currentQueueItemId: 'queue-1',
      queueSourcePlaylistId: 3,
      queueSourceContext: { type: 'genre', genre: 'Electronic' },
      queueContextLabel: 'Playlist',
      shuffle: true,
      repeat: 'all',
      playbackHistory: [],
    },
  })

  assert.ok(snapshot)
  assert.equal(snapshot.savedAt, 0)
  assert.equal(snapshot.ui?.activeView, 'home')
  assert.equal(snapshot.ui?.fullscreenLyricsVisible, false)
  assert.deepEqual(snapshot.library?.selectedSourceFilters, ['local'])
  assert.equal(snapshot.library?.selectedGenre, 'Electronic')
  assert.equal(snapshot.library?.selectedYear, 2025)
  assert.equal(snapshot.library?.trackListSortState, null)
  assert.deepEqual(snapshot.library?.albumSortState, { key: 'artist', direction: 'asc' })
  assert.deepEqual(snapshot.playlist?.sortState, { key: 'added', direction: 'desc' })
  assert.equal(snapshot.player?.queueItems.length, 1)
  assert.deepEqual(snapshot.player?.baseUpcomingQueueIds, ['queue-1'])
  assert.deepEqual(snapshot.player?.upcomingQueueIds, ['queue-1'])
  assert.equal(Object.hasOwn(snapshot.player?.currentTrack as unknown as Record<string, unknown>, 'artworkData'), false)
  assert.equal(snapshot.player?.currentTrack?.replayGainTrackDb, 0)
  assert.deepEqual(snapshot.player?.currentTrack?.genres, ['Electronic', 'Ambient'])
  assert.deepEqual(snapshot.player?.queueItems[0]?.sourceContext, { type: 'genre', genre: 'Electronic' })
  assert.deepEqual(snapshot.player?.queueSourceContext, { type: 'genre', genre: 'Electronic' })
})

test('session snapshots round-trip through storage and clear cleanly', () => {
  const storage = new MemoryStorage()
  const snapshot = normalizeSessionSnapshot({
    kind: SESSION_STATE_KIND,
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    savedAt: 1,
    player: null,
    ui: null,
    library: null,
    playlist: null,
  })
  assert.ok(snapshot)

  writeSessionSnapshot(snapshot, storage)
  writeSessionPositionCheckpoint(createPositionCheckpoint(), storage)
  assert.equal(storage.getItem(ASTRA_SESSION_STATE_STORAGE_KEY)?.includes(SESSION_STATE_KIND), true)
  assert.deepEqual(readSessionSnapshot(storage), snapshot)

  clearSessionSnapshot(storage)
  assert.equal(readSessionSnapshot(storage), null)
  assert.equal(storage.getItem(ASTRA_SESSION_POSITION_CHECKPOINT_STORAGE_KEY), null)
})

test('a newer matching position checkpoint overlays only the restored playback time', () => {
  const storage = new MemoryStorage()
  const snapshot = createQueuedSessionSnapshot()
  const checkpoint = createPositionCheckpoint()

  writeSessionSnapshot(snapshot, storage)
  writeSessionPositionCheckpoint(checkpoint, storage)

  assert.deepEqual(readSessionPositionCheckpoint(storage), checkpoint)
  assert.deepEqual(readSessionSnapshot(storage), {
    ...snapshot,
    player: {
      ...snapshot.player!,
      currentTime: checkpoint.currentTime,
    },
  })
})

test('position checkpoints are ignored unless they are newer and match track and queue identity', () => {
  const snapshot = createQueuedSessionSnapshot()
  const cases: Array<{ checkpoint: SessionPositionCheckpointV1; label: string }> = [
    { checkpoint: createPositionCheckpoint({ savedAt: snapshot.savedAt }), label: 'same timestamp' },
    { checkpoint: createPositionCheckpoint({ savedAt: snapshot.savedAt - 1 }), label: 'older timestamp' },
    { checkpoint: createPositionCheckpoint({ baseSessionSavedAt: snapshot.savedAt - 1 }), label: 'other base session' },
    { checkpoint: createPositionCheckpoint({ currentTrackPath: '/music/other.flac' }), label: 'other track' },
    { checkpoint: createPositionCheckpoint({ currentQueueItemId: 'queue-other' }), label: 'other queue item' },
    { checkpoint: createPositionCheckpoint({ currentTrackSource: 'manual' }), label: 'other track source' },
  ]

  for (const { checkpoint, label } of cases) {
    const storage = new MemoryStorage()
    writeSessionSnapshot(snapshot, storage)
    writeSessionPositionCheckpoint(checkpoint, storage)
    assert.deepEqual(readSessionSnapshot(storage), snapshot, label)
  }
})

test('a corrupt position checkpoint never prevents full v1 session recovery', () => {
  const storage = new MemoryStorage()
  const snapshot = createQueuedSessionSnapshot()
  writeSessionSnapshot(snapshot, storage)
  storage.setItem(ASTRA_SESSION_POSITION_CHECKPOINT_STORAGE_KEY, '{not json')

  assert.equal(readSessionPositionCheckpoint(storage), null)
  assert.deepEqual(readSessionSnapshot(storage), snapshot)
})

test('position checkpoint normalization rejects incomplete and invalid records', () => {
  assert.equal(normalizeSessionPositionCheckpoint({}), null)
  assert.equal(normalizeSessionPositionCheckpoint({
    ...createPositionCheckpoint(),
    currentQueueItemId: undefined,
  }), null)
  assert.equal(normalizeSessionPositionCheckpoint({
    ...createPositionCheckpoint(),
    currentTime: Number.NaN,
  }), null)
  assert.equal(normalizeSessionPositionCheckpoint({
    ...createPositionCheckpoint(),
    savedAt: 10,
    baseSessionSavedAt: 10,
  }), null)
})

test('a matching position checkpoint is clamped to the restored track duration', () => {
  const storage = new MemoryStorage()
  const snapshot = createQueuedSessionSnapshot()
  writeSessionSnapshot(snapshot, storage)
  writeSessionPositionCheckpoint(createPositionCheckpoint({ currentTime: 500 }), storage)

  assert.equal(readSessionSnapshot(storage)?.player?.currentTime, 120)
})

test('session snapshot normalization preserves genre track sort state', () => {
  const snapshot = normalizeSessionSnapshot({
    kind: SESSION_STATE_KIND,
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    savedAt: 1,
    ui: null,
    player: null,
    playlist: null,
    library: {
      viewMode: 'tracks',
      selectedAlbum: null,
      selectedArtist: null,
      selectedGenre: null,
      selectedYear: null,
      trackListSortState: { key: 'genre', direction: 'asc' },
      tracksViewSortState: { key: 'duration', direction: 'desc' },
      selectedSourceFilters: [],
      albumSortMode: 'title',
      includeSinglesInAlbums: false,
      includeCollabArtists: false,
      artistRootViewMode: 'list',
    },
  })

  assert.ok(snapshot)
  assert.deepEqual(snapshot.library?.trackListSortState, { key: 'genre', direction: 'asc' })
  assert.deepEqual(snapshot.library?.tracksViewSortState, { key: 'duration', direction: 'desc' })
  assert.equal(snapshot.library?.tracksViewSortRules, undefined)
  assert.deepEqual(snapshot.library?.albumSortState, { key: 'title', direction: 'asc' })
})

test('session snapshot normalization preserves multikey Tracks sorting and Year album sorting', () => {
  const snapshot = normalizeSessionSnapshot({
    kind: SESSION_STATE_KIND,
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    savedAt: 1,
    ui: null,
    player: null,
    playlist: null,
    library: {
      viewMode: 'tracks',
      selectedAlbum: null,
      selectedArtist: null,
      selectedGenre: null,
      selectedYear: null,
      trackListSortState: { key: 'artist', direction: 'asc' },
      tracksViewSortState: { key: 'artist', direction: 'asc' },
      tracksViewSortRules: [
        { key: 'artist', direction: 'asc' },
        { key: 'year', direction: 'desc' },
        { key: 'artist', direction: 'desc' },
        { key: 'codec', direction: 'asc' }
      ],
      selectedSourceFilters: [],
      albumSortState: { key: 'year', direction: 'desc' },
      includeSinglesInAlbums: false,
      includeCollabArtists: false,
      artistRootViewMode: 'list'
    }
  })

  assert.deepEqual(snapshot?.library?.tracksViewSortRules, [
    { key: 'artist', direction: 'asc' },
    { key: 'year', direction: 'desc' },
    { key: 'codec', direction: 'asc' }
  ])
  assert.deepEqual(snapshot?.library?.albumSortState, { key: 'year', direction: 'desc' })
})

test('session snapshot normalization preserves Stats routing and play count sorting', () => {
  const snapshot = normalizeSessionSnapshot({
    kind: SESSION_STATE_KIND,
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    savedAt: 1,
    ui: {
      activeView: 'stats',
      showQueue: false,
      showInfoSidebar: false,
      showPipelineShelf: false,
      showLyricsShelf: false,
      lyricsShelfExpanded: false,
      fullscreenLyricsVisible: false
    },
    player: null,
    playlist: {
      selectedPlaylistId: 4,
      sortState: { key: 'play_count', direction: 'desc' }
    },
    library: {
      viewMode: 'tracks',
      selectedAlbum: null,
      selectedArtist: null,
      selectedGenre: null,
      selectedYear: null,
      trackListSortState: { key: 'play_count', direction: 'desc' },
      tracksViewSortState: { key: 'play_count', direction: 'desc' },
      selectedSourceFilters: [],
      albumSortMode: 'title',
      includeSinglesInAlbums: true,
      includeCollabArtists: false,
      artistRootViewMode: 'list'
    }
  })

  assert.equal(snapshot?.ui?.activeView, 'stats')
  assert.deepEqual(snapshot?.library?.trackListSortState, { key: 'play_count', direction: 'desc' })
  assert.deepEqual(snapshot?.library?.tracksViewSortState, { key: 'play_count', direction: 'desc' })
  assert.deepEqual(snapshot?.playlist?.sortState, { key: 'play_count', direction: 'desc' })
})

test('session snapshot normalization defaults missing fullscreen lyrics visibility to hidden', () => {
  const snapshot = normalizeSessionSnapshot({
    kind: SESSION_STATE_KIND,
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    savedAt: 1,
    player: null,
    library: null,
    playlist: null,
    ui: {
      activeView: 'library',
      showQueue: false,
      showInfoSidebar: false,
      showPipelineShelf: false,
      showLyricsShelf: false,
      lyricsShelfExpanded: false
    }
  })

  assert.equal(snapshot?.ui?.fullscreenLyricsVisible, false)
})

test('session snapshot normalization preserves Years and Unknown Year selection', () => {
  const snapshot = normalizeSessionSnapshot({
    kind: SESSION_STATE_KIND,
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    savedAt: 1,
    ui: null,
    player: null,
    playlist: null,
    library: {
      viewMode: 'years',
      selectedAlbum: null,
      selectedArtist: null,
      selectedGenre: null,
      selectedYear: 'unknown',
      trackListSortState: null,
      selectedSourceFilters: [],
      albumSortMode: 'title',
      includeSinglesInAlbums: true,
      includeCollabArtists: false,
      artistRootViewMode: 'list'
    }
  })

  assert.equal(snapshot?.library?.viewMode, 'years')
  assert.equal(snapshot?.library?.selectedYear, 'unknown')
})
