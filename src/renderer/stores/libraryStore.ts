import { create } from 'zustand'
import type { TrackSourceType } from '../../types/subsonic'

// Types matching preload
export interface DbTrack {
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
  primary_artist: string | null
  year: number | null
  artwork_hash: string | null
  track_count: number
  is_new: boolean
}

interface Artist {
  artist: string
  track_count: number
  artwork_hash: string | null
  artwork_source: 'manual' | 'detected' | 'track' | null
}

export interface LibraryFolder {
  id: number
  path: string
  added_at: number
}

interface LibrarySelectionSnapshot {
  selectedAlbum: { identity_key?: string; album: string; artist: string; is_new?: boolean } | null
  selectedArtist: string | null
  selectionOrigin: SelectionOrigin
  trackPaths: string[]
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
type ArtworkResponseFormat = 'object-url' | 'data-url'

export interface ArtworkRequestOptions {
  variant?: ArtworkVariant
  format?: ArtworkResponseFormat
}

interface ArtworkCacheEntry {
  url: string
  byteLength: number
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
  fullTracks: DbTrack[]
  totalTrackCount: number
  albums: Album[]
  albumsIncludingSingles: Album[]
  albumsIncludingSinglesLoaded: boolean
  artists: Artist[]
  folders: LibraryFolder[]
  viewMode: ViewMode
  selectedAlbum: { identity_key?: string; album: string; artist: string; is_new?: boolean } | null
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
  artworkCache: Map<string, ArtworkCacheEntry>
  favorites: Set<string>
  favoriteTracks: DbTrack[]
  recentlyPlayed: DbTrack[]
  artistBrowseMode: LibraryArtistBrowseMode
  showTracklistBpmKey: boolean
  showTracklistAddedDate: boolean
  folderViewExpandedPaths: Set<string>
  folderViewScrollTop: number

