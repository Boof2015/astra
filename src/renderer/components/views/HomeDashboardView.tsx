import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { HomeDashboard, HomeRediscoveryRelease, HomeReleaseSummary } from '../../../types/home'
import { getLocalDayKey } from '../../../shared/home/homeDashboard'
import { useHorizontalWheelScroll } from '../../hooks/useHorizontalWheelScroll'
import { useLibraryStore } from '../../stores/libraryStore'
import { useListeningStatsStore } from '../../stores/listeningStatsStore'
import { usePlayerStore } from '../../stores/playerStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useUIStore } from '../../stores/uiStore'
import { HOME_REDISCOVERY_ROTATION_STORAGE_KEY } from '../../constants/settingsStorageKeys'
import { formatCompactDuration } from '../../utils/collectionDuration'
import { resolveHomeSkyDate, type HomeModuleId } from '../../utils/homePreferences'
import { resolveHomeShelfLimits } from '../../utils/homeShelfLimits'
import {
  buildAllDisplayPlaylists,
  buildSidebarPlaylistSections,
  FAVORITES_PLAYLIST_ID,
  type DisplayPlaylist
} from '../../utils/playlistSystem'
import AlbumArtwork from '../library/AlbumArtwork'
import HomeCustomizeModal from '../home/HomeCustomizeModal'
import PlaylistCover from '../playlists/PlaylistCover'
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
interface HomeTrack {
  path: string
  title: string
  artist: string
  album: string
  artwork_hash: string | null
}

type JumpBackInCard =
  | {
      kind: 'album'
      key: string
      title: string
      subtitle: string
      artworkHash: string | null
      detail: string
      lastPlayedAt: number
      active: boolean
      release: HomeReleaseSummary
    }
  | {
      kind: 'playlist'
      key: string
      title: string
      subtitle: string
      artworkHash: string | null
      detail: string
      lastPlayedAt: number
      active: boolean
      playlist: DisplayPlaylist
    }

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

function releaseDetail(release: HomeReleaseSummary): string {
  const parts = [`${release.track_count} ${release.track_count === 1 ? 'track' : 'tracks'}`]
  if (release.year) parts.push(String(release.year))
  return parts.join(' · ')
}

function uniqueRecentTracks(tracks: HomeTrack[], limit = 10): HomeTrack[] {
  const seen = new Set<string>()
  const result: HomeTrack[] = []
  for (const track of tracks) {
    if (!track.path || seen.has(track.path)) continue
    seen.add(track.path)
    result.push(track)
    if (result.length >= limit) break
  }
  return result
}

