import { create } from 'zustand'
import { audioEngine, isSupersededAudioLoadError } from '../audio/AudioEngine'
import type { Track, PlaybackState } from '../types/audio'
import type { NativeAudioCapabilities } from '../../types/nativeAudio'
import type { ListeningHistoryStatus } from '../../types/listeningStats'
import { extractWaveformPeaks } from '../audio/waveformExtractor'
import { useLibraryStore, type DbTrack } from './libraryStore'
import { usePlaylistStore } from './playlistStore'
import { resolveOutputDeviceLabel, useAudioSettingsStore, type ReplayGainMode } from './audioSettingsStore'
import { useParallaxStore } from './parallaxStore'
import { logMemoryDiagnosticsEvent } from '../utils/memoryDiagnostics'
import {
  type PlayerSessionSnapshot,
  type SessionPlaybackSourceContext,
  type SessionQueueItem,
  type SessionQueueTrackSnapshot
} from '../utils/sessionState'

interface RemoteLoadProgress {
  path: string
  sourceType: 'local' | 'subsonic' | 'jellyfin'
  stage: 'downloading' | 'streaming' | 'complete' | 'failed'
  loadedBytes: number
  totalBytes: number | null
  chunkCount: number
  percent: number | null
  done: boolean
  failed: boolean
  bufferedSeconds: number
  bufferedPercent: number | null
  analyzedSeconds: number
  analyzedPercent: number | null
  playable: boolean
}

export type QueueItemOrigin = 'context' | 'manual'
export type QueueTrackSource = QueueItemOrigin | 'standalone'
type PlaybackLoadOutcome = 'loaded' | 'failed' | 'superseded'

export type QueueTrackSnapshot = Omit<Track, 'artworkData'>

export interface QueueTrackEntry {
  path: string
  snapshot: QueueTrackSnapshot
}

export interface QueueItem {
  queueId: string
  entry: QueueTrackEntry
  origin: QueueItemOrigin
  sourcePlaylistId: number | null
  sourceContext: PlaybackSourceContext | null
  contextLabel: string | null
}

export interface PlaybackHistoryEntry {
  item: QueueItem
}

export interface ResolvedQueueTrack {
  queueId: string
  source: 'upcoming' | 'previous'
  origin: QueueItemOrigin
  track: Track
  index: number
}

export type PlaybackSourceContext =
  | { type: 'playlist'; playlistId: number }
  | { type: 'artist'; artist: string }
  | { type: 'genre'; genre: string }
  | { type: 'album'; album: string; albumArtist?: string; identityKey?: string }

export interface PlaybackContextOptions {
  sourcePlaylistId?: number | null
  contextLabel?: string | null
  sourceContext?: PlaybackSourceContext | null
  shuffle?: boolean
  startShuffled?: boolean
}

interface PlayerStore {
  // State
  currentTrack: Track | null
  currentTrackSource: QueueTrackSource
  playbackState: PlaybackState
  currentTime: number
  duration: number
  volume: number
  isMuted: boolean
  waveformData: Float32Array | null
  waveformBufferedRatio: number
  waveformAnalyzedRatio: number
  remoteLoadProgress: RemoteLoadProgress | null
  loadingStatus: string | null
  remoteBufferedSeconds: number
  remoteStreamSessionId: number | null
  ffmpegFallbackNotice: {
    id: number
    trackPath: string
    title: string
    artist: string
  } | null
  outputDelayNotice: {
    id: number
    trackPath: string
    title: string
    artist: string
    delayMs: number
    outputLabel: string
  } | null
  associatedOpenNotice: {
    id: number
    trackPath: string
    title: string
    fileCount: number
    sourceLabel: string
  } | null
  restoredTrackNeedsLoad: boolean
  restoredPlaybackTime: number | null

  // Queue state
  queueItems: QueueItem[]
  baseUpcomingQueueIds: string[]
  upcomingQueueIds: string[]
  currentQueueItemId: string | null
  queueSourcePlaylistId: number | null
  queueSourceContext: PlaybackSourceContext | null
  queueContextLabel: string | null
  shuffle: boolean
  repeat: 'none' | 'one' | 'all'
  playbackHistory: PlaybackHistoryEntry[]

  // Actions
  loadTrack: (track: Track, audioData: ArrayBuffer) => Promise<boolean>
  loadTrackFromPath: (track: Track) => Promise<boolean>
  play: () => Promise<void>
  pause: () => void
  togglePlay: () => Promise<void>
  stop: () => void
  replaceLocalTrackPaths: (replacements: Record<string, string>) => Promise<void>
  seek: (time: number) => Promise<void>
  setVolume: (volume: number) => void
  toggleMute: () => void
  resetAudioPreferences: () => void

  // Queue actions
  startPlaybackContext: (
    tracks: Track[],
    startIndex?: number,
    options?: PlaybackContextOptions
  ) => Promise<void>
  startPlaybackContextByPaths: (
    paths: string[],
    startIndex?: number,
    options?: PlaybackContextOptions
  ) => Promise<void>
  enqueueTrack: (track: Track, position?: number | 'next' | 'end') => void
  enqueueTracks: (tracks: Track[], position?: number | 'next' | 'end') => void
  enqueueTrackPaths: (paths: string[], position?: number | 'next' | 'end') => Promise<void>
  moveUpcomingItem: (queueId: string, toIndex: number) => void
  removeUpcomingItem: (queueId: string) => void
  clearAllQueues: () => void
  playNext: () => Promise<void>
  playPrevious: () => Promise<void>
  playQueuedItem: (queueId: string, options?: { manualStart?: boolean }) => Promise<void>
  toggleShuffle: () => void
  toggleRepeat: () => void
  getResolvedUpcomingTracks: () => Track[]
  getResolvedUpcomingEntries: () => ResolvedQueueTrack[]
  getResolvedPreviousTracks: () => Track[]
  getResolvedPreviousEntries: () => ResolvedQueueTrack[]
  getResolvedNextTrack: () => Track | null
  getResolvedQueueLength: () => number
  clearFfmpegFallbackNotice: () => void
  clearOutputDelayNotice: () => void
  showAssociatedOpenNotice: (notice: {
    trackPath: string
    title: string
    fileCount: number
    sourceLabel: string
  }) => void
  clearAssociatedOpenNotice: () => void
  getSessionSnapshot: () => PlayerSessionSnapshot
  restoreSession: (snapshot: PlayerSessionSnapshot) => Promise<void>
  resetListeningHistoryTracking: (status: ListeningHistoryStatus) => void

  // Internal
  _initListeners: () => void
  _cleanupListeners: () => void
  _loadAndPlayTrack: (track: Track, options?: { manualStart?: boolean; startTime?: number }) => Promise<PlaybackLoadOutcome>
  _preBufferNextTrack: () => Promise<void>
  _schedulePreBufferNextTrack: (options?: { invalidatePending?: boolean }) => void
  _getNextEntry: () => ResolvedQueueTrack | null
}

// Waveform cache stored outside zustand to avoid re-renders on cache updates
const waveformCache = new Map<string, Float32Array>()
const MAX_WAVEFORM_CACHE_ENTRIES = 128
const SLOW_PATH_THRESHOLD_MS = 1500
const OUTPUT_DELAY_NOTICE_THRESHOLD_MS = 120
export const RECENT_PLAY_MIN_SECONDS = 15
const DEFAULT_PLAYER_VOLUME = 0.7
const CURRENT_TIME_STORE_THROTTLE_MS = 100
const LISTENING_HISTORY_CHECKPOINT_SECONDS = 10
const BYTES_PER_FLOAT32_SAMPLE = 4
const LARGE_LOCAL_FILE_BYTES = 128 * 1024 * 1024
const MAX_STANDARD_PREBUFFER_TRACK_BYTES = 192 * 1024 * 1024
const MAX_STANDARD_PREBUFFER_TOTAL_BYTES = 384 * 1024 * 1024
const LOCAL_PROGRESSIVE_DECODED_BYTES = MAX_STANDARD_PREBUFFER_TRACK_BYTES
const LOUDNESS_WARMUP_UPCOMING_TRACKS = 2
export const GAPLESS_PREBUFFER_LEAD_SECONDS = 15
const GAPLESS_PREBUFFER_TIMER_TOLERANCE_MS = 250
const MAX_GAPLESS_PREBUFFER_TIMER_MS = 2_147_000_000
export const MAX_PLAYBACK_HISTORY = 500
export const PLAYER_VOLUME_STORAGE_KEY = 'astra-player-volume-v1'
const BIT_PERFECT_REMOTE_FALLBACK_MESSAGE = 'Bit-perfect mode is only available for local files. Playback fell back to Standard.'
const IAMF_BIT_PERFECT_FALLBACK_MESSAGE = 'Eclipsa (IAMF) tracks decode through the standard pipeline. Playback fell back to Standard.'
let nextQueueItemId = 1

function createQueueId(): string {
  const queueId = `queue-${nextQueueItemId}`
  nextQueueItemId += 1
  return queueId
}

function getQueueIdSequenceNumber(queueId: string): number | null {
  const match = /^queue-(\d+)$/.exec(queueId)
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function advanceNextQueueItemId(queueIds: Iterable<string>): void {
  let maxId = 0
  for (const queueId of queueIds) {
    const parsed = getQueueIdSequenceNumber(queueId)
    if (parsed !== null) {
      maxId = Math.max(maxId, parsed)
    }
  }
  nextQueueItemId = Math.max(nextQueueItemId, maxId + 1)
}

function sessionContextToPlaybackContext(context: SessionPlaybackSourceContext | null): PlaybackSourceContext | null {
  if (!context) return null
  if (context.type === 'playlist') {
    return typeof context.playlistId === 'number'
      ? { type: 'playlist', playlistId: context.playlistId }
      : null
  }
  if (context.type === 'artist') {
    return context.artist ? { type: 'artist', artist: context.artist } : null
  }
  if (context.type === 'genre') {
    return context.genre ? { type: 'genre', genre: context.genre } : null
  }
  if (context.type === 'album') {
    return context.album
      ? {
          type: 'album',
          album: context.album,
          albumArtist: context.albumArtist,
          identityKey: context.identityKey
        }
      : null
  }
  return null
}

function sessionQueueItemToQueueItem(item: SessionQueueItem): QueueItem {
  return {
    queueId: item.queueId,
    entry: {
      path: item.entry.path,
      snapshot: { ...item.entry.snapshot }
    },
    origin: item.origin,
    sourcePlaylistId: item.sourcePlaylistId,
    sourceContext: sessionContextToPlaybackContext(item.sourceContext),
    contextLabel: item.contextLabel
  }
}

function sessionTrackSnapshotToTrack(snapshot: SessionQueueTrackSnapshot): Track {
  return { ...snapshot }
}

class SupersededPlaybackLoadError extends Error {
  constructor() {
    super('Playback load was superseded by a newer request.')
    this.name = 'SupersededPlaybackLoadError'
  }
}

function estimateWaveformCacheBytes(): number {
  let total = 0
  for (const peaks of waveformCache.values()) {
    total += peaks.byteLength
  }
  return total
}

function estimateTrackArtworkBytes(track: Track | null | undefined): number {
  const artworkData = track?.artworkData
  return typeof artworkData === 'string' ? artworkData.length * 2 : 0
}

function estimateDecodedTrackBytes(track: Track | null | undefined): number | null {
  if (!track) return null

  const durationSeconds = track.duration
  const sampleRate = track.sampleRate
  const channels = track.channels ?? 2

  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null
  if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate <= 0) return null
  if (typeof channels !== 'number' || !Number.isFinite(channels) || channels <= 0) return null

  return Math.round(durationSeconds * sampleRate * channels * BYTES_PER_FLOAT32_SAMPLE)
}

export function getGaplessPrebufferDelayMs(
  currentTime: number,
  duration: number,
  leadSeconds: number = GAPLESS_PREBUFFER_LEAD_SECONDS
): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0

  const normalizedCurrentTime = Number.isFinite(currentTime)
    ? Math.max(0, currentTime)
    : 0
  const normalizedLeadSeconds = Number.isFinite(leadSeconds)
    ? Math.max(0, leadSeconds)
    : GAPLESS_PREBUFFER_LEAD_SECONDS
  const remainingSeconds = Math.max(0, duration - normalizedCurrentTime)
  const delaySeconds = remainingSeconds - normalizedLeadSeconds

  if (delaySeconds <= 0) return 0
  return Math.min(
    MAX_GAPLESS_PREBUFFER_TIMER_MS,
    Math.round(delaySeconds * 1000)
  )
}

function getFileNameFromPath(trackPath: string): string {
  const normalizedPath = trackPath.replace(/\\/g, '/')
  return normalizedPath.split('/').pop() ?? trackPath
}

function getTitleFromPath(trackPath: string): string {
  const fileName = getFileNameFromPath(trackPath)
  const extensionIndex = fileName.lastIndexOf('.')
  return extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName
}

function getFormatFromPath(trackPath: string): string {
  const fileName = getFileNameFromPath(trackPath)
  const extensionIndex = fileName.lastIndexOf('.')
  return extensionIndex > 0 ? fileName.slice(extensionIndex + 1).toLowerCase() : 'unknown'
}

export function resolvePositiveDuration(primary: unknown, fallback: unknown = 0): number {
  const primaryDuration = Number(primary)
  if (Number.isFinite(primaryDuration) && primaryDuration > 0) return primaryDuration

  const fallbackDuration = Number(fallback)
  if (Number.isFinite(fallbackDuration) && fallbackDuration > 0) return fallbackDuration

  return 0
}

export function shouldApplyDurationChange(
  duration: unknown,
  currentTrack: Pick<Track, 'duration'> | null,
  playbackState: PlaybackState
): boolean {
  if (resolvePositiveDuration(duration) > 0) return true
  if (!currentTrack || playbackState === 'stopped') return true
  return resolvePositiveDuration(currentTrack.duration) <= 0
}

export interface RecentPlayAccumulationState {
  accumulatedSeconds: number
  lastAccumulatedAtMs: number | null
}

export function getRecentPlayThresholdSecondsForDuration(duration: number | null | undefined): number {
  if (!Number.isFinite(duration) || (duration ?? 0) <= 0) {
    return RECENT_PLAY_MIN_SECONDS
  }
  return Math.min(RECENT_PLAY_MIN_SECONDS, Math.max(0, duration ?? 0))
}

export function advanceRecentPlayAccumulation(
  state: RecentPlayAccumulationState,
  playbackState: PlaybackState,
  nowMs: number
): RecentPlayAccumulationState {
  if (playbackState !== 'playing') {
    return {
      accumulatedSeconds: state.accumulatedSeconds,
      lastAccumulatedAtMs: null
    }
  }

  if (state.lastAccumulatedAtMs === null) {
    return {
      accumulatedSeconds: state.accumulatedSeconds,
      lastAccumulatedAtMs: nowMs
    }
  }

  const deltaSeconds = Math.max(0, (nowMs - state.lastAccumulatedAtMs) / 1000)
  return {
    accumulatedSeconds: state.accumulatedSeconds + deltaSeconds,
    lastAccumulatedAtMs: nowMs
  }
}

export function stripTrackArtworkData(track: Track): QueueTrackSnapshot {
  const { artworkData: _artworkData, ...snapshot } = track
  return snapshot
}

export function createFallbackQueueTrackSnapshot(trackPath: string): QueueTrackSnapshot {
  return {
    id: trackPath,
    path: trackPath,
    title: getTitleFromPath(trackPath) || 'Unknown Track',
    artist: 'Unknown Artist',
    album: 'Unknown Album',
    duration: 0,
    format: getFormatFromPath(trackPath)
  }
}

export function createQueueEntryFromTrack(track: Track): QueueTrackEntry {
  return {
    path: track.path,
    snapshot: stripTrackArtworkData(track)
  }
}

function createQueueEntryFromPath(trackPath: string): QueueTrackEntry {
  return {
    path: trackPath,
    snapshot: createFallbackQueueTrackSnapshot(trackPath)
  }
}

