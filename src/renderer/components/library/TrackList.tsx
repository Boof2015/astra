import { CSSProperties, memo, ReactElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { List, RowComponentProps, type ListImperativeAPI } from 'react-window'
import { usePlayerStore } from '../../stores/playerStore'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useAudioSettingsStore } from '../../stores/audioSettingsStore'
import type { LibraryTrackRevealRequest } from '../../stores/uiStore'
import { useOpenArtistInLibrary } from '../../hooks/useOpenArtistInLibrary'
import { useOpenAlbumInLibrary } from '../../hooks/useOpenAlbumInLibrary'
import { Track } from '../../types/audio'
import type { TrackSourceType } from '../../../types/subsonic'
import AlbumArtwork from './AlbumArtwork'
import ArtistNameLinks from './ArtistNameLinks'
import PlaylistCover from '../playlists/PlaylistCover'

interface DbTrack {
  id: number
  path: string
  title: string
  artist: string
  album: string
  album_artist: string | null
  duration: number
  track_number: number | null
  artwork_hash: string | null
  format: string
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  bpm: number | null
  musical_key: string | null
  replaygain_track_gain_db: number | null
  replaygain_album_gain_db: number | null
  source_type: TrackSourceType
  source_id: number | null
  source_track_id: string | null
  source_path: string | null
  is_available: number
  availability_reason: string | null
  codec?: string | null
  codec_profile?: string | null
  is_atmos_joc?: number | null
}

export type TrackListSortKey = 'title' | 'artist' | 'album' | 'duration' | 'bpm' | 'musical_key'

export interface TrackListSortState {
  key: TrackListSortKey
  direction: 'asc' | 'desc'
}

interface TrackListProps {
  tracks: DbTrack[]
  queueSeedTracks?: DbTrack[]
  showArtist?: boolean
  showAlbum?: boolean
  externalScroll?: boolean
  playlistSourceId?: number | null
  jumpToTrackRequest?: LibraryTrackRevealRequest | null
  enableColumnSorting?: boolean
  sortState?: TrackListSortState | null
  onSortColumnToggle?: (key: TrackListSortKey) => void
  enableDefaultOrderReset?: boolean
  onDefaultOrderReset?: () => void
}

interface TrackListRowSharedProps {
  tracks: DbTrack[]
  showArtist: boolean
  showAlbum: boolean
  showTracklistBpmKey: boolean
  currentTrackPath: string | null
  loadingTrackPath: string | null
  loadingTrackPercent: number | null
  loadingTrackChunkCount: number
  currentTrackChannels: number | undefined
  currentTrackIsAtmosJoc: boolean
  isPlaying: boolean
  isLoadingTrack: boolean
  selectedOutputChannelCount: number | null
  favorites: Set<string>
  playlistPopupTrackPath: string | null
  queuedTrackPaths: Set<string>
  nextQueuedTrackPath: string | null
  queueFeedback: Record<string, true>
  openArtistInLibrary: (artist: string) => void | Promise<void>
  openAlbumInLibrary: (albumName: string, trackArtist: string, albumArtist?: string | null) => void | Promise<void>
  formatBpm: (bpm: number | null | undefined) => string
  formatDuration: (seconds: number) => string
  onTrackClick: (track: DbTrack, index: number) => Promise<void>
  onPlayNext: (event: React.MouseEvent, track: DbTrack) => void
  onAddToQueue: (event: React.MouseEvent, track: DbTrack) => void
  onToggleFavorite: (event: React.MouseEvent, trackPath: string) => void
  onOpenPlaylistPopup: (event: React.MouseEvent<HTMLButtonElement>, trackPath: string) => void
}

const TRACK_ROW_HEIGHT_FALLBACK_PX = 48
const TRACK_LIST_OVERSCAN_COUNT = 8

interface TrackPlaylistPopupState {
  trackPath: string
  anchor: {
    top: number
    left: number
    right: number
    bottom: number
    height: number
  }
}

