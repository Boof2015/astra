import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HomeDashboard, HomeRediscoveryRelease, HomeReleaseSummary } from '../../../types/home'
import { buildHomeSourceCards, playbackSourceKey, resolveCurrentPlaybackSource } from '../../../shared/home/playbackSources'
import type { PlaybackSourceContext } from '../../../types/playbackSource'
import { revealTrackInLibrary } from '../../hooks/useJumpToNowPlaying'
import { getLocalDayKey, HOME_SHELF_ITEM_LIMIT } from '../../../shared/home/homeDashboard'
import { useHorizontalWheelScroll } from '../../hooks/useHorizontalWheelScroll'
import { useLibraryStore } from '../../stores/libraryStore'
import { useListeningStatsStore } from '../../stores/listeningStatsStore'
import { usePlayerStore } from '../../stores/playerStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useUIStore } from '../../stores/uiStore'
import { HOME_REDISCOVERY_ROTATION_STORAGE_KEY } from '../../constants/settingsStorageKeys'
import { formatCompactDuration } from '../../utils/collectionDuration'
import { resolveHomeSkyDate, type HomeModuleId } from '../../utils/homePreferences'
import {
  buildSidebarPlaylistSections,
  FAVORITES_PLAYLIST_ID
} from '../../utils/playlistSystem'
import HomeBinaryClock from '../home/HomeBinaryClock'
import HomeCustomizeModal from '../home/HomeCustomizeModal'
import HomeJumpBackIn, { type JumpBackInCard } from '../home/HomeJumpBackIn'
import { activateHomePlayback, isHomePlaybackTargetActive } from '../../utils/homePlayback'
import { formatHomeAddedAge } from '../../utils/homeAddedAge'
import type { HomeRecentTrack } from '../../utils/homeRecentTracks'
import HomeSection from '../home/HomeSection'
import HomeShelfNavigation from '../home/HomeShelfNavigation'
import HomeExpandableGrid from '../home/HomeExpandableGrid'
import { HomeLoadingAlbumCards } from '../home/HomeLoadingCards'
import HomeRecentTracksDrawer from '../home/HomeRecentTracksDrawer'
import { HomeAlbumCard, HomeCollectionCard, HomeTrackRow } from '../home/HomeMediaCards'
import type { HomePlaybackControlState } from '../home/HomePlaybackControl'
import {
  chooseGreeting,
  createStarField,
  drawPixelSky,
  drawStarField,
  formatHomeClockDate,
  formatHomeClockTime,
  getAdaptivePalette,
  getMinuteStamp,
  type GreetingSelection,
  type StarField
} from './HomeView'

const GREETING_ROTATION_MS = 30 * 60 * 1000
interface RediscoveryRotation {
  dayKey: string
  index: number
}

function readRediscoveryRotation(): RediscoveryRotation {
  const today = getLocalDayKey(new Date())
  try {
    const parsed = JSON.parse(localStorage.getItem(HOME_REDISCOVERY_ROTATION_STORAGE_KEY) ?? 'null') as Partial<RediscoveryRotation> | null
    if (parsed?.dayKey === today && Number.isFinite(parsed.index)) {
      return { dayKey: today, index: Math.max(0, Math.trunc(parsed.index!)) }
    }
  } catch {
    // Fall back to today's first deterministic selection.
  }
  return { dayKey: today, index: 0 }
}

function persistRediscoveryRotation(rotation: RediscoveryRotation): void {
  try {
    localStorage.setItem(HOME_REDISCOVERY_ROTATION_STORAGE_KEY, JSON.stringify(rotation))
  } catch {
    // The in-memory rotation still works when storage is unavailable.
  }
}

function uniqueRecentTracks(tracks: HomeRecentTrack[]): HomeRecentTrack[] {
  const seen = new Set<string>()
  const result: HomeRecentTrack[] = []
  for (const track of tracks) {
    if (!track.path || seen.has(track.path)) continue
    seen.add(track.path)
    result.push(track)
  }
  return result
}


