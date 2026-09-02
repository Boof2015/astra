import { DragEvent, useCallback, useEffect, useMemo, useRef, useState, type UIEvent as ReactUIEvent } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'
import { useRatingsStore, type TrackRatingState } from '../../stores/ratingsStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import {
  buildAllDisplayPlaylists,
  buildSidebarPlaylistSections,
  FAVORITES_PLAYLIST_ID,
  FAVORITES_PLAYLIST_NAME,
  isSystemFavoritesPlaylistId,
  sortPlaylistBrowserEntries
} from '../../utils/playlistSystem'
import { formatCompactTotalTrackDuration } from '../../utils/collectionDuration'
import { formatPlaylistExportStatus, formatPlaylistImportStatus, type PlaylistImportStatus } from '../../utils/playlistImportStatus'
import { buildVisiblePlaylistSearchRows } from '../../utils/playlistSearch'
import { matchesFuzzyFields } from '../../utils/fuzzySearch'
import { compareTrackPlayCounts } from '../../utils/trackPlayCountSort'
import { compareBaseLocaleText } from '../../utils/localeSort'
import { getDetailHeaderCollapseDistance, resolveDetailHeaderCollapsed } from '../../utils/detailHeaderScroll'
import { runViewTransition } from '../../utils/viewTransitions'
import AlbumArtwork from '../library/AlbumArtwork'
import TrackList, { type TrackListSortKey, type TrackListSortState } from '../library/TrackList'
import CreatePlaylistModal from '../playlists/CreatePlaylistModal'
import DynamicPlaylistRuleEditor from '../playlists/DynamicPlaylistRuleEditor'
import PlaylistCover from '../playlists/PlaylistCover'
import QueueSplitButton from '../queue/QueueSplitButton'
import ConfirmActionModal from '../settings/ConfirmActionModal'
import SearchEmptyState from '../search/SearchEmptyState'
import {
  createDefaultDynamicPlaylistRules,
  normalizeDynamicPlaylistRules,
  type DynamicPlaylistRulesV1
} from '../../../shared/playlists/dynamicPlaylist'

const PLAYLIST_IMPORT_STATUS_TIMEOUT_MS = 9000
const PLAYLIST_ASSOCIATION_AUDIO_FILTER = [{
  name: 'Audio Files',
  extensions: ['mp3', 'flac', 'wav', 'ogg', 'aac', 'm4a', 'opus', 'wma', 'aiff', 'alac', 'ape', 'wv', 'iamf', 'mp4']
}]

type SortDirection = 'asc' | 'desc'
type PlaylistTrack = ReturnType<typeof usePlaylistStore.getState>['selectedPlaylistTracks'][number]
type PlaylistEntry = ReturnType<typeof usePlaylistStore.getState>['selectedPlaylistEntries'][number]

interface PlaylistDisplayRow {
  track: PlaylistTrack
  entryId: number | null
  defaultNumber: number
  instanceKey: string
}

function getMissingPlaylistEntryLabel(entry: PlaylistEntry): string {
  if (entry.title?.trim()) return entry.title
  const parts = entry.track_path.split(/[\\/]/)
  return parts[parts.length - 1] || entry.track_path
}

function createMissingPlaylistTrackPlaceholder(entry: PlaylistEntry, index: number): PlaylistTrack {
  return {
    id: -Math.max(1, entry.id),
    path: entry.track_path,
    album_identity_key: `missing-playlist-entry:${entry.id}`,
    is_new: false,
    title: getMissingPlaylistEntryLabel(entry),
    artist: entry.artist?.trim() || 'Missing playlist entry',
    artist_names: entry.artist?.trim() ? [entry.artist] : [],
    album: entry.album?.trim() || '',
    album_artist: null,
    album_artist_names: [],
    duration: 0,
    track_number: index + 1,
    disc_number: null,
    year: null,
    genre: null,
    genres: [],
    artwork_hash: null,
    format: 'missing',
    sample_rate: null,
    bit_depth: null,
    bitrate: null,
    channels: null,
    bpm: null,
    musical_key: null,
    source_type: 'local',
    source_id: null,
    source_track_id: null,
    source_path: null,
    is_available: 0,
    availability_reason: 'missing_playlist_entry',
    file_created_at: null,
    play_count: 0,
    last_played_at: null,
    replaygain_track_gain_db: null,
    replaygain_album_gain_db: null,
    added_at: entry.added_at,
    modified_at: entry.added_at
  }
}

function isMissingPlaylistDisplayTrack(track: PlaylistTrack): boolean {
  return track.availability_reason === 'missing_playlist_entry'
}

