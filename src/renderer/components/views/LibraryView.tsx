import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type UIEvent as ReactUIEvent } from 'react'
import {
  useLibraryStore,
  type LibraryArtistBrowseMode,
  type LibrarySelectionRequest
} from '../../stores/libraryStore'
import { usePlayerStore, type PlaybackSourceContext } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import { useSubsonicSettingsStore } from '../../stores/subsonicSettingsStore'
import { useJellyfinSettingsStore } from '../../stores/jellyfinSettingsStore'
import { useGraphStore } from '../../stores/graphStore'
import { useRatingsStore } from '../../stores/ratingsStore'
import { useHorizontalWheelScroll } from '../../hooks/useHorizontalWheelScroll'
import { usePresence } from '../../hooks/usePresence'
import { buildAlbumIdentityKeyFromTrack, buildAlbumKey, getAlbumIdentityArtist, normalizeKey, splitCollaborators } from '../../utils/albumIdentity'
import { compareAlbumsByYearDescending } from '../../utils/albumYearSort'
import { partitionArtistDiscography } from '../../utils/artistDiscography'
import { formatCompactTotalTrackDuration } from '../../utils/collectionDuration'
import { matchesFuzzyFields } from '../../utils/fuzzySearch'
import { isSameOrDescendantFsPath } from '../../utils/folderTree'
import { compareBaseLocaleText } from '../../utils/localeSort'
import { runViewTransition } from '../../utils/viewTransitions'
import { compareTrackPlayCounts } from '../../utils/trackPlayCountSort'
import {
  compareAlbumsBySortState,
  getDefaultAlbumSortDirection,
  type AlbumSortKey
} from '../../utils/albumSort'
import { getLibraryTabTransitionScopeClasses } from '../../utils/libraryTabMotion'
import { getDetailHeaderCollapseDistance, resolveDetailHeaderCollapsed } from '../../utils/detailHeaderScroll'
import {
  albumMatchesLibraryYear,
  buildLibraryYearGroups,
  filterTracksByLibraryYearAlbums,
  formatLibraryYearKey,
  type LibraryYearGroup
} from '../../utils/libraryYears'
import {
  bindLibraryScrollRestoration,
  resolveLibraryScrollContextKey
} from '../../utils/libraryScrollRestoration'
import TrackList, { type TrackListSortKey, type TrackListViewportAPI } from '../library/TrackList'
import AlbumArtwork from '../library/AlbumArtwork'
import QueueSplitButton from '../queue/QueueSplitButton'
import AlbumGrid, { type AlbumGridViewportAPI } from '../library/AlbumGrid'
import ArtistList, { type ArtistListViewportAPI } from '../library/ArtistList'
import FolderTreeView from '../library/FolderTreeView'
import GenreGrid, { type GenreGridViewportAPI } from '../library/GenreGrid'
import YearAlbumPreview from '../library/YearAlbumPreview'
import YearGrid, { type YearGridViewportAPI } from '../library/YearGrid'
import RootTrackTableControls from '../library/RootTrackTableControls'
import {
  getVisibleRootTrackColumnIds,
  normalizeTrackSortRules,
  replaceTrackSortRulesFromHeader,
  type RootTrackColumnId
} from '../../utils/rootTrackTable'
import { compareTracksBySortRules } from '../../utils/trackSort'

type SortDirection = 'asc' | 'desc'
type ArtistAlbumRailMode = 'albums' | 'singles' | 'featured'

function formatTrackCount(count: number): string {
  return `${count} ${count === 1 ? 'track' : 'tracks'}`
}

function normalizeSortText(value: string | null | undefined): string {
  return (value ?? '').trim()
}

function compareTextValue(a: string | null | undefined, b: string | null | undefined): number {
  return compareBaseLocaleText(normalizeSortText(a), normalizeSortText(b))
}

function compareWithDirection(value: number, direction: SortDirection): number {
  return direction === 'asc' ? value : -value
}

function toSortableBpm(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value
}

function toSortableDuration(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value
}

function compareNullableBpm(a: number | null | undefined, b: number | null | undefined, direction: SortDirection): number {
  const aValue = toSortableBpm(a)
  const bValue = toSortableBpm(b)
  const aMissing = aValue === null
  const bMissing = bValue === null

  if (aMissing && bMissing) return 0
  if (aMissing) return 1
  if (bMissing) return -1

  return compareWithDirection(aValue - bValue, direction)
}

function compareNullableRating(a: number | null | undefined, b: number | null | undefined, direction: SortDirection): number {
  const aMissing = typeof a !== 'number'
  const bMissing = typeof b !== 'number'

  if (aMissing && bMissing) return 0
  if (aMissing) return 1
  if (bMissing) return -1

  return compareWithDirection(a - b, direction)
}

function compareNullableDuration(a: number | null | undefined, b: number | null | undefined, direction: SortDirection): number {
  const aValue = toSortableDuration(a)
  const bValue = toSortableDuration(b)
  const aMissing = aValue === null
  const bMissing = bValue === null

  if (aMissing && bMissing) return 0
  if (aMissing) return 1
  if (bMissing) return -1

  return compareWithDirection(aValue - bValue, direction)
}

function resolveEffectiveAddedAt(
  track: { source_type: 'local' | 'subsonic' | 'jellyfin'; file_created_at: number | null; added_at: number }
): number {
  if (track.source_type === 'local' && typeof track.file_created_at === 'number' && Number.isFinite(track.file_created_at) && track.file_created_at > 0) {
    return track.file_created_at
  }
  return track.added_at
}

function compareAddedAt(
  a: { source_type: 'local' | 'subsonic' | 'jellyfin'; file_created_at: number | null; added_at: number },
  b: { source_type: 'local' | 'subsonic' | 'jellyfin'; file_created_at: number | null; added_at: number },
  direction: SortDirection
): number {
  return compareWithDirection(resolveEffectiveAddedAt(a) - resolveEffectiveAddedAt(b), direction)
}

function compareNullableKey(
  a: string | null | undefined,
  b: string | null | undefined,
  direction: SortDirection
): number {
  const aValue = normalizeSortText(a)
  const bValue = normalizeSortText(b)
  const aMissing = aValue.length === 0
  const bMissing = bValue.length === 0

  if (aMissing && bMissing) return 0
  if (aMissing) return 1
  if (bMissing) return -1

  return compareWithDirection(compareBaseLocaleText(aValue, bValue), direction)
}

function comparePath(a: string, b: string): number {
  return compareBaseLocaleText(a, b)
}

function compareAlbumSequence(
  a: { disc_number: number | null; track_number: number | null; title: string; path: string },
  b: { disc_number: number | null; track_number: number | null; title: string; path: string }
): number {
  const discComparison = (a.disc_number ?? 0) - (b.disc_number ?? 0)
  if (discComparison !== 0) return discComparison

  const trackComparison = (a.track_number ?? 0) - (b.track_number ?? 0)
  if (trackComparison !== 0) return trackComparison

  const titleComparison = compareTextValue(a.title, b.title)
  if (titleComparison !== 0) return titleComparison

  return comparePath(a.path, b.path)
}

function resolveBrowseArtistForTrack(
  track: { artist: string; artist_names?: string[] | null; album_artist: string | null; album_artist_names?: string[] | null },
  mode: LibraryArtistBrowseMode
): string {
  const normalizedAlbumArtist = track.album_artist?.trim() ?? ''
  if (normalizedAlbumArtist) {
    if (mode === 'strict') return normalizedAlbumArtist
    const albumArtistContributors = splitCollaborators(normalizedAlbumArtist)
    return albumArtistContributors[0] ?? normalizedAlbumArtist
  }

  const normalizedArtist = track.artist.trim()
  if (mode === 'strict') return normalizedArtist || 'Unknown Artist'
  if (track.artist_names && track.artist_names.length > 0) return track.artist_names[0]
  if (track.album_artist_names && track.album_artist_names.length > 0) return track.album_artist_names[0]
  const artistContributors = splitCollaborators(normalizedArtist)
  return artistContributors[0] ?? (normalizedArtist || 'Unknown Artist')
}

function trackMatchesLibraryQuery(
  track: { title: string },
  query: string
): boolean {
  return matchesFuzzyFields(query, [
    { value: track.title, weight: 1.5 }
  ])
}

