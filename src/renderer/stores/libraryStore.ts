import { create } from 'zustand'

// Types matching preload
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

interface Album {
  album: string
  artist: string
  year: number | null
  artwork_hash: string | null
  track_count: number
}

interface Artist {
  artist: string
  track_count: number
}

interface LibraryFolder {
  id: number
  path: string
  added_at: number
}

type ViewMode = 'tracks' | 'albums' | 'artists'

interface LibraryStore {
  // State
  tracks: DbTrack[]
  albums: Album[]
  artists: Artist[]
  folders: LibraryFolder[]
  viewMode: ViewMode
  selectedAlbum: { album: string; artist: string } | null
  selectedArtist: string | null
  searchQuery: string
  searchResults: DbTrack[]
  isLoading: boolean
  isScanning: boolean
  scanProgress: { current: number; total: number; file: string } | null
  artworkCache: Map<string, string>

  // Actions
  loadLibrary: () => Promise<void>
  loadTracks: () => Promise<void>
  loadAlbums: () => Promise<void>
  loadArtists: () => Promise<void>
  loadFolders: () => Promise<void>
  addFolder: () => Promise<void>
  removeFolder: (path: string) => Promise<void>
  rescan: () => Promise<void>
  setViewMode: (mode: ViewMode) => void
  selectAlbum: (album: string, artist: string) => Promise<void>
  selectArtist: (artist: string) => Promise<void>
  clearSelection: () => void
  search: (query: string) => Promise<void>
  clearSearch: () => void
  getArtwork: (hash: string | null) => Promise<string | null>
}

// Artwork cache stored outside of zustand to avoid re-renders
const artworkCache = new Map<string, string>()

export const useLibraryStore = create<LibraryStore>((set, get) => ({
  // Initial state
  tracks: [],
  albums: [],
  artists: [],
  folders: [],
  viewMode: 'tracks',
  selectedAlbum: null,
  selectedArtist: null,
  searchQuery: '',
  searchResults: [],
  isLoading: false,
  isScanning: false,
  scanProgress: null,
  artworkCache,

  // Load entire library
  loadLibrary: async () => {
    set({ isLoading: true })
    await Promise.all([
      get().loadTracks(),
      get().loadAlbums(),
      get().loadArtists(),
      get().loadFolders()
    ])
    set({ isLoading: false })
  },

  // Load tracks
  loadTracks: async () => {
    const tracks = await window.electronAPI.library.getTracks()
    set({ tracks })
  },

  // Load albums
  loadAlbums: async () => {
    const albums = await window.electronAPI.library.getAlbums()
    set({ albums })
  },

  // Load artists
  loadArtists: async () => {
    const artists = await window.electronAPI.library.getArtists()
    set({ artists })
  },

  // Load folders
  loadFolders: async () => {
    const folders = await window.electronAPI.library.getFolders()
    set({ folders })
  },

  // Add folder
  addFolder: async () => {
    const folderPath = await window.electronAPI.openAudioFolder()
    if (!folderPath) return

    set({ isScanning: true, scanProgress: { current: 0, total: 0, file: '' } })

    // Subscribe to scan progress
    const unsubscribe = window.electronAPI.library.onScanProgress((progress) => {
      set({ scanProgress: progress })
    })

    try {
      const result = await window.electronAPI.library.addFolder(folderPath)
      if (result.success) {
        // Reload library after scan
        await get().loadLibrary()
      }
    } finally {
      unsubscribe()
      set({ isScanning: false, scanProgress: null })
    }
  },

  // Remove folder
  removeFolder: async (path: string) => {
    await window.electronAPI.library.removeFolder(path)
    await get().loadLibrary()
  },

  // Rescan all folders
  rescan: async () => {
    set({ isScanning: true, scanProgress: { current: 0, total: 0, file: '' } })

    const unsubscribe = window.electronAPI.library.onScanProgress((progress) => {
      set({ scanProgress: progress })
    })

    try {
      await window.electronAPI.library.rescan()
      await get().loadLibrary()
    } finally {
      unsubscribe()
      set({ isScanning: false, scanProgress: null })
    }
  },

  // Set view mode
  setViewMode: (mode: ViewMode) => {
    set({ viewMode: mode, selectedAlbum: null, selectedArtist: null })
  },

  // Select album
  selectAlbum: async (album: string, artist: string) => {
    const tracks = await window.electronAPI.library.getTracksByAlbum(album, artist)
    set({ selectedAlbum: { album, artist }, tracks, selectedArtist: null })
  },

  // Select artist
  selectArtist: async (artist: string) => {
    const tracks = await window.electronAPI.library.getTracksByArtist(artist)
    set({ selectedArtist: artist, tracks, selectedAlbum: null })
  },

  // Clear selection
  clearSelection: async () => {
    set({ selectedAlbum: null, selectedArtist: null })
    await get().loadTracks()
  },

  // Search
  search: async (query: string) => {
    set({ searchQuery: query })
    if (query.trim()) {
      const searchResults = await window.electronAPI.library.search(query)
      set({ searchResults })
    } else {
      set({ searchResults: [] })
    }
  },

  // Clear search
  clearSearch: () => {
    set({ searchQuery: '', searchResults: [] })
  },

  // Get artwork data URL (with caching)
  getArtwork: async (hash: string | null) => {
    if (!hash) return null

    // Check cache first
    if (artworkCache.has(hash)) {
      return artworkCache.get(hash)!
    }

    // Load from disk
    const dataUrl = await window.electronAPI.library.getArtworkDataUrl(hash)
    if (dataUrl) {
      artworkCache.set(hash, dataUrl)
    }
    return dataUrl
  }
}))
