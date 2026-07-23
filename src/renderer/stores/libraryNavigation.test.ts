import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getLibraryDiagnosticsSnapshot,
  MAX_SELECTION_HISTORY_TRACK_PATHS,
  useLibraryStore,
  type DbTrack
} from './libraryStore.ts'

function makeDbTrack(path: string, artist = 'Artist A'): DbTrack {
  return {
    id: 1,
    path,
    album_identity_key: 'album:key',
    is_new: false,
    title: path,
    artist,
    artist_names: [artist],
    album: 'Album',
    album_artist: artist,
    album_artist_names: [artist],
    duration: 180,
    track_number: 1,
    disc_number: 1,
    year: 2026,
    genre: null,
    genres: [],
    artwork_hash: null,
    base_artwork_hash: null,
    format: 'flac',
    sample_rate: 44100,
    bit_depth: 16,
    bitrate: null,
    channels: 2,
    codec: null,
    codec_profile: null,
    is_atmos_joc: 0,
    is_iamf: 0,
    bpm: null,
    musical_key: null,
    source_type: 'local',
    source_id: null,
    source_track_id: null,
    source_path: null,
    is_available: 1,
    availability_reason: null,
    file_created_at: null,
    play_count: 0,
    last_played_at: null,
    replaygain_track_gain_db: null,
    replaygain_album_gain_db: null,
    added_at: 1,
    modified_at: 1
  }
}

function installLibraryMock(options: {
  artistTracks?: DbTrack[]
  albumTracks?: DbTrack[]
  genreTracks?: DbTrack[]
  yearTracks?: DbTrack[]
  getTracksByAlbum?: (album: string, artist?: string, identityKey?: string) => Promise<DbTrack[]> | DbTrack[]
  getTracksByYear?: (year: number | null) => Promise<DbTrack[]> | DbTrack[]
} = {}): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        library: {
          getTracksByArtist: async () => options.artistTracks ?? [],
          getTracksByAlbum: async (album: string, artist?: string, identityKey?: string) => {
            return options.getTracksByAlbum
              ? options.getTracksByAlbum(album, artist, identityKey)
              : options.albumTracks ?? []
          },
          getTracksByGenre: async () => options.genreTracks ?? [],
          getTracksByYear: async (year: number | null) => {
            return options.getTracksByYear
              ? options.getTracksByYear(year)
              : options.yearTracks ?? []
          },
          getGenres: async () => []
        }
      }
    }
  })
}

function resetLibraryNavigation(): void {
  useLibraryStore.setState({
    viewMode: 'albums',
    selectedAlbum: null,
    selectedArtist: null,
    selectedGenre: null,
    selectedYear: null,
    selectionOrigin: null,
    selectionHistory: [],
    selectionForwardHistory: [],
    trackPaths: [],
    fullTrackPaths: [],
    trackByPath: new Map(),
    tracksViewSortState: { key: 'title', direction: 'asc' }
  })
  useLibraryStore.getState().setTrackListSortState({ key: 'title', direction: 'asc' })
  useLibraryStore.getState().clearSelectedSourceFilters()
}

test('Library detail navigation traverses backward and forward', async () => {
  installLibraryMock()
  resetLibraryNavigation()

  await useLibraryStore.getState().selectArtist('Artist A')
  await useLibraryStore.getState().selectAlbum('Album B', 'Artist B')

  assert.equal(useLibraryStore.getState().selectedAlbum?.album, 'Album B')
  assert.equal(await useLibraryStore.getState().goBackSelection(), true)
  assert.equal(useLibraryStore.getState().selectedArtist, 'Artist A')
  assert.equal(useLibraryStore.getState().selectionForwardHistory.length, 1)

  assert.equal(await useLibraryStore.getState().goForwardSelection(), true)
  assert.equal(useLibraryStore.getState().selectedAlbum?.album, 'Album B')
  assert.equal(useLibraryStore.getState().selectionHistory.length, 1)
})

