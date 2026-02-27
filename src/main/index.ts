import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, screen } from 'electron'
import { join, basename, extname } from 'path'
import { readFile, writeFile, mkdtemp, rm, access, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { execFile, type ExecFileOptions } from 'child_process'
import { createHash } from 'crypto'
import * as mm from 'music-metadata'
import * as library from './services/library'
import {
  discordRpcService,
  type DiscordPresenceUpdate,
  type DiscordRpcConfigureOptions
} from './services/discordRpc'
import { resolveDiscordCoverArtUrl } from './services/discordCoverArtLookup'
import { checkForUpdates, RELEASES_PAGE_URL } from './services/updates'
import { LocalApiService, generateLocalApiToken } from './services/localApi'
import {
  MINI_WINDOW_MIN_HEIGHT,
  MINI_WINDOW_MIN_WIDTH,
  loadMiniWindowPrefs,
  normalizeMiniPlayerVisualizerMode,
  saveMiniWindowPrefs,
} from './services/miniWindowPrefs'
import type {
  MiniPlayerCommand,
  MiniPlayerSnapshot,
  MiniPlayerVisualizerStreamChunk,
  MiniPlayerWindowPrefs,
  MiniPlayerWindowState,
} from '../types/miniPlayer'
import {
  DEFAULT_SCOPE_POPOUT_STATE,
  SCOPE_KINDS,
  isScopeKind,
  type ScopeKind,
  type ScopePopoutChunk,
  type ScopePopoutState
} from '../types/scopePopout'
import {
  LOCAL_API_DEFAULT_PORT,
  LOCAL_API_MAX_PORT,
  LOCAL_API_MIN_PORT,
  type LocalApiServiceConfig,
} from '../types/localApi'

// Check if running in development
const isDev = process.env.NODE_ENV === 'development'

let mainWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null
const scopePopoutWindows: Record<ScopeKind, BrowserWindow | null> = {
  spectrum: null,
  oscilloscope: null,
  vectorscope: null,
}
let scopePopoutState: ScopePopoutState = { ...DEFAULT_SCOPE_POPOUT_STATE }
let miniWindowPrefs: MiniPlayerWindowPrefs | null = null
let latestMiniPlayerSnapshot: MiniPlayerSnapshot | null = null
let latestMiniVisualizerChunk: MiniPlayerVisualizerStreamChunk | null = null
const latestScopePopoutChunks: Partial<Record<ScopeKind, ScopePopoutChunk>> = {}
let miniWindowPersistTimer: ReturnType<typeof setTimeout> | null = null
let audioMetadataBackfillTimer: ReturnType<typeof setTimeout> | null = null
let replayGainBackfillTimer: ReturnType<typeof setTimeout> | null = null
let replayGainScanEnabled: boolean = false

const MINI_WINDOW_PERSIST_DEBOUNCE_MS = 220
const AUDIO_METADATA_BACKFILL_STARTUP_DELAY_MS = 15_000
const AUDIO_METADATA_BACKFILL_MIGRATION_KEY = 'audio_metadata_backfill_v1_done'
const REPLAYGAIN_BACKFILL_STARTUP_DELAY_MS = 17_000
const REPLAYGAIN_SCAN_ENABLED_META_KEY = 'replaygain_scan_enabled_v1'
const REPLAYGAIN_BACKFILL_MIGRATION_KEY = 'replaygain_backfill_v2_done'
const RUNTIME_ICON_DATA_URL_PREFIX = 'data:image/'
const MAX_RUNTIME_ICON_DATA_URL_LENGTH = 2_000_000
const LOCAL_API_ENABLED_META_KEY = 'local_api_enabled_v1'
const LOCAL_API_CONTROLS_ENABLED_META_KEY = 'local_api_controls_enabled_v1'
const LOCAL_API_PORT_META_KEY = 'local_api_port_v1'
const LOCAL_API_TOKEN_META_KEY = 'local_api_token_v1'
const TRACKLIST_THUMB_MAX_EDGE_PX = 96
const TRACKLIST_THUMB_JPEG_QUALITY = 78
const TRACKLIST_THUMB_CACHE_VERSION = 'v1'
const RELEASES_URL_HOSTNAME = 'github.com'
const RELEASES_URL_PATH_PREFIX = '/boof2015/astra/releases'

let artworkThumbnailCacheDir = ''
const artworkThumbnailRequestCache = new Map<string, Promise<string | null>>()

let localApiConfig: LocalApiServiceConfig = {
  enabled: false,
  controlsEnabled: false,
  port: LOCAL_API_DEFAULT_PORT,
  token: generateLocalApiToken(),
}

function resolveSafeReleaseUrl(candidateUrl: unknown): string {
  if (typeof candidateUrl !== 'string') {
    return RELEASES_PAGE_URL
  }

  const trimmed = candidateUrl.trim()
  if (trimmed.length === 0) {
    return RELEASES_PAGE_URL
  }

  try {
    const parsedUrl = new URL(trimmed)
    const normalizedPath = parsedUrl.pathname.replace(/\/+$/, '').toLowerCase()
    const isPathAllowed = normalizedPath === RELEASES_URL_PATH_PREFIX
      || normalizedPath.startsWith(`${RELEASES_URL_PATH_PREFIX}/`)

    if (parsedUrl.protocol !== 'https:') {
      return RELEASES_PAGE_URL
    }
    if (parsedUrl.hostname.toLowerCase() !== RELEASES_URL_HOSTNAME) {
      return RELEASES_PAGE_URL
    }
    if (parsedUrl.port.length > 0) {
      return RELEASES_PAGE_URL
    }
    if (!isPathAllowed) {
      return RELEASES_PAGE_URL
    }
    return parsedUrl.toString()
  } catch {
    return RELEASES_PAGE_URL
  }
}

function sendMiniPlayerCommand(command: MiniPlayerCommand): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mini-player:command', command)
  }
}

const localApiService = new LocalApiService({
  config: localApiConfig,
  getSnapshot: () => latestMiniPlayerSnapshot,
  dispatchCommand: sendMiniPlayerCommand,
  onStatusChange: () => {
    broadcastLocalApiStatus()
  }
})

const SCOPE_POPOUT_DEFAULTS: Record<ScopeKind, {
  title: string
  width: number
  height: number
  minWidth: number
  minHeight: number
}> = {
  spectrum: {
    title: 'Astra Spectrum',
    width: 760,
    height: 320,
    minWidth: 420,
    minHeight: 220,
  },
  oscilloscope: {
    title: 'Astra Oscilloscope',
    width: 760,
    height: 320,
    minWidth: 420,
    minHeight: 220,
  },
  vectorscope: {
    title: 'Astra Vectorscope',
    width: 440,
    height: 440,
    minWidth: 300,
    minHeight: 300,
  },
}

// Supported audio formats
const AUDIO_EXTENSIONS = ['mp3', 'flac', 'wav', 'ogg', 'aac', 'm4a', 'opus', 'wma', 'aiff']
const AUDIO_FILTERS = [
  {
    name: 'Audio Files',
    extensions: AUDIO_EXTENSIONS
  }
]

function getMiniWindowState(): MiniPlayerWindowState {
  const isOpen = Boolean(miniWindow && !miniWindow.isDestroyed())
  const alwaysOnTop = isOpen
    ? miniWindow!.isAlwaysOnTop()
    : miniWindowPrefs?.alwaysOnTop ?? true
  const visualizerMode = normalizeMiniPlayerVisualizerMode(miniWindowPrefs?.visualizerMode)

  return { isOpen, alwaysOnTop, visualizerMode }
}

function normalizeScopeKind(value: unknown): ScopeKind | null {
  return isScopeKind(value) ? value : null
}

function getScopePopoutWindow(scope: ScopeKind): BrowserWindow | null {
  const candidate = scopePopoutWindows[scope]
  if (!candidate || candidate.isDestroyed()) {
    return null
  }
  return candidate
}

function getScopePopoutState(): ScopePopoutState {
  return { ...scopePopoutState }
}

function setScopePopoutOpenState(scope: ScopeKind, isOpen: boolean): void {
  if (scopePopoutState[scope] === isOpen) return
  scopePopoutState = {
    ...scopePopoutState,
    [scope]: isOpen
  }
  broadcastScopePopoutState()
}

