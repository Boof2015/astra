import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { getHeapSpaceStatistics } from 'v8'
import type {
  MiniPlayerCommand,
  MiniPlayerQueueSnapshot,
  MiniPlayerSnapshot,
  MiniPlayerVisualizerMode,
  MiniPlayerVisualizerStreamChunk,
  MiniPlayerWindowState
} from '../types/miniPlayer'
import type {
  LyricsPopoutCommand,
  LyricsPopoutSnapshot,
  LyricsPopoutWindowState
} from '../types/lyricsPopout'
import type {
  ScopeKind,
  ScopePopoutChunk,
  ScopePopoutState
} from '../types/scopePopout'
import type {
  LocalApiStatus
} from '../types/localApi'
import type {
  CompanionApiRendererCommand,
  CompanionApiScope
} from '../types/companionApi'
import type {
  PhoneRemoteClientKind,
  PhoneRemotePairedDevice,
  PhoneRemotePairingTicket,
  PhoneRemotePendingPairingRequest,
  PhoneRemoteStatus
} from '../types/phoneRemote'
import type { PhoneSyncConflictResolution } from '../types/phoneSync'
import type {
  ParallaxAudioChunk,
  ParallaxDiscoveryEvent,
  ParallaxOutputLatencyMetrics,
  ParallaxPairedSink,
  ParallaxHostStreamStartInfo,
  ParallaxHostStreamStartOptions,
  ParallaxHostNextStreamStartOptions,
  ParallaxHostTimelinePublishOptions,
  ParallaxSinkTelemetry,
  ParallaxStatus,
  ParallaxTimelineEvent,
  ParallaxTimelineState
} from '../types/parallax'
import type {
  DynamicPlaylistRulesV1,
  PlaylistKind
} from '../shared/playlists/dynamicPlaylist'
import type { TrackRatingEntry } from '../shared/ratings/trackRating'
import type { AppMemoryFootprintSource } from '../shared/processMemoryFootprint'
import type {
  LastFmAuthFinishResult,
  LastFmAuthStartResult,
  LastFmCustomProfileInput,
  LastFmStatus
} from '../types/lastFm'
import type {
  LyricsFormat,
  LyricsManualClearResult,
  LyricsManualImportResult,
  LyricsLookupResult,
  LyricsOffsetSetResult,
  LyricsStatus,
  LyricsTrackOverride,
  LyricsTrackQuery
} from '../types/lyrics'
import type {
  JellyfinSource,
  JellyfinSourceCreateInput,
  JellyfinSourceTestInput,
  JellyfinSourceTestResult,
  JellyfinSourceUpdateInput,
  JellyfinStatusSnapshot,
  SubsonicSource,
  SubsonicSourceCreateInput,
  SubsonicSourceTestInput,
  SubsonicSourceTestResult,
  SubsonicSourceUpdateInput,
  SubsonicStatusSnapshot,
  TrackSourceType
} from '../types/subsonic'
import type {
  AudioBufferMemoryStats,
  NativeAudioCapabilities,
  NativeAudioEvent,
  NativeAudioPlaybackSnapshot,
  NativeAudioTrackLoadResult,
  NativeAudioTrackMetadata,
  NativeAudioVisualizerTapDemand,
  NativeAudioVUMeterChunk,
  NativeAudioVectorscopeChunk
} from '../types/nativeAudio'
import type {
  ProgressiveAudioLoadProgress,
  ProgressiveStreamChunk,
  ProgressiveStreamEvent,
  ProgressiveStreamInfo,
  RemoteAudioLoadProgress,
  RemoteStreamChunk,
  RemoteStreamEvent,
  RemoteStreamInfo
} from '../types/remoteStream'
import type {
  MemoryDiagnosticsBlinkResourceUsageSnapshot,
  MemoryDiagnosticsCaptureBundleResult,
  MemoryDiagnosticsEventPayload,
  MemoryDiagnosticsProcessMemoryStats,
  MemoryDiagnosticsRendererSnapshot,
  MemoryDiagnosticsRendererMemoryStats,
  MemoryDiagnosticsSnapshotRequest,
  MemoryDiagnosticsStatus
} from '../types/diagnostics'
import type { AppBuildInfo } from '../types/appBuildInfo'
import type {
  ImportedListeningSource,
  ImportedListeningSourceRemoval,
  ListeningHistoryStatus,
  ListeningSessionCheckpoint,
  ListeningSessionCheckpointResult,
  ListeningStatsApplyRequest,
  ListeningStatsDashboard,
  ListeningStatsExportBundle,
  ListeningStatsExportRequest,
  ListeningImportPreview,
  ListeningStatsQuery,
  ListeningStatsTransferAvailability
} from '../types/listeningStats'
import type { ListeningStatsImportResult } from '../shared/stats/statsTransfer'
import type {
  GlobalShortcutRegistrationRequest,
  GlobalShortcutRegistrationResult,
  InputActionId,
  RawBindingInput
} from '../types/inputBindings'
import type {
  IntegrityDuplicateTrashRequest,
  IntegrityDuplicateTrashResult,
  IntegrityFinding,
  IntegrityScanMode,
  IntegrityScanProgress,
  IntegrityScanResult,
  IntegrityScanScope
} from '../types/libraryIntegrity'
import { createNativeAudioController, type NativeAudioAddonModule } from './nativeAudioController'

type RuntimeIconImageSetPayload = {
  images: Array<{
    size: number
    dataUrl: string
  }>
}

export interface AudioFileMetadata {
  title?: string
  artist?: string
  artistNames?: string[]
  album?: string
  albumArtist?: string
  albumArtistNames?: string[]
  year?: number
  trackNumber?: number
  duration?: number
  format?: string
  sampleRate?: number
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

// Audio file result from main process
export interface AudioFileResult {
  path: string
  name: string
  data?: ArrayBuffer
  metadata?: AudioFileMetadata
}

export interface AudioLoadOptions {
  metadataMode?: 'full' | 'none'
}

export interface TrackLoudnessResult {
  loudnessLufs: number
  peakLinear: number | null
  method: string
}

export interface TrackLoudnessStorePayload {
  loudnessLufs: number
  peakLinear?: number | null
  method?: string
}

export interface AudioFileStatResult {
  size: number
  mtimeMs: number
}

export interface ProgressiveStreamStartOptions {
  startTimeSeconds?: number | null
}

// Library types
export interface DbTrack {
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
  year: number | null
  genre: string | null
  genres: string[]
  artwork_hash: string | null
  base_artwork_hash: string | null
  format: string
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  codec: string | null
  codec_profile: string | null
  is_atmos_joc: number | null
  is_iamf: number | null
  replaygain_track_gain_db: number | null
  replaygain_album_gain_db: number | null
  bpm: number | null
  musical_key: string | null
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
  modified_at: number
}

export interface LibraryTrackPageRequest {
  offset?: number
  limit?: number
}

export interface LibraryTrackPage {
  tracks: DbTrack[]
  offset: number
  limit: number
  total: number
  nextOffset: number
  hasMore: boolean
}

export interface LibraryFolder {
  id: number
  path: string
  added_at: number
  hidden: number
}

export interface FolderSubfolderSummary {
  totalSubfolders: number
  excludedSubfolders: number
}

export interface FolderSubdirectoryEntry {
  name: string
  relativePath: string
  excluded: boolean
  hasChildren: boolean
  missing: boolean
  audioFileCount: number
}

export interface Album {
  identity_key: string
  album: string
  artist: string
  primary_artist: string | null
  year: number | null
  artwork_hash: string | null
  track_count: number
  is_new: boolean
}

export interface AlbumListOptions {
  includeSingles?: boolean
}

export interface Artist {
  artist: string
  track_count: number
  primary_track_count: number
  album_count: number
  artwork_hash: string | null
  artwork_source: 'manual' | 'detected' | 'track' | null
}

export interface Genre {
  genre: string
  track_count: number
  album_count: number
  artwork_hash: string | null
}

export type LibraryArtistBrowseMode = 'strict' | 'canonical'

export interface ScanProgress {
  current: number
  total: number
  file: string
}

export type ScanStage = 'scanning' | 'backfill' | 'cleanup'

export interface ScanStageProgress {
  stage: ScanStage
  message: string
}

export type ScanIssuePhase = 'discovery' | 'scan' | 'backfill' | 'cleanup'

export interface ScanIssueEntry {
  phase: ScanIssuePhase
  path: string
  message: string
  code?: string
  folderPath?: string
}

export interface ScanIssueLog {
  total: number
  shown: number
  truncated: boolean
  entries: ScanIssueEntry[]
}

export interface Playlist {
  id: number
  name: string
  kind: PlaylistKind
  created_at: number
  updated_at: number
  last_played_at: number | null
  custom_cover_hash: string | null
  auto_cover_hash: string | null
  track_count: number
  missing_track_count: number
}

export interface PlaylistTrackEntry {
  id: number
  track_path: string
  position: number
  added_at: number
  missing: boolean
  title: string | null
  artist: string | null
  album: string | null
  track: DbTrack | null
}

export type PlaylistImportDetectedFormat = 'csv' | 'm3u' | 'm3u8' | 'xspf' | 'wpl' | 'asx'

export interface PlaylistImportResult {
  sourceFilePath: string
  detectedFormat: PlaylistImportDetectedFormat
  playlistId: number | null
  playlistName: string | null
  entriesTotal: number
  importedCount: number
  missingEntryCount: number
  matchedByPathCount: number
  matchedByMetadataCount: number
  unmatchedCount: number
  ambiguousMetadataCount: number
  unsupportedEntryCount: number
  warnings: string[]
}

export interface PlaylistExportResult {
  filePath: string
  format: 'm3u' | 'm3u8'
  playlistId: number
  exportedCount: number
  warnings: string[]
}

export interface DynamicPlaylistPreview {
  track_count: number
  tracks: DbTrack[]
}

export type MetadataSaveMode = 'virtual' | 'file'

export interface MetadataEditChanges {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string | null
  genre?: string | null
  year?: number | null
  trackNumber?: number | null
  discNumber?: number | null
  artworkPath?: string | null
}

export interface MetadataEditRequest {
  mode: MetadataSaveMode
  trackPaths: string[]
  changes: MetadataEditChanges
}

export interface MetadataEditFailure {
  trackPath: string
  message: string
}

export interface MetadataEditResult {
  mode: MetadataSaveMode
  requested: number
  succeeded: number
  failed: number
  updatedTrackPaths: string[]
  failures: MetadataEditFailure[]
}

export interface TrackOverrideSnapshot {
  title: string | null
  artist: string | null
  album: string | null
  album_artist: string | null
  genre: string | null
  year: number | null
  track_number: number | null
  disc_number: number | null
  artwork_hash: string | null
  artwork_cleared: number | null
}

export interface AppPerformanceStats {
  cpuPercent: number
  workingSetMb: number
  footprintMb: number | null
  appProcessFootprintMb: number | null
  childProcessFootprintMb: number | null
  footprintSource: AppMemoryFootprintSource
  footprintComplete: boolean
  footprintFailedPids: number[]
  footprintProcessCount: number
  footprintAppProcessCount: number
  footprintChildProcessCount: number
  privateMemoryExcludingCallerMb: number | null
  mainProcessMemoryMb: number | null
  helperProcessesMemoryMb: number | null
}

export type MainProcessMemoryStats = MemoryDiagnosticsProcessMemoryStats
export type RendererMemoryStats = MemoryDiagnosticsRendererMemoryStats

export interface DiscordTrackPresence {
  title: string
  artist?: string
  album?: string
  albumArtist?: string
  coverArtUrl?: string
  durationSeconds?: number
  format?: string
  sampleRate?: number
  bitDepth?: number
  bitrate?: number
  channels?: number
  codec?: string
  codecProfile?: string
  isAtmosJoc?: boolean
}

export interface DiscordPresenceUpdate {
  playbackState: 'stopped' | 'playing' | 'paused' | 'loading'
  currentTimeSeconds?: number
  durationSeconds?: number
  track?: DiscordTrackPresence | null
}

export type DiscordRpcCompactStatusMode = 'title' | 'artist'
export type DiscordRpcExpandedInfoMode = 'file-info' | 'album'
export type DiscordRpcLinkDestination = 'off' | 'ytmusic' | 'lastfm'

export interface DiscordRpcConfigureOptions {
  enabled: boolean
  coverArtEnabled: boolean
  smallIconEnabled?: boolean
  compactStatusMode?: DiscordRpcCompactStatusMode
  expandedInfoMode?: DiscordRpcExpandedInfoMode
  linkDestination?: DiscordRpcLinkDestination
  pauseClearMinutes?: number
}

export interface DiscordRpcConfigureResult {
  ok: boolean
  connected: boolean
  message: string
}

export interface DiscordCoverArtLookupQuery {
  album: string
  artist?: string
  albumArtist?: string
  title?: string
}

export type DiscordCoverArtLookupResult =
  | { status: 'hit'; url: string }
  | { status: 'not_found' }
  | { status: 'transient_error'; code?: string }

export type UpdateCheckStatus = 'up-to-date' | 'update-available' | 'error'

export interface UpdateCheckResult {
  status: UpdateCheckStatus
  updateAvailable: boolean
  currentVersion: string
  latestTag: string | null
  latestVersion: string | null
  releaseName: string | null
  releaseUrl: string
  checkedAt: number
  message: string
}

// Native Visualizer Types
export interface OscilloscopeResult {
  triggerIndex: number // float (position in circular buffer)
  samplesToShow: number
  detectedPitch: number
  writePos: number // current write position in circular buffer
}

export interface VectorscopeResult {
  x: Float32Array
  y: Float32Array
}

export interface VisualizerDSP {
  oscilloscope: {
    setSampleRate(sampleRate: number): void
    setPitchLock(enabled: boolean): void
    setDisplaySamples(samples: number): void
    pushSamples(samples: Float32Array): void // Push to circular buffer
    processContinuous(): OscilloscopeResult // Process using circular buffer
    process(audioData: Float32Array): OscilloscopeResult // Legacy snapshot
    getWritePos(): number // Get current write position
    getSamples(startPos: number, count: number): Float32Array // Get samples for rendering
    reset(): void
  }
  spectrum: {
    setFFTSize(size: number): void
    getFFTSize(): number
    setSampleRate(sampleRate: number): void
    setSmoothing(smoothing: number): void
    process(audioData: Float32Array): Float32Array
    binToFrequency(bin: number): number
    configureBars(options: {
      barCount: number
      minFrequency: number
      maxFrequency: number
      minDecibels: number
      maxDecibels: number
      tiltDbPerOctave: number
      heatmapTiltDbPerOctave: number
      tiltReferenceHz: number
      heatmapSmoothing: number
      showPeaks: boolean
    }): void
    getBarFrame(): Float32Array
    reset(): void
  }
  vectorscope: {
    setSampleRate(sampleRate: number): void
    pushSamples(leftChannel: Float32Array, rightChannel: Float32Array): void
    getPoints(maxPoints: number): { x: Float32Array; y: Float32Array; count: number }
    setBufferSize(size: number): void
    getBufferSize(): number
    process(leftChannel: Float32Array, rightChannel: Float32Array): VectorscopeResult
    reset(): void
  }
}

type NativeAddonModule = VisualizerDSP & NativeAudioAddonModule

// Load Native Module
let visualizerDSP: NativeAddonModule | null = null
let nativeAddonLoadError: string | null = null
try {
  // Determine path based on environment
  const isDev = process.env.NODE_ENV === 'development'
  let modulePath: string

  if (isDev) {
    // In dev: .../astra/native/build/Release/visualizer_dsp.node
    // __dirname is .../out/preload
    modulePath = join(__dirname, '../../native/build/Release/visualizer_dsp.node')
  } else {
    // In prod: .../resources/native/visualizer_dsp.node
    modulePath = join(process.resourcesPath, 'native/visualizer_dsp.node')
  }

  // Try to load
  visualizerDSP = require(modulePath)
  if (!visualizerDSP?.playback) {
    nativeAddonLoadError = 'Native addon loaded, but playback exports are missing. Rebuild the native addon for this platform.'
  }
  console.log('Native visualizer DSP module loaded successfully', modulePath)
} catch (error) {
  nativeAddonLoadError = error instanceof Error
    ? `Failed to load native addon: ${error.message}`
    : 'Failed to load native addon.'
  console.warn('Failed to load native visualizer DSP module:', error)
}

const nativeAudioController = createNativeAudioController(visualizerDSP, {
  unavailableReason: nativeAddonLoadError
})

function getBlinkResourceUsage(): MemoryDiagnosticsBlinkResourceUsageSnapshot {
  const usage = webFrame.getResourceUsage()
  return {
    images: { ...usage.images },
    scripts: { ...usage.scripts },
    cssStyleSheets: { ...usage.cssStyleSheets },
    xslStyleSheets: { ...usage.xslStyleSheets },
    fonts: { ...usage.fonts },
    other: { ...usage.other }
  }
}

const LIBRARY_TRACK_PAGE_LIMIT = 500

async function getAllLibraryTracksPaged(): Promise<DbTrack[]> {
  const tracks: DbTrack[] = []
  let offset = 0

  while (true) {
    const page = await ipcRenderer.invoke('library:getTracksPage', {
      offset,
      limit: LIBRARY_TRACK_PAGE_LIMIT
    }) as LibraryTrackPage

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

// Expose APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  associatedOpenFiles: {
    markReady: () => ipcRenderer.send('associated-open-files:rendererReady'),
    onOpenFiles: (callback: (paths: string[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, paths: string[]) => callback(paths)
      ipcRenderer.on('associated-open-files', handler)
      return () => ipcRenderer.removeListener('associated-open-files', handler)
    }
  },

  miniPlayer: {
    open: () => ipcRenderer.invoke('mini-player:open'),
    close: () => ipcRenderer.invoke('mini-player:close'),
    getWindowState: () => ipcRenderer.invoke('mini-player:getWindowState'),
    isCursorInsideWindow: () => ipcRenderer.invoke('mini-player:isCursorInsideWindow'),
    setVisualizerMode: (mode: MiniPlayerVisualizerMode) => ipcRenderer.invoke('mini-player:setVisualizerMode', mode),
    toggleAlwaysOnTop: () => ipcRenderer.invoke('mini-player:toggleAlwaysOnTop'),
    getSnapshot: () => ipcRenderer.invoke('mini-player:getSnapshot'),
    publishSnapshot: (snapshot: MiniPlayerSnapshot) => ipcRenderer.send('mini-player:publishSnapshot', snapshot),
    publishQueueSnapshot: (snapshot: MiniPlayerQueueSnapshot) => ipcRenderer.send('mini-player:publishQueueSnapshot', snapshot),
    publishVisualizerChunk: (chunk: MiniPlayerVisualizerStreamChunk) => ipcRenderer.send('mini-player:publishVisualizerChunk', chunk),
    sendCommand: (command: MiniPlayerCommand) => ipcRenderer.send('mini-player:sendCommand', command),
    onSnapshot: (callback: (snapshot: MiniPlayerSnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: MiniPlayerSnapshot) => callback(snapshot)
      ipcRenderer.on('mini-player:snapshot', handler)
      return () => ipcRenderer.removeListener('mini-player:snapshot', handler)
    },
    onCommand: (callback: (command: MiniPlayerCommand) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, command: MiniPlayerCommand) => callback(command)
      ipcRenderer.on('mini-player:command', handler)
      return () => ipcRenderer.removeListener('mini-player:command', handler)
    },
    onWindowState: (callback: (state: MiniPlayerWindowState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: MiniPlayerWindowState) => callback(state)
      ipcRenderer.on('mini-player:windowState', handler)
      return () => ipcRenderer.removeListener('mini-player:windowState', handler)
    },
    onVisualizerChunk: (callback: (chunk: MiniPlayerVisualizerStreamChunk) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, chunk: MiniPlayerVisualizerStreamChunk) => callback(chunk)
      ipcRenderer.on('mini-player:visualizerChunk', handler)
      return () => ipcRenderer.removeListener('mini-player:visualizerChunk', handler)
    }
  },

