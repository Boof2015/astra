import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject
} from 'react'

const PROGRAMMATIC_SCROLL_RESET_MS = 300
const DEFAULT_EXPANDED_OPEN_RECENTER_DELAY_MS = 360

interface UseLyricsSyncedViewOptions {
  isOpen: boolean
  isExpanded: boolean
  hasSyncedLyrics: boolean
  activeSyncedLineIndex: number
  focusedSyncedLineIndex?: number
  contentKey?: string | null
  collapsedLineHeightPx?: number
  collapsedLineHeightsPx?: number[]
  collapsedActiveAnchorIndex?: number
  expandedActiveAnchorRatio?: number
  expandedOpenRecenterDelayMs?: number
}

interface UseLyricsSyncedViewResult {
  followPaused: boolean
  setFollowPaused: (paused: boolean) => void
  expandedListRef: MutableRefObject<HTMLDivElement | null>
  effectiveSyncedLineIndex: number
  collapsedWindowStyle: CSSProperties
  collapsedTrackStyle: CSSProperties
  setSyncedLineRef: (index: number) => (node: HTMLParagraphElement | null) => void
  pauseFollowFromManualScroll: () => void
  handleRecenter: () => void
}

export function useLyricsSyncedView({
  isOpen,
  isExpanded,
  hasSyncedLyrics,
  activeSyncedLineIndex,
  focusedSyncedLineIndex,
  contentKey = null,
  collapsedLineHeightPx = 34,
  collapsedLineHeightsPx,
  collapsedActiveAnchorIndex = 1,
  expandedActiveAnchorRatio = 0.5,
  expandedOpenRecenterDelayMs = DEFAULT_EXPANDED_OPEN_RECENTER_DELAY_MS
}: UseLyricsSyncedViewOptions): UseLyricsSyncedViewResult {
  const [followPaused, setFollowPausedState] = useState(false)
  const syncedLineRefs = useRef<Map<number, HTMLParagraphElement>>(new Map())
  const expandedListRef = useRef<HTMLDivElement | null>(null)
  const programmaticScrollRef = useRef(false)
  const clearProgrammaticScrollTimerRef = useRef<number | null>(null)
  const openRecenterTimerRef = useRef<number | null>(null)
  const hasCompletedExpandedOpenRef = useRef(false)

  const effectiveSyncedLineIndex = focusedSyncedLineIndex != null && focusedSyncedLineIndex >= 0
    ? focusedSyncedLineIndex
    : activeSyncedLineIndex >= 0
      ? activeSyncedLineIndex
      : 0

  const collapsedLineMetrics = useMemo(() => {
    const heights = collapsedLineHeightsPx?.map((height) => (
      Number.isFinite(height) && height > 0 ? height : collapsedLineHeightPx
    )) ?? []
    const tops: number[] = []
    let totalHeightPx = 0
    heights.forEach((height) => {
      tops.push(totalHeightPx)
      totalHeightPx += height
    })
    return { heights, tops, totalHeightPx }
  }, [collapsedLineHeightPx, collapsedLineHeightsPx])

  const getCollapsedLineHeight = useCallback((index: number) => {
    if (index >= 0 && index < collapsedLineMetrics.heights.length) {
      return collapsedLineMetrics.heights[index]
    }
    return collapsedLineHeightPx
  }, [collapsedLineHeightPx, collapsedLineMetrics.heights])

  const getCollapsedLineTop = useCallback((index: number) => {
    if (index < 0) return index * collapsedLineHeightPx
    if (index < collapsedLineMetrics.tops.length) return collapsedLineMetrics.tops[index]
    return collapsedLineMetrics.totalHeightPx
      + ((index - collapsedLineMetrics.heights.length) * collapsedLineHeightPx)
  }, [
    collapsedLineHeightPx,
    collapsedLineMetrics.heights.length,
    collapsedLineMetrics.tops,
    collapsedLineMetrics.totalHeightPx
  ])

  const hasVariableCollapsedRows = collapsedLineMetrics.heights.length > 0
  const focusedCollapsedLineHeightPx = getCollapsedLineHeight(effectiveSyncedLineIndex)
  const adjacentCollapsedLineHeightPx = Math.max(
    collapsedLineHeightPx,
    getCollapsedLineHeight(effectiveSyncedLineIndex - 1),
    getCollapsedLineHeight(effectiveSyncedLineIndex + 1)
  )
  const collapsedWindowHeightPx = hasVariableCollapsedRows
    ? focusedCollapsedLineHeightPx + (adjacentCollapsedLineHeightPx * 2)
    : collapsedLineHeightPx * 3
  const collapsedAnchorCenterPx = hasVariableCollapsedRows
    ? collapsedWindowHeightPx / 2
    : (collapsedActiveAnchorIndex + 0.5) * collapsedLineHeightPx
  const collapsedTrackOffsetY = collapsedAnchorCenterPx
    - getCollapsedLineTop(effectiveSyncedLineIndex)
    - (focusedCollapsedLineHeightPx / 2)

  const collapsedWindowStyle = useMemo(() => ({
    '--transport-lyrics-focus-line-height': `${collapsedLineHeightPx}px`,
    '--transport-lyrics-focus-window-height': `${collapsedWindowHeightPx}px`
  } as CSSProperties), [collapsedLineHeightPx, collapsedWindowHeightPx])

  const collapsedTrackStyle = useMemo(() => ({
    transform: `translate3d(0, ${collapsedTrackOffsetY}px, 0)`
  } as CSSProperties), [collapsedTrackOffsetY])

  const setFollowPaused = useCallback((paused: boolean) => {
    setFollowPausedState(paused)
  }, [])

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
    const targetLineIndex = activeSyncedLineIndex >= 0 ? activeSyncedLineIndex : effectiveSyncedLineIndex
    if (targetLineIndex < 0) return
    const container = expandedListRef.current
    const lineNode = syncedLineRefs.current.get(targetLineIndex)
    if (!container || !lineNode) return

    const containerRect = container.getBoundingClientRect()
    const lineRect = lineNode.getBoundingClientRect()
    const lineOffsetWithinContainer = lineRect.top - containerRect.top
    const anchorRatio = Math.max(0.2, Math.min(0.8, expandedActiveAnchorRatio))
    const anchoredTop = (
      container.scrollTop +
      lineOffsetWithinContainer -
      ((container.clientHeight * anchorRatio) - (lineNode.clientHeight / 2))
    )
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight)
    const targetTop = Math.max(0, Math.min(anchoredTop, maxTop))

    markProgrammaticScroll()
    if (behavior === 'auto') {
      container.scrollTop = targetTop
      return
    }
    container.scrollTo({
      top: targetTop,
      behavior
    })
  }, [activeSyncedLineIndex, effectiveSyncedLineIndex, expandedActiveAnchorRatio, markProgrammaticScroll])

  const pauseFollowFromManualScroll = useCallback(() => {
    if (!isExpanded) return
    if (!hasSyncedLyrics) return
    if (programmaticScrollRef.current) return
    setFollowPausedState(true)
  }, [hasSyncedLyrics, isExpanded])

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
    if (!isOpen || !isExpanded) return
    setFollowPausedState(false)
  }, [contentKey, isExpanded, isOpen])

  useEffect(() => {
    hasCompletedExpandedOpenRef.current = false
    programmaticScrollRef.current = false
    setFollowPausedState(false)
    if (expandedListRef.current) {
      expandedListRef.current.scrollTop = 0
    }
  }, [contentKey])

  useEffect(() => {
    if (isOpen && isExpanded) return
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
    setFollowPausedState(false)
  }, [contentKey, isExpanded, isOpen])

  useEffect(() => {
    if (!isOpen) return
    if (!isExpanded) return
    if (!hasSyncedLyrics) return
    if (hasCompletedExpandedOpenRef.current) return
    hasCompletedExpandedOpenRef.current = true
    window.requestAnimationFrame(() => {
      scrollActiveExpandedLineIntoView('auto')
    })
    openRecenterTimerRef.current = window.setTimeout(() => {
      scrollActiveExpandedLineIntoView('auto')
      openRecenterTimerRef.current = null
    }, expandedOpenRecenterDelayMs)
  }, [
    expandedOpenRecenterDelayMs,
    hasSyncedLyrics,
    isExpanded,
    isOpen,
    contentKey,
    scrollActiveExpandedLineIntoView
  ])

  useEffect(() => {
    if (!isOpen) return
    if (!isExpanded) return
    if (!hasSyncedLyrics) return
    if (followPaused) return
    scrollActiveExpandedLineIntoView('smooth')
  }, [
    activeSyncedLineIndex,
    followPaused,
    hasSyncedLyrics,
    isExpanded,
    isOpen,
    scrollActiveExpandedLineIntoView
  ])

  const setSyncedLineRef = useCallback((index: number) => (node: HTMLParagraphElement | null) => {
    if (node) {
      syncedLineRefs.current.set(index, node)
      return
    }
    syncedLineRefs.current.delete(index)
  }, [])

  const handleRecenter = useCallback(() => {
    setFollowPausedState(false)
    scrollActiveExpandedLineIntoView('smooth')
  }, [scrollActiveExpandedLineIntoView])

  return {
    followPaused,
    setFollowPaused,
    expandedListRef,
    effectiveSyncedLineIndex,
    collapsedWindowStyle,
    collapsedTrackStyle,
    setSyncedLineRef,
    pauseFollowFromManualScroll,
    handleRecenter
  }
}
