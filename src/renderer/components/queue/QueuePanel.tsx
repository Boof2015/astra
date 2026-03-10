import {
  CSSProperties,
  DragEvent,
  memo,
  MouseEvent,
  ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { List, RowComponentProps } from 'react-window'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import { Track } from '../../types/audio'

interface QueueSectionRow {
  kind: 'section'
  key: string
  label: string
  showShuffled?: boolean
  faded?: boolean
}

interface QueueBoundaryRow {
  kind: 'boundary'
  key: string
  active: boolean
}

interface QueueTrackRow {
  kind: 'track'
  key: string
  track: Track
  variant: 'current' | 'user' | 'auto' | 'previous'
  source: 'user' | 'auto' | null
  actualIndex: number | null
  dragIndex: number | null
  draggable: boolean
  removable: boolean
}

type QueueVirtualRow = QueueSectionRow | QueueBoundaryRow | QueueTrackRow

interface QueueRowSharedProps {
  rows: QueueVirtualRow[]
  reorderDragOverIndex: number | null
  insertDropIndex: number | null
  isCurrentLoading: boolean
  currentLoadingPercent: number | null
  currentLoadingChunkCount: number
  formatDuration: (seconds: number) => string
  onDragStart: (event: DragEvent<HTMLDivElement>, index: number) => void
  onDragOver: (event: DragEvent<HTMLDivElement>, index: number) => void
  onDragEnd: () => void
  onDragLeave: () => void
  onPlayQueuedTrack: (source: 'user' | 'auto', index: number) => void
  onRemoveUserTrack: (event: MouseEvent<HTMLButtonElement>, index: number) => void
}

const QUEUE_ITEM_ROW_HEIGHT_FALLBACK_PX = 56
const QUEUE_SECTION_ROW_HEIGHT_FALLBACK_PX = 32
const QUEUE_BOUNDARY_ROW_HEIGHT_PX = 16
const QUEUE_LIST_OVERSCAN_COUNT = 8
const QUEUE_DRAG_SCROLL_EDGE_PX = 40

function isUnavailableQueueTrack(track: Track): boolean {
  return track.sourceType !== undefined
    && track.sourceType !== 'local'
    && track.isAvailable === false
}

function parseCssPixelValue(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value.trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.round(parsed)
}

function resolveQueueRowHeights(element: HTMLElement | null): { itemRowHeight: number; sectionRowHeight: number } {
  if (!element) {
    return {
      itemRowHeight: QUEUE_ITEM_ROW_HEIGHT_FALLBACK_PX,
      sectionRowHeight: QUEUE_SECTION_ROW_HEIGHT_FALLBACK_PX
    }
  }

  const styles = getComputedStyle(element)
  return {
    itemRowHeight: parseCssPixelValue(
      styles.getPropertyValue('--queue-item-row-height'),
      QUEUE_ITEM_ROW_HEIGHT_FALLBACK_PX
    ),
    sectionRowHeight: parseCssPixelValue(
      styles.getPropertyValue('--queue-section-row-height'),
      QUEUE_SECTION_ROW_HEIGHT_FALLBACK_PX
    )
  }
}

function QueueRowRenderer({
  ariaAttributes,
  index,
  style,
  rows,
  reorderDragOverIndex,
  insertDropIndex,
  isCurrentLoading,
  currentLoadingPercent,
  currentLoadingChunkCount,
  formatDuration,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDragLeave,
  onPlayQueuedTrack,
  onRemoveUserTrack
}: RowComponentProps<QueueRowSharedProps>): ReactElement | null {
  const row = rows[index]
  if (!row) return null

  if (row.kind === 'section') {
    return (
      <div className="queue-list-item" style={style as CSSProperties} {...ariaAttributes}>
        <div className={`queue-section-title ${row.faded ? 'queue-section-title-faded' : ''}`}>
          {row.label}
          {row.showShuffled && <span className="queue-section-shuffled">Shuffled</span>}
        </div>
      </div>
    )
  }

  if (row.kind === 'boundary') {
    return (
      <div className="queue-list-item" style={style as CSSProperties} {...ariaAttributes}>
        <div className={`queue-drop-boundary ${row.active ? 'queue-drop-boundary-active' : ''}`} />
      </div>
    )
  }

  const isReorderDragOver = row.dragIndex !== null && reorderDragOverIndex === row.dragIndex
  const isExternalDropBefore = row.source === 'user' && row.actualIndex !== null && insertDropIndex === row.actualIndex
  const isUnavailable = isUnavailableQueueTrack(row.track)
  const canPlay = row.source !== null && row.actualIndex !== null && !isUnavailable
  const isLoadingRow = row.variant === 'current'
    && isCurrentLoading
    && row.track.sourceType !== undefined
    && row.track.sourceType !== 'local'
  const sourceLabel = row.track.sourceType === 'jellyfin'
    ? 'Jellyfin'
    : row.track.sourceType === 'subsonic'
      ? 'Subsonic'
      : null
  const loadingPercentLabel = typeof currentLoadingPercent === 'number' && Number.isFinite(currentLoadingPercent)
    ? `${Math.round(Math.max(0, Math.min(1, currentLoadingPercent)) * 100)}%`
    : null

  return (
    <div className="queue-list-item" style={style as CSSProperties} {...ariaAttributes}>
      <div
        className={`queue-item ${row.variant === 'current' ? 'queue-item-current' : ''} ${
          row.variant === 'previous' ? 'queue-item-previous' : ''
        } ${isReorderDragOver ? 'queue-item-drag-over' : ''} ${
          isExternalDropBefore ? 'queue-item-insert-before' : ''
        } ${isUnavailable ? 'queue-item-unavailable' : ''} ${isLoadingRow ? 'queue-item-loading' : ''}`}
        draggable={row.draggable}
        onDragStart={row.draggable && row.dragIndex !== null ? (event) => onDragStart(event, row.dragIndex!) : undefined}
        onDragOver={row.draggable && row.dragIndex !== null ? (event) => onDragOver(event, row.dragIndex!) : undefined}
        onDragEnd={row.draggable ? onDragEnd : undefined}
        onDragLeave={row.draggable ? onDragLeave : undefined}
        onClick={canPlay && row.source && row.actualIndex !== null ? () => onPlayQueuedTrack(row.source!, row.actualIndex!) : undefined}
      >
        {row.draggable && (
          <div className="queue-item-drag-handle">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 15h18v-2H3v2zm0 4h18v-2H3v2zm0-8h18V9H3v2zm0-6v2h18V5H3z" />
            </svg>
          </div>
        )}
        <div className="queue-item-info">
          <div className="queue-item-title">
            {isLoadingRow && (
              <span className="queue-item-loading-icon" title="Buffering track">
                <span className="loading-spinner-small queue-item-loading-spinner" />
              </span>
            )}
            {sourceLabel && (
              <span className="queue-source-badge" title={isUnavailable ? `${sourceLabel} (unavailable)` : sourceLabel}>
                {row.track.sourceType === 'jellyfin' ? (
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
                    <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
                  </svg>
                ) : (
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 17h2a4 4 0 0 1 4 4" />
                    <path d="M3 11h4a8 8 0 0 1 8 8" />
                    <circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none" />
                  </svg>
                )}
                <span>{sourceLabel}</span>
              </span>
            )}
            {row.track.title}
          </div>
          <div className="queue-item-artist">{row.track.artist}</div>
          {isLoadingRow && (
            <div className="queue-item-loading-status">
              {loadingPercentLabel
                ? `Buffering ${loadingPercentLabel}`
                : currentLoadingChunkCount > 0
                  ? `Buffering ${currentLoadingChunkCount} chunks`
                  : 'Buffering...'}
            </div>
          )}
        </div>
        <div className="queue-item-duration">{formatDuration(row.track.duration)}</div>
        {row.removable && row.actualIndex !== null && (
          <button
            className="queue-item-remove"
            onClick={(event) => onRemoveUserTrack(event, row.actualIndex!)}
            title="Remove from queue"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

const QueueRow = memo(QueueRowRenderer) as (
  props: RowComponentProps<QueueRowSharedProps>
) => ReactElement | null

export default function QueuePanel() {
  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const currentTrackSource = usePlayerStore((state) => state.currentTrackSource)
  const playbackState = usePlayerStore((state) => state.playbackState)
  const remoteLoadProgress = usePlayerStore((state) => state.remoteLoadProgress)
  const userQueue = usePlayerStore((state) => state.userQueue)
  const autoQueue = usePlayerStore((state) => state.autoQueue)
  const autoQueueIndex = usePlayerStore((state) => state.autoQueueIndex)
  const autoQueueContextLabel = usePlayerStore((state) => state.autoQueueContextLabel)
  const shuffle = usePlayerStore((state) => state.shuffle)
  const shuffledAutoIndices = usePlayerStore((state) => state.shuffledAutoIndices)
  const playbackHistory = usePlayerStore((state) => state.playbackHistory)
  const getResolvedAutoUpcomingEntries = usePlayerStore((state) => state.getResolvedAutoUpcomingEntries)
  const playQueuedTrack = usePlayerStore((state) => state.playQueuedTrack)
  const removeUserTrack = usePlayerStore((state) => state.removeUserTrack)
  const moveUserQueue = usePlayerStore((state) => state.moveUserQueue)
  const clearAllQueues = usePlayerStore((state) => state.clearAllQueues)
  const queueInsertDrag = useUIStore((state) => state.queueInsertDrag)
  const setQueueInsertDropTarget = useUIStore((state) => state.setQueueInsertDropTarget)

  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [reorderDragOverIndex, setReorderDragOverIndex] = useState<number | null>(null)
  const [listViewportHeight, setListViewportHeight] = useState(0)
  const [queueItemRowHeight, setQueueItemRowHeight] = useState(QUEUE_ITEM_ROW_HEIGHT_FALLBACK_PX)
  const [queueSectionRowHeight, setQueueSectionRowHeight] = useState(QUEUE_SECTION_ROW_HEIGHT_FALLBACK_PX)
  const dragNodeRef = useRef<HTMLDivElement | null>(null)
  const queueContentRef = useRef<HTMLDivElement | null>(null)
  const autoUpcomingEntries = useMemo(
    () => getResolvedAutoUpcomingEntries(),
    [
      autoQueue,
      autoQueueIndex,
      currentTrack,
      currentTrackSource,
      getResolvedAutoUpcomingEntries,
      shuffle,
      shuffledAutoIndices
    ]
  )

  useEffect(() => {
    return () => {
      dragNodeRef.current?.classList.remove('dragging')
    }
  }, [])

  useLayoutEffect(() => {
    const element = queueContentRef.current
    if (!element) return

    const updateMeasurements = () => {
      const nextHeight = Math.max(0, Math.round(element.clientHeight))
      const { itemRowHeight, sectionRowHeight } = resolveQueueRowHeights(element)

      setListViewportHeight((previous) => (previous === nextHeight ? previous : nextHeight))
      setQueueItemRowHeight((previous) => (previous === itemRowHeight ? previous : itemRowHeight))
      setQueueSectionRowHeight((previous) => (previous === sectionRowHeight ? previous : sectionRowHeight))
    }

    updateMeasurements()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateMeasurements)
      return () => {
        window.removeEventListener('resize', updateMeasurements)
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      updateMeasurements()
    })
    resizeObserver.observe(element)

    return () => {
      resizeObserver.disconnect()
    }
  }, [])

  useEffect(() => {
    const drag = queueInsertDrag
    const element = queueContentRef.current
    if (!drag || !element) {
      setQueueInsertDropTarget(null)
      return
    }

    const scrollElement = (element.querySelector('.queue-list-virtualized') as HTMLElement | null) ?? element
    const rect = scrollElement.getBoundingClientRect()

    if (
      drag.pointerX < rect.left
      || drag.pointerX > rect.right
      || drag.pointerY < rect.top
      || drag.pointerY > rect.bottom
    ) {
      setQueueInsertDropTarget(null)
      return
    }

    const distanceFromTop = drag.pointerY - rect.top
    const distanceFromBottom = rect.bottom - drag.pointerY
    if (distanceFromTop < QUEUE_DRAG_SCROLL_EDGE_PX) {
      scrollElement.scrollTop = Math.max(0, scrollElement.scrollTop - Math.ceil((QUEUE_DRAG_SCROLL_EDGE_PX - distanceFromTop) / 4))
    } else if (distanceFromBottom < QUEUE_DRAG_SCROLL_EDGE_PX) {
      scrollElement.scrollTop += Math.ceil((QUEUE_DRAG_SCROLL_EDGE_PX - distanceFromBottom) / 4)
    }

    const relativeY = drag.pointerY - rect.top + scrollElement.scrollTop
    const hasVisibleQueue = Boolean(currentTrack) || userQueue.length > 0 || autoUpcomingEntries.length > 0
    if (!hasVisibleQueue) {
      setQueueInsertDropTarget({ kind: 'empty', index: 0 })
      return
    }

    let userQueueStartOffset = 0
    if (currentTrack) {
      userQueueStartOffset += queueSectionRowHeight + queueItemRowHeight
    }
    if (userQueue.length > 0) {
      userQueueStartOffset += queueSectionRowHeight
    }

    let targetIndex = 0
    if (userQueue.length > 0) {
      const localY = relativeY - userQueueStartOffset
      targetIndex = userQueue.length
      for (let index = 0; index < userQueue.length; index += 1) {
        const midpoint = index * queueItemRowHeight + queueItemRowHeight / 2
        if (localY < midpoint) {
          targetIndex = index
          break
        }
      }
    }

    setQueueInsertDropTarget({
      kind: 'user',
      index: targetIndex
    })
  }, [
    autoUpcomingEntries.length,
    currentTrack,
    queueInsertDrag,
    queueItemRowHeight,
    queueSectionRowHeight,
    setQueueInsertDropTarget,
    userQueue.length
  ])

  const formatDuration = useCallback((seconds: number): string => {
    if (!seconds || !isFinite(seconds)) return '--:--'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }, [])

  const insertDropIndex = queueInsertDrag?.dropTarget?.kind === 'empty'
    ? 0
    : queueInsertDrag?.dropTarget?.kind === 'user'
      ? queueInsertDrag.dropTarget.index
      : null

  const rows = useMemo<QueueVirtualRow[]>(() => {
    const nextRows: QueueVirtualRow[] = []

    if (currentTrack) {
      nextRows.push({
        kind: 'section',
        key: 'section-now-playing',
        label: 'Now Playing'
      })
      nextRows.push({
        kind: 'track',
        key: `track-current-${currentTrack.id}`,
        track: currentTrack,
        variant: 'current',
        source: null,
        actualIndex: null,
        dragIndex: null,
        draggable: false,
        removable: false
      })
    }

    if (userQueue.length > 0) {
      nextRows.push({
        kind: 'section',
        key: 'section-user-queue',
        label: `Queued by You (${userQueue.length} ${userQueue.length === 1 ? 'track' : 'tracks'})`
      })

      userQueue.forEach((track, index) => {
        nextRows.push({
          kind: 'track',
          key: `track-user-${track.id}-${index}`,
          track,
          variant: 'user',
          source: 'user',
          actualIndex: index,
          dragIndex: index,
          draggable: true,
          removable: true
        })
      })
    }

    if (autoUpcomingEntries.length > 0) {
      nextRows.push({
        kind: 'boundary',
        key: 'boundary-user-auto',
        active: insertDropIndex === userQueue.length
      })
      nextRows.push({
        kind: 'section',
        key: 'section-auto-queue',
        label: `Next From ${autoQueueContextLabel ?? 'Current Selection'} (${autoUpcomingEntries.length} ${autoUpcomingEntries.length === 1 ? 'track' : 'tracks'})`,
        showShuffled: shuffle
      })

      autoUpcomingEntries.forEach((entry) => {
        nextRows.push({
          kind: 'track',
          key: `track-auto-${entry.track.id}-${entry.index}`,
          track: entry.track,
          variant: 'auto',
          source: 'auto',
          actualIndex: entry.index,
          dragIndex: null,
          draggable: false,
          removable: false
        })
      })
    }

    if (playbackHistory.length > 0) {
      nextRows.push({
        kind: 'section',
        key: 'section-previously-played',
        label: 'Previously Played',
        faded: true
      })

      playbackHistory.forEach((entry, index) => {
        nextRows.push({
          kind: 'track',
          key: `track-previous-${entry.track.id}-${index}`,
          track: entry.track,
          variant: 'previous',
          source: null,
          actualIndex: null,
          dragIndex: null,
          draggable: false,
          removable: false
        })
      })
    }

    return nextRows
  }, [
    autoQueueContextLabel,
    autoUpcomingEntries,
    currentTrack,
    insertDropIndex,
    playbackHistory,
    shuffle,
    userQueue
  ])

  const handleDragStart = useCallback((event: DragEvent<HTMLDivElement>, index: number) => {
    setDragIndex(index)
    dragNodeRef.current = event.currentTarget
    event.dataTransfer.effectAllowed = 'move'
    setTimeout(() => {
      dragNodeRef.current?.classList.add('dragging')
    }, 0)
  }, [])

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault()
    if (dragIndex === null || dragIndex === index) return
    setReorderDragOverIndex(index)
  }, [dragIndex])

  const handleDragEnd = useCallback(() => {
    if (dragIndex !== null && reorderDragOverIndex !== null && dragIndex !== reorderDragOverIndex) {
      moveUserQueue(dragIndex, reorderDragOverIndex)
    }
    dragNodeRef.current?.classList.remove('dragging')
    setDragIndex(null)
    setReorderDragOverIndex(null)
  }, [dragIndex, moveUserQueue, reorderDragOverIndex])

  const handleDragLeave = useCallback(() => {
    setReorderDragOverIndex(null)
  }, [])

  const handlePlayQueuedTrack = useCallback((source: 'user' | 'auto', index: number) => {
    void playQueuedTrack({ source, index }, { manualStart: true })
  }, [playQueuedTrack])

  const handleRemoveUserTrack = useCallback((event: MouseEvent<HTMLButtonElement>, index: number) => {
    event.stopPropagation()
    removeUserTrack(index)
  }, [removeUserTrack])

  const resolveRowHeight = useCallback((index: number) => {
    const row = rows[index]
    if (!row) return queueItemRowHeight
    if (row.kind === 'section') return queueSectionRowHeight
    if (row.kind === 'boundary') return QUEUE_BOUNDARY_ROW_HEIGHT_PX
    return queueItemRowHeight
  }, [queueItemRowHeight, queueSectionRowHeight, rows])

  const isCurrentLoading = playbackState === 'loading'
  const currentLoadingProgress = isCurrentLoading
    && currentTrack
    && remoteLoadProgress
    && remoteLoadProgress.path === currentTrack.path
    ? remoteLoadProgress
    : null

  const rowProps = useMemo<QueueRowSharedProps>(() => ({
    rows,
    reorderDragOverIndex,
    insertDropIndex,
    isCurrentLoading,
    currentLoadingPercent: currentLoadingProgress?.percent ?? null,
    currentLoadingChunkCount: currentLoadingProgress?.chunkCount ?? 0,
    formatDuration,
    onDragStart: handleDragStart,
    onDragOver: handleDragOver,
    onDragEnd: handleDragEnd,
    onDragLeave: handleDragLeave,
    onPlayQueuedTrack: handlePlayQueuedTrack,
    onRemoveUserTrack: handleRemoveUserTrack
  }), [
    rows,
    reorderDragOverIndex,
    insertDropIndex,
    isCurrentLoading,
    currentLoadingProgress,
    formatDuration,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragLeave,
    handlePlayQueuedTrack,
    handleRemoveUserTrack
  ])

  if (rows.length === 0) {
    return (
      <div className="queue-panel">
        <div className="queue-header">
          <h3>Queue</h3>
        </div>
        <div className="queue-empty-drop-zone-wrap" ref={queueContentRef}>
          <div className={`queue-empty-drop-zone ${queueInsertDrag?.dropTarget?.kind === 'empty' ? 'queue-empty-drop-zone-active' : ''}`}>
            <p>No tracks in queue</p>
            <p className="queue-empty-hint">
              {queueInsertDrag ? 'Drop here to build a user queue' : 'Open the queue and long-press a track to drop it here'}
            </p>
          </div>
        </div>
      </div>
    )
  }

  const listHeight = listViewportHeight > 0 ? listViewportHeight : queueItemRowHeight * 8

  return (
    <div className="queue-panel">
      <div className="queue-header">
        <h3>Queue</h3>
        <button className="queue-clear-btn" onClick={clearAllQueues} title="Clear queue history and queued tracks">
          Clear
        </button>
      </div>

      <div className="queue-content" ref={queueContentRef}>
        <List
          className="queue-list-virtualized"
          defaultHeight={QUEUE_ITEM_ROW_HEIGHT_FALLBACK_PX * 8}
          overscanCount={QUEUE_LIST_OVERSCAN_COUNT}
          rowComponent={QueueRow}
          rowCount={rows.length}
          rowHeight={resolveRowHeight}
          rowProps={rowProps}
          style={{ height: listHeight, width: '100%' }}
        />
      </div>
    </div>
  )
}
