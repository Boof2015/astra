import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FocusEvent, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useUIStore, type AppView, type TrackDragDropTarget } from '../../stores/uiStore'
import { useGraphStore } from '../../stores/graphStore'
import { useListeningStatsStore } from '../../stores/listeningStatsStore'
import { buildSidebarPlaylistSections } from '../../utils/playlistSystem'
import { formatPlaylistImportStatus } from '../../utils/playlistImportStatus'
import { runViewTransition } from '../../utils/viewTransitions'
import CreatePlaylistModal from '../playlists/CreatePlaylistModal'
import PlaylistCover from '../playlists/PlaylistCover'
import { usePresence } from '../../hooks/usePresence'
import type { DynamicPlaylistRulesV1 } from '../../../shared/playlists/dynamicPlaylist'

const baseNavItems: { id: AppView; label: string; icon: ReactNode }[] = [
  {
    id: 'home',
    label: 'Home',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
  },
  {
    id: 'library',
    label: 'Library',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
      </svg>
    ),
  },
  {
    id: 'stats',
    label: 'Stats',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 20V10" />
        <path d="M10 20V4" />
        <path d="M16 20v-7" />
        <path d="M22 20H2" />
      </svg>
    ),
  },
  {
    id: 'graph',
    label: 'Graph',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="5" cy="6" r="2.2" />
        <circle cx="18.5" cy="5.5" r="2.2" />
        <circle cx="12" cy="18" r="2.2" />
        <path d="M7 7.2 10.5 16" />
        <path d="m16.8 6.6-3.4 9.1" />
        <path d="M7.3 6h9" />
      </svg>
    ),
  },
  {
    id: 'eq',
    label: 'Equalizer',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="4" x2="4" y1="21" y2="14" />
        <line x1="4" x2="4" y1="10" y2="3" />
        <line x1="12" x2="12" y1="21" y2="12" />
        <line x1="12" x2="12" y1="8" y2="3" />
        <line x1="20" x2="20" y1="21" y2="16" />
        <line x1="20" x2="20" y1="12" y2="3" />
        <line x1="2" x2="6" y1="14" y2="14" />
        <line x1="10" x2="14" y1="8" y2="8" />
        <line x1="18" x2="22" y1="16" y2="16" />
      </svg>
    ),
  },
  {
    id: 'playlist',
    label: 'Playlists',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" />
        <line x1="3" y1="12" x2="3.01" y2="12" />
        <line x1="3" y1="18" x2="3.01" y2="18" />
      </svg>
    ),
  },
]

const settingsIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

interface SidebarTooltip {
  label: string
  left: number
  top: number
}

interface SidebarDropOverlayLabel {
  key: string
  label: string
  left: number
  top: number
}

