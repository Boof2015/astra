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
import { List, RowComponentProps, type ListImperativeAPI } from 'react-window'
import {
  usePlayerStore,
  type PlaybackHistoryEntry,
  type QueueItem,
  type QueueTrackEntry
} from '../../stores/playerStore'
import { useLibraryStore, type DbTrack } from '../../stores/libraryStore'
import { useUIStore } from '../../stores/uiStore'
import { Track } from '../../types/audio'
import {
  CONTROLLER_VIRTUAL_MOVE_EVENT,
  focusControllerTarget,
  type ControllerVirtualMoveDetail
} from '../../utils/controllerFocus'
import {
  createQueueVirtualLayout,
  resolveQueueDropIndex,
  resolveQueueVirtualRowLocation,
  type QueueVirtualLayout
} from './queueVirtualModel'

interface QueueSectionRow {
  kind: 'section'
  label: string
  showShuffled?: boolean
  faded?: boolean
}

interface QueueTrackRow {
  kind: 'track'
  track: Track
  variant: 'current' | 'upcoming' | 'previous'
  queueId: string | null
  manual: boolean
  dragIndex: number | null
  draggable: boolean
  removable: boolean
}

type QueueVirtualRow = QueueSectionRow | QueueTrackRow

interface QueueVirtualModel {
  currentTrack: Track | null
  queueItemsById: ReadonlyMap<string, QueueItem>
  upcomingQueueIds: readonly string[]
  playbackHistory: readonly PlaybackHistoryEntry[]
  trackByPath: ReadonlyMap<string, DbTrack>
  shuffle: boolean
  layout: QueueVirtualLayout
}

interface QueueRowSharedProps {
  model: QueueVirtualModel
  reorderDragOverIndex: number | null
  insertDropIndex: number | null
  isCurrentLoading: boolean
  currentLoadingPercent: number | null
  currentLoadingChunkCount: number
  formatDuration: (seconds: number) => string
  onDragStart: (event: DragEvent<HTMLDivElement>, queueId: string, index: number) => void
  onDragOver: (event: DragEvent<HTMLDivElement>, index: number) => void
  onDragEnd: () => void
  onDragLeave: () => void
  onPlayQueuedTrack: (queueId: string) => void
  onRemoveTrack: (event: MouseEvent<HTMLButtonElement>, queueId: string) => void
}

const QUEUE_ITEM_ROW_HEIGHT_FALLBACK_PX = 56
const QUEUE_SECTION_ROW_HEIGHT_FALLBACK_PX = 32
const QUEUE_LIST_OVERSCAN_COUNT = 8
const QUEUE_DRAG_SCROLL_EDGE_PX = 40

function dbTrackToQueueTrack(dbTrack: DbTrack): Track {
  return {
    id: dbTrack.path,
    path: dbTrack.path,
    title: dbTrack.title,
    artist: dbTrack.artist,
    artistNames: dbTrack.artist_names,
    album: dbTrack.album,
    albumArtist: dbTrack.album_artist ?? undefined,
    albumArtistNames: dbTrack.album_artist_names,
    albumIdentityKey: dbTrack.album_identity_key,
    duration: dbTrack.duration,
    trackNumber: dbTrack.track_number ?? undefined,
    discNumber: dbTrack.disc_number ?? undefined,
    year: dbTrack.year ?? undefined,
    genre: dbTrack.genre ?? undefined,
    genres: dbTrack.genres,
    artworkHash: dbTrack.artwork_hash ?? undefined,
    format: dbTrack.format,
    sampleRate: dbTrack.sample_rate ?? undefined,
    bitDepth: dbTrack.bit_depth ?? undefined,
    bitrate: dbTrack.bitrate ?? undefined,
    channels: dbTrack.channels ?? undefined,
    codec: dbTrack.codec ?? undefined,
    codecProfile: dbTrack.codec_profile ?? undefined,
    isAtmosJoc: dbTrack.is_atmos_joc === 1,
    isIamf: dbTrack.is_iamf === 1,
    replayGainTrackDb: dbTrack.replaygain_track_gain_db ?? undefined,
    replayGainAlbumDb: dbTrack.replaygain_album_gain_db ?? undefined,
    sourceType: dbTrack.source_type,
    sourceId: dbTrack.source_id ?? undefined,
    sourceTrackId: dbTrack.source_track_id ?? undefined,
    sourcePath: dbTrack.source_path ?? undefined,
    isAvailable: dbTrack.is_available === 1,
    availabilityReason: dbTrack.availability_reason ?? undefined
  }
}

