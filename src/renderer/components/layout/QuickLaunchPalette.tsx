import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { NAV_ENTRIES, SETTINGS_SECTIONS } from '../../constants/settingsSections'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlayerStore } from '../../stores/playerStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useUIStore } from '../../stores/uiStore'
import type { Track } from '../../types/audio'
import type {
  QuickLaunchAlbumRecord,
  QuickLaunchArtistRecord,
  QuickLaunchPlaylistRecord,
  QuickLaunchResult,
  QuickLaunchSeeAllResult,
  QuickLaunchTrackAction,
  QuickLaunchTrackRecord
} from '../../types/quickLaunch'
import { multiFieldScore, MIN_SCORE_THRESHOLD } from '../../utils/fuzzySearch'

const SETTINGS_RESULT_LIMIT = 3
const NAV_RESULT_LIMIT = 3
const TRACK_RESULT_LIMIT = 5
const ALBUM_RESULT_LIMIT = 4
const ARTIST_RESULT_LIMIT = 4
const PLAYLIST_RESULT_LIMIT = 4
const EMPTY_RECENT_TRACKS_LIMIT = 3
const EMPTY_SHORTCUT_NAV_IDS = ['nav:eq', 'nav:library'] as const
const EMPTY_SHORTCUT_SETTING_IDS = ['library', 'playback'] as const

interface ResultGroup {
  id: string
  label: string
  results: QuickLaunchResult[]
}

interface AudioLoadMetadata {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  duration?: number
  artwork?: string
  channels?: number
  codec?: string
  codecProfile?: string
  isAtmosJoc?: boolean
  replayGainTrackDb?: number
  replayGainAlbumDb?: number
}

interface AudioLoadResult {
  data: ArrayBuffer
  metadata?: AudioLoadMetadata
}

function toQueueTrack(track: QuickLaunchTrackRecord): Track {
  return {
    id: track.path,
    path: track.path,
    title: track.title,
    artist: track.artist,
    album: track.album,
    albumArtist: track.album_artist ?? undefined,
    duration: track.duration,
    trackNumber: track.track_number ?? undefined,
    discNumber: track.disc_number ?? undefined,
    year: track.year ?? undefined,
    genre: track.genre ?? undefined,
    artworkHash: track.artwork_hash ?? undefined,
    format: track.format,
    sampleRate: track.sample_rate ?? undefined,
    bitDepth: track.bit_depth ?? undefined,
    bitrate: track.bitrate ?? undefined,
    channels: track.channels ?? undefined,
    codec: track.codec ?? undefined,
    codecProfile: track.codec_profile ?? undefined,
    isAtmosJoc: track.is_atmos_joc === 1,
    replayGainTrackDb: track.replaygain_track_gain_db ?? undefined,
    replayGainAlbumDb: track.replaygain_album_gain_db ?? undefined,
    sourceType: track.source_type,
    sourceId: track.source_id ?? undefined,
    sourceTrackId: track.source_track_id ?? undefined,
    sourcePath: track.source_path ?? undefined,
    isAvailable: track.is_available === 1,
    availabilityReason: track.availability_reason ?? undefined
  }
}

function toLoadedTrack(track: QuickLaunchTrackRecord, metadata?: AudioLoadMetadata): Track {
  return {
    id: track.path,
    path: track.path,
    title: metadata?.title ?? track.title,
    artist: metadata?.artist ?? track.artist,
    album: metadata?.album ?? track.album,
    albumArtist: metadata?.albumArtist ?? track.album_artist ?? undefined,
    duration: metadata?.duration ?? track.duration,
    trackNumber: track.track_number ?? undefined,
    discNumber: track.disc_number ?? undefined,
    year: track.year ?? undefined,
    genre: track.genre ?? undefined,
    artworkData: metadata?.artwork,
    artworkHash: track.artwork_hash ?? undefined,
    format: track.format,
    sampleRate: track.sample_rate ?? undefined,
    bitDepth: track.bit_depth ?? undefined,
    bitrate: track.bitrate ?? undefined,
    channels: metadata?.channels ?? track.channels ?? undefined,
    codec: metadata?.codec ?? track.codec ?? undefined,
    codecProfile: metadata?.codecProfile ?? track.codec_profile ?? undefined,
    isAtmosJoc: metadata?.isAtmosJoc ?? (track.is_atmos_joc === 1),
    replayGainTrackDb: metadata?.replayGainTrackDb ?? track.replaygain_track_gain_db ?? undefined,
    replayGainAlbumDb: metadata?.replayGainAlbumDb ?? track.replaygain_album_gain_db ?? undefined,
    sourceType: track.source_type,
    sourceId: track.source_id ?? undefined,
    sourceTrackId: track.source_track_id ?? undefined,
    sourcePath: track.source_path ?? undefined,
    isAvailable: track.is_available === 1,
    availabilityReason: track.availability_reason ?? undefined
  }
}

