import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join, basename } from 'path'
import { readFile } from 'fs/promises'
import { is } from 'electron-vite/utils'

let mainWindow: BrowserWindow | null = null

// Supported audio formats
const AUDIO_EXTENSIONS = ['mp3', 'flac', 'wav', 'ogg', 'aac', 'm4a', 'opus', 'wma', 'aiff']
const AUDIO_FILTERS = [
  {
    name: 'Audio Files',
    extensions: AUDIO_EXTENSIONS
  }
]

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    transparent: false,
    backgroundColor: '#0a0a0f',
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// ============================================
// Window control IPC handlers
// ============================================
ipcMain.on('window:minimize', () => {
  mainWindow?.minimize()
})

ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow?.maximize()
  }
})

ipcMain.on('window:close', () => {
  mainWindow?.close()
})

ipcMain.handle('window:isMaximized', () => {
  return mainWindow?.isMaximized() ?? false
})

// ============================================
// File dialog IPC handlers
// ============================================

// Open file dialog for audio files
ipcMain.handle('dialog:openAudioFile', async () => {
  if (!mainWindow) return null

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Audio File',
    filters: AUDIO_FILTERS,
    properties: ['openFile']
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  const filePath = result.filePaths[0]
  return loadAudioFile(filePath)
})

// Open folder dialog
ipcMain.handle('dialog:openAudioFolder', async () => {
  if (!mainWindow) return null

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Music Folder',
    properties: ['openDirectory']
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  return result.filePaths
})

// Load a specific audio file
ipcMain.handle('audio:loadFile', async (_event, filePath: string) => {
  return loadAudioFile(filePath)
})

// ============================================
// Helper functions
// ============================================

async function loadAudioFile(filePath: string) {
  try {
    // Read file as buffer
    const buffer = await readFile(filePath)
    const name = basename(filePath)

    // Extract format from extension
    const ext = filePath.split('.').pop()?.toLowerCase() ?? 'unknown'

    // Basic metadata from filename (will be enhanced with music-metadata in Phase 3)
    const titleFromName = name.replace(/\.[^.]+$/, '')  // Remove extension

    return {
      path: filePath,
      name: name,
      data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      metadata: {
        title: titleFromName,
        artist: 'Unknown Artist',
        album: 'Unknown Album',
        format: ext
      }
    }
  } catch (error) {
    console.error('Failed to load audio file:', error)
    return null
  }
}
