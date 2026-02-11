import { contextBridge, ipcRenderer } from 'electron'
import { join } from 'path'

// Audio file result from main process
export interface AudioFileResult {
  path: string
  name: string
  data: ArrayBuffer
  metadata?: {
    title?: string
    artist?: string
    album?: string
    year?: number
    trackNumber?: number
    duration?: number
    format?: string
    sampleRate?: number
    channels?: number
    codec?: string
    codecProfile?: string
    isAtmosJoc?: boolean
    artwork?: string  // Base64 data URL
  }
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
  added_at: number
  modified_at: number
}

export interface LibraryFolder {
  id: number
  path: string
  added_at: number
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
  track_count: number
}

export interface AppPerformanceStats {
  cpuPercent: number
  memoryMb: number
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

  // Platform info
  platform: process.platform,
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  getAppPerformanceStats: () => ipcRenderer.invoke('app:getPerformanceStats'),

  // File operations
  openAudioFile: () => ipcRenderer.invoke('dialog:openAudioFile'),
  openAudioFolder: () => ipcRenderer.invoke('dialog:openAudioFolder'),
  loadAudioFile: (filePath: string) => ipcRenderer.invoke('audio:loadFile', filePath),
  decodeAudioWithFfmpeg: (filePath: string) => ipcRenderer.invoke('audio:decodeWithFfmpeg', filePath),

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
    getFolders: () => ipcRenderer.invoke('library:getFolders'),
    addFolder: (folderPath: string) => ipcRenderer.invoke('library:addFolder', folderPath),
    removeFolder: (folderPath: string) => ipcRenderer.invoke('library:removeFolder', folderPath),
    rescan: () => ipcRenderer.invoke('library:rescan'),
    getTrackCount: () => ipcRenderer.invoke('library:getTrackCount'),
    getArtworkPath: (hash: string) => ipcRenderer.invoke('library:getArtworkPath', hash),
    getArtworkDataUrl: (hash: string) => ipcRenderer.invoke('library:getArtworkDataUrl', hash),
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

      // Platform
      platform: NodeJS.Platform
      getAppVersion: () => Promise<string>
      getAppPerformanceStats: () => Promise<AppPerformanceStats>

      // File operations
      openAudioFile: () => Promise<AudioFileResult | null>
      openAudioFolder: () => Promise<string | null>
      loadAudioFile: (filePath: string) => Promise<AudioFileResult | null>
      decodeAudioWithFfmpeg: (filePath: string) => Promise<ArrayBuffer | null>

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
        getFolders: () => Promise<LibraryFolder[]>
        addFolder: (folderPath: string) => Promise<{ success: boolean; added?: number; updated?: number; errors?: number; skippedDirs?: string[]; error?: string }>
        removeFolder: (folderPath: string) => Promise<{ success: boolean }>
        rescan: () => Promise<{ added: number; updated: number; errors: number; folderWarnings?: Record<string, string[]> }>
        getTrackCount: () => Promise<number>
        getArtworkPath: (hash: string) => Promise<string>
        getArtworkDataUrl: (hash: string) => Promise<string | null>
        onScanProgress: (callback: (progress: ScanProgress) => void) => () => void
        onAudioMetadataBackfillComplete: (callback: (result: { scanned: number; updated: number; errors: number }) => void) => () => void

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
      }
    }

    // Native Visualizer API - exposed as visualizerAPI global
    visualizerAPI: VisualizerDSP | null
  }
}
