import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import { useLyricsStore } from '../../stores/lyricsStore'
import { usePlaybackClock } from '../../hooks/usePlaybackClock'
import type { Track } from '../../types/audio'
import type { LyricsLine, LyricsTrackQuery } from '../../../types/lyrics'

const COLLAPSED_LINE_HEIGHT_PX = 34
const COLLAPSED_ACTIVE_ANCHOR_INDEX = 1
const PROGRAMMATIC_SCROLL_RESET_MS = 300
const EXPANDED_OPEN_RECENTER_DELAY_MS = 360

function getLyricsSourceLabel(source: 'embedded' | 'lrclib' | 'manual'): string {
  if (source === 'embedded') return 'Embedded'
  if (source === 'manual') return 'Manual'
  return 'LRCLIB'
}

function buildLyricsQuery(track: Track | null): LyricsTrackQuery | null {
  if (!track) return null
  return {
    path: track.path,
    title: track.title,
    artist: track.artist,
    album: track.album || undefined,
    durationSeconds: Number.isFinite(track.duration) ? track.duration : undefined
  }
}

function getLyricsRequestKey(query: LyricsTrackQuery | null): string {
  if (!query) return '__none__'
  return `${query.path}\u0000${query.title}\u0000${query.artist}\u0000${query.album ?? ''}\u0000${query.durationSeconds ?? ''}`
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

export default function TransportLyricsShelf() {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const currentTime = usePlaybackClock()
  const showLyricsShelf = useUIStore((s) => s.showLyricsShelf)
  const lyricsShelfExpanded = useUIStore((s) => s.lyricsShelfExpanded)
  const setLyricsShelfExpanded = useUIStore((s) => s.setLyricsShelfExpanded)
  const lyricsTrackPath = useLyricsStore((s) => s.currentTrackPath)
  const lyricsResult = useLyricsStore((s) => s.currentResult)
  const lyricsIsLoading = useLyricsStore((s) => s.isLoading)
  const lyricsStoreError = useLyricsStore((s) => s.errorMessage)
  const loadLyricsForTrack = useLyricsStore((s) => s.loadForTrack)
  const refreshLyricsForTrack = useLyricsStore((s) => s.refreshForTrack)

  const [followPaused, setFollowPaused] = useState(false)
  const syncedLineRefs = useRef<Map<number, HTMLParagraphElement>>(new Map())
  const expandedListRef = useRef<HTMLDivElement | null>(null)
  const lastLyricsRequestKeyRef = useRef<string | null>(null)
  const programmaticScrollRef = useRef(false)
  const clearProgrammaticScrollTimerRef = useRef<number | null>(null)
  const openRecenterTimerRef = useRef<number | null>(null)
  const hasCompletedExpandedOpenRef = useRef(false)

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
  const hasSyncedLyrics = syncedLines.length > 0
  const activeSyncedLineIndex = useMemo(
    () => findActiveSyncedLineIndex(syncedLines, currentTime),
    [currentTime, syncedLines]
  )
  const effectiveSyncedLineIndex = activeSyncedLineIndex >= 0 ? activeSyncedLineIndex : 0

  const collapsedTrackOffsetY = (
    COLLAPSED_ACTIVE_ANCHOR_INDEX - effectiveSyncedLineIndex
  ) * COLLAPSED_LINE_HEIGHT_PX
  const collapsedTrackStyle = useMemo(() => ({
    '--transport-lyrics-focus-line-height': `${COLLAPSED_LINE_HEIGHT_PX}px`,
    transform: `translate3d(0, ${collapsedTrackOffsetY}px, 0)`
  } as CSSProperties), [collapsedTrackOffsetY])

  const plainLyrics = activeLyricsResult?.status === 'hit'
    ? activeLyricsResult.lyrics.plainLyrics?.trim() ?? ''
    : ''

  const metaChipText = useMemo(() => {
    if (!currentTrack) return 'No Track'
    if (lyricsIsLoading && !activeLyricsResult) return 'Loading'
    if (activeLyricsResult?.status === 'hit') {
      const sourceLabel = getLyricsSourceLabel(activeLyricsResult.lyrics.source)
      const syncLabel = hasSyncedLyrics ? 'Synced' : 'Unsynced'
      const cachedLabel = activeLyricsResult.cached ? ' • Cached' : ''
      return `${sourceLabel} • ${syncLabel}${cachedLabel}`
    }
    if (activeLyricsResult?.status === 'transient_error') return 'Error'
    if (activeLyricsResult?.status === 'not_found') {
      return activeLyricsResult.reason === 'online-disabled' ? 'Online Off' : 'Not Found'
    }
    if (lyricsStoreError) return 'Error'
    return 'Ready'
  }, [activeLyricsResult, currentTrack, hasSyncedLyrics, lyricsIsLoading, lyricsStoreError])

  const markProgrammaticScroll = useCallback(() => {
    programmaticScrollRef.current = true
    if (clearProgrammaticScrollTimerRef.current !== null) {
      window.clearTimeout(clearProgrammaticScrollTimerRef.current)
    }
    clearProgrammaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false
      clearProgrammaticScrollTimerRef.current = null
    }, PROGRAMMATIC_SCROLL_RESET_MS)
  }, [])

  const scrollActiveExpandedLineIntoView = useCallback((behavior: ScrollBehavior = 'smooth') => {
    if (activeSyncedLineIndex < 0) return
    const container = expandedListRef.current
    const lineNode = syncedLineRefs.current.get(activeSyncedLineIndex)
    if (!container || !lineNode) return

    const containerRect = container.getBoundingClientRect()
    const lineRect = lineNode.getBoundingClientRect()
    const lineOffsetWithinContainer = lineRect.top - containerRect.top
    const centeredTop = (
      container.scrollTop +
      lineOffsetWithinContainer -
      ((container.clientHeight - lineNode.clientHeight) / 2)
    )
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight)
    const targetTop = Math.max(0, Math.min(centeredTop, maxTop))

    markProgrammaticScroll()
    if (behavior === 'auto') {
      container.scrollTop = targetTop
      return
    }
    container.scrollTo({
      top: targetTop,
      behavior
    })
  }, [activeSyncedLineIndex, markProgrammaticScroll])

  const pauseFollowFromManualScroll = useCallback(() => {
    if (!lyricsShelfExpanded) return
    if (!hasSyncedLyrics) return
    if (programmaticScrollRef.current) return
    setFollowPaused(true)
  }, [hasSyncedLyrics, lyricsShelfExpanded])

  const refreshLyrics = useCallback(() => {
    if (!lyricsQuery) return
    void refreshLyricsForTrack(lyricsQuery)
  }, [lyricsQuery, refreshLyricsForTrack])

  useEffect(() => {
    return () => {
      if (clearProgrammaticScrollTimerRef.current !== null) {
        window.clearTimeout(clearProgrammaticScrollTimerRef.current)
      }
      if (openRecenterTimerRef.current !== null) {
        window.clearTimeout(openRecenterTimerRef.current)
      }
    }
  }, [])

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

  useEffect(() => {
    if (!showLyricsShelf || !lyricsShelfExpanded) return
    setFollowPaused(false)
  }, [currentTrack?.path, lyricsShelfExpanded, showLyricsShelf])

  useEffect(() => {
    if (lyricsShelfExpanded) return
    if (clearProgrammaticScrollTimerRef.current !== null) {
      window.clearTimeout(clearProgrammaticScrollTimerRef.current)
      clearProgrammaticScrollTimerRef.current = null
    }
    if (openRecenterTimerRef.current !== null) {
      window.clearTimeout(openRecenterTimerRef.current)
      openRecenterTimerRef.current = null
    }
    hasCompletedExpandedOpenRef.current = false
    programmaticScrollRef.current = false
    syncedLineRefs.current.clear()
    if (expandedListRef.current) {
      expandedListRef.current.scrollTop = 0
    }
    setFollowPaused(false)
  }, [followPaused, lyricsShelfExpanded])

  useEffect(() => {
    if (!showLyricsShelf) return
    if (!lyricsShelfExpanded) return
    if (!hasSyncedLyrics) return
    if (hasCompletedExpandedOpenRef.current) return
    hasCompletedExpandedOpenRef.current = true
    // Ensure expanded mode starts centered and stays centered after shelf open transition settles.
    window.requestAnimationFrame(() => {
      scrollActiveExpandedLineIntoView('auto')
    })
    openRecenterTimerRef.current = window.setTimeout(() => {
      scrollActiveExpandedLineIntoView('auto')
      openRecenterTimerRef.current = null
    }, EXPANDED_OPEN_RECENTER_DELAY_MS)
  }, [hasSyncedLyrics, lyricsShelfExpanded, scrollActiveExpandedLineIntoView, showLyricsShelf])

  useEffect(() => {
    if (!showLyricsShelf) return
    if (!lyricsShelfExpanded) return
    if (!hasSyncedLyrics) return
    if (followPaused) return
    scrollActiveExpandedLineIntoView('smooth')
  }, [
    activeSyncedLineIndex,
    followPaused,
    hasSyncedLyrics,
    lyricsShelfExpanded,
    scrollActiveExpandedLineIntoView,
    showLyricsShelf
  ])

  const setSyncedLineRef = (index: number) => (node: HTMLParagraphElement | null) => {
    if (node) {
      syncedLineRefs.current.set(index, node)
      return
    }
    syncedLineRefs.current.delete(index)
  }

  const handleRecenter = () => {
    setFollowPaused(false)
    scrollActiveExpandedLineIntoView('smooth')
  }

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
    if (!currentTrack) {
      return <p className="transport-lyrics-shelf-state">No track selected.</p>
    }

    if (lyricsIsLoading && !activeLyricsResult) {
      return <p className="transport-lyrics-shelf-state">Loading lyrics...</p>
    }

    if (activeLyricsResult?.status === 'transient_error') {
      return (
        <div className="transport-lyrics-shelf-state transport-lyrics-shelf-state-error">
          <p>{activeLyricsResult.message}</p>
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

    if (!lyricsShelfExpanded) {
      if (activeLyricsResult?.status === 'hit' && hasSyncedLyrics) {
        return renderCollapsedSyncedWindow()
      }
      return (
        <p className="transport-lyrics-shelf-state transport-lyrics-shelf-state-not-found">
          Lyrics not synced or not found.
        </p>
      )
    }

    if (activeLyricsResult?.status === 'hit' && hasSyncedLyrics) {
      return (
        <div
          key="lyrics-expanded-list"
          ref={expandedListRef}
          className="transport-lyrics-expanded-list"
          onWheel={pauseFollowFromManualScroll}
          onTouchStart={pauseFollowFromManualScroll}
          aria-live="polite"
        >
          {syncedLines.map((line, index) => (
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

    if (plainLyrics.length > 0) {
      return <pre className="transport-lyrics-expanded-plain">{plainLyrics}</pre>
    }

    return (
      <p className="transport-lyrics-shelf-state transport-lyrics-shelf-state-not-found">
        Lyrics not synced or not found.
      </p>
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