test('explicit Library root exit bypasses detail history and retains the active mode', async () => {
  installLibraryMock()
  resetLibraryNavigation()
  useLibraryStore.getState().setViewMode('artists')

  await useLibraryStore.getState().selectArtist('Artist A')
  await useLibraryStore.getState().selectArtist('Artist B')

  assert.equal(useLibraryStore.getState().selectionHistory.length, 1)
  await useLibraryStore.getState().clearSelection()

  const state = useLibraryStore.getState()
  assert.equal(state.viewMode, 'artists')
  assert.equal(state.selectedAlbum, null)
  assert.equal(state.selectedArtist, null)
  assert.equal(state.selectedGenre, null)
  assert.equal(state.selectedYear, null)
  assert.equal(state.selectionOrigin, null)
  assert.deepEqual(state.selectionHistory, [])
  assert.deepEqual(state.selectionForwardHistory, [])
  assert.deepEqual(state.trackPaths, [])
})

test('album opened from an artist detail restores the artist context', async () => {
  installLibraryMock()
  resetLibraryNavigation()
  useLibraryStore.getState().setViewMode('artists')

  await useLibraryStore.getState().selectArtist('Artist A')
  await useLibraryStore.getState().selectAlbum('Album A', 'Artist A', 'library-detail')

  assert.equal(useLibraryStore.getState().selectionOrigin, 'library-detail')
  assert.equal(await useLibraryStore.getState().goBackSelection(), true)

  const state = useLibraryStore.getState()
  assert.equal(state.viewMode, 'artists')
  assert.equal(state.selectedArtist, 'Artist A')
  assert.equal(state.selectedAlbum, null)
})

test('album opened from global search exits to the remembered Library root', async () => {
  installLibraryMock()
  resetLibraryNavigation()
  useLibraryStore.getState().setViewMode('artists')

  await useLibraryStore.getState().selectArtist('Artist A')
  await useLibraryStore.getState().selectAlbum('Search Album', 'Artist B', 'library')

  assert.equal(useLibraryStore.getState().selectionOrigin, 'library')
  await useLibraryStore.getState().clearSelection()

  const state = useLibraryStore.getState()
  assert.equal(state.viewMode, 'artists')
  assert.equal(state.selectedArtist, null)
  assert.equal(state.selectedAlbum, null)
  assert.deepEqual(state.selectionHistory, [])
})

test('root Tracks sort and source filters survive Library tab switches', () => {
  installLibraryMock()
  resetLibraryNavigation()
  useLibraryStore.getState().setViewMode('tracks')
  useLibraryStore.getState().setTrackListSortState({ key: 'duration', direction: 'desc' })
  useLibraryStore.getState().setSelectedSourceFilters(['local'])

  useLibraryStore.getState().setViewMode('artists')
  assert.deepEqual(useLibraryStore.getState().trackListSortState, { key: 'title', direction: 'asc' })
  assert.deepEqual([...useLibraryStore.getState().selectedSourceFilters], ['local'])

  useLibraryStore.getState().setViewMode('tracks')
  assert.deepEqual(useLibraryStore.getState().trackListSortState, { key: 'duration', direction: 'desc' })
  assert.deepEqual([...useLibraryStore.getState().selectedSourceFilters], ['local'])
})

test('detail sorting does not overwrite the root Tracks sort', async () => {
  installLibraryMock()
  resetLibraryNavigation()
  useLibraryStore.getState().setViewMode('tracks')
  useLibraryStore.getState().setTrackListSortState({ key: 'duration', direction: 'desc' })
  useLibraryStore.getState().setSelectedSourceFilters(['local'])

  await useLibraryStore.getState().selectArtist('Artist A')
  useLibraryStore.getState().setTrackListSortState({ key: 'added', direction: 'desc' })
  await useLibraryStore.getState().clearSelection()

  assert.deepEqual(useLibraryStore.getState().trackListSortState, { key: 'duration', direction: 'desc' })
  assert.deepEqual([...useLibraryStore.getState().selectedSourceFilters], ['local'])
})

