import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type {
  MiniPlayerSnapshot,
  MiniPlayerVisualizerMode,
  MiniPlayerWindowState
} from '../../../types/miniPlayer'
import MiniPlayerBackdropVisualizer from './MiniPlayerBackdropVisualizer'
import '../../styles/mini-player.css'

const EMPTY_SNAPSHOT: MiniPlayerSnapshot = {
  playbackState: 'stopped',
  currentTime: 0,
  duration: 0,
  queueLength: 0,
  outputDeviceLabel: null,
  currentTrack: null,
  visualizerLineColor: '#38bdf8'
}

const EMPTY_WINDOW_STATE: MiniPlayerWindowState = {
  isOpen: true,
  alwaysOnTop: true,
  visualizerMode: 'spectrum'
}

type MiniLayoutMode = 'tiny' | 'compact' | 'wide' | 'hero'

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function clampTime(value: number, duration: number): number {
  if (!Number.isFinite(value)) return 0
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.max(0, Math.min(duration, value))
}

function resolveLayoutMode(width: number, height: number): MiniLayoutMode {
  const isUltraNarrow = width <= 340
  const isShortStrip = height <= 150
  const isSmallFootprint = width <= 420 && height <= 220

  if (isUltraNarrow || isShortStrip || isSmallFootprint) return 'tiny'
  if (width >= 460 && height >= 320) return 'hero'
  if (width >= 620 && height >= 170) return 'wide'
  return 'compact'
}

const MINI_VISUALIZER_MODE_ORDER: MiniPlayerVisualizerMode[] = ['off', 'oscilloscope', 'spectrum']

const MINI_VISUALIZER_MODE_LABELS: Record<MiniPlayerVisualizerMode, string> = {
  off: 'Off',
  oscilloscope: 'Oscilloscope',
  spectrum: 'Spectrum'
}

function nextMiniVisualizerMode(current: MiniPlayerVisualizerMode): MiniPlayerVisualizerMode {
  const currentIndex = MINI_VISUALIZER_MODE_ORDER.indexOf(current)
  if (currentIndex === -1) return 'off'
  const nextIndex = (currentIndex + 1) % MINI_VISUALIZER_MODE_ORDER.length
  return MINI_VISUALIZER_MODE_ORDER[nextIndex] ?? 'off'
}

