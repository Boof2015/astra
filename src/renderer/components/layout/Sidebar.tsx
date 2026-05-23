import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useUIStore, type AppView, type TrackDragDropTarget } from '../../stores/uiStore'
import { useGraphStore } from '../../stores/graphStore'
import { buildPlaylistDisplaySections } from '../../utils/playlistSystem'
import { formatPlaylistImportStatus } from '../../utils/playlistImportStatus'
import CreatePlaylistModal from '../playlists/CreatePlaylistModal'
import PlaylistCover from '../playlists/PlaylistCover'

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

export default function Sidebar() {
  const { activeView, setActiveView } = useUIStore()
  const trackDrag = useUIStore((s) => s.trackDrag)
  const setTrackDragDropTarget = useUIStore((s) => s.setTrackDragDropTarget)
  const sidebarPlaylistCreateRequest = useUIStore((s) => s.sidebarPlaylistCreateRequest)
  const clearSidebarPlaylistCreateRequest = useUIStore((s) => s.clearSidebarPlaylistCreateRequest)
  const graphEnabled = useGraphStore((s) => s.enabled)
  const openFullMap = useGraphStore((s) => s.openFullMap)
  const playlists = usePlaylistStore((s) => s.playlists)
  const selectedPlaylistId = usePlaylistStore((s) => s.selectedPlaylistId)
  const loadPlaylists = usePlaylistStore((s) => s.loadPlaylists)
  const createPlaylistWithOptions = usePlaylistStore((s) => s.createPlaylistWithOptions)
  const importPlaylistFromFile = usePlaylistStore((s) => s.importPlaylistFromFile)
  const clearPlaylistSelection = usePlaylistStore((s) => s.clearSelection)
  const selectPlaylist = usePlaylistStore((s) => s.selectPlaylist)
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
  const [isOverflowDragHover, setIsOverflowDragHover] = useState(false)
  const [sidebarDropSettledKey, setSidebarDropSettledKey] = useState<string | null>(null)
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null)
  const popoutRef = useRef<HTMLDivElement | null>(null)
  const overflowAutoOpenTimerRef = useRef<number | null>(null)
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

  const { sidebarQuickPlaylists, sidebarOverflowPlaylists } = useMemo(
    () => buildPlaylistDisplaySections(playlists, {
      trackCount: favoriteTracks.length,
      topArtworkHash: favoriteTracks[0]?.artwork_hash ?? null
    }, 3),
    [playlists, favoriteTracks]
  )
  const navItems = useMemo(
    () => baseNavItems.filter((item) => graphEnabled || item.id !== 'graph'),
    [graphEnabled]
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
      if (overflowAutoOpenTimerRef.current !== null) {
        window.clearTimeout(overflowAutoOpenTimerRef.current)
      }
      if (sidebarDropSettleTimerRef.current !== null) {
        window.clearTimeout(sidebarDropSettleTimerRef.current)
      }
    }
  }, [])

  useLayoutEffect(() => {
    if (!isOverflowOpen) {
      setOverflowPopoutStyle(null)
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

  useEffect(() => {
    if (!trackDrag) {
      setTrackDragDropTarget('sidebar', null)
      return
    }

    const target = document.elementFromPoint(trackDrag.pointerX, trackDrag.pointerY)
    if (!(target instanceof Element)) {
      setTrackDragDropTarget('sidebar', null)
      return
    }

    const dropElement = target.closest('[data-sidebar-drop-target]')
    if (!dropElement) {
      setTrackDragDropTarget('sidebar', null)
      return
    }

    const targetKind = dropElement.getAttribute('data-sidebar-drop-target')
    if (targetKind === 'playlist') {
      const playlistId = Number.parseInt(dropElement.getAttribute('data-sidebar-drop-playlist-id') ?? '', 10)
      if (!Number.isFinite(playlistId) || playlistId <= 0) {
        setTrackDragDropTarget('sidebar', null)
        return
      }
      setTrackDragDropTarget('sidebar', {
        surface: 'sidebar',
        kind: 'playlist',
        playlistId
      })
      return
    }

    if (targetKind === 'create-playlist') {
      setTrackDragDropTarget('sidebar', {
        surface: 'sidebar',
        kind: 'create-playlist'
      })
      return
    }

    setTrackDragDropTarget('sidebar', null)
  }, [setTrackDragDropTarget, trackDrag])

  useEffect(() => {
    if (!trackDrag || sidebarOverflowPlaylists.length === 0) {
      setIsOverflowDragHover(false)
      if (overflowAutoOpenTimerRef.current !== null) {
        window.clearTimeout(overflowAutoOpenTimerRef.current)
        overflowAutoOpenTimerRef.current = null
      }
      if (!trackDrag && overflowOpenedByDragRef.current) {
        overflowOpenedByDragRef.current = false
        setIsOverflowOpen(false)
      }
      return
    }

    const overflowButton = overflowButtonRef.current
    if (!overflowButton) {
      setIsOverflowDragHover(false)
      return
    }

    const rect = overflowButton.getBoundingClientRect()
    const isHoveringOverflowButton = trackDrag.pointerX >= rect.left
      && trackDrag.pointerX <= rect.right
      && trackDrag.pointerY >= rect.top
      && trackDrag.pointerY <= rect.bottom

    setIsOverflowDragHover(isHoveringOverflowButton)

    if (!isHoveringOverflowButton || isOverflowOpen) {
      if (overflowAutoOpenTimerRef.current !== null) {
        window.clearTimeout(overflowAutoOpenTimerRef.current)
        overflowAutoOpenTimerRef.current = null
      }
      return
    }

    if (overflowAutoOpenTimerRef.current !== null) {
      return
    }

    overflowAutoOpenTimerRef.current = window.setTimeout(() => {
      overflowAutoOpenTimerRef.current = null
      overflowOpenedByDragRef.current = true
      setIsOverflowOpen(true)
      requestAnimationFrame(() => {
        updateOverflowPopoutPosition()
      })
    }, 200)
  }, [isOverflowOpen, sidebarOverflowPlaylists.length, trackDrag, updateOverflowPopoutPosition])

  useEffect(() => {
    const previousTrackDrag = previousTrackDragRef.current
    previousTrackDragRef.current = trackDrag

    if (trackDrag) return
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
  }, [clearPlaylistSelection, openFullMap, setActiveView])

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

  return (
    <aside className="sidebar">
      <div className="sidebar-scroll-area">
        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`sidebar-icon-btn nav-btn ${activeView === item.id ? 'active' : ''}`}
              onClick={() => handleNavClick(item.id)}
              aria-label={item.label}
            >
              {item.icon}
              <span className="nav-tooltip">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-playlist-cluster">
          {(sidebarQuickPlaylists.length > 0 || sidebarOverflowPlaylists.length > 0) && (
            <div className="sidebar-playlist-quick">
              {sidebarQuickPlaylists.map((playlist) => (
                <button
                  key={playlist.id}
                  className={`sidebar-icon-btn nav-btn sidebar-playlist-btn ${activeView === 'playlist' && selectedPlaylistId === playlist.id ? 'active' : ''} ${!playlist.isSystemFavorites ? getSidebarDropClassName(`playlist:${playlist.id}`) : ''}`.trim()}
                  onClick={() => void handleOpenPlaylist(playlist.id)}
                  aria-label={playlist.name}
                  data-sidebar-drop-target={!playlist.isSystemFavorites ? 'playlist' : undefined}
                  data-sidebar-drop-playlist-id={!playlist.isSystemFavorites ? playlist.id : undefined}
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
                  <span className="nav-tooltip">{playlist.name}</span>
                  {!playlist.isSystemFavorites && (
                    <span className="sidebar-drop-label">Add to Playlist</span>
                  )}
                </button>
              ))}

              {sidebarOverflowPlaylists.length > 0 && (
                <button
                  ref={overflowButtonRef}
                  className={`sidebar-icon-btn nav-btn sidebar-playlist-overflow-btn ${isOverflowOpen ? 'active' : ''} ${Boolean(trackDrag) ? 'is-drop-active' : ''} ${isOverflowDragHover ? 'is-drop-hover' : ''}`.trim()}
                  onClick={() => {
                    overflowOpenedByDragRef.current = false
                    setIsOverflowOpen((value) => !value)
                    requestAnimationFrame(() => {
                      updateOverflowPopoutPosition()
                    })
                  }}
                  aria-label={isOverflowOpen ? 'Hide playlists' : `Show more playlists (${sidebarOverflowPlaylists.length})`}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="5" cy="12" r="1.8" />
                    <circle cx="12" cy="12" r="1.8" />
                    <circle cx="19" cy="12" r="1.8" />
                  </svg>
                  <span className="nav-tooltip">
                    {isOverflowOpen ? 'Hide playlists' : `More playlists (${sidebarOverflowPlaylists.length})`}
                  </span>
                </button>
              )}
            </div>
          )}

          <button
            type="button"
            className={`sidebar-playlist-create-btn ${getSidebarDropClassName('create-playlist')}`.trim()}
            onClick={() => {
              setCreatePlaylistTrackPaths(null)
              setIsCreatePlaylistModalOpen(true)
            }}
            aria-label="Create playlist"
            data-sidebar-drop-target="create-playlist"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span className="nav-tooltip">Create playlist</span>
            <span className="sidebar-drop-label">Create Playlist</span>
          </button>
        </div>
      </div>

      <div className="sidebar-bottom-actions">
        <button
          className={`sidebar-icon-btn nav-btn sidebar-settings-btn ${activeView === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveView('settings')}
          aria-label="Settings"
        >
          {settingsIcon}
          <span className="nav-tooltip">Settings</span>
        </button>
      </div>

      {isOverflowOpen && sidebarOverflowPlaylists.length > 0 && (
        <>
          <button
            type="button"
            className="sidebar-playlist-popout-backdrop"
            aria-label="Close playlists"
            onClick={() => setIsOverflowOpen(false)}
          />
          <div
            className="sidebar-playlist-popout"
            ref={popoutRef}
            style={overflowPopoutStyle ?? undefined}
          >
            <div className="sidebar-playlist-popout-header">Playlists</div>
            <div className="sidebar-playlist-popout-list">
              {sidebarOverflowPlaylists.map((playlist) => (
                <button
                  key={playlist.id}
                  className={`sidebar-playlist-popout-item ${activeView === 'playlist' && selectedPlaylistId === playlist.id ? 'active' : ''} ${getSidebarDropClassName(`playlist:${playlist.id}`)}`.trim()}
                  onClick={() => void handleOpenPlaylist(playlist.id)}
                  data-sidebar-drop-target="playlist"
                  data-sidebar-drop-playlist-id={playlist.id}
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
                  <span className="sidebar-drop-label">Add to Playlist</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      <CreatePlaylistModal
        isOpen={isCreatePlaylistModalOpen}
        onClose={handleCloseCreatePlaylistModal}
        onCreate={handleCreatePlaylist}
        onImport={createPlaylistTrackPaths ? undefined : handleImportPlaylist}
        isImporting={isImportingPlaylist}
        title={createPlaylistTrackPaths ? 'Create Playlist from Tracks' : 'Create Playlist'}
        pendingTrackCount={createPlaylistTrackPaths?.length}
      />
    </aside>
  )
}
