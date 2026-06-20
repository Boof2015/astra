import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLibraryStore, type LibraryArtistBrowseMode } from '../../stores/libraryStore'
import { usePlayerStore, type PlaybackSourceContext } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import { useSubsonicSettingsStore } from '../../stores/subsonicSettingsStore'
import { useJellyfinSettingsStore } from '../../stores/jellyfinSettingsStore'
import { useGraphStore } from '../../stores/graphStore'
import { Track } from '../../types/audio'
import { useHorizontalWheelScroll } from '../../hooks/useHorizontalWheelScroll'
import { buildAlbumIdentityKeyFromTrack, buildAlbumKey, getAlbumIdentityArtist, normalizeKey, splitCollaborators } from '../../utils/albumIdentity'
import { formatCompactTotalTrackDuration } from '../../utils/collectionDuration'
import TrackList, { type TrackListSortKey, type TrackListSortState } from '../library/TrackList'
import AlbumArtwork from '../library/AlbumArtwork'
import ArtistList, { type ArtistListViewMode, type ArtistListViewportAPI } from '../library/ArtistList'
import FolderTreeView from '../library/FolderTreeView'

type SortDirection = 'asc' | 'desc'
type ArtistAlbumRailMode = 'albums' | 'featured'
type AlbumSortMode = 'title' | 'artist'
type ArtistRootViewMode = ArtistListViewMode
const ALBUM_SORT_MODE_STORAGE_KEY = 'astra-library-album-sort-mode-v1'
const INCLUDE_SINGLES_IN_ALBUMS_STORAGE_KEY = 'astra-library-include-singles-in-albums-v1'
const INCLUDE_COLLAB_ARTISTS_STORAGE_KEY = 'astra-library-include-collab-artists-v1'
const ARTIST_ROOT_VIEW_MODE_STORAGE_KEY = 'astra-library-artist-view-mode-v1'

