import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { usePlayerStore } from '../../stores/playerStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import {
  useUIStore,
  type TrackDragDropTarget,
  type TrackDragState,
  type TrackDragSpringTarget
} from '../../stores/uiStore'
import {
  isTrackDragSpringRequestCurrent,
  resolveTrackDragDropSurface,
  resolveTrackDragScrollDelta,
  resolveTrackInsertionIndex,
  TRACK_NAV_SPRING_OPEN_MS,
  TRACK_PLAYLIST_SPRING_OPEN_MS,
  TRACK_QUEUE_SPRING_OPEN_MS
} from './trackDragModel'

const SIDEBAR_OVERFLOW_SPRING_OPEN_MS = 200

interface DragFeedback {
  id: number
  message: string
  tone: 'success' | 'error'
}

let activeDropScrollEdgeElement: HTMLElement | null = null

function springTargetsEqual(left: TrackDragSpringTarget | null, right: TrackDragSpringTarget | null): boolean {
  if (left === right) return true
  if (!left || !right || left.kind !== right.kind) return false
  return left.kind === 'queue'
    || left.kind === 'sidebar-overflow'
    || left.kind === 'playlist-browser'
    || left.kind === 'playlist-back'
    || (right.kind === 'playlist' && left.playlistId === right.playlistId)
}

function resolveNumericDataset(element: Element, name: string): number | null {
  const raw = element.getAttribute(name)
  if (raw === null) return null
  const value = Number.parseInt(raw, 10)
  return Number.isInteger(value) ? value : null
}

function resolveIndexedDropTarget(
  element: Element,
  pointerY: number,
  rowSelector: string,
  rowAttribute: string,
  countAttribute: string
): number {
  const fixed = element.closest('[data-track-drop-queue-fixed-index]')
  const fixedIndex = fixed ? resolveNumericDataset(fixed, 'data-track-drop-queue-fixed-index') : null
  if (fixedIndex !== null) return Math.max(0, fixedIndex)
  const row = element.closest(rowSelector)
  if (row) {
    const rowIndex = resolveNumericDataset(row, rowAttribute)
    if (rowIndex !== null) {
      const rect = row.getBoundingClientRect()
      return resolveTrackInsertionIndex(rowIndex, pointerY, rect.top, rect.height)
    }
  }
  const container = element.closest(`[${countAttribute}]`)
  return Math.max(0, resolveNumericDataset(container ?? element, countAttribute) ?? 0)
}

