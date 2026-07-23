import { CSSProperties, memo, ReactElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { List, RowComponentProps, type ListImperativeAPI } from 'react-window'
import { usePlayerStore, type PlaybackSourceContext } from '../../stores/playerStore'
import { useLibraryStore } from '../../stores/libraryStore'
import { getNormalPlaylists, usePlaylistStore } from '../../stores/playlistStore'
import { useAudioSettingsStore } from '../../stores/audioSettingsStore'
import { useUIStore, type LibraryTrackRevealRequest, type PlaylistTrackRevealRequest } from '../../stores/uiStore'
import { useLibraryIntegrityStore } from '../../stores/libraryIntegrityStore'
import { useRatingsStore } from '../../stores/ratingsStore'
import TrackRatingControl from '../ratings/TrackRatingControl'
import { useMetadataEditorStore } from '../../stores/metadataEditorStore'
import { useLyricsEditorStore } from '../../stores/lyricsEditorStore'
import { useOpenArtistInLibrary } from '../../hooks/useOpenArtistInLibrary'
import { useOpenAlbumInLibrary } from '../../hooks/useOpenAlbumInLibrary'
import { Track } from '../../types/audio'
import type { TrackSourceType } from '../../../types/subsonic'
import { buildTrackListRows, type TrackListVirtualRow } from './trackListRows'
import { shouldSuppressTrackRowDrag } from './trackDragTarget'
import AlbumArtwork from './AlbumArtwork'
import ArtistNameLinks from './ArtistNameLinks'
import CreatePlaylistModal from '../playlists/CreatePlaylistModal'
import PlaylistCover from '../playlists/PlaylistCover'
import {
  CONTROLLER_VIRTUAL_MOVE_EVENT,
  focusControllerTarget,
  type ControllerVirtualMoveDetail
} from '../../utils/controllerFocus'
import { rankFuzzyMatches } from '../../utils/fuzzySearch'
import { highlightSearchMatch } from '../../utils/searchHighlight'
import {
  clampFixedOverlayPosition,
  viewportPointToAppLayout,
  viewportRectToAppLayout,
  viewportSizeToAppLayout
} from '../../utils/overlayPositioning'

interface DbTrack {
  id: number
  path: string
  album_identity_key: string
  is_new: boolean
  title: string
  artist: string
  artist_names: string[]
  album: string
  album_artist: string | null
  album_artist_names: string[]
  duration: number
  track_number: number | null
  disc_number: number | null
  genre: string | null
  genres: string[]
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
  file_created_at: number | null
  play_count: number
  last_played_at: number | null
  added_at: number
  codec?: string | null
  codec_profile?: string | null
  is_atmos_joc?: number | null
  is_iamf?: number | null
}

export type TrackListSortKey = 'title' | 'artist' | 'album' | 'genre' | 'duration' | 'bpm' | 'musical_key' | 'added' | 'rating' | 'play_count'
export type TrackNumberMode = 'album' | 'context' | 'none'

export interface TrackListSortState {
  key: TrackListSortKey
  direction: 'asc' | 'desc'
}

interface TrackListProps {
  tracks: DbTrack[]
  queueSeedTracks?: DbTrack[]
  queueContextLabel?: string | null
  showArtist?: boolean
  showAlbum?: boolean
  showAddedDate?: boolean
  showNewTrackIndicator?: boolean
  showDiscHeaders?: boolean
  trackNumberMode?: TrackNumberMode
  contextTrackNumbers?: readonly number[]
  trackInstanceKeys?: readonly string[]
  playlistEntryIds?: readonly (number | null)[]
  queueSeedIndexes?: readonly (number | null)[]
  externalScroll?: boolean
  playlistSourceId?: number | null
  onChangeMissingPlaylistAssociation?: (trackPath: string, entryId?: number | null) => void | Promise<void>
  sourceContext?: PlaybackSourceContext | null
  jumpToTrackRequest?: LibraryTrackRevealRequest | PlaylistTrackRevealRequest | null
  onJumpToTrackRequestConsumed?: (requestId: number) => void
  enableColumnSorting?: boolean
  sortState?: TrackListSortState | null
  onSortColumnToggle?: (key: TrackListSortKey) => void
  enableDefaultOrderReset?: boolean
  onDefaultOrderReset?: () => void
  searchQuery?: string
}

interface TrackListRowSharedProps {
  rows: TrackListVirtualRow[]
  tracks: DbTrack[]
  showArtist: boolean
  showAlbum: boolean
  showTracklistBpmKey: boolean
  showTracklistGenre: boolean
  showAddedDate: boolean
  showTracklistPlayCount: boolean
  showNewTrackIndicator: boolean
  ratingsEnabled: boolean
  searchQuery: string
  trackNumberMode: TrackNumberMode
  contextTrackNumbers?: readonly number[]
  trackInstanceKeys?: readonly string[]
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
  openAlbumInLibrary: (
    albumName: string,
    trackArtist: string,
    albumArtist?: string | null,
    albumIdentityKey?: string
  ) => void | Promise<void>
  formatBpm: (bpm: number | null | undefined) => string
  formatAddedDate: (track: Pick<DbTrack, 'source_type' | 'file_created_at' | 'added_at'>) => string
  formatAddedDateTitle: (track: Pick<DbTrack, 'source_type' | 'file_created_at' | 'added_at'>) => string
  formatDuration: (seconds: number) => string
  onTrackClick: (event: React.MouseEvent<HTMLDivElement>, track: DbTrack, index: number) => Promise<void>
  onQueueInsertPointerDown: (event: React.PointerEvent<HTMLDivElement>, track: DbTrack, index: number) => void
  onPlayNext: (event: React.MouseEvent, track: DbTrack) => void
  onAddToQueue: (event: React.MouseEvent, track: DbTrack) => void
  onToggleFavorite: (event: React.MouseEvent, trackPath: string) => void
  onOpenPlaylistPopup: (event: React.MouseEvent<HTMLButtonElement>, track: DbTrack) => void
  onTrackContextMenu: (event: React.MouseEvent<HTMLDivElement>, track: DbTrack, index: number) => void
  onRemoveFromPlaylist: (event: React.MouseEvent, track: DbTrack, index: number) => void
  canRemoveFromPlaylist: boolean
  isRemovingFromPlaylist: boolean
  showQueueInsertAffordance: boolean
  queueInsertArmedTrackPath: string | null
  selectedTrackPaths: Set<string>
}

const TRACK_ROW_HEIGHT_FALLBACK_PX = 48
const TRACK_DISC_HEADER_HEIGHT_FALLBACK_PX = 30
const TRACK_LIST_OVERSCAN_COUNT = 8
const TRACK_SELECTION_DRAG_THRESHOLD_PX = 6
const trackAddedDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'numeric',
  day: 'numeric',
  year: '2-digit'
})

interface TrackPlaylistPopupState {
  trackPaths: string[]
  primaryTrackPath: string
  anchor: {
    top: number
    left: number
    right: number
    bottom: number
    height: number
  }
}

interface TrackPlaylistFeedback {
  kind: 'info' | 'error'
  message: string
}

interface TrackPlaylistCreateState {
  trackPaths: string[]
}

interface TrackContextMenuState {
  track: DbTrack
  tracks: DbTrack[]
  playlistEntryId: number | null
  x: number
  y: number
}

interface TrackSelectionPointerState {
  anchorIndex: number
  pointerId: number
  startX: number
  startY: number
  mode: 'modifier-selection' | 'selected-drag'
  baseSelectedPaths: Set<string>
  activeSelectedPaths: Set<string> | null
}

// Convert DbTrack to Track
function dbTrackToTrack(dbTrack: DbTrack): Track {
  return {
    id: dbTrack.path,
    path: dbTrack.path,
    title: dbTrack.title,
    artist: dbTrack.artist,
    artistNames: dbTrack.artist_names,
    album: dbTrack.album,
    albumArtist: dbTrack.album_artist ?? undefined,
    albumArtistNames: dbTrack.album_artist_names,
    albumIdentityKey: dbTrack.album_identity_key,
    duration: dbTrack.duration,
    genre: dbTrack.genre ?? undefined,
    genres: dbTrack.genres,
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

function resolveContextTrackNumber(
  contextTrackNumbers: readonly number[] | undefined,
  index: number
): number {
  const contextualNumber = contextTrackNumbers?.[index]
  if (typeof contextualNumber === 'number' && Number.isFinite(contextualNumber) && contextualNumber > 0) {
    return Math.trunc(contextualNumber)
  }

  return index + 1
}

function resolveCssPixelVariablePx(element: HTMLElement | null, variableName: string, fallback: number): number {
  if (!element) return fallback

  const cssValue = getComputedStyle(element).getPropertyValue(variableName).trim()
  const parsed = Number.parseFloat(cssValue)
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed)
  }

  return fallback
}

function resolveTrackRowHeightPx(element: HTMLElement | null): number {
  return resolveCssPixelVariablePx(element, '--track-row-height', TRACK_ROW_HEIGHT_FALLBACK_PX)
}

function resolveTrackDiscHeaderHeightPx(element: HTMLElement | null): number {
  return resolveCssPixelVariablePx(element, '--track-disc-header-height', TRACK_DISC_HEADER_HEIGHT_FALLBACK_PX)
}

function getTrackListVirtualRowHeightPx(
  row: TrackListVirtualRow | undefined,
  trackRowHeight: number,
  discHeaderHeight: number
): number {
  if (row?.kind === 'disc-header') return discHeaderHeight
  return trackRowHeight
}

function formatTrackBpm(bpm: number | null | undefined): string {
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) return '--'

  const rounded = Math.round(bpm * 10) / 10
  if (!Number.isFinite(rounded) || rounded <= 0) return '--'
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function resolveEffectiveAddedAt(track: Pick<DbTrack, 'source_type' | 'file_created_at' | 'added_at'>): number {
  if (track.source_type === 'local' && typeof track.file_created_at === 'number' && Number.isFinite(track.file_created_at) && track.file_created_at > 0) {
    return track.file_created_at
  }
  return track.added_at
}

function formatTrackAddedDate(track: Pick<DbTrack, 'source_type' | 'file_created_at' | 'added_at'>): string {
  const timestamp = resolveEffectiveAddedAt(track)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '--'

  try {
    return trackAddedDateFormatter.format(new Date(timestamp))
  } catch {
    return '--'
  }
}

