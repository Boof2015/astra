import { create } from 'zustand'
import type { TrackSourceType } from '../../types/subsonic'

// Types matching preload
export interface DbTrack {
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
  base_artwork_hash: string | null
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

interface Album {
  identity_key: string
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

export interface LibraryFolder {
  id: number
  path: string
  added_at: number
}

interface LibrarySelectionSnapshot {
  selectedAlbum: { identity_key?: string; album: string; artist: string } | null
  selectedArtist: string | null
  selectionOrigin: SelectionOrigin
  tracks: DbTrack[]
}

export interface FolderSubfolderSummary {
  totalSubfolders: number
  excludedSubfolders: number
}

export interface FolderSubdirectoryEntry {
  name: string
  relativePath: string
  excluded: boolean
  hasChildren: boolean
  missing: boolean
  audioFileCount: number
}

type ViewMode = 'tracks' | 'albums' | 'artists' | 'folders'
type SelectionOrigin = 'home' | 'library' | null
export type LibraryArtistBrowseMode = 'strict' | 'canonical'
export type ArtworkVariant = 'full' | 'thumbnail' | 'card'

export interface ArtworkRequestOptions {
  variant?: ArtworkVariant
}

type ScanStage = 'scanning' | 'backfill' | 'cleanup'

interface ScanStageProgress {
  stage: ScanStage
  message: string
}

export type ScanIssuePhase = 'discovery' | 'scan' | 'backfill' | 'cleanup'

export interface ScanIssueEntry {
  phase: ScanIssuePhase
  path: string
  message: string
  code?: string
  folderPath?: string
}

export interface ScanIssueLog {
  total: number
  shown: number
  truncated: boolean
  entries: ScanIssueEntry[]
}

interface LibraryStore {
  // State
  tracks: DbTrack[]
  totalTrackCount: number
  albums: Album[]
  artists: Artist[]
  folders: LibraryFolder[]
  viewMode: ViewMode
  selectedAlbum: { identity_key?: string; album: string; artist: string } | null
  selectedArtist: string | null
  selectionOrigin: SelectionOrigin
  selectionHistory: LibrarySelectionSnapshot[]
  searchQuery: string
  searchResults: DbTrack[]
  isLoading: boolean
  isScanning: boolean
  isCancelingScan: boolean
  scanProgress: { current: number; total: number; file: string } | null
  scanStage: ScanStageProgress | null
  folderWarnings: Record<string, string[]>
  lastScanIssueLog: ScanIssueLog | null
  folderSubfolderSummaries: Record<string, FolderSubfolderSummary>
  artworkCache: Map<string, string>
  favorites: Set<string>
  favoriteTracks: DbTrack[]
  recentlyPlayed: DbTrack[]
  showTracklistBpmKey: boolean
  showTracklistAddedDate: boolean

