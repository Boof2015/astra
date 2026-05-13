import { DragEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useUIStore } from '../../stores/uiStore'
import {
  buildPlaylistDisplaySections,
  FAVORITES_PLAYLIST_ID,
  FAVORITES_PLAYLIST_NAME,
  isSystemFavoritesPlaylistId
} from '../../utils/playlistSystem'
import { formatPlaylistImportStatus, type PlaylistImportStatus } from '../../utils/playlistImportStatus'
import AlbumArtwork from '../library/AlbumArtwork'
import TrackList, { type TrackListSortKey, type TrackListSortState } from '../library/TrackList'
import CreatePlaylistModal from '../playlists/CreatePlaylistModal'
import PlaylistCover from '../playlists/PlaylistCover'
import ConfirmActionModal from '../settings/ConfirmActionModal'

const PLAYLIST_IMPORT_STATUS_TIMEOUT_MS = 9000

type SortDirection = 'asc' | 'desc'
type PlaylistTrack = ReturnType<typeof usePlaylistStore.getState>['selectedPlaylistTracks'][number]
type PlaylistEntry = ReturnType<typeof usePlaylistStore.getState>['selectedPlaylistEntries'][number]

function getPlaylistEntryPath(entry: PlaylistEntry): string {
  return entry.track?.path ?? entry.track_path
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

function comparePlaylistTracksBySort(a: PlaylistTrack, b: PlaylistTrack, sortState: TrackListSortState): number {
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
  if (sortState.key === 'added') {
    return compareWithDirection(resolveEffectiveAddedAt(a) - resolveEffectiveAddedAt(b), sortState.direction)
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
    loadPlaylists,
    selectPlaylist,
    renamePlaylist,
    deletePlaylist,
    setPlaylistCustomCoverFromFile,
    clearPlaylistCustomCover,
    reorderPlaylistTracks,
    importPlaylistFromFile
  } = usePlaylistStore()
  const setActiveView = useUIStore((s) => s.setActiveView)
  const showTracklistBpmKey = useLibraryStore((s) => s.showTracklistBpmKey)
  const favoriteTrackPaths = useLibraryStore((s) => s.favoriteTrackPaths)
  const trackCacheVersion = useLibraryStore((s) => s.trackCacheVersion)
  const resolveTrackPaths = useLibraryStore((s) => s.resolveTrackPaths)
  const favoriteTracks = useMemo(
    () => resolveTrackPaths(favoriteTrackPaths),
    [favoriteTrackPaths, resolveTrackPaths, trackCacheVersion]
  )

  const isPlaylistBrowser = selectedPlaylistId === null
  const isFavoritesPlaylist = isSystemFavoritesPlaylistId(selectedPlaylistId)
  const playlist = playlists.find((p) => p.id === selectedPlaylistId)
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
  const [sortState, setSortState] = useState<TrackListSortState | null>(null)
  const [isReorderMode, setIsReorderMode] = useState(false)
  const [reorderedEntries, setReorderedEntries] = useState<PlaylistEntry[] | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [isDeletingPlaylist, setIsDeletingPlaylist] = useState(false)
  const [isSavingReorder, setIsSavingReorder] = useState(false)
  const [reorderError, setReorderError] = useState<string | null>(null)
  const [isCreatePlaylistModalOpen, setIsCreatePlaylistModalOpen] = useState(false)
  const [isImportingPlaylist, setIsImportingPlaylist] = useState(false)
  const [playlistImportStatus, setPlaylistImportStatus] = useState<PlaylistImportStatus | null>(null)
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false)
  const [isDiscardReorderConfirmOpen, setIsDiscardReorderConfirmOpen] = useState(false)

  useEffect(() => {
    setIsRenaming(false)
    setRenameValue('')
    setIsUpdatingCover(false)
    setSortState(null)
    setIsReorderMode(false)
    setReorderedEntries(null)
    setDragIndex(null)
    setDropIndex(null)
    setIsDeletingPlaylist(false)
    setReorderError(null)
    setIsCreatePlaylistModalOpen(false)
    setIsDeleteConfirmOpen(false)
    setIsSavingReorder(false)
    setIsDiscardReorderConfirmOpen(false)
  }, [selectedPlaylistId])

  useEffect(() => {
    if (showTracklistBpmKey) return
    if (!sortState) return
    if (sortState.key !== 'bpm' && sortState.key !== 'musical_key') return
    setSortState(null)
  }, [showTracklistBpmKey, sortState])

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

  const playlistDisplayTracks = useMemo(() => {
    if (isFavoritesPlaylist) return selectedPlaylistTracks
    return selectedPlaylistEntries.map((entry, index) => entry.track ?? createMissingPlaylistTrackPlaceholder(entry, index))
  }, [isFavoritesPlaylist, selectedPlaylistEntries, selectedPlaylistTracks])

  const displayTracks = useMemo(() => {
    if (!sortState) return playlistDisplayTracks

    const indexedTracks = playlistDisplayTracks.map((track, index) => ({ track, index }))
    indexedTracks.sort((left, right) => {
      const comparison = comparePlaylistTracksBySort(left.track, right.track, sortState)
      if (comparison !== 0) return comparison

      const pathComparison = comparePath(left.track.path, right.track.path)
      if (pathComparison !== 0) return pathComparison

      return left.index - right.index
    })

    return indexedTracks.map(({ track }) => track)
  }, [playlistDisplayTracks, sortState])

  const displayPlayableTracks = useMemo(
    () => displayTracks.filter((track) => !isMissingPlaylistDisplayTrack(track)),
    [displayTracks]
  )

  const playlistMissingCount = selectedPlaylistEntries.reduce(
    (count, entry) => count + (entry.missing || entry.track === null ? 1 : 0),
    0
  )
  const playlistEntryCount = isFavoritesPlaylist ? selectedPlaylistTracks.length : selectedPlaylistEntries.length

  useEffect(() => {
    if (selectedPlaylistId === null || isFavoritesPlaylist || isReorderMode || isSavingReorder) return
    void loadPlaylists()
    void selectPlaylist(selectedPlaylistId)
  }, [isFavoritesPlaylist, isReorderMode, isSavingReorder, loadPlaylists, selectPlaylist, selectedPlaylistId, trackCacheVersion])

  const canReorderTracks = !isFavoritesPlaylist && selectedPlaylistId !== null && selectedPlaylistId > 0
  const hasUnsavedReorderChanges = useMemo(() => {
    if (!isReorderMode || !reorderedEntries) return false
    if (reorderedEntries.length !== selectedPlaylistEntries.length) return true

    for (let index = 0; index < reorderedEntries.length; index += 1) {
      const reorderedEntry = reorderedEntries[index]
      const currentEntry = selectedPlaylistEntries[index]
      if (!reorderedEntry || !currentEntry || getPlaylistEntryPath(reorderedEntry) !== getPlaylistEntryPath(currentEntry)) {
        return true
      }
    }

    return false
  }, [isReorderMode, reorderedEntries, selectedPlaylistEntries])

  const handleBack = () => {
    clearSelection()
    setActiveView('playlist')
  }

  const handleStartRename = () => {
    if (isFavoritesPlaylist || isReorderMode || isSavingReorder) return
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
    setIsDeleteConfirmOpen(true)
  }

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
    setSortState((current) => {
      if (current?.key === key) {
        return {
          key,
          direction: current.direction === 'asc' ? 'desc' : 'asc'
        }
      }
      return {
        key,
        direction: 'asc'
      }
    })
  }, [])

  const handleResetToDefaultOrder = useCallback(() => {
    setSortState(null)
  }, [])

  const handleToggleReorderMode = useCallback(() => {
    if (!canReorderTracks || isSavingReorder) return

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
  }, [canReorderTracks, hasUnsavedReorderChanges, isReorderMode, isSavingReorder, selectedPlaylistEntries])

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
      await reorderPlaylistTracks(selectedPlaylistId, reorderedEntries.map(getPlaylistEntryPath))
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
  }, [canReorderTracks, isSavingReorder, reorderedEntries, reorderPlaylistTracks, selectPlaylist, selectedPlaylistId])

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
            <div className="playlist-browser-grid">
              {allPlaylists.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="playlist-browser-card"
                  onClick={() => {
                    void handleOpenPlaylist(entry.id)
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
      <div className="playlist-header">
        <div className="playlist-header-left">
          <button className="back-btn" onClick={handleBack} title="Back">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
            </svg>
          </button>
          <PlaylistCover
            hash={playlistCoverHash}
            name={playlistName ?? FAVORITES_PLAYLIST_NAME}
            isFavorites={isFavoritesPlaylist}
            className="playlist-header-cover"
          />
          <div className="playlist-header-meta">
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
              <h2>{playlistName}</h2>
            )}
            <span className="track-count">
              {selectedPlaylistTracks.length} {selectedPlaylistTracks.length === 1 ? 'track' : 'tracks'}
              {playlistMissingCount > 0 && (
                <span className="playlist-missing-count"> / {playlistMissingCount} missing</span>
              )}
            </span>
          </div>
        </div>
        <div className="playlist-header-actions">
          <button
            type="button"
            className="settings-btn settings-btn-primary playlist-action-btn"
            onClick={() => setIsCreatePlaylistModalOpen(true)}
            disabled={isReorderMode || isSavingReorder || isDeletingPlaylist}
          >
            New Playlist
          </button>
          {!isFavoritesPlaylist && (
            <>
              <button
                type="button"
                className="settings-btn playlist-action-btn"
                onClick={handleStartRename}
                disabled={isReorderMode || isSavingReorder || isDeletingPlaylist}
              >
                Rename
              </button>
              <button
                type="button"
                className="settings-btn playlist-action-btn"
                onClick={() => void handleChangeCover()}
                disabled={isUpdatingCover || isReorderMode || isSavingReorder || isDeletingPlaylist}
              >
                {isUpdatingCover ? 'Updating Cover...' : 'Change Cover'}
              </button>
              <button
                type="button"
                className="settings-btn playlist-action-btn"
                onClick={() => void handleClearCover()}
                disabled={isUpdatingCover || !playlist?.custom_cover_hash || isReorderMode || isSavingReorder || isDeletingPlaylist}
              >
                Remove Cover
              </button>
              <button
                type="button"
                className={`settings-btn playlist-action-btn ${isReorderMode ? 'settings-btn-primary' : ''}`}
                onClick={handleToggleReorderMode}
                disabled={isSavingReorder || isDeletingPlaylist || (!isReorderMode && playlistEntryCount < 2)}
              >
                {isReorderMode ? 'Exit Reorder' : 'Reorder Tracks'}
              </button>
              <button
                type="button"
                className="settings-btn playlist-action-btn playlist-action-btn-danger"
                onClick={handleRequestDelete}
                disabled={isReorderMode || isSavingReorder || isDeletingPlaylist}
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>
      <div className="playlist-content">
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
                queueContextLabel={playlistName ?? 'Playlist'}
                playlistSourceId={selectedPlaylistId !== null && selectedPlaylistId > 0 ? selectedPlaylistId : null}
                enableColumnSorting
                sortState={sortState}
                onSortColumnToggle={handleSortColumnToggle}
                enableDefaultOrderReset
                onDefaultOrderReset={handleResetToDefaultOrder}
              />
            )}
          </>
        ) : (
          <div className="library-empty">
            <p>{selectedPlaylistId === FAVORITES_PLAYLIST_ID ? 'No favorites yet' : 'This playlist is empty'}</p>
            <p className="empty-hint">
              {selectedPlaylistId === FAVORITES_PLAYLIST_ID
                ? 'Click the heart icon on any track to add favorites.'
                : 'Add tracks from the Library view'}
            </p>
            {selectedPlaylistId !== FAVORITES_PLAYLIST_ID && (
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
        onImport={handleImportPlaylist}
        isImporting={isImportingPlaylist}
      />
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