function compareScoredResults<T extends { score: number; id: string }>(a: T, b: T): number {
  if (a.score !== b.score) {
    return b.score - a.score
  }
  return a.id.localeCompare(b.id)
}

// Match highlighting: prefer contiguous substring, fallback to sequential chars
function highlightMatch(text: string, query: string): ReactNode {
  if (!query) return text
  const normalizedText = text.toLowerCase()
  const normalizedQuery = query.toLowerCase().trim()
  if (!normalizedQuery) return text

  // Try contiguous substring first
  const substringIndex = normalizedText.indexOf(normalizedQuery)
  if (substringIndex >= 0) {
    return (
      <>
        {text.slice(0, substringIndex)}
        <mark className="ql-highlight">{text.slice(substringIndex, substringIndex + normalizedQuery.length)}</mark>
        {text.slice(substringIndex + normalizedQuery.length)}
      </>
    )
  }

  // Fallback: highlight sequential matched characters
  const parts: ReactNode[] = []
  let qi = 0
  let lastPushed = 0
  for (let i = 0; i < text.length && qi < normalizedQuery.length; i++) {
    if (text[i].toLowerCase() === normalizedQuery[qi]) {
      if (i > lastPushed) {
        parts.push(text.slice(lastPushed, i))
      }
      parts.push(<mark key={i} className="ql-highlight">{text[i]}</mark>)
      qi++
      lastPushed = i + 1
    }
  }
  if (lastPushed < text.length) {
    parts.push(text.slice(lastPushed))
  }
  return <>{parts}</>
}

// Artwork thumbnail component
function ResultThumbnail({ hash, fallback }: { hash: string | null | undefined; fallback: ReactNode }) {
  const [url, setUrl] = useState<string | null>(null)
  const getArtwork = useLibraryStore((state) => state.getArtwork)

  useEffect(() => {
    if (!hash) { setUrl(null); return }
    let cancelled = false
    void getArtwork(hash).then((u) => { if (!cancelled) setUrl(u ?? null) })
    return () => { cancelled = true }
  }, [hash, getArtwork])

  if (url) {
    return <img src={url} className="ql-thumb" alt="" loading="lazy" decoding="async" />
  }
  return <div className="ql-thumb ql-thumb-placeholder">{fallback}</div>
}

// SVG icons for result types
const IconNote = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12 2v8.5a2.5 2.5 0 1 1-1-2V4H7v7.5a2.5 2.5 0 1 1-1-2V2h6z" fill="currentColor" /></svg>
)
const IconDisc = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" /><circle cx="8" cy="8" r="2" fill="currentColor" /></svg>
)
const IconPerson = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5" r="2.5" fill="currentColor" /><path d="M3.5 13.5c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
)
const IconGear = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6.7 1.5h2.6l.4 1.8.9.4 1.6-.9 1.8 1.8-.9 1.6.4.9 1.8.4v2.6l-1.8.4-.4.9.9 1.6-1.8 1.8-1.6-.9-.9.4-.4 1.8H6.7l-.4-1.8-.9-.4-1.6.9-1.8-1.8.9-1.6-.4-.9-1.8-.4V6.5l1.8-.4.4-.9-.9-1.6 1.8-1.8 1.6.9.9-.4.4-1.8z" stroke="currentColor" strokeWidth="1" /><circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1" /></svg>
)
const IconNav = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 4h11M2.5 8h11M2.5 12h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
)