  // Actions
  loadLibrary: () => Promise<void>
  loadTracks: () => Promise<void>
  loadTrackCount: () => Promise<void>
  loadAlbums: () => Promise<void>
  loadArtists: () => Promise<void>
  loadFolders: () => Promise<void>
  loadFolderSubfolderSummary: (folderPath: string) => Promise<FolderSubfolderSummary>
  listFolderSubdirectories: (folderPath: string, parentRelativePath?: string) => Promise<FolderSubdirectoryEntry[]>
  setFolderSubfolderExcluded: (
    folderPath: string,
    relativePath: string,
    excluded: boolean
  ) => Promise<FolderSubfolderSummary | null>
  rescanFolder: (folderPath: string) => Promise<FolderSubfolderSummary | null>
  scanFolders: (folderPaths: string[]) => Promise<{ scannedFolders: number; canceled: boolean }>
  cancelScan: () => Promise<boolean>
  addFolder: () => Promise<void>
  addFolderWithoutScan: () => Promise<string | null>
  removeFolder: (path: string) => Promise<void>
  rescan: () => Promise<void>
  backfillReplayGainMetadata: () => Promise<void>
  setViewMode: (mode: ViewMode) => void
  selectAlbum: (
    album: string,
    artist?: string,
    origin?: Exclude<SelectionOrigin, null>,
    identityKey?: string
  ) => Promise<void>
  selectArtist: (
    artist: string,
    origin?: Exclude<SelectionOrigin, null>,
    mode?: LibraryArtistBrowseMode
  ) => Promise<void>
  clearSelection: () => void
  goBackSelection: () => Promise<boolean>
  search: (query: string) => Promise<void>
  clearSearch: () => void
  getArtwork: (hash: string | null, options?: ArtworkRequestOptions) => Promise<string | null>
  loadFavorites: () => Promise<void>
  toggleFavorite: (trackPath: string) => Promise<void>
  isFavorite: (trackPath: string) => boolean
  loadRecentlyPlayed: () => Promise<void>
  recordPlay: (trackPath: string) => Promise<void>
  setShowTracklistBpmKey: (enabled: boolean) => void
  setShowTracklistAddedDate: (enabled: boolean) => void
}

// Artwork cache stored outside of zustand to avoid re-renders
const MAX_THUMBNAIL_CACHE_ENTRIES = 512
const MAX_CARD_ARTWORK_CACHE_ENTRIES = 96
const MAX_FULL_ARTWORK_CACHE_ENTRIES = 32
const MAX_SCAN_ISSUE_ENTRIES = 200
const RECENTLY_PLAYED_FETCH_LIMIT = 120
const MAX_SELECTION_HISTORY_ENTRIES = 40
const TRACKLIST_BPM_KEY_VISIBILITY_STORAGE_KEY = 'astra-library-tracklist-bpm-key-visible-v1'
const TRACKLIST_ADDED_DATE_VISIBILITY_STORAGE_KEY = 'astra-library-tracklist-added-date-visible-v1'
const artworkCache = new Map<string, string>()
const cardArtworkCache = new Map<string, string>()
const thumbnailArtworkCache = new Map<string, string>()
const artworkRequestCache = new Map<string, Promise<string | null>>()

function snapshotCurrentSelection(state: Pick<LibraryStore, 'selectedAlbum' | 'selectedArtist' | 'selectionOrigin' | 'tracks'>): LibrarySelectionSnapshot | null {
  if (!state.selectedAlbum && !state.selectedArtist) return null

  return {
    selectedAlbum: state.selectedAlbum ? { ...state.selectedAlbum } : null,
    selectedArtist: state.selectedArtist,
    selectionOrigin: state.selectionOrigin,
    tracks: state.tracks
  }
}

function appendSelectionHistory(
  history: LibrarySelectionSnapshot[],
  snapshot: LibrarySelectionSnapshot | null
): LibrarySelectionSnapshot[] {
  if (!snapshot) return history

  const next = history.concat(snapshot)
  if (next.length <= MAX_SELECTION_HISTORY_ENTRIES) return next
  return next.slice(next.length - MAX_SELECTION_HISTORY_ENTRIES)
}

function loadTracklistBpmKeyVisibilitySetting(): boolean {
  try {
    return localStorage.getItem(TRACKLIST_BPM_KEY_VISIBILITY_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function loadTracklistAddedDateVisibilitySetting(): boolean {
  try {
    return localStorage.getItem(TRACKLIST_ADDED_DATE_VISIBILITY_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function getArtworkCacheKey(hash: string, variant: ArtworkVariant): string {
  if (variant === 'thumbnail') return `thumb:${hash}`
  if (variant === 'card') return `card:${hash}`
  return `full:${hash}`
}

function setLruCacheEntry(
  cache: Map<string, string>,
  cacheKey: string,
  dataUrl: string,
  maxEntries: number
): void {
  if (cache.has(cacheKey)) {
    cache.delete(cacheKey)
  }
  cache.set(cacheKey, dataUrl)

  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value
    if (!oldestKey) return
    cache.delete(oldestKey)
  }
}

function getLruCacheEntry(cache: Map<string, string>, cacheKey: string): string | undefined {
  const cached = cache.get(cacheKey)
  if (!cached) return undefined
  // Touch entry to keep LRU order.
  cache.delete(cacheKey)
  cache.set(cacheKey, cached)
  return cached
}

function normalizeScanIssueLog(scanIssueLog: ScanIssueLog | null | undefined): ScanIssueLog | null {
  if (!scanIssueLog || scanIssueLog.total <= 0) return null

  const entries = scanIssueLog.entries.slice(0, MAX_SCAN_ISSUE_ENTRIES)
  const shown = entries.length
  const truncated = scanIssueLog.truncated || scanIssueLog.total > shown

  return {
    total: scanIssueLog.total,
    shown,
    truncated,
    entries,
  }
}

function mergeScanIssueLogs(
  current: ScanIssueLog | null,
  incoming: ScanIssueLog | null | undefined
): ScanIssueLog | null {
  const next = normalizeScanIssueLog(incoming)
  if (!next) return current
  if (!current) return next

  const combinedEntries = current.entries.length >= MAX_SCAN_ISSUE_ENTRIES
    ? current.entries
    : current.entries.concat(next.entries).slice(0, MAX_SCAN_ISSUE_ENTRIES)
  const total = current.total + next.total

  return {
    total,
    shown: combinedEntries.length,
    truncated: current.truncated || next.truncated || total > combinedEntries.length,
    entries: combinedEntries,
  }
}

export const useLibraryStore = create<LibraryStore>((set, get) => ({
  // Initial state
  tracks: [],
  totalTrackCount: 0,
  albums: [],
  artists: [],
  folders: [],
  viewMode: 'tracks',
  selectedAlbum: null,
  selectedArtist: null,
  selectionOrigin: null,
  selectionHistory: [],
  searchQuery: '',
  searchResults: [],
  isLoading: false,
  isScanning: false,
  isCancelingScan: false,
  scanProgress: null,
  scanStage: null,
  folderWarnings: {},
  lastScanIssueLog: null,
  folderSubfolderSummaries: {},
  artworkCache,
  favorites: new Set<string>(),
  favoriteTracks: [],
  recentlyPlayed: [],
  showTracklistBpmKey: loadTracklistBpmKeyVisibilitySetting(),
  showTracklistAddedDate: loadTracklistAddedDateVisibilitySetting(),

  // Load entire library
  loadLibrary: async () => {
    set({ isLoading: true })
    const currentSelection = {
      album: get().selectedAlbum,
      artist: get().selectedArtist
    }
    await Promise.all([
      get().loadTracks(),
      get().loadTrackCount(),
      get().loadAlbums(),
      get().loadArtists(),
      get().loadFolders(),
      get().loadFavorites(),
      get().loadRecentlyPlayed()
    ])

    if (currentSelection.album) {
      const albumSelection = currentSelection.album
      const tracks = await window.electronAPI.library.getTracksByAlbum(
        albumSelection.album,
        albumSelection.artist,
        albumSelection.identity_key
      )
      set((state) => {
        const activeAlbum = state.selectedAlbum
        if (!activeAlbum) return {}
        if (activeAlbum.identity_key !== albumSelection.identity_key) return {}
        if (activeAlbum.album !== albumSelection.album) return {}
        if (activeAlbum.artist !== albumSelection.artist) return {}
        return { tracks }
      })
    } else if (currentSelection.artist) {
      const artistSelection = currentSelection.artist
      const tracks = await window.electronAPI.library.getTracksByArtist(artistSelection)
      set((state) => {
        if (state.selectedArtist !== artistSelection) return {}
        return { tracks }
      })
    }

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

  // Load full-library track count (independent of active selection/filter state)
  loadTrackCount: async () => {
    try {
      const totalTrackCount = await window.electronAPI.library.getTrackCount()
      if (typeof totalTrackCount !== 'number' || !Number.isFinite(totalTrackCount) || totalTrackCount < 0) {
        return
      }
      set({ totalTrackCount })
    } catch (error) {
      console.error('Failed to load library track count:', error)
    }
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
    const folderPathSet = new Set(folders.map((folder) => folder.path))
    set((state) => {
      const nextSummaries: Record<string, FolderSubfolderSummary> = {}
      for (const [folderPath, summary] of Object.entries(state.folderSubfolderSummaries)) {
        if (folderPathSet.has(folderPath)) {
          nextSummaries[folderPath] = summary
        }
      }
      return { folders, folderSubfolderSummaries: nextSummaries }
    })
  },

  // Load a folder subfolder summary
  loadFolderSubfolderSummary: async (folderPath: string) => {
    const summary = await window.electronAPI.library.getFolderSubfolderSummary(folderPath)
    set((state) => ({
      folderSubfolderSummaries: {
        ...state.folderSubfolderSummaries,
        [folderPath]: summary
      }
    }))
    return summary
  },

  // List direct subdirectories under a folder path branch
  listFolderSubdirectories: async (folderPath: string, parentRelativePath: string = '') => {
    return window.electronAPI.library.listFolderSubdirectories(folderPath, parentRelativePath)
  },

  // Exclude/include a subfolder path without triggering a scan yet.
  setFolderSubfolderExcluded: async (folderPath: string, relativePath: string, excluded: boolean) => {
    const result = await window.electronAPI.library.setFolderSubfolderExcluded(folderPath, relativePath, excluded)
    if (!result.success) {
      return null
    }

    if (result.summary) {
      set((state) => ({
        folderSubfolderSummaries: {
          ...state.folderSubfolderSummaries,
          [folderPath]: result.summary!,
        }
      }))
    }

    return result.summary ?? null
  },

  // Rescan one folder after a batch of subfolder inclusion/exclusion changes.
  rescanFolder: async (folderPath: string) => {
    set({
      isScanning: true,
      isCancelingScan: false,
      scanProgress: { current: 0, total: 0, file: '' },
      scanStage: { stage: 'scanning', message: 'Scanning files...' },
      lastScanIssueLog: null
    })

    const unsubscribeProgress = window.electronAPI.library.onScanProgress((progress) => {
      set({ scanProgress: progress })
    })
    const unsubscribeStage = window.electronAPI.library.onScanStage((scanStage) => {
      set({ scanStage })
    })

    try {
      const result = await window.electronAPI.library.rescanFolder(folderPath)
      if (result.canceled) {
        return null
      }
      if (!result.success) {
        return null
      }

      set({ lastScanIssueLog: normalizeScanIssueLog(result.scanIssueLog) })

      if (result.skippedDirs && result.skippedDirs.length > 0) {
        set({ folderWarnings: { ...get().folderWarnings, [folderPath]: result.skippedDirs } })
      } else {
        const { [folderPath]: _, ...remainingWarnings } = get().folderWarnings
        set({ folderWarnings: remainingWarnings })
      }

      if (result.summary) {
        set((state) => ({
          folderSubfolderSummaries: {
            ...state.folderSubfolderSummaries,
            [folderPath]: result.summary!,
          }
        }))
      }

      await get().loadLibrary()
      return result.summary ?? null
    } finally {
      unsubscribeProgress()
      unsubscribeStage()
      set({ isScanning: false, isCancelingScan: false, scanProgress: null, scanStage: null })
    }
  },

  // Rescan an explicit set of folders in one operation and reload once.
  scanFolders: async (folderPaths: string[]) => {
    const uniqueFolderPaths = Array.from(new Set(folderPaths.filter((folderPath) => folderPath.trim().length > 0)))
    if (uniqueFolderPaths.length === 0) {
      return { scannedFolders: 0, canceled: false }
    }

    set({
      isScanning: true,
      isCancelingScan: false,
      scanProgress: { current: 0, total: 0, file: '' },
      scanStage: { stage: 'scanning', message: 'Scanning files...' },
      lastScanIssueLog: null
    })

    const unsubscribeProgress = window.electronAPI.library.onScanProgress((progress) => {
      set({ scanProgress: progress })
    })
    const unsubscribeStage = window.electronAPI.library.onScanStage((scanStage) => {
      set({ scanStage })
    })

    try {
      const nextWarnings = { ...get().folderWarnings }
      const nextSummaries = { ...get().folderSubfolderSummaries }
      let aggregatedScanIssueLog: ScanIssueLog | null = null
      let scannedFolders = 0
      let canceled = false

      for (const folderPath of uniqueFolderPaths) {
        const result = await window.electronAPI.library.rescanFolder(folderPath)
        if (result.canceled) {
          canceled = true
          break
        }
        if (!result.success) {
          throw new Error(`Failed to scan folder: ${folderPath}`)
        }

        aggregatedScanIssueLog = mergeScanIssueLogs(aggregatedScanIssueLog, result.scanIssueLog)

        if (result.skippedDirs && result.skippedDirs.length > 0) {
          nextWarnings[folderPath] = result.skippedDirs
        } else {
          delete nextWarnings[folderPath]
        }

        if (result.summary) {
          nextSummaries[folderPath] = result.summary
        }
        scannedFolders += 1
      }

      set({
        folderWarnings: nextWarnings,
        folderSubfolderSummaries: nextSummaries,
        lastScanIssueLog: aggregatedScanIssueLog,
      })

      if (scannedFolders > 0) {
        await get().loadLibrary()
      }

      return { scannedFolders, canceled }
    } finally {
      unsubscribeProgress()
      unsubscribeStage()
      set({ isScanning: false, isCancelingScan: false, scanProgress: null, scanStage: null })
    }
  },

  cancelScan: async () => {
    if (!get().isScanning || get().isCancelingScan) return false

    set({ isCancelingScan: true })
    let cancelAccepted = false

    try {
      const result = await window.electronAPI.library.cancelScan()
      cancelAccepted = Boolean(result.canceled)
      if (cancelAccepted) {
        set((state) => ({
          scanStage: state.scanStage
            ? { ...state.scanStage, message: 'Canceling scan...' }
            : { stage: 'scanning', message: 'Canceling scan...' }
        }))
      }
      return cancelAccepted
    } catch (error) {
      console.error('Failed to cancel library scan:', error)
      return false
    } finally {
      if (!cancelAccepted) {
        set({ isCancelingScan: false })
      }
    }
  },

  // Add folder mapping without scanning tracks yet.
  addFolderWithoutScan: async () => {
    const folderPath = await window.electronAPI.openAudioFolder()
    if (!folderPath) return null

    const result = await window.electronAPI.library.addFolderWithoutScan(folderPath)
    if (!result.success) return null

    await get().loadFolders()
    if (result.summary) {
      set((state) => ({
        folderSubfolderSummaries: {
          ...state.folderSubfolderSummaries,
          [folderPath]: result.summary!,
        }
      }))
    } else {
      await get().loadFolderSubfolderSummary(folderPath)
    }

    return folderPath
  },

  // Add folder
  addFolder: async () => {
    const folderPath = await window.electronAPI.openAudioFolder()
    if (!folderPath) return

    set({
      isScanning: true,
      isCancelingScan: false,
      scanProgress: { current: 0, total: 0, file: '' },
      scanStage: { stage: 'scanning', message: 'Scanning files...' },
      lastScanIssueLog: null
    })

    // Subscribe to scan progress
    const unsubscribeProgress = window.electronAPI.library.onScanProgress((progress) => {
      set({ scanProgress: progress })
    })
    const unsubscribeStage = window.electronAPI.library.onScanStage((scanStage) => {
      set({ scanStage })
    })

    try {
      const result = await window.electronAPI.library.addFolder(folderPath)
      if (result.canceled) {
        await get().loadFolders()
        return
      }
      if (result.success) {
        set({ lastScanIssueLog: normalizeScanIssueLog(result.scanIssueLog) })
        if (result.skippedDirs && result.skippedDirs.length > 0) {
          set({ folderWarnings: { ...get().folderWarnings, [folderPath]: result.skippedDirs } })
        }
        // Reload library after scan
        await get().loadLibrary()
      }
    } finally {
      unsubscribeProgress()
      unsubscribeStage()
      set({ isScanning: false, isCancelingScan: false, scanProgress: null, scanStage: null })
    }
  },

  // Remove folder and reload library state without rescanning all folders.
  removeFolder: async (path: string) => {
    await window.electronAPI.library.removeFolder(path)
    const { [path]: _, ...remaining } = get().folderWarnings
    const { [path]: __, ...remainingSummaries } = get().folderSubfolderSummaries
    set({ folderWarnings: remaining, folderSubfolderSummaries: remainingSummaries })
    await get().loadLibrary()
  },

  // Rescan all folders
  rescan: async () => {
    set({
      isScanning: true,
      isCancelingScan: false,
      scanProgress: { current: 0, total: 0, file: '' },
      scanStage: { stage: 'scanning', message: 'Scanning files...' },
      lastScanIssueLog: null
    })

    const unsubscribeProgress = window.electronAPI.library.onScanProgress((progress) => {
      set({ scanProgress: progress })
    })
    const unsubscribeStage = window.electronAPI.library.onScanStage((scanStage) => {
      set({ scanStage })
    })

    try {
      const result = await window.electronAPI.library.rescan()
      if (result.canceled) {
        return
      }
      if (result.folderWarnings) {
        set({ folderWarnings: result.folderWarnings })
      } else {
        set({ folderWarnings: {} })
      }
      set({ lastScanIssueLog: normalizeScanIssueLog(result.scanIssueLog) })
      await get().loadLibrary()
    } finally {
      unsubscribeProgress()
      unsubscribeStage()
      set({ isScanning: false, isCancelingScan: false, scanProgress: null, scanStage: null })
    }
  },

  backfillReplayGainMetadata: async () => {
    if (get().isScanning) return

    set({
      isScanning: true,
      isCancelingScan: false,
      scanProgress: { current: 0, total: 0, file: '' },
      scanStage: { stage: 'backfill', message: 'Processing ReplayGain metadata...' },
      lastScanIssueLog: null
    })

    const unsubscribeProgress = window.electronAPI.library.onScanProgress((progress) => {
      set({ scanProgress: progress })
    })
    const unsubscribeStage = window.electronAPI.library.onScanStage((scanStage) => {
      set({ scanStage })
    })

    try {
      const result = await window.electronAPI.library.backfillReplayGainMetadata()
      if (result.canceled) {
        return
      }
      set({ lastScanIssueLog: normalizeScanIssueLog(result.scanIssueLog) })
      await get().loadLibrary()
    } finally {
      unsubscribeProgress()
      unsubscribeStage()
      set({ isScanning: false, isCancelingScan: false, scanProgress: null, scanStage: null })
    }
  },

  // Set view mode
  setViewMode: (mode: ViewMode) => {
    set((state) => {
      // Allow detail navigation helpers to switch base mode to tracks without discarding active detail selection.
      if ((state.selectedAlbum || state.selectedArtist) && mode === 'tracks') {
        return { viewMode: mode }
      }

      return {
        viewMode: mode,
        selectedAlbum: null,
        selectedArtist: null,
        selectionOrigin: null,
        selectionHistory: []
      }
    })
  },

  // Select album
  selectAlbum: async (
    album: string,
    artist?: string,
    origin: Exclude<SelectionOrigin, null> = 'library',
    identityKey?: string
  ) => {
    const tracks = await window.electronAPI.library.getTracksByAlbum(album, artist, identityKey)
    set((state) => ({
      selectedAlbum: { identity_key: identityKey, album, artist: artist ?? '' },
      tracks,
      selectedArtist: null,
      selectionOrigin: origin,
      selectionHistory: appendSelectionHistory(state.selectionHistory, snapshotCurrentSelection(state))
    }))
  },

  // Select artist
  selectArtist: async (
    artist: string,
    origin: Exclude<SelectionOrigin, null> = 'library',
    mode: LibraryArtistBrowseMode = 'canonical'
  ) => {
    const tracks = await window.electronAPI.library.getTracksByArtist(artist, mode)
    set((state) => ({
      selectedArtist: artist,
      tracks,
      selectedAlbum: null,
      selectionOrigin: origin,
      selectionHistory: appendSelectionHistory(state.selectionHistory, snapshotCurrentSelection(state))
    }))
  },

  // Clear selection
  clearSelection: async () => {
    set({ selectedAlbum: null, selectedArtist: null, selectionOrigin: null, selectionHistory: [] })
    await get().loadTracks()
  },

  // Restore previous detail selection when available.
  goBackSelection: async () => {
    let didRestore = false

    set((state) => {
      const historyLength = state.selectionHistory.length
      if (historyLength === 0) return {}

      const previous = state.selectionHistory[historyLength - 1]
      if (!previous) return {}

      didRestore = true
      return {
        selectedAlbum: previous.selectedAlbum ? { ...previous.selectedAlbum } : null,
        selectedArtist: previous.selectedArtist,
        selectionOrigin: previous.selectionOrigin,
        tracks: previous.tracks,
        selectionHistory: state.selectionHistory.slice(0, -1)
      }
    })

    return didRestore
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
  getArtwork: async (hash: string | null, options?: ArtworkRequestOptions) => {
    if (!hash) return null
    const variant: ArtworkVariant = options?.variant ?? 'full'
    const cacheKey = getArtworkCacheKey(hash, variant)

    // Check cache first
    const cache = variant === 'thumbnail'
      ? thumbnailArtworkCache
      : variant === 'card'
        ? cardArtworkCache
        : artworkCache
    const cached = getLruCacheEntry(cache, cacheKey)
    if (cached) {
      return cached
    }

    // Deduplicate concurrent requests for the same artwork hash + variant.
    if (artworkRequestCache.has(cacheKey)) {
      return artworkRequestCache.get(cacheKey)!
    }

    const request = (
      variant === 'thumbnail'
        ? window.electronAPI.library.getArtworkThumbnailDataUrl(hash)
        : variant === 'card'
          ? window.electronAPI.library.getArtworkCardDataUrl(hash)
          : window.electronAPI.library.getArtworkDataUrl(hash)
    )
      .then((dataUrl) => {
        if (dataUrl) {
          if (variant === 'thumbnail') {
            setLruCacheEntry(thumbnailArtworkCache, cacheKey, dataUrl, MAX_THUMBNAIL_CACHE_ENTRIES)
          } else if (variant === 'card') {
            setLruCacheEntry(cardArtworkCache, cacheKey, dataUrl, MAX_CARD_ARTWORK_CACHE_ENTRIES)
          } else {
            setLruCacheEntry(artworkCache, cacheKey, dataUrl, MAX_FULL_ARTWORK_CACHE_ENTRIES)
          }
        }
        return dataUrl
      })
      .catch(() => null)
      .finally(() => {
        artworkRequestCache.delete(cacheKey)
      })

    artworkRequestCache.set(cacheKey, request)
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
    const recentlyPlayed = await window.electronAPI.library.getRecentlyPlayed(RECENTLY_PLAYED_FETCH_LIMIT)
    set({ recentlyPlayed })
  },

  // Record a track play
  recordPlay: async (trackPath: string) => {
    await window.electronAPI.library.addRecentlyPlayed(trackPath)
    // Reload recently played list
    const recentlyPlayed = await window.electronAPI.library.getRecentlyPlayed(RECENTLY_PLAYED_FETCH_LIMIT)
    set({ recentlyPlayed })
  },

  setShowTracklistBpmKey: (enabled: boolean) => {
    const normalized = Boolean(enabled)
    set({ showTracklistBpmKey: normalized })

    try {
      localStorage.setItem(TRACKLIST_BPM_KEY_VISIBILITY_STORAGE_KEY, normalized ? '1' : '0')
    } catch {
      // Ignore localStorage write failures in restricted environments.
    }
  },

  setShowTracklistAddedDate: (enabled: boolean) => {
    const normalized = Boolean(enabled)
    set({ showTracklistAddedDate: normalized })

    try {
      localStorage.setItem(TRACKLIST_ADDED_DATE_VISIBILITY_STORAGE_KEY, normalized ? '1' : '0')
    } catch {
      // Ignore localStorage write failures in restricted environments.
    }
  }
}))
