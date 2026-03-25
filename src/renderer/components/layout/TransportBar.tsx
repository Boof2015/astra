import { useEffect, useState, useRef, useCallback } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import { useEQStore } from '../../stores/eqStore'
import { useLibraryStore } from '../../stores/libraryStore'
import {
  BIT_PERFECT_DSP_DISABLED_MESSAGE,
  resolveOutputDeviceLabel,
  useAudioSettingsStore
} from '../../stores/audioSettingsStore'
import { useOpenArtistInLibrary } from '../../hooks/useOpenArtistInLibrary'
import { usePlaybackClock } from '../../hooks/usePlaybackClock'
import { audioEngine } from '../../audio/AudioEngine'
import AlbumArtwork from '../library/AlbumArtwork'
import ArtistNameLinks from '../library/ArtistNameLinks'
import WaveformSeekBar from '../player/WaveformSeekBar'
import EQPopover from '../eq/EQPopover'
import EQResponsePreview from '../eq/EQResponsePreview'
import AudioPipelineShelf from './AudioPipelineShelf'
import TransportLyricsShelf from './TransportLyricsShelf'
import type { MiniPlayerWindowState } from '../../../types/miniPlayer'

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function TransportWaveformSection({
  loadingLabel,
  loadingPercent
}: {
  loadingLabel: string | null
  loadingPercent: number | null
}) {
  const waveformData = usePlayerStore((s) => s.waveformData)
  const currentTime = usePlaybackClock()
  const duration = usePlayerStore((s) => s.duration)
  const seek = usePlayerStore((s) => s.seek)
  const effectiveDelayMs = useAudioSettingsStore((s) => s.effectiveDelayMs)
  const waveformTimeDisplayMode = useUIStore((s) => s.waveformTimeDisplayMode)
  const toggleWaveformTimeDisplayMode = useUIStore((s) => s.toggleWaveformTimeDisplayMode)

  const effectiveDelaySec = Math.max(0, effectiveDelayMs / 1000)
  const compensatedTime = duration > 0
    ? Math.max(0, Math.min(duration, currentTime - effectiveDelaySec))
    : 0
  const progress = duration > 0 ? (compensatedTime / duration) * 100 : 0
  const remaining = duration > 0 ? duration - compensatedTime : 0
  const showingRemainingTime = waveformTimeDisplayMode === 'remaining'
  const rightTimeLabel = showingRemainingTime ? `-${formatTime(remaining)}` : formatTime(duration)
  const rightTimeToggleLabel = showingRemainingTime ? 'Show track duration' : 'Show remaining time'

  return (
    <div className="transport-waveform-wrap">
      <span className="waveform-time waveform-time-current">{formatTime(compensatedTime)}</span>
      <button
        type="button"
        className="waveform-time waveform-time-remaining waveform-time-toggle"
        onClick={toggleWaveformTimeDisplayMode}
        aria-label={rightTimeToggleLabel}
        title={rightTimeToggleLabel}
      >
        {rightTimeLabel}
      </button>
      <WaveformSeekBar
        waveformData={waveformData}
        progress={progress}
        duration={duration}
        currentTime={compensatedTime}
        onSeek={(time) => {
          const rawSeekTime = Math.max(0, Math.min(duration, time + effectiveDelaySec))
          void seek(rawSeekTime)
        }}
      />
      {loadingLabel && (
        <div className="transport-loading-hint" role="status" aria-live="polite">
          <span className="transport-loading-hint-label">{loadingLabel}</span>
          <span
            className={`transport-loading-hint-bar ${loadingPercent === null ? 'indeterminate' : ''}`}
            aria-hidden="true"
          >
            <span
              className="transport-loading-hint-fill"
              style={loadingPercent === null ? undefined : { width: `${Math.round(loadingPercent * 100)}%` }}
            />
          </span>
        </div>
      )}
    </div>
  )
}