  // Actions
  loadLibrary: () => Promise<void>
  loadTracks: () => Promise<void>
  loadFullTracks: () => Promise<void>
  loadTrackCount: () => Promise<void>
  loadAlbums: () => Promise<void>
  loadAlbumsIncludingSingles: () => Promise<void>
  loadArtists: () => Promise<void>
  setArtistImageFromFile: (artist: string, mode: LibraryArtistBrowseMode, imagePath: string) => Promise<void>
  clearArtistImage: (artist: string, mode: LibraryArtistBrowseMode) => Promise<void>
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
  forceRescanAll: () => Promise<void>
  backfillReplayGainMetadata: () => Promise<void>
  setViewMode: (mode: ViewMode) => void
  selectAlbum: (
    album: string,
    artist?: string,
    origin?: Exclude<SelectionOrigin, null>,
    identityKey?: string
  ) => Promise<void>
  selectArtist: (artist: string, origin?: Exclude<SelectionOrigin, null>) => Promise<void>
  releaseFullTracks: () => void
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
  markTrackLatestSyncSeen: (trackPath: string) => Promise<void>
  setArtistBrowseMode: (mode: LibraryArtistBrowseMode) => void
  setShowTracklistBpmKey: (enabled: boolean) => void
  setShowTracklistAddedDate: (enabled: boolean) => void
  setFolderViewExpandedPaths: (paths: Iterable<string>) => void
  setFolderViewScrollTop: (scrollTop: number) => void
  pruneFolderViewExpandedPaths: (validFolderPaths: ReadonlySet<string>) => void
}

// Artwork cache stored outside of zustand to avoid re-renders
const MAX_THUMBNAIL_CACHE_ENTRIES = 128
const MAX_CARD_ARTWORK_CACHE_ENTRIES = 64
const MAX_FULL_ARTWORK_CACHE_ENTRIES = 4
const MAX_SCAN_ISSUE_ENTRIES = 200
const RECENTLY_PLAYED_FETCH_LIMIT = 120
const MAX_SELECTION_HISTORY_ENTRIES = 40
export const ARTIST_BROWSE_MODE_STORAGE_KEY = 'astra-library-artist-browse-mode-v1'
const TRACKLIST_BPM_KEY_VISIBILITY_STORAGE_KEY = 'astra-library-tracklist-bpm-key-visible-v1'
const TRACKLIST_ADDED_DATE_VISIBILITY_STORAGE_KEY = 'astra-library-tracklist-added-date-visible-v1'
const artworkCache = new Map<string, ArtworkCacheEntry>()
const cardArtworkCache = new Map<string, ArtworkCacheEntry>()
const thumbnailArtworkCache = new Map<string, ArtworkCacheEntry>()
const artworkRequestCache = new Map<string, Promise<string | null>>()
let fullTracksRequestId = 0

function estimateArtworkCacheBytes(cache: Map<string, ArtworkCacheEntry>): number {
  let total = 0
  for (const [key, entry] of cache.entries()) {
    total += (key.length * 2) + (entry.url.length * 2) + entry.byteLength
  }
  return total
}

function snapshotCurrentSelection(state: Pick<LibraryStore, 'selectedAlbum' | 'selectedArtist' | 'selectionOrigin' | 'tracks'>): LibrarySelectionSnapshot | null {
  if (!state.selectedAlbum && !state.selectedArtist) return null

  return {
    selectedAlbum: state.selectedAlbum ? { ...state.selectedAlbum } : null,
    selectedArtist: state.selectedArtist,
    selectionOrigin: state.selectionOrigin,
    trackPaths: state.tracks.map((track) => track.path)
  }
}

function resolveTracksFromPaths(
  trackPaths: readonly string[],
  fullTracks: readonly DbTrack[]
): { tracks: DbTrack[]; complete: boolean } {
  if (trackPaths.length === 0) {
    return { tracks: [], complete: true }
  }

  const tracksByPath = new Map(fullTracks.map((track) => [track.path, track]))
  const tracks: DbTrack[] = []
  for (const trackPath of trackPaths) {
    const track = tracksByPath.get(trackPath)
    if (track) {
      tracks.push(track)
    }
  }

  return {
    tracks,
    complete: tracks.length === trackPaths.length
  }
}

function isSameAlbumSelection(
  current: LibraryStore['selectedAlbum'],
  target: NonNullable<LibraryStore['selectedAlbum']>
): boolean {
  return Boolean(
    current &&
    current.identity_key === target.identity_key &&
    current.album === target.album &&
    current.artist === target.artist
  )
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

function normalizeArtistBrowseMode(mode: LibraryArtistBrowseMode | string | null | undefined): LibraryArtistBrowseMode {
  return mode === 'strict' ? 'strict' : 'canonical'
}

function loadArtistBrowseModeSetting(): LibraryArtistBrowseMode {
  try {
    return normalizeArtistBrowseMode(localStorage.getItem(ARTIST_BROWSE_MODE_STORAGE_KEY))
  } catch {
    return 'canonical'
  }
}

function clearTrackNewFlagInCollection(tracks: DbTrack[], trackPath: string): DbTrack[] {
  let didChange = false
  const nextTracks = tracks.map((track) => {
    if (track.path !== trackPath || !track.is_new) {
      return track
    }
    didChange = true
    return {
      ...track,
      is_new: false
    }
  })

  return didChange ? nextTracks : tracks
}

function updateAlbumNewFlagInCollection(albums: Album[], albumIdentityKey: string | null, isNew: boolean): Album[] {
  if (!albumIdentityKey) return albums

  let didChange = false
  const nextAlbums = albums.map((album) => {
    if (album.identity_key !== albumIdentityKey || album.is_new === isNew) {
      return album
    }
    didChange = true
    return {
      ...album,
      is_new: isNew
    }
  })

  return didChange ? nextAlbums : albums
}

function updateSelectedAlbumNewFlag(
  selectedAlbum: LibraryStore['selectedAlbum'],
  albumIdentityKey: string | null,
  isNew: boolean
): LibraryStore['selectedAlbum'] {
  if (!selectedAlbum || !albumIdentityKey || selectedAlbum.identity_key !== albumIdentityKey || selectedAlbum.is_new === isNew) {
    return selectedAlbum
  }

  return {
    ...selectedAlbum,
    is_new: isNew
  }
}

function updateSelectionHistoryForSeenTrack(
  selectionHistory: LibrarySelectionSnapshot[],
  albumIdentityKey: string | null,
  albumIsNew: boolean
): LibrarySelectionSnapshot[] {
  let didChange = false
  const nextHistory = selectionHistory.map((snapshot) => {
    const nextSelectedAlbum = snapshot.selectedAlbum && albumIdentityKey && snapshot.selectedAlbum.identity_key === albumIdentityKey
      ? updateSelectedAlbumNewFlag(snapshot.selectedAlbum, albumIdentityKey, albumIsNew)
      : snapshot.selectedAlbum

    if (nextSelectedAlbum === snapshot.selectedAlbum) {
      return snapshot
    }

    didChange = true
    return {
      ...snapshot,
      selectedAlbum: nextSelectedAlbum
    }
  })

  return didChange ? nextHistory : selectionHistory
}

function getArtworkCacheKey(hash: string, variant: ArtworkVariant): string {
  if (variant === 'thumbnail') return `thumb:${hash}`
  if (variant === 'card') return `card:${hash}`
  return `full:${hash}`
}

function getArtworkRequestKey(cacheKey: string, format: ArtworkResponseFormat): string {
  return `${format}:${cacheKey}`
}

function revokeArtworkCacheEntry(entry: ArtworkCacheEntry | undefined): void {
  if (!entry?.url.startsWith('blob:')) return
  URL.revokeObjectURL(entry.url)
}

function dataUrlToArtworkCacheEntry(dataUrl: string): ArtworkCacheEntry | null {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex <= 0) return null

  const header = dataUrl.slice(0, commaIndex)
  const payload = dataUrl.slice(commaIndex + 1)
  const mime = header.match(/^data:([^;,]+)/)?.[1] ?? 'image/jpeg'

  try {
    if (header.toLocaleLowerCase().includes(';base64')) {
      const binary = atob(payload)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i)
      }
      const blob = new Blob([bytes], { type: mime })
      return {
        url: URL.createObjectURL(blob),
        byteLength: blob.size
      }
    }

