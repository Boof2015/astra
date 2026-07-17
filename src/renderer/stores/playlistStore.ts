import { create } from 'zustand'
import { FAVORITES_PLAYLIST_ID, isSystemFavoritesPlaylistId } from '../utils/playlistSystem'
import type { TrackSourceType } from '../../types/subsonic'
import { normalizeTrackSortState, type PlaylistSessionSnapshot, type SessionTrackSortState } from '../utils/sessionState'
import {
  normalizeDynamicPlaylistRules,
  type DynamicPlaylistRulesV1,
  type PlaylistKind
} from '../../shared/playlists/dynamicPlaylist'

export interface Playlist {
  id: number
  name: string
  kind: PlaylistKind
  created_at: number
  updated_at: number
  last_played_at: number | null
  custom_cover_hash: string | null
  auto_cover_hash: string | null
  track_count: number
  missing_track_count: number
}

export type PlaylistImportDetectedFormat = 'csv' | 'm3u' | 'm3u8' | 'xspf' | 'wpl' | 'asx'

export interface PlaylistImportResult {
  sourceFilePath: string
  detectedFormat: PlaylistImportDetectedFormat
  playlistId: number | null
  playlistName: string | null
  entriesTotal: number
  importedCount: number
  missingEntryCount: number
  matchedByPathCount: number
  matchedByMetadataCount: number
  unmatchedCount: number
  ambiguousMetadataCount: number
  unsupportedEntryCount: number
  warnings: string[]
}

export interface PlaylistExportResult {
  filePath: string
  format: 'm3u' | 'm3u8'
  playlistId: number
  exportedCount: number
  warnings: string[]
}

export interface DynamicPlaylistPreview {
  track_count: number
  tracks: DbTrack[]
}

export interface CreatePlaylistOptions {
  name: string
  coverImagePath?: string | null
  trackPaths?: string[]
}

export interface CreateDynamicPlaylistOptions {
  name: string
  rules: DynamicPlaylistRulesV1
  coverImagePath?: string | null
}

export interface PlaylistTrackMembershipSummary {
  playlistId: number
  matchedTrackCount: number
}

export type PlaylistTrackListSortState = SessionTrackSortState

interface DbTrack {
  id: number
  path: string
  album_identity_key: string
  is_new: boolean
  title: string
  artist: string
  artist_names: string[]
  album: string
  album_artist: string | null
  album_artist_names: string[]
  duration: number
  track_number: number | null
  disc_number: number | null
  year: number | null
  genre: string | null
  genres: string[]
  artwork_hash: string | null
  format: string
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  bpm: number | null
  musical_key: string | null
  source_type: TrackSourceType
  source_id: number | null
  source_track_id: string | null
  source_path: string | null
  is_available: number
  availability_reason: string | null
  file_created_at: number | null
  play_count: number
  last_played_at: number | null
  replaygain_track_gain_db: number | null
  replaygain_album_gain_db: number | null
  added_at: number
  modified_at: number
}

export interface PlaylistTrackEntry {
  id: number
  track_path: string
  position: number
  added_at: number
  missing: boolean
  title: string | null
  artist: string | null
  album: string | null
  track: DbTrack | null
}

interface PlaylistStore {
  playlists: Playlist[]
  selectedPlaylistId: number | null
  selectedPlaylistEntries: PlaylistTrackEntry[]
  selectedPlaylistTracks: DbTrack[]
  sortState: PlaylistTrackListSortState | null

