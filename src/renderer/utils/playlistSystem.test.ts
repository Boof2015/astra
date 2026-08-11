import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FAVORITES_PLAYLIST_ID,
  buildAllDisplayPlaylists,
  buildHomePlaylists,
  buildSidebarPlaylistSections,
  getDefaultSidebarPinnedPlaylistIds,
  normalizePlaylistBrowserSortMode,
  normalizeSidebarPinnedPlaylistIds,
  parsePlaylistSidebarPins,
  serializePlaylistSidebarPins,
  sortPlaylistBrowserEntries,
  type PlaylistLike
} from './playlistSystem.ts'

function playlist(
  id: number,
  overrides: Partial<PlaylistLike> = {}
): PlaylistLike {
  return {
    id,
    name: `Playlist ${id}`,
    kind: 'normal',
    created_at: id * 10,
    updated_at: id * 100,
    last_played_at: null,
    custom_cover_hash: null,
    auto_cover_hash: null,
    track_count: id,
    missing_track_count: 0,
    ...overrides
  }
}

const favorites = { trackCount: 4, topArtworkHash: 'favorites-cover' }

test('default sidebar pins seed Favorites and the three most relevant playlists', () => {
  const playlists = [
    playlist(1, { updated_at: 100 }),
    playlist(2, { last_played_at: 500 }),
    playlist(3, { last_played_at: 800 }),
    playlist(4, { updated_at: 900 })
  ]

  assert.deepEqual(getDefaultSidebarPinnedPlaylistIds(playlists), [FAVORITES_PLAYLIST_ID, 3, 2, 4])
})

test('sidebar pin normalization removes duplicates and missing playlist ids but retains Favorites', () => {
  assert.deepEqual(
    normalizeSidebarPinnedPlaylistIds([3, 3, 999, FAVORITES_PLAYLIST_ID, 2], [playlist(2), playlist(3)]),
    [3, FAVORITES_PLAYLIST_ID, 2]
  )
})

test('sidebar pin persistence distinguishes an empty custom list from invalid state', () => {
  const serialized = serializePlaylistSidebarPins([])
  assert.deepEqual(parsePlaylistSidebarPins(serialized), [])
  assert.equal(parsePlaylistSidebarPins('{"version":2,"pinnedPlaylistIds":[]}'), null)
  assert.equal(parsePlaylistSidebarPins('{not-json'), null)
  assert.equal(parsePlaylistSidebarPins('{"version":1,"pinnedPlaylistIds":[1,"2"]}'), null)
})

test('sidebar sections follow exact pin order and put every unpinned item under More', () => {
  const playlists = [playlist(1), playlist(2), playlist(3)]
  const sections = buildSidebarPlaylistSections(
    playlists,
    favorites,
    [2, FAVORITES_PLAYLIST_ID]
  )

  assert.deepEqual(sections.sidebarPinnedPlaylists.map((entry) => entry.id), [2, FAVORITES_PLAYLIST_ID])
  assert.deepEqual(sections.sidebarOverflowPlaylists.map((entry) => entry.id), [3, 1])
})

test('empty Favorites is hidden without disturbing its saved pin position', () => {
  const sections = buildSidebarPlaylistSections(
    [playlist(1), playlist(2)],
    { trackCount: 0, topArtworkHash: null },
    [2, FAVORITES_PLAYLIST_ID, 1]
  )

  assert.deepEqual(sections.sidebarPinnedPlaylists.map((entry) => entry.id), [2, 1])
})

test('Home ordering remains recency based and independent from sidebar pins', () => {
  const playlists = [
    playlist(1, { last_played_at: 100 }),
    playlist(2, { last_played_at: 300 })
  ]
  assert.deepEqual(buildHomePlaylists(playlists, favorites).map((entry) => entry.id), [FAVORITES_PLAYLIST_ID, 2, 1])
})

test('playlist browser sort modes preserve Favorites and sort user playlists', () => {
  const entries = buildAllDisplayPlaylists([
    playlist(1, { name: 'Zulu', created_at: 100, updated_at: 500 }),
    playlist(2, { name: 'Alpha', created_at: 900, updated_at: 200 })
  ], favorites)

  assert.deepEqual(sortPlaylistBrowserEntries(entries, 'name').map((entry) => entry.id), [FAVORITES_PLAYLIST_ID, 2, 1])
  assert.deepEqual(sortPlaylistBrowserEntries(entries, 'created').map((entry) => entry.id), [FAVORITES_PLAYLIST_ID, 2, 1])
  assert.deepEqual(sortPlaylistBrowserEntries(entries, 'recently-updated').map((entry) => entry.id), [FAVORITES_PLAYLIST_ID, 1, 2])
  assert.equal(normalizePlaylistBrowserSortMode('unknown'), 'recently-played')
})
