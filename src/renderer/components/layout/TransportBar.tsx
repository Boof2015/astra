import LocalizedText from '../i18n/LocalizedText'
import { translate } from '../../i18n'
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
import { useOpenAlbumInLibrary } from '../../hooks/useOpenAlbumInLibrary'
import { useJumpToNowPlaying } from '../../hooks/useJumpToNowPlaying'
import { usePlaybackClock } from '../../hooks/usePlaybackClock'
import { audioEngine } from '../../audio/AudioEngine'
import AlbumArtwork from '../library/AlbumArtwork'
import ArtistNameLinks from '../library/ArtistNameLinks'
import WaveformSeekBar from '../player/WaveformSeekBar'
import VolumeControl from '../player/VolumeControl'
import EQPopover from '../eq/EQPopover'
import { usePresence } from '../../hooks/usePresence'
import EQResponsePreview from '../eq/EQResponsePreview'
import AudioPipelineShelf from './AudioPipelineShelf'
import TransportLyricsShelf from './TransportLyricsShelf'
import { useLyricsPopoutStore } from '../../stores/lyricsPopoutStore'
import { useParallaxStore } from '../../stores/parallaxStore'
import { resolveTransportInfoLine } from '../../utils/transportInfoLine'
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
  const waveformBufferedRatio = usePlayerStore((s) => s.waveformBufferedRatio)
  const waveformAnalyzedRatio = usePlayerStore((s) => s.waveformAnalyzedRatio)
  const remoteBufferedSeconds = usePlayerStore((s) => s.remoteBufferedSeconds)
  // 30Hz keeps the waveform playhead visually smooth without re-rendering
  // the transport section at display refresh rate.
  const currentTime = usePlaybackClock(1 / 30)
  const duration = usePlayerStore((s) => s.duration)
  const seek = usePlayerStore((s) => s.seek)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
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
        bufferedRatio={waveformBufferedRatio}
        analyzedRatio={waveformAnalyzedRatio}
        seekableDuration={currentTrack?.sourceType && currentTrack.sourceType !== 'local' ? remoteBufferedSeconds : duration}
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
  const togglePlay = usePlayerStore((s) => s.togglePlay)
  const shuffle = usePlayerStore((s) => s.shuffle)
  const repeat = usePlayerStore((s) => s.repeat)
  const playNext = usePlayerStore((s) => s.playNext)
  const playPrevious = usePlayerStore((s) => s.playPrevious)
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle)
  const toggleRepeat = usePlayerStore((s) => s.toggleRepeat)
  const remoteLoadProgress = usePlayerStore((s) => s.remoteLoadProgress)
  const loadingStatus = usePlayerStore((s) => s.loadingStatus)
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
    closeLyricsShelf,
    transportInfoLineMode,
    setFullscreen
  } = useUIStore()
  const lyricsPopoutIsOpen = useLyricsPopoutStore((s) => s.windowState.isOpen)
  const eqEnabled = useEQStore((s) => s.enabled)
  const favorites = useLibraryStore((s) => s.favorites)
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite)
  const openArtistInLibrary = useOpenArtistInLibrary()
  const openAlbumInLibrary = useOpenAlbumInLibrary()
  const selectedOutputDeviceId = useAudioSettingsStore((s) => s.selectedDeviceId)
  const availableOutputDevices = useAudioSettingsStore((s) => s.availableDevices)
  const normalizationEnabled = useAudioSettingsStore((s) => s.normalizationEnabled)
  const replayGainScanEnabled = useAudioSettingsStore((s) => s.replayGainScanEnabled)
  const playbackOutputMode = useAudioSettingsStore((s) => s.playbackOutputMode)
  const nativeAudioCapabilities = useAudioSettingsStore((s) => s.nativeAudioCapabilities)
  const playbackModeStatusMessage = useAudioSettingsStore((s) => s.playbackModeStatusMessage)
  const parallaxSinkConnected = useParallaxStore((s) => Boolean(s.status?.sink.connected))
  const jumpToNowPlaying = useJumpToNowPlaying()

  const isAssociationTrack = currentTrack?.origin === 'associated-external'
  const isFavorite = currentTrack && !isAssociationTrack ? favorites.has(currentTrack.path) : false

  const [showEQPopover, setShowEQPopover] = useState(false)
  const eqPopoverPresence = usePresence(showEQPopover)
  const [miniWindowState, setMiniWindowState] = useState<MiniPlayerWindowState>({
    isOpen: false,
    alwaysOnTop: true,
    visualizerMode: 'spectrum'
  })

  // Marquee scroll for long titles
  const titleOuterRef = useRef<HTMLButtonElement>(null)
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
    if (playbackOutputMode !== 'bitperfect') return
    if (!showEQPopover) return
    setShowEQPopover(false)
  }, [playbackOutputMode, showEQPopover])

  const bitPerfectModeActive = playbackOutputMode === 'bitperfect'
  const disabledControlMessage = playbackModeStatusMessage ?? BIT_PERFECT_DSP_DISABLED_MESSAGE
  const eqControlDisabled = bitPerfectModeActive
  const transportControlsLocked = parallaxSinkConnected

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
    if (loadingStatus) return loadingStatus
    if (!activeRemoteLoadProgress) return null
    if (activeRemoteLoadProgress?.stage === 'streaming') {
      const readySeconds = Math.max(0, activeRemoteLoadProgress.bufferedSeconds)
      const readyLabel = formatTime(readySeconds)
      const streamingLabel = currentTrack.sourceType && currentTrack.sourceType !== 'local' ? 'Streaming' : 'Buffering'
      if (loadingPercent !== null) {
        return `${streamingLabel} • ${readyLabel} ready • ${Math.round(loadingPercent * 100)}% downloaded`
      }
      return `${streamingLabel} • ${readyLabel} ready`
    }
    if (loadingPercent !== null) {
      return `Buffering ${Math.round(loadingPercent * 100)}% • ${activeRemoteLoadProgress?.chunkCount ?? 0} chunks`
    }
    if ((activeRemoteLoadProgress?.chunkCount ?? 0) > 0) {
      return `Buffering ${activeRemoteLoadProgress!.chunkCount} chunks`
    }
    return currentTrack.sourceType && currentTrack.sourceType !== 'local'
      ? 'Buffering remote track...'
      : 'Buffering track...'
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
  const showEclipsaBadge = Boolean(currentTrack?.isIamf || currentCodec === 'iamf')
  const outputDeviceLabel = (() => {
    return resolveOutputDeviceLabel(selectedOutputDeviceId, availableOutputDevices, {
      defaultRouteFallbackLabel: 'System Default Output',
      selectedFallbackLabel: 'Selected Output'
    }).label
  })()
  const transportInfoLine = resolveTransportInfoLine(
    transportInfoLineMode,
    outputDeviceLabel,
    currentTrack?.album
  )
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
    const approxPrefix = audioEngine.isNormalizationApproximate() ? '~' : ''
    return {
      value: `${approxPrefix}${sign}${displayDb.toFixed(1)}dB`,
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

  const handleLyricsToggle = () => {
    if (showLyricsShelf && lyricsPopoutIsOpen) {
      void window.electronAPI.lyricsPopout.close()
      closeLyricsShelf()
      return
    }
    toggleLyricsShelf()
  }

  return (
    <div
      className={transportBarClassName}
      data-controller-region="true"
      data-controller-region-id="transport"
      data-controller-group="transport-items"
      data-controller-axis="horizontal"
      data-controller-auto-items="true"
    >
      <button
        className={`pipeline-shelf-toggle${showPipelineShelf ? ' pipeline-shelf-toggle-open' : ''}`}
        onClick={togglePipelineShelf}
        title={showPipelineShelf ? translate('common:auto.transportbar.hide_audio_pipeline') : translate('common:auto.transportbar.show_audio_pipeline')}
        aria-label={translate('common:auto.transportbar.toggle_audio_pipeline_shelf')}
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
        <div
          className="transport-artwork"
          onClick={() => setFullscreen(true)}
          data-controller-focusable="true"
          tabIndex={-1}
          role="button"
          aria-label={translate('common:auto.transportbar.open_fullscreen_player')}
        >
          {currentTrack?.artworkHash ? (
            <AlbumArtwork hash={currentTrack.artworkHash} alt={translate('common:auto.transportbar.album_art')} variant="card" />
          ) : currentTrack?.artworkData ? (
            <img src={currentTrack.artworkData} alt={translate('common:auto.transportbar.album_art')} />
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
          <button
            type="button"
            ref={titleOuterRef}
            className={`now-playing-title now-playing-title-button${titleOverflows ? ' marquee-active' : ''}`}
            onClick={() => {
              void jumpToNowPlaying()
            }}
            disabled={!currentTrack}
            title={translate('common:auto.transportbar.jump_to_playing_j')}
            aria-label={translate('common:auto.transportbar.jump_to_playing_j')}
          >
            <span ref={titleInnerRef} className="now-playing-title-inner">
              {currentTrack?.title ?? 'No track playing'}
            </span>
          </button>
          <div className="transport-subline">
            <div className="now-playing-artist">
              {currentTrack?.artist?.trim()
                ? (
                  <ArtistNameLinks
                    artistText={currentTrack.artist}
                    artistNames={currentTrack.artistNames}
                    browseArtistText={currentTrack.albumArtist}
                    browseArtistNames={currentTrack.albumArtistNames}
                    onArtistClick={openArtistInLibrary}
                    className="now-playing-artist-links"
                    linkClassName="artist-name-link-inline"
                  />
                )
                : '\u2014'}
            </div>
            {(showAtmosBadge || showEclipsaBadge || isMultichannel) && (
              <div className="transport-audio-badges">
              {showAtmosBadge && (
                  <span
                    className="transport-audio-badge transport-audio-badge-atmos"
                    title={translate('common:auto.transportbar.atmos_metadata_detected')}
                  >

                    <LocalizedText ns="common" i18nKey="auto.transportbar.atm" />
                  </span>
                )}
                {showEclipsaBadge && (
                  <span
                    className="transport-audio-badge transport-audio-badge-eclipsa"
                    title={translate('common:auto.transportbar.eclipsa_audio_iamf_source_decoded_to_7_1_4')}
                  >

                    <LocalizedText ns="common" i18nKey="auto.transportbar.ecl" />
                  </span>
                )}
                {isMultichannel && (
                  <span
                    className="transport-audio-badge transport-audio-badge-ch"
                    title={translate('common:auto.transportbar.resolvedchannelcount_channels', { resolvedchannelcount: resolvedChannelCount })}
                  >
                    <span>{resolvedChannelCount}<LocalizedText ns="common" i18nKey="auto.transportbar.ch" /></span>
                  </span>
                )}
              </div>
            )}
          </div>
          {transportInfoLine && (
            transportInfoLine.action === 'open-album' && currentTrack ? (
              <button
                type="button"
                className="transport-output-line transport-output-line-button"
                title={transportInfoLine.title}
                aria-label={transportInfoLine.title}
                onClick={() => {
                  void openAlbumInLibrary(
                    currentTrack.album,
                    currentTrack.artist,
                    currentTrack.albumArtist,
                    currentTrack.albumIdentityKey
                  )
                }}
              >
                <span className="transport-output-line-prefix">{transportInfoLine.prefix}</span>
                <span className="transport-output-line-value">{transportInfoLine.value}</span>
              </button>
            ) : (
              <div className="transport-output-line" title={transportInfoLine.title}>
                <span className="transport-output-line-prefix">{transportInfoLine.prefix}</span>
                <span className="transport-output-line-value">{transportInfoLine.value}</span>
              </div>
            )
          )}
          {bitPerfectStatusLabel && (
            <div className="transport-output-line" title={disabledControlMessage}>
              <span className="transport-output-line-prefix"><LocalizedText ns="common" i18nKey="auto.transportbar.bp" /></span>
              <span className="transport-output-line-value">{bitPerfectStatusLabel}</span>
            </div>
          )}
        </div>
        <button
          className={`transport-fav-btn ${isFavorite ? 'active' : ''}`}
          title={isAssociationTrack
            ? translate('common:auto.transportbar.unavailable_for_files_opened_from_your_file_explorer')
            : isFavorite
              ? translate('common:auto.transportbar.remove_from_favorites')
              : translate('common:auto.transportbar.add_to_favorites')}
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
            aria-label={translate('common:auto.transportbar.shuffle')}
            onClick={toggleShuffle}
            disabled={transportControlsLocked}
            title={shuffle ? translate('common:auto.transportbar.shuffle_on') : translate('common:auto.transportbar.shuffle_off')}
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
            aria-label={translate('common:auto.transportbar.previous')}
            onClick={playPrevious}
            disabled={transportControlsLocked || resolvedQueueLength === 0}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="5" x2="6" y2="19" />
              <polygon points="18,5 8,12 18,19" />
            </svg>
          </button>
          <button
            className="control-btn control-btn-play"
            onClick={togglePlay}
            disabled={transportControlsLocked || !currentTrack || isLoadingTrack}
            aria-label={isPlaying ? translate('common:auto.transportbar.pause') : translate('common:auto.transportbar.play')}
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
            aria-label={translate('common:auto.transportbar.next')}
            onClick={playNext}
            disabled={transportControlsLocked || resolvedQueueLength === 0}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="5" x2="18" y2="19" />
              <polygon points="6,5 16,12 6,19" />
            </svg>
          </button>
          <button
            className={`control-btn control-btn-repeat ${repeat !== 'none' ? 'active' : ''}`}
            aria-label={translate('common:auto.transportbar.repeat')}
            onClick={toggleRepeat}
            disabled={transportControlsLocked}
            title={repeat === 'none' ? translate('common:auto.transportbar.repeat_off') : repeat === 'all' ? translate('common:auto.transportbar.repeat_all') : translate('common:auto.transportbar.repeat_one')}
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
        <VolumeControl className="transport-volume" />
      </div>

      {/* Right: EQ + Queue/Info + File readout */}
      <div className="transport-right">
        <div className="transport-mini-lyrics-stack">
          <button
            className={`transport-mini-btn transport-mini-btn-split-top ${miniWindowState.isOpen ? 'active' : ''} ${miniWindowState.alwaysOnTop ? 'pinned' : ''}`}
            onClick={() => void window.electronAPI.miniPlayer.open()}
            title={translate('common:auto.transportbar.open_mini_player')}
            aria-label={translate('common:auto.transportbar.open_mini_player')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
              <line x1="7" y1="8.5" x2="17" y2="8.5" />
              <line x1="7" y1="12.5" x2="14" y2="12.5" />
            </svg>
          </button>
          <button
            className={`transport-lyrics-btn ${showLyricsShelf ? 'active' : ''}`}
            onClick={handleLyricsToggle}
            title={showLyricsShelf && lyricsPopoutIsOpen ? translate('common:auto.transportbar.close_popped_out_lyrics') : translate('common:auto.transportbar.toggle_lyrics_shelf')}
            aria-label={translate('common:auto.transportbar.toggle_lyrics_shelf')}
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
          title={eqControlDisabled ? disabledControlMessage : translate('common:auto.transportbar.toggle_equalizer')}
          disabled={eqControlDisabled}
        >
          <span className="transport-eq-label"><LocalizedText ns="common" i18nKey="auto.transportbar.eq" /></span>
          <EQResponsePreview className="transport-eq-curve" width={80} height={30} showFill={false} />
        </button>

        {/* Queue + Info stacked vertically */}
        <div className="transport-qi-stack">
          <button
            className={`transport-qi-btn ${showQueue ? 'active' : ''}`}
            onClick={toggleQueue}
            title={translate('common:auto.transportbar.toggle_queue')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
            </svg>
          </button>
          <button
            className={`transport-qi-btn ${showInfoSidebar ? 'active' : ''}`}
            onClick={toggleInfoSidebar}
            title={translate('common:auto.transportbar.toggle_track_info')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
            </svg>
          </button>
        </div>

        {/* File info readout — 2x2 grid */}
        <div className="transport-file-readout">
          <div className="readout-cell">
            <span className="readout-label"><LocalizedText ns="common" i18nKey="auto.transportbar.fmt" /></span>
            <span className="readout-value">{currentTrack?.format?.toUpperCase() ?? '—'}</span>
          </div>
          <div className="readout-cell">
            <span className="readout-label"><LocalizedText ns="common" i18nKey="auto.transportbar.bit" /></span>
            <span className="readout-value">{currentTrack?.bitDepth ?? '—'}</span>
          </div>
          <div className="readout-cell">
            <span className="readout-label"><LocalizedText ns="common" i18nKey="auto.transportbar.khz" /></span>
            <span className="readout-value">{currentTrack?.sampleRate ? (currentTrack.sampleRate / 1000).toFixed(1) : '—'}</span>
          </div>
          <div className="readout-cell">
            <span className="readout-label"><LocalizedText ns="common" i18nKey="auto.transportbar.norm" /></span>
            <span
              className={`readout-value${normalizationReadout.dim ? ' readout-value-dim' : ''}${normalizationReadout.accent ? ' readout-value-replaygain' : ''}${normalizationReadout.off ? ' readout-value-off' : ''}`}
            >
              {normalizationReadout.value}
            </span>
          </div>
        </div>
      </div>

      {/* EQ Popover */}
      {eqPopoverPresence.shouldRender && (
        <EQPopover
          presencePhase={eqPopoverPresence.phase}
          onClose={() => setShowEQPopover(false)}
        />
      )}
    </div>
  )
}