  loadPlaylists: () => Promise<void>
  createPlaylist: (name: string) => Promise<Playlist>
  createPlaylistWithOptions: (options: CreatePlaylistOptions) => Promise<Playlist>
  createDynamicPlaylist: (name: string, rules: DynamicPlaylistRulesV1) => Promise<Playlist>
  createDynamicPlaylistWithOptions: (options: CreateDynamicPlaylistOptions) => Promise<Playlist>
  getDynamicPlaylistRules: (playlistId: number) => Promise<DynamicPlaylistRulesV1>
  updateDynamicPlaylistRules: (playlistId: number, rules: DynamicPlaylistRulesV1) => Promise<void>
  previewDynamicPlaylist: (rules: DynamicPlaylistRulesV1) => Promise<DynamicPlaylistPreview>
  renamePlaylist: (id: number, name: string) => Promise<void>
  deletePlaylist: (id: number) => Promise<void>
  selectPlaylist: (id: number) => Promise<void>
  refreshSelectedPlaylist: () => Promise<void>
  clearSelection: () => void
  addToPlaylist: (playlistId: number, trackPaths: string[]) => Promise<void>
  removeFromPlaylist: (playlistId: number, trackPath: string) => Promise<void>
  removePlaylistEntry: (playlistId: number, entryId: number) => Promise<void>
  reassociatePlaylistEntry: (playlistId: number, entryId: number, targetTrackPath: string) => Promise<void>
  reorderPlaylistEntries: (playlistId: number, orderedEntryIds: number[]) => Promise<void>
  setPlaylistCustomCoverFromFile: (playlistId: number, imagePath: string) => Promise<void>
  clearPlaylistCustomCover: (playlistId: number) => Promise<void>
  getPlaylistsContainingTrack: (trackPath: string) => Promise<number[]>
  getPlaylistsContainingTracks: (trackPaths: string[]) => Promise<PlaylistTrackMembershipSummary[]>
  getPlaylistTrackPaths: (playlistId: number) => Promise<string[]>
  importPlaylistFromFile: () => Promise<PlaylistImportResult | null>
  exportPlaylistToM3u: (playlistId: number, playlistName: string) => Promise<PlaylistExportResult | null>
  setSortState: (sortState: PlaylistTrackListSortState | null) => void
  getSessionSnapshot: () => PlaylistSessionSnapshot
  restoreSession: (snapshot: PlaylistSessionSnapshot) => Promise<void>
}

function getPlayableTracksFromEntries(entries: PlaylistTrackEntry[]): DbTrack[] {
  return entries
    .map((entry) => entry.track)
    .filter((track): track is DbTrack => track !== null)
}

function sanitizePlaylistExportFileName(playlistName: string): string {
  const sanitized = playlistName
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '_')
    .replace(/\.+$/g, '')
    .slice(0, 80)
    .trim()
  return sanitized || 'Playlist'
}

function ensurePlaylistExportExtension(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath
  if (/\.[^.]+$/.test(fileName)) return filePath
  return `${filePath}.m3u8`
}

export function getNormalPlaylists(playlists: Playlist[]): Playlist[] {
  return playlists.filter((playlist) => playlist.kind !== 'dynamic')
}

