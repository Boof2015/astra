import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { NAV_ENTRIES, NON_HIDDEN_SETTINGS_SECTIONS } from '../../constants/settingsSections'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlayerStore } from '../../stores/playerStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useUIStore } from '../../stores/uiStore'
import { usePresence } from '../../hooks/usePresence'
import { useGraphStore } from '../../stores/graphStore'
import { useListeningStatsStore } from '../../stores/listeningStatsStore'
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
import { highlightSearchMatch } from '../../utils/searchHighlight'

const SETTINGS_RESULT_LIMIT = 3
const NAV_RESULT_LIMIT = 3
const TRACK_RESULT_LIMIT = 5
const ALBUM_RESULT_LIMIT = 4
const ARTIST_RESULT_LIMIT = 4
const PLAYLIST_RESULT_LIMIT = 4
const EMPTY_RECENT_TRACKS_LIMIT = 3
const EMPTY_SHORTCUT_NAV_IDS = ['nav:eq', 'nav:library'] as const
const EMPTY_SHORTCUT_SETTING_IDS = ['keybinds', 'playback'] as const
const QUICK_LAUNCH_TRACK_PAGE_LIMIT = 500

interface ResultGroup {
  id: string
  label: string
  results: QuickLaunchResult[]
}

function compareScoredResults<T extends { score: number; id: string }>(a: T, b: T): number {
  if (a.score !== b.score) {
    return b.score - a.score
  }
  return a.id.localeCompare(b.id)
}

