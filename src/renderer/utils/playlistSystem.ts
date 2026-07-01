export const FAVORITES_PLAYLIST_ID = -1
export const FAVORITES_PLAYLIST_NAME = 'Favorites'

export interface PlaylistLike {
  id: number
  name: string
  kind?: 'normal' | 'dynamic'
  created_at: number
  updated_at: number
  last_played_at: number | null
  custom_cover_hash: string | null
  auto_cover_hash: string | null
  track_count: number
  missing_track_count?: number
}

export interface DisplayPlaylist extends PlaylistLike {
  isSystemFavorites: boolean
  cover_hash: string | null
}

export interface PlaylistDisplaySections {
  homePlaylists: DisplayPlaylist[]
  sidebarQuickPlaylists: DisplayPlaylist[]
  sidebarOverflowPlaylists: DisplayPlaylist[]
}

export function isSystemFavoritesPlaylistId(playlistId: number | null | undefined): boolean {
  return playlistId === FAVORITES_PLAYLIST_ID
}

export function sortUserPlaylists(playlists: PlaylistLike[]): PlaylistLike[] {
  return [...playlists].sort((a, b) => {
    const aPlayed = a.last_played_at
    const bPlayed = b.last_played_at

    if (aPlayed !== null && bPlayed !== null) {
      if (bPlayed !== aPlayed) return bPlayed - aPlayed
      if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at
      return b.id - a.id
    }

    if (aPlayed !== null) return -1
    if (bPlayed !== null) return 1
    if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at
    return b.id - a.id
  })
}

interface FavoritesDisplayOptions {
  trackCount: number
  topArtworkHash: string | null
}

function createFavoritesPlaylist(options: FavoritesDisplayOptions): DisplayPlaylist | null {
  if (options.trackCount <= 0) return null
  return {
    id: FAVORITES_PLAYLIST_ID,
    name: FAVORITES_PLAYLIST_NAME,
    kind: 'normal',
    created_at: 0,
    updated_at: 0,
    last_played_at: null,
    custom_cover_hash: null,
    auto_cover_hash: options.topArtworkHash,
    track_count: options.trackCount,
    missing_track_count: 0,
    isSystemFavorites: true,
    cover_hash: options.topArtworkHash
  }
}

function toDisplayPlaylist(playlist: PlaylistLike): DisplayPlaylist {
  return {
    ...playlist,
    kind: playlist.kind === 'dynamic' ? 'dynamic' : 'normal',
    isSystemFavorites: false,
    cover_hash: playlist.custom_cover_hash ?? playlist.auto_cover_hash
  }
}

export function buildPlaylistDisplaySections(
  userPlaylists: PlaylistLike[],
  favoriteOptions: FavoritesDisplayOptions,
  quickPlayedLimit: number = 3
): PlaylistDisplaySections {
  const favoritesPlaylist = createFavoritesPlaylist(favoriteOptions)
  const orderedUserPlaylists = sortUserPlaylists(userPlaylists)

  // Fill quick slots from the global ordered list so unplayed playlists
  // still appear when there are fewer than `quickPlayedLimit` played playlists.
  const quickUserPlaylists = orderedUserPlaylists.slice(0, quickPlayedLimit)

  const quickPlaylistIdSet = new Set(quickUserPlaylists.map((playlist) => playlist.id))

  const sidebarOverflowPlaylists = orderedUserPlaylists
    .filter((playlist) => !quickPlaylistIdSet.has(playlist.id))
    .map(toDisplayPlaylist)

  const sidebarQuickPlaylists = [
    ...(favoritesPlaylist ? [favoritesPlaylist] : []),
    ...quickUserPlaylists.map(toDisplayPlaylist)
  ]

  const homePlaylists = [
    ...(favoritesPlaylist ? [favoritesPlaylist] : []),
    ...orderedUserPlaylists.map(toDisplayPlaylist)
  ]

  return {
    homePlaylists,
    sidebarQuickPlaylists,
    sidebarOverflowPlaylists
  }
}