    const decoded = decodeURIComponent(payload)
    const blob = new Blob([decoded], { type: mime })
    return {
      url: URL.createObjectURL(blob),
      byteLength: blob.size
    }
  } catch {
    return null
  }
}

function setLruCacheEntry(
  cache: Map<string, ArtworkCacheEntry>,
  cacheKey: string,
  entry: ArtworkCacheEntry,
  maxEntries: number
): void {
  const existing = cache.get(cacheKey)
  if (existing) {
    revokeArtworkCacheEntry(existing)
  }
  cache.delete(cacheKey)
  cache.set(cacheKey, entry)

  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value
    if (!oldestKey) return
    revokeArtworkCacheEntry(cache.get(oldestKey))
    cache.delete(oldestKey)
  }
}

function getLruCacheEntry(cache: Map<string, ArtworkCacheEntry>, cacheKey: string): string | undefined {
  const cached = cache.get(cacheKey)
  if (!cached) return undefined
  // Touch entry to keep LRU order.
  cache.delete(cacheKey)
  cache.set(cacheKey, cached)
  return cached.url
}

function clearArtworkCache(cache: Map<string, ArtworkCacheEntry>): void {
  for (const entry of cache.values()) {
    revokeArtworkCacheEntry(entry)
  }
  cache.clear()
}

