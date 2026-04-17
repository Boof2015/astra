import { useCallback, useEffect, useMemo, useRef } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import { useLyricsStore } from '../../stores/lyricsStore'
import { useLyricsPopoutStore } from '../../stores/lyricsPopoutStore'
import { usePlaybackClock } from '../../hooks/usePlaybackClock'
import { useLyricsSyncedView } from '../../hooks/useLyricsSyncedView'
import {
  buildLyricsQuery,
  DEFAULT_LYRICS_BODY_COPY,
  findActiveSyncedLineIndex,
  getActiveLyricsResult,
  getLyricsMetaChipText,
  getLyricsRequestKey,
  resolveLyricsBodyState
} from '../../utils/lyricsPresentation'

export default function TransportLyricsShelf() {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const currentTime = usePlaybackClock()
  const showLyricsShelf = useUIStore((s) => s.showLyricsShelf)
  const lyricsShelfExpanded = useUIStore((s) => s.lyricsShelfExpanded)
  const setLyricsShelfExpanded = useUIStore((s) => s.setLyricsShelfExpanded)
  const lyricsPopoutIsOpen = useLyricsPopoutStore((s) => s.windowState.isOpen)
  const lyricsTrackPath = useLyricsStore((s) => s.currentTrackPath)
  const lyricsResult = useLyricsStore((s) => s.currentResult)
  const lyricsIsLoading = useLyricsStore((s) => s.isLoading)
  const lyricsStoreError = useLyricsStore((s) => s.errorMessage)
  const loadLyricsForTrack = useLyricsStore((s) => s.loadForTrack)
  const refreshLyricsForTrack = useLyricsStore((s) => s.refreshForTrack)
  const lastLyricsRequestKeyRef = useRef<string | null>(null)

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
  const hasSyncedLyrics = syncedLines.length > 0
  const activeSyncedLineIndex = useMemo(
    () => findActiveSyncedLineIndex(syncedLines, currentTime),
    [currentTime, syncedLines]
  )
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
    followPaused,
    collapsedTrackStyle,
    effectiveSyncedLineIndex,
    expandedListRef,
    setSyncedLineRef,
    pauseFollowFromManualScroll,
    handleRecenter
  } = useLyricsSyncedView({
    isOpen: showLyricsShelf && !lyricsPopoutIsOpen,
    isExpanded: lyricsShelfExpanded,
    hasSyncedLyrics,
    activeSyncedLineIndex,
    contentKey: currentTrack?.path ?? null
  })

  const refreshLyrics = useCallback(() => {
    if (!lyricsQuery) return
    void refreshLyricsForTrack(lyricsQuery)
  }, [lyricsQuery, refreshLyricsForTrack])

  useEffect(() => {
    if (!showLyricsShelf) {
      lastLyricsRequestKeyRef.current = null
      return
    }
    const requestKey = getLyricsRequestKey(lyricsQuery)
    if (lastLyricsRequestKeyRef.current === requestKey) return
    lastLyricsRequestKeyRef.current = requestKey
    void loadLyricsForTrack(lyricsQuery)
  }, [loadLyricsForTrack, lyricsQuery, showLyricsShelf])

  const renderCollapsedSyncedWindow = () => (
    <div key="lyrics-collapsed-window" className="transport-lyrics-focus-window" aria-live="polite">
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
    if (!lyricsShelfExpanded) {
      if (bodyState.kind === 'hit_synced') {
        return renderCollapsedSyncedWindow()
      }
      if (bodyState.kind === 'no-track' || bodyState.kind === 'loading') {
        return <p className="transport-lyrics-shelf-state">{bodyState.message}</p>
      }
      if (bodyState.kind === 'transient_error') {
        return (
          <div className="transport-lyrics-shelf-state transport-lyrics-shelf-state-error">
            <p>{bodyState.message}</p>
            <button
              type="button"
              className="transport-lyrics-inline-action"
              onClick={refreshLyrics}
              disabled={lyricsIsLoading}
            >
              Retry
            </button>
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
          key="lyrics-expanded-list"
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

  if (lyricsPopoutIsOpen) {
    return (
      <section
        className={[
          'transport-lyrics-shelf',
          showLyricsShelf ? 'transport-lyrics-shelf-open' : '',
          'transport-lyrics-shelf-stub'
        ].join(' ').trim()}
        aria-hidden={!showLyricsShelf}
      >
        <div className="transport-lyrics-shelf-content">
          <header className="transport-lyrics-shelf-header">
            <span className="transport-lyrics-shelf-label">Lyrics</span>
            <span className="transport-lyrics-shelf-meta">Popped Out</span>
            <div className="transport-lyrics-shelf-header-actions">
              <button
                type="button"
                className="transport-lyrics-inline-action"
                onClick={() => void window.electronAPI.lyricsPopout.open()}
              >
                Show Window
              </button>
              <button
                type="button"
                className="transport-lyrics-inline-action"
                onClick={() => void window.electronAPI.lyricsPopout.close()}
              >
                Recall
              </button>
            </div>
          </header>
          <div className="transport-lyrics-popout-stub-body">
            <p className="transport-lyrics-popout-stub-message">
              Lyrics are detached in a floating window.
            </p>
            <p className="transport-lyrics-popout-stub-track">
              {currentTrack
                ? `${currentTrack.title} • ${currentTrack.artist}`
                : 'No track selected.'}
            </p>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section
      className={[
        'transport-lyrics-shelf',
        showLyricsShelf ? 'transport-lyrics-shelf-open' : '',
        lyricsShelfExpanded ? 'transport-lyrics-shelf-expanded' : ''
      ].join(' ').trim()}
      aria-hidden={!showLyricsShelf}
    >
      <div className="transport-lyrics-shelf-content">
        <header className="transport-lyrics-shelf-header">
          <span className="transport-lyrics-shelf-label">Lyrics</span>
          <span className="transport-lyrics-shelf-meta">{metaChipText}</span>
          <div className="transport-lyrics-shelf-header-actions">
            {lyricsShelfExpanded && hasSyncedLyrics && followPaused && (
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
              onClick={refreshLyrics}
              disabled={!currentTrack || lyricsIsLoading}
            >
              {lyricsIsLoading ? 'Loading...' : 'Refresh'}
            </button>
            <button
              type="button"
              className="transport-lyrics-inline-action"
              onClick={() => void window.electronAPI.lyricsPopout.open()}
              disabled={!currentTrack}
            >
              Pop Out
            </button>
            <button
              type="button"
              className={`transport-lyrics-shelf-chevron${lyricsShelfExpanded ? ' expanded' : ''}`}
              onClick={() => setLyricsShelfExpanded(!lyricsShelfExpanded)}
              title={lyricsShelfExpanded ? 'Collapse lyrics shelf' : 'Expand lyrics shelf'}
              aria-label={lyricsShelfExpanded ? 'Collapse lyrics shelf' : 'Expand lyrics shelf'}
            >
              <svg width="12" height="8" viewBox="0 0 12 8" fill="none">
                <path
                  d="M1 1.5L6 6.5L11 1.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </header>
        {renderBody()}
      </div>
    </section>
  )
}
