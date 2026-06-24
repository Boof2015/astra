import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import { resolveCollectionTrackPaths } from '../../utils/collectionQueue'

interface MenuPosition {
  left: number
  top: number
}

const MENU_EDGE_PADDING_PX = 8

export default function CollectionQueueContextMenu() {
  const request = useUIStore((state) => state.collectionQueueMenu)
  const activeView = useUIStore((state) => state.activeView)
  const closeMenu = useUIStore((state) => state.closeCollectionQueueMenu)
  const enqueueTrackPaths = usePlayerStore((state) => state.enqueueTrackPaths)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const [busyAction, setBusyAction] = useState<'next' | 'end' | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    setBusyAction(null)
    setErrorMessage(null)
  }, [request])

  useLayoutEffect(() => {
    if (!request || !menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    setPosition({
      left: Math.min(
        Math.max(MENU_EDGE_PADDING_PX, request.x),
        Math.max(MENU_EDGE_PADDING_PX, window.innerWidth - rect.width - MENU_EDGE_PADDING_PX)
      ),
      top: Math.min(
        Math.max(MENU_EDGE_PADDING_PX, request.y),
        Math.max(MENU_EDGE_PADDING_PX, window.innerHeight - rect.height - MENU_EDGE_PADDING_PX)
      )
    })
  }, [request, errorMessage])

  useEffect(() => {
    if (!request) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) closeMenu()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }
    const handleViewportChange = () => closeMenu()

    document.addEventListener('mousedown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [closeMenu, request])

  useEffect(() => {
    closeMenu()
  }, [activeView, closeMenu])

  const runAction = useCallback(async (position: 'next' | 'end') => {
    if (!request || busyAction) return
    setBusyAction(position)
    setErrorMessage(null)
    try {
      const trackPaths = await resolveCollectionTrackPaths(request.target)
      if (trackPaths.length === 0) {
        setErrorMessage('No playable tracks in this collection.')
        return
      }
      await enqueueTrackPaths(trackPaths, position)
      closeMenu()
    } catch (error) {
      console.error('Failed to add collection to queue:', error)
      setErrorMessage('Could not add this collection to the queue.')
    } finally {
      setBusyAction(null)
    }
  }, [busyAction, closeMenu, enqueueTrackPaths, request])

  if (!request) return null

  const label = request.target.kind === 'album' ? request.target.album : request.target.name
  return createPortal(
    <div
      ref={menuRef}
      className="track-context-menu collection-queue-context-menu"
      role="menu"
      aria-label={`Queue actions for ${label}`}
      style={{
        left: position?.left ?? request.x,
        top: position?.top ?? request.y,
        visibility: position ? 'visible' : 'hidden'
      }}
      onContextMenu={(event) => event.preventDefault()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="collection-queue-context-menu-title" title={label}>{label}</div>
      <button
        type="button"
        className="track-context-menu-item"
        role="menuitem"
        disabled={busyAction !== null}
        onClick={() => void runAction('next')}
      >
        <span className="track-context-menu-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
          </svg>
        </span>
        {busyAction === 'next' ? 'Adding...' : 'Play Next'}
      </button>
      <button
        type="button"
        className="track-context-menu-item"
        role="menuitem"
        disabled={busyAction !== null}
        onClick={() => void runAction('end')}
      >
        <span className="track-context-menu-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M13 7h-2v4H7v2h4v4h2v-4h4v-2h-4V7zm-1-5C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8-8z" />
          </svg>
        </span>
        {busyAction === 'end' ? 'Adding...' : 'Add to Queue'}
      </button>
      {errorMessage && <div className="collection-queue-context-menu-error">{errorMessage}</div>}
    </div>,
    document.body
  )
}
