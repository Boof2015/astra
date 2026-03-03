import { DragEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useUIStore } from '../../stores/uiStore'
import { FAVORITES_PLAYLIST_ID, FAVORITES_PLAYLIST_NAME, isSystemFavoritesPlaylistId } from '../../utils/playlistSystem'
import AlbumArtwork from '../library/AlbumArtwork'
import TrackList, { type TrackListSortKey, type TrackListSortState } from '../library/TrackList'
import PlaylistCover from '../playlists/PlaylistCover'
import ConfirmActionModal from '../settings/ConfirmActionModal'

type SortDirection = 'asc' | 'desc'
type PlaylistTrack = ReturnType<typeof usePlaylistStore.getState>['selectedPlaylistTracks'][number]

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
  return compareNullableKey(a.musical_key, b.musical_key, sortState.direction)
}

export default function PlaylistView() {
  const {
    selectedPlaylistId,
    selectedPlaylistTracks,
    playlists,
    clearSelection,
    renamePlaylist,
    deletePlaylist,
    setPlaylistCustomCoverFromFile,
    clearPlaylistCustomCover,
    reorderPlaylistTracks
  } = usePlaylistStore()
  const setActiveView = useUIStore((s) => s.setActiveView)
  const showTracklistBpmKey = useLibraryStore((s) => s.showTracklistBpmKey)

  const isFavoritesPlaylist = isSystemFavoritesPlaylistId(selectedPlaylistId)
  const playlist = playlists.find((p) => p.id === selectedPlaylistId)
  const playlistName = isFavoritesPlaylist ? FAVORITES_PLAYLIST_NAME : playlist?.name

  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [isUpdatingCover, setIsUpdatingCover] = useState(false)
  const [sortState, setSortState] = useState<TrackListSortState | null>(null)
  const [isReorderMode, setIsReorderMode] = useState(false)
  const [reorderedTracks, setReorderedTracks] = useState<PlaylistTrack[] | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [isSavingReorder, setIsSavingReorder] = useState(false)
  const [reorderError, setReorderError] = useState<string | null>(null)
  const [isDiscardReorderConfirmOpen, setIsDiscardReorderConfirmOpen] = useState(false)

  useEffect(() => {
    setSortState(null)
    setIsReorderMode(false)
    setReorderedTracks(null)
    setDragIndex(null)
    setDropIndex(null)
    setReorderError(null)
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
    if (!isFavoritesPlaylist || !isReorderMode) return
    setIsReorderMode(false)
    setReorderedTracks(null)
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
    return playlist.custom_cover_hash ?? playlist.auto_cover_hash
  }, [isFavoritesPlaylist, playlist, selectedPlaylistTracks])

  const displayTracks = useMemo(() => {
    if (!sortState) return selectedPlaylistTracks

    const indexedTracks = selectedPlaylistTracks.map((track, index) => ({ track, index }))
    indexedTracks.sort((left, right) => {
      const comparison = comparePlaylistTracksBySort(left.track, right.track, sortState)
      if (comparison !== 0) return comparison

      const pathComparison = comparePath(left.track.path, right.track.path)
      if (pathComparison !== 0) return pathComparison

      return left.index - right.index
    })

    return indexedTracks.map(({ track }) => track)
  }, [selectedPlaylistTracks, sortState])

  const canReorderTracks = !isFavoritesPlaylist && selectedPlaylistId !== null && selectedPlaylistId > 0
  const hasUnsavedReorderChanges = useMemo(() => {
    if (!isReorderMode || !reorderedTracks) return false
    if (reorderedTracks.length !== selectedPlaylistTracks.length) return true

    for (let index = 0; index < reorderedTracks.length; index += 1) {
      if (reorderedTracks[index]?.path !== selectedPlaylistTracks[index]?.path) {
        return true
      }
    }

    return false
  }, [isReorderMode, reorderedTracks, selectedPlaylistTracks])

  const handleBack = () => {
    clearSelection()
    setActiveView('home')
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

  const handleDelete = async () => {
    if (isFavoritesPlaylist || isReorderMode || isSavingReorder) return
    if (selectedPlaylistId !== null) {
      await deletePlaylist(selectedPlaylistId)
      handleBack()
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
      setReorderedTracks(null)
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
    setReorderedTracks([...selectedPlaylistTracks])
    setIsReorderMode(true)
  }, [canReorderTracks, hasUnsavedReorderChanges, isReorderMode, isSavingReorder, selectedPlaylistTracks])

  const handleCancelReorder = useCallback(() => {
    if (isSavingReorder) return
    if (hasUnsavedReorderChanges) {
      setIsDiscardReorderConfirmOpen(true)
      return
    }
    setIsDiscardReorderConfirmOpen(false)
    setIsReorderMode(false)
    setReorderedTracks(null)
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
    if (dragIndex === null || dropIndex === null || dragIndex === dropIndex || !reorderedTracks) {
      setDragIndex(null)
      setDropIndex(null)
      return
    }

    const updated = [...reorderedTracks]
    const [moved] = updated.splice(dragIndex, 1)
    if (!moved) {
      setDragIndex(null)
      setDropIndex(null)
      return
    }
    updated.splice(dropIndex, 0, moved)
    setReorderedTracks(updated)
    setDragIndex(null)
    setDropIndex(null)
  }, [dragIndex, dropIndex, reorderedTracks])

  const handleSaveReorder = useCallback(async () => {
    if (isSavingReorder) return
    if (!canReorderTracks || selectedPlaylistId === null) return
    if (!reorderedTracks || reorderedTracks.length === 0) return

    setIsSavingReorder(true)
    setReorderError(null)
    try {
      await reorderPlaylistTracks(selectedPlaylistId, reorderedTracks.map((track) => track.path))
      setIsDiscardReorderConfirmOpen(false)
      setIsReorderMode(false)
      setReorderedTracks(null)
      setDragIndex(null)
      setDropIndex(null)
      setSortState(null)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to reorder playlist tracks.'
      setReorderError(message)
    } finally {
      setIsSavingReorder(false)
    }
  }, [canReorderTracks, isSavingReorder, reorderedTracks, reorderPlaylistTracks, selectedPlaylistId])

  const handleConfirmDiscardReorder = useCallback(() => {
    if (isSavingReorder) return
    setIsDiscardReorderConfirmOpen(false)
    setIsReorderMode(false)
    setReorderedTracks(null)
    setDragIndex(null)
    setDropIndex(null)
    setReorderError(null)
  }, [isSavingReorder])

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
              <h2 onDoubleClick={isFavoritesPlaylist ? undefined : handleStartRename}>{playlistName}</h2>
            )}
            <span className="track-count">
              {selectedPlaylistTracks.length} {selectedPlaylistTracks.length === 1 ? 'track' : 'tracks'}
            </span>
          </div>
        </div>
        {!isFavoritesPlaylist && (
          <div className="playlist-header-right">
            <button
              className={`icon-btn icon-btn-with-tooltip ${isReorderMode ? 'active' : ''}`}
              onClick={handleToggleReorderMode}
              disabled={isSavingReorder || (!isReorderMode && selectedPlaylistTracks.length < 2)}
              aria-label={isReorderMode ? 'Exit reorder mode' : 'Reorder tracks'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" />
                <path d="M3 12h18" />
                <path d="M3 18h18" />
              </svg>
              <span className="icon-btn-tooltip">{isReorderMode ? 'Exit reorder mode' : 'Reorder tracks'}</span>
            </button>
            <button
              className="icon-btn icon-btn-with-tooltip"
              onClick={() => void handleChangeCover()}
              disabled={isUpdatingCover || isReorderMode || isSavingReorder}
              aria-label="Change cover"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="m18 2 4 4-10 10H8v-4L18 2z" />
              </svg>
              <span className="icon-btn-tooltip">Change cover</span>
            </button>
            <button
              className="icon-btn icon-btn-with-tooltip"
              onClick={() => void handleClearCover()}
              disabled={isUpdatingCover || !playlist?.custom_cover_hash || isReorderMode || isSavingReorder}
              aria-label="Remove custom cover"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3l18 18" />
                <circle cx="12" cy="12" r="9" />
              </svg>
              <span className="icon-btn-tooltip">Remove custom cover</span>
            </button>
            <button
              className="icon-btn icon-btn-with-tooltip"
              onClick={handleStartRename}
              disabled={isReorderMode || isSavingReorder}
              aria-label="Rename playlist"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
              </svg>
              <span className="icon-btn-tooltip">Rename playlist</span>
            </button>
            <button
              className="icon-btn icon-btn-with-tooltip"
              onClick={() => void handleDelete()}
              disabled={isReorderMode || isSavingReorder}
              aria-label="Delete playlist"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18"/>
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
              </svg>
              <span className="icon-btn-tooltip">Delete playlist</span>
            </button>
          </div>
        )}
      </div>
      <div className="playlist-content">
        {isReorderMode && reorderedTracks ? (
          <>
            <div className="playlist-reorder-list">
              {reorderedTracks.map((track, index) => (
                <div
                  key={`${track.path}:${index}`}
                  className={`playlist-reorder-row ${dragIndex === index ? 'dragging' : ''} ${dropIndex === index && dragIndex !== index ? 'drop-target' : ''}`}
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
                    <AlbumArtwork
                      hash={track.artwork_hash}
                      alt={track.album || track.title}
                      variant="thumbnail"
                      className="playlist-reorder-cover-image"
                    />
                  </div>
                  <div className="playlist-reorder-index">{index + 1}</div>
                  <div className="playlist-reorder-title">{track.title}</div>
                  <div className="playlist-reorder-artist">{track.artist}</div>
                </div>
              ))}
            </div>
            <div className="playlist-reorder-actions">
              {reorderError && <span className="playlist-reorder-error">{reorderError}</span>}
              <button
                type="button"
                className="settings-btn settings-btn-primary"
                onClick={() => {
                  void handleSaveReorder()
                }}
                disabled={isSavingReorder || reorderedTracks.length === 0}
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
        ) : displayTracks.length > 0 ? (
          <TrackList
            tracks={displayTracks}
            queueSeedTracks={displayTracks}
            playlistSourceId={selectedPlaylistId !== null && selectedPlaylistId > 0 ? selectedPlaylistId : null}
            enableColumnSorting
            sortState={sortState}
            onSortColumnToggle={handleSortColumnToggle}
            enableDefaultOrderReset
            onDefaultOrderReset={handleResetToDefaultOrder}
          />
        ) : (
          <div className="library-empty">
            <p>{selectedPlaylistId === FAVORITES_PLAYLIST_ID ? 'No favorites yet' : 'This playlist is empty'}</p>
            <p className="empty-hint">
              {selectedPlaylistId === FAVORITES_PLAYLIST_ID
                ? 'Click the heart icon on any track to add favorites.'
                : 'Add tracks from the Library view'}
            </p>
          </div>
        )}
      </div>
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
