import { CSSProperties, memo, ReactElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { List, RowComponentProps } from 'react-window'
import { usePlayerStore } from '../../stores/playerStore'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useAudioSettingsStore } from '../../stores/audioSettingsStore'
import { useOpenArtistInLibrary } from '../../hooks/useOpenArtistInLibrary'
import { Track } from '../../types/audio'
import AlbumArtwork from './AlbumArtwork'
import ArtistNameLinks from './ArtistNameLinks'

interface DbTrack {
  id: number
  path: string
  title: string
  artist: string
  album: string
  duration: number
  track_number: number | null
  artwork_hash: string | null
  format: string
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  codec?: string | null
  codec_profile?: string | null
  is_atmos_joc?: number | null
}

interface TrackListProps {
  tracks: DbTrack[]
  showArtist?: boolean
  showAlbum?: boolean
}

interface PlaylistSummary {
  id: number
  name: string
}

interface TrackListRowSharedProps {
  tracks: DbTrack[]
  showArtist: boolean
  showAlbum: boolean
  currentTrackPath: string | null
  currentTrackChannels: number | undefined
  currentTrackIsAtmosJoc: boolean
  isPlaying: boolean
  selectedOutputChannelCount: number | null
  favorites: Set<string>
  playlists: PlaylistSummary[]
  playlistDropdownTrack: string | null
  queuedTrackPaths: Set<string>
  nextQueuedTrackPath: string | null
  queueFeedback: Record<string, true>
  openArtistInLibrary: (artist: string) => void | Promise<void>
  formatDuration: (seconds: number) => string
  onTrackClick: (track: DbTrack, index: number) => Promise<void>
  onPlayNext: (event: React.MouseEvent, track: DbTrack) => void
  onAddToQueue: (event: React.MouseEvent, track: DbTrack) => void
  onToggleFavorite: (event: React.MouseEvent, trackPath: string) => void
  onTogglePlaylistDropdown: (event: React.MouseEvent, trackPath: string) => void
  onAddTrackToPlaylist: (event: React.MouseEvent, playlistId: number, trackPath: string) => Promise<void>
}

const TRACK_ROW_HEIGHT_FALLBACK_PX = 48
const TRACK_LIST_OVERSCAN_COUNT = 8

// Convert DbTrack to Track
function dbTrackToTrack(dbTrack: DbTrack): Track {
  return {
    id: dbTrack.path,
    path: dbTrack.path,
    title: dbTrack.title,
    artist: dbTrack.artist,
    album: dbTrack.album,
    duration: dbTrack.duration,
    format: dbTrack.format,
    artworkHash: dbTrack.artwork_hash ?? undefined,
    sampleRate: dbTrack.sample_rate ?? undefined,
    bitDepth: dbTrack.bit_depth ?? undefined,
    bitrate: dbTrack.bitrate ?? undefined,
    channels: dbTrack.channels ?? undefined,
    codec: dbTrack.codec ?? undefined,
    codecProfile: dbTrack.codec_profile ?? undefined,
    isAtmosJoc: dbTrack.is_atmos_joc === 1
  }
}

function hasQueueActionFeedback(queueFeedback: Record<string, true>, action: 'queue' | 'next', trackPath: string): boolean {
  return Boolean(queueFeedback[`${action}:${trackPath}`])
}

function resolveTrackRowHeightPx(element: HTMLElement | null): number {
  if (!element) return TRACK_ROW_HEIGHT_FALLBACK_PX

  const cssValue = getComputedStyle(element).getPropertyValue('--track-row-height').trim()
  const parsed = Number.parseFloat(cssValue)
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed)
  }

  return TRACK_ROW_HEIGHT_FALLBACK_PX
}

