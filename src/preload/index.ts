import { contextBridge, ipcRenderer } from 'electron'
import { join } from 'path'
import type {
  MiniPlayerCommand,
  MiniPlayerSnapshot,
  MiniPlayerVisualizerMode,
  MiniPlayerVisualizerStreamChunk,
  MiniPlayerWindowState
} from '../types/miniPlayer'
import type {
  ScopeKind,
  ScopePopoutChunk,
  ScopePopoutState
} from '../types/scopePopout'
import type {
  LocalApiStatus
} from '../types/localApi'
import type {
  LastFmAuthFinishResult,
  LastFmAuthStartResult,
  LastFmStatus
} from '../types/lastFm'
import type {
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
  NativeAudioCapabilities,
  NativeAudioEvent,
  NativeAudioPlaybackSnapshot,
  NativeAudioSampleFormat,
  NativeAudioTrackLoadResult,
  NativeAudioTrackMetadata,
  NativeAudioVectorscopeChunk
} from '../types/nativeAudio'
import { createNativeAudioController } from './nativeAudioController'

export interface AudioFileMetadata {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  year?: number
  trackNumber?: number
  duration?: number
  format?: string
  sampleRate?: number
  channels?: number
  codec?: string
  codecProfile?: string
  isAtmosJoc?: boolean
  replayGainTrackDb?: number
  replayGainAlbumDb?: number
  artwork?: string
}

// Audio file result from main process
export interface AudioFileResult {
  path: string
  name: string
  data: ArrayBuffer
  metadata?: AudioFileMetadata
}

export interface AudioLoadOptions {
  metadataMode?: 'full' | 'none'
}

export interface RemoteAudioLoadProgress {
  path: string
  sourceType: 'subsonic' | 'jellyfin'
  stage: 'downloading'
  loadedBytes: number
  totalBytes: number | null
  chunkCount: number
  percent: number | null
  done: boolean
  failed: boolean
}

// Library types
export interface DbTrack {
  id: number
  path: string
  title: string
  artist: string
  album: string
  album_artist: string | null
  duration: number
  track_number: number | null
  disc_number: number | null
  year: number | null
  genre: string | null
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
  added_at: number
  modified_at: number
}

export interface LibraryFolder {
  id: number
  path: string
  added_at: number
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
  year: number | null
  artwork_hash: string | null
  track_count: number
}

export interface Artist {
  artist: string
  track_count: number
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
  created_at: number
  updated_at: number
  last_played_at: number | null
  custom_cover_hash: string | null
  auto_cover_hash: string | null
  track_count: number
}

export type PlaylistImportDetectedFormat = 'csv' | 'm3u' | 'm3u8' | 'xspf' | 'wpl' | 'asx'

export interface PlaylistImportResult {
  sourceFilePath: string
  detectedFormat: PlaylistImportDetectedFormat
  playlistId: number | null
  playlistName: string | null
  entriesTotal: number
  importedCount: number
  matchedByPathCount: number
  matchedByMetadataCount: number
  unmatchedCount: number
  ambiguousMetadataCount: number
  unsupportedEntryCount: number
  warnings: string[]
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
  memoryMb: number
}

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

interface NativeAudioAddonPlayback {
  getCapabilities(): NativeAudioCapabilities
  setOutputDevice(deviceId: string): NativeAudioCapabilities
  loadTrack(
    pcmData: Uint8Array,
    sampleRate: number,
    channels: number,
    sampleFormat: NativeAudioSampleFormat,
    duration: number
  ): NativeAudioPlaybackSnapshot
  preloadNextTrack(
    pcmData: Uint8Array,
    sampleRate: number,
    channels: number,
    sampleFormat: NativeAudioSampleFormat,
    duration: number
  ): void
  play(): NativeAudioPlaybackSnapshot
  pause(): NativeAudioPlaybackSnapshot
  stop(): NativeAudioPlaybackSnapshot
  seek(seconds: number): NativeAudioPlaybackSnapshot
  clearNextTrack(): void
  getPlaybackSnapshot(): NativeAudioPlaybackSnapshot
  drainEvents(): NativeAudioEvent[]
  flushOscilloscopeSamples(): Float32Array | null
  flushSpectrumSamples(): Float32Array | null
  flushVectorscopeSamples(): { left: Float32Array; right: Float32Array } | null
}

