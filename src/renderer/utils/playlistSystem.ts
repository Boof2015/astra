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

export interface SidebarPlaylistSections {
  sidebarPinnedPlaylists: DisplayPlaylist[]
  sidebarOverflowPlaylists: DisplayPlaylist[]
}

export type PlaylistBrowserSortMode = 'recently-played' | 'recently-updated' | 'name' | 'created'

export interface PlaylistSidebarPinsV1 {
  version: 1
  pinnedPlaylistIds: number[]
}

export const PLAYLIST_SIDEBAR_PINS_VERSION = 1
export const DEFAULT_SIDEBAR_USER_PLAYLIST_LIMIT = 3

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

export function buildAllDisplayPlaylists(
  userPlaylists: PlaylistLike[],
  favoriteOptions: FavoritesDisplayOptions
): DisplayPlaylist[] {
  const favoritesPlaylist = createFavoritesPlaylist(favoriteOptions)
  return [
    ...(favoritesPlaylist ? [favoritesPlaylist] : []),
    ...sortUserPlaylists(userPlaylists).map(toDisplayPlaylist)
  ]
}

export function buildHomePlaylists(
  userPlaylists: PlaylistLike[],
  favoriteOptions: FavoritesDisplayOptions
): DisplayPlaylist[] {
  return buildAllDisplayPlaylists(userPlaylists, favoriteOptions)
}

export function getDefaultSidebarPinnedPlaylistIds(
  userPlaylists: PlaylistLike[],
  quickPlayedLimit: number = DEFAULT_SIDEBAR_USER_PLAYLIST_LIMIT
): number[] {
  return [
    FAVORITES_PLAYLIST_ID,
    ...sortUserPlaylists(userPlaylists)
      .slice(0, Math.max(0, quickPlayedLimit))
      .map((playlist) => playlist.id)
  ]
}

export function normalizeSidebarPinnedPlaylistIds(
  pinnedPlaylistIds: readonly number[],
  userPlaylists: PlaylistLike[]
): number[] {
  const validPlaylistIds = new Set(userPlaylists.map((playlist) => playlist.id))
  validPlaylistIds.add(FAVORITES_PLAYLIST_ID)

  const normalized: number[] = []
  const seen = new Set<number>()
  for (const value of pinnedPlaylistIds) {
    if (!Number.isInteger(value) || !validPlaylistIds.has(value) || seen.has(value)) continue
    normalized.push(value)
    seen.add(value)
  }
  return normalized
}

export function parsePlaylistSidebarPins(raw: unknown): number[] | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PlaylistSidebarPinsV1>
    if (parsed.version !== PLAYLIST_SIDEBAR_PINS_VERSION || !Array.isArray(parsed.pinnedPlaylistIds)) {
      return null
    }
    if (!parsed.pinnedPlaylistIds.every((value) => Number.isInteger(value))) return null
    return [...parsed.pinnedPlaylistIds]
  } catch {
    return null
  }
}

export function serializePlaylistSidebarPins(pinnedPlaylistIds: readonly number[]): string {
  const payload: PlaylistSidebarPinsV1 = {
    version: PLAYLIST_SIDEBAR_PINS_VERSION,
    pinnedPlaylistIds: [...pinnedPlaylistIds]
  }
  return JSON.stringify(payload)
}

export function buildSidebarPlaylistSections(
  userPlaylists: PlaylistLike[],
  favoriteOptions: FavoritesDisplayOptions,
  pinnedPlaylistIds: readonly number[]
): SidebarPlaylistSections {
  const allPlaylists = buildAllDisplayPlaylists(userPlaylists, favoriteOptions)
  const playlistById = new Map(allPlaylists.map((playlist) => [playlist.id, playlist]))
  const normalizedPinnedIds = normalizeSidebarPinnedPlaylistIds(pinnedPlaylistIds, userPlaylists)
  const pinnedIdSet = new Set(normalizedPinnedIds)

  return {
    sidebarPinnedPlaylists: normalizedPinnedIds
      .map((playlistId) => playlistById.get(playlistId))
      .filter((playlist): playlist is DisplayPlaylist => Boolean(playlist)),
    sidebarOverflowPlaylists: allPlaylists.filter((playlist) => !pinnedIdSet.has(playlist.id))
  }
}

export function normalizePlaylistBrowserSortMode(value: unknown): PlaylistBrowserSortMode {
  return value === 'recently-updated' || value === 'name' || value === 'created'
    ? value
    : 'recently-played'
}

export function sortPlaylistBrowserEntries(
  playlists: readonly DisplayPlaylist[],
  sortMode: PlaylistBrowserSortMode
): DisplayPlaylist[] {
  const favorites = playlists.filter((playlist) => playlist.isSystemFavorites)
  const userPlaylists = playlists.filter((playlist) => !playlist.isSystemFavorites)
  const sorted = [...userPlaylists].sort((a, b) => {
    if (sortMode === 'name') {
      const nameOrder = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      return nameOrder || b.id - a.id
    }
    if (sortMode === 'created') {
      return b.created_at - a.created_at || b.id - a.id
    }
    if (sortMode === 'recently-updated') {
      return b.updated_at - a.updated_at || b.id - a.id
    }

    const aPlayed = a.last_played_at
    const bPlayed = b.last_played_at
    if (aPlayed !== null && bPlayed !== null) {
      return bPlayed - aPlayed || b.updated_at - a.updated_at || b.id - a.id
    }
    if (aPlayed !== null) return -1
    if (bPlayed !== null) return 1
    return b.updated_at - a.updated_at || b.id - a.id
  })
  return [...favorites, ...sorted]
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
