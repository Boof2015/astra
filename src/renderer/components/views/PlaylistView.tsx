import { DragEvent, useCallback, useEffect, useMemo, useRef, useState, type UIEvent as ReactUIEvent } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'
import { useRatingsStore, type TrackRatingState } from '../../stores/ratingsStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import {
  buildPlaylistDisplaySections,
  FAVORITES_PLAYLIST_ID,
  FAVORITES_PLAYLIST_NAME,
  isSystemFavoritesPlaylistId
} from '../../utils/playlistSystem'
import { formatCompactTotalTrackDuration } from '../../utils/collectionDuration'
import { formatPlaylistExportStatus, formatPlaylistImportStatus, type PlaylistImportStatus } from '../../utils/playlistImportStatus'
import { buildPlayableOccurrenceIndexes } from '../../utils/playlistOccurrences'
import { compareTrackPlayCounts } from '../../utils/trackPlayCountSort'
import AlbumArtwork from '../library/AlbumArtwork'
import TrackList, { type TrackListSortKey, type TrackListSortState } from '../library/TrackList'
import CreatePlaylistModal from '../playlists/CreatePlaylistModal'
import DynamicPlaylistRuleEditor from '../playlists/DynamicPlaylistRuleEditor'
import PlaylistCover from '../playlists/PlaylistCover'
import QueueSplitButton from '../queue/QueueSplitButton'
import ConfirmActionModal from '../settings/ConfirmActionModal'
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

function FileCircleExclamationIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 576 512" fill="currentColor" aria-hidden="true">
      {/* Font Awesome Free file-circle-exclamation: https://fontawesome.com/icons/classic/solid/file-circle-exclamation */}
      <path d="M0 64C0 28.7 28.7 0 64 0h160v128c0 17.7 14.3 32 32 32h128v38.6C310.1 219.5 256 287.4 256 368c0 59.1 29.1 111.3 73.7 143.3-3.2.5-6.4.7-9.7.7H64c-35.3 0-64-28.7-64-64V64zm384 64H256V0l128 128zm48 96a144 144 0 1 1 0 288 144 144 0 1 1 0-288zm0 240a24 24 0 1 0 0-48 24 24 0 1 0 0 48zm0-192c-8.8 0-16 7.2-16 16v80c0 8.8 7.2 16 16 16s16-7.2 16-16v-80c0-8.8-7.2-16-16-16z" />
    </svg>
  )
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