export const usePlaylistStore = create<PlaylistStore>((set, get) => {
  const loadPlaylistSelection = async (playlistId: number): Promise<Pick<PlaylistStore, 'selectedPlaylistEntries' | 'selectedPlaylistTracks'>> => {
    if (playlistId === FAVORITES_PLAYLIST_ID) {
      const tracks = await window.electronAPI.library.getFavorites()
      return { selectedPlaylistEntries: [], selectedPlaylistTracks: tracks }
    }

    const entries = await window.electronAPI.library.getPlaylistTrackEntries(playlistId)
    return {
      selectedPlaylistEntries: entries,
      selectedPlaylistTracks: getPlayableTracksFromEntries(entries)
    }
  }

  const refreshSelectedPlaylist = async (playlistId: number) => {
    if (get().selectedPlaylistId !== playlistId) return
    set(await loadPlaylistSelection(playlistId))
  }

  return {
    playlists: [],
    selectedPlaylistId: null,
    selectedPlaylistEntries: [],
    selectedPlaylistTracks: [],
    sortState: null,

    loadPlaylists: async () => {
      const playlists = (await window.electronAPI.library.getPlaylists()).map((playlist) => ({
        ...playlist,
        kind: playlist.kind === 'dynamic' ? 'dynamic' as const : 'normal' as const
      }))
      set({ playlists })
    },

    createPlaylist: async (name: string) => {
      return get().createPlaylistWithOptions({ name })
    },

    createPlaylistWithOptions: async ({ name, coverImagePath = null, trackPaths = [] }) => {
      const trimmedName = name.trim()
      if (!trimmedName) {
        throw new Error('Playlist name is required.')
      }

      const playlist = await window.electronAPI.library.createPlaylist(trimmedName)

      try {
        if (coverImagePath && playlist.id > 0) {
          await window.electronAPI.library.setPlaylistCustomCoverFromFile(playlist.id, coverImagePath)
        }
        if (trackPaths.length > 0 && playlist.id > 0) {
          await window.electronAPI.library.addToPlaylist(playlist.id, trackPaths)
        }
      } catch (error) {
        if (playlist.id > 0) {
          try {
            await window.electronAPI.library.deletePlaylist(playlist.id)
          } catch {
            // Ignore rollback failures and surface the original error.
          }
        }
        await get().loadPlaylists()
        throw error
      }

      await get().loadPlaylists()
      return playlist
    },

    createDynamicPlaylist: async (name: string, rules: DynamicPlaylistRulesV1) => {
      return get().createDynamicPlaylistWithOptions({ name, rules })
    },

    createDynamicPlaylistWithOptions: async ({ name, rules, coverImagePath = null }) => {
      const trimmedName = name.trim()
      if (!trimmedName) {
        throw new Error('Playlist name is required.')
      }

      const normalizedRules = normalizeDynamicPlaylistRules(rules)
      const playlist = await window.electronAPI.library.createDynamicPlaylist(trimmedName, normalizedRules)

      try {
        if (coverImagePath && playlist.id > 0) {
          await window.electronAPI.library.setPlaylistCustomCoverFromFile(playlist.id, coverImagePath)
        }
      } catch (error) {
        if (playlist.id > 0) {
          try {
            await window.electronAPI.library.deletePlaylist(playlist.id)
          } catch {
            // Ignore rollback failures and surface the original error.
          }
        }
        await get().loadPlaylists()
        throw error
      }

      await get().loadPlaylists()
      return playlist
    },

    getDynamicPlaylistRules: async (playlistId: number) => {
      if (!Number.isInteger(playlistId) || playlistId <= 0) {
        throw new Error('Playlist id is required.')
      }
      return window.electronAPI.library.getDynamicPlaylistRules(playlistId)
    },

    updateDynamicPlaylistRules: async (playlistId: number, rules: DynamicPlaylistRulesV1) => {
      if (!Number.isInteger(playlistId) || playlistId <= 0) {
        throw new Error('Playlist id is required.')
      }
      await window.electronAPI.library.updateDynamicPlaylistRules(playlistId, normalizeDynamicPlaylistRules(rules))
      await get().loadPlaylists()
      await refreshSelectedPlaylist(playlistId)
    },

    previewDynamicPlaylist: async (rules: DynamicPlaylistRulesV1) => {
      return window.electronAPI.library.previewDynamicPlaylist(normalizeDynamicPlaylistRules(rules))
    },

    renamePlaylist: async (id: number, name: string) => {
      if (isSystemFavoritesPlaylistId(id)) return
      await window.electronAPI.library.renamePlaylist(id, name)
      await get().loadPlaylists()
    },

    deletePlaylist: async (id: number) => {
      if (isSystemFavoritesPlaylistId(id)) return
      await window.electronAPI.library.deletePlaylist(id)
      if (get().selectedPlaylistId === id) {
        set({ selectedPlaylistId: null, selectedPlaylistEntries: [], selectedPlaylistTracks: [] })
      }
      await get().loadPlaylists()
    },

    selectPlaylist: async (id: number) => {
      set({ selectedPlaylistId: id, ...(await loadPlaylistSelection(id)) })
    },

    refreshSelectedPlaylist: async () => {
      const playlistId = get().selectedPlaylistId
      if (playlistId === null) return
      await refreshSelectedPlaylist(playlistId)
    },

    clearSelection: () => {
      set({ selectedPlaylistId: null, selectedPlaylistEntries: [], selectedPlaylistTracks: [] })
    },

    addToPlaylist: async (playlistId: number, trackPaths: string[]) => {
      await window.electronAPI.library.addToPlaylist(playlistId, trackPaths)
      await get().loadPlaylists()
      await refreshSelectedPlaylist(playlistId)
    },

    removeFromPlaylist: async (playlistId: number, trackPath: string) => {
      await window.electronAPI.library.removeFromPlaylist(playlistId, trackPath)
      await get().loadPlaylists()
      await refreshSelectedPlaylist(playlistId)
    },

    removePlaylistEntry: async (playlistId: number, entryId: number) => {
      await window.electronAPI.library.removePlaylistEntry(playlistId, entryId)
      await get().loadPlaylists()
      await refreshSelectedPlaylist(playlistId)
    },

    reassociatePlaylistEntry: async (playlistId: number, entryId: number, targetTrackPath: string) => {
      await window.electronAPI.library.reassociatePlaylistEntry(playlistId, entryId, targetTrackPath)
      await get().loadPlaylists()
      await refreshSelectedPlaylist(playlistId)
    },

    reorderPlaylistEntries: async (playlistId: number, orderedEntryIds: number[]) => {
      if (isSystemFavoritesPlaylistId(playlistId)) return
      if (playlistId <= 0) return
      if (!Array.isArray(orderedEntryIds) || orderedEntryIds.length === 0) return

      await window.electronAPI.library.reorderPlaylistEntries(playlistId, orderedEntryIds)
      await get().loadPlaylists()
      await refreshSelectedPlaylist(playlistId)
    },

    setPlaylistCustomCoverFromFile: async (playlistId: number, imagePath: string) => {
      if (isSystemFavoritesPlaylistId(playlistId)) return
      await window.electronAPI.library.setPlaylistCustomCoverFromFile(playlistId, imagePath)
      await get().loadPlaylists()
    },

    clearPlaylistCustomCover: async (playlistId: number) => {
      if (isSystemFavoritesPlaylistId(playlistId)) return
      await window.electronAPI.library.clearPlaylistCustomCover(playlistId)
      await get().loadPlaylists()
    },

    getPlaylistsContainingTrack: async (trackPath: string) => {
      if (!trackPath) return []
      return window.electronAPI.library.getPlaylistsContainingTrack(trackPath)
    },

    getPlaylistsContainingTracks: async (trackPaths: string[]) => {
      if (!Array.isArray(trackPaths) || trackPaths.length === 0) return []
      return window.electronAPI.library.getPlaylistsContainingTracks(trackPaths)
    },

    getPlaylistTrackPaths: async (playlistId: number) => {
      if (!Number.isInteger(playlistId) || playlistId <= 0) return []
      const entries = await window.electronAPI.library.getPlaylistTrackEntries(playlistId)
      return entries.map((entry) => entry.track_path)
    },

    importPlaylistFromFile: async () => {
      const filePath = await window.electronAPI.openFileDialog({
        title: 'Import Playlist',
        filters: [
          { name: 'Playlist Files', extensions: ['csv', 'm3u', 'm3u8', 'xspf', 'xml', 'wpl', 'asx'] },
          { name: 'CSV Files', extensions: ['csv'] },
          { name: 'M3U Playlists', extensions: ['m3u', 'm3u8'] },
          { name: 'XSPF Playlists', extensions: ['xspf'] },
          { name: 'XML Playlists', extensions: ['xml', 'wpl', 'asx'] }
        ]
      })
      if (!filePath) return null

      const result = await window.electronAPI.library.importPlaylistFromFile(filePath)
      await get().loadPlaylists()
      return result
    },

    exportPlaylistToM3u: async (playlistId: number, playlistName: string) => {
      if (!Number.isInteger(playlistId)) return null

      const filePath = await window.electronAPI.showSaveDialog({
        title: 'Export Playlist',
        defaultPath: `${sanitizePlaylistExportFileName(playlistName)}.m3u8`,
        filters: [
          { name: 'M3U8 Playlists', extensions: ['m3u8'] },
          { name: 'M3U Playlists', extensions: ['m3u'] }
        ]
      })
      if (!filePath) return null

      return window.electronAPI.library.exportPlaylistToM3u(playlistId, ensurePlaylistExportExtension(filePath))
    },

    setSortState: (sortState) => {
      set({ sortState: sortState ? normalizeTrackSortState(sortState) : null })
    },

    getSessionSnapshot: () => {
      const state = get()
      return {
        selectedPlaylistId: state.selectedPlaylistId,
        sortState: state.sortState ? { ...state.sortState } : null
      }
    },

    restoreSession: async (snapshot) => {
      const sortState = normalizeTrackSortState(snapshot.sortState)
      const selectedPlaylistId = snapshot.selectedPlaylistId
      if (selectedPlaylistId === null) {
        set({
          selectedPlaylistId: null,
          selectedPlaylistEntries: [],
          selectedPlaylistTracks: [],
          sortState
        })
        return
      }

      if (isSystemFavoritesPlaylistId(selectedPlaylistId)) {
        set({ sortState })
        await get().selectPlaylist(selectedPlaylistId)
        set({ sortState })
        return
      }

      const playlistExists = get().playlists.some((playlist) => playlist.id === selectedPlaylistId)
      if (!playlistExists) {
        set({
          selectedPlaylistId: null,
          selectedPlaylistEntries: [],
          selectedPlaylistTracks: [],
          sortState
        })
        return
      }

      set({ sortState })
      await get().selectPlaylist(selectedPlaylistId)
      set({ sortState })
    }
  }
})