  companionApi: {
    onCommand: (callback: (command: CompanionApiRendererCommand) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, command: CompanionApiRendererCommand) => callback(command)
      ipcRenderer.on('companion-api:command', handler)
      return () => ipcRenderer.removeListener('companion-api:command', handler)
    }
  },

  lyricsPopout: {
    open: () => ipcRenderer.invoke('lyrics-popout:open'),
    close: () => ipcRenderer.invoke('lyrics-popout:close'),
    getWindowState: () => ipcRenderer.invoke('lyrics-popout:getWindowState'),
    getSnapshot: () => ipcRenderer.invoke('lyrics-popout:getSnapshot'),
    publishSnapshot: (snapshot: LyricsPopoutSnapshot) => ipcRenderer.send('lyrics-popout:publishSnapshot', snapshot),
    sendCommand: (command: LyricsPopoutCommand) => ipcRenderer.send('lyrics-popout:sendCommand', command),
    onSnapshot: (callback: (snapshot: LyricsPopoutSnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: LyricsPopoutSnapshot) => callback(snapshot)
      ipcRenderer.on('lyrics-popout:snapshot', handler)
      return () => ipcRenderer.removeListener('lyrics-popout:snapshot', handler)
    },
    onCommand: (callback: (command: LyricsPopoutCommand) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, command: LyricsPopoutCommand) => callback(command)
      ipcRenderer.on('lyrics-popout:command', handler)
      return () => ipcRenderer.removeListener('lyrics-popout:command', handler)
    },
    onWindowState: (callback: (state: LyricsPopoutWindowState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: LyricsPopoutWindowState) => callback(state)
      ipcRenderer.on('lyrics-popout:windowState', handler)
      return () => ipcRenderer.removeListener('lyrics-popout:windowState', handler)
    }
  },

  scopePopout: {
    open: (scope: ScopeKind) => ipcRenderer.invoke('scope-popout:open', scope),
    recall: (scope: ScopeKind) => ipcRenderer.invoke('scope-popout:recall', scope),
    getState: () => ipcRenderer.invoke('scope-popout:getState'),
    publishChunk: (chunk: ScopePopoutChunk) => ipcRenderer.send('scope-popout:publishChunk', chunk),
    onState: (callback: (state: ScopePopoutState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: ScopePopoutState) => callback(state)
      ipcRenderer.on('scope-popout:state', handler)
      return () => ipcRenderer.removeListener('scope-popout:state', handler)
    },
    onChunk: (callback: (chunk: ScopePopoutChunk) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, chunk: ScopePopoutChunk) => callback(chunk)
      ipcRenderer.on('scope-popout:chunk', handler)
      return () => ipcRenderer.removeListener('scope-popout:chunk', handler)
    }
  },

  // Platform info
  platform: process.platform,
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  getAppBuildInfo: (): Promise<AppBuildInfo> => ipcRenderer.invoke('app:getBuildInfo'),
  getAppPerformanceStats: () => ipcRenderer.invoke('app:getPerformanceStats'),
  getMainProcessMemoryStats: (): Promise<MainProcessMemoryStats> => ipcRenderer.invoke('app:getMainProcessMemoryStats'),
  getRendererMemoryStats: async (): Promise<RendererMemoryStats> => {
    const memoryInfo = await process.getProcessMemoryInfo()
    const memoryUsage = process.memoryUsage()
    const heapSpaces = getHeapSpaceStatistics()
    const getSpaceUsedBytes = (spaceName: string): number | null => {
      const match = heapSpaces.find((space) => space.space_name === spaceName)
      return match && Number.isFinite(match.space_used_size)
        ? match.space_used_size
        : null
    }
    return {
      privateMb: memoryInfo.private / 1024,
      rssBytes: memoryUsage.rss,
      heapUsedBytes: memoryUsage.heapUsed,
      heapTotalBytes: memoryUsage.heapTotal,
      externalBytes: memoryUsage.external,
      arrayBuffersBytes: memoryUsage.arrayBuffers,
      heapSpaces: {
        oldSpaceUsedBytes: getSpaceUsedBytes('old_space'),
        newSpaceUsedBytes: getSpaceUsedBytes('new_space'),
        codeSpaceUsedBytes: getSpaceUsedBytes('code_space'),
        mapSpaceUsedBytes: getSpaceUsedBytes('map_space'),
        largeObjectSpaceUsedBytes: getSpaceUsedBytes('large_object_space')
      }
    }
  },
  diagnostics: {
    getStatus: (): Promise<MemoryDiagnosticsStatus> => ipcRenderer.invoke('diagnostics:getStatus'),
    setEnabled: (enabled: boolean): Promise<MemoryDiagnosticsStatus> => ipcRenderer.invoke('diagnostics:setEnabled', enabled),
    revealCurrentLog: (): Promise<boolean> => ipcRenderer.invoke('diagnostics:revealCurrentLog'),
    revealPreviousLog: (): Promise<boolean> => ipcRenderer.invoke('diagnostics:revealPreviousLog'),
    captureMemoryBundle: (tag?: string): Promise<MemoryDiagnosticsCaptureBundleResult> =>
      ipcRenderer.invoke('diagnostics:captureMemoryBundle', tag),
    getBlinkResourceUsage: (): MemoryDiagnosticsBlinkResourceUsageSnapshot => getBlinkResourceUsage(),
    clearRendererCache: (): void => webFrame.clearCache(),
    publishRendererSnapshot: (requestId: string, snapshot: MemoryDiagnosticsRendererSnapshot) =>
      ipcRenderer.send('diagnostics:publishRendererSnapshot', requestId, snapshot),
    logEvent: (payload: MemoryDiagnosticsEventPayload): Promise<boolean> =>
      ipcRenderer.invoke('diagnostics:logEvent', payload),
    onStatus: (callback: (status: MemoryDiagnosticsStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: MemoryDiagnosticsStatus) => callback(status)
      ipcRenderer.on('diagnostics:status', handler)
      return () => ipcRenderer.removeListener('diagnostics:status', handler)
    },
    onSnapshotRequest: (callback: (request: MemoryDiagnosticsSnapshotRequest) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, request: MemoryDiagnosticsSnapshotRequest) => callback(request)
      ipcRenderer.on('diagnostics:requestRendererSnapshot', handler)
      return () => ipcRenderer.removeListener('diagnostics:requestRendererSnapshot', handler)
    }
  },

  updates: {
    checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('updates:check'),
    openReleasesPage: (releaseUrl?: string) => ipcRenderer.invoke('updates:openReleasesPage', releaseUrl)
  },

  theme: {
    setRuntimeIconDataUrl: (payload: string | RuntimeIconImageSetPayload) =>
      ipcRenderer.send('theme:setRuntimeIconDataUrl', payload),
  },

  inputBindings: {
    configureGlobal: (requests: GlobalShortcutRegistrationRequest[]): Promise<GlobalShortcutRegistrationResult[]> =>
      ipcRenderer.invoke('input-bindings:configure-global', requests),
    onInput: (callback: (input: RawBindingInput) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, input: RawBindingInput) => callback(input)
      ipcRenderer.on('input-bindings:input', handler)
      return () => ipcRenderer.removeListener('input-bindings:input', handler)
    },
    onGlobalAction: (callback: (actionId: InputActionId) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, actionId: InputActionId) => callback(actionId)
      ipcRenderer.on('input-bindings:global-action', handler)
      return () => ipcRenderer.removeListener('input-bindings:global-action', handler)
    }
  },

  // Integrations
  discord: {
    configure: (options: DiscordRpcConfigureOptions): Promise<DiscordRpcConfigureResult> =>
      ipcRenderer.invoke('discord:configure', options),
    updatePresence: (update: DiscordPresenceUpdate) => ipcRenderer.send('discord:updatePresence', update),
    clearPresence: () => ipcRenderer.send('discord:clearPresence'),
    resolveCoverArt: (query: DiscordCoverArtLookupQuery): Promise<DiscordCoverArtLookupResult> =>
      ipcRenderer.invoke('discord:resolveCoverArt', query)
  },

  localApi: {
    getStatus: (): Promise<LocalApiStatus> => ipcRenderer.invoke('local-api:getStatus'),
    setEnabled: (enabled: boolean): Promise<LocalApiStatus> => ipcRenderer.invoke('local-api:setEnabled', enabled),
    setControlsEnabled: (enabled: boolean): Promise<LocalApiStatus> =>
      ipcRenderer.invoke('local-api:setControlsEnabled', enabled),
    setLibrarySearchEnabled: (enabled: boolean): Promise<LocalApiStatus> =>
      ipcRenderer.invoke('local-api:setLibrarySearchEnabled', enabled),
    setLibraryWriteEnabled: (enabled: boolean): Promise<LocalApiStatus> =>
      ipcRenderer.invoke('local-api:setLibraryWriteEnabled', enabled),
    setPort: (port: number): Promise<LocalApiStatus> => ipcRenderer.invoke('local-api:setPort', port),
    rotateToken: (): Promise<LocalApiStatus> => ipcRenderer.invoke('local-api:rotateToken'),
    resetToDefaults: (): Promise<LocalApiStatus> => ipcRenderer.invoke('local-api:resetToDefaults'),
    onStatus: (callback: (status: LocalApiStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: LocalApiStatus) => callback(status)
      ipcRenderer.on('local-api:status', handler)
      return () => ipcRenderer.removeListener('local-api:status', handler)
    }
  },

  phoneRemote: {
    getStatus: (): Promise<PhoneRemoteStatus> => ipcRenderer.invoke('phone-remote:getStatus'),
    createPairingTicket: (baseUrl?: string, clientKind?: PhoneRemoteClientKind): Promise<PhoneRemotePairingTicket> =>
      ipcRenderer.invoke('phone-remote:createPairingTicket', baseUrl, clientKind),
    listPairedDevices: (): Promise<PhoneRemotePairedDevice[]> =>
      ipcRenderer.invoke('phone-remote:listPairedDevices'),
    listPendingPairingRequests: (): Promise<PhoneRemotePendingPairingRequest[]> =>
      ipcRenderer.invoke('phone-remote:listPendingPairingRequests'),
    approvePairingRequest: (id: string, grantedScopes?: CompanionApiScope[]): Promise<PhoneRemotePendingPairingRequest | null> =>
      ipcRenderer.invoke('phone-remote:approvePairingRequest', id, grantedScopes),
    rejectPairingRequest: (id: string): Promise<PhoneRemotePendingPairingRequest | null> =>
      ipcRenderer.invoke('phone-remote:rejectPairingRequest', id),
    revokePairedDevice: (id: string): Promise<PhoneRemotePairedDevice | null> =>
      ipcRenderer.invoke('phone-remote:revokePairedDevice', id),
    revokeAllPairedDevices: (): Promise<number> => ipcRenderer.invoke('phone-remote:revokeAllPairedDevices'),
    setEnabled: (enabled: boolean): Promise<PhoneRemoteStatus> =>
      ipcRenderer.invoke('phone-remote:setEnabled', enabled),
    setPort: (port: number): Promise<PhoneRemoteStatus> => ipcRenderer.invoke('phone-remote:setPort', port),
    setSyncEnabled: (enabled: boolean): Promise<PhoneRemoteStatus> =>
      ipcRenderer.invoke('phone-remote:setSyncEnabled', enabled),
    requestSync: (): Promise<PhoneRemoteStatus> => ipcRenderer.invoke('phone-remote:requestSync'),
    resolveSyncConflict: (syncUid: string, resolution: PhoneSyncConflictResolution): Promise<PhoneRemoteStatus> =>
      ipcRenderer.invoke('phone-remote:resolveSyncConflict', syncUid, resolution),
    resetToDefaults: (): Promise<PhoneRemoteStatus> => ipcRenderer.invoke('phone-remote:resetToDefaults'),
    onStatus: (callback: (status: PhoneRemoteStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: PhoneRemoteStatus) => callback(status)
      ipcRenderer.on('phone-remote:status', handler)
      return () => ipcRenderer.removeListener('phone-remote:status', handler)
    }
  },

  parallax: {
    // Read once at preload init. Renderer cannot reach process.env directly with contextIsolation,
    // so we expose the resolved boolean.
    //
    // History:
    //   - Phase 2B (§13.5) shipped predictor as opt-in via PARALLAX_USE_HOST_PREDICTOR=1.
    //   - After macOS rig validation (rate +2.2 ppm vs env-off +4.1 ppm, jitter 0.4×, single
    //     early snap) §13.5.1 flipped it to default-on with PARALLAX_DISABLE_HOST_PREDICTOR=1
    //     as the kill switch.
    //   - 2026-06 Windows + complex-audio-path testing showed the predictor introduces a
    //     session-dependent static bias (~5-6 ms shifts across restarts, occasionally
    //     20-25 ms) that breaks the "calibrate manual trim once" path. Phase 1 nominal
    //     timeline alone gives a stable (if biased) offset users can dial in once and trust.
    //     Polarity flipped: predictor is now OPT-IN again, via PARALLAX_ENABLE_HOST_PREDICTOR=1.
    //   - PARALLAX_DISABLE_HOST_PREDICTOR still honored as an explicit override — forces off
    //     even if the enable flag is set, so users who already had the kill switch in their
    //     env stay at off without breakage.
    //
    // CSV `loop_source` continues to distinguish predictor vs phase1 frames so the active path
    // is verifiable per session.
    //
    // The flag still lives on the SINK process — same gotcha as before
    // (feedback_parallax-env-flag-machine-side memory). Setting it on the host has no effect.
    useHostPredictor: ((): boolean => {
      const explicitDisable = process.env.PARALLAX_DISABLE_HOST_PREDICTOR
      if (explicitDisable === '1' || explicitDisable === 'true') return false
      const explicitEnable = process.env.PARALLAX_ENABLE_HOST_PREDICTOR
      return explicitEnable === '1' || explicitEnable === 'true'
    })(),
    // §14.1.4 — `--zone` launch flag (or PARALLAX_LAUNCH_ZONE=1 env). Read once at preload init.
    // Main process translates the argv flag into the env var before this script runs. Renderer's
    // uiStore seeds `isZoneDisplayActive` from this OR the persisted preference.
    launchInZoneMode: ((): boolean => {
      const raw = process.env.PARALLAX_LAUNCH_ZONE
      return raw === '1' || raw === 'true'
    })(),
    getStatus: (): Promise<ParallaxStatus> => ipcRenderer.invoke('parallax:getStatus'),
    getEndpointIdentity: (): Promise<{ hostname: string; lanIps: string[] }> =>
      ipcRenderer.invoke('parallax:getEndpointIdentity'),
    fetchSinkArtwork: (streamId: string): Promise<string | null> =>
      ipcRenderer.invoke('parallax:fetchSinkArtwork', streamId),
    requestSinkTrimUpdate: (
      outputDeviceId: string,
      outputDeviceLabel: string | null,
      advanceMs: number
    ): Promise<boolean> =>
      ipcRenderer.invoke('parallax:requestSinkTrimUpdate', outputDeviceId, outputDeviceLabel, advanceMs),
    listPairedSinks: (): Promise<ParallaxPairedSink[]> => ipcRenderer.invoke('parallax:listPairedSinks'),
    setHostEnabled: (enabled: boolean): Promise<ParallaxStatus> =>
      ipcRenderer.invoke('parallax:setHostEnabled', enabled),
    // §20 Commit 1. Sink-role toggle.
    setSinkEnabled: (enabled: boolean): Promise<ParallaxStatus> =>
      ipcRenderer.invoke('parallax:setSinkEnabled', enabled),
    // §20 Commit 2. mDNS browse on/off + event subscription. Advertise lifecycle is owned by
    // main (bound to sinkEnabled) — no IPC needed there.
    startDiscoveryBrowse: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke('parallax:startDiscoveryBrowse'),
    stopDiscoveryBrowse: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke('parallax:stopDiscoveryBrowse'),
    onDiscoveryEvent: (callback: (event: ParallaxDiscoveryEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, event: ParallaxDiscoveryEvent) => callback(event)
      ipcRenderer.on('parallax:discoveryEvent', handler)
      return () => ipcRenderer.removeListener('parallax:discoveryEvent', handler)
    },
    // §20 Commit 3 pair flow. Wizard calls initiate → user reads sink PIN → wizard calls
    // submitPin. Cancel discards the host-side candidate; the sink expires its pending state
    // independently via TTL. Errors bubble through the IPC reject channel.
    initiatePair: (sinkBaseUrl: string): Promise<{
      pairingId: string
      sinkParallaxEndpointUuid: string | null
      sinkName: string
      expiresInSeconds: number
    }> => ipcRenderer.invoke('parallax:initiatePair', sinkBaseUrl),
    submitPairPin: (
      pairingId: string,
      pin: string,
      sinkName?: string
    ): Promise<{ sinkId: string; sinkName: string; sinkParallaxEndpointUuid: string | null }> =>
      ipcRenderer.invoke('parallax:submitPairPin', pairingId, pin, sinkName),
    cancelPair: (pairingId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('parallax:cancelPair', pairingId),
    cancelIncomingPair: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke('parallax:cancelIncomingPair'),
    approveIncomingPair: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('parallax:approveIncomingPair'),
    setHostPort: (port: number): Promise<ParallaxStatus> => ipcRenderer.invoke('parallax:setHostPort', port),
    disconnectSink: (): Promise<ParallaxStatus> => ipcRenderer.invoke('parallax:disconnectSink'),
    publishHostStreamStart: (
      info: ParallaxHostStreamStartInfo,
      options?: ParallaxHostStreamStartOptions
    ): Promise<ParallaxTimelineState> => ipcRenderer.invoke('parallax:publishHostStreamStart', info, options),
    publishHostNextStreamStart: (
      info: ParallaxHostStreamStartInfo,
      options: ParallaxHostNextStreamStartOptions
    ): Promise<ParallaxTimelineState> => ipcRenderer.invoke('parallax:publishHostNextStreamStart', info, options),
    publishHostNextStreamCancel: (): Promise<void> =>
      ipcRenderer.invoke('parallax:publishHostNextStreamCancel'),
    publishHostPromoteNextStream: (): Promise<ParallaxTimelineState | null> =>
      ipcRenderer.invoke('parallax:publishHostPromoteNextStream'),
    publishHostAudioChunk: (chunk: ParallaxAudioChunk): Promise<void> =>
      ipcRenderer.invoke('parallax:publishHostAudioChunk', chunk),
    publishHostTimeline: (timeline: ParallaxTimelineState, options?: ParallaxHostTimelinePublishOptions): Promise<void> =>
      ipcRenderer.invoke('parallax:publishHostTimeline', timeline, options),
    publishHostEmitAnchor: (anchor: Omit<Extract<ParallaxTimelineEvent, { type: 'host-emit-anchor' }>, 'emittedAtHostTimeMs'>): Promise<void> =>
      ipcRenderer.invoke('parallax:publishHostEmitAnchor', anchor),
    stopHostStream: (): Promise<void> => ipcRenderer.invoke('parallax:stopHostStream'),
    publishSinkTelemetry: (telemetry: ParallaxSinkTelemetry): Promise<void> =>
      ipcRenderer.invoke('parallax:publishSinkTelemetry', telemetry),
    reportHostLatency: (metrics: ParallaxOutputLatencyMetrics): Promise<void> =>
      ipcRenderer.invoke('parallax:reportHostLatency', metrics),
    revokePairedSink: (id: string): Promise<ParallaxPairedSink | null> =>
      ipcRenderer.invoke('parallax:revokePairedSink', id),
    renamePairedSink: (id: string, name: string): Promise<ParallaxPairedSink | null> =>
      ipcRenderer.invoke('parallax:renamePairedSink', id, name),
    setSinkPlaybackEnabled: (id: string, enabled: boolean): Promise<ParallaxStatus> =>
      ipcRenderer.invoke('parallax:setSinkPlaybackEnabled', id, enabled),
    setAllSinksPlaybackEnabled: (enabled: boolean): Promise<ParallaxStatus> =>
      ipcRenderer.invoke('parallax:setAllSinksPlaybackEnabled', enabled),
    revokeAllPairedSinks: (): Promise<number> => ipcRenderer.invoke('parallax:revokeAllPairedSinks'),
    clearHostPresenceCache: (sinkId?: string): Promise<ParallaxStatus> =>
      ipcRenderer.invoke('parallax:clearHostPresenceCache', sinkId),
    resetToDefaults: (): Promise<ParallaxStatus> => ipcRenderer.invoke('parallax:resetToDefaults'),
    // §14.1.1. Host UI calls this when the user moves a per-sink trim stepper. Main process
    // persists to pairedSink.trims and broadcasts `sink-trim-update` to that sink's SSE clients.
    setSinkTrim: (
      sinkId: string,
      outputDeviceId: string,
      outputDeviceLabel: string | null,
      advanceMs: number
    ): Promise<ParallaxStatus> =>
      ipcRenderer.invoke('parallax:setSinkTrim', sinkId, outputDeviceId, outputDeviceLabel, advanceMs),
    // §14.1.2. Sink-side durable pairing. `setSinkConnection` persists creds after a successful
    // pair; `getSinkConnection` populates the "paired with X" UI; `forgetSinkConnection` is the
    // sink-side symmetric of the host's "Revoke" — wipes creds and stops auto-reconnect.
    forgetSinkConnection: (): Promise<ParallaxStatus> =>
      ipcRenderer.invoke('parallax:forgetSinkConnection'),
    reconnectFromPersisted: (): Promise<ParallaxStatus> =>
      ipcRenderer.invoke('parallax:reconnectFromPersisted'),
    startAutoReconnect: (): Promise<{ scheduled: boolean; reason?: 'no-persisted-connection' | 'host-mode-active' }> =>
      ipcRenderer.invoke('parallax:startAutoReconnect'),
    onSinkPaired: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('parallax:sinkPaired', handler)
      return () => ipcRenderer.removeListener('parallax:sinkPaired', handler)
    },
    onStatus: (callback: (status: ParallaxStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: ParallaxStatus) => callback(status)
      ipcRenderer.on('parallax:status', handler)
      return () => ipcRenderer.removeListener('parallax:status', handler)
    },
    onEvent: (callback: (event: ParallaxTimelineEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, event: ParallaxTimelineEvent) => callback(event)
      ipcRenderer.on('parallax:event', handler)
      return () => ipcRenderer.removeListener('parallax:event', handler)
    },
    onAudioChunk: (callback: (chunk: ParallaxAudioChunk) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, chunk: ParallaxAudioChunk) => callback(chunk)
      ipcRenderer.on('parallax:audioChunk', handler)
      return () => ipcRenderer.removeListener('parallax:audioChunk', handler)
    }
  },

  lastFm: {
    getStatus: (): Promise<LastFmStatus> => ipcRenderer.invoke('lastfm:getStatus'),
    setEnabled: (enabled: boolean): Promise<LastFmStatus> => ipcRenderer.invoke('lastfm:setEnabled', enabled),
    createCustomProfile: (input: LastFmCustomProfileInput): Promise<LastFmStatus> =>
      ipcRenderer.invoke('lastfm:createCustomProfile', input),
    updateCustomProfile: (profileId: string, input: LastFmCustomProfileInput): Promise<LastFmStatus> =>
      ipcRenderer.invoke('lastfm:updateCustomProfile', profileId, input),
    deleteCustomProfile: (profileId: string): Promise<LastFmStatus> =>
      ipcRenderer.invoke('lastfm:deleteCustomProfile', profileId),
    setActiveProfile: (profileId: string): Promise<LastFmStatus> =>
      ipcRenderer.invoke('lastfm:setActiveProfile', profileId),
    setProfileEnabled: (profileId: string, enabled: boolean): Promise<LastFmStatus> =>
      ipcRenderer.invoke('lastfm:setProfileEnabled', profileId, enabled),
    beginAuth: (profileId?: string): Promise<LastFmAuthStartResult> => ipcRenderer.invoke('lastfm:beginAuth', profileId),
    finishAuth: (): Promise<LastFmAuthFinishResult> => ipcRenderer.invoke('lastfm:finishAuth'),
    disconnect: (): Promise<LastFmStatus> => ipcRenderer.invoke('lastfm:disconnect'),
    disconnectProfile: (profileId: string): Promise<LastFmStatus> =>
      ipcRenderer.invoke('lastfm:disconnectProfile', profileId),
    resetToDefaults: (): Promise<LastFmStatus> => ipcRenderer.invoke('lastfm:resetToDefaults'),
    onStatus: (callback: (status: LastFmStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: LastFmStatus) => callback(status)
      ipcRenderer.on('lastfm:status', handler)
      return () => ipcRenderer.removeListener('lastfm:status', handler)
    }
  },

  lyrics: {
    getStatus: (): Promise<LyricsStatus> => ipcRenderer.invoke('lyrics:getStatus'),
    setEnabled: (enabled: boolean): Promise<LyricsStatus> => ipcRenderer.invoke('lyrics:setEnabled', enabled),
    setLrclibBaseUrl: (baseUrl: string): Promise<LyricsStatus> =>
      ipcRenderer.invoke('lyrics:setLrclibBaseUrl', baseUrl),
    getForTrack: (query: LyricsTrackQuery): Promise<LyricsLookupResult> => ipcRenderer.invoke('lyrics:getForTrack', query),
    refreshForTrack: (query: LyricsTrackQuery): Promise<LyricsLookupResult> =>
      ipcRenderer.invoke('lyrics:refreshForTrack', query),
    getTrackOverride: (trackPath: string): Promise<LyricsTrackOverride> =>
      ipcRenderer.invoke('lyrics:getTrackOverride', trackPath),
    importManualLyrics: (trackPaths: string[], lyricsText: string, format?: LyricsFormat): Promise<LyricsManualImportResult> =>
      ipcRenderer.invoke('lyrics:importManualLyrics', trackPaths, lyricsText, format),
    clearManualLyrics: (trackPaths: string[]): Promise<LyricsManualClearResult> =>
      ipcRenderer.invoke('lyrics:clearManualLyrics', trackPaths),
    setTrackOffset: (trackPaths: string[], offsetMs: number): Promise<LyricsOffsetSetResult> =>
      ipcRenderer.invoke('lyrics:setTrackOffset', trackPaths, offsetMs),
    resetToDefaults: (): Promise<LyricsStatus> => ipcRenderer.invoke('lyrics:resetToDefaults'),
    onStatus: (callback: (status: LyricsStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: LyricsStatus) => callback(status)
      ipcRenderer.on('lyrics:status', handler)
      return () => ipcRenderer.removeListener('lyrics:status', handler)
    }
  },

  subsonic: {
    listSources: (): Promise<SubsonicSource[]> => ipcRenderer.invoke('subsonic:listSources'),
    createSource: (input: SubsonicSourceCreateInput): Promise<SubsonicSource> =>
      ipcRenderer.invoke('subsonic:createSource', input),
    updateSource: (sourceId: number, input: SubsonicSourceUpdateInput): Promise<SubsonicSource> =>
      ipcRenderer.invoke('subsonic:updateSource', sourceId, input),
    deleteSource: (sourceId: number, purgeTracks: boolean): Promise<void> =>
      ipcRenderer.invoke('subsonic:deleteSource', sourceId, purgeTracks),
    testSource: (input: SubsonicSourceTestInput): Promise<SubsonicSourceTestResult> =>
      ipcRenderer.invoke('subsonic:testSource', input),
    syncSource: (sourceId: number, syncSessionKey?: string): Promise<void> => ipcRenderer.invoke('subsonic:syncSource', sourceId, syncSessionKey),
    syncAll: (syncSessionKey?: string): Promise<void> => ipcRenderer.invoke('subsonic:syncAll', syncSessionKey),
    getStatus: (): Promise<SubsonicStatusSnapshot> => ipcRenderer.invoke('subsonic:getStatus'),
    onStatus: (callback: (status: SubsonicStatusSnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: SubsonicStatusSnapshot) => callback(status)
      ipcRenderer.on('subsonic:status', handler)
      return () => ipcRenderer.removeListener('subsonic:status', handler)
    }
  },
  jellyfin: {
    listSources: (): Promise<JellyfinSource[]> => ipcRenderer.invoke('jellyfin:listSources'),
    createSource: (input: JellyfinSourceCreateInput): Promise<JellyfinSource> =>
      ipcRenderer.invoke('jellyfin:createSource', input),
    updateSource: (sourceId: number, input: JellyfinSourceUpdateInput): Promise<JellyfinSource> =>
      ipcRenderer.invoke('jellyfin:updateSource', sourceId, input),
    deleteSource: (sourceId: number, purgeTracks: boolean): Promise<void> =>
      ipcRenderer.invoke('jellyfin:deleteSource', sourceId, purgeTracks),
    testSource: (input: JellyfinSourceTestInput): Promise<JellyfinSourceTestResult> =>
      ipcRenderer.invoke('jellyfin:testSource', input),
    syncSource: (sourceId: number, syncSessionKey?: string): Promise<void> => ipcRenderer.invoke('jellyfin:syncSource', sourceId, syncSessionKey),
    syncAll: (syncSessionKey?: string): Promise<void> => ipcRenderer.invoke('jellyfin:syncAll', syncSessionKey),
    getStatus: (): Promise<JellyfinStatusSnapshot> => ipcRenderer.invoke('jellyfin:getStatus'),
    onStatus: (callback: (status: JellyfinStatusSnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: JellyfinStatusSnapshot) => callback(status)
      ipcRenderer.on('jellyfin:status', handler)
      return () => ipcRenderer.removeListener('jellyfin:status', handler)
    }
  },

  // File operations
  openAudioFile: () => ipcRenderer.invoke('dialog:openAudioFile'),
  openAudioFolder: () => ipcRenderer.invoke('dialog:openAudioFolder'),
  loadAudioFile: (filePath: string, options?: AudioLoadOptions) => ipcRenderer.invoke('audio:loadFile', filePath, options),
  // Binaural renderer WASM for the spatial worklet (an AudioWorkletGlobalScope
  // cannot fetch; the preload reads the bytes like it loads the native addon).
  getSpatialWasmBytes: async (): Promise<ArrayBuffer> => {
    const isDev = process.env.NODE_ENV === 'development'
    const wasmPath = isDev
      ? join(__dirname, '../../src/renderer/public/spatial-renderer.wasm')
      : join(__dirname, '../renderer/spatial-renderer.wasm')
    const bytes = await readFile(wasmPath)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  },
  // IAMF (Eclipsa Audio) decoder WASM for the renderer decode worker.
  getIamfWasmBytes: async (): Promise<ArrayBuffer> => {
    const isDev = process.env.NODE_ENV === 'development'
    const wasmPath = isDev
      ? join(__dirname, '../../src/renderer/public/iamf-decoder.wasm')
      : join(__dirname, '../renderer/iamf-decoder.wasm')
    const bytes = await readFile(wasmPath)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  },
  getAudioMetadata: (filePath: string) => ipcRenderer.invoke('audio:getMetadata', filePath) as Promise<AudioFileMetadata | null>,
  getAudioFileStat: (filePath: string) => ipcRenderer.invoke('audio:getFileStat', filePath) as Promise<AudioFileStatResult | null>,
  decodeAudioWithFfmpeg: (filePath: string) => ipcRenderer.invoke('audio:decodeWithFfmpeg', filePath),
  analyzeTrackLoudness: (filePath: string) =>
    ipcRenderer.invoke('audio:analyzeTrackLoudness', filePath) as Promise<TrackLoudnessResult | null>,
  warmupTrackLoudness: (filePath: string) =>
    ipcRenderer.invoke('audio:warmupTrackLoudness', filePath) as Promise<TrackLoudnessResult | null>,
  storeTrackLoudness: (filePath: string, payload: TrackLoudnessStorePayload) =>
    ipcRenderer.invoke('audio:storeTrackLoudness', filePath, payload) as Promise<boolean>,
  startProgressiveStream: (
    filePath: string,
    outputSampleRate: number,
    expectedChannels?: number | null,
    options?: ProgressiveStreamStartOptions
  ) =>
    ipcRenderer.invoke('audio:startProgressiveStream', filePath, outputSampleRate, expectedChannels, options) as Promise<ProgressiveStreamInfo>,
  cancelProgressiveStream: (sessionId: number) => ipcRenderer.invoke('audio:cancelProgressiveStream', sessionId) as Promise<void>,
  startRemoteStream: (filePath: string, outputSampleRate: number, expectedChannels?: number | null) =>
    ipcRenderer.invoke('audio:startRemoteStream', filePath, outputSampleRate, expectedChannels) as Promise<RemoteStreamInfo>,
  cancelRemoteStream: (sessionId: number) => ipcRenderer.invoke('audio:cancelRemoteStream', sessionId) as Promise<void>,
  getReplayGainScanEnabled: () => ipcRenderer.invoke('audio:getReplayGainScanEnabled') as Promise<boolean>,
  setReplayGainScanEnabled: (enabled: boolean) => ipcRenderer.invoke('audio:setReplayGainScanEnabled', enabled) as Promise<boolean>,
  onRemoteLoadProgress: (callback: (progress: RemoteAudioLoadProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: RemoteAudioLoadProgress) => callback(progress)
    ipcRenderer.on('audio:remoteLoadProgress', handler)
    return () => ipcRenderer.removeListener('audio:remoteLoadProgress', handler)
  },
  onProgressiveLoadProgress: (callback: (progress: ProgressiveAudioLoadProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ProgressiveAudioLoadProgress) => callback(progress)
    ipcRenderer.on('audio:progressiveLoadProgress', handler)
    return () => ipcRenderer.removeListener('audio:progressiveLoadProgress', handler)
  },
  onRemoteStreamChunk: (callback: (chunk: RemoteStreamChunk) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, chunk: RemoteStreamChunk) => callback(chunk)
    ipcRenderer.on('audio:remoteStreamChunk', handler)
    return () => ipcRenderer.removeListener('audio:remoteStreamChunk', handler)
  },
  onProgressiveStreamChunk: (callback: (chunk: ProgressiveStreamChunk) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, chunk: ProgressiveStreamChunk) => callback(chunk)
    ipcRenderer.on('audio:progressiveStreamChunk', handler)
    return () => ipcRenderer.removeListener('audio:progressiveStreamChunk', handler)
  },
  onRemoteStreamEvent: (callback: (payload: RemoteStreamEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: RemoteStreamEvent) => callback(payload)
    ipcRenderer.on('audio:remoteStreamEvent', handler)
    return () => ipcRenderer.removeListener('audio:remoteStreamEvent', handler)
  },
  onProgressiveStreamEvent: (callback: (payload: ProgressiveStreamEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ProgressiveStreamEvent) => callback(payload)
    ipcRenderer.on('audio:progressiveStreamEvent', handler)
    return () => ipcRenderer.removeListener('audio:progressiveStreamEvent', handler)
  },

  // Generic file dialogs & I/O
  showSaveDialog: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('dialog:showSaveDialog', options),
  openFileDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('dialog:openFile', options),
  readTextFile: (filePath: string) => ipcRenderer.invoke('fs:readTextFile', filePath),
  readFileAsDataUrl: (filePath: string) => ipcRenderer.invoke('fs:readDataUrl', filePath) as Promise<string | null>,
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeTextFile', filePath, content),
  writeSettingsTransferFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('settings-transfer:writeFile', filePath, content) as Promise<boolean>,
  revealFileInFolder: (filePath: string) => ipcRenderer.invoke('fs:revealFileInFolder', filePath) as Promise<boolean>,

  statsShare: {
    copyPng: (bytes: Uint8Array) => ipcRenderer.invoke('stats-share:copy-png', bytes) as Promise<boolean>,
    savePng: (bytes: Uint8Array, suggestedFileName: string) =>
      ipcRenderer.invoke('stats-share:save-png', bytes, suggestedFileName) as Promise<string | null>
  },

  signalShare: {
    copyPng: (bytes: Uint8Array) => ipcRenderer.invoke('signal-share:copy-png', bytes) as Promise<boolean>,
    savePng: (bytes: Uint8Array, suggestedFileName: string) =>
      ipcRenderer.invoke('signal-share:save-png', bytes, suggestedFileName) as Promise<string | null>
  },

  // Library operations
  library: {
    getTracks: () => getAllLibraryTracksPaged(),
    getTracksPage: (request?: LibraryTrackPageRequest) =>
      ipcRenderer.invoke('library:getTracksPage', request) as Promise<LibraryTrackPage>,
    getTracksByPaths: (trackPaths: string[]) =>
      ipcRenderer.invoke('library:getTracksByPaths', trackPaths) as Promise<DbTrack[]>,
    getTracksByArtist: (artist: string, mode?: LibraryArtistBrowseMode) =>
      ipcRenderer.invoke('library:getTracksByArtist', artist, mode),
    getTracksByGenre: (genre: string) =>
      ipcRenderer.invoke('library:getTracksByGenre', genre) as Promise<DbTrack[]>,
    getTracksByYear: (year: number | null) =>
      ipcRenderer.invoke('library:getTracksByYear', year) as Promise<DbTrack[]>,
    getTracksByAlbum: (album: string, artist?: string, identityKey?: string) =>
      ipcRenderer.invoke('library:getTracksByAlbum', album, artist, identityKey),
    getArtists: (mode?: LibraryArtistBrowseMode) => ipcRenderer.invoke('library:getArtists', mode),
    getGenres: () => ipcRenderer.invoke('library:getGenres') as Promise<Genre[]>,
    setArtistImageFromFile: (artist: string, mode: LibraryArtistBrowseMode, imagePath: string) =>
      ipcRenderer.invoke('library:setArtistImageFromFile', artist, mode, imagePath),
    clearArtistImage: (artist: string, mode: LibraryArtistBrowseMode) =>
      ipcRenderer.invoke('library:clearArtistImage', artist, mode),
    getAlbums: (options?: AlbumListOptions) => ipcRenderer.invoke('library:getAlbums', options),
    search: (query: string) => ipcRenderer.invoke('library:search', query),
    getMetadataOverridePaths: () => ipcRenderer.invoke('library:getMetadataOverridePaths'),
    clearMetadataOverrides: (trackPaths: string[]) => ipcRenderer.invoke('library:clearMetadataOverrides', trackPaths),
    saveMetadataEdits: (request: MetadataEditRequest) => ipcRenderer.invoke('library:saveMetadataEdits', request),
    getTrackOverrideFields: (trackPaths: string[]) => ipcRenderer.invoke('library:getTrackOverrideFields', trackPaths) as Promise<Record<string, string[]>>,
    getTrackOverrideSnapshots: (trackPaths: string[]) => ipcRenderer.invoke('library:getTrackOverrideSnapshots', trackPaths) as Promise<Record<string, TrackOverrideSnapshot | null>>,
    restoreTrackOverrides: (overrides: Record<string, TrackOverrideSnapshot | null>) => ipcRenderer.invoke('library:restoreTrackOverrides', overrides) as Promise<void>,
    getFolders: () => ipcRenderer.invoke('library:getFolders'),
    getFolderSubfolderSummary: (folderPath: string) => ipcRenderer.invoke('library:getFolderSubfolderSummary', folderPath) as Promise<FolderSubfolderSummary>,
    listFolderSubdirectories: (folderPath: string, parentRelativePath?: string) =>
      ipcRenderer.invoke('library:listFolderSubdirectories', folderPath, parentRelativePath) as Promise<FolderSubdirectoryEntry[]>,
    addFolderWithoutScan: (folderPath: string) => ipcRenderer.invoke('library:addFolderWithoutScan', folderPath) as Promise<{
      success: boolean
      folder?: LibraryFolder
      summary?: FolderSubfolderSummary
      error?: string
    }>,
    setFolderSubfolderExcluded: (folderPath: string, relativePath: string, excluded: boolean) =>
      ipcRenderer.invoke('library:setFolderSubfolderExcluded', folderPath, relativePath, excluded) as Promise<{
        success: boolean
        summary?: FolderSubfolderSummary
        error?: string
      }>,
    rescanFolder: (folderPath: string) => ipcRenderer.invoke('library:rescanFolder', folderPath) as Promise<{
      success: boolean
      canceled?: boolean
      added?: number
      updated?: number
      errors?: number
      removed?: number
      skippedDirs?: string[]
      summary?: FolderSubfolderSummary
      scanIssueLog?: ScanIssueLog
    }>,
    addFolder: (folderPath: string) => ipcRenderer.invoke('library:addFolder', folderPath) as Promise<{
      success: boolean
      canceled?: boolean
      added?: number
      updated?: number
      errors?: number
      skippedDirs?: string[]
      scanIssueLog?: ScanIssueLog
      error?: string
    }>,
    removeFolder: (folderPath: string) => ipcRenderer.invoke('library:removeFolder', folderPath),
    setFolderHidden: (folderPath: string, hidden: boolean) =>
      ipcRenderer.invoke('library:setFolderHidden', folderPath, hidden) as Promise<{ success: boolean; error?: string }>,
    backfillReplayGainMetadata: () => ipcRenderer.invoke('library:backfillReplayGainMetadata') as Promise<{
      scanned: number
      updated: number
      errors: number
      canceled?: boolean
      scanIssueLog?: ScanIssueLog
    }>,
    cancelScan: () => ipcRenderer.invoke('library:cancelScan') as Promise<{ canceled: boolean }>,
    startIntegrityScan: (request: { mode: IntegrityScanMode; scope: IntegrityScanScope }) =>
      ipcRenderer.invoke('library:startIntegrityScan', request) as Promise<IntegrityScanResult>,
    cancelIntegrityScan: () => ipcRenderer.invoke('library:cancelIntegrityScan') as Promise<{ canceled: boolean }>,
    trashIntegrityDuplicates: (request: IntegrityDuplicateTrashRequest) =>
      ipcRenderer.invoke('library:trashIntegrityDuplicates', request) as Promise<IntegrityDuplicateTrashResult>,
    checkTrackIntegrity: (trackPath: string) =>
      ipcRenderer.invoke('library:checkTrackIntegrity', trackPath) as Promise<IntegrityScanResult>,
    checkTracksIntegrity: (trackPaths: string[]) =>
      ipcRenderer.invoke('library:checkTracksIntegrity', trackPaths) as Promise<IntegrityScanResult>,
    resetMappedFolders: () => ipcRenderer.invoke('library:resetMappedFolders'),
    factoryReset: () => ipcRenderer.invoke('library:factoryReset'),
    rescan: () => ipcRenderer.invoke('library:rescan') as Promise<{
      added: number
      updated: number
      errors: number
      removed?: number
      folderWarnings?: Record<string, string[]>
      scanIssueLog?: ScanIssueLog
      canceled?: boolean
    }>,
    forceRescanAll: () => ipcRenderer.invoke('library:forceRescanAll') as Promise<{
      added: number
      updated: number
      errors: number
      removed?: number
      folderWarnings?: Record<string, string[]>
      scanIssueLog?: ScanIssueLog
      canceled?: boolean
    }>,
    getTrackCount: () => ipcRenderer.invoke('library:getTrackCount') as Promise<number>,
    getTotalTrackDuration: () => ipcRenderer.invoke('library:getTotalTrackDuration') as Promise<number>,
    getArtworkPath: (hash: string) => ipcRenderer.invoke('library:getArtworkPath', hash),
    getArtworkDataUrl: (hash: string) => ipcRenderer.invoke('library:getArtworkDataUrl', hash),
    getArtworkThumbnailDataUrl: (hash: string) => ipcRenderer.invoke('library:getArtworkThumbnailDataUrl', hash),
    getArtworkCardDataUrl: (hash: string) => ipcRenderer.invoke('library:getArtworkCardDataUrl', hash),
    onScanProgress: (callback: (progress: ScanProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: ScanProgress) => callback(progress)
      ipcRenderer.on('library:scanProgress', handler)
      return () => ipcRenderer.removeListener('library:scanProgress', handler)
    },
    onScanStage: (callback: (progress: ScanStageProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: ScanStageProgress) => callback(progress)
      ipcRenderer.on('library:scanStage', handler)
      return () => ipcRenderer.removeListener('library:scanStage', handler)
    },
    onIntegrityScanProgress: (callback: (progress: IntegrityScanProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: IntegrityScanProgress) => callback(progress)
      ipcRenderer.on('library:integrityScanProgress', handler)
      return () => ipcRenderer.removeListener('library:integrityScanProgress', handler)
    },
    onIntegrityScanFinding: (callback: (finding: IntegrityFinding) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, finding: IntegrityFinding) => callback(finding)
      ipcRenderer.on('library:integrityScanFinding', handler)
      return () => ipcRenderer.removeListener('library:integrityScanFinding', handler)
    },
    onIntegrityScanComplete: (callback: (result: IntegrityScanResult) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, result: IntegrityScanResult) => callback(result)
      ipcRenderer.on('library:integrityScanComplete', handler)
      return () => ipcRenderer.removeListener('library:integrityScanComplete', handler)
    },
    onFileCreatedAtBackfillComplete: (callback: (result: { scanned: number; updated: number; errors: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, result: { scanned: number; updated: number; errors: number }) => callback(result)
      ipcRenderer.on('library:fileCreatedAtBackfillComplete', handler)
      return () => ipcRenderer.removeListener('library:fileCreatedAtBackfillComplete', handler)
    },
    onAudioMetadataBackfillComplete: (callback: (result: { scanned: number; updated: number; errors: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, result: { scanned: number; updated: number; errors: number }) => callback(result)
      ipcRenderer.on('library:audioMetadataBackfillComplete', handler)
      return () => ipcRenderer.removeListener('library:audioMetadataBackfillComplete', handler)
    },
    onMetadataEditProgress: (callback: (progress: { current: number; total: number; trackPath: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: { current: number; total: number; trackPath: string }) => callback(progress)
      ipcRenderer.on('library:metadataEditProgress', handler)
      return () => ipcRenderer.removeListener('library:metadataEditProgress', handler)
    },
    // Fired after a mobile LAN sync mutates favorites/playlists in the main
    // process; the renderer should reload both stores.
    onExternalLibraryMutation: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('library:externalLibraryMutation', handler)
      return () => ipcRenderer.removeListener('library:externalLibraryMutation', handler)
    },

    // Favorites
    getFavorites: () => ipcRenderer.invoke('library:getFavorites'),
    getFavoritePaths: () => ipcRenderer.invoke('library:getFavoritePaths'),
    addFavorite: (trackPath: string) => ipcRenderer.invoke('library:addFavorite', trackPath),
    removeFavorite: (trackPath: string) => ipcRenderer.invoke('library:removeFavorite', trackPath),

    // Track ratings
    getTrackRatings: () => ipcRenderer.invoke('library:getTrackRatings'),
    setTrackRating: (trackPaths: string[], rating: number | null) => ipcRenderer.invoke('library:setTrackRating', trackPaths, rating),
    resetTrackRatings: () => ipcRenderer.invoke('library:resetTrackRatings'),

    // Recently played
    getRecentlyPlayed: (limit?: number) => ipcRenderer.invoke('library:getRecentlyPlayed', limit),
    markTrackLatestSyncSeen: (trackPath: string) => ipcRenderer.invoke('library:markTrackLatestSyncSeen', trackPath),
    addRecentlyPlayed: (trackPath: string) => ipcRenderer.invoke('library:addRecentlyPlayed', trackPath),
    getListeningHistoryStatus: () => ipcRenderer.invoke('library:getListeningHistoryStatus') as Promise<ListeningHistoryStatus>,
    checkpointListeningSession: (checkpoint: ListeningSessionCheckpoint) =>
      ipcRenderer.invoke('library:checkpointListeningSession', checkpoint) as Promise<ListeningSessionCheckpointResult>,
    getListeningStatsDashboard: (query: ListeningStatsQuery) =>
      ipcRenderer.invoke('library:getListeningStatsDashboard', query) as Promise<ListeningStatsDashboard>,
    clearDetailedListeningHistory: () =>
      ipcRenderer.invoke('library:clearDetailedListeningHistory') as Promise<ListeningHistoryStatus>,

    // Listening stats transfer (settings import/export)
    getListeningStatsTransferAvailability: () =>
      ipcRenderer.invoke('library:getListeningStatsTransferAvailability') as Promise<ListeningStatsTransferAvailability>,
    exportListeningStatsTransfer: (request?: ListeningStatsExportRequest) =>
      ipcRenderer.invoke('library:exportListeningStatsTransfer', request) as Promise<ListeningStatsExportBundle>,
    applyListeningStatsTransfer: (request: ListeningStatsApplyRequest) =>
      ipcRenderer.invoke('library:applyListeningStatsTransfer', request) as Promise<ListeningStatsImportResult>,

    // External listening imports (the public astra-listening-import format)
    readListeningImportFile: (filePath: string) =>
      ipcRenderer.invoke('library:readListeningImportFile', filePath) as Promise<ListeningImportPreview>,
    applyListeningImportFile: (filePath: string) =>
      ipcRenderer.invoke('library:applyListeningImportFile', filePath) as Promise<ListeningStatsImportResult>,
    getImportedListeningSources: () =>
      ipcRenderer.invoke('library:getImportedListeningSources') as Promise<ImportedListeningSource[]>,
    removeImportedListeningSource: (source: string) =>
      ipcRenderer.invoke('library:removeImportedListeningSource', source) as Promise<ImportedListeningSourceRemoval>,

    // Playlists
    getPlaylists: () => ipcRenderer.invoke('library:getPlaylists'),
    createPlaylist: (name: string) => ipcRenderer.invoke('library:createPlaylist', name),
    createDynamicPlaylist: (name: string, rules: DynamicPlaylistRulesV1) => ipcRenderer.invoke('library:createDynamicPlaylist', name, rules),
    getDynamicPlaylistRules: (playlistId: number) => ipcRenderer.invoke('library:getDynamicPlaylistRules', playlistId),
    updateDynamicPlaylistRules: (playlistId: number, rules: DynamicPlaylistRulesV1) => ipcRenderer.invoke('library:updateDynamicPlaylistRules', playlistId, rules),
    previewDynamicPlaylist: (rules: DynamicPlaylistRulesV1) => ipcRenderer.invoke('library:previewDynamicPlaylist', rules),
    renamePlaylist: (id: number, name: string) => ipcRenderer.invoke('library:renamePlaylist', id, name),
    deletePlaylist: (id: number) => ipcRenderer.invoke('library:deletePlaylist', id),
    getPlaylistTracks: (playlistId: number) => ipcRenderer.invoke('library:getPlaylistTracks', playlistId),
    getPlaylistTrackEntries: (playlistId: number) => ipcRenderer.invoke('library:getPlaylistTrackEntries', playlistId),
    addToPlaylist: (playlistId: number, trackPaths: string[]) => ipcRenderer.invoke('library:addToPlaylist', playlistId, trackPaths),
    removeFromPlaylist: (playlistId: number, trackPath: string) => ipcRenderer.invoke('library:removeFromPlaylist', playlistId, trackPath),
    removePlaylistEntry: (playlistId: number, entryId: number) => ipcRenderer.invoke('library:removePlaylistEntry', playlistId, entryId),
    reassociatePlaylistEntry: (playlistId: number, entryId: number, targetTrackPath: string) =>
      ipcRenderer.invoke('library:reassociatePlaylistEntry', playlistId, entryId, targetTrackPath),
    reorderPlaylistEntries: (playlistId: number, orderedEntryIds: number[]) => ipcRenderer.invoke('library:reorderPlaylistEntries', playlistId, orderedEntryIds),
    markPlaylistPlayed: (playlistId: number) => ipcRenderer.invoke('library:markPlaylistPlayed', playlistId),
    setPlaylistCustomCoverFromFile: (playlistId: number, imagePath: string) => ipcRenderer.invoke('library:setPlaylistCustomCoverFromFile', playlistId, imagePath),
    clearPlaylistCustomCover: (playlistId: number) => ipcRenderer.invoke('library:clearPlaylistCustomCover', playlistId),
    getPlaylistsContainingTrack: (trackPath: string) => ipcRenderer.invoke('library:getPlaylistsContainingTrack', trackPath),
    getPlaylistsContainingTracks: (trackPaths: string[]) => ipcRenderer.invoke('library:getPlaylistsContainingTracks', trackPaths) as Promise<Array<{ playlistId: number; matchedTrackCount: number }>>,
    importPlaylistFromFile: (filePath: string) => ipcRenderer.invoke('library:importPlaylistFromFile', filePath),
    exportPlaylistToM3u: (playlistId: number, filePath: string) => ipcRenderer.invoke('library:exportPlaylistToM3u', playlistId, filePath),
  }
})