test('Library root participates in forward navigation and fresh selection clears forward history', async () => {
  installLibraryMock()
  resetLibraryNavigation()

  await useLibraryStore.getState().selectArtist('Artist A')
  assert.equal(await useLibraryStore.getState().goBackSelection(), true)
  assert.equal(useLibraryStore.getState().selectedArtist, null)
  assert.equal(useLibraryStore.getState().selectionForwardHistory.length, 1)

  assert.equal(await useLibraryStore.getState().goForwardSelection(), true)
  assert.equal(useLibraryStore.getState().selectedArtist, 'Artist A')

  await useLibraryStore.getState().goBackSelection()
  await useLibraryStore.getState().selectArtist('Artist C')
  assert.equal(useLibraryStore.getState().selectionForwardHistory.length, 0)
  assert.equal(await useLibraryStore.getState().goForwardSelection(), false)
})

test('Library genre detail participates in backward and forward navigation', async () => {
  const genreTrack = makeDbTrack('/genre/a.flac', 'Genre Artist')
  installLibraryMock({ genreTracks: [genreTrack] })
  resetLibraryNavigation()

  await useLibraryStore.getState().selectArtist('Artist A')
  await useLibraryStore.getState().selectGenre('Electronic')

  assert.equal(useLibraryStore.getState().selectedGenre, 'Electronic')
  assert.deepEqual(useLibraryStore.getState().trackPaths, [genreTrack.path])

  assert.equal(await useLibraryStore.getState().goBackSelection(), true)
  assert.equal(useLibraryStore.getState().selectedArtist, 'Artist A')
  assert.equal(useLibraryStore.getState().selectedGenre, null)
  assert.equal(useLibraryStore.getState().selectionForwardHistory.length, 1)

  assert.equal(await useLibraryStore.getState().goForwardSelection(), true)
  assert.equal(useLibraryStore.getState().selectedArtist, null)
  assert.equal(useLibraryStore.getState().selectedGenre, 'Electronic')
  assert.deepEqual(useLibraryStore.getState().trackPaths, [genreTrack.path])
})

test('Library year and album details participate in backward and forward navigation', async () => {
  const albumTrack = makeDbTrack('/years/2025/album.flac', 'Year Artist')
  const yearFetches: Array<number | null> = []
  installLibraryMock({
    albumTracks: [albumTrack],
    getTracksByYear: (year) => {
      yearFetches.push(year)
      return [albumTrack]
    }
  })
  resetLibraryNavigation()
  useLibraryStore.setState({
    viewMode: 'years',
    albums: [{
      identity_key: 'album:key',
      album: 'Year Album',
      artist: 'Year Artist',
      primary_artist: 'Year Artist',
      year: 2025,
      artwork_hash: null,
      track_count: 1,
      is_new: false
    }]
  })

  await useLibraryStore.getState().selectYear(2025)
  assert.equal(useLibraryStore.getState().selectedYear, 2025)
  assert.deepEqual(useLibraryStore.getState().trackPaths, [albumTrack.path])
  assert.deepEqual(yearFetches, [2025])

  await useLibraryStore.getState().selectAlbum('Year Album', 'Year Artist', 'library', 'album:key')
  assert.equal(useLibraryStore.getState().selectedYear, null)
  assert.equal(useLibraryStore.getState().selectedAlbum?.album, 'Year Album')

  assert.equal(await useLibraryStore.getState().goBackSelection(), true)
  assert.equal(useLibraryStore.getState().selectedAlbum, null)
  assert.equal(useLibraryStore.getState().selectedYear, 2025)

  assert.equal(await useLibraryStore.getState().goBackSelection(), true)
  assert.equal(useLibraryStore.getState().selectedYear, null)

  assert.equal(await useLibraryStore.getState().goForwardSelection(), true)
  assert.equal(useLibraryStore.getState().selectedYear, 2025)

  assert.equal(await useLibraryStore.getState().goForwardSelection(), true)
  assert.equal(useLibraryStore.getState().selectedAlbum?.album, 'Year Album')
  assert.deepEqual(useLibraryStore.getState().trackPaths, [albumTrack.path])
})

