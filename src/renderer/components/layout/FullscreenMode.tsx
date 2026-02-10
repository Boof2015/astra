import { useUIStore } from '../../stores/uiStore'
import { usePlayerStore } from '../../stores/playerStore'

export default function FullscreenMode() {
  const setFullscreen = useUIStore((s) => s.setFullscreen)
  const currentTrack = usePlayerStore((s) => s.currentTrack)

  return (
    <div className="fullscreen-overlay">
      <button className="fullscreen-close" onClick={() => setFullscreen(false)} title="Exit fullscreen">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>
        </svg>
      </button>

      <div className="fullscreen-content">
        <div className="fullscreen-track-info">
          {currentTrack ? (
            <>
              <h1 className="fullscreen-title">{currentTrack.title}</h1>
              <p className="fullscreen-artist">{currentTrack.artist}</p>
              <p className="fullscreen-album">{currentTrack.album}</p>
            </>
          ) : (
            <h1 className="fullscreen-title">No track playing</h1>
          )}
        </div>
      </div>
    </div>
  )
}