function resolveDropTargetAtPoint(x: number, y: number, drag: TrackDragState): {
  target: TrackDragDropTarget | null
  springTarget: TrackDragSpringTarget | null
  scrollContainer: HTMLElement | null
} {
  const element = document.elementFromPoint(x, y)
  if (!element) return { target: null, springTarget: null, scrollContainer: null }
  const hasPortableItems = drag.items.some((item) => !item.missing && Boolean(item.path))

  if (element.closest('[data-track-drag-sidebar-overflow]') && hasPortableItems) {
    return { target: null, springTarget: { kind: 'sidebar-overflow' }, scrollContainer: null }
  }

  if (element.closest('[data-track-drag-playlist-back]')) {
    return { target: null, springTarget: { kind: 'playlist-back' }, scrollContainer: null }
  }

  if (element.closest('[data-track-drag-playlist-browser]')) {
    return { target: null, springTarget: { kind: 'playlist-browser' }, scrollContainer: null }
  }

  const playlistContainer = element.closest<HTMLElement>('[data-track-drop-playlist-id]')
  const queueContainer = element.closest<HTMLElement>('[data-track-drop-queue-count]')
  const sidebarTarget = element.closest<HTMLElement>('[data-sidebar-drop-target]')
  const surface = resolveTrackDragDropSurface(
    Boolean(playlistContainer),
    Boolean(queueContainer && hasPortableItems),
    Boolean(sidebarTarget && hasPortableItems)
  )

  if (surface === 'playlist' && playlistContainer) {
    const playlistId = resolveNumericDataset(playlistContainer, 'data-track-drop-playlist-id')
    if (playlistId !== null) {
      const samePlaylist = drag.source.kind === 'track-list' && drag.source.playlistId === playlistId
      if (samePlaylist || hasPortableItems) {
        const index = resolveIndexedDropTarget(
          element,
          y,
          '[data-track-drop-playlist-index]',
          'data-track-drop-playlist-index',
          'data-track-drop-playlist-count'
        )
        return {
          target: { surface: 'playlist', kind: 'insert', playlistId, index },
          springTarget: null,
          scrollContainer: playlistContainer
        }
      }
    }
  }

  if (surface === 'queue' && queueContainer) {
    const index = resolveIndexedDropTarget(
      element,
      y,
      '[data-track-drop-queue-index]',
      'data-track-drop-queue-index',
      'data-track-drop-queue-count'
    )
    return {
      target: {
        surface: 'queue',
        kind: resolveNumericDataset(queueContainer, 'data-track-drop-queue-count') === 0 ? 'empty' : 'upcoming',
        index
      },
      springTarget: null,
      scrollContainer: queueContainer
    }
  }

  if (surface === 'sidebar' && sidebarTarget) {
    const kind = sidebarTarget.dataset.sidebarDropTarget
    if (kind === 'playlist') {
      const playlistId = resolveNumericDataset(sidebarTarget, 'data-sidebar-drop-playlist-id')
      if (playlistId !== null) {
        return {
          target: { surface: 'sidebar', kind: 'playlist', playlistId },
          springTarget: { kind: 'playlist', playlistId },
          scrollContainer: null
        }
      }
    }
    if (kind === 'create-playlist') {
      return {
        target: { surface: 'sidebar', kind: 'create-playlist' },
        springTarget: null,
        scrollContainer: null
      }
    }
  }

  if (element.closest('[data-track-drop-queue-toggle]') && hasPortableItems && !useUIStore.getState().showQueue) {
    return { target: null, springTarget: { kind: 'queue' }, scrollContainer: null }
  }

  return { target: null, springTarget: null, scrollContainer: null }
}

function setResolvedDropTarget(target: TrackDragDropTarget | null): void {
  const state = useUIStore.getState()
  const currentSurface = state.trackDrag?.dropTarget?.surface
  if (target) {
    state.setTrackDragDropTarget(target.surface, target)
  } else if (currentSurface) {
    state.setTrackDragDropTarget(currentSurface, null)
  }
}

function autoScrollDropContainer(container: HTMLElement | null, pointerY: number): boolean {
  if (!container) return false
  const scroller = container.matches('.track-list-virtualized, .queue-list-virtualized')
    ? container
    : container.querySelector<HTMLElement>('.track-list-virtualized, .queue-list-virtualized') ?? container
  if (scroller.scrollHeight <= scroller.clientHeight) return false

  const rect = scroller.getBoundingClientRect()
  if (pointerY < rect.top || pointerY > rect.bottom) return false
  const delta = resolveTrackDragScrollDelta(
    pointerY,
    rect.top,
    rect.bottom,
    scroller.scrollTop > 0,
    scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight
  )
  if (delta === 0) return false
  const previousScrollTop = scroller.scrollTop
  scroller.scrollTop += delta
  if (activeDropScrollEdgeElement && activeDropScrollEdgeElement !== container) {
    delete activeDropScrollEdgeElement.dataset.trackDropScrollEdge
  }
  activeDropScrollEdgeElement = container
  container.dataset.trackDropScrollEdge = delta < 0 ? 'top' : 'bottom'
  return scroller.scrollTop !== previousScrollTop
}

function clearDropScrollEdges(): void {
  if (!activeDropScrollEdgeElement) return
  delete activeDropScrollEdgeElement.dataset.trackDropScrollEdge
  activeDropScrollEdgeElement = null
}

