import { create } from 'zustand'
import type { TrackSourceType } from '../../types/subsonic'
import { logMemoryDiagnosticsEvent } from '../utils/memoryDiagnostics'
import { useUIStore } from './uiStore'
import {
  ALBUM_SORT_MODE_STORAGE_KEY,
  ARTIST_BROWSE_MODE_STORAGE_KEY,
  ARTIST_ROOT_VIEW_MODE_STORAGE_KEY,
  INCLUDE_COLLAB_ARTISTS_STORAGE_KEY,
  INCLUDE_SINGLES_IN_ALBUMS_STORAGE_KEY,
  TRACKLIST_ADDED_DATE_VISIBILITY_STORAGE_KEY,
  TRACKLIST_BPM_KEY_VISIBILITY_STORAGE_KEY,
  TRACKLIST_GENRE_VISIBILITY_STORAGE_KEY,
  TRACKLIST_PLAY_COUNT_VISIBILITY_STORAGE_KEY
} from '../constants/settingsStorageKeys'
import {
  normalizeTrackSortState,
  type LibrarySessionSnapshot,
  type SessionAlbumSortMode,
  type SessionArtistRootViewMode,
  type SessionTrackSortState
} from '../utils/sessionState'
import { normalizeKey } from '../utils/albumIdentity'
import { albumMatchesLibraryYear, type LibraryYearKey } from '../utils/libraryYears'

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
  genres: string[]
  artwork_hash: string | null
  base_artwork_hash: string | null
  format: string
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  codec: string | null
  codec_profile: string | null
  is_atmos_joc: number | null
  is_iamf: number | null
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
  primary_track_count: number
  album_count: number
  artwork_hash: string | null
  artwork_source: 'manual' | 'detected' | 'track' | null
}

interface Genre {
  genre: string
  track_count: number
  album_count: number
  artwork_hash: string | null
}

export interface LibraryFolder {
  id: number
  path: string
  added_at: number
  hidden: number
}