export default function MiniPlayerApp() {
  const rootRef = useRef<HTMLDivElement>(null)
  const [snapshot, setSnapshot] = useState<MiniPlayerSnapshot>(EMPTY_SNAPSHOT)
  const [windowState, setWindowState] = useState<MiniPlayerWindowState>(EMPTY_WINDOW_STATE)
  const [isScrubbing, setIsScrubbing] = useState(false)
  const [scrubTime, setScrubTime] = useState(0)
  const [layoutMode, setLayoutMode] = useState<MiniLayoutMode>('compact')
  const [activeBackdropArtwork, setActiveBackdropArtwork] = useState<string | null>(null)
  const [previousBackdropArtwork, setPreviousBackdropArtwork] = useState<string | null>(null)
  const [isBackdropCrossfading, setIsBackdropCrossfading] = useState(false)
  const backdropCrossfadeTimeoutRef = useRef<number | null>(null)
  const activeBackdropRef = useRef<string | null>(null)

  useEffect(() => {
    let isMounted = true

    void window.electronAPI.miniPlayer.getSnapshot().then((latest) => {
      if (!isMounted || !latest) return
      setSnapshot(latest)
      setScrubTime(latest.currentTime)
    })

    void window.electronAPI.miniPlayer.getWindowState().then((state) => {
      if (!isMounted) return
      setWindowState(state)
    })

    const unsubSnapshot = window.electronAPI.miniPlayer.onSnapshot((next) => {
      setSnapshot(next)
    })
    const unsubWindowState = window.electronAPI.miniPlayer.onWindowState((next) => {
      setWindowState(next)
    })

    return () => {
      isMounted = false
      unsubSnapshot()
      unsubWindowState()
    }
  }, [])

  useEffect(() => {
    const target = rootRef.current
    if (!target) return

    const updateLayoutFromRect = (width: number, height: number) => {
      setLayoutMode(resolveLayoutMode(width, height))
    }

    const initialRect = target.getBoundingClientRect()
    updateLayoutFromRect(initialRect.width, initialRect.height)

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      updateLayoutFromRect(entry.contentRect.width, entry.contentRect.height)
    })
    observer.observe(target)

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!isScrubbing) {
      setScrubTime(snapshot.currentTime)
    }
  }, [snapshot.currentTime, isScrubbing])

  useEffect(() => {
    return () => {
      if (backdropCrossfadeTimeoutRef.current !== null) {
        window.clearTimeout(backdropCrossfadeTimeoutRef.current)
        backdropCrossfadeTimeoutRef.current = null
      }
    }
  }, [])

  const track = snapshot.currentTrack
  const hasTrack = Boolean(track)
  const isPlaying = snapshot.playbackState === 'playing'
  const isLoading = snapshot.playbackState === 'loading'
  const backdropArtwork = track?.artworkData ?? null
  const safeDuration = Number.isFinite(snapshot.duration) ? Math.max(0, snapshot.duration) : 0
  const currentDisplayTime = isScrubbing ? scrubTime : snapshot.currentTime
  const clampedDisplayTime = clampTime(currentDisplayTime, safeDuration)
  const remainingTime = Math.max(0, safeDuration - clampedDisplayTime)
  const seekProgress = safeDuration > 0 ? (clampedDisplayTime / safeDuration) * 100 : 0
  const seekStyle = { '--seek-progress': `${Math.max(0, Math.min(100, seekProgress))}%` } as CSSProperties
  const showSeek = layoutMode === 'wide' || layoutMode === 'hero'
  const showContextLine = layoutMode === 'hero'
  const showPreviousButton = layoutMode !== 'tiny'
  const visualizerMode = windowState.visualizerMode
  const nextVisualizerMode = nextMiniVisualizerMode(visualizerMode)
  const visualizerModeLabel = MINI_VISUALIZER_MODE_LABELS[visualizerMode]
  const nextVisualizerModeLabel = MINI_VISUALIZER_MODE_LABELS[nextVisualizerMode]
  const secondaryLabel = (snapshot.outputDeviceLabel?.trim() || track?.artist || 'No output selected')
  const contextLine = hasTrack
    ? [track?.artist, track?.album].filter((value): value is string => Boolean(value && value.trim())).join(' • ')
    : ''

  useEffect(() => {
    if (backdropCrossfadeTimeoutRef.current !== null) {
      window.clearTimeout(backdropCrossfadeTimeoutRef.current)
      backdropCrossfadeTimeoutRef.current = null
    }

    if (!backdropArtwork) {
      activeBackdropRef.current = null
      setActiveBackdropArtwork(null)
      setPreviousBackdropArtwork(null)
      setIsBackdropCrossfading(false)
      return
    }

    if (!activeBackdropRef.current) {
      activeBackdropRef.current = backdropArtwork
      setActiveBackdropArtwork(backdropArtwork)
      setPreviousBackdropArtwork(null)
      setIsBackdropCrossfading(false)
      return
    }

    if (activeBackdropRef.current === backdropArtwork) return

    setPreviousBackdropArtwork(activeBackdropRef.current)
    setActiveBackdropArtwork(backdropArtwork)
    activeBackdropRef.current = backdropArtwork
    setIsBackdropCrossfading(true)

    backdropCrossfadeTimeoutRef.current = window.setTimeout(() => {
      setPreviousBackdropArtwork(null)
      setIsBackdropCrossfading(false)
      backdropCrossfadeTimeoutRef.current = null
    }, 540)
  }, [backdropArtwork])

  const handleSeekCommit = () => {
    if (safeDuration <= 0) return
    window.electronAPI.miniPlayer.sendCommand({
      type: 'seek',
      time: clampTime(scrubTime, safeDuration)
    })
  }

  const handleCycleVisualizerMode = () => {
    void window.electronAPI.miniPlayer.setVisualizerMode(nextVisualizerMode).then(setWindowState)
  }

  return (
    <div ref={rootRef} className={`mini-player-root mini-player-mode-${layoutMode}`}>
      <div className="mini-player-backdrop" aria-hidden="true">
        {previousBackdropArtwork && (
          <div className={`mini-player-backdrop-layer mini-player-backdrop-layer-previous ${isBackdropCrossfading ? 'is-fading' : ''}`}>
            <img className="mini-player-backdrop-image" src={previousBackdropArtwork} alt="" />
          </div>
        )}

        <div className={`mini-player-backdrop-layer mini-player-backdrop-layer-current ${isBackdropCrossfading ? 'is-entering' : ''}`}>
          {activeBackdropArtwork ? (
            <img className="mini-player-backdrop-image" src={activeBackdropArtwork} alt="" />
          ) : (
            <div className="mini-player-backdrop-fallback" />
          )}
        </div>

        <MiniPlayerBackdropVisualizer
          mode={visualizerMode}
          lineColor={snapshot.visualizerLineColor}
          isIdle={!track || !isPlaying}
          artworkDataUrl={activeBackdropArtwork ?? backdropArtwork}
          layoutMode={layoutMode}
        />

        <div className="mini-player-backdrop-colorwash" />
        <div className="mini-player-backdrop-scrim" />
      </div>

      <div className="mini-player-shell">
        <header className="mini-player-header">
          <div className="mini-player-drag">ASTRA MINI</div>
          <div className="mini-player-header-controls">
            <button
              className={`mini-header-btn ${windowState.alwaysOnTop ? 'active' : ''}`}
              title={windowState.alwaysOnTop ? 'Unpin mini player' : 'Pin mini player'}
              aria-label={windowState.alwaysOnTop ? 'Unpin mini player' : 'Pin mini player'}
              onClick={() => void window.electronAPI.miniPlayer.toggleAlwaysOnTop().then(setWindowState)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="M14 3a1 1 0 0 0-1 1v2H8a1 1 0 0 0-.8 1.6L10 11v3.27l-1.6 3.19A1 1 0 0 0 9.3 19h5.4a1 1 0 0 0 .9-1.54L14 14.27V11l2.8-3.4A1 1 0 0 0 16 6h-5V4a1 1 0 0 0-1-1h4z" />
              </svg>
            </button>
            <button
              className={`mini-header-btn ${visualizerMode !== 'off' ? 'active' : ''}`}
              title={`Mini visualizer: ${visualizerModeLabel}. Click to switch to ${nextVisualizerModeLabel}`}
              aria-label={`Mini visualizer: ${visualizerModeLabel}. Click to switch to ${nextVisualizerModeLabel}`}
              onClick={handleCycleVisualizerMode}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                {visualizerMode === 'spectrum' ? (
                  <>
                    <path d="M4 18V12" />
                    <path d="M8 18V9" />
                    <path d="M12 18V6" />
                    <path d="M16 18V10" />
                    <path d="M20 18V13" />
                  </>
                ) : visualizerMode === 'oscilloscope' ? (
                  <path d="M3 12h3l2-4 4 8 3-6 2 2h4" />
                ) : (
                  <>
                    <circle cx="12" cy="12" r="7" />
                    <path d="M7 17 17 7" />
                  </>
                )}
              </svg>
            </button>
            <button
              className="mini-header-btn"
              title="Close mini player"
              aria-label="Close mini player"
              onClick={() => void window.electronAPI.miniPlayer.close()}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </header>

        <main className="mini-player-body">
          <div className="mini-player-art-panel">
            <div className="mini-player-artwork">
              {track?.artworkData ? (
                <img src={track.artworkData} alt="Album art" />
              ) : (
                <div className="mini-player-artwork-placeholder">&#9835;</div>
              )}
            </div>
          </div>

          <div className="mini-player-main">
            <div className="mini-player-meta">
              <div className="mini-player-title">{track?.title ?? 'No track playing'}</div>
              <div className="mini-player-secondary-line">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v2.05c.9.57 1.5 1.57 1.5 2.98s-.6 2.41-1.5 2.98v2.05c1.48-.73 2.5-2.25 2.5-4.03z" />
                </svg>
                <span>{secondaryLabel}</span>
              </div>
              {showContextLine && contextLine && (
                <div className="mini-player-context-line">{contextLine}</div>
              )}
            </div>

            <div className="mini-player-controls" data-mode={layoutMode}>
              {showPreviousButton && (
                <button
                  className="mini-control-btn"
                  onClick={() => window.electronAPI.miniPlayer.sendCommand({ type: 'playPrevious' })}
                  disabled={snapshot.queueLength === 0}
                  aria-label="Previous"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="6" y1="5" x2="6" y2="19" />
                    <polygon points="18,5 8,12 18,19" />
                  </svg>
                </button>
              )}

              <button
                className="mini-control-btn mini-control-btn-play"
                onClick={() => window.electronAPI.miniPlayer.sendCommand({ type: 'togglePlay' })}
                disabled={!hasTrack || isLoading}
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isLoading ? (
                  <div className="mini-loading-spinner" />
                ) : isPlaying ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              <button
                className="mini-control-btn"
                onClick={() => window.electronAPI.miniPlayer.sendCommand({ type: 'playNext' })}
                disabled={snapshot.queueLength === 0}
                aria-label="Next"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="5" x2="18" y2="19" />
                  <polygon points="6,5 16,12 6,19" />
                </svg>
              </button>

              <button
                className={`mini-favorite-btn ${track?.isFavorite ? 'active' : ''}`}
                onClick={() => {
                  if (!track) return
                  window.electronAPI.miniPlayer.sendCommand({ type: 'toggleFavorite', trackPath: track.path })
                }}
                disabled={!track}
                aria-label={track?.isFavorite ? 'Remove favorite' : 'Add favorite'}
                title={track?.isFavorite ? 'Favorited' : 'Favorite'}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12.5 9.2 16.7 19 7" />
                </svg>
              </button>
            </div>

            {showSeek && (
              <div className="mini-player-seek-wrap">
                <div className="mini-player-time-row">
                  <span>{formatTime(clampedDisplayTime)}</span>
                  <span>-{formatTime(remainingTime)}</span>
                </div>
                <input
                  className="mini-player-seek"
                  style={seekStyle}
                  type="range"
                  min={0}
                  max={safeDuration > 0 ? safeDuration : 1}
                  step={0.01}
                  value={safeDuration > 0 ? clampTime(scrubTime, safeDuration) : 0}
                  onPointerDown={() => setIsScrubbing(true)}
                  onPointerUp={() => {
                    setIsScrubbing(false)
                    handleSeekCommit()
                  }}
                  onPointerCancel={() => setIsScrubbing(false)}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    setScrubTime(Number.isFinite(next) ? next : 0)
                  }}
                  onKeyUp={(event) => {
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                      handleSeekCommit()
                    }
                  }}
                  disabled={safeDuration <= 0 || !hasTrack}
                  aria-label="Seek"
                />
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
