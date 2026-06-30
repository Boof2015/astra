import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { LyricsPopoutSnapshot } from '../../../types/lyricsPopout'
import { useLyricsSyncedView } from '../../hooks/useLyricsSyncedView'
import { useLyricsDisplaySettingsStore } from '../../stores/lyricsDisplaySettingsStore'
import LyricsLineContent from '../lyrics/LyricsLineContent'
import {
  DEFAULT_LYRICS_BODY_COPY,
  BASE_COMPACT_LYRICS_LINE_HEIGHT_PX,
  getCompactSyncedLyricsLineHeights,
  getCompensatedLyricsTime,
  getLyricsLineSeekTimeSeconds,
  getLyricsMetaChipText,
  getSyncedLyricsDisplayLines,
  resolveSyncedLyricsTiming,
  resolveLyricsBodyState
} from '../../utils/lyricsPresentation'
import '../../styles/lyrics-popout.css'

const EMPTY_SNAPSHOT: LyricsPopoutSnapshot = {
  capturedAt: 0,
  preferredExpanded: true,
  playbackState: 'stopped',
  currentTime: 0,
  duration: 0,
  effectiveDelayMs: 0,
  currentTrack: null,
  lyricsQuery: null,
  lyricsResult: null,
  isLoading: false,
  errorMessage: ''
}

function clampTime(value: number, duration: number): number {
  if (!Number.isFinite(value)) return 0
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, value)
  return Math.max(0, Math.min(duration, value))
}

function useLyricsPopoutClock(snapshot: LyricsPopoutSnapshot): number {
  const [currentTime, setCurrentTime] = useState(() => (
    getCompensatedLyricsTime(snapshot.currentTime, snapshot.duration, snapshot.effectiveDelayMs)
  ))

  useEffect(() => {
    if (snapshot.playbackState !== 'playing') {
      setCurrentTime(getCompensatedLyricsTime(snapshot.currentTime, snapshot.duration, snapshot.effectiveDelayMs))
      return
    }

    let frameId: number | null = null

    const tick = () => {
      const elapsedSeconds = Math.max(0, (Date.now() - snapshot.capturedAt) / 1000)
      const projectedTime = clampTime(snapshot.currentTime + elapsedSeconds, snapshot.duration)
      setCurrentTime(getCompensatedLyricsTime(projectedTime, snapshot.duration, snapshot.effectiveDelayMs))
      frameId = window.requestAnimationFrame(tick)
    }

    tick()
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId)
      }
    }
  }, [
    snapshot.capturedAt,
    snapshot.currentTime,
    snapshot.duration,
    snapshot.effectiveDelayMs,
    snapshot.playbackState
  ])

  return currentTime
}