function clearAllArtworkCaches(): void {
  clearArtworkCache(artworkCache)
  clearArtworkCache(cardArtworkCache)
  clearArtworkCache(thumbnailArtworkCache)
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', clearAllArtworkCaches)
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
  fullTracks: [],
  totalTrackCount: 0,
  albums: [],
  albumsIncludingSingles: [],
  albumsIncludingSinglesLoaded: false,
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
  artistBrowseMode: loadArtistBrowseModeSetting(),
  showTracklistBpmKey: loadTracklistBpmKeyVisibilitySetting(),
  showTracklistAddedDate: loadTracklistAddedDateVisibilitySetting(),
  folderViewExpandedPaths: new Set<string>(),
  folderViewScrollTop: 0,

  // Load entire library
  loadLibrary: async () => {
    set({ isLoading: true })
    const shouldReloadAlbumsIncludingSingles = get().albumsIncludingSinglesLoaded
    const currentSelection = {
      album: get().selectedAlbum,
      artist: get().selectedArtist,
      artistBrowseMode: get().artistBrowseMode
    }
    await Promise.all([
      get().loadTracks(),
      get().loadTrackCount(),
      get().loadAlbums(),
      shouldReloadAlbumsIncludingSingles ? get().loadAlbumsIncludingSingles() : Promise.resolve(),
      get().loadArtists(),
      get().loadFolders(),
      get().loadFavorites(),
      get().loadRecentlyPlayed()
    ])

    if (currentSelection.album) {
      const albumSelection = currentSelection.album
      const matchedAlbum = get().albums.find((candidate) => {
        if (albumSelection.identity_key && candidate.identity_key === albumSelection.identity_key) return true
        return candidate.album === albumSelection.album && candidate.artist === albumSelection.artist
      })
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
        return {
          tracks,
          selectedAlbum: {
            ...activeAlbum,
            is_new: matchedAlbum?.is_new ?? false
          }
        }
      })
    } else if (currentSelection.artist) {
      const artistSelection = currentSelection.artist
      const tracks = await window.electronAPI.library.getTracksByArtist(
        artistSelection,
        currentSelection.artistBrowseMode
      )
      set((state) => {
        if (state.selectedArtist !== artistSelection) return {}
        if (state.artistBrowseMode !== currentSelection.artistBrowseMode) return {}
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
      if (state.selectedAlbum || state.selectedArtist) {
        return { fullTracks: tracks }
      }
      return { tracks, fullTracks: tracks }
    })
  },

  loadFullTracks: async () => {
    const requestId = ++fullTracksRequestId
    const tracks = await window.electronAPI.library.getTracks()
    if (requestId !== fullTracksRequestId) {
      return
    }

    set({ fullTracks: tracks })
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

  loadAlbumsIncludingSingles: async () => {
    const albumsIncludingSingles = await window.electronAPI.library.getAlbums({ includeSingles: true })
    set({ albumsIncludingSingles, albumsIncludingSinglesLoaded: true })
  },

  // Load artists
  loadArtists: async () => {
    const mode = get().artistBrowseMode
    const artists = await window.electronAPI.library.getArtists(mode)
    set((state) => {
      if (state.artistBrowseMode !== mode) return {}
      return { artists }
    })
  },

  setArtistImageFromFile: async (artist: string, mode: LibraryArtistBrowseMode, imagePath: string) => {
    await window.electronAPI.library.setArtistImageFromFile(artist, mode, imagePath)
    await get().loadArtists()
  },

  clearArtistImage: async (artist: string, mode: LibraryArtistBrowseMode) => {
    await window.electronAPI.library.clearArtistImage(artist, mode)
    await get().loadArtists()
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

  forceRescanAll: async () => {
    set({
      isScanning: true,
      isCancelingScan: false,
      scanProgress: { current: 0, total: 0, file: '' },
      scanStage: { stage: 'scanning', message: 'Force rescanning library...' },
      lastScanIssueLog: null
    })

    const unsubscribeProgress = window.electronAPI.library.onScanProgress((progress) => {
      set({ scanProgress: progress })
    })
    const unsubscribeStage = window.electronAPI.library.onScanStage((scanStage) => {
      set({ scanStage })
    })

    try {
      const result = await window.electronAPI.library.forceRescanAll()
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
        tracks: state.fullTracks,
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
    const matchedAlbum = get().albums.find((candidate) => {
      if (identityKey && candidate.identity_key === identityKey) return true
      return candidate.album === album && candidate.artist === (artist ?? '')
    })
    set((state) => ({
      selectedAlbum: {
        identity_key: identityKey,
        album,
        artist: artist ?? '',
        is_new: matchedAlbum?.is_new ?? false
      },
      tracks,
      selectedArtist: null,
      selectionOrigin: origin,
      selectionHistory: appendSelectionHistory(state.selectionHistory, snapshotCurrentSelection(state))
    }))
  },

  // Select artist
  selectArtist: async (artist: string, origin: Exclude<SelectionOrigin, null> = 'library') => {
    const mode = get().artistBrowseMode
    const tracks = await window.electronAPI.library.getTracksByArtist(artist, mode)
    set((state) => ({
      selectedArtist: artist,
      tracks,
      selectedAlbum: null,
      selectionOrigin: origin,
      selectionHistory: appendSelectionHistory(state.selectionHistory, snapshotCurrentSelection(state))
    }))
  },

  releaseFullTracks: () => {
    fullTracksRequestId += 1
  },

  // Clear selection
  clearSelection: async () => {
    set((state) => ({
      selectedAlbum: null,
      selectedArtist: null,
      selectionOrigin: null,
      selectionHistory: [],
      tracks: state.fullTracks
    }))
    await get().loadTracks()
  },

  // Restore previous detail selection when available.
  goBackSelection: async () => {
    const state = get()
    const historyLength = state.selectionHistory.length
    if (historyLength === 0) return false

    const previous = state.selectionHistory[historyLength - 1]
    if (!previous) return false

    const restoredTracks = resolveTracksFromPaths(previous.trackPaths, state.fullTracks)
    const restoredAlbum = previous.selectedAlbum ? { ...previous.selectedAlbum } : null
    const restoredArtist = previous.selectedArtist

    set({
      selectedAlbum: restoredAlbum,
      selectedArtist: restoredArtist,
      selectionOrigin: previous.selectionOrigin,
      tracks: restoredTracks.tracks,
      selectionHistory: state.selectionHistory.slice(0, -1)
    })

    if (restoredArtist) {
      const mode = get().artistBrowseMode
      const tracks = await window.electronAPI.library.getTracksByArtist(restoredArtist, mode)
      set((state) => {
        if (state.selectedArtist !== restoredArtist) return {}
        if (state.artistBrowseMode !== mode) return {}
        return { tracks }
      })
    } else if (restoredAlbum && !restoredTracks.complete) {
      const tracks = await window.electronAPI.library.getTracksByAlbum(
        restoredAlbum.album,
        restoredAlbum.artist,
        restoredAlbum.identity_key
      )
      set((state) => {
        if (!isSameAlbumSelection(state.selectedAlbum, restoredAlbum)) return {}
        return { tracks }
      })
    }

    return true
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

  // Get artwork URL (with caching)
  getArtwork: async (hash: string | null, options?: ArtworkRequestOptions) => {
    if (!hash) return null
    const variant: ArtworkVariant = options?.variant ?? 'card'
    const format: ArtworkResponseFormat = options?.format ?? 'object-url'
    const cacheKey = getArtworkCacheKey(hash, variant)
    const requestKey = getArtworkRequestKey(cacheKey, format)

    const cache = variant === 'thumbnail'
      ? thumbnailArtworkCache
      : variant === 'card'
        ? cardArtworkCache
        : artworkCache
    if (format === 'object-url') {
      const cached = getLruCacheEntry(cache, cacheKey)
      if (cached) {
        return cached
      }
    }

    // Deduplicate concurrent requests for the same artwork hash + variant.
    if (artworkRequestCache.has(requestKey)) {
      return artworkRequestCache.get(requestKey)!
    }

    const request = (
      variant === 'thumbnail'
        ? window.electronAPI.library.getArtworkThumbnailDataUrl(hash)
        : variant === 'card'
          ? window.electronAPI.library.getArtworkCardDataUrl(hash)
          : window.electronAPI.library.getArtworkDataUrl(hash)
    )
      .then((dataUrl) => {
        if (!dataUrl) return null
        if (format === 'data-url') return dataUrl

        const entry = dataUrlToArtworkCacheEntry(dataUrl)
        if (!entry) return dataUrl

        if (variant === 'thumbnail') {
          setLruCacheEntry(thumbnailArtworkCache, cacheKey, entry, MAX_THUMBNAIL_CACHE_ENTRIES)
        } else if (variant === 'card') {
          setLruCacheEntry(cardArtworkCache, cacheKey, entry, MAX_CARD_ARTWORK_CACHE_ENTRIES)
        } else {
          setLruCacheEntry(artworkCache, cacheKey, entry, MAX_FULL_ARTWORK_CACHE_ENTRIES)
        }
        return entry.url
      })
      .catch(() => null)
      .finally(() => {
        artworkRequestCache.delete(requestKey)
      })

    artworkRequestCache.set(requestKey, request)
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

  markTrackLatestSyncSeen: async (trackPath: string) => {
    if (!trackPath.trim()) return

    const knownTrack =
      get().fullTracks.find((track) => track.path === trackPath)
      ?? get().tracks.find((track) => track.path === trackPath)
      ?? get().searchResults.find((track) => track.path === trackPath)
      ?? get().favoriteTracks.find((track) => track.path === trackPath)
      ?? get().recentlyPlayed.find((track) => track.path === trackPath)
    if (knownTrack && !knownTrack.is_new) {
      return
    }

    await window.electronAPI.library.markTrackLatestSyncSeen(trackPath)

    set((state) => {
      const matchedTrack =
        state.fullTracks.find((track) => track.path === trackPath)
        ?? state.tracks.find((track) => track.path === trackPath)
        ?? state.searchResults.find((track) => track.path === trackPath)
        ?? state.favoriteTracks.find((track) => track.path === trackPath)
        ?? state.recentlyPlayed.find((track) => track.path === trackPath)

      const albumIdentityKey = matchedTrack?.album_identity_key ?? null
      const fullTracks = clearTrackNewFlagInCollection(state.fullTracks, trackPath)
      const tracks = clearTrackNewFlagInCollection(state.tracks, trackPath)
      const searchResults = clearTrackNewFlagInCollection(state.searchResults, trackPath)
      const favoriteTracks = clearTrackNewFlagInCollection(state.favoriteTracks, trackPath)
      const recentlyPlayed = clearTrackNewFlagInCollection(state.recentlyPlayed, trackPath)
      const albumIsNew = albumIdentityKey
        ? fullTracks.some((track) => track.album_identity_key === albumIdentityKey && track.is_new)
        : false

      return {
        fullTracks,
        tracks,
        searchResults,
        favoriteTracks,
        recentlyPlayed,
        albums: updateAlbumNewFlagInCollection(state.albums, albumIdentityKey, albumIsNew),
        albumsIncludingSingles: updateAlbumNewFlagInCollection(state.albumsIncludingSingles, albumIdentityKey, albumIsNew),
        selectedAlbum: updateSelectedAlbumNewFlag(state.selectedAlbum, albumIdentityKey, albumIsNew),
        selectionHistory: updateSelectionHistoryForSeenTrack(
          state.selectionHistory,
          albumIdentityKey,
          albumIsNew
        )
      }
    })
  },

  // Record a track play
  recordPlay: async (trackPath: string) => {
    await window.electronAPI.library.addRecentlyPlayed(trackPath)
    // Reload recently played list
    const recentlyPlayed = await window.electronAPI.library.getRecentlyPlayed(RECENTLY_PLAYED_FETCH_LIMIT)
    set({ recentlyPlayed })
  },

  setArtistBrowseMode: (mode: LibraryArtistBrowseMode) => {
    const normalized = normalizeArtistBrowseMode(mode)
    if (get().artistBrowseMode === normalized) return

    set({ artistBrowseMode: normalized })

    try {
      localStorage.setItem(ARTIST_BROWSE_MODE_STORAGE_KEY, normalized)
    } catch {
      // Ignore localStorage write failures in restricted environments.
    }

    void (async () => {
      await get().loadArtists()

      const selectedArtist = get().selectedArtist
      if (!selectedArtist) return

      const tracks = await window.electronAPI.library.getTracksByArtist(selectedArtist, normalized)
      set((state) => {
        if (state.selectedArtist !== selectedArtist) return {}
        if (state.artistBrowseMode !== normalized) return {}
        return { tracks }
      })
    })()
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
  },

  setFolderViewExpandedPaths: (paths: Iterable<string>) => {
    set({ folderViewExpandedPaths: new Set(paths) })
  },

  setFolderViewScrollTop: (scrollTop: number) => {
    const normalized = Number.isFinite(scrollTop) ? Math.max(0, Math.round(scrollTop)) : 0
    if (get().folderViewScrollTop === normalized) return
    set({ folderViewScrollTop: normalized })
  },

  pruneFolderViewExpandedPaths: (validFolderPaths: ReadonlySet<string>) => {
    set((state) => {
      if (state.folderViewExpandedPaths.size === 0) return {}

      const nextExpandedPaths = new Set<string>()
      for (const folderPath of state.folderViewExpandedPaths) {
        if (validFolderPaths.has(folderPath)) {
          nextExpandedPaths.add(folderPath)
        }
      }

      if (nextExpandedPaths.size === state.folderViewExpandedPaths.size) return {}
      return { folderViewExpandedPaths: nextExpandedPaths }
    })
  }
}))

export function getLibraryDiagnosticsSnapshot(): {
  totalTrackCount: number
  visibleTrackCount: number
  albumCount: number
  artistCount: number
  folderCount: number
  favoriteCount: number
  favoriteTrackCount: number
  recentlyPlayedCount: number
  searchResultCount: number
  selectionHistoryCount: number
  selectionHistoryTrackCount: number
  selectedDetailTrackCount: number
  scanInProgress: boolean
  caches: {
    artworkFullEntries: number
    artworkFullBytes: number
    artworkThumbnailEntries: number
    artworkThumbnailBytes: number
    artworkCardEntries: number
    artworkCardBytes: number
    artworkRequests: number
  }
} {
  const state = useLibraryStore.getState()
  const selectionHistoryTrackCount = state.selectionHistory.reduce((total, snapshot) => {
    return total + snapshot.trackPaths.length
  }, 0)
  return {
    totalTrackCount: state.totalTrackCount,
    visibleTrackCount: state.tracks.length,
    albumCount: state.albums.length,
    artistCount: state.artists.length,
    folderCount: state.folders.length,
    favoriteCount: state.favorites.size,
    favoriteTrackCount: state.favoriteTracks.length,
    recentlyPlayedCount: state.recentlyPlayed.length,
    searchResultCount: state.searchResults.length,
    selectionHistoryCount: state.selectionHistory.length,
    selectionHistoryTrackCount,
    selectedDetailTrackCount: state.selectedAlbum || state.selectedArtist ? state.tracks.length : 0,
    scanInProgress: state.isScanning,
    caches: {
      artworkFullEntries: artworkCache.size,
      artworkFullBytes: estimateArtworkCacheBytes(artworkCache),
      artworkThumbnailEntries: thumbnailArtworkCache.size,
      artworkThumbnailBytes: estimateArtworkCacheBytes(thumbnailArtworkCache),
      artworkCardEntries: cardArtworkCache.size,
      artworkCardBytes: estimateArtworkCacheBytes(cardArtworkCache),
      artworkRequests: artworkRequestCache.size
    }
  }
}
