import assert from 'node:assert/strict'
import test from 'node:test'
import { getNormalPlaylists, usePlaylistStore, type Playlist } from './playlistStore.ts'

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

function installPlaylistMock(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        library: {
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
    sortState: null
  })
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
