export default function MainContent() {
  return (
    <main className="main-content">
      {/* Visualizer Panel (placeholder) */}
      <div className="visualizer-panel glass-panel">
        <div className="visualizer-placeholder">
          <div className="visualizer-label">Oscilloscope</div>
          <div className="visualizer-empty">
            <span>No audio playing</span>
          </div>
        </div>
      </div>

      {/* Library/Content area (placeholder) */}
      <div className="library-panel glass-panel">
        <div className="library-header">
          <h2>All Songs</h2>
          <button className="add-folder-btn">
            <span>+</span> Add Folder
          </button>
        </div>
        <div className="library-empty">
          <div className="empty-icon">♫</div>
          <p>Your library is empty</p>
          <p className="empty-hint">Add a folder to get started</p>
        </div>
      </div>

      {/* Now Playing Bar */}
      <div className="now-playing glass-panel">
        <div className="now-playing-info">
          <div className="now-playing-artwork">
            <div className="artwork-placeholder">♫</div>
          </div>
          <div className="now-playing-text">
            <div className="now-playing-title">No track playing</div>
            <div className="now-playing-artist">—</div>
          </div>
        </div>

        <div className="now-playing-controls">
          <button className="control-btn" aria-label="Previous">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
            </svg>
          </button>
          <button className="control-btn control-btn-play" aria-label="Play">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
          </button>
          <button className="control-btn" aria-label="Next">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
            </svg>
          </button>
        </div>

        <div className="now-playing-progress">
          <span className="progress-time">0:00</span>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: '0%' }} />
          </div>
          <span className="progress-time">0:00</span>
        </div>

        <div className="now-playing-volume">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
          </svg>
          <div className="volume-slider">
            <div className="volume-fill" style={{ width: '70%' }} />
          </div>
        </div>
      </div>
    </main>
  )
}
