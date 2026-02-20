import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useUIStore, type AppView } from '../../stores/uiStore'
import { buildPlaylistDisplaySections } from '../../utils/playlistSystem'
import PlaylistCover from '../playlists/PlaylistCover'

const navItems: { id: AppView; label: string; icon: ReactNode }[] = [
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
]

const settingsIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export default function Sidebar() {
  const { activeView, setActiveView } = useUIStore()
  const playlists = usePlaylistStore((s) => s.playlists)
  const selectedPlaylistId = usePlaylistStore((s) => s.selectedPlaylistId)
  const loadPlaylists = usePlaylistStore((s) => s.loadPlaylists)
  const selectPlaylist = usePlaylistStore((s) => s.selectPlaylist)
  const favoriteTracks = useLibraryStore((s) => s.favoriteTracks)

  const [isOverflowOpen, setIsOverflowOpen] = useState(false)
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null)
  const popoutRef = useRef<HTMLDivElement | null>(null)
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

  const handleOpenPlaylist = async (playlistId: number) => {
    await selectPlaylist(playlistId)
    setActiveView('playlist')
    setIsOverflowOpen(false)
  }

  return (
    <aside className="sidebar">
      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`sidebar-icon-btn nav-btn ${activeView === item.id ? 'active' : ''}`}
            onClick={() => setActiveView(item.id)}
            aria-label={item.label}
          >
            {item.icon}
            <span className="nav-tooltip">{item.label}</span>
          </button>
        ))}
      </nav>

      {(sidebarQuickPlaylists.length > 0 || sidebarOverflowPlaylists.length > 0) && (
        <div className="sidebar-playlist-quick">
          {sidebarQuickPlaylists.map((playlist) => (
            <button
              key={playlist.id}
              className={`sidebar-icon-btn nav-btn sidebar-playlist-btn ${activeView === 'playlist' && selectedPlaylistId === playlist.id ? 'active' : ''}`}
              onClick={() => void handleOpenPlaylist(playlist.id)}
              aria-label={playlist.name}
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
            </button>
          ))}

          {sidebarOverflowPlaylists.length > 0 && (
            <button
              ref={overflowButtonRef}
              className={`sidebar-icon-btn nav-btn sidebar-playlist-overflow-btn ${isOverflowOpen ? 'active' : ''}`}
              onClick={() => {
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
        className={`sidebar-icon-btn nav-btn sidebar-settings-btn ${activeView === 'settings' ? 'active' : ''}`}
        onClick={() => setActiveView('settings')}
        aria-label="Settings"
      >
        {settingsIcon}
        <span className="nav-tooltip">Settings</span>
      </button>

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
                  className={`sidebar-playlist-popout-item ${activeView === 'playlist' && selectedPlaylistId === playlist.id ? 'active' : ''}`}
                  onClick={() => void handleOpenPlaylist(playlist.id)}
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
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </aside>
  )
}