// Artwork thumbnail component
function ResultThumbnail({ hash, fallback }: { hash: string | null | undefined; fallback: ReactNode }) {
  const [url, setUrl] = useState<string | null>(null)
  const getArtwork = useLibraryStore((state) => state.getArtwork)

  useEffect(() => {
    if (!hash) { setUrl(null); return }
    let cancelled = false
    void getArtwork(hash, { variant: 'thumbnail' }).then((u) => { if (!cancelled) setUrl(u ?? null) })
    return () => { cancelled = true }
  }, [hash, getArtwork])

  if (url) {
    return (
      <img
        src={url}
        className="ql-thumb"
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setUrl(null)}
      />
    )
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
  const graphEnabled = useGraphStore((state) => state.enabled)
  const listeningStatsEnabled = useListeningStatsStore((state) => state.enabled)
  const openFullMap = useGraphStore((state) => state.openFullMap)
  const presence = usePresence(isQuickLaunchOpen)

  const albums = useLibraryStore((state) => state.albums) as QuickLaunchAlbumRecord[]
  const artists = useLibraryStore((state) => state.artists) as QuickLaunchArtistRecord[]
  const recentlyPlayedPaths = useLibraryStore((state) => state.recentlyPlayedPaths)
  const trackCacheVersion = useLibraryStore((state) => state.trackCacheVersion)
  const resolveTrackPaths = useLibraryStore((state) => state.resolveTrackPaths)
  const selectedAlbum = useLibraryStore((state) => state.selectedAlbum)
  const selectedArtist = useLibraryStore((state) => state.selectedArtist)
  const setViewMode = useLibraryStore((state) => state.setViewMode)
  const selectAlbum = useLibraryStore((state) => state.selectAlbum)
  const selectArtist = useLibraryStore((state) => state.selectArtist)
  const clearSelection = useLibraryStore((state) => state.clearSelection)

  const enqueueTrackPaths = usePlayerStore((state) => state.enqueueTrackPaths)
  const startPlaybackContextByPaths = usePlayerStore((state) => state.startPlaybackContextByPaths)

  const playlists = usePlaylistStore((state) => state.playlists) as QuickLaunchPlaylistRecord[]
  const clearPlaylistSelection = usePlaylistStore((state) => state.clearSelection)
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
  const recentlyPlayed = useMemo(
    () => resolveTrackPaths(recentlyPlayedPaths),
    [recentlyPlayedPaths, resolveTrackPaths, trackCacheVersion]
  )

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

    const loadTrackCorpus = async () => {
      const tracks: QuickLaunchTrackRecord[] = []
      let offset = 0

      while (true) {
        const page = await window.electronAPI.library.getTracksPage({
          offset,
          limit: QUICK_LAUNCH_TRACK_PAGE_LIMIT
        })

        tracks.push(...page.tracks)
        if (!page.hasMore || page.tracks.length === 0) {
          break
        }

        const nextOffset = Number(page.nextOffset)
        offset = Number.isFinite(nextOffset) && nextOffset > offset
          ? Math.trunc(nextOffset)
          : offset + page.tracks.length
      }

      return tracks
    }

    void loadTrackCorpus()
      .then((tracks) => {
        if (!canceled) {
          setTrackCorpus(tracks)
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

    const scored = NAV_ENTRIES
      .filter((entry) => (
        (graphEnabled || entry.view !== 'graph')
        && (listeningStatsEnabled || entry.view !== 'stats')
      ))
      .map((entry) => {
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
  }, [graphEnabled, hasQuery, listeningStatsEnabled, trimmedQuery])

  const settingResults = useMemo(() => {
    if (!hasQuery) return []

    const scored = NON_HIDDEN_SETTINGS_SECTIONS.map((section) => {
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
        { value: track.artist_names.join(' '), weight: 1.2 },
        { value: track.album_artist_names.join(' '), weight: 1.0 },
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
      const section = NON_HIDDEN_SETTINGS_SECTIONS.find((candidate) => candidate.id === id)
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
        if (result.view === 'playlist') {
          clearPlaylistSelection()
        }
        if (result.view === 'graph') {
          openFullMap()
        }
        setActiveView(result.view as Parameters<typeof setActiveView>[0])
        closeQuickLaunch()
        return
      }

      if (result.kind === 'album') {
        const albumArtist = result.album.artist.trim()
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
        void enqueueTrackPaths([result.track.path], 'next')
        closeQuickLaunch()
        return
      }

      const queueTrackPaths = trackCorpus.map((track) => track.path)
      const queueIndex = trackCorpus.findIndex((track) => track.path === result.track.path)
      if (queueIndex >= 0) {
        await startPlaybackContextByPaths(queueTrackPaths, queueIndex, {
          contextLabel: 'Search Results'
        })
        closeQuickLaunch()
        return
      }
      closeQuickLaunch()
    } catch (error) {
      console.error('Quick launch action failed', error)
    } finally {
      setIsExecuting(false)
    }
  }, [
    clearPlaylistSelection,
    enqueueTrackPaths,
    clearSelection,
    closeQuickLaunch,
    isExecuting,
    openFullMap,
    selectAlbum,
    selectArtist,
    selectPlaylist,
    selectedAlbum,
    selectedArtist,
    setActiveView,
    setPendingLibrarySearchQuery,
    setPendingSettingsSection,
    setViewMode,
    startPlaybackContextByPaths,
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

  if (!presence.shouldRender) return null

  let rowIndex = -1

  return (
    <div
      className="quick-launch-overlay"
      data-presence={presence.phase}
      aria-hidden={presence.phase === 'exiting'}
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
                          {result.kind === 'setting' && highlightSearchMatch(result.label, trimmedQuery, 'ql-highlight')}
                          {result.kind === 'nav' && highlightSearchMatch(result.label, trimmedQuery, 'ql-highlight')}
                          {result.kind === 'track' && highlightSearchMatch(result.track.title, trimmedQuery, 'ql-highlight')}
                          {result.kind === 'album' && highlightSearchMatch(result.album.album, trimmedQuery, 'ql-highlight')}
                          {result.kind === 'artist' && highlightSearchMatch(result.artist.artist, trimmedQuery, 'ql-highlight')}
                          {result.kind === 'playlist' && highlightSearchMatch(result.playlist.name, trimmedQuery, 'ql-highlight')}
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