function dbTrackToTrack(dbTrack: DbTrack): Track {
  const codecTrack = dbTrack as DbTrack & {
    codec?: string | null
    codec_profile?: string | null
    is_atmos_joc?: number | null
    is_iamf?: number | null
  }

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
    trackNumber: dbTrack.track_number ?? undefined,
    discNumber: dbTrack.disc_number ?? undefined,
    year: dbTrack.year ?? undefined,
    genre: dbTrack.genre ?? undefined,
    genres: dbTrack.genres,
    artworkHash: dbTrack.artwork_hash ?? undefined,
    format: dbTrack.format,
    sampleRate: dbTrack.sample_rate ?? undefined,
    bitDepth: dbTrack.bit_depth ?? undefined,
    bitrate: dbTrack.bitrate ?? undefined,
    channels: dbTrack.channels ?? undefined,
    codec: codecTrack.codec ?? undefined,
    codecProfile: codecTrack.codec_profile ?? undefined,
    isAtmosJoc: codecTrack.is_atmos_joc === 1,
    isIamf: codecTrack.is_iamf === 1,
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

function createQueueEntriesFromTracks(tracks: readonly Track[]): QueueTrackEntry[] {
  return tracks
    .filter((track): track is Track => Boolean(track?.path))
    .map(createQueueEntryFromTrack)
}

function createQueueEntriesFromResolvedTracks(
  paths: readonly string[],
  resolvedTracks: readonly DbTrack[]
): QueueTrackEntry[] {
  const resolvedByPath = new Map(resolvedTracks.map((track) => [track.path, track]))

  return paths.map((trackPath) => {
    const dbTrack = resolvedByPath.get(trackPath)
    return dbTrack ? createQueueEntryFromTrack(dbTrackToTrack(dbTrack)) : createQueueEntryFromPath(trackPath)
  })
}

export function createQueueEntriesFromPaths(trackPaths: readonly string[]): QueueTrackEntry[] {
  const paths = trackPaths.filter((trackPath) => typeof trackPath === 'string' && trackPath.length > 0)
  if (paths.length === 0) return []

  const resolvedTracks = useLibraryStore.getState().resolveTrackPaths(paths)
  return createQueueEntriesFromResolvedTracks(paths, resolvedTracks)
}

export async function createQueueEntriesFromPathsWithFetch(trackPaths: readonly string[]): Promise<QueueTrackEntry[]> {
  const paths = trackPaths.filter((trackPath) => typeof trackPath === 'string' && trackPath.length > 0)
  if (paths.length === 0) return []

  const resolvedTracks = await useLibraryStore.getState().resolveTrackPathsWithFetch(paths)
  return createQueueEntriesFromResolvedTracks(paths, resolvedTracks)
}

function resolveQueueEntryTrack(entry: QueueTrackEntry | null | undefined): Track | null {
  if (!entry) return null

  if (entry.snapshot.origin === 'associated-external') {
    return { ...entry.snapshot }
  }

  const [dbTrack] = useLibraryStore.getState().resolveTrackPaths([entry.path])
  const track = dbTrack ? dbTrackToTrack(dbTrack) : { ...entry.snapshot }

  if (entry.snapshot.isAvailable === false) {
    return {
      ...track,
      isAvailable: false,
      availabilityReason: entry.snapshot.availabilityReason
    }
  }

  return track
}

function updateQueueEntryAvailability(entry: QueueTrackEntry, trackPath: string, reason: string): QueueTrackEntry {
  if (entry.path !== trackPath) return entry
  return {
    ...entry,
    snapshot: {
      ...entry.snapshot,
      isAvailable: false,
      availabilityReason: reason
    }
  }
}

function getTrackRetentionDiagnostics(state: Pick<PlayerStore, 'currentTrack' | 'queueItems' | 'playbackHistory'>) {
  let retainedArtworkTrackCount = 0
  let retainedArtworkDataBytes = 0
  const distinctTrackPaths = new Set<string>()

  const addTrackPath = (trackPath: string | null | undefined): void => {
    if (trackPath) {
      distinctTrackPaths.add(trackPath)
    }
  }

  if (state.currentTrack) {
    addTrackPath(state.currentTrack.path)
    const artworkBytes = estimateTrackArtworkBytes(state.currentTrack)
    if (artworkBytes > 0) {
      retainedArtworkTrackCount += 1
      retainedArtworkDataBytes += artworkBytes
    }
  }
  state.queueItems.forEach((item) => addTrackPath(item.entry.path))
  state.playbackHistory.forEach((entry) => addTrackPath(entry.item.entry.path))

  return {
    retainedTrackCount: state.currentTrack ? 1 : 0,
    distinctRetainedTrackCount: distinctTrackPaths.size,
    retainedArtworkTrackCount,
    retainedArtworkDataBytes
  }
}

function createInitialRemoteLoadProgress(track: Track): RemoteLoadProgress {
  const sourceType = track.sourceType === 'jellyfin'
    ? 'jellyfin'
    : track.sourceType === 'subsonic'
      ? 'subsonic'
      : 'local'
  return {
    path: track.path,
    sourceType,
    stage: sourceType === 'local' ? 'streaming' : 'downloading',
    loadedBytes: 0,
    totalBytes: null,
    chunkCount: 0,
    percent: null,
    done: false,
    failed: false,
    bufferedSeconds: 0,
    bufferedPercent: 0,
    analyzedSeconds: 0,
    analyzedPercent: 0,
    playable: false
  }
}

function getWaveformCacheEntry(trackPath: string): Float32Array | undefined {
  const cached = waveformCache.get(trackPath)
  if (!cached) return undefined
  waveformCache.delete(trackPath)
  waveformCache.set(trackPath, cached)
  return cached
}

function setWaveformCacheEntry(trackPath: string, peaks: Float32Array): void {
  if (waveformCache.has(trackPath)) {
    waveformCache.delete(trackPath)
  }
  waveformCache.set(trackPath, peaks)

  while (waveformCache.size > MAX_WAVEFORM_CACHE_ENTRIES) {
    const oldestKey = waveformCache.keys().next().value
    if (!oldestKey) return
    waveformCache.delete(oldestKey)
  }
}

type NextCandidate =
  | { kind: 'current'; track: Track }
  | { kind: 'queue'; item: QueueItem; track: Track; index: number }

function isUnavailableRemoteTrack(track: Track | null | undefined): boolean {
  if (!track) return false
  return track.sourceType !== undefined
    && track.sourceType !== 'local'
    && track.isAvailable === false
}

function shouldUseWaveformCache(track: Track | null | undefined): boolean {
  if (!track) return false
  return (track.sourceType ?? 'local') === 'local'
}

function clampQueuePosition(index: number, length: number): number {
  if (!Number.isFinite(index)) return length
  const normalized = Math.floor(index)
  return Math.max(0, Math.min(length, normalized))
}

function moveQueueId(order: readonly string[], queueId: string, toIndex: number): string[] {
  const fromIndex = order.indexOf(queueId)
  if (fromIndex < 0) return [...order]
  const next = [...order]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(Math.max(0, Math.min(next.length, Math.floor(toIndex))), 0, moved)
  return next
}

function moveQueueIdRelativeToVisibleOrder(
  order: readonly string[],
  queueId: string,
  visibleOrder: readonly string[]
): string[] {
  const visibleIndex = visibleOrder.indexOf(queueId)
  if (visibleIndex < 0 || !order.includes(queueId)) return [...order]

  const next = order.filter((id) => id !== queueId)
  const followingId = visibleOrder[visibleIndex + 1]
  const precedingId = visibleOrder[visibleIndex - 1]
  const followingIndex = followingId ? next.indexOf(followingId) : -1
  if (followingIndex >= 0) {
    next.splice(followingIndex, 0, queueId)
    return next
  }

  const precedingIndex = precedingId ? next.indexOf(precedingId) : -1
  next.splice(precedingIndex >= 0 ? precedingIndex + 1 : next.length, 0, queueId)
  return next
}

function normalizeContextLabel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function resolvePlaybackSourceContext(options?: PlaybackContextOptions): PlaybackSourceContext | null {
  if (options?.sourceContext) return options.sourceContext
  if (typeof options?.sourcePlaylistId === 'number') {
    return { type: 'playlist', playlistId: options.sourcePlaylistId }
  }
  return null
}

function shuffleQueueIds(queueIds: readonly string[]): string[] {
  const ids = [...queueIds]
  for (let index = ids.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[ids[index], ids[swapIndex]] = [ids[swapIndex], ids[index]]
  }
  return ids
}

function getShuffledStartIndex(entryCount: number, requestedStartIndex: number): number {
  if (entryCount <= 1) return requestedStartIndex

  const candidateIndexes: number[] = []
  for (let index = 0; index < entryCount; index += 1) {
    if (requestedStartIndex === 0 && index === 0) continue
    candidateIndexes.push(index)
  }

  if (candidateIndexes.length === 0) return requestedStartIndex
  return candidateIndexes[Math.floor(Math.random() * candidateIndexes.length)] ?? requestedStartIndex
}

interface RecentPlaySession {
  trackPath: string
  thresholdSeconds: number
  accumulatedSeconds: number
  lastAccumulatedAtMs: number | null
  counted: boolean
  allowDbWrite: boolean
  sourcePlaylistId: number | null
  generation: string | null
  sessionKey: string
  sessionStartedAt: number
  segmentKey: string
  segmentStartedAt: number
  segmentStartAccumulatedSeconds: number
  lastCheckpointAccumulatedSeconds: number
  trackDurationSeconds: number
  qualificationEligible: boolean
}

let nextListeningHistoryKey = 1

function createListeningHistoryKey(prefix: 'session' | 'segment'): string {
  const randomId = globalThis.crypto?.randomUUID?.()
  if (randomId) return `${prefix}:${randomId}`
  const key = `${prefix}:${Date.now()}:${nextListeningHistoryKey}`
  nextListeningHistoryKey += 1
  return key
}

interface AssociatedAudioMetadata {
  title?: string
  artist?: string
  artistNames?: string[]
  album?: string
  albumArtist?: string
  albumArtistNames?: string[]
  duration?: number
  format?: string
  channels?: number
  codec?: string
  codecProfile?: string
  isAtmosJoc?: boolean
  isIamf?: boolean
  replayGainTrackDb?: number
  replayGainAlbumDb?: number
  artworkHash?: string
  artwork?: string
}

export function mergeAssociatedTrackMetadata(track: Track, metadata: AssociatedAudioMetadata): Track {
  const nextArtworkHash = metadata.artworkHash?.trim() || track.artworkHash
  const nextArtworkData = metadata.artwork ?? track.artworkData
  const baseTrack = { ...track }
  if (nextArtworkHash) {
    delete baseTrack.artworkData
  }

  return {
    ...baseTrack,
    title: metadata.title?.trim() || track.title,
    artist: metadata.artist?.trim() || track.artist,
    artistNames: metadata.artistNames ?? track.artistNames,
    album: metadata.album?.trim() || track.album,
    albumArtist: metadata.albumArtist ?? track.albumArtist,
    albumArtistNames: metadata.albumArtistNames ?? track.albumArtistNames,
    duration: typeof metadata.duration === 'number' && Number.isFinite(metadata.duration) && metadata.duration > 0
      ? metadata.duration
      : track.duration,
    format: metadata.format?.trim() || track.format,
    ...(nextArtworkHash
      ? { artworkHash: nextArtworkHash }
      : nextArtworkData
        ? { artworkData: nextArtworkData }
        : {}),
    channels: metadata.channels ?? track.channels,
    codec: metadata.codec ?? track.codec,
    codecProfile: metadata.codecProfile ?? track.codecProfile,
    isAtmosJoc: metadata.isAtmosJoc ?? track.isAtmosJoc,
    isIamf: metadata.isIamf ?? track.isIamf,
    replayGainTrackDb: metadata.replayGainTrackDb ?? track.replayGainTrackDb,
    replayGainAlbumDb: metadata.replayGainAlbumDb ?? track.replayGainAlbumDb
  }
}

function clampPlayerVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PLAYER_VOLUME
  return Math.max(0, Math.min(1, value))
}

function readSavedPlayerVolume(): number {
  try {
    const raw = localStorage.getItem(PLAYER_VOLUME_STORAGE_KEY)
    if (raw == null) return DEFAULT_PLAYER_VOLUME
    return clampPlayerVolume(Number(raw))
  } catch {
    return DEFAULT_PLAYER_VOLUME
  }
}

function persistPlayerVolume(volume: number): void {
  try {
    localStorage.setItem(PLAYER_VOLUME_STORAGE_KEY, String(clampPlayerVolume(volume)))
  } catch {
    // Ignore storage failures and continue with in-memory volume.
  }
}

function clearSavedPlayerVolume(): void {
  try {
    localStorage.removeItem(PLAYER_VOLUME_STORAGE_KEY)
  } catch {
    // Ignore storage failures and continue with in-memory volume.
  }
}

const initialPlayerVolume = readSavedPlayerVolume()
audioEngine.setVolume(initialPlayerVolume)

function logSlowPath(label: string, startTime: number, details: Record<string, unknown>): void {
  if (!import.meta.env?.DEV) return
  const elapsed = performance.now() - startTime
  if (elapsed <= SLOW_PATH_THRESHOLD_MS) return
  console.warn(`[perf] ${label} slow path (${Math.round(elapsed)}ms)`, details)
}

// Kick off the main-process loudness lookup/analysis (DB hit or ffmpeg ebur128
// pass) so it runs in parallel with the file read + decode. Returns null when
// the load would never consume the result.
function requestTrackLoudnessAnalysis(
  track: Track,
  replayGainDb: number | null,
  priority: 'interactive' | 'background' = 'interactive'
): Promise<{ loudnessLufs: number; peakLinear: number | null } | null> | null {
  if (track.sourceType && track.sourceType !== 'local') return null
  if (!audioEngine.needsLoudnessAnalysisForLoad(replayGainDb)) return null
  const request = priority === 'background'
    ? window.electronAPI.warmupTrackLoudness(track.path)
    : window.electronAPI.analyzeTrackLoudness(track.path)
  return request.catch(() => null)
}

// IAMF (Eclipsa) tracks decode via the renderer wasm worker; every
// ffmpeg-based path (bit-perfect, progressive streaming, compatibility
// fallback) must route around them — the bundled ffmpeg 6.0 has no IAMF
// support, so those paths cannot ever succeed.
function isIamfTrack(track: Track | null | undefined): boolean {
  if (!track) return false
  if (track.isIamf) return true
  return track.path.toLowerCase().endsWith('.iamf')
}

async function shouldUseLocalProgressivePath(track: Track): Promise<boolean> {
  if ((track.sourceType ?? 'local') !== 'local') return false
  if (isIamfTrack(track)) return false
  if (useAudioSettingsStore.getState().playbackOutputMode !== 'standard') return false

  const estimatedDecodedBytes = estimateDecodedTrackBytes(track)
  if (estimatedDecodedBytes !== null && estimatedDecodedBytes >= LOCAL_PROGRESSIVE_DECODED_BYTES) {
    return true
  }

  const fileStat = await window.electronAPI.getAudioFileStat(track.path).catch(() => null)
  return Boolean(fileStat && fileStat.size >= LARGE_LOCAL_FILE_BYTES)
}

function scheduleDeferredWaveformExtraction(callback: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => callback(), { timeout: 1000 })
    return
  }
  setTimeout(callback, 0)
}