// Convert DbTrack to Track
function dbTrackToTrack(dbTrack: DbTrack): Track {
  return {
    id: dbTrack.path,
    path: dbTrack.path,
    title: dbTrack.title,
    artist: dbTrack.artist,
    album: dbTrack.album,
    albumArtist: dbTrack.album_artist ?? undefined,
    duration: dbTrack.duration,
    format: dbTrack.format,
    artworkHash: dbTrack.artwork_hash ?? undefined,
    sampleRate: dbTrack.sample_rate ?? undefined,
    bitDepth: dbTrack.bit_depth ?? undefined,
    bitrate: dbTrack.bitrate ?? undefined,
    channels: dbTrack.channels ?? undefined,
    codec: dbTrack.codec ?? undefined,
    codecProfile: dbTrack.codec_profile ?? undefined,
    isAtmosJoc: dbTrack.is_atmos_joc === 1,
    replayGainTrackDb: dbTrack.replaygain_track_gain_db ?? undefined,
    replayGainAlbumDb: dbTrack.replaygain_album_gain_db ?? undefined,
    sourceType: dbTrack.source_type,
    sourceId: dbTrack.source_id ?? undefined,
    sourceTrackId: dbTrack.source_track_id ?? undefined,
    sourcePath: dbTrack.source_path ?? undefined,
    isAvailable: dbTrack.is_available === 1,
    availabilityReason: dbTrack.availability_reason ?? undefined
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

function formatTrackBpm(bpm: number | null | undefined): string {
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) return '--'

  const rounded = Math.round(bpm * 10) / 10
  if (!Number.isFinite(rounded) || rounded <= 0) return '--'
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function isUnavailableRemoteTrack(track: Pick<DbTrack, 'source_type' | 'is_available'>): boolean {
  return track.source_type !== 'local' && track.is_available !== 1
}

function TrackListRowRenderer({
  ariaAttributes,
  index,
  style,
  tracks,
  showArtist,
  showAlbum,
  showTracklistBpmKey,
  currentTrackPath,
  loadingTrackPath,
  loadingTrackPercent,
  loadingTrackChunkCount,
  currentTrackChannels,
  currentTrackIsAtmosJoc,
  isPlaying,
  isLoadingTrack,
  selectedOutputChannelCount,
  favorites,
  playlistPopupTrackPath,
  queuedTrackPaths,
  nextQueuedTrackPath,
  queueFeedback,
  openArtistInLibrary,
  openAlbumInLibrary,
  formatBpm,
  formatDuration,
  onTrackClick,
  onPlayNext,
  onAddToQueue,
  onToggleFavorite,
  onOpenPlaylistPopup
}: RowComponentProps<TrackListRowSharedProps>): ReactElement | null {
  const track = tracks[index]
  if (!track) return null

  const isCurrent = currentTrackPath === track.path
  const isCurrentLoading = isCurrent
    && isLoadingTrack
    && track.source_type === 'subsonic'
    && (loadingTrackPath === null || loadingTrackPath === track.path)
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

  const isUnavailable = isUnavailableRemoteTrack(track)
  const loadingPercentLabel = typeof loadingTrackPercent === 'number' && Number.isFinite(loadingTrackPercent)
    ? `${Math.round(Math.max(0, Math.min(1, loadingTrackPercent)) * 100)}%`
    : null

  return (
    <div className="track-list-item" style={style as CSSProperties} {...ariaAttributes}>
      <div
        className={`track-row ${isCurrent ? 'track-row-active' : ''} ${isCurrentLoading ? 'track-row-loading' : ''} ${isUnavailable ? 'track-row-unavailable' : ''}`}
        onClick={() => {
          void onTrackClick(track, index)
        }}
      >
        <div className="track-col track-col-num">
          {isCurrent && isPlaying ? (
            <span className="track-playing-icon">&#9654;</span>
          ) : isCurrentLoading ? (
            <span className="track-loading-icon" title="Buffering track">
              <span className="loading-spinner-small track-loading-spinner" />
            </span>
          ) : (
            <span className="track-number">{track.track_number ?? index + 1}</span>
          )}
        </div>
        <div className="track-col track-col-title">
          <div className="track-title-cell">
            <div className="track-artwork-thumb">
              <AlbumArtwork hash={track.artwork_hash} alt={track.album || track.title} variant="thumbnail" />
            </div>
            {track.source_type === 'subsonic' && (
              <span className="track-source-badge" title={isUnavailable ? 'Subsonic (unavailable)' : 'Subsonic'}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 17h2a4 4 0 0 1 4 4" />
                  <path d="M3 11h4a8 8 0 0 1 8 8" />
                  <circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none" />
                </svg>
                <span>Subsonic</span>
              </span>
            )}
            <span className="track-title">{track.title}</span>
            {isCurrentLoading && (
              <span className="track-loading-status">
                {loadingPercentLabel
                  ? `Buffering ${loadingPercentLabel}`
                  : loadingTrackChunkCount > 0
                    ? `Buffering ${loadingTrackChunkCount} chunks`
                    : 'Buffering...'}
              </span>
            )}
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
            {track.album.trim().length > 0 ? (
              <button
                type="button"
                className="track-album track-album-link"
                onClick={(event) => {
                  event.stopPropagation()
                  void openAlbumInLibrary(track.album, track.artist, track.album_artist)
                }}
                title={`Show album ${track.album}`}
              >
                {track.album}
              </button>
            ) : (
              <span className="track-album">{'\u2014'}</span>
            )}
          </div>
        )}
        {showTracklistBpmKey && (
          <div className="track-col track-col-bpm">
            <span className="track-bpm">{formatBpm(track.bpm)}</span>
          </div>
        )}
        {showTracklistBpmKey && (
          <div className="track-col track-col-key">
            <span className="track-key">{track.musical_key?.trim() || '--'}</span>
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
                className={`track-action-btn ${playlistPopupTrackPath === track.path ? 'track-playlist-trigger-open' : ''}`}
                onClick={(event) => onOpenPlaylistPopup(event, track.path)}
                title="Add to playlist"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
                </svg>
              </button>
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

export default function TrackList({
  tracks,
  queueSeedTracks = tracks,
  showArtist = true,
  showAlbum = true,
  externalScroll = false,
  playlistSourceId = null,
  jumpToTrackRequest = null,
  enableColumnSorting = false,
  sortState = null,
  onSortColumnToggle,
  enableDefaultOrderReset = false,
  onDefaultOrderReset
}: TrackListProps) {
  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const playbackState = usePlayerStore((state) => state.playbackState)
  const remoteLoadProgress = usePlayerStore((state) => state.remoteLoadProgress)
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
  const showTracklistBpmKey = useLibraryStore((state) => state.showTracklistBpmKey)
  const playlists = usePlaylistStore((state) => state.playlists)
  const addToPlaylist = usePlaylistStore((state) => state.addToPlaylist)
  const removeFromPlaylist = usePlaylistStore((state) => state.removeFromPlaylist)
  const getPlaylistsContainingTrack = usePlaylistStore((state) => state.getPlaylistsContainingTrack)
  const openArtistInLibrary = useOpenArtistInLibrary()
  const openAlbumInLibrary = useOpenAlbumInLibrary()

  const [playlistPopup, setPlaylistPopup] = useState<TrackPlaylistPopupState | null>(null)
  const [playlistPopupSearch, setPlaylistPopupSearch] = useState('')
  const [playlistMemberships, setPlaylistMemberships] = useState<Set<number>>(new Set())
  const [isPlaylistMembershipLoading, setIsPlaylistMembershipLoading] = useState(false)
  const [isPlaylistMembershipMutating, setIsPlaylistMembershipMutating] = useState(false)
  const [queueFeedback, setQueueFeedback] = useState<Record<string, true>>({})
  const [listViewportHeight, setListViewportHeight] = useState(0)
  const [trackRowHeight, setTrackRowHeight] = useState(TRACK_ROW_HEIGHT_FALLBACK_PX)

  const queueFeedbackTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const listBodyRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<ListImperativeAPI>(null)
  const playlistPopupRef = useRef<HTMLDivElement | null>(null)
  const playlistPopupTriggerRef = useRef<HTMLButtonElement | null>(null)
  const playlistMembershipRequestIdRef = useRef(0)
  const consumedJumpRequestIdRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      for (const timer of queueFeedbackTimersRef.current.values()) {
        clearTimeout(timer)
      }
      queueFeedbackTimersRef.current.clear()
    }
  }, [])

  useEffect(() => {
    setPlaylistPopup((current) => {
      if (!current) return current
      return tracks.some((track) => track.path === current.trackPath) ? current : null
    })
  }, [tracks])

  useEffect(() => {
    if (!jumpToTrackRequest) return
    if (consumedJumpRequestIdRef.current === jumpToTrackRequest.id) return

    const targetIndex = tracks.findIndex((track) => track.path === jumpToTrackRequest.trackPath)
    if (targetIndex < 0) return

    listRef.current?.scrollToRow({
      index: targetIndex,
      align: 'center',
      behavior: 'smooth'
    })
    consumedJumpRequestIdRef.current = jumpToTrackRequest.id
  }, [jumpToTrackRequest, tracks])

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
  const renderedQueueTracks = useMemo(() => tracks.map(dbTrackToTrack), [tracks])
  const queueSeedQueueTracks = useMemo(() => queueSeedTracks.map(dbTrackToTrack), [queueSeedTracks])
  const queueSeedTrackPathToIndex = useMemo(() => {
    const indexByPath = new Map<string, number>()
    queueSeedTracks.forEach((track, index) => {
      indexByPath.set(track.path, index)
    })
    return indexByPath
  }, [queueSeedTracks])
  const nextQueueIndex = queueIndex >= 0 ? queueIndex + 1 : 0
  const nextQueuedTrackPath = queue[nextQueueIndex]?.path ?? null

  const currentTrackPath = currentTrack?.path ?? null
  const isPlaying = playbackState === 'playing'
  const isLoadingTrack = playbackState === 'loading'
  const loadingTrackPath = remoteLoadProgress?.path ?? (isLoadingTrack ? currentTrackPath : null)
  const loadingTrackPercent = remoteLoadProgress?.percent ?? null
  const loadingTrackChunkCount = remoteLoadProgress?.chunkCount ?? 0
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
    const queueSeedIndex = queueSeedTrackPathToIndex.get(dbTrack.path)
    if (queueSeedIndex !== undefined) {
      setQueue(queueSeedQueueTracks, queueSeedIndex, { sourcePlaylistId: playlistSourceId })
    } else {
      // Fallback to the rendered list if the clicked row path is missing from queue seed tracks.
      setQueue(renderedQueueTracks, index, { sourcePlaylistId: playlistSourceId })
    }

    const result = await window.electronAPI.loadAudioFile(dbTrack.path, { metadataMode: 'none' })
    if (!result) return

    const track: Track = {
      id: dbTrack.path,
      path: dbTrack.path,
      title: result.metadata?.title ?? dbTrack.title,
      artist: result.metadata?.artist ?? dbTrack.artist,
      album: result.metadata?.album ?? dbTrack.album,
      albumArtist: result.metadata?.albumArtist ?? dbTrack.album_artist ?? undefined,
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
      isAtmosJoc: result.metadata?.isAtmosJoc ?? (dbTrack.is_atmos_joc === 1),
      replayGainTrackDb: result.metadata?.replayGainTrackDb ?? dbTrack.replaygain_track_gain_db ?? undefined,
      replayGainAlbumDb: result.metadata?.replayGainAlbumDb ?? dbTrack.replaygain_album_gain_db ?? undefined,
      sourceType: dbTrack.source_type,
      sourceId: dbTrack.source_id ?? undefined,
      sourceTrackId: dbTrack.source_track_id ?? undefined,
      sourcePath: dbTrack.source_path ?? undefined,
      isAvailable: dbTrack.is_available === 1,
      availabilityReason: dbTrack.availability_reason ?? undefined
    }

    const loaded = await loadTrack(track, result.data)
    if (loaded) {
      await play()
    }
  }, [loadTrack, play, playlistSourceId, queueSeedQueueTracks, queueSeedTrackPathToIndex, renderedQueueTracks, setQueue])

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

  const closePlaylistPopup = useCallback(() => {
    playlistMembershipRequestIdRef.current += 1
    setPlaylistPopup(null)
    setPlaylistPopupSearch('')
    setPlaylistMemberships(new Set())
    setIsPlaylistMembershipLoading(false)
    setIsPlaylistMembershipMutating(false)
    playlistPopupTriggerRef.current = null
  }, [])

  const refreshPlaylistMembership = useCallback(async (trackPath: string) => {
    const requestId = playlistMembershipRequestIdRef.current + 1
    playlistMembershipRequestIdRef.current = requestId

    setIsPlaylistMembershipLoading(true)
    try {
      const playlistIds = await getPlaylistsContainingTrack(trackPath)
      if (playlistMembershipRequestIdRef.current !== requestId) return
      setPlaylistMemberships(new Set(playlistIds))
    } finally {
      if (playlistMembershipRequestIdRef.current === requestId) {
        setIsPlaylistMembershipLoading(false)
      }
    }
  }, [getPlaylistsContainingTrack])

  const handleOpenPlaylistPopup = useCallback((event: React.MouseEvent<HTMLButtonElement>, trackPath: string) => {
    event.stopPropagation()

    if (playlistPopup?.trackPath === trackPath) {
      closePlaylistPopup()
      return
    }

    const trigger = event.currentTarget
    const rect = trigger.getBoundingClientRect()

    playlistPopupTriggerRef.current = trigger
    setPlaylistPopupSearch('')
    setPlaylistMemberships(new Set())
    setIsPlaylistMembershipMutating(false)
    setPlaylistPopup({
      trackPath,
      anchor: {
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        height: rect.height
      }
    })
    void refreshPlaylistMembership(trackPath)
  }, [closePlaylistPopup, playlistPopup?.trackPath, refreshPlaylistMembership])

  const handleToggleTrackPlaylistMembership = useCallback(async (event: React.MouseEvent, playlistId: number, trackPath: string) => {
    event.stopPropagation()
    if (isPlaylistMembershipMutating) return

    const isMember = playlistMemberships.has(playlistId)
    setIsPlaylistMembershipMutating(true)
    try {
      if (isMember) {
        await removeFromPlaylist(playlistId, trackPath)
      } else {
        await addToPlaylist(playlistId, [trackPath])
      }

      setPlaylistMemberships((current) => {
        const next = new Set(current)
        if (isMember) {
          next.delete(playlistId)
        } else {
          next.add(playlistId)
        }
        return next
      })
    } finally {
      setIsPlaylistMembershipMutating(false)
    }
  }, [addToPlaylist, isPlaylistMembershipMutating, playlistMemberships, removeFromPlaylist])

  const handleListScroll = useCallback(() => {
    closePlaylistPopup()
  }, [closePlaylistPopup])

  useEffect(() => {
    if (!playlistPopup) return

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (playlistPopupRef.current?.contains(target)) return
      if (playlistPopupTriggerRef.current?.contains(target)) return
      closePlaylistPopup()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closePlaylistPopup()
      }
    }

    const handleResize = () => {
      const trigger = playlistPopupTriggerRef.current
      if (!trigger) {
        closePlaylistPopup()
        return
      }
      const rect = trigger.getBoundingClientRect()
      setPlaylistPopup((current) => {
        if (!current) return current
        return {
          ...current,
          anchor: {
            top: rect.top,
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
            height: rect.height
          }
        }
      })
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleResize)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleResize)
    }
  }, [closePlaylistPopup, playlistPopup])

  const filteredPlaylists = useMemo(() => {
    const query = playlistPopupSearch.trim().toLocaleLowerCase()
    if (!query) return playlists
    return playlists.filter((playlist) => playlist.name.toLocaleLowerCase().includes(query))
  }, [playlistPopupSearch, playlists])

  const playlistPopupStyle = useMemo(() => {
    if (!playlistPopup) return undefined

    const panelWidth = 268
    const gap = 8
    const edgePadding = 10
    const estimatedHeight = 280

    let left = playlistPopup.anchor.right + gap
    if (left + panelWidth > window.innerWidth - edgePadding) {
      left = Math.max(edgePadding, playlistPopup.anchor.left - panelWidth - gap)
    }

    let top = playlistPopup.anchor.top - 8
    const maxTop = Math.max(edgePadding, window.innerHeight - edgePadding - estimatedHeight)
    top = Math.min(Math.max(top, edgePadding), maxTop)

    return {
      top,
      left,
      maxHeight: Math.max(150, window.innerHeight - top - edgePadding)
    }
  }, [playlistPopup])

  const listHeight = listViewportHeight > 0 ? listViewportHeight : trackRowHeight
  const resolvedListHeight = externalScroll
    ? Math.max(trackRowHeight, trackRowHeight * tracks.length)
    : listHeight
  const playlistPopupTrackPath = playlistPopup?.trackPath ?? null
  const isColumnSortingEnabled = enableColumnSorting && typeof onSortColumnToggle === 'function'
  const canResetDefaultOrder = enableDefaultOrderReset && typeof onDefaultOrderReset === 'function'

  const getAriaSort = (key: TrackListSortKey): 'none' | 'ascending' | 'descending' => {
    if (!isColumnSortingEnabled || !sortState || sortState.key !== key) return 'none'
    return sortState.direction === 'asc' ? 'ascending' : 'descending'
  }

  const renderSortableHeader = (key: TrackListSortKey, label: string, className: string): ReactElement => {
    const isActive = Boolean(sortState && sortState.key === key)
    const direction = isActive ? sortState!.direction : 'asc'
    const currentDirectionLabel = isActive ? (direction === 'asc' ? 'ascending' : 'descending') : 'not sorted'
    const nextDirectionLabel = isActive && direction === 'asc' ? 'descending' : 'ascending'

    if (!isColumnSortingEnabled || !onSortColumnToggle) {
      return <div className={`track-col ${className}`}>{label}</div>
    }

    return (
      <div className={`track-col ${className}`} role="columnheader" aria-sort={getAriaSort(key)}>
        <button
          type="button"
          className={`track-col-sort-btn ${isActive ? 'active' : ''}`}
          onClick={() => onSortColumnToggle(key)}
          aria-label={`${label}: ${currentDirectionLabel}. Activate to sort ${nextDirectionLabel}.`}
        >
          <span className="track-col-sort-label">{label}</span>
          <span
            aria-hidden="true"
            className={`track-col-sort-indicator ${isActive ? 'active' : ''} ${direction === 'desc' ? 'desc' : ''}`}
          />
        </button>
      </div>
    )
  }

  const rowProps = useMemo<TrackListRowSharedProps>(() => ({
    tracks,
    showArtist,
    showAlbum,
    showTracklistBpmKey,
    currentTrackPath,
    loadingTrackPath,
    loadingTrackPercent,
    loadingTrackChunkCount,
    currentTrackChannels,
    currentTrackIsAtmosJoc,
    isPlaying,
    isLoadingTrack,
    selectedOutputChannelCount,
    favorites,
    playlistPopupTrackPath,
    queuedTrackPaths,
    nextQueuedTrackPath,
    queueFeedback,
    openArtistInLibrary,
    openAlbumInLibrary,
    formatBpm: formatTrackBpm,
    formatDuration,
    onTrackClick: handleTrackClick,
    onPlayNext: handlePlayNext,
    onAddToQueue: handleAddToQueue,
    onToggleFavorite: handleToggleFavorite,
    onOpenPlaylistPopup: handleOpenPlaylistPopup
  }), [
    tracks,
    showArtist,
    showAlbum,
    showTracklistBpmKey,
    currentTrackPath,
    loadingTrackPath,
    loadingTrackPercent,
    loadingTrackChunkCount,
    currentTrackChannels,
    currentTrackIsAtmosJoc,
    isPlaying,
    isLoadingTrack,
    selectedOutputChannelCount,
    favorites,
    playlistPopupTrackPath,
    queuedTrackPaths,
    nextQueuedTrackPath,
    queueFeedback,
    openArtistInLibrary,
    openAlbumInLibrary,
    formatTrackBpm,
    formatDuration,
    handleTrackClick,
    handlePlayNext,
    handleAddToQueue,
    handleToggleFavorite,
    handleOpenPlaylistPopup
  ])

  if (tracks.length === 0) {
    return (
      <div className="track-list-empty">
        <p>No tracks found</p>
      </div>
    )
  }

  return (
    <div className={`track-list ${externalScroll ? 'track-list-external-scroll' : ''}`}>
      <div className="track-list-header">
        {canResetDefaultOrder ? (
          <div className="track-col track-col-num">
            <button
              type="button"
              className={`track-col-sort-btn track-col-default-sort-btn ${sortState === null ? 'active' : ''}`}
              onClick={() => onDefaultOrderReset()}
              aria-label={sortState === null ? 'Default album order active.' : 'Restore default album order.'}
            >
              <span className="track-col-sort-label">#</span>
            </button>
          </div>
        ) : (
          <div className="track-col track-col-num">#</div>
        )}
        {renderSortableHeader('title', 'Title', 'track-col-title')}
        {showArtist && renderSortableHeader('artist', 'Artist', 'track-col-artist')}
        {showAlbum && renderSortableHeader('album', 'Album', 'track-col-album')}
        {showTracklistBpmKey && renderSortableHeader('bpm', 'BPM', 'track-col-bpm')}
        {showTracklistBpmKey && renderSortableHeader('musical_key', 'Key', 'track-col-key')}
        <div className="track-col track-col-codec">Codec</div>
        {renderSortableHeader('duration', 'Length', 'track-col-duration')}
        <div className="track-col track-col-actions" />
      </div>
      <div className={`track-list-body ${externalScroll ? 'track-list-body-external-scroll' : ''}`} ref={listBodyRef}>
        <List
          className="track-list-virtualized"
          defaultHeight={TRACK_ROW_HEIGHT_FALLBACK_PX * 8}
          listRef={listRef}
          onScroll={externalScroll ? undefined : handleListScroll}
          overscanCount={TRACK_LIST_OVERSCAN_COUNT}
          rowComponent={TrackListRow}
          rowCount={tracks.length}
          rowHeight={trackRowHeight}
          rowProps={rowProps}
          style={{ height: resolvedListHeight, width: '100%' }}
        />
      </div>
      {playlistPopup && (
        <div
          className="track-playlist-popup"
          style={playlistPopupStyle}
          ref={playlistPopupRef}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="track-playlist-popup-search">
            <input
              type="text"
              className="track-playlist-popup-search-input"
              placeholder="Search playlists..."
              value={playlistPopupSearch}
              onChange={(event) => setPlaylistPopupSearch(event.target.value)}
              autoFocus
            />
          </div>
          <div className="track-playlist-popup-list">
            {isPlaylistMembershipLoading ? (
              <div className="track-playlist-popup-empty">Loading...</div>
            ) : filteredPlaylists.length > 0 ? (
              filteredPlaylists.map((playlist) => {
                const isMember = playlistMemberships.has(playlist.id)
                return (
                  <button
                    key={playlist.id}
                    className={`track-playlist-popup-item ${isMember ? 'is-member' : ''}`}
                    onClick={(event) => {
                      void handleToggleTrackPlaylistMembership(event, playlist.id, playlistPopup.trackPath)
                    }}
                    disabled={isPlaylistMembershipMutating}
                  >
                    <span className="track-playlist-popup-item-check">
                      {isMember ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      ) : null}
                    </span>
                    <PlaylistCover
                      hash={playlist.custom_cover_hash ?? playlist.auto_cover_hash}
                      name={playlist.name}
                      className="track-playlist-popup-cover"
                    />
                    <span className="track-playlist-popup-item-name">{playlist.name}</span>
                  </button>
                )
              })
            ) : (
              <div className="track-playlist-popup-empty">No matching playlists</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