function TrackDragOverlay({ overlayRef }: { overlayRef: React.RefObject<HTMLDivElement | null> }) {
  const items = useUIStore((state) => state.trackDrag?.items ?? null)
  const source = useUIStore((state) => state.trackDrag?.source ?? null)
  const target = useUIStore((state) => state.trackDrag?.dropTarget ?? null)
  const springTarget = useUIStore((state) => state.trackDrag?.springTarget ?? null)
  const phase = useUIStore((state) => state.trackDrag?.phase ?? null)
  const playlists = usePlaylistStore((state) => state.playlists)
  if (!items || !source || phase === null) return null

  const playlistId = target?.surface === 'playlist' || (target?.surface === 'sidebar' && target.kind === 'playlist')
    ? target.playlistId
    : springTarget?.kind === 'playlist'
      ? springTarget.playlistId
      : null
  const playlistName = playlistId === null
    ? null
    : playlists.find((playlist) => playlist.id === playlistId)?.name ?? 'Playlist'
  let action = items.length === 1 ? 'Track' : `${items.length} tracks`
  if (phase === 'dropping') action = 'Finishing drop…'
  else if (target?.surface === 'queue') {
    const moving = source.kind === 'queue' && source.section === 'upcoming'
    action = moving ? 'Move in Queue' : `Insert in Queue · ${target.index + 1}`
  } else if (target?.surface === 'playlist') {
    const moving = source.kind === 'track-list' && source.playlistId === target.playlistId
    action = `${moving ? 'Move in' : 'Copy to'} ${playlistName}`
  } else if (target?.surface === 'sidebar' && target.kind === 'playlist') {
    action = `Add to ${playlistName}`
  } else if (target?.surface === 'sidebar') {
    action = 'Create Playlist'
  } else if (springTarget?.kind === 'playlist') {
    action = `Hold to open ${playlistName}`
  } else if (springTarget?.kind === 'queue') {
    action = 'Hold to open Queue'
  } else if (springTarget?.kind === 'sidebar-overflow') {
    action = 'Hold to show Playlists'
  } else if (springTarget?.kind === 'playlist-back') {
    action = 'Hold to go back'
  } else if (springTarget?.kind === 'playlist-browser') {
    action = 'Hold to browse Playlists'
  }

  const firstItem = items[0]
  const springDuration = springTarget?.kind === 'queue'
    ? TRACK_QUEUE_SPRING_OPEN_MS
    : springTarget?.kind === 'sidebar-overflow'
      ? SIDEBAR_OVERFLOW_SPRING_OPEN_MS
      : springTarget?.kind === 'playlist-back' || springTarget?.kind === 'playlist-browser'
        ? TRACK_NAV_SPRING_OPEN_MS
      : TRACK_PLAYLIST_SPRING_OPEN_MS
  return (
    <div
      ref={overlayRef}
      className={`track-drag-overlay ${items.length > 1 ? 'is-batch' : ''} ${target ? 'has-target' : ''} ${springTarget ? 'is-spring-loading' : ''}`.trim()}
      style={{ '--track-drag-spring-duration': `${springDuration}ms` } as CSSProperties}
      aria-hidden="true"
    >
      {items.length > 1 && <span className="track-drag-overlay-count">{items.length}</span>}
      <span className="track-drag-overlay-action">{action}</span>
      <strong>{items.length > 1 ? `${items.length} tracks` : firstItem?.title ?? 'Track'}</strong>
      <span>{items.length > 1 ? 'In visible order' : firstItem?.artist || 'Unknown Artist'}</span>
      {springTarget && <span className="track-drag-overlay-progress" />}
    </div>
  )
}

