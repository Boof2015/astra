import test from 'node:test'
import assert from 'node:assert/strict'
import { useLibraryStore, type DbTrack } from './libraryStore.ts'

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
    bpm: null,
    musical_key: null,
    source_type: 'local',
    source_id: null,
    source_track_id: null,
    source_path: null,
    is_available: 1,
    availability_reason: null,
    file_created_at: null,
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
} = {}): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        library: {
          getTracksByArtist: async () => options.artistTracks ?? [],
          getTracksByAlbum: async () => options.albumTracks ?? [],
          getTracksByGenre: async () => options.genreTracks ?? [],
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
    selectionOrigin: null,
    selectionHistory: [],
    selectionForwardHistory: [],
    trackPaths: [],
    fullTrackPaths: [],
    trackByPath: new Map()
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
    trackListSortState: { key: 'added', direction: 'desc' },
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

test('Library session restore drops a stale album detail and keeps root state', async () => {
  installLibraryMock({ albumTracks: [] })
  resetLibraryNavigation()

  await useLibraryStore.getState().restoreSession({
    viewMode: 'albums',
    selectedAlbum: { album: 'Missing', artist: 'Missing Artist', identity_key: 'missing' },
    selectedArtist: null,
    selectedGenre: null,
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