interface LibrarySelectionSnapshot {
  selectedAlbum: { identity_key?: string; album: string; artist: string; is_new?: boolean } | null
  selectedArtist: string | null
  selectedGenre: string | null
  selectedYear: LibraryYearKey | null
  selectionOrigin: SelectionOrigin
  trackPaths: string[]
  trackPathsPruned?: boolean
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

export type ViewMode = 'tracks' | 'albums' | 'artists' | 'genres' | 'years' | 'folders'
type SelectionOrigin = 'home' | 'library' | 'library-detail' | null
export type LibraryArtistBrowseMode = 'strict' | 'canonical'
export type LibraryFullTrackConsumer = 'library' | 'graph' | 'integrity'
export type ArtworkVariant = 'full' | 'thumbnail' | 'card'
type ArtworkResponseFormat = 'object-url' | 'data-url'
export type LibraryAlbumSortMode = SessionAlbumSortMode
export type LibraryArtistRootViewMode = SessionArtistRootViewMode
export type LibraryTrackListSortState = SessionTrackSortState

export {
  ALBUM_SORT_MODE_STORAGE_KEY,
  ARTIST_BROWSE_MODE_STORAGE_KEY,
  ARTIST_ROOT_VIEW_MODE_STORAGE_KEY,
  INCLUDE_COLLAB_ARTISTS_STORAGE_KEY,
  INCLUDE_SINGLES_IN_ALBUMS_STORAGE_KEY,
  TRACKLIST_ADDED_DATE_VISIBILITY_STORAGE_KEY,
  TRACKLIST_BPM_KEY_VISIBILITY_STORAGE_KEY,
  TRACKLIST_PLAY_COUNT_VISIBILITY_STORAGE_KEY
} from '../constants/settingsStorageKeys'

export interface ArtworkRequestOptions {
  variant?: ArtworkVariant
  format?: ArtworkResponseFormat
}

// Displayable artwork URLs are deterministic astra-artwork:// protocol URLs
// served by the main process; Chromium owns image caching and eviction, so
// the renderer keeps no artwork byte caches.
const ARTWORK_PROTOCOL_VARIANT_SEGMENTS: Record<ArtworkVariant, string> = {
  thumbnail: 'thumb',
  card: 'card',
  full: 'full'
}

function buildArtworkProtocolUrl(hash: string, variant: ArtworkVariant): string {
  return `astra-artwork://art/${ARTWORK_PROTOCOL_VARIANT_SEGMENTS[variant]}/${encodeURIComponent(hash)}`
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
  trackByPath: Map<string, DbTrack>
  trackCacheVersion: number
  trackPaths: string[]
  fullTrackPaths: string[]
  fullTracksStatus: 'idle' | 'loading' | 'complete'
  fullTrackConsumers: Set<LibraryFullTrackConsumer>
  totalTrackCount: number
  totalTrackDuration: number
  albums: Album[]
  albumsIncludingSingles: Album[]
  albumsIncludingSinglesLoaded: boolean
  artists: Artist[]
  genres: Genre[]
  folders: LibraryFolder[]
  viewMode: ViewMode
  selectedAlbum: { identity_key?: string; album: string; artist: string; is_new?: boolean } | null
  selectedArtist: string | null
  selectedGenre: string | null
  selectedYear: LibraryYearKey | null
  selectionOrigin: SelectionOrigin
  selectionHistory: LibrarySelectionSnapshot[]
  selectionForwardHistory: LibrarySelectionSnapshot[]
  searchQuery: string
  searchResultPaths: string[]
  isLoading: boolean
  isScanning: boolean
  isCancelingScan: boolean
  scanProgress: { current: number; total: number; file: string } | null
  scanStage: ScanStageProgress | null
  folderWarnings: Record<string, string[]>
  lastScanIssueLog: ScanIssueLog | null
  folderSubfolderSummaries: Record<string, FolderSubfolderSummary>
  favorites: Set<string>
  favoriteTrackPaths: string[]
  recentlyPlayedPaths: string[]
  artistBrowseMode: LibraryArtistBrowseMode
  showTracklistBpmKey: boolean
  showTracklistGenre: boolean
  showTracklistAddedDate: boolean
  showTracklistPlayCount: boolean
  trackListSortState: LibraryTrackListSortState | null
  tracksViewSortState: LibraryTrackListSortState | null
  selectedSourceFilters: Set<string>
  albumSortMode: LibraryAlbumSortMode
  includeSinglesInAlbums: boolean
  includeCollabArtists: boolean
  artistRootViewMode: LibraryArtistRootViewMode
  folderViewExpandedPaths: Set<string>
  folderViewScrollTop: number

  // Actions
  loadLibrary: () => Promise<void>
  loadTracks: () => Promise<void>
  loadFullTracks: (consumer?: LibraryFullTrackConsumer) => Promise<void>
  loadTrackCount: () => Promise<void>
  loadTrackDuration: () => Promise<void>
  loadAlbums: () => Promise<void>
  loadAlbumsIncludingSingles: () => Promise<void>
  loadArtists: () => Promise<void>
  loadGenres: () => Promise<void>
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
  setFolderHidden: (path: string, hidden: boolean) => Promise<void>
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
  selectGenre: (genre: string, origin?: Exclude<SelectionOrigin, null>) => Promise<void>
  selectYear: (year: LibraryYearKey, origin?: Exclude<SelectionOrigin, null>) => Promise<void>
  releaseFullTracks: (consumer?: LibraryFullTrackConsumer) => void
  clearSelection: () => Promise<void>
  goBackSelection: () => Promise<boolean>
  goForwardSelection: () => Promise<boolean>
  search: (query: string) => Promise<void>
  clearSearch: () => void
  resolveTrackPaths: (trackPaths: readonly string[]) => DbTrack[]
  resolveTrackPathsWithFetch: (trackPaths: readonly string[]) => Promise<DbTrack[]>
  getArtwork: (hash: string | null, options?: ArtworkRequestOptions) => Promise<string | null>
  loadFavorites: () => Promise<void>
  toggleFavorite: (trackPath: string) => Promise<void>
  isFavorite: (trackPath: string) => boolean
  loadRecentlyPlayed: () => Promise<void>
  recordPlay: (trackPath: string) => Promise<void>
  markTrackLatestSyncSeen: (trackPath: string) => Promise<void>
  setArtistBrowseMode: (mode: LibraryArtistBrowseMode) => void
  setShowTracklistBpmKey: (enabled: boolean) => void
  setShowTracklistGenre: (enabled: boolean) => void
  setShowTracklistAddedDate: (enabled: boolean) => void
  setShowTracklistPlayCount: (enabled: boolean) => void
  setTrackListSortState: (sortState: LibraryTrackListSortState | null) => void
  resetTrackListSortState: () => void
  setSelectedSourceFilters: (filters: Iterable<string>) => void
  clearSelectedSourceFilters: () => void
  toggleSourceFilter: (filterKey: string) => void
  setAlbumSortMode: (mode: LibraryAlbumSortMode) => void
  setIncludeSinglesInAlbums: (enabled: boolean) => void
  setIncludeCollabArtists: (enabled: boolean) => void
  setArtistRootViewMode: (mode: LibraryArtistRootViewMode) => void
  setFolderViewExpandedPaths: (paths: Iterable<string>) => void
  setFolderViewScrollTop: (scrollTop: number) => void
  pruneFolderViewExpandedPaths: (validFolderPaths: ReadonlySet<string>) => void
  getSessionSnapshot: () => LibrarySessionSnapshot
  restoreSession: (snapshot: LibrarySessionSnapshot) => Promise<void>
}

const MAX_SCAN_ISSUE_ENTRIES = 200
const RECENTLY_PLAYED_FETCH_LIMIT = 120
const MAX_SELECTION_HISTORY_ENTRIES = 40
export const MAX_SELECTION_HISTORY_TRACK_PATHS = 500
const FULL_TRACK_PAGE_LIMIT = 2000
const FULL_TRACK_REVEAL_INTERVAL_MS = 250
const DEFAULT_TRACK_LIST_SORT_STATE: LibraryTrackListSortState = { key: 'title', direction: 'asc' }
// Dedup for the remaining data-url IPC requests (consumers that ship
// artwork outside this renderer, e.g. media session and remote controllers).
const artworkRequestCache = new Map<string, Promise<string | null>>()
let fullTracksRequestId = 0

// Blink's decoded-image cache accumulates while browsing artwork-heavy views
// and is never released on its own. Once the user has been away from all of
// them for a while, ask Blink to drop it — but only when the image cache is
// actually holding enough to be worth clearing. A wasted clear is cheap
// (artwork re-serves from the disk-backed astra-artwork protocol), so the
// delay is just a debounce against quick bounce-backs.
const BLINK_CACHE_CLEAR_DELAY_MS = 45_000
const BLINK_CACHE_CLEAR_MIN_IMAGE_BYTES = 24 * 1024 * 1024
// The fullscreen overlay covers the active view and shows a single backdrop,
// so time spent there counts as "away" — long fullscreen listening sessions
// are exactly when reclaiming browse artwork matters.
const ARTWORK_HEAVY_VIEWS: ReadonlySet<string> = new Set(['home', 'library', 'playlist', 'graph'])
let blinkCacheClearTimer: number | null = null

function isArtworkHeavyUiState(state: { activeView: string; isFullscreen: boolean }): boolean {
  return !state.isFullscreen && ARTWORK_HEAVY_VIEWS.has(state.activeView)
}

function cancelScheduledBlinkCacheClear(): void {
  if (blinkCacheClearTimer !== null) {
    window.clearTimeout(blinkCacheClearTimer)
    blinkCacheClearTimer = null
  }
}

function scheduleBlinkCacheClear(): void {
  cancelScheduledBlinkCacheClear()
  blinkCacheClearTimer = window.setTimeout(() => {
    blinkCacheClearTimer = null
    try {
      if (isArtworkHeavyUiState(useUIStore.getState())) return

      const imageCacheBytes = window.electronAPI.diagnostics.getBlinkResourceUsage()?.images?.size
      if (typeof imageCacheBytes === 'number' && imageCacheBytes < BLINK_CACHE_CLEAR_MIN_IMAGE_BYTES) {
        return
      }

      window.electronAPI.diagnostics.clearRendererCache()
      logMemoryDiagnosticsEvent('renderer_blink_cache_cleared', {
        reason: 'artwork_views_idle',
        imageCacheMb: typeof imageCacheBytes === 'number'
          ? Number((imageCacheBytes / (1024 * 1024)).toFixed(1))
          : null
      })
    } catch {
      // Cache clearing is best-effort.
    }
  }, BLINK_CACHE_CLEAR_DELAY_MS)
}

// Schedule on leaving the artwork-heavy views, cancel on returning to one.
useUIStore.subscribe((state, prevState) => {
  const heavy = isArtworkHeavyUiState(state)
  if (heavy === isArtworkHeavyUiState(prevState)) return
  if (heavy) {
    cancelScheduledBlinkCacheClear()
  } else {
    scheduleBlinkCacheClear()
  }
})

export function getUniqueTrackPaths(tracks: readonly DbTrack[]): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const track of tracks) {
    const path = track.path
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

export function resolveCachedTrackPaths(
  trackPaths: readonly string[],
  trackByPath: ReadonlyMap<string, DbTrack>
): { tracks: DbTrack[]; complete: boolean } {
  if (trackPaths.length === 0) {
    return { tracks: [], complete: true }
  }

  const tracks: DbTrack[] = []
  for (const trackPath of trackPaths) {
    const track = trackByPath.get(trackPath)
    if (track) {
      tracks.push(track)
    }
  }

  return {
    tracks,
    complete: tracks.length === trackPaths.length
  }
}

export function pruneCachedTracks(
  trackByPath: ReadonlyMap<string, DbTrack>,
  retainedPaths: ReadonlySet<string>
): Map<string, DbTrack> {
  if (trackByPath.size === 0) {
    return trackByPath instanceof Map ? trackByPath : new Map(trackByPath)
  }

  let didPrune = false
  const next = new Map<string, DbTrack>()
  for (const [trackPath, track] of trackByPath.entries()) {
    if (retainedPaths.has(trackPath)) {
      next.set(trackPath, track)
    } else {
      didPrune = true
    }
  }

  return didPrune ? next : trackByPath instanceof Map ? trackByPath : new Map(trackByPath)
}

export function updateFullTrackConsumers(
  current: ReadonlySet<LibraryFullTrackConsumer>,
  consumer: LibraryFullTrackConsumer | undefined,
  action: 'retain' | 'release'
): { consumers: Set<LibraryFullTrackConsumer>; shouldReleaseFullTracks: boolean; changed: boolean } {
  const consumers = new Set(current)
  const beforeSize = consumers.size
  if (consumer) {
    if (action === 'retain') {
      consumers.add(consumer)
    } else {
      consumers.delete(consumer)
    }
  } else if (action === 'release') {
    consumers.clear()
  }

  return {
    consumers,
    shouldReleaseFullTracks: action === 'release' && consumers.size === 0,
    changed: consumers.size !== beforeSize || [...consumers].some((entry) => !current.has(entry))
  }
}

interface TrackCacheFinalizeOptions {
  prune?: boolean
}

interface TrackCacheIngestOptions extends TrackCacheFinalizeOptions {
  mutate?: boolean
}

function ingestTracksIntoCache(
  trackByPath: ReadonlyMap<string, DbTrack>,
  tracks: readonly DbTrack[],
  options: TrackCacheIngestOptions = {}
): { trackByPath: Map<string, DbTrack>; paths: string[]; changed: boolean } {
  const paths: string[] = []
  const seen = new Set<string>()
  let next = trackByPath instanceof Map ? trackByPath : new Map(trackByPath)
  let changed = false

  for (const track of tracks) {
    const path = track.path
    if (!path) continue
    if (!seen.has(path)) {
      seen.add(path)
      paths.push(path)
    }
    if (next.get(path) === track) continue
    if (!changed && !options.mutate) {
      next = new Map(next)
    }
    next.set(path, track)
    changed = true
  }

  return { trackByPath: next, paths, changed }
}

type TrackCachePatch = Partial<Pick<
  LibraryStore,
  | 'trackPaths'
  | 'fullTrackPaths'
  | 'fullTracksStatus'
  | 'fullTrackConsumers'
  | 'searchQuery'
  | 'searchResultPaths'
  | 'favorites'
  | 'favoriteTrackPaths'
  | 'recentlyPlayedPaths'
  | 'selectedAlbum'
  | 'selectedArtist'
  | 'selectedGenre'
  | 'selectedYear'
  | 'selectionOrigin'
  | 'selectionHistory'
  | 'selectionForwardHistory'
  | 'trackListSortState'
  | 'tracksViewSortState'
  | 'selectedSourceFilters'
  | 'albumSortMode'
  | 'includeSinglesInAlbums'
  | 'includeCollabArtists'
  | 'artistRootViewMode'
>>

function addPathsToRetainedSet(retainedPaths: Set<string>, trackPaths: readonly string[]): void {
  for (const trackPath of trackPaths) {
    retainedPaths.add(trackPath)
  }
}

function collectRetainedTrackPaths(state: LibraryStore, patch: TrackCachePatch = {}): Set<string> {
  const retainedPaths = new Set<string>()
  const trackPaths = patch.trackPaths ?? state.trackPaths
  const fullTrackPaths = patch.fullTrackPaths ?? state.fullTrackPaths
  const fullTrackConsumers = patch.fullTrackConsumers ?? state.fullTrackConsumers
  const searchResultPaths = patch.searchResultPaths ?? state.searchResultPaths
  const favoriteTrackPaths = patch.favoriteTrackPaths ?? state.favoriteTrackPaths
  const recentlyPlayedPaths = patch.recentlyPlayedPaths ?? state.recentlyPlayedPaths

  addPathsToRetainedSet(retainedPaths, trackPaths)
  if (fullTrackConsumers.size > 0) {
    addPathsToRetainedSet(retainedPaths, fullTrackPaths)
  }
  addPathsToRetainedSet(retainedPaths, searchResultPaths)
  addPathsToRetainedSet(retainedPaths, favoriteTrackPaths)
  addPathsToRetainedSet(retainedPaths, recentlyPlayedPaths)

  return retainedPaths
}

function finalizeTrackCachePatch(
  state: LibraryStore,
  patch: TrackCachePatch,
  trackByPath: Map<string, DbTrack>,
  cacheChanged: boolean,
  options: TrackCacheFinalizeOptions = {}
): TrackCachePatch & Pick<LibraryStore, 'trackByPath' | 'trackCacheVersion'> {
  const shouldPrune = options.prune !== false
  const retainedPaths = shouldPrune ? collectRetainedTrackPaths(state, patch) : null
  const prunedTrackByPath = retainedPaths ? pruneCachedTracks(trackByPath, retainedPaths) : trackByPath
  const didPrune = shouldPrune && prunedTrackByPath !== trackByPath

  return {
    ...patch,
    trackByPath: prunedTrackByPath,
    trackCacheVersion: cacheChanged || didPrune ? state.trackCacheVersion + 1 : state.trackCacheVersion
  }
}

function ingestTracksForPatch(
  state: LibraryStore,
  tracks: readonly DbTrack[],
  patch: TrackCachePatch,
  options: TrackCacheIngestOptions = {}
): TrackCachePatch & Pick<LibraryStore, 'trackByPath' | 'trackCacheVersion'> {
  const ingested = ingestTracksIntoCache(state.trackByPath, tracks, options)
  return finalizeTrackCachePatch(state, patch, ingested.trackByPath, ingested.changed, options)
}

function snapshotCurrentSelection(state: Pick<LibraryStore, 'selectedAlbum' | 'selectedArtist' | 'selectedGenre' | 'selectedYear' | 'selectionOrigin' | 'trackPaths'>): LibrarySelectionSnapshot | null {
  if (!state.selectedAlbum && !state.selectedArtist && !state.selectedGenre && state.selectedYear === null) return null
  const shouldPruneTrackPaths = state.trackPaths.length > MAX_SELECTION_HISTORY_TRACK_PATHS

  return {
    selectedAlbum: state.selectedAlbum ? { ...state.selectedAlbum } : null,
    selectedArtist: state.selectedArtist,
    selectedGenre: state.selectedGenre,
    selectedYear: state.selectedYear,
    selectionOrigin: state.selectionOrigin,
    trackPaths: shouldPruneTrackPaths ? [] : [...state.trackPaths],
    ...(shouldPruneTrackPaths ? { trackPathsPruned: true } : {})
  }
}

function resolveTracksFromPaths(
  trackPaths: readonly string[],
  trackByPath: ReadonlyMap<string, DbTrack>
): { tracks: DbTrack[]; complete: boolean } {
  return resolveCachedTrackPaths(trackPaths, trackByPath)
}

function resolveTracksFromSelectionSnapshot(
  snapshot: LibrarySelectionSnapshot,
  trackByPath: ReadonlyMap<string, DbTrack>
): { tracks: DbTrack[]; complete: boolean } {
  const resolved = resolveTracksFromPaths(snapshot.trackPaths, trackByPath)
  return {
    tracks: resolved.tracks,
    complete: resolved.complete && !snapshot.trackPathsPruned
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

function loadTracklistGenreVisibilitySetting(): boolean {
  try {
    return localStorage.getItem(TRACKLIST_GENRE_VISIBILITY_STORAGE_KEY) === '1'
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

function loadTracklistPlayCountVisibilitySetting(): boolean {
  try {
    return localStorage.getItem(TRACKLIST_PLAY_COUNT_VISIBILITY_STORAGE_KEY) === '1'
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

function normalizeAlbumSortMode(mode: LibraryAlbumSortMode | string | null | undefined): LibraryAlbumSortMode {
  return mode === 'artist' ? 'artist' : 'title'
}

function loadAlbumSortModeSetting(): LibraryAlbumSortMode {
  try {
    return normalizeAlbumSortMode(localStorage.getItem(ALBUM_SORT_MODE_STORAGE_KEY))
  } catch {
    return 'title'
  }
}

function loadIncludeSinglesInAlbumsSetting(): boolean {
  try {
    return localStorage.getItem(INCLUDE_SINGLES_IN_ALBUMS_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function loadIncludeCollabArtistsSetting(): boolean {
  try {
    return localStorage.getItem(INCLUDE_COLLAB_ARTISTS_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function normalizeArtistRootViewMode(mode: LibraryArtistRootViewMode | string | null | undefined): LibraryArtistRootViewMode {
  return mode === 'grid' ? 'grid' : 'list'
}

function loadArtistRootViewModeSetting(): LibraryArtistRootViewMode {
  try {
    return normalizeArtistRootViewMode(localStorage.getItem(ARTIST_ROOT_VIEW_MODE_STORAGE_KEY))
  } catch {
    return 'list'
  }
}

function persistStringPreference(storageKey: string, value: string): void {
  try {
    localStorage.setItem(storageKey, value)
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

function persistBooleanPreference(storageKey: string, value: boolean): void {
  persistStringPreference(storageKey, value ? '1' : '0')
}

function normalizeSourceFilters(filters: Iterable<string>): Set<string> {
  const next = new Set<string>()
  for (const filter of filters) {
    if (typeof filter === 'string' && filter.trim().length > 0) {
      next.add(filter)
    }
  }
  return next
}

function areStringSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
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

function getAlbumCoveragePaths(state: LibraryStore, albumIdentityKey: string | null): string[] | null {
  if (!albumIdentityKey) return null
  if (state.fullTrackConsumers.size > 0 && state.fullTrackPaths.length > 0) {
    return state.fullTrackPaths
  }
  if (state.selectedAlbum?.identity_key === albumIdentityKey) {
    return state.trackPaths
  }
  return null
}

function hasAlbumCoverage(state: LibraryStore, albumIdentityKey: string | null): boolean {
  return getAlbumCoveragePaths(state, albumIdentityKey) !== null
}

function getAlbumArtistForTrackLookup(track: DbTrack): string {
  return track.album_artist ?? track.artist
}

function clearTrackNewFlagInCache(
  trackByPath: ReadonlyMap<string, DbTrack>,
  trackPath: string
): { trackByPath: Map<string, DbTrack>; changed: boolean } {
  const existing = trackByPath.get(trackPath)
  if (!existing?.is_new) {
    return {
      trackByPath: trackByPath instanceof Map ? trackByPath : new Map(trackByPath),
      changed: false
    }
  }

  const next = new Map(trackByPath)
  next.set(trackPath, {
    ...existing,
    is_new: false
  })
  return { trackByPath: next, changed: true }
}

function computeAlbumIsNew(
  trackByPath: ReadonlyMap<string, DbTrack>,
  coveragePaths: readonly string[] | null,
  albumIdentityKey: string | null
): boolean {
  if (!albumIdentityKey || !coveragePaths) return false
  return coveragePaths.some((trackPath) => {
    const track = trackByPath.get(trackPath)
    return track?.album_identity_key === albumIdentityKey && track.is_new
  })
}

function getArtworkCacheKey(hash: string, variant: ArtworkVariant): string {
  if (variant === 'thumbnail') return `thumb:${hash}`
  if (variant === 'card') return `card:${hash}`
  return `full:${hash}`
}

function getArtworkRequestKey(cacheKey: string, format: ArtworkResponseFormat): string {
  return `${format}:${cacheKey}`
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
  trackByPath: new Map<string, DbTrack>(),
  trackCacheVersion: 0,
  trackPaths: [],
  fullTrackPaths: [],
  fullTracksStatus: 'idle',
  fullTrackConsumers: new Set<LibraryFullTrackConsumer>(),
  totalTrackCount: 0,
  totalTrackDuration: 0,
  albums: [],
  albumsIncludingSingles: [],
  albumsIncludingSinglesLoaded: false,
  artists: [],
  genres: [],
  folders: [],
  viewMode: 'tracks',
  selectedAlbum: null,
  selectedArtist: null,
  selectedGenre: null,
  selectedYear: null,
  selectionOrigin: null,
  selectionHistory: [],
  selectionForwardHistory: [],
  searchQuery: '',
  searchResultPaths: [],
  isLoading: false,
  isScanning: false,
  isCancelingScan: false,
  scanProgress: null,
  scanStage: null,
  folderWarnings: {},
  lastScanIssueLog: null,
  folderSubfolderSummaries: {},
  favorites: new Set<string>(),
  favoriteTrackPaths: [],
  recentlyPlayedPaths: [],
  artistBrowseMode: loadArtistBrowseModeSetting(),
  showTracklistBpmKey: loadTracklistBpmKeyVisibilitySetting(),
  showTracklistGenre: loadTracklistGenreVisibilitySetting(),
  showTracklistAddedDate: loadTracklistAddedDateVisibilitySetting(),
  showTracklistPlayCount: loadTracklistPlayCountVisibilitySetting(),
  trackListSortState: { ...DEFAULT_TRACK_LIST_SORT_STATE },
  tracksViewSortState: { ...DEFAULT_TRACK_LIST_SORT_STATE },
  selectedSourceFilters: new Set<string>(),
  albumSortMode: loadAlbumSortModeSetting(),
  includeSinglesInAlbums: loadIncludeSinglesInAlbumsSetting(),
  includeCollabArtists: loadIncludeCollabArtistsSetting(),
  artistRootViewMode: loadArtistRootViewModeSetting(),
  folderViewExpandedPaths: new Set<string>(),
  folderViewScrollTop: 0,

  // Load entire library
  loadLibrary: async () => {
    set({ isLoading: true })
    const shouldReloadAlbumsIncludingSingles = get().albumsIncludingSinglesLoaded
    const currentSelection = {
      album: get().selectedAlbum,
      artist: get().selectedArtist,
      genre: get().selectedGenre,
      artistBrowseMode: get().artistBrowseMode,
      hasFullTrackConsumers: get().fullTrackConsumers.size > 0
    }
    await Promise.all([
      get().loadTrackCount(),
      get().loadTrackDuration(),
      get().loadAlbums(),
      shouldReloadAlbumsIncludingSingles ? get().loadAlbumsIncludingSingles() : Promise.resolve(),
      get().loadArtists(),
      get().loadGenres(),
      get().loadFolders(),
      get().loadFavorites(),
      get().loadRecentlyPlayed(),
      currentSelection.hasFullTrackConsumers ? get().loadFullTracks() : Promise.resolve()
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
        const paths = getUniqueTrackPaths(tracks)
        return ingestTracksForPatch(state, tracks, {
          trackPaths: paths,
          selectedAlbum: {
            ...activeAlbum,
            is_new: matchedAlbum?.is_new ?? false
          }
        })
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
        const paths = getUniqueTrackPaths(tracks)
        return ingestTracksForPatch(state, tracks, { trackPaths: paths })
      })
    } else if (currentSelection.genre) {
      const genreSelection = currentSelection.genre
      const tracks = await window.electronAPI.library.getTracksByGenre(genreSelection)
      set((state) => {
        if (state.selectedGenre !== genreSelection) return {}
        const paths = getUniqueTrackPaths(tracks)
        return ingestTracksForPatch(state, tracks, { trackPaths: paths })
      })
    }

    set({ isLoading: false })
  },

  // Load tracks
  loadTracks: async () => {
    await get().loadFullTracks('library')
  },

  loadFullTracks: async (consumer?: LibraryFullTrackConsumer) => {
    if (consumer) {
      set((state) => {
        const nextConsumers = updateFullTrackConsumers(state.fullTrackConsumers, consumer, 'retain')
        if (!nextConsumers.changed) return {}
        return { fullTrackConsumers: nextConsumers.consumers }
      })
    }

    if (get().fullTrackConsumers.size === 0) {
      return
    }

    const requestId = ++fullTracksRequestId
    const paths: string[] = []
    const seenPaths = new Set<string>()
    let offset = 0
    let lastRevealAt = 0
    let completed = false

    set((state) => (state.fullTracksStatus === 'loading' ? {} : { fullTracksStatus: 'loading' }))

    try {
      while (true) {
        const page = await window.electronAPI.library.getTracksPage({
          offset,
          limit: FULL_TRACK_PAGE_LIMIT
        })
        if (requestId !== fullTracksRequestId) {
          return
        }
        if (get().fullTrackConsumers.size === 0) {
          return
        }

        for (const track of page.tracks) {
          if (!track.path || seenPaths.has(track.path)) continue
          seenPaths.add(track.path)
          paths.push(track.path)
        }

        const isLastPage = !page.hasMore || page.tracks.length === 0

        // Reveal pages as they arrive so large libraries display immediately,
        // throttled because each reveal re-runs view-side sorting over the
        // cumulative list. The final (pruning) publish happens after the loop.
        const now = Date.now()
        const shouldReveal = !isLastPage && (
          lastRevealAt === 0 || now - lastRevealAt >= FULL_TRACK_REVEAL_INTERVAL_MS
        )
        if (shouldReveal) {
          lastRevealAt = now
        }

        set((state) => {
          if (requestId !== fullTracksRequestId || state.fullTrackConsumers.size === 0) {
            return {}
          }
          const patch: Parameters<typeof ingestTracksForPatch>[2] = {}
          if (shouldReveal) {
            patch.fullTrackPaths = paths.slice()
            const shouldUseAsVisibleTracks = !state.selectedAlbum && !state.selectedArtist && !state.selectedGenre && (
              state.viewMode === 'tracks' || state.viewMode === 'genres' || state.viewMode === 'folders'
            )
            if (shouldUseAsVisibleTracks) {
              patch.trackPaths = paths.slice()
            }
          }
          return ingestTracksForPatch(state, page.tracks, patch, { mutate: true, prune: false })
        })

        if (isLastPage) {
          break
        }

        const nextOffset = Number(page.nextOffset)
        offset = Number.isFinite(nextOffset) && nextOffset > offset
          ? Math.trunc(nextOffset)
          : offset + page.tracks.length
      }

      completed = true
      set((state) => {
        if (requestId !== fullTracksRequestId || state.fullTrackConsumers.size === 0) {
          return {}
        }

        const shouldUseAsVisibleTracks = !state.selectedAlbum && !state.selectedArtist && !state.selectedGenre && (
          state.viewMode === 'tracks' || state.viewMode === 'genres' || state.viewMode === 'folders'
        )
        return finalizeTrackCachePatch(state, {
          fullTrackPaths: paths,
          fullTracksStatus: 'complete',
          ...(shouldUseAsVisibleTracks ? { trackPaths: paths } : {})
        }, state.trackByPath, false)
      })
    } finally {
      if (!completed && requestId === fullTracksRequestId) {
        set((state) => (state.fullTracksStatus === 'loading' ? { fullTracksStatus: 'idle' } : {}))
      }
    }
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

  loadTrackDuration: async () => {
    try {
      const totalTrackDuration = await window.electronAPI.library.getTotalTrackDuration()
      if (typeof totalTrackDuration !== 'number' || !Number.isFinite(totalTrackDuration) || totalTrackDuration < 0) {
        return
      }
      set({ totalTrackDuration })
    } catch (error) {
      console.error('Failed to load library track duration:', error)
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

  loadGenres: async () => {
    const genres = await window.electronAPI.library.getGenres()
    set({ genres })
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

  // Toggle a folder's visibility. Hidden folders stay indexed; their tracks are filtered out of
  // the browsable library in LibraryView. Applies immediately — no rescan or library reload.
  setFolderHidden: async (path: string, hidden: boolean) => {
    // Optimistically flip visibility so the checkbox and library filters react instantly.
    set((state) => ({
      folders: state.folders.map((folder) =>
        folder.path === path ? { ...folder, hidden: hidden ? 1 : 0 } : folder
      )
    }))

    const result = await window.electronAPI.library.setFolderHidden(path, hidden)
    if (!result.success) {
      // Revert the optimistic change if the write failed.
      set((state) => ({
        folders: state.folders.map((folder) =>
          folder.path === path ? { ...folder, hidden: hidden ? 0 : 1 } : folder
        )
      }))
    }
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
      scanStage: { stage: 'scanning', message: 'Rewriting library metadata...' },
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
      const isLeavingRootTracks = state.viewMode === 'tracks'
        && !state.selectedAlbum
        && !state.selectedArtist
        && !state.selectedGenre
        && state.selectedYear === null
      const tracksViewSortState = isLeavingRootTracks
        ? state.trackListSortState
        : state.tracksViewSortState

      // Allow detail navigation helpers to switch base mode to tracks without discarding active detail selection.
      if ((state.selectedAlbum || state.selectedArtist || state.selectedGenre) && mode === 'tracks') {
        return {
          viewMode: mode,
          trackListSortState: { ...DEFAULT_TRACK_LIST_SORT_STATE },
          tracksViewSortState: tracksViewSortState ? { ...tracksViewSortState } : null
        }
      }

      return {
        viewMode: mode,
        trackPaths: mode === 'tracks' || mode === 'genres' || mode === 'folders' ? state.fullTrackPaths : [],
        selectedAlbum: null,
        selectedArtist: null,
        selectedGenre: null,
        selectedYear: null,
        selectionOrigin: null,
        selectionHistory: [],
        selectionForwardHistory: [],
        trackListSortState: mode === 'tracks'
          ? { ...(tracksViewSortState ?? DEFAULT_TRACK_LIST_SORT_STATE) }
          : { ...DEFAULT_TRACK_LIST_SORT_STATE },
        tracksViewSortState: tracksViewSortState ? { ...tracksViewSortState } : null
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
    set((state) => ingestTracksForPatch(state, tracks, {
      selectedAlbum: {
        identity_key: identityKey,
        album,
        artist: artist ?? '',
        is_new: matchedAlbum?.is_new ?? false
      },
      trackPaths: getUniqueTrackPaths(tracks),
      selectedArtist: null,
      selectedGenre: null,
      selectedYear: null,
      selectionOrigin: origin,
      selectionHistory: appendSelectionHistory(state.selectionHistory, snapshotCurrentSelection(state)),
      selectionForwardHistory: [],
      trackListSortState: null
    }))
  },

  // Select artist
  selectArtist: async (artist: string, origin: Exclude<SelectionOrigin, null> = 'library') => {
    const mode = get().artistBrowseMode
    const tracks = await window.electronAPI.library.getTracksByArtist(artist, mode)
    set((state) => ingestTracksForPatch(state, tracks, {
      selectedArtist: artist,
      trackPaths: getUniqueTrackPaths(tracks),
      selectedAlbum: null,
      selectedGenre: null,
      selectedYear: null,
      selectionOrigin: origin,
      selectionHistory: appendSelectionHistory(state.selectionHistory, snapshotCurrentSelection(state)),
      selectionForwardHistory: [],
      trackListSortState: { ...DEFAULT_TRACK_LIST_SORT_STATE }
    }))
  },

  selectGenre: async (genre: string, origin: Exclude<SelectionOrigin, null> = 'library') => {
    const tracks = await window.electronAPI.library.getTracksByGenre(genre)
    set((state) => ingestTracksForPatch(state, tracks, {
      selectedGenre: genre,
      trackPaths: getUniqueTrackPaths(tracks),
      selectedAlbum: null,
      selectedArtist: null,
      selectedYear: null,
      selectionOrigin: origin,
      selectionHistory: appendSelectionHistory(state.selectionHistory, snapshotCurrentSelection(state)),
      selectionForwardHistory: [],
      trackListSortState: { ...DEFAULT_TRACK_LIST_SORT_STATE }
    }))
  },

  selectYear: async (year: LibraryYearKey, origin: Exclude<SelectionOrigin, null> = 'library') => {
    const tracks = await window.electronAPI.library.getTracksByYear(year === 'unknown' ? null : year)
    set((state) => ingestTracksForPatch(state, tracks, {
      selectedYear: year,
      selectedAlbum: null,
      selectedArtist: null,
      selectedGenre: null,
      trackPaths: getUniqueTrackPaths(tracks),
      selectionOrigin: origin,
      selectionHistory: appendSelectionHistory(state.selectionHistory, snapshotCurrentSelection(state)),
      selectionForwardHistory: [],
      trackListSortState: { ...DEFAULT_TRACK_LIST_SORT_STATE }
    }))
  },

  releaseFullTracks: (consumer?: LibraryFullTrackConsumer) => {
    set((state) => {
      const nextConsumers = updateFullTrackConsumers(state.fullTrackConsumers, consumer, 'release')
      if (!nextConsumers.shouldReleaseFullTracks) {
        return nextConsumers.changed ? { fullTrackConsumers: nextConsumers.consumers } : {}
      }

      fullTracksRequestId += 1
      return finalizeTrackCachePatch(state, {
        fullTrackConsumers: nextConsumers.consumers,
        fullTrackPaths: [],
        fullTracksStatus: 'idle',
        ...(!state.selectedAlbum && !state.selectedArtist && !state.selectedGenre && state.selectedYear === null
          ? { trackPaths: [] }
          : {})
      }, state.trackByPath, false)
    })
  },

  // Clear selection
  clearSelection: async () => {
    set((state) => ({
      selectedAlbum: null,
      selectedArtist: null,
      selectedGenre: null,
      selectedYear: null,
      selectionOrigin: null,
      selectionHistory: [],
      selectionForwardHistory: [],
      trackPaths: state.viewMode === 'tracks' || state.viewMode === 'genres' || state.viewMode === 'folders' ? state.fullTrackPaths : [],
      trackListSortState: state.viewMode === 'tracks'
        ? { ...(state.tracksViewSortState ?? DEFAULT_TRACK_LIST_SORT_STATE) }
        : { ...DEFAULT_TRACK_LIST_SORT_STATE }
    }))
  },

  // Restore previous detail selection when available.
  goBackSelection: async () => {
    const state = get()
    const current = snapshotCurrentSelection(state)
    if (!current) return false
    const historyLength = state.selectionHistory.length
    if (historyLength === 0) {
      set((latest) => ({
        selectedAlbum: null,
        selectedArtist: null,
        selectedGenre: null,
        selectedYear: null,
        selectionOrigin: null,
        trackPaths: state.viewMode === 'tracks' || state.viewMode === 'genres' || state.viewMode === 'folders' ? state.fullTrackPaths : [],
        selectionForwardHistory: appendSelectionHistory(state.selectionForwardHistory, current),
        trackListSortState: state.viewMode === 'tracks'
          ? { ...(latest.tracksViewSortState ?? DEFAULT_TRACK_LIST_SORT_STATE) }
          : { ...DEFAULT_TRACK_LIST_SORT_STATE }
      }))
      return true
    }

    const previous = state.selectionHistory[historyLength - 1]
    if (!previous) return false

    const restoredTracks = resolveTracksFromSelectionSnapshot(previous, state.trackByPath)
    const restoredAlbum = previous.selectedAlbum ? { ...previous.selectedAlbum } : null
    const restoredArtist = previous.selectedArtist
    const restoredGenre = previous.selectedGenre
    const restoredYear = previous.selectedYear

    set({
      selectedAlbum: restoredAlbum,
      selectedArtist: restoredArtist,
      selectedGenre: restoredGenre,
      selectedYear: restoredYear,
      selectionOrigin: previous.selectionOrigin,
      trackPaths: restoredTracks.tracks.map((track) => track.path),
      selectionHistory: state.selectionHistory.slice(0, -1),
      selectionForwardHistory: appendSelectionHistory(state.selectionForwardHistory, current),
      trackListSortState: restoredAlbum ? null : { ...DEFAULT_TRACK_LIST_SORT_STATE }
    })

    if (restoredArtist) {
      const mode = get().artistBrowseMode
      const tracks = await window.electronAPI.library.getTracksByArtist(restoredArtist, mode)
      set((state) => {
        if (state.selectedArtist !== restoredArtist) return {}
        if (state.artistBrowseMode !== mode) return {}
        return ingestTracksForPatch(state, tracks, { trackPaths: getUniqueTrackPaths(tracks) })
      })
    } else if (restoredGenre) {
      const tracks = await window.electronAPI.library.getTracksByGenre(restoredGenre)
      set((state) => {
        if (state.selectedGenre !== restoredGenre) return {}
        return ingestTracksForPatch(state, tracks, { trackPaths: getUniqueTrackPaths(tracks) })
      })
    } else if (restoredYear !== null && !restoredTracks.complete) {
      const tracks = await window.electronAPI.library.getTracksByYear(restoredYear === 'unknown' ? null : restoredYear)
      set((state) => {
        if (state.selectedYear !== restoredYear) return {}
        return ingestTracksForPatch(state, tracks, { trackPaths: getUniqueTrackPaths(tracks) })
      })
    } else if (restoredAlbum && !restoredTracks.complete) {
      const tracks = await window.electronAPI.library.getTracksByAlbum(
        restoredAlbum.album,
        restoredAlbum.artist,
        restoredAlbum.identity_key
      )
      set((state) => {
        if (!isSameAlbumSelection(state.selectedAlbum, restoredAlbum)) return {}
        return ingestTracksForPatch(state, tracks, { trackPaths: getUniqueTrackPaths(tracks) })
      })
    }

    return true
  },

  goForwardSelection: async () => {
    const state = get()
    const forwardLength = state.selectionForwardHistory.length
    if (forwardLength === 0) return false

    const next = state.selectionForwardHistory[forwardLength - 1]
    if (!next) return false
    const current = snapshotCurrentSelection(state)
    const restoredTracks = resolveTracksFromSelectionSnapshot(next, state.trackByPath)
    const restoredAlbum = next.selectedAlbum ? { ...next.selectedAlbum } : null
    const restoredArtist = next.selectedArtist
    const restoredGenre = next.selectedGenre
    const restoredYear = next.selectedYear

    set({
      selectedAlbum: restoredAlbum,
      selectedArtist: restoredArtist,
      selectedGenre: restoredGenre,
      selectedYear: restoredYear,
      selectionOrigin: next.selectionOrigin,
      trackPaths: restoredTracks.tracks.map((track) => track.path),
      selectionHistory: appendSelectionHistory(state.selectionHistory, current),
      selectionForwardHistory: state.selectionForwardHistory.slice(0, -1),
      trackListSortState: restoredAlbum ? null : { ...DEFAULT_TRACK_LIST_SORT_STATE }
    })

    if (restoredArtist) {
      const mode = get().artistBrowseMode
      const tracks = await window.electronAPI.library.getTracksByArtist(restoredArtist, mode)
      set((latest) => {
        if (latest.selectedArtist !== restoredArtist || latest.artistBrowseMode !== mode) return {}
        return ingestTracksForPatch(latest, tracks, { trackPaths: getUniqueTrackPaths(tracks) })
      })
    } else if (restoredGenre) {
      const tracks = await window.electronAPI.library.getTracksByGenre(restoredGenre)
      set((latest) => {
        if (latest.selectedGenre !== restoredGenre) return {}
        return ingestTracksForPatch(latest, tracks, { trackPaths: getUniqueTrackPaths(tracks) })
      })
    } else if (restoredYear !== null && !restoredTracks.complete) {
      const tracks = await window.electronAPI.library.getTracksByYear(restoredYear === 'unknown' ? null : restoredYear)
      set((latest) => {
        if (latest.selectedYear !== restoredYear) return {}
        return ingestTracksForPatch(latest, tracks, { trackPaths: getUniqueTrackPaths(tracks) })
      })
    } else if (restoredAlbum && !restoredTracks.complete) {
      const tracks = await window.electronAPI.library.getTracksByAlbum(
        restoredAlbum.album,
        restoredAlbum.artist,
        restoredAlbum.identity_key
      )
      set((latest) => {
        if (!isSameAlbumSelection(latest.selectedAlbum, restoredAlbum)) return {}
        return ingestTracksForPatch(latest, tracks, { trackPaths: getUniqueTrackPaths(tracks) })
      })
    }

    return true
  },

  // Search
  search: async (query: string) => {
    set({ searchQuery: query })
    if (query.trim()) {
      const searchResults = await window.electronAPI.library.search(query)
      const paths = getUniqueTrackPaths(searchResults)
      set((state) => ingestTracksForPatch(state, searchResults, { searchResultPaths: paths }))
    } else {
      set((state) => finalizeTrackCachePatch(state, { searchResultPaths: [] }, state.trackByPath, false))
    }
  },

  // Clear search
  clearSearch: () => {
    set((state) => finalizeTrackCachePatch(state, { searchQuery: '', searchResultPaths: [] }, state.trackByPath, false))
  },

  resolveTrackPaths: (trackPaths: readonly string[]) => {
    return resolveCachedTrackPaths(trackPaths, get().trackByPath).tracks
  },

  resolveTrackPathsWithFetch: async (trackPaths: readonly string[]) => {
    const cached = resolveCachedTrackPaths(trackPaths, get().trackByPath)
    if (cached.complete) return cached.tracks

    const missingPaths: string[] = []
    const seenMissingPaths = new Set<string>()
    const trackByPath = get().trackByPath
    for (const trackPath of trackPaths) {
      if (typeof trackPath !== 'string' || trackPath.length === 0) continue
      if (trackByPath.has(trackPath) || seenMissingPaths.has(trackPath)) continue
      seenMissingPaths.add(trackPath)
      missingPaths.push(trackPath)
    }

    if (missingPaths.length === 0) {
      return cached.tracks
    }

    try {
      const fetchedTracks = await window.electronAPI.library.getTracksByPaths(missingPaths)
      if (fetchedTracks.length > 0) {
        set((state) => ingestTracksForPatch(state, fetchedTracks, {}, { prune: false }))
      }
    } catch (error) {
      console.error('Failed to hydrate library tracks by path:', error)
    }

    return resolveCachedTrackPaths(trackPaths, get().trackByPath).tracks
  },

  // Get artwork URL (with caching)
  getArtwork: async (hash: string | null, options?: ArtworkRequestOptions) => {
    if (!hash) return null
    const variant: ArtworkVariant = options?.variant ?? 'card'
    const format: ArtworkResponseFormat = options?.format ?? 'object-url'

    // Displayable URLs are deterministic; the astra-artwork protocol serves
    // the bytes and Chromium handles caching. May 404 for missing art, so
    // consumers need an error fallback.
    if (format === 'object-url') {
      return buildArtworkProtocolUrl(hash, variant)
    }

    // Data URLs still go over IPC for consumers that ship artwork outside
    // this renderer (media session, remote controller snapshots).
    const requestKey = getArtworkRequestKey(getArtworkCacheKey(hash, variant), format)
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
      .then((dataUrl) => dataUrl ?? null)
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
    const favoriteTrackPaths = getUniqueTrackPaths(favoriteTracks)
    set((state) => ingestTracksForPatch(state, favoriteTracks, {
      favorites: new Set(paths),
      favoriteTrackPaths
    }))
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
    const favoriteTrackPaths = getUniqueTrackPaths(favoriteTracks)
    set((state) => ingestTracksForPatch(state, favoriteTracks, { favoriteTrackPaths }))
  },

  // Sync check if track is a favorite
  isFavorite: (trackPath: string) => {
    return get().favorites.has(trackPath)
  },

  // Load recently played tracks
  loadRecentlyPlayed: async () => {
    const recentlyPlayed = await window.electronAPI.library.getRecentlyPlayed(RECENTLY_PLAYED_FETCH_LIMIT)
    const recentlyPlayedPaths = getUniqueTrackPaths(recentlyPlayed)
    set((state) => ingestTracksForPatch(state, recentlyPlayed, { recentlyPlayedPaths }))
  },

  markTrackLatestSyncSeen: async (trackPath: string) => {
    if (!trackPath.trim()) return

    const knownTrack = get().trackByPath.get(trackPath)
    if (knownTrack && !knownTrack.is_new) {
      return
    }

    await window.electronAPI.library.markTrackLatestSyncSeen(trackPath)

    let albumTracks: DbTrack[] | null = null
    const albumIdentityKey = knownTrack?.album_identity_key ?? null
    if (knownTrack && albumIdentityKey && !hasAlbumCoverage(get(), albumIdentityKey)) {
      albumTracks = await window.electronAPI.library.getTracksByAlbum(
        knownTrack.album,
        getAlbumArtistForTrackLookup(knownTrack),
        albumIdentityKey
      )
    }

    set((state) => {
      const matchedTrack = state.trackByPath.get(trackPath)
      const resolvedAlbumIdentityKey = albumIdentityKey ?? matchedTrack?.album_identity_key ?? null
      const cleared = clearTrackNewFlagInCache(state.trackByPath, trackPath)
      const ingested = albumTracks
        ? ingestTracksIntoCache(cleared.trackByPath, albumTracks)
        : { trackByPath: cleared.trackByPath, changed: false }
      const coveragePaths = albumTracks
        ? getUniqueTrackPaths(albumTracks)
        : getAlbumCoveragePaths(state, resolvedAlbumIdentityKey)
      const albumIsNew = computeAlbumIsNew(ingested.trackByPath, coveragePaths, resolvedAlbumIdentityKey)

      return {
        ...finalizeTrackCachePatch(state, {}, ingested.trackByPath, cleared.changed || ingested.changed),
        albums: updateAlbumNewFlagInCollection(state.albums, resolvedAlbumIdentityKey, albumIsNew),
        albumsIncludingSingles: updateAlbumNewFlagInCollection(state.albumsIncludingSingles, resolvedAlbumIdentityKey, albumIsNew),
        selectedAlbum: updateSelectedAlbumNewFlag(state.selectedAlbum, resolvedAlbumIdentityKey, albumIsNew),
        selectionHistory: updateSelectionHistoryForSeenTrack(
          state.selectionHistory,
          resolvedAlbumIdentityKey,
          albumIsNew
        ),
        selectionForwardHistory: updateSelectionHistoryForSeenTrack(
          state.selectionForwardHistory,
          resolvedAlbumIdentityKey,
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
    const recentlyPlayedPaths = getUniqueTrackPaths(recentlyPlayed)
    set((state) => ingestTracksForPatch(state, recentlyPlayed, { recentlyPlayedPaths }))
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
        return ingestTracksForPatch(state, tracks, { trackPaths: getUniqueTrackPaths(tracks) })
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

  setShowTracklistGenre: (enabled: boolean) => {
    const normalized = Boolean(enabled)
    set({ showTracklistGenre: normalized })

    try {
      localStorage.setItem(TRACKLIST_GENRE_VISIBILITY_STORAGE_KEY, normalized ? '1' : '0')
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

  setShowTracklistPlayCount: (enabled: boolean) => {
    const normalized = Boolean(enabled)
    set({ showTracklistPlayCount: normalized })

    try {
      localStorage.setItem(TRACKLIST_PLAY_COUNT_VISIBILITY_STORAGE_KEY, normalized ? '1' : '0')
    } catch {
      // Ignore localStorage write failures in restricted environments.
    }
  },

  setTrackListSortState: (sortState: LibraryTrackListSortState | null) => {
    const normalized = sortState ? normalizeTrackSortState(sortState) : null
    set((state) => {
      const isRootTracks = state.viewMode === 'tracks'
        && !state.selectedAlbum
        && !state.selectedArtist
        && !state.selectedGenre
        && state.selectedYear === null
      return {
        trackListSortState: normalized,
        ...(isRootTracks
          ? { tracksViewSortState: normalized ? { ...normalized } : null }
          : {})
      }
    })
  },

  resetTrackListSortState: () => {
    set((state) => {
      const trackListSortState = state.selectedAlbum ? null : { ...DEFAULT_TRACK_LIST_SORT_STATE }
      const isRootTracks = state.viewMode === 'tracks'
        && !state.selectedAlbum
        && !state.selectedArtist
        && !state.selectedGenre
        && state.selectedYear === null
      return {
        trackListSortState,
        ...(isRootTracks ? { tracksViewSortState: trackListSortState } : {})
      }
    })
  },

  setSelectedSourceFilters: (filters: Iterable<string>) => {
    const next = normalizeSourceFilters(filters)
    set((state) => (
      areStringSetsEqual(state.selectedSourceFilters, next)
        ? {}
        : { selectedSourceFilters: next }
    ))
  },

  clearSelectedSourceFilters: () => {
    set((state) => (
      state.selectedSourceFilters.size === 0
        ? {}
        : { selectedSourceFilters: new Set<string>() }
    ))
  },

  toggleSourceFilter: (filterKey: string) => {
    if (!filterKey.trim()) return
    set((state) => {
      const next = new Set(state.selectedSourceFilters)
      if (next.has(filterKey)) {
        next.delete(filterKey)
      } else {
        next.add(filterKey)
      }
      return { selectedSourceFilters: next }
    })
  },

  setAlbumSortMode: (mode: LibraryAlbumSortMode) => {
    const normalized = normalizeAlbumSortMode(mode)
    persistStringPreference(ALBUM_SORT_MODE_STORAGE_KEY, normalized)
    set({ albumSortMode: normalized })
  },

  setIncludeSinglesInAlbums: (enabled: boolean) => {
    const normalized = Boolean(enabled)
    persistBooleanPreference(INCLUDE_SINGLES_IN_ALBUMS_STORAGE_KEY, normalized)
    set({ includeSinglesInAlbums: normalized })
  },

  setIncludeCollabArtists: (enabled: boolean) => {
    const normalized = Boolean(enabled)
    persistBooleanPreference(INCLUDE_COLLAB_ARTISTS_STORAGE_KEY, normalized)
    set({ includeCollabArtists: normalized })
  },

  setArtistRootViewMode: (mode: LibraryArtistRootViewMode) => {
    const normalized = normalizeArtistRootViewMode(mode)
    persistStringPreference(ARTIST_ROOT_VIEW_MODE_STORAGE_KEY, normalized)
    set({ artistRootViewMode: normalized })
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
  },

  getSessionSnapshot: () => {
    const state = get()
    return {
      viewMode: state.viewMode,
      selectedAlbum: state.selectedAlbum ? { ...state.selectedAlbum } : null,
      selectedArtist: state.selectedArtist,
      selectedGenre: state.selectedGenre,
      selectedYear: state.selectedYear,
      trackListSortState: state.trackListSortState ? { ...state.trackListSortState } : null,
      tracksViewSortState: state.tracksViewSortState ? { ...state.tracksViewSortState } : null,
      selectedSourceFilters: [...state.selectedSourceFilters],
      albumSortMode: state.albumSortMode,
      includeSinglesInAlbums: state.includeSinglesInAlbums,
      includeCollabArtists: state.includeCollabArtists,
      artistRootViewMode: state.artistRootViewMode
    }
  },

  restoreSession: async (snapshot: LibrarySessionSnapshot) => {
    const normalizedSortState = normalizeTrackSortState(snapshot.trackListSortState)
    const isRootTracksSnapshot = snapshot.viewMode === 'tracks'
      && !snapshot.selectedAlbum
      && !snapshot.selectedArtist
      && !snapshot.selectedGenre
      && snapshot.selectedYear === null
    const tracksViewSortState = normalizeTrackSortState(snapshot.tracksViewSortState)
      ?? (isRootTracksSnapshot ? normalizedSortState : null)
      ?? { ...DEFAULT_TRACK_LIST_SORT_STATE }
    const selectedSourceFilters = normalizeSourceFilters(snapshot.selectedSourceFilters)
    const albumSortMode = normalizeAlbumSortMode(snapshot.albumSortMode)
    const artistRootViewMode = normalizeArtistRootViewMode(snapshot.artistRootViewMode)
    const basePatch = {
      viewMode: snapshot.viewMode,
      selectedAlbum: null,
      selectedArtist: null,
      selectedGenre: null,
      selectedYear: null,
      selectionOrigin: null,
      selectionHistory: [],
      selectionForwardHistory: [],
      trackListSortState: isRootTracksSnapshot
        ? { ...tracksViewSortState }
        : normalizedSortState,
      tracksViewSortState: { ...tracksViewSortState },
      selectedSourceFilters,
      albumSortMode,
      includeSinglesInAlbums: Boolean(snapshot.includeSinglesInAlbums),
      includeCollabArtists: Boolean(snapshot.includeCollabArtists),
      artistRootViewMode
    }

    persistStringPreference(ALBUM_SORT_MODE_STORAGE_KEY, albumSortMode)
    persistBooleanPreference(INCLUDE_SINGLES_IN_ALBUMS_STORAGE_KEY, Boolean(snapshot.includeSinglesInAlbums))
    persistBooleanPreference(INCLUDE_COLLAB_ARTISTS_STORAGE_KEY, Boolean(snapshot.includeCollabArtists))
    persistStringPreference(ARTIST_ROOT_VIEW_MODE_STORAGE_KEY, artistRootViewMode)

    if (snapshot.selectedAlbum) {
      const selectedAlbum = snapshot.selectedAlbum
      const matchedAlbum = get().albums.find((candidate) => {
        if (selectedAlbum.identity_key && candidate.identity_key === selectedAlbum.identity_key) return true
        return candidate.album === selectedAlbum.album && candidate.artist === selectedAlbum.artist
      })
      const tracks = await window.electronAPI.library.getTracksByAlbum(
        selectedAlbum.album,
        selectedAlbum.artist,
        selectedAlbum.identity_key
      )

      if (matchedAlbum || tracks.length > 0) {
        set((state) => ingestTracksForPatch(state, tracks, {
          ...basePatch,
          selectedAlbum: {
            ...selectedAlbum,
            is_new: matchedAlbum?.is_new ?? selectedAlbum.is_new ?? false
          },
          trackPaths: getUniqueTrackPaths(tracks)
        }))
        return
      }
    }

    if (snapshot.selectedArtist) {
      const selectedArtistKey = normalizeKey(snapshot.selectedArtist)
      const matchedArtist = get().artists.some((artist) => normalizeKey(artist.artist) === selectedArtistKey)
      const tracks = matchedArtist
        ? await window.electronAPI.library.getTracksByArtist(snapshot.selectedArtist, get().artistBrowseMode)
        : []

      if (matchedArtist || tracks.length > 0) {
        set((state) => ingestTracksForPatch(state, tracks, {
          ...basePatch,
          selectedArtist: snapshot.selectedArtist,
          trackPaths: getUniqueTrackPaths(tracks)
        }))
        return
      }
    }

    if (snapshot.selectedGenre) {
      const selectedGenreKey = normalizeKey(snapshot.selectedGenre)
      const matchedGenre = get().genres.some((genre) => normalizeKey(genre.genre) === selectedGenreKey)
      const tracks = matchedGenre
        ? await window.electronAPI.library.getTracksByGenre(snapshot.selectedGenre)
        : []

      if (matchedGenre || tracks.length > 0) {
        set((state) => ingestTracksForPatch(state, tracks, {
          ...basePatch,
          selectedGenre: snapshot.selectedGenre,
          trackPaths: getUniqueTrackPaths(tracks)
        }))
        return
      }
    }

    if (snapshot.selectedYear !== null) {
      const restoredYear = snapshot.selectedYear
      if (snapshot.includeSinglesInAlbums && !get().albumsIncludingSinglesLoaded) {
        await get().loadAlbumsIncludingSingles()
      }
      const yearAlbums = snapshot.includeSinglesInAlbums
        ? get().albumsIncludingSingles
        : get().albums
      const matchedYear = yearAlbums.some((album) => albumMatchesLibraryYear(album, restoredYear))
      if (matchedYear) {
        const tracks = await window.electronAPI.library.getTracksByYear(restoredYear === 'unknown' ? null : restoredYear)
        set((state) => ingestTracksForPatch(state, tracks, {
          ...basePatch,
          selectedYear: restoredYear,
          trackPaths: getUniqueTrackPaths(tracks)
        }))
        return
      }
    }

    set((state) => ({
      ...basePatch,
      trackPaths: snapshot.viewMode === 'tracks' || snapshot.viewMode === 'genres' || snapshot.viewMode === 'folders'
        ? state.fullTrackPaths
        : []
    }))
  }
}))

export function getLibraryDiagnosticsSnapshot(): {
  totalTrackCount: number
  visibleTrackCount: number
  fullTrackCount: number
  albumCount: number
  artistCount: number
  genreCount: number
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
    visibleTrackCount: state.trackPaths.length,
    fullTrackCount: state.fullTrackPaths.length,
    albumCount: state.albums.length,
    artistCount: state.artists.length,
    genreCount: state.genres.length,
    folderCount: state.folders.length,
    favoriteCount: state.favorites.size,
    favoriteTrackCount: state.favoriteTrackPaths.length,
    recentlyPlayedCount: state.recentlyPlayedPaths.length,
    searchResultCount: state.searchResultPaths.length,
    selectionHistoryCount: state.selectionHistory.length,
    selectionHistoryTrackCount,
    selectedDetailTrackCount: state.selectedAlbum || state.selectedArtist || state.selectedGenre ? state.trackPaths.length : 0,
    scanInProgress: state.isScanning,
    caches: {
      // Renderer artwork byte caches were removed with the astra-artwork
      // protocol migration; Chromium owns image caching now. Shape kept for
      // the memory diagnostics CSV.
      artworkFullEntries: 0,
      artworkFullBytes: 0,
      artworkThumbnailEntries: 0,
      artworkThumbnailBytes: 0,
      artworkCardEntries: 0,
      artworkCardBytes: 0,
      artworkRequests: artworkRequestCache.size
    }
  }
}
