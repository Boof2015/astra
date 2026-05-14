import { create } from 'zustand'
import { audioEngine, isSupersededAudioLoadError } from '../audio/AudioEngine'
import type { Track, PlaybackState } from '../types/audio'
import type { NativeAudioCapabilities } from '../../types/nativeAudio'
import { extractWaveformPeaks } from '../audio/waveformExtractor'
import { useLibraryStore, type DbTrack } from './libraryStore'
import { resolveOutputDeviceLabel, useAudioSettingsStore, type ReplayGainMode } from './audioSettingsStore'
import { logMemoryDiagnosticsEvent } from '../utils/memoryDiagnostics'

interface RemoteLoadProgress {
  path: string
  sourceType: 'subsonic' | 'jellyfin'
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

export type QueueTrackSource = 'user' | 'auto' | 'manual'
type PlaybackLoadOutcome = 'loaded' | 'failed' | 'superseded'

export type QueueTrackSnapshot = Omit<Track, 'artworkData'>

export interface QueueTrackEntry {
  path: string
  snapshot: QueueTrackSnapshot
}

export interface PlaybackHistoryEntry {
  entry: QueueTrackEntry
  source: QueueTrackSource
  autoQueueIndex: number
}

export interface QueueTrackLocator {
  source: 'user' | 'auto'
  index: number
}

export interface ResolvedQueueTrack {
  source: 'future' | 'user' | 'auto' | 'previous'
  track: Track
  index: number
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

  // Queue state
  userQueue: QueueTrackEntry[]
  autoQueue: QueueTrackEntry[]
  autoQueueIndex: number
  autoQueueSourcePlaylistId: number | null
  autoQueueContextLabel: string | null
  shuffle: boolean
  repeat: 'none' | 'one' | 'all'
  shuffledAutoIndices: number[]
  playbackHistory: PlaybackHistoryEntry[]
  playbackFuture: PlaybackHistoryEntry[]

  // Actions
  loadTrack: (track: Track, audioData: ArrayBuffer) => Promise<boolean>
  play: () => Promise<void>
  pause: () => void
  togglePlay: () => Promise<void>
  stop: () => void
  seek: (time: number) => Promise<void>
  setVolume: (volume: number) => void
  toggleMute: () => void
  resetAudioPreferences: () => void

  // Queue actions
  startPlaybackContext: (
    tracks: Track[],
    startIndex?: number,
    options?: { sourcePlaylistId?: number | null; contextLabel?: string | null }
  ) => Promise<void>
  startPlaybackContextByPaths: (
    paths: string[],
    startIndex?: number,
    options?: { sourcePlaylistId?: number | null; contextLabel?: string | null }
  ) => Promise<void>
  enqueueUserTrack: (track: Track, position?: number | 'next' | 'end') => void
  enqueueUserTracks: (tracks: Track[], position?: number | 'next' | 'end') => void
  enqueueUserTrackPaths: (paths: string[], position?: number | 'next' | 'end') => Promise<void>
  moveUserQueue: (fromIndex: number, toIndex: number) => void
  removeUserTrack: (index: number) => void
  clearUserQueue: () => void
  clearAllQueues: () => void
  playNext: () => Promise<void>
  playPrevious: () => Promise<void>
  playQueuedTrack: (locator: QueueTrackLocator, options?: { manualStart?: boolean }) => Promise<void>
  toggleShuffle: () => void
  toggleRepeat: () => void
  getResolvedUpcomingTracks: () => Track[]
  getResolvedUpcomingEntries: () => ResolvedQueueTrack[]
  getResolvedUserQueueEntries: () => ResolvedQueueTrack[]
  getResolvedAutoUpcomingTracks: () => Track[]
  getResolvedAutoUpcomingEntries: () => ResolvedQueueTrack[]
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

  // Compatibility wrappers during queue migration
  setQueue: (tracks: Track[], startIndex?: number, options?: { sourcePlaylistId?: number | null; contextLabel?: string | null }) => void
  addToQueue: (track: Track) => void
  addToQueueNext: (track: Track) => void
  removeFromQueue: (index: number) => void
  moveInQueue: (fromIndex: number, toIndex: number) => void
  clearQueue: () => void
  playTrackAt: (index: number) => Promise<void>
  getUpcomingTracks: () => Track[]
  getPreviousTracks: () => Track[]