export default function QuickLaunchPalette() {
  const isQuickLaunchOpen = useUIStore((state) => state.isQuickLaunchOpen)
  const closeQuickLaunch = useUIStore((state) => state.closeQuickLaunch)
  const setPendingLibrarySearchQuery = useUIStore((state) => state.setPendingLibrarySearchQuery)
  const setPendingSettingsSection = useUIStore((state) => state.setPendingSettingsSection)
  const setActiveView = useUIStore((state) => state.setActiveView)

  const albums = useLibraryStore((state) => state.albums) as QuickLaunchAlbumRecord[]
  const artists = useLibraryStore((state) => state.artists) as QuickLaunchArtistRecord[]
  const recentlyPlayed = useLibraryStore((state) => state.recentlyPlayed)
  const selectedAlbum = useLibraryStore((state) => state.selectedAlbum)
  const selectedArtist = useLibraryStore((state) => state.selectedArtist)
  const setViewMode = useLibraryStore((state) => state.setViewMode)
  const selectAlbum = useLibraryStore((state) => state.selectAlbum)
  const selectArtist = useLibraryStore((state) => state.selectArtist)
  const clearSelection = useLibraryStore((state) => state.clearSelection)

  const addToQueueNext = usePlayerStore((state) => state.addToQueueNext)
  const setQueue = usePlayerStore((state) => state.setQueue)
  const loadTrack = usePlayerStore((state) => state.loadTrack)
  const play = usePlayerStore((state) => state.play)

  const playlists = usePlaylistStore((state) => state.playlists) as QuickLaunchPlaylistRecord[]
  const selectPlaylist = usePlaylistStore((state) => state.selectPlaylist)

  const [query, setQuery] = useState('')
  const [selectedResultIndex, setSelectedResultIndex] = useState(0)
  const [isTrackCorpusLoading, setIsTrackCorpusLoading] = useState(false)
  const [trackCorpus, setTrackCorpus] = useState<QuickLaunchTrackRecord[]>([])
  const [isExecuting, setIsExecuting] = useState(false)
  const [trackAction, setTrackAction] = useState<QuickLaunchTrackAction>('play-now')

  const inputRef = useRef<HTMLInputElement | null>(null)
  const selectedRowRef = useRef<HTMLElement | null>(null)

  const trimmedQuery = query.trim()
  const hasQuery = trimmedQuery.length > 0

  useEffect(() => {
    if (!isQuickLaunchOpen) return

    setQuery('')
    setSelectedResultIndex(0)
    setTrackAction('play-now')

    requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
  }, [isQuickLaunchOpen])

  useEffect(() => {
    if (!isQuickLaunchOpen) return

    let canceled = false
    setIsTrackCorpusLoading(true)

    void window.electronAPI.library.getTracks()
      .then((tracks) => {
        if (!canceled) {
          setTrackCorpus(tracks as QuickLaunchTrackRecord[])
        }
      })
      .catch(() => {
        if (!canceled) {
          setTrackCorpus([])
        }
      })
      .finally(() => {
        if (!canceled) {
          setIsTrackCorpusLoading(false)
        }
      })

    return () => {
      canceled = true
    }
  }, [isQuickLaunchOpen])

  // Reset track action when selection or query changes
  useEffect(() => {
    setTrackAction('play-now')
  }, [selectedResultIndex, trimmedQuery])

  const navResults = useMemo(() => {
    if (!hasQuery) return []

    const scored = NAV_ENTRIES.map((entry) => {
      const result = multiFieldScore(trimmedQuery, [
        { value: entry.label, weight: 1.5 },
        { value: entry.keywords.join(' '), weight: 1.0 }
      ])
      if (!result || result < MIN_SCORE_THRESHOLD) return null
      return {
        kind: 'nav' as const,
        id: entry.id,
        score: result,
        label: entry.label,
        view: entry.view
      }
    }).filter((r): r is NonNullable<typeof r> => r !== null)

    return scored.sort(compareScoredResults).slice(0, NAV_RESULT_LIMIT)
  }, [hasQuery, trimmedQuery])

  const settingResults = useMemo(() => {
    if (!hasQuery) return []

    const scored = SETTINGS_SECTIONS.map((section) => {
      const result = multiFieldScore(trimmedQuery, [
        { value: section.label, weight: 1.4 },
        { value: section.keywords.join(' '), weight: 1.0 }
      ])
      if (!result || result < MIN_SCORE_THRESHOLD) return null

      return {
        kind: 'setting' as const,
        id: `setting:${section.id}`,
        score: result,
        sectionId: section.id,
        label: section.label,
        subtitle: section.keywords.join(' · ')
      }
    }).filter((result): result is NonNullable<typeof result> => result !== null)

    return scored.sort(compareScoredResults).slice(0, SETTINGS_RESULT_LIMIT)
  }, [hasQuery, trimmedQuery])

  const trackResults = useMemo(() => {
    if (!hasQuery) return []

    const scored = trackCorpus.map((track) => {
      const result = multiFieldScore(trimmedQuery, [
        { value: track.title, weight: 1.5 },
        { value: track.artist, weight: 1.2 },
        { value: track.album, weight: 1.0 }
      ])
      if (!result || result < MIN_SCORE_THRESHOLD) return null
      return {
        kind: 'track' as const,
        id: `track:${track.path}`,
        score: result,
        track
      }
    }).filter((result): result is NonNullable<typeof result> => result !== null)

    return scored.sort(compareScoredResults).slice(0, TRACK_RESULT_LIMIT)
  }, [hasQuery, trackCorpus, trimmedQuery])

  const albumResults = useMemo(() => {
    if (!hasQuery) return []

    const scored = albums.map((album) => {
      const result = multiFieldScore(trimmedQuery, [
        { value: album.album, weight: 1.4 },
        { value: album.artist, weight: 1.1 }
      ])
      if (!result || result < MIN_SCORE_THRESHOLD) return null

      return {
        kind: 'album' as const,
        id: `album:${album.identity_key}`,
        score: result,
        album
      }
    }).filter((result): result is NonNullable<typeof result> => result !== null)

    return scored.sort(compareScoredResults).slice(0, ALBUM_RESULT_LIMIT)
  }, [albums, hasQuery, trimmedQuery])

  const artistResults = useMemo(() => {
    if (!hasQuery) return []

    const scored = artists.map((artist) => {
      const result = multiFieldScore(trimmedQuery, [
        { value: artist.artist, weight: 1.5 }
      ])
      if (!result || result < MIN_SCORE_THRESHOLD) return null

      return {
        kind: 'artist' as const,
        id: `artist:${artist.artist}`,
        score: result,
        artist
      }
    }).filter((result): result is NonNullable<typeof result> => result !== null)

    return scored.sort(compareScoredResults).slice(0, ARTIST_RESULT_LIMIT)
  }, [artists, hasQuery, trimmedQuery])

  const playlistResults = useMemo(() => {
    if (!hasQuery) return []

    const scored = playlists.map((playlist) => {
      const result = multiFieldScore(trimmedQuery, [
        { value: playlist.name, weight: 1.5 }
      ])
      if (!result || result < MIN_SCORE_THRESHOLD) return null

      return {
        kind: 'playlist' as const,
        id: `playlist:${playlist.id}`,
        score: result,
        playlist
      }
    }).filter((result): result is NonNullable<typeof result> => result !== null)

    return scored.sort(compareScoredResults).slice(0, PLAYLIST_RESULT_LIMIT)
  }, [hasQuery, playlists, trimmedQuery])

  // Recently played tracks for empty-query state
  const recentTrackResults = useMemo(() => {
    if (hasQuery) return []

    const seenTrackPaths = new Set<string>()
    const uniqueTracks: Array<{
      kind: 'track'
      id: string
      score: number
      track: QuickLaunchTrackRecord
    }> = []

    for (const track of recentlyPlayed) {
      if (seenTrackPaths.has(track.path)) continue
      seenTrackPaths.add(track.path)
      uniqueTracks.push({
        kind: 'track',
        id: `track:${track.path}`,
        score: 0,
        track: track as unknown as QuickLaunchTrackRecord
      })
      if (uniqueTracks.length >= EMPTY_RECENT_TRACKS_LIMIT) break
    }

    return uniqueTracks
  }, [hasQuery, recentlyPlayed])

  const quickShortcutResults = useMemo(() => {
    if (hasQuery) return []

    const navResults = EMPTY_SHORTCUT_NAV_IDS.map((id) => {
      const entry = NAV_ENTRIES.find((candidate) => candidate.id === id)
      if (!entry) return null
      return {
        kind: 'nav' as const,
        id: entry.id,
        score: 0,
        label: entry.label,
        view: entry.view
      }
    }).filter((result): result is NonNullable<typeof result> => result !== null)

    const settingResults = EMPTY_SHORTCUT_SETTING_IDS.map((id) => {
      const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === id)
      if (!section) return null
      return {
        kind: 'setting' as const,
        id: `setting:${section.id}`,
        score: 0,
        sectionId: section.id,
        label: section.label,
        subtitle: section.keywords.join(' · ')
      }
    }).filter((result): result is NonNullable<typeof result> => result !== null)

    return [...navResults, ...settingResults]
  }, [hasQuery])

  const seeAllResult = useMemo<QuickLaunchSeeAllResult | null>(() => {
    if (!hasQuery) return null
    return {
      kind: 'see-all',
      id: 'see-all-in-library',
      query: trimmedQuery
    }
  }, [hasQuery, trimmedQuery])

  const resultGroups = useMemo<ResultGroup[]>(() => {
    if (!hasQuery) {
      // Empty query: brief overview with recents + high-value shortcuts.
      const groups: ResultGroup[] = []
      if (recentTrackResults.length > 0) {
        groups.push({
          id: 'recent',
          label: 'Recently Played',
          results: recentTrackResults
        })
      }
      if (quickShortcutResults.length > 0) {
        groups.push({
          id: 'shortcuts',
          label: 'Shortcuts',
          results: quickShortcutResults
        })
      }
      return groups
    }

    // Nav always pinned at top
    const pinned: ResultGroup[] = []
    if (navResults.length > 0) {
      pinned.push({
        id: 'nav',
        label: 'Go to',
        results: navResults
      })
    }

    // Remaining groups sorted by their top result's score
    const scored: { group: ResultGroup; topScore: number }[] = []

    if (trackResults.length > 0) {
      scored.push({
        group: { id: 'tracks', label: 'Tracks', results: trackResults },
        topScore: trackResults[0].score
      })
    }
    if (albumResults.length > 0) {
      scored.push({
        group: { id: 'albums', label: 'Albums', results: albumResults },
        topScore: albumResults[0].score
      })
    }
    if (artistResults.length > 0) {
      scored.push({
        group: { id: 'artists', label: 'Artists', results: artistResults },
        topScore: artistResults[0].score
      })
    }
    if (playlistResults.length > 0) {
      scored.push({
        group: { id: 'playlists', label: 'Playlists', results: playlistResults },
        topScore: playlistResults[0].score
      })
    }
    if (settingResults.length > 0) {
      scored.push({
        group: { id: 'settings', label: 'Settings', results: settingResults },
        topScore: settingResults[0].score
      })
    }

    scored.sort((a, b) => b.topScore - a.topScore)

    return [...pinned, ...scored.map((s) => s.group)]
  }, [albumResults, artistResults, hasQuery, navResults, playlistResults, quickShortcutResults, recentTrackResults, settingResults, trackResults])

  const flatResults = useMemo<QuickLaunchResult[]>(() => {
    const results: QuickLaunchResult[] = []
    for (const group of resultGroups) {
      results.push(...group.results)
    }

    if (seeAllResult) {
      results.push(seeAllResult)
    }

    return results
  }, [resultGroups, seeAllResult])

  const selectedResult = flatResults[selectedResultIndex] ?? null

  useEffect(() => {
    if (flatResults.length === 0) {
      setSelectedResultIndex(0)
      return
    }

    setSelectedResultIndex((current) => Math.max(0, Math.min(current, flatResults.length - 1)))
  }, [flatResults.length])

  useEffect(() => {
    if (!isQuickLaunchOpen) return
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [isQuickLaunchOpen, selectedResultIndex])

  const setSelectedRowRef = useCallback((element: HTMLElement | null) => {
    selectedRowRef.current = element
  }, [])

  const executeResult = useCallback(async (
    result: QuickLaunchResult,
    requestedTrackAction?: QuickLaunchTrackAction
  ): Promise<void> => {
    if (isExecuting) return

    setIsExecuting(true)
    try {
      if (result.kind === 'setting') {
        setPendingSettingsSection(result.sectionId)
        setActiveView('settings')
        closeQuickLaunch()
        return
      }

      if (result.kind === 'nav') {
        setActiveView(result.view as Parameters<typeof setActiveView>[0])
        closeQuickLaunch()
        return
      }

      if (result.kind === 'album') {
        const albumArtist = result.album.artist.trim()
        setViewMode('tracks')
        await selectAlbum(
          result.album.album,
          albumArtist.length > 0 ? albumArtist : undefined,
          'library',
          result.album.identity_key
        )
        setActiveView('library')
        closeQuickLaunch()
        return
      }

      if (result.kind === 'artist') {
        setViewMode('tracks')
        await selectArtist(result.artist.artist, 'library')
        setActiveView('library')
        closeQuickLaunch()
        return
      }

      if (result.kind === 'playlist') {
        await selectPlaylist(result.playlist.id)
        setActiveView('playlist')
        closeQuickLaunch()
        return
      }

      if (result.kind === 'see-all') {
        setViewMode('tracks')
        if (selectedAlbum || selectedArtist) {
          await clearSelection()
        }
        setPendingLibrarySearchQuery(result.query)
        setActiveView('library')
        closeQuickLaunch()
        return
      }

      const action = requestedTrackAction ?? 'play-now'

      if (action === 'queue-next') {
        addToQueueNext(toQueueTrack(result.track))
        closeQuickLaunch()
        return
      }

      const queueTracks = trackCorpus.map(toQueueTrack)
      const queueIndex = trackCorpus.findIndex((track) => track.path === result.track.path)
      if (queueIndex >= 0) {
        setQueue(queueTracks, queueIndex)
      }

      const loaded = await window.electronAPI.loadAudioFile(
        result.track.path,
        { metadataMode: 'none' }
      ) as AudioLoadResult | null
      if (!loaded) return

      const loadedTrack = toLoadedTrack(result.track, loaded.metadata)
      const didLoad = await loadTrack(loadedTrack, loaded.data)
      if (didLoad) {
        await play()
      }
      closeQuickLaunch()
    } catch (error) {
      console.error('Quick launch action failed', error)
    } finally {
      setIsExecuting(false)
    }
  }, [
    addToQueueNext,
    clearSelection,
    closeQuickLaunch,
    isExecuting,
    loadTrack,
    play,
    selectAlbum,
    selectArtist,
    selectPlaylist,
    selectedAlbum,
    selectedArtist,
    setActiveView,
    setPendingLibrarySearchQuery,
    setPendingSettingsSection,
    setQueue,
    setViewMode,
    trackCorpus
  ])

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeQuickLaunch()
      return
    }

    if (flatResults.length === 0) return
    if (!selectedResult) return

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()

      setSelectedResultIndex((current) => {
        if (event.key === 'ArrowUp') {
          return current <= 0 ? flatResults.length - 1 : current - 1
        }
        return current >= flatResults.length - 1 ? 0 : current + 1
      })
      return
    }

    // Tab toggles track action between play-now and queue-next
    if (event.key === 'Tab' && selectedResult.kind === 'track') {
      event.preventDefault()
      setTrackAction((current) => current === 'play-now' ? 'queue-next' : 'play-now')
      return
    }

    if (event.key !== 'Enter') return

    event.preventDefault()
    if (selectedResult.kind === 'track') {
      void executeResult(selectedResult, trackAction)
      return
    }

    void executeResult(selectedResult)
  }

  const handleResultClick = (result: QuickLaunchResult, index: number) => {
    setSelectedResultIndex(index)
    if (result.kind === 'track') {
      void executeResult(result, 'play-now')
      return
    }
    void executeResult(result)
  }

  const handleQueueClick = (
    event: ReactMouseEvent<HTMLButtonElement>,
    result: QuickLaunchResult
  ) => {
    event.stopPropagation()
    if (result.kind !== 'track') return
    void executeResult(result, 'queue-next')
  }

  if (!isQuickLaunchOpen) return null

  let rowIndex = -1

  return (
    <div
      className="quick-launch-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeQuickLaunch()
        }
      }}
    >
      <div
        className="quick-launch-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Quick Launch"
      >
        <div className="quick-launch-input-wrap">
          <input
            ref={inputRef}
            className="quick-launch-input"
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
            }}
            onKeyDown={handleInputKeyDown}
            placeholder="Search tracks, albums, artists, playlists, settings..."
            spellCheck={false}
            disabled={isExecuting}
          />
          <span className="quick-launch-input-hint">Esc</span>
        </div>

        {isTrackCorpusLoading && (
          <div className="quick-launch-status">Refreshing library index...</div>
        )}

        <div className="quick-launch-results">
          {/* Empty query hint */}
          {!hasQuery && recentTrackResults.length === 0 && quickShortcutResults.length === 0 && (
            <div className="ql-idle-hint">Type to search tracks, albums, artists, playlists, or settings</div>
          )}

          {/* No results */}
          {hasQuery && resultGroups.length === 0 && !isTrackCorpusLoading && (
            <div className="ql-empty">No results for &ldquo;{trimmedQuery}&rdquo;</div>
          )}

          {resultGroups.map((group) => (
            <div key={group.id} className="quick-launch-group">
              <div className="quick-launch-group-label">{group.label}</div>
              <div className="quick-launch-group-results">
                {group.results.map((result) => {
                  rowIndex += 1
                  const currentIndex = rowIndex
                  const isSelected = selectedResultIndex === currentIndex
                  const isTrack = result.kind === 'track'
                  const showQueueAction = isTrack && isSelected && trackAction === 'queue-next'

                  return (
                    <div
                      key={result.id}
                      ref={isSelected ? setSelectedRowRef : undefined}
                      role="button"
                      tabIndex={-1}
                      className={`quick-launch-result-row ${isSelected ? 'selected' : ''}`}
                      onMouseEnter={() => setSelectedResultIndex(currentIndex)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => handleResultClick(result, currentIndex)}
                    >
                      {/* Thumbnail / Icon */}
                      {result.kind === 'track' && (
                        <ResultThumbnail hash={result.track.artwork_hash} fallback={<IconNote />} />
                      )}
                      {result.kind === 'album' && (
                        <ResultThumbnail hash={result.album.artwork_hash} fallback={<IconDisc />} />
                      )}
                      {result.kind === 'artist' && (
                        <ResultThumbnail hash={result.artist.artwork_hash} fallback={<IconPerson />} />
                      )}
                      {result.kind === 'playlist' && (
                        <ResultThumbnail hash={result.playlist.custom_cover_hash ?? result.playlist.auto_cover_hash} fallback={<IconDisc />} />
                      )}
                      {result.kind === 'setting' && (
                        <div className="ql-icon"><IconGear /></div>
                      )}
                      {result.kind === 'nav' && (
                        <div className="ql-icon"><IconNav /></div>
                      )}

                      {/* Text */}
                      <div className="quick-launch-result-text">
                        <span className="quick-launch-result-label">
                          {result.kind === 'setting' && highlightMatch(result.label, trimmedQuery)}
                          {result.kind === 'nav' && highlightMatch(result.label, trimmedQuery)}
                          {result.kind === 'track' && highlightMatch(result.track.title, trimmedQuery)}
                          {result.kind === 'album' && highlightMatch(result.album.album, trimmedQuery)}
                          {result.kind === 'artist' && highlightMatch(result.artist.artist, trimmedQuery)}
                          {result.kind === 'playlist' && highlightMatch(result.playlist.name, trimmedQuery)}
                        </span>
                        <span className="quick-launch-result-subtitle">
                          {result.kind === 'setting' && result.subtitle}
                          {result.kind === 'nav' && 'Navigate'}
                          {result.kind === 'track' && `${result.track.artist} · ${result.track.album}`}
                          {result.kind === 'album' && `by ${result.album.artist}`}
                          {result.kind === 'artist' && `${result.artist.track_count} tracks`}
                          {result.kind === 'playlist' && `${result.playlist.track_count} ${result.playlist.track_count === 1 ? 'track' : 'tracks'}`}
                        </span>
                      </div>

                      {/* Track action indicator + queue button */}
                      {isTrack && isSelected && (
                        <div className="ql-track-actions">
                          {showQueueAction ? (
                            <span className="ql-action-badge">Queue</span>
                          ) : (
                            <span className="ql-tab-hint"><kbd>Tab</kbd> queue</span>
                          )}
                          <button
                            type="button"
                            className="quick-launch-queue-btn"
                            onClick={(event) => handleQueueClick(event, result)}
                            title="Queue next"
                          >
                            +
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}

          {seeAllResult && (
            <button
              ref={selectedResultIndex === flatResults.length - 1 ? setSelectedRowRef : undefined}
              type="button"
              className={`quick-launch-result-row quick-launch-see-all ${selectedResultIndex === flatResults.length - 1 ? 'selected' : ''}`}
              onMouseEnter={() => setSelectedResultIndex(flatResults.length - 1)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void executeResult(seeAllResult)}
            >
              <span className="quick-launch-result-label">See all in Library &rarr;</span>
              <span className="quick-launch-result-subtitle">{seeAllResult.query}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
