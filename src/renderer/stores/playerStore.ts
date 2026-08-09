import { create } from 'zustand'
import {
  audioEngine,
  isSupersededAudioLoadError,
  type AudioLoadTimings
} from '../audio/AudioEngine'
import type { Track, PlaybackState } from '../types/audio'
import type { NativeAudioCapabilities, NativeAudioTrackLoadResult } from '../../types/nativeAudio'
import type { ListeningHistoryStatus } from '../../types/listeningStats'
import {
  createNativeOutputFailureError,
  parseBitPerfectFormatError,
  stripBitPerfectFormatTag
} from '../../shared/audio/bitPerfectFormatError'
import { extractWaveformPeaks } from '../audio/waveformExtractor'
import { useLibraryStore, type DbTrack } from './libraryStore'
import { usePlaylistStore } from './playlistStore'
import { resolveOutputDeviceLabel, useAudioSettingsStore, type ReplayGainMode } from './audioSettingsStore'
import { useParallaxStore } from './parallaxStore'
import { logMemoryDiagnosticsEvent } from '../utils/memoryDiagnostics'
import { selectUpcomingLoudnessWarmupTracks } from '../utils/loudnessWarmup'
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
type PlaybackIntent = 'context' | 'queue' | 'next' | 'previous' | 'resume' | 'direct' | 'automatic'
type PrebufferStatus = 'not_applicable' | 'miss' | 'ready' | 'in_flight' | 'in_flight_promoted'

interface PlaybackAttempt {
  id: number
  intent: PlaybackIntent
  commandStartedAtMs: number
  queuePreparationMs: number
  selectedTrackHydrationMs: number
  supersededLoadWaitMs: number
  prebufferStatus: PrebufferStatus
  completed: boolean
  playingAtMs: number | null
  transitionIdentity: PlaybackTransitionIdentity | null
}

interface PlaybackTransitionIdentity {
  intentId: number
  queueItemId: string | null
  standaloneTrackPath: string | null
}

interface CommittedPlaybackTransition {
  identity: PlaybackTransitionIdentity
  track: Track
}

interface PlaybackLoadOptions {
  manualStart?: boolean
  startTime?: number
  attempt?: PlaybackAttempt
}

interface PlaybackAttemptTimings {
  backend: 'standard' | 'exclusive' | 'bitperfect' | 'remote' | 'local_progressive' | 'prebuffer'
  loadRequestId?: number | null
  prebufferRequestId?: number | null
  decodeRequestId?: number | null
  fileReadMs?: number | null
  decodeMs?: number | null
  decodeOnlyMs?: number | null
  standardLoadPipelineMs?: number | null
  decodeWorkMs?: number | null
  loudnessMs?: number | null
  backendStartMs?: number | null
  validPcmBytes?: number | null
  backingBufferBytes?: number | null
  allocationGrowthCount?: number | null
  transportRoute?: 'invoke' | 'message_port_stream' | null
  mainHandlerMs?: number | null
  binaryResolutionMs?: number | null
  probeMs?: number | null
  probeCacheStatus?: 'hit' | 'miss' | 'bypass' | null
  probeDecodeOverlapEnabled?: boolean | null
  probeFfmpegOverlapMs?: number | null
  ffmpegMs?: number | null
  ffmpegSpawnToFirstPcmMs?: number | null
  ffmpegPcmOutputSpanMs?: number | null
  ffmpegCloseTailMs?: number | null
  pcmAllocationMs?: number | null
  initialPcmAllocationMs?: number | null
  growthPcmAllocationMs?: number | null
  payloadFinalizationMs?: number | null
  preloadInvokeMs?: number | null
  rendererBridgeCallMs?: number | null
  electronIpcResidualMs?: number | null
  contextBridgeResidualMs?: number | null
  streamChunkCount?: number | null
  streamDispatchCopyMs?: number | null
  streamDispatchPostMs?: number | null
  streamTailMs?: number | null
  rendererPcmAssemblyAllocationMs?: number | null
  rendererPcmAssemblyCopyMs?: number | null
  rendererPortRequestMs?: number | null
  streamTransportResidualMs?: number | null
  webAudioBufferAllocationMs?: number | null
  pcmDeinterleaveMs?: number | null
  pcmCommitMs?: number | null
  postDeliveryCommitMs?: number | null
  nativeBinaryResolutionMs?: number | null
  nativeProbeMs?: number | null
  nativeDecodeMs?: number | null
  nativeLoadMs?: number | null
  nativeDeviceStartMs?: number | null
}

function getStandardPcmTimingDetails(timings: AudioLoadTimings | null | undefined) {
  const decodeWorkMs = timings?.decodeWorkMs ?? timings?.decodeMs ?? null
  return {
    decodeRequestId: timings?.decodeRequestId ?? null,
    validPcmBytes: timings?.validPcmBytes ?? null,
    backingBufferBytes: timings?.backingBufferBytes ?? null,
    allocationGrowthCount: timings?.allocationGrowthCount ?? null,
    transportRoute: timings?.transportRoute ?? null,
    mainHandlerMs: timings?.mainHandlerMs ?? null,
    binaryResolutionMs: timings?.binaryResolutionMs ?? null,
    probeMs: timings?.probeMs ?? timings?.nativeProbeMs ?? null,
    probeCacheStatus: timings?.probeCacheStatus ?? null,
    probeDecodeOverlapEnabled: timings?.probeDecodeOverlapEnabled ?? null,
    probeFfmpegOverlapMs: timings?.probeFfmpegOverlapMs ?? null,
    ffmpegMs: timings?.ffmpegMs ?? timings?.nativeDecodeMs ?? null,
    ffmpegSpawnToFirstPcmMs: timings?.ffmpegSpawnToFirstPcmMs ?? null,
    ffmpegPcmOutputSpanMs: timings?.ffmpegPcmOutputSpanMs ?? null,
    ffmpegCloseTailMs: timings?.ffmpegCloseTailMs ?? null,
    pcmAllocationMs: timings?.pcmAllocationMs ?? null,
    initialPcmAllocationMs: timings?.initialPcmAllocationMs ?? null,
    growthPcmAllocationMs: timings?.growthPcmAllocationMs ?? null,
    payloadFinalizationMs: timings?.payloadFinalizationMs ?? null,
    preloadInvokeMs: timings?.preloadInvokeMs ?? null,
    rendererBridgeCallMs: timings?.rendererBridgeCallMs ?? null,
    electronIpcResidualMs: timings?.electronIpcResidualMs ?? null,
    contextBridgeResidualMs: timings?.contextBridgeResidualMs ?? null,
    streamChunkCount: timings?.streamChunkCount ?? null,
    streamDispatchCopyMs: timings?.streamDispatchCopyMs ?? null,
    streamDispatchPostMs: timings?.streamDispatchPostMs ?? null,
    streamTailMs: timings?.streamTailMs ?? null,
    rendererPcmAssemblyAllocationMs: timings?.rendererPcmAssemblyAllocationMs ?? null,
    rendererPcmAssemblyCopyMs: timings?.rendererPcmAssemblyCopyMs ?? null,
    rendererPortRequestMs: timings?.rendererPortRequestMs ?? null,
    streamTransportResidualMs: timings?.streamTransportResidualMs ?? null,
    webAudioBufferAllocationMs: timings?.webAudioBufferAllocationMs ?? null,
    pcmDeinterleaveMs: timings?.pcmDeinterleaveMs ?? null,
    pcmCommitMs: timings?.pcmCommitMs ?? null,
    postDeliveryCommitMs: timings?.postDeliveryCommitMs ?? null,
    decodeWorkMs
  }
}

interface PendingTransitionLoad {
  id: number
  intentId: number
  track: Track
  targetQueueItemId: string | null
  standaloneTrackPath: string | null
  options: PlaybackLoadOptions
  queuedAtMs: number
  backend: PlaybackAttemptTimings['backend']
  resolve: (outcome: PlaybackLoadOutcome) => void
  reject: (error: unknown) => void
}

interface PlaybackContextHydrationPlan {
  missingPaths: Set<string>
  commandStartedAtMs: number
  playbackIntentId: number
}

interface ContextTrackHydrationRecord {
  generation: number
  promise: Promise<DbTrack | null>
}

interface PlaybackInterruptionReconciliation {
  intentId: number
  desiredState: Extract<PlaybackState, 'paused' | 'stopped'>
  track: Track
  standaloneTrackPath: string | null
}

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
  // Persistent, not a timed cue: the output device refused this track's format in exclusive
  // mode, which stays true until the device or the playback mode changes.
  bitPerfectFormatNotice: {
    id: number
    trackTitle: string
    deviceLabel: string | null
    sampleRate: number | null
    channels: number | null
    sampleFormat: string | null
    message: string
    failureStage: string | null
    osCode: string | number | null
    report: string | null
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
  getResolvedUpcomingEntries: (limit?: number) => ResolvedQueueTrack[]
  getResolvedPreviousTracks: () => Track[]
  getResolvedPreviousEntries: () => ResolvedQueueTrack[]
  getResolvedNextTrack: () => Track | null
  getResolvedQueueLength: () => number
  clearFfmpegFallbackNotice: () => void
  clearOutputDelayNotice: () => void
  clearBitPerfectFormatNotice: () => void
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
  _loadAndPlayTrack: (track: Track, options?: PlaybackLoadOptions) => Promise<PlaybackLoadOutcome>
  _preBufferNextTrack: () => Promise<void>
  _schedulePreBufferNextTrack: (options?: { invalidatePending?: boolean }) => void
  _clearBufferedNextTrack: () => void
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
const LOUDNESS_WARMUP_UPCOMING_TRACKS = 1
export const GAPLESS_PREBUFFER_LEAD_SECONDS = 15
const GAPLESS_PREBUFFER_TIMER_TOLERANCE_MS = 250
const MAX_GAPLESS_PREBUFFER_TIMER_MS = 2_147_000_000
export const ADAPTIVE_PREBUFFER_SETTLE_MS = 1000
export const ADAPTIVE_PREBUFFER_IDLE_TIMEOUT_MS = 2000
export const CONTEXT_HYDRATION_BATCH_SIZE = 200
const STANDARD_TRANSITION_COALESCE_MS = 75
export const MAX_PLAYBACK_HISTORY = 500
export const PLAYER_VOLUME_STORAGE_KEY = 'astra-player-volume-v1'
const NATIVE_REMOTE_FAILURE_MESSAGE = 'Native exclusive playback is local-file-only. Switch to Standard to play remote or progressive sources.'
const IAMF_NATIVE_FAILURE_MESSAGE = 'Eclipsa (IAMF) and Parallax sources are Standard-only. Switch to Standard to play this track.'
let nextQueueItemId = 1
let nextPlaybackAttemptId = 1

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
  if (useAudioSettingsStore.getState().playbackOutputMode === 'bitperfect') return null
  if (!audioEngine.needsLoudnessAnalysisForLoad(replayGainDb)) return null
  const request = priority === 'background'
    ? window.electronAPI.warmupTrackLoudness(track.path)
    : window.electronAPI.analyzeTrackLoudness(track.path)
  return request.catch(() => null)
}

