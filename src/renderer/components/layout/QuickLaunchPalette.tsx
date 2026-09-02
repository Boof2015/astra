import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window'
import { NAV_ENTRIES, NON_HIDDEN_SETTINGS_SECTIONS } from '../../constants/settingsSections'
import { useInputActionDispatcher } from '../../hooks/useInputActionDispatcher'
import { usePresence } from '../../hooks/usePresence'
import { useGraphStore } from '../../stores/graphStore'
import { useLibraryStore } from '../../stores/libraryStore'
import { useListeningStatsStore } from '../../stores/listeningStatsStore'
import { usePlayerStore } from '../../stores/playerStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useUIStore } from '../../stores/uiStore'
import type {
  QuickLaunchAlbumRecord,
  QuickLaunchArtistRecord,
  QuickLaunchFilterKind,
  QuickLaunchLockedFilter,
  QuickLaunchPlaylistRecord,
  QuickLaunchResult,
  QuickLaunchSeeAllResult,
  QuickLaunchTrackAction,
  QuickLaunchTrackRecord
} from '../../types/quickLaunch'
import { multiFieldScore, normalizeSearchValue } from '../../utils/fuzzySearch'
import { FAVORITES_PLAYLIST_ID, FAVORITES_PLAYLIST_NAME } from '../../utils/playlistSystem'
import {
  buildQuickLaunchPlayRequest,
  findQuickLaunchTokenFragment,
  QUICK_LAUNCH_FILTER_REGISTRY,
  QUICK_LAUNCH_IMMEDIATE_COMMANDS,
  QUICK_LAUNCH_RESULT_ACTIONS,
  rankQuickLaunchFilterOptions,
  rankQuickLaunchTrackOccurrences,
  removeQuickLaunchTokenFragment,
  replaceQuickLaunchTokenFragment,
  upsertQuickLaunchFilter,
  type QuickLaunchFilterOption,
  type QuickLaunchTrackOccurrence
} from '../../utils/quickLaunchSearch'
import { highlightSearchMatch } from '../../utils/searchHighlight'
import { scoreTrackIdentityQuery } from '../../utils/trackSearch'

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
const STRUCTURED_TRACK_ROW_HEIGHT = 54
const POINTER_ACTIVATION_DISTANCE_PX = 4

interface ResultGroup {
  id: string
  label: string
  results: QuickLaunchResult[]
}

interface FilterEditor {
  kind: QuickLaunchFilterKind
  value: string
  original?: QuickLaunchLockedFilter
}

type ComposerSuggestion =
  | { kind: 'filter-definition'; id: string; label: string; subtitle: string; filterKind: QuickLaunchFilterKind }
  | { kind: 'filter-value'; id: string; label: string; subtitle?: string; option: QuickLaunchFilterOption }
  | { kind: 'result-action'; id: string; label: string; subtitle: string; action: QuickLaunchTrackAction }
  | { kind: 'immediate-command'; id: string; label: string; subtitle: string; actionId: 'playback-toggle' | 'next-track' | 'previous-track' | 'shuffle' }

function compareScoredResults<T extends { score: number; id: string }>(a: T, b: T): number {
  return b.score - a.score || a.id.localeCompare(b.id)
}

function ResultThumbnail({ hash, fallback }: { hash: string | null | undefined; fallback: ReactNode }) {
  const [url, setUrl] = useState<string | null>(null)
  const getArtwork = useLibraryStore((state) => state.getArtwork)

  useEffect(() => {
    if (!hash) {
      setUrl(null)
      return
    }
    let cancelled = false
    void getArtwork(hash, { variant: 'thumbnail' }).then((nextUrl) => {
      if (!cancelled) setUrl(nextUrl ?? null)
    })
    return () => { cancelled = true }
  }, [getArtwork, hash])

  if (url) {
    return <img src={url} className="ql-thumb" alt="" loading="lazy" decoding="async" onError={() => setUrl(null)} />
  }
  return <div className="ql-thumb ql-thumb-placeholder">{fallback}</div>
}

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

interface StructuredTrackRowProps {
  occurrences: QuickLaunchTrackOccurrence[]
  query: string
  selectedIndex: number
  hoverEnabled: boolean
  action: QuickLaunchTrackAction
  onHover: (index: number) => void
  onExecute: (occurrence: QuickLaunchTrackOccurrence, action: QuickLaunchTrackAction) => void
}