export default function HomeDashboardView() {
  const totalTrackCount = useLibraryStore((state) => state.totalTrackCount)
  const totalTrackDuration = useLibraryStore((state) => state.totalTrackDuration)
  const albums = useLibraryStore((state) => state.albums)
  const artists = useLibraryStore((state) => state.artists)
  const recentlyPlayedPaths = useLibraryStore((state) => state.recentlyPlayedPaths)
  const favoriteTrackPaths = useLibraryStore((state) => state.favoriteTrackPaths)
  const trackCacheVersion = useLibraryStore((state) => state.trackCacheVersion)
  const resolveTrackPaths = useLibraryStore((state) => state.resolveTrackPaths)
  const setLibraryViewMode = useLibraryStore((state) => state.setViewMode)
  const selectAlbum = useLibraryStore((state) => state.selectAlbum)

  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const playbackState = usePlayerStore((state) => state.playbackState)
  const currentQueueItemId = usePlayerStore((state) => state.currentQueueItemId)
  const queueItems = usePlayerStore((state) => state.queueItems)
  const queueSourceContext = useMemo(() => resolveCurrentPlaybackSource({ currentTrack, currentQueueItemId, queueItems }), [currentTrack, currentQueueItemId, queueItems])
  const artistBrowseMode = useLibraryStore((state) => state.artistBrowseMode)
  const togglePlay = usePlayerStore((state) => state.togglePlay)
  const startPlaybackContextByPaths = usePlayerStore((state) => state.startPlaybackContextByPaths)

  const playlists = usePlaylistStore((state) => state.playlists)
  const sidebarPinnedPlaylistIds = usePlaylistStore((state) => state.sidebarPinnedPlaylistIds)
  const loadPlaylists = usePlaylistStore((state) => state.loadPlaylists)
  const selectPlaylist = usePlaylistStore((state) => state.selectPlaylist)

  const homeGreetingTextMode = useUIStore((state) => state.homeGreetingTextMode)
  const homeSkyTimePreference = useUIStore((state) => state.homeSkyTimePreference)
  const homeLayoutPreference = useUIStore((state) => state.homeLayoutPreference)
  const setActiveView = useUIStore((state) => state.setActiveView)
  const openCollectionQueueMenu = useUIStore((state) => state.openCollectionQueueMenu)

  const listeningStatsEnabled = useListeningStatsStore((state) => state.enabled)
  const listeningDashboard = useListeningStatsStore((state) => state.dashboard)
  const listeningStatsLoading = useListeningStatsStore((state) => state.isLoading)
  const loadListeningDashboard = useListeningStatsStore((state) => state.loadDashboard)

  const [greeting, setGreeting] = useState<GreetingSelection>(() => chooseGreeting(null, new Date()))
  const [clockNow, setClockNow] = useState(() => new Date())
  const [dashboard, setDashboard] = useState<HomeDashboard | null>(null)
  const [dashboardLoading, setDashboardLoading] = useState(true)
  const initialDashboardLoading = dashboardLoading && dashboard === null
  const [dashboardError, setDashboardError] = useState<string | null>(null)
  const [rediscoveryRotation, setRediscoveryRotation] = useState(readRediscoveryRotation)
  const [isCustomizeOpen, setIsCustomizeOpen] = useState(false)
  const [isRecentTracksOpen, setIsRecentTracksOpen] = useState(false)
  const [pendingPlaybackKey, setPendingPlaybackKey] = useState<string | null>(null)
  const playbackRequestRef = useRef<string | null>(null)
  const isShuffleStarting = pendingPlaybackKey === 'library:shuffle'
  const [actionError, setActionError] = useState<string | null>(null)

  const heroRef = useRef<HTMLElement | null>(null)
  const skyCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const starCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const rediscoverRowRef = useRef<HTMLDivElement | null>(null)
  const newlyAddedRowRef = useRef<HTMLDivElement | null>(null)

  const hasLibraryContent = totalTrackCount > 0 || albums.length > 0 || artists.length > 0
  const activeAlbumIdentityKey = queueSourceContext?.type === 'album'
    ? queueSourceContext.identityKey ?? currentTrack?.albumIdentityKey ?? null
    : null

  useHorizontalWheelScroll(rediscoverRowRef)
  useHorizontalWheelScroll(newlyAddedRowRef)

  useEffect(() => {
    void loadPlaylists()
  }, [loadPlaylists])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const now = new Date()
      setGreeting((current) => chooseGreeting(current.id, now))
    }, GREETING_ROTATION_MS)
    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    if (homeGreetingTextMode !== 'clock' && homeGreetingTextMode !== 'binary-clock') return
    const updateClock = () => setClockNow(new Date())
    updateClock()
    let intervalId: number | null = null
    const now = new Date()
    const intervalMs = homeGreetingTextMode === 'binary-clock' ? 1000 : 60000
    const elapsedInInterval = homeGreetingTextMode === 'binary-clock'
      ? now.getMilliseconds()
      : now.getSeconds() * 1000 + now.getMilliseconds()
    const timeoutId = window.setTimeout(() => {
      updateClock()
      intervalId = window.setInterval(updateClock, intervalMs)
    }, Math.max(100, intervalMs - elapsedInInterval))
    return () => {
      window.clearTimeout(timeoutId)
      if (intervalId !== null) window.clearInterval(intervalId)
    }
  }, [homeGreetingTextMode])

  useEffect(() => {
    const card = heroRef.current
    const skyCanvas = skyCanvasRef.current
    const starCanvas = starCanvasRef.current
    if (!card || !skyCanvas || !starCanvas) return
    const skyContext = skyCanvas.getContext('2d')
    const starContext = starCanvas.getContext('2d')
    if (!skyContext || !starContext) return

    let width = 0
    let height = 0
    let starField: StarField = createStarField(1, 1)
    let rafId: number | null = null
    let lastSkyMinute = -1
    let active = true
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let palette = getAdaptivePalette(resolveHomeSkyDate(new Date(), homeSkyTimePreference))

    const applyTint = () => {
      card.style.setProperty('--home-greeting-top-color', `rgba(${palette.top[0]}, ${palette.top[1]}, ${palette.top[2]}, 0.62)`)
    }
    const drawSky = (realNow: Date) => {
      const skyDate = resolveHomeSkyDate(realNow, homeSkyTimePreference)
      palette = getAdaptivePalette(skyDate)
      drawPixelSky(skyCanvas, skyContext, width, height, palette)
      applyTint()
      lastSkyMinute = getMinuteStamp(realNow)
    }
    const syncDimensions = () => {
      const nextWidth = Math.max(1, Math.floor(card.clientWidth))
      const nextHeight = Math.max(1, Math.floor(card.clientHeight))
      if (nextWidth === width && nextHeight === height) return
      width = nextWidth
      height = nextHeight
      starField = createStarField(width, height)
      starCanvas.width = width
      starCanvas.height = height
      drawSky(new Date())
    }
    const drawFrame = (timestamp: number) => {
      if (!active) return
      const now = new Date()
      if (homeSkyTimePreference.mode === 'realtime' && getMinuteStamp(now) !== lastSkyMinute) drawSky(now)
      drawStarField(starContext, width, height, starField, palette.starOpacity, timestamp)
      rafId = window.requestAnimationFrame(drawFrame)
    }
    const start = () => {
      if (reduceMotion) {
        drawStarField(starContext, width, height, starField, palette.starOpacity, 0)
      } else if (rafId === null) {
        rafId = window.requestAnimationFrame(drawFrame)
      }
    }
    const stop = () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      rafId = null
    }
    const handleVisibility = () => {
      if (document.hidden) return stop()
      if (homeSkyTimePreference.mode === 'realtime') drawSky(new Date())
      start()
    }
    const observer = new ResizeObserver(syncDimensions)
    observer.observe(card)
    syncDimensions()
    drawSky(new Date())
    start()
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      active = false
      stop()
      observer.disconnect()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [homeSkyTimePreference])

  const dashboardRequestId = useRef(0)
  const loadHomeDashboard = useCallback(async () => {
    const requestId = ++dashboardRequestId.current
    setDashboardLoading(true)
    setDashboardError(null)
    try {
      const result = await window.electronAPI.library.getHomeDashboard({
        rotation: rediscoveryRotation.index,
        activeSource: queueSourceContext,
        artistBrowseMode,
        excludedReleaseIdentityKeys: activeAlbumIdentityKey ? [activeAlbumIdentityKey] : [],
        jumpBackInReleaseLimit: HOME_SHELF_ITEM_LIMIT,
        rediscoverLimit: HOME_SHELF_ITEM_LIMIT,
        newlyAddedLimit: HOME_SHELF_ITEM_LIMIT
      })
      if (requestId !== dashboardRequestId.current) return
      setDashboard(result)
      if (result.day_key !== rediscoveryRotation.dayKey) {
        const reset = { dayKey: result.day_key, index: 0 }
        persistRediscoveryRotation(reset)
        setRediscoveryRotation(reset)
      }
    } catch (error) {
      if (requestId === dashboardRequestId.current) setDashboardError(error instanceof Error ? error.message : 'Home recommendations could not be loaded.')
    } finally {
      if (requestId === dashboardRequestId.current) setDashboardLoading(false)
    }
  }, [activeAlbumIdentityKey, rediscoveryRotation, queueSourceContext, artistBrowseMode])

  useEffect(() => {
    void loadHomeDashboard()
    const refresh = () => { void loadHomeDashboard() }
    window.addEventListener('astra:home-sources-changed', refresh)
    return () => {
      dashboardRequestId.current += 1
      window.removeEventListener('astra:home-sources-changed', refresh)
    }
  }, [loadHomeDashboard, trackCacheVersion, playlists, favoriteTrackPaths])

  const favoriteTracks = useMemo(
    () => resolveTrackPaths(favoriteTrackPaths) as HomeRecentTrack[],
    [favoriteTrackPaths, resolveTrackPaths, trackCacheVersion]
  )
  const recentTracks = useMemo(
    () => uniqueRecentTracks(resolveTrackPaths(recentlyPlayedPaths) as HomeRecentTrack[]),
    [recentlyPlayedPaths, resolveTrackPaths, trackCacheVersion]
  )
  const pinnedPlaylists = useMemo(() => buildSidebarPlaylistSections(playlists, {
    trackCount: favoriteTracks.length,
    topArtworkHash: favoriteTracks[0]?.artwork_hash ?? null
  }, sidebarPinnedPlaylistIds).sidebarPinnedPlaylists, [favoriteTracks, playlists, sidebarPinnedPlaylistIds])

  const jumpBackInCards = useMemo<JumpBackInCard[]>(() => buildHomeSourceCards(
    dashboard?.recent_sources ?? [], queueSourceContext, dashboard?.active_source ?? null, HOME_SHELF_ITEM_LIMIT
  ), [dashboard, queueSourceContext])

  const visibleModules = homeLayoutPreference.modules.filter((module) => (
    module.visible && (module.id !== 'listening-snapshot' || listeningStatsEnabled)
  ))
  const hasListeningSnapshot = visibleModules.some((module) => module.id === 'listening-snapshot')

  useEffect(() => {
    if (!hasListeningSnapshot || !listeningStatsEnabled || listeningDashboard || listeningStatsLoading) return
    void loadListeningDashboard()
  }, [hasListeningSnapshot, listeningDashboard, listeningStatsEnabled, listeningStatsLoading, loadListeningDashboard])

  const clockGreeting = useMemo(() => ({
    primary: formatHomeClockTime(clockNow),
    subline: formatHomeClockDate(clockNow)
  }), [clockNow])

  const handleOpenRelease = async (release: HomeReleaseSummary) => {
    setLibraryViewMode('albums')
    await selectAlbum(release.album, release.artist, 'home', release.identity_key)
    setActiveView('library')
  }

  const handleOpenPlaylist = async (playlistId: number) => {
    await selectPlaylist(playlistId)
    setActiveView('playlist')
  }

  const getPlayback = (source: PlaybackSourceContext): HomePlaybackControlState => {
    const active = isHomePlaybackTargetActive(source, { currentSource: queueSourceContext, currentTrackPath: currentTrack?.path ?? null })
    return {
      active,
      playing: active && playbackState === 'playing',
      pending: pendingPlaybackKey === playbackSourceKey(source) || (active && playbackState === 'loading'),
      disabled: pendingPlaybackKey !== null || playbackState === 'loading'
    }
  }

  const runPlaybackRequest = async (key: string, title: string, action: () => Promise<void>) => {
    // A ref closes the gap before React renders disabled buttons after a click.
    if (playbackRequestRef.current || usePlayerStore.getState().playbackState === 'loading') return
    playbackRequestRef.current = key
    setPendingPlaybackKey(key)
    setActionError(null)
    try {
      await action()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Could not play ${title}.`)
    } finally {
      playbackRequestRef.current = null
      setPendingPlaybackKey(null)
    }
  }

  const playSource = async (source: PlaybackSourceContext, title: string, start?: () => Promise<void>) => {
    await runPlaybackRequest(playbackSourceKey(source), title, async () => {
      const player = usePlayerStore.getState()
      await activateHomePlayback(source, {
        currentSource: resolveCurrentPlaybackSource(player),
        currentTrackPath: player.currentTrack?.path ?? null
      }, {
        toggle: togglePlay,
        start: start ?? (async () => {
          let tracks: Awaited<ReturnType<typeof window.electronAPI.library.getTracksByPaths>>
          switch (source.type) {
            case 'playlist':
              tracks = source.playlistId === FAVORITES_PLAYLIST_ID
                ? await window.electronAPI.library.getFavorites()
                : await window.electronAPI.library.getPlaylistTracks(source.playlistId)
              break
            case 'album':
              tracks = await window.electronAPI.library.getTracksByAlbum(source.album, source.albumArtist, source.identityKey)
              break
            case 'artist':
              tracks = await window.electronAPI.library.getTracksByArtist(source.artist, artistBrowseMode)
              break
            case 'genre':
              tracks = await window.electronAPI.library.getTracksByGenre(source.genre)
              break
            case 'year':
              tracks = await window.electronAPI.library.getTracksByYear(source.year === 'unknown' ? null : source.year)
              break
            case 'track':
              tracks = await window.electronAPI.library.getTracksByPaths([source.trackPath])
              break
          }
          const paths = tracks.filter((track) => track.is_available !== 0).map((track) => track.path)
          if (!paths.length) throw new Error(`No available tracks in ${title}.`)
          await startPlaybackContextByPaths(paths, 0, {
            sourceContext: source,
            sourcePlaylistId: source.type === 'playlist' ? source.playlistId : null,
            contextLabel: title,
            startShuffled: source.type !== 'track'
          })
        })
      })
    })
  }

  const handleJumpOpen = async (card: JumpBackInCard) => {
    try {
      setActionError(null)
      const source = card.source
      const library = useLibraryStore.getState()
      if (source.type === 'playlist') return await handleOpenPlaylist(source.playlistId)
      if (source.type === 'track') { await revealTrackInLibrary(source.trackPath); return }
      if (source.type === 'album') {
        setLibraryViewMode('albums')
        await selectAlbum(source.album, source.albumArtist, 'home', source.identityKey)
      } else if (source.type === 'artist') await library.selectArtist(source.artist, 'home')
      else if (source.type === 'genre') await library.selectGenre(source.genre, 'home')
      else await library.selectYear(source.year, 'home')
      setActiveView('library')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Could not open ${card.title}.`)
    }
  }

  const handleShuffleLibrary = async () => {
    if (!hasLibraryContent) return
    await runPlaybackRequest('library:shuffle', 'Library', async () => {
      const paths = await window.electronAPI.library.getAvailableTrackPaths()
      if (!paths.length) throw new Error('No available tracks could be played.')
      await startPlaybackContextByPaths(paths, 0, { contextLabel: 'Library', shuffle: true, startShuffled: true })
    })
  }

  const handleRefreshRediscovery = () => {
    const today = getLocalDayKey(new Date())
    const next = {
      dayKey: today,
      index: rediscoveryRotation.dayKey === today ? rediscoveryRotation.index + 1 : 1
    }
    persistRediscoveryRotation(next)
    setRediscoveryRotation(next)
  }

  const renderJumpBackIn = () => (
    <HomeJumpBackIn cards={jumpBackInCards} loading={initialDashboardLoading} getPlayback={(card) => getPlayback(card.source)}
      onOpen={(card) => void handleJumpOpen(card)} onPlay={(card) => void playSource(card.source, card.title)} />
  )

  const releaseSource = (release: HomeReleaseSummary): PlaybackSourceContext => ({
    type: 'album', album: release.album, albumArtist: release.artist, identityKey: release.identity_key
  })

  const renderReleaseShelf = (
    id: 'rediscover' | 'newly-added',
    title: string,
    releases: readonly HomeReleaseSummary[],
    rowRef: typeof rediscoverRowRef,
    getReason: (release: HomeReleaseSummary) => string,
    action?: ReactNode
  ) => {
    if (!releases.length && !initialDashboardLoading) return null
    return (
      <HomeSection id={id} title={title} axis="horizontal" actions={<>{action}{!initialDashboardLoading && <HomeShelfNavigation scrollRef={rowRef} label={title} />}</>}>
        <div className="home-album-shelf" ref={rowRef}
          role={initialDashboardLoading ? 'status' : undefined}
          aria-label={initialDashboardLoading ? `Loading ${title}` : undefined}
          tabIndex={initialDashboardLoading ? -1 : undefined}>
          {initialDashboardLoading ? <HomeLoadingAlbumCards /> : releases.map((release) => (
            <HomeAlbumCard key={release.identity_key} title={release.album} subtitle={release.artist} artworkHash={release.artwork_hash}
              reason={getReason(release)} playback={getPlayback(releaseSource(release))}
              onOpen={() => void handleOpenRelease(release)} onPlay={() => void playSource(releaseSource(release), release.album)} />
          ))}
        </div>
      </HomeSection>
    )
  }

  const renderPinnedPlaylists = () => {
    if (!pinnedPlaylists.length) return null
    return (
      <HomeSection id="pinned-playlists" title="Pinned playlists">
        <HomeExpandableGrid items={pinnedPlaylists} getKey={(playlist) => String(playlist.id)} renderItem={(playlist) => (
          <HomeCollectionCard title={playlist.name} subtitle={`${playlist.track_count.toLocaleString()} tracks`}
            artworkHash={playlist.cover_hash} playlist favorites={playlist.isSystemFavorites}
            playback={getPlayback({ type: 'playlist', playlistId: playlist.id })}
            onOpen={() => void handleOpenPlaylist(playlist.id)}
            onPlay={() => void playSource({ type: 'playlist', playlistId: playlist.id }, playlist.name)}
            onContextMenu={(event) => {
              event.preventDefault()
              openCollectionQueueMenu({ target: { kind: 'playlist', playlistId: playlist.id, name: playlist.name }, x: event.clientX, y: event.clientY })
            }} />
        )} />
      </HomeSection>
    )
  }

  const handlePlayRecentTrack = (track: HomeRecentTrack) => {
    const index = recentTracks.findIndex((entry) => entry.path === track.path)
    if (index < 0) return
    void playSource({ type: 'track', trackPath: track.path }, track.title, async () => {
      // Home's preview and the drawer's search only filter the display, not the queue.
      await startPlaybackContextByPaths(recentTracks.map((entry) => entry.path), index, { recordSelectedTrack: true, contextLabel: 'Recently Played' })
    })
  }

  const renderRecentTracks = () => {
    if (!recentTracks.length) return null
    return (
      <HomeSection id="recent-tracks" title="Recently played tracks" actions={
        <button type="button" className="home-section-action" data-controller-focusable="true" aria-label="View all recently played tracks"
          onClick={() => { setActionError(null); setIsRecentTracksOpen(true) }}>View all</button>
      }>
        <HomeExpandableGrid items={recentTracks} initialRows={3} maxRows={6} getKey={(track) => track.path} renderItem={(track) => (
          <HomeTrackRow title={track.title} subtitle={track.artist} artworkHash={track.artwork_hash}
            playback={getPlayback({ type: 'track', trackPath: track.path })}
            onPlay={() => handlePlayRecentTrack(track)} />
        )} />
      </HomeSection>
    )
  }

  const renderListeningSnapshot = () => {
    if (!listeningDashboard?.status.startedAt) return null
    const summary = listeningDashboard.summary
    return (
      <HomeSection id="listening-snapshot" title="Listening snapshot" detail={listeningDashboard.range.toUpperCase()}>
        <div className="home-listening-snapshot">
          <article><span>Listening time</span><strong>{formatCompactDuration(summary.listenedSeconds) ?? '0 min'}</strong></article>
          <article><span>Qualified plays</span><strong>{summary.qualifiedPlays.toLocaleString()}</strong></article>
          <article><span>Tracks played</span><strong>{summary.tracksPlayed.toLocaleString()}</strong></article>
          <article><span>Active days</span><strong>{summary.activeDays.toLocaleString()}</strong></article>
        </div>
      </HomeSection>
    )
  }

  const renderModule = (id: HomeModuleId) => {
    if (id === 'jump-back-in') return renderJumpBackIn()
    if (id === 'rediscover') return renderReleaseShelf(
      'rediscover', 'Rediscover', dashboard?.rediscover_releases ?? [],
      rediscoverRowRef, (release) => (release as HomeRediscoveryRelease).reason,
      <button className="home-section-action" type="button" onClick={handleRefreshRediscovery} disabled={dashboardLoading} aria-label="Refresh Rediscover" data-controller-focusable={dashboardLoading ? undefined : 'true'}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>
        Refresh
      </button>
    )
    if (id === 'pinned-playlists') return renderPinnedPlaylists()
    if (id === 'recent-tracks') return renderRecentTracks()
    if (id === 'newly-added') return renderReleaseShelf(
      'newly-added', 'Newly added', dashboard?.newly_added_releases ?? [], newlyAddedRowRef,
      (release) => formatHomeAddedAge(release.latest_added_at)
    )
    if (id === 'listening-snapshot') return renderListeningSnapshot()
    return null
  }

  const greetingCopy = homeGreetingTextMode === 'clock' ? clockGreeting : greeting
  const libraryDuration = formatCompactDuration(totalTrackDuration)

  return (
    <div className="home-view home-dashboard-view">
      <div className="home-content home-dashboard-content" data-controller-scroll>
        <section ref={heroRef} className={`home-greeting-card home-dashboard-hero is-${greeting.bucket}`}>
          <canvas ref={skyCanvasRef} className="home-greeting-sky-canvas" aria-hidden="true" />
          <canvas ref={starCanvasRef} className="home-greeting-star-canvas" aria-hidden="true" />
          <div className="home-dashboard-hero-main">
            {homeGreetingTextMode !== 'off' && (
              <div className="home-greeting-content">
                {homeGreetingTextMode === 'binary-clock' ? (
                  <HomeBinaryClock date={clockNow} dateLabel={formatHomeClockDate(clockNow)} />
                ) : (
                  <>
                    <h1 className="home-greeting-message">{greetingCopy.primary}</h1>
                    {greetingCopy.subline.trim() && <p className="home-greeting-subline">{greetingCopy.subline}</p>}
                  </>
                )}
              </div>
            )}
            {hasLibraryContent && (
              <p className="home-dashboard-library-meta">
                {totalTrackCount.toLocaleString()} tracks <span>·</span> {albums.length.toLocaleString()} albums <span>·</span> {artists.length.toLocaleString()} artists
                {libraryDuration ? <><span>·</span> {libraryDuration}</> : null}
              </p>
            )}
          </div>
          <div className="home-dashboard-hero-actions">
            <button
              type="button"
              className="settings-btn settings-btn-primary home-hero-action"
              onClick={() => void handleShuffleLibrary()}
              disabled={!hasLibraryContent || pendingPlaybackKey !== null || playbackState === 'loading'}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M16 3h5v5" /><path d="M4 20 21 3" /><path d="M21 16v5h-5" /><path d="m15 15 6 6" /><path d="m4 4 5 5" /></svg>
              {isShuffleStarting ? 'Starting…' : 'Shuffle Library'}
            </button>
            <button type="button" className="settings-btn home-hero-action" onClick={() => setIsCustomizeOpen(true)}>Customize</button>
          </div>
        </section>

        {!hasLibraryContent ? (
          <div className="home-dashboard-empty">
            <span>Your library is quiet.</span>
            <p>Add a music folder to start building Home.</p>
            <button type="button" className="settings-btn settings-btn-primary" onClick={() => setActiveView('library')}>Open Library</button>
          </div>
        ) : (
          <div className="home-dashboard-modules">
            {(dashboardError || actionError) && (
              <div className="home-dashboard-error" role="alert">
                <span>{dashboardError ?? actionError}</span>
                {dashboardError ? (
                  <button type="button" onClick={() => void loadHomeDashboard()}>Retry</button>
                ) : (
                  <button type="button" onClick={() => setActionError(null)}>Dismiss</button>
                )}
              </div>
            )}
            {visibleModules.map((module) => <div key={module.id}>{renderModule(module.id)}</div>)}
          </div>
        )}
      </div>
      <HomeCustomizeModal isOpen={isCustomizeOpen} onClose={() => setIsCustomizeOpen(false)} />
      <HomeRecentTracksDrawer isOpen={isRecentTracksOpen} tracks={recentTracks}
        getPlayback={(track) => getPlayback({ type: 'track', trackPath: track.path })} onPlay={handlePlayRecentTrack}
        onClose={() => setIsRecentTracksOpen(false)} error={actionError} onDismissError={() => setActionError(null)} />
    </div>
  )
}
