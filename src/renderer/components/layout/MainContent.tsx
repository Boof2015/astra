import { useEffect, useState } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import { useLibraryStore } from '../../stores/libraryStore'
import { Track } from '../../types/audio'
import TrackList from '../library/TrackList'
import QueuePanel from '../queue/QueuePanel'
import AlbumArtwork from '../library/AlbumArtwork'
import FolderSettings from '../settings/FolderSettings'
import VisualizerPanel from '../visualizers/VisualizerPanel'

export default function MainContent() {
  const {
    currentTrack,
    playbackState,
    currentTime,
    duration,
    volume,
    isMuted,
    queue,
    queueIndex,
    loadTrack,
    togglePlay,
    seek,
    setVolume,
    toggleMute,
    playNext,
    playPrevious,
    setQueue
  } = usePlayerStore()

  const {
    tracks,
    albums,
    artists,
    viewMode,
    selectedAlbum,
    selectedArtist,
    isLoading,
    isScanning,
    scanProgress,
    loadLibrary,
    addFolder,
    rescan,
    setViewMode,
    selectAlbum,
    selectArtist,
    clearSelection
  } = useLibraryStore()

  // Queue panel visibility
  const [showQueue, setShowQueue] = useState(false)
  // Folder settings modal visibility
  const [showFolderSettings, setShowFolderSettings] = useState(false)

  // Load library on mount
  useEffect(() => {
    loadLibrary()
  }, [loadLibrary])

  // Format time as M:SS
  const formatTime = (seconds: number): string => {
    if (!isFinite(seconds) || isNaN(seconds)) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  // Handle open file (single file, not library)
  const handleOpenFile = async () => {
    const result = await window.electronAPI.openAudioFile()
    if (result) {
      const track: Track = {
        id: result.path,
        path: result.path,
        title: result.metadata?.title ?? result.name,
        artist: result.metadata?.artist ?? 'Unknown Artist',
        album: result.metadata?.album ?? 'Unknown Album',
        duration: result.metadata?.duration ?? 0,
        format: result.metadata?.format ?? 'unknown',
        artworkData: result.metadata?.artwork
      }
      await loadTrack(track, result.data)
    }
  }

  // Handle progress bar click
  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (duration <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const percent = (e.clientX - rect.left) / rect.width
    seek(percent * duration)
  }

  // Handle volume change
  const handleVolumeClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const percent = (e.clientX - rect.left) / rect.width
    setVolume(Math.max(0, Math.min(1, percent)))
  }

  const isPlaying = playbackState === 'playing'
  const isLoadingTrack = playbackState === 'loading'
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  // Render library header
  const renderLibraryHeader = () => {
    let title = 'Library'
    let showViewTabs = true
    let itemCount = tracks.length
    let itemLabel = tracks.length === 1 ? 'track' : 'tracks'

    if (selectedAlbum) {
      title = selectedAlbum.album
      showViewTabs = false
    } else if (selectedArtist) {
      title = selectedArtist
      showViewTabs = false
    } else if (viewMode === 'albums') {
      itemCount = albums.length
      itemLabel = albums.length === 1 ? 'album' : 'albums'
    } else if (viewMode === 'artists') {
      itemCount = artists.length
      itemLabel = artists.length === 1 ? 'artist' : 'artists'
    }

    return (
      <div className="library-header">
        <div className="library-header-left">
          {(selectedAlbum || selectedArtist) && (
            <button className="back-btn" onClick={clearSelection} title="Back">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
              </svg>
            </button>
          )}
          <h2>{title}</h2>
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
            </div>
          )}
          <span className="track-count">
            {itemCount} {itemLabel}
          </span>
        </div>
        <div className="library-header-right">
          <button className="icon-btn" onClick={handleOpenFile} title="Open File">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
            </svg>
          </button>
          <button className="icon-btn" onClick={rescan} title="Rescan Library" disabled={isScanning}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
            </svg>
          </button>
          <button className="icon-btn" onClick={() => setShowFolderSettings(true)} title="Manage Folders">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
            </svg>
          </button>
          <button className="add-folder-btn" onClick={addFolder}>
            <span>+</span> Add Folder
          </button>
        </div>
      </div>
    )
  }

  // Render scanning progress
  const renderScanProgress = () => {
    if (!isScanning || !scanProgress) return null
    const percent = scanProgress.total > 0 ? (scanProgress.current / scanProgress.total) * 100 : 0
    const fileName = scanProgress.file ? scanProgress.file.split('/').pop() || scanProgress.file.split('\\').pop() : ''
    return (
      <div className="scan-overlay">
        <div className="scan-progress">
          <div className="loading-spinner" />
          <div className="scan-title">Scanning Library</div>
          <div className="scan-count">{scanProgress.current} / {scanProgress.total} files</div>
          <div className="scan-bar">
            <div className="scan-bar-fill" style={{ width: `${percent}%` }} />
          </div>
          {fileName && <div className="scan-file">{fileName}</div>}
        </div>
      </div>
    )
  }

  // Render library content
  const renderLibraryContent = () => {
    if (isLoading) {
      return (
        <div className="library-loading">
          <div className="loading-spinner" />
          <p>Loading library...</p>
        </div>
      )
    }

    // Show empty state only when no content at all
    const hasContent = tracks.length > 0 || albums.length > 0 || artists.length > 0
    if (!hasContent && !selectedAlbum && !selectedArtist) {
      return (
        <div className="library-empty">
          <div className="empty-icon">♫</div>
          <p>Your library is empty</p>
          <p className="empty-hint">Click "Add Folder" to scan your music</p>
        </div>
      )
    }

    // Show album grid
    if (viewMode === 'albums' && !selectedAlbum && !selectedArtist) {
      if (albums.length === 0) {
        return (
          <div className="library-empty">
            <p>No albums found</p>
          </div>
        )
      }
      return (
        <div className="album-grid">
          {albums.map((album) => (
            <div
              key={`${album.album}-${album.artist}`}
              className="album-card"
              onClick={() => selectAlbum(album.album, album.artist)}
            >
              <div className="album-artwork">
                <AlbumArtwork hash={album.artwork_hash} alt={album.album} />
              </div>
              <div className="album-info">
                <div className="album-title">{album.album}</div>
                <div className="album-artist">{album.artist}</div>
                <div className="album-meta">{album.track_count} tracks{album.year ? ` • ${album.year}` : ''}</div>
              </div>
            </div>
          ))}
        </div>
      )
    }

    // Show artist list
    if (viewMode === 'artists' && !selectedAlbum && !selectedArtist) {
      if (artists.length === 0) {
        return (
          <div className="library-empty">
            <p>No artists found</p>
          </div>
        )
      }
      return (
        <div className="artist-list">
          {artists.map((artist) => (
            <div
              key={artist.artist}
              className="artist-item"
              onClick={() => selectArtist(artist.artist)}
            >
              <div className="artist-avatar">
                {artist.artist.charAt(0).toUpperCase()}
              </div>
              <div className="artist-info">
                <div className="artist-name">{artist.artist}</div>
                <div className="artist-track-count">{artist.track_count} tracks</div>
              </div>
            </div>
          ))}
        </div>
      )
    }

    // Show tracks
    return <TrackList tracks={tracks} showArtist={!selectedArtist} showAlbum={!selectedAlbum} />
  }

  return (
    <main className="main-content">
      <div className="main-content-wrapper">
        <div className="main-content-area">
          {/* Visualizer Panel */}
          <div className="visualizer-container glass-panel">
            <VisualizerPanel />
          </div>

          {/* Library Panel */}
          <div className="library-panel glass-panel">
            {renderLibraryHeader()}
            {renderScanProgress()}
            <div className="library-content">
              {renderLibraryContent()}
            </div>
          </div>
        </div>

        {/* Queue Sidebar */}
        <div className={`queue-sidebar ${showQueue ? '' : 'hidden'}`}>
          <QueuePanel />
        </div>
      </div>

      {/* Now Playing Bar */}
      <div className="now-playing glass-panel">
        <div className="now-playing-info">
          <div className="now-playing-artwork">
            {currentTrack?.artworkHash ? (
              <AlbumArtwork hash={currentTrack.artworkHash} alt="Album art" />
            ) : currentTrack?.artworkData ? (
              <img src={currentTrack.artworkData} alt="Album art" />
            ) : (
              <div className="artwork-placeholder">♫</div>
            )}
          </div>
          <div className="now-playing-text">
            <div className="now-playing-title">
              {currentTrack?.title ?? 'No track playing'}
            </div>
            <div className="now-playing-artist">
              {currentTrack?.artist ?? '—'}
            </div>
          </div>
        </div>

        <div className="now-playing-controls">
          <button
            className="control-btn"
            aria-label="Previous"
            onClick={playPrevious}
            disabled={queue.length === 0}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
            </svg>
          </button>
          <button
            className="control-btn control-btn-play"
            onClick={togglePlay}
            disabled={!currentTrack || isLoadingTrack}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isLoadingTrack ? (
              <div className="loading-spinner" />
            ) : isPlaying ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
            )}
          </button>
          <button
            className="control-btn"
            aria-label="Next"
            onClick={playNext}
            disabled={queue.length === 0}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
            </svg>
          </button>
        </div>

        <div className="now-playing-progress">
          <span className="progress-time">{formatTime(currentTime)}</span>
          <div
            className="progress-bar"
            onClick={handleProgressClick}
            role="slider"
            aria-valuenow={currentTime}
            aria-valuemin={0}
            aria-valuemax={duration}
          >
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="progress-time">{formatTime(duration)}</span>
        </div>

        <div className="now-playing-volume">
          <button
            className="volume-btn"
            onClick={toggleMute}
            aria-label={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted || volume === 0 ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
              </svg>
            ) : volume < 0.5 ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 9v6h4l5 5V4l-5 5H7z"/>
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
              </svg>
            )}
          </button>
          <div
            className="volume-slider"
            onClick={handleVolumeClick}
            role="slider"
            aria-valuenow={volume * 100}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="volume-fill"
              style={{ width: `${isMuted ? 0 : volume * 100}%` }}
            />
          </div>
          <button
            className={`queue-toggle-btn ${showQueue ? 'active' : ''}`}
            onClick={() => setShowQueue(!showQueue)}
            title="Toggle queue"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Folder Settings Modal */}
      <FolderSettings
        isOpen={showFolderSettings}
        onClose={() => setShowFolderSettings(false)}
      />
    </main>
  )
}
