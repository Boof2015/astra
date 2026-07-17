import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SESSION_STATE_KIND,
  SESSION_STATE_SCHEMA_VERSION,
  clearSessionSnapshot,
  normalizeSessionSnapshot,
  readSessionSnapshot,
  writeSessionSnapshot,
  type SessionStorageLike,
} from './sessionState.ts'
import { ASTRA_SESSION_STATE_STORAGE_KEY } from '../constants/settingsStorageKeys.ts'

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
  assert.equal(storage.getItem(ASTRA_SESSION_STATE_STORAGE_KEY)?.includes(SESSION_STATE_KIND), true)
  assert.deepEqual(readSessionSnapshot(storage), snapshot)

  clearSessionSnapshot(storage)
  assert.equal(readSessionSnapshot(storage), null)
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