function supersedeInteractiveLoudnessAnalysis(trackPath: string | null): void {
  const supersede = window.electronAPI.supersedeTrackLoudness
  if (!supersede) return
  void supersede(trackPath).catch(() => {
    // Playback must remain independent from optional analysis coordination.
  })
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

function shouldUseNativeExclusivePath(track: Track | null | undefined): boolean {
  if (!track) return false
  const sourceType = track.sourceType ?? 'local'
  if (sourceType !== 'local') return false
  if (isIamfTrack(track)) return false
  return useAudioSettingsStore.getState().playbackOutputMode !== 'standard'
}

async function ensureCompatiblePlaybackMode(track: Track): Promise<void> {
  const sourceType = track.sourceType ?? 'local'
  const iamf = isIamfTrack(track)
  if (sourceType === 'local' && !iamf) {
    return
  }

  const audioSettings = useAudioSettingsStore.getState()
  if (audioSettings.playbackOutputMode === 'standard') {
    return
  }

  const message = sourceType !== 'local'
    ? NATIVE_REMOTE_FAILURE_MESSAGE
    : IAMF_NATIVE_FAILURE_MESSAGE
  throw createNativeOutputFailureError({
    deviceLabel: audioSettings.nativeAudioOutputStatus?.deviceLabel ?? null,
    sampleRate: track.sampleRate ?? null,
    channels: track.channels ?? null,
    sampleFormat: null,
    message,
    failureStage: 'source',
    osCode: null,
    report: `Native output failure\nStage: source\nMode: ${audioSettings.playbackOutputMode}\nTrack: ${track.path}\n${message}`
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
  let bitPerfectFormatNoticeId = 0
  // One dialog per distinct device/format rejection, so a whole album at an unsupported
  // rate doesn't reopen it on every track.
  const surfacedBitPerfectFormatFailures = new Set<string>()
  const associatedMetadataInflight = new Set<string>()
  let pendingManualLoadCueTrack: Track | null = null
  let recentPlaySession: RecentPlaySession | null = null
  let listeningHistoryStatusPromise: Promise<ListeningHistoryStatus> | null = null
  let activeLoadRequestId = 0
  let activePrebufferRequestId = 0
  let playbackIntentGeneration = 0
  let contextHydrationGeneration = 0
  let activeContextHydrationItems: readonly QueueItem[] = []
  const pendingContextMetadataPaths = new Map<string, number>()
  const contextTrackHydrationByPath = new Map<string, ContextTrackHydrationRecord>()
  // Keep exact queue-item ownership until a request settles. A newer context may
  // preserve an unresolved item in playback history; Previous must be able to
  // promote that original request without letting its stale generation patch a
  // different queue item that happens to share the same path.
  const contextTrackHydrationByQueueId = new Map<string, ContextTrackHydrationRecord>()
  let nextTransitionLoadId = 1
  let activeStandardTransitionLoads = 0
  let pendingStandardTransition: PendingTransitionLoad | null = null
  let standardTransitionTimerId: ReturnType<typeof globalThis.setTimeout> | null = null
  let activeNativeTransitionLoad: Promise<void> | null = null
  let activeNativeControl: Promise<void> | null = null
  let activeStandaloneNativeLoad = false
  let pendingNativeTransition: PendingTransitionLoad | null = null
  let activeExecutingTransition: PendingTransitionLoad | null = null
  let committedPlaybackTransition: CommittedPlaybackTransition | null = null
  let pendingNativeSeek: {
    intentId: number
    targetTime: number
    dirty: boolean
    operation: Promise<void> | null
  } | null = null
  let prebufferScheduleTimerId: ReturnType<typeof globalThis.setTimeout> | null = null
  let prebufferScheduleDueAtMs: number | null = null
  let prebufferScheduleTrackPath: string | null = null
  let prebufferIdleCallbackId: number | null = null
  let prebufferIdleTrackPath: string | null = null
  let prebufferIdleDueAtMs: number | null = null
  let prebufferInFlightRequestId: number | null = null
  let prebufferInFlightTrackPath: string | null = null
  let prebufferInFlightPromise: Promise<void> | null = null
  let completedPrebufferRequestId: number | null = null
  let completedPrebufferTrackPath: string | null = null
  let prebufferAttemptedTrackPath: string | null = null
  let prebufferRetryAtLateTrackPath: string | null = null
  let prebufferLateRetryAttemptedTrackPath: string | null = null
  let manualGaplessTransitionInProgress = false
  let preAppliedGaplessQueueItemId: string | null = null
  let completedPreAppliedGaplessQueueItemId: string | null = null
  let pendingPlaybackInterruptionReconciliation: PlaybackInterruptionReconciliation | null = null
  let standaloneTransitionTrackPath: string | null = null
  let standaloneTransitionIntentId: number | null = null
  let nextPlaybackIntentOverride: PlaybackIntent | null = null

  const resetContextHydrationTracking = (): void => {
    activeContextHydrationItems = []
    pendingContextMetadataPaths.clear()
    contextTrackHydrationByPath.clear()
  }

  const createPlaybackAttempt = (
    intent: PlaybackIntent,
    commandStartedAtMs: number = performance.now(),
    details: Partial<Pick<PlaybackAttempt, 'queuePreparationMs' | 'supersededLoadWaitMs' | 'prebufferStatus'>> = {}
  ): PlaybackAttempt => ({
    id: nextPlaybackAttemptId++,
    intent,
    commandStartedAtMs,
    queuePreparationMs: details.queuePreparationMs ?? 0,
    selectedTrackHydrationMs: 0,
    supersededLoadWaitMs: details.supersededLoadWaitMs ?? 0,
    prebufferStatus: details.prebufferStatus ?? 'not_applicable',
    completed: false,
    playingAtMs: null,
    transitionIdentity: null
  })

  const transitionIdentitiesMatch = (
    left: PlaybackTransitionIdentity,
    right: PlaybackTransitionIdentity
  ): boolean => (
    left.intentId === right.intentId
    && left.queueItemId === right.queueItemId
    && left.standaloneTrackPath === right.standaloneTrackPath
  )

  const clearCommittedPlaybackTransition = (identity: PlaybackTransitionIdentity | null): void => {
    if (
      identity
      && committedPlaybackTransition
      && transitionIdentitiesMatch(committedPlaybackTransition.identity, identity)
    ) {
      committedPlaybackTransition = null
    }
  }

  const commitPlaybackTransition = (
    attempt: PlaybackAttempt,
    intentId: number,
    track: Track,
    options: { queueItemId?: string | null; standaloneTrackPath?: string | null } = {}
  ): void => {
    if (!isCurrentPlaybackIntent(intentId)) return
    const state = get()
    const standaloneTrackPath = options.standaloneTrackPath !== undefined
      ? options.standaloneTrackPath
      : standaloneTransitionIntentId === intentId && standaloneTransitionTrackPath === track.path
        ? track.path
        : null
    const candidateQueueItemId = options.queueItemId !== undefined
      ? options.queueItemId
      : standaloneTrackPath
        ? null
        : state.currentQueueItemId
    const queueItem = candidateQueueItemId
      ? state.queueItems.find((item) => item.queueId === candidateQueueItemId)
      : null
    const queueItemId = !standaloneTrackPath && queueItem?.entry.path === track.path
      ? queueItem.queueId
      : null
    const identity: PlaybackTransitionIdentity = {
      intentId,
      queueItemId,
      standaloneTrackPath
    }
    attempt.transitionIdentity = identity
    committedPlaybackTransition = { identity, track }
  }

  const completePlaybackAttempt = (
    attempt: PlaybackAttempt,
    track: Track,
    outcome: PlaybackLoadOutcome,
    timings: PlaybackAttemptTimings
  ): void => {
    if (attempt.completed) return
    attempt.completed = true
    clearCommittedPlaybackTransition(attempt.transitionIdentity)
    const audioSettings = useAudioSettingsStore.getState()
    const completedAtMs = performance.now()
    const commandToScheduledPlayMs = outcome === 'loaded' && attempt.playingAtMs !== null
      ? Math.max(0, Math.round(attempt.playingAtMs - attempt.commandStartedAtMs))
      : null
    // Compatibility alias: this endpoint has always meant source scheduled/state
    // changed, not hardware-audible output.
    const totalCommandToPlayingMs = commandToScheduledPlayMs
    logMemoryDiagnosticsEvent('playback_attempt_completed', {
      attemptId: attempt.id,
      loadRequestId: timings.loadRequestId ?? null,
      prebufferRequestId: timings.prebufferRequestId ?? null,
      decodeRequestId: timings.decodeRequestId ?? null,
      intent: attempt.intent,
      outcome,
      trackPath: track.path,
      sourceType: track.sourceType ?? 'local',
      backend: timings.backend,
      queuePreparationMs: Math.round(attempt.queuePreparationMs),
      selectedTrackHydrationMs: Math.round(attempt.selectedTrackHydrationMs),
      supersededLoadWaitMs: Math.round(attempt.supersededLoadWaitMs),
      prebufferStatus: attempt.prebufferStatus,
      fileReadMs: timings.fileReadMs ?? null,
      decodeMs: timings.decodeMs ?? null,
      decodeOnlyMs: timings.decodeOnlyMs ?? null,
      standardLoadPipelineMs: timings.standardLoadPipelineMs ?? null,
      decodeWorkMs: timings.decodeWorkMs ?? null,
      loudnessMs: timings.loudnessMs ?? null,
      backendStartMs: timings.backendStartMs ?? null,
      validPcmBytes: timings.validPcmBytes ?? null,
      backingBufferBytes: timings.backingBufferBytes ?? null,
      allocationGrowthCount: timings.allocationGrowthCount ?? null,
      transportRoute: timings.transportRoute ?? null,
      mainHandlerMs: timings.mainHandlerMs ?? null,
      binaryResolutionMs: timings.binaryResolutionMs ?? null,
      probeMs: timings.probeMs ?? null,
      probeCacheStatus: timings.probeCacheStatus ?? null,
      probeDecodeOverlapEnabled: timings.probeDecodeOverlapEnabled ?? null,
      probeFfmpegOverlapMs: timings.probeFfmpegOverlapMs ?? null,
      ffmpegMs: timings.ffmpegMs ?? null,
      ffmpegSpawnToFirstPcmMs: timings.ffmpegSpawnToFirstPcmMs ?? null,
      ffmpegPcmOutputSpanMs: timings.ffmpegPcmOutputSpanMs ?? null,
      ffmpegCloseTailMs: timings.ffmpegCloseTailMs ?? null,
      pcmAllocationMs: timings.pcmAllocationMs ?? null,
      initialPcmAllocationMs: timings.initialPcmAllocationMs ?? null,
      growthPcmAllocationMs: timings.growthPcmAllocationMs ?? null,
      payloadFinalizationMs: timings.payloadFinalizationMs ?? null,
      preloadInvokeMs: timings.preloadInvokeMs ?? null,
      rendererBridgeCallMs: timings.rendererBridgeCallMs ?? null,
      electronIpcResidualMs: timings.electronIpcResidualMs ?? null,
      contextBridgeResidualMs: timings.contextBridgeResidualMs ?? null,
      streamChunkCount: timings.streamChunkCount ?? null,
      streamDispatchCopyMs: timings.streamDispatchCopyMs ?? null,
      streamDispatchPostMs: timings.streamDispatchPostMs ?? null,
      streamTailMs: timings.streamTailMs ?? null,
      rendererPcmAssemblyAllocationMs: timings.rendererPcmAssemblyAllocationMs ?? null,
      rendererPcmAssemblyCopyMs: timings.rendererPcmAssemblyCopyMs ?? null,
      rendererPortRequestMs: timings.rendererPortRequestMs ?? null,
      streamTransportResidualMs: timings.streamTransportResidualMs ?? null,
      webAudioBufferAllocationMs: timings.webAudioBufferAllocationMs ?? null,
      pcmDeinterleaveMs: timings.pcmDeinterleaveMs ?? null,
      pcmCommitMs: timings.pcmCommitMs ?? null,
      postDeliveryCommitMs: timings.postDeliveryCommitMs ?? null,
      nativeBinaryResolutionMs: timings.nativeBinaryResolutionMs ?? null,
      nativeProbeMs: timings.nativeProbeMs ?? null,
      nativeDecodeMs: timings.nativeDecodeMs ?? null,
      nativeLoadMs: timings.nativeLoadMs ?? null,
      nativeDeviceStartMs: timings.nativeDeviceStartMs ?? null,
      commandToScheduledPlayMs,
      totalCommandToPlayingMs,
      totalAttemptMs: Math.max(0, Math.round(completedAtMs - attempt.commandStartedAtMs)),
      configuredOutputDelayMs: audioSettings.effectiveDelayMs
    })
    logSlowPath('playbackAttempt', attempt.commandStartedAtMs, {
      attemptId: attempt.id,
      intent: attempt.intent,
      outcome,
      trackPath: track.path,
      backend: timings.backend,
      commandToScheduledPlayMs,
      totalCommandToPlayingMs
    })
  }

  const markPlaybackAttemptPlaying = (attempt: PlaybackAttempt): void => {
    if (attempt.playingAtMs === null) attempt.playingAtMs = performance.now()
  }

  const getPromotedPrebufferAttemptTimings = (
    prebufferRequestId: number | null,
    backendStartMs?: number | null
  ): PlaybackAttemptTimings => {
    const engineTimings = audioEngine.getLastLoadTimings()
    const pcmTimingDetails = getStandardPcmTimingDetails(engineTimings)
    const standardLoadPipelineMs = engineTimings?.standardLoadPipelineMs ?? null
    const decodeWorkMs = engineTimings?.decodeWorkMs ?? engineTimings?.decodeMs ?? null
    return {
      backend: 'prebuffer',
      prebufferRequestId,
      ...pcmTimingDetails,
      decodeMs: standardLoadPipelineMs,
      decodeOnlyMs: decodeWorkMs,
      standardLoadPipelineMs,
      decodeWorkMs,
      loudnessMs: engineTimings?.analysisMs ?? null,
      backendStartMs: backendStartMs ?? null
    }
  }

  const isParallaxSinkModeActive = (): boolean => {
    return Boolean(useParallaxStore.getState().status?.sink.connected)
  }

  const playWithParallaxIfNeeded = async (
    track: Track | null | undefined,
    isCurrent: () => boolean = () => true
  ): Promise<void> => {
    if (!isCurrent()) throw new SupersededPlaybackLoadError()
    if (isParallaxSinkModeActive()) return
    const parallaxStore = useParallaxStore.getState()
    const resumeTimeline = await parallaxStore.resumeHostPlayback(track)
    if (!isCurrent()) throw new SupersededPlaybackLoadError()
    if (resumeTimeline) {
      await audioEngine.playCurrentBufferOnParallaxTimeline(resumeTimeline)
      return
    }
    const timeline = track ? await useParallaxStore.getState().prepareHostPlayback(track) : null
    if (!isCurrent()) throw new SupersededPlaybackLoadError()
    if (timeline) {
      await audioEngine.playCurrentBufferOnParallaxTimeline(timeline)
      return
    }
    if (!isCurrent()) throw new SupersededPlaybackLoadError()
    await audioEngine.play()
  }

  const clearScheduledPrebufferTimer = (): void => {
    if (prebufferScheduleTimerId !== null) {
      globalThis.clearTimeout(prebufferScheduleTimerId)
      prebufferScheduleTimerId = null
    }
    if (prebufferIdleCallbackId !== null && typeof globalThis.cancelIdleCallback === 'function') {
      globalThis.cancelIdleCallback(prebufferIdleCallbackId)
      prebufferIdleCallbackId = null
    }
    prebufferIdleCallbackId = null
    prebufferIdleTrackPath = null
    prebufferIdleDueAtMs = null
    prebufferScheduleDueAtMs = null
    prebufferScheduleTrackPath = null
  }

  const invalidatePrebufferRequest = (): void => {
    activePrebufferRequestId += 1
    prebufferInFlightRequestId = null
    prebufferInFlightTrackPath = null
    prebufferInFlightPromise = null
    prebufferAttemptedTrackPath = null
    prebufferRetryAtLateTrackPath = null
    prebufferLateRetryAttemptedTrackPath = null
  }

  const clearBufferedNextTrack = (): void => {
    const hadNativePrebufferInFlight = audioEngine.getPlaybackOutputMode() !== 'standard'
      && prebufferInFlightPromise !== null
    clearScheduledPrebufferTimer()
    invalidatePrebufferRequest()
    completedPrebufferRequestId = null
    completedPrebufferTrackPath = null
    if (audioEngine.getPlaybackOutputMode() !== 'standard') {
      if (hadNativePrebufferInFlight) audioEngine.cancelPendingNativeDecode()
      const clearIntentId = playbackIntentGeneration
      void runNativeControlAfterActiveTransition(clearIntentId, () => audioEngine.clearNextBuffer())
    } else {
      audioEngine.clearNextBuffer()
    }
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

  const getAttemptBackend = (track: Track): PlaybackAttemptTimings['backend'] => {
    if (shouldUseNativeExclusivePath(track)) {
      return useAudioSettingsStore.getState().playbackOutputMode === 'exclusive'
        ? 'exclusive'
        : 'bitperfect'
    }
    if (track.sourceType && track.sourceType !== 'local') return 'remote'
    return 'standard'
  }

  const supersedePendingTransition = (request: PendingTransitionLoad | null): void => {
    if (!request) return
    request.options.attempt!.supersededLoadWaitMs += Math.max(0, performance.now() - request.queuedAtMs)
    completePlaybackAttempt(request.options.attempt!, request.track, 'superseded', {
      backend: request.backend
    })
    request.resolve('superseded')
  }

  const cancelPendingTransitionLoads = (): void => {
    supersedePendingTransition(pendingStandardTransition)
    pendingStandardTransition = null
    supersedePendingTransition(pendingNativeTransition)
    pendingNativeTransition = null
    if (standardTransitionTimerId !== null) {
      globalThis.clearTimeout(standardTransitionTimerId)
      standardTransitionTimerId = null
    }
  }

  const beginPlaybackIntent = (): number => {
    playbackIntentGeneration += 1
    cancelPendingTransitionLoads()
    // An obsolete Standard request may continue unwinding in parallel, but it
    // must no longer identify itself as the transition that owns player state.
    activeExecutingTransition = null
    committedPlaybackTransition = null
    pendingNativeSeek = null
    // Supersede the active track load as soon as the user's newer intent is
    // accepted, including while its context metadata is still hydrating. Do
    // not call invalidateLoadRequest() here: a matching next-track prebuffer
    // remains eligible for promotion by the newer intent.
    activeLoadRequestId += 1
    audioEngine.supersedeCurrentLoadPreservingPrebuffer()
    const hadPreAppliedTransition = preAppliedGaplessQueueItemId !== null
    preAppliedGaplessQueueItemId = null
    completedPreAppliedGaplessQueueItemId = null
    const hadPendingInterruption = pendingPlaybackInterruptionReconciliation !== null
    pendingPlaybackInterruptionReconciliation = null
    standaloneTransitionTrackPath = null
    standaloneTransitionIntentId = null
    if (
      activeNativeTransitionLoad
      || activeStandaloneNativeLoad
      || hadPreAppliedTransition
      || hadPendingInterruption
    ) {
      audioEngine.cancelPendingNativeDecode()
    }
    return playbackIntentGeneration
  }

  const isCurrentPlaybackIntent = (intentId: number): boolean => intentId === playbackIntentGeneration

  const runNativeControlAfterActiveTransition = (
    intentId: number,
    control: () => void | Promise<void>
  ): Promise<void> => {
    const barrier = activeNativeControl ?? activeNativeTransitionLoad
    const runIfCurrent = async (): Promise<void> => {
      if (isCurrentPlaybackIntent(intentId)) await Promise.resolve(control())
    }
    const operation = barrier
      ? barrier.then(runIfCurrent, runIfCurrent)
      : runIfCurrent()
    activeNativeControl = operation
    const settle = (): void => {
      if (activeNativeControl === operation) activeNativeControl = null
      drainNativeTransitions()
      if (!activeNativeTransitionLoad && !activeNativeControl && standardTransitionTimerId === null) {
        flushPendingStandardTransition()
      }
    }
    void operation.then(settle, settle)
    return operation
  }

  const runSerializedNativeSeek = (intentId: number, targetTime: number): Promise<void> => {
    const existing = pendingNativeSeek
    if (existing && existing.intentId === intentId) {
      existing.targetTime = targetTime
      existing.dirty = true
      return existing.operation ?? Promise.resolve()
    }

    const request = {
      intentId,
      targetTime,
      dirty: false,
      operation: null as Promise<void> | null
    }
    pendingNativeSeek = request
    const operation = runNativeControlAfterActiveTransition(intentId, async () => {
      do {
        request.dirty = false
        const latestTargetTime = request.targetTime
        await audioEngine.seek(latestTargetTime)
      } while (request.dirty && isCurrentPlaybackIntent(intentId))
    })
    request.operation = operation
    const settle = (): void => {
      if (pendingNativeSeek === request) pendingNativeSeek = null
    }
    void operation.then(settle, settle)
    return operation
  }

  const clearNonmatchingPrebufferForIntent = (
    intentId: number,
    targetTrackPath: string
  ): void => {
    // A newly committed target owns the transition immediately, even if its
    // metadata still needs fetching. Keep only work that can be promoted to
    // that exact target; otherwise a natural gapless handoff could advance the
    // queue to the old buffered track during the metadata wait.
    clearScheduledPrebufferTimer()
    const bufferedPath = audioEngine.nextBufferedTrackPath
    const hasBufferedWork = audioEngine.hasNextBuffered || bufferedPath !== null
    const hasInFlightWork = prebufferInFlightPromise !== null && prebufferInFlightTrackPath !== null
    const hasNonmatchingWork = (
      (hasBufferedWork && bufferedPath !== targetTrackPath)
      || (hasInFlightWork && prebufferInFlightTrackPath !== targetTrackPath)
    )
    if (!hasNonmatchingWork) return

    const cancelNativePrebufferDecode = audioEngine.getPlaybackOutputMode() !== 'standard'
      && hasInFlightWork
    invalidatePrebufferRequest()
    void useParallaxStore.getState().cancelHostNextStream()
    if (audioEngine.getPlaybackOutputMode() !== 'standard') {
      if (cancelNativePrebufferDecode) audioEngine.cancelPendingNativeDecode()
      void runNativeControlAfterActiveTransition(intentId, () => audioEngine.clearNextBuffer())
      return
    }
    audioEngine.clearNextBuffer()
  }

  const executeTransitionLoad = async (request: PendingTransitionLoad): Promise<void> => {
    request.options.attempt!.supersededLoadWaitMs += Math.max(0, performance.now() - request.queuedAtMs)
    if (request.intentId === playbackIntentGeneration) {
      activeExecutingTransition = request
    }
    try {
      const outcome = await get()._loadAndPlayTrack(request.track, request.options)
      request.resolve(outcome)
    } catch (error) {
      if (isSupersededAudioLoadError(error) || error instanceof SupersededPlaybackLoadError) {
        completePlaybackAttempt(request.options.attempt!, request.track, 'superseded', {
          backend: request.backend
        })
        request.resolve('superseded')
        return
      }
      completePlaybackAttempt(request.options.attempt!, request.track, 'failed', {
        backend: request.backend
      })
      request.reject(error)
    } finally {
      if (activeExecutingTransition === request) activeExecutingTransition = null
    }
  }

  const startStandardTransition = (request: PendingTransitionLoad): void => {
    if (shouldUseNativeExclusivePath(request.track)) {
      supersedePendingTransition(pendingNativeTransition)
      pendingNativeTransition = request
      drainNativeTransitions()
      return
    }
    activeStandardTransitionLoads += 1
    const settle = (): void => {
      activeStandardTransitionLoads = Math.max(0, activeStandardTransitionLoads - 1)
    }
    void executeTransitionLoad(request).then(settle, settle)
  }

  const flushPendingStandardTransition = (): void => {
    if (!pendingStandardTransition || activeNativeTransitionLoad || activeNativeControl) return
    const request = pendingStandardTransition
    pendingStandardTransition = null
    startStandardTransition(request)
  }

  const schedulePendingStandardTransition = (): void => {
    if (standardTransitionTimerId !== null) {
      globalThis.clearTimeout(standardTransitionTimerId)
    }
    standardTransitionTimerId = globalThis.setTimeout(() => {
      standardTransitionTimerId = null
      flushPendingStandardTransition()
    }, STANDARD_TRANSITION_COALESCE_MS)
  }

  const drainNativeTransitions = (): void => {
    if (activeNativeTransitionLoad || activeNativeControl || !pendingNativeTransition) return
    const request = pendingNativeTransition
    pendingNativeTransition = null
    if (!shouldUseNativeExclusivePath(request.track)) {
      startStandardTransition(request)
      return
    }
    const operation = executeTransitionLoad(request)
    activeNativeTransitionLoad = operation
    const settle = (): void => {
      if (activeNativeTransitionLoad === operation) {
        activeNativeTransitionLoad = null
      }
      drainNativeTransitions()
      if (!activeNativeTransitionLoad && !activeNativeControl && standardTransitionTimerId === null) {
        flushPendingStandardTransition()
      }
    }
    void operation.then(settle, settle)
  }

  // Standard decoding is safe to supersede: the first request starts immediately and
  // subsequent rapid requests collapse into a 75 ms latest-wins window. Native control
  // calls remain strictly serialized; only their abortable probe/decode phase is canceled.
  const runSerializedTrackLoad = (
    track: Track,
    options: PlaybackLoadOptions = {},
    intent: PlaybackIntent = 'next'
  ): Promise<PlaybackLoadOutcome> => {
    invalidateLoadRequest()
    const normalizedOptions: PlaybackLoadOptions = {
      ...options,
      attempt: options.attempt ?? createPlaybackAttempt(intent)
    }
    const transitionState = get()
    const requestStandaloneTrackPath = standaloneTransitionTrackPath === track.path
      && standaloneTransitionIntentId === playbackIntentGeneration
      ? track.path
      : null
    const requestQueueItem = !requestStandaloneTrackPath && transitionState.currentQueueItemId
      ? transitionState.queueItems.find((item) => item.queueId === transitionState.currentQueueItemId)
      : null
    const requestQueueItemId = requestQueueItem?.entry.path === track.path
      ? requestQueueItem.queueId
      : null
    const attempt = normalizedOptions.attempt!
    if (!attempt.transitionIdentity) {
      commitPlaybackTransition(attempt, playbackIntentGeneration, track, {
        queueItemId: requestQueueItemId,
        standaloneTrackPath: requestStandaloneTrackPath
      })
    }
    const requestIdentity = attempt.transitionIdentity

    return new Promise<PlaybackLoadOutcome>((resolve, reject) => {
      const request: PendingTransitionLoad = {
        id: nextTransitionLoadId++,
        intentId: requestIdentity?.intentId ?? playbackIntentGeneration,
        track,
        targetQueueItemId: requestIdentity?.queueItemId ?? requestQueueItemId,
        standaloneTrackPath: requestIdentity?.standaloneTrackPath ?? requestStandaloneTrackPath,
        options: normalizedOptions,
        queuedAtMs: performance.now(),
        backend: getAttemptBackend(track),
        resolve,
        reject
      }

      if (activeNativeTransitionLoad) {
        void audioEngine.cancelPendingNativeDecode?.()
      }

      if (shouldUseNativeExclusivePath(track)) {
        supersedePendingTransition(pendingStandardTransition)
        pendingStandardTransition = null
        if (standardTransitionTimerId !== null) {
          globalThis.clearTimeout(standardTransitionTimerId)
          standardTransitionTimerId = null
        }
        supersedePendingTransition(pendingNativeTransition)
        pendingNativeTransition = request
        drainNativeTransitions()
        return
      }

      supersedePendingTransition(pendingNativeTransition)
      pendingNativeTransition = null

      if (
        activeStandardTransitionLoads === 0
        && !activeNativeTransitionLoad
        && !activeNativeControl
        && !pendingStandardTransition
        && standardTransitionTimerId === null
      ) {
        startStandardTransition(request)
        return
      }

      supersedePendingTransition(pendingStandardTransition)
      pendingStandardTransition = request
      schedulePendingStandardTransition()
    })
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
    const activeItem = state.currentQueueItemId
      ? state.queueItems.find((item) => item.queueId === state.currentQueueItemId)
      : null
    if (activeItem) return { item: activeItem }
    if (!state.currentTrack) return null
    return {
      item: createQueueItem(createQueueEntryFromTrack(state.currentTrack), 'manual')
    }
  }

  const resolveAuthoritativeTransitionTrack = (
    request: PendingTransitionLoad | null,
    state: PlayerStore
  ): Track | null => {
    if (!request || request.intentId !== playbackIntentGeneration) return null
    if (request.standaloneTrackPath) {
      return standaloneTransitionIntentId === request.intentId
        && standaloneTransitionTrackPath === request.standaloneTrackPath
        ? request.track
        : null
    }
    if (!request.targetQueueItemId || state.currentQueueItemId !== request.targetQueueItemId) return null
    const targetItem = state.queueItems.find((item) => item.queueId === request.targetQueueItemId)
    return resolveQueueEntryTrack(targetItem?.entry) ?? request.track
  }

  const getCommittedTransitionTarget = (state: PlayerStore = get()): Track | null => {
    const committed = committedPlaybackTransition
    if (committed?.identity.intentId === playbackIntentGeneration) {
      const { identity } = committed
      if (
        identity.standaloneTrackPath
        && standaloneTransitionIntentId === identity.intentId
        && standaloneTransitionTrackPath === identity.standaloneTrackPath
      ) {
        return committed.track
      }
      if (identity.queueItemId && state.currentQueueItemId === identity.queueItemId) {
        const committedItem = state.queueItems.find((item) => item.queueId === identity.queueItemId)
        return resolveQueueEntryTrack(committedItem?.entry) ?? committed.track
      }
    }
    // Exact queue-item identity matters here: authored duplicates may share one
    // path while a newer occurrence is waiting or between decode and backend start.
    for (const request of [pendingStandardTransition, pendingNativeTransition, activeExecutingTransition]) {
      const authoritativeTrack = resolveAuthoritativeTransitionTrack(request, state)
      if (authoritativeTrack) return authoritativeTrack
    }
    if (!state.currentQueueItemId) {
      return state.playbackState === 'loading' ? state.currentTrack : null
    }
    const currentItem = state.queueItems.find((item) => item.queueId === state.currentQueueItemId)
    const targetTrack = resolveQueueEntryTrack(currentItem?.entry)
    if (!targetTrack) return state.playbackState === 'loading' ? state.currentTrack : null
    const targetsDifferentTrack = !state.currentTrack || state.currentTrack.path !== targetTrack.path
    if (state.currentTrack?.path === standaloneTransitionTrackPath) {
      return state.playbackState === 'loading' ? state.currentTrack : null
    }
    if (preAppliedGaplessQueueItemId === currentItem?.queueId) {
      return targetTrack
    }
    // A rapid queue transition can commit its final target while an older load
    // still owns currentTrack. In that case the committed queue item wins.
    if (targetsDifferentTrack) return targetTrack
    // Once that target's load begins, currentTrack is authoritative.
    if (state.playbackState === 'loading') return state.currentTrack ?? targetTrack
    return null
  }

  const applyPlaybackInterruptionReconciliation = (
    reconciliation: PlaybackInterruptionReconciliation
  ): void => {
    const { desiredState, track } = reconciliation
    if (reconciliation.standaloneTrackPath === track.path) {
      standaloneTransitionTrackPath = track.path
      standaloneTransitionIntentId = reconciliation.intentId
    }
    set({
      currentTrack: track,
      playbackState: desiredState,
      currentTime: 0,
      duration: track.duration,
      waveformData: null,
      waveformBufferedRatio: track.sourceType && track.sourceType !== 'local' ? 0 : 1,
      waveformAnalyzedRatio: track.sourceType && track.sourceType !== 'local' ? 0 : 1,
      remoteLoadProgress: null,
      loadingStatus: null,
      remoteBufferedSeconds: 0,
      remoteStreamSessionId: null,
      restoredTrackNeedsLoad: true,
      restoredPlaybackTime: 0
    })
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

  /**
   * Surfaces a device format rejection. Returns true when the error was one, so callers can
   * skip the generic "load failed" path.
   */
  const showBitPerfectFormatNotice = (track: Track, error: unknown): boolean => {
    const failure = parseBitPerfectFormatError(error)
    if (!failure) return false

    const dedupeKey = [
      failure.deviceLabel ?? '',
      failure.sampleRate ?? '',
      failure.channels ?? '',
      failure.sampleFormat ?? '',
      failure.failureStage ?? ''
    ].join('|')
    if (surfacedBitPerfectFormatFailures.has(dedupeKey)) return true
    surfacedBitPerfectFormatFailures.add(dedupeKey)

    bitPerfectFormatNoticeId += 1
    set({
      bitPerfectFormatNotice: {
        id: bitPerfectFormatNoticeId,
        trackTitle: track.title,
        deviceLabel: failure.deviceLabel,
        sampleRate: failure.sampleRate,
        channels: failure.channels,
        sampleFormat: failure.sampleFormat,
        message: failure.message,
        failureStage: failure.failureStage,
        osCode: failure.osCode,
        report: failure.report
      }
    })
    return true
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

  const queueItemsByIdCache = new WeakMap<QueueItem[], ReadonlyMap<string, QueueItem>>()

  const getQueueItemsById = (queueItems: QueueItem[]): ReadonlyMap<string, QueueItem> => {
    const cached = queueItemsByIdCache.get(queueItems)
    if (cached) return cached

    const itemsById = new Map<string, QueueItem>()
    for (const item of queueItems) {
      itemsById.set(item.queueId, item)
    }
    queueItemsByIdCache.set(queueItems, itemsById)
    return itemsById
  }

  const buildResolvedUpcomingEntries = (
    state: Pick<PlayerStore, 'queueItems' | 'upcomingQueueIds'>,
    limit?: number
  ): ResolvedQueueTrack[] => {
    const normalizedLimit = limit === undefined || limit === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(limit)
        ? Math.max(0, Math.floor(limit))
        : 0
    if (normalizedLimit === 0) return []

    const itemsById = getQueueItemsById(state.queueItems)
    const resolved: ResolvedQueueTrack[] = []
    for (let index = 0; index < state.upcomingQueueIds.length; index += 1) {
      const queueId = state.upcomingQueueIds[index]!
      const item = itemsById.get(queueId)
      const track = resolveQueueEntryTrack(item?.entry)
      if (!item || !track) continue
      resolved.push({
        queueId,
        source: 'upcoming',
        origin: item.origin,
        track,
        index
      })
      if (resolved.length >= normalizedLimit) break
    }

    return resolved
  }

  function* iterateNextCandidates(state: PlayerStore): Generator<NextCandidate> {
    if (state.repeat === 'one' && state.currentTrack) {
      yield { kind: 'current', track: state.currentTrack }
      return
    }

    const itemsById = getQueueItemsById(state.queueItems)
    let foundQueueCandidate = false
    for (let index = 0; index < state.upcomingQueueIds.length; index += 1) {
      const queueId = state.upcomingQueueIds[index]!
      const item = itemsById.get(queueId)
      const track = resolveQueueEntryTrack(item?.entry)
      if (!item || !track) continue
      foundQueueCandidate = true
      yield { kind: 'queue', item, track, index }
    }

    if (!foundQueueCandidate && state.repeat === 'all' && state.currentTrack) {
      const currentItem = state.currentQueueItemId
        ? itemsById.get(state.currentQueueItemId)
        : null
      if (currentItem && state.queueItems.length === 1) {
        yield { kind: 'current', track: state.currentTrack }
      }
    }
  }

  const findNextPlayableCandidate = (state: PlayerStore): NextCandidate | null => {
    for (const candidate of iterateNextCandidates(state)) {
      if (isUnavailableRemoteTrack(candidate.track)) continue
      return candidate
    }
    return null
  }

  const resolveExpectedPrebufferTrack = (state: PlayerStore = get()): Track | null => {
    if (state.repeat === 'one') return null

    for (const candidate of iterateNextCandidates(state)) {
      const candidateTrack = candidate.track
      if (!candidateTrack) continue
      if (isUnavailableRemoteTrack(candidateTrack)) continue
      // Path-only context snapshots intentionally omit source metadata. Do not
      // treat one as a local file until its already-scheduled hydration settles;
      // it may actually be a remote entry that must never be prebuffered.
      if (pendingContextMetadataPaths.get(candidateTrack.path) === contextHydrationGeneration) {
        void getOrStartContextTrackHydration(
          candidateTrack.path,
          candidate.kind === 'queue' ? candidate.item.queueId : state.currentQueueItemId
        )
        return null
      }
      // The first playable queue entry defines the handoff. Never prebuffer a local
      // track hidden behind a remote entry.
      if (candidateTrack.sourceType && candidateTrack.sourceType !== 'local') return null
      return candidateTrack
    }

    return null
  }

  const resolveExpectedPrebufferTrackPath = (state: PlayerStore = get()): string | null => (
    resolveExpectedPrebufferTrack(state)?.path ?? null
  )

  const warmupUpcomingLoudness = (): void => {
    const audioSettings = useAudioSettingsStore.getState()
    if (!audioSettings.normalizationEnabled || audioSettings.playbackOutputMode !== 'standard') return
    const state = get()
    if (state.repeat === 'one') return

    const upcomingTracks = (function* (): Generator<Track> {
      for (const candidate of iterateNextCandidates(state)) {
        yield candidate.track
      }
    })()
    const tracks = selectUpcomingLoudnessWarmupTracks(
      upcomingTracks,
      (track) => {
        const replayGainDb = getReplayGainCandidateDb(track, audioSettings.replayGainMode)
        return audioEngine.needsLoudnessAnalysisForLoad(replayGainDb)
      },
      LOUDNESS_WARMUP_UPCOMING_TRACKS
    )
    for (const track of tracks) {
      const replayGainDb = getReplayGainCandidateDb(track, audioSettings.replayGainMode)
      const request = requestTrackLoudnessAnalysis(track, replayGainDb, 'background')
      if (request) void request
    }
  }

  const startPrebufferNextTrack = (): Promise<void> => {
    const expectedTrackPath = resolveExpectedPrebufferTrackPath()
    if (
      expectedTrackPath
      && prebufferInFlightTrackPath === expectedTrackPath
      && prebufferInFlightPromise
    ) {
      return prebufferInFlightPromise
    }

    const operation = get()._preBufferNextTrack()
    prebufferInFlightPromise = operation
    void operation.then(
      () => {
        if (prebufferInFlightPromise === operation) prebufferInFlightPromise = null
        if (
          prebufferRetryAtLateTrackPath
          && prebufferRetryAtLateTrackPath === resolveExpectedPrebufferTrackPath()
          && !audioEngine.hasNextBuffered
        ) {
          schedulePreBufferNextTrack()
        }
      },
      () => {
        if (prebufferInFlightPromise === operation) prebufferInFlightPromise = null
      }
    )
    return operation
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
    const expectedTrack = resolveExpectedPrebufferTrack(state)
    const expectedTrackPath = expectedTrack?.path ?? null
    const activeOutputMode = audioEngine.getPlaybackOutputMode()
    const usesNativePrebuffer = activeOutputMode !== 'standard'
      && shouldUseNativeExclusivePath(expectedTrack)

    if (
      useAudioSettingsStore.getState().disableGaplessPrebufferDev
      || !state.currentTrack
      || state.repeat === 'one'
      || !expectedTrackPath
      || (state.currentTrack.sourceType && state.currentTrack.sourceType !== 'local')
      // IAMF and other Standard-only targets must not start eager file/loudness
      // work while a native-exclusive backend is active. Their eventual play action
      // performs the existing safe fallback to Standard first.
      || (activeOutputMode !== 'standard' && !usesNativePrebuffer)
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

    if (state.playbackState !== 'playing') {
      clearScheduledPrebufferTimer()
      return
    }

    if (audioEngine.nextBufferedTrackPath === expectedTrackPath) {
      clearScheduledPrebufferTimer()
      // Eager decode may have installed the buffer long before Parallax's
      // announcement window. Re-enter its existing deferred scheduler on
      // resume so a pause cannot leave behind a stale boundary timer.
      void useParallaxStore.getState().publishHostNextStream(expectedTrack)
      return
    }
    if (
      prebufferInFlightTrackPath === expectedTrackPath
      && prebufferInFlightRequestId !== null
      && prebufferInFlightPromise
    ) {
      clearScheduledPrebufferTimer()
      return
    }
    const duration = audioEngine.duration > 0 ? audioEngine.duration : state.duration
    const currentTime = Number.isFinite(audioEngine.currentTime) ? audioEngine.currentTime : state.currentTime
    const delayMs = getGaplessPrebufferDelayMs(currentTime, duration)

    if (prebufferIdleTrackPath === expectedTrackPath && prebufferIdleCallbackId !== null) {
      const lateBoundaryDueAtMs = performance.now() + delayMs
      if (
        delayMs > 0
        && prebufferIdleDueAtMs !== null
        && prebufferIdleDueAtMs <= lateBoundaryDueAtMs + GAPLESS_PREBUFFER_TIMER_TOLERANCE_MS
      ) {
        return
      }
      clearScheduledPrebufferTimer()
    }

    const scheduleTimer = (timerDelayMs: number, callback: () => void): void => {
      const dueAtMs = performance.now() + timerDelayMs
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
        callback()
      }, timerDelayMs)
    }

    const startIfStillEligible = (): void => {
      const latestState = get()
      if (
        latestState.playbackState !== 'playing'
        || resolveExpectedPrebufferTrackPath(latestState) !== expectedTrackPath
        || useAudioSettingsStore.getState().disableGaplessPrebufferDev
      ) {
        return
      }
      void startPrebufferNextTrack()
    }

    if (delayMs > 0 && usesNativePrebuffer) {
      scheduleTimer(delayMs, startIfStillEligible)
      return
    }

    if (delayMs > 0 && prebufferAttemptedTrackPath === expectedTrackPath) {
      if (prebufferRetryAtLateTrackPath === expectedTrackPath) {
        scheduleTimer(delayMs, () => {
          if (prebufferAttemptedTrackPath === expectedTrackPath) {
            prebufferAttemptedTrackPath = null
          }
          prebufferRetryAtLateTrackPath = null
          prebufferLateRetryAttemptedTrackPath = expectedTrackPath
          startIfStillEligible()
        })
      }
      return
    }

    if (delayMs > 0) {
      const settleDelayMs = Math.min(ADAPTIVE_PREBUFFER_SETTLE_MS, delayMs)
      scheduleTimer(settleDelayMs, () => {
        if (settleDelayMs >= delayMs) {
          startIfStillEligible()
          return
        }
        if (resolveExpectedPrebufferTrackPath() !== expectedTrackPath) return
        prebufferIdleTrackPath = expectedTrackPath
        if (typeof globalThis.requestIdleCallback === 'function') {
          const idleTimeoutMs = Math.max(1, Math.min(
            ADAPTIVE_PREBUFFER_IDLE_TIMEOUT_MS,
            delayMs - settleDelayMs
          ))
          prebufferIdleDueAtMs = performance.now() + idleTimeoutMs
          prebufferIdleCallbackId = globalThis.requestIdleCallback(() => {
            prebufferIdleCallbackId = null
            prebufferIdleTrackPath = null
            prebufferIdleDueAtMs = null
            startIfStillEligible()
          }, { timeout: idleTimeoutMs })
        } else {
          prebufferScheduleTrackPath = expectedTrackPath
          prebufferScheduleDueAtMs = performance.now()
          prebufferScheduleTimerId = globalThis.setTimeout(() => {
            prebufferScheduleTimerId = null
            prebufferScheduleTrackPath = null
            prebufferScheduleDueAtMs = null
            startIfStillEligible()
          }, 0)
        }
      })
      return
    }

    clearScheduledPrebufferTimer()
    if (prebufferAttemptedTrackPath === expectedTrackPath) {
      if (
        prebufferRetryAtLateTrackPath === expectedTrackPath
        && prebufferLateRetryAttemptedTrackPath !== expectedTrackPath
      ) {
        prebufferAttemptedTrackPath = null
        prebufferRetryAtLateTrackPath = null
        prebufferLateRetryAttemptedTrackPath = expectedTrackPath
      } else {
        return
      }
    }
    startIfStillEligible()
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

  const patchHydratedContextTracks = (
    generation: number,
    contextItems: readonly QueueItem[],
    resolvedTracks: readonly DbTrack[]
  ): void => {
    if (resolvedTracks.length === 0) return
    const entryByPath = new Map(resolvedTracks.map((dbTrack) => {
      const entry = createQueueEntryFromTrack(dbTrackToTrack(dbTrack))
      return [entry.path, entry]
    }))
    const contextQueueIds = new Set(contextItems.map((item) => item.queueId))
    const patchItem = (item: QueueItem): QueueItem => {
      if (!contextQueueIds.has(item.queueId)) return item
      const entry = entryByPath.get(item.entry.path)
      return entry ? { ...item, entry } : item
    }
    const patchHistory = (history: readonly PlaybackHistoryEntry[]): PlaybackHistoryEntry[] => (
      history.map((historyEntry) => {
        const item = patchItem(historyEntry.item)
        return item === historyEntry.item ? historyEntry : { ...historyEntry, item }
      })
    )
    if (generation !== contextHydrationGeneration) {
      // A newer context owns the live queue, but an exact old queue item may
      // have been preserved in history (or retained as the current item by a
      // queue clear). Queue IDs are unique, so these exact-ID patches cannot
      // touch any item created for the newer context.
      set((state) => ({
        queueItems: state.queueItems.map(patchItem),
        playbackHistory: patchHistory(state.playbackHistory)
      }))
      return
    }
    const pendingInterruption = pendingPlaybackInterruptionReconciliation
    if (pendingInterruption) {
      const entry = entryByPath.get(pendingInterruption.track.path)
      if (entry && contextItems.some(
        (item) => item.queueId === get().currentQueueItemId && item.entry.path === entry.path
      )) {
        pendingPlaybackInterruptionReconciliation = {
          ...pendingInterruption,
          track: { ...entry.snapshot }
        }
      }
    }
    set((state) => {
      const currentItem = state.currentQueueItemId
        ? state.queueItems.find(
            (item) => item.queueId === state.currentQueueItemId && contextQueueIds.has(item.queueId)
          )
        : null
      const restoredEntry = state.restoredTrackNeedsLoad && state.currentTrack && currentItem
        ? entryByPath.get(currentItem.entry.path) ?? null
        : null
      const restoredTrack = restoredEntry && state.currentTrack?.path === restoredEntry.path
        ? { ...restoredEntry.snapshot }
        : null
      return {
        queueItems: state.queueItems.map(patchItem),
        // A rapid transition can move an unresolved context item into history
        // before its fetch completes. Keep that preserved transition authoritative
        // too, especially for remote/progressive source classification on Previous.
        playbackHistory: patchHistory(state.playbackHistory),
        currentTrack: restoredTrack ?? state.currentTrack,
        ...(restoredTrack
          ? {
              duration: restoredTrack.duration,
              waveformBufferedRatio: restoredTrack.sourceType && restoredTrack.sourceType !== 'local' ? 0 : 1,
              waveformAnalyzedRatio: restoredTrack.sourceType && restoredTrack.sourceType !== 'local' ? 0 : 1
            }
          : {})
      }
    })
  }

  const hydrateContextPathBatch = async (
    generation: number,
    contextItems: readonly QueueItem[],
    paths: readonly string[]
  ): Promise<void> => {
    if (generation !== contextHydrationGeneration || paths.length === 0) return
    const batchPaths = [...new Set(paths)].filter((path) => {
      const existing = contextTrackHydrationByPath.get(path)
      return !existing || existing.generation !== generation
    })
    if (batchPaths.length === 0) return

    // Defer invocation by one microtask so every per-path record is installed
    // synchronously. A matching skip can then reuse this exact request even if it
    // arrives before the library resolver has begun its work.
    const batchResolution = Promise.resolve()
      .then(() => useLibraryStore.getState().resolveTrackPathsWithFetch(batchPaths))
      .then((tracks) => {
        patchHydratedContextTracks(generation, contextItems, tracks)
        return tracks
      }, (error) => {
        if (generation === contextHydrationGeneration && import.meta.env?.DEV) {
          console.warn('Failed to hydrate playback context metadata:', error)
        }
        return [] as DbTrack[]
      })

    const records = batchPaths.map((path) => {
      const record: ContextTrackHydrationRecord = {
        generation,
        promise: batchResolution.then((tracks) => tracks.find((track) => track.path === path) ?? null)
      }
      contextTrackHydrationByPath.set(path, record)
      for (const item of contextItems) {
        if (item.entry.path !== path) continue
        contextTrackHydrationByQueueId.set(item.queueId, record)
        const clearExactQueueRecord = (): void => {
          if (contextTrackHydrationByQueueId.get(item.queueId) === record) {
            contextTrackHydrationByQueueId.delete(item.queueId)
          }
        }
        void record.promise.then(clearExactQueueRecord, clearExactQueueRecord)
      }
      return [path, record] as const
    })

    await batchResolution
    for (const [path, record] of records) {
      if (contextTrackHydrationByPath.get(path) === record) {
        contextTrackHydrationByPath.delete(path)
      }
      if (pendingContextMetadataPaths.get(path) === generation) {
        pendingContextMetadataPaths.delete(path)
      }
    }
    if (
      generation === contextHydrationGeneration
      && get().playbackState === 'playing'
      && getCommittedTransitionTarget(get()) === null
    ) {
      schedulePreBufferNextTrack()
    }
  }

  const getOrStartContextTrackHydration = (
    path: string,
    queueItemId?: string | null
  ): Promise<DbTrack | null> | null => {
    if (queueItemId) {
      const exactQueueRecord = contextTrackHydrationByQueueId.get(queueItemId)
      if (exactQueueRecord) return exactQueueRecord.promise
    }
    const generation = contextHydrationGeneration
    const existing = contextTrackHydrationByPath.get(path)
    if (existing?.generation === generation) return existing.promise
    if (pendingContextMetadataPaths.get(path) !== generation) return null

    void hydrateContextPathBatch(generation, activeContextHydrationItems, [path])
    return contextTrackHydrationByPath.get(path)?.promise ?? null
  }

  const scheduleRemainingContextHydration = (
    generation: number,
    contextItems: readonly QueueItem[],
    paths: readonly string[]
  ): void => {
    const uniquePaths = [...new Set(paths)]
    let offset = 0
    const scheduleNextBatch = (): void => {
      if (generation !== contextHydrationGeneration || offset >= uniquePaths.length) return
      const runBatch = (): void => {
        if (generation !== contextHydrationGeneration) return
        const batch = uniquePaths.slice(offset, offset + CONTEXT_HYDRATION_BATCH_SIZE)
        offset += batch.length
        void hydrateContextPathBatch(generation, contextItems, batch).finally(scheduleNextBatch)
      }
      if (typeof globalThis.requestIdleCallback === 'function') {
        globalThis.requestIdleCallback(runBatch, { timeout: ADAPTIVE_PREBUFFER_IDLE_TIMEOUT_MS })
      } else {
        globalThis.setTimeout(runBatch, 0)
      }
    }
    scheduleNextBatch()
  }

  const startPlaybackContextEntries = async (
    entries: QueueTrackEntry[],
    startIndex = 0,
    options?: PlaybackContextOptions,
    hydrationPlan?: PlaybackContextHydrationPlan
  ): Promise<void> => {
    if (blockLocalPlaybackInParallaxSinkMode()) return

    const commandStartedAtMs = hydrationPlan?.commandStartedAtMs ?? performance.now()
    contextHydrationGeneration += 1
    resetContextHydrationTracking()
    const generation = contextHydrationGeneration
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
    activeContextHydrationItems = contextItems
    for (const path of hydrationPlan?.missingPaths ?? []) {
      pendingContextMetadataPaths.set(path, generation)
    }
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
    // The newly committed context is authoritative even if its selected metadata
    // still needs one fetch; prevent an older load from reaching playback meanwhile.
    invalidateLoadRequest()
    const contextIntentId = hydrationPlan?.playbackIntentId ?? playbackIntentGeneration
    let stalePrebufferWaitMs = 0
    const stalePrebufferWaitStartedAtMs = performance.now()
    const hadNativePrebufferInFlight = prebufferInFlightPromise !== null
    const stalePrebufferClear = audioEngine.getPlaybackOutputMode() !== 'standard'
      ? (() => {
          clearScheduledPrebufferTimer()
          invalidatePrebufferRequest()
          if (hadNativePrebufferInFlight) audioEngine.cancelPendingNativeDecode()
          void useParallaxStore.getState().cancelHostNextStream()
          return runNativeControlAfterActiveTransition(contextIntentId, () => audioEngine.clearNextBuffer())
        })()
      : (() => {
          clearBufferedNextTrack()
          return Promise.resolve()
        })()
    void stalePrebufferClear.then(() => {
      stalePrebufferWaitMs = performance.now() - stalePrebufferWaitStartedAtMs
    })

    const queuePreparationMs = performance.now() - commandStartedAtMs

    const missingPaths = hydrationPlan?.missingPaths ?? new Set<string>()
    const targetPath = currentItem.entry.path
    supersedeInteractiveLoudnessAnalysis(targetPath)
    // Start the only critical metadata fetch first. Background hydration is
    // launched immediately afterward, but never delays this selected track.
    const targetResolution = missingPaths.has(targetPath)
      ? getOrStartContextTrackHydration(targetPath, currentItem.queueId)
      : null
    const nextCandidate = findNextPlayableCandidate(get())
    const nextHydrationPath = nextCandidate && nextCandidate.kind !== 'current'
      && missingPaths.has(nextCandidate.track.path)
      && nextCandidate.track.path !== targetPath
      ? nextCandidate.track.path
      : null

    if (nextHydrationPath) {
      void hydrateContextPathBatch(generation, contextItems, [nextHydrationPath])
    }
    // Context metadata belongs to the committed queue, not to the lifetime of
    // this particular playback intent. Schedule the remaining idle work now so
    // an immediate Next/Pause/Stop cannot strand the queue on fallback snapshots.
    scheduleRemainingContextHydration(
      generation,
      contextItems,
      [...missingPaths].filter((path) => path !== targetPath && path !== nextHydrationPath)
    )

    const attempt = createPlaybackAttempt('context', commandStartedAtMs, {
      queuePreparationMs,
      prebufferStatus: 'miss'
    })
    let targetTrack = resolveQueueEntryTrack(currentItem.entry)
    commitPlaybackTransition(
      attempt,
      contextIntentId,
      targetTrack ?? currentItem.entry.snapshot,
      { queueItemId: currentItem.queueId }
    )
    const targetHydrationStartedAtMs = targetResolution ? performance.now() : null
    const recordTargetHydrationTiming = (): void => {
      if (targetHydrationStartedAtMs !== null && attempt.selectedTrackHydrationMs === 0) {
        attempt.selectedTrackHydrationMs = performance.now() - targetHydrationStartedAtMs
      }
    }
    if (targetResolution) {
      try {
        const resolvedTarget = await targetResolution
        if (
          generation !== contextHydrationGeneration
          || (hydrationPlan && !isCurrentPlaybackIntent(hydrationPlan.playbackIntentId))
        ) {
          recordTargetHydrationTiming()
          completePlaybackAttempt(attempt, targetTrack ?? currentItem.entry.snapshot, 'superseded', {
            backend: targetTrack ? getAttemptBackend(targetTrack) : 'standard'
          })
          return
        }
        if (resolvedTarget) {
          patchHydratedContextTracks(generation, contextItems, [resolvedTarget])
          targetTrack = dbTrackToTrack(resolvedTarget)
        }
      } catch (error) {
        if (
          generation !== contextHydrationGeneration
          || (hydrationPlan && !isCurrentPlaybackIntent(hydrationPlan.playbackIntentId))
        ) {
          recordTargetHydrationTiming()
          completePlaybackAttempt(attempt, targetTrack ?? currentItem.entry.snapshot, 'superseded', {
            backend: targetTrack ? getAttemptBackend(targetTrack) : 'standard'
          })
          return
        }
        if (import.meta.env?.DEV) console.warn('Failed to resolve selected track metadata:', error)
      }
      recordTargetHydrationTiming()
    }
    if (hydrationPlan && !isCurrentPlaybackIntent(hydrationPlan.playbackIntentId)) {
      completePlaybackAttempt(attempt, targetTrack ?? currentItem.entry.snapshot, 'superseded', {
        backend: targetTrack ? getAttemptBackend(targetTrack) : 'standard'
      })
      return
    }
    if (!targetTrack || isUnavailableRemoteTrack(targetTrack)) {
      completePlaybackAttempt(attempt, targetTrack ?? currentItem.entry.snapshot, 'failed', {
        backend: targetTrack ? getAttemptBackend(targetTrack) : 'standard'
      })
      return
    }

    await stalePrebufferClear
    attempt.supersededLoadWaitMs += stalePrebufferWaitMs
    if (
      generation !== contextHydrationGeneration
      || (hydrationPlan && !isCurrentPlaybackIntent(hydrationPlan.playbackIntentId))
    ) {
      completePlaybackAttempt(attempt, targetTrack, 'superseded', {
        backend: getAttemptBackend(targetTrack)
      })
      return
    }

    const load = runSerializedTrackLoad(targetTrack, {
      manualStart: true,
      attempt
    }, 'context')
    const loaded = await load
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
    bitPerfectFormatNotice: null,
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

      const loadIntentId = beginPlaybackIntent()
      supersedeInteractiveLoudnessAnalysis(track.path)
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
        if (shouldUseNativeExclusivePath(track)) {
          const replayGainDb = getReplayGainCandidateDb(track, useAudioSettingsStore.getState().replayGainMode)
          audioEngine.setCurrentReplayGainDb(replayGainDb)
          const nativeLoad: { result: NativeAudioTrackLoadResult | null } = { result: null }
          const loudnessAnalysis = requestTrackLoudnessAnalysis(track, replayGainDb)
          await runNativeControlAfterActiveTransition(loadIntentId, async () => {
            activeStandaloneNativeLoad = true
            try {
              nativeLoad.result = await audioEngine.loadTrackFromPath(track, {
                replayGainDb,
                trackPath: track.path,
                loudnessAnalysis
              })
            } finally {
              activeStandaloneNativeLoad = false
            }
          })
          throwIfSupersededLoad(loadRequestId)
          const result = nativeLoad.result
          if (!result) throw new SupersededPlaybackLoadError()
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
            usedNativeExclusive: true,
            nativeOutputMode: useAudioSettingsStore.getState().playbackOutputMode,
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
        const isFormatFailure = showBitPerfectFormatNotice(track, error)
        if (isFormatFailure) {
          console.warn('Native exclusive playback failed closed:', stripBitPerfectFormatTag(
            error instanceof Error ? error.message : String(error)
          ))
        } else {
          console.error('Failed to load track:', error)
        }
        logSlowPath('loadTrack', loadStart, {
          trackPath: track.path,
          failed: true,
          deviceFormatRejected: isFormatFailure
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
      const commandStartedAtMs = performance.now()
      const directIntentId = beginPlaybackIntent()
      clearNonmatchingPrebufferForIntent(directIntentId, track.path)
      supersedeInteractiveLoudnessAnalysis(track.path)
      standaloneTransitionTrackPath = track.path
      standaloneTransitionIntentId = directIntentId
      set({ currentTrackSource: 'manual' })
      try {
        const outcome = await runSerializedTrackLoad(track, {
          manualStart: true,
          attempt: createPlaybackAttempt('direct', commandStartedAtMs, {
            queuePreparationMs: performance.now() - commandStartedAtMs,
            prebufferStatus: 'miss'
          })
        }, 'direct')
        if (
          outcome !== 'loaded'
          && standaloneTransitionTrackPath === track.path
          && standaloneTransitionIntentId === directIntentId
        ) {
          standaloneTransitionTrackPath = null
          standaloneTransitionIntentId = null
        }
        return outcome === 'loaded'
      } catch (error) {
        if (
          standaloneTransitionTrackPath === track.path
          && standaloneTransitionIntentId === directIntentId
        ) {
          standaloneTransitionTrackPath = null
          standaloneTransitionIntentId = null
        }
        throw error
      }
    },

    // Playback controls
    play: async () => {
      if (blockLocalPlaybackInParallaxSinkMode()) return

      const state = get()
      const pendingInterruption = pendingPlaybackInterruptionReconciliation
      if (
        pendingInterruption
        && pendingInterruption.intentId === playbackIntentGeneration
      ) {
        const commandStartedAtMs = performance.now()
        let targetTrack = pendingInterruption.track
        // Make the committed target authoritative immediately, then queue its
        // explicit reload behind the still-running native control/handshake.
        applyPlaybackInterruptionReconciliation(pendingInterruption)
        const resumeIntentId = beginPlaybackIntent()
        supersedeInteractiveLoudnessAnalysis(targetTrack.path)
        if (pendingInterruption.standaloneTrackPath === targetTrack.path) {
          standaloneTransitionTrackPath = targetTrack.path
          standaloneTransitionIntentId = resumeIntentId
        }
        const attempt = createPlaybackAttempt('resume', commandStartedAtMs, {
          prebufferStatus: 'miss'
        })
        const targetQueueItemId = get().currentQueueItemId
        commitPlaybackTransition(attempt, resumeIntentId, targetTrack, {
          queueItemId: targetQueueItemId,
          standaloneTrackPath: pendingInterruption.standaloneTrackPath
        })
        const contextHydration = getOrStartContextTrackHydration(targetTrack.path, targetQueueItemId)
        if (contextHydration) {
          const hydrationStartedAtMs = performance.now()
          await contextHydration
          attempt.selectedTrackHydrationMs = performance.now() - hydrationStartedAtMs
          if (!isCurrentPlaybackIntent(resumeIntentId)) {
            completePlaybackAttempt(attempt, targetTrack, 'superseded', {
              backend: getAttemptBackend(targetTrack)
            })
            return
          }
        }
        const refreshedItem = targetQueueItemId
          ? get().queueItems.find((item) => item.queueId === targetQueueItemId)
          : null
        if (refreshedItem?.entry.path === targetTrack.path) {
          targetTrack = resolveQueueEntryTrack(refreshedItem.entry) ?? targetTrack
        }
        if (isUnavailableRemoteTrack(targetTrack)) {
          completePlaybackAttempt(attempt, targetTrack, 'failed', {
            backend: getAttemptBackend(targetTrack)
          })
          return
        }
        const loaded = await runSerializedTrackLoad(targetTrack, {
          manualStart: true,
          startTime: 0,
          attempt
        }, 'resume')
        if (loaded === 'failed' && targetTrack.sourceType && targetTrack.sourceType !== 'local') {
          markTrackUnavailableInState(targetTrack.path)
        }
        return
      }

      if (state.currentTrack && state.restoredTrackNeedsLoad) {
        const commandStartedAtMs = performance.now()
        let track = state.currentTrack
        const preserveStandaloneIdentity = standaloneTransitionTrackPath === track.path
        const resumeIntentId = beginPlaybackIntent()
        supersedeInteractiveLoudnessAnalysis(track.path)
        if (preserveStandaloneIdentity) {
          standaloneTransitionTrackPath = track.path
          standaloneTransitionIntentId = resumeIntentId
        }
        const startTime = state.restoredPlaybackTime ?? state.currentTime
        const attempt = createPlaybackAttempt('resume', commandStartedAtMs, {
          prebufferStatus: 'miss'
        })
        const targetQueueItemId = state.currentQueueItemId
        commitPlaybackTransition(attempt, resumeIntentId, track, {
          queueItemId: targetQueueItemId,
          standaloneTrackPath: preserveStandaloneIdentity ? track.path : null
        })
        const contextHydration = getOrStartContextTrackHydration(track.path, targetQueueItemId)
        if (contextHydration) {
          const hydrationStartedAtMs = performance.now()
          await contextHydration
          attempt.selectedTrackHydrationMs = performance.now() - hydrationStartedAtMs
          if (!isCurrentPlaybackIntent(resumeIntentId)) {
            completePlaybackAttempt(attempt, track, 'superseded', {
              backend: getAttemptBackend(track)
            })
            return
          }
        }
        const refreshedItem = targetQueueItemId
          ? get().queueItems.find((item) => item.queueId === targetQueueItemId)
          : null
        if (refreshedItem?.entry.path === track.path) {
          track = resolveQueueEntryTrack(refreshedItem.entry) ?? track
        }
        if (isUnavailableRemoteTrack(track)) {
          completePlaybackAttempt(attempt, track, 'failed', {
            backend: getAttemptBackend(track)
          })
          return
        }
        set({
          restoredTrackNeedsLoad: false,
          restoredPlaybackTime: null
        })
        const loaded = await runSerializedTrackLoad(track, {
          manualStart: true,
          startTime,
          attempt
        }, 'resume')
        if (loaded === 'failed' && track.sourceType && track.sourceType !== 'local') {
          markTrackUnavailableInState(track.path)
        }
        return
      }

      if (!state.currentTrack) {
        const commandStartedAtMs = performance.now()
        const playbackIntentId = beginPlaybackIntent()
        const candidate = findNextPlayableCandidate(state)
        if (!candidate || candidate.kind === 'current') return
        clearNonmatchingPrebufferForIntent(playbackIntentId, candidate.track.path)
        supersedeInteractiveLoudnessAnalysis(candidate.track.path)

        set(applyCandidateTransition(state, candidate, {
          pushCurrentToHistory: false
        }))

        const attempt = createPlaybackAttempt('resume', commandStartedAtMs, {
          queuePreparationMs: performance.now() - commandStartedAtMs,
          prebufferStatus: 'miss'
        })
        commitPlaybackTransition(attempt, playbackIntentId, candidate.track, {
          queueItemId: candidate.item.queueId
        })
        let targetTrack = candidate.track
        const contextHydration = getOrStartContextTrackHydration(
          candidate.track.path,
          candidate.item.queueId
        )
        if (contextHydration) {
          const hydrationStartedAtMs = performance.now()
          const hydratedTrack = await contextHydration
          attempt.selectedTrackHydrationMs = performance.now() - hydrationStartedAtMs
          if (!isCurrentPlaybackIntent(playbackIntentId)) {
            completePlaybackAttempt(attempt, targetTrack, 'superseded', {
              backend: getAttemptBackend(targetTrack)
            })
            return
          }
          const refreshedItem = get().queueItems.find((queueItem) => queueItem.queueId === candidate.item.queueId)
          if (!refreshedItem) {
            completePlaybackAttempt(attempt, targetTrack, 'superseded', {
              backend: getAttemptBackend(targetTrack)
            })
            return
          }
          targetTrack = resolveQueueEntryTrack(refreshedItem.entry)
            ?? (hydratedTrack ? dbTrackToTrack(hydratedTrack) : candidate.track)
          if (isUnavailableRemoteTrack(targetTrack)) {
            completePlaybackAttempt(attempt, targetTrack, 'failed', {
              backend: getAttemptBackend(targetTrack)
            })
            return
          }
        }

        const loaded = await runSerializedTrackLoad(targetTrack, {
          manualStart: true,
          attempt
        }, 'resume')
        if (loaded === 'failed' && targetTrack.sourceType && targetTrack.sourceType !== 'local') {
          markTrackUnavailableInState(targetTrack.path)
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
        const commandStartedAtMs = performance.now()
        const preserveStandaloneIdentity = standaloneTransitionTrackPath === state.currentTrack.path
        const resumeIntentId = beginPlaybackIntent()
        supersedeInteractiveLoudnessAnalysis(state.currentTrack.path)
        if (preserveStandaloneIdentity) {
          standaloneTransitionTrackPath = state.currentTrack.path
          standaloneTransitionIntentId = resumeIntentId
        }
        const reloadAttempt = createPlaybackAttempt('resume', commandStartedAtMs, {
          prebufferStatus: 'miss'
        })
        commitPlaybackTransition(reloadAttempt, resumeIntentId, state.currentTrack, {
          queueItemId: state.currentQueueItemId,
          standaloneTrackPath: preserveStandaloneIdentity ? state.currentTrack.path : null
        })
        const reloaded = await runSerializedTrackLoad(state.currentTrack, {
          manualStart: true,
          attempt: reloadAttempt
        }, 'resume')
        if (reloaded === 'failed') {
          markTrackUnavailableInState(state.currentTrack.path)
        }
        return
      }
      if (pendingManualLoadCueTrack) {
        showOutputDelayNotice(pendingManualLoadCueTrack)
        pendingManualLoadCueTrack = null
      }
      const resumedTrack = get().currentTrack
      if (!resumedTrack) return
      const preserveStandaloneIdentity = standaloneTransitionTrackPath === resumedTrack.path
      const resumeIntentId = beginPlaybackIntent()
      if (preserveStandaloneIdentity) {
        standaloneTransitionTrackPath = resumedTrack.path
        standaloneTransitionIntentId = resumeIntentId
      }
      supersedeInteractiveLoudnessAnalysis(resumedTrack.path)
      const resumeAttempt = createPlaybackAttempt('resume', performance.now(), {
        prebufferStatus: 'not_applicable'
      })
      commitPlaybackTransition(resumeAttempt, resumeIntentId, resumedTrack, {
        queueItemId: get().currentQueueItemId,
        standaloneTrackPath: preserveStandaloneIdentity ? resumedTrack.path : null
      })
      const backendStart = performance.now()
      try {
        const resumePlayback = (): Promise<void> => playWithParallaxIfNeeded(
          resumedTrack,
          () => isCurrentPlaybackIntent(resumeIntentId)
        )
        if (audioEngine.getPlaybackOutputMode() !== 'standard') {
          // Native play includes the device-start handshake. Publish it through
          // the same control barrier as pause/stop/clear so a following target
          // can supersede its state without overlapping native addon calls.
          await runNativeControlAfterActiveTransition(resumeIntentId, resumePlayback)
        } else {
          await resumePlayback()
        }
        // A queued native control intentionally becomes a no-op if a newer
        // intent wins before it starts; do not report that skipped resume as playing.
        if (!isCurrentPlaybackIntent(resumeIntentId)) throw new SupersededPlaybackLoadError()
        markPlaybackAttemptPlaying(resumeAttempt)
        completePlaybackAttempt(resumeAttempt, resumedTrack, 'loaded', {
          backend: getAttemptBackend(resumedTrack),
          backendStartMs: performance.now() - backendStart
        })
      } catch (error) {
        const superseded = error instanceof SupersededPlaybackLoadError
          || isSupersededAudioLoadError(error)
          || !isCurrentPlaybackIntent(resumeIntentId)
        completePlaybackAttempt(resumeAttempt, resumedTrack, superseded ? 'superseded' : 'failed', {
          backend: getAttemptBackend(resumedTrack),
          backendStartMs: performance.now() - backendStart
        })
        if (superseded) return
        throw error
      }
      const currentTrack = get().currentTrack
      if ((previousPlaybackState === 'loading' || previousPlaybackState === 'stopped') && currentTrack) {
        void useLibraryStore.getState().markTrackLatestSyncSeen(currentTrack.path)
        startRecentPlaySession(currentTrack.path)
      }
    },

    pause: () => {
      if (blockLocalPlaybackInParallaxSinkMode()) return
      const pendingTarget = getCommittedTransitionTarget()
      if (pendingTarget) {
        const standaloneTrackPath = standaloneTransitionTrackPath === pendingTarget.path
          ? pendingTarget.path
          : null
        const intentId = beginPlaybackIntent()
        supersedeInteractiveLoudnessAnalysis(null)
        invalidateLoadRequest()
        pendingManualLoadCueTrack = null
        const reconciliation: PlaybackInterruptionReconciliation = {
          intentId,
          desiredState: 'paused',
          track: pendingTarget,
          standaloneTrackPath
        }
        pendingPlaybackInterruptionReconciliation = reconciliation
        const waitsForNativeState = audioEngine.getPlaybackOutputMode() !== 'standard'
        if (waitsForNativeState) {
          clearScheduledPrebufferTimer()
          invalidatePrebufferRequest()
          const pauseControl = runNativeControlAfterActiveTransition(intentId, () => audioEngine.pause())
          const reconcilePausedTarget = (): void => {
            if (pendingPlaybackInterruptionReconciliation === reconciliation) {
              pendingPlaybackInterruptionReconciliation = null
              applyPlaybackInterruptionReconciliation(reconciliation)
            }
          }
          void pauseControl.then(reconcilePausedTarget, reconcilePausedTarget)
        } else {
          clearBufferedNextTrack()
          audioEngine.pause()
        }
        // Standard/remote state events are synchronous. If the engine had no
        // active source and emitted nothing, reconcile here; native state is
        // deliberately reconciled only when its asynchronous pause completes.
        if (!waitsForNativeState && pendingPlaybackInterruptionReconciliation === reconciliation) {
          pendingPlaybackInterruptionReconciliation = null
          applyPlaybackInterruptionReconciliation(reconciliation)
        }
        void useParallaxStore.getState().pauseHostPlayback()
        return
      }
      if (audioEngine.getPlaybackOutputMode() !== 'standard') {
        clearScheduledPrebufferTimer()
        invalidatePrebufferRequest()
        audioEngine.cancelPendingNativeDecode()
        void runNativeControlAfterActiveTransition(
          playbackIntentGeneration,
          () => audioEngine.pause()
        )
      } else {
        audioEngine.pause()
      }
      void useParallaxStore.getState().pauseHostPlayback()
    },

    togglePlay: async () => {
      if (blockLocalPlaybackInParallaxSinkMode()) return

      const state = get()
      if (pendingPlaybackInterruptionReconciliation) {
        await get().play()
        return
      }
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
      const pendingTarget = getCommittedTransitionTarget()
      const standaloneTrackPath = pendingTarget && standaloneTransitionTrackPath === pendingTarget.path
        ? pendingTarget.path
        : null
      playbackIntentGeneration += 1
      cancelPendingTransitionLoads()
      activeExecutingTransition = null
      committedPlaybackTransition = null
      pendingNativeSeek = null
      preAppliedGaplessQueueItemId = null
      completedPreAppliedGaplessQueueItemId = null
      pendingPlaybackInterruptionReconciliation = null
      audioEngine.cancelPendingNativeDecode()
      supersedeInteractiveLoudnessAnalysis(null)
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
      if (pendingTarget) {
        pendingPlaybackInterruptionReconciliation = {
          intentId: playbackIntentGeneration,
          desiredState: 'stopped',
          track: pendingTarget,
          standaloneTrackPath
        }
      }
      const waitsForNativeState = audioEngine.getPlaybackOutputMode() !== 'standard'
      if (waitsForNativeState) {
        const stopControl = runNativeControlAfterActiveTransition(
          playbackIntentGeneration,
          () => audioEngine.stop()
        )
        const reconcileStoppedTarget = (): void => {
          const reconciliation = pendingPlaybackInterruptionReconciliation
          if (
            reconciliation
            && reconciliation.intentId === playbackIntentGeneration
            && reconciliation.desiredState === 'stopped'
          ) {
            pendingPlaybackInterruptionReconciliation = null
            applyPlaybackInterruptionReconciliation(reconciliation)
          }
        }
        void stopControl.then(reconcileStoppedTarget, reconcileStoppedTarget)
      } else {
        audioEngine.stop()
      }
      const reconciliation = pendingPlaybackInterruptionReconciliation
      if (reconciliation && !waitsForNativeState) {
        pendingPlaybackInterruptionReconciliation = null
        applyPlaybackInterruptionReconciliation(reconciliation)
      }
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
      const seekIntentId = playbackIntentGeneration

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
      if (!isCurrentPlaybackIntent(seekIntentId)) return
      if (parallaxSeekTimeline && state.playbackState === 'playing') {
        await audioEngine.playCurrentBufferOnParallaxTimeline(parallaxSeekTimeline)
        if (!isCurrentPlaybackIntent(seekIntentId)) return
        schedulePreBufferNextTrack()
        return
      }
      if (audioEngine.getPlaybackOutputMode() !== 'standard') {
        await runSerializedNativeSeek(seekIntentId, seekTime)
      } else {
        await audioEngine.seek(seekTime)
      }
      if (!isCurrentPlaybackIntent(seekIntentId)) return
      schedulePreBufferNextTrack()
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
      const commandStartedAtMs = performance.now()
      const playbackIntentId = beginPlaybackIntent()
      await startPlaybackContextEntries(createQueueEntriesFromTracks(tracks), startIndex, options, {
        missingPaths: new Set<string>(),
        commandStartedAtMs,
        playbackIntentId
      })
    },

    startPlaybackContextByPaths: async (paths: string[], startIndex = 0, options) => {
      if (blockLocalPlaybackInParallaxSinkMode()) return
      const commandStartedAtMs = performance.now()
      const playbackIntentId = beginPlaybackIntent()
      const normalizedPaths = paths.filter((trackPath) => typeof trackPath === 'string' && trackPath.length > 0)
      const cachedTracks = useLibraryStore.getState().resolveTrackPaths(normalizedPaths)
      const cachedPaths = new Set(cachedTracks.map((track) => track.path))
      await startPlaybackContextEntries(
        createQueueEntriesFromResolvedTracks(normalizedPaths, cachedTracks),
        startIndex,
        options,
        {
          missingPaths: new Set(normalizedPaths.filter((path) => !cachedPaths.has(path))),
          commandStartedAtMs,
          playbackIntentId
        }
      )
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
      contextHydrationGeneration += 1
      resetContextHydrationTracking()
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

    clearBitPerfectFormatNotice: () => {
      set({ bitPerfectFormatNotice: null })
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
      contextHydrationGeneration += 1
      resetContextHydrationTracking()
      activeExecutingTransition = null
      committedPlaybackTransition = null
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

      const commandStartedAtMs = performance.now()
      const state = get()
      const item = state.queueItems.find((candidate) => candidate.queueId === queueId)
      const track = resolveQueueEntryTrack(item?.entry)
      const index = state.upcomingQueueIds.indexOf(queueId)
      const candidate: NextCandidate | null = item && track
        ? { kind: 'queue', item, track, index }
        : null

      if (!candidate || isUnavailableRemoteTrack(candidate.track)) return
      const playbackIntentId = beginPlaybackIntent()
      clearNonmatchingPrebufferForIntent(playbackIntentId, candidate.track.path)
      supersedeInteractiveLoudnessAnalysis(candidate.track.path)

      set(applyCandidateTransition(state, candidate, {
        pushCurrentToHistory: true
      }))

      const attempt = createPlaybackAttempt('queue', commandStartedAtMs, {
        queuePreparationMs: performance.now() - commandStartedAtMs,
        prebufferStatus: 'miss'
      })
      commitPlaybackTransition(attempt, playbackIntentId, candidate.track, {
        queueItemId: candidate.item.queueId
      })
      let targetTrack = candidate.track
      const contextHydration = getOrStartContextTrackHydration(
        candidate.track.path,
        candidate.item.queueId
      )
      if (contextHydration) {
        const hydrationStartedAtMs = performance.now()
        const hydratedTrack = await contextHydration
        attempt.selectedTrackHydrationMs = performance.now() - hydrationStartedAtMs
        if (!isCurrentPlaybackIntent(playbackIntentId)) {
          completePlaybackAttempt(attempt, targetTrack, 'superseded', {
            backend: getAttemptBackend(targetTrack)
          })
          return
        }
        const refreshedItem = get().queueItems.find((queueItem) => queueItem.queueId === candidate.item.queueId)
        if (!refreshedItem) {
          completePlaybackAttempt(attempt, targetTrack, 'superseded', {
            backend: getAttemptBackend(targetTrack)
          })
          return
        }
        targetTrack = resolveQueueEntryTrack(refreshedItem.entry)
          ?? (hydratedTrack ? dbTrackToTrack(hydratedTrack) : candidate.track)
        if (isUnavailableRemoteTrack(targetTrack)) {
          completePlaybackAttempt(attempt, targetTrack, 'failed', {
            backend: getAttemptBackend(targetTrack)
          })
          return
        }
      }

      const loaded = await runSerializedTrackLoad(targetTrack, {
        manualStart: options?.manualStart ?? true,
        attempt
      }, 'queue')
      if (loaded === 'failed' && targetTrack.sourceType && targetTrack.sourceType !== 'local') {
        markTrackUnavailableInState(targetTrack.path)
      }
    },

    playNext: async () => {
      if (blockLocalPlaybackInParallaxSinkMode()) return

      const playbackIntent = nextPlaybackIntentOverride ?? 'next'
      nextPlaybackIntentOverride = null
      const commandStartedAtMs = performance.now()
      const state = get()
      const candidate = findNextPlayableCandidate(state)
      if (!candidate) return
      const playbackIntentId = beginPlaybackIntent()
      clearNonmatchingPrebufferForIntent(playbackIntentId, candidate.track.path)
      supersedeInteractiveLoudnessAnalysis(candidate.track.path)

      const attempt = createPlaybackAttempt(playbackIntent, commandStartedAtMs, {
        prebufferStatus: 'miss'
      })

      const contextHydration = candidate.kind === 'queue'
        ? getOrStartContextTrackHydration(candidate.track.path, candidate.item.queueId)
        : null
      if (contextHydration && candidate.kind === 'queue') {
        set(applyCandidateTransition(state, candidate, {
          pushCurrentToHistory: true
        }))
        commitPlaybackTransition(attempt, playbackIntentId, candidate.track, {
          queueItemId: candidate.item.queueId
        })
        attempt.queuePreparationMs = performance.now() - commandStartedAtMs
        const hydrationStartedAtMs = performance.now()
        const hydratedTrack = await contextHydration
        attempt.selectedTrackHydrationMs = performance.now() - hydrationStartedAtMs
        if (!isCurrentPlaybackIntent(playbackIntentId)) {
          completePlaybackAttempt(attempt, candidate.track, 'superseded', {
            backend: getAttemptBackend(candidate.track)
          })
          return
        }
        const refreshedItem = get().queueItems.find((queueItem) => queueItem.queueId === candidate.item.queueId)
        if (!refreshedItem) {
          completePlaybackAttempt(attempt, candidate.track, 'superseded', {
            backend: getAttemptBackend(candidate.track)
          })
          return
        }
        const targetTrack = resolveQueueEntryTrack(refreshedItem.entry)
          ?? (hydratedTrack ? dbTrackToTrack(hydratedTrack) : candidate.track)
        if (isUnavailableRemoteTrack(targetTrack)) {
          completePlaybackAttempt(attempt, targetTrack, 'failed', {
            backend: getAttemptBackend(targetTrack)
          })
          return
        }
        const loaded = await runSerializedTrackLoad(targetTrack, { attempt }, playbackIntent)
        if (loaded === 'failed' && targetTrack.sourceType && targetTrack.sourceType !== 'local') {
          markTrackUnavailableInState(targetTrack.path)
        }
        return
      }

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
        const promotedPrebufferRequestId = completedPrebufferTrackPath === candidate.track.path
          ? completedPrebufferRequestId
          : null
        attempt.prebufferStatus = 'ready'
        invalidateLoadRequest()
        manualGaplessTransitionInProgress = true
        const backendStart = performance.now()
        try {
          if (audioEngine.skipToPreBuffered()) {
            markPlaybackAttemptPlaying(attempt)
            completePlaybackAttempt(
              attempt,
              candidate.track,
              'loaded',
              getPromotedPrebufferAttemptTimings(
                promotedPrebufferRequestId,
                performance.now() - backendStart
              )
            )
            return
          }
        } catch (error) {
          completePlaybackAttempt(
            attempt,
            candidate.track,
            'failed',
            getPromotedPrebufferAttemptTimings(
              promotedPrebufferRequestId,
              performance.now() - backendStart
            )
          )
          throw error
        } finally {
          manualGaplessTransitionInProgress = false
        }
        // Fell through (buffer vanished): fall back to the cold-load path below.
        attempt.prebufferStatus = 'miss'
      }

      if (
        state.playbackState === 'playing'
        && candidate.kind !== 'current'
        && prebufferInFlightTrackPath === candidate.track.path
        && prebufferInFlightPromise
      ) {
        attempt.prebufferStatus = 'in_flight'
        const promotedPrebufferRequestId = prebufferInFlightRequestId
        audioEngine.promoteMatchingPrebufferDecode(candidate.track.path)
        // Preserve the transition immediately (so rapid Next presses still advance
        // every queue/history step), while allowing the prebuffer request to finish
        // against the target that is now current in queue state.
        preAppliedGaplessQueueItemId = candidate.item.queueId
        completedPreAppliedGaplessQueueItemId = null
        set(applyCandidateTransition(state, candidate, {
          pushCurrentToHistory: true
        }))
        attempt.queuePreparationMs = performance.now() - commandStartedAtMs

        const inFlightPrebuffer = prebufferInFlightPromise
        await inFlightPrebuffer.catch(() => undefined)
        if (!isCurrentPlaybackIntent(playbackIntentId)) {
          if (preAppliedGaplessQueueItemId === candidate.item.queueId) {
            preAppliedGaplessQueueItemId = null
          }
          completePlaybackAttempt(
            attempt,
            candidate.track,
            'superseded',
            getPromotedPrebufferAttemptTimings(promotedPrebufferRequestId)
          )
          return
        }

        if (completedPreAppliedGaplessQueueItemId === candidate.item.queueId) {
          completedPreAppliedGaplessQueueItemId = null
          attempt.prebufferStatus = 'in_flight_promoted'
          markPlaybackAttemptPlaying(attempt)
          completePlaybackAttempt(
            attempt,
            candidate.track,
            'loaded',
            getPromotedPrebufferAttemptTimings(promotedPrebufferRequestId)
          )
          return
        }

        if (audioEngine.nextBufferedTrackPath === candidate.track.path) {
          invalidateLoadRequest()
          manualGaplessTransitionInProgress = true
          const backendStart = performance.now()
          try {
            if (audioEngine.skipToPreBuffered()) {
              attempt.prebufferStatus = 'in_flight_promoted'
              markPlaybackAttemptPlaying(attempt)
              completePlaybackAttempt(
                attempt,
                candidate.track,
                'loaded',
                getPromotedPrebufferAttemptTimings(
                  promotedPrebufferRequestId,
                  performance.now() - backendStart
                )
              )
              return
            }
          } catch (error) {
            preAppliedGaplessQueueItemId = null
            completePlaybackAttempt(
              attempt,
              candidate.track,
              'failed',
              getPromotedPrebufferAttemptTimings(
                promotedPrebufferRequestId,
                performance.now() - backendStart
              )
            )
            throw error
          } finally {
            manualGaplessTransitionInProgress = false
          }
          preAppliedGaplessQueueItemId = null
        }

        preAppliedGaplessQueueItemId = null
        await runSerializedTrackLoad(candidate.track, { attempt }, playbackIntent)
        return
      }

      set(applyCandidateTransition(state, candidate, {
        pushCurrentToHistory: true
      }))
      commitPlaybackTransition(attempt, playbackIntentId, candidate.track, {
        queueItemId: candidate.kind === 'current' ? state.currentQueueItemId : candidate.item.queueId
      })
      attempt.queuePreparationMs = performance.now() - commandStartedAtMs

      await runSerializedTrackLoad(candidate.track, { attempt }, playbackIntent)
    },

    playPrevious: async () => {
      if (blockLocalPlaybackInParallaxSinkMode()) return

      const commandStartedAtMs = performance.now()
      const state = get()
      const hasCommittedTransition = getCommittedTransitionTarget(state) !== null

      // If more than 3 seconds into track, restart it
      if (state.currentTrack && !hasCommittedTransition && state.currentTime > 3) {
        await get().seek(0)
        return
      }

      const previousEntry = state.playbackHistory[state.playbackHistory.length - 1]
      const previousTrack = resolveQueueEntryTrack(previousEntry?.item.entry)
      if (!previousEntry || !previousTrack || isUnavailableRemoteTrack(previousTrack)) return
      const playbackIntentId = beginPlaybackIntent()
      clearNonmatchingPrebufferForIntent(playbackIntentId, previousTrack.path)
      supersedeInteractiveLoudnessAnalysis(previousTrack.path)
      const attempt = createPlaybackAttempt('previous', commandStartedAtMs, {
        prebufferStatus: 'miss'
      })

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
      commitPlaybackTransition(attempt, playbackIntentId, previousTrack, {
        queueItemId: previousEntry.item.queueId
      })
      attempt.queuePreparationMs = performance.now() - commandStartedAtMs

      let targetTrack = previousTrack
      const contextHydration = getOrStartContextTrackHydration(
        previousTrack.path,
        previousEntry.item.queueId
      )
      if (contextHydration) {
        const hydrationStartedAtMs = performance.now()
        const hydratedTrack = await contextHydration
        attempt.selectedTrackHydrationMs = performance.now() - hydrationStartedAtMs
        if (!isCurrentPlaybackIntent(playbackIntentId)) {
          completePlaybackAttempt(attempt, targetTrack, 'superseded', {
            backend: getAttemptBackend(targetTrack)
          })
          return
        }
        const refreshedItem = get().queueItems.find(
          (queueItem) => queueItem.queueId === previousEntry.item.queueId
        )
        if (!refreshedItem) {
          completePlaybackAttempt(attempt, targetTrack, 'superseded', {
            backend: getAttemptBackend(targetTrack)
          })
          return
        }
        targetTrack = resolveQueueEntryTrack(refreshedItem.entry)
          ?? (hydratedTrack ? dbTrackToTrack(hydratedTrack) : previousTrack)
        if (isUnavailableRemoteTrack(targetTrack)) {
          completePlaybackAttempt(attempt, targetTrack, 'failed', {
            backend: getAttemptBackend(targetTrack)
          })
          return
        }
      }

      const loaded = await runSerializedTrackLoad(targetTrack, {
        manualStart: true,
        attempt
      }, 'previous')
      if (loaded === 'failed' && targetTrack.sourceType && targetTrack.sourceType !== 'local') {
        markTrackUnavailableInState(targetTrack.path)
      }
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

    getResolvedUpcomingEntries: (limit) => {
      return buildResolvedUpcomingEntries(get(), limit)
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
      return state.playbackHistory.length + (state.currentTrack ? 1 : 0) + state.upcomingQueueIds.length
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
      const loadStart = performance.now()
      supersedeInteractiveLoudnessAnalysis(track.path)
      const attempt = options.attempt ?? createPlaybackAttempt('direct', loadStart, {
        prebufferStatus: 'miss'
      })
      let attemptBackend = getAttemptBackend(track)
      let attemptLoadRequestId: number | null = null
      let attemptFileReadMs: number | null = null
      let attemptDecodeMs: number | null = null
      let attemptDecodeOnlyMs: number | null = null
      let attemptStandardLoadPipelineMs: number | null = null
      let attemptLoudnessMs: number | null = null
      let attemptBackendStartMs: number | null = null
      let attemptStandardPcmTimings: AudioLoadTimings | null = null
      let nativeBinaryResolutionMs: number | null = null
      let nativeProbeMs: number | null = null
      let nativeDecodeMs: number | null = null
      let nativeLoadMs: number | null = null
      let nativeDeviceStartMs: number | null = null
      const finishAttempt = (outcome: PlaybackLoadOutcome): void => {
        if (attemptBackend === 'bitperfect' || attemptBackend === 'exclusive') {
          const timings = audioEngine.getLastLoadTimings()
          attemptDecodeMs ??= timings?.decodeMs ?? null
          nativeBinaryResolutionMs ??= timings?.nativeBinaryResolutionMs ?? null
          nativeProbeMs ??= timings?.nativeProbeMs ?? null
          nativeDecodeMs ??= timings?.nativeDecodeMs ?? null
          nativeLoadMs ??= timings?.nativeLoadMs ?? null
          nativeDeviceStartMs ??= timings?.nativeDeviceStartMs ?? null
        }
        const pcmTimingDetails = getStandardPcmTimingDetails(attemptStandardPcmTimings)
        completePlaybackAttempt(attempt, track, outcome, {
          backend: attemptBackend,
          loadRequestId: attemptLoadRequestId,
          ...pcmTimingDetails,
          fileReadMs: attemptFileReadMs,
          decodeMs: attemptDecodeMs,
          decodeOnlyMs: attemptDecodeOnlyMs,
          standardLoadPipelineMs: attemptStandardLoadPipelineMs,
          decodeWorkMs: attemptDecodeOnlyMs ?? pcmTimingDetails.decodeWorkMs,
          loudnessMs: attemptLoudnessMs,
          backendStartMs: attemptBackendStartMs,
          nativeBinaryResolutionMs,
          nativeProbeMs,
          nativeDecodeMs,
          nativeLoadMs,
          nativeDeviceStartMs
        })
      }

      if (blockLocalPlaybackInParallaxSinkMode()) {
        finishAttempt('superseded')
        return 'superseded'
      }

      const loadRequestId = beginLoadRequest()
      attemptLoadRequestId = loadRequestId
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
        if (shouldUseNativeExclusivePath(track)) {
          attemptBackend = getAttemptBackend(track)
          audioEngine.setCurrentReplayGainDb(replayGainDb)
          const loudnessAnalysis = requestTrackLoudnessAnalysis(track, replayGainDb)
          const loadResult = await audioEngine.loadTrackFromPath(track, {
            replayGainDb,
            trackPath: track.path,
            loudnessAnalysis
          })
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
          const backendStart = performance.now()
          try {
            await playWithParallaxIfNeeded(resolvedTrack, () => isActiveLoadRequest(loadRequestId))
          } finally {
            attemptBackendStartMs = performance.now() - backendStart
            const timings = audioEngine.getLastLoadTimings()
            nativeBinaryResolutionMs = timings?.nativeBinaryResolutionMs ?? nativeBinaryResolutionMs
            nativeProbeMs = timings?.nativeProbeMs ?? nativeProbeMs
            nativeDecodeMs = timings?.nativeDecodeMs ?? nativeDecodeMs
            nativeLoadMs = timings?.nativeLoadMs ?? nativeLoadMs
            nativeDeviceStartMs = timings?.nativeDeviceStartMs ?? nativeDeviceStartMs
          }
          throwIfSupersededLoad(loadRequestId)
          markPlaybackAttemptPlaying(attempt)
          void useLibraryStore.getState().markTrackLatestSyncSeen(resolvedTrack.path)
          startRecentPlaySession(resolvedTrack.path)
          schedulePreBufferNextTrack()
          warmupUpcomingLoudness()
          const engineTimings = audioEngine.getLastLoadTimings()
          attemptDecodeMs = engineTimings?.decodeMs ?? null
          nativeBinaryResolutionMs = engineTimings?.nativeBinaryResolutionMs ?? null
          nativeProbeMs = engineTimings?.nativeProbeMs ?? null
          nativeDecodeMs = engineTimings?.nativeDecodeMs ?? null
          nativeLoadMs = engineTimings?.nativeLoadMs ?? null
          nativeDeviceStartMs = engineTimings?.nativeDeviceStartMs ?? null
          logMemoryDiagnosticsEvent('track_load_success', {
            attemptId: attempt.id,
            loadRequestId,
            prebufferRequestId: null,
            decodeRequestId: null,
            trackPath: track.path,
            sourceType: track.sourceType ?? 'local',
            loadPath: useAudioSettingsStore.getState().playbackOutputMode,
            durationSeconds: loadResult.duration,
            channels: loadResult.channels,
            nativeBinaryResolutionMs,
            nativeProbeMs,
            nativeDecodeMs,
            nativeLoadMs,
            nativeDeviceStartMs
          }, 'renderer', { captureSample: false })
          logSlowPath('queueLoadAndPlayTrack', loadStart, {
            trackPath: track.path,
            usedNativeExclusive: true,
            nativeOutputMode: useAudioSettingsStore.getState().playbackOutputMode
          })
          finishAttempt('loaded')
          return 'loaded'
        }

        if (track.sourceType && track.sourceType !== 'local') {
          attemptBackend = 'remote'
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
            const backendStart = performance.now()
            try {
              await playWithParallaxIfNeeded(resolvedTrack, () => isActiveLoadRequest(loadRequestId))
            } finally {
              attemptBackendStartMs = performance.now() - backendStart
            }
            throwIfSupersededLoad(loadRequestId)
            markPlaybackAttemptPlaying(attempt)
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
              attemptId: attempt.id,
              loadRequestId,
              prebufferRequestId: null,
              decodeRequestId: null,
              trackPath: track.path,
              sourceType: resolvedTrack.sourceType ?? 'local',
              loadPath: 'remote_stream',
              sessionId: streamInfo.sessionId,
              durationSeconds: resolvedTrack.duration,
              channels: streamInfo.channels
            }, 'renderer', { captureSample: false })
            logSlowPath('queueLoadAndPlayTrack', loadStart, {
              trackPath: track.path,
              usedRemoteStream: true
            })
            finishAttempt('loaded')
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
          attemptBackend = 'local_progressive'
          const needsFixedLoudness = audioEngine.needsLoudnessAnalysisForLoad(replayGainDb)
          const progressiveLoudnessStartedAt = needsFixedLoudness ? performance.now() : null
          const fixedLoudness = needsFixedLoudness
            ? await resolveInteractiveLoudnessForProgressiveLoad(track, replayGainDb, loadRequestId)
            : null
          if (progressiveLoudnessStartedAt !== null) {
            attemptLoudnessMs = performance.now() - progressiveLoudnessStartedAt
          }
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
              const backendStart = performance.now()
              try {
                await audioEngine.play()
              } finally {
                attemptBackendStartMs = performance.now() - backendStart
              }
              throwIfSupersededLoad(loadRequestId)
              markPlaybackAttemptPlaying(attempt)
              void useLibraryStore.getState().markTrackLatestSyncSeen(resolvedTrack.path)
              startRecentPlaySession(resolvedTrack.path)
              schedulePreBufferNextTrack()
              warmupUpcomingLoudness()
              logMemoryDiagnosticsEvent('track_load_success', {
                attemptId: attempt.id,
                loadRequestId,
                prebufferRequestId: null,
                decodeRequestId: null,
                trackPath: track.path,
                sourceType: 'local',
                loadPath: 'local_progressive_stream',
                sessionId: streamInfo.sessionId,
                durationSeconds: resolvedTrack.duration,
                channels: streamInfo.channels,
                usedReplayGain: replayGainDb != null,
                usedStoredLoudness: Boolean(fixedLoudness)
              }, 'renderer', { captureSample: false })
              logSlowPath('queueLoadAndPlayTrack', loadStart, {
                trackPath: track.path,
                usedLocalProgressiveStream: true
              })
              finishAttempt('loaded')
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

        attemptBackend = 'standard'
        // Resolve loudness (stored value or main-process ffmpeg pass) in
        // parallel with whichever decoder wins below. The same promise is
        // reused if the native float32 path needs Chromium fallback.
        const loudnessAnalysis = requestTrackLoudnessAnalysis(track, replayGainDb)
        let result: Awaited<ReturnType<typeof window.electronAPI.loadAudioFile>> = null
        let fileLoadMs: number | null = null
        let usedFfmpegPcm = false
        let usedFfmpegFallback = false
        const decodeStart = performance.now()
        try {
          const canUseFfmpegPcm = !isIamfTrack(track)
            && Number.isInteger(track.channels)
            && Number(track.channels) >= 1
            && Number(track.channels) <= 8
            && typeof window.electronAPI.decodeLocalAudioToPcm === 'function'

          if (canUseFfmpegPcm) {
            const pcmOutcome = await audioEngine.loadStandardTrackFromPath(track, {
              replayGainDb,
              trackPath: track.path,
              loudnessAnalysis,
              priority: 'interactive'
            })
            throwIfSupersededLoad(loadRequestId)
            if (pcmOutcome === 'cancelled') {
              throw new SupersededPlaybackLoadError()
            }
            usedFfmpegPcm = pcmOutcome === 'loaded'
            if (usedFfmpegPcm) {
              attemptStandardPcmTimings = audioEngine.getLastLoadTimings()
            }
          }

          if (!usedFfmpegPcm) {
            const fileLoadStart = performance.now()
            result = await window.electronAPI.loadAudioFile(track.path, { metadataMode: 'none' })
              .finally(() => {
                attemptFileReadMs = performance.now() - fileLoadStart
              })
            throwIfSupersededLoad(loadRequestId)
            fileLoadMs = Math.round(performance.now() - fileLoadStart)
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
              finishAttempt('failed')
              return 'failed'
            }
            if (!result.data) {
              throw new Error('Audio file data missing from full decode load.')
            }

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
          }
        } finally {
          attemptStandardLoadPipelineMs = performance.now() - decodeStart
          attemptDecodeMs = attemptStandardLoadPipelineMs
        }
        const decodeMs = Math.round(attemptStandardLoadPipelineMs)
        const detectedChannels = audioEngine.getCurrentTrackChannelCount()
        const metadataResolvedTrack: Track = {
          ...track,
          title: result?.metadata?.title ?? track.title,
          artist: result?.metadata?.artist ?? track.artist,
          album: result?.metadata?.album ?? track.album,
          albumArtist: result?.metadata?.albumArtist ?? track.albumArtist,
          duration: result?.metadata?.duration ?? track.duration,
          channels: detectedChannels ?? result?.metadata?.channels ?? track.channels,
          codec: result?.metadata?.codec ?? track.codec,
          codecProfile: result?.metadata?.codecProfile ?? track.codecProfile,
          isAtmosJoc: result?.metadata?.isAtmosJoc ?? track.isAtmosJoc,
          isIamf: result?.metadata?.isIamf ?? track.isIamf,
          replayGainTrackDb: result?.metadata?.replayGainTrackDb ?? track.replayGainTrackDb,
          replayGainAlbumDb: result?.metadata?.replayGainAlbumDb ?? track.replayGainAlbumDb
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
        const backendStart = performance.now()
        try {
          await playWithParallaxIfNeeded(resolvedTrack, () => isActiveLoadRequest(loadRequestId))
        } finally {
          attemptBackendStartMs = performance.now() - backendStart
        }
        throwIfSupersededLoad(loadRequestId)
        markPlaybackAttemptPlaying(attempt)
        void useLibraryStore.getState().markTrackLatestSyncSeen(resolvedTrack.path)
        startRecentPlaySession(resolvedTrack.path)
        const engineTimings = audioEngine.getLastLoadTimings()
        if (usedFfmpegPcm) {
          attemptStandardPcmTimings = engineTimings ?? attemptStandardPcmTimings
        }
        attemptDecodeOnlyMs = engineTimings?.decodeWorkMs ?? engineTimings?.decodeMs ?? null
        attemptLoudnessMs = engineTimings?.analysisMs ?? null
        nativeProbeMs = usedFfmpegPcm ? engineTimings?.nativeProbeMs ?? null : null
        nativeDecodeMs = usedFfmpegPcm ? engineTimings?.nativeDecodeMs ?? null : null
        const pcmTimingDetails = getStandardPcmTimingDetails(attemptStandardPcmTimings)
        logMemoryDiagnosticsEvent('track_load_success', {
          attemptId: attempt.id,
          loadRequestId,
          prebufferRequestId: null,
          trackPath: track.path,
          sourceType: resolvedTrack.sourceType ?? 'local',
          loadPath: usedFfmpegPcm
            ? 'file_ffmpeg_pcm'
            : usedFfmpegFallback
              ? 'file_ffmpeg_fallback'
              : 'file_decode',
          fileLoadMs,
          ...pcmTimingDetails,
          decodeMs,
          decodeOnlyMs: attemptDecodeOnlyMs,
          standardLoadPipelineMs: decodeMs,
          decodeWorkMs: attemptDecodeOnlyMs,
          loudnessMs: engineTimings?.analysisMs ?? null,
          loudnessAnalysisMs: engineTimings?.analysisMs ?? null,
          nativePcmProbeMs: usedFfmpegPcm ? engineTimings?.nativeProbeMs ?? null : null,
          nativePcmDecodeMs: usedFfmpegPcm ? engineTimings?.nativeDecodeMs ?? null : null,
          usedFfmpegPcm,
          usedFfmpegFallback
        }, 'renderer', { captureSample: false })

        // Schedule next-track prebuffering for the gapless handoff window.
        schedulePreBufferNextTrack()
        warmupUpcomingLoudness()
        logSlowPath('queueLoadAndPlayTrack', loadStart, {
          trackPath: track.path,
          fileLoadMs,
          decodeMs,
          decodeOnlyMs: engineTimings?.decodeMs ?? null,
          loudnessAnalysisMs: engineTimings?.analysisMs ?? null,
          nativePcmProbeMs: usedFfmpegPcm ? engineTimings?.nativeProbeMs ?? null : null,
          nativePcmDecodeMs: usedFfmpegPcm ? engineTimings?.nativeDecodeMs ?? null : null,
          usedFfmpegPcm,
          usedFfmpegFallback
        })
        finishAttempt('loaded')
        return 'loaded'
      } catch (error) {
        if (isSupersededPlaybackLoad(error, loadRequestId)) {
          finishAttempt('superseded')
          return 'superseded'
        }
        if (recentPlaySession === loadListeningSession) finalizeRecentPlaySession()
        const isFormatFailure = showBitPerfectFormatNotice(track, error)
        const failureMessage = error instanceof Error
          ? stripBitPerfectFormatTag(error.message)
          : 'Unknown track load failure.'
        if (isFormatFailure) {
          console.warn('Bit-perfect playback rejected by the output device:', failureMessage)
        } else {
          console.error('Failed to load track:', error)
        }
        logMemoryDiagnosticsEvent('track_load_failed', {
          attemptId: attempt.id,
          loadRequestId,
          prebufferRequestId: null,
          decodeRequestId: attemptStandardPcmTimings?.decodeRequestId ?? null,
          trackPath: track.path,
          sourceType: track.sourceType ?? 'local',
          message: failureMessage
        }, 'renderer', { captureSample: false })
        logSlowPath('queueLoadAndPlayTrack', loadStart, {
          trackPath: track.path,
          failed: true,
          deviceFormatRejected: isFormatFailure
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
        finishAttempt('failed')
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
      if (prebufferRetryAtLateTrackPath !== expectedPrebufferTrackPath) {
        prebufferRetryAtLateTrackPath = null
      }

      const canApplyPrebufferResult = (nextTrack: Track): boolean => {
        const preAppliedItem = preAppliedGaplessQueueItemId
          ? get().queueItems.find((item) => item.queueId === preAppliedGaplessQueueItemId)
          : null
        return isActivePrebufferRequest(prebufferRequestId)
          && (
            resolveExpectedPrebufferTrackPath() === nextTrack.path
            || preAppliedItem?.entry.path === nextTrack.path
          )
      }

      try {
        if (useAudioSettingsStore.getState().disableGaplessPrebufferDev) {
          return
        }

        if (state.repeat === 'one' || !expectedPrebufferTrackPath) {
          return
        }

        for (const candidate of iterateNextCandidates(state)) {
          const nextTrack = candidate.track
          if (!nextTrack) continue
          if (nextTrack.sourceType && nextTrack.sourceType !== 'local') {
            // Remote prebuffering downloads entire files and can stall click-to-play on constrained links.
            continue
          }
          if (isUnavailableRemoteTrack(nextTrack)) continue
          const activeOutputMode = audioEngine.getPlaybackOutputMode()
          if (activeOutputMode !== 'standard' && !shouldUseNativeExclusivePath(nextTrack)) {
            return
          }
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
            if (shouldUseNativeExclusivePath(nextTrack)) {
              const nativePrebufferIntentId = playbackIntentGeneration
              const nextReplayGainDb = getReplayGainCandidateDb(nextTrack, useAudioSettingsStore.getState().replayGainMode)
              const nextLoudnessAnalysis = requestTrackLoudnessAnalysis(nextTrack, nextReplayGainDb)
              await runNativeControlAfterActiveTransition(nativePrebufferIntentId, async () => {
                if (!canApplyPrebufferResult(nextTrack)) return
                await audioEngine.preBufferNextTrackFromPath(nextTrack, {
                  replayGainDb: nextReplayGainDb,
                  trackPath: nextTrack.path,
                  loudnessAnalysis: nextLoudnessAnalysis
                })
              })
              if (!canApplyPrebufferResult(nextTrack)) {
                // Leave a just-completed native prebuffer in place. Clearing it
                // here can overlap an active device handshake; path checks keep
                // it ineligible, and the next serialized native load/stop clears
                // or promotes it safely.
                return
              }
              logSlowPath('preBufferNextTrack', bufferStart, {
                trackPath: nextTrack.path,
                loaded: true,
                usedNativeExclusive: true,
                nativeOutputMode: useAudioSettingsStore.getState().playbackOutputMode
              })
              prebufferRetryAtLateTrackPath = null
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
            // Resolve loudness in parallel with the native decode. Reuse the
            // same result if this track needs the Chromium fallback.
            const nextLoudnessAnalysis = requestTrackLoudnessAnalysis(
              nextTrack,
              nextReplayGainDb,
              'background'
            )
            const canUseFfmpegPcm = !isIamfTrack(nextTrack)
              && Number.isInteger(nextTrack.channels)
              && Number(nextTrack.channels) >= 1
              && Number(nextTrack.channels) <= 8
              && typeof window.electronAPI.decodeLocalAudioToPcm === 'function'
            let usedFfmpegPcm = false
            let standardLoadPipelineMs: number | null = null

            if (canUseFfmpegPcm) {
              const standardLoadStartedAt = performance.now()
              let pcmOutcome: Awaited<ReturnType<typeof audioEngine.preBufferNextStandardTrackFromPath>>
              try {
                pcmOutcome = await audioEngine.preBufferNextStandardTrackFromPath(nextTrack, {
                  replayGainDb: nextReplayGainDb,
                  trackPath: nextTrack.path,
                  loudnessAnalysis: nextLoudnessAnalysis,
                  priority: 'background'
                })
              } finally {
                standardLoadPipelineMs = performance.now() - standardLoadStartedAt
              }
              if (!canApplyPrebufferResult(nextTrack)) {
                if (pcmOutcome === 'loaded') audioEngine.clearNextBuffer()
                return
              }
              if (pcmOutcome === 'cancelled') return
              usedFfmpegPcm = pcmOutcome === 'loaded'
            }

            if (!usedFfmpegPcm) {
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
              } else {
                if (isActivePrebufferRequest(prebufferRequestId)) {
                  prebufferRetryAtLateTrackPath = nextTrack.path
                }
                return
              }
            }

            // Both decoders intentionally install an ordinary AudioBuffer.
            // Verify ownership before declaring success; an eager miss gets
            // one retry in the final 15-second window.
            if (audioEngine.nextBufferedTrackPath !== nextTrack.path) {
              if (isActivePrebufferRequest(prebufferRequestId)) {
                prebufferRetryAtLateTrackPath = nextTrack.path
              }
              return
            }
            logSlowPath('preBufferNextTrack', bufferStart, {
              trackPath: nextTrack.path,
              loaded: true,
              usedFfmpegPcm
            })
            completedPrebufferRequestId = prebufferRequestId
            completedPrebufferTrackPath = nextTrack.path
            const engineTimings = audioEngine.getLastPrebufferLoadTimings()
            const pcmTimingDetails = getStandardPcmTimingDetails(usedFfmpegPcm ? engineTimings : null)
            const roundedStandardLoadPipelineMs = standardLoadPipelineMs === null
              ? engineTimings?.standardLoadPipelineMs ?? null
              : Math.round(standardLoadPipelineMs)
            const decodeWorkMs = engineTimings?.decodeWorkMs ?? engineTimings?.decodeMs ?? null
            logMemoryDiagnosticsEvent('prebuffer_complete', {
              attemptId: null,
              loadRequestId: null,
              prebufferRequestId,
              trackPath: nextTrack.path,
              decoder: usedFfmpegPcm ? 'ffmpeg_pcm' : 'webaudio',
              ...pcmTimingDetails,
              decodeMs: roundedStandardLoadPipelineMs,
              decodeOnlyMs: decodeWorkMs,
              standardLoadPipelineMs: roundedStandardLoadPipelineMs,
              decodeWorkMs,
              loudnessMs: engineTimings?.analysisMs ?? null
            })
            prebufferRetryAtLateTrackPath = null
            // §21 Gapless sink handoff — the next track is decoded; pre-announce it to connected
            // sinks so they pre-buffer and cross the boundary gaplessly. No-op unless hosting with
            // sinks on a Standard-mode local track.
            void useParallaxStore.getState().publishHostNextStream(nextTrack)
            return
          } catch (error) {
            if (isSupersededAudioLoadError(error) || !isActivePrebufferRequest(prebufferRequestId)) {
              return
            }
            console.error('Failed to pre-buffer next track:', error)
            prebufferRetryAtLateTrackPath = nextTrack.path
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

    _clearBufferedNextTrack: () => {
      clearBufferedNextTrack()
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
        const reconciliation = pendingPlaybackInterruptionReconciliation
        if (
          reconciliation
          && reconciliation.intentId === playbackIntentGeneration
          && (
            reconciliation.desiredState === nextPlaybackState
            || (reconciliation.desiredState === 'paused' && nextPlaybackState === 'stopped')
          )
        ) {
          pendingPlaybackInterruptionReconciliation = null
          applyPlaybackInterruptionReconciliation(reconciliation)
        }
      })

      audioEngine.on('nativeCapabilitiesChange', (capabilities) => {
        if (useAudioSettingsStore.getState().playbackOutputMode === 'standard') {
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
        const state = get()
        // A queued gapless callback can outlive the buffer it belongs to. Once a
        // newer explicit transition has committed its target, only the matching
        // in-flight prebuffer promotion may advance that already-applied queue.
        if (preAppliedGaplessQueueItemId === null && getCommittedTransitionTarget(state)) return
        finalizeRecentPlaySession('playing', {
          completedNaturally: !manualGaplessTransitionInProgress
        })

        if (state.repeat === 'one') {
          // Safety net: AudioEngine already swapped to the wrong buffer.
          // Reload the correct track to fix audio/UI desync.
          const correctTrack = state.currentTrack
          if (correctTrack) {
            void get()._loadAndPlayTrack(correctTrack)
          }
          return
        }

        const preAppliedQueueItem = preAppliedGaplessQueueItemId
          ? state.queueItems.find((item) => item.queueId === preAppliedGaplessQueueItemId)
          : null
        const nextCandidate = preAppliedQueueItem ? null : findNextPlayableCandidate(state)
        const nextTrack = preAppliedQueueItem
          ? resolveQueueEntryTrack(preAppliedQueueItem.entry)
          : nextCandidate && nextCandidate.kind !== 'current'
            ? nextCandidate.track
            : null
        if (!nextTrack) {
          preAppliedGaplessQueueItemId = null
          return
        }
        if (isUnavailableRemoteTrack(nextTrack)) return
        logMemoryDiagnosticsEvent('gapless_transition_state', {
          previousTrackPath: state.currentTrack?.path ?? null,
          nextTrackPath: nextTrack.path
        })

        const transitionState = preAppliedQueueItem
          ? {}
          : applyCandidateTransition(state, nextCandidate!, {
              pushCurrentToHistory: true
            })
        if (preAppliedQueueItem) {
          completedPreAppliedGaplessQueueItemId = preAppliedQueueItem.queueId
        }
        preAppliedGaplessQueueItemId = null
        const nextState = {
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
        // Ignore a stale end notification while a newer click/skip owns the
        // committed target. Its load will establish the next authoritative state.
        if (getCommittedTransitionTarget(get())) return
        finalizeRecentPlaySession('playing', { completedNaturally: true })
        set({
          currentTime: 0,
          remoteBufferedSeconds: 0,
          remoteStreamSessionId: null
        })
        // Auto-play next track (non-gapless fallback)
        nextPlaybackIntentOverride = 'automatic'
        get().playNext()
      })

      audioEngine.on('error', (error) => {
        finalizeRecentPlaySession()
        const currentTrack = get().currentTrack
        const surfacedNativeFailure = currentTrack
          ? showBitPerfectFormatNotice(currentTrack, error)
          : false
        if (!surfacedNativeFailure) console.error('Audio engine error:', error)
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
      playbackIntentGeneration += 1
      cancelPendingTransitionLoads()
      activeExecutingTransition = null
      committedPlaybackTransition = null
      pendingNativeSeek = null
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
  playerState._clearBufferedNextTrack()
  playerState._schedulePreBufferNextTrack({ invalidatePending: true })
})

useAudioSettingsStore.subscribe((nextState, prevState) => {
  if (nextState.disableGaplessPrebufferDev === prevState.disableGaplessPrebufferDev) return

  const playerState = usePlayerStore.getState()
  playerState._clearBufferedNextTrack()
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
