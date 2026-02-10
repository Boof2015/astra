import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join, basename } from 'path'
import { readFile, writeFile } from 'fs/promises'
import * as mm from 'music-metadata'
import * as library from './services/library'

// Check if running in development
const isDev = process.env.NODE_ENV === 'development'

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

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // Initialize library database
  await library.initDatabase()

  // Clean up tracks that no longer exist on disk
  const removedCount = await library.cleanupMissingTracks()
  if (removedCount > 0) {
    console.log(`Removed ${removedCount} missing tracks from library`)
  }

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

app.on('before-quit', () => {
  library.closeDatabase()
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

// App info
ipcMain.handle('app:getVersion', () => {
  return app.getVersion()
})

ipcMain.handle('app:getPerformanceStats', () => {
  const metrics = app.getAppMetrics()
  const totalCpuPercent = metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0)
  const totalWorkingSetKb = metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0)

  return {
    cpuPercent: totalCpuPercent,
    memoryMb: totalWorkingSetKb / 1024,
  }
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
    title: 'Add Music Folder',
    properties: ['openDirectory']
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  return result.filePaths[0]
})

// Load a specific audio file
ipcMain.handle('audio:loadFile', async (_event, filePath: string) => {
  return loadAudioFile(filePath)
})

// ============================================
// Generic file dialog & I/O handlers
// ============================================

ipcMain.handle('dialog:showSaveDialog', async (_event, options: {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}) => {
  if (!mainWindow) return null
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title,
    defaultPath: options.defaultPath,
    filters: options.filters,
  })
  if (result.canceled || !result.filePath) return null
  return result.filePath
})

ipcMain.handle('dialog:openFile', async (_event, options: {
  title?: string
  filters?: { name: string; extensions: string[] }[]
}) => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title,
    filters: options.filters,
    properties: ['openFile'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('fs:readTextFile', async (_event, filePath: string) => {
  return readFile(filePath, 'utf-8')
})

ipcMain.handle('fs:writeTextFile', async (_event, filePath: string, content: string) => {
  await writeFile(filePath, content, 'utf-8')
  return true
})

// ============================================
// Library IPC handlers
// ============================================

// Get all tracks
ipcMain.handle('library:getTracks', () => {
  return library.getAllTracks()
})

// Get tracks by artist
ipcMain.handle('library:getTracksByArtist', (_event, artist: string) => {
  return library.getTracksByArtist(artist)
})

// Get tracks by album
ipcMain.handle('library:getTracksByAlbum', (_event, album: string, artist?: string) => {
  return library.getTracksByAlbum(album, artist)
})

// Get all artists
ipcMain.handle('library:getArtists', () => {
  return library.getArtists()
})

// Get all albums
ipcMain.handle('library:getAlbums', () => {
  return library.getAlbums()
})

// Search tracks
ipcMain.handle('library:search', (_event, query: string) => {
  return library.searchTracks(query)
})

// Get library folders
ipcMain.handle('library:getFolders', () => {
  return library.getLibraryFolders()
})

// Add library folder and scan
ipcMain.handle('library:addFolder', async (_event, folderPath: string) => {
  const folder = await library.addLibraryFolder(folderPath)
  if (!folder) {
    return { success: false, error: 'Folder already in library' }
  }

  // Scan folder
  const result = await library.scanFolder(folderPath, (current, total, file) => {
    mainWindow?.webContents.send('library:scanProgress', { current, total, file })
  })

  return { success: true, folder, ...result }
})

// Remove library folder
ipcMain.handle('library:removeFolder', async (_event, folderPath: string) => {
  await library.removeLibraryFolder(folderPath)
  return { success: true }
})

// Rescan all folders
ipcMain.handle('library:rescan', async () => {
  const folders = library.getLibraryFolders()
  let totalAdded = 0
  let totalUpdated = 0
  let totalErrors = 0
  const folderWarnings: Record<string, string[]> = {}

  for (const folder of folders) {
    const result = await library.scanFolder(folder.path, (current, total, file) => {
      mainWindow?.webContents.send('library:scanProgress', { current, total, file })
    })
    totalAdded += result.added
    totalUpdated += result.updated
    totalErrors += result.errors
    if (result.skippedDirs.length > 0) {
      folderWarnings[folder.path] = result.skippedDirs
    }
  }

  // Clean up tracks that no longer exist on disk
  const removed = await library.cleanupMissingTracks()

  return { added: totalAdded, updated: totalUpdated, errors: totalErrors, removed, folderWarnings }
})

// Get track count
ipcMain.handle('library:getTrackCount', () => {
  return library.getTrackCount()
})

// Get artwork path
ipcMain.handle('library:getArtworkPath', (_event, hash: string) => {
  return library.getArtworkPath(hash)
})

// Get artwork as data URL
ipcMain.handle('library:getArtworkDataUrl', async (_event, hash: string) => {
  if (!hash) return null
  try {
    const artworkPath = library.getArtworkPath(hash)
    const data = await readFile(artworkPath)
    const base64 = data.toString('base64')
    // Determine mime type from file extension in hash, or detect from magic bytes
    let mimeType = 'image/jpeg'
    if (hash.endsWith('.png')) mimeType = 'image/png'
    else if (hash.endsWith('.gif')) mimeType = 'image/gif'
    else if (hash.endsWith('.webp')) mimeType = 'image/webp'
    else if (hash.endsWith('.bmp')) mimeType = 'image/bmp'
    else {
      // Backward compatibility: detect from magic bytes for old .jpg files
      if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
        mimeType = 'image/png'
      } else if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
        mimeType = 'image/gif'
      } else if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
        mimeType = 'image/webp'
      }
    }
    return `data:${mimeType};base64,${base64}`
  } catch {
    return null
  }
})