function comparePath(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
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

  return compareWithDirection(aValue.localeCompare(bValue, undefined, { sensitivity: 'base' }), direction)
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
    reorderPlaylistEntries,
    reassociatePlaylistEntry,
    importPlaylistFromFile,
    exportPlaylistToM3u,
    sortState,
    setSortState
  } = usePlaylistStore()
  const setActiveView = useUIStore((s) => s.setActiveView)
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
  const allPlaylists = useMemo(
    () => buildPlaylistDisplaySections(playlists, {
      trackCount: favoriteTracks.length,
      topArtworkHash: favoriteTracks[0]?.artwork_hash ?? null
    }, 3).homePlaylists,
    [favoriteTracks, playlists]
  )

  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [isUpdatingCover, setIsUpdatingCover] = useState(false)
  const [isReorderMode, setIsReorderMode] = useState(false)
  const [reorderedEntries, setReorderedEntries] = useState<PlaylistEntry[] | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [isDeletingPlaylist, setIsDeletingPlaylist] = useState(false)
  const [isSavingReorder, setIsSavingReorder] = useState(false)
  const [reorderError, setReorderError] = useState<string | null>(null)
  const [isCreatePlaylistModalOpen, setIsCreatePlaylistModalOpen] = useState(false)
  const [isImportingPlaylist, setIsImportingPlaylist] = useState(false)
  const [isExportingPlaylist, setIsExportingPlaylist] = useState(false)
  const [playlistImportStatus, setPlaylistImportStatus] = useState<PlaylistImportStatus | null>(null)
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false)
  const [isDiscardReorderConfirmOpen, setIsDiscardReorderConfirmOpen] = useState(false)
  const [isPlayPending, setIsPlayPending] = useState(false)
  const [isDetailHeaderCollapsed, setIsDetailHeaderCollapsed] = useState(false)
  const [isCoverMenuOpen, setIsCoverMenuOpen] = useState(false)
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false)
  const [isDynamicRulesModalOpen, setIsDynamicRulesModalOpen] = useState(false)
  const [dynamicRulesDraft, setDynamicRulesDraft] = useState<DynamicPlaylistRulesV1>(() => createDefaultDynamicPlaylistRules())
  const [dynamicRulesError, setDynamicRulesError] = useState<string | null>(null)
  const [isDynamicRulesLoading, setIsDynamicRulesLoading] = useState(false)
  const [isSavingDynamicRules, setIsSavingDynamicRules] = useState(false)
  const playPendingRef = useRef(false)
  const coverControlRef = useRef<HTMLDivElement | null>(null)
  const moreMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setIsRenaming(false)
    setRenameValue('')
    setIsUpdatingCover(false)
    setIsReorderMode(false)
    setReorderedEntries(null)
    setDragIndex(null)
    setDropIndex(null)
    setIsDeletingPlaylist(false)
    setReorderError(null)
    setIsCreatePlaylistModalOpen(false)
    setIsExportingPlaylist(false)
    setIsDeleteConfirmOpen(false)
    setIsSavingReorder(false)
    setIsDiscardReorderConfirmOpen(false)
    setIsCoverMenuOpen(false)
    setIsMoreMenuOpen(false)
    setIsDynamicRulesModalOpen(false)
    setDynamicRulesDraft(createDefaultDynamicPlaylistRules())
    setDynamicRulesError(null)
    setIsDynamicRulesLoading(false)
    setIsSavingDynamicRules(false)
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
    if (!playlistTrackRevealRequest) return
    if (selectedPlaylistId !== playlistTrackRevealRequest.playlistId) return
    if (!isReorderMode) return

    setIsReorderMode(false)
    setReorderedEntries(null)
    setDragIndex(null)
    setDropIndex(null)
    setReorderError(null)
    setIsDiscardReorderConfirmOpen(false)
  }, [isReorderMode, playlistTrackRevealRequest, selectedPlaylistId])

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

  useEffect(() => {
    if (!isFavoritesPlaylist || !isReorderMode) return
    setIsReorderMode(false)
    setReorderedEntries(null)
    setDragIndex(null)
    setDropIndex(null)
    setReorderError(null)
    setIsDiscardReorderConfirmOpen(false)
  }, [isFavoritesPlaylist, isReorderMode])

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

  const displayTracks = useMemo(() => displayRows.map((row) => row.track), [displayRows])
  const displayPlaylistEntryIds = useMemo(() => displayRows.map((row) => row.entryId), [displayRows])
  const displayTrackNumbers = useMemo(() => displayRows.map((row) => row.defaultNumber), [displayRows])
  const displayTrackInstanceKeys = useMemo(() => displayRows.map((row) => row.instanceKey), [displayRows])

  const displayPlayableTracks = useMemo(
    () => displayTracks.filter((track) => !isMissingPlaylistDisplayTrack(track)),
    [displayTracks]
  )
  const displayQueueSeedIndexes = useMemo(
    () => buildPlayableOccurrenceIndexes(displayRows, (row) => !isMissingPlaylistDisplayTrack(row.track)),
    [displayRows]
  )
  const displayPlayableTrackPaths = useMemo(
    () => displayPlayableTracks.map((track) => track.path),
    [displayPlayableTracks]
  )

  const playlistMissingCount = selectedPlaylistEntries.reduce(
    (count, entry) => count + (entry.missing || entry.track === null ? 1 : 0),
    0
  )
  const playlistEntryCount = isFavoritesPlaylist ? selectedPlaylistTracks.length : selectedPlaylistEntries.length
  const playlistDurationLabel = formatCompactTotalTrackDuration(selectedPlaylistTracks)

  useEffect(() => {
    if (selectedPlaylistId === null || isFavoritesPlaylist || isReorderMode || isSavingReorder) return
    void loadPlaylists()
    void selectPlaylist(selectedPlaylistId)
  }, [isFavoritesPlaylist, isReorderMode, isSavingReorder, loadPlaylists, selectPlaylist, selectedPlaylistId, trackCacheVersion])

  const canReorderTracks = !isFavoritesPlaylist && !isDynamicPlaylist && selectedPlaylistId !== null && selectedPlaylistId > 0
  const isPlayDisabled = isPlayPending || isReorderMode || isSavingReorder || isDeletingPlaylist || displayPlayableTrackPaths.length === 0
  const hasUnsavedReorderChanges = useMemo(() => {
    if (!isReorderMode || !reorderedEntries) return false
    if (reorderedEntries.length !== selectedPlaylistEntries.length) return true

    for (let index = 0; index < reorderedEntries.length; index += 1) {
      const reorderedEntry = reorderedEntries[index]
      const currentEntry = selectedPlaylistEntries[index]
      if (!reorderedEntry || !currentEntry || reorderedEntry.id !== currentEntry.id) {
        return true
      }
    }

    return false
  }, [isReorderMode, reorderedEntries, selectedPlaylistEntries])

  const isDynamicRulesDraftInvalid = useMemo(() => {
    try {
      normalizeDynamicPlaylistRules(dynamicRulesDraft)
      return false
    } catch {
      return true
    }
  }, [dynamicRulesDraft])

  const handleBack = () => {
    clearSelection()
    setActiveView('playlist')
  }

  const handleStartRename = () => {
    if (isFavoritesPlaylist || isReorderMode || isSavingReorder) return
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
    if (isReorderMode || isSavingReorder) return
    const playlist = await createPlaylistWithOptions({ name, coverImagePath })
    await selectPlaylist(playlist.id)
    setActiveView('playlist')
  }

  const handleCreateDynamicPlaylist = async (name: string, coverImagePath: string | null, rules: DynamicPlaylistRulesV1) => {
    if (isReorderMode || isSavingReorder) return
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
    if (isFavoritesPlaylist || isReorderMode || isSavingReorder || isDeletingPlaylist) return
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
    if (isReorderMode || isSavingReorder || isDeletingPlaylist) return

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
  }, [exportPlaylistToM3u, isDeletingPlaylist, isExportingPlaylist, isReorderMode, isSavingReorder, playlistName, selectedPlaylistId])

  const handleConfirmDelete = async () => {
    if (isFavoritesPlaylist || isReorderMode || isSavingReorder || isDeletingPlaylist) return
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
    if (isFavoritesPlaylist || selectedPlaylistId === null || selectedPlaylistId <= 0 || isUpdatingCover || isReorderMode || isSavingReorder) return
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
    if (isFavoritesPlaylist || selectedPlaylistId === null || selectedPlaylistId <= 0 || isUpdatingCover || isReorderMode || isSavingReorder) return
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
    if (selectedPlaylistId === null || displayPlayableTrackPaths.length === 0 || isReorderMode || isSavingReorder) return

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
  }, [displayPlayableTrackPaths, isReorderMode, isSavingReorder, playlistName, selectedPlaylistId, startPlaybackContextByPaths])

  const handlePlaylistContentScrollCapture = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target.scrollHeight <= target.clientHeight + 1) return

    const scrollTop = target.scrollTop
    setIsDetailHeaderCollapsed((isCollapsed) => (isCollapsed ? scrollTop > 8 : scrollTop > 40))
  }, [])

  useEffect(() => {
    setIsDetailHeaderCollapsed(false)
  }, [selectedPlaylistId])

  const handleToggleReorderMode = useCallback(() => {
    if (!canReorderTracks || isSavingReorder) return
    setIsCoverMenuOpen(false)
    setIsMoreMenuOpen(false)

    if (isReorderMode) {
      if (hasUnsavedReorderChanges) {
        setIsDiscardReorderConfirmOpen(true)
        return
      }
      setIsDiscardReorderConfirmOpen(false)
      setIsReorderMode(false)
      setReorderedEntries(null)
      setDragIndex(null)
      setDropIndex(null)
      setReorderError(null)
      return
    }

    setIsDiscardReorderConfirmOpen(false)
    setSortState(null)
    setReorderError(null)
    setDragIndex(null)
    setDropIndex(null)
    setReorderedEntries([...selectedPlaylistEntries])
    setIsReorderMode(true)
  }, [canReorderTracks, hasUnsavedReorderChanges, isReorderMode, isSavingReorder, selectedPlaylistEntries, setSortState])

  const handleCancelReorder = useCallback(() => {
    if (isSavingReorder) return
    if (hasUnsavedReorderChanges) {
      setIsDiscardReorderConfirmOpen(true)
      return
    }
    setIsDiscardReorderConfirmOpen(false)
    setIsReorderMode(false)
    setReorderedEntries(null)
    setDragIndex(null)
    setDropIndex(null)
    setReorderError(null)
  }, [hasUnsavedReorderChanges, isSavingReorder])

  const handleReorderDragStart = useCallback((index: number) => {
    if (isSavingReorder) return
    setDragIndex(index)
  }, [isSavingReorder])

  const handleReorderDragOver = useCallback((index: number) => {
    if (isSavingReorder) return
    setDropIndex(index)
  }, [isSavingReorder])

  const handleReorderDragEnd = useCallback(() => {
    if (dragIndex === null || dropIndex === null || dragIndex === dropIndex || !reorderedEntries) {
      setDragIndex(null)
      setDropIndex(null)
      return
    }

    const updated = [...reorderedEntries]
    const [moved] = updated.splice(dragIndex, 1)
    if (!moved) {
      setDragIndex(null)
      setDropIndex(null)
      return
    }
    updated.splice(dropIndex, 0, moved)
    setReorderedEntries(updated)
    setDragIndex(null)
    setDropIndex(null)
  }, [dragIndex, dropIndex, reorderedEntries])

  const handleSaveReorder = useCallback(async () => {
    if (isSavingReorder) return
    if (!canReorderTracks || selectedPlaylistId === null) return
    if (!reorderedEntries || reorderedEntries.length === 0) return

    setIsSavingReorder(true)
    setReorderError(null)
    try {
      await reorderPlaylistEntries(selectedPlaylistId, reorderedEntries.map((entry) => entry.id))
      setIsDiscardReorderConfirmOpen(false)
      setIsReorderMode(false)
      setReorderedEntries(null)
      setDragIndex(null)
      setDropIndex(null)
      setSortState(null)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to reorder playlist tracks.'
      if (message.includes('Playlist reorder payload')) {
        setReorderError('Playlist changed while reordering. The playlist has been refreshed; try saving the order again.')
        await selectPlaylist(selectedPlaylistId)
      } else {
        setReorderError(message)
      }
    } finally {
      setIsSavingReorder(false)
    }
  }, [canReorderTracks, isSavingReorder, reorderedEntries, reorderPlaylistEntries, selectPlaylist, selectedPlaylistId, setSortState])

  const handleConfirmDiscardReorder = useCallback(() => {
    if (isSavingReorder) return
    setIsDiscardReorderConfirmOpen(false)
    setIsReorderMode(false)
    setReorderedEntries(null)
    setDragIndex(null)
    setDropIndex(null)
    setReorderError(null)
  }, [isSavingReorder])

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
    await selectPlaylist(playlistId)
    setActiveView('playlist')
  }, [selectPlaylist, setActiveView])

  if (isPlaylistBrowser) {
    return (
      <div className="playlist-view">
        <div className="playlist-browser">
          <div className="playlist-browser-header">
            <div className="playlist-browser-copy">
              <h2>Playlists</h2>
              <p>{allPlaylists.length > 0 ? `${allPlaylists.length} collections ready to play` : 'Create a playlist to start organizing your library.'}</p>
            </div>
            <div className="playlist-browser-actions">
              <button
                type="button"
                className="settings-btn playlist-action-btn"
                onClick={() => {
                  void handleImportPlaylist()
                }}
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
          </div>

          {playlistImportStatus && <PlaylistImportStatusBanner status={playlistImportStatus} />}

          {allPlaylists.length > 0 ? (
            <div
              className="playlist-browser-grid"
              data-controller-group="playlist-browser"
              data-controller-axis="grid"
            >
              {allPlaylists.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="playlist-browser-card"
                  data-controller-focusable="true"
                  data-controller-context="true"
                  data-controller-key={`playlist:${entry.id}`}
                  onClick={() => {
                    void handleOpenPlaylist(entry.id)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    openCollectionQueueMenu({
                      target: { kind: 'playlist', playlistId: entry.id, name: entry.name },
                      x: event.clientX,
                      y: event.clientY
                    })
                  }}
                >
                  <PlaylistCover
                    hash={entry.cover_hash}
                    name={entry.name}
                    isFavorites={entry.isSystemFavorites}
                    className="playlist-browser-card-cover"
                  />
                  <span className="playlist-browser-card-meta">
                    <span className="playlist-browser-card-name">{entry.name}</span>
                    <span className="playlist-browser-card-count">
                      {entry.kind === 'dynamic' ? 'Dynamic - ' : ''}
                      {entry.track_count} {entry.track_count === 1 ? 'track' : 'tracks'}
                      {entry.missing_track_count ? `, ${entry.missing_track_count} missing` : ''}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="library-empty playlist-browser-empty">
              <p>No playlists yet</p>
              <p className="empty-hint">Use the create button to make one from anywhere in the app.</p>
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
      </div>
    )
  }

  if (!playlist && !isFavoritesPlaylist) {
    return (
      <div className="playlist-view">
        <div className="playlist-header">
          <button className="back-btn" onClick={handleBack} title="Back">
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
      <div className={`library-header library-detail-header ${isDetailHeaderCollapsed ? 'is-collapsed' : ''}`}>
        {playlistCoverHash && (
          <div className="library-detail-hero-backdrop" aria-hidden="true">
            <AlbumArtwork hash={playlistCoverHash} alt="" variant="card" />
          </div>
        )}
        <div className="library-header-left library-detail-header-left">
          <button className="back-btn" onClick={handleBack} title="Back">
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
                  disabled={isUpdatingCover || isReorderMode || isSavingReorder || isDeletingPlaylist}
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
                      disabled={isUpdatingCover || isReorderMode || isSavingReorder || isDeletingPlaylist}
                    >
                      Change cover
                    </button>
                    <button
                      type="button"
                      className="playlist-header-menu-item"
                      role="menuitem"
                      onClick={() => void handleClearCover()}
                      disabled={isUpdatingCover || !playlist?.custom_cover_hash || isReorderMode || isSavingReorder || isDeletingPlaylist}
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
            disabled={displayPlayableTrackPaths.length === 0 || isReorderMode || isSavingReorder}
          />
          {!isFavoritesPlaylist && (
            <button
              type="button"
              className={`icon-btn library-collection-action-btn playlist-detail-icon-btn ${isReorderMode ? 'active' : ''}`}
              onClick={handleToggleReorderMode}
              disabled={isSavingReorder || isDeletingPlaylist || (!isReorderMode && playlistEntryCount < 2)}
              title={isReorderMode ? 'Exit reorder mode' : 'Reorder tracks'}
              aria-label={isReorderMode ? 'Exit reorder mode' : 'Reorder tracks'}
              aria-pressed={isReorderMode}
            >
              <svg width="15" height="17" viewBox="0 0 320 512" fill="currentColor" aria-hidden="true">
                <path d="M137.4 41.4c12.5-12.5 32.8-12.5 45.3 0l128 128c9.2 9.2 11.9 22.9 6.9 34.9S301 224 288 224H32c-12.9 0-24.6-7.8-29.6-19.8s-2.2-25.7 6.9-34.9l128-128zm0 429.3-128-128c-9.2-9.2-11.9-22.9-6.9-34.9S19.1 288 32 288h256c12.9 0 24.6 7.8 29.6 19.8s2.2 25.7-6.9 34.9l-128 128c-12.5 12.5-32.8 12.5-45.3 0z" />
              </svg>
            </button>
          )}
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
                  disabled={isReorderMode || isSavingReorder || isDeletingPlaylist}
                >
                  New playlist
                </button>
                {isDynamicPlaylist && (
                  <button
                    type="button"
                    className="playlist-header-menu-item"
                    role="menuitem"
                    onClick={() => {
                      void handleOpenDynamicRules()
                    }}
                    disabled={isReorderMode || isSavingReorder || isDeletingPlaylist}
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
                  disabled={isReorderMode || isSavingReorder || isDeletingPlaylist || isExportingPlaylist}
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
                      disabled={isReorderMode || isSavingReorder || isDeletingPlaylist}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="playlist-header-menu-item danger"
                      role="menuitem"
                      onClick={handleRequestDelete}
                      disabled={isReorderMode || isSavingReorder || isDeletingPlaylist}
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
      <div className="playlist-content" onScrollCapture={handlePlaylistContentScrollCapture}>
        {playlistImportStatus && <PlaylistImportStatusBanner status={playlistImportStatus} />}
        {isReorderMode && reorderedEntries ? (
          <>
            <div className="playlist-reorder-list">
              {reorderedEntries.map((entry, index) => {
                const track = entry.track
                const isMissing = entry.missing || track === null
                const title = track?.title ?? getMissingPlaylistEntryLabel(entry)
                const artist = track?.artist ?? entry.track_path

                return (
                  <div
                    key={`${entry.id}:${entry.track_path}`}
                    className={`playlist-reorder-row ${isMissing ? 'missing' : ''} ${dragIndex === index ? 'dragging' : ''} ${dropIndex === index && dragIndex !== index ? 'drop-target' : ''}`}
                    draggable={!isSavingReorder}
                    onDragStart={(event: DragEvent<HTMLDivElement>) => {
                      event.dataTransfer.effectAllowed = 'move'
                      handleReorderDragStart(index)
                    }}
                    onDragOver={(event: DragEvent<HTMLDivElement>) => {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                      handleReorderDragOver(index)
                    }}
                    onDrop={(event: DragEvent<HTMLDivElement>) => {
                      event.preventDefault()
                    }}
                    onDragEnd={handleReorderDragEnd}
                  >
                    <div className="playlist-reorder-handle" aria-hidden="true">
                      <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
                        <circle cx="3" cy="2" r="1.2" />
                        <circle cx="7" cy="2" r="1.2" />
                        <circle cx="3" cy="6" r="1.2" />
                        <circle cx="7" cy="6" r="1.2" />
                        <circle cx="3" cy="10" r="1.2" />
                        <circle cx="7" cy="10" r="1.2" />
                        <circle cx="3" cy="14" r="1.2" />
                        <circle cx="7" cy="14" r="1.2" />
                      </svg>
                    </div>
                    <div className="playlist-reorder-cover">
                      {track ? (
                        <AlbumArtwork
                          hash={track.artwork_hash}
                          alt={track.album || track.title}
                          variant="thumbnail"
                          className="playlist-reorder-cover-image"
                        />
                      ) : (
                        <FileCircleExclamationIcon className="playlist-reorder-missing-icon" />
                      )}
                    </div>
                    <div className="playlist-reorder-index">{index + 1}</div>
                    <div className="playlist-reorder-title">{title}</div>
                    <div className="playlist-reorder-artist">{artist}</div>
                    {isMissing && <div className="playlist-reorder-missing-label">Missing</div>}
                  </div>
                )
              })}
            </div>
            <div className="playlist-reorder-actions">
              {reorderError && <span className="playlist-reorder-error">{reorderError}</span>}
              <button
                type="button"
                className="settings-btn settings-btn-primary"
                onClick={() => {
                  void handleSaveReorder()
                }}
                disabled={isSavingReorder || reorderedEntries.length === 0}
              >
                {isSavingReorder ? 'Saving...' : 'Save Order'}
              </button>
              <button
                type="button"
                className="settings-btn"
                onClick={handleCancelReorder}
                disabled={isSavingReorder}
              >
                Cancel
              </button>
            </div>
          </>
        ) : displayTracks.length > 0 || playlistMissingCount > 0 ? (
          <>
            {displayTracks.length > 0 && (
              <TrackList
                tracks={displayTracks}
                queueSeedTracks={displayPlayableTracks}
                queueSeedIndexes={displayQueueSeedIndexes}
                queueContextLabel={playlistName ?? 'Playlist'}
                trackNumberMode="context"
                contextTrackNumbers={displayTrackNumbers}
                trackInstanceKeys={displayTrackInstanceKeys}
                playlistEntryIds={displayPlaylistEntryIds}
                playlistSourceId={isDynamicPlaylist ? null : selectedPlaylistId}
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
              />
            )}
          </>
        ) : (
          <div className="library-empty">
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
      <ConfirmActionModal
        isOpen={isDiscardReorderConfirmOpen}
        title="Discard Unsaved Reorder?"
        message="You have unsaved playlist reorder changes. Leaving reorder mode will discard them."
        confirmLabel="Discard Changes"
        cancelLabel="Keep Editing"
        isDestructive
        isBusy={isSavingReorder}
        onCancel={() => setIsDiscardReorderConfirmOpen(false)}
        onConfirm={handleConfirmDiscardReorder}
      />
    </div>
  )
}
