import { create } from 'zustand'

interface Playlist {
  id: number
  name: string
  created_at: number
  updated_at: number
  track_count: number
}

interface DbTrack {
  id: number
  path: string
  title: string
  artist: string
  album: string
  album_artist: string | null
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
  added_at: number
  modified_at: number
}

interface PlaylistStore {
  playlists: Playlist[]
  selectedPlaylistId: number | null
  selectedPlaylistTracks: DbTrack[]

  loadPlaylists: () => Promise<void>
  createPlaylist: (name: string) => Promise<Playlist>
  renamePlaylist: (id: number, name: string) => Promise<void>
  deletePlaylist: (id: number) => Promise<void>
  selectPlaylist: (id: number) => Promise<void>
  clearSelection: () => void
  addToPlaylist: (playlistId: number, trackPaths: string[]) => Promise<void>
  removeFromPlaylist: (playlistId: number, trackPath: string) => Promise<void>
}

export const usePlaylistStore = create<PlaylistStore>((set, get) => ({
  playlists: [],
  selectedPlaylistId: null,
  selectedPlaylistTracks: [],

  loadPlaylists: async () => {
    const playlists = await window.electronAPI.library.getPlaylists()
    set({ playlists })
  },

  createPlaylist: async (name: string) => {
    const playlist = await window.electronAPI.library.createPlaylist(name)
    await get().loadPlaylists()
    return playlist
  },

  renamePlaylist: async (id: number, name: string) => {
    await window.electronAPI.library.renamePlaylist(id, name)
    await get().loadPlaylists()
  },

  deletePlaylist: async (id: number) => {
    await window.electronAPI.library.deletePlaylist(id)
    if (get().selectedPlaylistId === id) {
      set({ selectedPlaylistId: null, selectedPlaylistTracks: [] })
    }
    await get().loadPlaylists()
  },

  selectPlaylist: async (id: number) => {
    const tracks = await window.electronAPI.library.getPlaylistTracks(id)
    set({ selectedPlaylistId: id, selectedPlaylistTracks: tracks })
  },

  clearSelection: () => {
    set({ selectedPlaylistId: null, selectedPlaylistTracks: [] })
  },

  addToPlaylist: async (playlistId: number, trackPaths: string[]) => {
    await window.electronAPI.library.addToPlaylist(playlistId, trackPaths)
    await get().loadPlaylists()
    // Refresh tracks if this playlist is currently selected
    if (get().selectedPlaylistId === playlistId) {
      const tracks = await window.electronAPI.library.getPlaylistTracks(playlistId)
      set({ selectedPlaylistTracks: tracks })
    }
  },

  removeFromPlaylist: async (playlistId: number, trackPath: string) => {
    await window.electronAPI.library.removeFromPlaylist(playlistId, trackPath)
    await get().loadPlaylists()
    // Refresh tracks if this playlist is currently selected
    if (get().selectedPlaylistId === playlistId) {
      const tracks = await window.electronAPI.library.getPlaylistTracks(playlistId)
      set({ selectedPlaylistTracks: tracks })
    }
  }
}))