function loadAlbumSortModeSetting(): AlbumSortMode {
  try {
    const stored = localStorage.getItem(ALBUM_SORT_MODE_STORAGE_KEY)
    return stored === 'artist' ? 'artist' : 'title'
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

function loadArtistRootViewModeSetting(): ArtistRootViewMode {
  try {
    return localStorage.getItem(ARTIST_ROOT_VIEW_MODE_STORAGE_KEY) === 'grid' ? 'grid' : 'list'
  } catch {
    return 'list'
  }
}

function formatTrackCount(count: number): string {
  return `${count} ${count === 1 ? 'track' : 'tracks'}`
}

function normalizeSortText(value: string | null | undefined): string {
  return (value ?? '').trim()
}

function compareTextValue(a: string | null | undefined, b: string | null | undefined): number {
  return normalizeSortText(a).localeCompare(normalizeSortText(b), undefined, { sensitivity: 'base' })
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

  return compareWithDirection(aValue.localeCompare(bValue, undefined, { sensitivity: 'base' }), direction)
}

function comparePath(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
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
  track: { title: string; artist: string; artist_names?: string[] | null; album: string; album_artist_names?: string[] | null },
  normalizedQuery: string
): boolean {
  return track.title.toLowerCase().includes(normalizedQuery)
    || track.artist.toLowerCase().includes(normalizedQuery)
    || track.album.toLowerCase().includes(normalizedQuery)
    || (track.artist_names ?? []).some((artist) => artist.toLowerCase().includes(normalizedQuery))
    || (track.album_artist_names ?? []).some((artist) => artist.toLowerCase().includes(normalizedQuery))
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
  const folders = useLibraryStore((state) => state.folders)
  const viewMode = useLibraryStore((state) => state.viewMode)
  const selectedAlbum = useLibraryStore((state) => state.selectedAlbum)
  const selectedArtist = useLibraryStore((state) => state.selectedArtist)
  const selectionOrigin = useLibraryStore((state) => state.selectionOrigin)
  const isLoading = useLibraryStore((state) => state.isLoading)
  const isScanning = useLibraryStore((state) => state.isScanning)
  const isCancelingScan = useLibraryStore((state) => state.isCancelingScan)
  const scanProgress = useLibraryStore((state) => state.scanProgress)
  const scanStage = useLibraryStore((state) => state.scanStage)
  const cancelScan = useLibraryStore((state) => state.cancelScan)
  const loadAlbumsIncludingSingles = useLibraryStore((state) => state.loadAlbumsIncludingSingles)
  const loadFullTracks = useLibraryStore((state) => state.loadFullTracks)
  const releaseFullTracks = useLibraryStore((state) => state.releaseFullTracks)
  const setViewMode = useLibraryStore((state) => state.setViewMode)
  const selectAlbum = useLibraryStore((state) => state.selectAlbum)
  const selectArtist = useLibraryStore((state) => state.selectArtist)
  const clearSelection = useLibraryStore((state) => state.clearSelection)
  const goBackSelection = useLibraryStore((state) => state.goBackSelection)
  const showTracklistBpmKey = useLibraryStore((state) => state.showTracklistBpmKey)
  const showTracklistAddedDate = useLibraryStore((state) => state.showTracklistAddedDate)
  const subsonicSources = useSubsonicSettingsStore((state) => state.sources)
  const jellyfinSources = useJellyfinSettingsStore((state) => state.sources)

  const loadTrack = usePlayerStore((s) => s.loadTrack)
  const autoQueue = usePlayerStore((s) => s.autoQueue)
  const shuffle = usePlayerStore((s) => s.shuffle)
  const startPlaybackContextByPaths = usePlayerStore((s) => s.startPlaybackContextByPaths)
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const graphEnabled = useGraphStore((s) => s.enabled)
  const openFocusedGraph = useGraphStore((s) => s.openFocusedGraph)
  const libraryTrackRevealRequest = useUIStore((s) => s.libraryTrackRevealRequest)
  const clearLibraryTrackRevealRequest = useUIStore((s) => s.clearLibraryTrackRevealRequest)
  const pendingLibrarySearchQuery = useUIStore((s) => s.pendingLibrarySearchQuery)
  const consumePendingLibrarySearchQuery = useUIStore((s) => s.consumePendingLibrarySearchQuery)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortState, setSortState] = useState<TrackListSortState | null>({ key: 'title', direction: 'asc' })
  const [artistAlbumRailMode, setArtistAlbumRailMode] = useState<ArtistAlbumRailMode>('albums')
  const artistBrowseMode = useLibraryStore((state) => state.artistBrowseMode)
  const setArtistImageFromFile = useLibraryStore((state) => state.setArtistImageFromFile)
  const clearArtistImage = useLibraryStore((state) => state.clearArtistImage)
  const [albumSortMode, setAlbumSortMode] = useState<AlbumSortMode>(() => loadAlbumSortModeSetting())
  const [includeSinglesInAlbums, setIncludeSinglesInAlbums] = useState(() => loadIncludeSinglesInAlbumsSetting())
  const [includeCollabArtists, setIncludeCollabArtists] = useState(() => loadIncludeCollabArtistsSetting())
  const [artistRootViewMode, setArtistRootViewMode] = useState<ArtistRootViewMode>(() => loadArtistRootViewModeSetting())
  const [selectedSourceFilters, setSelectedSourceFilters] = useState<Set<string>>(new Set())
  const [isShufflePlayPending, setIsShufflePlayPending] = useState(false)
  const [isUpdatingArtistImage, setIsUpdatingArtistImage] = useState(false)
  const [isArtistImageMenuOpen, setIsArtistImageMenuOpen] = useState(false)
  const previousInDetailViewRef = useRef(false)
  const shufflePlayPendingRef = useRef(false)
  const albumGridRef = useRef<HTMLDivElement | null>(null)
  const albumGridScrollRef = useRef(0)
  const artistViewportRef = useRef<ArtistListViewportAPI | null>(null)
  const artistScrollRef = useRef(0)
  const artistImageControlRef = useRef<HTMLDivElement | null>(null)
  const artistAlbumRailRef = useRef<HTMLDivElement | null>(null)
  const pendingScrollRef = useRef<'albums' | 'artists' | null>(null)

  useHorizontalWheelScroll(artistAlbumRailRef)

  const normalizedQuery = searchQuery.trim().toLowerCase()
  const hasSearchQuery = normalizedQuery.length > 0
  const inDetailView = Boolean(selectedAlbum || selectedArtist)
  const isAlbumRootView = viewMode === 'albums' && !selectedAlbum && !selectedArtist
  const isArtistRootView = viewMode === 'artists' && !selectedAlbum && !selectedArtist
  const isTracklistContext = Boolean(selectedAlbum || selectedArtist || viewMode === 'tracks')
  const shouldRetainFullTracks = !selectedAlbum && !selectedArtist && (
    viewMode === 'tracks' || viewMode === 'folders' || selectedSourceFilters.size > 0
  )
  const isFullTrackListPending = shouldRetainFullTracks && totalTrackCount > 0 && fullTrackPaths.length === 0
  const activeTrackPaths = shouldRetainFullTracks ? fullTrackPaths : trackPaths
  const tracks = useMemo(
    () => resolveTrackPaths(activeTrackPaths),
    [activeTrackPaths, resolveTrackPaths, trackCacheVersion]
  )
  const sortContextKey = useMemo(() => {
    if (selectedAlbum) {
      const identityKey = selectedAlbum.identity_key?.trim()
      if (identityKey) return `album:${identityKey}`
      return `album:${selectedAlbum.album.trim().toLocaleLowerCase()}::${selectedAlbum.artist.trim().toLocaleLowerCase()}`
    }
    if (selectedArtist) {
      return `artist:${selectedArtist.trim().toLocaleLowerCase()}`
    }
    return 'library-root'
  }, [selectedAlbum, selectedArtist])
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
    return null
  }, [selectedAlbum, selectedArtist])
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
  const selectedArtistRecord = useMemo(() => {
    if (!selectedArtist) return null
    const selectedArtistKey = normalizeKey(selectedArtist)
    return artists.find((artist) => normalizeKey(artist.artist) === selectedArtistKey) ?? null
  }, [artists, selectedArtist])
  const selectedArtistArtworkHash = selectedArtistRecord?.artwork_hash ?? null
  const selectedArtistArtworkSource = selectedArtistRecord?.artwork_source ?? null
  const canResetSelectedArtistImage = selectedArtistArtworkSource === 'manual'

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
    setSelectedSourceFilters(new Set())
  }, [libraryTrackRevealRequest])

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
    try {
      localStorage.setItem(ALBUM_SORT_MODE_STORAGE_KEY, albumSortMode)
    } catch {
      // Ignore localStorage write failures in restricted environments.
    }
  }, [albumSortMode])

  useEffect(() => {
    try {
      localStorage.setItem(INCLUDE_SINGLES_IN_ALBUMS_STORAGE_KEY, includeSinglesInAlbums ? '1' : '0')
    } catch {
      // Ignore localStorage write failures in restricted environments.
    }
  }, [includeSinglesInAlbums])

  useEffect(() => {
    try {
      localStorage.setItem(INCLUDE_COLLAB_ARTISTS_STORAGE_KEY, includeCollabArtists ? '1' : '0')
    } catch {
      // Ignore localStorage write failures in restricted environments.
    }
  }, [includeCollabArtists])

  useEffect(() => {
    try {
      localStorage.setItem(ARTIST_ROOT_VIEW_MODE_STORAGE_KEY, artistRootViewMode)
    } catch {
      // Ignore localStorage write failures in restricted environments.
    }
  }, [artistRootViewMode])

  useEffect(() => {
    if (!includeSinglesInAlbums || !isAlbumRootView || albumsIncludingSinglesLoaded) return
    void loadAlbumsIncludingSingles()
  }, [albumsIncludingSinglesLoaded, includeSinglesInAlbums, isAlbumRootView, loadAlbumsIncludingSingles])

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

    setSelectedSourceFilters((current) => {
      if (current.size === 0) return current
      const next = new Set<string>()
      for (const key of current) {
        if (validFilterKeys.has(key)) {
          next.add(key)
        }
      }
      return next.size === current.size ? current : next
    })
  }, [jellyfinSources, subsonicSources])

  useEffect(() => {
    if (shouldShowSourceFilters) return
    setSelectedSourceFilters((current) => (current.size === 0 ? current : new Set()))
  }, [shouldShowSourceFilters])

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

  useLayoutEffect(() => {
    if (selectedAlbum) {
      setSortState(null)
      return
    }
    setSortState({ key: 'title', direction: 'asc' })
  }, [sortContextKey, selectedAlbum])

  useLayoutEffect(() => {
    const pending = pendingScrollRef.current
    if (pending === 'albums' && albumGridRef.current) {
      albumGridRef.current.scrollTop = albumGridScrollRef.current
      pendingScrollRef.current = null
    } else if (pending === 'artists' && artistViewportRef.current?.element) {
      artistViewportRef.current.element.scrollTop = artistScrollRef.current
      pendingScrollRef.current = null
    }
  })

  useEffect(() => {
    if (!sortState) return
    const hideBpmKeySort = !showTracklistBpmKey && (sortState.key === 'bpm' || sortState.key === 'musical_key')
    const hideAddedSort = !showTracklistAddedDate && sortState.key === 'added'
    if (!hideBpmKeySort && !hideAddedSort) return
    setSortState(selectedAlbum ? null : { key: 'title', direction: 'asc' })
  }, [selectedAlbum, showTracklistAddedDate, showTracklistBpmKey, sortState])

  const handleSortColumnToggle = useCallback((key: TrackListSortKey) => {
    setSortState((current) => {
      if (current?.key === key) {
        return {
          key,
          direction: current.direction === 'asc' ? 'desc' : 'asc'
        }
      }
      return {
        key,
        direction: key === 'added' ? 'desc' : 'asc'
      }
    })
  }, [])

  const handleResetToDefaultOrder = useCallback(() => {
    setSortState(null)
  }, [])

  const handleSetAlbumSortMode = useCallback((mode: AlbumSortMode) => {
    setAlbumSortMode(mode)
  }, [])

  const handleToggleIncludeSinglesInAlbums = useCallback(() => {
    setIncludeSinglesInAlbums((current) => !current)
  }, [])

  const handleToggleIncludeCollabArtists = useCallback(() => {
    setIncludeCollabArtists((current) => !current)
  }, [])

  const handleResetSourceFilters = useCallback(() => {
    setSelectedSourceFilters(new Set())
  }, [])

  const handleToggleSourceFilter = useCallback((filterKey: string) => {
    setSelectedSourceFilters((current) => {
      const next = new Set(current)
      if (next.has(filterKey)) {
        next.delete(filterKey)
      } else {
        next.add(filterKey)
      }
      return next
    })
  }, [])

  const handleSelectArtistFromList = useCallback(async (artistName: string) => {
    artistScrollRef.current = artistViewportRef.current?.element?.scrollTop ?? 0
    await selectArtist(artistName, 'library')
  }, [selectArtist])

  const sourceFilteredTracks = useMemo(() => {
    if (!shouldShowSourceFilters || selectedSourceFilters.size === 0) return tracks

    return tracks.filter((track) => {
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
  }, [selectedSourceFilters, shouldShowSourceFilters, tracks])

  const queueSeedSortedTracks = useMemo(() => {
    const sorted = [...sourceFilteredTracks]

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
      } else if (sortState.key === 'added') {
        comparison = compareAddedAt(a, b, sortState.direction)
      } else {
        comparison = compareNullableKey(a.musical_key, b.musical_key, sortState.direction)
      }

      if (comparison !== 0) return comparison
      return comparePath(a.path, b.path)
    })

    return sorted
  }, [sortState, sourceFilteredTracks])
  const isShufflePlayDisabled = isShufflePlayPending || queueSeedSortedTracks.length === 0
  const isShufflePlayActive = useMemo(() => {
    if (!shuffle) return false
    if (autoQueue.length === 0) return false
    if (autoQueue.length !== queueSeedSortedTracks.length) return false

    for (let index = 0; index < autoQueue.length; index += 1) {
      if (autoQueue[index]?.path !== queueSeedSortedTracks[index]?.path) {
        return false
      }
    }

    return true
  }, [autoQueue, queueSeedSortedTracks, shuffle])

  const handleShufflePlayTracklist = useCallback(async () => {
    if (shufflePlayPendingRef.current) return
    if (queueSeedSortedTracks.length === 0) return

    shufflePlayPendingRef.current = true
    setIsShufflePlayPending(true)

    try {
      const queueTrackPaths = queueSeedSortedTracks.map((track) => track.path)
      const randomStartIndex = Math.floor(Math.random() * queueTrackPaths.length)

      await startPlaybackContextByPaths(queueTrackPaths, randomStartIndex, {
        contextLabel: selectedAlbum?.album ?? selectedArtist ?? 'Library',
        sourceContext: playbackSourceContext
      })
      if (!shuffle) {
        toggleShuffle()
      }
    } catch (error) {
      console.error('Failed to shuffle play tracklist:', error)
    } finally {
      shufflePlayPendingRef.current = false
      setIsShufflePlayPending(false)
    }
  }, [playbackSourceContext, queueSeedSortedTracks, selectedAlbum?.album, selectedArtist, shuffle, startPlaybackContextByPaths, toggleShuffle])

  const displayTracks = useMemo(() => {
    if (!hasSearchQuery) return queueSeedSortedTracks
    return queueSeedSortedTracks.filter((track) => trackMatchesLibraryQuery(track, normalizedQuery))
  }, [hasSearchQuery, normalizedQuery, queueSeedSortedTracks])

  const albumGridSourceAlbums = isAlbumRootView && includeSinglesInAlbums && albumsIncludingSinglesLoaded
    ? albumsIncludingSingles
    : albums

  const sourceFilteredAlbumIdentityKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const track of sourceFilteredTracks) {
      keys.add(track.album_identity_key || buildAlbumIdentityKeyFromTrack(track))
    }
    return keys
  }, [sourceFilteredTracks])

  const sourceFilteredAlbums = useMemo(() => {
    if (!shouldShowSourceFilters || selectedSourceFilters.size === 0) return albumGridSourceAlbums
    return albumGridSourceAlbums.filter((album) => sourceFilteredAlbumIdentityKeys.has(album.identity_key))
  }, [albumGridSourceAlbums, selectedSourceFilters.size, shouldShowSourceFilters, sourceFilteredAlbumIdentityKeys])

  const filteredAlbums = useMemo(() => {
    const visibleAlbums = !hasSearchQuery
      ? sourceFilteredAlbums
      : sourceFilteredAlbums.filter((album) =>
        album.album.toLowerCase().includes(normalizedQuery)
        || album.artist.toLowerCase().includes(normalizedQuery)
      )

    const sortedAlbums = [...visibleAlbums]
    sortedAlbums.sort((a, b) => {
      if (albumSortMode === 'artist') {
        const artistCompare = compareTextValue(a.artist, b.artist)
        if (artistCompare !== 0) return artistCompare
        const albumCompare = compareTextValue(a.album, b.album)
        if (albumCompare !== 0) return albumCompare
      } else {
        const albumCompare = compareTextValue(a.album, b.album)
        if (albumCompare !== 0) return albumCompare
        const artistCompare = compareTextValue(a.artist, b.artist)
        if (artistCompare !== 0) return artistCompare
      }
      return a.identity_key.localeCompare(b.identity_key)
    })

    return sortedAlbums
  }, [albumSortMode, hasSearchQuery, normalizedQuery, sourceFilteredAlbums])

  const sourceFilteredArtistKeys = useMemo(() => {
    if (!shouldShowSourceFilters || selectedSourceFilters.size === 0) return null
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
  }, [artistBrowseMode, selectedSourceFilters.size, shouldShowSourceFilters, sourceFilteredTracks])

  const sourceFilteredPrimaryArtistKeys = useMemo(() => {
    if (artistBrowseMode !== 'canonical') return null
    if (!shouldShowSourceFilters || selectedSourceFilters.size === 0) return null

    const keys = new Set<string>()
    for (const track of sourceFilteredTracks) {
      const browseArtistKey = normalizeKey(resolveBrowseArtistForTrack(track, artistBrowseMode))
      if (browseArtistKey) keys.add(browseArtistKey)
    }
    return keys
  }, [artistBrowseMode, selectedSourceFilters.size, shouldShowSourceFilters, sourceFilteredTracks])

  const visibleArtists = useMemo(() => {
    if (!sourceFilteredArtistKeys) return artists
    return artists.filter((artist) => sourceFilteredArtistKeys.has(normalizeKey(artist.artist)))
  }, [artists, sourceFilteredArtistKeys])

  const rootVisibleArtists = useMemo(() => {
    if (artistBrowseMode !== 'canonical' || includeCollabArtists) return visibleArtists

    if (sourceFilteredPrimaryArtistKeys) {
      return visibleArtists.filter((artist) => sourceFilteredPrimaryArtistKeys.has(normalizeKey(artist.artist)))
    }

    return visibleArtists.filter((artist) => artist.primary_track_count > 0)
  }, [artistBrowseMode, includeCollabArtists, sourceFilteredPrimaryArtistKeys, visibleArtists])

  const filteredArtists = useMemo(() => {
    if (!hasSearchQuery) return rootVisibleArtists
    return rootVisibleArtists.filter((artist) => artist.artist.toLowerCase().includes(normalizedQuery))
  }, [hasSearchQuery, normalizedQuery, rootVisibleArtists])

  const albumByKey = useMemo(() => {
    const map = new Map<string, (typeof albums)[number]>()
    for (const album of albums) {
      const key = buildAlbumKey(album.album, album.artist)
      if (map.has(key)) continue
      map.set(key, album)
    }
    return map
  }, [albums])

  const albumByIdentityKey = useMemo(() => {
    const map = new Map<string, (typeof albums)[number]>()
    for (const album of albums) {
      if (map.has(album.identity_key)) continue
      map.set(album.identity_key, album)
    }
    return map
  }, [albums])

  const { primaryArtistAlbums, featuredArtistAlbums } = useMemo(() => {
    if (!selectedArtist) {
      return {
        primaryArtistAlbums: [] as (typeof albums)[number][],
        featuredArtistAlbums: [] as (typeof albums)[number][]
      }
    }

    const UNKNOWN_ALBUM_NAME = 'Unknown Album'
    const UNKNOWN_ARTIST_NAME = 'Unknown Artist'
    const matchedIdentityKeys = new Set<string>()
    const selectedArtistKey = normalizeKey(selectedArtist)
    const featuredSinglesByIdentityKey = new Map<string, (typeof albums)[number]>()

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

      if (normalizeKey(browseArtist) === selectedArtistKey) continue

      const normalizedAlbumName = track.album.trim() || UNKNOWN_ALBUM_NAME
      if (normalizeKey(normalizedAlbumName) === normalizeKey(UNKNOWN_ALBUM_NAME)) continue

      const existingSingle = featuredSinglesByIdentityKey.get(identityKey)
      if (existingSingle) {
        existingSingle.track_count += 1
        if (existingSingle.year === null || ((track.year ?? -1) > existingSingle.year)) {
          existingSingle.year = track.year
        }
        if (!existingSingle.artwork_hash && track.artwork_hash) {
          existingSingle.artwork_hash = track.artwork_hash
        }
        continue
      }

      featuredSinglesByIdentityKey.set(identityKey, {
        identity_key: identityKey,
        album: normalizedAlbumName,
        artist: identityArtist || UNKNOWN_ARTIST_NAME,
        primary_artist: resolveBrowseArtistForTrack(track, 'canonical'),
        year: track.year,
        artwork_hash: track.artwork_hash,
        track_count: 1,
        is_new: false
      })
    }

    const primary: (typeof albums)[number][] = []
    const featured: (typeof albums)[number][] = []

    for (const album of albums) {
      if (!matchedIdentityKeys.has(album.identity_key)) continue

      const primaryArtistKey = artistBrowseMode === 'strict'
        ? normalizeKey(album.artist)
        : normalizeKey(album.primary_artist ?? '')

      if (primaryArtistKey === selectedArtistKey) {
        primary.push(album)
      } else {
        featured.push(album)
      }
    }

    for (const single of featuredSinglesByIdentityKey.values()) {
      featured.push(single)
    }

    featured.sort((a, b) => {
      const albumCompare = a.album.localeCompare(b.album, undefined, { sensitivity: 'base' })
      if (albumCompare !== 0) return albumCompare
      const artistCompare = a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' })
      if (artistCompare !== 0) return artistCompare
      return a.identity_key.localeCompare(b.identity_key)
    })

    return {
      primaryArtistAlbums: primary,
      featuredArtistAlbums: featured
    }
  }, [albumByIdentityKey, albumByKey, albums, artistBrowseMode, selectedArtist, sourceFilteredTracks])

  const trimmedQueryForMessage = searchQuery.trim()
  const searchPlaceholder = inDetailView
    ? 'Search tracks...'
    : viewMode === 'albums'
      ? 'Search albums...'
      : viewMode === 'artists'
        ? 'Search artists...'
      : viewMode === 'folders'
          ? 'Search folders & tracks...'
          : 'Search tracks...'
  const isAllSourcesFilterActive = selectedSourceFilters.size === 0

  const handleBack = async () => {
    const restored = await goBackSelection()
    if (restored) return

    const shouldReturnHome = selectionOrigin === 'home'
    if (shouldReturnHome) {
      setActiveView('home')
    } else {
      if (viewMode === 'albums') pendingScrollRef.current = 'albums'
      else if (viewMode === 'artists') pendingScrollRef.current = 'artists'
    }
    await clearSelection()
  }

  const handleOpenFile = async () => {
    const result = await window.electronAPI.openAudioFile()
    if (result) {
      const track: Track = {
        id: result.path,
        path: result.path,
        title: result.metadata?.title ?? result.name,
        artist: result.metadata?.artist ?? 'Unknown Artist',
        artistNames: result.metadata?.artistNames,
        album: result.metadata?.album ?? 'Unknown Album',
        albumArtist: result.metadata?.albumArtist,
        albumArtistNames: result.metadata?.albumArtistNames,
        duration: result.metadata?.duration ?? 0,
        format: result.metadata?.format ?? 'unknown',
        artworkData: result.metadata?.artwork,
        channels: result.metadata?.channels,
        codec: result.metadata?.codec,
        codecProfile: result.metadata?.codecProfile,
        isAtmosJoc: result.metadata?.isAtmosJoc,
        replayGainTrackDb: result.metadata?.replayGainTrackDb,
        replayGainAlbumDb: result.metadata?.replayGainAlbumDb,
      }
      await loadTrack(track, result.data)
    }
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
  } else if (viewMode === 'albums') {
    itemCount = filteredAlbums.length
    itemLabel = filteredAlbums.length === 1 ? 'album' : 'albums'
  } else if (viewMode === 'artists') {
    itemCount = filteredArtists.length
    itemLabel = filteredArtists.length === 1 ? 'artist' : 'artists'
  } else if (viewMode === 'folders') {
    itemCount = sourceFilteredTracks.length
    itemLabel = sourceFilteredTracks.length === 1 ? 'track' : 'tracks'
  }
  const selectedAlbumDurationLabel = selectedAlbum
    ? formatCompactTotalTrackDuration(displayTracks)
    : null

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

    const hasContent = sourceFilteredTracks.length > 0 || sourceFilteredAlbums.length > 0 || visibleArtists.length > 0
    if (!hasContent && !selectedAlbum && !selectedArtist) {
      return (
        <div className="library-empty">
          <div className="empty-icon">&#9835;</div>
          <p>Your library is empty</p>
          <p className="empty-hint">Use Settings &gt; Library &gt; Add Folder to scan your music</p>
        </div>
      )
    }

    if (hasSearchQuery && displayTracks.length === 0 && (selectedAlbum || viewMode === 'tracks') && !selectedArtist) {
      return (
        <div className="library-empty">
          <p>No tracks found for "{trimmedQueryForMessage}"</p>
        </div>
      )
    }

    // Folder tree
    if (viewMode === 'folders' && !selectedAlbum && !selectedArtist) {
      return <FolderTreeView tracks={sourceFilteredTracks} allTracks={tracks} folders={folders} searchQuery={searchQuery} />
    }

    // Albums grid
    if (viewMode === 'albums' && !selectedAlbum && !selectedArtist) {
      if (filteredAlbums.length === 0) {
        return hasSearchQuery
          ? <div className="library-empty"><p>No albums found for "{trimmedQueryForMessage}"</p></div>
          : <div className="library-empty"><p>No albums found</p></div>
      }
      return (
        <div className="album-grid" ref={albumGridRef}>
          {filteredAlbums.map((album) => (
            <div
              key={album.identity_key}
              className="album-card"
              onClick={() => {
                albumGridScrollRef.current = albumGridRef.current?.scrollTop ?? 0
                void selectAlbum(album.album, album.artist, 'library', album.identity_key)
              }}
            >
              {album.is_new && (
                <span className="library-latest-sync-pill album-card-sync-pill" title="Added in latest library sync">
                  NEW
                </span>
              )}
              <div className="album-artwork">
                <AlbumArtwork hash={album.artwork_hash} alt={album.album} variant="card" />
              </div>
              <div className="album-info">
                <div className="album-title">{album.album}</div>
                <div className="album-artist">{album.artist}</div>
                <div className="album-meta">{formatTrackCount(album.track_count)}{album.year ? ` \u2022 ${album.year}` : ''}</div>
              </div>
            </div>
          ))}
        </div>
      )
    }

    // Artists list
    if (viewMode === 'artists' && !selectedAlbum && !selectedArtist) {
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
        />
      )
    }

    if (selectedArtist) {
      const showingFeaturedAlbums = artistAlbumRailMode === 'featured'
      const visibleArtistAlbums = showingFeaturedAlbums ? featuredArtistAlbums : primaryArtistAlbums
      const railEmptyMessage = showingFeaturedAlbums
        ? 'No featured appearances found in indexed albums or singles.'
        : 'No primary albums found in indexed albums.'

      return (
        <div className="library-artist-detail">
          <section className="library-artist-rail">
            <div className="library-artist-rail-header">
              <h3>Albums</h3>
              <div className="library-artist-rail-action-row">
                {graphEnabled && (
                  <button
                    type="button"
                    className="library-artist-graph-btn"
                    onClick={handleOpenSelectedArtistInGraph}
                  >
                    Open In Graph
                  </button>
                )}
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
              <div className="library-artist-rail-row" ref={artistAlbumRailRef}>
                {visibleArtistAlbums.map((album) => (
                  <button
                    key={album.identity_key}
                    type="button"
                    className="library-artist-rail-card"
                    onClick={() => void selectAlbum(album.album, album.artist, 'library', album.identity_key)}
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
              <div className="library-artist-rail-empty">{railEmptyMessage}</div>
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
            trackNumberMode={selectedAlbum ? 'album' : 'none'}
            externalScroll
            enableColumnSorting
            sortState={sortState}
            onSortColumnToggle={handleSortColumnToggle}
            enableDefaultOrderReset={Boolean(selectedAlbum)}
            onDefaultOrderReset={selectedAlbum ? handleResetToDefaultOrder : undefined}
            jumpToTrackRequest={libraryTrackRevealRequest}
            onJumpToTrackRequestConsumed={clearLibraryTrackRevealRequest}
          />
        </div>
      )
    }

    // Tracks
    return (
      <TrackList
        tracks={displayTracks}
        queueSeedTracks={queueSeedSortedTracks}
        queueContextLabel={selectedAlbum?.album ?? selectedArtist ?? 'Library'}
        sourceContext={playbackSourceContext}
        showArtist={!selectedArtist}
        showAlbum={!selectedAlbum}
        showAddedDate={showTracklistAddedDate}
        showNewTrackIndicator
        trackNumberMode={selectedAlbum ? 'album' : 'none'}
        enableColumnSorting
        sortState={sortState}
        onSortColumnToggle={handleSortColumnToggle}
        enableDefaultOrderReset={Boolean(selectedAlbum)}
        onDefaultOrderReset={selectedAlbum ? handleResetToDefaultOrder : undefined}
        jumpToTrackRequest={libraryTrackRevealRequest}
        onJumpToTrackRequestConsumed={clearLibraryTrackRevealRequest}
      />
    )
  }

  return (
    <div className="library-view">
      <div className="library-header">
        <div className="library-header-left">
          {(selectedAlbum || selectedArtist) && (
            <button className="back-btn" onClick={handleBack} title="Back">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
              </svg>
            </button>
          )}
          {selectedArtist && (
            <div className="library-header-artist-image-control" ref={artistImageControlRef}>
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
              {isArtistImageMenuOpen && (
                <div className="library-header-artist-image-menu" role="menu">
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
          <h2>{title}</h2>
          {selectedAlbum?.is_new && (
            <span className="library-latest-sync-pill library-header-sync-pill" title="Added in latest library sync">
              NEW
            </span>
          )}
          {showViewTabs && (
            <div className="view-tabs">
              <button
                className={`view-tab ${viewMode === 'tracks' ? 'active' : ''}`}
                onClick={() => setViewMode('tracks')}
              >
                Tracks
              </button>
              <button
                className={`view-tab ${viewMode === 'albums' ? 'active' : ''}`}
                onClick={() => setViewMode('albums')}
              >
                Albums
              </button>
              <button
                className={`view-tab ${viewMode === 'artists' ? 'active' : ''}`}
                onClick={() => setViewMode('artists')}
              >
                Artists
              </button>
              <button
                className={`view-tab ${viewMode === 'folders' ? 'active' : ''}`}
                onClick={() => setViewMode('folders')}
              >
                Folders
              </button>
            </div>
          )}
          <span className="track-count">
            {itemCount} {itemLabel}
            {selectedAlbumDurationLabel ? ` \u00b7 ${selectedAlbumDurationLabel}` : ''}
          </span>
          {shouldShowSourceFilters && (
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
          )}
        </div>
        <div className="library-header-right">
          {isAlbumRootView && (
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
              <div className="library-segmented-toggle" role="group" aria-label="Album sort mode">
                <span
                  className="library-segmented-highlight"
                  aria-hidden="true"
                  style={{ transform: albumSortMode === 'artist' ? 'translateX(100%)' : 'translateX(0%)' }}
                />
                <button
                  type="button"
                  className={`library-segmented-btn ${albumSortMode === 'title' ? 'active' : ''}`}
                  onClick={() => handleSetAlbumSortMode('title')}
                  aria-pressed={albumSortMode === 'title'}
                  title="Sort albums by title"
                >
                  Title
                </button>
                <button
                  type="button"
                  className={`library-segmented-btn ${albumSortMode === 'artist' ? 'active' : ''}`}
                  onClick={() => handleSetAlbumSortMode('artist')}
                  aria-pressed={albumSortMode === 'artist'}
                  title="Sort albums by artist"
                >
                  Artist
                </button>
              </div>
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
          {isTracklistContext && (
            <button
              type="button"
              className={`icon-btn library-shuffle-btn ${isShufflePlayActive ? 'active' : ''}`}
              onClick={() => {
                void handleShufflePlayTracklist()
              }}
              title="Shuffle play tracklist"
              aria-label="Shuffle play tracklist"
              disabled={isShufflePlayDisabled}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 3h5v5" />
                <path d="M4 20 21 3" />
                <path d="M21 16v5h-5" />
                <path d="M15 15 21 21" />
                <path d="M4 4 9 9" />
              </svg>
              <span className="library-shuffle-btn-label">Shuffle all</span>
            </button>
          )}
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
              onChange={(e) => setSearchQuery(e.target.value)}
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
          <button className="icon-btn" onClick={handleOpenFile} title="Open File">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
            </svg>
          </button>
        </div>
      </div>

      {renderScanProgress()}

      <div className="library-content">
        {renderContent()}
      </div>
    </div>
  )
}
