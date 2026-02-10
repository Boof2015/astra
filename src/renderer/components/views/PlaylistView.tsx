import { useState } from 'react'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useUIStore } from '../../stores/uiStore'
import TrackList from '../library/TrackList'

export default function PlaylistView() {
  const { selectedPlaylistId, selectedPlaylistTracks, playlists, clearSelection, renamePlaylist, deletePlaylist } = usePlaylistStore()
  const setActiveView = useUIStore((s) => s.setActiveView)

  const playlist = playlists.find((p) => p.id === selectedPlaylistId)

  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')

  const handleBack = () => {
    clearSelection()
    setActiveView('home')
  }

  const handleStartRename = () => {
    setRenameValue(playlist?.name ?? '')
    setIsRenaming(true)
  }

  const handleConfirmRename = async () => {
    const name = renameValue.trim()
    if (name && selectedPlaylistId !== null) {
      await renamePlaylist(selectedPlaylistId, name)
    }
    setIsRenaming(false)
  }

  const handleDelete = async () => {
    if (selectedPlaylistId !== null) {
      await deletePlaylist(selectedPlaylistId)
      handleBack()
    }
  }

  if (!playlist) {
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
          {isRenaming ? (
            <input
              className="playlist-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmRename(); if (e.key === 'Escape') setIsRenaming(false) }}
              onBlur={handleConfirmRename}
              autoFocus
            />
          ) : (
            <h2 onDoubleClick={handleStartRename}>{playlist.name}</h2>
          )}
          <span className="track-count">
            {selectedPlaylistTracks.length} {selectedPlaylistTracks.length === 1 ? 'track' : 'tracks'}
          </span>
        </div>
        <div className="playlist-header-right">
          <button className="icon-btn" onClick={handleStartRename} title="Rename playlist">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
            </svg>
          </button>
          <button className="icon-btn" onClick={handleDelete} title="Delete playlist">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18"/>
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
      <div className="playlist-content">
        {selectedPlaylistTracks.length > 0 ? (
          <TrackList tracks={selectedPlaylistTracks} />
        ) : (
          <div className="library-empty">
            <p>This playlist is empty</p>
            <p className="empty-hint">Add tracks from the Library view</p>
          </div>
        )}
      </div>
    </div>
  )
}