function toReplayGainDb(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function getReplayGainCandidateDb(
  track: Track | null | undefined,
  replayGainMode: ReplayGainMode
): number | null {
  if (!track) return null

  const trackGainDb = toReplayGainDb(track.replayGainTrackDb)
  const albumGainDb = toReplayGainDb(track.replayGainAlbumDb)

  if (replayGainMode === 'track') {
    return trackGainDb
  }

  if (replayGainMode === 'album') {
    return albumGainDb
  }

  return trackGainDb ?? albumGainDb
}

function shouldUseBitPerfectPath(track: Track | null | undefined): boolean {
  if (!track) return false
  const sourceType = track.sourceType ?? 'local'
  if (sourceType !== 'local') return false
  if (isIamfTrack(track)) return false
  return useAudioSettingsStore.getState().playbackOutputMode === 'bitperfect'
}

async function ensureCompatiblePlaybackMode(track: Track): Promise<void> {
  const sourceType = track.sourceType ?? 'local'
  const iamf = isIamfTrack(track)
  if (sourceType === 'local' && !iamf) {
    return
  }

  const audioSettings = useAudioSettingsStore.getState()
  if (audioSettings.playbackOutputMode !== 'bitperfect') {
    return
  }

  await audioSettings.setPlaybackOutputMode('standard')
  useAudioSettingsStore.setState({
    playbackModeStatusMessage: sourceType !== 'local'
      ? BIT_PERFECT_REMOTE_FALLBACK_MESSAGE
      : IAMF_BIT_PERFECT_FALLBACK_MESSAGE
  })
}

export const usePlayerStore = create<PlayerStore>((set, get) => {
  // Track if listeners are initialized
  let listenersInitialized = false
  let remoteLoadProgressUnsubscribe: (() => void) | null = null
  let listeningBeforeUnloadHandler: (() => void) | null = null
  let lastCommittedCurrentTimeMs = 0
  let ffmpegFallbackNoticeId = 0
  let outputDelayNoticeId = 0
  let associatedOpenNoticeId = 0
  const associatedMetadataInflight = new Set<string>()
  let pendingManualLoadCueTrack: Track | null = null
  let recentPlaySession: RecentPlaySession | null = null
  let listeningHistoryStatusPromise: Promise<ListeningHistoryStatus> | null = null
  let activeLoadRequestId = 0
  let activePrebufferRequestId = 0
  let currentSerializedLoad: Promise<void> | null = null
  let prebufferScheduleTimerId: ReturnType<typeof globalThis.setTimeout> | null = null
  let prebufferScheduleDueAtMs: number | null = null
  let prebufferScheduleTrackPath: string | null = null
  let prebufferInFlightRequestId: number | null = null
  let prebufferInFlightTrackPath: string | null = null
  let prebufferAttemptedTrackPath: string | null = null
  let manualGaplessTransitionInProgress = false

  const isParallaxSinkModeActive = (): boolean => {
    return Boolean(useParallaxStore.getState().status?.sink.connected)
  }

  const playWithParallaxIfNeeded = async (track: Track | null | undefined): Promise<void> => {
    if (isParallaxSinkModeActive()) return
    const parallaxStore = useParallaxStore.getState()
    const resumeTimeline = await parallaxStore.resumeHostPlayback(track)
    if (resumeTimeline) {
      await audioEngine.playCurrentBufferOnParallaxTimeline(resumeTimeline)
      return
    }
    const timeline = track ? await useParallaxStore.getState().prepareHostPlayback(track) : null
    if (timeline) {
      await audioEngine.playCurrentBufferOnParallaxTimeline(timeline)
      return
    }
    await audioEngine.play()
  }

  const clearScheduledPrebufferTimer = (): void => {
    if (prebufferScheduleTimerId !== null) {
      globalThis.clearTimeout(prebufferScheduleTimerId)
      prebufferScheduleTimerId = null
    }
    prebufferScheduleDueAtMs = null
    prebufferScheduleTrackPath = null
  }

  const invalidatePrebufferRequest = (): void => {
    activePrebufferRequestId += 1
    prebufferInFlightRequestId = null
    prebufferInFlightTrackPath = null
    prebufferAttemptedTrackPath = null
  }

  const clearBufferedNextTrack = (): void => {
    clearScheduledPrebufferTimer()
    invalidatePrebufferRequest()
    audioEngine.clearNextBuffer()
    // §21 Gapless sink handoff — the pre-announced next stream (if any) is now stale; withdraw it
    // from sinks. Idempotent: a no-op when nothing is pending. Re-published when the next prebuffer
    // completes.
    void useParallaxStore.getState().cancelHostNextStream()
  }

  const beginLoadRequest = (): number => {
    activeLoadRequestId += 1
    clearScheduledPrebufferTimer()
    invalidatePrebufferRequest()
    return activeLoadRequestId
  }

  const invalidateLoadRequest = (): void => {
    activeLoadRequestId += 1
    clearScheduledPrebufferTimer()
    invalidatePrebufferRequest()
  }

  const blockLocalPlaybackInParallaxSinkMode = (): boolean => {
    if (!isParallaxSinkModeActive()) return false
    invalidateLoadRequest()
    pendingManualLoadCueTrack = null
    finalizeRecentPlaySession()
    return true
  }

  const isActiveLoadRequest = (requestId: number): boolean => {
    return requestId === activeLoadRequestId
  }

  const throwIfSupersededLoad = (requestId: number): void => {
    if (!isActiveLoadRequest(requestId)) {
      throw new SupersededPlaybackLoadError()
    }
  }

  const isSupersededPlaybackLoad = (error: unknown, requestId: number): boolean => {
    return error instanceof SupersededPlaybackLoadError
      || isSupersededAudioLoadError(error)
      || !isActiveLoadRequest(requestId)
  }

  const resolveInteractiveLoudnessForProgressiveLoad = async (
    track: Track,
    replayGainDb: number | null,
    loadRequestId: number
  ): Promise<{ loudnessLufs: number; peakLinear: number | null } | null> => {
    const request = requestTrackLoudnessAnalysis(track, replayGainDb, 'interactive')
    if (!request) return null

    set({ loadingStatus: 'Analyzing loudness' })
    try {
      const result = await request
      throwIfSupersededLoad(loadRequestId)
      return result
    } finally {
      if (isActiveLoadRequest(loadRequestId)) {
        set({ loadingStatus: null })
      }
    }
  }

  // Run _loadAndPlayTrack while serializing rapid presses against any in-flight load.
  // Bumps activeLoadRequestId so the in-flight load supersedes itself at its next
  // checkpoint, then awaits its completion before starting the new load. This stops
  // the native-side controlMutex pile-up that magnifies the freeze during rate changes.
  const runSerializedTrackLoad = async (
    track: Track,
    options?: { manualStart?: boolean }
  ): Promise<void> => {
    invalidateLoadRequest()
    const previous = currentSerializedLoad
    if (previous) {
      try {
        await previous
      } catch {
        // Superseded or failed loads are expected here; the next load will handle errors.
      }
    }

    const next = (async () => {
      try {
        const outcome = await get()._loadAndPlayTrack(track, options ?? {})
        if (outcome === 'failed' && track.sourceType && track.sourceType !== 'local') {
          markTrackUnavailableInState(track.path)
        }
      } catch (error) {
        if (!isSupersededAudioLoadError(error) && !(error instanceof SupersededPlaybackLoadError)) {
          throw error
        }
      }
    })()
    currentSerializedLoad = next
    try {
      await next
    } finally {
      if (currentSerializedLoad === next) {
        currentSerializedLoad = null
      }
    }
  }

  const beginPrebufferRequest = (): number => {
    activePrebufferRequestId += 1
    return activePrebufferRequestId
  }

  const isActivePrebufferRequest = (requestId: number): boolean => {
    return requestId === activePrebufferRequestId
  }

  const hydrateAssociatedCurrentTrackMetadata = (track: Track): void => {
    if (track.origin !== 'associated-external') {
      return
    }
    if (associatedMetadataInflight.has(track.path)) {
      return
    }

    associatedMetadataInflight.add(track.path)

    void window.electronAPI.getAudioMetadata(track.path)
      .then((metadata) => {
        if (!metadata) {
          return
        }

        const currentState = get()
        const activeTrack = currentState.currentTrack
        if (!activeTrack || activeTrack.path !== track.path || activeTrack.origin !== 'associated-external') {
          return
        }

        const nextTrack = mergeAssociatedTrackMetadata(activeTrack, metadata)
        set({
          currentTrack: nextTrack,
          duration: currentState.duration > 0 ? currentState.duration : nextTrack.duration
        })
      })
      .catch((error) => {
        console.warn(`Failed to hydrate metadata for associated track ${track.path}:`, error)
      })
      .finally(() => {
        associatedMetadataInflight.delete(track.path)
      })
  }

  const getRecentPlayThresholdSeconds = (track: Track | null): number => (
    getRecentPlayThresholdSecondsForDuration(track?.duration)
  )

  const createQueueItem = (
    entry: QueueTrackEntry,
    origin: QueueItemOrigin,
    options?: PlaybackContextOptions
  ): QueueItem => ({
    queueId: createQueueId(),
    entry,
    origin,
    sourcePlaylistId: origin === 'context' ? options?.sourcePlaylistId ?? null : null,
    sourceContext: origin === 'context' ? resolvePlaybackSourceContext(options) : null,
    contextLabel: origin === 'context'
      ? normalizeContextLabel(options?.contextLabel) ?? 'Current Selection'
      : null
  })

  const getCurrentPlaybackEntry = (
    state: Pick<PlayerStore, 'currentTrack' | 'currentQueueItemId' | 'queueItems'>
  ): PlaybackHistoryEntry | null => {
    if (!state.currentTrack) return null
    const activeItem = state.currentQueueItemId
      ? state.queueItems.find((item) => item.queueId === state.currentQueueItemId)
      : null
    return {
      item: activeItem ?? createQueueItem(createQueueEntryFromTrack(state.currentTrack), 'manual')
    }
  }

  const resolveSourcePlaylistIdForState = (
    state: Pick<PlayerStore, 'currentQueueItemId' | 'queueItems'>
  ): number | null => {
    if (!state.currentQueueItemId) return null
    return state.queueItems.find((item) => item.queueId === state.currentQueueItemId)?.sourcePlaylistId ?? null
  }

  const getListeningHistoryStatus = (): Promise<ListeningHistoryStatus> => {
    if (!listeningHistoryStatusPromise) {
      listeningHistoryStatusPromise = window.electronAPI.library.getListeningHistoryStatus()
        .catch((error: unknown) => {
          listeningHistoryStatusPromise = null
          throw error
        })
    }
    return listeningHistoryStatusPromise
  }

  const restartDetailedSession = (session: RecentPlaySession, status: ListeningHistoryStatus): void => {
    const wallNow = Date.now()
    session.generation = status.generation
    session.accumulatedSeconds = 0
    session.lastAccumulatedAtMs = get().playbackState === 'playing' ? performance.now() : null
    session.qualificationEligible = !session.counted
    session.sessionKey = createListeningHistoryKey('session')
    session.sessionStartedAt = wallNow
    session.segmentKey = createListeningHistoryKey('segment')
    session.segmentStartedAt = wallNow
    session.segmentStartAccumulatedSeconds = session.accumulatedSeconds
    session.lastCheckpointAccumulatedSeconds = session.accumulatedSeconds
  }

  const checkpointRecentPlay = (
    session: RecentPlaySession,
    options: {
      finalizeSegment?: boolean
      finalizeSession?: boolean
      completedNaturally?: boolean
      observedAt?: number
    } = {}
  ): void => {
    if (!session.allowDbWrite) return
    const observedAt = options.observedAt ?? Date.now()
    const sessionListenedSeconds = session.accumulatedSeconds
    const segmentListenedSeconds = Math.max(0, sessionListenedSeconds - session.segmentStartAccumulatedSeconds)
    const checkpointSessionKey = session.sessionKey
    const checkpointSegmentKey = session.segmentKey

    void (async () => {
      try {
        const status = session.generation
          ? { generation: session.generation, startedAt: null }
          : await getListeningHistoryStatus()
        if (!session.generation) session.generation = status.generation
        const result = await window.electronAPI.library.checkpointListeningSession({
          generation: status.generation,
          sessionKey: checkpointSessionKey,
          segmentKey: checkpointSegmentKey,
          trackPath: session.trackPath,
          sourcePlaylistId: session.sourcePlaylistId,
          sessionStartedAt: session.sessionStartedAt,
          segmentStartedAt: session.segmentStartedAt,
          observedAt,
          sessionListenedSeconds,
          segmentListenedSeconds,
          trackDurationSeconds: session.trackDurationSeconds,
          qualificationEligible: session.qualificationEligible,
          finalizeSegment: Boolean(options.finalizeSegment),
          finalizeSession: Boolean(options.finalizeSession),
          completedNaturally: Boolean(options.completedNaturally)
        })
        if (!result.accepted) {
          listeningHistoryStatusPromise = Promise.resolve(result.status)
          if (recentPlaySession === session && session.generation === status.generation) {
            if (result.status.generation !== status.generation) {
              restartDetailedSession(session, result.status)
            } else {
              session.allowDbWrite = false
            }
          }
          return
        }
        if (session.sessionKey === checkpointSessionKey && session.generation === status.generation) {
          session.lastCheckpointAccumulatedSeconds = Math.max(
            session.lastCheckpointAccumulatedSeconds,
            sessionListenedSeconds
          )
        }
        if (result.qualifiedNow) {
          session.counted = true
          session.qualificationEligible = false
          await Promise.all([
            useLibraryStore.getState().loadRecentlyPlayed(),
            usePlaylistStore.getState().loadPlaylists()
          ])
        }
        if (typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new Event('astra:listening-history-checkpoint'))
        }
      } catch (error) {
        console.warn('Failed to checkpoint listening history:', error)
      }
    })()
  }

  const updateRecentPlayAccumulation = (
    playbackState: PlaybackState,
    nowMs: number = performance.now()
  ): RecentPlaySession | null => {
    if (!recentPlaySession) return recentPlaySession

    const next = advanceRecentPlayAccumulation(recentPlaySession, playbackState, nowMs)
    recentPlaySession.accumulatedSeconds = next.accumulatedSeconds
    recentPlaySession.lastAccumulatedAtMs = next.lastAccumulatedAtMs
    return recentPlaySession
  }

  const maybeCommitRecentPlay = (
    playbackState: PlaybackState = get().playbackState,
    nowMs: number = performance.now()
  ): void => {
    const session = updateRecentPlayAccumulation(playbackState, nowMs)
    if (!session) return
    if (
      (!session.counted && session.accumulatedSeconds >= session.thresholdSeconds)
      || session.accumulatedSeconds - session.lastCheckpointAccumulatedSeconds >= LISTENING_HISTORY_CHECKPOINT_SECONDS
    ) checkpointRecentPlay(session)
  }

  const finalizeRecentPlaySession = (
    playbackState: PlaybackState = get().playbackState,
    options: { completedNaturally?: boolean } = {}
  ): void => {
    const session = updateRecentPlayAccumulation(playbackState)
    if (!session) return
    checkpointRecentPlay(session, {
      finalizeSegment: true,
      finalizeSession: true,
      completedNaturally: Boolean(options.completedNaturally)
    })
    recentPlaySession = null
  }

  const startRecentPlaySession = (trackPath: string): void => {
    if (recentPlaySession?.trackPath === trackPath) {
      const state = get()
      const duration = resolvePositiveDuration(state.currentTrack?.duration, state.duration)
      recentPlaySession.trackDurationSeconds = Math.max(recentPlaySession.trackDurationSeconds, duration)
      recentPlaySession.thresholdSeconds = getRecentPlayThresholdSecondsForDuration(duration)
      return
    }
    finalizeRecentPlaySession()
    const state = get()
    const track = state.currentTrack
    const thresholdSeconds = getRecentPlayThresholdSeconds(track)
    const wallNow = Date.now()
    recentPlaySession = {
      trackPath,
      thresholdSeconds,
      accumulatedSeconds: 0,
      lastAccumulatedAtMs: state.playbackState === 'playing' ? performance.now() : null,
      counted: false,
      allowDbWrite: track?.origin !== 'associated-external',
      sourcePlaylistId: resolveSourcePlaylistIdForState(state),
      generation: null,
      sessionKey: createListeningHistoryKey('session'),
      sessionStartedAt: wallNow,
      segmentKey: createListeningHistoryKey('segment'),
      segmentStartedAt: wallNow,
      segmentStartAccumulatedSeconds: 0,
      lastCheckpointAccumulatedSeconds: 0,
      trackDurationSeconds: resolvePositiveDuration(track?.duration, state.duration),
      qualificationEligible: true
    }
    const session = recentPlaySession
    if (session.allowDbWrite) {
      void getListeningHistoryStatus().then((status) => {
        if (recentPlaySession === session && session.generation === null) session.generation = status.generation
      }).catch(() => undefined)
    }
  }

  const showFfmpegFallbackNotice = (track: Track) => {
    ffmpegFallbackNoticeId += 1
    set({
      ffmpegFallbackNotice: {
        id: ffmpegFallbackNoticeId,
        trackPath: track.path,
        title: track.title,
        artist: track.artist
      }
    })
  }

  const showOutputDelayNotice = (track: Track) => {
    const audioSettingsState = useAudioSettingsStore.getState()
    const delayMs = Math.round(audioSettingsState.effectiveDelayMs)
    if (delayMs < OUTPUT_DELAY_NOTICE_THRESHOLD_MS) return

    const outputLabel = resolveOutputDeviceLabel(
      audioSettingsState.selectedDeviceId,
      audioSettingsState.availableDevices,
      {
        defaultRouteFallbackLabel: 'System Default Output',
        selectedFallbackLabel: 'Selected Output'
      }
    ).label

    outputDelayNoticeId += 1
    set({
      outputDelayNotice: {
        id: outputDelayNoticeId,
        trackPath: track.path,
        title: track.title,
        artist: track.artist,
        delayMs,
        outputLabel
      }
    })
  }

  const markTrackUnavailableInState = (trackPath: string, reason: string = 'source_unavailable'): void => {
    set((state) => ({
      queueItems: state.queueItems.map((item) => ({
        ...item,
        entry: updateQueueEntryAvailability(item.entry, trackPath, reason)
      })),
      playbackHistory: state.playbackHistory.map((entry) => (
        entry.item.entry.path === trackPath
          ? {
              ...entry,
              item: {
                ...entry.item,
                entry: updateQueueEntryAvailability(entry.item.entry, trackPath, reason)
              }
            }
          : entry
      )),
      currentTrack: state.currentTrack && state.currentTrack.path === trackPath
        ? { ...state.currentTrack, isAvailable: false, availabilityReason: reason }
        : state.currentTrack
    }))
  }

  const buildResolvedUpcomingEntries = (
    state: Pick<PlayerStore, 'queueItems' | 'upcomingQueueIds'>
  ): ResolvedQueueTrack[] => {
    const itemsById = new Map(state.queueItems.map((item) => [item.queueId, item]))
    const resolved: ResolvedQueueTrack[] = []
    state.upcomingQueueIds.forEach((queueId, index) => {
      const item = itemsById.get(queueId)
      const track = resolveQueueEntryTrack(item?.entry)
      if (!item || !track) return
      if (!track) return
      resolved.push({
        queueId,
        source: 'upcoming',
        origin: item.origin,
        track,
        index
      })
    })

    return resolved
  }

  const collectNextCandidates = (state: PlayerStore): NextCandidate[] => {
    if (state.repeat === 'one' && state.currentTrack) {
      return [{ kind: 'current', track: state.currentTrack }]
    }

    const itemsById = new Map(state.queueItems.map((item) => [item.queueId, item]))
    const candidates: NextCandidate[] = []
    state.upcomingQueueIds.forEach((queueId, index) => {
      const item = itemsById.get(queueId)
      const track = resolveQueueEntryTrack(item?.entry)
      if (!item || !track) return
      candidates.push({ kind: 'queue', item, track, index })
    })

    if (candidates.length === 0 && state.repeat === 'all' && state.currentTrack) {
      const currentItem = state.currentQueueItemId
        ? itemsById.get(state.currentQueueItemId)
        : null
      if (currentItem && state.queueItems.length === 1) {
        candidates.push({ kind: 'current', track: state.currentTrack })
      }
    }

    return candidates
  }

  const findNextPlayableCandidate = (state: PlayerStore): NextCandidate | null => {
    const candidates = collectNextCandidates(state)
    for (const candidate of candidates) {
      if (isUnavailableRemoteTrack(candidate.track)) continue
      return candidate
    }
    return null
  }

  const resolveExpectedPrebufferTrackPath = (state: PlayerStore = get()): string | null => {
    if (state.repeat === 'one') return null

    for (const candidate of collectNextCandidates(state)) {
      const candidateTrack = candidate.track
      if (!candidateTrack) continue
      if (candidateTrack.sourceType && candidateTrack.sourceType !== 'local') continue
      if (isUnavailableRemoteTrack(candidateTrack)) continue
      return candidateTrack.path
    }

    return null
  }

  const warmupUpcomingLoudness = (): void => {
    const audioSettings = useAudioSettingsStore.getState()
    if (!audioSettings.normalizationEnabled || audioSettings.playbackOutputMode !== 'standard') return

    const warmed = new Set<string>()
    for (const candidate of collectNextCandidates(get())) {
      if (warmed.size >= LOUDNESS_WARMUP_UPCOMING_TRACKS) break
      const track = candidate.track
      if (!track || (track.sourceType && track.sourceType !== 'local')) continue
      if (isUnavailableRemoteTrack(track) || warmed.has(track.path)) continue

      const replayGainDb = getReplayGainCandidateDb(track, audioSettings.replayGainMode)
      const request = requestTrackLoudnessAnalysis(track, replayGainDb, 'background')
      if (!request) continue
      warmed.add(track.path)
      void request
    }
  }

  const schedulePreBufferNextTrack = (options: { invalidatePending?: boolean } = {}): void => {
    if (options.invalidatePending) {
      clearScheduledPrebufferTimer()
      invalidatePrebufferRequest()
    }

    if (isParallaxSinkModeActive()) {
      clearBufferedNextTrack()
      return
    }

    const state = get()
    const expectedTrackPath = resolveExpectedPrebufferTrackPath(state)

    if (
      useAudioSettingsStore.getState().disableGaplessPrebufferDev
      || !state.currentTrack
      || state.repeat === 'one'
      || !expectedTrackPath
      || (state.currentTrack.sourceType && state.currentTrack.sourceType !== 'local')
    ) {
      clearScheduledPrebufferTimer()
      if (audioEngine.hasNextBuffered) {
        clearBufferedNextTrack()
      } else if (prebufferInFlightTrackPath !== null) {
        clearBufferedNextTrack()
      }
      return
    }

    const bufferedTrackPath = audioEngine.nextBufferedTrackPath
    if (bufferedTrackPath !== null && bufferedTrackPath !== expectedTrackPath) {
      clearBufferedNextTrack()
    } else if (bufferedTrackPath === null && audioEngine.hasNextBuffered) {
      clearBufferedNextTrack()
    } else if (prebufferInFlightTrackPath !== null && prebufferInFlightTrackPath !== expectedTrackPath) {
      clearBufferedNextTrack()
    }

    const duration = audioEngine.duration > 0 ? audioEngine.duration : state.duration
    const currentTime = Number.isFinite(audioEngine.currentTime) ? audioEngine.currentTime : state.currentTime
    const delayMs = getGaplessPrebufferDelayMs(currentTime, duration)

    if (delayMs > 0) {
      if (
        audioEngine.nextBufferedTrackPath === expectedTrackPath
        || prebufferInFlightTrackPath === expectedTrackPath
      ) {
        clearBufferedNextTrack()
      }
      if (prebufferAttemptedTrackPath === expectedTrackPath) {
        prebufferAttemptedTrackPath = null
      }

      if (state.playbackState !== 'playing') {
        clearScheduledPrebufferTimer()
        return
      }

      const dueAtMs = performance.now() + delayMs
      if (
        prebufferScheduleTimerId !== null
        && prebufferScheduleTrackPath === expectedTrackPath
        && prebufferScheduleDueAtMs !== null
        && Math.abs(prebufferScheduleDueAtMs - dueAtMs) <= GAPLESS_PREBUFFER_TIMER_TOLERANCE_MS
      ) {
        return
      }

      clearScheduledPrebufferTimer()
      prebufferScheduleTrackPath = expectedTrackPath
      prebufferScheduleDueAtMs = dueAtMs
      prebufferScheduleTimerId = globalThis.setTimeout(() => {
        prebufferScheduleTimerId = null
        prebufferScheduleDueAtMs = null
        prebufferScheduleTrackPath = null
        schedulePreBufferNextTrack()
      }, delayMs)
      return
    }

    if (state.playbackState !== 'playing') {
      clearScheduledPrebufferTimer()
      return
    }

    clearScheduledPrebufferTimer()
    if (audioEngine.nextBufferedTrackPath === expectedTrackPath) return
    if (prebufferInFlightTrackPath === expectedTrackPath && prebufferInFlightRequestId !== null) return
    if (prebufferAttemptedTrackPath === expectedTrackPath) return

    void get()._preBufferNextTrack()
  }

  const applyCandidateTransition = (
    state: PlayerStore,
    candidate: NextCandidate,
    options: { pushCurrentToHistory: boolean }
  ) => {
    const currentEntry = getCurrentPlaybackEntry(state)
    const nextHistory = options.pushCurrentToHistory && currentEntry && candidate.kind !== 'current'
      ? [...state.playbackHistory, currentEntry].slice(-MAX_PLAYBACK_HISTORY)
      : state.playbackHistory

    if (candidate.kind === 'current') {
      return { playbackHistory: nextHistory }
    }

    let nextBaseIds = state.baseUpcomingQueueIds.filter((queueId) => queueId !== candidate.item.queueId)
    let nextUpcomingIds = state.upcomingQueueIds.filter((queueId) => queueId !== candidate.item.queueId)
    if (nextUpcomingIds.length === 0 && state.repeat === 'all') {
      nextBaseIds = state.queueItems
        .map((item) => item.queueId)
        .filter((queueId) => queueId !== candidate.item.queueId)
      nextUpcomingIds = state.shuffle ? shuffleQueueIds(nextBaseIds) : [...nextBaseIds]
    }

    return {
      playbackHistory: nextHistory,
      baseUpcomingQueueIds: nextBaseIds,
      upcomingQueueIds: nextUpcomingIds,
      currentQueueItemId: candidate.item.queueId,
      currentTrackSource: candidate.item.origin
    }
  }

  const startPlaybackContextEntries = async (
    entries: QueueTrackEntry[],
    startIndex = 0,
    options?: PlaybackContextOptions
  ): Promise<void> => {
    if (blockLocalPlaybackInParallaxSinkMode()) return

    const state = get()
    const normalizedStartIndex = entries.length === 0
      ? -1
      : Math.max(0, Math.min(entries.length - 1, Math.floor(startIndex)))
    const nextShuffle = options?.shuffle ?? state.shuffle
    const playbackStartIndex = options?.startShuffled && nextShuffle
      ? getShuffledStartIndex(entries.length, normalizedStartIndex)
      : normalizedStartIndex
    const currentEntry = getCurrentPlaybackEntry(state)

    if (playbackStartIndex < 0) {
      clearBufferedNextTrack()
      return
    }

    const contextItems = entries.map((entry) => createQueueItem(entry, 'context', options))
    const currentItem = contextItems[playbackStartIndex]
    const itemsById = new Map(state.queueItems.map((item) => [item.queueId, item]))
    const manualItems = state.upcomingQueueIds
      .map((queueId) => itemsById.get(queueId))
      .filter((item): item is QueueItem => item?.origin === 'manual')
    const queueItems = [
      ...contextItems.slice(0, playbackStartIndex + 1),
      ...manualItems,
      ...contextItems.slice(playbackStartIndex + 1)
    ]
    const baseUpcomingQueueIds = nextShuffle
      ? queueItems.map((item) => item.queueId).filter((queueId) => queueId !== currentItem.queueId)
      : [
          ...manualItems.map((item) => item.queueId),
          ...contextItems.slice(playbackStartIndex + 1).map((item) => item.queueId)
        ]
    const upcomingQueueIds = nextShuffle
      ? shuffleQueueIds(baseUpcomingQueueIds)
      : [...baseUpcomingQueueIds]

    set({
      queueItems,
      baseUpcomingQueueIds,
      upcomingQueueIds,
      currentQueueItemId: currentItem.queueId,
      queueSourcePlaylistId: options?.sourcePlaylistId ?? null,
      queueSourceContext: resolvePlaybackSourceContext(options),
      queueContextLabel: normalizeContextLabel(options?.contextLabel) ?? 'Current Selection',
      shuffle: nextShuffle,
      playbackHistory: currentEntry ? [...state.playbackHistory, currentEntry].slice(-MAX_PLAYBACK_HISTORY) : state.playbackHistory,
      currentTrackSource: 'context',
      restoredTrackNeedsLoad: false,
      restoredPlaybackTime: null
    })

    const targetTrack = resolveQueueEntryTrack(currentItem.entry)
    if (!targetTrack || isUnavailableRemoteTrack(targetTrack)) return

    const loaded = await get()._loadAndPlayTrack(targetTrack, { manualStart: true })
    if (loaded === 'failed' && targetTrack.sourceType && targetTrack.sourceType !== 'local') {
      markTrackUnavailableInState(targetTrack.path)
    }
  }

  const enqueueEntries = (entries: QueueTrackEntry[], position: number | 'next' | 'end' = 'end'): void => {
    if (entries.length === 0) return

    const state = get()
    const items = entries.map((entry) => createQueueItem(entry, 'manual'))
    const insertionIndex = position === 'next'
      ? 0
      : position === 'end'
        ? state.upcomingQueueIds.length
        : clampQueuePosition(position, state.upcomingQueueIds.length)
    const itemIds = items.map((item) => item.queueId)
    const baseUpcomingQueueIds = [...state.baseUpcomingQueueIds]
    const upcomingQueueIds = [...state.upcomingQueueIds]
    baseUpcomingQueueIds.splice(insertionIndex, 0, ...itemIds)
    upcomingQueueIds.splice(insertionIndex, 0, ...itemIds)

    const queueItems = [...state.queueItems]
    const targetQueueId = state.upcomingQueueIds[insertionIndex]
    const currentIndex = state.currentQueueItemId
      ? queueItems.findIndex((item) => item.queueId === state.currentQueueItemId)
      : -1
    const targetIndex = targetQueueId
      ? queueItems.findIndex((item) => item.queueId === targetQueueId)
      : -1
    const canonicalInsertionIndex = position === 'next' && currentIndex >= 0
      ? currentIndex + 1
      : targetIndex >= 0
        ? targetIndex
        : queueItems.length
    queueItems.splice(canonicalInsertionIndex, 0, ...items)

    set({ queueItems, baseUpcomingQueueIds, upcomingQueueIds })
    clearBufferedNextTrack()
    schedulePreBufferNextTrack()
  }

  const seekLoadedTrackBeforePlay = async (track: Track, requestedTime: number | null | undefined): Promise<void> => {
    if (!Number.isFinite(requestedTime) || !requestedTime || requestedTime <= 0) return
    if (track.sourceType && track.sourceType !== 'local') return

    const resolvedDuration = resolvePositiveDuration(audioEngine.duration, track.duration)
    const targetTime = resolvedDuration > 0
      ? Math.min(Math.max(0, requestedTime), resolvedDuration)
      : Math.max(0, requestedTime)
    if (targetTime <= 0) return

    await audioEngine.seek(targetTime)
    set({ currentTime: targetTime })
  }

  return {
    // Initial state
    currentTrack: null,
    currentTrackSource: 'standalone',
    playbackState: 'stopped',
    currentTime: 0,
    duration: 0,
    volume: initialPlayerVolume,
    isMuted: false,
    waveformData: null,
    waveformBufferedRatio: 1,
    waveformAnalyzedRatio: 1,
    remoteLoadProgress: null,
    loadingStatus: null,
    remoteBufferedSeconds: 0,
    remoteStreamSessionId: null,
    ffmpegFallbackNotice: null,
    outputDelayNotice: null,
    associatedOpenNotice: null,
    restoredTrackNeedsLoad: false,
    restoredPlaybackTime: null,

    // Queue state
    queueItems: [],
    baseUpcomingQueueIds: [],
    upcomingQueueIds: [],
    currentQueueItemId: null,
    queueSourcePlaylistId: null,
    queueSourceContext: null,
    queueContextLabel: null,
    shuffle: false,
    repeat: 'none',
    playbackHistory: [],

    // Load a track
    loadTrack: async (track: Track, audioData: ArrayBuffer) => {
      if (blockLocalPlaybackInParallaxSinkMode()) return false

      const loadStart = performance.now()
      const loadRequestId = beginLoadRequest()
      pendingManualLoadCueTrack = null
      // Initialize listeners on first load
      if (!listenersInitialized) {
        get()._initListeners()
      }

      finalizeRecentPlaySession()
      set({
        currentTrack: track,
        currentTrackSource: 'standalone',
        currentQueueItemId: null,
        playbackState: 'loading',
        waveformData: null,
        waveformBufferedRatio: 1,
        waveformAnalyzedRatio: 1,
        remoteLoadProgress: null,
        loadingStatus: null,
        remoteBufferedSeconds: 0,
        remoteStreamSessionId: null,
        currentTime: 0,
        duration: track.duration,
        restoredTrackNeedsLoad: false,
        restoredPlaybackTime: null
      })
      startRecentPlaySession(track.path)
      const loadListeningSession = recentPlaySession

      try {
        await ensureCompatiblePlaybackMode(track)
        throwIfSupersededLoad(loadRequestId)
        let usedFfmpegFallback = false
        const decodeStart = performance.now()
        if (shouldUseBitPerfectPath(track)) {
          const replayGainDb = getReplayGainCandidateDb(track, useAudioSettingsStore.getState().replayGainMode)
          audioEngine.setCurrentReplayGainDb(replayGainDb)
          const result = await audioEngine.loadTrackFromPath(track)
          throwIfSupersededLoad(loadRequestId)
          const decodeMs = Math.round(performance.now() - decodeStart)
          const resolvedTrack: Track = {
            ...track,
            duration: result.duration > 0 ? result.duration : track.duration,
            channels: result.channels ?? track.channels
          }
          set({
            duration: result.duration > 0 ? result.duration : track.duration,
            currentTrack: resolvedTrack,
            currentTrackSource: 'standalone',
            currentQueueItemId: null,
            remoteLoadProgress: null,
            loadingStatus: null,
            remoteBufferedSeconds: 0,
            remoteStreamSessionId: null,
            waveformBufferedRatio: 1,
            waveformAnalyzedRatio: 1,
            currentTime: 0,
            restoredTrackNeedsLoad: false,
            restoredPlaybackTime: null
          })
          hydrateAssociatedCurrentTrackMetadata(resolvedTrack)
          pendingManualLoadCueTrack = resolvedTrack
          schedulePreBufferNextTrack()
          warmupUpcomingLoudness()
          logSlowPath('loadTrack', loadStart, {
            trackPath: track.path,
            usedNativeBitPerfect: true,
            decodeMs
          })
          return true
        }

        const replayGainDb = getReplayGainCandidateDb(track, useAudioSettingsStore.getState().replayGainMode)
        const loudnessAnalysis = requestTrackLoudnessAnalysis(track, replayGainDb)
        try {
          await audioEngine.loadAudioData(audioData, { replayGainDb, trackPath: track.path, loudnessAnalysis })
          throwIfSupersededLoad(loadRequestId)
        } catch (primaryDecodeError) {
          if (isSupersededPlaybackLoad(primaryDecodeError, loadRequestId)) {
            throw primaryDecodeError
          }
          // ffmpeg 6.0 cannot decode IAMF; the fallback would fail anyway.
          if (isIamfTrack(track)) {
            throw primaryDecodeError
          }
          const fallbackData = await window.electronAPI.decodeAudioWithFfmpeg(track.path)
          throwIfSupersededLoad(loadRequestId)
          if (!fallbackData) {
            throw primaryDecodeError
          }

          usedFfmpegFallback = true
          console.warn(`Primary decode failed for ${track.path}; using FFmpeg compatibility decode.`)
          await audioEngine.loadAudioData(fallbackData, { replayGainDb, trackPath: track.path, loudnessAnalysis })
          throwIfSupersededLoad(loadRequestId)
        }
        const decodeMs = Math.round(performance.now() - decodeStart)
        const detectedChannels = audioEngine.getCurrentTrackChannelCount()
        const resolvedDuration = resolvePositiveDuration(audioEngine.duration, track.duration)
        const resolvedTrack: Track = {
          ...track,
          duration: resolvedDuration,
          channels: detectedChannels ?? track.channels
        }
        set({
          duration: resolvedDuration,
          currentTrack: resolvedTrack,
          currentTrackSource: 'standalone',
          currentQueueItemId: null,
          remoteLoadProgress: null,
          loadingStatus: null,
          remoteBufferedSeconds: 0,
          remoteStreamSessionId: null,
          waveformBufferedRatio: 1,
          waveformAnalyzedRatio: 1,
          currentTime: 0,
          restoredTrackNeedsLoad: false,
          restoredPlaybackTime: null
        })
        hydrateAssociatedCurrentTrackMetadata(resolvedTrack)
        if (usedFfmpegFallback) {
          showFfmpegFallbackNotice(resolvedTrack)
        }
        pendingManualLoadCueTrack = resolvedTrack

        // Schedule next-track prebuffering for the gapless handoff window.
        schedulePreBufferNextTrack()
        warmupUpcomingLoudness()
        const engineTimings = audioEngine.getLastLoadTimings()
        logSlowPath('loadTrack', loadStart, {
          trackPath: track.path,
          usedFfmpegFallback,
          decodeMs,
          decodeOnlyMs: engineTimings?.decodeMs ?? null,
          loudnessAnalysisMs: engineTimings?.analysisMs ?? null
        })
        return true
      } catch (error) {
        if (isSupersededPlaybackLoad(error, loadRequestId)) {
          return false
        }
        if (recentPlaySession === loadListeningSession) finalizeRecentPlaySession()
        console.error('Failed to load track:', error)
        logSlowPath('loadTrack', loadStart, {
          trackPath: track.path,
          failed: true
        })
        set({
          playbackState: 'stopped',
          remoteLoadProgress: null,
          loadingStatus: null,
          remoteBufferedSeconds: 0,
          remoteStreamSessionId: null
        })
        pendingManualLoadCueTrack = null
        return false
      }
    },

    loadTrackFromPath: async (track: Track) => {
      set({ currentTrackSource: 'manual' })
      const outcome = await get()._loadAndPlayTrack(track, { manualStart: true })
      return outcome === 'loaded'
    },

    // Playback controls
    play: async () => {
      if (blockLocalPlaybackInParallaxSinkMode()) return

      const state = get()
      if (state.currentTrack && state.restoredTrackNeedsLoad) {
        const track = state.currentTrack
        const startTime = state.restoredPlaybackTime ?? state.currentTime
        set({
          restoredTrackNeedsLoad: false,
          restoredPlaybackTime: null
        })
        const loaded = await get()._loadAndPlayTrack(track, { manualStart: true, startTime })
        if (loaded === 'failed' && track.sourceType && track.sourceType !== 'local') {
          markTrackUnavailableInState(track.path)
        }
        return
      }

      if (!state.currentTrack) {
        const candidate = findNextPlayableCandidate(state)
        if (!candidate || candidate.kind === 'current') return

        set(applyCandidateTransition(state, candidate, {
          pushCurrentToHistory: false
        }))

        const loaded = await get()._loadAndPlayTrack(candidate.track, { manualStart: true })
        if (loaded === 'failed' && candidate.track.sourceType && candidate.track.sourceType !== 'local') {
          markTrackUnavailableInState(candidate.track.path)
        }
        return
      }

      const previousPlaybackState = state.playbackState
      // After a terminal stop the engine has released its decoded buffer
      // (and any remote session), so restarting requires a full reload.
      const needsReloadFromStopped = previousPlaybackState === 'stopped' && (
        state.currentTrack.sourceType && state.currentTrack.sourceType !== 'local'
          ? state.remoteStreamSessionId === null
          : audioEngine.getPlaybackOutputMode() === 'standard' && !audioEngine.hasDecodedAudioBuffer()
      )
      if (needsReloadFromStopped) {
        const reloaded = await get()._loadAndPlayTrack(state.currentTrack, { manualStart: true })
        if (reloaded === 'failed') {
          markTrackUnavailableInState(state.currentTrack.path)
        }
        return
      }
      if (pendingManualLoadCueTrack) {
        showOutputDelayNotice(pendingManualLoadCueTrack)
        pendingManualLoadCueTrack = null
      }
      await playWithParallaxIfNeeded(get().currentTrack)
      const currentTrack = get().currentTrack
      if ((previousPlaybackState === 'loading' || previousPlaybackState === 'stopped') && currentTrack) {
        void useLibraryStore.getState().markTrackLatestSyncSeen(currentTrack.path)
        startRecentPlaySession(currentTrack.path)
      }
    },

    pause: () => {
      if (blockLocalPlaybackInParallaxSinkMode()) return
      audioEngine.pause()
      void useParallaxStore.getState().pauseHostPlayback()
    },

    togglePlay: async () => {
      if (blockLocalPlaybackInParallaxSinkMode()) return

      const state = get()
      if (!state.currentTrack || state.playbackState === 'stopped' || state.restoredTrackNeedsLoad) {
        await get().play()
        return
      }
      if (state.playbackState === 'playing') {
        get().pause()
        return
      }
      await get().play()
    },

    stop: () => {
      if (blockLocalPlaybackInParallaxSinkMode()) return
      void useParallaxStore.getState().stopHostPlayback()
      invalidateLoadRequest()
      pendingManualLoadCueTrack = null
      finalizeRecentPlaySession()
      set({
        remoteBufferedSeconds: 0,
        loadingStatus: null,
        remoteStreamSessionId: null,
        restoredTrackNeedsLoad: false,
        restoredPlaybackTime: null
      })
      audioEngine.stop()
    },

    replaceLocalTrackPaths: async (replacements) => {
      const replacementEntries = Object.entries(replacements).filter(([fromPath, toPath]) => (
        typeof fromPath === 'string'
        && fromPath.length > 0
        && typeof toPath === 'string'
        && toPath.length > 0
        && fromPath !== toPath
      ))
      if (replacementEntries.length === 0) return
      const replacementByPath = new Map(replacementEntries)
      const keepPaths = Array.from(new Set(replacementEntries.map(([, keepPath]) => keepPath)))
      const resolvedKeepTracks = await useLibraryStore.getState().resolveTrackPathsWithFetch(keepPaths)
      const keepTrackByPath = new Map(resolvedKeepTracks.map((track) => {
        const playerTrack = dbTrackToTrack(track)
        return [playerTrack.path, playerTrack]
      }))
      const remapEntry = (entry: QueueTrackEntry): QueueTrackEntry => {
        const keepPath = replacementByPath.get(entry.path)
        if (!keepPath) return entry
        const keepTrack = keepTrackByPath.get(keepPath)
        return keepTrack ? createQueueEntryFromTrack(keepTrack) : createQueueEntryFromPath(keepPath)
      }

      set((state) => {
        const currentKeepPath = state.currentTrack ? replacementByPath.get(state.currentTrack.path) : undefined
        const currentKeepTrack = currentKeepPath ? keepTrackByPath.get(currentKeepPath) : undefined
        return {
          queueItems: state.queueItems.map((item) => ({ ...item, entry: remapEntry(item.entry) })),
          playbackHistory: state.playbackHistory.map((entry) => ({
            ...entry,
            item: { ...entry.item, entry: remapEntry(entry.item.entry) }
          })),
          currentTrack: currentKeepTrack && state.playbackState === 'stopped'
            ? currentKeepTrack
            : state.currentTrack
        }
      })
      clearBufferedNextTrack()
      schedulePreBufferNextTrack()
    },

    seek: async (time: number) => {
      if (blockLocalPlaybackInParallaxSinkMode()) return

      // §21 Gapless sink handoff — a seek moves the current track's boundary, invalidating the
      // pre-announced next stream's scheduled crossover. Withdraw it; this boundary falls back to the
      // Phase-1 sink follow.
      void useParallaxStore.getState().cancelHostNextStream()

      const state = get()
      if (state.restoredTrackNeedsLoad) {
        const duration = resolvePositiveDuration(state.duration, state.currentTrack?.duration)
        const targetTime = duration > 0
          ? Math.min(Math.max(0, time), duration)
          : Math.max(0, time)
        set({
          currentTime: targetTime,
          restoredPlaybackTime: targetTime
        })
        return
      }
      const seekTime = state.currentTrack?.sourceType && state.currentTrack.sourceType !== 'local'
        ? Math.max(0, Math.min(time, state.remoteBufferedSeconds))
        : time
      const parallaxSeekTimeline = await useParallaxStore.getState().prepareHostSeek(
        seekTime,
        state.playbackState === 'playing'
      )
      if (parallaxSeekTimeline && state.playbackState === 'playing') {
        await audioEngine.playCurrentBufferOnParallaxTimeline(parallaxSeekTimeline)
        return
      }
      await audioEngine.seek(seekTime)
    },

    // Volume controls
    setVolume: (volume: number) => {
      const normalized = clampPlayerVolume(volume)
      audioEngine.setMuted(false)
      audioEngine.setVolume(normalized)
      set({ volume: normalized, isMuted: false })
      persistPlayerVolume(normalized)
    },

    toggleMute: () => {
      audioEngine.toggleMute()
      set({ isMuted: audioEngine.isMuted })
    },

    resetAudioPreferences: () => {
      clearSavedPlayerVolume()
      audioEngine.setVolume(DEFAULT_PLAYER_VOLUME)
      audioEngine.setMuted(false)
      set({ volume: DEFAULT_PLAYER_VOLUME, isMuted: false })
    },

    // Queue actions
    startPlaybackContext: async (tracks: Track[], startIndex = 0, options) => {
      if (blockLocalPlaybackInParallaxSinkMode()) return
      await startPlaybackContextEntries(createQueueEntriesFromTracks(tracks), startIndex, options)
    },

    startPlaybackContextByPaths: async (paths: string[], startIndex = 0, options) => {
      if (blockLocalPlaybackInParallaxSinkMode()) return
      await startPlaybackContextEntries(await createQueueEntriesFromPathsWithFetch(paths), startIndex, options)
    },

    enqueueTrack: (track: Track, position = 'end') => {
      get().enqueueTracks([track], position)
    },

    enqueueTracks: (tracks: Track[], position = 'end') => {
      enqueueEntries(createQueueEntriesFromTracks(tracks), position)
    },

    enqueueTrackPaths: async (paths: string[], position = 'end') => {
      enqueueEntries(await createQueueEntriesFromPathsWithFetch(paths), position)
    },

    moveUpcomingItem: (queueId: string, toIndex: number) => {
      const state = get()
      if (!state.upcomingQueueIds.includes(queueId)) return

      const upcomingQueueIds = moveQueueId(state.upcomingQueueIds, queueId, toIndex)
      const baseUpcomingQueueIds = moveQueueId(state.baseUpcomingQueueIds, queueId, toIndex)
      const canonicalIds = moveQueueIdRelativeToVisibleOrder(
        state.queueItems.map((item) => item.queueId),
        queueId,
        baseUpcomingQueueIds
      )
      const itemById = new Map(state.queueItems.map((item) => [item.queueId, item]))
      set({
        upcomingQueueIds,
        baseUpcomingQueueIds,
        queueItems: canonicalIds.map((id) => itemById.get(id)).filter((item): item is QueueItem => Boolean(item))
      })

      clearBufferedNextTrack()
      schedulePreBufferNextTrack()
    },

    removeUpcomingItem: (queueId: string) => {
      const state = get()
      if (!state.upcomingQueueIds.includes(queueId)) return

      set({
        queueItems: state.queueItems.filter((item) => item.queueId !== queueId),
        baseUpcomingQueueIds: state.baseUpcomingQueueIds.filter((id) => id !== queueId),
        upcomingQueueIds: state.upcomingQueueIds.filter((id) => id !== queueId)
      })

      clearBufferedNextTrack()
      schedulePreBufferNextTrack()
    },

    clearAllQueues: () => {
      clearBufferedNextTrack()
      const state = get()
      const currentItem = state.currentQueueItemId
        ? state.queueItems.find((item) => item.queueId === state.currentQueueItemId)
        : null
      set({
        queueItems: currentItem ? [currentItem] : [],
        baseUpcomingQueueIds: [],
        upcomingQueueIds: [],
        queueSourcePlaylistId: currentItem?.sourcePlaylistId ?? null,
        queueSourceContext: currentItem?.sourceContext ?? null,
        queueContextLabel: currentItem?.contextLabel ?? null,
        playbackHistory: [],
        currentTrackSource: currentItem?.origin ?? (state.currentTrack ? 'standalone' : 'standalone')
      })
    },

    clearFfmpegFallbackNotice: () => {
      set({ ffmpegFallbackNotice: null })
    },

    clearOutputDelayNotice: () => {
      set({ outputDelayNotice: null })
    },

    showAssociatedOpenNotice: (notice) => {
      const fileCount = Number.isFinite(notice.fileCount)
        ? Math.max(1, Math.floor(notice.fileCount))
        : 1
      associatedOpenNoticeId += 1
      set({
        associatedOpenNotice: {
          id: associatedOpenNoticeId,
          trackPath: notice.trackPath,
          title: notice.title.trim() || 'Unknown Track',
          fileCount,
          sourceLabel: notice.sourceLabel.trim() || 'File Explorer'
        }
      })
    },

    clearAssociatedOpenNotice: () => {
      set({ associatedOpenNotice: null })
    },

    getSessionSnapshot: () => {
      const state = get()
      return {
        currentTrack: state.currentTrack ? stripTrackArtworkData(state.currentTrack) : null,
        currentTrackSource: state.currentTrackSource,
        savedPlaybackState: state.playbackState,
        currentTime: state.currentTime,
        duration: state.duration,
        queueItems: state.queueItems.map((item) => ({
          queueId: item.queueId,
          entry: {
            path: item.entry.path,
            snapshot: { ...item.entry.snapshot }
          },
          origin: item.origin,
          sourcePlaylistId: item.sourcePlaylistId,
          sourceContext: item.sourceContext,
          contextLabel: item.contextLabel
        })),
        baseUpcomingQueueIds: [...state.baseUpcomingQueueIds],
        upcomingQueueIds: [...state.upcomingQueueIds],
        currentQueueItemId: state.currentQueueItemId,
        queueSourcePlaylistId: state.queueSourcePlaylistId,
        queueSourceContext: state.queueSourceContext,
        queueContextLabel: state.queueContextLabel,
        shuffle: state.shuffle,
        repeat: state.repeat,
        playbackHistory: state.playbackHistory.map((entry) => ({
          item: {
            queueId: entry.item.queueId,
            entry: {
              path: entry.item.entry.path,
              snapshot: { ...entry.item.entry.snapshot }
            },
            origin: entry.item.origin,
            sourcePlaylistId: entry.item.sourcePlaylistId,
            sourceContext: entry.item.sourceContext,
            contextLabel: entry.item.contextLabel
          }
        }))
      }
    },

    restoreSession: async (snapshot) => {
      const knownLibraryPaths = new Set<string>()
      const collectLibraryPath = (track: SessionQueueTrackSnapshot | null | undefined) => {
        if (!track) return
        if (track.origin === 'associated-external') return
        if (!track.sourceType) return
        knownLibraryPaths.add(track.path)
      }

      collectLibraryPath(snapshot.currentTrack)
      snapshot.queueItems.forEach((item) => collectLibraryPath(item.entry.snapshot))
      snapshot.playbackHistory.forEach((entry) => collectLibraryPath(entry.item.entry.snapshot))

      const resolvedLibraryPaths = knownLibraryPaths.size > 0
        ? new Set((await useLibraryStore.getState().resolveTrackPathsWithFetch([...knownLibraryPaths])).map((track) => track.path))
        : new Set<string>()
      const isRestorableTrack = (track: SessionQueueTrackSnapshot | null | undefined): boolean => {
        if (!track) return false
        if (track.origin === 'associated-external') return true
        if (!track.sourceType) return true
        return resolvedLibraryPaths.has(track.path)
      }

      const queueItems = snapshot.queueItems
        .filter((item) => isRestorableTrack(item.entry.snapshot))
        .map(sessionQueueItemToQueueItem)
      const queueItemIds = new Set(queueItems.map((item) => item.queueId))
      const baseUpcomingQueueIds = snapshot.baseUpcomingQueueIds.filter((queueId) => queueItemIds.has(queueId))
      const upcomingQueueIds = snapshot.upcomingQueueIds.filter((queueId) => queueItemIds.has(queueId))
      const currentQueueItemId = snapshot.currentQueueItemId && queueItemIds.has(snapshot.currentQueueItemId)
        ? snapshot.currentQueueItemId
        : null
      const playbackHistory = snapshot.playbackHistory
        .filter((entry) => isRestorableTrack(entry.item.entry.snapshot))
        .map((entry) => ({ item: sessionQueueItemToQueueItem(entry.item) }))
      const currentTrack = isRestorableTrack(snapshot.currentTrack)
        ? sessionTrackSnapshotToTrack(snapshot.currentTrack!)
        : null

      advanceNextQueueItemId([
        ...queueItems.map((item) => item.queueId),
        ...playbackHistory.map((entry) => entry.item.queueId)
      ])

      clearBufferedNextTrack()
      set({
        currentTrack,
        currentTrackSource: currentTrack ? snapshot.currentTrackSource : 'standalone',
        playbackState: currentTrack ? 'paused' : 'stopped',
        currentTime: currentTrack ? snapshot.currentTime : 0,
        duration: currentTrack ? resolvePositiveDuration(snapshot.duration, currentTrack.duration) : 0,
        waveformData: null,
        waveformBufferedRatio: currentTrack?.sourceType && currentTrack.sourceType !== 'local' ? 0 : 1,
        waveformAnalyzedRatio: currentTrack?.sourceType && currentTrack.sourceType !== 'local' ? 0 : 1,
        remoteLoadProgress: null,
        remoteBufferedSeconds: 0,
        remoteStreamSessionId: null,
        ffmpegFallbackNotice: null,
        outputDelayNotice: null,
        associatedOpenNotice: null,
        restoredTrackNeedsLoad: Boolean(currentTrack),
        restoredPlaybackTime: currentTrack ? snapshot.currentTime : null,
        queueItems,
        baseUpcomingQueueIds,
        upcomingQueueIds,
        currentQueueItemId,
        queueSourcePlaylistId: snapshot.queueSourcePlaylistId,
        queueSourceContext: sessionContextToPlaybackContext(snapshot.queueSourceContext),
        queueContextLabel: snapshot.queueContextLabel,
        shuffle: snapshot.shuffle,
        repeat: snapshot.repeat,
        playbackHistory
      })
    },

    resetListeningHistoryTracking: (status) => {
      listeningHistoryStatusPromise = Promise.resolve(status)
      if (recentPlaySession) restartDetailedSession(recentPlaySession, status)
    },

    playQueuedItem: async (queueId, options) => {
      if (blockLocalPlaybackInParallaxSinkMode()) return

      const state = get()
      const item = state.queueItems.find((candidate) => candidate.queueId === queueId)
      const track = resolveQueueEntryTrack(item?.entry)
      const index = state.upcomingQueueIds.indexOf(queueId)
      const candidate: NextCandidate | null = item && track
        ? { kind: 'queue', item, track, index }
        : null

      if (!candidate || isUnavailableRemoteTrack(candidate.track)) return

      set(applyCandidateTransition(state, candidate, {
        pushCurrentToHistory: true
      }))

      const loaded = await get()._loadAndPlayTrack(candidate.track, {
        manualStart: options?.manualStart ?? true
      })
      if (loaded === 'failed' && candidate.track.sourceType && candidate.track.sourceType !== 'local') {
        markTrackUnavailableInState(candidate.track.path)
      }
    },

    playNext: async () => {
      if (blockLocalPlaybackInParallaxSinkMode()) return

      const state = get()
      const candidate = findNextPlayableCandidate(state)
      if (!candidate) return

      // Fast path: the track we're skipping to is already decoded as the prebuffered next
      // track. Promote it instantly in the engine (gapless) instead of cold-loading from disk.
      // The synchronous 'gaplessTransition' listener then advances the queue and re-prebuffers,
      // so we must NOT pre-apply applyCandidateTransition here (it would double-advance).
      if (
        state.playbackState === 'playing' &&
        candidate.kind !== 'current' &&
        candidate.track?.path != null &&
        audioEngine.nextBufferedTrackPath === candidate.track.path
      ) {
        invalidateLoadRequest()
        manualGaplessTransitionInProgress = true
        try {
          if (audioEngine.skipToPreBuffered()) return
        } finally {
          manualGaplessTransitionInProgress = false
        }
        // Fell through (buffer vanished): fall back to the cold-load path below.
      }

      set(applyCandidateTransition(state, candidate, {
        pushCurrentToHistory: true
      }))

      await runSerializedTrackLoad(candidate.track)
    },

    playPrevious: async () => {
      if (blockLocalPlaybackInParallaxSinkMode()) return

      const state = get()
      if (!state.currentTrack) return

      // If more than 3 seconds into track, restart it
      if (state.currentTime > 3) {
        await audioEngine.seek(0)
        return
      }

      const previousEntry = state.playbackHistory[state.playbackHistory.length - 1]
      const previousTrack = resolveQueueEntryTrack(previousEntry?.item.entry)
      if (!previousEntry || !previousTrack || isUnavailableRemoteTrack(previousTrack)) return

      const currentEntry = getCurrentPlaybackEntry(state)
      const queueItemsById = new Map(state.queueItems.map((item) => [item.queueId, item]))
      if (currentEntry) queueItemsById.set(currentEntry.item.queueId, currentEntry.item)
      queueItemsById.set(previousEntry.item.queueId, previousEntry.item)
      const queueItems = [...queueItemsById.values()]
      const currentId = currentEntry?.item.queueId ?? null
      const baseUpcomingQueueIds = currentId
        ? [currentId, ...state.baseUpcomingQueueIds.filter((id) => id !== currentId && id !== previousEntry.item.queueId)]
        : state.baseUpcomingQueueIds.filter((id) => id !== previousEntry.item.queueId)
      const upcomingQueueIds = currentId
        ? [currentId, ...state.upcomingQueueIds.filter((id) => id !== currentId && id !== previousEntry.item.queueId)]
        : state.upcomingQueueIds.filter((id) => id !== previousEntry.item.queueId)
      set({
        queueItems,
        baseUpcomingQueueIds,
        upcomingQueueIds,
        playbackHistory: state.playbackHistory.slice(0, -1),
        currentQueueItemId: previousEntry.item.queueId,
        currentTrackSource: previousEntry.item.origin
      })

      await runSerializedTrackLoad(previousTrack, { manualStart: true })
    },

    toggleShuffle: () => {
      const state = get()
      const newShuffle = !state.shuffle
      set({
        shuffle: newShuffle,
        upcomingQueueIds: newShuffle
          ? shuffleQueueIds(state.baseUpcomingQueueIds)
          : [...state.baseUpcomingQueueIds]
      })
      clearBufferedNextTrack()
      schedulePreBufferNextTrack()
    },

    toggleRepeat: () => {
      set((state) => {
        const modes: Array<'none' | 'one' | 'all'> = ['none', 'all', 'one']
        const currentIndex = modes.indexOf(state.repeat)
        const repeat = modes[(currentIndex + 1) % modes.length]
        if (repeat !== 'all' || state.upcomingQueueIds.length > 0 || !state.currentQueueItemId) {
          return { repeat }
        }
        const baseUpcomingQueueIds = state.queueItems
          .map((item) => item.queueId)
          .filter((queueId) => queueId !== state.currentQueueItemId)
        return {
          repeat,
          baseUpcomingQueueIds,
          upcomingQueueIds: state.shuffle ? shuffleQueueIds(baseUpcomingQueueIds) : [...baseUpcomingQueueIds]
        }
      })
      clearBufferedNextTrack()
      schedulePreBufferNextTrack()
    },

    getResolvedUpcomingTracks: () => {
      return buildResolvedUpcomingEntries(get()).map((entry) => entry.track)
    },

    getResolvedUpcomingEntries: () => {
      return buildResolvedUpcomingEntries(get())
    },

    getResolvedPreviousTracks: () => {
      return get().getResolvedPreviousEntries().map((entry) => entry.track)
    },

    getResolvedPreviousEntries: () => {
      const entries: ResolvedQueueTrack[] = []
      get().playbackHistory.forEach((entry, index) => {
        const track = resolveQueueEntryTrack(entry.item.entry)
        if (!track) return
        entries.push({
          queueId: entry.item.queueId,
          source: 'previous',
          origin: entry.item.origin,
          track,
          index
        })
      })
      return entries
    },

    getResolvedNextTrack: () => {
      const candidate = findNextPlayableCandidate(get())
      if (!candidate) return null
      return candidate.track
    },

    getResolvedQueueLength: () => {
      const state = get()
      return state.playbackHistory.length + (state.currentTrack ? 1 : 0) + buildResolvedUpcomingEntries(state).length
    },

    _getNextEntry: () => {
      const candidate = findNextPlayableCandidate(get())
      if (!candidate || candidate.kind === 'current') return null
      return {
        queueId: candidate.item.queueId,
        source: 'upcoming',
        origin: candidate.item.origin,
        track: candidate.track,
        index: candidate.index
      }
    },

    // Internal: Load and play a track from queue
    _loadAndPlayTrack: async (track: Track, options = {}) => {
      if (blockLocalPlaybackInParallaxSinkMode()) return 'superseded'

      const loadStart = performance.now()
      const loadRequestId = beginLoadRequest()
      const manualStart = Boolean(options.manualStart)
      const startTime = Number.isFinite(options.startTime) ? Math.max(0, Number(options.startTime)) : 0
      pendingManualLoadCueTrack = null
      // Initialize listeners if needed
      if (!listenersInitialized) {
        get()._initListeners()
      }

      finalizeRecentPlaySession()
      set({
        currentTrack: track,
        playbackState: 'loading',
        waveformData: null,
        waveformBufferedRatio: track.sourceType && track.sourceType !== 'local' ? 0 : 1,
        waveformAnalyzedRatio: track.sourceType && track.sourceType !== 'local' ? 0 : 1,
        remoteLoadProgress: track.sourceType && track.sourceType !== 'local'
          ? createInitialRemoteLoadProgress(track)
          : null,
        loadingStatus: null,
        remoteBufferedSeconds: 0,
        remoteStreamSessionId: null,
        currentTime: 0,
        duration: track.duration,
        restoredTrackNeedsLoad: false,
        restoredPlaybackTime: null
      })
      startRecentPlaySession(track.path)
      const loadListeningSession = recentPlaySession

      try {
        await ensureCompatiblePlaybackMode(track)
        throwIfSupersededLoad(loadRequestId)
        const replayGainDb = getReplayGainCandidateDb(track, useAudioSettingsStore.getState().replayGainMode)
        if (shouldUseBitPerfectPath(track)) {
          audioEngine.setCurrentReplayGainDb(replayGainDb)
          const loadResult = await audioEngine.loadTrackFromPath(track)
          throwIfSupersededLoad(loadRequestId)
          const resolvedTrack: Track = {
            ...track,
            duration: loadResult.duration > 0 ? loadResult.duration : track.duration,
            channels: loadResult.channels ?? track.channels
          }
          set({
            duration: loadResult.duration > 0 ? loadResult.duration : track.duration,
            currentTrack: resolvedTrack,
            remoteLoadProgress: null,
            loadingStatus: null,
            currentTime: 0,
            restoredTrackNeedsLoad: false,
            restoredPlaybackTime: null
          })
          hydrateAssociatedCurrentTrackMetadata(resolvedTrack)
          await seekLoadedTrackBeforePlay(resolvedTrack, startTime)
          if (manualStart) {
            showOutputDelayNotice(resolvedTrack)
          }
          throwIfSupersededLoad(loadRequestId)
          await playWithParallaxIfNeeded(resolvedTrack)
          throwIfSupersededLoad(loadRequestId)
          void useLibraryStore.getState().markTrackLatestSyncSeen(resolvedTrack.path)
          startRecentPlaySession(resolvedTrack.path)
          schedulePreBufferNextTrack()
          warmupUpcomingLoudness()
          logMemoryDiagnosticsEvent('track_load_success', {
            trackPath: track.path,
            sourceType: track.sourceType ?? 'local',
            loadPath: 'bitperfect',
            durationSeconds: loadResult.duration,
            channels: loadResult.channels
          })
          logSlowPath('queueLoadAndPlayTrack', loadStart, {
            trackPath: track.path,
            usedNativeBitPerfect: true
          })
          return 'loaded'
        }

        if (track.sourceType && track.sourceType !== 'local') {
          try {
            const streamInfo = await audioEngine.loadRemoteStream(track, { replayGainDb })
            throwIfSupersededLoad(loadRequestId)
            const resolvedTrack: Track = {
              ...track,
              duration: streamInfo.durationSeconds && streamInfo.durationSeconds > 0 ? streamInfo.durationSeconds : track.duration,
              channels: streamInfo.channels ?? track.channels
            }
            set({
              duration: resolvedTrack.duration,
              currentTrack: resolvedTrack,
              waveformData: null,
              waveformBufferedRatio: 0,
              waveformAnalyzedRatio: 0,
              remoteLoadProgress: createInitialRemoteLoadProgress(resolvedTrack),
              loadingStatus: null,
              remoteBufferedSeconds: audioEngine.getRemoteBufferedSeconds(),
              remoteStreamSessionId: streamInfo.sessionId,
              currentTime: 0,
              restoredTrackNeedsLoad: false,
              restoredPlaybackTime: null
            })
            hydrateAssociatedCurrentTrackMetadata(resolvedTrack)
            if (manualStart) {
              showOutputDelayNotice(resolvedTrack)
            }
            throwIfSupersededLoad(loadRequestId)
            await playWithParallaxIfNeeded(resolvedTrack)
            throwIfSupersededLoad(loadRequestId)
            void useLibraryStore.getState().markTrackLatestSyncSeen(resolvedTrack.path)
            startRecentPlaySession(resolvedTrack.path)
            warmupUpcomingLoudness()
            logMemoryDiagnosticsEvent('remote_stream_started', {
              trackPath: track.path,
              sourceType: resolvedTrack.sourceType ?? 'local',
              sessionId: streamInfo.sessionId,
              durationSeconds: resolvedTrack.duration,
              channels: streamInfo.channels
            })
            logMemoryDiagnosticsEvent('track_load_success', {
              trackPath: track.path,
              sourceType: resolvedTrack.sourceType ?? 'local',
              loadPath: 'remote_stream',
              sessionId: streamInfo.sessionId,
              durationSeconds: resolvedTrack.duration,
              channels: streamInfo.channels
            })
            logSlowPath('queueLoadAndPlayTrack', loadStart, {
              trackPath: track.path,
              usedRemoteStream: true
            })
            return 'loaded'
          } catch (streamError) {
            if (isSupersededPlaybackLoad(streamError, loadRequestId)) {
              throw streamError
            }
            console.warn(`Remote progressive stream setup failed for ${track.path}; falling back to full download.`, streamError)
            logMemoryDiagnosticsEvent('remote_stream_fallback', {
              trackPath: track.path,
              sourceType: track.sourceType ?? 'local',
              message: streamError instanceof Error ? streamError.message : 'Remote stream setup failed.'
            })
            set({
              remoteLoadProgress: createInitialRemoteLoadProgress(track),
              remoteBufferedSeconds: 0,
              remoteStreamSessionId: null,
              waveformData: null,
              waveformBufferedRatio: 0,
              waveformAnalyzedRatio: 0
            })
          }
        }

        const useLocalProgressive = await shouldUseLocalProgressivePath(track)
        throwIfSupersededLoad(loadRequestId)
        if (useLocalProgressive) {
          const needsFixedLoudness = audioEngine.needsLoudnessAnalysisForLoad(replayGainDb)
          const fixedLoudness = needsFixedLoudness
            ? await resolveInteractiveLoudnessForProgressiveLoad(track, replayGainDb, loadRequestId)
            : null
          throwIfSupersededLoad(loadRequestId)

          if (!needsFixedLoudness || fixedLoudness) {
            try {
              const streamInfo = await audioEngine.loadProgressiveStream(track, {
                replayGainDb,
                loudnessAnalysis: fixedLoudness
              })
              throwIfSupersededLoad(loadRequestId)
              const resolvedTrack: Track = {
                ...track,
                duration: streamInfo.durationSeconds && streamInfo.durationSeconds > 0 ? streamInfo.durationSeconds : track.duration,
                channels: streamInfo.channels ?? track.channels
              }
              set({
                duration: resolvedTrack.duration,
                currentTrack: resolvedTrack,
                waveformData: null,
                waveformBufferedRatio: 0,
                waveformAnalyzedRatio: 0,
                remoteLoadProgress: createInitialRemoteLoadProgress(resolvedTrack),
                loadingStatus: null,
                remoteBufferedSeconds: audioEngine.getRemoteBufferedSeconds(),
                remoteStreamSessionId: streamInfo.sessionId,
                currentTime: 0
              })
              hydrateAssociatedCurrentTrackMetadata(resolvedTrack)
              if (manualStart) {
                showOutputDelayNotice(resolvedTrack)
              }
              throwIfSupersededLoad(loadRequestId)
              await audioEngine.play()
              throwIfSupersededLoad(loadRequestId)
              void useLibraryStore.getState().markTrackLatestSyncSeen(resolvedTrack.path)
              startRecentPlaySession(resolvedTrack.path)
              schedulePreBufferNextTrack()
              warmupUpcomingLoudness()
              logMemoryDiagnosticsEvent('track_load_success', {
                trackPath: track.path,
                sourceType: 'local',
                loadPath: 'local_progressive_stream',
                sessionId: streamInfo.sessionId,
                durationSeconds: resolvedTrack.duration,
                channels: streamInfo.channels,
                usedReplayGain: replayGainDb != null,
                usedStoredLoudness: Boolean(fixedLoudness)
              })
              logSlowPath('queueLoadAndPlayTrack', loadStart, {
                trackPath: track.path,
                usedLocalProgressiveStream: true
              })
              return 'loaded'
            } catch (streamError) {
              if (isSupersededPlaybackLoad(streamError, loadRequestId)) {
                throw streamError
              }
              console.warn(`Local progressive stream setup failed for ${track.path}; falling back to full decode.`, streamError)
              logMemoryDiagnosticsEvent('local_progressive_stream_fallback', {
                trackPath: track.path,
                message: streamError instanceof Error ? streamError.message : 'Local progressive stream setup failed.'
              })
              set({
                loadingStatus: null,
                remoteLoadProgress: null,
                remoteBufferedSeconds: 0,
                remoteStreamSessionId: null,
                waveformData: null,
                waveformBufferedRatio: 1,
                waveformAnalyzedRatio: 1
              })
            }
          } else {
            logMemoryDiagnosticsEvent('local_progressive_loudness_fallback', {
              trackPath: track.path
            })
            set({ loadingStatus: null })
          }
        }

        const fileLoadStart = performance.now()
        // Resolve loudness (stored value or main-process ffmpeg pass) in
        // parallel with the file read + decode below.
        const loudnessAnalysis = requestTrackLoudnessAnalysis(track, replayGainDb)
        // Load audio file from path
        const result = await window.electronAPI.loadAudioFile(track.path, { metadataMode: 'none' })
        throwIfSupersededLoad(loadRequestId)
        const fileLoadMs = Math.round(performance.now() - fileLoadStart)
        if (!result) {
          console.error('Failed to load audio file:', track.path)
          logSlowPath('queueLoadAndPlayTrack', loadStart, {
            trackPath: track.path,
            failed: true,
            stage: 'fileLoad'
          })
          set({
            playbackState: 'stopped',
            remoteLoadProgress: null,
            loadingStatus: null,
            remoteBufferedSeconds: 0,
            remoteStreamSessionId: null
          })
          if (recentPlaySession === loadListeningSession) finalizeRecentPlaySession()
          return 'failed'
        }
        if (!result.data) {
          throw new Error('Audio file data missing from full decode load.')
        }

        let usedFfmpegFallback = false
        const decodeStart = performance.now()
        try {
          await audioEngine.loadAudioData(result.data, { replayGainDb, trackPath: track.path, loudnessAnalysis })
          throwIfSupersededLoad(loadRequestId)
        } catch (primaryDecodeError) {
          if (isSupersededPlaybackLoad(primaryDecodeError, loadRequestId)) {
            throw primaryDecodeError
          }
          // ffmpeg 6.0 cannot decode IAMF; the fallback would fail anyway.
          if (isIamfTrack(track)) {
            throw primaryDecodeError
          }
          const fallbackData = await window.electronAPI.decodeAudioWithFfmpeg(track.path)
          throwIfSupersededLoad(loadRequestId)
          if (!fallbackData) {
            throw primaryDecodeError
          }

          usedFfmpegFallback = true
          console.warn(`Primary decode failed for ${track.path}; using FFmpeg compatibility decode.`)
          await audioEngine.loadAudioData(fallbackData, { replayGainDb, trackPath: track.path, loudnessAnalysis })
          throwIfSupersededLoad(loadRequestId)
        }
        const decodeMs = Math.round(performance.now() - decodeStart)
        const detectedChannels = audioEngine.getCurrentTrackChannelCount()
        const metadataResolvedTrack: Track = {
          ...track,
          title: result.metadata?.title ?? track.title,
          artist: result.metadata?.artist ?? track.artist,
          album: result.metadata?.album ?? track.album,
          albumArtist: result.metadata?.albumArtist ?? track.albumArtist,
          duration: result.metadata?.duration ?? track.duration,
          channels: detectedChannels ?? result.metadata?.channels ?? track.channels,
          codec: result.metadata?.codec ?? track.codec,
          codecProfile: result.metadata?.codecProfile ?? track.codecProfile,
          isAtmosJoc: result.metadata?.isAtmosJoc ?? track.isAtmosJoc,
          isIamf: result.metadata?.isIamf ?? track.isIamf,
          replayGainTrackDb: result.metadata?.replayGainTrackDb ?? track.replayGainTrackDb,
          replayGainAlbumDb: result.metadata?.replayGainAlbumDb ?? track.replayGainAlbumDb
        }
        const resolvedDuration = resolvePositiveDuration(audioEngine.duration, metadataResolvedTrack.duration)
        const resolvedTrack: Track = {
          ...metadataResolvedTrack,
          duration: resolvedDuration
        }
        set({
          duration: resolvedDuration,
          currentTrack: resolvedTrack,
          remoteLoadProgress: null,
          loadingStatus: null,
          remoteBufferedSeconds: 0,
          remoteStreamSessionId: null,
          waveformBufferedRatio: 1,
          waveformAnalyzedRatio: 1,
          currentTime: 0,
          restoredTrackNeedsLoad: false,
          restoredPlaybackTime: null
        })
        hydrateAssociatedCurrentTrackMetadata(resolvedTrack)
        await seekLoadedTrackBeforePlay(resolvedTrack, startTime)
        if (usedFfmpegFallback) {
          showFfmpegFallbackNotice(resolvedTrack)
        }
        if (manualStart) {
          showOutputDelayNotice(resolvedTrack)
        }
        throwIfSupersededLoad(loadRequestId)
        await playWithParallaxIfNeeded(resolvedTrack)
        throwIfSupersededLoad(loadRequestId)
        void useLibraryStore.getState().markTrackLatestSyncSeen(resolvedTrack.path)
        startRecentPlaySession(resolvedTrack.path)
        const engineTimings = audioEngine.getLastLoadTimings()
        logMemoryDiagnosticsEvent('track_load_success', {
          trackPath: track.path,
          sourceType: resolvedTrack.sourceType ?? 'local',
          loadPath: usedFfmpegFallback ? 'file_ffmpeg_fallback' : 'file_decode',
          fileLoadMs,
          decodeMs,
          decodeOnlyMs: engineTimings?.decodeMs ?? null,
          loudnessAnalysisMs: engineTimings?.analysisMs ?? null,
          usedFfmpegFallback
        })

        // Schedule next-track prebuffering for the gapless handoff window.
        schedulePreBufferNextTrack()
        warmupUpcomingLoudness()
        logSlowPath('queueLoadAndPlayTrack', loadStart, {
          trackPath: track.path,
          fileLoadMs,
          decodeMs,
          decodeOnlyMs: engineTimings?.decodeMs ?? null,
          loudnessAnalysisMs: engineTimings?.analysisMs ?? null,
          usedFfmpegFallback
        })
        return 'loaded'
      } catch (error) {
        if (isSupersededPlaybackLoad(error, loadRequestId)) {
          return 'superseded'
        }
        if (recentPlaySession === loadListeningSession) finalizeRecentPlaySession()
        console.error('Failed to load track:', error)
        logMemoryDiagnosticsEvent('track_load_failed', {
          trackPath: track.path,
          sourceType: track.sourceType ?? 'local',
          message: error instanceof Error ? error.message : 'Unknown track load failure.'
        })
        logSlowPath('queueLoadAndPlayTrack', loadStart, {
          trackPath: track.path,
          failed: true
        })
        if (track.sourceType && track.sourceType !== 'local') {
          markTrackUnavailableInState(track.path)
        }
        set({
          playbackState: 'stopped',
          remoteLoadProgress: null,
          loadingStatus: null,
          remoteBufferedSeconds: 0,
          remoteStreamSessionId: null
        })
        return 'failed'
      }
    },

    // Pre-buffer the next track for gapless playback
    _preBufferNextTrack: async () => {
      if (isParallaxSinkModeActive()) {
        clearBufferedNextTrack()
        return
      }

      const bufferStart = performance.now()
      const prebufferRequestId = beginPrebufferRequest()
      const state = get()
      const expectedPrebufferTrackPath = resolveExpectedPrebufferTrackPath(state)
      prebufferInFlightRequestId = prebufferRequestId
      prebufferInFlightTrackPath = expectedPrebufferTrackPath
      prebufferAttemptedTrackPath = expectedPrebufferTrackPath

      const canApplyPrebufferResult = (nextTrack: Track): boolean => {
        return isActivePrebufferRequest(prebufferRequestId)
          && resolveExpectedPrebufferTrackPath() === nextTrack.path
      }

      try {
        if (useAudioSettingsStore.getState().disableGaplessPrebufferDev) {
          return
        }

        if (state.repeat === 'one') {
          return
        }

        const candidates = collectNextCandidates(state)
        if (candidates.length === 0) return

        for (const candidate of candidates) {
          const nextTrack = candidate.track
          if (!nextTrack) continue
          if (nextTrack.sourceType && nextTrack.sourceType !== 'local') {
            // Remote prebuffering downloads entire files and can stall click-to-play on constrained links.
            continue
          }
          if (isUnavailableRemoteTrack(nextTrack)) continue
          if (await shouldUseLocalProgressivePath(nextTrack)) {
            logMemoryDiagnosticsEvent('prebuffer_skipped_local_progressive', {
              trackPath: nextTrack.path
            })
            logSlowPath('preBufferNextTrack', bufferStart, {
              trackPath: nextTrack.path,
              skippedLocalProgressive: true
            })
            return
          }

          try {
            if (!canApplyPrebufferResult(nextTrack)) return
            if (shouldUseBitPerfectPath(nextTrack)) {
              await audioEngine.preBufferNextTrackFromPath(nextTrack)
              if (!canApplyPrebufferResult(nextTrack)) {
                audioEngine.clearNextBuffer()
                return
              }
              logSlowPath('preBufferNextTrack', bufferStart, {
                trackPath: nextTrack.path,
                loaded: true,
                usedNativeBitPerfect: true
              })
              return
            }

            const bufferStats = await audioEngine.getBufferMemoryStats()
            const estimatedNextTrackBytes = estimateDecodedTrackBytes(nextTrack)
            const currentBufferedBytes = bufferStats.totalBytes
            const wouldExceedTotalBudget =
              estimatedNextTrackBytes !== null
              && (currentBufferedBytes + estimatedNextTrackBytes) > MAX_STANDARD_PREBUFFER_TOTAL_BYTES

            if (
              currentBufferedBytes >= MAX_STANDARD_PREBUFFER_TOTAL_BYTES
              || (estimatedNextTrackBytes !== null && estimatedNextTrackBytes > MAX_STANDARD_PREBUFFER_TRACK_BYTES)
              || wouldExceedTotalBudget
            ) {
              logMemoryDiagnosticsEvent('prebuffer_skipped_budget', {
                trackPath: nextTrack.path,
                currentBufferedMb: Number((currentBufferedBytes / (1024 * 1024)).toFixed(1)),
                estimatedNextTrackMb: estimatedNextTrackBytes === null
                  ? null
                  : Number((estimatedNextTrackBytes / (1024 * 1024)).toFixed(1)),
                maxTrackMb: MAX_STANDARD_PREBUFFER_TRACK_BYTES / (1024 * 1024),
                maxTotalMb: MAX_STANDARD_PREBUFFER_TOTAL_BYTES / (1024 * 1024)
              })
              logSlowPath('preBufferNextTrack', bufferStart, {
                trackPath: nextTrack.path,
                skippedBudget: true,
                currentBufferedBytes,
                estimatedNextTrackBytes
              })
              return
            }

            const nextReplayGainDb = getReplayGainCandidateDb(nextTrack, useAudioSettingsStore.getState().replayGainMode)
            // Resolve loudness in parallel with the prebuffer file read + decode.
            const nextLoudnessAnalysis = requestTrackLoudnessAnalysis(nextTrack, nextReplayGainDb)
            const result = await window.electronAPI.loadAudioFile(nextTrack.path, { metadataMode: 'none' })
            if (!canApplyPrebufferResult(nextTrack)) {
              return
            }
            if (result?.data) {
              await audioEngine.preBufferNext(result.data, {
                replayGainDb: nextReplayGainDb,
                trackPath: nextTrack.path,
                loudnessAnalysis: nextLoudnessAnalysis
              })
              if (!canApplyPrebufferResult(nextTrack)) {
                audioEngine.clearNextBuffer()
                return
              }
              logSlowPath('preBufferNextTrack', bufferStart, {
                trackPath: nextTrack.path,
                loaded: true
              })
              // §21 Gapless sink handoff — the next track is decoded; pre-announce it to connected
              // sinks so they pre-buffer and cross the boundary gaplessly. No-op unless hosting with
              // sinks on a non-bitperfect local track.
              void useParallaxStore.getState().publishHostNextStream(nextTrack)
              return
            }
            if (isActivePrebufferRequest(prebufferRequestId) && nextTrack.sourceType && nextTrack.sourceType !== 'local') {
              markTrackUnavailableInState(nextTrack.path)
            }
          } catch (error) {
            if (isSupersededAudioLoadError(error) || !isActivePrebufferRequest(prebufferRequestId)) {
              return
            }
            console.error('Failed to pre-buffer next track:', error)
            if (isActivePrebufferRequest(prebufferRequestId) && nextTrack.sourceType && nextTrack.sourceType !== 'local') {
              markTrackUnavailableInState(nextTrack.path)
            }
            logSlowPath('preBufferNextTrack', bufferStart, {
              trackPath: nextTrack.path,
              failed: true
            })
          }
        }
      } finally {
        if (prebufferInFlightRequestId === prebufferRequestId) {
          prebufferInFlightRequestId = null
          prebufferInFlightTrackPath = null
        }
      }
    },

    _schedulePreBufferNextTrack: (options = {}) => {
      schedulePreBufferNextTrack(options)
    },

    // Initialize audio engine event listeners
    _initListeners: () => {
      if (listenersInitialized) return
      listenersInitialized = true

      listeningBeforeUnloadHandler = () => finalizeRecentPlaySession()
      window.addEventListener('beforeunload', listeningBeforeUnloadHandler)

      remoteLoadProgressUnsubscribe?.()
      remoteLoadProgressUnsubscribe = window.electronAPI.onProgressiveLoadProgress((progress) => {
        set((state) => {
          const activeTrackPath = state.currentTrack?.path
          if (!activeTrackPath || activeTrackPath !== progress.path) {
            return state
          }
          return {
            remoteLoadProgress: progress,
            remoteBufferedSeconds: progress.bufferedSeconds
          }
        })
      })

      audioEngine.on('stateChange', (state) => {
        const nextPlaybackState = state as PlaybackState
        const previousPlaybackState = get().playbackState
        const now = performance.now()
        maybeCommitRecentPlay(previousPlaybackState, now)
        if (recentPlaySession && previousPlaybackState === 'playing' && nextPlaybackState !== 'playing') {
          checkpointRecentPlay(recentPlaySession, { finalizeSegment: true })
          recentPlaySession.lastAccumulatedAtMs = null
        } else if (recentPlaySession && nextPlaybackState === 'playing' && previousPlaybackState !== 'playing') {
          recentPlaySession.segmentKey = createListeningHistoryKey('segment')
          recentPlaySession.segmentStartedAt = Date.now()
          recentPlaySession.segmentStartAccumulatedSeconds = recentPlaySession.accumulatedSeconds
          recentPlaySession.lastAccumulatedAtMs = now
        }
        if (nextPlaybackState === 'playing') {
          lastCommittedCurrentTimeMs = now
          set({
            playbackState: nextPlaybackState,
            currentTime: audioEngine.currentTime
          })
          schedulePreBufferNextTrack()
          return
        }

        clearScheduledPrebufferTimer()
        lastCommittedCurrentTimeMs = now
        set({
          playbackState: nextPlaybackState,
          currentTime: nextPlaybackState === 'paused' ? audioEngine.currentTime : 0
        })
      })

      audioEngine.on('nativeCapabilitiesChange', (capabilities) => {
        if (useAudioSettingsStore.getState().playbackOutputMode !== 'bitperfect') {
          return
        }
        useAudioSettingsStore.setState({
          nativeAudioCapabilities: capabilities as NativeAudioCapabilities,
          playbackModeStatusMessage: audioEngine.getPlaybackModeStatusMessage()
        })
      })

      audioEngine.on('timeUpdate', (time) => {
        const normalizedTime = time as number
        maybeCommitRecentPlay()

        const state = get()
        if (state.playbackState === 'playing' || state.playbackState === 'paused') {
          schedulePreBufferNextTrack()
        }

        if (state.playbackState === 'loading') {
          if (normalizedTime !== 0) {
            return
          }
          if (state.currentTime !== 0) {
            lastCommittedCurrentTimeMs = performance.now()
            set({ currentTime: 0 })
          }
          return
        }

        if (state.playbackState === 'stopped') {
          if (normalizedTime !== 0) {
            return
          }
          if (state.currentTime !== 0) {
            lastCommittedCurrentTimeMs = performance.now()
            set({ currentTime: 0 })
          }
          return
        }

        if (state.playbackState !== 'playing') {
          lastCommittedCurrentTimeMs = performance.now()
          set({ currentTime: normalizedTime })
          return
        }

        const now = performance.now()
        const currentStoredTime = state.currentTime
        const timeJumped = normalizedTime === 0
          || normalizedTime < currentStoredTime
          || Math.abs(normalizedTime - currentStoredTime) >= 0.2
        if (!timeJumped && (now - lastCommittedCurrentTimeMs) < CURRENT_TIME_STORE_THROTTLE_MS) {
          return
        }

        lastCommittedCurrentTimeMs = now
        set({ currentTime: normalizedTime })
      })

      audioEngine.on('durationChange', (duration) => {
        const state = get()
        if (!shouldApplyDurationChange(duration, state.currentTrack, state.playbackState)) return
        set({ duration: resolvePositiveDuration(duration) })
        schedulePreBufferNextTrack()
      })

      audioEngine.on('remoteWaveformUpdate', (payload) => {
        const next = payload as {
          waveformData: Float32Array
          bufferedRatio: number
          analyzedRatio: number
          bufferedSeconds: number
        }
        const track = get().currentTrack
        if (!track || get().remoteStreamSessionId === null) {
          return
        }

        set((state) => ({
          waveformData: (
            state.remoteStreamSessionId !== null
            && state.waveformAnalyzedRatio >= 0.999
            && next.analyzedRatio < 0.999
          )
            ? state.waveformData
            : next.waveformData,
          waveformBufferedRatio: next.bufferedRatio,
          waveformAnalyzedRatio: Math.max(state.waveformAnalyzedRatio, next.analyzedRatio),
          remoteBufferedSeconds: next.bufferedSeconds
        }))
      })

      audioEngine.on('bufferReady', (buffer) => {
        const track = get().currentTrack
        if (!track || !buffer) return

        if (shouldUseWaveformCache(track)) {
          const cached = getWaveformCacheEntry(track.path)
          if (cached) {
            set({
              waveformData: cached,
              waveformBufferedRatio: 1,
              waveformAnalyzedRatio: 1
            })
            return
          }
        }

        // bufferReady fires synchronously inside loadAudioData (before play())
        // and at gapless transitions; extraction is a full pass over the
        // decoded samples, so keep it off the playback-start critical path.
        const trackPath = track.path
        scheduleDeferredWaveformExtraction(() => {
          if (get().currentTrack?.path !== trackPath) return
          const extractStart = performance.now()
          const peaks = extractWaveformPeaks(buffer as AudioBuffer)
          logSlowPath('extractWaveformPeaks', extractStart, { trackPath })
          if (shouldUseWaveformCache(track)) {
            setWaveformCacheEntry(trackPath, peaks)
          }
          set({
            waveformData: peaks,
            waveformBufferedRatio: 1,
            waveformAnalyzedRatio: 1
          })
        })
      })

      // Handle gapless transition - advance queue without reloading
      audioEngine.on('gaplessTransition', () => {
        if (isParallaxSinkModeActive()) return
        finalizeRecentPlaySession('playing', {
          completedNaturally: !manualGaplessTransitionInProgress
        })
        const state = get()

        if (state.repeat === 'one') {
          // Safety net: AudioEngine already swapped to the wrong buffer.
          // Reload the correct track to fix audio/UI desync.
          const correctTrack = state.currentTrack
          if (correctTrack) {
            void get()._loadAndPlayTrack(correctTrack)
          }
          return
        }

        const nextCandidate = findNextPlayableCandidate(state)
        if (!nextCandidate || nextCandidate.kind === 'current') return

        const nextTrack = nextCandidate.track
        if (isUnavailableRemoteTrack(nextTrack)) return
        logMemoryDiagnosticsEvent('gapless_transition_state', {
          previousTrackPath: state.currentTrack?.path ?? null,
          nextTrackPath: nextTrack.path
        })

        const transitionState = applyCandidateTransition(state, nextCandidate, {
          pushCurrentToHistory: true
        })
        const nextState: typeof transitionState & {
          currentTrack: Track
          currentTime: number
          duration: number
          waveformData: Float32Array | null
          waveformBufferedRatio: number
          waveformAnalyzedRatio: number
          remoteBufferedSeconds: number
          remoteStreamSessionId: number | null
        } = {
          ...transitionState,
          currentTrack: nextTrack,
          currentTime: 0,
          duration: nextTrack.duration,
          waveformData: shouldUseWaveformCache(nextTrack)
            ? (getWaveformCacheEntry(nextTrack.path) ?? null)
            : null,
          waveformBufferedRatio: 1,
          waveformAnalyzedRatio: 1,
          remoteBufferedSeconds: 0,
          remoteStreamSessionId: null
        }
        set(nextState)
        audioEngine.setCurrentReplayGainDb(
          getReplayGainCandidateDb(nextTrack, useAudioSettingsStore.getState().replayGainMode)
        )
        startRecentPlaySession(nextTrack.path)
        prebufferAttemptedTrackPath = null

        // §21 Gapless sink handoff. Promote the pre-announced next stream so sinks cross the boundary
        // gaplessly. promoteHostNextStream falls back to the Phase-1 boundary start
        // (startHostStreamForCurrentPlayback) when nothing was pre-announced — so sinks always follow.
        void useParallaxStore
          .getState()
          .promoteHostNextStream(nextTrack)
          .catch(() => {
            /* host streaming is best-effort; errors surface via parallaxStore */
          })

        // Schedule the NEXT next track for the new handoff window.
        schedulePreBufferNextTrack()
      })

      // Handle non-gapless track end (when no next track buffered)
      audioEngine.on('ended', () => {
        if (isParallaxSinkModeActive()) return
        finalizeRecentPlaySession('playing', { completedNaturally: true })
        set({
          currentTime: 0,
          remoteBufferedSeconds: 0,
          remoteStreamSessionId: null
        })
        // Auto-play next track (non-gapless fallback)
        get().playNext()
      })

      audioEngine.on('error', (error) => {
        finalizeRecentPlaySession()
        console.error('Audio engine error:', error)
        logMemoryDiagnosticsEvent('audio_engine_error', {
          message: error instanceof Error ? error.message : String(error)
        })
      })

      // Set initial volume
      audioEngine.setVolume(get().volume)
    },

    // Cleanup listeners
    _cleanupListeners: () => {
      finalizeRecentPlaySession()
      clearScheduledPrebufferTimer()
      // Audio engine handles its own cleanup
      if (remoteLoadProgressUnsubscribe) {
        remoteLoadProgressUnsubscribe()
        remoteLoadProgressUnsubscribe = null
      }
      if (listeningBeforeUnloadHandler) {
        window.removeEventListener('beforeunload', listeningBeforeUnloadHandler)
        listeningBeforeUnloadHandler = null
      }
      listenersInitialized = false
    }
  }
})

