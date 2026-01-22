import { contextBridge, ipcRenderer } from 'electron'

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

// Expose APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // Platform info
  platform: process.platform,

  // File operations
  openAudioFile: () => ipcRenderer.invoke('dialog:openAudioFile'),
  openAudioFolder: () => ipcRenderer.invoke('dialog:openAudioFolder'),
  loadAudioFile: (filePath: string) => ipcRenderer.invoke('audio:loadFile', filePath),

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
    }
  }
})

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

      // File operations
      openAudioFile: () => Promise<AudioFileResult | null>
      openAudioFolder: () => Promise<string | null>
      loadAudioFile: (filePath: string) => Promise<AudioFileResult | null>

      // Library operations
      library: {
        getTracks: () => Promise<DbTrack[]>
        getTracksByArtist: (artist: string) => Promise<DbTrack[]>
        getTracksByAlbum: (album: string, artist?: string) => Promise<DbTrack[]>
        getArtists: () => Promise<Artist[]>
        getAlbums: () => Promise<Album[]>
        search: (query: string) => Promise<DbTrack[]>
        getFolders: () => Promise<LibraryFolder[]>
        addFolder: (folderPath: string) => Promise<{ success: boolean; added?: number; updated?: number; errors?: number; error?: string }>
        removeFolder: (folderPath: string) => Promise<{ success: boolean }>
        rescan: () => Promise<{ added: number; updated: number; errors: number }>
        getTrackCount: () => Promise<number>
        getArtworkPath: (hash: string) => Promise<string>
        getArtworkDataUrl: (hash: string) => Promise<string | null>
        onScanProgress: (callback: (progress: ScanProgress) => void) => () => void
      }
    }
  }
}
