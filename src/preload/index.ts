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
      openAudioFolder: () => Promise<string[] | null>
      loadAudioFile: (filePath: string) => Promise<AudioFileResult | null>
    }
  }
}