useAudioSettingsStore.subscribe((nextState, prevState) => {
  if (nextState.replayGainMode === prevState.replayGainMode) return

  const playerState = usePlayerStore.getState()
  const replayGainDb = getReplayGainCandidateDb(playerState.currentTrack, nextState.replayGainMode)
  audioEngine.setCurrentReplayGainDb(replayGainDb)
  audioEngine.clearNextBuffer()
  playerState._schedulePreBufferNextTrack({ invalidatePending: true })
})

useAudioSettingsStore.subscribe((nextState, prevState) => {
  if (nextState.disableGaplessPrebufferDev === prevState.disableGaplessPrebufferDev) return

  const playerState = usePlayerStore.getState()
  audioEngine.clearNextBuffer()
  playerState._schedulePreBufferNextTrack({ invalidatePending: true })
})

// When a sink joins while this instance is already a host playing/paused a local track, start a
// Parallax stream anchored at the current position so the sink syncs to the in-progress song
// instead of waiting (and forcing a restart on the next play). See parallaxStore for the anchor.
let hostAutoStreamStartInFlight = false
useParallaxStore.subscribe((nextState, prevState) => {
  const nextCount = nextState.status?.host.activePlaybackSinkCount ?? 0
  const prevCount = prevState.status?.host.activePlaybackSinkCount ?? 0
  if (prevCount > 0 && nextCount === 0) {
    nextState.handleHostPlaybackAudienceLost()
    return
  }
  if (nextCount <= 0 || nextCount <= prevCount) return
  if (hostAutoStreamStartInFlight) return

  const playerState = usePlayerStore.getState()
  const track = playerState.currentTrack
  if (!track) return
  const playbackState = playerState.playbackState
  if (playbackState !== 'playing' && playbackState !== 'paused') return

  hostAutoStreamStartInFlight = true
  void nextState
    .startHostStreamForCurrentPlayback(track, playbackState === 'playing')
    .finally(() => {
      hostAutoStreamStartInFlight = false
    })
})

export function getPlayerDiagnosticsSnapshot(): {
  caches: {
    waveformEntries: number
    waveformBytes: number
    currentWaveformBytes: number
  }
  retention: {
    retainedTrackCount: number
    distinctRetainedTrackCount: number
    retainedArtworkTrackCount: number
    retainedArtworkDataBytes: number
  }
} {
  const state = usePlayerStore.getState()
  return {
    caches: {
      waveformEntries: waveformCache.size,
      waveformBytes: estimateWaveformCacheBytes(),
      currentWaveformBytes: state.waveformData?.byteLength ?? 0
    },
    retention: getTrackRetentionDiagnostics(state)
  }
}
