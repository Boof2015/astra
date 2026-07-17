import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getUniqueTrackPaths,
  pruneCachedTracks,
  resolveCachedTrackPaths,
  TRACKLIST_PLAY_COUNT_VISIBILITY_STORAGE_KEY,
  updateFullTrackConsumers,
  useLibraryStore,
  type DbTrack
} from './libraryStore.ts'

function makeTrack(path: string, overrides: Partial<DbTrack> = {}): DbTrack {
  return {
    id: overrides.id ?? Math.abs(path.split('').reduce((total, char) => total + char.charCodeAt(0), 0)),
    path,
    album_identity_key: overrides.album_identity_key ?? 'album:key',
    is_new: overrides.is_new ?? false,
    title: overrides.title ?? path,
    artist: overrides.artist ?? 'Artist',
    artist_names: overrides.artist_names ?? ['Artist'],
    album: overrides.album ?? 'Album',
    album_artist: overrides.album_artist ?? 'Artist',
    album_artist_names: overrides.album_artist_names ?? ['Artist'],
    duration: overrides.duration ?? 180,
    track_number: overrides.track_number ?? 1,
    disc_number: overrides.disc_number ?? 1,
    year: overrides.year ?? 2026,
    genre: overrides.genre ?? null,
    genres: overrides.genres ?? (overrides.genre ? [overrides.genre] : []),
    artwork_hash: overrides.artwork_hash ?? null,
    base_artwork_hash: overrides.base_artwork_hash ?? null,
    format: overrides.format ?? 'flac',
    sample_rate: overrides.sample_rate ?? 44100,
    bit_depth: overrides.bit_depth ?? 16,
    bitrate: overrides.bitrate ?? null,
    channels: overrides.channels ?? 2,
    codec: overrides.codec ?? null,
    codec_profile: overrides.codec_profile ?? null,
    is_atmos_joc: overrides.is_atmos_joc ?? 0,
    is_iamf: overrides.is_iamf ?? 0,
    bpm: overrides.bpm ?? null,
    musical_key: overrides.musical_key ?? null,
    source_type: overrides.source_type ?? 'local',
    source_id: overrides.source_id ?? null,
    source_track_id: overrides.source_track_id ?? null,
    source_path: overrides.source_path ?? null,
    is_available: overrides.is_available ?? 1,
    availability_reason: overrides.availability_reason ?? null,
    file_created_at: overrides.file_created_at ?? null,
    play_count: overrides.play_count ?? 0,
    last_played_at: overrides.last_played_at ?? null,
    replaygain_track_gain_db: overrides.replaygain_track_gain_db ?? null,
    replaygain_album_gain_db: overrides.replaygain_album_gain_db ?? null,
    added_at: overrides.added_at ?? 1,
    modified_at: overrides.modified_at ?? 1
  }
}

interface MockLibraryApi {
  getTracksByPaths: (trackPaths: string[]) => Promise<DbTrack[]> | DbTrack[]
  getTrackCount: () => Promise<number> | number
  getTotalTrackDuration: () => Promise<number> | number
  getAlbums: () => Promise<unknown[]> | unknown[]
  getArtists: () => Promise<unknown[]> | unknown[]
  getGenres: () => Promise<unknown[]> | unknown[]
  getFolders: () => Promise<unknown[]> | unknown[]
  getFavoritePaths: () => Promise<string[]> | string[]
  getFavorites: () => Promise<DbTrack[]> | DbTrack[]
  getRecentlyPlayed: (limit: number) => Promise<DbTrack[]> | DbTrack[]
}

function installMockLibraryApi(overrides: Partial<MockLibraryApi> = {}): void {
  const libraryApi: MockLibraryApi = {
    getTracksByPaths: async () => [],
    getTrackCount: async () => 0,
    getTotalTrackDuration: async () => 0,
    getAlbums: async () => [],
    getArtists: async () => [],
    getGenres: async () => [],
    getFolders: async () => [],
    getFavoritePaths: async () => [],
    getFavorites: async () => [],
    getRecentlyPlayed: async () => [],
    ...overrides
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        library: libraryApi
      }
    }
  })
}

function installMockTrackFetch(handler: (trackPaths: string[]) => Promise<DbTrack[]> | DbTrack[]): void {
  installMockLibraryApi({
    getTracksByPaths: async (trackPaths: string[]) => handler(trackPaths)
  })
}

test('getUniqueTrackPaths de-duplicates while preserving first-seen order', () => {
  assert.deepEqual(
    getUniqueTrackPaths([
      makeTrack('/music/a.flac'),
      makeTrack('/music/b.flac'),
      makeTrack('/music/a.flac', { title: 'Duplicate' }),
      makeTrack('/music/c.flac')
    ]),
    ['/music/a.flac', '/music/b.flac', '/music/c.flac']
  )
})

