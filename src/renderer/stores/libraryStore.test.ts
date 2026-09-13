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
import {
  ALBUM_SORT_STATE_STORAGE_KEY,
  ROOT_TRACK_TABLE_LAYOUT_STORAGE_KEY
} from '../constants/settingsStorageKeys.ts'
import { createDefaultRootTrackTableLayout } from '../utils/rootTrackTable.ts'

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
    track_total: overrides.track_total ?? 1,
    disc_number: overrides.disc_number ?? 1,
    disc_total: overrides.disc_total ?? 1,
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
  getTracksPage: (request: { offset?: number; limit?: number }) => Promise<{
    tracks: DbTrack[]
    total: number
    hasMore: boolean
    nextOffset: number | null
  }>
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
    getTracksPage: async () => ({ tracks: [], total: 0, hasMore: false, nextOffset: null }),
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
        library: libraryApi,
        libraryDiagnostics: {
          logRendererTiming: async () => true
        }
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

test('root Tracks layout and Album sort preferences normalize and persist independently', () => {
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
    const layout = createDefaultRootTrackTableLayout()
    layout.columns.find((entry) => entry.id === 'year')!.visible = true
    layout.columns.find((entry) => entry.id === 'title')!.visible = false
    useLibraryStore.getState().setRootTrackTableLayout(layout)
    useLibraryStore.getState().setAlbumSortState({ key: 'year', direction: 'desc' })

    assert.equal(useLibraryStore.getState().rootTrackTableLayout.columns[0]?.id, 'title')
    assert.equal(useLibraryStore.getState().rootTrackTableLayout.columns[0]?.visible, true)
    assert.equal(useLibraryStore.getState().rootTrackTableLayout.columns.find((entry) => entry.id === 'year')?.visible, true)
    assert.deepEqual(JSON.parse(values.get(ALBUM_SORT_STATE_STORAGE_KEY) ?? 'null'), { key: 'year', direction: 'desc' })
    assert.equal(typeof values.get(ROOT_TRACK_TABLE_LAYOUT_STORAGE_KEY), 'string')
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

test('loadLibrary submits a correlated aggregate reload summary', async () => {
  const timings: Record<string, unknown>[] = []
  let pageRequests = 0
  const firstPageTrack = makeTrack('/music/first.flac')
  const secondPageTrack = makeTrack('/music/second.flac')
  installMockLibraryApi({
    getTrackCount: async () => 3,
    getTotalTrackDuration: async () => 540,
    getAlbums: async () => [{ album: 'Album' }],
    getArtists: async () => [{ artist: 'Artist' }],
    getGenres: async () => ['Rock'],
    getFolders: async () => [{ path: '/music' }],
    getFavoritePaths: async () => ['/music/favorite.flac'],
    getRecentlyPlayed: async () => [makeTrack('/music/recent.flac')],
    getTracksPage: async () => {
      pageRequests += 1
      return pageRequests === 1
        ? { tracks: [firstPageTrack], total: 2, hasMore: true, nextOffset: 1 }
        : { tracks: [secondPageTrack], total: 2, hasMore: false, nextOffset: null }
    }
  })
  ;(window.electronAPI.libraryDiagnostics as unknown as {
    logRendererTiming: (event: Record<string, unknown>) => Promise<boolean>
  }).logRendererTiming = async (event) => {
    timings.push(event)
    return true
  }
  useLibraryStore.setState({
    trackByPath: new Map(),
    trackCacheVersion: 0,
    trackPaths: [],
    fullTrackPaths: [],
    fullTrackConsumers: new Set(['library']),
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

  const operationStartedAt = performance.now()
  await useLibraryStore.getState().loadLibrary({
    runId: 'diagnostic-run-1',
    operationKind: 'rescan_all',
    operationStartedAt,
    backendDurationMs: 12.5
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  const timing = timings[0]
  assert.ok(timing)
  assert.equal(timing.runId, 'diagnostic-run-1')
  assert.equal(timing.operationKind, 'rescan_all')
  assert.equal((timing.stepRequestCount as Record<string, number>).albums, 1)
  assert.equal((timing.stepRequestCount as Record<string, number>).favorites, 2)
  assert.equal((timing.stepRequestCount as Record<string, number>).full_tracks, 2)
  assert.equal((timing.stepRequestCount as Record<string, number>).active_selection, 0)
  assert.equal((timing.stepResultCount as Record<string, number>).track_count, 3)
  assert.equal((timing.stepResultCount as Record<string, number>).folders, 1)
  assert.equal((timing.stepResultCount as Record<string, number>).full_tracks, 2)
  assert.equal(typeof (timing.stepDurationMs as Record<string, number>).artists, 'number')
})

test('loadFullTracks publishes only revealed pages and the final staged page', async () => {
  const tracks = [
    makeTrack('/music/one.flac'),
    makeTrack('/music/two.flac'),
    makeTrack('/music/three.flac'),
    makeTrack('/music/four.flac')
  ]
  const revealTimes = [1000, 1100, 1300, 1350]
  const requestSnapshots: Array<{ version: number; paths: string[] }> = []
  let requestIndex = 0
  let now = revealTimes[0]

  installMockLibraryApi({
    getTracksPage: async () => {
      const index = requestIndex++
      const state = useLibraryStore.getState()
      requestSnapshots.push({
        version: state.trackCacheVersion,
        paths: [...state.fullTrackPaths]
      })
      now = revealTimes[index]
      return {
        tracks: [tracks[index]],
        total: tracks.length,
        hasMore: index < tracks.length - 1,
        nextOffset: index < tracks.length - 1 ? index + 1 : null
      }
    }
  })
  useLibraryStore.setState({
    trackByPath: new Map(),
    trackCacheVersion: 0,
    trackPaths: [],
    fullTrackPaths: [],
    fullTracksStatus: 'idle',
    fullTrackConsumers: new Set(['library']),
    selectedAlbum: null,
    selectedArtist: null,
    selectedGenre: null,
    selectedYear: null,
    viewMode: 'tracks'
  })

  const originalDateNow = Date.now
  Date.now = () => now
  try {
    await useLibraryStore.getState().loadFullTracks()
  } finally {
    Date.now = originalDateNow
  }

  assert.deepEqual(requestSnapshots, [
    { version: 0, paths: [] },
    { version: 1, paths: [tracks[0].path] },
    { version: 1, paths: [tracks[0].path] },
    { version: 2, paths: tracks.slice(0, 3).map((track) => track.path) }
  ])

  const state = useLibraryStore.getState()
  assert.equal(state.trackCacheVersion, 3)
  assert.equal(state.fullTracksStatus, 'complete')
  assert.deepEqual(state.fullTrackPaths, tracks.map((track) => track.path))
  assert.deepEqual(state.trackPaths, tracks.map((track) => track.path))
  assert.deepEqual(
    state.resolveTrackPaths(state.fullTrackPaths).map((track) => track.path),
    tracks.map((track) => track.path)
  )
})

function prepareFullTrackLoadTest(t: test.TestContext) {
  const initialState = useLibraryStore.getState()
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  useLibraryStore.setState({
    trackByPath: new Map(), trackCacheVersion: 0, trackPaths: [], fullTrackPaths: [],
    fullTracksStatus: 'idle', fullTrackConsumers: new Set(), viewMode: 'tracks',
    selectedAlbum: null, selectedArtist: null, selectedGenre: null, selectedYear: null,
    favorites: new Set(), favoriteTrackPaths: [], recentlyPlayedPaths: [], searchResultPaths: []
  })
  t.after(() => {
    useLibraryStore.getState().releaseFullTracks()
    useLibraryStore.setState(initialState, true)
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

type TrackPage = Awaited<ReturnType<MockLibraryApi['getTracksPage']>>
const finalTrackPage = (tracks: DbTrack[]): TrackPage => ({
  tracks, total: tracks.length, hasMore: false, nextOffset: null
})

test('full-library consumers share in-flight pages and retain the completed list', async (t) => {
  prepareFullTrackLoadTest(t)
  const page = deferred<TrackPage>()
  const first = makeTrack('/music/first.flac')
  const second = makeTrack('/music/second.flac')
  const offsets: number[] = []
  installMockLibraryApi({
    getTracksPage: async ({ offset = 0 }) => {
      offsets.push(offset)
      return offset === 0 ? page.promise : finalTrackPage([second])
    }
  })
  const store = useLibraryStore.getState()
  const library = store.loadFullTracks('library')
  const integrity = store.loadFullTracks('integrity')
  page.resolve({ tracks: [first], total: 2, hasMore: true, nextOffset: 1 })
  await Promise.all([library, integrity])
  assert.deepEqual(offsets, [0, 1])
  assert.deepEqual(useLibraryStore.getState().fullTrackPaths, [first.path, second.path])
  store.releaseFullTracks('integrity')
  await store.loadFullTracks('integrity')
  assert.deepEqual(offsets, [0, 1], 'reopening a consumer should reuse the retained complete list')
  assert.deepEqual([...useLibraryStore.getState().fullTrackConsumers], ['library', 'integrity'])
})

test('explicit library reload supersedes shared pages and publishes fresh metadata', async (t) => {
  prepareFullTrackLoadTest(t)
  const oldPage = deferred<TrackPage>()
  const freshPage = deferred<TrackPage>()
  const oldTrack = makeTrack('/music/track.flac', { title: 'Before edit' })
  const freshTrack = makeTrack(oldTrack.path, { title: 'After edit' })
  let calls = 0
  installMockLibraryApi({ getTracksPage: () => ++calls === 1 ? oldPage.promise : freshPage.promise })
  const store = useLibraryStore.getState()
  const initialLoad = store.loadFullTracks('library')
  await Promise.resolve()
  const refresh = store.loadLibrary()
  await Promise.resolve()
  const integrity = store.loadFullTracks('integrity')
  oldPage.resolve(finalTrackPage([oldTrack]))
  await initialLoad
  assert.equal(useLibraryStore.getState().fullTracksStatus, 'loading')
  freshPage.resolve(finalTrackPage([freshTrack]))
  await Promise.all([refresh, integrity])
  assert.equal(calls, 2)
  assert.equal(useLibraryStore.getState().trackByPath.get(oldTrack.path)?.title, 'After edit')

  await store.loadLibrary()
  assert.equal(calls, 3, 'a reload must refresh even a completed retained list')
})

test('releasing all consumers cancels shared pages and permits a new request', async (t) => {
  prepareFullTrackLoadTest(t)
  const stalePage = deferred<TrackPage>()
  const newPage = deferred<TrackPage>()
  const track = makeTrack('/music/new.flac')
  let calls = 0
  installMockLibraryApi({ getTracksPage: () => ++calls === 1 ? stalePage.promise : newPage.promise })
  const store = useLibraryStore.getState()
  const stale = store.loadFullTracks('library')
  await Promise.resolve()
  store.releaseFullTracks('library')
  const current = store.loadFullTracks('integrity')
  await Promise.resolve()
  stalePage.resolve(finalTrackPage([makeTrack('/music/stale.flac')]))
  await stale
  assert.equal(useLibraryStore.getState().fullTracksStatus, 'loading')
  const joined = store.loadFullTracks('graph')
  newPage.resolve(finalTrackPage([track]))
  await Promise.all([current, joined])
  assert.equal(calls, 2)
  assert.deepEqual(useLibraryStore.getState().fullTrackPaths, [track.path])
  store.releaseFullTracks()
  assert.equal(useLibraryStore.getState().trackByPath.size, 0)
})

test('failed shared pages can be retried, including an empty library', async (t) => {
  prepareFullTrackLoadTest(t)
  const page = deferred<TrackPage>()
  let calls = 0
  installMockLibraryApi({ getTracksPage: () => ++calls === 1 ? page.promise : Promise.resolve(finalTrackPage([])) })
  const store = useLibraryStore.getState()
  const first = assert.rejects(store.loadFullTracks('library'), /page failed/)
  const second = assert.rejects(store.loadFullTracks('integrity'), /page failed/)
  page.reject(new Error('page failed'))
  await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(useLibraryStore.getState().fullTracksStatus, 'idle')
  await store.loadFullTracks('library')
  await store.loadFullTracks('graph')
  assert.equal(calls, 2)
  assert.equal(useLibraryStore.getState().fullTracksStatus, 'complete')
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