test('Library selection history prunes oversized track path snapshots and refetches on restore', async () => {
  const largeAlbumTracks = Array.from(
    { length: MAX_SELECTION_HISTORY_TRACK_PATHS + 1 },
    (_value, index) => makeDbTrack(`/large-album/${index}.flac`, 'Artist A')
  )
  const nextAlbumTrack = makeDbTrack('/next-album/1.flac', 'Artist B')
  const albumFetches: string[] = []
  installLibraryMock({
    getTracksByAlbum: async (album) => {
      albumFetches.push(album)
      if (album === 'Large Album') return largeAlbumTracks
      if (album === 'Next Album') return [nextAlbumTrack]
      return []
    }
  })
  resetLibraryNavigation()

  await useLibraryStore.getState().selectAlbum('Large Album', 'Artist A')
  assert.equal(useLibraryStore.getState().trackPaths.length, largeAlbumTracks.length)

  await useLibraryStore.getState().selectAlbum('Next Album', 'Artist B')
  const [historySnapshot] = useLibraryStore.getState().selectionHistory
  assert.equal(historySnapshot?.selectedAlbum?.album, 'Large Album')
  assert.equal(historySnapshot?.trackPathsPruned, true)
  assert.deepEqual(historySnapshot?.trackPaths, [])
  assert.equal(getLibraryDiagnosticsSnapshot().selectionHistoryTrackCount, 0)

  assert.equal(await useLibraryStore.getState().goBackSelection(), true)
  assert.equal(useLibraryStore.getState().selectedAlbum?.album, 'Large Album')
  assert.equal(useLibraryStore.getState().trackPaths.length, largeAlbumTracks.length)
  assert.equal(albumFetches.filter((album) => album === 'Large Album').length, 2)
})

test('Library year history refetches an oversized year collection on restore', async () => {
  const largeYearTracks = Array.from(
    { length: MAX_SELECTION_HISTORY_TRACK_PATHS + 1 },
    (_value, index) => makeDbTrack(`/large-year/${index}.flac`, 'Year Artist')
  )
  const albumTrack = makeDbTrack('/next-album/1.flac', 'Next Artist')
  const yearFetches: Array<number | null> = []
  installLibraryMock({
    albumTracks: [albumTrack],
    getTracksByYear: (year) => {
      yearFetches.push(year)
      return largeYearTracks
    }
  })
  resetLibraryNavigation()
  useLibraryStore.setState({ viewMode: 'years' })

  await useLibraryStore.getState().selectYear(2025)
  assert.equal(useLibraryStore.getState().trackPaths.length, largeYearTracks.length)

  await useLibraryStore.getState().selectAlbum('Next Album', 'Next Artist')
  const [historySnapshot] = useLibraryStore.getState().selectionHistory
  assert.equal(historySnapshot?.selectedYear, 2025)
  assert.equal(historySnapshot?.trackPathsPruned, true)
  assert.deepEqual(historySnapshot?.trackPaths, [])

  assert.equal(await useLibraryStore.getState().goBackSelection(), true)
  assert.equal(useLibraryStore.getState().selectedYear, 2025)
  assert.equal(useLibraryStore.getState().trackPaths.length, largeYearTracks.length)
  assert.deepEqual(yearFetches, [2025, 2025])
})

test('releasing the full-library cache preserves selected Year tracks', async () => {
  const yearTrack = makeDbTrack('/years/2025/track.flac', 'Year Artist')
  installLibraryMock({ yearTracks: [yearTrack] })
  resetLibraryNavigation()

  await useLibraryStore.getState().selectYear(2025)
  useLibraryStore.setState({
    fullTrackConsumers: new Set(['library']),
    fullTrackPaths: ['/library/other.flac'],
    fullTracksStatus: 'complete'
  })

  useLibraryStore.getState().releaseFullTracks('library')

  assert.deepEqual(useLibraryStore.getState().trackPaths, [yearTrack.path])
  assert.deepEqual(useLibraryStore.getState().fullTrackPaths, [])
})

