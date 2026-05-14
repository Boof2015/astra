import { type CSSProperties, type Dispatch, type ReactElement, type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { usePlayerStore } from '../../stores/playerStore'
import { useLibraryStore } from '../../stores/libraryStore'
import { useAudioSettingsStore } from '../../stores/audioSettingsStore'
import { useLyricsStore } from '../../stores/lyricsStore'
import AlbumArtwork from '../library/AlbumArtwork'
import WaveformSeekBar from '../player/WaveformSeekBar'
import VolumeControl from '../player/VolumeControl'
import FullscreenAmbientSpectrum from './FullscreenAmbientSpectrum'
import { usePlaybackClock } from '../../hooks/usePlaybackClock'
import { getFullscreenBackdropArtworkCandidates } from '../../utils/fullscreenBackdropArtwork'
import {
  getCompensatedLyricsTime,
  getLyricsSourceLabel,
  getSyncedLyricsGapProgress,
  getSyncedLyricsDisplayLines,
  resolveSyncedLyricsTiming
} from '../../utils/lyricsPresentation'
import type { LyricsTrackQuery } from '../../../types/lyrics'

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

interface LyricsLineMeasurement {
  key: string
  topPx: number
  heightPx: number
}

function areLyricsLineMeasurementsEqual(
  current: LyricsLineMeasurement[],
  next: LyricsLineMeasurement[]
): boolean {
  if (current.length !== next.length) return false
  return current.every((measurement, index) => {
    const nextMeasurement = next[index]
    return measurement.key === nextMeasurement.key
      && measurement.topPx === nextMeasurement.topPx
      && measurement.heightPx === nextMeasurement.heightPx
  })
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

function FullscreenWaveformSection(): ReactElement {
  const waveformTimeDisplayMode = useUIStore((s) => s.waveformTimeDisplayMode)
  const toggleWaveformTimeDisplayMode = useUIStore((s) => s.toggleWaveformTimeDisplayMode)
  const currentTime = usePlaybackClock()
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

function FullscreenLyricsDockPanel({
  currentTrack,
  showLyricsDock,
  lyricsDockLayout,
}: {
  currentTrack: {
    path: string
    title: string
    artist: string
    album: string
    duration: number
  } | null
  showLyricsDock: boolean
  lyricsDockLayout: LyricsDockLayout
}): ReactElement {
  const currentTime = usePlaybackClock()
  const duration = usePlayerStore((s) => s.duration)
  const effectiveDelayMs = useAudioSettingsStore((s) => s.effectiveDelayMs)
  const lyricsTrackPath = useLyricsStore((s) => s.currentTrackPath)
  const lyricsResult = useLyricsStore((s) => s.currentResult)
  const lyricsIsLoading = useLyricsStore((s) => s.isLoading)
  const loadLyricsForTrack = useLyricsStore((s) => s.loadForTrack)
  const activeLyricLineRef = useRef<HTMLParagraphElement | null>(null)
  const lyricsDockTrackRef = useRef<HTMLDivElement | null>(null)
  const lastLyricsRequestKeyRef = useRef<string | null>(null)
  const [activeLyricFontSizePx, setActiveLyricFontSizePx] = useState<number | null>(null)
  const [lyricsLineMeasurements, setLyricsLineMeasurements] = useState<LyricsLineMeasurement[]>([])

  const compensatedTime = getCompensatedLyricsTime(currentTime, duration, effectiveDelayMs)
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
  const displayedSyncedLines = useMemo(
    () => getSyncedLyricsDisplayLines(syncedLines, { durationSeconds: duration }),
    [duration, syncedLines]
  )
  const displayedSyncedLineKeys = useMemo(
    () => displayedSyncedLines.map((line) => line.key).join('\u0000'),
    [displayedSyncedLines]
  )
  const lyricsLineMeasurementByKey = useMemo(() => {
    const measurementByKey = new Map<string, LyricsLineMeasurement>()
    lyricsLineMeasurements.forEach((measurement) => measurementByKey.set(measurement.key, measurement))
    return measurementByKey
  }, [lyricsLineMeasurements])
  const syncedLyricsTiming = useMemo(
    () => resolveSyncedLyricsTiming(syncedLines, compensatedTime, { durationSeconds: duration }),
    [compensatedTime, duration, syncedLines]
  )
  const activeSyncedLineIndex = syncedLyricsTiming.activeLineIndex
  const hasSyncedLyrics = displayedSyncedLines.some((line) => line.kind === 'lyric')
  const effectiveSyncedLineIndex = syncedLyricsTiming.focusLineIndex >= 0 ? syncedLyricsTiming.focusLineIndex : 0
  const activeSyncedLineText = activeSyncedLineIndex >= 0
    ? displayedSyncedLines[activeSyncedLineIndex]?.text ?? ''
    : ''
  const focusedSyncedLineKey = displayedSyncedLines[effectiveSyncedLineIndex]?.key ?? null
  const focusedSyncedLineMeasurement = focusedSyncedLineKey
    ? lyricsLineMeasurementByKey.get(focusedSyncedLineKey)
    : null
  const focusedSyncedLineTopPx = focusedSyncedLineMeasurement?.topPx
    ?? (effectiveSyncedLineIndex * lyricsDockLayout.lineHeightPx)
  const focusedSyncedLineHeightPx = focusedSyncedLineMeasurement?.heightPx
    ?? lyricsDockLayout.lineHeightPx
  const syncedLyricsAnchorCenterPx = (
    lyricsDockLayout.activeAnchorIndex + 0.5
  ) * lyricsDockLayout.lineHeightPx
  const syncedLyricsTrackOffsetY = syncedLyricsAnchorCenterPx
    - focusedSyncedLineTopPx
    - (focusedSyncedLineHeightPx / 2)
  const lyricsDockStyle = useMemo(() => ({
    '--fullscreen-lyrics-line-height': `${lyricsDockLayout.lineHeightPx}px`,
    '--fullscreen-lyrics-visible-lines': String(lyricsDockLayout.visibleLines),
    '--fullscreen-lyrics-open-height': `${lyricsDockLayout.openHeightPx}px`
  } as CSSProperties), [lyricsDockLayout.lineHeightPx, lyricsDockLayout.openHeightPx, lyricsDockLayout.visibleLines])

  const setActiveLyricLineNode = useCallback((node: HTMLParagraphElement | null) => {
    activeLyricLineRef.current = node
  }, [])

  const measureSyncedLyricLines = useCallback(() => {
    if (!showLyricsDock || !hasSyncedLyrics) {
      setLyricsLineMeasurements((previous) => previous.length === 0 ? previous : [])
      return
    }

    const track = lyricsDockTrackRef.current
    if (!track) {
      setLyricsLineMeasurements((previous) => previous.length === 0 ? previous : [])
      return
    }

    const nextMeasurements: LyricsLineMeasurement[] = []
    track.querySelectorAll<HTMLParagraphElement>('.fullscreen-lyrics-dock-line[data-lyrics-line-key]').forEach((node) => {
      const key = node.dataset.lyricsLineKey
      if (!key) return
      nextMeasurements.push({
        key,
        topPx: node.offsetTop,
        heightPx: Math.max(lyricsDockLayout.lineHeightPx, node.offsetHeight)
      })
    })

    setLyricsLineMeasurements((previous) => (
      areLyricsLineMeasurementsEqual(previous, nextMeasurements) ? previous : nextMeasurements
    ))
  }, [hasSyncedLyrics, lyricsDockLayout.lineHeightPx, showLyricsDock])

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

  useLayoutEffect(() => {
    measureSyncedLyricLines()
  }, [
    activeLyricFontSizePx,
    activeSyncedLineIndex,
    activeSyncedLineText,
    displayedSyncedLineKeys,
    effectiveSyncedLineIndex,
    lyricsDockLayout.visibleLines,
    measureSyncedLyricLines,
    showLyricsDock
  ])

  useEffect(() => {
    if (!showLyricsDock || !hasSyncedLyrics) return
    const node = activeLyricLineRef.current
    const track = lyricsDockTrackRef.current
    if (!node && !track) return

    const resizeObserver = new ResizeObserver(() => {
      recalculateActiveLyricFontSize()
      measureSyncedLyricLines()
    })
    if (node) resizeObserver.observe(node)
    if (track) resizeObserver.observe(track)

    return () => {
      resizeObserver.disconnect()
    }
  }, [
    activeSyncedLineIndex,
    activeSyncedLineText,
    displayedSyncedLineKeys,
    hasSyncedLyrics,
    measureSyncedLyricLines,
    recalculateActiveLyricFontSize,
    showLyricsDock
  ])

  const renderGapProgress = (displayLine: (typeof displayedSyncedLines)[number]) => {
    const progress = getSyncedLyricsGapProgress(displayLine, compensatedTime)
    if (progress === null) return displayLine.text
    return (
      <span className="lyrics-gap-progress">
        <span
          className="lyrics-gap-progress-fill"
          style={{ transform: `scaleX(${progress})` }}
        />
      </span>
    )
  }

  return (
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
              ref={lyricsDockTrackRef}
              className="fullscreen-lyrics-dock-track"
              style={{ transform: `translate3d(0, ${syncedLyricsTrackOffsetY}px, 0)` }}
            >
              {displayedSyncedLines.map((displayLine) => {
                const { displayIndex } = displayLine
                const distance = displayIndex - effectiveSyncedLineIndex
                const isActiveLine = displayLine.kind === 'lyric' && displayIndex === activeSyncedLineIndex
                const lineClassName = [
                  'fullscreen-lyrics-dock-line',
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
                    ref={isActiveLine ? setActiveLyricLineNode : undefined}
                    className={lineClassName}
                    style={isActiveLine && activeLyricFontSizePx != null
                      ? { fontSize: `${activeLyricFontSizePx}px` }
                      : undefined}
                    data-lyrics-line-key={displayLine.key}
                    aria-hidden={displayLine.kind === 'gap'}
                  >
                    <span className="fullscreen-lyrics-dock-line-text">{renderGapProgress(displayLine)}</span>
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
  const currentTime = usePlaybackClock()
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
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const playbackState = usePlayerStore((s) => s.playbackState)
  const shuffle = usePlayerStore((s) => s.shuffle)
  const repeat = usePlayerStore((s) => s.repeat)
  const currentTrackSource = usePlayerStore((s) => s.currentTrackSource)
  const playbackFuture = usePlayerStore((s) => s.playbackFuture)
  const userQueue = usePlayerStore((s) => s.userQueue)
  const autoQueue = usePlayerStore((s) => s.autoQueue)
  const autoQueueIndex = usePlayerStore((s) => s.autoQueueIndex)
  const shuffledAutoIndices = usePlayerStore((s) => s.shuffledAutoIndices)
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
  const [heroPhase, setHeroPhase] = useState<HeroPhase>('steady')
  const [fullscreenTitleOverflows, setFullscreenTitleOverflows] = useState(false)
  const [showLyricsDock, setShowLyricsDock] = useState(false)

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
    autoQueue,
    autoQueueIndex,
    currentTrack,
    currentTrackSource,
    playbackFuture,
    repeat,
    shuffle,
    shuffledAutoIndices,
    userQueue
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

            <FullscreenWaveformSection />

            <div className="fullscreen-footer">
              <div className="fullscreen-footer-primary">
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

          <FullscreenLyricsDockPanel
            currentTrack={currentTrack
              ? {
                  path: currentTrack.path,
                  title: currentTrack.title,
                  artist: currentTrack.artist,
                  album: currentTrack.album,
                  duration: currentTrack.duration
                }
              : null}
            showLyricsDock={showLyricsDock}
            lyricsDockLayout={lyricsDockLayout}
          />
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
