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
  channels: number | null
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
  artwork_hash: string | null
}

interface LibraryFolder {
  id: number
  path: string
  added_at: number
}

type ViewMode = 'tracks' | 'albums' | 'artists'
type SelectionOrigin = 'home' | 'library' | null

interface LibraryStore {
  // State
  tracks: DbTrack[]
  albums: Album[]
  artists: Artist[]
  folders: LibraryFolder[]
  viewMode: ViewMode
  selectedAlbum: { album: string; artist: string } | null
  selectedArtist: string | null
  selectionOrigin: SelectionOrigin
  searchQuery: string
  searchResults: DbTrack[]
  isLoading: boolean
  isScanning: boolean
  scanProgress: { current: number; total: number; file: string } | null
  folderWarnings: Record<string, string[]>
  artworkCache: Map<string, string>
  favorites: Set<string>
  favoriteTracks: DbTrack[]
  recentlyPlayed: DbTrack[]

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
  selectAlbum: (album: string, artist: string, origin?: Exclude<SelectionOrigin, null>) => Promise<void>
  selectArtist: (artist: string, origin?: Exclude<SelectionOrigin, null>) => Promise<void>
  clearSelection: () => void
  search: (query: string) => Promise<void>
  clearSearch: () => void
  getArtwork: (hash: string | null) => Promise<string | null>
  loadFavorites: () => Promise<void>
  toggleFavorite: (trackPath: string) => Promise<void>
  isFavorite: (trackPath: string) => boolean
  loadRecentlyPlayed: () => Promise<void>
  recordPlay: (trackPath: string) => Promise<void>
}

// Artwork cache stored outside of zustand to avoid re-renders
const artworkCache = new Map<string, string>()
const artworkRequestCache = new Map<string, Promise<string | null>>()

export const useLibraryStore = create<LibraryStore>((set, get) => ({
  // Initial state
  tracks: [],
  albums: [],
  artists: [],
  folders: [],
  viewMode: 'tracks',
  selectedAlbum: null,
  selectedArtist: null,
  selectionOrigin: null,
  searchQuery: '',
  searchResults: [],
  isLoading: false,
  isScanning: false,
  scanProgress: null,
  folderWarnings: {},
  artworkCache,
  favorites: new Set<string>(),
  favoriteTracks: [],
  recentlyPlayed: [],

  // Load entire library
  loadLibrary: async () => {
    set({ isLoading: true })
    await Promise.all([
      get().loadTracks(),
      get().loadAlbums(),
      get().loadArtists(),
      get().loadFolders(),
      get().loadFavorites(),
      get().loadRecentlyPlayed()
    ])
    set({ isLoading: false })
  },

  // Load tracks
  loadTracks: async () => {
    const tracks = await window.electronAPI.library.getTracks()
    set((state) => {
      // Avoid clobbering active artist/album selections with full library tracks.
      if (state.selectedAlbum || state.selectedArtist) return {}
      return { tracks }
    })
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
        if (result.skippedDirs && result.skippedDirs.length > 0) {
          set({ folderWarnings: { ...get().folderWarnings, [folderPath]: result.skippedDirs } })
        }
        // Reload library after scan
        await get().loadLibrary()
      }
    } finally {
      unsubscribe()
      set({ isScanning: false, scanProgress: null })
    }
  },

  // Remove folder and rescan remaining
  removeFolder: async (path: string) => {
    await window.electronAPI.library.removeFolder(path)
    const { [path]: _, ...remaining } = get().folderWarnings
    set({ folderWarnings: remaining })
    await get().rescan()
  },

  // Rescan all folders
  rescan: async () => {
    set({ isScanning: true, scanProgress: { current: 0, total: 0, file: '' } })

    const unsubscribe = window.electronAPI.library.onScanProgress((progress) => {
      set({ scanProgress: progress })
    })

    try {
      const result = await window.electronAPI.library.rescan()
      if (result.folderWarnings) {
        set({ folderWarnings: result.folderWarnings })
      } else {
        set({ folderWarnings: {} })
      }
      await get().loadLibrary()
    } finally {
      unsubscribe()
      set({ isScanning: false, scanProgress: null })
    }
  },

  // Set view mode
  setViewMode: (mode: ViewMode) => {
    set({ viewMode: mode, selectedAlbum: null, selectedArtist: null, selectionOrigin: null })
  },

  // Select album
  selectAlbum: async (album: string, artist: string, origin: Exclude<SelectionOrigin, null> = 'library') => {
    const tracks = await window.electronAPI.library.getTracksByAlbum(album, artist)
    set({ selectedAlbum: { album, artist }, tracks, selectedArtist: null, selectionOrigin: origin })
  },

  // Select artist
  selectArtist: async (artist: string, origin: Exclude<SelectionOrigin, null> = 'library') => {
    const tracks = await window.electronAPI.library.getTracksByArtist(artist)
    set({ selectedArtist: artist, tracks, selectedAlbum: null, selectionOrigin: origin })
  },

  // Clear selection
  clearSelection: async () => {
    set({ selectedAlbum: null, selectedArtist: null, selectionOrigin: null })
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

    // Deduplicate concurrent requests for the same artwork hash.
    if (artworkRequestCache.has(hash)) {
      return artworkRequestCache.get(hash)!
    }

    const request = window.electronAPI.library.getArtworkDataUrl(hash)
      .then((dataUrl) => {
        if (dataUrl) {
          artworkCache.set(hash, dataUrl)
        }
        return dataUrl
      })
      .catch(() => null)
      .finally(() => {
        artworkRequestCache.delete(hash)
      })

    artworkRequestCache.set(hash, request)
    return request
  },

  // Load favorite track paths and full track list
  loadFavorites: async () => {
    const [paths, favoriteTracks] = await Promise.all([
      window.electronAPI.library.getFavoritePaths(),
      window.electronAPI.library.getFavorites()
    ])
    set({ favorites: new Set(paths), favoriteTracks })
  },

  // Toggle favorite status
  toggleFavorite: async (trackPath: string) => {
    const { favorites } = get()
    if (favorites.has(trackPath)) {
      await window.electronAPI.library.removeFavorite(trackPath)
      const next = new Set(favorites)
      next.delete(trackPath)
      set({ favorites: next })
    } else {
      await window.electronAPI.library.addFavorite(trackPath)
      const next = new Set(favorites)
      next.add(trackPath)
      set({ favorites: next })
    }
    // Reload full favorite tracks list
    const favoriteTracks = await window.electronAPI.library.getFavorites()
    set({ favoriteTracks })
  },

  // Sync check if track is a favorite
  isFavorite: (trackPath: string) => {
    return get().favorites.has(trackPath)
  },

  // Load recently played tracks
  loadRecentlyPlayed: async () => {
    const recentlyPlayed = await window.electronAPI.library.getRecentlyPlayed(50)
    set({ recentlyPlayed })
  },

  // Record a track play
  recordPlay: async (trackPath: string) => {
    await window.electronAPI.library.addRecentlyPlayed(trackPath)
    // Reload recently played list
    const recentlyPlayed = await window.electronAPI.library.getRecentlyPlayed(50)
    set({ recentlyPlayed })
  }
}))
