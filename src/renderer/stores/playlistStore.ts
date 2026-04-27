import { create } from 'zustand'
import { FAVORITES_PLAYLIST_ID, isSystemFavoritesPlaylistId } from '../utils/playlistSystem'
import type { TrackSourceType } from '../../types/subsonic'

export interface Playlist {
  id: number
  name: string
  created_at: number
  updated_at: number
  last_played_at: number | null
  custom_cover_hash: string | null
  auto_cover_hash: string | null
  track_count: number
}

export type PlaylistImportDetectedFormat = 'csv' | 'm3u' | 'm3u8' | 'xspf' | 'wpl' | 'asx'

export interface PlaylistImportResult {
  sourceFilePath: string
  detectedFormat: PlaylistImportDetectedFormat
  playlistId: number | null
  playlistName: string | null
  entriesTotal: number
  importedCount: number
  matchedByPathCount: number
  matchedByMetadataCount: number
  unmatchedCount: number
  ambiguousMetadataCount: number
  unsupportedEntryCount: number
  warnings: string[]
}

export interface CreatePlaylistOptions {
  name: string
  coverImagePath?: string | null
  trackPaths?: string[]
}

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
  replaygain_track_gain_db: number | null
  replaygain_album_gain_db: number | null
  added_at: number
  modified_at: number
}

interface PlaylistStore {
  playlists: Playlist[]
  selectedPlaylistId: number | null
  selectedPlaylistTracks: DbTrack[]

  loadPlaylists: () => Promise<void>
  createPlaylist: (name: string) => Promise<Playlist>
  createPlaylistWithOptions: (options: CreatePlaylistOptions) => Promise<Playlist>
  renamePlaylist: (id: number, name: string) => Promise<void>
  deletePlaylist: (id: number) => Promise<void>
  selectPlaylist: (id: number) => Promise<void>
  clearSelection: () => void
  addToPlaylist: (playlistId: number, trackPaths: string[]) => Promise<void>
  removeFromPlaylist: (playlistId: number, trackPath: string) => Promise<void>
  reorderPlaylistTracks: (playlistId: number, orderedTrackPaths: string[]) => Promise<void>
  setPlaylistCustomCoverFromFile: (playlistId: number, imagePath: string) => Promise<void>
  clearPlaylistCustomCover: (playlistId: number) => Promise<void>
  getPlaylistsContainingTrack: (trackPath: string) => Promise<number[]>
  getPlaylistTrackPaths: (playlistId: number) => Promise<string[]>
  importPlaylistFromFile: () => Promise<PlaylistImportResult | null>
}

export const usePlaylistStore = create<PlaylistStore>((set, get) => {
  const refreshSelectedPlaylistTracks = async (playlistId: number) => {
    if (get().selectedPlaylistId !== playlistId) return
    const tracks = await window.electronAPI.library.getPlaylistTracks(playlistId)
    set({ selectedPlaylistTracks: tracks })
  }

  return {
    playlists: [],
    selectedPlaylistId: null,
    selectedPlaylistTracks: [],

    loadPlaylists: async () => {
      const playlists = await window.electronAPI.library.getPlaylists()
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

    renamePlaylist: async (id: number, name: string) => {
      if (isSystemFavoritesPlaylistId(id)) return
      await window.electronAPI.library.renamePlaylist(id, name)
      await get().loadPlaylists()
    },

    deletePlaylist: async (id: number) => {
      if (isSystemFavoritesPlaylistId(id)) return
      await window.electronAPI.library.deletePlaylist(id)
      if (get().selectedPlaylistId === id) {
        set({ selectedPlaylistId: null, selectedPlaylistTracks: [] })
      }
      await get().loadPlaylists()
    },

    selectPlaylist: async (id: number) => {
      const tracks = id === FAVORITES_PLAYLIST_ID
        ? await window.electronAPI.library.getFavorites()
        : await window.electronAPI.library.getPlaylistTracks(id)
      set({ selectedPlaylistId: id, selectedPlaylistTracks: tracks })
    },

    clearSelection: () => {
      set({ selectedPlaylistId: null, selectedPlaylistTracks: [] })
    },

    addToPlaylist: async (playlistId: number, trackPaths: string[]) => {
      await window.electronAPI.library.addToPlaylist(playlistId, trackPaths)
      await get().loadPlaylists()
      await refreshSelectedPlaylistTracks(playlistId)
    },

    removeFromPlaylist: async (playlistId: number, trackPath: string) => {
      await window.electronAPI.library.removeFromPlaylist(playlistId, trackPath)
      await get().loadPlaylists()
      await refreshSelectedPlaylistTracks(playlistId)
    },

    reorderPlaylistTracks: async (playlistId: number, orderedTrackPaths: string[]) => {
      if (isSystemFavoritesPlaylistId(playlistId)) return
      if (playlistId <= 0) return
      if (!Array.isArray(orderedTrackPaths) || orderedTrackPaths.length === 0) return

      await window.electronAPI.library.reorderPlaylistTracks(playlistId, orderedTrackPaths)
      await get().loadPlaylists()
      await refreshSelectedPlaylistTracks(playlistId)
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

    getPlaylistTrackPaths: async (playlistId: number) => {
      if (!Number.isInteger(playlistId) || playlistId <= 0) return []
      const tracks = await window.electronAPI.library.getPlaylistTracks(playlistId)
      return tracks.map((track) => track.path)
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
    }
  }
})
