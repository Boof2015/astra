import { type Dispatch, type ReactElement, type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { usePlayerStore } from '../../stores/playerStore'
import { useLibraryStore } from '../../stores/libraryStore'
import { useAudioSettingsStore } from '../../stores/audioSettingsStore'
import { useLyricsStore } from '../../stores/lyricsStore'
import { useLyricsDisplaySettingsStore } from '../../stores/lyricsDisplaySettingsStore'
import { useLyricsSyncedView } from '../../hooks/useLyricsSyncedView'
import AlbumArtwork from '../library/AlbumArtwork'
import WaveformSeekBar from '../player/WaveformSeekBar'
import VolumeControl from '../player/VolumeControl'
import FullscreenAmbientSpectrum from './FullscreenAmbientSpectrum'
import LyricsLineContent from '../lyrics/LyricsLineContent'
import { usePlaybackClock } from '../../hooks/usePlaybackClock'
import { getFullscreenBackdropArtworkCandidates } from '../../utils/fullscreenBackdropArtwork'
import {
  buildLyricsQuery,
  DEFAULT_LYRICS_BODY_COPY,
  getActiveLyricsResult,
  getCompensatedLyricsTime,
  getLyricsLineSeekTimeSeconds,
  getLyricsMetaChipText,
  getLyricsRequestKey,
  getSyncedLyricsDisplayLines,
  resolveLyricsBodyState,
  resolveSyncedLyricsTiming
} from '../../utils/lyricsPresentation'
import type { Track } from '../../types/audio'

type CueState = 'hidden' | 'visible' | 'handoff'
type HeroPhase = 'steady' | 'handoff' | 'enter'

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function preloadImage(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    img.decoding = 'async'
    img.onload = () => finish(() => resolve(url))
    img.onerror = () => finish(() => reject(new Error('Backdrop image failed to load')))
    img.src = url

    if (img.complete && img.naturalWidth > 0) {
      finish(() => resolve(url))
    }
  })
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

    const handleChange = () => setPrefersReducedMotion(mediaQuery.matches)
    handleChange()

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  return prefersReducedMotion
}

function FullscreenWaveformSection(): ReactElement {
  const waveformTimeDisplayMode = useUIStore((s) => s.waveformTimeDisplayMode)
  const toggleWaveformTimeDisplayMode = useUIStore((s) => s.toggleWaveformTimeDisplayMode)
  // 30Hz keeps the playhead visually smooth without frame-rate re-renders.
  const currentTime = usePlaybackClock(1 / 30)
  const duration = usePlayerStore((s) => s.duration)
  const waveformData = usePlayerStore((s) => s.waveformData)
  const waveformBufferedRatio = usePlayerStore((s) => s.waveformBufferedRatio)
  const waveformAnalyzedRatio = usePlayerStore((s) => s.waveformAnalyzedRatio)
  const remoteBufferedSeconds = usePlayerStore((s) => s.remoteBufferedSeconds)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const seek = usePlayerStore((s) => s.seek)
  const effectiveDelayMs = useAudioSettingsStore((s) => s.effectiveDelayMs)

  const effectiveDelaySec = Math.max(0, effectiveDelayMs / 1000)
  const compensatedTime = duration > 0
    ? Math.max(0, Math.min(duration, currentTime - effectiveDelaySec))
    : 0
  const remaining = duration > 0 ? Math.max(0, duration - compensatedTime) : 0
  const progress = duration > 0 ? Math.max(0, Math.min(100, (compensatedTime / duration) * 100)) : 0
  const showingRemainingTime = waveformTimeDisplayMode === 'remaining'
  const rightTimeLabel = showingRemainingTime ? `-${formatTime(remaining)}` : formatTime(duration)
  const rightTimeToggleLabel = showingRemainingTime ? 'Show track duration' : 'Show remaining time'

  return (
    <div className="fullscreen-waveform-wrap">
      <span className="fullscreen-time fullscreen-time-current">{formatTime(compensatedTime)}</span>
      <button
        type="button"
        className="fullscreen-time fullscreen-time-remaining fullscreen-time-toggle"
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
    </div>
  )
}

