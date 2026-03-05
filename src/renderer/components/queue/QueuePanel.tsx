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
import { Track } from '../../types/audio'

interface QueueSectionRow {
  kind: 'section'
  key: string
  label: string
  showShuffled?: boolean
  faded?: boolean
}

interface QueueTrackRow {
  kind: 'track'
  key: string
  track: Track
  variant: 'current' | 'upcoming' | 'previous'
  actualQueueIndex: number | null
  dragIndex: number | null
  draggable: boolean
  removable: boolean
}

type QueueVirtualRow = QueueSectionRow | QueueTrackRow

interface QueueRowSharedProps {
  rows: QueueVirtualRow[]
  dragOverIndex: number | null
  isCurrentLoading: boolean
  currentLoadingPercent: number | null
  currentLoadingChunkCount: number
  formatDuration: (seconds: number) => string
  onDragStart: (event: DragEvent<HTMLDivElement>, index: number) => void
  onDragOver: (event: DragEvent<HTMLDivElement>, index: number) => void
  onDragEnd: () => void
  onDragLeave: () => void
  onPlayTrackAt: (index: number) => void
  onRemoveFromQueue: (event: MouseEvent<HTMLButtonElement>, index: number) => void
}

const QUEUE_ITEM_ROW_HEIGHT_FALLBACK_PX = 56
const QUEUE_SECTION_ROW_HEIGHT_FALLBACK_PX = 32
const QUEUE_LIST_OVERSCAN_COUNT = 8

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
  dragOverIndex,
  isCurrentLoading,
  currentLoadingPercent,
  currentLoadingChunkCount,
  formatDuration,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDragLeave,
  onPlayTrackAt,
  onRemoveFromQueue
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

  const isDragOver = row.dragIndex !== null && dragOverIndex === row.dragIndex
  const isUnavailable = isUnavailableQueueTrack(row.track)
  const canPlay = row.actualQueueIndex !== null && !isUnavailable
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
        } ${isDragOver ? 'queue-item-drag-over' : ''} ${isUnavailable ? 'queue-item-unavailable' : ''} ${isLoadingRow ? 'queue-item-loading' : ''}`}
        draggable={row.draggable}
        onDragStart={row.draggable && row.dragIndex !== null ? (event) => onDragStart(event, row.dragIndex!) : undefined}
        onDragOver={row.draggable && row.dragIndex !== null ? (event) => onDragOver(event, row.dragIndex!) : undefined}
        onDragEnd={row.draggable ? onDragEnd : undefined}
        onDragLeave={row.draggable ? onDragLeave : undefined}
        onClick={canPlay ? () => onPlayTrackAt(row.actualQueueIndex!) : undefined}
      >
        {row.draggable && (
          <div className="queue-item-drag-handle">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 15h18v-2H3v2zm0 4h18v-2H3v2zm0-8h18V9H3v2zm0-6v2h18V5H3z"/>
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
        <div className="queue-item-duration">
          {formatDuration(row.track.duration)}
        </div>
        {row.removable && row.actualQueueIndex !== null && (
          <button
            className="queue-item-remove"
            onClick={(event) => onRemoveFromQueue(event, row.actualQueueIndex!)}
            title="Remove from queue"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
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
  const queue = usePlayerStore((state) => state.queue)
  const queueIndex = usePlayerStore((state) => state.queueIndex)
  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const playbackState = usePlayerStore((state) => state.playbackState)
  const remoteLoadProgress = usePlayerStore((state) => state.remoteLoadProgress)
  const shuffle = usePlayerStore((state) => state.shuffle)
  const shuffledIndices = usePlayerStore((state) => state.shuffledIndices)
  const shufflePosition = usePlayerStore((state) => state.shufflePosition)
  const playTrackAt = usePlayerStore((state) => state.playTrackAt)
  const removeFromQueue = usePlayerStore((state) => state.removeFromQueue)
  const moveInQueue = usePlayerStore((state) => state.moveInQueue)
  const clearQueue = usePlayerStore((state) => state.clearQueue)

  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [listViewportHeight, setListViewportHeight] = useState(0)
  const [queueItemRowHeight, setQueueItemRowHeight] = useState(QUEUE_ITEM_ROW_HEIGHT_FALLBACK_PX)
  const [queueSectionRowHeight, setQueueSectionRowHeight] = useState(QUEUE_SECTION_ROW_HEIGHT_FALLBACK_PX)
  const dragNodeRef = useRef<HTMLDivElement | null>(null)
  const queueContentRef = useRef<HTMLDivElement | null>(null)

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

  const formatDuration = useCallback((seconds: number): string => {
    if (!seconds || !isFinite(seconds)) return '--:--'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }, [])

  const upcomingTracks = useMemo(() => {
    if (queue.length === 0) return []
    if (shuffle && shuffledIndices.length > 0) {
      return shuffledIndices
        .slice(shufflePosition + 1)
        .map((queueItemIndex) => queue[queueItemIndex])
        .filter((track): track is Track => Boolean(track))
    }

    return queue.slice(queueIndex + 1)
  }, [queue, queueIndex, shuffle, shuffledIndices, shufflePosition])

  const previousTracks = useMemo(() => {
    if (queue.length === 0) return []
    if (shuffle && shuffledIndices.length > 0) {
      return shuffledIndices
        .slice(0, shufflePosition)
        .map((queueItemIndex) => queue[queueItemIndex])
        .filter((track): track is Track => Boolean(track))
    }

    return queue.slice(0, queueIndex)
  }, [queue, queueIndex, shuffle, shuffledIndices, shufflePosition])

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
        key: `track-current-${currentTrack.id}-${queueIndex}`,
        track: currentTrack,
        variant: 'current',
        actualQueueIndex: null,
        dragIndex: null,
        draggable: false,
        removable: false
      })
    }

    if (upcomingTracks.length > 0) {
      nextRows.push({
        kind: 'section',
        key: 'section-up-next',
        label: `Up Next (${upcomingTracks.length} ${upcomingTracks.length === 1 ? 'track' : 'tracks'})`,
        showShuffled: shuffle
      })

      for (let index = 0; index < upcomingTracks.length; index += 1) {
        const track = upcomingTracks[index]
        const actualQueueIndex = shuffle && shuffledIndices.length > 0
          ? shuffledIndices[shufflePosition + 1 + index]
          : queueIndex + 1 + index
        const nextDragIndex = shuffle && shuffledIndices.length > 0
          ? shufflePosition + 1 + index
          : queueIndex + 1 + index

        if (!Number.isInteger(actualQueueIndex)) continue

        nextRows.push({
          kind: 'track',
          key: `track-upcoming-${track.id}-${actualQueueIndex}`,
          track,
          variant: 'upcoming',
          actualQueueIndex,
          dragIndex: nextDragIndex,
          draggable: true,
          removable: true
        })
      }
    }

    if (previousTracks.length > 0) {
      nextRows.push({
        kind: 'section',
        key: 'section-previously-played',
        label: 'Previously Played',
        faded: true
      })

      for (let index = 0; index < previousTracks.length; index += 1) {
        const track = previousTracks[index]
        const actualQueueIndex = shuffle && shuffledIndices.length > 0
          ? shuffledIndices[index]
          : index

        if (!Number.isInteger(actualQueueIndex)) continue

        nextRows.push({
          kind: 'track',
          key: `track-previous-${track.id}-${actualQueueIndex}`,
          track,
          variant: 'previous',
          actualQueueIndex,
          dragIndex: null,
          draggable: false,
          removable: false
        })
      }
    }

    return nextRows
  }, [currentTrack, queueIndex, previousTracks, shuffle, shuffledIndices, shufflePosition, upcomingTracks])

  const handleDragStart = useCallback((event: DragEvent<HTMLDivElement>, index: number) => {
    setDragIndex(index)
    dragNodeRef.current = event.currentTarget
    event.dataTransfer.effectAllowed = 'move'
    // Add dragging class after a frame to avoid affecting the drag image
    setTimeout(() => {
      dragNodeRef.current?.classList.add('dragging')
    }, 0)
  }, [])

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault()
    if (dragIndex === null || dragIndex === index) return
    setDragOverIndex(index)
  }, [dragIndex])

  const handleDragEnd = useCallback(() => {
    if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
      moveInQueue(dragIndex, dragOverIndex)
    }
    dragNodeRef.current?.classList.remove('dragging')
    setDragIndex(null)
    setDragOverIndex(null)
  }, [dragIndex, dragOverIndex, moveInQueue])

  const handleDragLeave = useCallback(() => {
    setDragOverIndex(null)
  }, [])

  const handlePlayTrackAt = useCallback((index: number) => {
    void playTrackAt(index)
  }, [playTrackAt])

  const handleRemoveFromQueue = useCallback((event: MouseEvent<HTMLButtonElement>, index: number) => {
    event.stopPropagation()
    removeFromQueue(index)
  }, [removeFromQueue])

  const resolveRowHeight = useCallback((index: number) => {
    const row = rows[index]
    if (!row) return queueItemRowHeight
    return row.kind === 'section' ? queueSectionRowHeight : queueItemRowHeight
  }, [rows, queueItemRowHeight, queueSectionRowHeight])

  const isCurrentLoading = playbackState === 'loading'
  const currentLoadingProgress = isCurrentLoading
    && currentTrack
    && remoteLoadProgress
    && remoteLoadProgress.path === currentTrack.path
    ? remoteLoadProgress
    : null

  const rowProps = useMemo<QueueRowSharedProps>(() => ({
    rows,
    dragOverIndex,
    isCurrentLoading,
    currentLoadingPercent: currentLoadingProgress?.percent ?? null,
    currentLoadingChunkCount: currentLoadingProgress?.chunkCount ?? 0,
    formatDuration,
    onDragStart: handleDragStart,
    onDragOver: handleDragOver,
    onDragEnd: handleDragEnd,
    onDragLeave: handleDragLeave,
    onPlayTrackAt: handlePlayTrackAt,
    onRemoveFromQueue: handleRemoveFromQueue
  }), [
    rows,
    dragOverIndex,
    isCurrentLoading,
    currentLoadingProgress,
    formatDuration,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragLeave,
    handlePlayTrackAt,
    handleRemoveFromQueue
  ])

  if (queue.length === 0) {
    return (
      <div className="queue-panel">
        <div className="queue-header">
          <h3>Queue</h3>
        </div>
        <div className="queue-empty">
          <p>No tracks in queue</p>
          <p className="queue-empty-hint">Play a track from your library to start</p>
        </div>
      </div>
    )
  }

  const listHeight = listViewportHeight > 0 ? listViewportHeight : queueItemRowHeight * 8

  return (
    <div className="queue-panel">
      <div className="queue-header">
        <h3>Queue</h3>
        <button className="queue-clear-btn" onClick={clearQueue} title="Clear queue">
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