function PlaylistImportStatusBanner({ status }: { status: PlaylistImportStatus }) {
  return (
    <div
      className={`playlist-import-status home-playlist-import-status home-playlist-import-status-${status.tone}`}
      role={status.tone === 'error' ? 'alert' : 'status'}
    >
      {status.message}
    </div>
  )
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

function comparePath(a: string, b: string): number {
  return compareBaseLocaleText(a, b)
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

function compareNullableRating(a: number | null | undefined, b: number | null | undefined, direction: SortDirection): number {
  const aMissing = typeof a !== 'number'
  const bMissing = typeof b !== 'number'

  if (aMissing && bMissing) return 0
  if (aMissing) return 1
  if (bMissing) return -1

  return compareWithDirection(a - b, direction)
}

function comparePlaylistTracksBySort(
  a: PlaylistTrack,
  b: PlaylistTrack,
  sortState: TrackListSortState,
  ratings: ReadonlyMap<string, TrackRatingState>
): number {
  if (sortState.key === 'title') {
    return compareWithDirection(compareTextValue(a.title, b.title), sortState.direction)
  }
  if (sortState.key === 'artist') {
    return compareWithDirection(compareTextValue(a.artist, b.artist), sortState.direction)
  }
  if (sortState.key === 'album') {
    return compareWithDirection(compareTextValue(a.album, b.album), sortState.direction)
  }
  if (sortState.key === 'year') {
    const aYear = typeof a.year === 'number' && Number.isFinite(a.year) ? a.year : null
    const bYear = typeof b.year === 'number' && Number.isFinite(b.year) ? b.year : null
    if (aYear === null && bYear === null) return 0
    if (aYear === null) return 1
    if (bYear === null) return -1
    return compareWithDirection(aYear - bYear, sortState.direction)
  }
  if (sortState.key === 'duration') {
    return compareNullableDuration(a.duration, b.duration, sortState.direction)
  }
  if (sortState.key === 'bpm') {
    return compareNullableBpm(a.bpm, b.bpm, sortState.direction)
  }
  if (sortState.key === 'genre') {
    return compareNullableKey(a.genre, b.genre, sortState.direction)
  }
  if (sortState.key === 'added') {
    return compareWithDirection(resolveEffectiveAddedAt(a) - resolveEffectiveAddedAt(b), sortState.direction)
  }
  if (sortState.key === 'rating') {
    return compareNullableRating(
      ratings.get(a.path)?.rating ?? null,
      ratings.get(b.path)?.rating ?? null,
      sortState.direction
    )
  }
  if (sortState.key === 'play_count') {
    return compareTrackPlayCounts(
      a.play_count,
      b.play_count,
      sortState.direction,
      isMissingPlaylistDisplayTrack(a),
      isMissingPlaylistDisplayTrack(b)
    )
  }
  if (sortState.key === 'codec') {
    return compareNullableKey(a.format, b.format, sortState.direction)
  }
  return compareNullableKey(a.musical_key, b.musical_key, sortState.direction)
}

export default function PlaylistView() {
  const {
    selectedPlaylistId,
    selectedPlaylistEntries,
    selectedPlaylistTracks,
    playlists,
    clearSelection,
    createPlaylistWithOptions,
    createDynamicPlaylistWithOptions,
    getDynamicPlaylistRules,
    updateDynamicPlaylistRules,
    previewDynamicPlaylist,
    loadPlaylists,
    selectPlaylist,
    renamePlaylist,
    deletePlaylist,
    setPlaylistCustomCoverFromFile,
    clearPlaylistCustomCover,
    reassociatePlaylistEntry,
    importPlaylistFromFile,
    exportPlaylistToM3u,
    sidebarPinnedPlaylistIds,
    browserSortMode,
    pinPlaylistToSidebar,
    unpinPlaylistFromSidebar,
    moveSidebarPinnedPlaylist,
    resetSidebarPins,
    setBrowserSortMode,
    sortState,
    setSortState
  } = usePlaylistStore()
  const setActiveView = useUIStore((s) => s.setActiveView)
  const trackDrag = useUIStore((s) => s.trackDrag)
  const playlistTrackRevealRequest = useUIStore((s) => s.playlistTrackRevealRequest)
  const clearPlaylistTrackRevealRequest = useUIStore((s) => s.clearPlaylistTrackRevealRequest)
  const openCollectionQueueMenu = useUIStore((s) => s.openCollectionQueueMenu)
  const showTracklistBpmKey = useLibraryStore((s) => s.showTracklistBpmKey)
  const showTracklistGenre = useLibraryStore((s) => s.showTracklistGenre)
  const showTracklistPlayCount = useLibraryStore((s) => s.showTracklistPlayCount)
  const ratingsEnabled = useRatingsStore((s) => s.enabled)
  const trackRatings = useRatingsStore((s) => s.ratings)
  const favoriteTrackPaths = useLibraryStore((s) => s.favoriteTrackPaths)
  const trackCacheVersion = useLibraryStore((s) => s.trackCacheVersion)
  const resolveTrackPaths = useLibraryStore((s) => s.resolveTrackPaths)
  const shuffle = usePlayerStore((s) => s.shuffle)
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle)
  const startPlaybackContextByPaths = usePlayerStore((s) => s.startPlaybackContextByPaths)
  const favoriteTracks = useMemo(
    () => resolveTrackPaths(favoriteTrackPaths),
    [favoriteTrackPaths, resolveTrackPaths, trackCacheVersion]
  )

  const isPlaylistBrowser = selectedPlaylistId === null
  const isFavoritesPlaylist = isSystemFavoritesPlaylistId(selectedPlaylistId)
  const playlist = playlists.find((p) => p.id === selectedPlaylistId)
  const isDynamicPlaylist = playlist?.kind === 'dynamic'
  const playlistName = isFavoritesPlaylist ? FAVORITES_PLAYLIST_NAME : playlist?.name
  const isSelectedPlaylistPinned = selectedPlaylistId !== null
    && sidebarPinnedPlaylistIds.includes(selectedPlaylistId)
  const allPlaylists = useMemo(
    () => buildAllDisplayPlaylists(playlists, {
      trackCount: favoriteTracks.length,
      topArtworkHash: favoriteTracks[0]?.artwork_hash ?? null
    }),
    [favoriteTracks, playlists]
  )
  const { sidebarPinnedPlaylists } = useMemo(
    () => buildSidebarPlaylistSections(playlists, {
      trackCount: favoriteTracks.length,
      topArtworkHash: favoriteTracks[0]?.artwork_hash ?? null
    }, sidebarPinnedPlaylistIds),
    [favoriteTracks, playlists, sidebarPinnedPlaylistIds]
  )
  const sidebarPinnedPlaylistIdSet = useMemo(
    () => new Set(sidebarPinnedPlaylistIds),
    [sidebarPinnedPlaylistIds]
  )
  const playlistHeaderArtwork = useMemo(() => {
    const seenPlaylistIds = new Set<number>()
    return [...sidebarPinnedPlaylists, ...allPlaylists]
      .filter((entry) => {
        if (!entry.cover_hash || seenPlaylistIds.has(entry.id)) return false
        seenPlaylistIds.add(entry.id)
        return true
      })
      .slice(0, 3)
  }, [allPlaylists, sidebarPinnedPlaylists])

  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [isUpdatingCover, setIsUpdatingCover] = useState(false)
  const [isDeletingPlaylist, setIsDeletingPlaylist] = useState(false)
  const [isCreatePlaylistModalOpen, setIsCreatePlaylistModalOpen] = useState(false)
  const [isImportingPlaylist, setIsImportingPlaylist] = useState(false)
  const [isExportingPlaylist, setIsExportingPlaylist] = useState(false)
  const [playlistImportStatus, setPlaylistImportStatus] = useState<PlaylistImportStatus | null>(null)
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false)
  const [isPlayPending, setIsPlayPending] = useState(false)
  const [isDetailHeaderCollapsed, setIsDetailHeaderCollapsed] = useState(false)
  const [isCoverMenuOpen, setIsCoverMenuOpen] = useState(false)
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false)
  const [isDynamicRulesModalOpen, setIsDynamicRulesModalOpen] = useState(false)
  const [dynamicRulesDraft, setDynamicRulesDraft] = useState<DynamicPlaylistRulesV1>(() => createDefaultDynamicPlaylistRules())
  const [dynamicRulesError, setDynamicRulesError] = useState<string | null>(null)
  const [isDynamicRulesLoading, setIsDynamicRulesLoading] = useState(false)
  const [isSavingDynamicRules, setIsSavingDynamicRules] = useState(false)
  const [playlistBrowserSearchQuery, setPlaylistBrowserSearchQuery] = useState('')
  const [playlistTrackSearchQuery, setPlaylistTrackSearchQuery] = useState('')
  const [draggedPinnedPlaylistId, setDraggedPinnedPlaylistId] = useState<number | null>(null)
  const [pinnedDropTargetId, setPinnedDropTargetId] = useState<number | null>(null)
  const playPendingRef = useRef(false)
  const detailHeaderRef = useRef<HTMLDivElement | null>(null)
  const coverControlRef = useRef<HTMLDivElement | null>(null)
  const moreMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setIsRenaming(false)
    setRenameValue('')
    setIsUpdatingCover(false)
    setIsDeletingPlaylist(false)
    setIsCreatePlaylistModalOpen(false)
    setIsExportingPlaylist(false)
    setIsDeleteConfirmOpen(false)
    setIsCoverMenuOpen(false)
    setIsMoreMenuOpen(false)
    setIsDynamicRulesModalOpen(false)
    setDynamicRulesDraft(createDefaultDynamicPlaylistRules())
    setDynamicRulesError(null)
    setIsDynamicRulesLoading(false)
    setIsSavingDynamicRules(false)
    setPlaylistTrackSearchQuery('')
  }, [selectedPlaylistId])

  useEffect(() => {
    if (!isCoverMenuOpen && !isMoreMenuOpen) return

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return

      if (isCoverMenuOpen && !coverControlRef.current?.contains(target)) {
        setIsCoverMenuOpen(false)
      }
      if (isMoreMenuOpen && !moreMenuRef.current?.contains(target)) {
        setIsMoreMenuOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setIsCoverMenuOpen(false)
      setIsMoreMenuOpen(false)
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isCoverMenuOpen, isMoreMenuOpen])

  useEffect(() => {
    if (!sortState) return
    const hideBpmKeySort = !showTracklistBpmKey && (sortState.key === 'bpm' || sortState.key === 'musical_key')
    const hideGenreSort = !showTracklistGenre && sortState.key === 'genre'
    const hideRatingSort = !ratingsEnabled && sortState.key === 'rating'
    const hidePlayCountSort = !showTracklistPlayCount && sortState.key === 'play_count'
    if (!hideBpmKeySort && !hideGenreSort && !hideRatingSort && !hidePlayCountSort) return
    setSortState(null)
  }, [ratingsEnabled, setSortState, showTracklistBpmKey, showTracklistGenre, showTracklistPlayCount, sortState])

  useEffect(() => {
    if (!playlistImportStatus) return

    const timeoutId = window.setTimeout(() => {
      setPlaylistImportStatus(null)
    }, PLAYLIST_IMPORT_STATUS_TIMEOUT_MS)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [playlistImportStatus])

  const playlistCoverHash = useMemo(() => {
    if (isFavoritesPlaylist) {
      return selectedPlaylistTracks[0]?.artwork_hash ?? null
    }
    if (!playlist) return null
    return playlist.custom_cover_hash ?? selectedPlaylistTracks[0]?.artwork_hash ?? playlist.auto_cover_hash
  }, [isFavoritesPlaylist, playlist, selectedPlaylistTracks])

  const playlistDisplayRows = useMemo<PlaylistDisplayRow[]>(() => {
    if (isFavoritesPlaylist) {
      return selectedPlaylistTracks.map((track, index) => ({
        track,
        entryId: null,
        defaultNumber: index + 1,
        instanceKey: `favorite:${track.path}`
      }))
    }

    return selectedPlaylistEntries.map((entry, index) => ({
      track: entry.track ?? createMissingPlaylistTrackPlaceholder(entry, index),
      entryId: entry.id,
      defaultNumber: (Number.isFinite(entry.position) && entry.position >= 0 ? entry.position : index) + 1,
      instanceKey: `playlist-entry:${entry.id}`
    }))
  }, [isFavoritesPlaylist, selectedPlaylistEntries, selectedPlaylistTracks])

  const displayRows = useMemo(() => {
    if (!sortState) return playlistDisplayRows

    const indexedRows = playlistDisplayRows.map((row, index) => ({ row, index }))
    indexedRows.sort((left, right) => {
      const comparison = comparePlaylistTracksBySort(left.row.track, right.row.track, sortState, trackRatings)
      if (comparison !== 0) return comparison

      const pathComparison = comparePath(left.row.track.path, right.row.track.path)
      if (pathComparison !== 0) return pathComparison

      return left.index - right.index
    })

    return indexedRows.map(({ row }) => row)
  }, [playlistDisplayRows, sortState, trackRatings])

  const displayPlayableTracks = useMemo(
    () => displayRows
      .map((row) => row.track)
      .filter((track) => !isMissingPlaylistDisplayTrack(track)),
    [displayRows]
  )
  const displayPlayableTrackPaths = useMemo(
    () => displayPlayableTracks.map((track) => track.path),
    [displayPlayableTracks]
  )
  const trimmedPlaylistTrackSearchQuery = playlistTrackSearchQuery.trim()
  const hasPlaylistTrackSearchQuery = trimmedPlaylistTrackSearchQuery.length > 0
  const visiblePlaylistSearchRows = useMemo(
    () => buildVisiblePlaylistSearchRows(
      displayRows,
      trimmedPlaylistTrackSearchQuery,
      (row) => !isMissingPlaylistDisplayTrack(row.track)
    ),
    [displayRows, trimmedPlaylistTrackSearchQuery]
  )
  const visibleDisplayRows = useMemo(
    () => visiblePlaylistSearchRows.map(({ row }) => row),
    [visiblePlaylistSearchRows]
  )
  const visibleDisplayTracks = useMemo(
    () => visibleDisplayRows.map((row) => row.track),
    [visibleDisplayRows]
  )
  const visiblePlaylistEntryIds = useMemo(
    () => visibleDisplayRows.map((row) => row.entryId),
    [visibleDisplayRows]
  )
  const visibleTrackNumbers = useMemo(
    () => visibleDisplayRows.map((row) => row.defaultNumber),
    [visibleDisplayRows]
  )
  const visibleTrackInstanceKeys = useMemo(
    () => visibleDisplayRows.map((row) => row.instanceKey),
    [visibleDisplayRows]
  )
  const visibleQueueSeedIndexes = useMemo(
    () => visiblePlaylistSearchRows.map(({ queueSeedIndex }) => queueSeedIndex),
    [visiblePlaylistSearchRows]
  )

  useEffect(() => {
    const request = playlistTrackRevealRequest
    if (!hasPlaylistTrackSearchQuery || !request || request.playlistId !== selectedPlaylistId) return

    const targetExists = displayRows.some((row) => row.track.path === request.trackPath)
    const targetIsVisible = visibleDisplayRows.some((row) => row.track.path === request.trackPath)
    if (targetExists && !targetIsVisible) {
      setPlaylistTrackSearchQuery('')
    }
  }, [
    displayRows,
    hasPlaylistTrackSearchQuery,
    playlistTrackRevealRequest,
    selectedPlaylistId,
    visibleDisplayRows
  ])

  const playlistMissingCount = selectedPlaylistEntries.reduce(
    (count, entry) => count + (entry.missing || entry.track === null ? 1 : 0),
    0
  )
  const playlistDurationLabel = formatCompactTotalTrackDuration(selectedPlaylistTracks)

  useEffect(() => {
    if (selectedPlaylistId === null || isFavoritesPlaylist) return
    void loadPlaylists()
    void selectPlaylist(selectedPlaylistId)
  }, [isFavoritesPlaylist, loadPlaylists, selectPlaylist, selectedPlaylistId, trackCacheVersion])

  const isPlayDisabled = isPlayPending || isDeletingPlaylist || displayPlayableTrackPaths.length === 0

  const isDynamicRulesDraftInvalid = useMemo(() => {
    try {
      normalizeDynamicPlaylistRules(dynamicRulesDraft)
      return false
    } catch {
      return true
    }
  }, [dynamicRulesDraft])

  const handleBack = () => {
    void runViewTransition(() => {
      clearSelection()
      setActiveView('playlist')
    }, 'playlist-context-backward')
  }

  const handleStartRename = () => {
    if (isFavoritesPlaylist) return
    setIsMoreMenuOpen(false)
    setRenameValue(playlist?.name ?? '')
    setIsRenaming(true)
  }

  const handleConfirmRename = async () => {
    if (isFavoritesPlaylist) {
      setIsRenaming(false)
      return
    }
    const name = renameValue.trim()
    if (name && selectedPlaylistId !== null) {
      await renamePlaylist(selectedPlaylistId, name)
    }
    setIsRenaming(false)
  }

  const handleCreatePlaylist = async (name: string, coverImagePath: string | null) => {
    const playlist = await createPlaylistWithOptions({ name, coverImagePath })
    await selectPlaylist(playlist.id)
    setActiveView('playlist')
  }

  const handleCreateDynamicPlaylist = async (name: string, coverImagePath: string | null, rules: DynamicPlaylistRulesV1) => {
    const playlist = await createDynamicPlaylistWithOptions({ name, coverImagePath, rules })
    await selectPlaylist(playlist.id)
    setActiveView('playlist')
  }

  const handleImportPlaylist = useCallback(async (): Promise<boolean> => {
    if (isImportingPlaylist) return false

    setIsImportingPlaylist(true)
    try {
      const result = await importPlaylistFromFile()
      if (!result) return false

      setPlaylistImportStatus(formatPlaylistImportStatus(result))

      if (result.playlistId !== null && result.playlistId > 0 && result.importedCount + result.missingEntryCount > 0) {
        await selectPlaylist(result.playlistId)
        setActiveView('playlist')
      }

      return true
    } catch (error) {
      console.error('Failed to import playlist:', error)
      const message = error instanceof Error ? error.message : 'Failed to import playlist.'
      setPlaylistImportStatus({ tone: 'error', message })
      return true
    } finally {
      setIsImportingPlaylist(false)
    }
  }, [importPlaylistFromFile, isImportingPlaylist, selectPlaylist, setActiveView])

  const handleRequestDelete = () => {
    if (isFavoritesPlaylist || isDeletingPlaylist) return
    setIsMoreMenuOpen(false)
    setIsDeleteConfirmOpen(true)
  }

  const handleOpenDynamicRules = useCallback(async () => {
    if (!isDynamicPlaylist || selectedPlaylistId === null) return
    setIsMoreMenuOpen(false)
    setDynamicRulesError(null)
    setIsDynamicRulesLoading(true)
    setIsDynamicRulesModalOpen(true)
    try {
      setDynamicRulesDraft(await getDynamicPlaylistRules(selectedPlaylistId))
    } catch (error) {
      setDynamicRulesError(error instanceof Error ? error.message : 'Failed to load dynamic playlist rules.')
    } finally {
      setIsDynamicRulesLoading(false)
    }
  }, [getDynamicPlaylistRules, isDynamicPlaylist, selectedPlaylistId])

  const handleSaveDynamicRules = useCallback(async () => {
    if (!isDynamicPlaylist || selectedPlaylistId === null || isSavingDynamicRules) return

    setIsSavingDynamicRules(true)
    setDynamicRulesError(null)
    try {
      await updateDynamicPlaylistRules(selectedPlaylistId, normalizeDynamicPlaylistRules(dynamicRulesDraft))
      setIsDynamicRulesModalOpen(false)
    } catch (error) {
      setDynamicRulesError(error instanceof Error ? error.message : 'Failed to save dynamic playlist rules.')
    } finally {
      setIsSavingDynamicRules(false)
    }
  }, [dynamicRulesDraft, isDynamicPlaylist, isSavingDynamicRules, selectedPlaylistId, updateDynamicPlaylistRules])

  const handleExportPlaylist = useCallback(async () => {
    if (isExportingPlaylist) return
    if (selectedPlaylistId === null) return
    if (isDeletingPlaylist) return

    setIsMoreMenuOpen(false)
    setIsExportingPlaylist(true)
    try {
      const result = await exportPlaylistToM3u(selectedPlaylistId, playlistName ?? 'Playlist')
      if (!result) return
      setPlaylistImportStatus(formatPlaylistExportStatus(result))
    } catch (error) {
      console.error('Failed to export playlist:', error)
      const message = error instanceof Error ? error.message : 'Failed to export playlist.'
      setPlaylistImportStatus({ tone: 'error', message })
    } finally {
      setIsExportingPlaylist(false)
    }
  }, [exportPlaylistToM3u, isDeletingPlaylist, isExportingPlaylist, playlistName, selectedPlaylistId])

  const handleConfirmDelete = async () => {
    if (isFavoritesPlaylist || isDeletingPlaylist) return
    if (selectedPlaylistId === null) return
    setIsDeletingPlaylist(true)
    try {
      await deletePlaylist(selectedPlaylistId)
      setIsDeleteConfirmOpen(false)
      handleBack()
    } finally {
      setIsDeletingPlaylist(false)
    }
  }

  const handleChangeCover = async () => {
    setIsCoverMenuOpen(false)
    if (isFavoritesPlaylist || selectedPlaylistId === null || selectedPlaylistId <= 0 || isUpdatingCover) return
    const imagePath = await window.electronAPI.openFileDialog({
      title: 'Choose playlist cover',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    })
    if (!imagePath) return

    setIsUpdatingCover(true)
    try {
      await setPlaylistCustomCoverFromFile(selectedPlaylistId, imagePath)
    } finally {
      setIsUpdatingCover(false)
    }
  }

  const handleClearCover = async () => {
    setIsCoverMenuOpen(false)
    if (isFavoritesPlaylist || selectedPlaylistId === null || selectedPlaylistId <= 0 || isUpdatingCover) return
    if (!playlist?.custom_cover_hash) return

    setIsUpdatingCover(true)
    try {
      await clearPlaylistCustomCover(selectedPlaylistId)
    } finally {
      setIsUpdatingCover(false)
    }
  }

  const handleSortColumnToggle = useCallback((key: TrackListSortKey) => {
    const current = usePlaylistStore.getState().sortState
    if (current?.key === key) {
      setSortState({
        key,
        direction: current.direction === 'asc' ? 'desc' : 'asc'
      })
      return
    }
    setSortState({
      key,
      direction: key === 'play_count' ? 'desc' : 'asc'
    })
  }, [setSortState])

  const handleResetToDefaultOrder = useCallback(() => {
    setSortState(null)
  }, [setSortState])

  const handlePlayPlaylist = useCallback(async () => {
    if (playPendingRef.current) return
    if (selectedPlaylistId === null || displayPlayableTrackPaths.length === 0) return

    playPendingRef.current = true
    setIsPlayPending(true)

    try {
      // startShuffled respects the current shuffle toggle (mirrors the library detail header):
      // shuffle on -> random start track, shuffle off -> play in order from the top.
      await startPlaybackContextByPaths(displayPlayableTrackPaths, 0, {
        sourcePlaylistId: selectedPlaylistId,
        contextLabel: playlistName ?? 'Playlist',
        startShuffled: true
      })
    } catch (error) {
      console.error('Failed to play playlist:', error)
    } finally {
      playPendingRef.current = false
      setIsPlayPending(false)
    }
  }, [displayPlayableTrackPaths, playlistName, selectedPlaylistId, startPlaybackContextByPaths])

  const handlePlaylistContentScrollCapture = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target.scrollHeight <= target.clientHeight + 1) return

    const collapseDistance = getDetailHeaderCollapseDistance(detailHeaderRef.current)
    setIsDetailHeaderCollapsed((isCollapsed) => resolveDetailHeaderCollapsed({
      isCollapsed,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
      collapseDistance
    }))
  }, [])

  useEffect(() => {
    setIsDetailHeaderCollapsed(false)
  }, [selectedPlaylistId])

  const handleOpenLibrary = useCallback(() => {
    setActiveView('library')
  }, [setActiveView])

  const handleChangeMissingPlaylistAssociation = useCallback(async (trackPath: string, entryId?: number | null) => {
    if (selectedPlaylistId === null || selectedPlaylistId <= 0 || isDynamicPlaylist) return

    const entry = selectedPlaylistEntries.find((candidate) => (
      (typeof entryId === 'number' ? candidate.id === entryId : candidate.track_path === trackPath)
      && (candidate.missing || candidate.track === null)
    ))
    if (!entry) {
      setPlaylistImportStatus({ tone: 'error', message: 'That missing playlist entry is no longer available.' })
      return
    }

    const targetTrackPath = await window.electronAPI.openFileDialog({
      title: 'Change Associated Playlist File',
      filters: PLAYLIST_ASSOCIATION_AUDIO_FILTER
    })
    if (!targetTrackPath) return

    try {
      await reassociatePlaylistEntry(selectedPlaylistId, entry.id, targetTrackPath)
      const targetFileName = targetTrackPath.split(/[\\/]/).pop() || targetTrackPath
      setPlaylistImportStatus({
        tone: 'success',
        message: `Associated "${getMissingPlaylistEntryLabel(entry)}" with "${targetFileName}".`
      })
    } catch (error) {
      console.error('Failed to change playlist file association:', error)
      setPlaylistImportStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Failed to change the associated playlist file.'
      })
    }
  }, [isDynamicPlaylist, reassociatePlaylistEntry, selectedPlaylistEntries, selectedPlaylistId])

  const handleOpenPlaylist = useCallback(async (playlistId: number) => {
    await runViewTransition(async () => {
      await selectPlaylist(playlistId)
      setActiveView('playlist')
    }, 'playlist-context-forward')
  }, [selectPlaylist, setActiveView])

  const visibleBrowserPlaylists = useMemo(() => {
    const sorted = sortPlaylistBrowserEntries(allPlaylists, browserSortMode)
    const query = playlistBrowserSearchQuery.trim()
    if (!query) return sorted
    return sorted.filter((entry) => matchesFuzzyFields(query, [
      { value: entry.name, weight: 1.5 }
    ], 'context'))
  }, [allPlaylists, browserSortMode, playlistBrowserSearchQuery])

  const playlistBrowserTrackCount = useMemo(
    () => allPlaylists.reduce((total, entry) => total + entry.track_count, 0),
    [allPlaylists]
  )

  const handleToggleSidebarPin = useCallback((playlistId: number) => {
    if (sidebarPinnedPlaylistIdSet.has(playlistId)) {
      unpinPlaylistFromSidebar(playlistId)
    } else {
      pinPlaylistToSidebar(playlistId)
    }
  }, [pinPlaylistToSidebar, sidebarPinnedPlaylistIdSet, unpinPlaylistFromSidebar])

  const handlePinnedDragStart = useCallback((event: DragEvent<HTMLElement>, playlistId: number) => {
    setDraggedPinnedPlaylistId(playlistId)
    setPinnedDropTargetId(playlistId)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-astra-sidebar-playlist', String(playlistId))
  }, [])

  const handlePinnedDragEnd = useCallback(() => {
    setDraggedPinnedPlaylistId(null)
    setPinnedDropTargetId(null)
  }, [])

  const handlePinnedDrop = useCallback((event: DragEvent<HTMLElement>, targetPlaylistId: number) => {
    event.preventDefault()
    const transferredPlaylistId = Number.parseInt(
      event.dataTransfer.getData('application/x-astra-sidebar-playlist'),
      10
    )
    const sourcePlaylistId = Number.isInteger(transferredPlaylistId)
      ? transferredPlaylistId
      : draggedPinnedPlaylistId
    setDraggedPinnedPlaylistId(null)
    setPinnedDropTargetId(null)
    if (sourcePlaylistId === null || sourcePlaylistId === targetPlaylistId) return
    const targetIndex = sidebarPinnedPlaylistIds.indexOf(targetPlaylistId)
    if (targetIndex < 0) return
    moveSidebarPinnedPlaylist(sourcePlaylistId, targetIndex)
  }, [draggedPinnedPlaylistId, moveSidebarPinnedPlaylist, sidebarPinnedPlaylistIds])

  if (isPlaylistBrowser) {
    return (
      <div className="playlist-view">
        <div className="playlist-browser playlist-dashboard">
          <header className="playlist-dashboard-hero">
            {playlistHeaderArtwork.length > 0 && (
              <div className="playlist-dashboard-hero-artwork" aria-hidden="true">
                {playlistHeaderArtwork.map((entry, index) => (
                  <PlaylistCover
                    key={entry.id}
                    hash={entry.cover_hash}
                    name={entry.name}
                    className={`playlist-dashboard-hero-cover playlist-dashboard-hero-cover-${index + 1}`}
                  />
                ))}
              </div>
            )}
            <div className="playlist-browser-copy">
              <span className="playlist-dashboard-eyebrow">Your collections</span>
              <h1>Playlists</h1>
              <p>
                {allPlaylists.length > 0
                  ? `${allPlaylists.length} ${allPlaylists.length === 1 ? 'collection' : 'collections'} · ${playlistBrowserTrackCount} ${playlistBrowserTrackCount === 1 ? 'track' : 'tracks'}`
                  : 'Create a playlist to start shaping your library.'}
              </p>
            </div>
            <div className="playlist-browser-actions">
              <button
                type="button"
                className="settings-btn playlist-action-btn"
                onClick={() => void handleImportPlaylist()}
                disabled={isImportingPlaylist}
              >
                {isImportingPlaylist ? 'Importing...' : 'Import Playlist'}
              </button>
              <button
                type="button"
                className="settings-btn settings-btn-primary playlist-action-btn"
                onClick={() => setIsCreatePlaylistModalOpen(true)}
                disabled={isImportingPlaylist}
              >
                New Playlist
              </button>
            </div>
          </header>

          {playlistImportStatus && <PlaylistImportStatusBanner status={playlistImportStatus} />}

          <section className="playlist-dashboard-section playlist-dashboard-pinned-section">
            <div className="playlist-dashboard-section-header">
              <div className="playlist-dashboard-section-title">
                <h2>Pinned</h2>
                <span>{sidebarPinnedPlaylists.length} {sidebarPinnedPlaylists.length === 1 ? 'shortcut' : 'shortcuts'}</span>
              </div>
              <button
                type="button"
                className="playlist-dashboard-reset-btn"
                onClick={resetSidebarPins}
                disabled={allPlaylists.length === 0}
              >
                Reset pins
              </button>
            </div>
            {sidebarPinnedPlaylists.length > 0 ? (
              <div
                className="playlist-dashboard-pinned-rail"
                data-controller-group="playlist-pinned"
                data-controller-axis="horizontal"
              >
                {sidebarPinnedPlaylists.map((entry, index) => {
                  const isDragging = draggedPinnedPlaylistId === entry.id
                  const isDropTarget = pinnedDropTargetId === entry.id && !isDragging
                  const isTrackDropAvailable = !entry.isSystemFavorites && entry.kind !== 'dynamic'
                  const isTrackDropHover = trackDrag?.dropTarget?.surface === 'sidebar'
                    && trackDrag.dropTarget.kind === 'playlist'
                    && trackDrag.dropTarget.playlistId === entry.id
                  return (
                    <article
                      key={entry.id}
                      className={`playlist-dashboard-pinned-card ${isDragging ? 'is-dragging' : ''} ${isDropTarget ? 'is-drop-target' : ''} ${trackDrag ? isTrackDropAvailable ? 'is-track-drop-active' : 'is-track-drop-unavailable' : ''} ${isTrackDropHover ? 'is-track-drop-hover' : ''}`.trim()}
                      draggable={!trackDrag}
                      onDragStart={(event) => handlePinnedDragStart(event, entry.id)}
                      onDragEnd={handlePinnedDragEnd}
                      onDragOver={(event) => {
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                        setPinnedDropTargetId(entry.id)
                      }}
                      onDrop={(event) => handlePinnedDrop(event, entry.id)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        openCollectionQueueMenu({
                          target: { kind: 'playlist', playlistId: entry.id, name: entry.name },
                          x: event.clientX,
                          y: event.clientY
                        })
                      }}
                      data-sidebar-drop-target={isTrackDropAvailable ? 'playlist' : undefined}
                      data-sidebar-drop-playlist-id={isTrackDropAvailable ? entry.id : undefined}
                    >
                      <span className="playlist-dashboard-pin-slot" aria-hidden="true">
                        <svg className="playlist-dashboard-pin-slot-grip" width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
                          <circle cx="2" cy="2" r="1" />
                          <circle cx="8" cy="2" r="1" />
                          <circle cx="2" cy="7" r="1" />
                          <circle cx="8" cy="7" r="1" />
                          <circle cx="2" cy="12" r="1" />
                          <circle cx="8" cy="12" r="1" />
                        </svg>
                        <span>{String(index + 1).padStart(2, '0')}</span>
                      </span>
                      <button
                        type="button"
                        className="playlist-dashboard-pinned-open"
                        onClick={() => void handleOpenPlaylist(entry.id)}
                        data-controller-focusable="true"
                        data-controller-context="true"
                        data-controller-key={`pinned-playlist:${entry.id}`}
                        aria-label={`Open ${entry.name}`}
                        data-sidebar-drop-target={isTrackDropAvailable ? 'playlist' : undefined}
                        data-sidebar-drop-playlist-id={isTrackDropAvailable ? entry.id : undefined}
                      >
                        <PlaylistCover
                          hash={entry.cover_hash}
                          name={entry.name}
                          isFavorites={entry.isSystemFavorites}
                          className="playlist-dashboard-pinned-cover"
                        />
                        <span className="playlist-dashboard-pinned-meta">
                          <span className="playlist-dashboard-pinned-name">{entry.name}</span>
                          <span className="playlist-dashboard-pinned-count">
                            {entry.track_count} {entry.track_count === 1 ? 'track' : 'tracks'}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="playlist-dashboard-unpin-btn"
                        onClick={() => unpinPlaylistFromSidebar(entry.id)}
                        aria-label={`Unpin ${entry.name} from sidebar`}
                        title="Unpin from sidebar"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="m15 4 5 5-3 1-4 4 1 5-1 1-4-6-5-4 1-1 5 1 4-4 1-2Z" />
                          <path d="m9 15-5 5" />
                        </svg>
                      </button>
                    </article>
                  )
                })}
              </div>
            ) : (
              <div className="playlist-dashboard-pinned-empty">
                <span>No sidebar pins yet.</span>
                <span>Use the pin button on any playlist below.</span>
              </div>
            )}
          </section>

          <section className="playlist-dashboard-section playlist-dashboard-all-section">
            <div className="playlist-dashboard-section-header playlist-dashboard-all-header">
              <div className="playlist-dashboard-section-title">
                <h2>All Playlists</h2>
                <span>{allPlaylists.length} {allPlaylists.length === 1 ? 'collection' : 'collections'}</span>
              </div>
              <div className="playlist-dashboard-tools">
                <label className="playlist-dashboard-search">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-4-4" />
                  </svg>
                  <span className="sr-only">Search playlists</span>
                  <input
                    type="search"
                    data-shortcut-search="true"
                    value={playlistBrowserSearchQuery}
                    onChange={(event) => setPlaylistBrowserSearchQuery(event.target.value)}
                    placeholder="Search playlists"
                  />
                </label>
                <label className="playlist-dashboard-sort">
                  <span className="sr-only">Sort playlists</span>
                  <select
                    value={browserSortMode}
                    onChange={(event) => setBrowserSortMode(event.target.value as typeof browserSortMode)}
                  >
                    <option value="recently-played">Recently played</option>
                    <option value="recently-updated">Recently updated</option>
                    <option value="name">Name</option>
                    <option value="created">Date created</option>
                  </select>
                </label>
              </div>
            </div>

            {allPlaylists.length > 0 && visibleBrowserPlaylists.length > 0 ? (
            <div
              className="playlist-dashboard-grid"
              data-controller-group="playlist-browser"
              data-controller-axis="grid"
            >
              {visibleBrowserPlaylists.map((entry) => {
                const isPinned = sidebarPinnedPlaylistIdSet.has(entry.id)
                const isTrackDropAvailable = !entry.isSystemFavorites && entry.kind !== 'dynamic'
                const isTrackDropHover = trackDrag?.dropTarget?.surface === 'sidebar'
                  && trackDrag.dropTarget.kind === 'playlist'
                  && trackDrag.dropTarget.playlistId === entry.id
                return (
                <article
                  key={entry.id}
                  className={`playlist-dashboard-card ${isPinned ? 'is-pinned' : ''} ${trackDrag ? isTrackDropAvailable ? 'is-track-drop-active' : 'is-track-drop-unavailable' : ''} ${isTrackDropHover ? 'is-track-drop-hover' : ''}`.trim()}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    openCollectionQueueMenu({
                      target: { kind: 'playlist', playlistId: entry.id, name: entry.name },
                      x: event.clientX,
                      y: event.clientY
                    })
                  }}
                  data-sidebar-drop-target={isTrackDropAvailable ? 'playlist' : undefined}
                  data-sidebar-drop-playlist-id={isTrackDropAvailable ? entry.id : undefined}
                >
                  <button
                    type="button"
                    className="playlist-dashboard-card-open"
                    onClick={() => void handleOpenPlaylist(entry.id)}
                    data-controller-focusable="true"
                    data-controller-context="true"
                    data-controller-key={`playlist:${entry.id}`}
                    aria-label={`Open ${entry.name}`}
                    data-sidebar-drop-target={isTrackDropAvailable ? 'playlist' : undefined}
                    data-sidebar-drop-playlist-id={isTrackDropAvailable ? entry.id : undefined}
                  >
                    <PlaylistCover
                      hash={entry.cover_hash}
                      name={entry.name}
                      isFavorites={entry.isSystemFavorites}
                      className="playlist-dashboard-card-cover"
                    />
                    <span className="playlist-dashboard-card-meta">
                      <span className="playlist-dashboard-card-name">{entry.name}</span>
                      <span className="playlist-dashboard-card-details">
                        <span>{entry.kind === 'dynamic' ? 'Dynamic playlist' : entry.isSystemFavorites ? 'Favorites' : 'Playlist'}</span>
                        <span aria-hidden="true">·</span>
                        <span>{entry.track_count} {entry.track_count === 1 ? 'track' : 'tracks'}</span>
                      </span>
                      {Boolean(entry.missing_track_count) && (
                        <span className="playlist-dashboard-card-warning">
                          {entry.missing_track_count} missing {entry.missing_track_count === 1 ? 'track' : 'tracks'}
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`playlist-dashboard-pin-btn ${isPinned ? 'is-pinned' : ''}`}
                    onClick={() => handleToggleSidebarPin(entry.id)}
                    aria-pressed={isPinned}
                    aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${entry.name} ${isPinned ? 'from' : 'to'} sidebar`}
                    title={isPinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m15 4 5 5-3 1-4 4 1 5-1 1-4-6-5-4 1-1 5 1 4-4 1-2Z" />
                      <path d="m9 15-5 5" />
                    </svg>
                  </button>
                </article>
                )
              })}
            </div>
            ) : allPlaylists.length > 0 ? (
              <SearchEmptyState
                subject="playlists"
                query={playlistBrowserSearchQuery.trim()}
                fields="playlist name"
                onClear={() => setPlaylistBrowserSearchQuery('')}
                className="playlist-dashboard-search-empty"
              />
          ) : (
            <div className="library-empty playlist-browser-empty">
              <p>No playlists yet</p>
              <p className="empty-hint">Create one here, import an existing file, or add favorites from your library.</p>
            </div>
          )}
          </section>
        </div>
        <CreatePlaylistModal
          isOpen={isCreatePlaylistModalOpen}
          onClose={() => setIsCreatePlaylistModalOpen(false)}
          onCreate={handleCreatePlaylist}
          onCreateDynamic={handleCreateDynamicPlaylist}
          onPreviewDynamic={previewDynamicPlaylist}
          allowDynamic
          onImport={handleImportPlaylist}
          isImporting={isImportingPlaylist}
        />
      </div>
    )
  }

  if (!playlist && !isFavoritesPlaylist) {
    return (
      <div className="playlist-view">
        <div className="playlist-header">
          <button
            className={`back-btn ${trackDrag ? 'is-track-drag-target' : ''} ${trackDrag?.springTarget?.kind === 'playlist-back' ? 'is-track-drag-hover' : ''}`.trim()}
            onClick={handleBack}
            title="Back"
            data-track-drag-playlist-back=""
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
            </svg>
          </button>
          <h2>Playlist not found</h2>
        </div>
      </div>
    )
  }

  return (
    <div className="playlist-view">
      <div
        className={`library-header library-detail-header ${isDetailHeaderCollapsed ? 'is-collapsed' : ''}`}
        ref={detailHeaderRef}
      >
        {playlistCoverHash && (
          <div className="library-detail-hero-backdrop" aria-hidden="true">
            <AlbumArtwork hash={playlistCoverHash} alt="" variant="card" />
          </div>
        )}
        <div className="library-header-left library-detail-header-left">
          <button
            className={`back-btn ${trackDrag ? 'is-track-drag-target' : ''} ${trackDrag?.springTarget?.kind === 'playlist-back' ? 'is-track-drag-hover' : ''}`.trim()}
            onClick={handleBack}
            title="Back"
            data-track-drag-playlist-back=""
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
            </svg>
          </button>
          <div
            className="playlist-detail-cover"
            ref={coverControlRef}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (selectedPlaylistId === null) return
              openCollectionQueueMenu({
                target: {
                  kind: 'playlist',
                  playlistId: selectedPlaylistId,
                  name: playlistName ?? FAVORITES_PLAYLIST_NAME
                },
                x: event.clientX,
                y: event.clientY
              })
            }}
          >
            <div className="library-detail-artwork">
              <PlaylistCover
                hash={playlistCoverHash}
                name={playlistName ?? FAVORITES_PLAYLIST_NAME}
                isFavorites={isFavoritesPlaylist}
                className="playlist-header-cover"
              />
            </div>
            {!isFavoritesPlaylist && (
              <>
                <button
                  type="button"
                  className="playlist-header-cover-edit-btn"
                  onClick={() => {
                    setIsCoverMenuOpen((isOpen) => !isOpen)
                    setIsMoreMenuOpen(false)
                  }}
                  disabled={isUpdatingCover || isDeletingPlaylist}
                  aria-haspopup="menu"
                  aria-expanded={isCoverMenuOpen}
                  aria-label="Edit playlist cover"
                  title="Edit playlist cover"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                  </svg>
                </button>
                {isCoverMenuOpen && (
                  <div className="playlist-header-cover-menu" role="menu">
                    <button
                      type="button"
                      className="playlist-header-menu-item"
                      role="menuitem"
                      onClick={() => void handleChangeCover()}
                      disabled={isUpdatingCover || isDeletingPlaylist}
                    >
                      Change cover
                    </button>
                    <button
                      type="button"
                      className="playlist-header-menu-item"
                      role="menuitem"
                      onClick={() => void handleClearCover()}
                      disabled={isUpdatingCover || !playlist?.custom_cover_hash || isDeletingPlaylist}
                    >
                      Remove cover
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          <div
            className="library-detail-copy"
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (selectedPlaylistId === null) return
              openCollectionQueueMenu({
                target: {
                  kind: 'playlist',
                  playlistId: selectedPlaylistId,
                  name: playlistName ?? FAVORITES_PLAYLIST_NAME
                },
                x: event.clientX,
                y: event.clientY
              })
            }}
          >
            <div className="library-detail-eyebrow-row">
              <span className="library-detail-eyebrow">{isFavoritesPlaylist ? 'Favorites' : 'Playlist'}</span>
            </div>
            {isRenaming ? (
              <input
                className="playlist-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void handleConfirmRename()
                  }
                  if (e.key === 'Escape') {
                    setIsRenaming(false)
                  }
                }}
                onBlur={() => {
                  void handleConfirmRename()
                }}
                autoFocus
              />
            ) : (
              <h2>
                {playlistName}
                {isDynamicPlaylist && <span className="playlist-kind-badge">Dynamic</span>}
              </h2>
            )}
            <div className="library-detail-meta-row">
              <span className="library-detail-meta">
                {selectedPlaylistTracks.length} {selectedPlaylistTracks.length === 1 ? 'track' : 'tracks'}
                {playlistDurationLabel ? ` \u00b7 ${playlistDurationLabel}` : ''}
                {playlistMissingCount > 0 && (
                  <span className="playlist-missing-count"> / {playlistMissingCount} missing</span>
                )}
              </span>
            </div>
          </div>
        </div>
        <div className="library-header-right library-detail-header-actions">
          <button
            type="button"
            className="icon-btn library-play-btn library-collection-action-btn"
            onClick={() => {
              void handlePlayPlaylist()
            }}
            title="Play playlist"
            aria-label="Play playlist"
            disabled={isPlayDisabled}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
            <span className="library-collection-action-label">Play</span>
          </button>
          <button
            type="button"
            className={`icon-btn library-shuffle-btn library-collection-action-btn ${shuffle ? 'active' : ''}`}
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
          <QueueSplitButton
            trackPaths={displayPlayableTrackPaths}
            disabled={displayPlayableTrackPaths.length === 0}
          />
          <div className="playlist-header-menu-wrap" ref={moreMenuRef}>
            <button
              type="button"
              className={`icon-btn library-collection-action-btn playlist-detail-icon-btn ${isMoreMenuOpen ? 'active' : ''}`}
              onClick={() => {
                setIsMoreMenuOpen((isOpen) => !isOpen)
                setIsCoverMenuOpen(false)
              }}
              aria-haspopup="menu"
              aria-expanded={isMoreMenuOpen}
              aria-label="More playlist actions"
              title="More playlist actions"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="19" cy="12" r="1.8" />
              </svg>
            </button>
            {isMoreMenuOpen && (
              <div className="playlist-header-more-menu" role="menu">
                <button
                  type="button"
                  className="playlist-header-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setIsMoreMenuOpen(false)
                    setIsCreatePlaylistModalOpen(true)
                  }}
                  disabled={isDeletingPlaylist}
                >
                  New playlist
                </button>
                {selectedPlaylistId !== null && (
                  <button
                    type="button"
                    className="playlist-header-menu-item"
                    role="menuitem"
                    onClick={() => {
                      handleToggleSidebarPin(selectedPlaylistId)
                      setIsMoreMenuOpen(false)
                    }}
                    disabled={isDeletingPlaylist}
                  >
                    {isSelectedPlaylistPinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                  </button>
                )}
                {isDynamicPlaylist && (
                  <button
                    type="button"
                    className="playlist-header-menu-item"
                    role="menuitem"
                    onClick={() => {
                      void handleOpenDynamicRules()
                    }}
                    disabled={isDeletingPlaylist}
                  >
                    Edit Rules
                  </button>
                )}
                <button
                  type="button"
                  className="playlist-header-menu-item"
                  role="menuitem"
                  onClick={() => {
                    void handleExportPlaylist()
                  }}
                  disabled={isDeletingPlaylist || isExportingPlaylist}
                >
                  {isExportingPlaylist ? 'Exporting...' : 'Export M3U'}
                </button>
                {!isFavoritesPlaylist && (
                  <>
                    <button
                      type="button"
                      className="playlist-header-menu-item"
                      role="menuitem"
                      onClick={handleStartRename}
                      disabled={isDeletingPlaylist}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="playlist-header-menu-item danger"
                      role="menuitem"
                      onClick={handleRequestDelete}
                      disabled={isDeletingPlaylist}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="playlist-track-search-toolbar" role="search" aria-label="Search this playlist">
        <span className="playlist-track-search-status" role="status" aria-live="polite">
          {hasPlaylistTrackSearchQuery
            ? `${visibleDisplayRows.length} of ${displayRows.length} shown`
            : ''}
        </span>
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
            placeholder="Search tracks..."
            aria-label={`Search tracks in ${playlistName ?? 'playlist'}`}
            value={playlistTrackSearchQuery}
            onChange={(event) => setPlaylistTrackSearchQuery(event.target.value)}
          />
          {playlistTrackSearchQuery.length > 0 && (
            <button
              type="button"
              className="search-clear-btn"
              aria-label="Clear playlist search"
              title="Clear playlist search"
              onClick={() => setPlaylistTrackSearchQuery('')}
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className="playlist-content" onScrollCapture={handlePlaylistContentScrollCapture}>
        {playlistImportStatus && <PlaylistImportStatusBanner status={playlistImportStatus} />}
        {displayRows.length > 0 ? (
          visibleDisplayTracks.length > 0 ? (
            <TrackList
              tracks={visibleDisplayTracks}
              queueSeedTracks={displayPlayableTracks}
              queueSeedIndexes={visibleQueueSeedIndexes}
              queueContextLabel={playlistName ?? 'Playlist'}
              trackNumberMode="context"
              contextTrackNumbers={visibleTrackNumbers}
              trackInstanceKeys={visibleTrackInstanceKeys}
              playlistEntryIds={visiblePlaylistEntryIds}
              playlistSourceId={!isFavoritesPlaylist && !isDynamicPlaylist ? selectedPlaylistId : null}
              playlistDropEnabled={!hasPlaylistTrackSearchQuery}
              onChangeMissingPlaylistAssociation={handleChangeMissingPlaylistAssociation}
              enableColumnSorting
              sortState={sortState}
              onSortColumnToggle={handleSortColumnToggle}
              enableDefaultOrderReset
              onDefaultOrderReset={handleResetToDefaultOrder}
              jumpToTrackRequest={
                selectedPlaylistId === playlistTrackRevealRequest?.playlistId
                  ? playlistTrackRevealRequest
                  : null
              }
              onJumpToTrackRequestConsumed={clearPlaylistTrackRevealRequest}
              searchQuery={trimmedPlaylistTrackSearchQuery}
            />
          ) : (
            <SearchEmptyState
              subject="tracks"
              query={trimmedPlaylistTrackSearchQuery}
              fields="title, artist, and album"
              onClear={() => setPlaylistTrackSearchQuery('')}
              className="playlist-track-search-empty"
            />
          )
        ) : (
          <div
            className="library-empty"
            data-track-drop-playlist-id={!isDynamicPlaylist && selectedPlaylistId !== FAVORITES_PLAYLIST_ID ? selectedPlaylistId ?? undefined : undefined}
            data-track-drop-playlist-count={!isDynamicPlaylist && selectedPlaylistId !== FAVORITES_PLAYLIST_ID ? 0 : undefined}
          >
            <p>{selectedPlaylistId === FAVORITES_PLAYLIST_ID ? 'No favorites yet' : isDynamicPlaylist ? 'No matching tracks' : 'This playlist is empty'}</p>
            <p className="empty-hint">
              {selectedPlaylistId === FAVORITES_PLAYLIST_ID
                ? 'Click the heart icon on any track to add favorites.'
                : isDynamicPlaylist
                  ? 'Edit the rules or add more music to the library.'
                  : 'Add tracks from the Library view'}
            </p>
            {selectedPlaylistId !== FAVORITES_PLAYLIST_ID && !isDynamicPlaylist && (
              <div className="playlist-empty-actions">
                <button type="button" className="settings-btn settings-btn-primary" onClick={handleOpenLibrary}>
                  Open Library
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <CreatePlaylistModal
        isOpen={isCreatePlaylistModalOpen}
        onClose={() => setIsCreatePlaylistModalOpen(false)}
        onCreate={handleCreatePlaylist}
        onCreateDynamic={handleCreateDynamicPlaylist}
        onPreviewDynamic={previewDynamicPlaylist}
        allowDynamic
        onImport={handleImportPlaylist}
        isImporting={isImportingPlaylist}
      />
      {isDynamicRulesModalOpen && (
        <div
          className="modal-overlay playlist-create-modal-overlay"
          onClick={() => {
            if (!isSavingDynamicRules) setIsDynamicRulesModalOpen(false)
          }}
        >
          <div
            className="modal-content playlist-create-modal playlist-dynamic-rules-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header playlist-create-modal-header">
              <h2>Edit Dynamic Rules</h2>
              <button
                className="modal-close"
                onClick={() => setIsDynamicRulesModalOpen(false)}
                aria-label="Close"
                disabled={isSavingDynamicRules}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
              </button>
            </div>
            <div className="modal-body playlist-create-modal-body">
              {isDynamicRulesLoading ? (
                <div className="playlist-dynamic-preview-empty">Loading rules...</div>
              ) : (
                <DynamicPlaylistRuleEditor
                  rules={dynamicRulesDraft}
                  onRulesChange={setDynamicRulesDraft}
                  onPreview={previewDynamicPlaylist}
                  disabled={isSavingDynamicRules}
                />
              )}
              {dynamicRulesError && (
                <div className="playlist-create-error" role="alert">
                  {dynamicRulesError}
                </div>
              )}
            </div>
            <div className="modal-footer playlist-create-modal-footer">
              <div className="playlist-create-modal-actions">
                <button
                  className="settings-btn"
                  onClick={() => setIsDynamicRulesModalOpen(false)}
                  disabled={isSavingDynamicRules}
                >
                  Cancel
                </button>
                <button
                  className="settings-btn settings-btn-primary"
                  onClick={() => {
                    void handleSaveDynamicRules()
                  }}
                  disabled={isSavingDynamicRules || isDynamicRulesLoading || isDynamicRulesDraftInvalid}
                >
                  {isSavingDynamicRules ? 'Saving...' : 'Save Rules'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <ConfirmActionModal
        isOpen={isDeleteConfirmOpen}
        title="Delete Playlist?"
        message={`Delete "${playlistName ?? 'this playlist'}"? This cannot be undone.`}
        confirmLabel="Delete Playlist"
        cancelLabel="Cancel"
        isDestructive
        isBusy={isDeletingPlaylist}
        onCancel={() => setIsDeleteConfirmOpen(false)}
        onConfirm={() => {
          void handleConfirmDelete()
        }}
      />
    </div>
  )
}