export default function LyricsPopoutApp() {
  const [snapshot, setSnapshot] = useState<LyricsPopoutSnapshot>(EMPTY_SNAPSHOT)
  const [isExpanded, setIsExpanded] = useState(true)
  const hasAdoptedPreferredExpandedRef = useRef(false)
  const currentTime = useLyricsPopoutClock(snapshot)
  const lyricsDisplaySettings = useLyricsDisplaySettingsStore((s) => s.settings)
  const trackTitle = useMemo(() => snapshot.currentTrack?.title?.trim() || '', [snapshot.currentTrack?.title])
  const trackDetail = useMemo(() => (
    [snapshot.currentTrack?.artist, snapshot.currentTrack?.album]
      .filter((value): value is string => Boolean(value && value.trim()))
      .join(' • ')
  ), [snapshot.currentTrack?.album, snapshot.currentTrack?.artist])
  const trackLine = useMemo(() => (
    [trackTitle, trackDetail]
      .filter((value): value is string => Boolean(value))
      .join(' • ')
  ), [trackDetail, trackTitle])

  const adoptPreferredExpanded = (nextSnapshot: LyricsPopoutSnapshot) => {
    if (hasAdoptedPreferredExpandedRef.current) return
    hasAdoptedPreferredExpandedRef.current = true
    setIsExpanded(nextSnapshot.preferredExpanded)
  }

  useEffect(() => {
    let isMounted = true

    void window.electronAPI.lyricsPopout.getSnapshot().then((latest) => {
      if (!isMounted || !latest) return
      adoptPreferredExpanded(latest)
      setSnapshot(latest)
    })

    const unsubSnapshot = window.electronAPI.lyricsPopout.onSnapshot((next) => {
      adoptPreferredExpanded(next)
      setSnapshot(next)
    })

    return () => {
      isMounted = false
      unsubSnapshot()
    }
  }, [])

  const bodyState = useMemo(() => resolveLyricsBodyState({
    currentTrack: snapshot.currentTrack,
    activeLyricsResult: snapshot.lyricsResult,
    isLoading: snapshot.isLoading,
    errorMessage: snapshot.errorMessage,
    copy: DEFAULT_LYRICS_BODY_COPY
  }), [snapshot.currentTrack, snapshot.errorMessage, snapshot.isLoading, snapshot.lyricsResult])
  const syncedLines = bodyState.kind === 'hit_synced' ? bodyState.syncedLines : []
  const displayedSyncedLines = useMemo(
    () => getSyncedLyricsDisplayLines(syncedLines, { durationSeconds: snapshot.duration }),
    [snapshot.duration, syncedLines]
  )
  const compactSyncedLineHeightsPx = useMemo(
    () => getCompactSyncedLyricsLineHeights(displayedSyncedLines, lyricsDisplaySettings),
    [displayedSyncedLines, lyricsDisplaySettings]
  )
  const getCompactLineStyle = useCallback((displayIndex: number) => ({
    '--transport-lyrics-focus-row-height': `${
      compactSyncedLineHeightsPx[displayIndex] ?? BASE_COMPACT_LYRICS_LINE_HEIGHT_PX
    }px`
  } as CSSProperties), [compactSyncedLineHeightsPx])
  const hasSyncedLyrics = displayedSyncedLines.some((line) => line.kind === 'lyric')
  const syncedLyricsTiming = useMemo(
    () => resolveSyncedLyricsTiming(syncedLines, currentTime, { durationSeconds: snapshot.duration }),
    [currentTime, snapshot.duration, syncedLines]
  )
  const activeSyncedLineIndex = syncedLyricsTiming.activeLineIndex
  const metaChipText = useMemo(() => (
    getLyricsMetaChipText({
      currentTrack: snapshot.currentTrack,
      activeLyricsResult: snapshot.lyricsResult,
      hasSyncedLyrics,
      isLoading: snapshot.isLoading,
      errorMessage: snapshot.errorMessage
    })
  ), [hasSyncedLyrics, snapshot.currentTrack, snapshot.errorMessage, snapshot.isLoading, snapshot.lyricsResult])

  const {
    followPaused,
    collapsedWindowStyle,
    collapsedTrackStyle,
    effectiveSyncedLineIndex,
    expandedListRef,
    setFollowPaused,
    setSyncedLineRef,
    pauseFollowFromManualScroll,
    handleRecenter
  } = useLyricsSyncedView({
    isOpen: true,
    isExpanded,
    hasSyncedLyrics,
    activeSyncedLineIndex,
    focusedSyncedLineIndex: syncedLyricsTiming.focusLineIndex,
    contentKey: snapshot.currentTrack?.path ?? null,
    collapsedLineHeightsPx: compactSyncedLineHeightsPx
  })

  const handleLyricsLineSeek = useCallback((seekTimeSeconds: number) => {
    setFollowPaused(false)
    window.electronAPI.lyricsPopout.sendCommand({ type: 'seek', time: seekTimeSeconds })
  }, [setFollowPaused])

  const renderCompactSyncedWindow = () => (
    <div
      key="lyrics-popout-collapsed-window"
      className="transport-lyrics-focus-window"
      style={collapsedWindowStyle}
      aria-live="polite"
    >
      <div
        className="transport-lyrics-focus-track"
        style={collapsedTrackStyle}
      >
        {displayedSyncedLines.map((displayLine) => {
          const { displayIndex } = displayLine
          const distance = displayIndex - effectiveSyncedLineIndex
          const className = [
            'transport-lyrics-focus-line',
            displayLine.kind === 'gap' ? 'is-gap' : '',
            displayLine.kind === 'lyric' && displayIndex === activeSyncedLineIndex
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
              className={className}
              style={getCompactLineStyle(displayIndex)}
              aria-hidden={displayLine.kind === 'gap'}
            >
              <LyricsLineContent
                displayLine={displayLine}
                currentTimeSeconds={currentTime}
                isActive={displayLine.kind === 'lyric' && displayIndex === activeSyncedLineIndex}
                settings={lyricsDisplaySettings}
                seekTimeSeconds={displayLine.kind === 'lyric'
                  ? getLyricsLineSeekTimeSeconds(displayLine.timestampMs, snapshot.duration, snapshot.effectiveDelayMs)
                  : null}
                seekTabIndex={Math.abs(distance) <= 1 ? undefined : -1}
                onSeek={handleLyricsLineSeek}
              />
            </p>
          )
        })}
      </div>
    </div>
  )

  const renderBody = () => {
    if (!isExpanded) {
      if (bodyState.kind === 'hit_synced') {
        return renderCompactSyncedWindow()
      }
      if (bodyState.kind === 'no-track' || bodyState.kind === 'loading') {
        return <p className="transport-lyrics-shelf-state">{bodyState.message}</p>
      }
      if (bodyState.kind === 'transient_error') {
        return (
          <div className="transport-lyrics-shelf-state transport-lyrics-shelf-state-error">
            <p>{bodyState.message}</p>
          </div>
        )
      }
      return (
        <p className="transport-lyrics-shelf-state transport-lyrics-shelf-state-not-found">
          {bodyState.kind === 'not_found' && bodyState.reason === 'provider-unavailable'
            ? bodyState.message
            : 'Lyrics not synced or not found.'}
        </p>
      )
    }

    if (bodyState.kind === 'hit_synced') {
      return (
        <div
          ref={expandedListRef}
          className="transport-lyrics-expanded-list"
          onWheel={pauseFollowFromManualScroll}
          onTouchStart={pauseFollowFromManualScroll}
          aria-live="polite"
        >
          {displayedSyncedLines.map((displayLine) => (
            <p
              key={displayLine.key}
              ref={setSyncedLineRef(displayLine.displayIndex)}
              className={[
                'transport-lyrics-expanded-line',
                displayLine.kind === 'gap' ? 'is-gap' : '',
                displayLine.kind === 'lyric' && displayLine.displayIndex === activeSyncedLineIndex ? 'active' : ''
              ].join(' ').trim()}
              aria-hidden={displayLine.kind === 'gap'}
            >
              <LyricsLineContent
                displayLine={displayLine}
                currentTimeSeconds={currentTime}
                isActive={displayLine.kind === 'lyric' && displayLine.displayIndex === activeSyncedLineIndex}
                settings={lyricsDisplaySettings}
                seekTimeSeconds={displayLine.kind === 'lyric'
                  ? getLyricsLineSeekTimeSeconds(displayLine.timestampMs, snapshot.duration, snapshot.effectiveDelayMs)
                  : null}
                onSeek={handleLyricsLineSeek}
              />
            </p>
          ))}
        </div>
      )
    }

    if (bodyState.kind === 'hit_plain') {
      return <pre className="transport-lyrics-expanded-plain">{bodyState.plainLyrics}</pre>
    }

    return (
      <p className={`transport-lyrics-shelf-state ${bodyState.kind === 'transient_error' ? 'transport-lyrics-shelf-state-error' : 'transport-lyrics-shelf-state-not-found'}`.trim()}>
        {bodyState.message}
      </p>
    )
  }

  return (
    <main className="lyrics-popout-root">
      <section className={`transport-lyrics-shelf-content lyrics-popout-panel ${isExpanded ? 'is-expanded' : 'is-compact'}`.trim()}>
        <div className="lyrics-popout-top" title={trackLine || 'No track selected'}>
          <div className="lyrics-popout-top-drag-region" aria-hidden="true" />
          <header className="transport-lyrics-shelf-header lyrics-popout-top-header">
            <span className="transport-lyrics-shelf-label lyrics-popout-top-text">Lyrics</span>
            <span className="transport-lyrics-shelf-meta lyrics-popout-top-text">{metaChipText}</span>
            <div className="transport-lyrics-shelf-header-actions lyrics-popout-top-actions">
              {isExpanded && hasSyncedLyrics && followPaused && (
                <button
                  type="button"
                  className="transport-lyrics-recenter-btn"
                  onClick={handleRecenter}
                >
                  Recenter
                </button>
              )}
              <button
                type="button"
                className="transport-lyrics-inline-action"
                onClick={() => window.electronAPI.lyricsPopout.sendCommand({ type: 'refresh' })}
                disabled={!snapshot.currentTrack || snapshot.isLoading}
              >
                {snapshot.isLoading ? 'Loading...' : 'Refresh'}
              </button>
              <button
                type="button"
                className="transport-lyrics-inline-action"
                onClick={() => setIsExpanded((current) => !current)}
              >
                {isExpanded ? 'Compact' : 'Expand'}
              </button>
              <button
                type="button"
                className="transport-lyrics-inline-action"
                onClick={() => void window.electronAPI.lyricsPopout.close()}
              >
                Dock
              </button>
            </div>
          </header>
          <div className="lyrics-popout-subhead">
            <span className={`lyrics-popout-track-title${trackTitle ? '' : ' is-empty'}`.trim()}>
              {trackTitle || 'No track selected'}
            </span>
            {trackDetail && (
              <span className="lyrics-popout-track-detail">{trackDetail}</span>
            )}
          </div>
        </div>
        {renderBody()}
      </section>
    </main>
  )
}