function formatTrackAddedDateTitle(track: Pick<DbTrack, 'source_type' | 'file_created_at' | 'added_at'>): string {
  const timestamp = resolveEffectiveAddedAt(track)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Added date unavailable'

  try {
    return new Date(timestamp).toLocaleString()
  } catch {
    return 'Added date unavailable'
  }
}

function isUnavailableRemoteTrack(track: Pick<DbTrack, 'source_type' | 'is_available'>): boolean {
  return track.source_type !== 'local' && track.is_available !== 1
}

function isMissingPlaylistEntryTrack(track: Pick<DbTrack, 'availability_reason'>): boolean {
  return track.availability_reason === 'missing_playlist_entry'
}

function MissingPlaylistEntryIcon() {
  return (
    <svg className="track-missing-playlist-icon" width="14" height="14" viewBox="0 0 576 512" fill="currentColor" aria-hidden="true">
      {/* Font Awesome Free file-circle-exclamation: https://fontawesome.com/icons/classic/solid/file-circle-exclamation */}
      <path d="M0 64C0 28.7 28.7 0 64 0h160v128c0 17.7 14.3 32 32 32h128v38.6C310.1 219.5 256 287.4 256 368c0 59.1 29.1 111.3 73.7 143.3-3.2.5-6.4.7-9.7.7H64c-35.3 0-64-28.7-64-64V64zm384 64H256V0l128 128zm48 96a144 144 0 1 1 0 288 144 144 0 1 1 0-288zm0 240a24 24 0 1 0 0-48 24 24 0 1 0 0 48zm0-192c-8.8 0-16 7.2-16 16v80c0 8.8 7.2 16 16 16s16-7.2 16-16v-80c0-8.8-7.2-16-16-16z" />
    </svg>
  )
}

function isTrackSelectionModifierActive(event: Pick<MouseEvent | PointerEvent | React.MouseEvent | React.PointerEvent, 'ctrlKey' | 'metaKey'>): boolean {
  return event.ctrlKey || event.metaKey
}

function isTrackSelectionPreservingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false

  return Boolean(target.closest(
    '.track-row, .track-context-menu, .track-playlist-popup, .metadata-editor-panel, .lyrics-editor-panel, .modal-overlay, .modal-content'
  ))
}

function areTrackPathSetsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left === right) return true
  if (left.size !== right.size) return false
  for (const path of left) {
    if (!right.has(path)) return false
  }
  return true
}

function addTrackRangeToSelection(
  baseSelectedPaths: Set<string>,
  tracks: Track[],
  anchorIndex: number,
  hoverIndex: number
): Set<string> {
  const nextSelectedPaths = new Set(baseSelectedPaths)
  const startIndex = Math.max(0, Math.min(anchorIndex, hoverIndex))
  const endIndex = Math.min(tracks.length - 1, Math.max(anchorIndex, hoverIndex))

  for (let index = startIndex; index <= endIndex; index += 1) {
    const track = tracks[index]
    if (track) {
      nextSelectedPaths.add(track.path)
    }
  }

  return nextSelectedPaths
}

function resolveSelectedTracksInOrder(selectedTrackPaths: Set<string>, tracks: Track[]): Track[] {
  if (selectedTrackPaths.size === 0) return []
  return tracks.filter((track) => selectedTrackPaths.has(track.path))
}