  // Internal
  _initListeners: () => void
  _cleanupListeners: () => void
  _loadAndPlayTrack: (track: Track, options?: { manualStart?: boolean }) => Promise<PlaybackLoadOutcome>
  _preBufferNextTrack: () => Promise<void>
  _schedulePreBufferNextTrack: (options?: { invalidatePending?: boolean }) => void
  _getNextEntry: () => ResolvedQueueTrack | null
  _generateShuffleOrder: (currentAutoQueueIndex: number) => void
}

// Waveform cache stored outside zustand to avoid re-renders on cache updates
const waveformCache = new Map<string, Float32Array>()
const MAX_WAVEFORM_CACHE_ENTRIES = 128
const SLOW_PATH_THRESHOLD_MS = 1500
const OUTPUT_DELAY_NOTICE_THRESHOLD_MS = 120
const RECENT_PLAY_MIN_SECONDS = 10
const DEFAULT_PLAYER_VOLUME = 0.7
const CURRENT_TIME_STORE_THROTTLE_MS = 100
const BYTES_PER_FLOAT32_SAMPLE = 4
const MAX_STANDARD_PREBUFFER_TRACK_BYTES = 192 * 1024 * 1024
const MAX_STANDARD_PREBUFFER_TOTAL_BYTES = 384 * 1024 * 1024
export const GAPLESS_PREBUFFER_LEAD_SECONDS = 15
const GAPLESS_PREBUFFER_TIMER_TOLERANCE_MS = 250
const MAX_GAPLESS_PREBUFFER_TIMER_MS = 2_147_000_000
export const MAX_PLAYBACK_HISTORY = 500
export const PLAYER_VOLUME_STORAGE_KEY = 'astra-player-volume-v1'
const BIT_PERFECT_REMOTE_FALLBACK_MESSAGE = 'Bit-perfect mode is only available for local files. Playback fell back to Standard.'

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
    artworkHash: dbTrack.artwork_hash ?? undefined,
    format: dbTrack.format,
    sampleRate: dbTrack.sample_rate ?? undefined,
    bitDepth: dbTrack.bit_depth ?? undefined,
    bitrate: dbTrack.bitrate ?? undefined,
    channels: dbTrack.channels ?? undefined,
    codec: codecTrack.codec ?? undefined,
    codecProfile: codecTrack.codec_profile ?? undefined,
    isAtmosJoc: codecTrack.is_atmos_joc === 1,
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

function getTrackRetentionDiagnostics(state: Pick<PlayerStore, 'currentTrack' | 'userQueue' | 'autoQueue' | 'playbackHistory' | 'playbackFuture'>) {
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
  state.userQueue.forEach((entry) => addTrackPath(entry.path))
  state.autoQueue.forEach((entry) => addTrackPath(entry.path))
  state.playbackHistory.forEach((entry) => addTrackPath(entry.entry.path))
  state.playbackFuture.forEach((entry) => addTrackPath(entry.entry.path))

  return {
    retainedTrackCount: state.currentTrack ? 1 : 0,
    distinctRetainedTrackCount: distinctTrackPaths.size,
    retainedArtworkTrackCount,
    retainedArtworkDataBytes
  }
}

function createInitialRemoteLoadProgress(track: Track): RemoteLoadProgress {
  return {
    path: track.path,
    sourceType: track.sourceType === 'jellyfin' ? 'jellyfin' : 'subsonic',
    stage: 'downloading',
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
  | { kind: 'current'; track: Track; source: QueueTrackSource; autoQueueIndex: number }
  | { kind: 'future'; entry: PlaybackHistoryEntry; track: Track }
  | { kind: 'user'; entry: QueueTrackEntry; track: Track; index: number }
  | { kind: 'auto'; entry: QueueTrackEntry; track: Track; index: number }

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

function normalizeContextLabel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function buildAutoShuffleOrder(queueLength: number, currentAutoQueueIndex: number): number[] {
  if (queueLength <= 0) return []
  const normalizedIndex = Math.max(0, Math.min(queueLength - 1, currentAutoQueueIndex))
  const indices = Array.from({ length: queueLength }, (_, index) => index).filter((index) => index !== normalizedIndex)

  for (let index = indices.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[indices[index], indices[swapIndex]] = [indices[swapIndex], indices[index]]
  }

  return [normalizedIndex, ...indices]
}

interface RecentPlaySession {
  trackPath: string
  thresholdSeconds: number
  counted: boolean
  allowDbWrite: boolean
  sourcePlaylistId: number | null
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
  replayGainTrackDb?: number
  replayGainAlbumDb?: number
  artwork?: string
}

function mergeAssociatedTrackMetadata(track: Track, metadata: AssociatedAudioMetadata): Track {
  return {
    ...track,
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
    artworkData: metadata.artwork ?? track.artworkData,
    channels: metadata.channels ?? track.channels,
    codec: metadata.codec ?? track.codec,
    codecProfile: metadata.codecProfile ?? track.codecProfile,
    isAtmosJoc: metadata.isAtmosJoc ?? track.isAtmosJoc,
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
  return useAudioSettingsStore.getState().playbackOutputMode === 'bitperfect'
}

async function ensureCompatiblePlaybackMode(track: Track): Promise<void> {
  const sourceType = track.sourceType ?? 'local'
  if (sourceType === 'local') {
    return
  }

  const audioSettings = useAudioSettingsStore.getState()
  if (audioSettings.playbackOutputMode !== 'bitperfect') {
    return
  }

  await audioSettings.setPlaybackOutputMode('standard')
  useAudioSettingsStore.setState({
    playbackModeStatusMessage: BIT_PERFECT_REMOTE_FALLBACK_MESSAGE
  })
}

export const usePlayerStore = create<PlayerStore>((set, get) => {
  // Track if listeners are initialized
  let listenersInitialized = false
  let remoteLoadProgressUnsubscribe: (() => void) | null = null
  let lastCommittedCurrentTimeMs = 0
  let ffmpegFallbackNoticeId = 0
  let outputDelayNoticeId = 0
  let associatedOpenNoticeId = 0
  const associatedMetadataInflight = new Set<string>()
  let pendingManualLoadCueTrack: Track | null = null
  let recentPlaySession: RecentPlaySession | null = null
  let activeLoadRequestId = 0
  let activePrebufferRequestId = 0
  let currentSerializedLoad: Promise<void> | null = null
  let prebufferScheduleTimerId: ReturnType<typeof globalThis.setTimeout> | null = null
  let prebufferScheduleDueAtMs: number | null = null
  let prebufferScheduleTrackPath: string | null = null
  let prebufferInFlightRequestId: number | null = null
  let prebufferInFlightTrackPath: string | null = null
  let prebufferAttemptedTrackPath: string | null = null

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

  const getRecentPlayThresholdSeconds = (track: Track | null): number => {
    if (!track || !Number.isFinite(track.duration) || track.duration <= 0) {
      return RECENT_PLAY_MIN_SECONDS
    }
    return Math.min(RECENT_PLAY_MIN_SECONDS, Math.max(0, track.duration))
  }

  const getCurrentPlaybackEntry = (
    state: Pick<PlayerStore, 'currentTrack' | 'currentTrackSource' | 'autoQueueIndex'>
  ): PlaybackHistoryEntry | null => {
    if (!state.currentTrack) return null
    return {
      entry: createQueueEntryFromTrack(state.currentTrack),
      source: state.currentTrackSource,
      autoQueueIndex: state.autoQueueIndex
    }
  }

  const resolveSourcePlaylistIdForState = (
    state: Pick<PlayerStore, 'currentTrack' | 'currentTrackSource' | 'autoQueue' | 'autoQueueIndex' | 'autoQueueSourcePlaylistId'>
  ): number | null => {
    if (state.currentTrackSource !== 'auto' || state.autoQueueSourcePlaylistId === null) {
      return null
    }
    const queuedTrackPath = state.autoQueue[state.autoQueueIndex]?.path
    if (queuedTrackPath === state.currentTrack?.path) {
      return state.autoQueueSourcePlaylistId
    }
    return null
  }

  const commitRecentPlay = (session: RecentPlaySession): void => {
    if (session.counted) return
    session.counted = true
    if (!session.allowDbWrite) return
    void useLibraryStore.getState().recordPlay(session.trackPath)
    if (session.sourcePlaylistId !== null) {
      void window.electronAPI.library.markPlaylistPlayed(session.sourcePlaylistId)
    }
  }

  const commitRecentPlayNow = (): void => {
    if (!recentPlaySession || recentPlaySession.counted) return
    commitRecentPlay(recentPlaySession)
  }

  const maybeCommitRecentPlay = (time: number): void => {
    if (!recentPlaySession || recentPlaySession.counted) return
    if (time >= recentPlaySession.thresholdSeconds) {
      commitRecentPlay(recentPlaySession)
    }
  }

  const startRecentPlaySession = (trackPath: string): void => {
    const state = get()
    const track = state.currentTrack
    const thresholdSeconds = getRecentPlayThresholdSeconds(track)
    recentPlaySession = {
      trackPath,
      thresholdSeconds,
      counted: false,
      allowDbWrite: track?.origin !== 'associated-external',
      sourcePlaylistId: resolveSourcePlaylistIdForState(state)
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
      userQueue: state.userQueue.map((queuedTrack) => (
        updateQueueEntryAvailability(queuedTrack, trackPath, reason)
      )),
      autoQueue: state.autoQueue.map((queuedTrack) => (
        updateQueueEntryAvailability(queuedTrack, trackPath, reason)
      )),
      playbackHistory: state.playbackHistory.map((entry) => (
        entry.entry.path === trackPath
          ? { ...entry, entry: updateQueueEntryAvailability(entry.entry, trackPath, reason) }
          : entry
      )),
      playbackFuture: state.playbackFuture.map((entry) => (
        entry.entry.path === trackPath
          ? { ...entry, entry: updateQueueEntryAvailability(entry.entry, trackPath, reason) }
          : entry
      )),
      currentTrack: state.currentTrack && state.currentTrack.path === trackPath
        ? { ...state.currentTrack, isAvailable: false, availabilityReason: reason }
        : state.currentTrack
    }))
  }

  const getAutoPlaybackOrder = (
    state: Pick<PlayerStore, 'autoQueue' | 'shuffle' | 'shuffledAutoIndices'>
  ): number[] => {
    if (state.autoQueue.length === 0) return []
    if (state.shuffle && state.shuffledAutoIndices.length === state.autoQueue.length) {
      return state.shuffledAutoIndices
    }
    return state.autoQueue.map((_, index) => index)
  }

  const getAutoPlaybackPosition = (
    state: Pick<PlayerStore, 'autoQueue' | 'autoQueueIndex' | 'shuffle' | 'shuffledAutoIndices'>
  ): number => {
    if (state.autoQueue.length === 0) return -1
    if (state.autoQueueIndex < 0 || state.autoQueueIndex >= state.autoQueue.length) return -1

    const order = getAutoPlaybackOrder(state)
    return order.indexOf(state.autoQueueIndex)
  }

  const getAutoUpcomingIndices = (
    state: Pick<PlayerStore, 'autoQueue' | 'autoQueueIndex' | 'currentTrack' | 'currentTrackSource' | 'shuffle' | 'shuffledAutoIndices'>
  ): number[] => {
    const order = getAutoPlaybackOrder(state)
    if (order.length === 0) return []

    const currentAutoPosition = getAutoPlaybackPosition(state)
    const hasAutoAnchor = currentAutoPosition >= 0
    const startPosition = state.currentTrack
      ? (hasAutoAnchor ? currentAutoPosition + 1 : 0)
      : (hasAutoAnchor ? currentAutoPosition : 0)

    return order.slice(Math.max(0, startPosition))
  }

  const getAutoWrapIndices = (
    state: Pick<PlayerStore, 'autoQueue' | 'autoQueueIndex' | 'shuffle' | 'shuffledAutoIndices'>
  ): number[] => {
    const order = getAutoPlaybackOrder(state)
    if (order.length === 0) return []

    const currentAutoPosition = getAutoPlaybackPosition(state)
    if (currentAutoPosition < 0) return []
    return order.slice(0, currentAutoPosition + 1)
  }

  const buildResolvedUpcomingEntries = (
    state: Pick<PlayerStore, 'playbackFuture' | 'userQueue' | 'autoQueue' | 'autoQueueIndex' | 'currentTrack' | 'currentTrackSource' | 'shuffle' | 'shuffledAutoIndices'>
  ): ResolvedQueueTrack[] => {
    const resolved: ResolvedQueueTrack[] = []

    state.playbackFuture.forEach((entry, index) => {
      const track = resolveQueueEntryTrack(entry.entry)
      if (!track) return
      resolved.push({
        source: 'future',
        track,
        index
      })
    })

    state.userQueue.forEach((entry, index) => {
      const track = resolveQueueEntryTrack(entry)
      if (!track) return
      resolved.push({
        source: 'user',
        track,
        index
      })
    })

    getAutoUpcomingIndices(state).forEach((index) => {
      const track = resolveQueueEntryTrack(state.autoQueue[index])
      if (!track) return
      resolved.push({
        source: 'auto',
        track,
        index
      })
    })

    return resolved
  }

  const collectNextCandidates = (state: PlayerStore): NextCandidate[] => {
    if (state.repeat === 'one' && state.currentTrack) {
      return [{
        kind: 'current',
        track: state.currentTrack,
        source: state.currentTrackSource,
        autoQueueIndex: state.autoQueueIndex
      }]
    }

    const candidates: NextCandidate[] = []

    state.playbackFuture.forEach((entry) => {
      const track = resolveQueueEntryTrack(entry.entry)
      if (!track) return
      candidates.push({ kind: 'future', entry, track })
    })

    state.userQueue.forEach((entry, index) => {
      const track = resolveQueueEntryTrack(entry)
      if (!track) return
      candidates.push({ kind: 'user', entry, track, index })
    })

    getAutoUpcomingIndices(state).forEach((index) => {
      const entry = state.autoQueue[index]
      const track = resolveQueueEntryTrack(entry)
      if (!track) return
      candidates.push({ kind: 'auto', entry, track, index })
    })

    if (state.repeat === 'all') {
      getAutoWrapIndices(state).forEach((index) => {
        const entry = state.autoQueue[index]
        const track = resolveQueueEntryTrack(entry)
        if (!track) return
        candidates.push({ kind: 'auto', entry, track, index })
      })
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

  const schedulePreBufferNextTrack = (options: { invalidatePending?: boolean } = {}): void => {
    if (options.invalidatePending) {
      clearScheduledPrebufferTimer()
      invalidatePrebufferRequest()
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
    options: { pushCurrentToHistory: boolean; clearFuture: boolean }
  ) => {
    const currentEntry = getCurrentPlaybackEntry(state)
    const nextHistory = options.pushCurrentToHistory && currentEntry && candidate.kind !== 'current'
      ? [...state.playbackHistory, currentEntry].slice(-MAX_PLAYBACK_HISTORY)
      : state.playbackHistory

    let nextFuture = state.playbackFuture
    let nextUserQueue = state.userQueue
    let nextCurrentSource = state.currentTrackSource
    let nextAutoQueueIndex = state.autoQueueIndex

    if (options.clearFuture && candidate.kind !== 'future' && candidate.kind !== 'current') {
      nextFuture = []
    }

    switch (candidate.kind) {
      case 'current':
        nextCurrentSource = candidate.source
        nextAutoQueueIndex = candidate.autoQueueIndex
        break
      case 'future':
        nextCurrentSource = candidate.entry.source
        nextAutoQueueIndex = candidate.entry.autoQueueIndex
        nextFuture = state.playbackFuture.slice(1)
        break
      case 'user':
        nextCurrentSource = 'user'
        nextUserQueue = state.userQueue.filter((_, index) => index !== candidate.index)
        break
      case 'auto':
        nextCurrentSource = 'auto'
        nextAutoQueueIndex = candidate.index
        break
    }

    return {
      playbackHistory: nextHistory,
      playbackFuture: nextFuture,
      userQueue: nextUserQueue,
      currentTrackSource: nextCurrentSource,
      autoQueueIndex: nextAutoQueueIndex
    }
  }

  const startPlaybackContextEntries = async (
    entries: QueueTrackEntry[],
    startIndex = 0,
    options?: { sourcePlaylistId?: number | null; contextLabel?: string | null }
  ): Promise<void> => {
    const state = get()
    const normalizedStartIndex = entries.length === 0
      ? -1
      : Math.max(0, Math.min(entries.length - 1, Math.floor(startIndex)))
    const currentEntry = getCurrentPlaybackEntry(state)

    set({
      autoQueue: entries,
      autoQueueIndex: normalizedStartIndex,
      autoQueueSourcePlaylistId: options?.sourcePlaylistId ?? null,
      autoQueueContextLabel: normalizeContextLabel(options?.contextLabel) ?? 'Current Selection',
      shuffledAutoIndices: state.shuffle && normalizedStartIndex >= 0
        ? buildAutoShuffleOrder(entries.length, normalizedStartIndex)
        : [],
      playbackFuture: [],
      playbackHistory: currentEntry ? [...state.playbackHistory, currentEntry].slice(-MAX_PLAYBACK_HISTORY) : state.playbackHistory,
      currentTrackSource: normalizedStartIndex >= 0 ? 'auto' : state.currentTrackSource
    })

    if (normalizedStartIndex < 0) {
      clearBufferedNextTrack()
      return
    }

    const targetTrack = resolveQueueEntryTrack(entries[normalizedStartIndex])
    if (!targetTrack || isUnavailableRemoteTrack(targetTrack)) return

    const loaded = await get()._loadAndPlayTrack(targetTrack, { manualStart: true })
    if (loaded === 'failed' && targetTrack.sourceType && targetTrack.sourceType !== 'local') {
      markTrackUnavailableInState(targetTrack.path)
    }
  }

  const enqueueUserEntries = (entries: QueueTrackEntry[], position: number | 'next' | 'end' = 'end'): void => {
    if (entries.length === 0) return

    const state = get()
    const nextUserQueue = [...state.userQueue]
    const insertionIndex = position === 'next'
      ? 0
      : position === 'end'
        ? nextUserQueue.length
        : clampQueuePosition(position, nextUserQueue.length)

    nextUserQueue.splice(insertionIndex, 0, ...entries)
    set({ userQueue: nextUserQueue })
    clearBufferedNextTrack()
    schedulePreBufferNextTrack()
  }

  return {
    // Initial state
    currentTrack: null,
    currentTrackSource: 'manual',
    playbackState: 'stopped',
    currentTime: 0,
    duration: 0,
    volume: initialPlayerVolume,
    isMuted: false,
    waveformData: null,
    waveformBufferedRatio: 1,
    waveformAnalyzedRatio: 1,
    remoteLoadProgress: null,
    remoteBufferedSeconds: 0,
    remoteStreamSessionId: null,
    ffmpegFallbackNotice: null,
    outputDelayNotice: null,
    associatedOpenNotice: null,

    // Queue state
    userQueue: [],
    autoQueue: [],
    autoQueueIndex: -1,
    autoQueueSourcePlaylistId: null,
    autoQueueContextLabel: null,
    shuffle: false,
    repeat: 'none',
    shuffledAutoIndices: [],
    playbackHistory: [],
    playbackFuture: [],

    // Load a track
    loadTrack: async (track: Track, audioData: ArrayBuffer) => {
      const loadStart = performance.now()
      const loadRequestId = beginLoadRequest()
      pendingManualLoadCueTrack = null
      // Initialize listeners on first load
      if (!listenersInitialized) {
        get()._initListeners()
      }

      set({
        currentTrack: track,
        currentTrackSource: 'manual',
        playbackState: 'loading',
        waveformData: null,
        waveformBufferedRatio: 1,
        waveformAnalyzedRatio: 1,
        remoteLoadProgress: null,
        remoteBufferedSeconds: 0,
        remoteStreamSessionId: null,
        currentTime: 0,
        duration: track.duration
      })

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
            currentTrackSource: 'manual',
            remoteLoadProgress: null,
            remoteBufferedSeconds: 0,
            remoteStreamSessionId: null,
            waveformBufferedRatio: 1,
            waveformAnalyzedRatio: 1,
            currentTime: 0
          })
          hydrateAssociatedCurrentTrackMetadata(resolvedTrack)
          pendingManualLoadCueTrack = resolvedTrack
          schedulePreBufferNextTrack()
          logSlowPath('loadTrack', loadStart, {
            trackPath: track.path,
            usedNativeBitPerfect: true,
            decodeMs
          })
          return true
        }

        const replayGainDb = getReplayGainCandidateDb(track, useAudioSettingsStore.getState().replayGainMode)
        try {
          await audioEngine.loadAudioData(audioData, { replayGainDb, trackPath: track.path })
          throwIfSupersededLoad(loadRequestId)
        } catch (primaryDecodeError) {
          if (isSupersededPlaybackLoad(primaryDecodeError, loadRequestId)) {
            throw primaryDecodeError
          }
          const fallbackData = await window.electronAPI.decodeAudioWithFfmpeg(track.path)
          throwIfSupersededLoad(loadRequestId)
          if (!fallbackData) {
            throw primaryDecodeError
          }

          usedFfmpegFallback = true
          console.warn(`Primary decode failed for ${track.path}; using FFmpeg compatibility decode.`)
          await audioEngine.loadAudioData(fallbackData, { replayGainDb, trackPath: track.path })
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
          currentTrackSource: 'manual',
          remoteLoadProgress: null,
          remoteBufferedSeconds: 0,
          remoteStreamSessionId: null,
          waveformBufferedRatio: 1,
          waveformAnalyzedRatio: 1,
          currentTime: 0
        })
        hydrateAssociatedCurrentTrackMetadata(resolvedTrack)
        if (usedFfmpegFallback) {
          showFfmpegFallbackNotice(resolvedTrack)
        }
        pendingManualLoadCueTrack = resolvedTrack

        // Schedule next-track prebuffering for the gapless handoff window.
        schedulePreBufferNextTrack()
        logSlowPath('loadTrack', loadStart, {
          trackPath: track.path,
          usedFfmpegFallback,
          decodeMs
        })
        return true
      } catch (error) {
        if (isSupersededPlaybackLoad(error, loadRequestId)) {
          return false
        }
        console.error('Failed to load track:', error)
        logSlowPath('loadTrack', loadStart, {
          trackPath: track.path,
          failed: true
        })
        set({
          playbackState: 'stopped',
          remoteLoadProgress: null,
          remoteBufferedSeconds: 0,
          remoteStreamSessionId: null
        })
        pendingManualLoadCueTrack = null
        return false
      }
    },

    // Playback controls
    play: async () => {
      const state = get()
      if (!state.currentTrack) {
        const candidate = findNextPlayableCandidate(state)
        if (!candidate || candidate.kind === 'current') return

        set(applyCandidateTransition(state, candidate, {
          pushCurrentToHistory: false,
          clearFuture: false
        }))

        const loaded = await get()._loadAndPlayTrack(candidate.track, { manualStart: true })
        if (loaded === 'failed' && candidate.track.sourceType && candidate.track.sourceType !== 'local') {
          markTrackUnavailableInState(candidate.track.path)
        }
        return
      }

      const previousPlaybackState = state.playbackState
      if (
        state.currentTrack.sourceType
        && state.currentTrack.sourceType !== 'local'
        && previousPlaybackState === 'stopped'
        && state.remoteStreamSessionId === null
      ) {
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
      await audioEngine.play()
      const currentTrack = get().currentTrack
      if ((previousPlaybackState === 'loading' || previousPlaybackState === 'stopped') && currentTrack) {
        void useLibraryStore.getState().markTrackLatestSyncSeen(currentTrack.path)
        startRecentPlaySession(currentTrack.path)
      }
    },

    pause: () => {
      audioEngine.pause()
    },

    togglePlay: async () => {
      const state = get()
      if (!state.currentTrack || state.playbackState === 'stopped') {
        await get().play()
        return
      }
      await audioEngine.togglePlay()
    },

    stop: () => {
      invalidateLoadRequest()
      pendingManualLoadCueTrack = null
      recentPlaySession = null
      set({
        remoteBufferedSeconds: 0,
        remoteStreamSessionId: null
      })
      audioEngine.stop()
    },

    seek: async (time: number) => {
      const state = get()
      const seekTime = state.currentTrack?.sourceType && state.currentTrack.sourceType !== 'local'
        ? Math.max(0, Math.min(time, state.remoteBufferedSeconds))
        : time
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
      await startPlaybackContextEntries(createQueueEntriesFromTracks(tracks), startIndex, options)
    },

    startPlaybackContextByPaths: async (paths: string[], startIndex = 0, options) => {
      await startPlaybackContextEntries(await createQueueEntriesFromPathsWithFetch(paths), startIndex, options)
    },

    enqueueUserTrack: (track: Track, position = 'end') => {
      get().enqueueUserTracks([track], position)
    },

    enqueueUserTracks: (tracks: Track[], position = 'end') => {
      enqueueUserEntries(createQueueEntriesFromTracks(tracks), position)
    },

    enqueueUserTrackPaths: async (paths: string[], position = 'end') => {
      enqueueUserEntries(await createQueueEntriesFromPathsWithFetch(paths), position)
    },

    moveUserQueue: (fromIndex: number, toIndex: number) => {
      const state = get()
      if (fromIndex === toIndex) return
      if (fromIndex < 0 || fromIndex >= state.userQueue.length) return
      if (toIndex < 0 || toIndex >= state.userQueue.length) return

      const nextUserQueue = [...state.userQueue]
      const [removed] = nextUserQueue.splice(fromIndex, 1)
      nextUserQueue.splice(toIndex, 0, removed)
      set({ userQueue: nextUserQueue })

      clearBufferedNextTrack()
      schedulePreBufferNextTrack()
    },

    removeUserTrack: (index: number) => {
      const state = get()
      if (index < 0 || index >= state.userQueue.length) return

      set({
        userQueue: state.userQueue.filter((_, trackIndex) => trackIndex !== index)
      })

      clearBufferedNextTrack()
      schedulePreBufferNextTrack()
    },

    clearUserQueue: () => {
      set({ userQueue: [] })
      clearBufferedNextTrack()
      schedulePreBufferNextTrack()
    },

    clearAllQueues: () => {
      clearBufferedNextTrack()
      set({
        userQueue: [],
        autoQueue: [],
        autoQueueIndex: -1,
        autoQueueSourcePlaylistId: null,
        autoQueueContextLabel: null,
        shuffledAutoIndices: [],
        playbackHistory: [],
        playbackFuture: [],
        currentTrackSource: get().currentTrack ? 'manual' : 'manual'
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

    playQueuedTrack: async (locator, options) => {
      const state = get()
      const candidate: NextCandidate | null = locator.source === 'user'
        ? (() => {
            const entry = state.userQueue[locator.index]
            const track = resolveQueueEntryTrack(entry)
            return entry && track ? { kind: 'user', entry, track, index: locator.index } : null
          })()
        : (() => {
            const entry = state.autoQueue[locator.index]
            const track = resolveQueueEntryTrack(entry)
            return entry && track ? { kind: 'auto', entry, track, index: locator.index } : null
          })()

      if (!candidate || isUnavailableRemoteTrack(candidate.track)) return

      set(applyCandidateTransition(state, candidate, {
        pushCurrentToHistory: true,
        clearFuture: true
      }))

      const loaded = await get()._loadAndPlayTrack(candidate.track, {
        manualStart: options?.manualStart ?? true
      })
      if (loaded === 'failed' && candidate.track.sourceType && candidate.track.sourceType !== 'local') {
        markTrackUnavailableInState(candidate.track.path)
      }
    },

    playNext: async () => {
      const state = get()
      const candidate = findNextPlayableCandidate(state)
      if (!candidate) return

      set(applyCandidateTransition(state, candidate, {
        pushCurrentToHistory: true,
        clearFuture: true
      }))

      await runSerializedTrackLoad(candidate.track)
    },

    playPrevious: async () => {
      const state = get()
      if (!state.currentTrack) return

      // If more than 3 seconds into track, restart it
      if (state.currentTime > 3) {
        await audioEngine.seek(0)
        return
      }

      const previousEntry = state.playbackHistory[state.playbackHistory.length - 1]
      const previousTrack = resolveQueueEntryTrack(previousEntry?.entry)
      if (!previousEntry || !previousTrack || isUnavailableRemoteTrack(previousTrack)) return

      const currentEntry = getCurrentPlaybackEntry(state)
      set({
        playbackHistory: state.playbackHistory.slice(0, -1),
        playbackFuture: currentEntry ? [currentEntry, ...state.playbackFuture] : state.playbackFuture,
        currentTrackSource: previousEntry.source,
        autoQueueIndex: previousEntry.autoQueueIndex
      })

      await runSerializedTrackLoad(previousTrack, { manualStart: true })
    },

    toggleShuffle: () => {
      const state = get()
      const newShuffle = !state.shuffle
      set({
        shuffle: newShuffle,
        shuffledAutoIndices: newShuffle && state.autoQueue.length > 0
          ? buildAutoShuffleOrder(state.autoQueue.length, state.autoQueueIndex >= 0 ? state.autoQueueIndex : 0)
          : []
      })
      clearBufferedNextTrack()
      schedulePreBufferNextTrack()
    },

    toggleRepeat: () => {
      set((state) => {
        const modes: Array<'none' | 'one' | 'all'> = ['none', 'all', 'one']
        const currentIndex = modes.indexOf(state.repeat)
        return { repeat: modes[(currentIndex + 1) % modes.length] }
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

    getResolvedUserQueueEntries: () => {
      const entries: ResolvedQueueTrack[] = []
      get().userQueue.forEach((entry, index) => {
        const track = resolveQueueEntryTrack(entry)
        if (!track) return
        entries.push({
          source: 'user',
          track,
          index
        })
      })
      return entries
    },

    getResolvedAutoUpcomingTracks: () => {
      const state = get()
      return getAutoUpcomingIndices(state)
        .map((index) => resolveQueueEntryTrack(state.autoQueue[index]))
        .filter((track): track is Track => Boolean(track))
    },

    getResolvedAutoUpcomingEntries: () => {
      const state = get()
      const entries: ResolvedQueueTrack[] = []
      getAutoUpcomingIndices(state).forEach((index) => {
        const track = resolveQueueEntryTrack(state.autoQueue[index])
        if (!track) return
        entries.push({
          source: 'auto',
          track,
          index
        })
      })
      return entries
    },

    getResolvedPreviousTracks: () => {
      return get().getResolvedPreviousEntries().map((entry) => entry.track)
    },

    getResolvedPreviousEntries: () => {
      const entries: ResolvedQueueTrack[] = []
      get().playbackHistory.forEach((entry, index) => {
        const track = resolveQueueEntryTrack(entry.entry)
        if (!track) return
        entries.push({
          source: 'previous',
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

    setQueue: (tracks, startIndex = 0, options) => {
      const state = get()
      const entries = createQueueEntriesFromTracks(tracks)
      const normalizedStartIndex = entries.length === 0
        ? -1
        : Math.max(0, Math.min(entries.length - 1, Math.floor(startIndex)))

      set({
        autoQueue: entries,
        autoQueueIndex: normalizedStartIndex,
        autoQueueSourcePlaylistId: options?.sourcePlaylistId ?? null,
        autoQueueContextLabel: normalizeContextLabel(options?.contextLabel) ?? 'Current Selection',
        shuffledAutoIndices: state.shuffle && normalizedStartIndex >= 0
          ? buildAutoShuffleOrder(entries.length, normalizedStartIndex)
          : []
      })
    },

    addToQueue: (track) => {
      get().enqueueUserTrack(track, 'end')
    },

    addToQueueNext: (track) => {
      get().enqueueUserTrack(track, 'next')
    },

    removeFromQueue: (index) => {
      get().removeUserTrack(index)
    },

    moveInQueue: (fromIndex, toIndex) => {
      get().moveUserQueue(fromIndex, toIndex)
    },

    clearQueue: () => {
      get().clearAllQueues()
    },

    playTrackAt: async (index) => {
      await get().playQueuedTrack({ source: 'auto', index }, { manualStart: true })
    },

    getUpcomingTracks: () => {
      return get().getResolvedUpcomingTracks()
    },

    getPreviousTracks: () => {
      return get().getResolvedPreviousTracks()
    },

    _getNextEntry: () => {
      const candidate = findNextPlayableCandidate(get())
      if (!candidate || candidate.kind === 'current') return null
      if (candidate.kind === 'future') {
        return {
          source: 'future',
          track: candidate.track,
          index: 0
        }
      }

      return {
        source: candidate.kind,
        track: candidate.track,
        index: candidate.index
      }
    },

    _generateShuffleOrder: (currentAutoQueueIndex: number) => {
      const { autoQueue } = get()
      if (autoQueue.length === 0) {
        set({ shuffledAutoIndices: [] })
        return
      }
      set({
        shuffledAutoIndices: buildAutoShuffleOrder(autoQueue.length, currentAutoQueueIndex)
      })
    },

    // Internal: Load and play a track from queue
    _loadAndPlayTrack: async (track: Track, options = {}) => {
      const loadStart = performance.now()
      const loadRequestId = beginLoadRequest()
      const manualStart = Boolean(options.manualStart)
      pendingManualLoadCueTrack = null
      // Initialize listeners if needed
      if (!listenersInitialized) {
        get()._initListeners()
      }

      set({
        currentTrack: track,
        playbackState: 'loading',
        waveformData: null,
        waveformBufferedRatio: track.sourceType && track.sourceType !== 'local' ? 0 : 1,
        waveformAnalyzedRatio: track.sourceType && track.sourceType !== 'local' ? 0 : 1,
        remoteLoadProgress: track.sourceType && track.sourceType !== 'local'
          ? createInitialRemoteLoadProgress(track)
          : null,
        remoteBufferedSeconds: 0,
        remoteStreamSessionId: null,
        currentTime: 0,
        duration: track.duration
      })

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

        const fileLoadStart = performance.now()
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
            remoteBufferedSeconds: 0,
            remoteStreamSessionId: null
          })
          return 'failed'
        }

        let usedFfmpegFallback = false
        const decodeStart = performance.now()
        try {
          await audioEngine.loadAudioData(result.data, { replayGainDb, trackPath: track.path })
          throwIfSupersededLoad(loadRequestId)
        } catch (primaryDecodeError) {
          if (isSupersededPlaybackLoad(primaryDecodeError, loadRequestId)) {
            throw primaryDecodeError
          }
          const fallbackData = await window.electronAPI.decodeAudioWithFfmpeg(track.path)
          throwIfSupersededLoad(loadRequestId)
          if (!fallbackData) {
            throw primaryDecodeError
          }

          usedFfmpegFallback = true
          console.warn(`Primary decode failed for ${track.path}; using FFmpeg compatibility decode.`)
          await audioEngine.loadAudioData(fallbackData, { replayGainDb, trackPath: track.path })
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
          remoteBufferedSeconds: 0,
          remoteStreamSessionId: null,
          waveformBufferedRatio: 1,
          waveformAnalyzedRatio: 1,
          currentTime: 0
        })
        hydrateAssociatedCurrentTrackMetadata(resolvedTrack)
        if (usedFfmpegFallback) {
          showFfmpegFallbackNotice(resolvedTrack)
        }
        if (manualStart) {
          showOutputDelayNotice(resolvedTrack)
        }
        throwIfSupersededLoad(loadRequestId)
        await audioEngine.play()
        throwIfSupersededLoad(loadRequestId)
        void useLibraryStore.getState().markTrackLatestSyncSeen(resolvedTrack.path)
        startRecentPlaySession(resolvedTrack.path)
        logMemoryDiagnosticsEvent('track_load_success', {
          trackPath: track.path,
          sourceType: resolvedTrack.sourceType ?? 'local',
          loadPath: usedFfmpegFallback ? 'file_ffmpeg_fallback' : 'file_decode',
          fileLoadMs,
          decodeMs,
          usedFfmpegFallback
        })

        // Schedule next-track prebuffering for the gapless handoff window.
        schedulePreBufferNextTrack()
        logSlowPath('queueLoadAndPlayTrack', loadStart, {
          trackPath: track.path,
          fileLoadMs,
          decodeMs,
          usedFfmpegFallback
        })
        return 'loaded'
      } catch (error) {
        if (isSupersededPlaybackLoad(error, loadRequestId)) {
          return 'superseded'
        }
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
          remoteBufferedSeconds: 0,
          remoteStreamSessionId: null
        })
        return 'failed'
      }
    },

    // Pre-buffer the next track for gapless playback
    _preBufferNextTrack: async () => {
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

            const result = await window.electronAPI.loadAudioFile(nextTrack.path, { metadataMode: 'none' })
            if (!canApplyPrebufferResult(nextTrack)) {
              return
            }
            if (result) {
              await audioEngine.preBufferNext(result.data, {
                replayGainDb: getReplayGainCandidateDb(nextTrack, useAudioSettingsStore.getState().replayGainMode),
                trackPath: nextTrack.path
              })
              if (!canApplyPrebufferResult(nextTrack)) {
                audioEngine.clearNextBuffer()
                return
              }
              logSlowPath('preBufferNextTrack', bufferStart, {
                trackPath: nextTrack.path,
                loaded: true
              })
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

      remoteLoadProgressUnsubscribe?.()
      remoteLoadProgressUnsubscribe = window.electronAPI.onRemoteLoadProgress((progress) => {
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
        if (nextPlaybackState === 'playing') {
          lastCommittedCurrentTimeMs = performance.now()
          set({
            playbackState: nextPlaybackState,
            currentTime: audioEngine.currentTime
          })
          schedulePreBufferNextTrack()
          return
        }

        clearScheduledPrebufferTimer()
        lastCommittedCurrentTimeMs = performance.now()
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
        maybeCommitRecentPlay(normalizedTime)

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
        if (!track || !track.sourceType || track.sourceType === 'local') {
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

        const peaks = extractWaveformPeaks(buffer as AudioBuffer)
        if (shouldUseWaveformCache(track)) {
          setWaveformCacheEntry(track.path, peaks)
        }
        set({
          waveformData: peaks,
          waveformBufferedRatio: 1,
          waveformAnalyzedRatio: 1
        })
      })

      // Handle gapless transition - advance queue without reloading
      audioEngine.on('gaplessTransition', () => {
        commitRecentPlayNow()
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
          pushCurrentToHistory: true,
          clearFuture: true
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

        // Schedule the NEXT next track for the new handoff window.
        schedulePreBufferNextTrack()
      })

      // Handle non-gapless track end (when no next track buffered)
      audioEngine.on('ended', () => {
        commitRecentPlayNow()
        recentPlaySession = null
        set({
          currentTime: 0,
          remoteBufferedSeconds: 0,
          remoteStreamSessionId: null
        })
        // Auto-play next track (non-gapless fallback)
        get().playNext()
      })

      audioEngine.on('error', (error) => {
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
      clearScheduledPrebufferTimer()
      // Audio engine handles its own cleanup
      if (remoteLoadProgressUnsubscribe) {
        remoteLoadProgressUnsubscribe()
        remoteLoadProgressUnsubscribe = null
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