interface NativeAddonModule extends VisualizerDSP {
  playback?: NativeAudioAddonPlayback
}

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
    setVisualizerMode: (mode: MiniPlayerVisualizerMode) => ipcRenderer.invoke('mini-player:setVisualizerMode', mode),
    toggleAlwaysOnTop: () => ipcRenderer.invoke('mini-player:toggleAlwaysOnTop'),
    getSnapshot: () => ipcRenderer.invoke('mini-player:getSnapshot'),
    publishSnapshot: (snapshot: MiniPlayerSnapshot) => ipcRenderer.send('mini-player:publishSnapshot', snapshot),
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
  getAppPerformanceStats: () => ipcRenderer.invoke('app:getPerformanceStats'),

  updates: {
    checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('updates:check'),
    openReleasesPage: (releaseUrl?: string) => ipcRenderer.invoke('updates:openReleasesPage', releaseUrl)
  },

  theme: {
    setRuntimeIconDataUrl: (dataUrl: string) => ipcRenderer.send('theme:setRuntimeIconDataUrl', dataUrl),
  },

  // Integrations
  discord: {
    configure: (options: { enabled: boolean; coverArtEnabled: boolean }): Promise<DiscordRpcConfigureResult> =>
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
    setPort: (port: number): Promise<LocalApiStatus> => ipcRenderer.invoke('local-api:setPort', port),
    rotateToken: (): Promise<LocalApiStatus> => ipcRenderer.invoke('local-api:rotateToken'),
    resetToDefaults: (): Promise<LocalApiStatus> => ipcRenderer.invoke('local-api:resetToDefaults'),
    onStatus: (callback: (status: LocalApiStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: LocalApiStatus) => callback(status)
      ipcRenderer.on('local-api:status', handler)
      return () => ipcRenderer.removeListener('local-api:status', handler)
    }
  },

  lastFm: {
    getStatus: (): Promise<LastFmStatus> => ipcRenderer.invoke('lastfm:getStatus'),
    setEnabled: (enabled: boolean): Promise<LastFmStatus> => ipcRenderer.invoke('lastfm:setEnabled', enabled),
    beginAuth: (): Promise<LastFmAuthStartResult> => ipcRenderer.invoke('lastfm:beginAuth'),
    finishAuth: (): Promise<LastFmAuthFinishResult> => ipcRenderer.invoke('lastfm:finishAuth'),
    disconnect: (): Promise<LastFmStatus> => ipcRenderer.invoke('lastfm:disconnect'),
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
    getForTrack: (query: LyricsTrackQuery): Promise<LyricsLookupResult> => ipcRenderer.invoke('lyrics:getForTrack', query),
    refreshForTrack: (query: LyricsTrackQuery): Promise<LyricsLookupResult> =>
      ipcRenderer.invoke('lyrics:refreshForTrack', query),
    getTrackOverride: (trackPath: string): Promise<LyricsTrackOverride> =>
      ipcRenderer.invoke('lyrics:getTrackOverride', trackPath),
    importManualLyrics: (trackPaths: string[], lyricsText: string): Promise<LyricsManualImportResult> =>
      ipcRenderer.invoke('lyrics:importManualLyrics', trackPaths, lyricsText),
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
    syncSource: (sourceId: number): Promise<void> => ipcRenderer.invoke('subsonic:syncSource', sourceId),
    syncAll: (): Promise<void> => ipcRenderer.invoke('subsonic:syncAll'),
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
    syncSource: (sourceId: number): Promise<void> => ipcRenderer.invoke('jellyfin:syncSource', sourceId),
    syncAll: (): Promise<void> => ipcRenderer.invoke('jellyfin:syncAll'),
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
  getAudioMetadata: (filePath: string) => ipcRenderer.invoke('audio:getMetadata', filePath) as Promise<AudioFileMetadata | null>,
  decodeAudioWithFfmpeg: (filePath: string) => ipcRenderer.invoke('audio:decodeWithFfmpeg', filePath),
  getReplayGainScanEnabled: () => ipcRenderer.invoke('audio:getReplayGainScanEnabled') as Promise<boolean>,
  setReplayGainScanEnabled: (enabled: boolean) => ipcRenderer.invoke('audio:setReplayGainScanEnabled', enabled) as Promise<boolean>,
  onRemoteLoadProgress: (callback: (progress: RemoteAudioLoadProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: RemoteAudioLoadProgress) => callback(progress)
    ipcRenderer.on('audio:remoteLoadProgress', handler)
    return () => ipcRenderer.removeListener('audio:remoteLoadProgress', handler)
  },

  // Generic file dialogs & I/O
  showSaveDialog: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('dialog:showSaveDialog', options),
  openFileDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('dialog:openFile', options),
  readTextFile: (filePath: string) => ipcRenderer.invoke('fs:readTextFile', filePath),
  readFileAsDataUrl: (filePath: string) => ipcRenderer.invoke('fs:readDataUrl', filePath) as Promise<string | null>,
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeTextFile', filePath, content),
  revealFileInFolder: (filePath: string) => ipcRenderer.invoke('fs:revealFileInFolder', filePath) as Promise<boolean>,

  // Library operations
  library: {
    getTracks: () => ipcRenderer.invoke('library:getTracks'),
    getTracksByArtist: (artist: string, mode?: LibraryArtistBrowseMode) =>
      ipcRenderer.invoke('library:getTracksByArtist', artist, mode),
    getTracksByAlbum: (album: string, artist?: string, identityKey?: string) =>
      ipcRenderer.invoke('library:getTracksByAlbum', album, artist, identityKey),
    getArtists: (mode?: LibraryArtistBrowseMode) => ipcRenderer.invoke('library:getArtists', mode),
    getAlbums: () => ipcRenderer.invoke('library:getAlbums'),
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
    backfillReplayGainMetadata: () => ipcRenderer.invoke('library:backfillReplayGainMetadata') as Promise<{
      scanned: number
      updated: number
      errors: number
      canceled?: boolean
      scanIssueLog?: ScanIssueLog
    }>,
    cancelScan: () => ipcRenderer.invoke('library:cancelScan') as Promise<{ canceled: boolean }>,
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
    getTrackCount: () => ipcRenderer.invoke('library:getTrackCount'),
    getArtworkPath: (hash: string) => ipcRenderer.invoke('library:getArtworkPath', hash),
    getArtworkDataUrl: (hash: string) => ipcRenderer.invoke('library:getArtworkDataUrl', hash),
    getArtworkThumbnailDataUrl: (hash: string) => ipcRenderer.invoke('library:getArtworkThumbnailDataUrl', hash),
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

    // Favorites
    getFavorites: () => ipcRenderer.invoke('library:getFavorites'),
    getFavoritePaths: () => ipcRenderer.invoke('library:getFavoritePaths'),
    addFavorite: (trackPath: string) => ipcRenderer.invoke('library:addFavorite', trackPath),
    removeFavorite: (trackPath: string) => ipcRenderer.invoke('library:removeFavorite', trackPath),

    // Recently played
    getRecentlyPlayed: (limit?: number) => ipcRenderer.invoke('library:getRecentlyPlayed', limit),
    addRecentlyPlayed: (trackPath: string) => ipcRenderer.invoke('library:addRecentlyPlayed', trackPath),

    // Playlists
    getPlaylists: () => ipcRenderer.invoke('library:getPlaylists'),
    createPlaylist: (name: string) => ipcRenderer.invoke('library:createPlaylist', name),
    renamePlaylist: (id: number, name: string) => ipcRenderer.invoke('library:renamePlaylist', id, name),
    deletePlaylist: (id: number) => ipcRenderer.invoke('library:deletePlaylist', id),
    getPlaylistTracks: (playlistId: number) => ipcRenderer.invoke('library:getPlaylistTracks', playlistId),
    addToPlaylist: (playlistId: number, trackPaths: string[]) => ipcRenderer.invoke('library:addToPlaylist', playlistId, trackPaths),
    removeFromPlaylist: (playlistId: number, trackPath: string) => ipcRenderer.invoke('library:removeFromPlaylist', playlistId, trackPath),
    reorderPlaylistTracks: (playlistId: number, orderedTrackPaths: string[]) => ipcRenderer.invoke('library:reorderPlaylistTracks', playlistId, orderedTrackPaths),
    markPlaylistPlayed: (playlistId: number) => ipcRenderer.invoke('library:markPlaylistPlayed', playlistId),
    setPlaylistCustomCoverFromFile: (playlistId: number, imagePath: string) => ipcRenderer.invoke('library:setPlaylistCustomCoverFromFile', playlistId, imagePath),
    clearPlaylistCustomCover: (playlistId: number) => ipcRenderer.invoke('library:clearPlaylistCustomCover', playlistId),
    getPlaylistsContainingTrack: (trackPath: string) => ipcRenderer.invoke('library:getPlaylistsContainingTrack', trackPath),
    importPlaylistFromFile: (filePath: string) => ipcRenderer.invoke('library:importPlaylistFromFile', filePath),
  }
})