function HomeReleaseCard({
  release,
  reason,
  onOpen,
  onPlay,
  isPending
}: {
  release: HomeReleaseSummary
  reason: string
  onOpen: () => void
  onPlay: () => void
  isPending: boolean
}) {
  return (
    <article className="home-release-card">
      <button
        type="button"
        className="home-release-open"
        onClick={onOpen}
        data-controller-focusable="true"
        data-controller-context="true"
        aria-label={`Open ${release.album} by ${release.artist}`}
      >
        <span className="home-release-artwork">
          <AlbumArtwork hash={release.artwork_hash} alt={release.album} variant="card" />
        </span>
        <span className="home-release-copy">
          <strong>{release.album}</strong>
          <span>{release.artist}</span>
          <small className="home-release-reason">{reason}</small>
        </span>
      </button>
      <button
        type="button"
        className="home-card-play"
        onClick={onPlay}
        disabled={isPending}
        aria-label={`Play ${release.album}`}
        title={`Play ${release.album}`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
      </button>
    </article>
  )
}

function HomeShelfNavigation({
  scrollRef,
  label
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  label: string
}) {
  const [scrollState, setScrollState] = useState({ hasOverflow: false, canScrollBack: false, canScrollForward: false })

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const update = () => {
      const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth)
      const nextState = {
        hasOverflow: maxScrollLeft > 2,
        canScrollBack: element.scrollLeft > 2,
        canScrollForward: element.scrollLeft < maxScrollLeft - 2
      }
      setScrollState((current) => (
        current.hasOverflow === nextState.hasOverflow
        && current.canScrollBack === nextState.canScrollBack
        && current.canScrollForward === nextState.canScrollForward
          ? current
          : nextState
      ))
    }
    const resizeObserver = new ResizeObserver(update)
    const mutationObserver = new MutationObserver(update)
    resizeObserver.observe(element)
    mutationObserver.observe(element, { childList: true, subtree: true })
    element.addEventListener('scroll', update, { passive: true })
    const frameId = window.requestAnimationFrame(update)
    return () => {
      window.cancelAnimationFrame(frameId)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      element.removeEventListener('scroll', update)
    }
  })

  if (!scrollState.hasOverflow) return null

  const move = (direction: -1 | 1) => {
    const element = scrollRef.current
    if (!element) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollBy({
      left: direction * Math.max(260, element.clientWidth * 0.72),
      behavior: reducedMotion ? 'auto' : 'smooth'
    })
  }

  return (
    <div className="home-shelf-navigation" aria-label={`${label} shelf navigation`}>
      <button
        type="button"
        onClick={() => move(-1)}
        disabled={!scrollState.canScrollBack}
        aria-label={`Scroll ${label} left`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <button
        type="button"
        onClick={() => move(1)}
        disabled={!scrollState.canScrollForward}
        aria-label={`Scroll ${label} right`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
      </button>
    </div>
  )
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
  const queueSourceContext = usePlayerStore((state) => state.queueSourceContext)
  const play = usePlayerStore((state) => state.play)
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
  const [dashboardError, setDashboardError] = useState<string | null>(null)
  const [rediscoveryRotation, setRediscoveryRotation] = useState(readRediscoveryRotation)
  const [isCustomizeOpen, setIsCustomizeOpen] = useState(false)
  const [pendingPlaybackKey, setPendingPlaybackKey] = useState<string | null>(null)
  const [isShuffleStarting, setIsShuffleStarting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [homeContentWidth, setHomeContentWidth] = useState(() => window.innerWidth)

  const heroRef = useRef<HTMLElement | null>(null)
  const skyCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const starCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const jumpRowRef = useRef<HTMLDivElement | null>(null)
  const rediscoverRowRef = useRef<HTMLDivElement | null>(null)
  const pinnedRowRef = useRef<HTMLDivElement | null>(null)
  const recentRowRef = useRef<HTMLDivElement | null>(null)
  const newlyAddedRowRef = useRef<HTMLDivElement | null>(null)

  const hasLibraryContent = totalTrackCount > 0 || albums.length > 0 || artists.length > 0
  const activeAlbumIdentityKey = queueSourceContext?.type === 'album'
    ? queueSourceContext.identityKey ?? currentTrack?.albumIdentityKey ?? null
    : null

  useHorizontalWheelScroll(jumpRowRef)
  useHorizontalWheelScroll(rediscoverRowRef)
  useHorizontalWheelScroll(pinnedRowRef)
  useHorizontalWheelScroll(recentRowRef)
  useHorizontalWheelScroll(newlyAddedRowRef)

  useEffect(() => {
    void loadPlaylists()
  }, [loadPlaylists])

  useEffect(() => {
    const element = heroRef.current
    if (!element) return
    const update = () => setHomeContentWidth(element.clientWidth)
    const observer = new ResizeObserver(update)
    observer.observe(element)
    update()
    return () => observer.disconnect()
  }, [])

  const shelfLimits = useMemo(() => resolveHomeShelfLimits(homeContentWidth), [homeContentWidth])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const now = new Date()
      setGreeting((current) => chooseGreeting(current.id, now))
    }, GREETING_ROTATION_MS)
    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    if (homeGreetingTextMode !== 'clock') return
    const updateClock = () => setClockNow(new Date())
    updateClock()
    let intervalId: number | null = null
    const now = new Date()
    const timeoutId = window.setTimeout(() => {
      updateClock()
      intervalId = window.setInterval(updateClock, 60000)
    }, Math.max(100, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds())))
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

  const loadHomeDashboard = useCallback(async () => {
    setDashboardLoading(true)
    setDashboardError(null)
    try {
      const result = await window.electronAPI.library.getHomeDashboard({
        rotation: rediscoveryRotation.index,
        excludedReleaseIdentityKeys: activeAlbumIdentityKey ? [activeAlbumIdentityKey] : [],
        jumpBackInReleaseLimit: shelfLimits.jumpBackIn,
        rediscoverLimit: shelfLimits.rediscover,
        newlyAddedLimit: shelfLimits.newlyAdded
      })
      setDashboard(result)
      if (result.day_key !== rediscoveryRotation.dayKey) {
        const reset = { dayKey: result.day_key, index: 0 }
        persistRediscoveryRotation(reset)
        setRediscoveryRotation(reset)
      }
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : 'Home recommendations could not be loaded.')
    } finally {
      setDashboardLoading(false)
    }
  }, [activeAlbumIdentityKey, rediscoveryRotation, shelfLimits])

  useEffect(() => {
    void loadHomeDashboard()
  }, [loadHomeDashboard, trackCacheVersion])

  const favoriteTracks = useMemo(
    () => resolveTrackPaths(favoriteTrackPaths) as HomeTrack[],
    [favoriteTrackPaths, resolveTrackPaths, trackCacheVersion]
  )
  const recentTracks = useMemo(
    () => uniqueRecentTracks(resolveTrackPaths(recentlyPlayedPaths) as HomeTrack[], shelfLimits.recentTracks),
    [recentlyPlayedPaths, resolveTrackPaths, shelfLimits.recentTracks, trackCacheVersion]
  )
  const allDisplayPlaylists = useMemo(() => buildAllDisplayPlaylists(playlists, {
    trackCount: favoriteTracks.length,
    topArtworkHash: favoriteTracks[0]?.artwork_hash ?? null
  }), [favoriteTracks, playlists])
  const pinnedPlaylists = useMemo(() => buildSidebarPlaylistSections(playlists, {
    trackCount: favoriteTracks.length,
    topArtworkHash: favoriteTracks[0]?.artwork_hash ?? null
  }, sidebarPinnedPlaylistIds).sidebarPinnedPlaylists, [favoriteTracks, playlists, sidebarPinnedPlaylistIds])

  const jumpBackInCards = useMemo<JumpBackInCard[]>(() => {
    const activeCards: JumpBackInCard[] = []
    if (queueSourceContext?.type === 'album' && currentTrack) {
      const identityKey = queueSourceContext.identityKey ?? currentTrack.albumIdentityKey ?? `${currentTrack.album}\0${currentTrack.albumArtist ?? currentTrack.artist}`
      const release = dashboard?.recent_releases.find((entry) => entry.identity_key === identityKey) ?? {
        identity_key: identityKey,
        album: queueSourceContext.album || currentTrack.album,
        artist: queueSourceContext.albumArtist ?? currentTrack.albumArtist ?? currentTrack.artist,
        year: currentTrack.year ?? null,
        artwork_hash: currentTrack.artworkHash ?? null,
        track_count: 0,
        available_track_count: 1,
        play_count: 0,
        favorite_track_count: 0,
        last_played_at: null,
        latest_added_at: 0
      }
      activeCards.push({
        kind: 'album', key: `album:${identityKey}`, title: release.album, subtitle: release.artist,
        artworkHash: release.artwork_hash, detail: releaseDetail(release), lastPlayedAt: Number.MAX_SAFE_INTEGER,
        active: true, release
      })
    } else if (queueSourceContext?.type === 'playlist') {
      const playlist = allDisplayPlaylists.find((entry) => entry.id === queueSourceContext.playlistId)
      if (playlist?.track_count) {
        activeCards.push({
          kind: 'playlist', key: `playlist:${playlist.id}`, title: playlist.name,
          subtitle: playlist.isSystemFavorites ? 'Favorites' : playlist.kind === 'dynamic' ? 'Dynamic playlist' : 'Playlist',
          artworkHash: playlist.cover_hash, detail: `${playlist.track_count} tracks`, lastPlayedAt: Number.MAX_SAFE_INTEGER,
          active: true, playlist
        })
      }
    }

    const historical: JumpBackInCard[] = [
      ...(dashboard?.recent_releases ?? []).map((release): JumpBackInCard => ({
        kind: 'album', key: `album:${release.identity_key}`, title: release.album, subtitle: release.artist,
        artworkHash: release.artwork_hash, detail: releaseDetail(release), lastPlayedAt: release.last_played_at ?? 0,
        active: false, release
      })),
      ...allDisplayPlaylists
        .filter((playlist) => playlist.last_played_at !== null && playlist.track_count > 0)
        .map((playlist): JumpBackInCard => ({
          kind: 'playlist', key: `playlist:${playlist.id}`, title: playlist.name,
          subtitle: playlist.kind === 'dynamic' ? 'Dynamic playlist' : 'Playlist', artworkHash: playlist.cover_hash,
          detail: `${playlist.track_count} tracks`, lastPlayedAt: playlist.last_played_at ?? 0, active: false, playlist
        }))
    ].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt || a.key.localeCompare(b.key))

    const seen = new Set(activeCards.map((card) => card.key))
    for (const card of historical) {
      if (seen.has(card.key)) continue
      activeCards.push(card)
      seen.add(card.key)
      if (activeCards.length >= shelfLimits.jumpBackIn) break
    }
    return activeCards
  }, [allDisplayPlaylists, currentTrack, dashboard?.recent_releases, queueSourceContext, shelfLimits.jumpBackIn])

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

  const handlePlayRelease = async (release: HomeReleaseSummary) => {
    const pendingKey = `album:${release.identity_key}`
    if (pendingPlaybackKey) return
    setPendingPlaybackKey(pendingKey)
    setActionError(null)
    try {
      const tracks = await window.electronAPI.library.getTracksByAlbum(release.album, release.artist, release.identity_key)
      const paths = tracks.filter((track) => track.is_available !== 0).map((track) => track.path)
      await startPlaybackContextByPaths(paths, 0, {
        contextLabel: release.album,
        sourceContext: { type: 'album', album: release.album, albumArtist: release.artist, identityKey: release.identity_key },
        startShuffled: true
      })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Could not play ${release.album}.`)
    } finally {
      setPendingPlaybackKey(null)
    }
  }

  const handlePlayPlaylist = async (playlist: DisplayPlaylist) => {
    const pendingKey = `playlist:${playlist.id}`
    if (pendingPlaybackKey) return
    setPendingPlaybackKey(pendingKey)
    setActionError(null)
    try {
      const tracks = playlist.id === FAVORITES_PLAYLIST_ID
        ? await window.electronAPI.library.getFavorites()
        : await window.electronAPI.library.getPlaylistTracks(playlist.id)
      const paths = tracks.filter((track) => track.is_available !== 0).map((track) => track.path)
      await startPlaybackContextByPaths(paths, 0, {
        sourcePlaylistId: playlist.id,
        contextLabel: playlist.name,
        startShuffled: true
      })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Could not play ${playlist.name}.`)
    } finally {
      setPendingPlaybackKey(null)
    }
  }

  const handleJumpPlay = async (card: JumpBackInCard) => {
    if (card.active) {
      if (playbackState !== 'playing') {
        try {
          setActionError(null)
          await play()
        } catch (error) {
          setActionError(error instanceof Error ? error.message : `Could not continue ${card.title}.`)
        }
      }
      return
    }
    if (card.kind === 'album') await handlePlayRelease(card.release)
    else await handlePlayPlaylist(card.playlist)
  }

  const handleShuffleLibrary = async () => {
    if (!hasLibraryContent || isShuffleStarting) return
    setIsShuffleStarting(true)
    setActionError(null)
    try {
      const paths = await window.electronAPI.library.getAvailableTrackPaths()
      if (!paths.length) throw new Error('No available tracks could be played.')
      await startPlaybackContextByPaths(paths, 0, { contextLabel: 'Library', shuffle: true, startShuffled: true })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not shuffle the library.')
    } finally {
      setIsShuffleStarting(false)
    }
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

  const renderJumpBackIn = () => {
    if (!jumpBackInCards.length) return null
    const [featuredCard, ...remainingCards] = jumpBackInCards
    const renderCard = (card: JumpBackInCard, featured = false) => (
      <article className={`home-jump-card${card.active ? ' is-active' : ''}${featured ? ' is-featured' : ''}`} key={card.key}>
        <button
          type="button"
          className="home-jump-open"
          onClick={() => card.kind === 'album' ? void handleOpenRelease(card.release) : void handleOpenPlaylist(card.playlist.id)}
          data-controller-focusable="true"
          data-controller-context="true"
          aria-label={`Open ${card.title}`}
        >
          {card.kind === 'playlist' ? (
            <PlaylistCover hash={card.artworkHash} name={card.title} isFavorites={card.playlist.isSystemFavorites} className="home-jump-cover" />
          ) : (
            <AlbumArtwork hash={card.artworkHash} alt={card.title} className="home-jump-cover" variant="card" />
          )}
          <span className="home-jump-copy">
            {card.active && <small>{playbackState === 'playing' ? 'Playing now' : 'Ready to continue'}</small>}
            <strong>{card.title}</strong>
            <span>{card.subtitle}</span>
            <em>{card.detail}</em>
          </span>
        </button>
        <button
          type="button"
          className="home-jump-play"
          onClick={() => void handleJumpPlay(card)}
          disabled={pendingPlaybackKey === card.key || (card.active && playbackState === 'playing')}
          aria-label={card.active ? `${playbackState === 'playing' ? 'Currently playing' : 'Continue'} ${card.title}` : `Play ${card.title}`}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
          <span>{card.active ? (playbackState === 'playing' ? 'Playing' : 'Continue') : 'Play'}</span>
        </button>
      </article>
    )
    return (
      <section className="home-dashboard-section home-jump-section" data-controller-group="home-jump-back-in" data-controller-axis="horizontal">
        <div className="home-dashboard-section-header">
          <div><h2>Jump Back In</h2></div>
          <HomeShelfNavigation scrollRef={jumpRowRef} label="Jump Back In" />
        </div>
        <div className={`home-jump-layout${remainingCards.length ? '' : ' is-solo'}`}>
          {renderCard(featuredCard, true)}
          {remainingCards.length > 0 && (
            <div className="home-jump-row" ref={jumpRowRef}>
              {remainingCards.map((card) => renderCard(card))}
            </div>
          )}
        </div>
      </section>
    )
  }

  const renderReleaseShelf = (
    id: 'rediscover' | 'newly-added',
    title: string,
    subtitle: string,
    releases: readonly HomeReleaseSummary[],
    rowRef: typeof rediscoverRowRef,
    getReason: (release: HomeReleaseSummary) => string,
    action?: ReactNode
  ) => {
    if (!releases.length) return null
    return (
      <section className="home-dashboard-section home-release-section" data-controller-group={`home-${id}`} data-controller-axis="horizontal">
        <div className="home-dashboard-section-header">
          <div><h2>{title}</h2>{subtitle ? <span>{subtitle}</span> : null}</div>
          <div className="home-dashboard-section-actions">
            {action}
            <HomeShelfNavigation scrollRef={rowRef} label={title} />
          </div>
        </div>
        <div className="home-release-row" ref={rowRef}>
          {releases.map((release) => (
            <HomeReleaseCard
              key={release.identity_key}
              release={release}
              reason={getReason(release)}
              onOpen={() => void handleOpenRelease(release)}
              onPlay={() => void handlePlayRelease(release)}
              isPending={pendingPlaybackKey === `album:${release.identity_key}`}
            />
          ))}
        </div>
      </section>
    )
  }

  const renderPinnedPlaylists = () => {
    if (!pinnedPlaylists.length) return null
    return (
      <section className="home-dashboard-section" data-controller-group="home-pinned-playlists" data-controller-axis="horizontal">
        <div className="home-dashboard-section-header">
          <div><h2>Pinned Playlists</h2></div>
          <HomeShelfNavigation scrollRef={pinnedRowRef} label="Pinned Playlists" />
        </div>
        <div className="home-pinned-row" ref={pinnedRowRef}>
          {pinnedPlaylists.map((playlist) => (
            <article
              className="home-pinned-card"
              key={playlist.id}
              onContextMenu={(event) => {
                event.preventDefault()
                openCollectionQueueMenu({
                  target: { kind: 'playlist', playlistId: playlist.id, name: playlist.name },
                  x: event.clientX,
                  y: event.clientY
                })
              }}
            >
              <button
                type="button"
                className="home-pinned-open"
                onClick={() => void handleOpenPlaylist(playlist.id)}
                data-controller-focusable="true"
                data-controller-context="true"
              >
                <PlaylistCover hash={playlist.cover_hash} name={playlist.name} isFavorites={playlist.isSystemFavorites} className="home-pinned-cover" />
                <span><strong>{playlist.name}</strong><small>{playlist.track_count} tracks</small></span>
              </button>
              <button type="button" className="home-card-play" onClick={() => void handlePlayPlaylist(playlist)} aria-label={`Play ${playlist.name}`}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
              </button>
            </article>
          ))}
        </div>
      </section>
    )
  }

  const renderRecentTracks = () => {
    if (!recentTracks.length) return null
    return (
      <section className="home-dashboard-section" data-controller-group="home-recent-tracks" data-controller-axis="horizontal">
        <div className="home-dashboard-section-header">
          <div><h2>Recently Played Tracks</h2></div>
          <HomeShelfNavigation scrollRef={recentRowRef} label="Recently Played Tracks" />
        </div>
        <div className="home-recent-row" ref={recentRowRef}>
          {recentTracks.map((track, index) => (
            <article
              key={track.path}
              className={`home-track-card${currentTrack?.path === track.path ? ' active' : ''}`}
              onClick={() => void startPlaybackContextByPaths(recentTracks.map((entry) => entry.path), index, { contextLabel: 'Recently Played' })}
              data-controller-focusable="true"
              tabIndex={-1}
              role="button"
              aria-label={`Play ${track.title} by ${track.artist}`}
            >
              <div className="home-track-artwork"><AlbumArtwork hash={track.artwork_hash} alt={track.album} variant="card" /></div>
              <div className="home-track-meta"><div className="home-track-title">{track.title}</div><div className="home-track-artist">{track.artist}</div></div>
            </article>
          ))}
        </div>
      </section>
    )
  }

  const renderListeningSnapshot = () => {
    if (!listeningDashboard?.status.startedAt) return null
    const summary = listeningDashboard.summary
    return (
      <section className="home-dashboard-section">
        <div className="home-dashboard-section-header"><div><h2>Listening Snapshot</h2><span>{listeningDashboard.range.toUpperCase()}</span></div></div>
        <div className="home-listening-snapshot">
          <article><span>Listening time</span><strong>{formatCompactDuration(summary.listenedSeconds) ?? '0 min'}</strong></article>
          <article><span>Qualified plays</span><strong>{summary.qualifiedPlays.toLocaleString()}</strong></article>
          <article><span>Tracks played</span><strong>{summary.tracksPlayed.toLocaleString()}</strong></article>
          <article><span>Active days</span><strong>{summary.activeDays.toLocaleString()}</strong></article>
        </div>
      </section>
    )
  }

  const renderModule = (id: HomeModuleId) => {
    if (id === 'jump-back-in') return renderJumpBackIn()
    if (id === 'rediscover') return renderReleaseShelf(
      'rediscover', 'Rediscover', '', dashboard?.rediscover_releases ?? [],
      rediscoverRowRef, (release) => (release as HomeRediscoveryRelease).reason,
      <button className="home-section-action" type="button" onClick={handleRefreshRediscovery} disabled={dashboardLoading} aria-label="Refresh Rediscover">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>
        Refresh
      </button>
    )
    if (id === 'pinned-playlists') return renderPinnedPlaylists()
    if (id === 'recent-tracks') return renderRecentTracks()
    if (id === 'newly-added') return renderReleaseShelf(
      'newly-added', 'Newly Added', '', dashboard?.newly_added_releases ?? [], newlyAddedRowRef,
      (release) => release.year ? `Added · ${release.year}` : 'New to your library'
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
                <h1 className="home-greeting-message">{greetingCopy.primary}</h1>
                {greetingCopy.subline.trim() && <p className="home-greeting-subline">{greetingCopy.subline}</p>}
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
              disabled={!hasLibraryContent || isShuffleStarting}
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
            {dashboardLoading && !dashboard && (
              <div className="home-dashboard-skeleton" role="status" aria-label="Loading Home collections">
                {Array.from({ length: 5 }, (_, index) => <span key={index} />)}
              </div>
            )}
            {visibleModules.map((module) => <div key={module.id}>{renderModule(module.id)}</div>)}
          </div>
        )}
      </div>
      <HomeCustomizeModal isOpen={isCustomizeOpen} onClose={() => setIsCustomizeOpen(false)} />
    </div>
  )
}
