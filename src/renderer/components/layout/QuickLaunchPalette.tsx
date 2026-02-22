import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { SETTINGS_SECTIONS } from '../../constants/settingsSections'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import type { Track } from '../../types/audio'
import type {
  QuickLaunchAlbumRecord,
  QuickLaunchArtistRecord,
  QuickLaunchResult,
  QuickLaunchSeeAllResult,
  QuickLaunchTrackAction,
  QuickLaunchTrackRecord
} from '../../types/quickLaunch'
import { fuzzyScore } from '../../utils/fuzzySearch'

const SETTINGS_RESULT_LIMIT = 5
const TRACK_RESULT_LIMIT = 5
const ALBUM_RESULT_LIMIT = 4
const ARTIST_RESULT_LIMIT = 4

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
    isAtmosJoc: track.is_atmos_joc === 1
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
    isAtmosJoc: metadata?.isAtmosJoc ?? (track.is_atmos_joc === 1)
  }
}

function compareScoredResults<T extends { score: number; id: string }>(a: T, b: T): number {
  if (a.score !== b.score) {
    return b.score - a.score
  }
  return a.id.localeCompare(b.id)
}

export default function QuickLaunchPalette() {
  const isQuickLaunchOpen = useUIStore((state) => state.isQuickLaunchOpen)
  const closeQuickLaunch = useUIStore((state) => state.closeQuickLaunch)
  const setPendingLibrarySearchQuery = useUIStore((state) => state.setPendingLibrarySearchQuery)
  const setPendingSettingsSection = useUIStore((state) => state.setPendingSettingsSection)
  const setActiveView = useUIStore((state) => state.setActiveView)

  const albums = useLibraryStore((state) => state.albums) as QuickLaunchAlbumRecord[]
  const artists = useLibraryStore((state) => state.artists) as QuickLaunchArtistRecord[]
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

  const [query, setQuery] = useState('')
  const [selectedResultIndex, setSelectedResultIndex] = useState(0)
  const [isTrackCorpusLoading, setIsTrackCorpusLoading] = useState(false)
  const [trackCorpus, setTrackCorpus] = useState<QuickLaunchTrackRecord[]>([])
  const [isExecuting, setIsExecuting] = useState(false)
  const [trackActionSelection, setTrackActionSelection] = useState<{
    trackPath: string
    action: QuickLaunchTrackAction
  } | null>(null)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const selectedRowRef = useRef<HTMLElement | null>(null)

  const trimmedQuery = query.trim()
  const hasQuery = trimmedQuery.length > 0

  useEffect(() => {
    if (!isQuickLaunchOpen) return

    setQuery('')
    setSelectedResultIndex(0)
    setTrackActionSelection(null)

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

  const settingResults = useMemo(() => {
    if (!hasQuery) {
      return SETTINGS_SECTIONS.map((section) => ({
        kind: 'setting' as const,
        id: `setting:${section.id}`,
        score: 0,
        sectionId: section.id,
        label: section.label,
        subtitle: section.keywords.join(' · ')
      }))
    }

    const scored = SETTINGS_SECTIONS.map((section) => {
      const candidate = `${section.label} ${section.keywords.join(' ')}`
      const score = fuzzyScore(trimmedQuery, candidate)
      if (score === null) return null

      return {
        kind: 'setting' as const,
        id: `setting:${section.id}`,
        score,
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
      const candidate = `${track.title} ${track.artist} ${track.album}`
      const score = fuzzyScore(trimmedQuery, candidate)
      if (score === null) return null
      return {
        kind: 'track' as const,
        id: `track:${track.path}`,
        score,
        track
      }
    }).filter((result): result is NonNullable<typeof result> => result !== null)

    return scored.sort(compareScoredResults).slice(0, TRACK_RESULT_LIMIT)
  }, [hasQuery, trackCorpus, trimmedQuery])

  const albumResults = useMemo(() => {
    if (!hasQuery) return []

    const scored = albums.map((album) => {
      const candidate = `${album.album} ${album.artist}`
      const score = fuzzyScore(trimmedQuery, candidate)
      if (score === null) return null

      return {
        kind: 'album' as const,
        id: `album:${album.album}::${album.artist}`,
        score,
        album
      }
    }).filter((result): result is NonNullable<typeof result> => result !== null)

    return scored.sort(compareScoredResults).slice(0, ALBUM_RESULT_LIMIT)
  }, [albums, hasQuery, trimmedQuery])

  const artistResults = useMemo(() => {
    if (!hasQuery) return []

    const scored = artists.map((artist) => {
      const score = fuzzyScore(trimmedQuery, artist.artist)
      if (score === null) return null

      return {
        kind: 'artist' as const,
        id: `artist:${artist.artist}`,
        score,
        artist
      }
    }).filter((result): result is NonNullable<typeof result> => result !== null)

    return scored.sort(compareScoredResults).slice(0, ARTIST_RESULT_LIMIT)
  }, [artists, hasQuery, trimmedQuery])

  const seeAllResult = useMemo<QuickLaunchSeeAllResult | null>(() => {
    if (!hasQuery) return null
    return {
      kind: 'see-all',
      id: 'see-all-in-library',
      query: trimmedQuery
    }
  }, [hasQuery, trimmedQuery])

  const resultGroups = useMemo<ResultGroup[]>(() => {
    const groups: ResultGroup[] = []

    if (settingResults.length > 0) {
      groups.push({
        id: 'settings',
        label: 'Settings',
        results: settingResults
      })
    }

    if (trackResults.length > 0) {
      groups.push({
        id: 'tracks',
        label: 'Tracks',
        results: trackResults
      })
    }

    if (albumResults.length > 0) {
      groups.push({
        id: 'albums',
        label: 'Albums',
        results: albumResults
      })
    }

    if (artistResults.length > 0) {
      groups.push({
        id: 'artists',
        label: 'Artists',
        results: artistResults
      })
    }

    return groups
  }, [albumResults, artistResults, settingResults, trackResults])

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
  const isTrackActionPickerOpen = Boolean(
    selectedResult?.kind === 'track'
    && trackActionSelection
    && trackActionSelection.trackPath === selectedResult.track.path
  )

  useEffect(() => {
    if (flatResults.length === 0) {
      setSelectedResultIndex(0)
      setTrackActionSelection(null)
      return
    }

    setSelectedResultIndex((current) => Math.max(0, Math.min(current, flatResults.length - 1)))
  }, [flatResults.length])

  useEffect(() => {
    if (!trackActionSelection) return
    if (!selectedResult || selectedResult.kind !== 'track' || selectedResult.track.path !== trackActionSelection.trackPath) {
      setTrackActionSelection(null)
    }
  }, [selectedResult, trackActionSelection])

  useEffect(() => {
    if (!isQuickLaunchOpen) return
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [isQuickLaunchOpen, selectedResultIndex])

  const toggleSelectedTrackAction = useCallback(() => {
    setTrackActionSelection((current) => {
      if (!current) return current
      return {
        ...current,
        action: current.action === 'play-now' ? 'queue-next' : 'play-now'
      }
    })
  }, [])

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

      if (result.kind === 'album') {
        const albumArtist = result.album.artist.trim()
        setViewMode('tracks')
        await selectAlbum(result.album.album, albumArtist.length > 0 ? albumArtist : undefined, 'library')
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

      const trackAction = requestedTrackAction ?? 'play-now'

      if (trackAction === 'queue-next') {
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
      if (isTrackActionPickerOpen) {
        setTrackActionSelection(null)
      } else {
        closeQuickLaunch()
      }
      return
    }

    if (flatResults.length === 0) return
    if (!selectedResult) return

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()

      if (isTrackActionPickerOpen) {
        toggleSelectedTrackAction()
        return
      }

      setSelectedResultIndex((current) => {
        if (event.key === 'ArrowUp') {
          return current <= 0 ? flatResults.length - 1 : current - 1
        }
        return current >= flatResults.length - 1 ? 0 : current + 1
      })
      return
    }

    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && isTrackActionPickerOpen) {
      event.preventDefault()
      toggleSelectedTrackAction()
      return
    }

    if (event.key !== 'Enter') return

    event.preventDefault()
    if (selectedResult.kind === 'track') {
      if (!isTrackActionPickerOpen) {
        setTrackActionSelection({
          trackPath: selectedResult.track.path,
          action: 'play-now'
        })
        return
      }

      void executeResult(selectedResult, trackActionSelection?.action ?? 'play-now')
      return
    }

    void executeResult(selectedResult)
  }

  const handleTrackRowClick = (result: QuickLaunchResult, index: number) => {
    if (result.kind !== 'track') return
    setSelectedResultIndex(index)
    setTrackActionSelection({
      trackPath: result.track.path,
      action: 'play-now'
    })
  }

  const handleResultClick = (result: QuickLaunchResult, index: number) => {
    setSelectedResultIndex(index)
    if (result.kind === 'track') {
      handleTrackRowClick(result, index)
      return
    }
    void executeResult(result)
  }

  const handleActionClick = (
    event: ReactMouseEvent<HTMLButtonElement>,
    result: QuickLaunchResult,
    action: QuickLaunchTrackAction
  ) => {
    event.stopPropagation()
    if (result.kind !== 'track') return
    setTrackActionSelection({
      trackPath: result.track.path,
      action
    })
    void executeResult(result, action)
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
              setTrackActionSelection(null)
            }}
            onKeyDown={handleInputKeyDown}
            placeholder="Search settings, tracks, albums, artists..."
            spellCheck={false}
            disabled={isExecuting}
          />
          <span className="quick-launch-input-hint">Esc</span>
        </div>

        {isTrackCorpusLoading && (
          <div className="quick-launch-status">Refreshing library index...</div>
        )}

        <div className="quick-launch-results">
          {resultGroups.map((group) => (
            <div key={group.id} className="quick-launch-group">
              <div className="quick-launch-group-label">{group.label}</div>
              <div className="quick-launch-group-results">
                {group.results.map((result) => {
                  rowIndex += 1
                  const currentIndex = rowIndex
                  const isSelected = selectedResultIndex === currentIndex
                  const isTrack = result.kind === 'track'
                  const showTrackActions = Boolean(
                    isTrack
                    && isSelected
                    && trackActionSelection
                    && trackActionSelection.trackPath === result.track.path
                  )

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
                      <span className="quick-launch-result-label">
                        {result.kind === 'setting' && result.label}
                        {result.kind === 'track' && result.track.title}
                        {result.kind === 'album' && result.album.album}
                        {result.kind === 'artist' && result.artist.artist}
                      </span>
                      <span className="quick-launch-result-subtitle">
                        {result.kind === 'setting' && result.subtitle}
                        {result.kind === 'track' && `${result.track.artist} · ${result.track.album}`}
                        {result.kind === 'album' && `by ${result.album.artist}`}
                        {result.kind === 'artist' && `${result.artist.track_count} tracks`}
                      </span>
                      {showTrackActions && (
                        <span className="quick-launch-track-actions">
                          <button
                            type="button"
                            className={`quick-launch-track-action ${trackActionSelection?.action === 'play-now' ? 'active' : ''}`}
                            onClick={(event) => handleActionClick(event, result, 'play-now')}
                          >
                            Play now
                          </button>
                          <button
                            type="button"
                            className={`quick-launch-track-action ${trackActionSelection?.action === 'queue-next' ? 'active' : ''}`}
                            onClick={(event) => handleActionClick(event, result, 'queue-next')}
                          >
                            Queue next
                          </button>
                        </span>
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
              <span className="quick-launch-result-label">See all in Library →</span>
              <span className="quick-launch-result-subtitle">{seeAllResult.query}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