test('Library session restore applies valid detail, sort, and source filters', async () => {
  const track = makeDbTrack('/artist/a.flac', 'Artist A')
  installLibraryMock({ artistTracks: [track] })
  resetLibraryNavigation()
  useLibraryStore.setState({
    artists: [{
      artist: 'Artist A',
      track_count: 1,
      primary_track_count: 1,
      album_count: 1,
      artwork_hash: null,
      artwork_source: null
    }]
  })

  await useLibraryStore.getState().restoreSession({
    viewMode: 'artists',
    selectedAlbum: null,
    selectedArtist: 'Artist A',
    selectedGenre: null,
    selectedYear: null,
    trackListSortState: { key: 'added', direction: 'desc' },
    tracksViewSortState: { key: 'duration', direction: 'desc' },
    selectedSourceFilters: ['local'],
    albumSortMode: 'artist',
    includeSinglesInAlbums: true,
    includeCollabArtists: true,
    artistRootViewMode: 'grid'
  })

  const state = useLibraryStore.getState()
  assert.equal(state.viewMode, 'artists')
  assert.equal(state.selectedArtist, 'Artist A')
  assert.deepEqual(state.trackPaths, [track.path])
  assert.deepEqual(state.trackListSortState, { key: 'added', direction: 'desc' })
  assert.deepEqual([...state.selectedSourceFilters], ['local'])
  assert.equal(state.albumSortMode, 'artist')
  assert.equal(state.includeSinglesInAlbums, true)
  assert.equal(state.includeCollabArtists, true)
  assert.equal(state.artistRootViewMode, 'grid')

  await useLibraryStore.getState().clearSelection()
  useLibraryStore.getState().setViewMode('tracks')
  assert.deepEqual(useLibraryStore.getState().trackListSortState, { key: 'duration', direction: 'desc' })
  assert.deepEqual([...useLibraryStore.getState().selectedSourceFilters], ['local'])
})

test('Library session restore applies a valid genre detail', async () => {
  const track = makeDbTrack('/genre/electronic.flac', 'Genre Artist')
  installLibraryMock({ genreTracks: [track] })
  resetLibraryNavigation()
  useLibraryStore.setState({
    genres: [{
      genre: 'Electronic',
      track_count: 1,
      album_count: 1,
      artwork_hash: null
    }]
  })

  await useLibraryStore.getState().restoreSession({
    viewMode: 'genres',
    selectedAlbum: null,
    selectedArtist: null,
    selectedGenre: 'Electronic',
    selectedYear: null,
    trackListSortState: { key: 'title', direction: 'asc' },
    selectedSourceFilters: [],
    albumSortMode: 'title',
    includeSinglesInAlbums: false,
    includeCollabArtists: false,
    artistRootViewMode: 'list'
  })

  const state = useLibraryStore.getState()
  assert.equal(state.viewMode, 'genres')
  assert.equal(state.selectedGenre, 'Electronic')
  assert.deepEqual(state.trackPaths, [track.path])
})

test('legacy root Tracks snapshots derive the dedicated Tracks sort from the active sort', async () => {
  installLibraryMock()
  resetLibraryNavigation()

  await useLibraryStore.getState().restoreSession({
    viewMode: 'tracks',
    selectedAlbum: null,
    selectedArtist: null,
    selectedGenre: null,
    selectedYear: null,
    trackListSortState: { key: 'added', direction: 'desc' },
    selectedSourceFilters: ['local'],
    albumSortMode: 'title',
    includeSinglesInAlbums: false,
    includeCollabArtists: false,
    artistRootViewMode: 'list'
  })

  assert.deepEqual(useLibraryStore.getState().tracksViewSortState, { key: 'added', direction: 'desc' })
  useLibraryStore.getState().setViewMode('albums')
  useLibraryStore.getState().setViewMode('tracks')
  assert.deepEqual(useLibraryStore.getState().trackListSortState, { key: 'added', direction: 'desc' })
  assert.deepEqual([...useLibraryStore.getState().selectedSourceFilters], ['local'])
})