function TrackListRowRenderer({
  ariaAttributes,
  index,
  style,
  rows,
  tracks,
  showArtist,
  showAlbum,
  showTracklistBpmKey,
  showTracklistGenre,
  showAddedDate,
  showTracklistPlayCount,
  showNewTrackIndicator,
  ratingsEnabled,
  searchQuery,
  trackNumberMode,
  contextTrackNumbers,
  trackInstanceKeys,
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
  formatAddedDate,
  formatAddedDateTitle,
  formatDuration,
  onTrackClick,
  onQueueInsertPointerDown,
  onPlayNext,
  onAddToQueue,
  onToggleFavorite,
  onOpenPlaylistPopup,
  onTrackContextMenu,
  onRemoveFromPlaylist,
  canRemoveFromPlaylist,
  isRemovingFromPlaylist,
  showQueueInsertAffordance,
  queueInsertArmedTrackPath,
  selectedTrackPaths
}: RowComponentProps<TrackListRowSharedProps>): ReactElement | null {
  const row = rows[index]
  if (!row) return null

  if (row.kind === 'disc-header') {
    return (
      <div className="track-list-item track-list-disc-header-item" style={style as CSSProperties} {...ariaAttributes}>
        <div className="track-disc-header" role="separator" aria-label={`Disc ${row.discNumber}`}>
          <span className="track-disc-header-label">Disc {row.discNumber}</span>
          <span className="track-disc-header-rule" aria-hidden="true" />
        </div>
      </div>
    )
  }

  const trackIndex = row.trackIndex
  const track = tracks[trackIndex]
  if (!track) return null

  const isCurrent = currentTrackPath === track.path
  const isCurrentLoading = isCurrent
    && isLoadingTrack
    && track.source_type !== 'local'
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
  const showEclipsaBadge = Boolean(track.is_iamf === 1 || rowCodec === 'iamf')
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

  const isMissingPlaylistEntry = isMissingPlaylistEntryTrack(track)
  const isUnavailable = isUnavailableRemoteTrack(track) || isMissingPlaylistEntry
  const sourceLabel = track.source_type === 'jellyfin'
    ? 'Jellyfin'
    : track.source_type === 'subsonic'
      ? 'Subsonic'
      : null
  const loadingPercentLabel = typeof loadingTrackPercent === 'number' && Number.isFinite(loadingTrackPercent)
    ? `${Math.round(Math.max(0, Math.min(1, loadingTrackPercent)) * 100)}%`
    : null
  const isQueueInsertArmed = queueInsertArmedTrackPath === track.path
  const isQueueInsertSelected = selectedTrackPaths.has(track.path)
  const displayedTrackNumber = trackNumberMode === 'none'
    ? null
    : trackNumberMode === 'context'
      ? resolveContextTrackNumber(contextTrackNumbers, trackIndex)
      : track.track_number ?? trackIndex + 1
  const trackInstanceKey = trackInstanceKeys?.[trackIndex] ?? track.path

  return (
    <div className="track-list-item" style={style as CSSProperties} {...ariaAttributes}>
      <div
        className={`track-row ${isCurrent ? 'track-row-active' : ''} ${isCurrentLoading ? 'track-row-loading' : ''} ${
          isUnavailable ? 'track-row-unavailable' : ''
        } ${isMissingPlaylistEntry ? 'track-row-missing-playlist-entry' : ''} ${
          canRemoveFromPlaylist ? 'track-row-playlist-removable' : ''} ${
          showQueueInsertAffordance && !isMissingPlaylistEntry ? 'track-row-queue-droppable' : ''} ${
          isQueueInsertSelected ? 'track-row-queue-selected' : ''
        } ${isQueueInsertArmed ? 'track-row-queue-armed' : ''}`}
        data-track-index={trackIndex}
        data-controller-focusable="true"
        data-controller-context={isMissingPlaylistEntry && !canRemoveFromPlaylist ? undefined : 'true'}
        data-controller-key={`track:${trackInstanceKey}`}
        data-controller-index={trackIndex}
        tabIndex={-1}
        role="button"
        aria-label={`${track.title} by ${track.artist}`}
        onDragStart={showQueueInsertAffordance ? (event) => event.preventDefault() : undefined}
        onPointerDown={isMissingPlaylistEntry ? undefined : (event) => onQueueInsertPointerDown(event, track, trackIndex)}
        onContextMenu={isMissingPlaylistEntry && !canRemoveFromPlaylist ? undefined : (event) => onTrackContextMenu(event, track, trackIndex)}
        onClick={(event) => {
          if (isMissingPlaylistEntry) return
          void onTrackClick(event, track, trackIndex)
        }}
      >
        <div className="track-col track-col-num">
          {showNewTrackIndicator && track.is_new && (
            <span className="track-new-indicator" title="Added in latest library sync" aria-hidden="true" />
          )}
          {isCurrent && isPlaying ? (
            <span className="track-playing-icon">&#9654;</span>
          ) : isCurrentLoading ? (
            <span className="track-loading-icon" title="Buffering track">
              <span className="loading-spinner-small track-loading-spinner" />
            </span>
          ) : displayedTrackNumber === null ? (
            null
          ) : (
            <span className="track-number">{displayedTrackNumber}</span>
          )}
        </div>
        <div className="track-col track-col-title">
          <div className="track-title-cell">
            <div className="track-artwork-thumb">
              {isMissingPlaylistEntry ? (
                <MissingPlaylistEntryIcon />
              ) : (
                <AlbumArtwork hash={track.artwork_hash} alt={track.album || track.title} variant="thumbnail" />
              )}
            </div>
            {sourceLabel && (
              <span className="track-source-badge" title={isUnavailable ? `${sourceLabel} (unavailable)` : sourceLabel}>
                {track.source_type === 'jellyfin' ? (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
                    <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
                  </svg>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 17h2a4 4 0 0 1 4 4" />
                    <path d="M3 11h4a8 8 0 0 1 8 8" />
                    <circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none" />
                  </svg>
                )}
                <span>{sourceLabel}</span>
              </span>
            )}
            <span className="track-title">{highlightSearchMatch(track.title, searchQuery)}</span>
            {isMissingPlaylistEntry && (
              <span className="track-missing-playlist-label">Missing</span>
            )}
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
            {showEclipsaBadge && (
              <span className="track-channel-badge track-channel-badge-eclipsa" title="Eclipsa Audio (IAMF) source, decoded to 7.1.4">
                <span>ECLIPSA</span>
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
            {isMissingPlaylistEntry ? (
              <span className="track-artist">{track.artist}</span>
            ) : (
              <ArtistNameLinks
                artistText={track.artist}
                artistNames={track.artist_names}
                browseArtistText={track.album_artist}
                browseArtistNames={track.album_artist_names}
                onArtistClick={openArtistInLibrary}
                className="track-artist"
                linkClassName="artist-name-link-inline"
                stopPropagation
              />
            )}
          </div>
        )}
        {showAlbum && (
          <div className="track-col track-col-album">
            {isMissingPlaylistEntry && track.album.trim().length > 0 ? (
              <span className="track-album">{track.album}</span>
            ) : track.album.trim().length > 0 ? (
              <button
                type="button"
                className="track-album track-album-link"
                onClick={(event) => {
                  event.stopPropagation()
                  void openAlbumInLibrary(track.album, track.artist, track.album_artist, track.album_identity_key)
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
        {showTracklistGenre && (
          <div className="track-col track-col-genre">
            <span className="track-genre" title={track.genre?.trim() || 'Genre unavailable'}>
              {track.genre?.trim() || '--'}
            </span>
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
        {ratingsEnabled && (
          <div className="track-col track-col-rating">
            {!isMissingPlaylistEntry && <TrackRatingControl trackPaths={[track.path]} size="sm" />}
          </div>
        )}
        <div className="track-col track-col-codec">
          <span className="track-codec">{isMissingPlaylistEntry ? 'MISSING' : track.format ? track.format.toUpperCase() : '\u2014'}</span>
        </div>
        {showAddedDate && (
          <div className="track-col track-col-added">
            <span className="track-added" title={formatAddedDateTitle(track)}>
              {formatAddedDate(track)}
            </span>
          </div>
        )}
        {showTracklistPlayCount && (
          <div className="track-col track-col-plays">
            <span className="track-plays">{isMissingPlaylistEntry ? '--' : track.play_count}</span>
          </div>
        )}
        <div className="track-col track-col-duration">
          <span className="track-duration">{isMissingPlaylistEntry ? '--:--' : formatDuration(track.duration)}</span>
        </div>
        <div className="track-col track-col-actions">
          {(!isMissingPlaylistEntry || canRemoveFromPlaylist) && <div className="track-actions">
            {!isMissingPlaylistEntry && (
              <>
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
                    onClick={(event) => onOpenPlaylistPopup(event, track)}
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
              </>
            )}
            {canRemoveFromPlaylist && (
              <button
                className="track-action-btn track-action-btn-danger"
                onClick={(event) => onRemoveFromPlaylist(event, track, trackIndex)}
                title="Remove from playlist"
                disabled={isRemovingFromPlaylist}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 7h14" />
                  <path d="M9 7V5h6v2" />
                  <path d="M8 10v9h8v-9" />
                </svg>
              </button>
            )}
          </div>}
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
  queueContextLabel = null,
  showArtist = true,
  showAlbum = true,
  showAddedDate = false,
  showNewTrackIndicator = false,
  showDiscHeaders = false,
  trackNumberMode = 'album',
  contextTrackNumbers,
  trackInstanceKeys,
  playlistEntryIds,
  queueSeedIndexes,
  externalScroll = false,
  playlistSourceId = null,
  onChangeMissingPlaylistAssociation,
  sourceContext = null,
  jumpToTrackRequest = null,
  onJumpToTrackRequestConsumed,
  enableColumnSorting = false,
  sortState = null,
  onSortColumnToggle,
  enableDefaultOrderReset = false,
  onDefaultOrderReset,
  searchQuery = ''
}: TrackListProps) {
  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const playbackState = usePlayerStore((state) => state.playbackState)
  const remoteLoadProgress = usePlayerStore((state) => state.remoteLoadProgress)
  const queueItems = usePlayerStore((state) => state.queueItems)
  const upcomingQueueIds = usePlayerStore((state) => state.upcomingQueueIds)
  const startPlaybackContextByPaths = usePlayerStore((state) => state.startPlaybackContextByPaths)
  const enqueueTrackPaths = usePlayerStore((state) => state.enqueueTrackPaths)
  const selectedOutputChannelCount = useAudioSettingsStore((state) => state.selectedOutputChannelCount)
  const uiScalePercent = useUIStore((state) => state.uiScalePercent)
  const trackDrag = useUIStore((state) => state.trackDrag)
  const startTrackDrag = useUIStore((state) => state.startTrackDrag)
  const setTrackDragTracks = useUIStore((state) => state.setTrackDragTracks)
  const updateTrackDragPointer = useUIStore((state) => state.updateTrackDragPointer)
  const clearTrackDrag = useUIStore((state) => state.clearTrackDrag)
  const openSidebarPlaylistCreateRequest = useUIStore((state) => state.openSidebarPlaylistCreateRequest)
  const openSignalShare = useUIStore((state) => state.openSignalShare)
  const favorites = useLibraryStore((state) => state.favorites)
  const toggleFavorite = useLibraryStore((state) => state.toggleFavorite)
  const showTracklistBpmKey = useLibraryStore((state) => state.showTracklistBpmKey)
  const showTracklistGenre = useLibraryStore((state) => state.showTracklistGenre)
  const showTracklistPlayCount = useLibraryStore((state) => state.showTracklistPlayCount)
  const ratingsEnabled = useRatingsStore((state) => state.enabled)
  const ratings = useRatingsStore((state) => state.ratings)
  const setTrackRating = useRatingsStore((state) => state.setTrackRating)
  const playlists = usePlaylistStore((state) => state.playlists)
  const addToPlaylist = usePlaylistStore((state) => state.addToPlaylist)
  const createPlaylistWithOptions = usePlaylistStore((state) => state.createPlaylistWithOptions)
  const removeFromPlaylist = usePlaylistStore((state) => state.removeFromPlaylist)
  const removePlaylistEntry = usePlaylistStore((state) => state.removePlaylistEntry)
  const getPlaylistsContainingTracks = usePlaylistStore((state) => state.getPlaylistsContainingTracks)
  const openArtistInLibrary = useOpenArtistInLibrary()
  const openAlbumInLibrary = useOpenAlbumInLibrary()
  const integrityEnabled = useLibraryIntegrityStore((state) => state.enabled)
  const checkTracksIntegrity = useLibraryIntegrityStore((state) => state.checkTracks)
  const integrityBusyPaths = useLibraryIntegrityStore((state) => state.singleTrackBusyPaths)
  const openMetadataEditor = useMetadataEditorStore((state) => state.openPanel)
  const closeMetadataEditor = useMetadataEditorStore((state) => state.closePanel)
  const openLyricsEditor = useLyricsEditorStore((state) => state.openPanel)
  const closeLyricsEditor = useLyricsEditorStore((state) => state.closePanel)

  const [playlistPopup, setPlaylistPopup] = useState<TrackPlaylistPopupState | null>(null)
  const [trackContextMenu, setTrackContextMenu] = useState<TrackContextMenuState | null>(null)
  const [playlistPopupSearch, setPlaylistPopupSearch] = useState('')
  const [playlistPopupFeedback, setPlaylistPopupFeedback] = useState<TrackPlaylistFeedback | null>(null)
  const [playlistMembershipCounts, setPlaylistMembershipCounts] = useState<Record<number, number>>({})
  const [isPlaylistMembershipLoading, setIsPlaylistMembershipLoading] = useState(false)
  const [isPlaylistMembershipMutating, setIsPlaylistMembershipMutating] = useState(false)
  const [createPlaylistTarget, setCreatePlaylistTarget] = useState<TrackPlaylistCreateState | null>(null)
  const [queueFeedback, setQueueFeedback] = useState<Record<string, true>>({})
  const [queueInsertArmedTrackPath, setQueueInsertArmedTrackPath] = useState<string | null>(null)
  const [selectedTrackPaths, setSelectedTrackPaths] = useState<Set<string>>(new Set())
  const [isQueueInsertDragOwner, setIsQueueInsertDragOwner] = useState(false)
  const [isRemovingFromPlaylist, setIsRemovingFromPlaylist] = useState(false)
  const [listViewportHeight, setListViewportHeight] = useState(0)
  const [trackRowHeight, setTrackRowHeight] = useState(TRACK_ROW_HEIGHT_FALLBACK_PX)
  const [discHeaderHeight, setDiscHeaderHeight] = useState(TRACK_DISC_HEADER_HEIGHT_FALLBACK_PX)

  const queueFeedbackTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const isQueueInsertDragOwnerRef = useRef(false)
  const queueInsertPointerCleanupRef = useRef<(() => void) | null>(null)
  const queueInsertPointerStateRef = useRef<TrackSelectionPointerState | null>(null)
  const suppressQueueInsertClickRef = useRef(false)
  const listBodyRef = useRef<HTMLDivElement | null>(null)
  const controllerGroupRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<ListImperativeAPI>(null)
  const playlistPopupRef = useRef<HTMLDivElement | null>(null)
  const playlistPopupTriggerRef = useRef<HTMLButtonElement | null>(null)
  const playlistMembershipRequestIdRef = useRef(0)
  const consumedJumpRequestIdRef = useRef<number | null>(null)

  const virtualRows = useMemo(
    () => buildTrackListRows(tracks, showDiscHeaders),
    [showDiscHeaders, tracks]
  )
  const virtualRowIndexByTrackPath = useMemo(() => {
    const indexByPath = new Map<string, number>()
    virtualRows.forEach((row, virtualIndex) => {
      if (row.kind !== 'track') return
      const track = tracks[row.trackIndex]
      if (track) {
        indexByPath.set(track.path, virtualIndex)
      }
    })
    return indexByPath
  }, [tracks, virtualRows])

  useEffect(() => {
    const group = controllerGroupRef.current
    if (!group) return

    let frameId = 0
    const handleVirtualMove = (rawEvent: Event): void => {
      const event = rawEvent as CustomEvent<ControllerVirtualMoveDetail>
      const delta = event.detail.direction === 'up' ? -1 : 1
      const nextTrackIndex = event.detail.currentIndex + delta
      if (nextTrackIndex < 0 || nextTrackIndex >= tracks.length) return
      const nextTrack = tracks[nextTrackIndex]
      const targetVirtualIndex = nextTrack
        ? virtualRowIndexByTrackPath.get(nextTrack.path)
        : undefined
      if (targetVirtualIndex === undefined) return
      event.preventDefault()

      if (!externalScroll) {
        listRef.current?.scrollToRow({
          index: targetVirtualIndex,
          align: 'center',
          behavior: 'auto'
        })
      }

      let attempts = 8
      const focusMountedRow = (): void => {
        const row = listBodyRef.current?.querySelector<HTMLElement>(
          `.track-row[data-track-index="${nextTrackIndex}"]`
        )
        if (row) {
          focusControllerTarget(row)
          return
        }
        attempts -= 1
        if (attempts > 0) frameId = window.requestAnimationFrame(focusMountedRow)
      }
      frameId = window.requestAnimationFrame(focusMountedRow)
    }

    group.addEventListener(CONTROLLER_VIRTUAL_MOVE_EVENT, handleVirtualMove)
    return () => {
      window.cancelAnimationFrame(frameId)
      group.removeEventListener(CONTROLLER_VIRTUAL_MOVE_EVENT, handleVirtualMove)
    }
  }, [externalScroll, tracks, virtualRowIndexByTrackPath])

  const clearQueueInsertPointerListeners = useCallback(() => {
    queueInsertPointerCleanupRef.current?.()
    queueInsertPointerCleanupRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      for (const timer of queueFeedbackTimersRef.current.values()) {
        clearTimeout(timer)
      }
      queueFeedbackTimersRef.current.clear()
      clearQueueInsertPointerListeners()
      useUIStore.getState().clearTrackDrag()
    }
  }, [clearQueueInsertPointerListeners])

  useEffect(() => {
    if (trackDrag) return
    setQueueInsertArmedTrackPath(null)
    setIsQueueInsertDragOwner(false)
    isQueueInsertDragOwnerRef.current = false
  }, [trackDrag])

  useEffect(() => {
    setPlaylistPopup((current) => {
      if (!current) return current
      const visiblePaths = new Set(tracks.map((track) => track.path))
      return current.trackPaths.some((trackPath) => visiblePaths.has(trackPath)) ? current : null
    })
  }, [tracks])

  useEffect(() => {
    if (!jumpToTrackRequest) return
    if (consumedJumpRequestIdRef.current === jumpToTrackRequest.id) return

    const targetTrackIndex = tracks.findIndex((track) => track.path === jumpToTrackRequest.trackPath)
    if (targetTrackIndex < 0) return

    const targetVirtualIndex = virtualRowIndexByTrackPath.get(jumpToTrackRequest.trackPath)
    if (targetVirtualIndex === undefined) return

    let canceled = false
    const markRequestConsumed = () => {
      consumedJumpRequestIdRef.current = jumpToTrackRequest.id
      onJumpToTrackRequestConsumed?.(jumpToTrackRequest.id)
    }

    let frameId = 0
    let remainingAttempts = 6

    const scheduleRetry = () => {
      if (canceled || remainingAttempts <= 0) return
      remainingAttempts -= 1
      frameId = window.requestAnimationFrame(scrollToTarget)
    }

    const scrollToTarget = () => {
      if (canceled) return
      if (externalScroll) {
        const rowElement = listBodyRef.current?.querySelector<HTMLElement>(`.track-row[data-track-index="${targetTrackIndex}"]`)
        if (!rowElement) {
          scheduleRetry()
          return
        }

        rowElement.scrollIntoView({
          block: 'center',
          inline: 'nearest',
          behavior: 'smooth'
        })
        markRequestConsumed()
        return
      }

      if (!listRef.current) {
        scheduleRetry()
        return
      }

      listRef.current.scrollToRow({
        index: targetVirtualIndex,
        align: 'center',
        behavior: 'smooth'
      })
      markRequestConsumed()
    }

    frameId = window.requestAnimationFrame(scrollToTarget)
    return () => {
      canceled = true
      window.cancelAnimationFrame(frameId)
    }
  }, [
    externalScroll,
    jumpToTrackRequest,
    onJumpToTrackRequestConsumed,
    tracks,
    virtualRowIndexByTrackPath,
    listViewportHeight,
    trackRowHeight,
    discHeaderHeight
  ])

  useLayoutEffect(() => {
    const element = listBodyRef.current
    if (!element) return

    const updateMeasurements = () => {
      const nextHeight = Math.max(0, Math.round(element.clientHeight))
      const nextRowHeight = resolveTrackRowHeightPx(element)
      const nextDiscHeaderHeight = resolveTrackDiscHeaderHeightPx(element)

      setListViewportHeight((previous) => (previous === nextHeight ? previous : nextHeight))
      setTrackRowHeight((previous) => (previous === nextRowHeight ? previous : nextRowHeight))
      setDiscHeaderHeight((previous) => (previous === nextDiscHeaderHeight ? previous : nextDiscHeaderHeight))
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

  const manualUpcomingItems = useMemo(() => {
    const itemById = new Map(queueItems.map((item) => [item.queueId, item]))
    return upcomingQueueIds
      .map((queueId) => itemById.get(queueId))
      .filter((item) => item?.origin === 'manual')
  }, [queueItems, upcomingQueueIds])
  const queuedTrackPaths = useMemo(
    () => new Set(manualUpcomingItems.map((item) => item!.entry.path)),
    [manualUpcomingItems]
  )
  const renderedQueueTracks = useMemo(() => tracks.map(dbTrackToTrack), [tracks])
  const renderedQueueTrackPaths = useMemo(() => tracks.map((track) => track.path), [tracks])
  const selectedQueueTracks = useMemo(
    () => resolveSelectedTracksInOrder(selectedTrackPaths, renderedQueueTracks),
    [renderedQueueTracks, selectedTrackPaths]
  )
  const selectedDbTracks = useMemo(
    () => tracks.filter((track) => selectedTrackPaths.has(track.path)),
    [selectedTrackPaths, tracks]
  )
  const queueSeedTrackPaths = useMemo(() => queueSeedTracks.map((track) => track.path), [queueSeedTracks])
  const queueSeedTrackPathToIndex = useMemo(() => {
    const indexByPath = new Map<string, number>()
    queueSeedTracks.forEach((track, index) => {
      indexByPath.set(track.path, index)
    })
    return indexByPath
  }, [queueSeedTracks])
  const nextQueuedTrackPath = manualUpcomingItems[0]?.entry.path ?? null

  const canRemoveFromPlaylist = playlistSourceId !== null && playlistSourceId > 0
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

  const resolveActionTracks = useCallback((dbTrack: DbTrack): DbTrack[] => {
    if (selectedTrackPaths.has(dbTrack.path) && selectedDbTracks.length > 0) {
      return selectedDbTracks
    }
    return [dbTrack]
  }, [selectedDbTracks, selectedTrackPaths])

  const resolveActionTrackPaths = useCallback((dbTrack: DbTrack): string[] => (
    resolveActionTracks(dbTrack).map((track) => track.path)
  ), [resolveActionTracks])

  useEffect(() => {
    const validTrackPaths = new Set(renderedQueueTrackPaths)
    setSelectedTrackPaths((current) => {
      if (current.size === 0) return current

      const next = new Set<string>()
      for (const path of current) {
        if (validTrackPaths.has(path)) {
          next.add(path)
        }
      }

      return areTrackPathSetsEqual(current, next) ? current : next
    })
  }, [renderedQueueTrackPaths])

  useEffect(() => {
    if (selectedTrackPaths.size === 0) return

    const handlePointerDown = (event: PointerEvent) => {
      if (isTrackSelectionPreservingTarget(event.target)) return
      setSelectedTrackPaths(new Set())
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setSelectedTrackPaths(new Set())
      if (isQueueInsertDragOwnerRef.current) {
        clearQueueInsertPointerListeners()
        clearTrackDrag()
        setQueueInsertArmedTrackPath(null)
        setIsQueueInsertDragOwner(false)
        isQueueInsertDragOwnerRef.current = false
        queueInsertPointerStateRef.current = null
      }
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [clearQueueInsertPointerListeners, clearTrackDrag, selectedTrackPaths.size])

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

  const setQueueActionFeedbackForPaths = useCallback((action: 'queue' | 'next', trackPaths: string[]) => {
    for (const trackPath of trackPaths) {
      setQueueActionFeedback(action, trackPath)
    }
  }, [setQueueActionFeedback])

  const formatDuration = useCallback((seconds: number): string => {
    if (!seconds || !isFinite(seconds)) return '--:--'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }, [])

  const handleTrackClick = useCallback(async (event: React.MouseEvent<HTMLDivElement>, dbTrack: DbTrack, index: number) => {
    if (suppressQueueInsertClickRef.current) {
      suppressQueueInsertClickRef.current = false
      return
    }

    if (isTrackSelectionModifierActive(event)) {
      event.preventDefault()
      setSelectedTrackPaths((current) => {
        const next = new Set(current)
        if (next.has(dbTrack.path)) {
          next.delete(dbTrack.path)
        } else {
          next.add(dbTrack.path)
        }
        return areTrackPathSetsEqual(current, next) ? current : next
      })
      return
    }

    if (selectedTrackPaths.size > 0) {
      setSelectedTrackPaths(new Set())
    }

    const occurrenceQueueSeedIndex = queueSeedIndexes?.[index]
    const queueSeedIndex = typeof occurrenceQueueSeedIndex === 'number'
      ? occurrenceQueueSeedIndex
      : queueSeedTrackPathToIndex.get(dbTrack.path)
    if (queueSeedIndex === undefined) {
      await startPlaybackContextByPaths(renderedQueueTrackPaths, index, {
        sourcePlaylistId: playlistSourceId,
        sourceContext,
        contextLabel: queueContextLabel
      })
      return
    }

    await startPlaybackContextByPaths(queueSeedTrackPaths, queueSeedIndex, {
      sourcePlaylistId: playlistSourceId,
      sourceContext,
      contextLabel: queueContextLabel
    })
  }, [
    playlistSourceId,
    sourceContext,
    queueSeedTrackPaths,
    queueSeedTrackPathToIndex,
    queueSeedIndexes,
    queueContextLabel,
    renderedQueueTrackPaths,
    selectedTrackPaths.size,
    startPlaybackContextByPaths
  ])

  const handlePlayNext = useCallback((event: React.MouseEvent, dbTrack: DbTrack) => {
    event.stopPropagation()
    const trackPaths = resolveActionTrackPaths(dbTrack)
    void enqueueTrackPaths(trackPaths, 'next')
    setQueueActionFeedbackForPaths('next', trackPaths)
  }, [enqueueTrackPaths, resolveActionTrackPaths, setQueueActionFeedbackForPaths])

  const handleAddToQueue = useCallback((event: React.MouseEvent, dbTrack: DbTrack) => {
    event.stopPropagation()
    const trackPaths = resolveActionTrackPaths(dbTrack)
    void enqueueTrackPaths(trackPaths, 'end')
    setQueueActionFeedbackForPaths('queue', trackPaths)
  }, [enqueueTrackPaths, resolveActionTrackPaths, setQueueActionFeedbackForPaths])

  const resolveQueueInsertHoverIndex = useCallback((clientX: number, clientY: number): number | null => {
    const target = document.elementFromPoint(clientX, clientY)
    if (!(target instanceof Element)) return null

    const rowElement = target.closest('.track-row[data-track-index]')
    if (!(rowElement instanceof HTMLElement)) return null
    if (listBodyRef.current && !listBodyRef.current.contains(rowElement)) return null

    const rawIndex = rowElement.dataset.trackIndex
    if (rawIndex == null) return null

    const parsedIndex = Number.parseInt(rawIndex, 10)
    if (!Number.isFinite(parsedIndex) || parsedIndex < 0 || parsedIndex >= renderedQueueTracks.length) {
      return null
    }
    return parsedIndex
  }, [renderedQueueTracks.length])

  const cleanupQueueInsertPointerState = useCallback(() => {
    queueInsertPointerStateRef.current = null
    setQueueInsertArmedTrackPath(null)
  }, [])

  const handleQueueInsertPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>, dbTrack: DbTrack, index: number) => {
    if (event.button !== 0) return

    const target = event.target instanceof Element ? event.target : null
    if (shouldSuppressTrackRowDrag(target, event.currentTarget)) {
      return
    }

    const hasSelectionModifier = isTrackSelectionModifierActive(event)
    const isTrackSelected = selectedTrackPaths.has(dbTrack.path)
    if (!hasSelectionModifier && !isTrackSelected) {
      return
    }

    const track = dbTrackToTrack(dbTrack)
    clearQueueInsertPointerListeners()
    cleanupQueueInsertPointerState()

    queueInsertPointerStateRef.current = {
      anchorIndex: index,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      mode: hasSelectionModifier ? 'modifier-selection' : 'selected-drag',
      baseSelectedPaths: new Set(selectedTrackPaths),
      activeSelectedPaths: null
    }

    const beginQueueInsertDrag = (tracksForDrag: Track[], pointerX: number, pointerY: number) => {
      if (tracksForDrag.length === 0) return false
      setQueueInsertArmedTrackPath(track.path)
      setIsQueueInsertDragOwner(true)
      isQueueInsertDragOwnerRef.current = true
      startTrackDrag(tracksForDrag, pointerX, pointerY)
      return true
    }

    const updateModifierSelectionDrag = (pressState: TrackSelectionPointerState, hoverIndex: number) => {
      const nextSelectedPaths = addTrackRangeToSelection(
        pressState.baseSelectedPaths,
        renderedQueueTracks,
        pressState.anchorIndex,
        hoverIndex
      )
      if (pressState.activeSelectedPaths && areTrackPathSetsEqual(pressState.activeSelectedPaths, nextSelectedPaths)) {
        return
      }

      const tracksForDrag = resolveSelectedTracksInOrder(nextSelectedPaths, renderedQueueTracks)
      if (tracksForDrag.length === 0) return

      queueInsertPointerStateRef.current = {
        ...pressState,
        activeSelectedPaths: nextSelectedPaths
      }
      setSelectedTrackPaths((current) => (
        areTrackPathSetsEqual(current, nextSelectedPaths) ? current : nextSelectedPaths
      ))
      setTrackDragTracks(tracksForDrag)
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const pressState = queueInsertPointerStateRef.current
      if (!pressState || moveEvent.pointerId !== pressState.pointerId) return

      const distance = Math.hypot(moveEvent.clientX - pressState.startX, moveEvent.clientY - pressState.startY)
      if (!isQueueInsertDragOwnerRef.current && distance > TRACK_SELECTION_DRAG_THRESHOLD_PX) {
        if (pressState.mode === 'modifier-selection') {
          const hoveredIndex = resolveQueueInsertHoverIndex(moveEvent.clientX, moveEvent.clientY) ?? pressState.anchorIndex
          const nextSelectedPaths = addTrackRangeToSelection(
            pressState.baseSelectedPaths,
            renderedQueueTracks,
            pressState.anchorIndex,
            hoveredIndex
          )
          const tracksForDrag = resolveSelectedTracksInOrder(nextSelectedPaths, renderedQueueTracks)
          if (!beginQueueInsertDrag(tracksForDrag, moveEvent.clientX, moveEvent.clientY)) return

          queueInsertPointerStateRef.current = {
            ...pressState,
            activeSelectedPaths: nextSelectedPaths
          }
          setSelectedTrackPaths((current) => (
            areTrackPathSetsEqual(current, nextSelectedPaths) ? current : nextSelectedPaths
          ))
        } else {
          if (!beginQueueInsertDrag(selectedQueueTracks, moveEvent.clientX, moveEvent.clientY)) return
        }
      }

      if (isQueueInsertDragOwnerRef.current) {
        updateTrackDragPointer(moveEvent.clientX, moveEvent.clientY)

        const latestPressState = queueInsertPointerStateRef.current
        if (latestPressState?.mode === 'modifier-selection' && isTrackSelectionModifierActive(moveEvent)) {
          const hoveredIndex = resolveQueueInsertHoverIndex(moveEvent.clientX, moveEvent.clientY)
          if (hoveredIndex !== null) {
            updateModifierSelectionDrag(latestPressState, hoveredIndex)
          }
        }
      }
    }

    const finalizeQueueInsert = () => {
      clearQueueInsertPointerListeners()

      const dragState = useUIStore.getState().trackDrag
      if (isQueueInsertDragOwnerRef.current) {
        suppressQueueInsertClickRef.current = true
      }
      if (dragState?.dropTarget && dragState.tracks.length > 0) {
        if (dragState.dropTarget.surface === 'queue') {
          void enqueueTrackPaths(
            dragState.tracks.map((track) => track.path),
            dragState.dropTarget.kind === 'empty' ? 0 : dragState.dropTarget.index
          )
          if (dragState.tracks.length === 1) {
            setQueueActionFeedback('queue', dragState.tracks[0].path)
          }
        } else if (dragState.dropTarget.kind === 'playlist') {
          void addToPlaylist(
            dragState.dropTarget.playlistId,
            dragState.tracks.map((track) => track.path)
          ).catch((error) => {
            console.error('Failed to add dropped tracks to playlist.', error)
          })
        } else {
          openSidebarPlaylistCreateRequest(dragState.tracks.map((track) => track.path))
        }
      }

      clearTrackDrag()
      cleanupQueueInsertPointerState()
      setIsQueueInsertDragOwner(false)
      isQueueInsertDragOwnerRef.current = false
    }

    const handlePointerUp = (upEvent: PointerEvent) => {
      const pressState = queueInsertPointerStateRef.current
      if (!pressState || upEvent.pointerId !== pressState.pointerId) return
      finalizeQueueInsert()
    }

    const handlePointerCancel = () => {
      clearQueueInsertPointerListeners()
      clearTrackDrag()
      cleanupQueueInsertPointerState()
      setIsQueueInsertDragOwner(false)
      isQueueInsertDragOwnerRef.current = false
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)
    document.addEventListener('pointercancel', handlePointerCancel)
    queueInsertPointerCleanupRef.current = () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
      document.removeEventListener('pointercancel', handlePointerCancel)
    }
  }, [
    clearQueueInsertPointerListeners,
    cleanupQueueInsertPointerState,
    clearTrackDrag,
    addToPlaylist,
    enqueueTrackPaths,
    openSidebarPlaylistCreateRequest,
    renderedQueueTracks,
    resolveQueueInsertHoverIndex,
    selectedQueueTracks,
    selectedTrackPaths,
    setQueueActionFeedback,
    setTrackDragTracks,
    startTrackDrag,
    updateTrackDragPointer
  ])

  const handleToggleFavorite = useCallback((event: React.MouseEvent, trackPath: string) => {
    event.stopPropagation()
    void toggleFavorite(trackPath)
  }, [toggleFavorite])

  const closePlaylistPopup = useCallback(() => {
    playlistMembershipRequestIdRef.current += 1
    setPlaylistPopup(null)
    setPlaylistPopupSearch('')
    setPlaylistPopupFeedback(null)
    setPlaylistMembershipCounts({})
    setIsPlaylistMembershipLoading(false)
    setIsPlaylistMembershipMutating(false)
    setCreatePlaylistTarget(null)
    playlistPopupTriggerRef.current = null
  }, [])

  useEffect(() => {
    closePlaylistPopup()
    setTrackContextMenu(null)
  }, [closePlaylistPopup, uiScalePercent])

  const refreshPlaylistMembership = useCallback(async (trackPaths: string[]) => {
    const requestId = playlistMembershipRequestIdRef.current + 1
    playlistMembershipRequestIdRef.current = requestId

    setIsPlaylistMembershipLoading(true)
    try {
      const summaries = await getPlaylistsContainingTracks(trackPaths)
      if (playlistMembershipRequestIdRef.current !== requestId) return
      setPlaylistMembershipCounts(Object.fromEntries(
        summaries.map((summary) => [summary.playlistId, summary.matchedTrackCount])
      ))
    } finally {
      if (playlistMembershipRequestIdRef.current === requestId) {
        setIsPlaylistMembershipLoading(false)
      }
    }
  }, [getPlaylistsContainingTracks])

  const openPlaylistPopupForTracks = useCallback((trigger: HTMLElement, popupTracks: DbTrack[]) => {
    const trackPaths = popupTracks.map((track) => track.path)
    const primaryTrackPath = trackPaths[0]
    if (!primaryTrackPath) return

    if (
      playlistPopup
      && playlistPopup.primaryTrackPath === primaryTrackPath
      && playlistPopup.trackPaths.length === trackPaths.length
      && playlistPopup.trackPaths.every((trackPath, index) => trackPath === trackPaths[index])
    ) {
      closePlaylistPopup()
      return
    }

    const rect = trigger.getBoundingClientRect()

    playlistPopupTriggerRef.current = trigger instanceof HTMLButtonElement ? trigger : null
    setPlaylistPopupSearch('')
    setPlaylistPopupFeedback(null)
    setPlaylistMembershipCounts({})
    setIsPlaylistMembershipMutating(false)
    setPlaylistPopup({
      trackPaths,
      primaryTrackPath,
      anchor: {
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        height: rect.height
      }
    })
    void refreshPlaylistMembership(trackPaths)
  }, [closePlaylistPopup, playlistPopup, refreshPlaylistMembership])

  const handleOpenPlaylistPopup = useCallback((event: React.MouseEvent<HTMLButtonElement>, track: DbTrack) => {
    event.stopPropagation()
    setTrackContextMenu(null)
    openPlaylistPopupForTracks(event.currentTarget, resolveActionTracks(track))
  }, [openPlaylistPopupForTracks, resolveActionTracks])

  const handleTrackContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>, track: DbTrack, trackIndex: number) => {
    event.preventDefault()
    event.stopPropagation()
    closePlaylistPopup()

    const hasRepeatedRenderedPath = playlistEntryIds !== undefined
      && tracks.some((candidate, index) => index !== trackIndex && candidate.path === track.path)
    const contextTracks = !hasRepeatedRenderedPath && selectedTrackPaths.has(track.path) && selectedDbTracks.length > 0
      ? selectedDbTracks
      : [track]
    if (contextTracks.length === 1 && contextTracks[0]?.path === track.path) {
      setSelectedTrackPaths(new Set([track.path]))
    }

    setTrackContextMenu({
      track,
      tracks: contextTracks,
      playlistEntryId: contextTracks.length === 1 ? playlistEntryIds?.[trackIndex] ?? null : null,
      x: event.clientX,
      y: event.clientY
    })
  }, [closePlaylistPopup, playlistEntryIds, selectedDbTracks, selectedTrackPaths, tracks])

  const handleCheckTrackIntegrity = useCallback(() => {
    if (!trackContextMenu) return
    const trackPaths = trackContextMenu.tracks
      .filter((track) => track.source_type === 'local')
      .map((track) => track.path)
    if (trackPaths.length === 0) return
    setTrackContextMenu(null)
    void checkTracksIntegrity(trackPaths)
  }, [checkTracksIntegrity, trackContextMenu])

  const handleContextPlayNext = useCallback(() => {
    if (!trackContextMenu) return
    const trackPaths = trackContextMenu.tracks.map((track) => track.path)
    void enqueueTrackPaths(trackPaths, 'next')
    setQueueActionFeedbackForPaths('next', trackPaths)
    setTrackContextMenu(null)
  }, [enqueueTrackPaths, setQueueActionFeedbackForPaths, trackContextMenu])

  const handleContextAddToQueue = useCallback(() => {
    if (!trackContextMenu) return
    const trackPaths = trackContextMenu.tracks.map((track) => track.path)
    void enqueueTrackPaths(trackPaths, 'end')
    setQueueActionFeedbackForPaths('queue', trackPaths)
    setTrackContextMenu(null)
  }, [enqueueTrackPaths, setQueueActionFeedbackForPaths, trackContextMenu])

  const handleOpenContextPlaylistPopup = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (!trackContextMenu) return
    event.stopPropagation()
    openPlaylistPopupForTracks(event.currentTarget, trackContextMenu.tracks)
    setTrackContextMenu(null)
  }, [openPlaylistPopupForTracks, trackContextMenu])

  const handleContextCreateSignal = useCallback(() => {
    if (!trackContextMenu || trackContextMenu.tracks.length !== 1) return
    const track = trackContextMenu.track
    openSignalShare({
      artist: track.artist,
      title: track.title,
      duration: track.duration
    })
    setTrackContextMenu(null)
  }, [openSignalShare, trackContextMenu])

  const handleContextEditMetadata = useCallback(() => {
    if (!trackContextMenu) return
    const localTracks = trackContextMenu.tracks.filter((track) => track.source_type === 'local')
    if (localTracks.length === 0) return

    openMetadataEditor({
      trackPaths: localTracks.map((track) => track.path),
      skippedRemoteCount: trackContextMenu.tracks.length - localTracks.length
    })
    closeLyricsEditor()
    setTrackContextMenu(null)
  }, [closeLyricsEditor, openMetadataEditor, trackContextMenu])

  const handleContextRemoveRating = useCallback(() => {
    if (!trackContextMenu) return
    const trackPaths = trackContextMenu.tracks.map((track) => track.path)
    void setTrackRating(trackPaths, null)
    setTrackContextMenu(null)
  }, [setTrackRating, trackContextMenu])

  const handleContextEditLyrics = useCallback(() => {
    if (!trackContextMenu) return
    const trackPaths = trackContextMenu.tracks.map((track) => track.path)
    if (trackPaths.length === 0) return

    closeMetadataEditor()
    openLyricsEditor({ trackPaths })
    setTrackContextMenu(null)
  }, [closeMetadataEditor, openLyricsEditor, trackContextMenu])

  const handleToggleTrackPlaylistMembership = useCallback(async (event: React.MouseEvent, playlistId: number, trackPaths: string[]) => {
    event.stopPropagation()
    if (isPlaylistMembershipMutating) return

    const isSingleTrack = trackPaths.length === 1
    const matchedTrackCount = playlistMembershipCounts[playlistId] ?? 0
    const isComplete = matchedTrackCount >= trackPaths.length
    setPlaylistPopupFeedback(null)
    setIsPlaylistMembershipMutating(true)
    try {
      if (isSingleTrack && isComplete) {
        await removeFromPlaylist(playlistId, trackPaths[0])
      } else {
        await addToPlaylist(playlistId, trackPaths)
      }

      await refreshPlaylistMembership(trackPaths)
    } finally {
      setIsPlaylistMembershipMutating(false)
    }
  }, [addToPlaylist, isPlaylistMembershipMutating, playlistMembershipCounts, refreshPlaylistMembership, removeFromPlaylist])

  const removeTrackPathsFromCurrentPlaylist = useCallback(async (trackPaths: string[]) => {
    const playlistId = playlistSourceId
    if (playlistId === null || playlistId <= 0) return
    if (isRemovingFromPlaylist) return

    const uniqueTrackPaths = Array.from(new Set(trackPaths.filter((trackPath) => trackPath.trim().length > 0)))
    if (uniqueTrackPaths.length === 0) return

    setIsRemovingFromPlaylist(true)
    try {
      for (const trackPath of uniqueTrackPaths) {
        await removeFromPlaylist(playlistId, trackPath)
      }
      closePlaylistPopup()
      setTrackContextMenu(null)
      setSelectedTrackPaths(new Set())
    } finally {
      setIsRemovingFromPlaylist(false)
    }
  }, [closePlaylistPopup, isRemovingFromPlaylist, playlistSourceId, removeFromPlaylist])

  const removePlaylistOccurrence = useCallback(async (entryId: number | null, fallbackTrackPath: string) => {
    const playlistId = playlistSourceId
    if (playlistId === null || playlistId <= 0 || isRemovingFromPlaylist) return

    setIsRemovingFromPlaylist(true)
    try {
      if (typeof entryId === 'number' && Number.isInteger(entryId) && entryId > 0) {
        await removePlaylistEntry(playlistId, entryId)
      } else {
        await removeFromPlaylist(playlistId, fallbackTrackPath)
      }
      closePlaylistPopup()
      setTrackContextMenu(null)
      setSelectedTrackPaths(new Set())
    } finally {
      setIsRemovingFromPlaylist(false)
    }
  }, [closePlaylistPopup, isRemovingFromPlaylist, playlistSourceId, removeFromPlaylist, removePlaylistEntry])

  const handleRemoveTrackFromPlaylist = useCallback((event: React.MouseEvent, dbTrack: DbTrack, trackIndex: number) => {
    event.stopPropagation()
    void removePlaylistOccurrence(playlistEntryIds?.[trackIndex] ?? null, dbTrack.path)
  }, [playlistEntryIds, removePlaylistOccurrence])

  const handleContextRemoveFromPlaylist = useCallback(() => {
    if (!trackContextMenu) return
    if (trackContextMenu.tracks.length === 1 && trackContextMenu.playlistEntryId !== null) {
      void removePlaylistOccurrence(trackContextMenu.playlistEntryId, trackContextMenu.track.path)
      return
    }
    void removeTrackPathsFromCurrentPlaylist(trackContextMenu.tracks.map((track) => track.path))
  }, [removePlaylistOccurrence, removeTrackPathsFromCurrentPlaylist, trackContextMenu])

  const handleChangeMissingPlaylistAssociation = useCallback(() => {
    if (!trackContextMenu || trackContextMenu.tracks.length !== 1) return
    const track = trackContextMenu.tracks[0]
    if (!track || !isMissingPlaylistEntryTrack(track) || !onChangeMissingPlaylistAssociation) return
    setTrackContextMenu(null)
    void onChangeMissingPlaylistAssociation(track.path, trackContextMenu.playlistEntryId)
  }, [onChangeMissingPlaylistAssociation, trackContextMenu])

  const handleOpenCreatePlaylistModal = useCallback(() => {
    if (!playlistPopup) return
    setPlaylistPopupFeedback(null)
    setCreatePlaylistTarget({ trackPaths: playlistPopup.trackPaths })
  }, [playlistPopup])

  const handleCloseCreatePlaylistModal = useCallback(() => {
    setCreatePlaylistTarget(null)
  }, [])

  const handleCreatePlaylistForTrack = useCallback(async (name: string, coverImagePath: string | null) => {
    if (!createPlaylistTarget) {
      throw new Error('No track is selected for playlist creation.')
    }

    const playlist = await createPlaylistWithOptions({
      name,
      coverImagePath,
      trackPaths: createPlaylistTarget.trackPaths
    })

    setPlaylistPopupSearch('')
    setPlaylistPopupFeedback({
      kind: 'info',
      message: `Created "${playlist.name}" and added ${createPlaylistTarget.trackPaths.length === 1 ? 'this track' : `${createPlaylistTarget.trackPaths.length} tracks`}.`
    })
    await refreshPlaylistMembership(createPlaylistTarget.trackPaths)
    return playlist
  }, [createPlaylistTarget, createPlaylistWithOptions, refreshPlaylistMembership])

  const handleListScroll = useCallback(() => {
    closePlaylistPopup()
    setTrackContextMenu(null)
  }, [closePlaylistPopup])

  const isCreatePlaylistModalOpen = createPlaylistTarget !== null

  useEffect(() => {
    if (!playlistPopup) return

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (isCreatePlaylistModalOpen) return

      const target = event.target as Node | null
      if (!target) return
      if (playlistPopupRef.current?.contains(target)) return
      if (playlistPopupTriggerRef.current?.contains(target)) return
      closePlaylistPopup()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isCreatePlaylistModalOpen) return

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
  }, [closePlaylistPopup, isCreatePlaylistModalOpen, playlistPopup])

  useEffect(() => {
    if (!trackContextMenu) return

    const handlePointerDown = () => {
      setTrackContextMenu(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setTrackContextMenu(null)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handlePointerDown)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handlePointerDown)
    }
  }, [trackContextMenu])

  const filteredPlaylists = useMemo(() => {
    return rankFuzzyMatches(getNormalPlaylists(playlists), playlistPopupSearch, (playlist) => [
      { value: playlist.name, weight: 1.5 }
    ])
  }, [playlistPopupSearch, playlists])

  const playlistPopupTrack = useMemo(() => {
    if (!playlistPopup) return null
    return tracks.find((track) => track.path === playlistPopup.primaryTrackPath) ?? null
  }, [playlistPopup, tracks])

  const playlistPopupStyle = useMemo(() => {
    if (!playlistPopup) return undefined

    const panelWidth = 296
    const gap = 8
    const edgePadding = 10
    const estimatedHeight = 344
    const uiScale = uiScalePercent / 100
    const anchor = viewportRectToAppLayout({
      x: playlistPopup.anchor.left,
      y: playlistPopup.anchor.top,
      width: playlistPopup.anchor.right - playlistPopup.anchor.left,
      height: playlistPopup.anchor.height,
      right: playlistPopup.anchor.right,
      bottom: playlistPopup.anchor.bottom
    }, uiScale)
    const viewport = viewportSizeToAppLayout({
      width: window.innerWidth,
      height: window.innerHeight
    }, uiScale)

    let left = anchor.right + gap
    if (left + panelWidth > viewport.width - edgePadding) {
      left = Math.max(edgePadding, anchor.x - panelWidth - gap)
    }

    let top = anchor.y - 8
    const maxTop = Math.max(edgePadding, viewport.height - edgePadding - estimatedHeight)
    top = Math.min(Math.max(top, edgePadding), maxTop)

    return {
      top,
      left,
      maxHeight: Math.max(150, viewport.height - top - edgePadding)
    }
  }, [playlistPopup, uiScalePercent])

  const trackContextMenuStyle = useMemo(() => {
    if (!trackContextMenu) return undefined

    const panelWidth = 220
    const panelHeight = (integrityEnabled ? 252 : 194) + (
      onChangeMissingPlaylistAssociation && playlistSourceId !== null && playlistSourceId > 0 ? 36 : 0
    ) + (ratingsEnabled ? 72 : 0) + (trackContextMenu.tracks.length === 1 ? 36 : 0)
    const edgePadding = 8
    const uiScale = uiScalePercent / 100
    const anchor = viewportPointToAppLayout({
      x: trackContextMenu.x,
      y: trackContextMenu.y
    }, uiScale)
    const viewport = viewportSizeToAppLayout({
      width: window.innerWidth,
      height: window.innerHeight
    }, uiScale)

    return clampFixedOverlayPosition({
      anchor,
      overlay: { width: panelWidth, height: panelHeight },
      viewport,
      edgePadding
    })
  }, [integrityEnabled, onChangeMissingPlaylistAssociation, playlistSourceId, ratingsEnabled, trackContextMenu, uiScalePercent])

  const listHeight = listViewportHeight > 0 ? listViewportHeight : trackRowHeight
  const virtualContentHeight = useMemo(() => (
    virtualRows.reduce((height, row) => height + getTrackListVirtualRowHeightPx(row, trackRowHeight, discHeaderHeight), 0)
  ), [discHeaderHeight, trackRowHeight, virtualRows])
  const resolvedListHeight = externalScroll
    ? Math.max(trackRowHeight, virtualContentHeight)
    : listHeight
  const resolveVirtualRowHeight = useCallback((rowIndex: number) => (
    getTrackListVirtualRowHeightPx(virtualRows[rowIndex], trackRowHeight, discHeaderHeight)
  ), [discHeaderHeight, trackRowHeight, virtualRows])
  const playlistPopupTrackPath = playlistPopup?.primaryTrackPath ?? null
  const queueInsertPreview = isQueueInsertDragOwner ? trackDrag : null
  const isColumnSortingEnabled = enableColumnSorting && typeof onSortColumnToggle === 'function'
  const canResetDefaultOrder = enableDefaultOrderReset && typeof onDefaultOrderReset === 'function'
  const getDefaultSortDirection = (key: TrackListSortKey): 'asc' | 'desc' => (
    key === 'added' || key === 'rating' || key === 'play_count' ? 'desc' : 'asc'
  )

  const getAriaSort = (key: TrackListSortKey): 'none' | 'ascending' | 'descending' => {
    if (!isColumnSortingEnabled || !sortState || sortState.key !== key) return 'none'
    return sortState.direction === 'asc' ? 'ascending' : 'descending'
  }

  const renderSortableHeader = (key: TrackListSortKey, label: string, className: string): ReactElement => {
    const isActive = Boolean(sortState && sortState.key === key)
    const direction = isActive ? sortState!.direction : getDefaultSortDirection(key)
    const currentDirectionLabel = isActive ? (direction === 'asc' ? 'ascending' : 'descending') : 'not sorted'
    const nextDirectionLabel = isActive
      ? (direction === 'asc' ? 'descending' : 'ascending')
      : (direction === 'asc' ? 'ascending' : 'descending')

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

  const contextMenuTrackCount = trackContextMenu?.tracks.length ?? 0
  const contextMenuLocalTrackCount = trackContextMenu?.tracks.filter((track) => track.source_type === 'local').length ?? 0
  const contextMenuContainsMissingPlaylistEntry = Boolean(
    trackContextMenu?.tracks.some((track) => isMissingPlaylistEntryTrack(track))
  )
  const contextMenuTrackPaths = useMemo(
    () => trackContextMenu?.tracks.map((track) => track.path) ?? [],
    [trackContextMenu]
  )
  const contextMenuHasRatedTrack = Boolean(
    trackContextMenu?.tracks.some((track) => ratings.has(track.path))
  )
  const canChangeMissingPlaylistAssociation = Boolean(
    onChangeMissingPlaylistAssociation
    && canRemoveFromPlaylist
    && contextMenuTrackCount === 1
    && trackContextMenu
    && isMissingPlaylistEntryTrack(trackContextMenu.track)
  )
  const isContextIntegrityBusy = Boolean(
    trackContextMenu
    && integrityBusyPaths.some((trackPath) => trackContextMenu.tracks.some((track) => track.path === trackPath))
  )

  const rowProps = useMemo<TrackListRowSharedProps>(() => ({
    rows: virtualRows,
    tracks,
    showArtist,
    showAlbum,
    showTracklistBpmKey,
    showTracklistGenre,
    showAddedDate,
    showTracklistPlayCount,
    showNewTrackIndicator,
    ratingsEnabled,
    searchQuery,
    trackNumberMode,
    contextTrackNumbers,
    trackInstanceKeys,
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
    formatAddedDate: formatTrackAddedDate,
    formatAddedDateTitle: formatTrackAddedDateTitle,
    formatDuration,
    onTrackClick: handleTrackClick,
    onQueueInsertPointerDown: handleQueueInsertPointerDown,
    onPlayNext: handlePlayNext,
    onAddToQueue: handleAddToQueue,
    onToggleFavorite: handleToggleFavorite,
    onOpenPlaylistPopup: handleOpenPlaylistPopup,
    onTrackContextMenu: handleTrackContextMenu,
    onRemoveFromPlaylist: handleRemoveTrackFromPlaylist,
    canRemoveFromPlaylist,
    isRemovingFromPlaylist,
    showQueueInsertAffordance: true,
    queueInsertArmedTrackPath,
    selectedTrackPaths
  }), [
    virtualRows,
    tracks,
    showArtist,
    showAlbum,
    showTracklistBpmKey,
    showTracklistGenre,
    showAddedDate,
    showTracklistPlayCount,
    showNewTrackIndicator,
    ratingsEnabled,
    searchQuery,
    trackNumberMode,
    contextTrackNumbers,
    trackInstanceKeys,
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
    formatTrackAddedDate,
    formatTrackAddedDateTitle,
    formatDuration,
    handleTrackClick,
    handleQueueInsertPointerDown,
    handlePlayNext,
    handleAddToQueue,
    handleToggleFavorite,
    handleOpenPlaylistPopup,
    handleTrackContextMenu,
    handleRemoveTrackFromPlaylist,
    canRemoveFromPlaylist,
    isRemovingFromPlaylist,
    queueInsertArmedTrackPath,
    selectedTrackPaths
  ])

  if (tracks.length === 0) {
    return (
      <div className="track-list-empty">
        <p>No tracks found</p>
      </div>
    )
  }

  return (
    <div
      className={`track-list ${externalScroll ? 'track-list-external-scroll' : ''} ${queueInsertPreview ? 'track-list-queue-insert-dragging' : ''}`}
      ref={controllerGroupRef}
      data-controller-group="tracks"
      data-controller-axis="vertical"
      data-controller-virtual="true"
    >
      <div className="track-list-header">
        {canResetDefaultOrder ? (
          <div className="track-col track-col-num">
            <button
              type="button"
              className={`track-col-sort-btn track-col-default-sort-btn ${sortState === null ? 'active' : ''}`}
              onClick={() => onDefaultOrderReset()}
              aria-label={sortState === null ? 'Default order active.' : 'Restore default order.'}
            >
              <span className="track-col-sort-label">#</span>
            </button>
          </div>
        ) : (
          <div className="track-col track-col-num">{trackNumberMode === 'none' ? null : '#'}</div>
        )}
        {renderSortableHeader('title', 'Title', 'track-col-title')}
        {showArtist && renderSortableHeader('artist', 'Artist', 'track-col-artist')}
        {showAlbum && renderSortableHeader('album', 'Album', 'track-col-album')}
        {showTracklistGenre && renderSortableHeader('genre', 'Genre', 'track-col-genre')}
        {showTracklistBpmKey && renderSortableHeader('bpm', 'BPM', 'track-col-bpm')}
        {showTracklistBpmKey && renderSortableHeader('musical_key', 'Key', 'track-col-key')}
        {ratingsEnabled && renderSortableHeader('rating', 'Rating', 'track-col-rating')}
        <div className="track-col track-col-codec">Codec</div>
        {showAddedDate && renderSortableHeader('added', 'Added', 'track-col-added')}
        {showTracklistPlayCount && renderSortableHeader('play_count', 'Plays', 'track-col-plays')}
        {renderSortableHeader('duration', 'Length', 'track-col-duration')}
        <div className="track-col track-col-actions" />
      </div>
      <div
        className={`track-list-body ${externalScroll ? 'track-list-body-external-scroll' : ''}`}
        ref={listBodyRef}
        data-controller-scroll
      >
        <List
          className="track-list-virtualized"
          defaultHeight={TRACK_ROW_HEIGHT_FALLBACK_PX * 8}
          listRef={listRef}
          onScroll={externalScroll ? undefined : handleListScroll}
          overscanCount={TRACK_LIST_OVERSCAN_COUNT}
          rowComponent={TrackListRow}
          rowCount={virtualRows.length}
          rowHeight={resolveVirtualRowHeight}
          rowProps={rowProps}
          style={{ height: resolvedListHeight, width: '100%' }}
        />
      </div>
      {queueInsertPreview && (
        <div
          className={`track-queue-insert-preview ${queueInsertPreview.tracks.length > 1 ? 'track-queue-insert-preview-batch' : ''}`}
          style={{
            transform: `translate(${queueInsertPreview.pointerX + 14}px, ${queueInsertPreview.pointerY + 14}px)`
          }}
        >
          {queueInsertPreview.tracks.length > 1 && (
            <>
              <span className="track-queue-insert-preview-stack-layer track-queue-insert-preview-stack-layer-back" aria-hidden="true" />
              <span className="track-queue-insert-preview-stack-layer track-queue-insert-preview-stack-layer-mid" aria-hidden="true" />
            </>
          )}
          {queueInsertPreview.tracks.length > 1 && (
            <span className="track-queue-insert-preview-count">{queueInsertPreview.tracks.length}</span>
          )}
          <div className="track-queue-insert-preview-content">
            <span className="track-queue-insert-preview-kicker">Tracks</span>
            <span className="track-queue-insert-preview-title">
              {queueInsertPreview.tracks.length > 1
                ? `${queueInsertPreview.tracks.length} tracks`
                : queueInsertPreview.tracks[0]?.title ?? 'Track'}
            </span>
            <span className="track-queue-insert-preview-artist">
              {queueInsertPreview.tracks.length > 1
                ? 'In tracklist order'
                : queueInsertPreview.tracks[0]?.artist ?? 'Unknown Artist'}
            </span>
          </div>
        </div>
      )}
      {playlistPopup && (
        <div
          className="track-playlist-popup"
          style={playlistPopupStyle}
          ref={playlistPopupRef}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="track-playlist-popup-header">
            <div className="track-playlist-popup-header-copy">
              <div className="track-playlist-popup-title" title={playlistPopup.trackPaths.length === 1 ? playlistPopupTrack?.title ?? 'Track' : `${playlistPopup.trackPaths.length} selected tracks`}>
                {playlistPopup.trackPaths.length === 1 ? playlistPopupTrack?.title ?? 'Track' : `${playlistPopup.trackPaths.length} selected tracks`}
              </div>
              <div className="track-playlist-popup-subtitle">
                {playlistPopup.trackPaths.length === 1
                  ? 'Add or remove this track from playlists'
                  : 'Add selected tracks to playlists'}
              </div>
            </div>
            <button
              type="button"
              className="track-playlist-popup-create-btn"
              onClick={() => handleOpenCreatePlaylistModal()}
              disabled={isPlaylistMembershipLoading || isPlaylistMembershipMutating}
            >
              New playlist
            </button>
          </div>
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
          {playlistPopupFeedback && (
            <div
              className={`track-playlist-popup-notice ${playlistPopupFeedback.kind}`}
              role={playlistPopupFeedback.kind === 'error' ? 'alert' : 'status'}
            >
              {playlistPopupFeedback.message}
            </div>
          )}
          <div className="track-playlist-popup-list">
            {isPlaylistMembershipLoading ? (
              <div className="track-playlist-popup-empty">Loading...</div>
            ) : filteredPlaylists.length > 0 ? (
              filteredPlaylists.map((playlist) => {
                const matchedTrackCount = playlistMembershipCounts[playlist.id] ?? 0
                const isSingleTrack = playlistPopup.trackPaths.length === 1
                const isComplete = matchedTrackCount >= playlistPopup.trackPaths.length
                const isPartial = matchedTrackCount > 0 && !isComplete
                return (
                  <button
                    key={playlist.id}
                    className={`track-playlist-popup-item ${isComplete ? 'is-member' : ''} ${isPartial ? 'is-partial' : ''}`}
                    onClick={(event) => {
                      void handleToggleTrackPlaylistMembership(event, playlist.id, playlistPopup.trackPaths)
                    }}
                    disabled={isPlaylistMembershipMutating || (!isSingleTrack && isComplete)}
                  >
                    <span className="track-playlist-popup-item-check">
                      {isComplete ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      ) : isPartial ? (
                        <span className="track-playlist-popup-partial-dot" />
                      ) : null}
                    </span>
                    <PlaylistCover
                      hash={playlist.custom_cover_hash ?? playlist.auto_cover_hash}
                      name={playlist.name}
                      className="track-playlist-popup-cover"
                    />
                    <span className="track-playlist-popup-item-name">{highlightSearchMatch(playlist.name, playlistPopupSearch)}</span>
                    {!isSingleTrack && matchedTrackCount > 0 && (
                      <span className="track-playlist-popup-item-count">
                        {matchedTrackCount}/{playlistPopup.trackPaths.length}
                      </span>
                    )}
                  </button>
                )
              })
            ) : (
              <div className="track-playlist-popup-empty">No matching playlists</div>
            )}
          </div>
        </div>
      )}
      {trackContextMenu && (
        <div
          className="track-context-menu"
          style={trackContextMenuStyle}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="track-context-menu-item"
            onClick={handleContextPlayNext}
            disabled={contextMenuContainsMissingPlaylistEntry}
          >
            <span className="track-context-menu-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
              </svg>
            </span>
            {contextMenuTrackCount > 1 ? `Play Next (${contextMenuTrackCount})` : 'Play Next'}
          </button>
          <button
            type="button"
            className="track-context-menu-item"
            onClick={handleContextAddToQueue}
            disabled={contextMenuContainsMissingPlaylistEntry}
          >
            <span className="track-context-menu-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M13 7h-2v4H7v2h4v4h2v-4h4v-2h-4V7zm-1-5C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>
              </svg>
            </span>
            {contextMenuTrackCount > 1 ? `Add to Queue (${contextMenuTrackCount})` : 'Add to Queue'}
          </button>
          <button
            type="button"
            className="track-context-menu-item"
            onClick={handleOpenContextPlaylistPopup}
            disabled={contextMenuContainsMissingPlaylistEntry}
          >
            <span className="track-context-menu-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
              </svg>
            </span>
            Add to Playlist...
          </button>
          {contextMenuTrackCount === 1 && (
            <button
              type="button"
              className="track-context-menu-item"
              onClick={handleContextCreateSignal}
            >
              <span className="track-context-menu-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12h3l2-6 4 12 3-9 2 3h4" />
                </svg>
              </span>
              Create Astra Signal...
            </button>
          )}
          {ratingsEnabled && !contextMenuContainsMissingPlaylistEntry && (
            <div className="track-context-menu-rating">
              <span className="track-context-menu-rating-label">
                {contextMenuTrackCount > 1 ? `Rate (${contextMenuTrackCount})` : 'Rate'}
              </span>
              <TrackRatingControl
                trackPaths={contextMenuTrackPaths}
                size="md"
                calibration={false}
                onCommitted={() => setTrackContextMenu(null)}
              />
            </div>
          )}
          {ratingsEnabled && !contextMenuContainsMissingPlaylistEntry && contextMenuHasRatedTrack && (
            <button
              type="button"
              className="track-context-menu-item"
              onClick={handleContextRemoveRating}
            >
              <span className="track-context-menu-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
                  <path d="M4 4 20 20" />
                </svg>
              </span>
              {contextMenuTrackCount > 1 ? `Remove Rating (${contextMenuTrackCount})` : 'Remove Rating'}
            </button>
          )}
          {canChangeMissingPlaylistAssociation && (
            <button
              type="button"
              className="track-context-menu-item"
              onClick={handleChangeMissingPlaylistAssociation}
            >
              <span className="track-context-menu-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </span>
              Change Associated File...
            </button>
          )}
          {canRemoveFromPlaylist && (
            <button
              type="button"
              className="track-context-menu-item track-context-menu-item-danger"
              onClick={handleContextRemoveFromPlaylist}
              disabled={isRemovingFromPlaylist}
            >
              <span className="track-context-menu-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 7h14" />
                  <path d="M9 7V5h6v2" />
                  <path d="M8 10v9h8v-9" />
                </svg>
              </span>
              {isRemovingFromPlaylist
                ? 'Removing...'
                : contextMenuTrackCount > 1
                  ? `Remove from Playlist (${contextMenuTrackCount})`
                  : 'Remove from Playlist'}
            </button>
          )}
          <button
            type="button"
            className="track-context-menu-item"
            onClick={handleContextEditMetadata}
            disabled={contextMenuContainsMissingPlaylistEntry || contextMenuLocalTrackCount === 0}
          >
            <span className="track-context-menu-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </span>
            {contextMenuLocalTrackCount > 1 ? `Edit Metadata (${contextMenuLocalTrackCount})` : 'Edit Metadata'}
          </button>
          <button
            type="button"
            className="track-context-menu-item"
            onClick={handleContextEditLyrics}
            disabled={contextMenuContainsMissingPlaylistEntry}
          >
            <span className="track-context-menu-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
            </span>
            {contextMenuTrackCount > 1 ? `Edit Lyrics (${contextMenuTrackCount})` : 'Edit Lyrics'}
          </button>
          {integrityEnabled && (
            <button
              type="button"
              className="track-context-menu-item"
              onClick={handleCheckTrackIntegrity}
              disabled={contextMenuContainsMissingPlaylistEntry || contextMenuLocalTrackCount === 0 || isContextIntegrityBusy}
            >
              <span className="track-context-menu-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </span>
              {isContextIntegrityBusy
                ? 'Checking...'
                : contextMenuLocalTrackCount > 1
                  ? `Check Integrity (${contextMenuLocalTrackCount})`
                  : 'Check Integrity'}
            </button>
          )}
        </div>
      )}
      <CreatePlaylistModal
        isOpen={createPlaylistTarget !== null}
        onClose={handleCloseCreatePlaylistModal}
        onCreate={handleCreatePlaylistForTrack}
        title={createPlaylistTarget?.trackPaths.length === 1 ? 'Create Playlist for Track' : 'Create Playlist from Tracks'}
        pendingTrackCount={createPlaylistTarget?.trackPaths.length}
      />
    </div>
  )
}
