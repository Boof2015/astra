import { useEffect, useState, useRef, useCallback } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import { useEQStore } from '../../stores/eqStore'
import { useLibraryStore } from '../../stores/libraryStore'
import { audioEngine } from '../../audio/AudioEngine'
import AlbumArtwork from '../library/AlbumArtwork'
import WaveformSeekBar from '../player/WaveformSeekBar'
import EQPopover from '../eq/EQPopover'
import EQResponsePreview from '../eq/EQResponsePreview'
import type { MiniPlayerWindowState } from '../../../types/miniPlayer'

export default function TransportBar() {
  const {
    currentTrack,
    playbackState,
    currentTime,
    duration,
    volume,
    isMuted,
    queue,
    togglePlay,
    seek,
    setVolume,
    toggleMute,
    shuffle,
    repeat,
    playNext,
    playPrevious,
    toggleShuffle,
    toggleRepeat,
    waveformData,
  } = usePlayerStore()

  const { showQueue, toggleQueue, showInfoSidebar, toggleInfoSidebar, setFullscreen } = useUIStore()
  const eqEnabled = useEQStore((s) => s.enabled)
  const favorites = useLibraryStore((s) => s.favorites)
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite)

  const isFavorite = currentTrack ? favorites.has(currentTrack.path) : false

  const [showEQPopover, setShowEQPopover] = useState(false)
  const [miniWindowState, setMiniWindowState] = useState<MiniPlayerWindowState>({
    isOpen: false,
    alwaysOnTop: true
  })

  // Marquee scroll for long titles
  const titleOuterRef = useRef<HTMLDivElement>(null)
  const titleInnerRef = useRef<HTMLSpanElement>(null)
  const [titleOverflows, setTitleOverflows] = useState(false)

  const checkTitleOverflow = useCallback(() => {
    const outer = titleOuterRef.current
    const inner = titleInnerRef.current
    if (!outer || !inner) return
    const overflows = inner.scrollWidth > outer.clientWidth
    setTitleOverflows(overflows)
    if (overflows) {
      outer.style.setProperty('--marquee-offset', `${outer.clientWidth - inner.scrollWidth}px`)
    }
  }, [])

  useEffect(() => {
    checkTitleOverflow()
  }, [currentTrack, checkTitleOverflow])

  useEffect(() => {
    const outer = titleOuterRef.current
    if (!outer) return
    const ro = new ResizeObserver(checkTitleOverflow)
    ro.observe(outer)
    return () => ro.disconnect()
  }, [checkTitleOverflow])

  useEffect(() => {
    let isMounted = true

    void window.electronAPI.miniPlayer.getWindowState().then((state) => {
      if (!isMounted) return
      setMiniWindowState(state)
    })

    const unsubscribe = window.electronAPI.miniPlayer.onWindowState((state) => {
      setMiniWindowState(state)
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [])

  const formatTime = (seconds: number): string => {
    if (!isFinite(seconds) || isNaN(seconds)) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const getPercentFromClientX = (clientX: number, element: HTMLDivElement): number => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0) return 0
    const percent = (clientX - rect.left) / rect.width
    return Math.max(0, Math.min(1, percent))
  }

  const handleVolumePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setVolume(getPercentFromClientX(e.clientX, e.currentTarget))
  }

  const handleVolumePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    setVolume(getPercentFromClientX(e.clientX, e.currentTarget))
  }

  const releaseVolumePointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const isPlaying = playbackState === 'playing'
  const isLoadingTrack = playbackState === 'loading'
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0
  const remaining = duration > 0 ? duration - currentTime : 0
  const resolvedChannelCount = currentTrack?.channels ?? null
  const isMultichannel = (resolvedChannelCount ?? 0) > 2
  const currentCodecProfile = currentTrack?.codecProfile?.toLowerCase() ?? ''
  const currentCodec = currentTrack?.codec?.toLowerCase() ?? ''
  const showAtmosBadge = Boolean(
    currentTrack?.isAtmosJoc ||
    currentCodecProfile.includes('atmos') ||
    currentCodecProfile.includes('joc') ||
    currentCodec.includes('atmos') ||
    currentCodec.includes('joc')
  )
  const normalizationReadout = (() => {
    if (!currentTrack) {
      return { value: '\u2014', dim: true }
    }
    if (!audioEngine.normalizationEnabled) {
      return { value: 'OFF', dim: true }
    }

    const gainDb = audioEngine.getNormalizationGainDb()
    const rounded = Math.round(gainDb * 10) / 10
    const displayDb = Math.abs(rounded) < 0.05 ? 0 : rounded
    const sign = displayDb > 0 ? '+' : ''
    return { value: `${sign}${displayDb.toFixed(1)}dB`, dim: false }
  })()

  return (
    <div className="transport-bar">
      {/* Left: Track info */}
      <div className="transport-info">
        <div className="transport-artwork" onClick={() => setFullscreen(true)}>
          {currentTrack?.artworkHash ? (
            <AlbumArtwork hash={currentTrack.artworkHash} alt="Album art" />
          ) : currentTrack?.artworkData ? (
            <img src={currentTrack.artworkData} alt="Album art" />
          ) : (
            <div className="artwork-placeholder">&#9835;</div>
          )}
          <div className="transport-artwork-overlay">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
            </svg>
          </div>
        </div>
        <div className="transport-text">
          <div
            ref={titleOuterRef}
            className={`now-playing-title${titleOverflows ? ' marquee-active' : ''}`}
          >
            <span ref={titleInnerRef} className="now-playing-title-inner">
              {currentTrack?.title ?? 'No track playing'}
            </span>
          </div>
          <div className="transport-subline">
            <div className="now-playing-artist">
              {currentTrack?.artist ?? '\u2014'}
            </div>
            {(showAtmosBadge || isMultichannel) && (
              <div className="transport-audio-badges">
              {showAtmosBadge && (
                  <span
                    className="transport-audio-badge transport-audio-badge-atmos"
                    title="Atmos metadata detected"
                  >
                    ATM
                  </span>
                )}
                {isMultichannel && (
                  <span
                    className="transport-audio-badge transport-audio-badge-ch"
                    title={`${resolvedChannelCount} channels`}
                  >
                    <span>{resolvedChannelCount}CH</span>
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <button
          className={`transport-fav-btn ${isFavorite ? 'active' : ''}`}
          title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={() => currentTrack && toggleFavorite(currentTrack.path)}
          disabled={!currentTrack}
        >
          {isFavorite ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
          )}
        </button>
      </div>

      {/* Center: Controls + Waveform + Volume — single row */}
      <div className="transport-center">
        <div className="transport-controls">
          <button
            className={`control-btn control-btn-shuffle ${shuffle ? 'active' : ''}`}
            aria-label="Shuffle"
            onClick={toggleShuffle}
            title={shuffle ? 'Shuffle on' : 'Shuffle off'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 3h5v5" />
              <path d="M4 20 21 3" />
              <path d="M21 16v5h-5" />
              <path d="M15 15 21 21" />
              <path d="M4 4 9 9" />
            </svg>
          </button>
          <button
            className="control-btn control-btn-skip"
            aria-label="Previous"
            onClick={playPrevious}
            disabled={queue.length === 0}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="5" x2="6" y2="19" />
              <polygon points="18,5 8,12 18,19" />
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
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
            )}
          </button>
          <button
            className="control-btn control-btn-skip"
            aria-label="Next"
            onClick={playNext}
            disabled={queue.length === 0}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="5" x2="18" y2="19" />
              <polygon points="6,5 16,12 6,19" />
            </svg>
          </button>
          <button
            className={`control-btn control-btn-repeat ${repeat !== 'none' ? 'active' : ''}`}
            aria-label="Repeat"
            onClick={toggleRepeat}
            title={repeat === 'none' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one'}
          >
            {repeat === 'one' ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7h13a4 4 0 0 1 4 4v1" />
                <polyline points="17 4 20 7 17 10" />
                <path d="M21 17H8a4 4 0 0 1-4-4v-1" />
                <polyline points="7 20 4 17 7 14" />
                <path d="M12 8v8" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7h13a4 4 0 0 1 4 4v1" />
                <polyline points="17 4 20 7 17 10" />
                <path d="M21 17H8a4 4 0 0 1-4-4v-1" />
                <polyline points="7 20 4 17 7 14" />
              </svg>
            )}
          </button>
        </div>

        {/* Waveform with floating time labels */}
        <div className="transport-waveform-wrap">
          <span className="waveform-time waveform-time-current">{formatTime(currentTime)}</span>
          <span className="waveform-time waveform-time-remaining">-{formatTime(remaining)}</span>
          <WaveformSeekBar
            waveformData={waveformData}
            progress={progress}
            duration={duration}
            currentTime={currentTime}
            onSeek={(time) => void seek(time)}
          />
        </div>

        {/* Volume */}
        <div className="transport-volume">
          <button
            className="volume-btn"
            onClick={toggleMute}
            aria-label={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted || volume === 0 ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
              </svg>
            ) : volume < 0.5 ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 9v6h4l5 5V4l-5 5H7z"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
              </svg>
            )}
          </button>
          <div
            className="volume-slider"
            onPointerDown={handleVolumePointerDown}
            onPointerMove={handleVolumePointerMove}
            onPointerUp={releaseVolumePointer}
            onPointerCancel={releaseVolumePointer}
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
          <span className="volume-label">{Math.round(isMuted ? 0 : volume * 100)}</span>
        </div>
      </div>

      {/* Right: EQ + Queue/Info + File readout */}
      <div className="transport-right">
        <button
          className={`transport-mini-btn ${miniWindowState.isOpen ? 'active' : ''} ${miniWindowState.alwaysOnTop ? 'pinned' : ''}`}
          onClick={() => void window.electronAPI.miniPlayer.open()}
          title={miniWindowState.alwaysOnTop ? 'Open mini player (pinned)' : 'Open mini player'}
          aria-label="Open mini player"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
            <line x1="7" y1="8.5" x2="17" y2="8.5" />
            <line x1="7" y1="12.5" x2="14" y2="12.5" />
          </svg>
        </button>

        {/* EQ toggle button with mini curve */}
        <button
          className={`transport-eq-btn ${showEQPopover ? 'active' : ''} ${eqEnabled ? 'enabled' : ''}`}
          onClick={() => setShowEQPopover(!showEQPopover)}
          title="Toggle equalizer"
        >
          <span className="transport-eq-label">EQ</span>
          <EQResponsePreview className="transport-eq-curve" width={80} height={30} showFill={false} />
        </button>

        {/* Queue + Info stacked vertically */}
        <div className="transport-qi-stack">
          <button
            className={`transport-qi-btn ${showQueue ? 'active' : ''}`}
            onClick={toggleQueue}
            title="Toggle queue"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
            </svg>
          </button>
          <button
            className={`transport-qi-btn ${showInfoSidebar ? 'active' : ''}`}
            onClick={toggleInfoSidebar}
            title="Toggle track info"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
            </svg>
          </button>
        </div>

        {/* File info readout — 2x2 grid */}
        <div className="transport-file-readout">
          <div className="readout-cell">
            <span className="readout-label">FMT</span>
            <span className="readout-value">{currentTrack?.format?.toUpperCase() ?? '—'}</span>
          </div>
          <div className="readout-cell">
            <span className="readout-label">BIT</span>
            <span className="readout-value">{currentTrack?.bitDepth ?? '—'}</span>
          </div>
          <div className="readout-cell">
            <span className="readout-label">KHZ</span>
            <span className="readout-value">{currentTrack?.sampleRate ? (currentTrack.sampleRate / 1000).toFixed(1) : '—'}</span>
          </div>
          <div className="readout-cell">
            <span className="readout-label">NORM</span>
            <span className={`readout-value${normalizationReadout.dim ? ' readout-value-dim' : ''}`}>
              {normalizationReadout.value}
            </span>
          </div>
        </div>
      </div>

      {/* EQ Popover */}
      {showEQPopover && (
        <EQPopover onClose={() => setShowEQPopover(false)} />
      )}
    </div>
  )
}