// Expose Visualizer API
contextBridge.exposeInMainWorld('visualizerAPI', visualizerDSP)
// Diagnostics sibling to `visualizerAPI` (which is `null` when the addon fails to load, so it
// can't carry a reason itself). Lets the renderer surface *why* native-only visualizers are
// blank — the reason string distinguishes a missing file from a shared-lib/ABI mismatch.
contextBridge.exposeInMainWorld('visualizerAddonStatus', {
  available: Boolean(visualizerDSP),
  reason: nativeAddonLoadError,
})
contextBridge.exposeInMainWorld('nativeAudioAPI', nativeAudioController)
// §22 Commit 1 — Parallax loopback (Windows-only WASAPI, stubbed elsewhere). Wrapped in plain
// JS thunks rather than exposing the native sub-object directly — contextBridge handles
// `visualizerDSP` at top level via Electron's special path but does NOT fully forward arbitrary
// nested native objects, so a sub-object extraction (which is what we want here) returns
// proxies that don't invoke cleanly. The wrappers are cheap, stay in the preload process (no
// IPC), and preserve the no-jitter property `wallNowMs()` needs for the §22.11(a) clock anchor.
const parallaxLoopbackNative = (visualizerDSP as {
  parallaxLoopback?: {
    isSupported: () => { supported: boolean; reason?: string }
    wallNowMs: () => number
    start: () => { ok: boolean; endpoint?: unknown; error?: string }
    stop: () => void
    drain: () => Array<unknown>
    isRunning: () => boolean
  }
} | null)?.parallaxLoopback ?? null
contextBridge.exposeInMainWorld(
  'parallaxLoopbackAPI',
  parallaxLoopbackNative
    ? {
        isSupported: () => parallaxLoopbackNative.isSupported(),
        wallNowMs: () => parallaxLoopbackNative.wallNowMs(),
        start: () => parallaxLoopbackNative.start(),
        stop: () => parallaxLoopbackNative.stop(),
        drain: () => parallaxLoopbackNative.drain(),
        isRunning: () => parallaxLoopbackNative.isRunning()
      }
    : null
)