function resolveScopePopoutPosition(scope: ScopeKind): Pick<Electron.BrowserWindowConstructorOptions, 'x' | 'y'> {
  const main = mainWindow
  if (!main || main.isDestroyed()) {
    return {}
  }

  const defaults = SCOPE_POPOUT_DEFAULTS[scope]
  const bounds = main.getBounds()
  const offsets: Record<ScopeKind, { x: number; y: number }> = {
    spectrum: { x: 52, y: 56 },
    oscilloscope: { x: 88, y: 88 },
    vectorscope: { x: 120, y: 120 },
  }

  const targetX = bounds.x + offsets[scope].x
  const targetY = bounds.y + offsets[scope].y
  const matchingDisplay = screen.getDisplayMatching({
    x: targetX,
    y: targetY,
    width: defaults.width,
    height: defaults.height,
  })
  const workArea = matchingDisplay.workArea

  return {
    x: Math.max(workArea.x, Math.min(targetX, workArea.x + workArea.width - defaults.width)),
    y: Math.max(workArea.y, Math.min(targetY, workArea.y + workArea.height - defaults.height)),
  }
}

function broadcastScopePopoutState(): void {
  const payload = getScopePopoutState()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('scope-popout:state', payload)
  }

  for (const scope of SCOPE_KINDS) {
    const scopeWindow = getScopePopoutWindow(scope)
    if (scopeWindow) {
      scopeWindow.webContents.send('scope-popout:state', payload)
    }
  }
}

function parseMetaBoolean(value: string | null, fallback: boolean): boolean {
  if (value === '1') return true
  if (value === '0') return false
  return fallback
}

async function loadReplayGainScanEnabledFromMeta(): Promise<boolean> {
  const enabled = parseMetaBoolean(library.getAppMeta(REPLAYGAIN_SCAN_ENABLED_META_KEY), false)
  library.setReplayGainScanEnabled(enabled)

  const normalizedStoredValue = enabled ? '1' : '0'
  if (library.getAppMeta(REPLAYGAIN_SCAN_ENABLED_META_KEY) !== normalizedStoredValue) {
    try {
      await library.setAppMeta(REPLAYGAIN_SCAN_ENABLED_META_KEY, normalizedStoredValue)
    } catch (error) {
      console.warn('Failed to persist normalized ReplayGain scan setting:', error)
    }
  }

  return enabled
}

function normalizeLocalApiPort(rawPort: unknown): number {
  const parsed = typeof rawPort === 'number' ? rawPort : Number(rawPort)
  if (!Number.isInteger(parsed)) {
    throw new Error(`Port must be an integer between ${LOCAL_API_MIN_PORT} and ${LOCAL_API_MAX_PORT}.`)
  }
  if (parsed < LOCAL_API_MIN_PORT || parsed > LOCAL_API_MAX_PORT) {
    throw new Error(`Port must be between ${LOCAL_API_MIN_PORT} and ${LOCAL_API_MAX_PORT}.`)
  }
  return parsed
}

async function persistLocalApiConfig(config: LocalApiServiceConfig): Promise<void> {
  await library.setAppMeta(LOCAL_API_ENABLED_META_KEY, config.enabled ? '1' : '0')
  await library.setAppMeta(LOCAL_API_CONTROLS_ENABLED_META_KEY, config.controlsEnabled ? '1' : '0')
  await library.setAppMeta(LOCAL_API_PORT_META_KEY, String(config.port))
  await library.setAppMeta(LOCAL_API_TOKEN_META_KEY, config.token)
}

async function loadLocalApiConfigFromMeta(): Promise<LocalApiServiceConfig> {
  const enabled = parseMetaBoolean(library.getAppMeta(LOCAL_API_ENABLED_META_KEY), false)
  const controlsEnabledStored = parseMetaBoolean(library.getAppMeta(LOCAL_API_CONTROLS_ENABLED_META_KEY), false)
  const controlsEnabled = enabled ? controlsEnabledStored : false

  const rawPort = library.getAppMeta(LOCAL_API_PORT_META_KEY)
  let port = LOCAL_API_DEFAULT_PORT
  if (rawPort !== null) {
    try {
      port = normalizeLocalApiPort(rawPort)
    } catch {
      port = LOCAL_API_DEFAULT_PORT
    }
  }

  let token = library.getAppMeta(LOCAL_API_TOKEN_META_KEY) ?? ''
  token = token.trim()
  if (!token) {
    token = generateLocalApiToken()
  }

  const normalized: LocalApiServiceConfig = {
    enabled,
    controlsEnabled,
    port,
    token
  }

  const needsPersistence =
    library.getAppMeta(LOCAL_API_ENABLED_META_KEY) !== (normalized.enabled ? '1' : '0') ||
    library.getAppMeta(LOCAL_API_CONTROLS_ENABLED_META_KEY) !== (normalized.controlsEnabled ? '1' : '0') ||
    library.getAppMeta(LOCAL_API_PORT_META_KEY) !== String(normalized.port) ||
    library.getAppMeta(LOCAL_API_TOKEN_META_KEY) !== normalized.token

  if (needsPersistence) {
    try {
      await persistLocalApiConfig(normalized)
    } catch (error) {
      console.warn('Failed to persist normalized local API settings:', error)
    }
  }

  return normalized
}

async function applyLocalApiConfig(config: LocalApiServiceConfig): Promise<ReturnType<typeof localApiService.getStatus>> {
  localApiConfig = { ...config }
  await persistLocalApiConfig(localApiConfig)
  return localApiService.applyConfig(localApiConfig)
}