// ============================================
// Favorites IPC handlers
// ============================================

ipcMain.handle('library:getFavorites', () => {
  return library.getFavorites()
})

ipcMain.handle('library:getFavoritePaths', () => {
  return library.getFavoritePaths()
})

ipcMain.handle('library:addFavorite', async (_event, trackPath: string) => {
  await library.addFavorite(trackPath)
})

ipcMain.handle('library:removeFavorite', async (_event, trackPath: string) => {
  await library.removeFavorite(trackPath)
})

// ============================================
// Recently Played IPC handlers
// ============================================

ipcMain.handle('library:getRecentlyPlayed', (_event, limit?: number) => {
  return library.getRecentlyPlayed(limit)
})

ipcMain.handle('library:addRecentlyPlayed', async (_event, trackPath: string) => {
  await library.addRecentlyPlayed(trackPath)
})

// ============================================
// Playlist IPC handlers
// ============================================

ipcMain.handle('library:getPlaylists', () => {
  return library.getPlaylists()
})

ipcMain.handle('library:createPlaylist', async (_event, name: string) => {
  return library.createPlaylist(name)
})

ipcMain.handle('library:renamePlaylist', async (_event, id: number, name: string) => {
  await library.renamePlaylist(id, name)
})

ipcMain.handle('library:deletePlaylist', async (_event, id: number) => {
  await library.deletePlaylist(id)
})

ipcMain.handle('library:getPlaylistTracks', (_event, playlistId: number) => {
  return library.getPlaylistTracks(playlistId)
})

ipcMain.handle('library:addToPlaylist', async (_event, playlistId: number, trackPaths: string[]) => {
  await library.addToPlaylist(playlistId, trackPaths)
})

ipcMain.handle('library:removeFromPlaylist', async (_event, playlistId: number, trackPath: string) => {
  await library.removeFromPlaylist(playlistId, trackPath)
})

// ============================================
// Helper functions
// ============================================

async function loadAudioFile(filePath: string) {
  try {
    // Read file as buffer
    const buffer = await readFile(filePath)
    const name = basename(filePath)

    // Extract metadata using music-metadata
    let metadata: {
      title: string
      artist: string
      album: string
      duration?: number
      format: string
      artwork?: string
    }

    try {
      const mm_metadata = await mm.parseFile(filePath)
      const common = mm_metadata.common

      // Convert artwork to base64 data URL
      let artworkDataUrl: string | undefined
      if (common.picture && common.picture.length > 0) {
        const pic = common.picture[0]
        const base64 = pic.data.toString('base64')
        artworkDataUrl = `data:${pic.format};base64,${base64}`
      }

      metadata = {
        title: common.title || name.replace(/\.[^.]+$/, ''),
        artist: common.artist || 'Unknown Artist',
        album: common.album || 'Unknown Album',
        duration: mm_metadata.format.duration,
        format: filePath.split('.').pop()?.toLowerCase() ?? 'unknown',
        artwork: artworkDataUrl
      }
    } catch {
      // Fallback to basic metadata
      metadata = {
        title: name.replace(/\.[^.]+$/, ''),
        artist: 'Unknown Artist',
        album: 'Unknown Album',
        format: filePath.split('.').pop()?.toLowerCase() ?? 'unknown'
      }
    }

    return {
      path: filePath,
      name: name,
      data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      metadata
    }
  } catch (error) {
    console.error('Failed to load audio file:', error)
    return null
  }
}