// Type declarations for renderer
declare global {
  interface Window {
    nativeAudioAPI: {
      initialize: () => Promise<NativeAudioCapabilities>
      getCapabilities: () => Promise<NativeAudioCapabilities>
      setOutputDevice: (deviceId: string) => Promise<NativeAudioCapabilities>
      loadTrack: (filePath: string, metadata?: NativeAudioTrackMetadata) => Promise<NativeAudioTrackLoadResult>
      preloadNextTrack: (filePath: string, metadata?: NativeAudioTrackMetadata) => Promise<NativeAudioTrackLoadResult>
      promoteNextTrack: (filePath: string, metadata?: NativeAudioTrackMetadata) => Promise<NativeAudioTrackLoadResult>
      play: () => Promise<NativeAudioPlaybackSnapshot>
      pause: () => Promise<NativeAudioPlaybackSnapshot>
      stop: () => Promise<NativeAudioPlaybackSnapshot>
      seek: (seconds: number) => Promise<NativeAudioPlaybackSnapshot>
      clearNextTrack: () => Promise<void>
      getPlaybackSnapshot: () => Promise<NativeAudioPlaybackSnapshot>
      getBufferMemoryStats: () => Promise<AudioBufferMemoryStats>
      setVisualizerTapDemand: (demand: NativeAudioVisualizerTapDemand) => Promise<void>
      flushOscilloscopeChunks: () => Float32Array[]
      flushSpectrumChunks: () => Float32Array[]
      flushVectorscopeChunks: () => NativeAudioVectorscopeChunk[]
      flushVUMeterChunks: () => NativeAudioVUMeterChunk[]
      onEvent: (callback: (event: NativeAudioEvent) => void) => () => void
    }
    electronAPI: {
      // Window controls
      minimize: () => void
      maximize: () => void
      close: () => void
      isMaximized: () => Promise<boolean>
      associatedOpenFiles: {
        markReady: () => void
        onOpenFiles: (callback: (paths: string[]) => void) => () => void
      }
      miniPlayer: {
        open: () => Promise<void>
        close: () => Promise<void>
        getWindowState: () => Promise<MiniPlayerWindowState>
        isCursorInsideWindow: () => Promise<boolean>
        setVisualizerMode: (mode: MiniPlayerVisualizerMode) => Promise<MiniPlayerWindowState>
        toggleAlwaysOnTop: () => Promise<MiniPlayerWindowState>
        getSnapshot: () => Promise<MiniPlayerSnapshot | null>
        publishSnapshot: (snapshot: MiniPlayerSnapshot) => void
        publishQueueSnapshot: (snapshot: MiniPlayerQueueSnapshot) => void
        publishVisualizerChunk: (chunk: MiniPlayerVisualizerStreamChunk) => void
        sendCommand: (command: MiniPlayerCommand) => void
        onSnapshot: (callback: (snapshot: MiniPlayerSnapshot) => void) => () => void
        onCommand: (callback: (command: MiniPlayerCommand) => void) => () => void
        onWindowState: (callback: (state: MiniPlayerWindowState) => void) => () => void
        onVisualizerChunk: (callback: (chunk: MiniPlayerVisualizerStreamChunk) => void) => () => void
      }
      companionApi: {
        onCommand: (callback: (command: CompanionApiRendererCommand) => void) => () => void
      }
      lyricsPopout: {
        open: () => Promise<void>
        close: () => Promise<void>
        getWindowState: () => Promise<LyricsPopoutWindowState>
        getSnapshot: () => Promise<LyricsPopoutSnapshot | null>
        publishSnapshot: (snapshot: LyricsPopoutSnapshot) => void
        sendCommand: (command: LyricsPopoutCommand) => void
        onSnapshot: (callback: (snapshot: LyricsPopoutSnapshot) => void) => () => void
        onCommand: (callback: (command: LyricsPopoutCommand) => void) => () => void
        onWindowState: (callback: (state: LyricsPopoutWindowState) => void) => () => void
      }
      scopePopout: {
        open: (scope: ScopeKind) => Promise<ScopePopoutState>
        recall: (scope: ScopeKind) => Promise<ScopePopoutState>
        getState: () => Promise<ScopePopoutState>
        publishChunk: (chunk: ScopePopoutChunk) => void
        onState: (callback: (state: ScopePopoutState) => void) => () => void
        onChunk: (callback: (chunk: ScopePopoutChunk) => void) => () => void
      }

      // Platform
      platform: NodeJS.Platform
      getAppVersion: () => Promise<string>
      getAppBuildInfo: () => Promise<AppBuildInfo>
      getAppPerformanceStats: () => Promise<AppPerformanceStats>
      getMainProcessMemoryStats: () => Promise<MainProcessMemoryStats>
      getRendererMemoryStats: () => Promise<RendererMemoryStats>
      diagnostics: {
        getStatus: () => Promise<MemoryDiagnosticsStatus>
        setEnabled: (enabled: boolean) => Promise<MemoryDiagnosticsStatus>
        revealCurrentLog: () => Promise<boolean>
        revealPreviousLog: () => Promise<boolean>
        captureMemoryBundle: (tag?: string) => Promise<MemoryDiagnosticsCaptureBundleResult>
        getBlinkResourceUsage: () => MemoryDiagnosticsBlinkResourceUsageSnapshot
        clearRendererCache: () => void
        publishRendererSnapshot: (requestId: string, snapshot: MemoryDiagnosticsRendererSnapshot) => void
        logEvent: (payload: MemoryDiagnosticsEventPayload) => Promise<boolean>
        onStatus: (callback: (status: MemoryDiagnosticsStatus) => void) => () => void
        onSnapshotRequest: (callback: (request: MemoryDiagnosticsSnapshotRequest) => void) => () => void
      }
      updates: {
        checkForUpdates: () => Promise<UpdateCheckResult>
        openReleasesPage: (releaseUrl?: string) => Promise<boolean>
      }
      theme: {
        setRuntimeIconDataUrl: (payload: string | RuntimeIconImageSetPayload) => void
      }
      inputBindings: {
        configureGlobal: (requests: GlobalShortcutRegistrationRequest[]) => Promise<GlobalShortcutRegistrationResult[]>
        onInput: (callback: (input: RawBindingInput) => void) => () => void
        onGlobalAction: (callback: (actionId: InputActionId) => void) => () => void
      }

      // Integrations
      discord: {
        configure: (options: DiscordRpcConfigureOptions) => Promise<DiscordRpcConfigureResult>
        updatePresence: (update: DiscordPresenceUpdate) => void
        clearPresence: () => void
        resolveCoverArt: (query: DiscordCoverArtLookupQuery) => Promise<DiscordCoverArtLookupResult>
      }
      localApi: {
        getStatus: () => Promise<LocalApiStatus>
        setEnabled: (enabled: boolean) => Promise<LocalApiStatus>
        setControlsEnabled: (enabled: boolean) => Promise<LocalApiStatus>
        setLibrarySearchEnabled: (enabled: boolean) => Promise<LocalApiStatus>
        setLibraryWriteEnabled: (enabled: boolean) => Promise<LocalApiStatus>
        setPort: (port: number) => Promise<LocalApiStatus>
        rotateToken: () => Promise<LocalApiStatus>
        resetToDefaults: () => Promise<LocalApiStatus>
        onStatus: (callback: (status: LocalApiStatus) => void) => () => void
      }
      phoneRemote: {
        getStatus: () => Promise<PhoneRemoteStatus>
        createPairingTicket: (baseUrl?: string, clientKind?: PhoneRemoteClientKind) => Promise<PhoneRemotePairingTicket>
        listPairedDevices: () => Promise<PhoneRemotePairedDevice[]>
        listPendingPairingRequests: () => Promise<PhoneRemotePendingPairingRequest[]>
        approvePairingRequest: (id: string, grantedScopes?: CompanionApiScope[]) => Promise<PhoneRemotePendingPairingRequest | null>
        rejectPairingRequest: (id: string) => Promise<PhoneRemotePendingPairingRequest | null>
        revokePairedDevice: (id: string) => Promise<PhoneRemotePairedDevice | null>
        revokeAllPairedDevices: () => Promise<number>
        setEnabled: (enabled: boolean) => Promise<PhoneRemoteStatus>
        setPort: (port: number) => Promise<PhoneRemoteStatus>
        setSyncEnabled: (enabled: boolean) => Promise<PhoneRemoteStatus>
        requestSync: () => Promise<PhoneRemoteStatus>
        resolveSyncConflict: (syncUid: string, resolution: PhoneSyncConflictResolution) => Promise<PhoneRemoteStatus>
        resetToDefaults: () => Promise<PhoneRemoteStatus>
        onStatus: (callback: (status: PhoneRemoteStatus) => void) => () => void
      }
      parallax: {
        useHostPredictor: boolean
        launchInZoneMode: boolean
        getStatus: () => Promise<ParallaxStatus>
        getEndpointIdentity: () => Promise<{ hostname: string; lanIps: string[] }>
        fetchSinkArtwork: (streamId: string) => Promise<string | null>
        requestSinkTrimUpdate: (
          outputDeviceId: string,
          outputDeviceLabel: string | null,
          advanceMs: number
        ) => Promise<boolean>
        listPairedSinks: () => Promise<ParallaxPairedSink[]>
        setHostEnabled: (enabled: boolean) => Promise<ParallaxStatus>
        setSinkEnabled: (enabled: boolean) => Promise<ParallaxStatus>
        startDiscoveryBrowse: () => Promise<{ ok: true }>
        stopDiscoveryBrowse: () => Promise<{ ok: true }>
        onDiscoveryEvent: (callback: (event: ParallaxDiscoveryEvent) => void) => () => void
        initiatePair: (sinkBaseUrl: string) => Promise<{
          pairingId: string
          sinkParallaxEndpointUuid: string | null
          sinkName: string
          expiresInSeconds: number
        }>
        submitPairPin: (
          pairingId: string,
          pin: string,
          sinkName?: string
        ) => Promise<{ sinkId: string; sinkName: string; sinkParallaxEndpointUuid: string | null }>
        cancelPair: (pairingId: string) => Promise<{ ok: boolean }>
        cancelIncomingPair: () => Promise<{ ok: true }>
        approveIncomingPair: () => Promise<{ ok: boolean }>
        setHostPort: (port: number) => Promise<ParallaxStatus>
        disconnectSink: () => Promise<ParallaxStatus>
        publishHostStreamStart: (
          info: ParallaxHostStreamStartInfo,
          options?: ParallaxHostStreamStartOptions
        ) => Promise<ParallaxTimelineState>
        publishHostNextStreamStart: (
          info: ParallaxHostStreamStartInfo,
          options: ParallaxHostNextStreamStartOptions
        ) => Promise<ParallaxTimelineState>
        publishHostNextStreamCancel: () => Promise<void>
        publishHostPromoteNextStream: () => Promise<ParallaxTimelineState | null>
        publishHostAudioChunk: (chunk: ParallaxAudioChunk) => Promise<void>
        publishHostTimeline: (timeline: ParallaxTimelineState, options?: ParallaxHostTimelinePublishOptions) => Promise<void>
        publishHostEmitAnchor: (anchor: Omit<Extract<ParallaxTimelineEvent, { type: 'host-emit-anchor' }>, 'emittedAtHostTimeMs'>) => Promise<void>
        stopHostStream: () => Promise<void>
        publishSinkTelemetry: (telemetry: ParallaxSinkTelemetry) => Promise<void>
        reportHostLatency: (metrics: ParallaxOutputLatencyMetrics) => Promise<void>
        revokePairedSink: (id: string) => Promise<ParallaxPairedSink | null>
        renamePairedSink: (id: string, name: string) => Promise<ParallaxPairedSink | null>
        setSinkPlaybackEnabled: (id: string, enabled: boolean) => Promise<ParallaxStatus>
        setAllSinksPlaybackEnabled: (enabled: boolean) => Promise<ParallaxStatus>
        revokeAllPairedSinks: () => Promise<number>
        clearHostPresenceCache: (sinkId?: string) => Promise<ParallaxStatus>
        resetToDefaults: () => Promise<ParallaxStatus>
        setSinkTrim: (
          sinkId: string,
          outputDeviceId: string,
          outputDeviceLabel: string | null,
          advanceMs: number
        ) => Promise<ParallaxStatus>
        forgetSinkConnection: () => Promise<ParallaxStatus>
        reconnectFromPersisted: () => Promise<ParallaxStatus>
        startAutoReconnect: () => Promise<{ scheduled: boolean; reason?: 'no-persisted-connection' | 'host-mode-active' }>
        onSinkPaired: (callback: () => void) => () => void
        onStatus: (callback: (status: ParallaxStatus) => void) => () => void
        onEvent: (callback: (event: ParallaxTimelineEvent) => void) => () => void
        onAudioChunk: (callback: (chunk: ParallaxAudioChunk) => void) => () => void
      }
      lastFm: {
        getStatus: () => Promise<LastFmStatus>
        setEnabled: (enabled: boolean) => Promise<LastFmStatus>
        createCustomProfile: (input: LastFmCustomProfileInput) => Promise<LastFmStatus>
        updateCustomProfile: (profileId: string, input: LastFmCustomProfileInput) => Promise<LastFmStatus>
        deleteCustomProfile: (profileId: string) => Promise<LastFmStatus>
        setActiveProfile: (profileId: string) => Promise<LastFmStatus>
        setProfileEnabled: (profileId: string, enabled: boolean) => Promise<LastFmStatus>
        beginAuth: (profileId?: string) => Promise<LastFmAuthStartResult>
        finishAuth: () => Promise<LastFmAuthFinishResult>
        disconnect: () => Promise<LastFmStatus>
        disconnectProfile: (profileId: string) => Promise<LastFmStatus>
        resetToDefaults: () => Promise<LastFmStatus>
        onStatus: (callback: (status: LastFmStatus) => void) => () => void
      }
      lyrics: {
        getStatus: () => Promise<LyricsStatus>
        setEnabled: (enabled: boolean) => Promise<LyricsStatus>
        setLrclibBaseUrl: (baseUrl: string) => Promise<LyricsStatus>
        getForTrack: (query: LyricsTrackQuery) => Promise<LyricsLookupResult>
        refreshForTrack: (query: LyricsTrackQuery) => Promise<LyricsLookupResult>
        getTrackOverride: (trackPath: string) => Promise<LyricsTrackOverride>
        importManualLyrics: (trackPaths: string[], lyricsText: string, format?: LyricsFormat) => Promise<LyricsManualImportResult>
        clearManualLyrics: (trackPaths: string[]) => Promise<LyricsManualClearResult>
        setTrackOffset: (trackPaths: string[], offsetMs: number) => Promise<LyricsOffsetSetResult>
        resetToDefaults: () => Promise<LyricsStatus>
        onStatus: (callback: (status: LyricsStatus) => void) => () => void
      }
      subsonic: {
        listSources: () => Promise<SubsonicSource[]>
        createSource: (input: SubsonicSourceCreateInput) => Promise<SubsonicSource>
        updateSource: (sourceId: number, input: SubsonicSourceUpdateInput) => Promise<SubsonicSource>
        deleteSource: (sourceId: number, purgeTracks: boolean) => Promise<void>
        testSource: (input: SubsonicSourceTestInput) => Promise<SubsonicSourceTestResult>
        syncSource: (sourceId: number, syncSessionKey?: string) => Promise<void>
        syncAll: (syncSessionKey?: string) => Promise<void>
        getStatus: () => Promise<SubsonicStatusSnapshot>
        onStatus: (callback: (status: SubsonicStatusSnapshot) => void) => () => void
      }
      jellyfin: {
        listSources: () => Promise<JellyfinSource[]>
        createSource: (input: JellyfinSourceCreateInput) => Promise<JellyfinSource>
        updateSource: (sourceId: number, input: JellyfinSourceUpdateInput) => Promise<JellyfinSource>
        deleteSource: (sourceId: number, purgeTracks: boolean) => Promise<void>
        testSource: (input: JellyfinSourceTestInput) => Promise<JellyfinSourceTestResult>
        syncSource: (sourceId: number, syncSessionKey?: string) => Promise<void>
        syncAll: (syncSessionKey?: string) => Promise<void>
        getStatus: () => Promise<JellyfinStatusSnapshot>
        onStatus: (callback: (status: JellyfinStatusSnapshot) => void) => () => void
      }

      // File operations
      openAudioFile: () => Promise<AudioFileResult | null>
      openAudioFolder: () => Promise<string | null>
      loadAudioFile: (filePath: string, options?: AudioLoadOptions) => Promise<AudioFileResult | null>
      getSpatialWasmBytes: () => Promise<ArrayBuffer>
      getIamfWasmBytes: () => Promise<ArrayBuffer>
      getAudioMetadata: (filePath: string) => Promise<AudioFileMetadata | null>
      getAudioFileStat: (filePath: string) => Promise<AudioFileStatResult | null>
      decodeAudioWithFfmpeg: (filePath: string) => Promise<ArrayBuffer | null>
      analyzeTrackLoudness: (filePath: string) => Promise<TrackLoudnessResult | null>
      warmupTrackLoudness: (filePath: string) => Promise<TrackLoudnessResult | null>
      storeTrackLoudness: (filePath: string, payload: TrackLoudnessStorePayload) => Promise<boolean>
      startProgressiveStream: (
        filePath: string,
        outputSampleRate: number,
        expectedChannels?: number | null,
        options?: ProgressiveStreamStartOptions
      ) => Promise<ProgressiveStreamInfo>
      cancelProgressiveStream: (sessionId: number) => Promise<void>
      startRemoteStream: (filePath: string, outputSampleRate: number, expectedChannels?: number | null) => Promise<RemoteStreamInfo>
      cancelRemoteStream: (sessionId: number) => Promise<void>
      getReplayGainScanEnabled: () => Promise<boolean>
      setReplayGainScanEnabled: (enabled: boolean) => Promise<boolean>
      onRemoteLoadProgress: (callback: (progress: RemoteAudioLoadProgress) => void) => () => void
      onProgressiveLoadProgress: (callback: (progress: ProgressiveAudioLoadProgress) => void) => () => void
      onRemoteStreamChunk: (callback: (chunk: RemoteStreamChunk) => void) => () => void
      onProgressiveStreamChunk: (callback: (chunk: ProgressiveStreamChunk) => void) => () => void
      onRemoteStreamEvent: (callback: (payload: RemoteStreamEvent) => void) => () => void
      onProgressiveStreamEvent: (callback: (payload: ProgressiveStreamEvent) => void) => () => void

      // Generic file dialogs & I/O
      showSaveDialog: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
      openFileDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
      readTextFile: (filePath: string) => Promise<string>
      readFileAsDataUrl: (filePath: string) => Promise<string | null>
      writeSettingsTransferFile: (filePath: string, content: string) => Promise<boolean>
      writeFile: (filePath: string, content: string) => Promise<boolean>
      revealFileInFolder: (filePath: string) => Promise<boolean>

      statsShare: {
        copyPng: (bytes: Uint8Array) => Promise<boolean>
        savePng: (bytes: Uint8Array, suggestedFileName: string) => Promise<string | null>
      }
      signalShare: {
        copyPng: (bytes: Uint8Array) => Promise<boolean>
        savePng: (bytes: Uint8Array, suggestedFileName: string) => Promise<string | null>
      }

      // Library operations
      library: {
        getTracks: () => Promise<DbTrack[]>
        getTracksPage: (request?: LibraryTrackPageRequest) => Promise<LibraryTrackPage>
        getTracksByPaths: (trackPaths: string[]) => Promise<DbTrack[]>
        getTracksByArtist: (artist: string, mode?: LibraryArtistBrowseMode) => Promise<DbTrack[]>
        getTracksByGenre: (genre: string) => Promise<DbTrack[]>
        getTracksByYear: (year: number | null) => Promise<DbTrack[]>
        getTracksByAlbum: (album: string, artist?: string, identityKey?: string) => Promise<DbTrack[]>
        getArtists: (mode?: LibraryArtistBrowseMode) => Promise<Artist[]>
        getGenres: () => Promise<Genre[]>
        setArtistImageFromFile: (artist: string, mode: LibraryArtistBrowseMode, imagePath: string) => Promise<void>
        clearArtistImage: (artist: string, mode: LibraryArtistBrowseMode) => Promise<void>
        getAlbums: (options?: AlbumListOptions) => Promise<Album[]>
        search: (query: string) => Promise<DbTrack[]>
        getMetadataOverridePaths: () => Promise<string[]>
        clearMetadataOverrides: (trackPaths: string[]) => Promise<{ cleared: number }>
        saveMetadataEdits: (request: MetadataEditRequest) => Promise<MetadataEditResult>
        getTrackOverrideFields: (trackPaths: string[]) => Promise<Record<string, string[]>>
        getTrackOverrideSnapshots: (trackPaths: string[]) => Promise<Record<string, TrackOverrideSnapshot | null>>
        restoreTrackOverrides: (overrides: Record<string, TrackOverrideSnapshot | null>) => Promise<void>
        getFolders: () => Promise<LibraryFolder[]>
        getFolderSubfolderSummary: (folderPath: string) => Promise<FolderSubfolderSummary>
        listFolderSubdirectories: (folderPath: string, parentRelativePath?: string) => Promise<FolderSubdirectoryEntry[]>
        addFolderWithoutScan: (folderPath: string) => Promise<{
          success: boolean
          folder?: LibraryFolder
          summary?: FolderSubfolderSummary
          error?: string
        }>
        setFolderSubfolderExcluded: (
          folderPath: string,
          relativePath: string,
          excluded: boolean
        ) => Promise<{
          success: boolean
          summary?: FolderSubfolderSummary
          error?: string
        }>
        rescanFolder: (folderPath: string) => Promise<{
          success: boolean
          canceled?: boolean
          added?: number
          updated?: number
          errors?: number
          removed?: number
          skippedDirs?: string[]
          summary?: FolderSubfolderSummary
          scanIssueLog?: ScanIssueLog
        }>
        addFolder: (folderPath: string) => Promise<{
          success: boolean
          canceled?: boolean
          added?: number
          updated?: number
          errors?: number
          skippedDirs?: string[]
          scanIssueLog?: ScanIssueLog
          error?: string
        }>
        removeFolder: (folderPath: string) => Promise<{ success: boolean }>
        setFolderHidden: (folderPath: string, hidden: boolean) => Promise<{ success: boolean; error?: string }>
        backfillReplayGainMetadata: () => Promise<{
          scanned: number
          updated: number
          errors: number
          canceled?: boolean
          scanIssueLog?: ScanIssueLog
        }>
        cancelScan: () => Promise<{ canceled: boolean }>
        startIntegrityScan: (request: { mode: IntegrityScanMode; scope: IntegrityScanScope }) => Promise<IntegrityScanResult>
        cancelIntegrityScan: () => Promise<{ canceled: boolean }>
        trashIntegrityDuplicates: (request: IntegrityDuplicateTrashRequest) => Promise<IntegrityDuplicateTrashResult>
        checkTrackIntegrity: (trackPath: string) => Promise<IntegrityScanResult>
        checkTracksIntegrity: (trackPaths: string[]) => Promise<IntegrityScanResult>
        resetMappedFolders: () => Promise<{ success: boolean; clearedFolders: number; clearedTracks: number }>
        factoryReset: () => Promise<{ success: boolean }>
        rescan: () => Promise<{
          added: number
          updated: number
          errors: number
          removed?: number
          folderWarnings?: Record<string, string[]>
          scanIssueLog?: ScanIssueLog
          canceled?: boolean
        }>
        forceRescanAll: () => Promise<{
          added: number
          updated: number
          errors: number
          removed?: number
          folderWarnings?: Record<string, string[]>
          scanIssueLog?: ScanIssueLog
          canceled?: boolean
        }>
        getTrackCount: () => Promise<number>
        getTotalTrackDuration: () => Promise<number>
        getArtworkPath: (hash: string) => Promise<string>
        getArtworkDataUrl: (hash: string) => Promise<string | null>
        getArtworkThumbnailDataUrl: (hash: string) => Promise<string | null>
        getArtworkCardDataUrl: (hash: string) => Promise<string | null>
        onScanProgress: (callback: (progress: ScanProgress) => void) => () => void
        onScanStage: (callback: (progress: ScanStageProgress) => void) => () => void
        onIntegrityScanProgress: (callback: (progress: IntegrityScanProgress) => void) => () => void
        onIntegrityScanFinding: (callback: (finding: IntegrityFinding) => void) => () => void
        onIntegrityScanComplete: (callback: (result: IntegrityScanResult) => void) => () => void
        onFileCreatedAtBackfillComplete: (callback: (result: { scanned: number; updated: number; errors: number }) => void) => () => void
        onAudioMetadataBackfillComplete: (callback: (result: { scanned: number; updated: number; errors: number }) => void) => () => void
        onMetadataEditProgress: (callback: (progress: { current: number; total: number; trackPath: string }) => void) => () => void
        onExternalLibraryMutation: (callback: () => void) => () => void

        // Favorites
        getFavorites: () => Promise<DbTrack[]>
        getFavoritePaths: () => Promise<string[]>
        addFavorite: (trackPath: string) => Promise<void>
        removeFavorite: (trackPath: string) => Promise<void>

        // Track ratings
        getTrackRatings: () => Promise<TrackRatingEntry[]>
        setTrackRating: (trackPaths: string[], rating: number | null) => Promise<void>
        resetTrackRatings: () => Promise<{ success: boolean; cleared: number }>

        // Recently played
        getRecentlyPlayed: (limit?: number) => Promise<DbTrack[]>
        markTrackLatestSyncSeen: (trackPath: string) => Promise<void>
        addRecentlyPlayed: (trackPath: string) => Promise<void>
        getListeningHistoryStatus: () => Promise<ListeningHistoryStatus>
        checkpointListeningSession: (checkpoint: ListeningSessionCheckpoint) => Promise<ListeningSessionCheckpointResult>
        getListeningStatsDashboard: (query: ListeningStatsQuery) => Promise<ListeningStatsDashboard>
        clearDetailedListeningHistory: () => Promise<ListeningHistoryStatus>

        // Listening stats transfer (settings import/export)
        getListeningStatsTransferAvailability: () => Promise<ListeningStatsTransferAvailability>
        exportListeningStatsTransfer: (request?: ListeningStatsExportRequest) => Promise<ListeningStatsExportBundle>
        applyListeningStatsTransfer: (request: ListeningStatsApplyRequest) => Promise<ListeningStatsImportResult>
        readListeningImportFile: (filePath: string) => Promise<ListeningImportPreview>
        applyListeningImportFile: (filePath: string) => Promise<ListeningStatsImportResult>
        getImportedListeningSources: () => Promise<ImportedListeningSource[]>
        removeImportedListeningSource: (source: string) => Promise<ImportedListeningSourceRemoval>

        // Playlists
        getPlaylists: () => Promise<Playlist[]>
        createPlaylist: (name: string) => Promise<Playlist>
        createDynamicPlaylist: (name: string, rules: DynamicPlaylistRulesV1) => Promise<Playlist>
        getDynamicPlaylistRules: (playlistId: number) => Promise<DynamicPlaylistRulesV1>
        updateDynamicPlaylistRules: (playlistId: number, rules: DynamicPlaylistRulesV1) => Promise<void>
        previewDynamicPlaylist: (rules: DynamicPlaylistRulesV1) => Promise<DynamicPlaylistPreview>
        renamePlaylist: (id: number, name: string) => Promise<void>
        deletePlaylist: (id: number) => Promise<void>
        getPlaylistTracks: (playlistId: number) => Promise<DbTrack[]>
        getPlaylistTrackEntries: (playlistId: number) => Promise<PlaylistTrackEntry[]>
        addToPlaylist: (playlistId: number, trackPaths: string[]) => Promise<void>
        removeFromPlaylist: (playlistId: number, trackPath: string) => Promise<void>
        removePlaylistEntry: (playlistId: number, entryId: number) => Promise<void>
        reassociatePlaylistEntry: (playlistId: number, entryId: number, targetTrackPath: string) => Promise<void>
        reorderPlaylistEntries: (playlistId: number, orderedEntryIds: number[]) => Promise<void>
        markPlaylistPlayed: (playlistId: number) => Promise<void>
        setPlaylistCustomCoverFromFile: (playlistId: number, imagePath: string) => Promise<void>
        clearPlaylistCustomCover: (playlistId: number) => Promise<void>
        getPlaylistsContainingTrack: (trackPath: string) => Promise<number[]>
        getPlaylistsContainingTracks: (trackPaths: string[]) => Promise<Array<{ playlistId: number; matchedTrackCount: number }>>
        importPlaylistFromFile: (filePath: string) => Promise<PlaylistImportResult>
        exportPlaylistToM3u: (playlistId: number, filePath: string) => Promise<PlaylistExportResult>
      }
    }

    // Native Visualizer API - exposed as visualizerAPI global
    visualizerAPI: VisualizerDSP | null

    // Load state for the native visualizer addon. `available` mirrors `visualizerAPI !== null`;
    // `reason` carries the preload's load-failure message when it didn't load.
    visualizerAddonStatus: { available: boolean; reason: string | null }

    // §22 Commit 1 — Parallax loopback (Windows-only). Null on platforms / builds where the
    // native module didn't load or the loopback exports aren't present.
    parallaxLoopbackAPI: ParallaxLoopbackNative | null
  }
}

export interface ParallaxLoopbackCapturedSegment {
  firstFrameIndex: number
  captureWallMs: number
  frameCount: number
  channelCount: number
  pcm: Float32Array
}

export interface ParallaxLoopbackEndpointInfo {
  deviceId: string
  deviceName: string
  sampleRate: number
  channelCount: number
}

export interface ParallaxLoopbackNative {
  isSupported(): { supported: boolean; reason?: string }
  wallNowMs(): number
  start(): { ok: boolean; endpoint?: ParallaxLoopbackEndpointInfo; error?: string }
  stop(): void
  drain(): ParallaxLoopbackCapturedSegment[]
  isRunning(): boolean
}