test('play count column visibility is hidden by default and persists explicit changes', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    }
  })

  try {
    useLibraryStore.setState({ showTracklistPlayCount: false })
    assert.equal(useLibraryStore.getState().showTracklistPlayCount, false)
    useLibraryStore.getState().setShowTracklistPlayCount(true)
    assert.equal(useLibraryStore.getState().showTracklistPlayCount, true)
    assert.equal(values.get(TRACKLIST_PLAY_COUNT_VISIBILITY_STORAGE_KEY), '1')
    useLibraryStore.getState().setShowTracklistPlayCount(false)
    assert.equal(values.get(TRACKLIST_PLAY_COUNT_VISIBILITY_STORAGE_KEY), '0')
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('resolveCachedTrackPaths preserves requested order and reports incomplete caches', () => {
  const cache = new Map([
    ['/music/a.flac', makeTrack('/music/a.flac')],
    ['/music/c.flac', makeTrack('/music/c.flac')]
  ])

  assert.deepEqual(resolveCachedTrackPaths(['/music/c.flac', '/music/a.flac'], cache), {
    tracks: [cache.get('/music/c.flac'), cache.get('/music/a.flac')],
    complete: true
  })

  assert.deepEqual(resolveCachedTrackPaths(['/music/a.flac', '/music/b.flac'], cache), {
    tracks: [cache.get('/music/a.flac')],
    complete: false
  })
})

test('pruneCachedTracks removes unreferenced tracks even when retained set size matches cache size', () => {
  const cache = new Map([
    ['/music/a.flac', makeTrack('/music/a.flac')],
    ['/music/b.flac', makeTrack('/music/b.flac')]
  ])

  const pruned = pruneCachedTracks(cache, new Set(['/music/b.flac', '/music/c.flac']))

  assert.deepEqual([...pruned.keys()], ['/music/b.flac'])
})

test('updateFullTrackConsumers releases full tracks only after the last consumer leaves', () => {
  const retained = updateFullTrackConsumers(new Set(['library', 'graph']), 'graph', 'release')
  assert.deepEqual([...retained.consumers], ['library'])
  assert.equal(retained.shouldReleaseFullTracks, false)

  const released = updateFullTrackConsumers(retained.consumers, 'library', 'release')
  assert.deepEqual([...released.consumers], [])
  assert.equal(released.shouldReleaseFullTracks, true)
})

test('loadLibrary refreshes total track duration from the library API', async () => {
  installMockLibraryApi({
    getTrackCount: async () => 3,
    getTotalTrackDuration: async () => 90061
  })
  useLibraryStore.setState({
    trackByPath: new Map(),
    trackCacheVersion: 0,
    trackPaths: [],
    fullTrackPaths: [],
    fullTrackConsumers: new Set(),
    totalTrackCount: 0,
    totalTrackDuration: 0,
    albums: [],
    albumsIncludingSingles: [],
    albumsIncludingSinglesLoaded: false,
    artists: [],
    genres: [],
    folders: [],
    favorites: new Set(),
    favoriteTrackPaths: [],
    recentlyPlayedPaths: [],
    selectedAlbum: null,
    selectedArtist: null,
    selectedGenre: null,
    selectedYear: null
  })

  await useLibraryStore.getState().loadLibrary()

  const state = useLibraryStore.getState()
  assert.equal(state.totalTrackCount, 3)
  assert.equal(state.totalTrackDuration, 90061)
})

test('resolveTrackPathsWithFetch hydrates missing cached tracks without pruning retained cache', async () => {
  const cachedTrack = makeTrack('/music/cached.flac', { title: 'Cached' })
  const fetchedTrack = makeTrack('/music/fetched.flac', { title: 'Fetched' })
  let requestedPaths: string[] = []
  installMockTrackFetch((trackPaths) => {
    requestedPaths = trackPaths
    return [fetchedTrack]
  })
  useLibraryStore.setState({
    trackByPath: new Map([[cachedTrack.path, cachedTrack]]),
    trackCacheVersion: 0
  })

  const tracks = await useLibraryStore.getState().resolveTrackPathsWithFetch([
    cachedTrack.path,
    fetchedTrack.path,
    '/music/missing.flac',
    fetchedTrack.path
  ])

  assert.deepEqual(requestedPaths, [fetchedTrack.path, '/music/missing.flac'])
  assert.deepEqual(tracks.map((track) => track.path), [
    cachedTrack.path,
    fetchedTrack.path,
    fetchedTrack.path
  ])
  assert.equal(useLibraryStore.getState().trackByPath.get(cachedTrack.path), cachedTrack)
  assert.equal(useLibraryStore.getState().trackByPath.get(fetchedTrack.path), fetchedTrack)
})