function TrackListRowRenderer({
  ariaAttributes,
  index,
  style,
  tracks,
  showArtist,
  showAlbum,
  currentTrackPath,
  currentTrackChannels,
  currentTrackIsAtmosJoc,
  isPlaying,
  selectedOutputChannelCount,
  favorites,
  playlists,
  playlistDropdownTrack,
  queuedTrackPaths,
  nextQueuedTrackPath,
  queueFeedback,
  openArtistInLibrary,
  formatDuration,
  onTrackClick,
  onPlayNext,
  onAddToQueue,
  onToggleFavorite,
  onTogglePlaylistDropdown,
  onAddTrackToPlaylist
}: RowComponentProps<TrackListRowSharedProps>): ReactElement | null {
  const track = tracks[index]
  if (!track) return null

  const isCurrent = currentTrackPath === track.path
  const showPlayNextCheck = nextQueuedTrackPath === track.path || hasQueueActionFeedback(queueFeedback, 'next', track.path)
  const showAddQueueCheck = queuedTrackPaths.has(track.path) || hasQueueActionFeedback(queueFeedback, 'queue', track.path)
  const resolvedChannelCount = track.channels ?? (isCurrent ? currentTrackChannels : undefined)
  const isMultichannel = (resolvedChannelCount ?? 0) > 2
  const rowCodecProfile = track.codec_profile?.toLowerCase() ?? ''
  const rowCodec = track.codec?.toLowerCase() ?? ''
  const rowIsAtmosJoc = Boolean(
    track.is_atmos_joc === 1
    || rowCodecProfile.includes('atmos')
    || rowCodecProfile.includes('joc')
    || rowCodec.includes('atmos')
    || rowCodec.includes('joc')
  )
  const showAtmosBadge = Boolean(rowIsAtmosJoc || (isCurrent && currentTrackIsAtmosJoc))
  const isDownmixingCurrentAtmos = Boolean(
    isCurrent
    && currentTrackIsAtmosJoc
    && selectedOutputChannelCount
    && currentTrackChannels
    && selectedOutputChannelCount > 0
    && selectedOutputChannelCount < currentTrackChannels
  )
  const atmosphereBadgeTitle = isDownmixingCurrentAtmos
    ? `Atmos (EC-3/JOC) source is being downmixed to ${selectedOutputChannelCount} channels. Output quality can vary.`
    : 'Atmos (EC-3/JOC) metadata detected. Playback uses compatibility decoding and cannot guarantee native Atmos object rendering.'
  const channelBadgeTitle = isDownmixingCurrentAtmos
    ? `Atmos (EC-3/JOC) source is being downmixed to ${selectedOutputChannelCount} channels. Output quality can vary.`
    : showAtmosBadge
      ? 'Atmos (EC-3/JOC) metadata detected. Playback uses compatibility decoding and cannot guarantee native Atmos object rendering.'
      : `${resolvedChannelCount ?? 0} channels`

  return (
    <div className="track-list-item" style={style as CSSProperties} {...ariaAttributes}>
      <div
        className={`track-row ${isCurrent ? 'track-row-active' : ''}`}
        onClick={() => {
          void onTrackClick(track, index)
        }}
      >
        <div className="track-col track-col-num">
          {isCurrent && isPlaying ? (
            <span className="track-playing-icon">&#9654;</span>
          ) : (
            <span className="track-number">{track.track_number ?? index + 1}</span>
          )}
        </div>
        <div className="track-col track-col-title">
          <div className="track-title-cell">
            <div className="track-artwork-thumb">
              <AlbumArtwork hash={track.artwork_hash} alt={track.album || track.title} />
            </div>
            <span className="track-title">{track.title}</span>
            {showAtmosBadge && (
              <span className="track-channel-badge track-channel-badge-atmos" title={atmosphereBadgeTitle}>
                <span>ATMOS</span>
              </span>
            )}
            {isMultichannel && (
              <span className="track-channel-badge" title={channelBadgeTitle}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 10v4h4l5 5V5l-5 5H3zm13.5 2c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zm2.5 0c0 3.04-1.72 5.64-4.25 6.92l-.75-1.83c1.92-.98 3.25-2.97 3.25-5.09s-1.33-4.11-3.25-5.09l.75-1.83C17.28 6.36 19 8.96 19 12z" />
                </svg>
                <span>{resolvedChannelCount}CH</span>
              </span>
            )}
          </div>
        </div>
        {showArtist && (
          <div className="track-col track-col-artist">
            <ArtistNameLinks
              artistText={track.artist}
              onArtistClick={openArtistInLibrary}
              className="track-artist"
              linkClassName="artist-name-link-inline"
              stopPropagation
            />
          </div>
        )}
        {showAlbum && (
          <div className="track-col track-col-album">
            <span className="track-album">{track.album}</span>
          </div>
        )}
        <div className="track-col track-col-codec">
          <span className="track-codec">{track.format ? track.format.toUpperCase() : '\u2014'}</span>
        </div>
        <div className="track-col track-col-duration">
          <span className="track-duration">{formatDuration(track.duration)}</span>
        </div>
        <div className="track-col track-col-actions">
          <div className="track-actions">
            <button
              className={`track-action-btn ${favorites.has(track.path) ? 'active' : ''}`}
              onClick={(event) => onToggleFavorite(event, track.path)}
              title={favorites.has(track.path) ? 'Remove from favorites' : 'Add to favorites'}
            >
              {favorites.has(track.path) ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                </svg>
              )}
            </button>
            <div className="track-playlist-wrap">
              <button
                className="track-action-btn"
                onClick={(event) => onTogglePlaylistDropdown(event, track.path)}
                title="Add to playlist"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
                </svg>
              </button>
              {playlistDropdownTrack === track.path && (
                <div className="track-playlist-dropdown" onClick={(event) => event.stopPropagation()}>
                  {playlists.length > 0 ? (
                    playlists.map((playlist) => (
                      <button
                        key={playlist.id}
                        className="track-playlist-option"
                        onClick={(event) => {
                          void onAddTrackToPlaylist(event, playlist.id, track.path)
                        }}
                      >
                        {playlist.name}
                      </button>
                    ))
                  ) : (
                    <div className="track-playlist-empty">No playlists</div>
                  )}
                </div>
              )}
            </div>
            <button
              className={`track-action-btn ${showPlayNextCheck ? 'queued' : ''}`}
              onClick={(event) => onPlayNext(event, track)}
              title={showPlayNextCheck ? 'Queued to play next' : 'Play Next'}
            >
              {showPlayNextCheck ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
                </svg>
              )}
            </button>
            <button
              className={`track-action-btn ${showAddQueueCheck ? 'queued' : ''}`}
              onClick={(event) => onAddToQueue(event, track)}
              title={showAddQueueCheck ? 'In queue' : 'Add to Queue'}
            >
              {showAddQueueCheck ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M13 7h-2v4H7v2h4v4h2v-4h4v-2h-4V7zm-1-5C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const TrackListRow = memo(TrackListRowRenderer) as (
  props: RowComponentProps<TrackListRowSharedProps>
) => ReactElement | null

export default function TrackList({ tracks, showArtist = true, showAlbum = true }: TrackListProps) {
  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const playbackState = usePlayerStore((state) => state.playbackState)
  const queue = usePlayerStore((state) => state.queue)
  const queueIndex = usePlayerStore((state) => state.queueIndex)
  const loadTrack = usePlayerStore((state) => state.loadTrack)
  const play = usePlayerStore((state) => state.play)
  const setQueue = usePlayerStore((state) => state.setQueue)
  const addToQueue = usePlayerStore((state) => state.addToQueue)
  const addToQueueNext = usePlayerStore((state) => state.addToQueueNext)
  const selectedOutputChannelCount = useAudioSettingsStore((state) => state.selectedOutputChannelCount)
  const favorites = useLibraryStore((state) => state.favorites)
  const toggleFavorite = useLibraryStore((state) => state.toggleFavorite)
  const playlists = usePlaylistStore((state) => state.playlists)
  const addToPlaylist = usePlaylistStore((state) => state.addToPlaylist)
  const openArtistInLibrary = useOpenArtistInLibrary()

  const [playlistDropdownTrack, setPlaylistDropdownTrack] = useState<string | null>(null)
  const [queueFeedback, setQueueFeedback] = useState<Record<string, true>>({})
  const [listViewportHeight, setListViewportHeight] = useState(0)
  const [trackRowHeight, setTrackRowHeight] = useState(TRACK_ROW_HEIGHT_FALLBACK_PX)

  const queueFeedbackTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const listBodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    return () => {
      for (const timer of queueFeedbackTimersRef.current.values()) {
        clearTimeout(timer)
      }
      queueFeedbackTimersRef.current.clear()
    }
  }, [])

  useEffect(() => {
    setPlaylistDropdownTrack((current) => {
      if (!current) return current
      return tracks.some((track) => track.path === current) ? current : null
    })
  }, [tracks])

  useLayoutEffect(() => {
    const element = listBodyRef.current
    if (!element) return

    const updateMeasurements = () => {
      const nextHeight = Math.max(0, Math.round(element.clientHeight))
      const nextRowHeight = resolveTrackRowHeightPx(element)

      setListViewportHeight((previous) => (previous === nextHeight ? previous : nextHeight))
      setTrackRowHeight((previous) => (previous === nextRowHeight ? previous : nextRowHeight))
    }

    updateMeasurements()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateMeasurements)
      return () => {
        window.removeEventListener('resize', updateMeasurements)
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      updateMeasurements()
    })
    resizeObserver.observe(element)

    return () => {
      resizeObserver.disconnect()
    }
  }, [])

  const queuedTrackPaths = useMemo(() => new Set(queue.map((queuedTrack) => queuedTrack.path)), [queue])
  const queueTracks = useMemo(() => tracks.map(dbTrackToTrack), [tracks])
  const nextQueueIndex = queueIndex >= 0 ? queueIndex + 1 : 0
  const nextQueuedTrackPath = queue[nextQueueIndex]?.path ?? null

  const currentTrackPath = currentTrack?.path ?? null
  const isPlaying = playbackState === 'playing'
  const currentTrackChannels = currentTrack?.channels
  const currentCodecProfile = currentTrack?.codecProfile?.toLowerCase() ?? ''
  const currentCodec = currentTrack?.codec?.toLowerCase() ?? ''
  const currentTrackIsAtmosJoc = Boolean(
    currentTrack?.isAtmosJoc
    || currentCodecProfile.includes('atmos')
    || currentCodecProfile.includes('joc')
    || currentCodec.includes('atmos')
    || currentCodec.includes('joc')
  )

  const setQueueActionFeedback = useCallback((action: 'queue' | 'next', trackPath: string) => {
    const feedbackKey = `${action}:${trackPath}`

    setQueueFeedback((previous) => ({ ...previous, [feedbackKey]: true }))

    const existingTimer = queueFeedbackTimersRef.current.get(feedbackKey)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const timer = setTimeout(() => {
      setQueueFeedback((previous) => {
        if (!previous[feedbackKey]) return previous
        const next = { ...previous }
        delete next[feedbackKey]
        return next
      })
      queueFeedbackTimersRef.current.delete(feedbackKey)
    }, 1400)

    queueFeedbackTimersRef.current.set(feedbackKey, timer)
  }, [])

  const formatDuration = useCallback((seconds: number): string => {
    if (!seconds || !isFinite(seconds)) return '--:--'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }, [])

  const handleTrackClick = useCallback(async (dbTrack: DbTrack, index: number) => {
    setQueue(queueTracks, index)

    const result = await window.electronAPI.loadAudioFile(dbTrack.path, { metadataMode: 'none' })
    if (!result) return

    const track: Track = {
      id: dbTrack.path,
      path: dbTrack.path,
      title: result.metadata?.title ?? dbTrack.title,
      artist: result.metadata?.artist ?? dbTrack.artist,
      album: result.metadata?.album ?? dbTrack.album,
      duration: result.metadata?.duration ?? dbTrack.duration,
      format: dbTrack.format,
      artworkData: result.metadata?.artwork,
      artworkHash: dbTrack.artwork_hash ?? undefined,
      sampleRate: dbTrack.sample_rate ?? undefined,
      bitDepth: dbTrack.bit_depth ?? undefined,
      bitrate: dbTrack.bitrate ?? undefined,
      channels: result.metadata?.channels ?? dbTrack.channels ?? undefined,
      codec: result.metadata?.codec ?? dbTrack.codec ?? undefined,
      codecProfile: result.metadata?.codecProfile ?? dbTrack.codec_profile ?? undefined,
      isAtmosJoc: result.metadata?.isAtmosJoc ?? (dbTrack.is_atmos_joc === 1)
    }

    const loaded = await loadTrack(track, result.data)
    if (loaded) {
      await play()
    }
  }, [loadTrack, play, queueTracks, setQueue])

  const handlePlayNext = useCallback((event: React.MouseEvent, dbTrack: DbTrack) => {
    event.stopPropagation()
    addToQueueNext(dbTrackToTrack(dbTrack))
    setQueueActionFeedback('next', dbTrack.path)
  }, [addToQueueNext, setQueueActionFeedback])

  const handleAddToQueue = useCallback((event: React.MouseEvent, dbTrack: DbTrack) => {
    event.stopPropagation()
    addToQueue(dbTrackToTrack(dbTrack))
    setQueueActionFeedback('queue', dbTrack.path)
  }, [addToQueue, setQueueActionFeedback])

  const handleToggleFavorite = useCallback((event: React.MouseEvent, trackPath: string) => {
    event.stopPropagation()
    void toggleFavorite(trackPath)
  }, [toggleFavorite])

  const handleTogglePlaylistDropdown = useCallback((event: React.MouseEvent, trackPath: string) => {
    event.stopPropagation()
    setPlaylistDropdownTrack((current) => (current === trackPath ? null : trackPath))
  }, [])

  const handleAddTrackToPlaylist = useCallback(async (event: React.MouseEvent, playlistId: number, trackPath: string) => {
    event.stopPropagation()
    await addToPlaylist(playlistId, [trackPath])
    setPlaylistDropdownTrack(null)
  }, [addToPlaylist])

  const handleListScroll = useCallback(() => {
    setPlaylistDropdownTrack((current) => (current ? null : current))
  }, [])

  const listHeight = listViewportHeight > 0 ? listViewportHeight : trackRowHeight

  const rowProps = useMemo<TrackListRowSharedProps>(() => ({
    tracks,
    showArtist,
    showAlbum,
    currentTrackPath,
    currentTrackChannels,
    currentTrackIsAtmosJoc,
    isPlaying,
    selectedOutputChannelCount,
    favorites,
    playlists,
    playlistDropdownTrack,
    queuedTrackPaths,
    nextQueuedTrackPath,
    queueFeedback,
    openArtistInLibrary,
    formatDuration,
    onTrackClick: handleTrackClick,
    onPlayNext: handlePlayNext,
    onAddToQueue: handleAddToQueue,
    onToggleFavorite: handleToggleFavorite,
    onTogglePlaylistDropdown: handleTogglePlaylistDropdown,
    onAddTrackToPlaylist: handleAddTrackToPlaylist
  }), [
    tracks,
    showArtist,
    showAlbum,
    currentTrackPath,
    currentTrackChannels,
    currentTrackIsAtmosJoc,
    isPlaying,
    selectedOutputChannelCount,
    favorites,
    playlists,
    playlistDropdownTrack,
    queuedTrackPaths,
    nextQueuedTrackPath,
    queueFeedback,
    openArtistInLibrary,
    formatDuration,
    handleTrackClick,
    handlePlayNext,
    handleAddToQueue,
    handleToggleFavorite,
    handleTogglePlaylistDropdown,
    handleAddTrackToPlaylist
  ])

  if (tracks.length === 0) {
    return (
      <div className="track-list-empty">
        <p>No tracks found</p>
      </div>
    )
  }

  return (
    <div className="track-list">
      <div className="track-list-header">
        <div className="track-col track-col-num">#</div>
        <div className="track-col track-col-title">Title</div>
        {showArtist && <div className="track-col track-col-artist">Artist</div>}
        {showAlbum && <div className="track-col track-col-album">Album</div>}
        <div className="track-col track-col-codec">Codec</div>
        <div className="track-col track-col-duration">Length</div>
        <div className="track-col track-col-actions" />
      </div>
      <div className="track-list-body" ref={listBodyRef}>
        <List
          className="track-list-virtualized"
          defaultHeight={TRACK_ROW_HEIGHT_FALLBACK_PX * 8}
          onScroll={handleListScroll}
          overscanCount={TRACK_LIST_OVERSCAN_COUNT}
          rowComponent={TrackListRow}
          rowCount={tracks.length}
          rowHeight={trackRowHeight}
          rowProps={rowProps}
          style={{ height: listHeight, width: '100%' }}
        />
      </div>
    </div>
  )
}