function StructuredTrackRow({
  index,
  style,
  occurrences,
  query,
  selectedIndex,
  hoverEnabled,
  action,
  onHover,
  onExecute
}: RowComponentProps<StructuredTrackRowProps>) {
  const occurrence = occurrences[index]
  const selected = index === selectedIndex
  if (!occurrence) return null
  return (
    <div style={style} className="ql-virtual-row-shell">
      <button
        type="button"
        className={`quick-launch-result-row ${selected ? 'selected' : ''}`}
        onMouseEnter={() => { if (hoverEnabled) onHover(index) }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onExecute(occurrence, action)}
      >
        <ResultThumbnail hash={occurrence.track.artwork_hash} fallback={<IconNote />} />
        <span className="quick-launch-result-text">
          <span className="quick-launch-result-label">
            {highlightSearchMatch(occurrence.track.title, query, 'ql-highlight', 'global')}
          </span>
          <span className="quick-launch-result-subtitle">
            {highlightSearchMatch(occurrence.track.artist, query, 'ql-highlight', 'global')}
            {' · '}
            {highlightSearchMatch(occurrence.track.album, query, 'ql-highlight', 'global')}
          </span>
        </span>
        {selected && (
          <span className="ql-track-actions" aria-hidden="true">
            <span className="ql-key-action">↵ {action === 'play' ? 'Play' : action === 'next' ? 'Queue next' : 'Queue last'}</span>
            <span className="ql-key-action">⇥ Queue next</span>
          </span>
        )}
      </button>
    </div>
  )
}

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
  const dispatchInputAction = useInputActionDispatcher()

  const albums = useLibraryStore((state) => state.albums) as QuickLaunchAlbumRecord[]
  const artists = useLibraryStore((state) => state.artists) as QuickLaunchArtistRecord[]
  const artistBrowseMode = useLibraryStore((state) => state.artistBrowseMode)
  const favoriteTrackPaths = useLibraryStore((state) => state.favoriteTrackPaths)
  const recentlyPlayedPaths = useLibraryStore((state) => state.recentlyPlayedPaths)
  const trackCacheVersion = useLibraryStore((state) => state.trackCacheVersion)
  const resolveTrackPaths = useLibraryStore((state) => state.resolveTrackPaths)
  const selectedAlbum = useLibraryStore((state) => state.selectedAlbum)
  const selectedArtist = useLibraryStore((state) => state.selectedArtist)
  const selectedGenre = useLibraryStore((state) => state.selectedGenre)
  const selectedYear = useLibraryStore((state) => state.selectedYear)
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
  const [lockedFilters, setLockedFilters] = useState<QuickLaunchLockedFilter[]>([])
  const [resultAction, setResultAction] = useState<QuickLaunchTrackAction | null>(null)
  const [filterEditor, setFilterEditor] = useState<FilterEditor | null>(null)
  const [dismissedTokenStart, setDismissedTokenStart] = useState<number | null>(null)
  const [armedChipId, setArmedChipId] = useState<string | null>(null)
  const [selectedResultIndex, setSelectedResultIndex] = useState(0)
  const [isTrackCorpusLoading, setIsTrackCorpusLoading] = useState(false)
  const [trackCorpus, setTrackCorpus] = useState<QuickLaunchTrackRecord[]>([])
  const [playlistOccurrences, setPlaylistOccurrences] = useState<QuickLaunchTrackOccurrence[] | null>(null)
  const [isPlaylistScopeLoading, setIsPlaylistScopeLoading] = useState(false)
  const [isExecuting, setIsExecuting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [hoverSelectionEnabled, setHoverSelectionEnabled] = useState(false)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const selectedRowRef = useRef<HTMLElement | null>(null)
  const structuredListRef = useRef<ListImperativeAPI | null>(null)
  const loadedTrackVersionRef = useRef<number | null>(null)
  const pointerOriginRef = useRef<{ x: number; y: number } | null>(null)
  const playlistRequestRef = useRef(0)
  const executionPendingRef = useRef(false)

  const trimmedQuery = query.trim()
  const hasQuery = trimmedQuery.length > 0
  const structuredTrackMode = lockedFilters.length > 0 || resultAction !== null
  const playlistFilter = lockedFilters.find((filter) => filter.kind === 'playlist')
  const tokenFragment = useMemo(() => {
    if (filterEditor) return null
    const found = findQuickLaunchTokenFragment(query)
    return found && found.start !== dismissedTokenStart ? found : null
  }, [dismissedTokenStart, filterEditor, query])
  const recentlyPlayed = useMemo(
    () => resolveTrackPaths(recentlyPlayedPaths),
    [recentlyPlayedPaths, resolveTrackPaths, trackCacheVersion]
  )

  useEffect(() => {
    if (!isQuickLaunchOpen) return
    setQuery('')
    setLockedFilters([])
    setResultAction(null)
    setFilterEditor(null)
    setDismissedTokenStart(null)
    setArmedChipId(null)
    setSelectedResultIndex(0)
    setPlaylistOccurrences(null)
    setActionError(null)
    setIsExecuting(false)
    executionPendingRef.current = false
    setHoverSelectionEnabled(false)
    pointerOriginRef.current = null
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [isQuickLaunchOpen])

  useEffect(() => {
    if (!isQuickLaunchOpen || loadedTrackVersionRef.current === trackCacheVersion) return
    let cancelled = false
    setIsTrackCorpusLoading(true)

    const load = async () => {
      const tracks: QuickLaunchTrackRecord[] = []
      let offset = 0
      while (true) {
        const page = await window.electronAPI.library.getTracksPage({ offset, limit: QUICK_LAUNCH_TRACK_PAGE_LIMIT })
        tracks.push(...page.tracks)
        if (!page.hasMore || page.tracks.length === 0) break
        const nextOffset = Number(page.nextOffset)
        offset = Number.isFinite(nextOffset) && nextOffset > offset ? Math.trunc(nextOffset) : offset + page.tracks.length
      }
      return tracks
    }

    void load().then((tracks) => {
      if (cancelled) return
      setTrackCorpus(tracks)
      loadedTrackVersionRef.current = trackCacheVersion
    }).catch((error) => {
      if (!cancelled) setActionError(error instanceof Error ? error.message : 'Could not refresh the library search index.')
    }).finally(() => {
      if (!cancelled) setIsTrackCorpusLoading(false)
    })
    return () => { cancelled = true }
  }, [isQuickLaunchOpen, trackCacheVersion])

  useEffect(() => {
    const requestId = ++playlistRequestRef.current
    if (!playlistFilter || typeof playlistFilter.value !== 'number') {
      setPlaylistOccurrences(null)
      setIsPlaylistScopeLoading(false)
      return
    }

    setPlaylistOccurrences(null)
    setIsPlaylistScopeLoading(true)
    setActionError(null)
    const playlistId = playlistFilter.value
    const load = playlistId === FAVORITES_PLAYLIST_ID
      ? window.electronAPI.library.getFavorites().then((tracks) => tracks.map((track, index) => ({
          occurrenceKey: `favorites:${index}:${track.path}`,
          track: track as unknown as QuickLaunchTrackRecord,
          sourceIndex: index
        })))
      : window.electronAPI.library.getPlaylistTrackEntries(playlistId).then((entries) => entries.flatMap((entry, index) => (
          entry.track
            ? [{ occurrenceKey: `playlist:${playlistId}:${entry.id}:${index}`, track: entry.track as unknown as QuickLaunchTrackRecord, sourceIndex: index }]
            : []
        )))

    void load.then((occurrences) => {
      if (requestId === playlistRequestRef.current) setPlaylistOccurrences(occurrences)
    }).catch((error) => {
      if (requestId === playlistRequestRef.current) {
        setPlaylistOccurrences([])
        setActionError(error instanceof Error ? error.message : 'Could not load that playlist.')
      }
    }).finally(() => {
      if (requestId === playlistRequestRef.current) setIsPlaylistScopeLoading(false)
    })
  }, [playlistFilter?.id, playlistFilter?.value])

  const corpusOccurrences = useMemo<QuickLaunchTrackOccurrence[]>(() => trackCorpus.map((track, index) => ({
    occurrenceKey: `library:${index}:${track.path}`,
    track,
    sourceIndex: index
  })), [trackCorpus])
  const baseOccurrences = playlistFilter ? playlistOccurrences ?? [] : corpusOccurrences
  const rankedTrackOccurrences = useMemo(() => rankQuickLaunchTrackOccurrences(
    baseOccurrences,
    trimmedQuery,
    lockedFilters,
    artistBrowseMode
  ), [artistBrowseMode, baseOccurrences, lockedFilters, trimmedQuery])

  const filterOptions = useMemo<Record<QuickLaunchFilterKind, QuickLaunchFilterOption[]>>(() => {
    const albumMap = new Map<string, QuickLaunchFilterOption>()
    const genreMap = new Map<string, QuickLaunchFilterOption>()
    const yearSet = new Set<number>()
    for (const track of trackCorpus) {
      if (!albumMap.has(track.album_identity_key)) {
        const artist = track.album_artist?.trim() || track.artist
        albumMap.set(track.album_identity_key, {
          id: track.album_identity_key,
          label: track.album,
          subtitle: [artist, track.year ?? null].filter((value) => value !== null && `${value}`.length > 0).join(' · '),
          value: track.album_identity_key
        })
      }
      for (const genre of track.genres.length > 0 ? track.genres : track.genre ? [track.genre] : []) {
        const key = normalizeSearchValue(genre)
        if (key && !genreMap.has(key)) genreMap.set(key, { id: key, label: genre, value: genre })
      }
      if (track.year !== null) yearSet.add(track.year)
    }
    const playlistOptions: QuickLaunchFilterOption[] = [
      { id: `${FAVORITES_PLAYLIST_ID}`, label: FAVORITES_PLAYLIST_NAME, subtitle: `${favoriteTrackPaths.length} tracks`, value: FAVORITES_PLAYLIST_ID },
      ...playlists.map((playlist) => ({
        id: `${playlist.id}`,
        label: playlist.name,
        subtitle: `${playlist.kind === 'dynamic' ? 'Dynamic · ' : ''}${playlist.track_count} tracks`,
        value: playlist.id
      }))
    ]
    return {
      artist: artists.map((artist) => ({ id: normalizeSearchValue(artist.artist), label: artist.artist, subtitle: `${artist.track_count} tracks`, value: artist.artist })),
      album: [...albumMap.values()],
      playlist: playlistOptions,
      genre: [...genreMap.values()].sort((a, b) => a.label.localeCompare(b.label)),
      year: [
        ...[...yearSet].sort((a, b) => b - a).map((year) => ({ id: `${year}`, label: `${year}`, value: year })),
        { id: 'unknown', label: 'Unknown', value: null }
      ]
    }
  }, [artists, favoriteTrackPaths.length, playlists, trackCorpus])

  const composerSuggestions = useMemo<ComposerSuggestion[] | null>(() => {
    if (filterEditor) {
      return rankQuickLaunchFilterOptions(filterOptions[filterEditor.kind], filterEditor.value).map((option) => ({
        kind: 'filter-value',
        id: `value:${filterEditor.kind}:${option.id}`,
        label: option.label,
        subtitle: option.subtitle,
        option
      }))
    }
    if (!tokenFragment) return null
    const fragment = tokenFragment.fragment
    if (tokenFragment.trigger === '@') {
      return QUICK_LAUNCH_FILTER_REGISTRY
        .filter((definition) => definition.token.slice(1).startsWith(fragment.toLocaleLowerCase()))
        .map((definition) => ({
          kind: 'filter-definition',
          id: definition.token,
          label: definition.token,
          subtitle: definition.description,
          filterKind: definition.kind
        }))
    }
    return [
      ...QUICK_LAUNCH_RESULT_ACTIONS.map((command) => ({
        kind: 'result-action' as const,
        id: command.token,
        label: command.token,
        subtitle: command.description,
        action: command.id
      })),
      ...QUICK_LAUNCH_IMMEDIATE_COMMANDS.map((command) => ({
        kind: 'immediate-command' as const,
        id: command.token,
        label: command.token,
        subtitle: command.label,
        actionId: command.actionId
      }))
    ].filter((command) => command.label.slice(1).startsWith(fragment.toLocaleLowerCase()))
  }, [filterEditor, filterOptions, tokenFragment])

  const navResults = useMemo(() => {
    if (!hasQuery || structuredTrackMode) return []
    return NAV_ENTRIES.filter((entry) => (
      (graphEnabled || entry.view !== 'graph') && (listeningStatsEnabled || entry.view !== 'stats')
    )).map((entry) => {
      const score = multiFieldScore(trimmedQuery, [
        { value: entry.label, weight: 1.5 },
        { value: entry.keywords.join(' '), weight: 1 }
      ], 'global')
      return score === null ? null : { kind: 'nav' as const, id: entry.id, score, label: entry.label, view: entry.view }
    }).filter((result): result is NonNullable<typeof result> => result !== null).sort(compareScoredResults).slice(0, NAV_RESULT_LIMIT)
  }, [graphEnabled, hasQuery, listeningStatsEnabled, structuredTrackMode, trimmedQuery])

  const settingResults = useMemo(() => {
    if (!hasQuery || structuredTrackMode) return []
    return NON_HIDDEN_SETTINGS_SECTIONS.map((section) => {
      const score = multiFieldScore(trimmedQuery, [
        { value: section.label, weight: 1.4 },
        { value: section.keywords.join(' '), weight: 1 }
      ], 'global')
      return score === null ? null : {
        kind: 'setting' as const,
        id: `setting:${section.id}`,
        score,
        sectionId: section.id,
        label: section.label,
        subtitle: section.keywords.join(' · ')
      }
    }).filter((result): result is NonNullable<typeof result> => result !== null).sort(compareScoredResults).slice(0, SETTINGS_RESULT_LIMIT)
  }, [hasQuery, structuredTrackMode, trimmedQuery])

  const trackResults = useMemo(() => {
    if (!hasQuery || structuredTrackMode) return []
    return rankedTrackOccurrences.slice(0, TRACK_RESULT_LIMIT).map((occurrence) => ({
      kind: 'track' as const,
      id: occurrence.occurrenceKey,
      score: scoreTrackIdentityQuery(occurrence.track, trimmedQuery, 'global') ?? 0,
      track: occurrence.track
    }))
  }, [hasQuery, rankedTrackOccurrences, structuredTrackMode])

  const albumResults = useMemo(() => {
    if (!hasQuery || structuredTrackMode) return []
    return albums.map((album) => {
      const score = multiFieldScore(trimmedQuery, [
        { value: album.album, weight: 1.4 },
        { value: album.artist, weight: 1.1 }
      ], 'global')
      return score === null ? null : { kind: 'album' as const, id: `album:${album.identity_key}`, score, album }
    }).filter((result): result is NonNullable<typeof result> => result !== null).sort(compareScoredResults).slice(0, ALBUM_RESULT_LIMIT)
  }, [albums, hasQuery, structuredTrackMode, trimmedQuery])

  const artistResults = useMemo(() => {
    if (!hasQuery || structuredTrackMode) return []
    return artists.map((artist) => {
      const score = multiFieldScore(trimmedQuery, [{ value: artist.artist, weight: 1.5 }], 'global')
      return score === null ? null : { kind: 'artist' as const, id: `artist:${artist.artist}`, score, artist }
    }).filter((result): result is NonNullable<typeof result> => result !== null).sort(compareScoredResults).slice(0, ARTIST_RESULT_LIMIT)
  }, [artists, hasQuery, structuredTrackMode, trimmedQuery])

  const playlistResults = useMemo(() => {
    if (!hasQuery || structuredTrackMode) return []
    return playlists.map((playlist) => {
      const score = multiFieldScore(trimmedQuery, [{ value: playlist.name, weight: 1.5 }], 'global')
      return score === null ? null : { kind: 'playlist' as const, id: `playlist:${playlist.id}`, score, playlist }
    }).filter((result): result is NonNullable<typeof result> => result !== null).sort(compareScoredResults).slice(0, PLAYLIST_RESULT_LIMIT)
  }, [hasQuery, playlists, structuredTrackMode, trimmedQuery])

  const recentTrackResults = useMemo(() => {
    if (hasQuery || structuredTrackMode) return []
    const seen = new Set<string>()
    return recentlyPlayed.flatMap((track) => {
      if (seen.has(track.path) || seen.size >= EMPTY_RECENT_TRACKS_LIMIT) return []
      seen.add(track.path)
      return [{ kind: 'track' as const, id: `recent:${track.path}`, score: 0, track: track as unknown as QuickLaunchTrackRecord }]
    })
  }, [hasQuery, recentlyPlayed, structuredTrackMode])

  const quickShortcutResults = useMemo(() => {
    if (hasQuery || structuredTrackMode) return []
    const nav = EMPTY_SHORTCUT_NAV_IDS.flatMap((id) => {
      const entry = NAV_ENTRIES.find((candidate) => candidate.id === id)
      return entry ? [{ kind: 'nav' as const, id: entry.id, score: 0, label: entry.label, view: entry.view }] : []
    })
    const settings = EMPTY_SHORTCUT_SETTING_IDS.flatMap((id) => {
      const section = NON_HIDDEN_SETTINGS_SECTIONS.find((candidate) => candidate.id === id)
      return section ? [{ kind: 'setting' as const, id: `setting:${section.id}`, score: 0, sectionId: section.id, label: section.label, subtitle: section.keywords.join(' · ') }] : []
    })
    return [...nav, ...settings]
  }, [hasQuery, structuredTrackMode])

  const seeAllResult = useMemo<QuickLaunchSeeAllResult | null>(() => (
    hasQuery && !structuredTrackMode ? { kind: 'see-all', id: 'see-all-in-library', query: trimmedQuery } : null
  ), [hasQuery, structuredTrackMode, trimmedQuery])

  const resultGroups = useMemo<ResultGroup[]>(() => {
    if (structuredTrackMode) return []
    if (!hasQuery) {
      const groups: ResultGroup[] = []
      if (recentTrackResults.length) groups.push({ id: 'recent', label: 'Recently Played', results: recentTrackResults })
      if (quickShortcutResults.length) groups.push({ id: 'shortcuts', label: 'Shortcuts', results: quickShortcutResults })
      return groups
    }
    const pinned: ResultGroup[] = navResults.length ? [{ id: 'nav', label: 'Go to', results: navResults }] : []
    const scored: Array<{ group: ResultGroup; topScore: number }> = []
    if (trackResults.length) scored.push({ group: { id: 'tracks', label: 'Tracks', results: trackResults }, topScore: trackResults[0].score })
    if (albumResults.length) scored.push({ group: { id: 'albums', label: 'Albums', results: albumResults }, topScore: albumResults[0].score })
    if (artistResults.length) scored.push({ group: { id: 'artists', label: 'Artists', results: artistResults }, topScore: artistResults[0].score })
    if (playlistResults.length) scored.push({ group: { id: 'playlists', label: 'Playlists', results: playlistResults }, topScore: playlistResults[0].score })
    if (settingResults.length) scored.push({ group: { id: 'settings', label: 'Settings', results: settingResults }, topScore: settingResults[0].score })
    scored.sort((left, right) => right.topScore - left.topScore)
    return [...pinned, ...scored.map(({ group }) => group)]
  }, [albumResults, artistResults, hasQuery, navResults, playlistResults, quickShortcutResults, recentTrackResults, settingResults, structuredTrackMode, trackResults])

  const flatResults = useMemo(() => {
    const results = resultGroups.flatMap((group) => group.results)
    if (seeAllResult) results.push(seeAllResult)
    return results
  }, [resultGroups, seeAllResult])
  const selectableCount = composerSuggestions?.length ?? (structuredTrackMode ? rankedTrackOccurrences.length : flatResults.length)
  const selectedResult = structuredTrackMode ? null : flatResults[selectedResultIndex] ?? null
  const selectedOccurrence = structuredTrackMode ? rankedTrackOccurrences[selectedResultIndex] ?? null : null

  const selectionResetKey = `${query}\n${lockedFilters.map((filter) => filter.id).join('|')}\n${resultAction ?? ''}\n${filterEditor?.kind ?? ''}:${filterEditor?.value ?? ''}`
  useEffect(() => { setSelectedResultIndex(0) }, [selectionResetKey])
  useEffect(() => {
    setSelectedResultIndex((current) => selectableCount > 0 ? Math.min(current, selectableCount - 1) : 0)
  }, [selectableCount])
  useEffect(() => {
    if (!isQuickLaunchOpen || composerSuggestions || structuredTrackMode) return
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [composerSuggestions, isQuickLaunchOpen, selectedResultIndex, structuredTrackMode])
  useEffect(() => {
    if (!isQuickLaunchOpen || !structuredTrackMode || composerSuggestions || rankedTrackOccurrences.length === 0) return
    structuredListRef.current?.scrollToRow({ index: selectedResultIndex, align: 'auto', behavior: 'auto' })
  }, [composerSuggestions, isQuickLaunchOpen, rankedTrackOccurrences.length, selectedResultIndex, structuredTrackMode])

  const lockFilter = useCallback((kind: QuickLaunchFilterKind, option: QuickLaunchFilterOption) => {
    const filter: QuickLaunchLockedFilter = {
      kind,
      id: `${kind}:${option.id}`,
      label: option.label,
      subtitle: option.subtitle,
      value: option.value
    }
    setLockedFilters((current) => upsertQuickLaunchFilter(current, filter))
    setFilterEditor(null)
    setArmedChipId(null)
    setActionError(null)
  }, [])

  const activateFilterDefinition = useCallback((kind: QuickLaunchFilterKind) => {
    if (!tokenFragment) return
    setQuery((current) => removeQuickLaunchTokenFragment(current, tokenFragment.start))
    setFilterEditor({ kind, value: '' })
    setDismissedTokenStart(null)
  }, [tokenFragment])

  const executeImmediateCommand = useCallback((actionId: 'playback-toggle' | 'next-track' | 'previous-track' | 'shuffle') => {
    if (executionPendingRef.current) return
    executionPendingRef.current = true
    setIsExecuting(true)
    setActionError(null)
    try {
      dispatchInputAction(actionId)
      closeQuickLaunch()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The command could not be completed.')
      setIsExecuting(false)
      executionPendingRef.current = false
    }
  }, [closeQuickLaunch, dispatchInputAction])

  const chooseComposerSuggestion = useCallback((suggestion: ComposerSuggestion, lockValue: boolean) => {
    if (!lockValue) {
      if (suggestion.kind === 'filter-value') {
        setFilterEditor((current) => current ? { ...current, value: suggestion.label } : current)
      } else if (tokenFragment) {
        setQuery((current) => replaceQuickLaunchTokenFragment(current, tokenFragment.start, suggestion.label))
      }
      return
    }
    if (suggestion.kind === 'filter-definition') {
      activateFilterDefinition(suggestion.filterKind)
      return
    }
    if (suggestion.kind === 'filter-value') {
      lockFilter(filterEditor!.kind, suggestion.option)
      return
    }
    if (!tokenFragment) return
    setQuery((current) => removeQuickLaunchTokenFragment(current, tokenFragment.start))
    setDismissedTokenStart(null)
    if (suggestion.kind === 'result-action') {
      setResultAction(suggestion.action)
      return
    }
    executeImmediateCommand(suggestion.actionId)
  }, [activateFilterDefinition, executeImmediateCommand, filterEditor, lockFilter, tokenFragment])

  const executeTrackOccurrence = useCallback(async (occurrence: QuickLaunchTrackOccurrence, action: QuickLaunchTrackAction) => {
    if (executionPendingRef.current) return
    executionPendingRef.current = true
    setIsExecuting(true)
    setActionError(null)
    try {
      if (action === 'next') {
        await enqueueTrackPaths([occurrence.track.path], 'next')
      } else if (action === 'queue') {
        await enqueueTrackPaths([occurrence.track.path], 'end')
      } else {
        const request = buildQuickLaunchPlayRequest(rankedTrackOccurrences, occurrence.occurrenceKey)
        if (!request) throw new Error('The selected track is no longer in these results.')
        await startPlaybackContextByPaths(request.paths, request.startIndex, { contextLabel: 'Search Results' })
      }
      closeQuickLaunch()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The track action could not be completed.')
    } finally {
      setIsExecuting(false)
      executionPendingRef.current = false
    }
  }, [closeQuickLaunch, enqueueTrackPaths, rankedTrackOccurrences, startPlaybackContextByPaths])

  const executeResult = useCallback(async (result: QuickLaunchResult, action: QuickLaunchTrackAction = 'play') => {
    if (result.kind === 'track') {
      const occurrence = rankedTrackOccurrences.find((candidate) => candidate.track.path === result.track.path) ?? {
        occurrenceKey: result.id,
        track: result.track,
        sourceIndex: 0
      }
      await executeTrackOccurrence(occurrence, action)
      return
    }
    if (executionPendingRef.current) return
    executionPendingRef.current = true
    setIsExecuting(true)
    setActionError(null)
    try {
      if (result.kind === 'setting') {
        setPendingSettingsSection(result.sectionId)
        setActiveView('settings')
      } else if (result.kind === 'nav') {
        if (result.view === 'playlist') clearPlaylistSelection()
        if (result.view === 'graph') openFullMap()
        setActiveView(result.view as Parameters<typeof setActiveView>[0])
      } else if (result.kind === 'album') {
        const artist = result.album.artist.trim()
        await selectAlbum(result.album.album, artist || undefined, 'library', result.album.identity_key)
        setActiveView('library')
      } else if (result.kind === 'artist') {
        await selectArtist(result.artist.artist, 'library')
        setActiveView('library')
      } else if (result.kind === 'playlist') {
        await selectPlaylist(result.playlist.id)
        setActiveView('playlist')
      } else {
        setViewMode('tracks')
        if (selectedAlbum || selectedArtist || selectedGenre || selectedYear !== null) await clearSelection()
        setPendingLibrarySearchQuery(result.query)
        setActiveView('library')
      }
      closeQuickLaunch()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The selected action could not be completed.')
    } finally {
      setIsExecuting(false)
      executionPendingRef.current = false
    }
  }, [clearPlaylistSelection, clearSelection, closeQuickLaunch, executeTrackOccurrence, openFullMap, rankedTrackOccurrences, selectAlbum, selectArtist, selectPlaylist, selectedAlbum, selectedArtist, selectedGenre, selectedYear, setActiveView, setPendingLibrarySearchQuery, setPendingSettingsSection, setViewMode])

  const removeArmedChip = useCallback(() => {
    if (!armedChipId) return false
    if (armedChipId === 'action') setResultAction(null)
    else setLockedFilters((current) => current.filter((filter) => filter.id !== armedChipId))
    setArmedChipId(null)
    return true
  }, [armedChipId])

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (filterEditor) {
        if (filterEditor.original) setLockedFilters((current) => [...current.filter((filter) => filter.kind !== filterEditor.kind), filterEditor.original!])
        setFilterEditor(null)
        return
      }
      if (tokenFragment) {
        setDismissedTokenStart(tokenFragment.start)
        return
      }
      closeQuickLaunch()
      return
    }

    if ((event.key === 'Backspace' || event.key === 'Delete') && !filterEditor && query.length === 0) {
      const lastFilter = lockedFilters.at(-1)
      const lastId = resultAction ? 'action' : lastFilter?.id
      if (!lastId) return
      event.preventDefault()
      if (armedChipId === lastId) removeArmedChip()
      else setArmedChipId(lastId)
      return
    }

    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && selectableCount > 0) {
      event.preventDefault()
      setArmedChipId(null)
      setSelectedResultIndex((current) => event.key === 'ArrowUp'
        ? current <= 0 ? selectableCount - 1 : current - 1
        : current >= selectableCount - 1 ? 0 : current + 1)
      return
    }

    if (event.key === 'Tab') {
      if (composerSuggestions !== null) {
        event.preventDefault()
        if (composerSuggestions.length === 0) return
        const suggestion = composerSuggestions[selectedResultIndex] ?? composerSuggestions[0]
        chooseComposerSuggestion(suggestion, false)
        return
      }
      const occurrence = selectedOccurrence ?? (selectedResult?.kind === 'track'
        ? rankedTrackOccurrences.find((candidate) => candidate.track.path === selectedResult.track.path) ?? null
        : null)
      if (occurrence) {
        event.preventDefault()
        void executeTrackOccurrence(occurrence, 'next')
      }
      return
    }

    if (event.key !== 'Enter') return
    if (composerSuggestions !== null) {
      event.preventDefault()
      if (composerSuggestions.length === 0) return
      let suggestion = composerSuggestions[selectedResultIndex] ?? composerSuggestions[0]
      if (filterEditor) {
        const exact = composerSuggestions.find((candidate) => candidate.kind === 'filter-value' && normalizeSearchValue(candidate.label) === normalizeSearchValue(filterEditor.value))
        if (exact) suggestion = exact
      }
      chooseComposerSuggestion(suggestion, true)
      return
    }
    if (selectedOccurrence) {
      event.preventDefault()
      void executeTrackOccurrence(selectedOccurrence, resultAction ?? 'play')
      return
    }
    if (selectedResult) {
      event.preventDefault()
      void executeResult(selectedResult, resultAction ?? 'play')
    }
  }

  const handleChipClick = (filter: QuickLaunchLockedFilter) => {
    setLockedFilters((current) => current.filter((candidate) => candidate.kind !== filter.kind))
    setFilterEditor({ kind: filter.kind, value: filter.label, original: filter })
    setArmedChipId(null)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const handlePanelMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (hoverSelectionEnabled) return
    const point = { x: event.clientX, y: event.clientY }
    if (!pointerOriginRef.current) {
      pointerOriginRef.current = point
      return
    }
    if (Math.hypot(point.x - pointerOriginRef.current.x, point.y - pointerOriginRef.current.y) >= POINTER_ACTIVATION_DISTANCE_PX) {
      setHoverSelectionEnabled(true)
    }
  }

  if (!presence.shouldRender) return null
  const inputValue = filterEditor?.value ?? query
  const placeholder = filterEditor
    ? `Choose ${filterEditor.kind}...`
    : 'Search tracks, albums, artists, playlists, settings...'
  let rowIndex = -1

  return (
    <div
      className="quick-launch-overlay"
      data-presence={presence.phase}
      aria-hidden={presence.phase === 'exiting'}
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeQuickLaunch() }}
    >
      <div
        className="quick-launch-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Quick Launch"
        data-hover-selection={hoverSelectionEnabled ? 'enabled' : 'blocked'}
        onMouseMove={handlePanelMouseMove}
      >
        <div className="quick-launch-input-wrap">
          <div className="quick-launch-composer">
            {lockedFilters.map((filter) => (
              <button
                key={filter.kind}
                type="button"
                className={`ql-token-chip ${armedChipId === filter.id ? 'armed' : ''}`}
                onClick={() => handleChipClick(filter)}
                disabled={isExecuting}
              >
                <span>@{filter.kind}</span>
                <strong>{filter.label}</strong>
              </button>
            ))}
            {resultAction && (
              <button
                type="button"
                className={`ql-token-chip ql-action-chip ${armedChipId === 'action' ? 'armed' : ''}`}
                onClick={() => {
                  setQuery((current) => `${current}${current ? ' ' : ''}/${resultAction}`)
                  setResultAction(null)
                  setArmedChipId(null)
                  setDismissedTokenStart(null)
                  requestAnimationFrame(() => inputRef.current?.focus())
                }}
                disabled={isExecuting}
              >
                /{resultAction}
              </button>
            )}
            {filterEditor && query && <span className="ql-preserved-query">{query}</span>}
            {filterEditor && <span className="ql-editor-prefix">@{filterEditor.kind}</span>}
            <input
              ref={inputRef}
              className="quick-launch-input"
              type="text"
              value={inputValue}
              onChange={(event) => {
                setActionError(null)
                setArmedChipId(null)
                setDismissedTokenStart(null)
                if (filterEditor) setFilterEditor({ ...filterEditor, value: event.target.value })
                else setQuery(event.target.value)
              }}
              onKeyDown={handleInputKeyDown}
              placeholder={placeholder}
              spellCheck={false}
              disabled={isExecuting}
            />
          </div>
          <span className="quick-launch-input-hint">Esc</span>
        </div>

        {(isTrackCorpusLoading || isPlaylistScopeLoading) && (
          <div className="quick-launch-status">{isPlaylistScopeLoading ? 'Loading playlist…' : 'Refreshing library index…'}</div>
        )}
        {actionError && <div className="quick-launch-error" role="alert">{actionError}</div>}

        <div className="quick-launch-results">
          {composerSuggestions ? (
            <div className="quick-launch-group ql-suggestion-group">
              <div className="quick-launch-group-label">{filterEditor ? `Choose ${filterEditor.kind}` : tokenFragment?.trigger === '@' ? 'Filters' : 'Commands'}</div>
              <div className="quick-launch-group-results">
                {composerSuggestions.map((suggestion, index) => (
                  <button
                    key={suggestion.id}
                    type="button"
                    className={`quick-launch-result-row ${selectedResultIndex === index ? 'selected' : ''}`}
                    onMouseEnter={() => { if (hoverSelectionEnabled) setSelectedResultIndex(index) }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseComposerSuggestion(suggestion, true)}
                  >
                    <span className="ql-token-suggestion-icon">{suggestion.kind.startsWith('filter') ? '@' : '/'}</span>
                    <span className="quick-launch-result-text">
                      <span className="quick-launch-result-label">{suggestion.label}</span>
                      <span className="quick-launch-result-subtitle">{suggestion.subtitle}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : structuredTrackMode ? (
            <div className="quick-launch-group ql-structured-track-group">
              <div className="quick-launch-group-label">Tracks · {rankedTrackOccurrences.length.toLocaleString()} matches</div>
              {rankedTrackOccurrences.length > 0 ? (
                <List
                  className="ql-structured-track-list"
                  defaultHeight={Math.min(rankedTrackOccurrences.length * STRUCTURED_TRACK_ROW_HEIGHT, 480)}
                  listRef={structuredListRef}
                  rowComponent={StructuredTrackRow}
                  rowCount={rankedTrackOccurrences.length}
                  rowHeight={STRUCTURED_TRACK_ROW_HEIGHT}
                  rowProps={{
                    occurrences: rankedTrackOccurrences,
                    query: trimmedQuery,
                    selectedIndex: selectedResultIndex,
                    hoverEnabled: hoverSelectionEnabled,
                    action: resultAction ?? 'play',
                    onHover: setSelectedResultIndex,
                    onExecute: (occurrence, action) => { void executeTrackOccurrence(occurrence, action) }
                  }}
                  overscanCount={6}
                  style={{ height: Math.min(rankedTrackOccurrences.length * STRUCTURED_TRACK_ROW_HEIGHT, 480) }}
                />
              ) : !isTrackCorpusLoading && !isPlaylistScopeLoading ? (
                <div className="ql-empty">No tracks match this search and filter combination.</div>
              ) : null}
            </div>
          ) : (
            <>
              {!hasQuery && <div className="ql-idle-hint">Type @ for filters · / for commands</div>}
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
                      const selected = selectedResultIndex === currentIndex
                      return (
                        <button
                          key={result.id}
                          ref={selected ? (element) => { selectedRowRef.current = element } : undefined}
                          type="button"
                          className={`quick-launch-result-row ${selected ? 'selected' : ''}`}
                          onMouseEnter={() => { if (hoverSelectionEnabled) setSelectedResultIndex(currentIndex) }}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => { void executeResult(result, resultAction ?? 'play') }}
                        >
                          {result.kind === 'track' && <ResultThumbnail hash={result.track.artwork_hash} fallback={<IconNote />} />}
                          {result.kind === 'album' && <ResultThumbnail hash={result.album.artwork_hash} fallback={<IconDisc />} />}
                          {result.kind === 'artist' && <ResultThumbnail hash={result.artist.artwork_hash} fallback={<IconPerson />} />}
                          {result.kind === 'playlist' && <ResultThumbnail hash={result.playlist.custom_cover_hash ?? result.playlist.auto_cover_hash} fallback={<IconDisc />} />}
                          {result.kind === 'setting' && <span className="ql-icon"><IconGear /></span>}
                          {result.kind === 'nav' && <span className="ql-icon"><IconNav /></span>}
                          <span className="quick-launch-result-text">
                            <span className="quick-launch-result-label">
                              {result.kind === 'setting' && highlightSearchMatch(result.label, trimmedQuery, 'ql-highlight', 'global')}
                              {result.kind === 'nav' && highlightSearchMatch(result.label, trimmedQuery, 'ql-highlight', 'global')}
                              {result.kind === 'track' && highlightSearchMatch(result.track.title, trimmedQuery, 'ql-highlight', 'global')}
                              {result.kind === 'album' && highlightSearchMatch(result.album.album, trimmedQuery, 'ql-highlight', 'global')}
                              {result.kind === 'artist' && highlightSearchMatch(result.artist.artist, trimmedQuery, 'ql-highlight', 'global')}
                              {result.kind === 'playlist' && highlightSearchMatch(result.playlist.name, trimmedQuery, 'ql-highlight', 'global')}
                            </span>
                            <span className="quick-launch-result-subtitle">
                              {result.kind === 'setting' && result.subtitle}
                              {result.kind === 'nav' && 'Navigate'}
                              {result.kind === 'track' && <>{highlightSearchMatch(result.track.artist, trimmedQuery, 'ql-highlight', 'global')} · {highlightSearchMatch(result.track.album, trimmedQuery, 'ql-highlight', 'global')}</>}
                              {result.kind === 'album' && <>by {highlightSearchMatch(result.album.artist, trimmedQuery, 'ql-highlight', 'global')}{result.album.year ? ` · ${result.album.year}` : ''}</>}
                              {result.kind === 'artist' && `${result.artist.track_count} tracks`}
                              {result.kind === 'playlist' && `${result.playlist.track_count} ${result.playlist.track_count === 1 ? 'track' : 'tracks'}`}
                            </span>
                          </span>
                          {result.kind === 'track' && selected && (
                            <span className="ql-track-actions" aria-hidden="true">
                              <span className="ql-key-action">↵ Play</span>
                              <span className="ql-key-action">⇥ Queue next</span>
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
              {seeAllResult && (
                <button
                  ref={selectedResultIndex === flatResults.length - 1 ? (element) => { selectedRowRef.current = element } : undefined}
                  type="button"
                  className={`quick-launch-result-row quick-launch-see-all ${selectedResultIndex === flatResults.length - 1 ? 'selected' : ''}`}
                  onMouseEnter={() => { if (hoverSelectionEnabled) setSelectedResultIndex(flatResults.length - 1) }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => { void executeResult(seeAllResult) }}
                >
                  <span className="quick-launch-result-label">See all in Library →</span>
                  <span className="quick-launch-result-subtitle">{seeAllResult.query}</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