export default function TrackDragRuntime() {
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const lastPointerRef = useRef({ x: 0, y: 0 })
  const frameRef = useRef<number | null>(null)
  const springTimerRef = useRef<number | null>(null)
  const springTokenRef = useRef(0)
  const activeSpringTargetRef = useRef<TrackDragSpringTarget | null>(null)
  const feedbackTimerRef = useRef<number | null>(null)
  const [feedback, setFeedback] = useState<DragFeedback | null>(null)

  useEffect(() => useUIStore.subscribe((state, previous) => {
    const request = state.playlistNavigationRestoreRequest
    if (!request || request === previous.playlistNavigationRestoreRequest) return
    const restorePlaylistSelection = async () => {
      usePlaylistStore.getState().setSortState(request.sortState)
      if (request.playlistId === null) {
        usePlaylistStore.getState().clearSelection()
      } else {
        await usePlaylistStore.getState().selectPlaylist(request.playlistId)
      }
      useUIStore.getState().clearPlaylistNavigationRestoreRequest(request.id)
    }
    void restorePlaylistSelection().catch((error) => {
      console.error('Failed to restore playlist navigation:', error)
      useUIStore.getState().clearPlaylistNavigationRestoreRequest(request.id)
    })
  }), [])

  const showFeedback = useCallback((message: string, tone: DragFeedback['tone']) => {
    setFeedback({ id: Date.now(), message, tone })
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current)
    feedbackTimerRef.current = window.setTimeout(() => {
      setFeedback(null)
      feedbackTimerRef.current = null
    }, 2600)
  }, [])

  const restoreOrigin = useCallback(async (drag: TrackDragState) => {
    const ui = useUIStore.getState()
    const playlist = usePlaylistStore.getState()
    ui.setQueueVisible(drag.origin.showQueue)
    playlist.setSortState(drag.origin.playlistSortState)

    if (drag.origin.activeView !== 'playlist') {
      ui.replaceActiveView(drag.origin.activeView)
    }
    if (drag.origin.selectedPlaylistId === null) {
      playlist.clearSelection()
    } else if (playlist.selectedPlaylistId !== drag.origin.selectedPlaylistId) {
      await playlist.selectPlaylist(drag.origin.selectedPlaylistId)
    }
    if (drag.origin.activeView === 'playlist') {
      ui.replaceActiveView('playlist')
    }
  }, [])

  const cancelDrag = useCallback((message?: string) => {
    const drag = useUIStore.getState().trackDrag
    if (!drag) return
    springTokenRef.current += 1
    if (springTimerRef.current !== null) window.clearTimeout(springTimerRef.current)
    springTimerRef.current = null
    activeSpringTargetRef.current = null
    clearDropScrollEdges()
    useUIStore.getState().clearTrackDrag()
    void restoreOrigin(drag).catch((error) => {
      console.error('Failed to restore track drag origin:', error)
      showFeedback('The original view could not be fully restored.', 'error')
    })
    if (message) showFeedback(message, 'error')
  }, [restoreOrigin, showFeedback])

  const finalizeDrag = useCallback(async () => {
    const drag = useUIStore.getState().trackDrag
    if (!drag || drag.phase !== 'dragging') return
    const target = drag.dropTarget
    if (!target) {
      cancelDrag()
      return
    }
    useUIStore.getState().setTrackDragPhase('dropping')
    springTokenRef.current += 1

    try {
      const portablePaths = drag.items.filter((item) => !item.missing).map((item) => item.path)
      let message = 'Drop complete.'
      if (target.surface === 'queue') {
        if (
          drag.source.kind === 'queue'
          && drag.source.section === 'upcoming'
          && drag.source.queueId
          && drag.items.length === 1
        ) {
          const adjustedIndex = drag.source.index !== null && drag.source.index < target.index
            ? target.index - 1
            : target.index
          usePlayerStore.getState().moveUpcomingItem(drag.source.queueId, adjustedIndex)
          message = 'Queue order updated.'
        } else {
          await usePlayerStore.getState().enqueueTrackPaths(portablePaths, target.index)
          message = portablePaths.length === 1 ? 'Track added to Queue.' : `${portablePaths.length} tracks added to Queue.`
        }
      } else if (target.surface === 'sidebar' && target.kind === 'create-playlist') {
        useUIStore.getState().openSidebarPlaylistCreateRequest(portablePaths)
        message = 'Choose a name for the new playlist.'
      } else {
        const playlistId = target.playlistId
        const position = target.surface === 'playlist' ? target.index : 'end'
        const samePlaylist = drag.source.kind === 'track-list' && drag.source.playlistId === playlistId
        const entryIds = drag.items
          .map((item) => item.playlistEntryId)
          .filter((entryId): entryId is number => entryId !== null)
        if (samePlaylist && entryIds.length === drag.items.length && target.surface === 'playlist') {
          const result = await usePlaylistStore.getState().movePlaylistEntries(playlistId, entryIds, target.index)
          message = result.changed ? 'Playlist order updated.' : 'Tracks are already in that position.'
        } else {
          const result = await usePlaylistStore.getState().insertTracksIntoPlaylist(playlistId, portablePaths, position)
          if (result.insertedTrackPaths.length === 0) {
            message = portablePaths.length === 1 ? 'Track is already in that playlist.' : 'Those tracks are already in that playlist.'
          } else if (result.skippedTrackPaths.length > 0) {
            message = `Added ${result.insertedTrackPaths.length}; skipped ${result.skippedTrackPaths.length} already present.`
          } else {
            message = result.insertedTrackPaths.length === 1
              ? 'Track added to playlist.'
              : `${result.insertedTrackPaths.length} tracks added to playlist.`
          }
        }
        if (target.surface === 'playlist') {
          usePlaylistStore.getState().setSortState(null)
        }
      }

      if (drag.springOpened) {
        useUIStore.getState().commitTransientView(drag.origin)
      }
      clearDropScrollEdges()
      useUIStore.getState().clearTrackDrag()
      showFeedback(message, 'success')
    } catch (error) {
      console.error('Track drop failed:', error)
      useUIStore.getState().clearTrackDrag()
      await restoreOrigin(drag)
      showFeedback(error instanceof Error ? error.message : 'The drop could not be completed.', 'error')
    }
  }, [cancelDrag, restoreOrigin, showFeedback])

  const beginSpringTarget = useCallback((target: TrackDragSpringTarget | null) => {
    if (springTargetsEqual(activeSpringTargetRef.current, target)) return
    springTokenRef.current += 1
    const token = springTokenRef.current
    if (springTimerRef.current !== null) window.clearTimeout(springTimerRef.current)
    springTimerRef.current = null
    activeSpringTargetRef.current = target
    useUIStore.getState().setTrackDragSpringTarget(target)
    if (!target) return

    springTimerRef.current = window.setTimeout(() => {
      springTimerRef.current = null
      const drag = useUIStore.getState().trackDrag
      if (!drag || !isTrackDragSpringRequestCurrent(
        token,
        springTokenRef.current,
        springTargetsEqual(activeSpringTargetRef.current, target)
      )) return
      if (target.kind === 'queue') {
        useUIStore.getState().setQueueVisible(true)
        useUIStore.getState().markTrackDragSpringOpened()
        activeSpringTargetRef.current = null
        useUIStore.getState().setTrackDragSpringTarget(null)
        return
      }
      if (target.kind === 'sidebar-overflow') {
        document.querySelector<HTMLElement>('[data-track-drag-sidebar-overflow]')?.click()
        activeSpringTargetRef.current = null
        useUIStore.getState().setTrackDragSpringTarget(null)
        return
      }

      if (target.kind === 'playlist-back' || target.kind === 'playlist-browser') {
        usePlaylistStore.getState().clearSelection()
        useUIStore.getState().replaceActiveView('playlist')
        useUIStore.getState().markTrackDragSpringOpened()
        activeSpringTargetRef.current = null
        useUIStore.getState().setTrackDragSpringTarget(null)
        return
      }

      const openPlaylist = async () => {
        await usePlaylistStore.getState().selectPlaylist(target.playlistId, () => (
          isTrackDragSpringRequestCurrent(
            token,
            springTokenRef.current,
            springTargetsEqual(activeSpringTargetRef.current, target)
          )
        ))
        const latest = useUIStore.getState().trackDrag
        if (!latest || !isTrackDragSpringRequestCurrent(
          token,
          springTokenRef.current,
          springTargetsEqual(activeSpringTargetRef.current, target)
        )) return
        usePlaylistStore.getState().setSortState(null)
        useUIStore.getState().replaceActiveView('playlist')
        useUIStore.getState().markTrackDragSpringOpened()
        activeSpringTargetRef.current = null
        useUIStore.getState().setTrackDragSpringTarget(null)
      }
      void openPlaylist().catch((error) => {
        console.error('Failed to spring-open playlist:', error)
        cancelDrag('That playlist could not be opened.')
      })
    }, target.kind === 'queue'
      ? TRACK_QUEUE_SPRING_OPEN_MS
      : target.kind === 'sidebar-overflow'
        ? SIDEBAR_OVERFLOW_SPRING_OPEN_MS
        : target.kind === 'playlist-back' || target.kind === 'playlist-browser'
          ? TRACK_NAV_SPRING_OPEN_MS
        : TRACK_PLAYLIST_SPRING_OPEN_MS)
  }, [cancelDrag])

  useEffect(() => {
    const processFrame = () => {
      frameRef.current = null
      const drag = useUIStore.getState().trackDrag
      if (!drag || drag.phase !== 'dragging') return
      const pointer = lastPointerRef.current
      if (overlayRef.current) {
        overlayRef.current.style.transform = `translate3d(${pointer.x + 14}px, ${pointer.y + 14}px, 0)`
      }

      const resolved = resolveDropTargetAtPoint(pointer.x, pointer.y, drag)
      setResolvedDropTarget(resolved.target)
      beginSpringTarget(resolved.springTarget)

      if (
        resolved.target?.surface === 'playlist'
        && drag.source.kind === 'track-list'
        && drag.source.playlistId === resolved.target.playlistId
        && usePlaylistStore.getState().sortState !== null
      ) {
        usePlaylistStore.getState().setSortState(null)
      }

      clearDropScrollEdges()
      if (autoScrollDropContainer(resolved.scrollContainer, pointer.y)) {
        frameRef.current = window.requestAnimationFrame(processFrame)
      }
    }

    const scheduleFrame = () => {
      if (frameRef.current === null) frameRef.current = window.requestAnimationFrame(processFrame)
    }
    const handlePointerMove = (event: PointerEvent) => {
      const drag = useUIStore.getState().trackDrag
      if (!drag || event.pointerId !== drag.pointerId || drag.phase !== 'dragging') return
      lastPointerRef.current = { x: event.clientX, y: event.clientY }
      scheduleFrame()
    }
    const handlePointerUp = (event: PointerEvent) => {
      const drag = useUIStore.getState().trackDrag
      if (!drag || event.pointerId !== drag.pointerId) return
      lastPointerRef.current = { x: event.clientX, y: event.clientY }
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      processFrame()
      void finalizeDrag()
    }
    const handlePointerCancel = (event: PointerEvent) => {
      const drag = useUIStore.getState().trackDrag
      if (drag && event.pointerId === drag.pointerId) cancelDrag()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && useUIStore.getState().trackDrag) {
        event.preventDefault()
        cancelDrag()
      }
    }

    const unsubscribe = useUIStore.subscribe((state, previous) => {
      if (state.trackDrag && !previous.trackDrag) {
        lastPointerRef.current = { x: state.trackDrag.pointerX, y: state.trackDrag.pointerY }
        scheduleFrame()
      }
    })
    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)
    document.addEventListener('pointercancel', handlePointerCancel)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      unsubscribe()
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
      document.removeEventListener('pointercancel', handlePointerCancel)
      document.removeEventListener('keydown', handleKeyDown, true)
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      if (springTimerRef.current !== null) window.clearTimeout(springTimerRef.current)
      if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current)
    }
  }, [beginSpringTarget, cancelDrag, finalizeDrag])

  return createPortal((
    <>
      <TrackDragOverlay overlayRef={overlayRef} />
      <div className="track-drag-live-region" role="status" aria-live="polite" aria-atomic="true">
        {feedback?.message ?? ''}
      </div>
      {feedback && (
        <div key={feedback.id} className={`track-drag-feedback is-${feedback.tone}`} role={feedback.tone === 'error' ? 'alert' : 'status'}>
          {feedback.message}
        </div>
      )}
    </>
  ), document.body)
}
