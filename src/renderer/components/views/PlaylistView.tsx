import { useMemo, useState } from 'react'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useUIStore } from '../../stores/uiStore'
import { FAVORITES_PLAYLIST_ID, FAVORITES_PLAYLIST_NAME, isSystemFavoritesPlaylistId } from '../../utils/playlistSystem'
import TrackList from '../library/TrackList'
import PlaylistCover from '../playlists/PlaylistCover'

export default function PlaylistView() {
  const {
    selectedPlaylistId,
    selectedPlaylistTracks,
    playlists,
    clearSelection,
    renamePlaylist,
    deletePlaylist,
    setPlaylistCustomCoverFromFile,
    clearPlaylistCustomCover
  } = usePlaylistStore()
  const setActiveView = useUIStore((s) => s.setActiveView)

  const isFavoritesPlaylist = isSystemFavoritesPlaylistId(selectedPlaylistId)
  const playlist = playlists.find((p) => p.id === selectedPlaylistId)
  const playlistName = isFavoritesPlaylist ? FAVORITES_PLAYLIST_NAME : playlist?.name

  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [isUpdatingCover, setIsUpdatingCover] = useState(false)

  const playlistCoverHash = useMemo(() => {
    if (isFavoritesPlaylist) {
      return selectedPlaylistTracks[0]?.artwork_hash ?? null
    }
    if (!playlist) return null
    return playlist.custom_cover_hash ?? playlist.auto_cover_hash
  }, [isFavoritesPlaylist, playlist, selectedPlaylistTracks])

  const handleBack = () => {
    clearSelection()
    setActiveView('home')
  }

  const handleStartRename = () => {
    if (isFavoritesPlaylist) return
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
    if (isFavoritesPlaylist) return
    if (selectedPlaylistId !== null) {
      await deletePlaylist(selectedPlaylistId)
      handleBack()
    }
  }

  const handleChangeCover = async () => {
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
    if (isFavoritesPlaylist || selectedPlaylistId === null || selectedPlaylistId <= 0 || isUpdatingCover) return
    if (!playlist?.custom_cover_hash) return

    setIsUpdatingCover(true)
    try {
      await clearPlaylistCustomCover(selectedPlaylistId)
    } finally {
      setIsUpdatingCover(false)
    }
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
                  if (e.key === 'Enter') handleConfirmRename()
                  if (e.key === 'Escape') setIsRenaming(false)
                }}
                onBlur={handleConfirmRename}
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
              className="icon-btn icon-btn-with-tooltip"
              onClick={() => void handleChangeCover()}
              disabled={isUpdatingCover}
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
              disabled={isUpdatingCover || !playlist?.custom_cover_hash}
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
              aria-label="Rename playlist"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
              </svg>
              <span className="icon-btn-tooltip">Rename playlist</span>
            </button>
            <button
              className="icon-btn icon-btn-with-tooltip"
              onClick={handleDelete}
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
        {selectedPlaylistTracks.length > 0 ? (
          <TrackList tracks={selectedPlaylistTracks} playlistSourceId={selectedPlaylistId !== null && selectedPlaylistId > 0 ? selectedPlaylistId : null} />
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
    </div>
  )
}