async function createScopePopoutWindow(scope: ScopeKind): Promise<void> {
  const existing = getScopePopoutWindow(scope)
  if (existing) {
    if (existing.isMinimized()) {
      existing.restore()
    }
    existing.focus()
    setScopePopoutOpenState(scope, true)
    return
  }

  const defaults = SCOPE_POPOUT_DEFAULTS[scope]
  const position = resolveScopePopoutPosition(scope)

  const scopeWindow = new BrowserWindow({
    width: defaults.width,
    height: defaults.height,
    minWidth: defaults.minWidth,
    minHeight: defaults.minHeight,
    frame: false,
    transparent: false,
    backgroundColor: '#05070c',
    autoHideMenuBar: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    title: defaults.title,
    ...position,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  scopePopoutWindows[scope] = scopeWindow
  setScopePopoutOpenState(scope, true)

  scopeWindow.on('ready-to-show', () => {
    scopeWindow.show()
  })

  scopeWindow.on('closed', () => {
    scopePopoutWindows[scope] = null
    setScopePopoutOpenState(scope, false)
  })

  scopeWindow.webContents.on('did-finish-load', () => {
    const latestChunk = latestScopePopoutChunks[scope]
    if (latestChunk) {
      scopeWindow.webContents.send('scope-popout:chunk', latestChunk)
    }
    broadcastScopePopoutState()
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    await scopeWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=scope-popout&scope=${scope}`)
  } else {
    await scopeWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'scope-popout', scope }
    })
  }
}

function recallScopePopoutWindow(scope: ScopeKind): void {
  const scopeWindow = getScopePopoutWindow(scope)
  if (scopeWindow) {
    scopeWindow.close()
    return
  }

  setScopePopoutOpenState(scope, false)
}

function closeAllScopePopoutWindows(): void {
  for (const scope of SCOPE_KINDS) {
    const scopeWindow = getScopePopoutWindow(scope)
    if (scopeWindow) {
      scopeWindow.close()
    }
  }
}

function applyRuntimeIconImage(image: Electron.NativeImage): void {
  if (process.platform === 'darwin') {
    app.dock?.setIcon(image)
    return
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIcon(image)
  }

  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.setIcon(image)
  }

  for (const scope of SCOPE_KINDS) {
    const scopeWindow = getScopePopoutWindow(scope)
    if (scopeWindow) {
      scopeWindow.setIcon(image)
    }
  }
}

function applyRuntimeIconDataUrl(dataUrl: string): boolean {
  if (!dataUrl.startsWith(RUNTIME_ICON_DATA_URL_PREFIX)) return false
  if (dataUrl.length > MAX_RUNTIME_ICON_DATA_URL_LENGTH) return false

  const image = nativeImage.createFromDataURL(dataUrl)
  if (image.isEmpty()) return false

  applyRuntimeIconImage(image)
  return true
}

function broadcastMiniWindowState(): void {
  const payload = getMiniWindowState()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mini-player:windowState', payload)
  }
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.webContents.send('mini-player:windowState', payload)
  }
}

function broadcastLocalApiStatus(): void {
  const payload = localApiService.getStatus()

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('local-api:status', payload)
  }
}

function captureMiniWindowPrefs(): MiniPlayerWindowPrefs | null {
  if (!miniWindow || miniWindow.isDestroyed()) return null
  const bounds = miniWindow.getBounds()
  const visualizerMode = normalizeMiniPlayerVisualizerMode(miniWindowPrefs?.visualizerMode)
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    alwaysOnTop: miniWindow.isAlwaysOnTop(),
    visualizerMode
  }
}

async function persistMiniWindowPrefs(): Promise<void> {
  const captured = captureMiniWindowPrefs()
  if (!captured) return

  miniWindowPrefs = captured
  try {
    await saveMiniWindowPrefs(captured)
  } catch (error) {
    console.warn('Failed to persist mini player window prefs:', error)
  }
}

function schedulePersistMiniWindowPrefs(): void {
  if (miniWindowPersistTimer !== null) {
    clearTimeout(miniWindowPersistTimer)
  }
  miniWindowPersistTimer = setTimeout(() => {
    miniWindowPersistTimer = null
    void persistMiniWindowPrefs()
  }, MINI_WINDOW_PERSIST_DEBOUNCE_MS)
}

async function createMiniPlayerWindow(): Promise<void> {
  if (miniWindow && !miniWindow.isDestroyed()) {
    if (miniWindow.isMinimized()) {
      miniWindow.restore()
    }
    miniWindow.focus()
    broadcastMiniWindowState()
    return
  }

  const prefs = miniWindowPrefs ?? await loadMiniWindowPrefs()
  miniWindowPrefs = prefs

  miniWindow = new BrowserWindow({
    width: prefs.width,
    height: prefs.height,
    x: prefs.x,
    y: prefs.y,
    minWidth: MINI_WINDOW_MIN_WIDTH,
    minHeight: MINI_WINDOW_MIN_HEIGHT,
    frame: false,
    transparent: false,
    backgroundColor: '#050507',
    alwaysOnTop: prefs.alwaysOnTop,
    autoHideMenuBar: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    title: 'Astra Mini Player',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  miniWindow.on('ready-to-show', () => {
    miniWindow?.show()
  })

  miniWindow.on('move', schedulePersistMiniWindowPrefs)
  miniWindow.on('resize', schedulePersistMiniWindowPrefs)
  miniWindow.on('close', () => {
    if (miniWindowPersistTimer !== null) {
      clearTimeout(miniWindowPersistTimer)
      miniWindowPersistTimer = null
    }
    void persistMiniWindowPrefs()
  })
  miniWindow.on('always-on-top-changed', () => {
    schedulePersistMiniWindowPrefs()
    broadcastMiniWindowState()
  })
  miniWindow.on('closed', () => {
    miniWindow = null
    broadcastMiniWindowState()
  })

  miniWindow.webContents.on('did-finish-load', () => {
    if (latestMiniPlayerSnapshot) {
      miniWindow?.webContents.send('mini-player:snapshot', latestMiniPlayerSnapshot)
    }
    if (latestMiniVisualizerChunk) {
      miniWindow?.webContents.send('mini-player:visualizerChunk', latestMiniVisualizerChunk)
    }
    broadcastMiniWindowState()
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    await miniWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=mini`)
  } else {
    await miniWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'mini' }
    })
  }

  broadcastMiniWindowState()
}

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
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    if (miniWindow && !miniWindow.isDestroyed()) {
      miniWindow.close()
    }
    closeAllScopePopoutWindows()
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

  broadcastMiniWindowState()
  broadcastScopePopoutState()
  broadcastLocalApiStatus()
}

async function maybeRunAudioMetadataBackfillOnce(): Promise<void> {
  if (library.getAppMeta(AUDIO_METADATA_BACKFILL_MIGRATION_KEY) === '1') {
    return
  }

  try {
    const { scanned, updated, errors } = await library.backfillMissingChannelCounts()
    if (scanned > 0) {
      console.log(`Audio metadata backfill (one-time): scanned=${scanned}, updated=${updated}, errors=${errors}`)
    }
    if (updated > 0) {
      mainWindow?.webContents.send('library:audioMetadataBackfillComplete', { scanned, updated, errors })
    }
  } catch (err) {
    console.warn('Audio metadata backfill failed:', err)
  } finally {
    try {
      await library.setAppMeta(AUDIO_METADATA_BACKFILL_MIGRATION_KEY, '1')
    } catch (err) {
      console.warn('Failed to persist audio metadata backfill migration flag:', err)
    }
  }
}

function scheduleAudioMetadataBackfillMigration(): void {
  if (library.getAppMeta(AUDIO_METADATA_BACKFILL_MIGRATION_KEY) === '1') {
    return
  }

  if (audioMetadataBackfillTimer !== null) {
    clearTimeout(audioMetadataBackfillTimer)
  }

  audioMetadataBackfillTimer = setTimeout(() => {
    audioMetadataBackfillTimer = null
    void maybeRunAudioMetadataBackfillOnce()
  }, AUDIO_METADATA_BACKFILL_STARTUP_DELAY_MS)
}

async function maybeRunReplayGainBackfillOnce(): Promise<void> {
  if (!replayGainScanEnabled) {
    return
  }

  if (library.getAppMeta(REPLAYGAIN_BACKFILL_MIGRATION_KEY) === '1') {
    return
  }

  try {
    const { scanned, updated, errors } = await library.backfillMissingReplayGainMetadata()
    if (scanned > 0) {
      console.log(`ReplayGain metadata backfill (one-time): scanned=${scanned}, updated=${updated}, errors=${errors}`)
    }
    if (updated > 0) {
      mainWindow?.webContents.send('library:audioMetadataBackfillComplete', { scanned, updated, errors })
    }
  } catch (err) {
    console.warn('ReplayGain metadata backfill failed:', err)
  } finally {
    try {
      await library.setAppMeta(REPLAYGAIN_BACKFILL_MIGRATION_KEY, '1')
    } catch (err) {
      console.warn('Failed to persist ReplayGain metadata backfill migration flag:', err)
    }
  }
}

function scheduleReplayGainBackfillMigration(): void {
  if (!replayGainScanEnabled) {
    return
  }
  if (library.getAppMeta(REPLAYGAIN_BACKFILL_MIGRATION_KEY) === '1') {
    return
  }

  if (replayGainBackfillTimer !== null) {
    clearTimeout(replayGainBackfillTimer)
  }

  replayGainBackfillTimer = setTimeout(() => {
    replayGainBackfillTimer = null
    void maybeRunReplayGainBackfillOnce()
  }, REPLAYGAIN_BACKFILL_STARTUP_DELAY_MS)
}

function detectArtworkMimeType(hash: string, data: Buffer): string {
  if (hash.endsWith('.png')) return 'image/png'
  if (hash.endsWith('.gif')) return 'image/gif'
  if (hash.endsWith('.webp')) return 'image/webp'
  if (hash.endsWith('.bmp')) return 'image/bmp'

  // Backward compatibility: detect format from magic bytes for legacy hashes.
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
    return 'image/png'
  }
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return 'image/gif'
  }
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
    return 'image/webp'
  }
  return 'image/jpeg'
}

function toDataUrl(mimeType: string, data: Buffer): string {
  return `data:${mimeType};base64,${data.toString('base64')}`
}

function getArtworkThumbnailCacheKey(hash: string): string {
  return createHash('md5')
    .update(`${TRACKLIST_THUMB_CACHE_VERSION}:${hash}:${TRACKLIST_THUMB_MAX_EDGE_PX}`)
    .digest('hex')
}

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