function resolveQueueTrackForDisplay(
  entry: QueueTrackEntry | null | undefined,
  trackByPath: ReadonlyMap<string, DbTrack>
): Track | null {
  if (!entry) return null

  if (entry.snapshot.origin === 'associated-external') {
    return { ...entry.snapshot }
  }

  const dbTrack = trackByPath.get(entry.path)
  const track = dbTrack ? dbTrackToQueueTrack(dbTrack) : { ...entry.snapshot }
  if (entry.snapshot.isAvailable !== false) return track

  return {
    ...track,
    isAvailable: false,
    availabilityReason: entry.snapshot.availabilityReason
  }
}

function resolveQueueVirtualRow(model: QueueVirtualModel, index: number): QueueVirtualRow | null {
  const location = resolveQueueVirtualRowLocation(model.layout, index)
  if (!location) return null

  if (location.kind === 'section') {
    if (location.section === 'current') {
      return { kind: 'section', label: 'Now Playing' }
    }
    if (location.section === 'upcoming') {
      return {
        kind: 'section',
        label: `Up Next (${model.layout.upcomingCount})`,
        showShuffled: model.shuffle
      }
    }
    return {
      kind: 'section',
      label: 'Previously Played',
      faded: true
    }
  }

  if (location.kind === 'current') {
    if (!model.currentTrack) return null
    return {
      kind: 'track',
      track: model.currentTrack,
      variant: 'current',
      queueId: null,
      manual: false,
      dragIndex: null,
      draggable: false,
      removable: false
    }
  }

  if (location.kind === 'upcoming') {
    const queueId = model.upcomingQueueIds[location.itemIndex]
    const item = queueId ? model.queueItemsById.get(queueId) : undefined
    const track = resolveQueueTrackForDisplay(item?.entry, model.trackByPath)
    if (!queueId || !item || !track) return null

    return {
      kind: 'track',
      track,
      variant: 'upcoming',
      queueId,
      manual: item.origin === 'manual',
      dragIndex: location.itemIndex,
      draggable: true,
      removable: true
    }
  }

  const historyEntry = model.playbackHistory[location.itemIndex]
  const track = resolveQueueTrackForDisplay(historyEntry?.item.entry, model.trackByPath)
  if (!historyEntry || !track) return null

  return {
    kind: 'track',
    track,
    variant: 'previous',
    queueId: null,
    manual: false,
    dragIndex: null,
    draggable: false,
    removable: false
  }
}

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
  model,
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
  onRemoveTrack
}: RowComponentProps<QueueRowSharedProps>): ReactElement | null {
  const row = resolveQueueVirtualRow(model, index)
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

  const isReorderDragOver = row.dragIndex !== null && reorderDragOverIndex === row.dragIndex
  const isExternalDropBefore = row.variant === 'upcoming' && row.dragIndex !== null && insertDropIndex === row.dragIndex
  const isUnavailable = isUnavailableQueueTrack(row.track)
  const canPlay = row.queueId !== null && row.variant === 'upcoming' && !isUnavailable
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
        data-controller-focusable={canPlay ? 'true' : undefined}
        data-controller-key={row.queueId ? `queue:${row.queueId}` : undefined}
        data-controller-index={index}
        tabIndex={canPlay ? -1 : undefined}
        role={canPlay ? 'button' : undefined}
        aria-label={canPlay ? `Play ${row.track.title} by ${row.track.artist}` : undefined}
        draggable={row.draggable}
        onDragStart={row.draggable && row.dragIndex !== null && row.queueId ? (event) => onDragStart(event, row.queueId!, row.dragIndex!) : undefined}
        onDragOver={row.draggable && row.dragIndex !== null ? (event) => onDragOver(event, row.dragIndex!) : undefined}
        onDragEnd={row.draggable ? onDragEnd : undefined}
        onDragLeave={row.draggable ? onDragLeave : undefined}
        onClick={canPlay && row.queueId ? () => onPlayQueuedTrack(row.queueId!) : undefined}
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
            {row.manual && (
              <span className="queue-manual-badge" title="Queued by you" aria-label="Queued by you">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 6h10M4 12h7M4 18h6" />
                  <path d="M18 13v8M14 17h8" />
                </svg>
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
        {row.removable && row.queueId && (
          <button
            className="queue-item-remove"
            onClick={(event) => onRemoveTrack(event, row.queueId!)}
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
  const playbackState = usePlayerStore((state) => state.playbackState)
  const remoteLoadProgress = usePlayerStore((state) => state.remoteLoadProgress)
  const queueItems = usePlayerStore((state) => state.queueItems)
  const upcomingQueueIds = usePlayerStore((state) => state.upcomingQueueIds)
  const shuffle = usePlayerStore((state) => state.shuffle)
  const playbackHistory = usePlayerStore((state) => state.playbackHistory)
  const playQueuedItem = usePlayerStore((state) => state.playQueuedItem)
  const removeUpcomingItem = usePlayerStore((state) => state.removeUpcomingItem)
  const moveUpcomingItem = usePlayerStore((state) => state.moveUpcomingItem)
  const clearAllQueues = usePlayerStore((state) => state.clearAllQueues)
  const trackByPath = useLibraryStore((state) => state.trackByPath)
  const trackCacheVersion = useLibraryStore((state) => state.trackCacheVersion)
  const trackDrag = useUIStore((state) => state.trackDrag)
  const setTrackDragDropTarget = useUIStore((state) => state.setTrackDragDropTarget)
  const queueNowPlayingRevealRequest = useUIStore((state) => state.queueNowPlayingRevealRequest)
  const clearQueueNowPlayingRevealRequest = useUIStore((state) => state.clearQueueNowPlayingRevealRequest)

  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragQueueId, setDragQueueId] = useState<string | null>(null)
  const [reorderDragOverIndex, setReorderDragOverIndex] = useState<number | null>(null)
  const [listViewportHeight, setListViewportHeight] = useState(0)
  const [queueItemRowHeight, setQueueItemRowHeight] = useState(QUEUE_ITEM_ROW_HEIGHT_FALLBACK_PX)
  const [queueSectionRowHeight, setQueueSectionRowHeight] = useState(QUEUE_SECTION_ROW_HEIGHT_FALLBACK_PX)
  const [queueScrollGlowEdge, setQueueScrollGlowEdge] = useState<'top' | 'bottom' | null>(null)
  const [isDropSettling, setIsDropSettling] = useState(false)
  const dragNodeRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<ListImperativeAPI>(null)
  const queueContentRef = useRef<HTMLDivElement | null>(null)
  const controllerGroupRef = useRef<HTMLDivElement | null>(null)
  const previousDragActiveRef = useRef(false)
  const previousUpcomingLengthRef = useRef(upcomingQueueIds.length)
  const consumedQueueRevealRequestIdRef = useRef<number | null>(null)
  const settleTimerRef = useRef<number | null>(null)
  const queueItemsById = useMemo(() => {
    const itemsById = new Map<string, QueueItem>()
    for (const item of queueItems) {
      itemsById.set(item.queueId, item)
    }
    return itemsById
  }, [queueItems])
  const layout = useMemo(
    () => createQueueVirtualLayout(
      Boolean(currentTrack),
      upcomingQueueIds.length,
      playbackHistory.length
    ),
    [currentTrack, playbackHistory.length, upcomingQueueIds.length]
  )
  const model = useMemo<QueueVirtualModel>(() => ({
    currentTrack,
    queueItemsById,
    upcomingQueueIds,
    playbackHistory,
    trackByPath,
    shuffle,
    layout
  }), [
    currentTrack,
    layout,
    playbackHistory,
    queueItemsById,
    shuffle,
    trackCacheVersion,
    trackByPath,
    upcomingQueueIds
  ])

  useEffect(() => {
    return () => {
      dragNodeRef.current?.classList.remove('dragging')
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current)
      }
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
    const drag = trackDrag
    const element = queueContentRef.current
    if (!drag || !element) {
      setQueueScrollGlowEdge(null)
      setTrackDragDropTarget('queue', null)
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
      setQueueScrollGlowEdge(null)
      setTrackDragDropTarget('queue', null)
      return
    }

    const distanceFromTop = drag.pointerY - rect.top
    const distanceFromBottom = rect.bottom - drag.pointerY
    if (distanceFromTop < QUEUE_DRAG_SCROLL_EDGE_PX && scrollElement.scrollTop > 0) {
      setQueueScrollGlowEdge('top')
      scrollElement.scrollTop = Math.max(0, scrollElement.scrollTop - Math.ceil((QUEUE_DRAG_SCROLL_EDGE_PX - distanceFromTop) / 4))
    } else if (
      distanceFromBottom < QUEUE_DRAG_SCROLL_EDGE_PX
      && scrollElement.scrollTop + scrollElement.clientHeight < scrollElement.scrollHeight
    ) {
      setQueueScrollGlowEdge('bottom')
      scrollElement.scrollTop += Math.ceil((QUEUE_DRAG_SCROLL_EDGE_PX - distanceFromBottom) / 4)
    } else {
      setQueueScrollGlowEdge(null)
    }

    const relativeY = drag.pointerY - rect.top + scrollElement.scrollTop
    const hasVisibleQueue = Boolean(currentTrack) || layout.upcomingCount > 0
    if (!hasVisibleQueue) {
      setTrackDragDropTarget('queue', {
        surface: 'queue',
        kind: 'empty',
        index: 0
      })
      return
    }

    let upcomingStartOffset = 0
    if (currentTrack) {
      upcomingStartOffset += queueSectionRowHeight + queueItemRowHeight
    }
    if (layout.upcomingCount > 0) {
      upcomingStartOffset += queueSectionRowHeight
    }

    let targetIndex = 0
    if (layout.upcomingCount > 0) {
      const localY = relativeY - upcomingStartOffset
      targetIndex = resolveQueueDropIndex(localY, queueItemRowHeight, layout.upcomingCount)
    }

    setTrackDragDropTarget('queue', {
      surface: 'queue',
      kind: 'upcoming',
      index: targetIndex
    })
  }, [
    currentTrack,
    layout.upcomingCount,
    trackDrag,
    queueItemRowHeight,
    queueSectionRowHeight,
    setTrackDragDropTarget
  ])

  useEffect(() => {
    const dragActive = Boolean(trackDrag)
    const hadDrag = previousDragActiveRef.current
    const previousUpcomingLength = previousUpcomingLengthRef.current

    if (hadDrag && !dragActive && upcomingQueueIds.length > previousUpcomingLength) {
      setIsDropSettling(true)
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current)
      }
      settleTimerRef.current = window.setTimeout(() => {
        setIsDropSettling(false)
        settleTimerRef.current = null
      }, 220)
    }

    previousDragActiveRef.current = dragActive
    previousUpcomingLengthRef.current = upcomingQueueIds.length
  }, [trackDrag, upcomingQueueIds.length])

  const formatDuration = useCallback((seconds: number): string => {
    if (!seconds || !isFinite(seconds)) return '--:--'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }, [])

  const insertDropIndex = trackDrag?.dropTarget?.surface === 'queue' && trackDrag.dropTarget.kind === 'empty'
    ? 0
    : trackDrag?.dropTarget?.surface === 'queue' && trackDrag.dropTarget.kind === 'upcoming'
      ? trackDrag.dropTarget.index
      : null
  const queueInsertTrackCount = trackDrag?.tracks.length ?? 0
  const isQueueDropActive = Boolean(trackDrag)
  const isQueueDropHover = trackDrag?.dropTarget?.surface === 'queue'
  const queueDropLabel = queueInsertTrackCount > 1
    ? `${isQueueDropHover ? 'Drop' : 'Drag'} ${queueInsertTrackCount} tracks to Queue`
    : `${isQueueDropHover ? 'Drop' : 'Drag'} track to Queue`

  useEffect(() => {
    if (!queueNowPlayingRevealRequest) return
    if (consumedQueueRevealRequestIdRef.current === queueNowPlayingRevealRequest.id) return

    const targetIndex = layout.currentTrackIndex
    if (targetIndex === null) return

    let canceled = false
    const scrollToTarget = () => {
      if (canceled) return
      if (!listRef.current) return

      listRef.current.scrollToRow({
        index: targetIndex,
        align: 'center',
        behavior: 'smooth'
      })
      consumedQueueRevealRequestIdRef.current = queueNowPlayingRevealRequest.id
      clearQueueNowPlayingRevealRequest(queueNowPlayingRevealRequest.id)
    }

    const frameId = window.requestAnimationFrame(scrollToTarget)
    return () => {
      canceled = true
      window.cancelAnimationFrame(frameId)
    }
  }, [clearQueueNowPlayingRevealRequest, layout.currentTrackIndex, queueNowPlayingRevealRequest, queueItemRowHeight, queueSectionRowHeight])

  const handleDragStart = useCallback((event: DragEvent<HTMLDivElement>, queueId: string, index: number) => {
    setDragQueueId(queueId)
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
    if (dragQueueId && dragIndex !== null && reorderDragOverIndex !== null && dragIndex !== reorderDragOverIndex) {
      moveUpcomingItem(dragQueueId, reorderDragOverIndex)
    }
    dragNodeRef.current?.classList.remove('dragging')
    setDragIndex(null)
    setDragQueueId(null)
    setReorderDragOverIndex(null)
  }, [dragIndex, dragQueueId, moveUpcomingItem, reorderDragOverIndex])

  const handleDragLeave = useCallback(() => {
    setReorderDragOverIndex(null)
  }, [])

  const handlePlayQueuedTrack = useCallback((queueId: string) => {
    void playQueuedItem(queueId, { manualStart: true })
  }, [playQueuedItem])

  const handleRemoveTrack = useCallback((event: MouseEvent<HTMLButtonElement>, queueId: string) => {
    event.stopPropagation()
    removeUpcomingItem(queueId)
  }, [removeUpcomingItem])

  const resolveRowHeight = useCallback((index: number) => {
    if (resolveQueueVirtualRowLocation(layout, index)?.kind === 'section') {
      return queueSectionRowHeight
    }
    return queueItemRowHeight
  }, [layout, queueItemRowHeight, queueSectionRowHeight])

  const isCurrentLoading = playbackState === 'loading'
  const currentLoadingProgress = isCurrentLoading
    && currentTrack
    && remoteLoadProgress
    && remoteLoadProgress.path === currentTrack.path
    ? remoteLoadProgress
    : null

  const rowProps = useMemo<QueueRowSharedProps>(() => ({
    model,
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
    onRemoveTrack: handleRemoveTrack
  }), [
    model,
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
    handleRemoveTrack
  ])

  useEffect(() => {
    const group = controllerGroupRef.current
    if (!group) return

    let frameId = 0
    const handleVirtualMove = (rawEvent: Event): void => {
      const event = rawEvent as CustomEvent<ControllerVirtualMoveDetail>
      const delta = event.detail.direction === 'up' ? -1 : 1
      let nextIndex = event.detail.currentIndex + delta
      while (nextIndex >= 0 && nextIndex < layout.rowCount) {
        const candidate = resolveQueueVirtualRow(model, nextIndex)
        if (
          candidate?.kind === 'track'
          && candidate.queueId !== null
          && candidate.variant === 'upcoming'
          && !isUnavailableQueueTrack(candidate.track)
        ) break
        nextIndex += delta
      }
      if (nextIndex < 0 || nextIndex >= layout.rowCount) return
      event.preventDefault()
      listRef.current?.scrollToRow({ index: nextIndex, align: 'center', behavior: 'auto' })

      let attempts = 8
      const focusMountedQueueItem = (): void => {
        const target = queueContentRef.current?.querySelector<HTMLElement>(
          `.queue-item[data-controller-index="${nextIndex}"]`
        )
        if (target) {
          focusControllerTarget(target)
          return
        }
        attempts -= 1
        if (attempts > 0) frameId = window.requestAnimationFrame(focusMountedQueueItem)
      }
      frameId = window.requestAnimationFrame(focusMountedQueueItem)
    }

    group.addEventListener(CONTROLLER_VIRTUAL_MOVE_EVENT, handleVirtualMove)
    return () => {
      window.cancelAnimationFrame(frameId)
      group.removeEventListener(CONTROLLER_VIRTUAL_MOVE_EVENT, handleVirtualMove)
    }
  }, [layout.rowCount, model])

  if (layout.rowCount === 0) {
    return (
      <div className={`queue-panel ${isQueueDropActive ? 'queue-panel-drop-active' : ''} ${isQueueDropHover ? 'queue-panel-drop-hover' : ''} ${isDropSettling ? 'queue-panel-drop-settle' : ''}`} ref={controllerGroupRef} data-controller-region="true" data-controller-region-id="queue" data-controller-group="queue-items" data-controller-axis="vertical" data-controller-virtual="true">
        <div className="queue-header">
          <h3>Queue</h3>
        </div>
        {isQueueDropActive && (
          <div className={`queue-drop-mode-label ${isQueueDropHover ? 'is-hover' : ''}`}>
            {queueDropLabel}
          </div>
        )}
        <div className="queue-empty-drop-zone-wrap" ref={queueContentRef}>
          <div className={`queue-empty-drop-zone ${trackDrag?.dropTarget?.surface === 'queue' && trackDrag.dropTarget.kind === 'empty' ? 'queue-empty-drop-zone-active' : ''}`}>
            <p>No tracks in queue</p>
            <p className="queue-empty-hint">
              {trackDrag ? 'Drop here to build a user queue' : 'Cmd/Ctrl-select tracks to drop them here'}
            </p>
          </div>
        </div>
      </div>
    )
  }

  const listHeight = listViewportHeight > 0 ? listViewportHeight : queueItemRowHeight * 8

  return (
    <div className={`queue-panel ${isQueueDropActive ? 'queue-panel-drop-active' : ''} ${isQueueDropHover ? 'queue-panel-drop-hover' : ''} ${isDropSettling ? 'queue-panel-drop-settle' : ''}`} ref={controllerGroupRef} data-controller-region="true" data-controller-region-id="queue" data-controller-group="queue-items" data-controller-axis="vertical" data-controller-virtual="true">
      <div className="queue-header">
        <h3>Queue</h3>
        <button className="queue-clear-btn" onClick={clearAllQueues} title="Clear queue history and queued tracks">
          Clear
        </button>
      </div>
      {isQueueDropActive && (
        <div className={`queue-drop-mode-label ${isQueueDropHover ? 'is-hover' : ''}`}>
          {queueDropLabel}
        </div>
      )}

      <div className="queue-content" ref={queueContentRef} data-controller-scroll>
        <div className={`queue-scroll-glow queue-scroll-glow-top ${queueScrollGlowEdge === 'top' ? 'active' : ''}`} />
        <div className={`queue-scroll-glow queue-scroll-glow-bottom ${queueScrollGlowEdge === 'bottom' ? 'active' : ''}`} />
        <List
          className="queue-list-virtualized"
          defaultHeight={QUEUE_ITEM_ROW_HEIGHT_FALLBACK_PX * 8}
          listRef={listRef}
          overscanCount={QUEUE_LIST_OVERSCAN_COUNT}
          rowComponent={QueueRow}
          rowCount={layout.rowCount}
          rowHeight={resolveRowHeight}
          rowProps={rowProps}
          style={{ height: listHeight, width: '100%' }}
        />
      </div>
    </div>
  )
}