export default function LibraryView() {
  const trackPaths = useLibraryStore((state) => state.trackPaths)
  const fullTrackPaths = useLibraryStore((state) => state.fullTrackPaths)
  const trackCacheVersion = useLibraryStore((state) => state.trackCacheVersion)
  const resolveTrackPaths = useLibraryStore((state) => state.resolveTrackPaths)
  const totalTrackCount = useLibraryStore((state) => state.totalTrackCount)
  const albums = useLibraryStore((state) => state.albums)
  const albumsIncludingSingles = useLibraryStore((state) => state.albumsIncludingSingles)
  const albumsIncludingSinglesLoaded = useLibraryStore((state) => state.albumsIncludingSinglesLoaded)
  const artists = useLibraryStore((state) => state.artists)
  const genres = useLibraryStore((state) => state.genres)
  const folders = useLibraryStore((state) => state.folders)
  const viewMode = useLibraryStore((state) => state.viewMode)
  const selectedAlbum = useLibraryStore((state) => state.selectedAlbum)
  const selectedArtist = useLibraryStore((state) => state.selectedArtist)
  const selectedGenre = useLibraryStore((state) => state.selectedGenre)
  const selectedYear = useLibraryStore((state) => state.selectedYear)
  const selectionOrigin = useLibraryStore((state) => state.selectionOrigin)
  const selectionHistory = useLibraryStore((state) => state.selectionHistory)
  const isLoading = useLibraryStore((state) => state.isLoading)
  const isScanning = useLibraryStore((state) => state.isScanning)
  const isCancelingScan = useLibraryStore((state) => state.isCancelingScan)
  const scanProgress = useLibraryStore((state) => state.scanProgress)
  const scanStage = useLibraryStore((state) => state.scanStage)
  const cancelScan = useLibraryStore((state) => state.cancelScan)
  const rescan = useLibraryStore((state) => state.rescan)
  const loadAlbumsIncludingSingles = useLibraryStore((state) => state.loadAlbumsIncludingSingles)
  const loadFullTracks = useLibraryStore((state) => state.loadFullTracks)
  const releaseFullTracks = useLibraryStore((state) => state.releaseFullTracks)
  const setViewMode = useLibraryStore((state) => state.setViewMode)
  const prepareSelection = useLibraryStore((state) => state.prepareSelection)
  const commitPreparedSelection = useLibraryStore((state) => state.commitPreparedSelection)
  const clearSelection = useLibraryStore((state) => state.clearSelection)
  const showTracklistBpmKey = useLibraryStore((state) => state.showTracklistBpmKey)
  const showTracklistGenre = useLibraryStore((state) => state.showTracklistGenre)
  const showTracklistAddedDate = useLibraryStore((state) => state.showTracklistAddedDate)
  const showTracklistPlayCount = useLibraryStore((state) => state.showTracklistPlayCount)
  const ratingsEnabled = useRatingsStore((state) => state.enabled)
  const ratings = useRatingsStore((state) => state.ratings)
  const sortState = useLibraryStore((state) => state.trackListSortState)
  const setSortState = useLibraryStore((state) => state.setTrackListSortState)
  const tracksViewSortRules = useLibraryStore((state) => state.tracksViewSortRules)
  const setTracksViewSortRules = useLibraryStore((state) => state.setTracksViewSortRules)
  const rootTrackTableLayout = useLibraryStore((state) => state.rootTrackTableLayout)
  const setRootTrackTableLayout = useLibraryStore((state) => state.setRootTrackTableLayout)
  const selectedSourceFilters = useLibraryStore((state) => state.selectedSourceFilters)
  const setSelectedSourceFilters = useLibraryStore((state) => state.setSelectedSourceFilters)
  const clearSelectedSourceFilters = useLibraryStore((state) => state.clearSelectedSourceFilters)
  const toggleSourceFilter = useLibraryStore((state) => state.toggleSourceFilter)
  const albumSortState = useLibraryStore((state) => state.albumSortState)
  const setAlbumSortState = useLibraryStore((state) => state.setAlbumSortState)
  const includeSinglesInAlbums = useLibraryStore((state) => state.includeSinglesInAlbums)
  const setIncludeSinglesInAlbums = useLibraryStore((state) => state.setIncludeSinglesInAlbums)
  const includeCollabArtists = useLibraryStore((state) => state.includeCollabArtists)
  const setIncludeCollabArtists = useLibraryStore((state) => state.setIncludeCollabArtists)
  const artistRootViewMode = useLibraryStore((state) => state.artistRootViewMode)
  const setArtistRootViewMode = useLibraryStore((state) => state.setArtistRootViewMode)
  const subsonicSources = useSubsonicSettingsStore((state) => state.sources)
  const jellyfinSources = useJellyfinSettingsStore((state) => state.sources)

  const shuffle = usePlayerStore((s) => s.shuffle)
  const startPlaybackContextByPaths = usePlayerStore((s) => s.startPlaybackContextByPaths)
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const openCollectionQueueMenu = useUIStore((s) => s.openCollectionQueueMenu)
  const graphEnabled = useGraphStore((s) => s.enabled)
  const openFocusedGraph = useGraphStore((s) => s.openFocusedGraph)
  const libraryTrackRevealRequest = useUIStore((s) => s.libraryTrackRevealRequest)
  const clearLibraryTrackRevealRequest = useUIStore((s) => s.clearLibraryTrackRevealRequest)
  const pendingLibrarySearchQuery = useUIStore((s) => s.pendingLibrarySearchQuery)
  const consumePendingLibrarySearchQuery = useUIStore((s) => s.consumePendingLibrarySearchQuery)
  const [searchQuery, setSearchQuery] = useState('')
  const [responsiveHiddenTrackColumns, setResponsiveHiddenTrackColumns] = useState<readonly RootTrackColumnId[]>([])
  const [artistAlbumRailMode, setArtistAlbumRailMode] = useState<ArtistAlbumRailMode>('albums')
  const artistBrowseMode = useLibraryStore((state) => state.artistBrowseMode)
  const setArtistImageFromFile = useLibraryStore((state) => state.setArtistImageFromFile)
  const clearArtistImage = useLibraryStore((state) => state.clearArtistImage)
  const [isCollectionPlayPending, setIsCollectionPlayPending] = useState(false)
  const [isUpdatingArtistImage, setIsUpdatingArtistImage] = useState(false)
  const [isArtistImageMenuOpen, setIsArtistImageMenuOpen] = useState(false)
  const artistImageMenuPresence = usePresence(isArtistImageMenuOpen)
  const [isDetailHeaderCollapsed, setIsDetailHeaderCollapsed] = useState(false)
  const previousInDetailViewRef = useRef(false)
  const detailHeaderRef = useRef<HTMLDivElement | null>(null)
  const collectionPlayPendingRef = useRef(false)
  const albumViewportRef = useRef<AlbumGridViewportAPI | null>(null)
  const yearDetailViewportRef = useRef<HTMLDivElement | null>(null)
  const artistDetailViewportRef = useRef<HTMLDivElement | null>(null)
  const artistViewportRef = useRef<ArtistListViewportAPI | null>(null)
  const genreViewportRef = useRef<GenreGridViewportAPI | null>(null)
  const yearViewportRef = useRef<YearGridViewportAPI | null>(null)
  const trackViewportRef = useRef<TrackListViewportAPI | null>(null)
  const artistImageControlRef = useRef<HTMLDivElement | null>(null)
  const artistAlbumRailRef = useRef<HTMLDivElement | null>(null)
  const activeScrollBindingRef = useRef<{
    element: HTMLElement
    key: ReturnType<typeof resolveLibraryScrollContextKey>
    unbind: () => void
  } | null>(null)

  useHorizontalWheelScroll(artistAlbumRailRef)

  const trimmedSearchQuery = searchQuery.trim()
  const hasSearchQuery = trimmedSearchQuery.length > 0
  const inDetailView = Boolean(selectedAlbum || selectedArtist || selectedGenre || selectedYear !== null)
  const isAlbumRootView = viewMode === 'albums' && !selectedAlbum && !selectedArtist && !selectedGenre && selectedYear === null
  const isTrackRootView = viewMode === 'tracks' && !selectedAlbum && !selectedArtist && !selectedGenre && selectedYear === null
  const isArtistRootView = viewMode === 'artists' && !selectedAlbum && !selectedArtist && !selectedGenre && selectedYear === null
  const isGenreRootView = viewMode === 'genres' && !selectedAlbum && !selectedArtist && !selectedGenre && selectedYear === null
  const isYearRootView = viewMode === 'years' && !selectedAlbum && !selectedArtist && !selectedGenre && selectedYear === null
  const isYearDetailView = viewMode === 'years' && !selectedAlbum && !selectedArtist && !selectedGenre && selectedYear !== null
  const isReleaseBrowseView = isAlbumRootView || isYearRootView || isYearDetailView
  const isTracklistContext = Boolean(selectedAlbum || selectedArtist || selectedGenre || viewMode === 'tracks')
  const isCollectionActionContext = isTracklistContext || selectedYear !== null
  const libraryScrollContextKey = resolveLibraryScrollContextKey({
    viewMode,
    selectedAlbum,
    selectedArtist,
    selectedGenre,
    selectedYear
  })

  useEffect(() => {
    if (!isTrackRootView) return
    const visibleColumns = getVisibleRootTrackColumnIds(rootTrackTableLayout, ratingsEnabled)
    const normalizedRules = normalizeTrackSortRules(tracksViewSortRules, { visibleColumns, ratingsEnabled })
    const unchanged = normalizedRules.length === tracksViewSortRules.length
      && normalizedRules.every((rule, index) => (
        rule.key === tracksViewSortRules[index]?.key && rule.direction === tracksViewSortRules[index]?.direction
      ))
    if (!unchanged) setTracksViewSortRules(normalizedRules)
  }, [isTrackRootView, ratingsEnabled, rootTrackTableLayout, setTracksViewSortRules, tracksViewSortRules])

  // Folders the user has hidden stay indexed but are filtered out of every library browse surface.
  const hiddenFolderPrefixes = useMemo(
    () => folders.filter((folder) => folder.hidden).map((folder) => folder.path),
    [folders]
  )
  const hasHiddenFolders = hiddenFolderPrefixes.length > 0
  const visibleFolders = useMemo(
    () => (hasHiddenFolders ? folders.filter((folder) => !folder.hidden) : folders),
    [folders, hasHiddenFolders]
  )

  const shouldRetainFullTracks = !selectedAlbum && !selectedArtist && !selectedGenre && selectedYear === null && (
    viewMode === 'tracks' || viewMode === 'genres' || viewMode === 'folders'
    || selectedSourceFilters.size > 0 || hasHiddenFolders
  )
  const isFullTrackListPending = shouldRetainFullTracks && totalTrackCount > 0 && fullTrackPaths.length === 0
  const activeTrackPaths = shouldRetainFullTracks ? fullTrackPaths : trackPaths
  const tracks = useMemo(
    () => resolveTrackPaths(activeTrackPaths),
    [activeTrackPaths, resolveTrackPaths, trackCacheVersion]
  )
  // Drop tracks that live under a hidden folder using the same platform-aware path matching
  // as the folder tree, including filesystem roots and case-insensitive default filesystems.
  const visibleTracks = useMemo(() => {
    if (!hasHiddenFolders) return tracks
    return tracks.filter((track) => !hiddenFolderPrefixes.some((prefix) => (
      isSameOrDescendantFsPath(track.path, prefix, window.electronAPI.platform)
    )))
  }, [tracks, hiddenFolderPrefixes, hasHiddenFolders])
  const sortContextKey = useMemo(() => {
    if (selectedAlbum) {
      const identityKey = selectedAlbum.identity_key?.trim()
      if (identityKey) return `album:${identityKey}`
      return `album:${selectedAlbum.album.trim().toLocaleLowerCase()}::${selectedAlbum.artist.trim().toLocaleLowerCase()}`
    }
    if (selectedArtist) {
      return `artist:${selectedArtist.trim().toLocaleLowerCase()}`
    }
    if (selectedGenre) {
      return `genre:${selectedGenre.trim().toLocaleLowerCase()}`
    }
    if (selectedYear !== null) {
      return `year:${selectedYear}`
    }
    return 'library-root'
  }, [selectedAlbum, selectedArtist, selectedGenre, selectedYear])
  const playbackSourceContext = useMemo<PlaybackSourceContext | null>(() => {
    if (selectedAlbum) {
      return {
        type: 'album',
        album: selectedAlbum.album,
        albumArtist: selectedAlbum.artist || undefined,
        identityKey: selectedAlbum.identity_key
      }
    }
    if (selectedArtist) {
      return { type: 'artist', artist: selectedArtist }
    }
    if (selectedGenre) {
      return { type: 'genre', genre: selectedGenre }
    }
    return null
  }, [selectedAlbum, selectedArtist, selectedGenre])
  const sourceFilterOptions = useMemo(() => {
    return [
      ...subsonicSources.map((source) => ({
        key: `subsonic:${source.id}`,
        label: source.name
      })),
      ...jellyfinSources.map((source) => ({
        key: `jellyfin:${source.id}`,
        label: source.name
      }))
    ]
  }, [jellyfinSources, subsonicSources])
  const shouldShowSourceFilters = sourceFilterOptions.length > 0
  const hasEffectiveLibraryFilters = hasHiddenFolders || (shouldShowSourceFilters && selectedSourceFilters.size > 0)
  const selectedArtistRecord = useMemo(() => {
    if (!selectedArtist) return null
    const selectedArtistKey = normalizeKey(selectedArtist)
    return artists.find((artist) => normalizeKey(artist.artist) === selectedArtistKey) ?? null
  }, [artists, selectedArtist])
  const selectedArtistArtworkHash = selectedArtistRecord?.artwork_hash ?? null
  const selectedArtistArtworkSource = selectedArtistRecord?.artwork_source ?? null
  const canResetSelectedArtistImage = selectedArtistArtworkSource === 'manual'
  const selectedGenreRecord = useMemo(() => {
    if (!selectedGenre) return null
    const selectedGenreKey = normalizeKey(selectedGenre)
    return genres.find((genre) => normalizeKey(genre.genre) === selectedGenreKey) ?? null
  }, [genres, selectedGenre])
  const selectedGenreArtworkHash = selectedGenreRecord?.artwork_hash ?? null

  useEffect(() => {
    if (pendingLibrarySearchQuery === null) return

    const pendingQuery = consumePendingLibrarySearchQuery()
    if (pendingQuery !== null) {
      setSearchQuery(pendingQuery)
    }
  }, [consumePendingLibrarySearchQuery, pendingLibrarySearchQuery])

  useEffect(() => {
    if (!libraryTrackRevealRequest) return
    setSearchQuery('')
    clearSelectedSourceFilters()
  }, [clearSelectedSourceFilters, libraryTrackRevealRequest])

  useEffect(() => {
    if (!previousInDetailViewRef.current && inDetailView) {
      setSearchQuery('')
    }
    previousInDetailViewRef.current = inDetailView
  }, [inDetailView])

  useEffect(() => {
    setIsArtistImageMenuOpen(false)
  }, [selectedArtist])

  useEffect(() => {
    setIsDetailHeaderCollapsed(false)
  }, [sortContextKey])

  useEffect(() => {
    if (!isArtistImageMenuOpen) return

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (artistImageControlRef.current?.contains(target)) return
      setIsArtistImageMenuOpen(false)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setIsArtistImageMenuOpen(false)
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isArtistImageMenuOpen])

  useEffect(() => {
    if (!includeSinglesInAlbums || !isReleaseBrowseView || albumsIncludingSinglesLoaded) return
    void loadAlbumsIncludingSingles()
  }, [albumsIncludingSinglesLoaded, includeSinglesInAlbums, isReleaseBrowseView, loadAlbumsIncludingSingles])

  useEffect(() => {
    if (!shouldRetainFullTracks) return
    void loadFullTracks('library')
    return () => {
      releaseFullTracks('library')
    }
  }, [loadFullTracks, releaseFullTracks, shouldRetainFullTracks])

  useEffect(() => {
    const validFilterKeys = new Set<string>([
      'local',
      ...subsonicSources.map((source) => `subsonic:${source.id}`),
      ...jellyfinSources.map((source) => `jellyfin:${source.id}`)
    ])

    if (selectedSourceFilters.size === 0) return
    const next = new Set<string>()
    for (const key of selectedSourceFilters) {
      if (validFilterKeys.has(key)) {
        next.add(key)
      }
    }
    setSelectedSourceFilters(next)
  }, [jellyfinSources, selectedSourceFilters, setSelectedSourceFilters, subsonicSources])

  useEffect(() => {
    if (shouldShowSourceFilters) return
    clearSelectedSourceFilters()
  }, [clearSelectedSourceFilters, shouldShowSourceFilters])

  useEffect(() => {
    setArtistAlbumRailMode('albums')
  }, [selectedArtist])

  useEffect(() => {
    if (!isScanning) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void cancelScan()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [cancelScan, isScanning])

  // Resolve the active scrollport after every render because virtualized views
  // publish their imperative element after mounting and can replace it without
  // changing the navigation context (for example Artist list/grid mode).
  useLayoutEffect(() => {
    let element: HTMLElement | null = null
    if (selectedAlbum || selectedGenre || isTrackRootView) {
      element = trackViewportRef.current?.element ?? null
    } else if (selectedArtist) {
      element = artistDetailViewportRef.current
    } else if (selectedYear !== null) {
      element = yearDetailViewportRef.current
    } else if (viewMode === 'albums') {
      element = albumViewportRef.current?.element ?? null
    } else if (viewMode === 'artists') {
      element = artistViewportRef.current?.element ?? null
    } else if (viewMode === 'genres') {
      element = genreViewportRef.current?.element ?? null
    } else if (viewMode === 'years') {
      element = yearViewportRef.current?.element ?? null
    }

    const activeBinding = activeScrollBindingRef.current
    if (activeBinding?.key === libraryScrollContextKey && activeBinding.element === element) return

    activeBinding?.unbind()
    activeScrollBindingRef.current = null

    if (element) {
      activeScrollBindingRef.current = {
        element,
        key: libraryScrollContextKey,
        unbind: bindLibraryScrollRestoration(libraryScrollContextKey, element)
      }
    }
  })

  useLayoutEffect(() => () => {
    activeScrollBindingRef.current?.unbind()
    activeScrollBindingRef.current = null
  }, [])

  useEffect(() => {
    if (isTrackRootView) return
    if (!sortState) return
    const hideBpmKeySort = !showTracklistBpmKey && (sortState.key === 'bpm' || sortState.key === 'musical_key')
    const hideGenreSort = !showTracklistGenre && sortState.key === 'genre'
    const hideAddedSort = !showTracklistAddedDate && sortState.key === 'added'
    const hideRatingSort = !ratingsEnabled && sortState.key === 'rating'
    const hidePlayCountSort = !showTracklistPlayCount && sortState.key === 'play_count'
    if (!hideBpmKeySort && !hideGenreSort && !hideAddedSort && !hideRatingSort && !hidePlayCountSort) return
    setSortState(selectedAlbum ? null : { key: 'title', direction: 'asc' })
  }, [isTrackRootView, ratingsEnabled, selectedAlbum, setSortState, showTracklistAddedDate, showTracklistBpmKey, showTracklistGenre, showTracklistPlayCount, sortState])

  const handleSortColumnToggle = useCallback((key: TrackListSortKey) => {
    const state = useLibraryStore.getState()
    const isRootTracks = state.viewMode === 'tracks'
      && !state.selectedAlbum
      && !state.selectedArtist
      && !state.selectedGenre
      && state.selectedYear === null
    if (isRootTracks) {
      setTracksViewSortRules(replaceTrackSortRulesFromHeader(state.tracksViewSortRules, key))
      return
    }
    const current = useLibraryStore.getState().trackListSortState
    if (current?.key === key) {
      setSortState({
        key,
        direction: current.direction === 'asc' ? 'desc' : 'asc'
      })
      return
    }
    setSortState({
      key,
      direction: key === 'added' || key === 'play_count' ? 'desc' : 'asc'
    })
  }, [setSortState, setTracksViewSortRules])

  const handleResetToDefaultOrder = useCallback(() => {
    setSortState(null)
  }, [setSortState])

  const effectiveAlbumSortState = useMemo(() => (
    isYearDetailView && albumSortState.key === 'year'
      ? { key: 'title' as const, direction: 'asc' as const }
      : albumSortState
  ), [albumSortState, isYearDetailView])

  const handleAlbumSortKeyClick = useCallback((key: AlbumSortKey) => {
    const current = isYearDetailView && albumSortState.key === 'year'
      ? { key: 'title' as const, direction: 'asc' as const }
      : albumSortState
    setAlbumSortState(current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: getDefaultAlbumSortDirection(key) })
  }, [albumSortState, isYearDetailView, setAlbumSortState])

  const handleToggleIncludeSinglesInAlbums = useCallback(() => {
    setIncludeSinglesInAlbums(!includeSinglesInAlbums)
  }, [includeSinglesInAlbums, setIncludeSinglesInAlbums])

  const handleToggleIncludeCollabArtists = useCallback(() => {
    setIncludeCollabArtists(!includeCollabArtists)
  }, [includeCollabArtists, setIncludeCollabArtists])

  const handleResetSourceFilters = useCallback(() => {
    clearSelectedSourceFilters()
  }, [clearSelectedSourceFilters])

  const handleToggleSourceFilter = useCallback((filterKey: string) => {
    toggleSourceFilter(filterKey)
  }, [toggleSourceFilter])

  const handleLibraryContentScrollCapture = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    if (!inDetailView) return

    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target.scrollHeight <= target.clientHeight + 1) return

    const collapseDistance = getDetailHeaderCollapseDistance(detailHeaderRef.current)
    setIsDetailHeaderCollapsed((isCollapsed) => (
      resolveDetailHeaderCollapsed({
        isCollapsed,
        scrollTop: target.scrollTop,
        scrollHeight: target.scrollHeight,
        clientHeight: target.clientHeight,
        collapseDistance
      })
    ))
  }, [inDetailView])

  const runPreparedSelectionTransition = useCallback(async (
    request: LibrarySelectionRequest,
    scopeClassName: string
  ): Promise<boolean> => {
    const prepared = await prepareSelection(request)
    if (!prepared) return false

    let committed = false
    await runViewTransition(() => {
      committed = commitPreparedSelection(prepared)
    }, scopeClassName)
    return committed
  }, [commitPreparedSelection, prepareSelection])

  const handleSelectArtistFromList = useCallback(async (artistName: string) => {
    await runPreparedSelectionTransition(
      { kind: 'artist', artist: artistName, origin: 'library' },
      'library-context-forward'
    )
  }, [runPreparedSelectionTransition])

  const handleSelectAlbumFromGrid = useCallback((album: { album: string; artist: string; identity_key: string }) => {
    if (selectedYear !== null) {
      setSearchQuery('')
    }
    void runPreparedSelectionTransition(
      {
        kind: 'album',
        album: album.album,
        artist: album.artist,
        origin: selectedYear !== null ? 'library-detail' : 'library',
        identityKey: album.identity_key
      },
      'library-context-forward'
    )
  }, [runPreparedSelectionTransition, selectedYear])

  const handleAlbumGridContextMenu = useCallback((album: { album: string; artist: string; identity_key: string }, x: number, y: number) => {
    openCollectionQueueMenu({
      target: {
        kind: 'album',
        album: album.album,
        artist: album.artist,
        identityKey: album.identity_key
      },
      x,
      y
    })
  }, [openCollectionQueueMenu])

  const handleSelectGenreFromGrid = useCallback((genre: { genre: string }) => {
    void runPreparedSelectionTransition(
      { kind: 'genre', genre: genre.genre, origin: 'library' },
      'library-context-forward'
    )
  }, [runPreparedSelectionTransition])

  const handleSelectYearFromGrid = useCallback((year: LibraryYearGroup) => {
    void runPreparedSelectionTransition(
      { kind: 'year', year: year.key, origin: 'library' },
      'library-context-forward'
    )
  }, [runPreparedSelectionTransition])

  const handleSelectViewMode = useCallback((mode: Parameters<typeof setViewMode>[0]) => {
    if (viewMode === mode) return
    void runViewTransition(() => setViewMode(mode), getLibraryTabTransitionScopeClasses(viewMode, mode))
  }, [setViewMode, viewMode])

  const sourceFilteredTracks = useMemo(() => {
    if (!shouldShowSourceFilters || selectedSourceFilters.size === 0) return visibleTracks

    return visibleTracks.filter((track) => {
      if (track.source_type === 'local') {
        return selectedSourceFilters.has('local')
      }
      if (track.source_type === 'subsonic') {
        if (track.source_id == null) return false
        return selectedSourceFilters.has(`subsonic:${track.source_id}`)
      }
      if (track.source_type === 'jellyfin') {
        if (track.source_id == null) return false
        return selectedSourceFilters.has(`jellyfin:${track.source_id}`)
      }
      return false
    })
  }, [selectedSourceFilters, shouldShowSourceFilters, visibleTracks])

  const albumGridSourceAlbums = isReleaseBrowseView && includeSinglesInAlbums && albumsIncludingSinglesLoaded
    ? albumsIncludingSingles
    : albums

  const collectionSeedTracks = useMemo(() => {
    if (selectedYear === null) return sourceFilteredTracks
    return filterTracksByLibraryYearAlbums(sourceFilteredTracks, albumGridSourceAlbums, selectedYear)
  }, [albumGridSourceAlbums, selectedYear, sourceFilteredTracks])

  const queueSeedSortedTracks = useMemo(() => {
    const sorted = [...collectionSeedTracks]

    if (isTrackRootView) {
      sorted.sort((left, right) => compareTracksBySortRules(
        left,
        right,
        tracksViewSortRules,
        (trackPath) => ratings.get(trackPath)?.rating ?? null
      ))
      return sorted
    }

    sorted.sort((a, b) => {
      if (!sortState) {
        return compareAlbumSequence(a, b)
      }

      let comparison = 0
      if (sortState.key === 'title') {
        comparison = compareWithDirection(compareTextValue(a.title, b.title), sortState.direction)
      } else if (sortState.key === 'artist') {
        comparison = compareWithDirection(compareTextValue(a.artist, b.artist), sortState.direction)
      } else if (sortState.key === 'album') {
        comparison = compareWithDirection(compareTextValue(a.album, b.album), sortState.direction)
        if (comparison === 0) {
          comparison = compareAlbumSequence(a, b)
        }
      } else if (sortState.key === 'duration') {
        comparison = compareNullableDuration(a.duration, b.duration, sortState.direction)
      } else if (sortState.key === 'bpm') {
        comparison = compareNullableBpm(a.bpm, b.bpm, sortState.direction)
      } else if (sortState.key === 'genre') {
        comparison = compareNullableKey(a.genre, b.genre, sortState.direction)
      } else if (sortState.key === 'added') {
        comparison = compareAddedAt(a, b, sortState.direction)
      } else if (sortState.key === 'rating') {
        comparison = compareNullableRating(
          ratings.get(a.path)?.rating ?? null,
          ratings.get(b.path)?.rating ?? null,
          sortState.direction
        )
      } else if (sortState.key === 'play_count') {
        comparison = compareTrackPlayCounts(a.play_count, b.play_count, sortState.direction)
      } else {
        comparison = compareNullableKey(a.musical_key, b.musical_key, sortState.direction)
      }

      if (comparison !== 0) return comparison
      return comparePath(a.path, b.path)
    })

    return sorted
  }, [collectionSeedTracks, isTrackRootView, ratings, sortState, tracksViewSortRules])
  const isCollectionPlayDisabled = isCollectionPlayPending || queueSeedSortedTracks.length === 0
  const queueTrackPaths = useMemo(() => queueSeedSortedTracks.map((track) => track.path), [queueSeedSortedTracks])

  const handlePlayTracklist = useCallback(async () => {
    if (collectionPlayPendingRef.current) return
    if (queueSeedSortedTracks.length === 0) return

    collectionPlayPendingRef.current = true
    setIsCollectionPlayPending(true)

    try {
      const queueTrackPaths = queueSeedSortedTracks.map((track) => track.path)

      await startPlaybackContextByPaths(queueTrackPaths, 0, {
        contextLabel: selectedAlbum?.album
          ?? selectedArtist
          ?? selectedGenre
          ?? (selectedYear !== null ? formatLibraryYearKey(selectedYear) : 'Library'),
        sourceContext: playbackSourceContext,
        startShuffled: true
      })
    } catch (error) {
      console.error('Failed to play tracklist:', error)
    } finally {
      collectionPlayPendingRef.current = false
      setIsCollectionPlayPending(false)
    }
  }, [
    playbackSourceContext,
    queueSeedSortedTracks,
    selectedAlbum?.album,
    selectedArtist,
    selectedGenre,
    selectedYear,
    startPlaybackContextByPaths
  ])

  const displayTracks = useMemo(() => {
    if (!hasSearchQuery) return queueSeedSortedTracks
    return queueSeedSortedTracks.filter((track) => trackMatchesLibraryQuery(track, trimmedSearchQuery))
  }, [hasSearchQuery, trimmedSearchQuery, queueSeedSortedTracks])

  const sourceFilteredAlbumIdentityKeys = useMemo(() => {
    if (!isReleaseBrowseView || !hasEffectiveLibraryFilters) return null
    const keys = new Set<string>()
    for (const track of sourceFilteredTracks) {
      keys.add(track.album_identity_key || buildAlbumIdentityKeyFromTrack(track))
    }
    return keys
  }, [hasEffectiveLibraryFilters, isReleaseBrowseView, sourceFilteredTracks])

  const sourceFilteredAlbums = useMemo(() => {
    if (!isReleaseBrowseView) return []
    if (!sourceFilteredAlbumIdentityKeys) return albumGridSourceAlbums
    return albumGridSourceAlbums.filter((album) => sourceFilteredAlbumIdentityKeys.has(album.identity_key))
  }, [albumGridSourceAlbums, isReleaseBrowseView, sourceFilteredAlbumIdentityKeys])

  const filteredAlbums = useMemo(() => {
    if (!isAlbumRootView && !isYearDetailView) return []
    const shouldFilterByQuery = hasSearchQuery && (isAlbumRootView || isYearDetailView)
    const visibleAlbums = !shouldFilterByQuery
      ? sourceFilteredAlbums
      : sourceFilteredAlbums.filter((album) => matchesFuzzyFields(trimmedSearchQuery, [
        { value: album.album, weight: 1.4 },
        { value: album.artist, weight: 1.1 }
      ]))

    const sortedAlbums = [...visibleAlbums]
    sortedAlbums.sort((a, b) => compareAlbumsBySortState(a, b, effectiveAlbumSortState))

    return sortedAlbums
  }, [effectiveAlbumSortState, hasSearchQuery, isAlbumRootView, isYearDetailView, trimmedSearchQuery, sourceFilteredAlbums])

  const yearGroups = useMemo(() => {
    if (!isYearRootView && !isYearDetailView) return []
    return buildLibraryYearGroups(sourceFilteredAlbums)
  }, [isYearDetailView, isYearRootView, sourceFilteredAlbums])
  const filteredYears = useMemo(() => {
    if (!isYearRootView) return []
    if (!hasSearchQuery) return yearGroups
    return yearGroups.filter((year) => matchesFuzzyFields(trimmedSearchQuery, [
      { value: year.label, weight: 1.5 }
    ]))
  }, [hasSearchQuery, isYearRootView, trimmedSearchQuery, yearGroups])
  const selectedYearGroup = useMemo(() => {
    if (selectedYear === null) return null
    return yearGroups.find((year) => year.key === selectedYear) ?? null
  }, [selectedYear, yearGroups])
  const selectedYearAlbums = useMemo(() => {
    if (!isYearDetailView || selectedYear === null) return []
    return filteredAlbums.filter((album) => albumMatchesLibraryYear(album, selectedYear))
  }, [filteredAlbums, isYearDetailView, selectedYear])

  const sourceFilteredArtistKeys = useMemo(() => {
    if (!isArtistRootView) return null
    if ((!shouldShowSourceFilters || selectedSourceFilters.size === 0) && !hasHiddenFolders) return null
    const keys = new Set<string>()
    for (const track of sourceFilteredTracks) {
      const parsedArtistNames = track.artist_names.length > 0 ? track.artist_names : track.album_artist_names
      if (artistBrowseMode === 'canonical' && parsedArtistNames.length > 0) {
        const browseArtistKey = normalizeKey(resolveBrowseArtistForTrack(track, artistBrowseMode))
        if (browseArtistKey) keys.add(browseArtistKey)
        for (const artistName of parsedArtistNames) {
          const normalizedArtistKey = normalizeKey(artistName)
          if (normalizedArtistKey) keys.add(normalizedArtistKey)
        }
      } else {
        const browseArtist = resolveBrowseArtistForTrack(track, artistBrowseMode)
        const normalizedArtistKey = normalizeKey(browseArtist)
        if (normalizedArtistKey) {
          keys.add(normalizedArtistKey)
        }
      }
    }
    return keys
  }, [artistBrowseMode, hasHiddenFolders, isArtistRootView, selectedSourceFilters.size, shouldShowSourceFilters, sourceFilteredTracks])

  const sourceFilteredPrimaryArtistKeys = useMemo(() => {
    if (!isArtistRootView) return null
    if (artistBrowseMode !== 'canonical') return null
    if ((!shouldShowSourceFilters || selectedSourceFilters.size === 0) && !hasHiddenFolders) return null

    const keys = new Set<string>()
    for (const track of sourceFilteredTracks) {
      const browseArtistKey = normalizeKey(resolveBrowseArtistForTrack(track, artistBrowseMode))
      if (browseArtistKey) keys.add(browseArtistKey)
    }
    return keys
  }, [artistBrowseMode, hasHiddenFolders, isArtistRootView, selectedSourceFilters.size, shouldShowSourceFilters, sourceFilteredTracks])

  const visibleArtists = useMemo(() => {
    if (!isArtistRootView) return []
    if (!sourceFilteredArtistKeys) return artists
    return artists.filter((artist) => sourceFilteredArtistKeys.has(normalizeKey(artist.artist)))
  }, [artists, isArtistRootView, sourceFilteredArtistKeys])

  const rootVisibleArtists = useMemo(() => {
    if (!isArtistRootView) return []
    if (artistBrowseMode !== 'canonical' || includeCollabArtists) return visibleArtists

    if (sourceFilteredPrimaryArtistKeys) {
      return visibleArtists.filter((artist) => sourceFilteredPrimaryArtistKeys.has(normalizeKey(artist.artist)))
    }

    return visibleArtists.filter((artist) => artist.primary_track_count > 0)
  }, [artistBrowseMode, includeCollabArtists, isArtistRootView, sourceFilteredPrimaryArtistKeys, visibleArtists])

  const filteredArtists = useMemo(() => {
    if (!isArtistRootView) return []
    if (!hasSearchQuery) return rootVisibleArtists
    return rootVisibleArtists.filter((artist) => matchesFuzzyFields(trimmedSearchQuery, [
      { value: artist.artist, weight: 1.5 }
    ]))
  }, [hasSearchQuery, isArtistRootView, trimmedSearchQuery, rootVisibleArtists])

  const sourceFilteredGenreKeys = useMemo(() => {
    if (!isGenreRootView) return null
    if ((!shouldShowSourceFilters || selectedSourceFilters.size === 0) && !hasHiddenFolders) return null
    const keys = new Set<string>()
    for (const track of sourceFilteredTracks) {
      for (const genre of track.genres) {
        const normalizedGenreKey = normalizeKey(genre)
        if (normalizedGenreKey) keys.add(normalizedGenreKey)
      }
    }
    return keys
  }, [hasHiddenFolders, isGenreRootView, selectedSourceFilters.size, shouldShowSourceFilters, sourceFilteredTracks])

  const visibleGenres = useMemo(() => {
    if (!isGenreRootView) return []
    if (!sourceFilteredGenreKeys) return genres
    return genres.filter((genre) => sourceFilteredGenreKeys.has(normalizeKey(genre.genre)))
  }, [genres, isGenreRootView, sourceFilteredGenreKeys])

  const filteredGenres = useMemo(() => {
    if (!isGenreRootView) return []
    if (!hasSearchQuery) return visibleGenres
    return visibleGenres.filter((genre) => matchesFuzzyFields(trimmedSearchQuery, [
      { value: genre.genre, weight: 1.5 }
    ]))
  }, [hasSearchQuery, isGenreRootView, trimmedSearchQuery, visibleGenres])

  const albumByKey = useMemo(() => {
    const map = new Map<string, (typeof albums)[number]>()
    if (!selectedArtist) return map
    for (const album of albums) {
      const key = buildAlbumKey(album.album, album.artist)
      if (map.has(key)) continue
      map.set(key, album)
    }
    return map
  }, [albums, selectedArtist])

  const albumByIdentityKey = useMemo(() => {
    const map = new Map<string, (typeof albums)[number]>()
    if (!selectedArtist) return map
    for (const album of albums) {
      if (map.has(album.identity_key)) continue
      map.set(album.identity_key, album)
    }
    return map
  }, [albums, selectedArtist])

  const { primaryArtistAlbums, primaryArtistSingles, featuredArtistAlbums } = useMemo(() => {
    if (!selectedArtist) {
      return {
        primaryArtistAlbums: [] as (typeof albums)[number][],
        primaryArtistSingles: [] as (typeof albums)[number][],
        featuredArtistAlbums: [] as (typeof albums)[number][]
      }
    }

    const UNKNOWN_ALBUM_NAME = 'Unknown Album'
    const UNKNOWN_ARTIST_NAME = 'Unknown Artist'
    const matchedIdentityKeys = new Set<string>()
    const selectedArtistKey = normalizeKey(selectedArtist)
    const unmatchedReleasesByIdentityKey = new Map<string, {
      release: (typeof albums)[number]
      isPrimary: boolean
    }>()

    for (const track of sourceFilteredTracks) {
      const identityKey = track.album_identity_key || buildAlbumIdentityKeyFromTrack(track)
      const identityArtist = getAlbumIdentityArtist(track)
      const browseArtist = resolveBrowseArtistForTrack(track, artistBrowseMode)
      const fallbackKey = buildAlbumKey(track.album, identityArtist)
      const match = albumByIdentityKey.get(identityKey) ?? albumByKey.get(fallbackKey)

      if (match) {
        matchedIdentityKeys.add(match.identity_key)
        continue
      }

      const normalizedAlbumName = track.album.trim() || UNKNOWN_ALBUM_NAME
      if (normalizeKey(normalizedAlbumName) === normalizeKey(UNKNOWN_ALBUM_NAME)) continue

      const existingRelease = unmatchedReleasesByIdentityKey.get(identityKey)
      if (existingRelease) {
        existingRelease.release.track_count += 1
        if (existingRelease.release.year === null || ((track.year ?? -1) > existingRelease.release.year)) {
          existingRelease.release.year = track.year
        }
        if (!existingRelease.release.artwork_hash && track.artwork_hash) {
          existingRelease.release.artwork_hash = track.artwork_hash
        }
        continue
      }

      unmatchedReleasesByIdentityKey.set(identityKey, {
        isPrimary: normalizeKey(browseArtist) === selectedArtistKey,
        release: {
          identity_key: identityKey,
          album: normalizedAlbumName,
          artist: identityArtist || UNKNOWN_ARTIST_NAME,
          primary_artist: resolveBrowseArtistForTrack(track, 'canonical'),
          year: track.year,
          artwork_hash: track.artwork_hash,
          track_count: 1,
          is_new: false
        }
      })
    }

    const candidates: Array<{
      release: (typeof albums)[number]
      isPrimary: boolean
    }> = []

    for (const album of albums) {
      if (!matchedIdentityKeys.has(album.identity_key)) continue

      const primaryArtistKey = artistBrowseMode === 'strict'
        ? normalizeKey(album.artist)
        : normalizeKey(album.primary_artist ?? '')

      candidates.push({
        release: album,
        isPrimary: primaryArtistKey === selectedArtistKey
      })
    }

    for (const candidate of unmatchedReleasesByIdentityKey.values()) {
      candidates.push(candidate)
    }

    const sections = partitionArtistDiscography(candidates)
    sections.albums.sort(compareAlbumsByYearDescending)
    sections.singles.sort(compareAlbumsByYearDescending)
    sections.featured.sort(compareAlbumsByYearDescending)

    return {
      primaryArtistAlbums: sections.albums,
      primaryArtistSingles: sections.singles,
      featuredArtistAlbums: sections.featured
    }
  }, [albumByIdentityKey, albumByKey, albums, artistBrowseMode, selectedArtist, sourceFilteredTracks])

  const selectedAlbumRecord = useMemo(() => {
    if (!selectedAlbum) return null

    const identityKey = selectedAlbum.identity_key?.trim()
    const albumCandidates = albumsIncludingSinglesLoaded
      ? [...albums, ...albumsIncludingSingles]
      : albums

    if (identityKey) {
      const identityMatch = albumCandidates.find((album) => album.identity_key === identityKey)
      if (identityMatch) return identityMatch
    }

    const selectedAlbumKey = buildAlbumKey(selectedAlbum.album, selectedAlbum.artist)
    return albumCandidates.find((album) => buildAlbumKey(album.album, album.artist) === selectedAlbumKey) ?? null
  }, [albums, albumsIncludingSingles, albumsIncludingSinglesLoaded, selectedAlbum])

  const selectedAlbumArtworkHash = selectedAlbum
    ? selectedAlbumRecord?.artwork_hash
      ?? tracks.find((track) => track.artwork_hash)?.artwork_hash
      ?? null
    : null
  const selectedAlbumYear = selectedAlbum
    ? selectedAlbumRecord?.year
      ?? tracks.reduce<number | null>((latestYear, track) => {
        if (track.year === null) return latestYear
        return latestYear === null ? track.year : Math.max(latestYear, track.year)
      }, null)
    : null
  const selectedAlbumArtist = selectedAlbum
    ? selectedAlbum.artist.trim()
      || selectedAlbumRecord?.artist.trim()
      || tracks.find((track) => track.album_artist?.trim())?.album_artist?.trim()
      || tracks.find((track) => track.artist.trim())?.artist.trim()
      || ''
    : ''
  const detailArtworkHash = selectedAlbumArtworkHash
    ?? selectedArtistArtworkHash
    ?? selectedGenreArtworkHash
    ?? selectedYearGroup?.artwork_hash
    ?? null

  const trimmedQueryForMessage = searchQuery.trim()
  const searchPlaceholder = selectedYear !== null
    ? 'Search albums & tracks...'
    : inDetailView
      ? 'Search tracks...'
      : viewMode === 'albums'
        ? 'Search albums...'
        : viewMode === 'artists'
          ? 'Search artists...'
          : viewMode === 'genres'
            ? 'Search genres...'
            : viewMode === 'years'
              ? 'Search years...'
              : viewMode === 'folders'
                ? 'Search folders & tracks...'
                : 'Search tracks...'
  const isAllSourcesFilterActive = selectedSourceFilters.size === 0

  const contextualAlbumParent = selectedAlbum && selectionOrigin === 'library-detail'
    ? selectionHistory[selectionHistory.length - 1] ?? null
    : null
  const detailBackLabel = contextualAlbumParent?.selectedArtist
    ? `Back to ${contextualAlbumParent.selectedArtist}`
    : contextualAlbumParent?.selectedGenre
      ? `Back to ${contextualAlbumParent.selectedGenre}`
      : contextualAlbumParent?.selectedYear !== null && contextualAlbumParent?.selectedYear !== undefined
        ? `Back to ${formatLibraryYearKey(contextualAlbumParent.selectedYear)}`
        : 'Back to Library'

  const handleDetailBack = async () => {
    if (contextualAlbumParent) {
      const prepared = await prepareSelection({ kind: 'history', direction: 'back' })
      if (!prepared) return
      if (contextualAlbumParent.selectedYear !== null) {
        setSearchQuery('')
      }
      await runViewTransition(() => {
        commitPreparedSelection(prepared)
      }, 'library-context-backward')
      return
    }

    if (viewMode === 'years') {
      setSearchQuery('')
    }
    await runViewTransition(() => clearSelection(), 'library-context-backward')
  }

  const handleOpenSelectedArtistInGraph = () => {
    if (!selectedArtist) return
    openFocusedGraph(selectedArtist)
    setActiveView('graph')
  }

  const handleChangeSelectedArtistImage = useCallback(async () => {
    if (!selectedArtist || isUpdatingArtistImage) return
    setIsArtistImageMenuOpen(false)

    const imagePath = await window.electronAPI.openFileDialog({
      title: 'Choose artist image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    })
    if (!imagePath) return

    setIsUpdatingArtistImage(true)
    try {
      await setArtistImageFromFile(selectedArtist, artistBrowseMode, imagePath)
    } finally {
      setIsUpdatingArtistImage(false)
    }
  }, [artistBrowseMode, isUpdatingArtistImage, selectedArtist, setArtistImageFromFile])

  const handleResetSelectedArtistImage = useCallback(async () => {
    if (!selectedArtist || isUpdatingArtistImage || !canResetSelectedArtistImage) return
    setIsArtistImageMenuOpen(false)

    setIsUpdatingArtistImage(true)
    try {
      await clearArtistImage(selectedArtist, artistBrowseMode)
    } finally {
      setIsUpdatingArtistImage(false)
    }
  }, [artistBrowseMode, canResetSelectedArtistImage, clearArtistImage, isUpdatingArtistImage, selectedArtist])

  // Header
  let title = 'Library'
  let showViewTabs = true
  let itemCount = displayTracks.length
  let itemLabel = displayTracks.length === 1 ? 'track' : 'tracks'

  if (selectedAlbum) {
    title = selectedAlbum.album
    showViewTabs = false
  } else if (selectedArtist) {
    title = selectedArtist
    showViewTabs = false
  } else if (selectedGenre) {
    title = selectedGenre
    showViewTabs = false
  } else if (selectedYear !== null) {
    title = formatLibraryYearKey(selectedYear)
    showViewTabs = false
  } else if (viewMode === 'albums') {
    itemCount = filteredAlbums.length
    itemLabel = filteredAlbums.length === 1 ? 'album' : 'albums'
  } else if (viewMode === 'artists') {
    itemCount = filteredArtists.length
    itemLabel = filteredArtists.length === 1 ? 'artist' : 'artists'
  } else if (viewMode === 'genres') {
    itemCount = filteredGenres.length
    itemLabel = filteredGenres.length === 1 ? 'genre' : 'genres'
  } else if (viewMode === 'years') {
    itemCount = filteredYears.length
    itemLabel = filteredYears.length === 1 ? 'year' : 'years'
  } else if (viewMode === 'folders') {
    itemCount = sourceFilteredTracks.length
    itemLabel = sourceFilteredTracks.length === 1 ? 'track' : 'tracks'
  }
  const selectedAlbumDurationLabel = selectedAlbum
    ? formatCompactTotalTrackDuration(sourceFilteredTracks)
    : null
  // Average of the album's RATED tracks only, computed renderer-side from the
  // loaded track list like the duration above. Unrated albums show nothing.
  const selectedAlbumAverageRatingLabel = useMemo(() => {
    if (!ratingsEnabled || !selectedAlbum) return null
    let sum = 0
    let count = 0
    for (const track of sourceFilteredTracks) {
      const entry = ratings.get(track.path)
      if (entry) {
        sum += entry.rating
        count += 1
      }
    }
    return count > 0 ? `★ ${(sum / count).toFixed(1)}` : null
  }, [ratings, ratingsEnabled, selectedAlbum, sourceFilteredTracks])
  const selectedArtistDurationLabel = selectedArtist
    ? formatCompactTotalTrackDuration(sourceFilteredTracks)
    : null
  const selectedGenreDurationLabel = selectedGenre
    ? formatCompactTotalTrackDuration(sourceFilteredTracks)
    : null
  const detailMetaItems = selectedAlbum
    ? [
        selectedAlbumArtist || null,
        selectedAlbumYear ? String(selectedAlbumYear) : null,
        formatTrackCount(sourceFilteredTracks.length),
        selectedAlbumDurationLabel,
        selectedAlbumAverageRatingLabel
      ].filter((item): item is string => Boolean(item))
    : selectedArtist
      ? [
          `${primaryArtistAlbums.length} ${primaryArtistAlbums.length === 1 ? 'album' : 'albums'}`,
          formatTrackCount(sourceFilteredTracks.length),
          selectedArtistDurationLabel
        ].filter((item): item is string => Boolean(item))
      : selectedGenre
        ? [
            `${selectedGenreRecord?.album_count ?? 0} ${(selectedGenreRecord?.album_count ?? 0) === 1 ? 'album' : 'albums'}`,
            formatTrackCount(sourceFilteredTracks.length),
            selectedGenreDurationLabel
          ].filter((item): item is string => Boolean(item))
        : selectedYear !== null
          ? [
              `${selectedYearGroup?.album_count ?? 0} ${(selectedYearGroup?.album_count ?? 0) === 1 ? 'album' : 'albums'}`,
              formatTrackCount(selectedYearGroup?.track_count ?? 0)
            ]
          : []
  const detailTypeLabel = selectedAlbum
    ? 'Album'
    : selectedArtist
      ? 'Artist'
      : selectedGenre
        ? 'Genre'
        : 'Year'
  const showSelectedAlbumDiscHeaders = Boolean(selectedAlbum && sortState === null && !hasSearchQuery)

  // Scan progress overlay
  const renderScanProgress = () => {
    if (!isScanning || !scanProgress) return null
    const stage = scanStage?.stage ?? 'scanning'
    const percent = scanProgress.total > 0 ? (scanProgress.current / scanProgress.total) * 100 : 0
    const isCleanupStage = stage === 'cleanup'
    const displayPercent = isCleanupStage ? 100 : percent
    const scanTitle = stage === 'backfill'
      ? 'Processing Metadata'
      : stage === 'cleanup'
        ? 'Finalizing Library'
        : 'Scanning Library'
    const countUnit = stage === 'backfill' ? 'tracks' : 'files'
    const fileName = scanProgress.file ? scanProgress.file.split('/').pop() || scanProgress.file.split('\\').pop() : ''
    const scanMessage = scanStage?.message
      ?? (!isCleanupStage ? 'Processing...' : 'Finalizing library...')
    const scanDetail = isCleanupStage ? scanMessage : (fileName || scanMessage)
    const showCount = !isCleanupStage && scanProgress.total > 0

    return (
      <div className="scan-overlay">
        <div className="scan-progress">
          <button
            className="scan-cancel-btn"
            onClick={() => void cancelScan()}
            disabled={isCancelingScan}
            aria-label="Cancel scan"
            title="Cancel scan (Esc)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
          <div className="loading-spinner" />
          <div className="scan-title">{scanTitle}</div>
          {showCount && <div className="scan-count">{scanProgress.current} / {scanProgress.total} {countUnit}</div>}
          <div className="scan-bar">
            <div className="scan-bar-fill" style={{ width: `${displayPercent}%` }} />
          </div>
          {scanDetail && <div className="scan-file">{scanDetail}</div>}
          <div className="scan-cancel-hint">{isCancelingScan ? 'Canceling...' : 'Press Esc to cancel'}</div>
        </div>
      </div>
    )
  }

  // Content
  const renderContent = () => {
    if (isLoading || isFullTrackListPending) {
      return (
        <div className="library-loading">
          <div className="loading-spinner" />
          <p>Loading library...</p>
        </div>
      )
    }

    // When filters are active, every browse collection is derived from this
    // same filtered track set. Otherwise the aggregate metadata arrays retain
    // the previous empty-library semantics without deriving inactive tabs.
    const hasContent = hasEffectiveLibraryFilters
      ? sourceFilteredTracks.length > 0
      : sourceFilteredTracks.length > 0 || albumGridSourceAlbums.length > 0 || artists.length > 0 || genres.length > 0
    if (!hasContent && !selectedAlbum && !selectedArtist && !selectedGenre && selectedYear === null) {
      return (
        <div className="library-empty">
          <div className="empty-icon">&#9835;</div>
          <p>Your library is empty</p>
          <p className="empty-hint">Use Settings &gt; Library &gt; Add Folder to scan your music</p>
        </div>
      )
    }

    if (hasSearchQuery && displayTracks.length === 0 && (selectedAlbum || selectedGenre || viewMode === 'tracks') && !selectedArtist) {
      return (
        <div className="library-empty">
          <p>No tracks found for "{trimmedQueryForMessage}"</p>
        </div>
      )
    }

    // Folder tree
    if (viewMode === 'folders' && !selectedAlbum && !selectedArtist && !selectedGenre && selectedYear === null) {
      return <FolderTreeView tracks={sourceFilteredTracks} allTracks={visibleTracks} folders={visibleFolders} searchQuery={searchQuery} />
    }

    // Albums grid
    if (viewMode === 'albums' && !selectedAlbum && !selectedArtist && !selectedGenre && selectedYear === null) {
      if (filteredAlbums.length === 0) {
        return hasSearchQuery
          ? <div className="library-empty"><p>No albums found for "{trimmedQueryForMessage}"</p></div>
          : <div className="library-empty"><p>No albums found</p></div>
      }
      return (
        <AlbumGrid
          albums={filteredAlbums}
          viewportRef={albumViewportRef}
          searchQuery={trimmedSearchQuery}
          onSelectAlbum={handleSelectAlbumFromGrid}
          onAlbumContextMenu={handleAlbumGridContextMenu}
        />
      )
    }

    // Artists list
    if (viewMode === 'artists' && !selectedAlbum && !selectedArtist && !selectedGenre && selectedYear === null) {
      if (filteredArtists.length === 0) {
        return hasSearchQuery
          ? <div className="library-empty"><p>No artists found for "{trimmedQueryForMessage}"</p></div>
          : <div className="library-empty"><p>No artists found</p></div>
      }
      return (
        <ArtistList
          artists={filteredArtists}
          onSelectArtist={handleSelectArtistFromList}
          viewMode={artistRootViewMode}
          viewportRef={artistViewportRef}
          searchQuery={trimmedSearchQuery}
        />
      )
    }

    if (viewMode === 'genres' && !selectedAlbum && !selectedArtist && !selectedGenre && selectedYear === null) {
      if (filteredGenres.length === 0) {
        return hasSearchQuery
          ? <div className="library-empty"><p>No genres found for "{trimmedQueryForMessage}"</p></div>
          : <div className="library-empty"><p>No genres found</p></div>
      }
      return (
        <GenreGrid
          genres={filteredGenres}
          viewportRef={genreViewportRef}
          searchQuery={trimmedSearchQuery}
          onSelectGenre={handleSelectGenreFromGrid}
        />
      )
    }

    if (isYearRootView) {
      if (filteredYears.length === 0) {
        return hasSearchQuery
          ? <div className="library-empty"><p>No years found for "{trimmedQueryForMessage}"</p></div>
          : <div className="library-empty"><p>No years found</p></div>
      }
      return (
        <YearGrid
          years={filteredYears}
          viewportRef={yearViewportRef}
          searchQuery={trimmedSearchQuery}
          onSelectYear={handleSelectYearFromGrid}
        />
      )
    }

    if (isYearDetailView) {
      const yearLabel = formatLibraryYearKey(selectedYear)
      const albumEmptyMessage = hasSearchQuery
        ? `No albums found for "${trimmedQueryForMessage}"`
        : `No albums found for ${yearLabel}`
      const trackEmptyMessage = hasSearchQuery
        ? `No tracks found for "${trimmedQueryForMessage}"`
        : `No tracks found for ${yearLabel}`

      return (
        <div
          className="library-year-detail"
          ref={yearDetailViewportRef}
          data-controller-scroll
          data-track-list-scroll-container
        >
          <YearAlbumPreview
            key={`year-albums:${selectedYear}`}
            albums={selectedYearAlbums}
            searchQuery={trimmedSearchQuery}
            emptyMessage={albumEmptyMessage}
            onSelectAlbum={handleSelectAlbumFromGrid}
            onAlbumContextMenu={handleAlbumGridContextMenu}
          />

          <section className="year-detail-section year-detail-tracks" aria-labelledby="year-detail-tracks-heading">
            <div className="year-detail-section-header year-detail-tracks-header">
              <div className="year-detail-section-heading-row">
                <h3 id="year-detail-tracks-heading">Tracks</h3>
                <span>{formatTrackCount(displayTracks.length)}</span>
              </div>
            </div>
            {displayTracks.length > 0 ? (
              <TrackList
                tracks={displayTracks}
                queueSeedTracks={queueSeedSortedTracks}
                queueContextLabel={yearLabel}
                sourceContext={playbackSourceContext}
                showArtist
                showAlbum
                showAddedDate={showTracklistAddedDate}
                showNewTrackIndicator
                trackNumberMode="none"
                pageScroll
                enableColumnSorting
                sortState={sortState}
                onSortColumnToggle={handleSortColumnToggle}
                jumpToTrackRequest={libraryTrackRevealRequest}
                onJumpToTrackRequestConsumed={clearLibraryTrackRevealRequest}
                searchQuery={trimmedSearchQuery}
              />
            ) : (
              <div className="year-detail-section-empty year-detail-track-empty">{trackEmptyMessage}</div>
            )}
          </section>
        </div>
      )
    }

    if (selectedArtist) {
      const visibleArtistAlbums = artistAlbumRailMode === 'featured'
        ? featuredArtistAlbums
        : artistAlbumRailMode === 'singles'
          ? primaryArtistSingles
          : primaryArtistAlbums
      const railEmptyMessage = artistAlbumRailMode === 'featured'
        ? 'No featured appearances found in indexed albums or singles.'
        : artistAlbumRailMode === 'singles'
          ? 'No primary singles found in indexed releases.'
          : 'No primary albums found in indexed albums.'

      return (
        <div
          className="library-artist-detail"
          ref={artistDetailViewportRef}
          data-controller-scroll
          data-track-list-scroll-container
        >
          <section
            className="library-artist-rail"
            data-controller-group="artist-albums"
            data-controller-axis="horizontal"
          >
            <div className="library-artist-rail-header">
              <h3>Discography</h3>
              <div className="library-artist-rail-action-row">
                <div className="library-artist-rail-actions">
                  <button
                    type="button"
                    className={`library-artist-rail-toggle-btn ${artistAlbumRailMode === 'albums' ? 'active' : ''}`}
                    onClick={() => setArtistAlbumRailMode('albums')}
                    aria-pressed={artistAlbumRailMode === 'albums'}
                  >
                    Albums
                  </button>
                  <button
                    type="button"
                    className={`library-artist-rail-toggle-btn ${artistAlbumRailMode === 'singles' ? 'active' : ''}`}
                    onClick={() => setArtistAlbumRailMode('singles')}
                    aria-pressed={artistAlbumRailMode === 'singles'}
                  >
                    Singles
                  </button>
                  <button
                    type="button"
                    className={`library-artist-rail-toggle-btn ${artistAlbumRailMode === 'featured' ? 'active' : ''}`}
                    onClick={() => setArtistAlbumRailMode('featured')}
                    aria-pressed={artistAlbumRailMode === 'featured'}
                  >
                    Featured In
                  </button>
                </div>
              </div>
            </div>

            {visibleArtistAlbums.length > 0 ? (
              <div
                key={`artist-rail:${artistAlbumRailMode}`}
                className="library-artist-rail-row"
                ref={artistAlbumRailRef}
              >
                {visibleArtistAlbums.map((album, index) => (
                  <button
                    key={album.identity_key}
                    type="button"
                    className="library-artist-rail-card"
                    style={{ animationDelay: `${Math.min(index, 8) * 18}ms` }}
                    data-controller-focusable="true"
                    data-controller-context="true"
                    data-controller-key={`album:${album.identity_key}`}
                    onClick={() => void runPreparedSelectionTransition(
                      {
                        kind: 'album',
                        album: album.album,
                        artist: album.artist,
                        origin: 'library-detail',
                        identityKey: album.identity_key
                      },
                      'library-context-forward'
                    )}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      openCollectionQueueMenu({
                        target: {
                          kind: 'album',
                          album: album.album,
                          artist: album.artist,
                          identityKey: album.identity_key
                        },
                        x: event.clientX,
                        y: event.clientY
                      })
                    }}
                  >
                    {album.is_new && (
                      <span className="library-latest-sync-pill album-card-sync-pill" title="Added in latest library sync">
                        NEW
                      </span>
                    )}
                    <div className="library-artist-rail-artwork">
                      {album.artwork_hash ? (
                        <AlbumArtwork hash={album.artwork_hash} alt={album.album} variant="card" />
                      ) : (
                        <span>&#9835;</span>
                      )}
                    </div>
                    <div className="library-artist-rail-title">{album.album}</div>
                    <div className="library-artist-rail-artist">{album.artist}</div>
                    <div className="library-artist-rail-meta">
                      {formatTrackCount(album.track_count)}{album.year ? ` \u00b7 ${album.year}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div
                key={`artist-rail-empty:${artistAlbumRailMode}`}
                className="library-artist-rail-empty"
              >
                {railEmptyMessage}
              </div>
            )}
          </section>

          <TrackList
            tracks={displayTracks}
            queueSeedTracks={queueSeedSortedTracks}
            queueContextLabel={selectedAlbum?.album ?? selectedArtist ?? 'Library'}
            sourceContext={playbackSourceContext}
            showArtist={false}
            showAlbum={!selectedAlbum}
            showAddedDate={showTracklistAddedDate}
            showNewTrackIndicator
            showDiscHeaders={showSelectedAlbumDiscHeaders}
            trackNumberMode={selectedAlbum ? 'album' : 'none'}
            pageScroll
            enableColumnSorting
            sortState={sortState}
            onSortColumnToggle={handleSortColumnToggle}
            enableDefaultOrderReset={Boolean(selectedAlbum)}
            onDefaultOrderReset={selectedAlbum ? handleResetToDefaultOrder : undefined}
            jumpToTrackRequest={libraryTrackRevealRequest}
            onJumpToTrackRequestConsumed={clearLibraryTrackRevealRequest}
            searchQuery={trimmedSearchQuery}
          />
        </div>
      )
    }

    if (selectedGenre) {
      return (
        <TrackList
          tracks={displayTracks}
          viewportRef={trackViewportRef}
          queueSeedTracks={queueSeedSortedTracks}
          queueContextLabel={selectedGenre}
          sourceContext={playbackSourceContext}
          showArtist
          showAlbum
          showAddedDate={showTracklistAddedDate}
          showNewTrackIndicator
          trackNumberMode="none"
          enableColumnSorting
          sortState={sortState}
          onSortColumnToggle={handleSortColumnToggle}
          jumpToTrackRequest={libraryTrackRevealRequest}
          onJumpToTrackRequestConsumed={clearLibraryTrackRevealRequest}
          searchQuery={trimmedSearchQuery}
        />
      )
    }

    // Tracks
    return (
      <TrackList
        tracks={displayTracks}
        viewportRef={trackViewportRef}
        queueSeedTracks={queueSeedSortedTracks}
        queueContextLabel={selectedAlbum?.album ?? selectedArtist ?? 'Library'}
        sourceContext={playbackSourceContext}
        showArtist={!selectedArtist}
        showAlbum={!selectedAlbum}
        showAddedDate={showTracklistAddedDate}
        showNewTrackIndicator
        showDiscHeaders={showSelectedAlbumDiscHeaders}
        trackNumberMode={selectedAlbum ? 'album' : 'none'}
        enableColumnSorting
        sortState={sortState}
        sortRules={isTrackRootView ? tracksViewSortRules : undefined}
        onSortColumnToggle={handleSortColumnToggle}
        enableDefaultOrderReset={Boolean(selectedAlbum)}
        onDefaultOrderReset={selectedAlbum ? handleResetToDefaultOrder : undefined}
        jumpToTrackRequest={libraryTrackRevealRequest}
        onJumpToTrackRequestConsumed={clearLibraryTrackRevealRequest}
        rootTableLayout={isTrackRootView ? rootTrackTableLayout : undefined}
        onResponsiveHiddenColumnsChange={isTrackRootView ? setResponsiveHiddenTrackColumns : undefined}
        searchQuery={trimmedSearchQuery}
      />
    )
  }

  const renderSourceFilters = () => {
    if (!shouldShowSourceFilters) return null

    return (
      <div className="library-source-filters" role="group" aria-label="Source filters">
        <button
          type="button"
          className={`library-source-filter-chip ${isAllSourcesFilterActive ? 'active' : ''}`}
          onClick={handleResetSourceFilters}
        >
          All
        </button>
        <button
          type="button"
          className={`library-source-filter-chip ${selectedSourceFilters.has('local') ? 'active' : ''}`}
          onClick={() => handleToggleSourceFilter('local')}
        >
          Local
        </button>
        {sourceFilterOptions.map((source) => (
          <button
            key={source.key}
            type="button"
            className={`library-source-filter-chip ${selectedSourceFilters.has(source.key) ? 'active' : ''}`}
            onClick={() => handleToggleSourceFilter(source.key)}
          >
            {source.label}
          </button>
        ))}
      </div>
    )
  }

  const renderSearchControl = () => (
    <div className="search-container">
      <span className="search-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </span>
      <input
        type="text"
        className="search-input"
        data-shortcut-search="true"
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
      />
      {searchQuery.length > 0 && (
        <button
          type="button"
          className="search-clear-btn"
          aria-label="Clear search"
          title="Clear search"
          onClick={() => setSearchQuery('')}
        >
          ×
        </button>
      )}
    </div>
  )

  const renderScanForChangesControl = () => (
    <button
      type="button"
      className="icon-btn"
      onClick={() => void rescan()}
      disabled={isScanning}
      title="Scan for Changes"
      aria-label="Scan for Changes"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
      </svg>
    </button>
  )

  return (
    <div className="library-view">
      {inDetailView && (
        <div className="library-detail-toolbar">
          <div className="library-detail-toolbar-left">
            <button
              className="back-btn"
              onClick={handleDetailBack}
              title={detailBackLabel}
              aria-label={detailBackLabel}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
              </svg>
            </button>
              <div className="library-detail-breadcrumb" aria-label={`Library, ${detailTypeLabel} detail`}>
                <span>Library</span>
                <span className="library-detail-breadcrumb-separator" aria-hidden="true">/</span>
                <span>{detailTypeLabel}</span>
              </div>
            {renderSourceFilters()}
          </div>
          <div className="library-detail-toolbar-right">
            {renderSearchControl()}
            {renderScanForChangesControl()}
          </div>
        </div>
      )}
      <div
        className={`library-header ${inDetailView ? `library-detail-header ${isDetailHeaderCollapsed ? 'is-collapsed' : ''}` : ''}`}
        ref={detailHeaderRef}
      >
        {inDetailView && detailArtworkHash && (
          <div className="library-detail-hero-backdrop" aria-hidden="true">
            <AlbumArtwork
              hash={detailArtworkHash}
              alt=""
              variant="card"
            />
          </div>
        )}
        <div className={`library-header-left ${inDetailView ? 'library-detail-header-left' : ''}`}>
          {inDetailView ? (
            <>
              {selectedAlbum && (
                <div
                  className="library-detail-artwork"
                  onContextMenu={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    openCollectionQueueMenu({
                      target: {
                        kind: 'album',
                        album: selectedAlbum.album,
                        artist: selectedAlbum.artist,
                        identityKey: selectedAlbum.identity_key
                      },
                      x: event.clientX,
                      y: event.clientY
                    })
                  }}
                >
                  <AlbumArtwork
                    hash={selectedAlbumArtworkHash}
                    alt={`${selectedAlbum.album} artwork`}
                    variant="thumbnail"
                  />
                </div>
              )}

                {selectedArtist && (
                  <div className="library-header-artist-image-control library-detail-artist-image-control" ref={artistImageControlRef}>
                  <div className="library-header-artist-avatar">
                    {selectedArtistArtworkHash ? (
                      <AlbumArtwork
                        hash={selectedArtistArtworkHash}
                        alt={`${selectedArtist} artwork`}
                        className="library-header-artist-artwork"
                        variant="thumbnail"
                      />
                    ) : (
                      selectedArtist.charAt(0).toUpperCase()
                    )}
                  </div>
                  <button
                    type="button"
                    className="library-header-artist-edit-btn"
                    onClick={() => setIsArtistImageMenuOpen((isOpen) => !isOpen)}
                    disabled={isUpdatingArtistImage}
                    aria-haspopup="menu"
                    aria-expanded={isArtistImageMenuOpen}
                    aria-label="Edit artist image"
                    title="Edit artist image"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                    </svg>
                  </button>
                  {artistImageMenuPresence.shouldRender && (
                    <div
                      className="library-header-artist-image-menu"
                      data-presence={artistImageMenuPresence.phase}
                      aria-hidden={artistImageMenuPresence.phase === 'exiting'}
                      role="menu"
                    >
                      <button
                        type="button"
                        className="library-header-artist-image-menu-item"
                        role="menuitem"
                        onClick={() => void handleChangeSelectedArtistImage()}
                      >
                        Change image
                      </button>
                      <button
                        type="button"
                        className="library-header-artist-image-menu-item"
                        role="menuitem"
                        onClick={() => void handleResetSelectedArtistImage()}
                        disabled={!canResetSelectedArtistImage}
                      >
                        Reset image
                      </button>
                    </div>
                  )}
                  </div>
                )}

                {selectedGenre && (
                  <div className="library-detail-artwork library-detail-genre-artwork">
                    {selectedGenreArtworkHash ? (
                      <AlbumArtwork
                        hash={selectedGenreArtworkHash}
                        alt={`${selectedGenre} artwork`}
                        variant="thumbnail"
                      />
                    ) : (
                      <span>&#9835;</span>
                    )}
                  </div>
                )}

                {selectedYear !== null && (
                  <div className="library-detail-artwork library-detail-year-artwork">
                    {selectedYearGroup?.artwork_hash ? (
                      <AlbumArtwork
                        hash={selectedYearGroup.artwork_hash}
                        alt={`${formatLibraryYearKey(selectedYear)} artwork`}
                        variant="thumbnail"
                      />
                    ) : (
                      <span>{selectedYear === 'unknown' ? '?' : selectedYear}</span>
                    )}
                  </div>
                )}

                <div
                  className="library-detail-copy"
                onContextMenu={selectedAlbum ? (event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  openCollectionQueueMenu({
                    target: {
                      kind: 'album',
                      album: selectedAlbum.album,
                      artist: selectedAlbum.artist,
                      identityKey: selectedAlbum.identity_key
                    },
                    x: event.clientX,
                    y: event.clientY
                  })
                } : undefined}
              >
                  <div className="library-detail-eyebrow-row">
                    <span className="library-detail-eyebrow">{detailTypeLabel}</span>
                  {selectedAlbum?.is_new && (
                    <span className="library-latest-sync-pill library-header-sync-pill" title="Added in latest library sync">
                      NEW
                    </span>
                  )}
                </div>
                <h2 title={title}>{title}</h2>
                <div className="library-detail-meta-row">
                  <span className="library-detail-meta">{detailMetaItems.join(' \u00b7 ')}</span>
                </div>
              </div>
            </>
          ) : (
            <>
              <h2>{title}</h2>
              {showViewTabs && (
                <div
                  className="view-tabs"
                  data-controller-tabstrip="library-view"
                  data-controller-group="library-tabs"
                  data-controller-axis="horizontal"
                  data-controller-auto-items="true"
                >
                  <button
                    className={`view-tab ${viewMode === 'tracks' ? 'active' : ''}`}
                    data-controller-tab="tracks"
                    data-controller-key="library-tab:tracks"
                    onClick={() => handleSelectViewMode('tracks')}
                  >
                    Tracks
                  </button>
                  <button
                    className={`view-tab ${viewMode === 'albums' ? 'active' : ''}`}
                    data-controller-tab="albums"
                    data-controller-key="library-tab:albums"
                    onClick={() => handleSelectViewMode('albums')}
                  >
                    Albums
                  </button>
                  <button
                    className={`view-tab ${viewMode === 'artists' ? 'active' : ''}`}
                    data-controller-tab="artists"
                    data-controller-key="library-tab:artists"
                    onClick={() => handleSelectViewMode('artists')}
                  >
                    Artists
                  </button>
                  <button
                    className={`view-tab ${viewMode === 'genres' ? 'active' : ''}`}
                    data-controller-tab="genres"
                    data-controller-key="library-tab:genres"
                    onClick={() => handleSelectViewMode('genres')}
                  >
                    Genres
                  </button>
                  <button
                    className={`view-tab ${viewMode === 'years' ? 'active' : ''}`}
                    data-controller-tab="years"
                    data-controller-key="library-tab:years"
                    onClick={() => handleSelectViewMode('years')}
                  >
                    Years
                  </button>
                  <button
                    className={`view-tab ${viewMode === 'folders' ? 'active' : ''}`}
                    data-controller-tab="folders"
                    data-controller-key="library-tab:folders"
                    onClick={() => handleSelectViewMode('folders')}
                  >
                    Folders
                  </button>
                </div>
              )}
              <span className="track-count">{itemCount} {itemLabel}</span>
              {renderSourceFilters()}
            </>
          )}
        </div>
        <div className={`library-header-right ${inDetailView ? 'library-detail-header-actions' : ''}`}>
          {isReleaseBrowseView && (
            <div className="library-album-view-controls">
              <button
                type="button"
                className={`library-album-singles-toggle ${includeSinglesInAlbums ? 'active' : ''}`}
                onClick={handleToggleIncludeSinglesInAlbums}
                role="switch"
                aria-checked={includeSinglesInAlbums}
                aria-label="Include singles in albums"
                title="Include singles in albums"
              >
                Singles
              </button>
              {(isAlbumRootView || isYearDetailView) && (
                <div
                  className="library-segmented-toggle library-album-sort-toggle"
                  role="group"
                  aria-label="Album sort mode"
                  style={{ '--segment-count': isAlbumRootView ? 3 : 2 } as CSSProperties}
                >
                  <span
                    className="library-segmented-highlight"
                    aria-hidden="true"
                    style={{
                      transform: `translateX(${(
                        effectiveAlbumSortState.key === 'artist'
                          ? 1
                          : effectiveAlbumSortState.key === 'year'
                            ? 2
                            : 0
                      ) * 100}%)`
                    }}
                  />
                  {(['title', 'artist', ...(isAlbumRootView ? ['year'] as const : [])] as AlbumSortKey[]).map((key) => {
                    const active = effectiveAlbumSortState.key === key
                    const label = key === 'title' ? 'Title' : key === 'artist' ? 'Artist' : 'Year'
                    const directionLabel = effectiveAlbumSortState.direction === 'asc'
                      ? (key === 'year' ? 'oldest first' : 'A to Z')
                      : (key === 'year' ? 'newest first' : 'Z to A')
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`library-segmented-btn ${active ? 'active' : ''}`}
                        onClick={() => handleAlbumSortKeyClick(key)}
                        aria-pressed={active}
                        aria-label={`Sort albums by ${label}${active ? `, ${directionLabel}. Activate to reverse.` : ''}`}
                        title={`Sort albums by ${label}${active ? ` (${directionLabel})` : ''}`}
                      >
                        <span>{label}</span>
                        {active && <span className="library-sort-direction" aria-hidden="true">{effectiveAlbumSortState.direction === 'desc' ? '↑' : '↓'}</span>}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          {isArtistRootView && (
            <div className="library-artist-view-controls">
              {artistBrowseMode === 'canonical' && (
                <button
                  type="button"
                  className={`library-artist-collabs-toggle ${includeCollabArtists ? 'active' : ''}`}
                  onClick={handleToggleIncludeCollabArtists}
                  role="switch"
                  aria-checked={includeCollabArtists}
                  aria-label="Include collab-only artists"
                  title="Include collab-only artists"
                >
                  Collabs
                </button>
              )}
              <div className="library-segmented-toggle library-artist-view-toggle" role="group" aria-label="Artist view mode">
                <span
                  className="library-segmented-highlight"
                  aria-hidden="true"
                  style={{ transform: artistRootViewMode === 'grid' ? 'translateX(100%)' : 'translateX(0%)' }}
                />
                <button
                  type="button"
                  className={`library-segmented-btn ${artistRootViewMode === 'list' ? 'active' : ''}`}
                  onClick={() => setArtistRootViewMode('list')}
                  aria-label="Show artists as list"
                  aria-pressed={artistRootViewMode === 'list'}
                  title="List view"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M8 6h13" />
                    <path d="M8 12h13" />
                    <path d="M8 18h13" />
                    <path d="M3 6h.01" />
                    <path d="M3 12h.01" />
                    <path d="M3 18h.01" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`library-segmented-btn ${artistRootViewMode === 'grid' ? 'active' : ''}`}
                  onClick={() => setArtistRootViewMode('grid')}
                  aria-label="Show artists as grid"
                  aria-pressed={artistRootViewMode === 'grid'}
                  title="Grid view"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="7" height="7" rx="1" />
                    <rect x="14" y="3" width="7" height="7" rx="1" />
                    <rect x="3" y="14" width="7" height="7" rx="1" />
                    <rect x="14" y="14" width="7" height="7" rx="1" />
                  </svg>
                </button>
              </div>
            </div>
          )}
          {isTrackRootView && (
            <RootTrackTableControls
              layout={rootTrackTableLayout}
              sortRules={tracksViewSortRules}
              ratingsEnabled={ratingsEnabled}
              responsiveHiddenColumns={responsiveHiddenTrackColumns}
              onLayoutChange={setRootTrackTableLayout}
              onSortRulesChange={setTracksViewSortRules}
            />
          )}
          {isCollectionActionContext && (
            <button
              type="button"
              className={`icon-btn library-play-btn ${inDetailView ? 'library-collection-action-btn' : ''}`}
              onClick={() => {
                void handlePlayTracklist()
              }}
              title="Play tracklist"
              aria-label="Play tracklist"
              disabled={isCollectionPlayDisabled}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
              <span className="library-collection-action-label">Play</span>
            </button>
          )}
          {isCollectionActionContext && (
            <button
              type="button"
              className={`icon-btn library-shuffle-btn ${inDetailView ? 'library-collection-action-btn' : ''} ${shuffle ? 'active' : ''}`}
              onClick={toggleShuffle}
              title={shuffle ? 'Shuffle on' : 'Shuffle off'}
              aria-label="Shuffle"
              aria-pressed={shuffle}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M16 3h5v5" />
                <path d="M4 20 21 3" />
                <path d="M21 16v5h-5" />
                <path d="M15 15 21 21" />
                <path d="M4 4 9 9" />
              </svg>
              <span className="library-shuffle-btn-label">Shuffle</span>
            </button>
          )}
          {isCollectionActionContext && inDetailView && (
            <QueueSplitButton trackPaths={queueTrackPaths} disabled={queueTrackPaths.length === 0} />
          )}
          {selectedArtist && graphEnabled && (
            <button
              type="button"
              className="icon-btn library-collection-action-btn library-detail-graph-btn"
              onClick={handleOpenSelectedArtistInGraph}
              title="Open in Graph"
              aria-label="Open in Graph"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="5" cy="6" r="2.2" />
                <circle cx="18.5" cy="5.5" r="2.2" />
                <circle cx="12" cy="18" r="2.2" />
                <path d="M7 7.2 10.5 16" />
                <path d="m16.8 6.6-3.4 9.1" />
                <path d="M7.3 6h9" />
              </svg>
              <span className="library-collection-action-label">Graph</span>
            </button>
          )}
          {!inDetailView && renderSearchControl()}
          {!inDetailView && renderScanForChangesControl()}
        </div>
      </div>

      {renderScanProgress()}

      <div className="library-content" onScrollCapture={handleLibraryContentScrollCapture}>
        {renderContent()}
      </div>
    </div>
  )
}