test('Library session restore drops a stale album detail and keeps root state', async () => {
  installLibraryMock({ albumTracks: [] })
  resetLibraryNavigation()

  await useLibraryStore.getState().restoreSession({
    viewMode: 'albums',
    selectedAlbum: { album: 'Missing', artist: 'Missing Artist', identity_key: 'missing' },
    selectedArtist: null,
    selectedGenre: null,
    selectedYear: null,
    trackListSortState: null,
    selectedSourceFilters: ['local'],
    albumSortMode: 'title',
    includeSinglesInAlbums: false,
    includeCollabArtists: false,
    artistRootViewMode: 'list'
  })

  const state = useLibraryStore.getState()
  assert.equal(state.viewMode, 'albums')
  assert.equal(state.selectedAlbum, null)
  assert.equal(state.selectedArtist, null)
  assert.equal(state.selectedGenre, null)
  assert.deepEqual(state.trackPaths, [])
  assert.deepEqual([...state.selectedSourceFilters], ['local'])
})

test('Library session restore drops a stale genre detail and keeps root state', async () => {
  installLibraryMock({ genreTracks: [] })
  resetLibraryNavigation()

  await useLibraryStore.getState().restoreSession({
    viewMode: 'genres',
    selectedAlbum: null,
    selectedArtist: null,
    selectedGenre: 'Missing Genre',
    selectedYear: null,
    trackListSortState: null,
    selectedSourceFilters: ['local'],
    albumSortMode: 'title',
    includeSinglesInAlbums: false,
    includeCollabArtists: false,
    artistRootViewMode: 'list'
  })

  const state = useLibraryStore.getState()
  assert.equal(state.viewMode, 'genres')
  assert.equal(state.selectedAlbum, null)
  assert.equal(state.selectedArtist, null)
  assert.equal(state.selectedGenre, null)
  assert.deepEqual(state.trackPaths, [])
  assert.deepEqual([...state.selectedSourceFilters], ['local'])
})

test('Library session restore preserves Unknown Year and drops a stale year', async () => {
  const yearTrack = makeDbTrack('/years/unknown/track.flac', 'Undated Artist')
  const yearFetches: Array<number | null> = []
  installLibraryMock({
    getTracksByYear: (year) => {
      yearFetches.push(year)
      return [yearTrack]
    }
  })
  resetLibraryNavigation()
  useLibraryStore.setState({
    albums: [{
      identity_key: 'album:unknown',
      album: 'Undated Album',
      artist: 'Artist',
      primary_artist: 'Artist',
      year: null,
      artwork_hash: null,
      track_count: 1,
      is_new: false
    }]
  })

  const baseSnapshot = {
    viewMode: 'years' as const,
    selectedAlbum: null,
    selectedArtist: null,
    selectedGenre: null,
    trackListSortState: null,
    selectedSourceFilters: [],
    albumSortMode: 'title' as const,
    includeSinglesInAlbums: false,
    includeCollabArtists: false,
    artistRootViewMode: 'list' as const
  }

  await useLibraryStore.getState().restoreSession({
    ...baseSnapshot,
    selectedYear: 'unknown'
  })
  assert.equal(useLibraryStore.getState().selectedYear, 'unknown')
  assert.deepEqual(useLibraryStore.getState().trackPaths, [yearTrack.path])
  assert.deepEqual(yearFetches, [null])

  await useLibraryStore.getState().restoreSession({
    ...baseSnapshot,
    selectedYear: 1999
  })
  assert.equal(useLibraryStore.getState().viewMode, 'years')
  assert.equal(useLibraryStore.getState().selectedYear, null)
  assert.deepEqual(yearFetches, [null])
})