async function ensureArtworkThumbnailCacheDirectory(): Promise<void> {
  if (!artworkThumbnailCacheDir) {
    artworkThumbnailCacheDir = join(app.getPath('userData'), 'artwork-thumbs')
  }
  await mkdir(artworkThumbnailCacheDir, { recursive: true })
}

async function clearArtworkThumbnailCacheDirectory(): Promise<void> {
  if (!artworkThumbnailCacheDir) {
    artworkThumbnailCacheDir = join(app.getPath('userData'), 'artwork-thumbs')
  }
  try {
    await rm(artworkThumbnailCacheDir, { recursive: true, force: true })
    await mkdir(artworkThumbnailCacheDir, { recursive: true })
  } catch (error) {
    console.warn('Failed to clear artwork thumbnail cache directory:', artworkThumbnailCacheDir, error)
  }
}

function resizeForTracklistThumbnail(sourceImage: Electron.NativeImage): Electron.NativeImage {
  const { width, height } = sourceImage.getSize()
  if (width <= 0 || height <= 0) return sourceImage

  const longestEdge = Math.max(width, height)
  if (longestEdge <= TRACKLIST_THUMB_MAX_EDGE_PX) {
    return sourceImage
  }

  const scale = TRACKLIST_THUMB_MAX_EDGE_PX / longestEdge
  return sourceImage.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'good'
  })
}

async function getArtworkDataUrlByHash(hash: string): Promise<string | null> {
  if (!hash) return null
  try {
    const artworkPath = library.getArtworkPath(hash)
    const data = await readFile(artworkPath)
    return toDataUrl(detectArtworkMimeType(hash, data), data)
  } catch {
    return null
  }
}

async function getArtworkThumbnailDataUrlByHash(hash: string): Promise<string | null> {
  if (!hash) return null

  try {
    await ensureArtworkThumbnailCacheDirectory()
    const thumbnailPath = join(artworkThumbnailCacheDir, `${getArtworkThumbnailCacheKey(hash)}.jpg`)

    try {
      const cached = await readFile(thumbnailPath)
      if (cached.length > 0) {
        return toDataUrl('image/jpeg', cached)
      }
    } catch {
      // Cache miss: generate and persist below.
    }

    const artworkPath = library.getArtworkPath(hash)
    const sourceBuffer = await readFile(artworkPath)
    const sourceImage = nativeImage.createFromBuffer(sourceBuffer)
    if (sourceImage.isEmpty()) {
      return getArtworkDataUrlByHash(hash)
    }

    const resized = resizeForTracklistThumbnail(sourceImage)
    const thumbnailBuffer = resized.toJPEG(TRACKLIST_THUMB_JPEG_QUALITY)
    if (!thumbnailBuffer || thumbnailBuffer.length === 0) {
      return getArtworkDataUrlByHash(hash)
    }

    try {
      await writeFile(thumbnailPath, thumbnailBuffer, { flag: 'wx' })
    } catch (error) {
      if (getErrorCode(error) !== 'EEXIST') {
        console.warn('Failed to persist artwork thumbnail cache file:', thumbnailPath, error)
      }
    }

    return toDataUrl('image/jpeg', thumbnailBuffer)
  } catch (error) {
    console.warn('Failed to resolve artwork thumbnail data URL:', hash, error)
    return getArtworkDataUrlByHash(hash)
  }
}

app.whenReady().then(async () => {
  // Initialize library database
  await library.initDatabase()
  replayGainScanEnabled = await loadReplayGainScanEnabledFromMeta()
  try {
    await ensureArtworkThumbnailCacheDirectory()
  } catch (error) {
    console.warn('Failed to initialize artwork thumbnail cache directory:', error)
  }
  miniWindowPrefs = await loadMiniWindowPrefs()
  localApiConfig = await loadLocalApiConfigFromMeta()
  await localApiService.applyConfig(localApiConfig)
  localApiService.publishSnapshot(latestMiniPlayerSnapshot)

  // Clean up tracks that no longer exist on disk
  const removedCount = await library.cleanupMissingTracks()
  if (removedCount > 0) {
    console.log(`Removed ${removedCount} missing tracks from library`)
  }

  createWindow()
  scheduleAudioMetadataBackfillMigration()
  scheduleReplayGainBackfillMigration()

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
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
  if (miniWindowPersistTimer !== null) {
    clearTimeout(miniWindowPersistTimer)
    miniWindowPersistTimer = null
  }
  if (audioMetadataBackfillTimer !== null) {
    clearTimeout(audioMetadataBackfillTimer)
    audioMetadataBackfillTimer = null
  }
  if (replayGainBackfillTimer !== null) {
    clearTimeout(replayGainBackfillTimer)
    replayGainBackfillTimer = null
  }
  void persistMiniWindowPrefs()
  closeAllScopePopoutWindows()
  void localApiService.stop()
  discordRpcService.shutdown()
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

// Mini player window controls/state
ipcMain.handle('mini-player:open', async () => {
  await createMiniPlayerWindow()
})

ipcMain.handle('mini-player:close', async () => {
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.close()
  }
})

ipcMain.handle('mini-player:getWindowState', () => {
  return getMiniWindowState()
})

ipcMain.handle('mini-player:setVisualizerMode', async (_event, mode: unknown) => {
  const visualizerMode = normalizeMiniPlayerVisualizerMode(mode)

  if (!miniWindowPrefs) {
    miniWindowPrefs = await loadMiniWindowPrefs()
  }

  miniWindowPrefs = {
    ...miniWindowPrefs,
    visualizerMode,
  }

  await saveMiniWindowPrefs(miniWindowPrefs)
  broadcastMiniWindowState()
  return getMiniWindowState()
})

ipcMain.handle('mini-player:toggleAlwaysOnTop', async () => {
  if (!miniWindow || miniWindow.isDestroyed()) {
    await createMiniPlayerWindow()
  }

  if (!miniWindow || miniWindow.isDestroyed()) {
    return getMiniWindowState()
  }

  miniWindow.setAlwaysOnTop(!miniWindow.isAlwaysOnTop())
  await persistMiniWindowPrefs()
  broadcastMiniWindowState()
  return getMiniWindowState()
})

ipcMain.handle('mini-player:getSnapshot', () => {
  return latestMiniPlayerSnapshot
})

ipcMain.on('mini-player:publishSnapshot', (_event, snapshot: MiniPlayerSnapshot) => {
  latestMiniPlayerSnapshot = snapshot
  localApiService.publishSnapshot(snapshot)
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.webContents.send('mini-player:snapshot', snapshot)
  }
})

ipcMain.on('mini-player:publishVisualizerChunk', (_event, chunk: MiniPlayerVisualizerStreamChunk) => {
  latestMiniVisualizerChunk = chunk
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.webContents.send('mini-player:visualizerChunk', chunk)
  }
})

ipcMain.on('mini-player:sendCommand', (_event, command: MiniPlayerCommand) => {
  sendMiniPlayerCommand(command)
})

// Scope popout window controls/state
ipcMain.handle('scope-popout:open', async (_event, rawScope: unknown) => {
  const scope = normalizeScopeKind(rawScope)
  if (!scope) {
    return getScopePopoutState()
  }

  await createScopePopoutWindow(scope)
  return getScopePopoutState()
})

ipcMain.handle('scope-popout:recall', async (_event, rawScope: unknown) => {
  const scope = normalizeScopeKind(rawScope)
  if (!scope) {
    return getScopePopoutState()
  }

  recallScopePopoutWindow(scope)
  return getScopePopoutState()
})

ipcMain.handle('scope-popout:getState', () => {
  return getScopePopoutState()
})

