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

// Audio file result from main process
export interface AudioFileResult {
  path: string
  name: string
  data: ArrayBuffer
  metadata?: {
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
    artwork?: string  // Base64 data URL
  }
}

export interface AudioLoadOptions {
  metadataMode?: 'full' | 'none'
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
}

export interface Album {
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

export interface ScanProgress {
  current: number
  total: number
  file: string
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

// Load Native Module
let visualizerDSP: VisualizerDSP | null = null
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
  console.log('Native visualizer DSP module loaded successfully', modulePath)
} catch (error) {
  console.warn('Failed to load native visualizer DSP module:', error)
}

// Expose APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),

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

  // File operations
  openAudioFile: () => ipcRenderer.invoke('dialog:openAudioFile'),
  openAudioFolder: () => ipcRenderer.invoke('dialog:openAudioFolder'),
  loadAudioFile: (filePath: string, options?: AudioLoadOptions) => ipcRenderer.invoke('audio:loadFile', filePath, options),
  decodeAudioWithFfmpeg: (filePath: string) => ipcRenderer.invoke('audio:decodeWithFfmpeg', filePath),
  getReplayGainScanEnabled: () => ipcRenderer.invoke('audio:getReplayGainScanEnabled') as Promise<boolean>,
  setReplayGainScanEnabled: (enabled: boolean) => ipcRenderer.invoke('audio:setReplayGainScanEnabled', enabled) as Promise<boolean>,

  // Generic file dialogs & I/O
  showSaveDialog: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('dialog:showSaveDialog', options),
  openFileDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('dialog:openFile', options),
  readTextFile: (filePath: string) => ipcRenderer.invoke('fs:readTextFile', filePath),
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeTextFile', filePath, content),

  // Library operations
  library: {
    getTracks: () => ipcRenderer.invoke('library:getTracks'),
    getTracksByArtist: (artist: string) => ipcRenderer.invoke('library:getTracksByArtist', artist),
    getTracksByAlbum: (album: string, artist?: string) => ipcRenderer.invoke('library:getTracksByAlbum', album, artist),
    getArtists: () => ipcRenderer.invoke('library:getArtists'),
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
      added?: number
      updated?: number
      errors?: number
      removed?: number
      skippedDirs?: string[]
      summary?: FolderSubfolderSummary
    }>,
    addFolder: (folderPath: string) => ipcRenderer.invoke('library:addFolder', folderPath),
    removeFolder: (folderPath: string) => ipcRenderer.invoke('library:removeFolder', folderPath),
    resetMappedFolders: () => ipcRenderer.invoke('library:resetMappedFolders'),
    factoryReset: () => ipcRenderer.invoke('library:factoryReset'),
    rescan: () => ipcRenderer.invoke('library:rescan'),
    getTrackCount: () => ipcRenderer.invoke('library:getTrackCount'),
    getArtworkPath: (hash: string) => ipcRenderer.invoke('library:getArtworkPath', hash),
    getArtworkDataUrl: (hash: string) => ipcRenderer.invoke('library:getArtworkDataUrl', hash),
    getArtworkThumbnailDataUrl: (hash: string) => ipcRenderer.invoke('library:getArtworkThumbnailDataUrl', hash),
    onScanProgress: (callback: (progress: ScanProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: ScanProgress) => callback(progress)
      ipcRenderer.on('library:scanProgress', handler)
      return () => ipcRenderer.removeListener('library:scanProgress', handler)
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
    markPlaylistPlayed: (playlistId: number) => ipcRenderer.invoke('library:markPlaylistPlayed', playlistId),
    setPlaylistCustomCoverFromFile: (playlistId: number, imagePath: string) => ipcRenderer.invoke('library:setPlaylistCustomCoverFromFile', playlistId, imagePath),
    clearPlaylistCustomCover: (playlistId: number) => ipcRenderer.invoke('library:clearPlaylistCustomCover', playlistId),
    getPlaylistsContainingTrack: (trackPath: string) => ipcRenderer.invoke('library:getPlaylistsContainingTrack', trackPath),
    importPlaylistFromFile: (filePath: string) => ipcRenderer.invoke('library:importPlaylistFromFile', filePath),
  }
})

// Expose Visualizer API
contextBridge.exposeInMainWorld('visualizerAPI', visualizerDSP)

// Type declarations for renderer
declare global {
  interface Window {
    electronAPI: {
      // Window controls
      minimize: () => void
      maximize: () => void
      close: () => void
      isMaximized: () => Promise<boolean>
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

      // File operations
      openAudioFile: () => Promise<AudioFileResult | null>
      openAudioFolder: () => Promise<string | null>
      loadAudioFile: (filePath: string, options?: AudioLoadOptions) => Promise<AudioFileResult | null>
      decodeAudioWithFfmpeg: (filePath: string) => Promise<ArrayBuffer | null>
      getReplayGainScanEnabled: () => Promise<boolean>
      setReplayGainScanEnabled: (enabled: boolean) => Promise<boolean>

      // Generic file dialogs & I/O
      showSaveDialog: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
      openFileDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
      readTextFile: (filePath: string) => Promise<string>
      writeFile: (filePath: string, content: string) => Promise<boolean>

      // Library operations
      library: {
        getTracks: () => Promise<DbTrack[]>
        getTracksByArtist: (artist: string) => Promise<DbTrack[]>
        getTracksByAlbum: (album: string, artist?: string) => Promise<DbTrack[]>
        getArtists: () => Promise<Artist[]>
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
          added?: number
          updated?: number
          errors?: number
          removed?: number
          skippedDirs?: string[]
          summary?: FolderSubfolderSummary
        }>
        addFolder: (folderPath: string) => Promise<{ success: boolean; added?: number; updated?: number; errors?: number; skippedDirs?: string[]; error?: string }>
        removeFolder: (folderPath: string) => Promise<{ success: boolean }>
        resetMappedFolders: () => Promise<{ success: boolean; clearedFolders: number; clearedTracks: number }>
        factoryReset: () => Promise<{ success: boolean }>
        rescan: () => Promise<{ added: number; updated: number; errors: number; folderWarnings?: Record<string, string[]> }>
        getTrackCount: () => Promise<number>
        getArtworkPath: (hash: string) => Promise<string>
        getArtworkDataUrl: (hash: string) => Promise<string | null>
        getArtworkThumbnailDataUrl: (hash: string) => Promise<string | null>
        onScanProgress: (callback: (progress: ScanProgress) => void) => () => void
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