function FullscreenLyricsFocusBand({
  currentTrack,
  showLyrics,
}: {
  currentTrack: Track | null
  showLyrics: boolean
}): ReactElement {
  const currentTime = usePlaybackClock(0.1)
  const duration = usePlayerStore((s) => s.duration)
  const seek = usePlayerStore((s) => s.seek)
  const effectiveDelayMs = useAudioSettingsStore((s) => s.effectiveDelayMs)
  const lyricsTrackPath = useLyricsStore((s) => s.currentTrackPath)
  const lyricsResult = useLyricsStore((s) => s.currentResult)
  const lyricsIsLoading = useLyricsStore((s) => s.isLoading)
  const lyricsStoreError = useLyricsStore((s) => s.errorMessage)
  const loadLyricsForTrack = useLyricsStore((s) => s.loadForTrack)
  const lyricsDisplaySettings = useLyricsDisplaySettingsStore((s) => s.settings)
  const lastLyricsRequestKeyRef = useRef<string | null>(null)
  const hideLyricsContentTimeoutRef = useRef<number | null>(null)
  const bandRef = useRef<HTMLElement | null>(null)
  const openBandHeightRef = useRef(0)
  const prevShowLyricsRef = useRef(showLyrics)
  const [shouldRenderLyricsContent, setShouldRenderLyricsContent] = useState(showLyrics)

  const lyricsQuery = useMemo(
    () => buildLyricsQuery(currentTrack),
    [
      currentTrack?.path,
      currentTrack?.title,
      currentTrack?.artist,
      currentTrack?.album,
      currentTrack?.duration
    ]
  )

  const activeLyricsResult = useMemo(() => (
    getActiveLyricsResult(currentTrack?.path ?? null, lyricsTrackPath, lyricsResult)
  ), [currentTrack?.path, lyricsResult, lyricsTrackPath])

  const bodyState = useMemo(() => resolveLyricsBodyState({
    currentTrack,
    activeLyricsResult,
    isLoading: lyricsIsLoading,
    errorMessage: lyricsStoreError,
    copy: DEFAULT_LYRICS_BODY_COPY
  }), [activeLyricsResult, currentTrack, lyricsIsLoading, lyricsStoreError])

  const syncedLines = bodyState.kind === 'hit_synced' ? bodyState.syncedLines : []
  const compensatedTime = useMemo(
    () => getCompensatedLyricsTime(currentTime, duration, effectiveDelayMs),
    [currentTime, duration, effectiveDelayMs]
  )
  const displayedSyncedLines = useMemo(
    () => getSyncedLyricsDisplayLines(syncedLines, { durationSeconds: duration }),
    [duration, syncedLines]
  )
  const syncedLyricsTiming = useMemo(
    () => resolveSyncedLyricsTiming(syncedLines, compensatedTime, { durationSeconds: duration }),
    [compensatedTime, duration, syncedLines]
  )
  const activeSyncedLineIndex = syncedLyricsTiming.activeLineIndex
  const hasSyncedLyrics = displayedSyncedLines.some((line) => line.kind === 'lyric')
  const metaChipText = useMemo(() => (
    getLyricsMetaChipText({
      currentTrack,
      activeLyricsResult,
      hasSyncedLyrics,
      isLoading: lyricsIsLoading,
      errorMessage: lyricsStoreError
    })
  ), [activeLyricsResult, currentTrack, hasSyncedLyrics, lyricsIsLoading, lyricsStoreError])

  const {
    expandedListRef,
    effectiveSyncedLineIndex,
    setFollowPaused,
    setSyncedLineRef,
    pauseFollowFromManualScroll,
    handleRecenter,
    followPaused
  } = useLyricsSyncedView({
    isOpen: showLyrics,
    isExpanded: true,
    hasSyncedLyrics,
    activeSyncedLineIndex,
    focusedSyncedLineIndex: syncedLyricsTiming.focusLineIndex,
    contentKey: currentTrack?.path ?? null,
    expandedActiveAnchorRatio: 0.43
  })

  const handleLyricsLineSeek = useCallback((seekTimeSeconds: number) => {
    setFollowPaused(false)
    void seek(seekTimeSeconds)
  }, [seek, setFollowPaused])

  useEffect(() => {
    if (!showLyrics) {
      lastLyricsRequestKeyRef.current = null
      return
    }

    const requestKey = getLyricsRequestKey(lyricsQuery)
    if (lastLyricsRequestKeyRef.current === requestKey) return
    lastLyricsRequestKeyRef.current = requestKey
    void loadLyricsForTrack(lyricsQuery)
  }, [loadLyricsForTrack, lyricsQuery, showLyrics])

  useEffect(() => {
    if (hideLyricsContentTimeoutRef.current !== null) {
      window.clearTimeout(hideLyricsContentTimeoutRef.current)
      hideLyricsContentTimeoutRef.current = null
    }

    if (showLyrics) {
      setShouldRenderLyricsContent(true)
      return
    }

    hideLyricsContentTimeoutRef.current = window.setTimeout(() => {
      setShouldRenderLyricsContent(false)
      hideLyricsContentTimeoutRef.current = null
    }, 620)
  }, [showLyrics])

  useEffect(() => () => {
    if (hideLyricsContentTimeoutRef.current !== null) {
      window.clearTimeout(hideLyricsContentTimeoutRef.current)
    }
  }, [])

  // Remember the band's natural open height. It varies per track (metadata wraps
  // differently) and per window size, so a static CSS max-height can't match it.
  useEffect(() => {
    const el = bandRef.current
    if (!el || !showLyrics) return
    const measure = () => {
      const height = el.getBoundingClientRect().height
      if (height > 0) openBandHeightRef.current = height
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [showLyrics])

  // On close, collapse the band from its real measured height down to 0 (rather
  // than from the CSS max-height) so the card shrinks straight down instead of
  // briefly ballooning to max-height first and arcing shut.
  useLayoutEffect(() => {
    const el = bandRef.current
    const wasShown = prevShowLyricsRef.current
    prevShowLyricsRef.current = showLyrics
    if (!el) return

    if (wasShown && !showLyrics) {
      const start = openBandHeightRef.current
      if (start > 0) {
        // Animate real height (not max-height) so short content — unsynced/empty
        // states — collapses from the full height too, instead of snapping to its
        // content height the moment flex-grow drops and then "bouncing".
        el.style.transition = 'none'
        el.style.maxHeight = 'none'
        el.style.height = `${start}px`
        void el.offsetHeight // commit the start height without animating to it
        el.style.transition = ''
        el.style.height = '0px'
      }
    } else if (showLyrics) {
      // Reopening: hand height control back to CSS/flex.
      el.style.transition = ''
      el.style.maxHeight = ''
      el.style.height = ''
    }
  }, [showLyrics])

  const renderBody = () => {
    if (bodyState.kind === 'hit_synced') {
      return (
        <div
          ref={expandedListRef}
          className="fullscreen-lyrics-expanded-list"
          onWheel={pauseFollowFromManualScroll}
          onTouchStart={pauseFollowFromManualScroll}
          aria-live="polite"
        >
          {displayedSyncedLines.map((displayLine) => {
            const { displayIndex } = displayLine
            const distance = displayIndex - effectiveSyncedLineIndex
            const isActiveLine = displayLine.kind === 'lyric' && displayIndex === activeSyncedLineIndex
            const lineClassName = [
              'fullscreen-lyrics-focus-line',
              displayLine.kind === 'gap' ? 'is-gap' : '',
              isActiveLine
                ? 'is-active'
                : Math.abs(distance) <= 1
                  ? 'is-near'
                  : Math.abs(distance) === 2
                    ? 'is-far'
                    : 'is-distant'
            ].join(' ')

            return (
              <p
                key={displayLine.key}
                ref={setSyncedLineRef(displayIndex)}
                className={lineClassName}
                aria-hidden={displayLine.kind === 'gap'}
              >
                <LyricsLineContent
                  displayLine={displayLine}
                  currentTimeSeconds={compensatedTime}
                  isActive={isActiveLine}
                  settings={lyricsDisplaySettings}
                  seekTimeSeconds={displayLine.kind === 'lyric'
                    ? getLyricsLineSeekTimeSeconds(displayLine.timestampMs, duration, effectiveDelayMs)
                    : null}
                  onSeek={handleLyricsLineSeek}
                />
              </p>
            )
          })}
        </div>
      )
    }

    if (bodyState.kind === 'hit_plain') {
      return <pre className="fullscreen-lyrics-focus-plain">{bodyState.plainLyrics}</pre>
    }

    return (
      <p
        className={[
          'fullscreen-lyrics-focus-state',
          bodyState.kind === 'transient_error' ? 'fullscreen-lyrics-focus-state-error' : '',
          bodyState.kind === 'not_found' ? 'fullscreen-lyrics-focus-state-not-found' : ''
        ].join(' ').trim()}
      >
        {bodyState.message}
      </p>
    )
  }

  return (
    <section
      ref={bandRef}
      className="fullscreen-lyrics-focus-band"
      aria-hidden={!showLyrics}
      aria-label="Lyrics"
    >
      {shouldRenderLyricsContent && (
        <>
          <span className="fullscreen-lyrics-focus-meta">{metaChipText}</span>
          {renderBody()}
          {followPaused && hasSyncedLyrics && (
            <button
              type="button"
              className="fullscreen-lyrics-recenter"
              onClick={handleRecenter}
            >
              Recenter
            </button>
          )}
        </>
      )}
    </section>
  )
}

function FullscreenNextCueOverlay({
  nextTrack,
  playbackState,
  repeat,
  setHeroPhase,
}: {
  nextTrack: {
    artworkHash?: string
    artworkData?: string
    title: string
    artist: string
  } | null
  playbackState: 'stopped' | 'playing' | 'paused' | 'loading'
  repeat: 'none' | 'one' | 'all'
  setHeroPhase: Dispatch<SetStateAction<HeroPhase>>
}): ReactElement | null {
  const currentTime = usePlaybackClock(0.25)
  const duration = usePlayerStore((s) => s.duration)
  const effectiveDelayMs = useAudioSettingsStore((s) => s.effectiveDelayMs)
  const [cueState, setCueState] = useState<CueState>('hidden')

  const effectiveDelaySec = Math.max(0, effectiveDelayMs / 1000)
  const compensatedTime = duration > 0
    ? Math.max(0, Math.min(duration, currentTime - effectiveDelaySec))
    : 0
  const remaining = duration > 0 ? Math.max(0, duration - compensatedTime) : 0
  const cueProgress = Math.max(0, Math.min(1, (10 - Math.min(10, remaining)) / 10))
  const cueCountdown = Math.max(0, Math.ceil(Math.min(10, remaining)))
  const canShowNextCue =
    playbackState === 'playing' &&
    duration > 0 &&
    repeat !== 'one' &&
    Boolean(nextTrack)

  useEffect(() => {
    if (!canShowNextCue) {
      setCueState('hidden')
      setHeroPhase((prev) => (prev === 'handoff' ? 'steady' : prev))
      return
    }

    if (remaining <= 1.2) {
      setCueState('handoff')
      setHeroPhase((prev) => (prev === 'enter' ? prev : 'handoff'))
      return
    }

    if (remaining <= 10) {
      setCueState('visible')
      setHeroPhase((prev) => (prev === 'handoff' ? 'steady' : prev))
      return
    }

    setCueState('hidden')
    setHeroPhase((prev) => (prev === 'handoff' ? 'steady' : prev))
  }, [canShowNextCue, remaining, setHeroPhase])

  if (!nextTrack) return null

  return (
    <aside
      className={`fullscreen-next-cue fullscreen-next-cue-${cueState}`}
      aria-hidden={cueState === 'hidden'}
    >
      <div className="fullscreen-next-cue-card">
        <div className="fullscreen-next-cue-artwork">
          {nextTrack.artworkHash ? (
            <AlbumArtwork hash={nextTrack.artworkHash} alt="Up next artwork" variant="card" />
          ) : nextTrack.artworkData ? (
            <img src={nextTrack.artworkData} alt="Up next artwork" />
          ) : (
            <div className="fullscreen-next-cue-placeholder">&#9835;</div>
          )}
        </div>

        <div className="fullscreen-next-cue-meta">
          <span className="fullscreen-next-cue-label">Up Next</span>
          <div className="fullscreen-next-cue-title">{nextTrack.title}</div>
          <div className="fullscreen-next-cue-artist">{nextTrack.artist}</div>
        </div>

        <div className="fullscreen-next-cue-countdown">{cueCountdown}s</div>
      </div>

      <div className="fullscreen-next-cue-progress">
        <div
          className="fullscreen-next-cue-fill"
          style={{ transform: `scaleX(${cueProgress})` }}
        />
      </div>
    </aside>
  )
}

export default function FullscreenMode() {
  const setFullscreen = useUIStore((s) => s.setFullscreen)
  const showLyricsDock = useUIStore((s) => s.fullscreenLyricsVisible)
  const toggleFullscreenLyricsVisible = useUIStore((s) => s.toggleFullscreenLyricsVisible)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const playbackState = usePlayerStore((s) => s.playbackState)
  const shuffle = usePlayerStore((s) => s.shuffle)
  const repeat = usePlayerStore((s) => s.repeat)
  const queueItems = usePlayerStore((s) => s.queueItems)
  const upcomingQueueIds = usePlayerStore((s) => s.upcomingQueueIds)
  const togglePlay = usePlayerStore((s) => s.togglePlay)
  const playNext = usePlayerStore((s) => s.playNext)
  const playPrevious = usePlayerStore((s) => s.playPrevious)
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle)
  const toggleRepeat = usePlayerStore((s) => s.toggleRepeat)
  const resolvedQueueLength = usePlayerStore((s) => s.getResolvedQueueLength())

  const favorites = useLibraryStore((s) => s.favorites)
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite)
  const getArtwork = useLibraryStore((s) => s.getArtwork)

  const prefersReducedMotion = usePrefersReducedMotion()

  const [resolvedBackdropArtwork, setResolvedBackdropArtwork] = useState<string | null>(null)
  const [activeBackdropArtwork, setActiveBackdropArtwork] = useState<string | null>(null)
  const [previousBackdropArtwork, setPreviousBackdropArtwork] = useState<string | null>(null)
  const [showPreviousBackdropLayer, setShowPreviousBackdropLayer] = useState(false)
  const [isBackdropCrossfading, setIsBackdropCrossfading] = useState(false)
  const [heroPhase, setHeroPhase] = useState<HeroPhase>('steady')
  const [fullscreenTitleOverflows, setFullscreenTitleOverflows] = useState(false)

  const backdropRequestTokenRef = useRef(0)
  const previousTrackIdRef = useRef<string | null>(null)
  const enterResetTimeoutRef = useRef<number | null>(null)
  const backdropCrossfadeTimeoutRef = useRef<number | null>(null)
  const heroEnterRafRef = useRef<number | null>(null)
  const fullscreenTitleOuterRef = useRef<HTMLHeadingElement>(null)
  const fullscreenTitleInnerRef = useRef<HTMLSpanElement>(null)

  const isPlaying = playbackState === 'playing'
  const isLoadingTrack = playbackState === 'loading'
  const nextTrack = useMemo(() => usePlayerStore.getState().getResolvedNextTrack(), [
    currentTrack,
    queueItems,
    repeat,
    shuffle,
    upcomingQueueIds
  ])
  const isFavorite = currentTrack ? favorites.has(currentTrack.path) : false
  const currentTrackId = currentTrack?.id ?? null
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

  const checkFullscreenTitleOverflow = useCallback(() => {
    const outer = fullscreenTitleOuterRef.current
    const inner = fullscreenTitleInnerRef.current
    if (!outer || !inner) return

    const overflows = inner.scrollWidth > outer.clientWidth
    setFullscreenTitleOverflows(overflows)

    if (overflows) {
      outer.style.setProperty('--marquee-offset', `${outer.clientWidth - inner.scrollWidth}px`)
      return
    }

    outer.style.removeProperty('--marquee-offset')
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target
      const isEditableTarget = target instanceof HTMLElement && (
        target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT'
      )
      if (isEditableTarget) return

      if (e.key === 'Escape') {
        e.preventDefault()
        setFullscreen(false)
        return
      }

      if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        toggleFullscreenLyricsVisible()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [setFullscreen, toggleFullscreenLyricsVisible])

  useEffect(() => {
    checkFullscreenTitleOverflow()
  }, [currentTrack?.title, checkFullscreenTitleOverflow])

  useEffect(() => {
    const outer = fullscreenTitleOuterRef.current
    if (!outer) return

    const resizeObserver = new ResizeObserver(checkFullscreenTitleOverflow)
    resizeObserver.observe(outer)
    return () => resizeObserver.disconnect()
  }, [checkFullscreenTitleOverflow])

  useEffect(() => {
    return () => {
      if (enterResetTimeoutRef.current !== null) {
        window.clearTimeout(enterResetTimeoutRef.current)
      }
      if (backdropCrossfadeTimeoutRef.current !== null) {
        window.clearTimeout(backdropCrossfadeTimeoutRef.current)
      }
      if (heroEnterRafRef.current !== null) {
        window.cancelAnimationFrame(heroEnterRafRef.current)
      }
    }
  }, [])

  useEffect(() => {
    backdropRequestTokenRef.current += 1
    const requestToken = backdropRequestTokenRef.current
    const setResolvedIfCurrent = (url: string | null) => {
      if (backdropRequestTokenRef.current !== requestToken) return
      setResolvedBackdropArtwork(url)
    }

    const resolveBackdropArtwork = async () => {
      if (!currentTrack) {
        setResolvedIfCurrent(null)
        return
      }

      const uniqueCandidates = await getFullscreenBackdropArtworkCandidates(currentTrack, getArtwork)
      if (backdropRequestTokenRef.current !== requestToken) return
      if (uniqueCandidates.length === 0) {
        setResolvedIfCurrent(null)
        return
      }

      for (const candidate of uniqueCandidates) {
        try {
          const readyUrl = await preloadImage(candidate)
          setResolvedIfCurrent(readyUrl)
          return
        } catch {
          if (backdropRequestTokenRef.current !== requestToken) return
        }
      }

      setResolvedIfCurrent(null)
    }

    void resolveBackdropArtwork()
  }, [
    currentTrack,
    currentTrackId,
    currentTrack?.artworkData,
    currentTrack?.artworkHash,
    getArtwork
  ])

  useEffect(() => {
    if (activeBackdropArtwork === resolvedBackdropArtwork) return

    if (backdropCrossfadeTimeoutRef.current !== null) {
      window.clearTimeout(backdropCrossfadeTimeoutRef.current)
      backdropCrossfadeTimeoutRef.current = null
    }

    // First resolved backdrop should appear immediately instead of crossfading from fallback.
    if (!activeBackdropArtwork && resolvedBackdropArtwork) {
      setPreviousBackdropArtwork(null)
      setShowPreviousBackdropLayer(false)
      setActiveBackdropArtwork(resolvedBackdropArtwork)
      setIsBackdropCrossfading(false)
      return
    }

    setPreviousBackdropArtwork(activeBackdropArtwork)
    setShowPreviousBackdropLayer(true)
    setActiveBackdropArtwork(resolvedBackdropArtwork)
    setIsBackdropCrossfading(true)

    backdropCrossfadeTimeoutRef.current = window.setTimeout(() => {
      setShowPreviousBackdropLayer(false)
      setIsBackdropCrossfading(false)
      backdropCrossfadeTimeoutRef.current = null
    }, prefersReducedMotion ? 120 : 680)
  }, [activeBackdropArtwork, prefersReducedMotion, resolvedBackdropArtwork])

  useEffect(() => {
    if (previousTrackIdRef.current === currentTrackId) return

    previousTrackIdRef.current = currentTrackId

    if (enterResetTimeoutRef.current !== null) {
      window.clearTimeout(enterResetTimeoutRef.current)
      enterResetTimeoutRef.current = null
    }
    if (heroEnterRafRef.current !== null) {
      window.cancelAnimationFrame(heroEnterRafRef.current)
      heroEnterRafRef.current = null
    }

    if (!currentTrackId) {
      setHeroPhase('steady')
      return
    }

    setHeroPhase('handoff')
    heroEnterRafRef.current = window.requestAnimationFrame(() => {
      setHeroPhase('enter')
      enterResetTimeoutRef.current = window.setTimeout(
        () => setHeroPhase('steady'),
        prefersReducedMotion ? 80 : 420
      )
    })
  }, [currentTrackId, prefersReducedMotion])

  return (
    <div
      className="fullscreen-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Fullscreen player"
      data-controller-scope="overlay"
    >
      <div className="fullscreen-backdrop" aria-hidden="true">
        {showPreviousBackdropLayer && (
          <div className={`fullscreen-backdrop-layer fullscreen-backdrop-layer-previous ${isBackdropCrossfading ? 'is-fading' : ''}`}>
            {previousBackdropArtwork ? (
              <img className="fullscreen-backdrop-image" src={previousBackdropArtwork} alt="" />
            ) : (
              <div className="fullscreen-backdrop-fallback" />
            )}
          </div>
        )}

        <div className={`fullscreen-backdrop-layer fullscreen-backdrop-layer-current ${isBackdropCrossfading ? 'is-entering' : ''}`}>
          {activeBackdropArtwork ? (
            <img className="fullscreen-backdrop-image" src={activeBackdropArtwork} alt="" />
          ) : (
            <div className="fullscreen-backdrop-fallback" />
          )}
        </div>

        <div className="fullscreen-backdrop-colorwash" />
        <div className="fullscreen-backdrop-scrim" />
      </div>

      <FullscreenAmbientSpectrum
        className={!currentTrack ? 'is-idle' : ''}
        opacityIntent="subtle"
      />

      <button
        className="fullscreen-close"
        onClick={() => setFullscreen(false)}
        title="Exit fullscreen"
        aria-label="Exit fullscreen"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
        </svg>
      </button>

      <div className="fullscreen-content">
        <div className={`fullscreen-stage ${showLyricsDock ? 'lyrics-open' : ''}`}>
          <div
            className={`fullscreen-hero fullscreen-hero-${heroPhase}${showLyricsDock ? ' lyrics-active' : ''}`}
          >
            <div
              className="fullscreen-hero-topbar"
              data-controller-group="fullscreen-topbar"
              data-controller-axis="horizontal"
              data-controller-auto-items="true"
            >
              <span className="fullscreen-status-label">
                {isLoadingTrack ? 'Loading' : isPlaying ? 'Now Playing' : currentTrack ? 'Paused' : 'Ready'}
              </span>
              <button
                type="button"
                className={`fullscreen-lyrics-toggle ${showLyricsDock ? 'active' : ''}`}
                onClick={toggleFullscreenLyricsVisible}
                title={showLyricsDock ? 'Hide lyrics (L)' : 'Show lyrics (L)'}
                aria-label={showLyricsDock ? 'Hide lyrics' : 'Show lyrics'}
                aria-pressed={showLyricsDock}
              >
                Lyrics
              </button>
            </div>

            <div className="fullscreen-main-row">
              <div className="fullscreen-artwork">
                {currentTrack?.artworkHash ? (
                  <AlbumArtwork hash={currentTrack.artworkHash} alt="Album art" variant="card" />
                ) : currentTrack?.artworkData ? (
                  <img src={currentTrack.artworkData} alt="Album art" />
                ) : (
                  <div className="fullscreen-artwork-placeholder">&#9835;</div>
                )}
              </div>

              <div className="fullscreen-track-info">
                <h1
                  ref={fullscreenTitleOuterRef}
                  className={`fullscreen-title${fullscreenTitleOverflows ? ' marquee-active' : ''}`}
                >
                  <span ref={fullscreenTitleInnerRef} className="fullscreen-title-inner">
                    {currentTrack?.title ?? 'No track playing'}
                  </span>
                </h1>
                <p className="fullscreen-artist">{currentTrack?.artist ?? '\u2014'}</p>
                <p className="fullscreen-album">{currentTrack?.album ?? '\u2014'}</p>
                {(showAtmosBadge || showEclipsaBadge || isMultichannel) && (
                  <div className="fullscreen-audio-badges">
                    {showAtmosBadge && (
                      <span className="fullscreen-audio-badge fullscreen-audio-badge-atmos">
                        ATMOS
                      </span>
                    )}
                    {showEclipsaBadge && (
                      <span className="fullscreen-audio-badge fullscreen-audio-badge-eclipsa">
                        ECLIPSA
                      </span>
                    )}
                    {isMultichannel && (
                      <span className="fullscreen-audio-badge fullscreen-audio-badge-ch">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <path d="M3 10v4h4l5 5V5l-5 5H3zm13.5 2c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zm2.5 0c0 3.04-1.72 5.64-4.25 6.92l-.75-1.83c1.92-.98 3.25-2.97 3.25-5.09s-1.33-4.11-3.25-5.09l.75-1.83C17.28 6.36 19 8.96 19 12z" />
                        </svg>
                        <span>{resolvedChannelCount}CH</span>
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            <FullscreenLyricsFocusBand
              currentTrack={currentTrack}
              showLyrics={showLyricsDock}
            />

            <div className="fullscreen-console">
              <div
                className="fullscreen-controls"
                data-controller-group="fullscreen-controls"
                data-controller-axis="horizontal"
                data-controller-auto-items="true"
              >
                <button
                  className={`fullscreen-control-btn ${shuffle ? 'active' : ''}`}
                  aria-label="Shuffle"
                  title={shuffle ? 'Shuffle on' : 'Shuffle off'}
                  onClick={toggleShuffle}
                  disabled={resolvedQueueLength === 0}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 3h5v5" />
                    <path d="M4 20 21 3" />
                    <path d="M21 16v5h-5" />
                    <path d="M15 15 21 21" />
                    <path d="M4 4 9 9" />
                  </svg>
                </button>
  
                <button
                  className="fullscreen-control-btn"
                  aria-label="Previous"
                  onClick={() => void playPrevious()}
                  disabled={resolvedQueueLength === 0}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="6" y1="5" x2="6" y2="19" />
                    <polygon points="18,5 8,12 18,19" />
                  </svg>
                </button>
  
                <button
                  className="fullscreen-control-btn fullscreen-control-btn-play"
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                  onClick={() => void togglePlay()}
                  disabled={!currentTrack || isLoadingTrack}
                >
                  {isLoadingTrack ? (
                    <div className="loading-spinner" />
                  ) : isPlaying ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
  
                <button
                  className="fullscreen-control-btn"
                  aria-label="Next"
                  onClick={() => void playNext()}
                  disabled={resolvedQueueLength === 0}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="5" x2="18" y2="19" />
                    <polygon points="6,5 16,12 6,19" />
                  </svg>
                </button>
  
                <button
                  className={`fullscreen-control-btn ${repeat !== 'none' ? 'active' : ''}`}
                  aria-label="Repeat"
                  title={repeat === 'none' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one'}
                  onClick={toggleRepeat}
                  disabled={resolvedQueueLength === 0}
                >
                  {repeat === 'one' ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7h13a4 4 0 0 1 4 4v1" />
                      <polyline points="17 4 20 7 17 10" />
                      <path d="M21 17H8a4 4 0 0 1-4-4v-1" />
                      <polyline points="7 20 4 17 7 14" />
                      <path d="M12 8v8" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7h13a4 4 0 0 1 4 4v1" />
                      <polyline points="17 4 20 7 17 10" />
                      <path d="M21 17H8a4 4 0 0 1-4-4v-1" />
                      <polyline points="7 20 4 17 7 14" />
                    </svg>
                  )}
                </button>
              </div>
  
              <FullscreenWaveformSection />
  
              <div className="fullscreen-footer">
                <div
                  className="fullscreen-footer-primary"
                  data-controller-group="fullscreen-footer"
                  data-controller-axis="horizontal"
                  data-controller-auto-items="true"
                >
                  <button
                    className={`fullscreen-favorite-btn ${isFavorite ? 'active' : ''}`}
                    aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                    title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                    onClick={() => currentTrack && void toggleFavorite(currentTrack.path)}
                    disabled={!currentTrack}
                  >
                    {isFavorite ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                      </svg>
                    )}
                    <span>{isFavorite ? 'Favorited' : 'Favorite'}</span>
                  </button>
  
                  <VolumeControl
                    className="fullscreen-volume"
                    labelFormatter={(percent) => `${percent}%`}
                  />
                </div>
  
                <div className="fullscreen-file-readout" aria-hidden={!currentTrack}>
                  <span>{currentTrack?.format?.toUpperCase() ?? '—'}</span>
                  <span>{currentTrack?.bitDepth ? `${currentTrack.bitDepth}-bit` : '—'}</span>
                  <span>
                    {currentTrack?.sampleRate
                      ? `${(currentTrack.sampleRate / 1000).toFixed(1)} kHz`
                      : '—'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <FullscreenNextCueOverlay
        nextTrack={nextTrack}
        playbackState={playbackState}
        repeat={repeat}
        setHeroPhase={setHeroPhase}
      />
    </div>
  )
}
