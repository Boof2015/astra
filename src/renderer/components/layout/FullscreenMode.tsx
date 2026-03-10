import { CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { usePlayerStore } from '../../stores/playerStore'
import { useLibraryStore } from '../../stores/libraryStore'
import { useAudioSettingsStore } from '../../stores/audioSettingsStore'
import { useLyricsStore } from '../../stores/lyricsStore'
import AlbumArtwork from '../library/AlbumArtwork'
import WaveformSeekBar from '../player/WaveformSeekBar'
import FullscreenAmbientSpectrum from './FullscreenAmbientSpectrum'
import type { LyricsLine, LyricsTrackQuery } from '../../../types/lyrics'

type CueState = 'hidden' | 'visible' | 'handoff'
type HeroPhase = 'steady' | 'handoff' | 'enter'
const FULLSCREEN_DOCK_CHROME_HEIGHT_PX = 58
const ACTIVE_LYRIC_MIN_SCALE = 0.82
const ACTIVE_LYRIC_FONT_SIZE_EPSILON_PX = 0.1

interface LyricsDockLayout {
  lineHeightPx: number
  visibleLines: number
  activeAnchorIndex: number
  renderPadding: number
  openHeightPx: number
}

function getLyricsSourceLabel(source: 'embedded' | 'lrclib' | 'manual'): string {
  if (source === 'embedded') return 'Embedded'
  if (source === 'manual') return 'Manual'
  return 'LRCLIB'
}

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

function useViewportSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }))

  useEffect(() => {
    const handleResize = () => {
      setSize({
        width: window.innerWidth,
        height: window.innerHeight
      })
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return size
}

function resolveLyricsDockLayout(viewport: { width: number; height: number }): LyricsDockLayout {
  if (viewport.width <= 860 || viewport.height <= 660) {
    const lineHeightPx = 34
    const visibleLines = 3
    return {
      lineHeightPx,
      visibleLines,
      activeAnchorIndex: 1,
      renderPadding: 2,
      openHeightPx: (visibleLines * lineHeightPx) + FULLSCREEN_DOCK_CHROME_HEIGHT_PX
    }
  }

  if (viewport.width >= 1480 && viewport.height >= 980) {
    const lineHeightPx = 48
    const visibleLines = 7
    return {
      lineHeightPx,
      visibleLines,
      activeAnchorIndex: 2,
      renderPadding: 4,
      openHeightPx: (visibleLines * lineHeightPx) + FULLSCREEN_DOCK_CHROME_HEIGHT_PX
    }
  }

  if (viewport.width >= 1180 && viewport.height >= 820) {
    const lineHeightPx = 44
    const visibleLines = 5
    return {
      lineHeightPx,
      visibleLines,
      activeAnchorIndex: 1,
      renderPadding: 3,
      openHeightPx: (visibleLines * lineHeightPx) + FULLSCREEN_DOCK_CHROME_HEIGHT_PX
    }
  }

  const lineHeightPx = 42
  const visibleLines = 3
  return {
    lineHeightPx,
    visibleLines,
    activeAnchorIndex: 1,
    renderPadding: 3,
    openHeightPx: (visibleLines * lineHeightPx) + FULLSCREEN_DOCK_CHROME_HEIGHT_PX
  }
}

function buildLyricsQuery(
  track: {
    path: string
    title: string
    artist: string
    album: string
    duration: number
  } | null
): LyricsTrackQuery | null {
  if (!track) return null
  return {
    path: track.path,
    title: track.title,
    artist: track.artist,
    album: track.album || undefined,
    durationSeconds: Number.isFinite(track.duration) ? track.duration : undefined
  }
}

function findActiveSyncedLineIndex(lines: LyricsLine[], currentTimeSeconds: number): number {
  if (lines.length === 0) return -1
  const currentTimeMs = Number.isFinite(currentTimeSeconds)
    ? Math.max(0, Math.floor(currentTimeSeconds * 1000))
    : 0

  let low = 0
  let high = lines.length - 1
  let best = -1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (lines[mid].timestampMs <= currentTimeMs) {
      best = mid
      low = mid + 1
      continue
    }
    high = mid - 1
  }

  return best
}

export default function FullscreenMode() {
  const setFullscreen = useUIStore((s) => s.setFullscreen)
  const waveformTimeDisplayMode = useUIStore((s) => s.waveformTimeDisplayMode)
  const toggleWaveformTimeDisplayMode = useUIStore((s) => s.toggleWaveformTimeDisplayMode)
  const {
    currentTrack,
    playbackState,
    currentTime,
    duration,
    waveformData,
    shuffle,
    repeat,
    togglePlay,
    seek,
    playNext,
    playPrevious,
    toggleShuffle,
    toggleRepeat,
  } = usePlayerStore()
  const nextTrack = usePlayerStore((s) => s.getResolvedNextTrack())
  const resolvedQueueLength = usePlayerStore((s) => s.getResolvedQueueLength())

  const favorites = useLibraryStore((s) => s.favorites)
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite)
  const getArtwork = useLibraryStore((s) => s.getArtwork)
  const effectiveDelayMs = useAudioSettingsStore((s) => s.effectiveDelayMs)
  const lyricsTrackPath = useLyricsStore((s) => s.currentTrackPath)
  const lyricsResult = useLyricsStore((s) => s.currentResult)
  const lyricsIsLoading = useLyricsStore((s) => s.isLoading)
  const loadLyricsForTrack = useLyricsStore((s) => s.loadForTrack)

  const prefersReducedMotion = usePrefersReducedMotion()
  const viewportSize = useViewportSize()
  const lyricsDockLayout = useMemo(
    () => resolveLyricsDockLayout(viewportSize),
    [viewportSize.height, viewportSize.width]
  )

  const [resolvedBackdropArtwork, setResolvedBackdropArtwork] = useState<string | null>(null)
  const [activeBackdropArtwork, setActiveBackdropArtwork] = useState<string | null>(null)
  const [previousBackdropArtwork, setPreviousBackdropArtwork] = useState<string | null>(null)
  const [showPreviousBackdropLayer, setShowPreviousBackdropLayer] = useState(false)
  const [isBackdropCrossfading, setIsBackdropCrossfading] = useState(false)
  const [cueState, setCueState] = useState<CueState>('hidden')
  const [heroPhase, setHeroPhase] = useState<HeroPhase>('steady')
  const [fullscreenTitleOverflows, setFullscreenTitleOverflows] = useState(false)
  const [showLyricsDock, setShowLyricsDock] = useState(false)

  const backdropRequestTokenRef = useRef(0)
  const previousTrackIdRef = useRef<string | null>(null)
  const enterResetTimeoutRef = useRef<number | null>(null)
  const backdropCrossfadeTimeoutRef = useRef<number | null>(null)
  const heroEnterRafRef = useRef<number | null>(null)
  const lastLyricsRequestKeyRef = useRef<string | null>(null)
  const fullscreenTitleOuterRef = useRef<HTMLHeadingElement>(null)
  const fullscreenTitleInnerRef = useRef<HTMLSpanElement>(null)
  const activeLyricLineRef = useRef<HTMLParagraphElement | null>(null)
  const [activeLyricFontSizePx, setActiveLyricFontSizePx] = useState<number | null>(null)

  const isPlaying = playbackState === 'playing'
  const isLoadingTrack = playbackState === 'loading'
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
  const effectiveDelaySec = Math.max(0, effectiveDelayMs / 1000)
  const compensatedTime = duration > 0
    ? Math.max(0, Math.min(duration, currentTime - effectiveDelaySec))
    : 0
  const remaining = duration > 0 ? Math.max(0, duration - compensatedTime) : 0
  const progress = duration > 0 ? Math.max(0, Math.min(100, (compensatedTime / duration) * 100)) : 0
  const showingRemainingTime = waveformTimeDisplayMode === 'remaining'
  const rightTimeLabel = showingRemainingTime ? `-${formatTime(remaining)}` : formatTime(duration)
  const rightTimeToggleLabel = showingRemainingTime ? 'Show track duration' : 'Show remaining time'
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
  const activeLyricsResult = useMemo(() => {
    if (!currentTrack) return null
    if (lyricsTrackPath !== currentTrack.path) return null
    return lyricsResult
  }, [currentTrack, lyricsResult, lyricsTrackPath])
  const syncedLines = useMemo(() => {
    if (activeLyricsResult?.status !== 'hit') return []
    return activeLyricsResult.lyrics.syncedLines
  }, [activeLyricsResult])
  const activeSyncedLineIndex = useMemo(
    () => findActiveSyncedLineIndex(syncedLines, compensatedTime),
    [compensatedTime, syncedLines]
  )
  const hasSyncedLyrics = syncedLines.length > 0
  const effectiveSyncedLineIndex = activeSyncedLineIndex >= 0 ? activeSyncedLineIndex : 0
  const activeSyncedLineText = syncedLines[effectiveSyncedLineIndex]?.text ?? ''
  const syncedLyricsTrackOffsetY = (
    lyricsDockLayout.activeAnchorIndex - effectiveSyncedLineIndex
  ) * lyricsDockLayout.lineHeightPx
  const lyricsDockStyle = useMemo(() => ({
    '--fullscreen-lyrics-line-height': `${lyricsDockLayout.lineHeightPx}px`,
    '--fullscreen-lyrics-visible-lines': String(lyricsDockLayout.visibleLines),
    '--fullscreen-lyrics-open-height': `${lyricsDockLayout.openHeightPx}px`
  } as CSSProperties), [lyricsDockLayout.lineHeightPx, lyricsDockLayout.openHeightPx, lyricsDockLayout.visibleLines])

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

  const setActiveLyricLineNode = useCallback((node: HTMLParagraphElement | null) => {
    activeLyricLineRef.current = node
  }, [])

  const recalculateActiveLyricFontSize = useCallback(() => {
    const node = activeLyricLineRef.current
    if (!showLyricsDock || !hasSyncedLyrics || !node) {
      setActiveLyricFontSizePx((previous) => (previous === null ? previous : null))
      return
    }

    const previousInlineFontSize = node.style.fontSize
    if (previousInlineFontSize.length > 0) {
      node.style.fontSize = ''
    }

    const textNode = node.querySelector('.fullscreen-lyrics-dock-line-text') as HTMLSpanElement | null
    const baseFontSizePx = Number.parseFloat(window.getComputedStyle(node).fontSize)
    const availableWidthPx = textNode?.clientWidth ?? node.clientWidth
    const contentWidthPx = textNode?.scrollWidth ?? node.scrollWidth

    if (previousInlineFontSize.length > 0) {
      node.style.fontSize = previousInlineFontSize
    }

    if (
      !Number.isFinite(baseFontSizePx)
      || baseFontSizePx <= 0
      || availableWidthPx <= 0
      || contentWidthPx <= availableWidthPx + 0.5
    ) {
      setActiveLyricFontSizePx((previous) => (previous === null ? previous : null))
      return
    }

    const minFontSizePx = baseFontSizePx * ACTIVE_LYRIC_MIN_SCALE
    const fitScale = availableWidthPx / contentWidthPx
    const unclampedTargetPx = baseFontSizePx * fitScale
    const clampedTargetPx = Math.max(minFontSizePx, Math.min(baseFontSizePx, unclampedTargetPx))
    const roundedTargetPx = Math.round(clampedTargetPx * 100) / 100
    const shouldClearOverride = roundedTargetPx >= baseFontSizePx - ACTIVE_LYRIC_FONT_SIZE_EPSILON_PX

    setActiveLyricFontSizePx((previous) => {
      const next = shouldClearOverride ? null : roundedTargetPx
      if (previous === null && next === null) return previous
      if (previous != null && next != null && Math.abs(previous - next) < ACTIVE_LYRIC_FONT_SIZE_EPSILON_PX) {
        return previous
      }
      return next
    })
  }, [hasSyncedLyrics, showLyricsDock])

  const cueProgress = Math.max(0, Math.min(1, (10 - Math.min(10, remaining)) / 10))
  const cueCountdown = Math.max(0, Math.ceil(Math.min(10, remaining)))
  const canShowNextCue =
    playbackState === 'playing' &&
    duration > 0 &&
    repeat !== 'one' &&
    Boolean(nextTrack)

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
        setShowLyricsDock((visible) => !visible)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [setFullscreen])

  useEffect(() => {
    checkFullscreenTitleOverflow()
  }, [currentTrack?.title, checkFullscreenTitleOverflow])

  useEffect(() => {
    if (!showLyricsDock) {
      lastLyricsRequestKeyRef.current = null
      return
    }

    const requestKey = lyricsQuery
      ? `${lyricsQuery.path}\u0000${lyricsQuery.title}\u0000${lyricsQuery.artist}\u0000${lyricsQuery.album ?? ''}\u0000${lyricsQuery.durationSeconds ?? ''}`
      : '__none__'
    if (lastLyricsRequestKeyRef.current === requestKey) return
    lastLyricsRequestKeyRef.current = requestKey
    void loadLyricsForTrack(lyricsQuery)
  }, [loadLyricsForTrack, lyricsQuery, showLyricsDock])

  useEffect(() => {
    const outer = fullscreenTitleOuterRef.current
    if (!outer) return

    const resizeObserver = new ResizeObserver(checkFullscreenTitleOverflow)
    resizeObserver.observe(outer)
    return () => resizeObserver.disconnect()
  }, [checkFullscreenTitleOverflow])

  useLayoutEffect(() => {
    recalculateActiveLyricFontSize()
  }, [
    recalculateActiveLyricFontSize,
    activeSyncedLineIndex,
    activeSyncedLineText,
    lyricsDockLayout.lineHeightPx,
    lyricsDockLayout.visibleLines,
    showLyricsDock
  ])

  useEffect(() => {
    if (!showLyricsDock || !hasSyncedLyrics) return
    const node = activeLyricLineRef.current
    if (!node) return

    const resizeObserver = new ResizeObserver(() => {
      recalculateActiveLyricFontSize()
    })
    resizeObserver.observe(node)

    return () => {
      resizeObserver.disconnect()
    }
  }, [
    activeSyncedLineIndex,
    activeSyncedLineText,
    hasSyncedLyrics,
    recalculateActiveLyricFontSize,
    showLyricsDock
  ])

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

      const artworkCandidates: string[] = []

      if (currentTrack.artworkHash) {
        try {
          const hashArtwork = await getArtwork(currentTrack.artworkHash)
          if (backdropRequestTokenRef.current !== requestToken) return
          if (hashArtwork) {
            artworkCandidates.push(hashArtwork)
          }
        } catch {
          if (backdropRequestTokenRef.current !== requestToken) return
        }
      }

      if (currentTrack.artworkData) {
        artworkCandidates.push(currentTrack.artworkData)
      }

      const uniqueCandidates = [...new Set(artworkCandidates)]
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
    setCueState('hidden')

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
  }, [canShowNextCue, remaining])

  return (
    <div
      className="fullscreen-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Fullscreen player"
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
            className={`fullscreen-hero fullscreen-hero-${heroPhase}`}
          >
            <div className="fullscreen-hero-topbar">
              <span className="fullscreen-status-label">
                {isLoadingTrack ? 'Loading' : isPlaying ? 'Now Playing' : currentTrack ? 'Paused' : 'Ready'}
              </span>
              <button
                type="button"
                className={`fullscreen-lyrics-toggle ${showLyricsDock ? 'active' : ''}`}
                onClick={() => setShowLyricsDock((visible) => !visible)}
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
                  <AlbumArtwork hash={currentTrack.artworkHash} alt="Album art" />
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
                {(showAtmosBadge || isMultichannel) && (
                  <div className="fullscreen-audio-badges">
                    {showAtmosBadge && (
                      <span className="fullscreen-audio-badge fullscreen-audio-badge-atmos">
                        ATMOS
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

            <div className="fullscreen-controls">
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
                onSeek={(time) => {
                  const rawSeekTime = Math.max(0, Math.min(duration, time + effectiveDelaySec))
                  void seek(rawSeekTime)
                }}
              />
            </div>

            <div className="fullscreen-footer">
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

          <section
            className={`fullscreen-lyrics-dock ${showLyricsDock ? 'is-open' : ''}`}
            style={lyricsDockStyle}
            aria-hidden={!showLyricsDock}
          >
            <div className="fullscreen-lyrics-dock-glass">
              <div className="fullscreen-lyrics-dock-head">
                <span className="fullscreen-lyrics-dock-label">Lyrics</span>
                {activeLyricsResult?.status === 'hit' && (
                  <span className="fullscreen-lyrics-dock-source">
                    {getLyricsSourceLabel(activeLyricsResult.lyrics.source)}
                    {hasSyncedLyrics ? ' • Synced' : ' • Unsynced'}
                    {activeLyricsResult.cached ? ' • Cached' : ''}
                  </span>
                )}
              </div>

              {!currentTrack ? (
                <p className="fullscreen-lyrics-dock-state">No track selected.</p>
              ) : lyricsIsLoading && !activeLyricsResult ? (
                <p className="fullscreen-lyrics-dock-state">Loading lyrics...</p>
              ) : activeLyricsResult?.status === 'hit' && hasSyncedLyrics ? (
                <div className="fullscreen-lyrics-dock-window" aria-live="polite">
                  <div
                    className="fullscreen-lyrics-dock-track"
                    style={{ transform: `translate3d(0, ${syncedLyricsTrackOffsetY}px, 0)` }}
                  >
                    {syncedLines.map((line, index) => {
                      const distance = index - effectiveSyncedLineIndex
                      const isActiveLine = distance === 0
                      const lineClassName = [
                        'fullscreen-lyrics-dock-line',
                        isActiveLine
                          ? 'is-active'
                          : Math.abs(distance) === 1
                            ? 'is-near'
                            : Math.abs(distance) === 2
                              ? 'is-far'
                              : 'is-distant'
                      ].join(' ')

                      return (
                        <p
                          key={`${line.timestampMs}:${index}`}
                          ref={isActiveLine ? setActiveLyricLineNode : undefined}
                          className={lineClassName}
                          style={isActiveLine && activeLyricFontSizePx != null
                            ? { fontSize: `${activeLyricFontSizePx}px` }
                            : undefined}
                        >
                          <span className="fullscreen-lyrics-dock-line-text">{line.text}</span>
                        </p>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <p className="fullscreen-lyrics-dock-state fullscreen-lyrics-dock-state-not-found">
                  Lyrics not synced or not found.
                </p>
              )}
            </div>
          </section>
        </div>
      </div>

      {nextTrack && (
        <aside
          className={`fullscreen-next-cue fullscreen-next-cue-${cueState}`}
          aria-hidden={cueState === 'hidden'}
        >
          <div className="fullscreen-next-cue-card">
            <div className="fullscreen-next-cue-artwork">
              {nextTrack.artworkHash ? (
                <AlbumArtwork hash={nextTrack.artworkHash} alt="Up next artwork" />
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
      )}
    </div>
  )
}
