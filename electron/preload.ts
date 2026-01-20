import { contextBridge, ipcRenderer } from 'electron'

// Expose window controls to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // Platform info
  platform: process.platform,

  // File system (to be expanded in Phase 3)
  // openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  // openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
})

// Type declarations for renderer
declare global {
  interface Window {
    electronAPI: {
      minimize: () => void
      maximize: () => void
      close: () => void
      isMaximized: () => Promise<boolean>
      platform: NodeJS.Platform
    }
  }
}