// Expose Visualizer API
contextBridge.exposeInMainWorld('visualizerAPI', visualizerDSP)
contextBridge.exposeInMainWorld('nativeAudioAPI', nativeAudioController)

// Type declarations for renderer
declare global {
  interface Window {
    nativeAudioAPI: {
      initialize: () => Promise<NativeAudioCapabilities>
      getCapabilities: () => Promise<NativeAudioCapabilities>
      setOutputDevice: (deviceId: string) => Promise<NativeAudioCapabilities>
      loadTrack: (filePath: string, metadata?: NativeAudioTrackMetadata) => Promise<NativeAudioTrackLoadResult>
      preloadNextTrack: (filePath: string, metadata?: NativeAudioTrackMetadata) => Promise<NativeAudioTrackLoadResult>
      play: () => Promise<NativeAudioPlaybackSnapshot>
      pause: () => Promise<NativeAudioPlaybackSnapshot>
      stop: () => Promise<NativeAudioPlaybackSnapshot>
      seek: (seconds: number) => Promise<NativeAudioPlaybackSnapshot>
      clearNextTrack: () => Promise<void>
      getPlaybackSnapshot: () => Promise<NativeAudioPlaybackSnapshot>
      flushOscilloscopeChunks: () => Float32Array[]
      flushSpectrumChunks: () => Float32Array[]
      flushVectorscopeChunks: () => NativeAudioVectorscopeChunk[]
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
        setVisualizerMode: (mode: MiniPlayerVisualizerMode) => Promise<MiniPlayerWindowState>
        toggleAlwaysOnTop: () => Promise<MiniPlayerWindowState>
        getSnapshot: () => Promise<MiniPlayerSnapshot | null>
        publishSnapshot: (snapshot: MiniPlayerSnapshot) => void
        publishVisualizerChunk: (chunk: MiniPlayerVisualizerStreamChunk) => void
        sendCommand: (command: MiniPlayerCommand) => void
        onSnapshot: (callback: (snapshot: MiniPlayerSnapshot) => void) => () => void
        onCommand: (callback: (command: MiniPlayerCommand) => void) => () => void
        onWindowState: (callback: (state: MiniPlayerWindowState) => void) => () => void
        onVisualizerChunk: (callback: (chunk: MiniPlayerVisualizerStreamChunk) => void) => () => void
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
      getAppPerformanceStats: () => Promise<AppPerformanceStats>
      updates: {
        checkForUpdates: () => Promise<UpdateCheckResult>
        openReleasesPage: (releaseUrl?: string) => Promise<boolean>
      }
      theme: {
        setRuntimeIconDataUrl: (dataUrl: string) => void
      }

      // Integrations
      discord: {
        configure: (options: { enabled: boolean; coverArtEnabled: boolean }) => Promise<DiscordRpcConfigureResult>
        updatePresence: (update: DiscordPresenceUpdate) => void
        clearPresence: () => void
        resolveCoverArt: (query: DiscordCoverArtLookupQuery) => Promise<DiscordCoverArtLookupResult>
      }
      localApi: {
        getStatus: () => Promise<LocalApiStatus>
        setEnabled: (enabled: boolean) => Promise<LocalApiStatus>
        setControlsEnabled: (enabled: boolean) => Promise<LocalApiStatus>
        setPort: (port: number) => Promise<LocalApiStatus>
        rotateToken: () => Promise<LocalApiStatus>
        resetToDefaults: () => Promise<LocalApiStatus>
        onStatus: (callback: (status: LocalApiStatus) => void) => () => void
      }
      lastFm: {
        getStatus: () => Promise<LastFmStatus>
        setEnabled: (enabled: boolean) => Promise<LastFmStatus>
        beginAuth: () => Promise<LastFmAuthStartResult>
        finishAuth: () => Promise<LastFmAuthFinishResult>
        disconnect: () => Promise<LastFmStatus>
        resetToDefaults: () => Promise<LastFmStatus>
        onStatus: (callback: (status: LastFmStatus) => void) => () => void
      }
      lyrics: {
        getStatus: () => Promise<LyricsStatus>
        setEnabled: (enabled: boolean) => Promise<LyricsStatus>
        getForTrack: (query: LyricsTrackQuery) => Promise<LyricsLookupResult>
        refreshForTrack: (query: LyricsTrackQuery) => Promise<LyricsLookupResult>
        getTrackOverride: (trackPath: string) => Promise<LyricsTrackOverride>
        importManualLyrics: (trackPaths: string[], lyricsText: string) => Promise<LyricsManualImportResult>
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
        syncSource: (sourceId: number) => Promise<void>
        syncAll: () => Promise<void>
        getStatus: () => Promise<SubsonicStatusSnapshot>
        onStatus: (callback: (status: SubsonicStatusSnapshot) => void) => () => void
      }
      jellyfin: {
        listSources: () => Promise<JellyfinSource[]>
        createSource: (input: JellyfinSourceCreateInput) => Promise<JellyfinSource>
        updateSource: (sourceId: number, input: JellyfinSourceUpdateInput) => Promise<JellyfinSource>
        deleteSource: (sourceId: number, purgeTracks: boolean) => Promise<void>
        testSource: (input: JellyfinSourceTestInput) => Promise<JellyfinSourceTestResult>
        syncSource: (sourceId: number) => Promise<void>
        syncAll: () => Promise<void>
        getStatus: () => Promise<JellyfinStatusSnapshot>
        onStatus: (callback: (status: JellyfinStatusSnapshot) => void) => () => void
      }

      // File operations
      openAudioFile: () => Promise<AudioFileResult | null>
      openAudioFolder: () => Promise<string | null>
      loadAudioFile: (filePath: string, options?: AudioLoadOptions) => Promise<AudioFileResult | null>
      getAudioMetadata: (filePath: string) => Promise<AudioFileMetadata | null>
      decodeAudioWithFfmpeg: (filePath: string) => Promise<ArrayBuffer | null>
      getReplayGainScanEnabled: () => Promise<boolean>
      setReplayGainScanEnabled: (enabled: boolean) => Promise<boolean>
      onRemoteLoadProgress: (callback: (progress: RemoteAudioLoadProgress) => void) => () => void

      // Generic file dialogs & I/O
      showSaveDialog: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
      openFileDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
      readTextFile: (filePath: string) => Promise<string>
      readFileAsDataUrl: (filePath: string) => Promise<string | null>
      writeFile: (filePath: string, content: string) => Promise<boolean>
      revealFileInFolder: (filePath: string) => Promise<boolean>

      // Library operations
      library: {
        getTracks: () => Promise<DbTrack[]>
        getTracksByArtist: (artist: string, mode?: LibraryArtistBrowseMode) => Promise<DbTrack[]>
        getTracksByAlbum: (album: string, artist?: string, identityKey?: string) => Promise<DbTrack[]>
        getArtists: (mode?: LibraryArtistBrowseMode) => Promise<Artist[]>
        getAlbums: () => Promise<Album[]>
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
        backfillReplayGainMetadata: () => Promise<{
          scanned: number
          updated: number
          errors: number
          canceled?: boolean
          scanIssueLog?: ScanIssueLog
        }>
        cancelScan: () => Promise<{ canceled: boolean }>
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
        getTrackCount: () => Promise<number>
        getArtworkPath: (hash: string) => Promise<string>
        getArtworkDataUrl: (hash: string) => Promise<string | null>
        getArtworkThumbnailDataUrl: (hash: string) => Promise<string | null>
        onScanProgress: (callback: (progress: ScanProgress) => void) => () => void
        onScanStage: (callback: (progress: ScanStageProgress) => void) => () => void
        onAudioMetadataBackfillComplete: (callback: (result: { scanned: number; updated: number; errors: number }) => void) => () => void
        onMetadataEditProgress: (callback: (progress: { current: number; total: number; trackPath: string }) => void) => () => void

        // Favorites
        getFavorites: () => Promise<DbTrack[]>
        getFavoritePaths: () => Promise<string[]>
        addFavorite: (trackPath: string) => Promise<void>
        removeFavorite: (trackPath: string) => Promise<void>

        // Recently played
        getRecentlyPlayed: (limit?: number) => Promise<DbTrack[]>
        addRecentlyPlayed: (trackPath: string) => Promise<void>

        // Playlists
        getPlaylists: () => Promise<Playlist[]>
        createPlaylist: (name: string) => Promise<Playlist>
        renamePlaylist: (id: number, name: string) => Promise<void>
        deletePlaylist: (id: number) => Promise<void>
        getPlaylistTracks: (playlistId: number) => Promise<DbTrack[]>
        addToPlaylist: (playlistId: number, trackPaths: string[]) => Promise<void>
        removeFromPlaylist: (playlistId: number, trackPath: string) => Promise<void>
        reorderPlaylistTracks: (playlistId: number, orderedTrackPaths: string[]) => Promise<void>
        markPlaylistPlayed: (playlistId: number) => Promise<void>
        setPlaylistCustomCoverFromFile: (playlistId: number, imagePath: string) => Promise<void>
        clearPlaylistCustomCover: (playlistId: number) => Promise<void>
        getPlaylistsContainingTrack: (trackPath: string) => Promise<number[]>
        importPlaylistFromFile: (filePath: string) => Promise<PlaylistImportResult>
      }
    }

    // Native Visualizer API - exposed as visualizerAPI global
    visualizerAPI: VisualizerDSP | null
  }
}
