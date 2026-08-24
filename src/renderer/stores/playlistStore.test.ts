import assert from 'node:assert/strict'
import test from 'node:test'
import { getNormalPlaylists, usePlaylistStore, type Playlist } from './playlistStore.ts'
import { FAVORITES_PLAYLIST_ID, parsePlaylistSidebarPins } from '../utils/playlistSystem.ts'
import { PLAYLIST_SIDEBAR_PINS_STORAGE_KEY } from '../constants/settingsStorageKeys.ts'

function makePlaylist(id: number, name = `Playlist ${id}`, kind: Playlist['kind'] = 'normal'): Playlist {
  return {
    id,
    name,
    kind,
    created_at: 1,
    updated_at: 1,
    last_played_at: null,
    custom_cover_hash: null,
    auto_cover_hash: null,
    track_count: 0,
    missing_track_count: 0
  }
}

function installPlaylistMock(playlists: Playlist[] = []): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        library: {
          getPlaylists: async () => playlists,
          getPlaylistTrackEntries: async () => [],
          getFavorites: async () => []
        }
      }
    }
  })
}

function resetPlaylistStore(playlists: Playlist[] = []): void {
  usePlaylistStore.setState({
    playlists,
    selectedPlaylistId: null,
    selectedPlaylistEntries: [],
    selectedPlaylistTracks: [],
    sortState: null,
    sidebarPinnedPlaylistIds: [FAVORITES_PLAYLIST_ID],
    sidebarPinsInitialized: false,
    browserSortMode: 'recently-played'
  })
}

function installLocalStorageMock(): { values: Map<string, string>; restore: () => void } {
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
  return {
    values,
    restore: () => {
      if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  }
}

test('Playlist session restore selects an existing playlist and restores sort state', async () => {
  installPlaylistMock()
  resetPlaylistStore([makePlaylist(7)])

  await usePlaylistStore.getState().restoreSession({
    selectedPlaylistId: 7,
    sortState: { key: 'added', direction: 'desc' }
  })

  assert.equal(usePlaylistStore.getState().selectedPlaylistId, 7)
  assert.deepEqual(usePlaylistStore.getState().sortState, { key: 'added', direction: 'desc' })
  assert.deepEqual(usePlaylistStore.getState().getSessionSnapshot(), {
    selectedPlaylistId: 7,
    sortState: { key: 'added', direction: 'desc' }
  })
})

test('Playlist session restore selects an existing dynamic playlist', async () => {
  installPlaylistMock()
  resetPlaylistStore([makePlaylist(11, 'Dynamic Set', 'dynamic')])

  await usePlaylistStore.getState().restoreSession({
    selectedPlaylistId: 11,
    sortState: { key: 'title', direction: 'asc' }
  })

  assert.equal(usePlaylistStore.getState().selectedPlaylistId, 11)
  assert.deepEqual(usePlaylistStore.getState().selectedPlaylistTracks, [])
})

test('Playlist session restore drops a missing selected playlist but keeps sort preference', async () => {
  installPlaylistMock()
  resetPlaylistStore([makePlaylist(3)])

  await usePlaylistStore.getState().restoreSession({
    selectedPlaylistId: 42,
    sortState: { key: 'title', direction: 'asc' }
  })

  assert.equal(usePlaylistStore.getState().selectedPlaylistId, null)
  assert.deepEqual(usePlaylistStore.getState().sortState, { key: 'title', direction: 'asc' })
})

test('getNormalPlaylists filters dynamic playlists out of manual targets', () => {
  const normal = makePlaylist(1, 'Manual')
  const dynamic = makePlaylist(2, 'Dynamic', 'dynamic')

  assert.deepEqual(getNormalPlaylists([normal, dynamic]), [normal])
})

test('sidebar pins persist exact order and allow an empty custom list', () => {
  const storage = installLocalStorageMock()
  try {
    resetPlaylistStore([makePlaylist(1), makePlaylist(2), makePlaylist(3)])
    const store = usePlaylistStore.getState()

    store.pinPlaylistToSidebar(2)
    store.pinPlaylistToSidebar(1)
    usePlaylistStore.getState().moveSidebarPinnedPlaylist(1, 0)
    assert.deepEqual(usePlaylistStore.getState().sidebarPinnedPlaylistIds, [1, FAVORITES_PLAYLIST_ID, 2])
    usePlaylistStore.getState().moveSidebarPinnedPlaylist(1, 2)
    assert.deepEqual(usePlaylistStore.getState().sidebarPinnedPlaylistIds, [FAVORITES_PLAYLIST_ID, 2, 1])
    usePlaylistStore.getState().moveSidebarPinnedPlaylist(1, 0)
    assert.deepEqual(usePlaylistStore.getState().sidebarPinnedPlaylistIds, [1, FAVORITES_PLAYLIST_ID, 2])

    usePlaylistStore.getState().unpinPlaylistFromSidebar(1)
    usePlaylistStore.getState().unpinPlaylistFromSidebar(2)
    usePlaylistStore.getState().unpinPlaylistFromSidebar(FAVORITES_PLAYLIST_ID)
    assert.deepEqual(usePlaylistStore.getState().sidebarPinnedPlaylistIds, [])
    assert.deepEqual(
      parsePlaylistSidebarPins(storage.values.get(PLAYLIST_SIDEBAR_PINS_STORAGE_KEY)),
      []
    )
  } finally {
    storage.restore()
  }
})

test('loading playlists seeds defaults once and prunes deleted playlist ids', async () => {
  const storage = installLocalStorageMock()
  try {
    const playlists = [
      makePlaylist(1),
      { ...makePlaylist(2), last_played_at: 200 },
      { ...makePlaylist(3), last_played_at: 300 },
      makePlaylist(4)
    ]
    installPlaylistMock(playlists)
    resetPlaylistStore()

    await usePlaylistStore.getState().loadPlaylists()
    assert.deepEqual(
      usePlaylistStore.getState().sidebarPinnedPlaylistIds,
      [FAVORITES_PLAYLIST_ID, 3, 2, 4]
    )

    usePlaylistStore.setState({
      sidebarPinnedPlaylistIds: [FAVORITES_PLAYLIST_ID, 3, 999],
      sidebarPinsInitialized: true
    })
    await usePlaylistStore.getState().loadPlaylists()
    assert.deepEqual(usePlaylistStore.getState().sidebarPinnedPlaylistIds, [FAVORITES_PLAYLIST_ID, 3])
  } finally {
    storage.restore()
  }
})
