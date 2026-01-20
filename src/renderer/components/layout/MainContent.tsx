import { usePlayerStore } from '../../stores/playerStore'
import { Track } from '../../types/audio'

export default function MainContent() {
  const {
    currentTrack,
    playbackState,
    currentTime,
    duration,
    volume,
    isMuted,
    loadTrack,
    togglePlay,
    seek,
    setVolume,
    toggleMute
  } = usePlayerStore()

  // Format time as M:SS
  const formatTime = (seconds: number): string => {
    if (!isFinite(seconds) || isNaN(seconds)) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  // Handle open file
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
  const isLoading = playbackState === 'loading'
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <main className="main-content">
      {/* Visualizer Panel (placeholder) */}
      <div className="visualizer-panel glass-panel">
        <div className="visualizer-placeholder">
          <div className="visualizer-label">Oscilloscope</div>
          <div className="visualizer-empty">
            {isPlaying ? (
              <span className="visualizer-active">Visualizer coming in Phase 5</span>
            ) : (
              <span>No audio playing</span>
            )}
          </div>
        </div>
      </div>

      {/* Library/Content area */}
      <div className="library-panel glass-panel">
        <div className="library-header">
          <h2>Library</h2>
          <button className="add-folder-btn" onClick={handleOpenFile}>
            <span>+</span> Open File
          </button>
        </div>

        {currentTrack ? (
          <div className="library-track-info">
            <div className="track-details">
              <h3>{currentTrack.title}</h3>
              <p>{currentTrack.artist}</p>
              <p className="track-album">{currentTrack.album}</p>
              <p className="track-format">{currentTrack.format.toUpperCase()}</p>
            </div>
          </div>
        ) : (
          <div className="library-empty">
            <div className="empty-icon">♫</div>
            <p>No track loaded</p>
            <p className="empty-hint">Click "Open File" to load an audio file</p>
          </div>
        )}
      </div>

      {/* Now Playing Bar */}
      <div className="now-playing glass-panel">
        <div className="now-playing-info">
          <div className="now-playing-artwork">
            {currentTrack?.artworkData ? (
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
          <button className="control-btn" aria-label="Previous" disabled>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
            </svg>
          </button>
          <button
            className="control-btn control-btn-play"
            onClick={togglePlay}
            disabled={!currentTrack || isLoading}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isLoading ? (
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
          <button className="control-btn" aria-label="Next" disabled>
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
        </div>
      </div>
    </main>
  )
}
