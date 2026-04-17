import { useEffect, useMemo, useRef, useState } from 'react'
import type { LyricsPopoutSnapshot } from '../../../types/lyricsPopout'
import { useLyricsSyncedView } from '../../hooks/useLyricsSyncedView'
import {
  DEFAULT_LYRICS_BODY_COPY,
  findActiveSyncedLineIndex,
  getLyricsMetaChipText,
  resolveLyricsBodyState
} from '../../utils/lyricsPresentation'
import '../../styles/lyrics-popout.css'

const EMPTY_SNAPSHOT: LyricsPopoutSnapshot = {
  capturedAt: 0,
  preferredExpanded: true,
  playbackState: 'stopped',
  currentTime: 0,
  duration: 0,
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
  const [currentTime, setCurrentTime] = useState(snapshot.currentTime)

  useEffect(() => {
    if (snapshot.playbackState !== 'playing') {
      setCurrentTime(snapshot.currentTime)
      return
    }

    let frameId: number | null = null

    const tick = () => {
      const elapsedSeconds = Math.max(0, (Date.now() - snapshot.capturedAt) / 1000)
      setCurrentTime(clampTime(snapshot.currentTime + elapsedSeconds, snapshot.duration))
      frameId = window.requestAnimationFrame(tick)
    }

    tick()
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId)
      }
    }
  }, [snapshot.capturedAt, snapshot.currentTime, snapshot.duration, snapshot.playbackState])

  return currentTime
}

export default function LyricsPopoutApp() {
  const [snapshot, setSnapshot] = useState<LyricsPopoutSnapshot>(EMPTY_SNAPSHOT)
  const [isExpanded, setIsExpanded] = useState(true)
  const hasAdoptedPreferredExpandedRef = useRef(false)
  const currentTime = useLyricsPopoutClock(snapshot)
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
  const hasSyncedLyrics = syncedLines.length > 0
  const activeSyncedLineIndex = useMemo(
    () => findActiveSyncedLineIndex(syncedLines, currentTime),
    [currentTime, syncedLines]
  )
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
    collapsedTrackStyle,
    effectiveSyncedLineIndex,
    expandedListRef,
    setSyncedLineRef,
    pauseFollowFromManualScroll,
    handleRecenter
  } = useLyricsSyncedView({
    isOpen: true,
    isExpanded,
    hasSyncedLyrics,
    activeSyncedLineIndex,
    contentKey: snapshot.currentTrack?.path ?? null
  })

  const renderCompactSyncedWindow = () => (
    <div key="lyrics-popout-collapsed-window" className="transport-lyrics-focus-window" aria-live="polite">
      <div
        className="transport-lyrics-focus-track"
        style={collapsedTrackStyle}
      >
        {syncedLines.map((line, index) => {
          const distance = index - effectiveSyncedLineIndex
          const className = [
            'transport-lyrics-focus-line',
            distance === 0
              ? 'is-active'
              : Math.abs(distance) === 1
                ? 'is-near'
                : Math.abs(distance) === 2
                  ? 'is-far'
                  : 'is-distant'
          ].join(' ')
          return (
            <p key={`${line.timestampMs}:${index}`} className={className}>
              {line.text}
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
          Lyrics not synced or not found.
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
          {bodyState.syncedLines.map((line, index) => (
            <p
              key={`${line.timestampMs}:${index}`}
              ref={setSyncedLineRef(index)}
              className={`transport-lyrics-expanded-line ${index === activeSyncedLineIndex ? 'active' : ''}`}
            >
              {line.text}
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