export default function TransportBar() {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const playbackState = usePlayerStore((s) => s.playbackState)
  const volume = usePlayerStore((s) => s.volume)
  const isMuted = usePlayerStore((s) => s.isMuted)
  const togglePlay = usePlayerStore((s) => s.togglePlay)
  const setVolume = usePlayerStore((s) => s.setVolume)
  const toggleMute = usePlayerStore((s) => s.toggleMute)
  const shuffle = usePlayerStore((s) => s.shuffle)
  const repeat = usePlayerStore((s) => s.repeat)
  const playNext = usePlayerStore((s) => s.playNext)
  const playPrevious = usePlayerStore((s) => s.playPrevious)
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle)
  const toggleRepeat = usePlayerStore((s) => s.toggleRepeat)
  const remoteLoadProgress = usePlayerStore((s) => s.remoteLoadProgress)
  const resolvedQueueLength = usePlayerStore((s) => s.getResolvedQueueLength())

  const {
    showQueue,
    toggleQueue,
    showInfoSidebar,
    toggleInfoSidebar,
    showPipelineShelf,
    showLyricsShelf,
    togglePipelineShelf,
    toggleLyricsShelf,
    setFullscreen
  } = useUIStore()
  const eqEnabled = useEQStore((s) => s.enabled)
  const favorites = useLibraryStore((s) => s.favorites)
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite)
  const openArtistInLibrary = useOpenArtistInLibrary()
  const selectedOutputDeviceId = useAudioSettingsStore((s) => s.selectedDeviceId)
  const availableOutputDevices = useAudioSettingsStore((s) => s.availableDevices)
  const normalizationEnabled = useAudioSettingsStore((s) => s.normalizationEnabled)
  const replayGainScanEnabled = useAudioSettingsStore((s) => s.replayGainScanEnabled)
  const playbackOutputMode = useAudioSettingsStore((s) => s.playbackOutputMode)
  const nativeAudioCapabilities = useAudioSettingsStore((s) => s.nativeAudioCapabilities)
  const playbackModeStatusMessage = useAudioSettingsStore((s) => s.playbackModeStatusMessage)

  const isAssociationTrack = currentTrack?.origin === 'associated-external'
  const isFavorite = currentTrack && !isAssociationTrack ? favorites.has(currentTrack.path) : false

  const [showEQPopover, setShowEQPopover] = useState(false)
  const [miniWindowState, setMiniWindowState] = useState<MiniPlayerWindowState>({
    isOpen: false,
    alwaysOnTop: true,
    visualizerMode: 'spectrum'
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

  useEffect(() => {
    if (!showLyricsShelf) return
    if (!showEQPopover) return
    setShowEQPopover(false)
  }, [showEQPopover, showLyricsShelf])

  useEffect(() => {
    if (playbackOutputMode !== 'bitperfect') return
    if (!showEQPopover) return
    setShowEQPopover(false)
  }, [playbackOutputMode, showEQPopover])

  const getPercentFromClientX = (clientX: number, element: HTMLDivElement): number => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0) return 0
    const percent = (clientX - rect.left) / rect.width
    return Math.max(0, Math.min(1, percent))
  }

  const bitPerfectModeActive = playbackOutputMode === 'bitperfect'
  const disabledControlMessage = playbackModeStatusMessage ?? BIT_PERFECT_DSP_DISABLED_MESSAGE
  const volumeControlDisabled = bitPerfectModeActive
  const eqControlDisabled = bitPerfectModeActive

  const handleVolumePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (volumeControlDisabled) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setVolume(getPercentFromClientX(e.clientX, e.currentTarget))
  }

  const handleVolumePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (volumeControlDisabled) return
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
  const activeRemoteLoadProgress = isLoadingTrack
    && currentTrack
    && remoteLoadProgress
    && remoteLoadProgress.path === currentTrack.path
    ? remoteLoadProgress
    : null
  const loadingPercent = typeof activeRemoteLoadProgress?.percent === 'number'
    ? Math.max(0, Math.min(1, activeRemoteLoadProgress.percent))
    : null
  const loadingLabel = (() => {
    if (!isLoadingTrack || !currentTrack) return null
    if (!currentTrack.sourceType || currentTrack.sourceType === 'local') return null
    if (loadingPercent !== null) {
      return `Buffering ${Math.round(loadingPercent * 100)}% • ${activeRemoteLoadProgress?.chunkCount ?? 0} chunks`
    }
    if ((activeRemoteLoadProgress?.chunkCount ?? 0) > 0) {
      return `Buffering ${activeRemoteLoadProgress!.chunkCount} chunks`
    }
    return 'Buffering remote track...'
  })()
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
  const outputDeviceLabel = (() => {
    return resolveOutputDeviceLabel(selectedOutputDeviceId, availableOutputDevices, {
      defaultRouteFallbackLabel: 'System Default Output',
      selectedFallbackLabel: 'Selected Output'
    }).label
  })()
  const bitPerfectStatusLabel = (() => {
    if (!bitPerfectModeActive) return null

    const backendLabel = (() => {
      switch (nativeAudioCapabilities.activeBackend) {
        case 'coreaudio':
          return 'CoreAudio'
        case 'wasapi-exclusive':
          return 'WASAPI Exclusive'
        case 'alsa-hw':
          return 'ALSA hw'
        default:
          return 'Native Output'
      }
    })()

    const sampleRate = nativeAudioCapabilities.activeSampleRate ?? audioEngine.getSampleRate()
    const sampleRateLabel = sampleRate > 0 ? `${(sampleRate / 1000).toFixed(1)} kHz` : 'native rate'
    const exclusivityLabel = nativeAudioCapabilities.activeDeviceExclusive ? 'Exclusive' : 'Direct'
    return `${backendLabel} • ${sampleRateLabel} • ${exclusivityLabel}`
  })()
  const normalizationReadout = (() => {
    if (bitPerfectModeActive) {
      return { value: 'BYP', dim: false, accent: false, off: true }
    }

    const gainMode = audioEngine.getNormalizationMode()
    if (!currentTrack) {
      return { value: '\u2014', dim: true, accent: false, off: false }
    }
    if (!normalizationEnabled) {
      return { value: 'OFF', dim: false, accent: false, off: true }
    }

    const gainDb = audioEngine.getNormalizationGainDb()
    const rounded = Math.round(gainDb * 10) / 10
    const displayDb = Math.abs(rounded) < 0.05 ? 0 : rounded
    const sign = displayDb > 0 ? '+' : ''
    return {
      value: `${sign}${displayDb.toFixed(1)}dB`,
      dim: false,
      accent: replayGainScanEnabled && gainMode === 'replaygain',
      off: false
    }
  })()

  const transportBarClassName = [
    'transport-bar',
    showPipelineShelf ? 'transport-has-pipeline-open' : '',
    showLyricsShelf ? 'transport-has-lyrics-open' : ''
  ].join(' ').trim()

  return (
    <div className={transportBarClassName}>
      <button
        className={`pipeline-shelf-toggle${showPipelineShelf ? ' pipeline-shelf-toggle-open' : ''}`}
        onClick={togglePipelineShelf}
        title={showPipelineShelf ? 'Hide audio pipeline' : 'Show audio pipeline'}
        aria-label="Toggle audio pipeline shelf"
      >
        <svg width="14" height="8" viewBox="0 0 14 8" fill="none">
          <path
            d="M1 7l6-5 6 5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <AudioPipelineShelf />
      <TransportLyricsShelf />

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
              {currentTrack?.artist?.trim()
                ? (
                  <ArtistNameLinks
                    artistText={currentTrack.artist}
                    onArtistClick={openArtistInLibrary}
                    className="now-playing-artist-links"
                    linkClassName="artist-name-link-inline"
                  />
                )
                : '\u2014'}
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
          <div className="transport-output-line" title={outputDeviceLabel}>
            <span className="transport-output-line-prefix">OUT</span>
            <span className="transport-output-line-value">{outputDeviceLabel}</span>
          </div>
          {bitPerfectStatusLabel && (
            <div className="transport-output-line" title={disabledControlMessage}>
              <span className="transport-output-line-prefix">BP</span>
              <span className="transport-output-line-value">{bitPerfectStatusLabel}</span>
            </div>
          )}
        </div>
        <button
          className={`transport-fav-btn ${isFavorite ? 'active' : ''}`}
          title={isAssociationTrack
            ? 'Unavailable for files opened from your file explorer'
            : isFavorite
              ? 'Remove from favorites'
              : 'Add to favorites'}
          onClick={() => currentTrack && toggleFavorite(currentTrack.path)}
          disabled={!currentTrack || isAssociationTrack}
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
            disabled={resolvedQueueLength === 0}
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
            disabled={resolvedQueueLength === 0}
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
        <TransportWaveformSection loadingLabel={loadingLabel} loadingPercent={loadingPercent} />

        {/* Volume */}
        <div className="transport-volume">
          <button
            className="volume-btn"
            onClick={volumeControlDisabled ? undefined : toggleMute}
            aria-label={isMuted ? 'Unmute' : 'Mute'}
            title={volumeControlDisabled ? disabledControlMessage : (isMuted ? 'Unmute' : 'Mute')}
            disabled={volumeControlDisabled}
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
            className={`volume-slider${volumeControlDisabled ? ' disabled' : ''}`}
            onPointerDown={handleVolumePointerDown}
            onPointerMove={handleVolumePointerMove}
            onPointerUp={releaseVolumePointer}
            onPointerCancel={releaseVolumePointer}
            role="slider"
            aria-valuenow={volume * 100}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-disabled={volumeControlDisabled}
            title={volumeControlDisabled ? disabledControlMessage : 'Playback volume'}
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
        <div className="transport-mini-lyrics-stack">
          <button
            className={`transport-mini-btn transport-mini-btn-split-top ${miniWindowState.isOpen ? 'active' : ''} ${miniWindowState.alwaysOnTop ? 'pinned' : ''}`}
            onClick={() => void window.electronAPI.miniPlayer.open()}
            title="Open mini player"
            aria-label="Open mini player"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
              <line x1="7" y1="8.5" x2="17" y2="8.5" />
              <line x1="7" y1="12.5" x2="14" y2="12.5" />
            </svg>
          </button>
          <button
            className={`transport-lyrics-btn ${showLyricsShelf ? 'active' : ''}`}
            onClick={toggleLyricsShelf}
            title="Toggle lyrics shelf"
            aria-label="Toggle lyrics shelf"
            aria-pressed={showLyricsShelf}
            disabled={!currentTrack}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7h16" />
              <path d="M4 12h12" />
              <path d="M4 17h9" />
            </svg>
          </button>
        </div>

        {/* EQ toggle button with mini curve */}
        <button
          className={`transport-eq-btn ${showEQPopover ? 'active' : ''} ${eqEnabled ? 'enabled' : ''}${eqControlDisabled ? ' disabled' : ''}`}
          onClick={eqControlDisabled ? undefined : (() => setShowEQPopover(!showEQPopover))}
          title={eqControlDisabled ? disabledControlMessage : 'Toggle equalizer'}
          disabled={eqControlDisabled}
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
            <span
              className={`readout-value${normalizationReadout.dim ? ' readout-value-dim' : ''}${normalizationReadout.accent ? ' readout-value-replaygain' : ''}${normalizationReadout.off ? ' readout-value-off' : ''}`}
            >
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