export default function Sidebar() {
  const { activeView, setActiveView } = useUIStore()
  const trackDrag = useUIStore((s) => s.trackDrag)
  const sidebarPlaylistCreateRequest = useUIStore((s) => s.sidebarPlaylistCreateRequest)
  const clearSidebarPlaylistCreateRequest = useUIStore((s) => s.clearSidebarPlaylistCreateRequest)
  const openCollectionQueueMenu = useUIStore((s) => s.openCollectionQueueMenu)
  const graphEnabled = useGraphStore((s) => s.enabled)
  const listeningStatsEnabled = useListeningStatsStore((s) => s.enabled)
  const openFullMap = useGraphStore((s) => s.openFullMap)
  const playlists = usePlaylistStore((s) => s.playlists)
  const sidebarPinnedPlaylistIds = usePlaylistStore((s) => s.sidebarPinnedPlaylistIds)
  const moveSidebarPinnedPlaylist = usePlaylistStore((s) => s.moveSidebarPinnedPlaylist)
  const selectedPlaylistId = usePlaylistStore((s) => s.selectedPlaylistId)
  const loadPlaylists = usePlaylistStore((s) => s.loadPlaylists)
  const createPlaylistWithOptions = usePlaylistStore((s) => s.createPlaylistWithOptions)
  const createDynamicPlaylistWithOptions = usePlaylistStore((s) => s.createDynamicPlaylistWithOptions)
  const previewDynamicPlaylist = usePlaylistStore((s) => s.previewDynamicPlaylist)
  const importPlaylistFromFile = usePlaylistStore((s) => s.importPlaylistFromFile)
  const clearPlaylistSelection = usePlaylistStore((s) => s.clearSelection)
  const selectPlaylist = usePlaylistStore((s) => s.selectPlaylist)
  const clearLibrarySelection = useLibraryStore((s) => s.clearSelection)
  const favoriteTrackPaths = useLibraryStore((s) => s.favoriteTrackPaths)
  const trackCacheVersion = useLibraryStore((s) => s.trackCacheVersion)
  const resolveTrackPaths = useLibraryStore((s) => s.resolveTrackPaths)
  const favoriteTracks = useMemo(
    () => resolveTrackPaths(favoriteTrackPaths),
    [favoriteTrackPaths, resolveTrackPaths, trackCacheVersion]
  )

  const [isOverflowOpen, setIsOverflowOpen] = useState(false)
  const [isCreatePlaylistModalOpen, setIsCreatePlaylistModalOpen] = useState(false)
  const [createPlaylistTrackPaths, setCreatePlaylistTrackPaths] = useState<string[] | null>(null)
  const [isImportingPlaylist, setIsImportingPlaylist] = useState(false)
  const [sidebarDropSettledKey, setSidebarDropSettledKey] = useState<string | null>(null)
  const [sidebarTooltip, setSidebarTooltip] = useState<SidebarTooltip | null>(null)
  const [sidebarDropOverlayLabels, setSidebarDropOverlayLabels] = useState<SidebarDropOverlayLabel[]>([])
  const [draggedSidebarPlaylistId, setDraggedSidebarPlaylistId] = useState<number | null>(null)
  const [sidebarPinDropTargetId, setSidebarPinDropTargetId] = useState<number | null>(null)
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null)
  const sidebarRef = useRef<HTMLElement | null>(null)
  const popoutRef = useRef<HTMLDivElement | null>(null)
  const playlistScrollRef = useRef<HTMLDivElement | null>(null)
  const sidebarTooltipAnchorRef = useRef<HTMLElement | null>(null)
  const sidebarDropSettleTimerRef = useRef<number | null>(null)
  const overflowOpenedByDragRef = useRef(false)
  const previousTrackDragRef = useRef<typeof trackDrag>(null)
  const [overflowPopoutStyle, setOverflowPopoutStyle] = useState<{
    top: number
    left: number
    maxHeight: number
  } | null>(null)
  useEffect(() => {
    void loadPlaylists()
  }, [loadPlaylists])

  const { sidebarPinnedPlaylists: sidebarQuickPlaylists, sidebarOverflowPlaylists } = useMemo(
    () => buildSidebarPlaylistSections(playlists, {
      trackCount: favoriteTracks.length,
      topArtworkHash: favoriteTracks[0]?.artwork_hash ?? null
    }, sidebarPinnedPlaylistIds),
    [playlists, favoriteTracks, sidebarPinnedPlaylistIds]
  )
  const selectedPlaylistIsOverflow = selectedPlaylistId !== null
    && sidebarOverflowPlaylists.some((playlist) => playlist.id === selectedPlaylistId)
  const overflowPresence = usePresence(isOverflowOpen && sidebarOverflowPlaylists.length > 0)
  const navItems = useMemo(
    () => baseNavItems.filter((item) => (
      (graphEnabled || item.id !== 'graph')
      && (listeningStatsEnabled || item.id !== 'stats')
    )),
    [graphEnabled, listeningStatsEnabled]
  )

  const updateOverflowPopoutPosition = useCallback(() => {
    const anchor = overflowButtonRef.current
    if (!anchor) return

    const rect = anchor.getBoundingClientRect()
    const edgePadding = 10
    const gap = 12
    const assumedWidth = 304

    let left = rect.right + gap
    if (left + assumedWidth > window.innerWidth - edgePadding) {
      left = Math.max(edgePadding, rect.left - assumedWidth - gap)
    }

    let top = rect.top - 24
    const minTop = edgePadding
    const maxTop = Math.max(minTop, window.innerHeight - edgePadding - 220)
    top = Math.min(Math.max(top, minTop), maxTop)

    setOverflowPopoutStyle({
      top,
      left,
      maxHeight: Math.max(180, window.innerHeight - top - edgePadding)
    })
  }, [])

  const clearSidebarTooltip = useCallback(() => {
    sidebarTooltipAnchorRef.current = null
    setSidebarTooltip(null)
  }, [])

  const updateSidebarTooltip = useCallback((anchor: HTMLElement) => {
    const label = anchor.dataset.sidebarTooltip?.trim()

    if (!label || Boolean(trackDrag)) {
      clearSidebarTooltip()
      return
    }

    const rect = anchor.getBoundingClientRect()
    const nextTooltip: SidebarTooltip = {
      label,
      left: rect.right + 8,
      top: rect.top + rect.height / 2
    }

    setSidebarTooltip((current) => (
      current
        && current.label === nextTooltip.label
        && current.left === nextTooltip.left
        && current.top === nextTooltip.top
        ? current
        : nextTooltip
    ))
  }, [clearSidebarTooltip, trackDrag])

  const getTooltipAnchor = useCallback((target: EventTarget | null, sidebarElement: HTMLElement): HTMLElement | null => {
    if (!(target instanceof Element)) return null

    const anchor = target.closest<HTMLElement>('[data-sidebar-tooltip]')
    if (!anchor || !sidebarElement.contains(anchor)) return null

    return anchor
  }, [])

  const showSidebarTooltip = useCallback((anchor: HTMLElement) => {
    sidebarTooltipAnchorRef.current = anchor
    updateSidebarTooltip(anchor)
  }, [updateSidebarTooltip])

  const handleSidebarTooltipPointerOver = useCallback((event: PointerEvent<HTMLElement>) => {
    const anchor = getTooltipAnchor(event.target, event.currentTarget)
    if (!anchor) return

    showSidebarTooltip(anchor)
  }, [getTooltipAnchor, showSidebarTooltip])

  const handleSidebarTooltipPointerOut = useCallback((event: PointerEvent<HTMLElement>) => {
    const anchor = getTooltipAnchor(event.target, event.currentTarget)
    if (!anchor || sidebarTooltipAnchorRef.current !== anchor) return

    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && anchor.contains(nextTarget)) return

    clearSidebarTooltip()
  }, [clearSidebarTooltip, getTooltipAnchor])

  const handleSidebarTooltipFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const anchor = getTooltipAnchor(event.target, event.currentTarget)
    if (!anchor) return

    showSidebarTooltip(anchor)
  }, [getTooltipAnchor, showSidebarTooltip])

  const handleSidebarTooltipBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    const anchor = getTooltipAnchor(event.target, event.currentTarget)
    if (!anchor || sidebarTooltipAnchorRef.current !== anchor) return

    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && anchor.contains(nextTarget)) return

    clearSidebarTooltip()
  }, [clearSidebarTooltip, getTooltipAnchor])

  useEffect(() => {
    if (sidebarOverflowPlaylists.length === 0) {
      setIsOverflowOpen(false)
    }
  }, [sidebarOverflowPlaylists.length])

  useEffect(() => {
    if (!sidebarPlaylistCreateRequest) return
    setCreatePlaylistTrackPaths([...sidebarPlaylistCreateRequest.trackPaths])
    setIsCreatePlaylistModalOpen(true)
    clearSidebarPlaylistCreateRequest()
  }, [clearSidebarPlaylistCreateRequest, sidebarPlaylistCreateRequest])

  useEffect(() => {
    if (!isOverflowOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOverflowOpen(false)
      }
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (popoutRef.current?.contains(target)) return
      if (overflowButtonRef.current?.contains(target)) return
      setIsOverflowOpen(false)
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
    }
  }, [isOverflowOpen])

  useEffect(() => {
    return () => {
      if (sidebarDropSettleTimerRef.current !== null) {
        window.clearTimeout(sidebarDropSettleTimerRef.current)
      }
    }
  }, [])

  useLayoutEffect(() => {
    if (!isOverflowOpen) {
      return
    }

    updateOverflowPopoutPosition()

    const handleResize = () => {
      updateOverflowPopoutPosition()
    }

    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [isOverflowOpen, updateOverflowPopoutPosition])

  useLayoutEffect(() => {
    if (!sidebarTooltip) return

    const handleViewportChange = () => {
      const anchor = sidebarTooltipAnchorRef.current
      if (!anchor || !anchor.isConnected) {
        clearSidebarTooltip()
        return
      }

      updateSidebarTooltip(anchor)
    }

    window.addEventListener('resize', handleViewportChange)
    document.addEventListener('scroll', handleViewportChange, true)

    return () => {
      window.removeEventListener('resize', handleViewportChange)
      document.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [clearSidebarTooltip, sidebarTooltip, updateSidebarTooltip])

  useLayoutEffect(() => {
    if (!trackDrag) {
      setSidebarDropOverlayLabels([])
      return
    }

    const sidebar = sidebarRef.current
    if (!sidebar) return
    const updateLabels = () => {
      const labels = Array.from(sidebar.querySelectorAll<HTMLElement>('[data-sidebar-drop-overlay-label]'))
        .flatMap<SidebarDropOverlayLabel>((anchor) => {
          const label = anchor.dataset.sidebarDropOverlayLabel?.trim()
          const key = anchor.dataset.sidebarDropOverlayKey?.trim()
          if (!label || !key || !anchor.isConnected) return []
          const rect = anchor.getBoundingClientRect()
          const clipRect = anchor.closest<HTMLElement>('.sidebar-playlist-scroll')?.getBoundingClientRect()
            ?? sidebar.getBoundingClientRect()
          if (rect.bottom <= clipRect.top || rect.top >= clipRect.bottom) return []
          return [{ key, label, left: rect.right + 8, top: rect.top + rect.height / 2 }]
        })
      setSidebarDropOverlayLabels((current) => (
        current.length === labels.length
        && current.every((entry, index) => {
          const next = labels[index]
          return next
            && entry.key === next.key
            && entry.label === next.label
            && entry.left === next.left
            && entry.top === next.top
        })
          ? current
          : labels
      ))
    }

    updateLabels()
    window.addEventListener('resize', updateLabels)
    document.addEventListener('scroll', updateLabels, true)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateLabels)
    observer?.observe(sidebar)
    return () => {
      window.removeEventListener('resize', updateLabels)
      document.removeEventListener('scroll', updateLabels, true)
      observer?.disconnect()
    }
  }, [trackDrag])

  useEffect(() => {
    const previousTrackDrag = previousTrackDragRef.current
    previousTrackDragRef.current = trackDrag

    if (trackDrag) return
    if (overflowOpenedByDragRef.current) {
      overflowOpenedByDragRef.current = false
      setIsOverflowOpen(false)
    }
    if (previousTrackDrag?.dropTarget?.surface !== 'sidebar') return

    const settledKey = previousTrackDrag.dropTarget.kind === 'playlist'
      ? `playlist:${previousTrackDrag.dropTarget.playlistId}`
      : 'create-playlist'

    setSidebarDropSettledKey(settledKey)
    if (sidebarDropSettleTimerRef.current !== null) {
      window.clearTimeout(sidebarDropSettleTimerRef.current)
    }
    sidebarDropSettleTimerRef.current = window.setTimeout(() => {
      setSidebarDropSettledKey(null)
      sidebarDropSettleTimerRef.current = null
    }, 220)
  }, [trackDrag])

  const handleOpenPlaylist = async (playlistId: number) => {
    await selectPlaylist(playlistId)
    setActiveView('playlist')
    setIsOverflowOpen(false)
  }

  const handleCreatePlaylist = useCallback(async (name: string, coverImagePath: string | null) => {
    const playlist = await createPlaylistWithOptions({
      name,
      coverImagePath,
      trackPaths: createPlaylistTrackPaths ?? undefined
    })
    await selectPlaylist(playlist.id)
    setActiveView('playlist')
    setIsOverflowOpen(false)
    setCreatePlaylistTrackPaths(null)
  }, [createPlaylistTrackPaths, createPlaylistWithOptions, selectPlaylist, setActiveView])

  const handleCreateDynamicPlaylist = useCallback(async (name: string, coverImagePath: string | null, rules: DynamicPlaylistRulesV1) => {
    const playlist = await createDynamicPlaylistWithOptions({
      name,
      coverImagePath,
      rules
    })
    await selectPlaylist(playlist.id)
    setActiveView('playlist')
    setIsOverflowOpen(false)
    setCreatePlaylistTrackPaths(null)
  }, [createDynamicPlaylistWithOptions, selectPlaylist, setActiveView])

  const handleCloseCreatePlaylistModal = useCallback(() => {
    setIsCreatePlaylistModalOpen(false)
    setCreatePlaylistTrackPaths(null)
    clearSidebarPlaylistCreateRequest()
  }, [clearSidebarPlaylistCreateRequest])

  const handleImportPlaylist = useCallback(async (): Promise<boolean> => {
    if (isImportingPlaylist) return false

    setIsImportingPlaylist(true)
    try {
      const result = await importPlaylistFromFile()
      if (!result) return false

      const status = formatPlaylistImportStatus(result)
      if (status.tone === 'error') {
        throw new Error(status.message)
      }

      if (result.playlistId !== null && result.playlistId > 0 && result.importedCount + result.missingEntryCount > 0) {
        await selectPlaylist(result.playlistId)
        setActiveView('playlist')
        setIsOverflowOpen(false)
      }

      return true
    } catch (error) {
      console.error('Failed to import playlist:', error)
      throw error
    } finally {
      setIsImportingPlaylist(false)
    }
  }, [importPlaylistFromFile, isImportingPlaylist, selectPlaylist, setActiveView])

  const handleNavClick = useCallback((view: AppView) => {
    if (view === 'library' && activeView === 'library') {
      const library = useLibraryStore.getState()
      const isDetailActive = Boolean(
        library.selectedAlbum
        || library.selectedArtist
        || library.selectedGenre
        || library.selectedYear !== null
      )
      if (isDetailActive) {
        void runViewTransition(() => clearLibrarySelection(), 'library-context-backward')
      }
      return
    }

    if (view === 'playlist') {
      clearPlaylistSelection()
      setActiveView('playlist')
      setIsOverflowOpen(false)
      return
    }

    if (view === 'graph') {
      openFullMap()
    }

    setActiveView(view)
  }, [activeView, clearLibrarySelection, clearPlaylistSelection, openFullMap, setActiveView])

  const activeSidebarDropTarget = trackDrag?.dropTarget?.surface === 'sidebar'
    ? trackDrag.dropTarget
    : null

  const getSidebarDropKey = (dropTarget: TrackDragDropTarget | null): string | null => {
    if (!dropTarget || dropTarget.surface !== 'sidebar') return null
    return dropTarget.kind === 'playlist' ? `playlist:${dropTarget.playlistId}` : 'create-playlist'
  }

  const getSidebarDropClassName = (targetKey: string): string => {
    const classes = ['sidebar-drop-target']
    if (Boolean(trackDrag)) {
      classes.push('is-drop-active')
    }
    if (getSidebarDropKey(activeSidebarDropTarget) === targetKey) {
      classes.push('is-drop-hover')
    }
    if (sidebarDropSettledKey === targetKey) {
      classes.push('is-drop-settle')
    }
    return classes.join(' ')
  }

  const handleSidebarPlaylistDragStart = useCallback((event: DragEvent<HTMLButtonElement>, playlistId: number) => {
    if (trackDrag) {
      event.preventDefault()
      return
    }
    setDraggedSidebarPlaylistId(playlistId)
    setSidebarPinDropTargetId(playlistId)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-astra-sidebar-playlist', String(playlistId))
  }, [trackDrag])

  const handleSidebarPlaylistDragOver = useCallback((event: DragEvent<HTMLButtonElement>, playlistId: number) => {
    if (draggedSidebarPlaylistId === null) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setSidebarPinDropTargetId(playlistId)

    const scroller = playlistScrollRef.current
    if (!scroller) return
    const rect = scroller.getBoundingClientRect()
    const edgeSize = 36
    if (event.clientY < rect.top + edgeSize) {
      scroller.scrollBy({ top: -18 })
    } else if (event.clientY > rect.bottom - edgeSize) {
      scroller.scrollBy({ top: 18 })
    }
  }, [draggedSidebarPlaylistId])

  const handleSidebarPlaylistDrop = useCallback((event: DragEvent<HTMLButtonElement>, targetPlaylistId: number) => {
    event.preventDefault()
    const transferredPlaylistId = Number.parseInt(
      event.dataTransfer.getData('application/x-astra-sidebar-playlist'),
      10
    )
    const sourcePlaylistId = Number.isInteger(transferredPlaylistId)
      ? transferredPlaylistId
      : draggedSidebarPlaylistId
    setDraggedSidebarPlaylistId(null)
    setSidebarPinDropTargetId(null)
    if (sourcePlaylistId === null || sourcePlaylistId === targetPlaylistId) return
    const targetIndex = sidebarPinnedPlaylistIds.indexOf(targetPlaylistId)
    if (targetIndex < 0) return
    moveSidebarPinnedPlaylist(sourcePlaylistId, targetIndex)
  }, [draggedSidebarPlaylistId, moveSidebarPinnedPlaylist, sidebarPinnedPlaylistIds])

  const handleSidebarPlaylistDragEnd = useCallback(() => {
    setDraggedSidebarPlaylistId(null)
    setSidebarPinDropTargetId(null)
  }, [])

  return (
    <aside
      ref={sidebarRef}
      className="sidebar"
      data-controller-region="true"
      data-controller-region-id="sidebar"
      data-controller-group="sidebar-items"
      data-controller-axis="vertical"
      data-controller-auto-items="true"
      onPointerOver={handleSidebarTooltipPointerOver}
      onPointerOut={handleSidebarTooltipPointerOut}
      onFocus={handleSidebarTooltipFocus}
      onBlur={handleSidebarTooltipBlur}
    >
      <nav className="sidebar-nav sidebar-primary-nav" data-controller-tabstrip="sidebar-nav">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`sidebar-icon-btn nav-btn ${activeView === item.id ? 'active' : ''} ${trackDrag && item.id === 'playlist' ? 'is-track-drag-nav-target' : ''} ${trackDrag?.springTarget?.kind === 'playlist-browser' && item.id === 'playlist' ? 'is-track-drag-nav-hover' : ''}`.trim()}
            onClick={() => handleNavClick(item.id)}
            aria-label={item.label}
            data-controller-tab={item.id}
            data-sidebar-tooltip={item.label}
            data-track-drag-playlist-browser={item.id === 'playlist' ? '' : undefined}
          >
            {item.icon}
          </button>
        ))}
      </nav>

      <div className="sidebar-playlist-region">
        <div
          className="sidebar-playlist-scroll"
          ref={playlistScrollRef}
          data-controller-scroll
        >
          <div className="sidebar-playlist-quick">
            {sidebarQuickPlaylists.map((playlist) => {
              const isDragging = draggedSidebarPlaylistId === playlist.id
              const isPinDropTarget = sidebarPinDropTargetId === playlist.id && !isDragging
              return (
                <button
                  key={playlist.id}
                  draggable={!trackDrag}
                  className={`sidebar-icon-btn nav-btn sidebar-playlist-btn ${activeView === 'playlist' && selectedPlaylistId === playlist.id ? 'active' : ''} ${!playlist.isSystemFavorites && playlist.kind !== 'dynamic' ? getSidebarDropClassName(`playlist:${playlist.id}`) : trackDrag ? 'is-drop-unavailable' : ''} ${isDragging ? 'is-pin-dragging' : ''} ${isPinDropTarget ? 'is-pin-drop-target' : ''}`.trim()}
                  onClick={() => void handleOpenPlaylist(playlist.id)}
                  onDragStart={(event) => handleSidebarPlaylistDragStart(event, playlist.id)}
                  onDragOver={(event) => handleSidebarPlaylistDragOver(event, playlist.id)}
                  onDrop={(event) => handleSidebarPlaylistDrop(event, playlist.id)}
                  onDragEnd={handleSidebarPlaylistDragEnd}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setIsOverflowOpen(false)
                    openCollectionQueueMenu({
                      target: { kind: 'playlist', playlistId: playlist.id, name: playlist.name },
                      x: event.clientX,
                      y: event.clientY
                    })
                  }}
                  aria-label={playlist.name}
                  data-controller-context="true"
                  data-sidebar-tooltip={playlist.name}
                  data-sidebar-drop-target={!playlist.isSystemFavorites && playlist.kind !== 'dynamic' ? 'playlist' : undefined}
                  data-sidebar-drop-playlist-id={!playlist.isSystemFavorites && playlist.kind !== 'dynamic' ? playlist.id : undefined}
                  data-sidebar-drop-overlay-key={!playlist.isSystemFavorites && playlist.kind !== 'dynamic' ? `playlist:${playlist.id}` : undefined}
                  data-sidebar-drop-overlay-label={!playlist.isSystemFavorites && playlist.kind !== 'dynamic' ? `Add to ${playlist.name}` : undefined}
                >
                  {playlist.isSystemFavorites ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                    </svg>
                  ) : (
                    <PlaylistCover
                      hash={playlist.cover_hash}
                      name={playlist.name}
                      className="sidebar-playlist-btn-cover"
                    />
                  )}
                </button>
              )
            })}
          </div>
        </div>

        <div className="sidebar-playlist-footer">
          {sidebarOverflowPlaylists.length > 0 && (
            <button
              ref={overflowButtonRef}
              className={`sidebar-icon-btn nav-btn sidebar-playlist-overflow-btn ${isOverflowOpen || (activeView === 'playlist' && selectedPlaylistIsOverflow) ? 'active' : ''} ${Boolean(trackDrag) ? 'is-drop-active' : ''} ${trackDrag?.springTarget?.kind === 'sidebar-overflow' ? 'is-drop-hover' : ''}`.trim()}
              onClick={(event) => {
                overflowOpenedByDragRef.current = Boolean(trackDrag) && !event.nativeEvent.isTrusted
                setIsOverflowOpen((value) => !value)
                requestAnimationFrame(() => updateOverflowPopoutPosition())
              }}
              aria-label={isOverflowOpen ? 'Hide playlists' : `Show more playlists (${sidebarOverflowPlaylists.length})`}
              aria-expanded={isOverflowOpen}
              data-sidebar-tooltip={isOverflowOpen ? 'Hide playlists' : `More playlists (${sidebarOverflowPlaylists.length})`}
              data-track-drag-sidebar-overflow={trackDrag && !isOverflowOpen ? '' : undefined}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5" cy="12" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="19" cy="12" r="1.8" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className={`sidebar-playlist-create-btn ${getSidebarDropClassName('create-playlist')}`.trim()}
            onClick={() => {
              setCreatePlaylistTrackPaths(null)
              setIsCreatePlaylistModalOpen(true)
            }}
            aria-label="Create playlist"
            data-sidebar-tooltip="Create playlist"
            data-sidebar-drop-target="create-playlist"
            data-sidebar-drop-overlay-key="create-playlist"
            data-sidebar-drop-overlay-label="Create Playlist"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="sidebar-bottom-actions">
        <button
          className={`sidebar-icon-btn nav-btn sidebar-settings-btn ${activeView === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveView('settings')}
          aria-label="Settings"
          data-sidebar-tooltip="Settings"
        >
          {settingsIcon}
        </button>
      </div>

      {overflowPresence.shouldRender && (
        <>
          <button
            type="button"
            className="sidebar-playlist-popout-backdrop"
            data-presence={overflowPresence.phase}
            aria-hidden={overflowPresence.phase === 'exiting'}
            aria-label="Close playlists"
            onClick={() => setIsOverflowOpen(false)}
          />
          <div
            className="sidebar-playlist-popout"
            data-presence={overflowPresence.phase}
            aria-hidden={overflowPresence.phase === 'exiting'}
            ref={popoutRef}
            style={overflowPopoutStyle ?? undefined}
          >
            <div className="sidebar-playlist-popout-header">More Playlists</div>
            <div className="sidebar-playlist-popout-list">
              {sidebarOverflowPlaylists.map((playlist) => (
                <button
                  key={playlist.id}
                  className={`sidebar-playlist-popout-item ${activeView === 'playlist' && selectedPlaylistId === playlist.id ? 'active' : ''} ${!playlist.isSystemFavorites && playlist.kind !== 'dynamic' ? getSidebarDropClassName(`playlist:${playlist.id}`) : trackDrag ? 'is-drop-unavailable' : ''}`.trim()}
                  onClick={() => void handleOpenPlaylist(playlist.id)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setIsOverflowOpen(false)
                    openCollectionQueueMenu({
                      target: { kind: 'playlist', playlistId: playlist.id, name: playlist.name },
                      x: event.clientX,
                      y: event.clientY
                    })
                  }}
                  data-sidebar-drop-target={!playlist.isSystemFavorites && playlist.kind !== 'dynamic' ? 'playlist' : undefined}
                  data-controller-context="true"
                  data-sidebar-drop-playlist-id={!playlist.isSystemFavorites && playlist.kind !== 'dynamic' ? playlist.id : undefined}
                >
                  <PlaylistCover
                    hash={playlist.cover_hash}
                    name={playlist.name}
                    isFavorites={playlist.isSystemFavorites}
                    className="sidebar-playlist-popout-cover"
                  />
                  <span className="sidebar-playlist-popout-meta">
                    <span className="sidebar-playlist-popout-name">{playlist.name}</span>
                    <span className="sidebar-playlist-popout-count">
                      {playlist.track_count} {playlist.track_count === 1 ? 'track' : 'tracks'}
                    </span>
                  </span>
                  {!playlist.isSystemFavorites && playlist.kind !== 'dynamic' && <span className="sidebar-drop-label">Add to Playlist</span>}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {sidebarTooltip && createPortal(
        <div
          className="sidebar-nav-tooltip"
          role="tooltip"
          style={{ left: sidebarTooltip.left, top: sidebarTooltip.top }}
        >
          {sidebarTooltip.label}
        </div>,
        document.body
      )}
      {trackDrag && sidebarDropOverlayLabels.length > 0 && createPortal(
        <div className="sidebar-drop-overlay-labels" aria-hidden="true">
          {sidebarDropOverlayLabels.map((entry) => (
            <div
              key={entry.key}
              className={`sidebar-drop-overlay-label ${getSidebarDropKey(activeSidebarDropTarget) === entry.key ? 'is-drop-hover' : ''}`.trim()}
              style={{ left: entry.left, top: entry.top }}
            >
              {entry.label}
            </div>
          ))}
        </div>,
        document.body
      )}
      <CreatePlaylistModal
        isOpen={isCreatePlaylistModalOpen}
        onClose={handleCloseCreatePlaylistModal}
        onCreate={handleCreatePlaylist}
        onCreateDynamic={handleCreateDynamicPlaylist}
        onPreviewDynamic={previewDynamicPlaylist}
        allowDynamic={!createPlaylistTrackPaths}
        onImport={createPlaylistTrackPaths ? undefined : handleImportPlaylist}
        isImporting={isImportingPlaylist}
        title={createPlaylistTrackPaths ? 'Create Playlist from Tracks' : 'Create Playlist'}
        pendingTrackCount={createPlaylistTrackPaths?.length}
      />
    </aside>
  )
}