ipcMain.on('scope-popout:publishChunk', (_event, rawChunk: unknown) => {
  if (!rawChunk || typeof rawChunk !== 'object') return
  const chunk = rawChunk as ScopePopoutChunk
  if (!isScopeKind(chunk.scope)) return

  latestScopePopoutChunks[chunk.scope] = chunk

  const scopeWindow = getScopePopoutWindow(chunk.scope)
  if (scopeWindow) {
    scopeWindow.webContents.send('scope-popout:chunk', chunk)
  }
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

ipcMain.handle('updates:check', async () => {
  return checkForUpdates(app.getVersion())
})

ipcMain.handle('updates:openReleasesPage', async (_event, releaseUrl: unknown) => {
  const targetUrl = resolveSafeReleaseUrl(releaseUrl)
  await shell.openExternal(targetUrl)
  return true
})

ipcMain.on('theme:setRuntimeIconDataUrl', (_event, dataUrl: unknown) => {
  if (typeof dataUrl !== 'string') {
    console.warn('Ignored runtime icon update: payload must be a data URL string')
    return
  }

  try {
    if (!applyRuntimeIconDataUrl(dataUrl)) {
      console.warn('Ignored runtime icon update: invalid data URL payload')
    }
  } catch (error) {
    console.warn('Failed to apply runtime icon update:', error)
  }
})

// Discord Rich Presence
ipcMain.handle('discord:configure', async (_event, options: DiscordRpcConfigureOptions) => {
  return discordRpcService.configure(options)
})

ipcMain.on('discord:updatePresence', (_event, update: DiscordPresenceUpdate) => {
  discordRpcService.updatePresence(update)
})

ipcMain.on('discord:clearPresence', () => {
  discordRpcService.clearPresence()
})

ipcMain.handle('discord:resolveCoverArt', async (_event, query: unknown) => {
  if (!query || typeof query !== 'object') return { status: 'not_found' as const }
  const normalized = query as Record<string, unknown>
  if (typeof normalized.album !== 'string') return { status: 'not_found' as const }

  return resolveDiscordCoverArtUrl({
    album: normalized.album,
    artist: typeof normalized.artist === 'string' ? normalized.artist : undefined,
    albumArtist: typeof normalized.albumArtist === 'string' ? normalized.albumArtist : undefined,
    title: typeof normalized.title === 'string' ? normalized.title : undefined
  })
})

// Local integration API
ipcMain.handle('local-api:getStatus', () => {
  return localApiService.getStatus()
})

ipcMain.handle('local-api:setEnabled', async (_event, enabled: unknown) => {
  const nextEnabled = Boolean(enabled)
  const nextConfig: LocalApiServiceConfig = {
    ...localApiConfig,
    enabled: nextEnabled,
    controlsEnabled: nextEnabled ? localApiConfig.controlsEnabled : false
  }
  return applyLocalApiConfig(nextConfig)
})

ipcMain.handle('local-api:setControlsEnabled', async (_event, controlsEnabled: unknown) => {
  const nextControlsEnabled = localApiConfig.enabled && Boolean(controlsEnabled)
  const nextConfig: LocalApiServiceConfig = {
    ...localApiConfig,
    controlsEnabled: nextControlsEnabled
  }
  return applyLocalApiConfig(nextConfig)
})

ipcMain.handle('local-api:setPort', async (_event, rawPort: unknown) => {
  const nextPort = normalizeLocalApiPort(rawPort)
  const nextConfig: LocalApiServiceConfig = {
    ...localApiConfig,
    port: nextPort
  }
  return applyLocalApiConfig(nextConfig)
})

ipcMain.handle('local-api:rotateToken', async () => {
  const nextConfig: LocalApiServiceConfig = {
    ...localApiConfig,
    token: generateLocalApiToken()
  }
  return applyLocalApiConfig(nextConfig)
})

ipcMain.handle('local-api:resetToDefaults', async () => {
  const nextConfig: LocalApiServiceConfig = {
    enabled: false,
    controlsEnabled: false,
    port: LOCAL_API_DEFAULT_PORT,
    token: generateLocalApiToken(),
  }
  return applyLocalApiConfig(nextConfig)
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
ipcMain.handle('audio:loadFile', async (_event, filePath: string, options?: LoadAudioFileOptions) => {
  return loadAudioFile(filePath, options)
})

// Decode with FFmpeg when WebAudio decodeAudioData cannot handle the codec.
ipcMain.handle('audio:decodeWithFfmpeg', async (_event, filePath: string) => {
  return decodeAudioWithFfmpeg(filePath)
})

ipcMain.handle('audio:getReplayGainScanEnabled', () => {
  return replayGainScanEnabled
})

ipcMain.handle('audio:setReplayGainScanEnabled', async (_event, enabledValue: unknown) => {
  replayGainScanEnabled = Boolean(enabledValue)
  library.setReplayGainScanEnabled(replayGainScanEnabled)

  try {
    await library.setAppMeta(REPLAYGAIN_SCAN_ENABLED_META_KEY, replayGainScanEnabled ? '1' : '0')
  } catch (error) {
    console.warn('Failed to persist ReplayGain scan setting:', error)
  }

  if (!replayGainScanEnabled) {
    if (replayGainBackfillTimer !== null) {
      clearTimeout(replayGainBackfillTimer)
      replayGainBackfillTimer = null
    }
    try {
      await library.setAppMeta(REPLAYGAIN_BACKFILL_MIGRATION_KEY, '0')
    } catch (error) {
      console.warn('Failed to reset ReplayGain backfill migration flag:', error)
    }
  } else {
    scheduleReplayGainBackfillMigration()
  }

  return replayGainScanEnabled
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
ipcMain.handle('library:getTracksByAlbum', (_event, album: string, artist?: string, identityKey?: string) => {
  return library.getTracksByAlbum(album, artist, identityKey)
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

ipcMain.handle('library:getMetadataOverridePaths', () => {
  return library.getMetadataOverridePaths()
})

ipcMain.handle('library:clearMetadataOverrides', async (_event, trackPaths: string[]) => {
  return library.clearMetadataOverrides(trackPaths)
})

ipcMain.handle('library:saveMetadataEdits', async (_event, request: library.MetadataEditRequest) => {
  return library.saveMetadataEdits(request, (current, total, trackPath) => {
    mainWindow?.webContents.send('library:metadataEditProgress', { current, total, trackPath })
  })
})

ipcMain.handle('library:getTrackOverrideFields', (_event, trackPaths: string[]) => {
  return library.getTrackOverrideFields(trackPaths)
})

ipcMain.handle('library:getTrackOverrideSnapshots', (_event, trackPaths: string[]) => {
  return library.getTrackOverrideSnapshots(trackPaths)
})

ipcMain.handle('library:restoreTrackOverrides', async (_event, overrides: Record<string, library.TrackOverrideSnapshot | null>) => {
  return library.restoreTrackOverrides(overrides)
})

// Get library folders
ipcMain.handle('library:getFolders', () => {
  return library.getLibraryFolders()
})

ipcMain.handle('library:getFolderSubfolderSummary', async (_event, folderPath: string) => {
  return library.getFolderSubfolderSummary(folderPath)
})

ipcMain.handle('library:listFolderSubdirectories', async (_event, folderPath: string, parentRelativePath?: string) => {
  return library.listFolderSubdirectories(folderPath, parentRelativePath ?? '')
})

ipcMain.handle('library:addFolderWithoutScan', async (_event, folderPath: string) => {
  const folder = await library.addLibraryFolder(folderPath)
  if (!folder) {
    return { success: false, error: 'Folder already in library' }
  }
  const summary = await library.getFolderSubfolderSummary(folderPath)
  return { success: true, folder, summary }
})

type LibraryScanStage = 'scanning' | 'backfill' | 'cleanup'
let activeLibraryScanAbortController: AbortController | null = null
let activeLibraryScanStage: LibraryScanStage | null = null

function sendLibraryScanStage(stage: LibraryScanStage, message: string): void {
  activeLibraryScanStage = stage
  mainWindow?.webContents.send('library:scanStage', { stage, message })
}

function createLibraryScanAbortController(): AbortController {
  if (activeLibraryScanAbortController && !activeLibraryScanAbortController.signal.aborted) {
    throw new Error('A library scan is already in progress.')
  }

  const controller = new AbortController()
  activeLibraryScanAbortController = controller
  return controller
}

async function runLibraryScanOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = createLibraryScanAbortController()
  let transactionStarted = false

  try {
    library.beginLibraryWriteTransaction()
    transactionStarted = true

    const result = await operation(controller.signal)

    library.commitLibraryWriteTransaction()
    transactionStarted = false
    await library.persistLibraryDatabase()

    return result
  } catch (error) {
    if (transactionStarted) {
      try {
        library.rollbackLibraryWriteTransaction()
      } catch (rollbackError) {
        console.warn('Failed to roll back canceled library scan transaction:', rollbackError)
      }
    }
    throw error
  } finally {
    if (activeLibraryScanAbortController === controller) {
      activeLibraryScanAbortController = null
    }
    activeLibraryScanStage = null
  }
}

ipcMain.handle('library:cancelScan', () => {
  if (!activeLibraryScanAbortController || activeLibraryScanAbortController.signal.aborted) {
    return { canceled: false }
  }

  activeLibraryScanAbortController.abort()
  sendLibraryScanStage(activeLibraryScanStage ?? 'scanning', 'Canceling scan...')
  return { canceled: true }
})

// Add library folder and scan
ipcMain.handle('library:addFolder', async (_event, folderPath: string) => {
  const folder = await library.addLibraryFolder(folderPath)
  if (!folder) {
    return { success: false, error: 'Folder already in library' }
  }

  const folderLabel = basename(folderPath) || folderPath

  try {
    const result = await runLibraryScanOperation(async (signal) => {
      sendLibraryScanStage('scanning', `Scanning files in ${folderLabel}...`)
      const scanResult = await library.scanFolder(folderPath, (current, total, file) => {
        mainWindow?.webContents.send('library:scanProgress', { current, total, file })
      }, { signal, persist: false })

      sendLibraryScanStage('backfill', `Processing metadata for ${folderLabel}...`)
      const metadataBackfill = await library.backfillIncompleteAudioMetadataForFolder(folderPath, (current, total, file) => {
        mainWindow?.webContents.send('library:scanProgress', { current, total, file })
      }, { signal, persist: false })

      if (metadataBackfill.scanned > 0) {
        console.log(
          `Folder metadata backfill: scanned=${metadataBackfill.scanned}, updated=${metadataBackfill.updated}, errors=${metadataBackfill.errors}, folder=${folderPath}`
        )
      }
      if (metadataBackfill.updated > 0) {
        mainWindow?.webContents.send('library:audioMetadataBackfillComplete', metadataBackfill)
      }

      return scanResult
    })

    return { success: true, canceled: false, folder, ...result }
  } catch (error) {
    if (library.isLibraryScanCancelledError(error)) {
      return { success: false, canceled: true, folder }
    }
    throw error
  }
})

// Remove library folder
ipcMain.handle('library:removeFolder', async (_event, folderPath: string) => {
  await library.removeLibraryFolder(folderPath)
  return { success: true }
})

ipcMain.handle(
  'library:setFolderSubfolderExcluded',
  async (_event, folderPath: string, relativePath: string, excluded: boolean) => {
    const updated = await library.setFolderSubfolderExcluded(folderPath, relativePath, excluded)
    if (!updated) {
      return { success: false, error: 'Invalid folder or subfolder path.' }
    }

    const summary = await library.getFolderSubfolderSummary(folderPath)

    return { success: true, summary }
  }
)

ipcMain.handle(
  'library:rescanFolder',
  async (_event, folderPath: string) => {
    const folderLabel = basename(folderPath) || folderPath
    try {
      const result = await runLibraryScanOperation(async (signal) => {
        sendLibraryScanStage('scanning', `Scanning files in ${folderLabel}...`)
        const scanResult = await library.scanFolder(folderPath, (current, total, file) => {
          mainWindow?.webContents.send('library:scanProgress', { current, total, file })
        }, { signal, persist: false })

        sendLibraryScanStage('backfill', `Processing metadata for ${folderLabel}...`)
        const metadataBackfill = await library.backfillIncompleteAudioMetadataForFolder(folderPath, (current, total, file) => {
          mainWindow?.webContents.send('library:scanProgress', { current, total, file })
        }, { signal, persist: false })
        if (metadataBackfill.scanned > 0) {
          console.log(
            `Folder metadata backfill: scanned=${metadataBackfill.scanned}, updated=${metadataBackfill.updated}, errors=${metadataBackfill.errors}, folder=${folderPath}`
          )
        }
        if (metadataBackfill.updated > 0) {
          mainWindow?.webContents.send('library:audioMetadataBackfillComplete', metadataBackfill)
        }

        sendLibraryScanStage('cleanup', `Finalizing ${folderLabel}...`)
        const removed = await library.cleanupMissingTracks({ signal, persist: false })
        const summary = await library.getFolderSubfolderSummary(folderPath)

        return { ...scanResult, removed, summary }
      })

      return { success: true, canceled: false, ...result }
    } catch (error) {
      if (library.isLibraryScanCancelledError(error)) {
        return { success: false, canceled: true }
      }
      throw error
    }
  }
)

ipcMain.handle('library:resetMappedFolders', async () => {
  const result = await library.resetMappedFoldersData()
  await clearArtworkThumbnailCacheDirectory()
  artworkThumbnailRequestCache.clear()
  return { success: true, ...result }
})

ipcMain.handle('library:factoryReset', async () => {
  await library.factoryResetLibraryData()
  await clearArtworkThumbnailCacheDirectory()
  artworkThumbnailRequestCache.clear()
  return { success: true }
})

// Rescan all folders
ipcMain.handle('library:rescan', async () => {
  try {
    const result = await runLibraryScanOperation(async (signal) => {
      const folders = library.getLibraryFolders()
      let totalAdded = 0
      let totalUpdated = 0
      let totalErrors = 0
      let metadataBackfillScanned = 0
      let metadataBackfillUpdated = 0
      let metadataBackfillErrors = 0
      const folderWarnings: Record<string, string[]> = {}
      const totalFolders = folders.length

      for (let folderIndex = 0; folderIndex < folders.length; folderIndex++) {
        const folder = folders[folderIndex]
        const folderLabel = basename(folder.path) || folder.path
        sendLibraryScanStage('scanning', `Scanning ${folderLabel} (${folderIndex + 1}/${totalFolders})...`)

        const scanResult = await library.scanFolder(folder.path, (current, total, file) => {
          mainWindow?.webContents.send('library:scanProgress', { current, total, file })
        }, { signal, persist: false })
        totalAdded += scanResult.added
        totalUpdated += scanResult.updated
        totalErrors += scanResult.errors
        if (scanResult.skippedDirs.length > 0) {
          folderWarnings[folder.path] = scanResult.skippedDirs
        }

        sendLibraryScanStage('backfill', `Processing metadata for ${folderLabel} (${folderIndex + 1}/${totalFolders})...`)
        const metadataBackfill = await library.backfillIncompleteAudioMetadataForFolder(folder.path, (current, total, file) => {
          mainWindow?.webContents.send('library:scanProgress', { current, total, file })
        }, { signal, persist: false })
        metadataBackfillScanned += metadataBackfill.scanned
        metadataBackfillUpdated += metadataBackfill.updated
        metadataBackfillErrors += metadataBackfill.errors
      }

      if (metadataBackfillScanned > 0) {
        console.log(
          `Rescan metadata backfill: scanned=${metadataBackfillScanned}, updated=${metadataBackfillUpdated}, errors=${metadataBackfillErrors}`
        )
      }
      if (metadataBackfillUpdated > 0) {
        mainWindow?.webContents.send('library:audioMetadataBackfillComplete', {
          scanned: metadataBackfillScanned,
          updated: metadataBackfillUpdated,
          errors: metadataBackfillErrors
        })
      }

      // Clean up tracks that no longer exist on disk
      sendLibraryScanStage('cleanup', 'Finalizing library...')
      const removed = await library.cleanupMissingTracks({ signal, persist: false })

      return { added: totalAdded, updated: totalUpdated, errors: totalErrors, removed, folderWarnings }
    })

    return { ...result, canceled: false }
  } catch (error) {
    if (library.isLibraryScanCancelledError(error)) {
      return {
        added: 0,
        updated: 0,
        errors: 0,
        removed: 0,
        folderWarnings: {},
        canceled: true
      }
    }
    throw error
  }
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
  return getArtworkDataUrlByHash(hash)
})

// Get tracklist-sized artwork thumbnail as data URL
ipcMain.handle('library:getArtworkThumbnailDataUrl', async (_event, hash: string) => {
  if (!hash) return null

  const requestKey = getArtworkThumbnailCacheKey(hash)
  if (artworkThumbnailRequestCache.has(requestKey)) {
    return artworkThumbnailRequestCache.get(requestKey)!
  }

  const request = getArtworkThumbnailDataUrlByHash(hash)
    .finally(() => {
      artworkThumbnailRequestCache.delete(requestKey)
    })

  artworkThumbnailRequestCache.set(requestKey, request)
  return request
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

ipcMain.handle('library:markPlaylistPlayed', async (_event, playlistId: number) => {
  await library.markPlaylistPlayed(playlistId)
})

ipcMain.handle('library:setPlaylistCustomCoverFromFile', async (_event, playlistId: number, imagePath: string) => {
  await library.setPlaylistCustomCoverFromFile(playlistId, imagePath)
})

ipcMain.handle('library:clearPlaylistCustomCover', async (_event, playlistId: number) => {
  await library.clearPlaylistCustomCover(playlistId)
})

ipcMain.handle('library:getPlaylistsContainingTrack', (_event, trackPath: string) => {
  return library.getPlaylistsContainingTrack(trackPath)
})

ipcMain.handle('library:importPlaylistFromFile', async (_event, filePath: string) => {
  return library.importPlaylistFromFile(filePath)
})

// ============================================
// Helper functions
// ============================================

interface LoadedAudioMetadata {
  title: string
  artist: string
  album: string
  albumArtist?: string
  duration?: number
  format: string
  artwork?: string
  channels?: number
  codec?: string
  codecProfile?: string
  isAtmosJoc?: boolean
  replayGainTrackDb?: number
  replayGainAlbumDb?: number
}

interface LoadAudioFileOptions {
  metadataMode?: 'full' | 'none'
}

interface FfprobeAudioMetadata {
  channels?: number
  codec?: string
  codecProfile?: string
  isAtmosJoc?: boolean
  hints: string[]
}

const binaryPathCache: Record<'ffmpeg' | 'ffprobe', string | null | undefined> = {
  ffmpeg: undefined,
  ffprobe: undefined
}

function execFileAsync(command: string, args: string[], options: ExecFileOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        ...options,
        encoding: 'utf8',
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout ?? '')
      }
    )
  })
}

async function resolveBinary(binary: 'ffmpeg' | 'ffprobe'): Promise<string | null> {
  const cached = binaryPathCache[binary]
  if (cached !== undefined) {
    return cached
  }

  const isWindows = process.platform === 'win32'
  const executable = `${binary}${isWindows ? '.exe' : ''}`
  const systemCandidates = binary === 'ffmpeg'
    ? (isWindows ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'])
    : (isWindows ? ['ffprobe.exe', 'ffprobe'] : ['ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'])

  const staticModulePath = await resolveStaticModuleBinary(binary)
  const candidateSet = new Set<string>([
    ...(isDev ? [] : [
      join(process.resourcesPath, executable),
      join(process.resourcesPath, 'bin', executable)
    ]),
    ...(staticModulePath ? [staticModulePath] : []),
    ...systemCandidates
  ])
  const candidates = Array.from(candidateSet).flatMap((candidate) => {
    const unpacked = toAsarUnpackedPath(candidate)
    return unpacked !== candidate ? [candidate, unpacked] : [candidate]
  })

  for (const candidate of candidates) {
    if (looksLikePath(candidate)) {
      try {
        await access(candidate)
      } catch {
        continue
      }
    }
    try {
      await execFileAsync(candidate, ['-version'], { timeout: 4000, maxBuffer: 64 * 1024 })
      binaryPathCache[binary] = candidate
      return candidate
    } catch {
      // Try next candidate.
    }
  }

  binaryPathCache[binary] = null
  return null
}

async function resolveStaticModuleBinary(binary: 'ffmpeg' | 'ffprobe'): Promise<string | null> {
  try {
    if (binary === 'ffmpeg') {
      const module = await import('ffmpeg-static')
      return typeof module.default === 'string' ? module.default : null
    }

    const module = await import('ffprobe-static') as { path?: string; default?: { path?: string } }
    const modulePath = module.path ?? module.default?.path
    return typeof modulePath === 'string' ? modulePath : null
  } catch {
    return null
  }
}

function toAsarUnpackedPath(candidate: string): string {
  if (!candidate.includes('app.asar')) return candidate
  return candidate.replace('app.asar', 'app.asar.unpacked')
}

function looksLikePath(candidate: string): boolean {
  return candidate.includes('/') || candidate.includes('\\') || /^[a-zA-Z]:[\\/]/.test(candidate)
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function toNumberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function normalizeReplayGainTagId(id: string): string {
  return id.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function isTrackReplayGainTagId(id: string): boolean {
  const normalized = normalizeReplayGainTagId(id)
  return normalized.includes('replaygain_track_gain') || normalized.includes('rg_track_gain')
}

function isAlbumReplayGainTagId(id: string): boolean {
  const normalized = normalizeReplayGainTagId(id)
  return normalized.includes('replaygain_album_gain') || normalized.includes('rg_album_gain')
}

function toReplayGainNumberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = toReplayGainNumberOrUndefined(entry)
      if (parsed != null) return parsed
    }
    return undefined
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined

    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) return parsed

    const withDbSuffix = trimmed.replace(/\s*dB\s*$/i, '').trim()
    const parsedWithDbSuffix = Number(withDbSuffix)
    if (Number.isFinite(parsedWithDbSuffix)) return parsedWithDbSuffix

    const match = trimmed.match(/[+-]?\d+(?:[.,]\d+)?/)
    if (!match) return undefined
    const parsedFromMatch = Number(match[0].replace(',', '.'))
    return Number.isFinite(parsedFromMatch) ? parsedFromMatch : undefined
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const candidates: unknown[] = [record.dB, record.db, record.gain, record.value, record.text]
    for (const candidate of candidates) {
      const parsed = toReplayGainNumberOrUndefined(candidate)
      if (parsed != null) return parsed
    }
  }
  return undefined
}

function extractReplayGainDb(metadata: mm.IAudioMetadata): {
  trackGainDb?: number
  albumGainDb?: number
} {
  const common = metadata.common as unknown as Record<string, unknown>
  let trackGainDb = toReplayGainNumberOrUndefined(common.replaygain_track_gain)
  let albumGainDb = toReplayGainNumberOrUndefined(common.replaygain_album_gain)

  for (const [key, rawValue] of Object.entries(common)) {
    if (trackGainDb == null && isTrackReplayGainTagId(key)) {
      trackGainDb = toReplayGainNumberOrUndefined(rawValue)
    }
    if (albumGainDb == null && isAlbumReplayGainTagId(key)) {
      albumGainDb = toReplayGainNumberOrUndefined(rawValue)
    }
    if (trackGainDb != null && albumGainDb != null) {
      break
    }
  }

  if (trackGainDb == null || albumGainDb == null) {
    const nativeCollections = Object.values(metadata.native ?? {})
    for (const tags of nativeCollections) {
      if (!Array.isArray(tags)) continue
      for (const rawTag of tags) {
        if (!rawTag || typeof rawTag !== 'object') continue
        const tag = rawTag as { id?: unknown; value?: unknown }
        const id = typeof tag.id === 'string' ? tag.id : ''
        if (!id) continue

        if (trackGainDb == null && isTrackReplayGainTagId(id)) {
          trackGainDb = toReplayGainNumberOrUndefined(tag.value)
        }
        if (albumGainDb == null && isAlbumReplayGainTagId(id)) {
          albumGainDb = toReplayGainNumberOrUndefined(tag.value)
        }
        if (trackGainDb != null && albumGainDb != null) {
          break
        }
      }
      if (trackGainDb != null && albumGainDb != null) {
        break
      }
    }
  }

  return {
    trackGainDb: trackGainDb ?? toReplayGainNumberOrUndefined(metadata.format.trackGain),
    albumGainDb: albumGainDb ?? toReplayGainNumberOrUndefined(metadata.format.albumGain)
  }
}

function collectFfprobeHints(stream: Record<string, unknown>, format?: Record<string, unknown>): string[] {
  const hints: string[] = []
  const push = (value: unknown) => {
    const text = toStringOrUndefined(value)
    if (text) hints.push(text)
  }

  push(stream.codec_name)
  push(stream.codec_long_name)
  push(stream.profile)
  push(stream.codec_tag_string)
  push(stream.codec_tag)
  push(stream.channel_layout)

  const streamTags = stream.tags
  if (streamTags && typeof streamTags === 'object') {
    for (const tagValue of Object.values(streamTags)) {
      push(tagValue)
    }
  }

  const sideDataList = stream.side_data_list
  if (Array.isArray(sideDataList)) {
    for (const sideData of sideDataList) {
      if (!sideData || typeof sideData !== 'object') continue
      for (const sideDataValue of Object.values(sideData)) {
        push(sideDataValue)
      }
    }
  }

  if (format && typeof format === 'object') {
    push(format.format_name)
    push(format.format_long_name)
    const formatTags = format.tags
    if (formatTags && typeof formatTags === 'object') {
      for (const tagValue of Object.values(formatTags)) {
        push(tagValue)
      }
    }
  }

  return hints
}

function shouldProbeWithFfprobe(filePath: string, metadata: LoadedAudioMetadata): boolean {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.m4a' || ext === '.mp4' || ext === '.m4b' || ext === '.m4p' || ext === '.aac') {
    return true
  }

  return !metadata.channels || !metadata.codec || !metadata.codecProfile
}

async function probeAudioMetadataWithFfprobe(filePath: string): Promise<FfprobeAudioMetadata | null> {
  const ffprobePath = await resolveBinary('ffprobe')
  if (!ffprobePath) return null

  try {
    const stdout = await execFileAsync(
      ffprobePath,
      [
        '-v', 'error',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        '-select_streams', 'a:0',
        filePath
      ],
      { timeout: 10000, maxBuffer: 1024 * 1024 }
    )
    const parsed = JSON.parse(stdout) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> }
    const stream = parsed.streams?.[0]
    if (!stream) return null

    const codecName = toStringOrUndefined(stream.codec_name)
    const codecLongName = toStringOrUndefined(stream.codec_long_name)
    const codecProfile = toStringOrUndefined(stream.profile)
    const channels = toNumberOrUndefined(stream.channels)
    const hints = collectFfprobeHints(stream, parsed.format)

    return {
      channels,
      codec: codecName ?? codecLongName,
      codecProfile,
      isAtmosJoc: isAtmosJocStream(codecName ?? codecLongName, codecProfile, hints),
      hints
    }
  } catch (error) {
    console.warn(`ffprobe metadata probe failed for ${filePath}:`, error)
    return null
  }
}

async function decodeAudioWithFfmpeg(filePath: string): Promise<ArrayBuffer | null> {
  const ffmpegPath = await resolveBinary('ffmpeg')
  if (!ffmpegPath) return null

  const tempDir = await mkdtemp(join(tmpdir(), 'astra-ffmpeg-'))
  const outputPath = join(tempDir, 'decoded.wav')

  try {
    await execFileAsync(
      ffmpegPath,
      [
        '-v', 'error',
        '-y',
        '-i', filePath,
        '-map', '0:a:0',
        '-vn',
        '-c:a', 'pcm_s16le',
        '-f', 'wav',
        outputPath
      ],
      { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }
    )

    const decoded = await readFile(outputPath)
    return decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength)
  } catch (error) {
    console.warn(`FFmpeg compatibility decode failed for ${filePath}:`, error)
    return null
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function loadAudioFile(filePath: string, options: LoadAudioFileOptions = {}) {
  const loadStartMs = Date.now()
  try {
    // Read file as buffer
    const buffer = await readFile(filePath)
    const name = basename(filePath)
    const fallbackTitle = name.replace(/\.[^.]+$/, '')
    const format = filePath.split('.').pop()?.toLowerCase() ?? 'unknown'

    if (options.metadataMode === 'none') {
      const elapsedMs = Date.now() - loadStartMs
      if (isDev && elapsedMs > 1500) {
        console.warn(`[perf] loadAudioFile slow path (${elapsedMs}ms):`, {
          filePath,
          metadataMode: 'none'
        })
      }
      return {
        path: filePath,
        name,
        data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      }
    }

    // Extract metadata using music-metadata with ffprobe enrichment fallback.
    let metadata: LoadedAudioMetadata = {
      title: fallbackTitle,
      artist: 'Unknown Artist',
      album: 'Unknown Album',
      format
    }

    try {
      const mm_metadata = await mm.parseFile(filePath)
      const common = mm_metadata.common
      const replayGain = extractReplayGainDb(mm_metadata)

      // Convert artwork to base64 data URL
      let artworkDataUrl: string | undefined
      if (common.picture && common.picture.length > 0) {
        const pic = common.picture[0]
        const base64 = Buffer.from(pic.data).toString('base64')
        artworkDataUrl = `data:${pic.format};base64,${base64}`
      }

      metadata = {
        title: common.title || fallbackTitle,
        artist: common.artist || 'Unknown Artist',
        album: common.album || 'Unknown Album',
        albumArtist: typeof common.albumartist === 'string' ? common.albumartist : undefined,
        duration: mm_metadata.format.duration,
        format,
        artwork: artworkDataUrl,
        channels: mm_metadata.format.numberOfChannels,
        codec: mm_metadata.format.codec,
        codecProfile: mm_metadata.format.codecProfile,
        isAtmosJoc: isAtmosJocStream(mm_metadata.format.codec, mm_metadata.format.codecProfile),
        replayGainTrackDb: replayGainScanEnabled
          ? replayGain.trackGainDb
          : undefined,
        replayGainAlbumDb: replayGainScanEnabled
          ? replayGain.albumGainDb
          : undefined
      }
    } catch {
      // Keep default metadata when parser fails.
    }

    if (shouldProbeWithFfprobe(filePath, metadata)) {
      const ffprobeMetadata = await probeAudioMetadataWithFfprobe(filePath)
      if (ffprobeMetadata) {
        metadata.channels = ffprobeMetadata.channels ?? metadata.channels
        metadata.codec = ffprobeMetadata.codec ?? metadata.codec
        metadata.codecProfile = ffprobeMetadata.codecProfile ?? metadata.codecProfile
        metadata.isAtmosJoc = Boolean(
          metadata.isAtmosJoc ||
          ffprobeMetadata.isAtmosJoc ||
          isAtmosJocStream(metadata.codec, metadata.codecProfile, ffprobeMetadata.hints)
        )
      }
    }

    const payload = {
      path: filePath,
      name: name,
      data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      metadata
    }
    const elapsedMs = Date.now() - loadStartMs
    if (isDev && elapsedMs > 1500) {
      console.warn(`[perf] loadAudioFile slow path (${elapsedMs}ms):`, {
        filePath,
        metadataMode: 'full'
      })
    }
    return payload
  } catch (error) {
    const elapsedMs = Date.now() - loadStartMs
    console.error('Failed to load audio file:', error)
    if (isDev && elapsedMs > 1500) {
      console.warn(`[perf] loadAudioFile failed slow path (${elapsedMs}ms):`, {
        filePath,
        metadataMode: options.metadataMode ?? 'full'
      })
    }
    return null
  }
}

function isAtmosJocStream(codec?: string, codecProfile?: string, hints: string[] = []): boolean {
  const codecText = (codec ?? '').toLowerCase()
  const profileText = (codecProfile ?? '').toLowerCase()
  const hintText = hints.join(' ').toLowerCase()
  const combined = `${codecText} ${profileText} ${hintText}`
  const mentionsAtmos =
    combined.includes('joc') ||
    combined.includes('atmos') ||
    combined.includes('dby1')
  const isEc3Family =
    combined.includes('ec-3') ||
    combined.includes('eac3') ||
    combined.includes('ec3') ||
    combined.includes('e-ac-3') ||
    combined.includes('dolby digital plus') ||
    combined.includes('dd+')

  // JOC indicates Atmos in E-AC-3-based streams.
  if (combined.includes('joc')) return true

  return mentionsAtmos && isEc3Family
}
