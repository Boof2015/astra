import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, screen, safeStorage, powerMonitor } from 'electron'
import { join, basename, extname } from 'path'
import { readFile, writeFile, mkdtemp, rm, access, mkdir } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams, type ExecFileOptions } from 'child_process'
import { createHash } from 'crypto'
import * as mm from 'music-metadata'
import * as library from './services/library'
import {
  deepScanFlacIntegrityTrack,
  isFlacTarget,
  isIntegrityScanCancelledError,
  quickScanIntegrityTrack,
  resolveIntegrityWorkerCount,
  runIntegrityWithConcurrency,
  type IntegrityFindingInput,
  type IntegrityScanTrackTarget
} from './services/libraryIntegrity'
import { LibraryLatestSyncCoordinator } from './services/libraryLatestSync'
import {
  buildSubsonicStreamUrl,
  fetchSubsonicCoverArt,
  fetchSubsonicStarredTrackIds,
  fetchSubsonicTrackBytes,
  normalizeSubsonicBaseUrl,
  parseSubsonicArtworkHash,
  parseSubsonicTrackPath,
  syncSubsonicCatalog,
  syncSubsonicPlaylists,
  testSubsonicConnection,
  type SubsonicDownloadProgress
} from './services/subsonic'
import {
  authenticateJellyfin,
  buildJellyfinStreamRequestHeaders,
  buildJellyfinStreamUrl,
  buildJellyfinTranscodeStreamUrl,
  fetchJellyfinCoverArt,
  fetchJellyfinTrackBytes,
  normalizeJellyfinBaseUrl,
  parseJellyfinTrackPath,
  syncJellyfinCatalog,
  testJellyfinConnection,
  type JellyfinDownloadProgress
} from './services/jellyfin'
import type {
  RemoteAudioLoadProgress,
  RemoteStreamChunk,
  RemoteStreamEvent,
  RemoteStreamInfo,
  RemoteStreamSourceType
} from '../types/remoteStream'
import {
  discordRpcService,
  type DiscordPresenceUpdate,
  type DiscordRpcConfigureOptions
} from './services/discordRpc'
import { resolveDiscordCoverArtUrl } from './services/discordCoverArtLookup'
import { checkForUpdates, RELEASES_PAGE_URL } from './services/updates'
import { LocalApiService, generateLocalApiToken } from './services/localApi'
import { PhoneRemoteService } from './services/phoneRemote'
import { LastFmService, sanitizePendingScrobbles } from './services/lastFm'
import { LyricsService } from './services/lyrics'
import { MemoryDiagnosticsService } from './services/memoryDiagnostics'
import { getMusicMetadataParseOptions } from './utils/musicMetadata'
import {
  MINI_WINDOW_MIN_HEIGHT,
  MINI_WINDOW_MIN_WIDTH,
  loadMiniWindowPrefs,
  normalizeMiniPlayerVisualizerMode,
  saveMiniWindowPrefs,
} from './services/miniWindowPrefs'
import {
  loadLyricsPopoutWindowPrefs,
  saveLyricsPopoutWindowPrefs,
} from './services/lyricsPopoutWindowPrefs'
import {
  MAIN_WINDOW_DEFAULT_HEIGHT,
  MAIN_WINDOW_DEFAULT_WIDTH,
  MAIN_WINDOW_MIN_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH,
  loadMainWindowPrefs,
  saveMainWindowPrefs,
  type MainWindowPrefs
} from './services/mainWindowPrefs'
import {
  mergeMiniPlayerSnapshots,
  type MiniPlayerCommand,
  type MiniPlayerSnapshot,
  type MiniPlayerVisualizerStreamChunk,
  type MiniPlayerWindowPrefs,
  type MiniPlayerWindowState,
} from '../types/miniPlayer'
import {
  formatArtistNames,
  normalizeArtistNames
} from '../shared/library/artistCredits'
import {
  LYRICS_POPOUT_WINDOW_MIN_HEIGHT,
  LYRICS_POPOUT_WINDOW_MIN_WIDTH,
  type LyricsPopoutCommand,
  type LyricsPopoutSnapshot,
  type LyricsPopoutWindowPrefs,
  type LyricsPopoutWindowState,
} from '../types/lyricsPopout'
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
import {
  PHONE_REMOTE_DEFAULT_PORT,
  PHONE_REMOTE_MAX_PORT,
  PHONE_REMOTE_MIN_PORT,
  type PhoneRemoteServiceConfig
} from '../types/phoneRemote'
import {
  LASTFM_OFFICIAL_API_BASE_URL,
  LASTFM_OFFICIAL_PROFILE_ID,
  isLastFmCustomEndpoint,
  normalizeLastFmApiBaseUrl,
  normalizeLastFmScrobbleProtocol,
  parseListenBrainzApiBaseUrl,
  parseLastFmApiBaseUrl,
  lastFmProfileRequiresApiCredentials,
  type LastFmCustomProfileInput,
  type LastFmProfileConfig,
  type LastFmServiceConfig
} from '../types/lastFm'
import type { LyricsFormat, LyricsTrackQuery } from '../types/lyrics'
import type { UIScaleShortcutAction } from '../types/uiScale'
import type {
  JellyfinSource,
  JellyfinSourceCreateInput,
  JellyfinSourceLastStatus,
  JellyfinSourceSyncProgress,
  JellyfinSourceTestInput,
  JellyfinSourceTestResult,
  JellyfinSyncPhase,
  JellyfinSourceUpdateInput,
  JellyfinStatusSnapshot,
  SubsonicSource,
  SubsonicSourceCreateInput,
  SubsonicSourceLastStatus,
  SubsonicSourceSyncProgress,
  SubsonicSourceTestInput,
  SubsonicSourceTestResult,
  SubsonicSyncPhase,
  SubsonicSourceUpdateInput,
  SubsonicStatusSnapshot
} from '../types/subsonic'
import type {
  MemoryDiagnosticsEventPayload,
  MemoryDiagnosticsRendererSnapshot,
  MemoryDiagnosticsSnapshotRequest
} from '../types/diagnostics'
import type { AppBuildInfo } from '../types/appBuildInfo'
import type {
  IntegrityFinding,
  IntegrityScanMode,
  IntegrityScanProgress,
  IntegrityScanResult,
  IntegrityScanScope,
  IntegrityScanSummary
} from '../types/libraryIntegrity'
import { resolveUIScaleShortcutAction } from './uiScaleShortcuts'

// Check if running in development
const isDev = process.env.NODE_ENV === 'development'

interface ResolvedBuildMetadata {
  commitHash: string | null
  isDirty: boolean
}

const DIRTY_ENV_TRUE_VALUES = new Set(['1', 'true', 'yes', 'dirty'])
const DIRTY_ENV_FALSE_VALUES = new Set(['0', 'false', 'no', 'clean'])
let cachedBuildMetadata: ResolvedBuildMetadata | null = null

let mainWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null
let lyricsPopoutWindow: BrowserWindow | null = null
const scopePopoutWindows: Record<ScopeKind, BrowserWindow | null> = {
  spectrum: null,
  oscilloscope: null,
  vectorscope: null,
  spectrogram: null,
  vumeter: null,
  lufsmeter: null,
  waveform: null,
}
let scopePopoutState: ScopePopoutState = { ...DEFAULT_SCOPE_POPOUT_STATE }
let mainWindowPrefs: MainWindowPrefs | null = null
let miniWindowPrefs: MiniPlayerWindowPrefs | null = null
let lyricsPopoutWindowPrefs: LyricsPopoutWindowPrefs | null = null
let latestMiniPlayerSnapshot: MiniPlayerSnapshot | null = null
let latestMiniVisualizerChunk: MiniPlayerVisualizerStreamChunk | null = null
let latestLyricsPopoutSnapshot: LyricsPopoutSnapshot | null = null
const latestScopePopoutChunks: Partial<Record<ScopeKind, ScopePopoutChunk>> = {}
let mainWindowPersistTimer: ReturnType<typeof setTimeout> | null = null
let miniWindowPersistTimer: ReturnType<typeof setTimeout> | null = null
let lyricsPopoutWindowPersistTimer: ReturnType<typeof setTimeout> | null = null
let fileCreatedAtBackfillTimer: ReturnType<typeof setTimeout> | null = null
let audioMetadataBackfillTimer: ReturnType<typeof setTimeout> | null = null
let artistCreditsBackfillTimer: ReturnType<typeof setTimeout> | null = null
let replayGainBackfillTimer: ReturnType<typeof setTimeout> | null = null
let subsonicSyncTimer: ReturnType<typeof setInterval> | null = null
let jellyfinSyncTimer: ReturnType<typeof setInterval> | null = null
let replayGainScanEnabled: boolean = false
let subsonicSyncInFlight = false
let jellyfinSyncInFlight = false
let associatedOpenRendererReady = false
const associatedOpenPendingPaths: string[] = []
const latestLibrarySyncCoordinator = new LibraryLatestSyncCoordinator({
  getCurrentAlbumIdentityKeys: () => library.listAlbumIdentityKeys(),
  publishSummary: (summary) => library.setLatestLibrarySyncSummary(summary)
})

function normalizeBuildCommitHash(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseDirtyEnvValue(value: unknown): boolean | null {
  if (typeof value !== 'string') return null

  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  if (DIRTY_ENV_TRUE_VALUES.has(normalized)) return true
  if (DIRTY_ENV_FALSE_VALUES.has(normalized)) return false
  return null
}

function normalizeLatestSyncSessionKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

async function finalizeLatestLibrarySyncSession(
  sessionKey: string,
  success: boolean,
  contextLabel: string
): Promise<void> {
  try {
    await latestLibrarySyncCoordinator.endOperation(sessionKey, success)
  } catch (error) {
    console.warn(`Failed to finalize latest library sync session for ${contextLabel}:`, error)
  }
}

function tryReadBuildMetadataFile(filePath: string): ResolvedBuildMetadata | null {
  try {
    const payload = JSON.parse(readFileSync(filePath, 'utf8')) as { commitHash?: unknown; isDirty?: unknown }
    const commitHash = normalizeBuildCommitHash(payload.commitHash)
    const isDirty = payload.isDirty === true

    if (!commitHash) {
      return {
        commitHash: null,
        isDirty: false
      }
    }

    return {
      commitHash,
      isDirty
    }
  } catch {
    return null
  }
}

function tryResolveGitBuildMetadataFromDirectory(directory: string): ResolvedBuildMetadata | null {
  if (!existsSync(join(directory, '.git'))) {
    return null
  }

  try {
    const commitHash = normalizeBuildCommitHash(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }))

    if (!commitHash) {
      return null
    }

    const isDirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim().length > 0

    return {
      commitHash,
      isDirty
    }
  } catch {
    return null
  }
}

function resolveBuildMetadata(): ResolvedBuildMetadata {
  if (cachedBuildMetadata) {
    return cachedBuildMetadata
  }

  const envCommitHash = normalizeBuildCommitHash(
    process.env.ASTRA_GIT_COMMIT ?? process.env.ASTRA_BUILD_COMMIT_HASH
  )
  const envDirty = parseDirtyEnvValue(
    process.env.ASTRA_GIT_DIRTY ?? process.env.ASTRA_BUILD_DIRTY
  )

  if (envCommitHash) {
    cachedBuildMetadata = {
      commitHash: envCommitHash,
      isDirty: envDirty ?? false
    }
    return cachedBuildMetadata
  }

  const metadataFileCandidates = Array.from(new Set([
    join(__dirname, '..', 'build-metadata.json'),
    join(process.cwd(), 'out', 'build-metadata.json'),
    join(app.getAppPath(), 'out', 'build-metadata.json')
  ]))

  for (const candidate of metadataFileCandidates) {
    const metadata = tryReadBuildMetadataFile(candidate)
    if (metadata) {
      cachedBuildMetadata = {
        commitHash: metadata.commitHash,
        isDirty: envDirty ?? metadata.isDirty
      }
      return cachedBuildMetadata
    }
  }

  const gitDirectoryCandidates = Array.from(new Set([
    process.cwd(),
    app.getAppPath(),
    join(__dirname, '../..')
  ]))

  for (const candidate of gitDirectoryCandidates) {
    const metadata = tryResolveGitBuildMetadataFromDirectory(candidate)
    if (metadata) {
      cachedBuildMetadata = {
        commitHash: metadata.commitHash,
        isDirty: envDirty ?? metadata.isDirty
      }
      return cachedBuildMetadata
    }
  }

  cachedBuildMetadata = {
    commitHash: null,
    isDirty: false
  }
  return cachedBuildMetadata
}

const MINI_WINDOW_PERSIST_DEBOUNCE_MS = 220
const MAIN_WINDOW_PERSIST_DEBOUNCE_MS = MINI_WINDOW_PERSIST_DEBOUNCE_MS
const FILE_CREATED_AT_BACKFILL_STARTUP_DELAY_MS = 13_000
const FILE_CREATED_AT_BACKFILL_MIGRATION_KEY = 'file_created_at_backfill_v1_done'
const AUDIO_METADATA_BACKFILL_STARTUP_DELAY_MS = 15_000
const AUDIO_METADATA_BACKFILL_MIGRATION_KEY = 'audio_metadata_backfill_v2_done'
const ARTIST_CREDITS_BACKFILL_STARTUP_DELAY_MS = 16_000
const ARTIST_CREDITS_BACKFILL_MIGRATION_KEY = 'artist_credits_backfill_v1_done'
const REPLAYGAIN_BACKFILL_STARTUP_DELAY_MS = 17_000
const REPLAYGAIN_SCAN_ENABLED_META_KEY = 'replaygain_scan_enabled_v1'
const REPLAYGAIN_BACKFILL_MIGRATION_KEY = 'replaygain_backfill_v2_done'
const RUNTIME_ICON_DATA_URL_PREFIX = 'data:image/'
const MAX_RUNTIME_ICON_DATA_URL_LENGTH = 2_000_000
const MAX_RUNTIME_ICON_IMAGE_SET_DATA_URL_LENGTH = 3_500_000
const MAX_RUNTIME_ICON_IMAGE_SET_IMAGES = 10
const MIN_RUNTIME_ICON_IMAGE_SIZE = 16
const MAX_RUNTIME_ICON_IMAGE_SIZE = 2048
const LOCAL_API_ENABLED_META_KEY = 'local_api_enabled_v1'
const LOCAL_API_CONTROLS_ENABLED_META_KEY = 'local_api_controls_enabled_v1'
const LOCAL_API_PORT_META_KEY = 'local_api_port_v1'
const LOCAL_API_TOKEN_META_KEY = 'local_api_token_v1'
const PHONE_REMOTE_ENABLED_META_KEY = 'local_api_remote_web_enabled_v1'
const PHONE_REMOTE_PORT_META_KEY = 'phone_remote_port_v1'
const PHONE_REMOTE_PAIRED_DEVICES_META_KEY = 'local_api_paired_devices_v1'
const LASTFM_ENABLED_META_KEY = 'lastfm_enabled_v1'
const LASTFM_API_BASE_URL_META_KEY = 'lastfm_api_base_url_v1'
const LASTFM_SESSION_KEY_META_KEY = 'lastfm_session_key_v1'
const LASTFM_SESSION_USERNAME_META_KEY = 'lastfm_session_username_v1'
const LASTFM_PENDING_SCROBBLES_META_KEY = 'lastfm_pending_scrobbles_v1'
const LASTFM_ACTIVE_PROFILE_ID_META_KEY = 'lastfm_active_profile_id_v1'
const LASTFM_PROFILES_META_KEY = 'lastfm_profiles_v1'
const LYRICS_ONLINE_ENABLED_META_KEY = 'lyrics_online_enabled_v1'
const TRACKLIST_THUMB_MAX_EDGE_PX = 96
const CARD_ARTWORK_MAX_EDGE_PX = 320
const TRACKLIST_THUMB_JPEG_QUALITY = 78
const CARD_ARTWORK_JPEG_QUALITY = 84
const REMOTE_CONTROLLER_ARTWORK_MAX_EDGE_PX = 256
const REMOTE_CONTROLLER_ARTWORK_JPEG_QUALITY = 80
const ARTWORK_THUMB_CACHE_VERSION = 'v2'
const RELEASES_URL_HOSTNAME = 'github.com'
const RELEASES_URL_PATH_PREFIX = '/boof2015/astra/releases'
const MEMORY_DIAGNOSTICS_ENABLED_META_KEY = 'memory_diagnostics_enabled_v1'
const MEMORY_DIAGNOSTICS_SAMPLE_INTERVAL_MS = 15_000
const SUBSONIC_SYNC_INTERVAL_MS = 20 * 60 * 1000
const SUBSONIC_STREAM_MAX_BITRATE_KBPS = 256
const JELLYFIN_STREAM_MAX_BITRATE_KBPS = 256
const SUBSONIC_DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS = 80
const REMOTE_STREAM_PLAYABLE_SECONDS = 0.75
const REMOTE_STREAM_CHUNK_FRAMES = 4096
const JELLYFIN_AUTH_CACHE_TTL_MS = 30 * 60 * 1000

let artworkThumbnailCacheDir = ''
const artworkThumbnailRequestCache = new Map<string, Promise<string | null>>()
const subsonicArtworkResolveRequestCache = new Map<string, Promise<string | null>>()
let subsonicStatusCache: SubsonicStatusSnapshot = {
  isSyncing: false,
  updatedAt: Date.now(),
  sources: []
}
const subsonicSyncProgressBySourceId = new Map<number, SubsonicSourceSyncProgress>()
let jellyfinStatusCache: JellyfinStatusSnapshot = {
  isSyncing: false,
  updatedAt: Date.now(),
  sources: []
}
const jellyfinSyncProgressBySourceId = new Map<number, JellyfinSourceSyncProgress>()
const jellyfinAuthCacheBySourceId = new Map<number, { authContext: { accessToken: string; userId: string }; expiresAt: number }>()
const remoteStreamSessions = new Map<number, RemoteStreamSession>()
let nextRemoteStreamSessionId = 1

let localApiConfig: LocalApiServiceConfig = {
  enabled: false,
  controlsEnabled: false,
  port: LOCAL_API_DEFAULT_PORT,
  token: generateLocalApiToken(),
}
let phoneRemoteConfig: PhoneRemoteServiceConfig = {
  enabled: false,
  controlsEnabled: false,
  port: PHONE_REMOTE_DEFAULT_PORT
}
type PersistedPhoneRemotePairedDevice = {
  id: string
  name: string
  clientLabel: string
  tokenHash: string
  tokenPrefix: string
  createdAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}
let phoneRemotePairedDevices: PersistedPhoneRemotePairedDevice[] = []
let lastFmConfig: LastFmServiceConfig = {
  enabled: false,
  activeProfileId: LASTFM_OFFICIAL_PROFILE_ID,
  profiles: [{
    id: LASTFM_OFFICIAL_PROFILE_ID,
    kind: 'official',
    protocol: 'lastfm2',
    name: 'Official Last.fm',
    apiBaseUrl: LASTFM_OFFICIAL_API_BASE_URL,
    enabled: false,
    sessionKey: null,
    username: null,
    pendingScrobbles: []
  }]
}
let lyricsOnlineEnabled = false
let memoryDiagnosticsService: MemoryDiagnosticsService | null = null
let isAppQuitting = false

function getMemoryDiagnosticsProcessLabels(): Record<number, string> {
  const labels: Record<number, string> = {
    [process.pid]: 'browser'
  }

  const registerWindowProcess = (label: string, window: BrowserWindow | null): void => {
    if (!window || window.isDestroyed()) return
    const pid = window.webContents.getOSProcessId()
    if (Number.isInteger(pid) && pid > 0) {
      labels[pid] = label
    }
  }

  registerWindowProcess('main_window', mainWindow)
  registerWindowProcess('mini_window', miniWindow)
  registerWindowProcess('lyrics_popout_window', lyricsPopoutWindow)
  for (const scope of SCOPE_KINDS) {
    registerWindowProcess(`scope_${scope}`, scopePopoutWindows[scope])
  }

  return labels
}

function getMemoryDiagnosticsWindowRoleSummary(): Record<string, unknown> {
  return {
    mainWindowOpen: Boolean(mainWindow && !mainWindow.isDestroyed()),
    miniWindowOpen: Boolean(miniWindow && !miniWindow.isDestroyed()),
    lyricsPopoutWindowOpen: Boolean(lyricsPopoutWindow && !lyricsPopoutWindow.isDestroyed()),
    scopeOpenCount: SCOPE_KINDS.reduce((count, scope) => {
      const scopeWindow = getScopePopoutWindow(scope)
      return count + (scopeWindow && !scopeWindow.isDestroyed() ? 1 : 0)
    }, 0),
    scopePopouts: getScopePopoutState()
  }
}

function sendToWindow(window: BrowserWindow | null, channel: string, ...args: unknown[]): boolean {
  if (isAppQuitting || !window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return false
  }

  try {
    const frame = window.webContents.mainFrame
    if (frame.isDestroyed() || frame.detached) {
      return false
    }
    frame.send(channel, ...args)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('Render frame was disposed')) {
      console.warn(`Failed to send ${channel}:`, error)
    }
    return false
  }
}

function broadcastMemoryDiagnosticsStatus(): void {
  if (!memoryDiagnosticsService || !mainWindow || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send('diagnostics:status', memoryDiagnosticsService.getStatus())
}

function sendRendererSnapshotRequest(request: MemoryDiagnosticsSnapshotRequest): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false
  }
  mainWindow.webContents.send('diagnostics:requestRendererSnapshot', request)
  return true
}

function logMemoryDiagnosticsMainEvent(
  name: string,
  details?: Record<string, unknown>,
  options: { captureSample?: boolean } = {}
): void {
  if (!memoryDiagnosticsService) return
  void memoryDiagnosticsService.logEvent({
    name,
    source: 'main',
    details: details ?? null
  }, options)
}

function getMemoryDiagnosticsStatusSnapshot() {
  if (memoryDiagnosticsService) {
    return memoryDiagnosticsService.getStatus()
  }
  const logsDir = join(app.getPath('userData'), 'logs')
  return {
    enabled: false,
    sampleIntervalMs: MEMORY_DIAGNOSTICS_SAMPLE_INTERVAL_MS,
    currentLogPath: join(logsDir, 'memory-diagnostics-current.csv'),
    previousLogPath: join(logsDir, 'memory-diagnostics-prev.csv'),
    hasCurrentLog: false,
    hasPreviousLog: false,
    sessionStartedAt: null
  }
}

function normalizeMemoryDiagnosticsEventPayload(rawPayload: unknown): MemoryDiagnosticsEventPayload | null {
  if (!rawPayload || typeof rawPayload !== 'object') return null
  const payload = rawPayload as MemoryDiagnosticsEventPayload
  if (typeof payload.name !== 'string' || payload.name.trim().length === 0) return null
  if (payload.source !== 'main' && payload.source !== 'renderer') return null
  const details = payload.details
  return {
    name: payload.name.trim(),
    source: payload.source,
    details: details && typeof details === 'object' && !Array.isArray(details)
      ? details
      : null
  }
}

function stripEnvQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return value.slice(1, -1)
    }
  }
  return value
}

function stripInlineEnvComment(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '#') continue
    if (index === 0) return ''
    if (/\s/.test(value[index - 1])) {
      return value.slice(0, index).trimEnd()
    }
  }
  return value
}

function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = content.split(/\r?\n/)

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const equalsIndex = line.indexOf('=')
    if (equalsIndex <= 0) continue

    const key = line.slice(0, equalsIndex).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    const rawValue = line.slice(equalsIndex + 1).trim()
    const unquotedValue = stripEnvQuotes(rawValue)
    const value = rawValue === unquotedValue
      ? stripInlineEnvComment(unquotedValue)
      : unquotedValue
    out[key] = value
  }

  return out
}

function loadMainProcessEnvLocal(): void {
  const candidates = [
    join(process.cwd(), '.env.local'),
    join(__dirname, '../../.env.local')
  ]

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue

    try {
      const parsed = parseEnvFile(readFileSync(envPath, 'utf8'))
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] == null) {
          process.env[key] = value
        }
      }
      return
    } catch (error) {
      console.warn(`Failed to parse env file at ${envPath}:`, error)
    }
  }
}

loadMainProcessEnvLocal()
const LASTFM_API_KEY = (process.env.LASTFM_API_KEY ?? '').trim()
const LASTFM_SHARED_SECRET = (process.env.LASTFM_SHARED_SECRET ?? '').trim()

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
  resolveArtworkDataUrl: async (artworkHash) => getArtworkThumbnailDataUrlByHash(artworkHash, {
    maxEdgePx: REMOTE_CONTROLLER_ARTWORK_MAX_EDGE_PX,
    jpegQuality: REMOTE_CONTROLLER_ARTWORK_JPEG_QUALITY
  }),
  onStatusChange: () => {
    broadcastLocalApiStatus()
    const status = localApiService.getStatus()
    logMemoryDiagnosticsMainEvent('local_api_status_changed', {
      enabled: status.enabled,
      active: status.active,
      controlsEnabled: status.controlsEnabled,
      port: status.port,
      mode: status.mode,
      connectedClients: status.connectedClients,
      lastError: status.lastError
    })
  }
})

const phoneRemoteService = new PhoneRemoteService({
  config: phoneRemoteConfig,
  getSnapshot: () => latestMiniPlayerSnapshot,
  dispatchCommand: sendMiniPlayerCommand,
  resolveArtworkDataUrl: async (artworkHash) => getArtworkThumbnailDataUrlByHash(artworkHash, {
    maxEdgePx: REMOTE_CONTROLLER_ARTWORK_MAX_EDGE_PX,
    jpegQuality: REMOTE_CONTROLLER_ARTWORK_JPEG_QUALITY
  }),
  pairedDevices: phoneRemotePairedDevices,
  onPairedDevicesChange: (devices) => {
    phoneRemotePairedDevices = devices.map((device) => ({ ...device }))
    void persistPhoneRemotePairedDevices(phoneRemotePairedDevices).catch((error) => {
      console.warn('Failed to persist phone remote paired devices:', error)
    })
  },
  onStatusChange: () => {
    broadcastPhoneRemoteStatus()
    const status = phoneRemoteService.getStatus()
    logMemoryDiagnosticsMainEvent('phone_remote_status_changed', {
      enabled: status.enabled,
      active: status.active,
      controlsEnabled: status.controlsEnabled,
      port: status.port,
      connectedClients: status.connectedClients,
      pairedDeviceCount: status.pairedDeviceCount,
      pendingPairingCount: status.pendingPairingCount,
      lastError: status.lastError
    })
  }
})

const lastFmService = new LastFmService({
  config: lastFmConfig,
  apiKey: LASTFM_API_KEY,
  sharedSecret: LASTFM_SHARED_SECRET,
  openExternal: async (url: string) => {
    await shell.openExternal(url)
  },
  onConfigChange: async (config) => {
    lastFmConfig = {
      ...config,
      profiles: config.profiles.map((profile) => ({
        ...profile,
        pendingScrobbles: [...profile.pendingScrobbles]
      }))
    }
    await persistLastFmConfig(lastFmConfig)
  },
  onStatusChange: () => {
    broadcastLastFmStatus()
    const status = lastFmService.getStatus()
    logMemoryDiagnosticsMainEvent('lastfm_status_changed', {
      enabled: status.enabled,
      connected: status.connected,
      usingCustomEndpoint: status.usingCustomEndpoint,
      apiBaseUrl: status.apiBaseUrl,
      activeProfileId: status.activeProfileId,
      authPending: status.authPending,
      pendingScrobbles: status.pendingScrobbles,
      username: status.username,
      statusMessage: status.statusMessage,
      lastError: status.lastError
    })
  }
})

const lyricsService = new LyricsService({
  enabled: lyricsOnlineEnabled,
  appVersion: app.getVersion(),
  onStatusChange: () => {
    broadcastLyricsStatus()
    const status = lyricsService.getStatus()
    logMemoryDiagnosticsMainEvent('lyrics_status_changed', {
      enabled: status.enabled,
      provider: status.provider,
      statusMessage: status.statusMessage,
      lastError: status.lastError
    })
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
  spectrogram: {
    title: 'Astra Spectrogram',
    width: 760,
    height: 320,
    minWidth: 420,
    minHeight: 220,
  },
  vumeter: {
    title: 'Astra VU Meter',
    width: 480,
    height: 240,
    minWidth: 320,
    minHeight: 180,
  },
  lufsmeter: {
    title: 'Astra LUFS Meter',
    width: 480,
    height: 320,
    minWidth: 320,
    minHeight: 220,
  },
  waveform: {
    title: 'Astra Waveform',
    width: 760,
    height: 320,
    minWidth: 420,
    minHeight: 220,
  },
}

// Supported audio formats
const AUDIO_EXTENSIONS = ['mp3', 'flac', 'wav', 'ogg', 'aac', 'm4a', 'opus', 'wma', 'aiff', 'alac', 'ape', 'wv']
const AUDIO_EXTENSION_SET = new Set(AUDIO_EXTENSIONS.map((extension) => `.${extension}`))
const AUDIO_FILTERS = [
  {
    name: 'Audio Files',
    extensions: AUDIO_EXTENSIONS
  }
]

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

function normalizeAssociatedOpenPath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string') {
    return null
  }

  const trimmed = rawPath.trim()
  if (!trimmed || trimmed.startsWith('-')) {
    return null
  }

  let normalizedPath = trimmed
  if ((normalizedPath.startsWith('"') && normalizedPath.endsWith('"'))
    || (normalizedPath.startsWith('\'') && normalizedPath.endsWith('\''))) {
    normalizedPath = normalizedPath.slice(1, -1).trim()
  }
  if (!normalizedPath) {
    return null
  }

  const extension = extname(normalizedPath).toLowerCase()
  if (!AUDIO_EXTENSION_SET.has(extension)) {
    return null
  }
  if (!existsSync(normalizedPath)) {
    return null
  }
  return normalizedPath
}

function parseAssociatedOpenPathsFromArgv(argv: string[]): string[] {
  if (!Array.isArray(argv) || argv.length === 0) {
    return []
  }

  const uniquePaths = new Set<string>()
  for (const candidate of argv) {
    const normalizedPath = normalizeAssociatedOpenPath(candidate)
    if (normalizedPath) {
      uniquePaths.add(normalizedPath)
    }
  }
  return [...uniquePaths]
}

function canDispatchAssociatedOpenFiles(): boolean {
  if (!associatedOpenRendererReady) {
    return false
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false
  }
  if (mainWindow.webContents.isDestroyed()) {
    return false
  }
  return true
}

function flushAssociatedOpenFiles(): void {
  if (!canDispatchAssociatedOpenFiles()) {
    return
  }
  if (associatedOpenPendingPaths.length === 0) {
    return
  }

  const paths = [...associatedOpenPendingPaths]
  associatedOpenPendingPaths.length = 0
  mainWindow!.webContents.send('associated-open-files', paths)
}

function queueAssociatedOpenFiles(paths: string[]): void {
  if (paths.length === 0) {
    return
  }

  for (const path of paths) {
    if (associatedOpenPendingPaths.includes(path)) {
      continue
    }
    associatedOpenPendingPaths.push(path)
  }
  flushAssociatedOpenFiles()
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
}

function focusOrCreateMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  focusMainWindow()
}

function getMiniWindowState(): MiniPlayerWindowState {
  const isOpen = Boolean(miniWindow && !miniWindow.isDestroyed())
  const alwaysOnTop = isOpen
    ? miniWindow!.isAlwaysOnTop()
    : miniWindowPrefs?.alwaysOnTop ?? true
  const visualizerMode = normalizeMiniPlayerVisualizerMode(miniWindowPrefs?.visualizerMode)

  return { isOpen, alwaysOnTop, visualizerMode }
}

function getLyricsPopoutWindowState(): LyricsPopoutWindowState {
  return {
    isOpen: Boolean(lyricsPopoutWindow && !lyricsPopoutWindow.isDestroyed())
  }
}

function getAppBuildInfo(): AppBuildInfo {
  const buildMetadata = resolveBuildMetadata()
  const commitHash = buildMetadata.commitHash

  return {
    version: app.getVersion(),
    commitHash,
    shortCommitHash: commitHash ? commitHash.slice(0, 7) : null,
    isDirty: commitHash ? buildMetadata.isDirty : false
  }
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
    spectrogram: { x: 152, y: 152 },
    vumeter: { x: 184, y: 184 },
    lufsmeter: { x: 216, y: 216 },
    waveform: { x: 248, y: 248 },
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

async function loadMemoryDiagnosticsEnabledFromMeta(): Promise<boolean> {
  const enabled = parseMetaBoolean(library.getAppMeta(MEMORY_DIAGNOSTICS_ENABLED_META_KEY), false)
  const normalizedStoredValue = enabled ? '1' : '0'
  if (library.getAppMeta(MEMORY_DIAGNOSTICS_ENABLED_META_KEY) !== normalizedStoredValue) {
    try {
      await library.setAppMeta(MEMORY_DIAGNOSTICS_ENABLED_META_KEY, normalizedStoredValue)
    } catch (error) {
      console.warn('Failed to persist normalized memory diagnostics setting:', error)
    }
  }
  return enabled
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

function normalizePhoneRemotePort(rawPort: unknown): number {
  const parsed = typeof rawPort === 'number' ? rawPort : Number(rawPort)
  if (!Number.isInteger(parsed)) {
    throw new Error(`Port must be an integer between ${PHONE_REMOTE_MIN_PORT} and ${PHONE_REMOTE_MAX_PORT}.`)
  }
  if (parsed < PHONE_REMOTE_MIN_PORT || parsed > PHONE_REMOTE_MAX_PORT) {
    throw new Error(`Port must be between ${PHONE_REMOTE_MIN_PORT} and ${PHONE_REMOTE_MAX_PORT}.`)
  }
  return parsed
}

function sanitizePhoneRemotePairedDevices(rawDevices: unknown): PersistedPhoneRemotePairedDevice[] {
  if (!Array.isArray(rawDevices)) return []
  const sanitized: PersistedPhoneRemotePairedDevice[] = []

  for (const candidate of rawDevices) {
    if (!candidate || typeof candidate !== 'object') continue
    const value = candidate as Record<string, unknown>
    const id = typeof value.id === 'string' ? value.id.trim() : ''
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    const clientLabel = typeof value.clientLabel === 'string' ? value.clientLabel.trim() : ''
    const tokenHash = typeof value.tokenHash === 'string' ? value.tokenHash.trim() : ''
    const tokenPrefix = typeof value.tokenPrefix === 'string' ? value.tokenPrefix.trim() : ''
    const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
      ? Math.max(0, value.createdAt)
      : 0
    const lastSeenAt = typeof value.lastSeenAt === 'number' && Number.isFinite(value.lastSeenAt)
      ? Math.max(0, value.lastSeenAt)
      : null
    const revokedAt = typeof value.revokedAt === 'number' && Number.isFinite(value.revokedAt)
      ? Math.max(0, value.revokedAt)
      : null

    if (!id || !name || !clientLabel || !tokenHash || !tokenPrefix || createdAt <= 0) {
      continue
    }

    sanitized.push({
      id,
      name: name.slice(0, 80),
      clientLabel: clientLabel.slice(0, 80),
      tokenHash,
      tokenPrefix: tokenPrefix.slice(0, 16),
      createdAt,
      lastSeenAt,
      revokedAt
    })
  }

  return sanitized
}

async function persistLocalApiConfig(config: LocalApiServiceConfig): Promise<void> {
  await library.setAppMeta(LOCAL_API_ENABLED_META_KEY, config.enabled ? '1' : '0')
  await library.setAppMeta(LOCAL_API_CONTROLS_ENABLED_META_KEY, config.controlsEnabled ? '1' : '0')
  await library.setAppMeta(LOCAL_API_PORT_META_KEY, String(config.port))
  await library.setAppMeta(LOCAL_API_TOKEN_META_KEY, config.token)
}

async function persistPhoneRemoteConfig(config: PhoneRemoteServiceConfig): Promise<void> {
  await library.setAppMeta(PHONE_REMOTE_ENABLED_META_KEY, config.enabled ? '1' : '0')
  await library.setAppMeta(PHONE_REMOTE_PORT_META_KEY, String(config.port))
}

async function persistPhoneRemotePairedDevices(devices: PersistedPhoneRemotePairedDevice[]): Promise<void> {
  phoneRemotePairedDevices = devices.map((device) => ({ ...device }))
  await library.setAppMeta(PHONE_REMOTE_PAIRED_DEVICES_META_KEY, JSON.stringify(phoneRemotePairedDevices))
}

async function loadLocalApiConfigFromMeta(): Promise<LocalApiServiceConfig> {
  const enabled = parseMetaBoolean(library.getAppMeta(LOCAL_API_ENABLED_META_KEY), false)
  const controlsEnabledStored = parseMetaBoolean(library.getAppMeta(LOCAL_API_CONTROLS_ENABLED_META_KEY), false)

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
    controlsEnabled: controlsEnabledStored,
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

async function loadPhoneRemoteConfigFromMeta(controlsEnabled: boolean): Promise<PhoneRemoteServiceConfig> {
  const enabled = parseMetaBoolean(library.getAppMeta(PHONE_REMOTE_ENABLED_META_KEY), false)

  const rawPort = library.getAppMeta(PHONE_REMOTE_PORT_META_KEY)
  let port = PHONE_REMOTE_DEFAULT_PORT
  if (rawPort !== null) {
    try {
      port = normalizePhoneRemotePort(rawPort)
    } catch {
      port = PHONE_REMOTE_DEFAULT_PORT
    }
  }

  const normalized: PhoneRemoteServiceConfig = {
    enabled,
    controlsEnabled,
    port
  }

  const needsPersistence =
    library.getAppMeta(PHONE_REMOTE_ENABLED_META_KEY) !== (normalized.enabled ? '1' : '0') ||
    library.getAppMeta(PHONE_REMOTE_PORT_META_KEY) !== String(normalized.port)

  if (needsPersistence) {
    try {
      await persistPhoneRemoteConfig(normalized)
    } catch (error) {
      console.warn('Failed to persist normalized phone remote settings:', error)
    }
  }

  return normalized
}

async function loadPhoneRemotePairedDevicesFromMeta(): Promise<PersistedPhoneRemotePairedDevice[]> {
  let pairedDevices = sanitizePhoneRemotePairedDevices([])
  const rawPairedDevices = library.getAppMeta(PHONE_REMOTE_PAIRED_DEVICES_META_KEY)
  if (rawPairedDevices) {
    try {
      pairedDevices = sanitizePhoneRemotePairedDevices(JSON.parse(rawPairedDevices))
    } catch {
      pairedDevices = sanitizePhoneRemotePairedDevices([])
    }
  }

  if (library.getAppMeta(PHONE_REMOTE_PAIRED_DEVICES_META_KEY) !== JSON.stringify(pairedDevices)) {
    try {
      await persistPhoneRemotePairedDevices(pairedDevices)
    } catch (error) {
      console.warn('Failed to persist normalized phone remote paired devices:', error)
    }
  } else {
    phoneRemotePairedDevices = pairedDevices.map((device) => ({ ...device }))
  }

  return pairedDevices
}

async function applyLocalApiConfig(config: LocalApiServiceConfig): Promise<ReturnType<typeof localApiService.getStatus>> {
  localApiConfig = { ...config }
  await persistLocalApiConfig(localApiConfig)
  return localApiService.applyConfig(localApiConfig)
}

async function applyPhoneRemoteConfig(
  config: PhoneRemoteServiceConfig
): Promise<ReturnType<typeof phoneRemoteService.getStatus>> {
  phoneRemoteConfig = { ...config }
  await persistPhoneRemoteConfig(phoneRemoteConfig)
  return phoneRemoteService.applyConfig(phoneRemoteConfig)
}

function normalizeOptionalMetaText(value: string | null): string | null {
  if (value == null) return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function createOfficialLastFmProfile(
  sessionKey: string | null = null,
  username: string | null = null,
  pendingScrobbles = sanitizePendingScrobbles([]),
  enabled = false
): LastFmProfileConfig {
  return {
    id: LASTFM_OFFICIAL_PROFILE_ID,
    kind: 'official',
    protocol: 'lastfm2',
    name: 'Official Last.fm',
    apiBaseUrl: LASTFM_OFFICIAL_API_BASE_URL,
    enabled,
    sessionKey,
    username,
    pendingScrobbles
  }
}

function normalizeLastFmProfileName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 0 ? normalized.slice(0, 80) : fallback
}

function normalizeLastFmProfileEnabled(record: Record<string, unknown>, defaultEnabled: boolean): boolean {
  return typeof record.enabled === 'boolean' ? record.enabled : defaultEnabled
}

function normalizeLastFmProfilesFromMeta(raw: unknown, legacyActiveProfileId: string): LastFmProfileConfig[] | null {
  if (!Array.isArray(raw)) return null

  const customProfiles: LastFmProfileConfig[] = []
  let officialProfile = createOfficialLastFmProfile(null, null, sanitizePendingScrobbles([]), legacyActiveProfileId === LASTFM_OFFICIAL_PROFILE_ID)
  const usedIds = new Set<string>([LASTFM_OFFICIAL_PROFILE_ID])

  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const sessionKey = normalizeOptionalMetaText(typeof record.sessionKey === 'string' ? record.sessionKey : null)
    const username = normalizeOptionalMetaText(typeof record.username === 'string' ? record.username : null)
    const pendingScrobbles = sanitizePendingScrobbles(record.pendingScrobbles)

    if (record.kind === 'official' || record.id === LASTFM_OFFICIAL_PROFILE_ID) {
      officialProfile = createOfficialLastFmProfile(
        sessionKey,
        username,
        pendingScrobbles,
        normalizeLastFmProfileEnabled(record, legacyActiveProfileId === LASTFM_OFFICIAL_PROFILE_ID)
      )
      continue
    }

    if (record.kind !== 'custom') continue
    const protocol = normalizeLastFmScrobbleProtocol(record.protocol)
    const apiBaseUrl = protocol === 'listenbrainz'
      ? parseListenBrainzApiBaseUrl(record.apiBaseUrl)
      : parseLastFmApiBaseUrl(record.apiBaseUrl)
    if (!apiBaseUrl) continue
    if (protocol === 'lastfm2' && apiBaseUrl === LASTFM_OFFICIAL_API_BASE_URL) continue

    const rawId = normalizeOptionalMetaText(typeof record.id === 'string' ? record.id : null)
    const id = rawId && rawId !== LASTFM_OFFICIAL_PROFILE_ID && !usedIds.has(rawId)
      ? rawId
      : `custom-profile-${customProfiles.length + 1}`
    usedIds.add(id)
    const defaultEnabled = id === legacyActiveProfileId || rawId === legacyActiveProfileId

    customProfiles.push({
      id,
      kind: 'custom',
      protocol,
      name: normalizeLastFmProfileName(record.name, 'Custom endpoint'),
      apiBaseUrl,
      enabled: normalizeLastFmProfileEnabled(record, defaultEnabled),
      sessionKey,
      username,
      pendingScrobbles
    })
  }

  return [officialProfile, ...customProfiles]
}

function getLegacyLastFmProfile(config: LastFmServiceConfig): LastFmProfileConfig {
  return config.profiles.find((profile) => profile.enabled) ??
    config.profiles.find((profile) => profile.id === config.activeProfileId) ??
    config.profiles[0]
}

async function persistLastFmConfig(config: LastFmServiceConfig): Promise<void> {
  const activeProfile = getLegacyLastFmProfile(config)
  await library.setAppMeta(LASTFM_ENABLED_META_KEY, config.enabled ? '1' : '0')
  await library.setAppMeta(LASTFM_ACTIVE_PROFILE_ID_META_KEY, config.activeProfileId)
  await library.setAppMeta(LASTFM_PROFILES_META_KEY, JSON.stringify(config.profiles))
  await library.setAppMeta(
    LASTFM_API_BASE_URL_META_KEY,
    activeProfile.protocol === 'listenbrainz'
      ? (parseListenBrainzApiBaseUrl(activeProfile.apiBaseUrl) ?? activeProfile.apiBaseUrl)
      : normalizeLastFmApiBaseUrl(activeProfile.apiBaseUrl)
  )
  await library.setAppMeta(LASTFM_SESSION_KEY_META_KEY, activeProfile.sessionKey ?? '')
  await library.setAppMeta(LASTFM_SESSION_USERNAME_META_KEY, activeProfile.username ?? '')
  await library.setAppMeta(
    LASTFM_PENDING_SCROBBLES_META_KEY,
    JSON.stringify(activeProfile.pendingScrobbles)
  )
}

async function loadLastFmConfigFromMeta(): Promise<LastFmServiceConfig> {
  let profiles: LastFmProfileConfig[] | null = null
  let activeProfileId = normalizeOptionalMetaText(library.getAppMeta(LASTFM_ACTIVE_PROFILE_ID_META_KEY)) ?? LASTFM_OFFICIAL_PROFILE_ID
  const rawProfiles = library.getAppMeta(LASTFM_PROFILES_META_KEY)
  if (rawProfiles) {
    try {
      profiles = normalizeLastFmProfilesFromMeta(JSON.parse(rawProfiles), activeProfileId)
    } catch {
      profiles = null
    }
  }

  if (!profiles) {
    const rawApiBaseUrl = library.getAppMeta(LASTFM_API_BASE_URL_META_KEY)
    const hasStoredApiBaseUrl = rawApiBaseUrl != null && rawApiBaseUrl.trim().length > 0
    const parsedStoredApiBaseUrl = hasStoredApiBaseUrl ? parseLastFmApiBaseUrl(rawApiBaseUrl) : null
    const apiBaseUrl = parsedStoredApiBaseUrl ?? LASTFM_OFFICIAL_API_BASE_URL
    const invalidStoredApiBaseUrl = hasStoredApiBaseUrl && parsedStoredApiBaseUrl == null
    const sessionKey = invalidStoredApiBaseUrl ? null : normalizeOptionalMetaText(library.getAppMeta(LASTFM_SESSION_KEY_META_KEY))
    const username = invalidStoredApiBaseUrl ? null : normalizeOptionalMetaText(library.getAppMeta(LASTFM_SESSION_USERNAME_META_KEY))

    let pendingScrobbles = sanitizePendingScrobbles([])
    const rawPendingScrobbles = library.getAppMeta(LASTFM_PENDING_SCROBBLES_META_KEY)
    if (rawPendingScrobbles) {
      try {
        pendingScrobbles = sanitizePendingScrobbles(JSON.parse(rawPendingScrobbles))
      } catch {
        pendingScrobbles = sanitizePendingScrobbles([])
      }
    }

    if (isLastFmCustomEndpoint(apiBaseUrl)) {
      activeProfileId = 'custom-lastfm-endpoint'
      profiles = [
        createOfficialLastFmProfile(),
        {
          id: activeProfileId,
          kind: 'custom',
          protocol: 'lastfm2',
          name: 'Custom Last.fm endpoint',
          apiBaseUrl,
          enabled: Boolean(sessionKey && username) && LASTFM_API_KEY.length > 0 && LASTFM_SHARED_SECRET.length > 0,
          sessionKey,
          username,
          pendingScrobbles
        }
      ]
    } else {
      activeProfileId = LASTFM_OFFICIAL_PROFILE_ID
      profiles = [createOfficialLastFmProfile(
        sessionKey,
        username,
        pendingScrobbles,
        Boolean(sessionKey && username) && LASTFM_API_KEY.length > 0 && LASTFM_SHARED_SECRET.length > 0
      )]
    }
  }

  if (!profiles.some((profile) => profile.id === activeProfileId)) {
    activeProfileId = LASTFM_OFFICIAL_PROFILE_ID
  }

  profiles = profiles.map((profile) => {
    const connected = profile.protocol === 'listenbrainz'
      ? Boolean(profile.sessionKey)
      : Boolean(profile.sessionKey && profile.username)
    const hasRequiredApiCredentials = !lastFmProfileRequiresApiCredentials(profile) ||
      (LASTFM_API_KEY.length > 0 && LASTFM_SHARED_SECRET.length > 0)

    return {
      ...profile,
      enabled: profile.enabled && connected && hasRequiredApiCredentials
    }
  })
  const enabledStored = parseMetaBoolean(library.getAppMeta(LASTFM_ENABLED_META_KEY), false)
  const normalized: LastFmServiceConfig = {
    enabled: enabledStored,
    activeProfileId,
    profiles
  }

  const needsPersistence =
    library.getAppMeta(LASTFM_ENABLED_META_KEY) !== (normalized.enabled ? '1' : '0') ||
    library.getAppMeta(LASTFM_ACTIVE_PROFILE_ID_META_KEY) !== normalized.activeProfileId ||
    library.getAppMeta(LASTFM_PROFILES_META_KEY) !== JSON.stringify(normalized.profiles)

  if (needsPersistence) {
    try {
      await persistLastFmConfig(normalized)
    } catch (error) {
      console.warn('Failed to persist normalized Last.fm settings:', error)
    }
  }

  return normalized
}

async function applyLastFmConfig(config: LastFmServiceConfig): Promise<ReturnType<typeof lastFmService.getStatus>> {
  const normalized: LastFmServiceConfig = {
    enabled: config.enabled,
    activeProfileId: config.activeProfileId,
    profiles: config.profiles.map((profile) => ({
      ...profile,
      protocol: normalizeLastFmScrobbleProtocol(profile.protocol),
      apiBaseUrl: profile.protocol === 'listenbrainz'
        ? (parseListenBrainzApiBaseUrl(profile.apiBaseUrl) ?? profile.apiBaseUrl)
        : normalizeLastFmApiBaseUrl(profile.apiBaseUrl),
      enabled: Boolean(profile.enabled),
      pendingScrobbles: [...profile.pendingScrobbles]
    }))
  }
  lastFmConfig = normalized
  await persistLastFmConfig(lastFmConfig)
  return lastFmService.applyConfig(lastFmConfig)
}

async function persistLyricsConfig(enabled: boolean): Promise<void> {
  await library.setAppMeta(LYRICS_ONLINE_ENABLED_META_KEY, enabled ? '1' : '0')
}

async function loadLyricsConfigFromMeta(): Promise<boolean> {
  const enabled = parseMetaBoolean(library.getAppMeta(LYRICS_ONLINE_ENABLED_META_KEY), false)

  const normalizedStoredValue = enabled ? '1' : '0'
  if (library.getAppMeta(LYRICS_ONLINE_ENABLED_META_KEY) !== normalizedStoredValue) {
    try {
      await persistLyricsConfig(enabled)
    } catch (error) {
      console.warn('Failed to persist normalized lyrics integration setting:', error)
    }
  }

  return enabled
}

async function applyLyricsConfig(enabled: boolean): Promise<ReturnType<typeof lyricsService.getStatus>> {
  lyricsOnlineEnabled = Boolean(enabled)
  await persistLyricsConfig(lyricsOnlineEnabled)
  return lyricsService.applyConfig(lyricsOnlineEnabled)
}

function normalizeLyricsTrackQuery(rawQuery: unknown): LyricsTrackQuery | null {
  if (!rawQuery || typeof rawQuery !== 'object' || Array.isArray(rawQuery)) return null
  const record = rawQuery as Record<string, unknown>

  if (typeof record.path !== 'string') return null
  if (typeof record.title !== 'string') return null
  if (typeof record.artist !== 'string') return null

  return {
    path: record.path,
    title: record.title,
    artist: record.artist,
    album: typeof record.album === 'string' ? record.album : undefined,
    durationSeconds: typeof record.durationSeconds === 'number' ? record.durationSeconds : undefined
  }
}

function normalizeLyricsTrackPaths(rawTrackPaths: unknown): string[] {
  if (!Array.isArray(rawTrackPaths)) return []
  const normalized = rawTrackPaths
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0)
  return Array.from(new Set(normalized))
}

function normalizeLyricsOffsetMs(rawOffsetMs: unknown): number | null {
  if (typeof rawOffsetMs !== 'number' || !Number.isFinite(rawOffsetMs)) return null
  return Math.trunc(rawOffsetMs)
}

function normalizeLyricsImportFormat(rawFormat: unknown): LyricsFormat {
  return rawFormat === 'xlrc' || rawFormat === 'plain' || rawFormat === 'lrc' ? rawFormat : 'lrc'
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
  logMemoryDiagnosticsMainEvent('window_opened', {
    windowType: 'scope_popout',
    scope
  })

  scopeWindow.on('ready-to-show', () => {
    scopeWindow.show()
  })

  scopeWindow.on('closed', () => {
    scopePopoutWindows[scope] = null
    setScopePopoutOpenState(scope, false)
    logMemoryDiagnosticsMainEvent('window_closed', {
      windowType: 'scope_popout',
      scope
    })
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

  if (lyricsPopoutWindow && !lyricsPopoutWindow.isDestroyed()) {
    lyricsPopoutWindow.setIcon(image)
  }

  for (const scope of SCOPE_KINDS) {
    const scopeWindow = getScopePopoutWindow(scope)
    if (scopeWindow) {
      scopeWindow.setIcon(image)
    }
  }
}

interface RuntimeIconImageSetEntry {
  size: number
  dataUrl: string
}

function isRuntimeIconDataUrl(value: unknown): value is string {
  return typeof value === 'string' &&
    value.startsWith(RUNTIME_ICON_DATA_URL_PREFIX) &&
    value.length <= MAX_RUNTIME_ICON_DATA_URL_LENGTH
}

function createRuntimeIconImageFromDataUrl(dataUrl: string): Electron.NativeImage | null {
  const image = nativeImage.createFromDataURL(dataUrl)
  if (image.isEmpty()) return null

  return image
}

function normalizeRuntimeIconImageSetPayload(payload: unknown): RuntimeIconImageSetEntry[] | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null

  const images = (payload as Record<string, unknown>).images
  if (!Array.isArray(images) || images.length === 0 || images.length > MAX_RUNTIME_ICON_IMAGE_SET_IMAGES) {
    return null
  }

  const entries: RuntimeIconImageSetEntry[] = []
  const seenSizes = new Set<number>()
  let totalDataUrlLength = 0

  for (const image of images) {
    if (!image || typeof image !== 'object' || Array.isArray(image)) return null

    const record = image as Record<string, unknown>
    const size = record.size
    const dataUrl = record.dataUrl
    if (
      !Number.isInteger(size) ||
      typeof size !== 'number' ||
      size < MIN_RUNTIME_ICON_IMAGE_SIZE ||
      size > MAX_RUNTIME_ICON_IMAGE_SIZE ||
      seenSizes.has(size) ||
      !isRuntimeIconDataUrl(dataUrl)
    ) {
      return null
    }

    totalDataUrlLength += dataUrl.length
    if (totalDataUrlLength > MAX_RUNTIME_ICON_IMAGE_SET_DATA_URL_LENGTH) return null

    seenSizes.add(size)
    entries.push({ size, dataUrl })
  }

  return entries.sort((left, right) => left.size - right.size)
}

function createRuntimeIconImageFromImageSet(entries: RuntimeIconImageSetEntry[]): Electron.NativeImage | null {
  if (entries.length === 0) return null

  const sortedEntries = [...entries].sort((left, right) => right.size - left.size)
  const [baseEntry, ...alternateEntries] = sortedEntries
  if (!baseEntry) return null

  const image = nativeImage.createFromDataURL(baseEntry.dataUrl)
  if (image.isEmpty()) return null

  const baseSize = image.getSize()
  if (baseSize.width !== baseEntry.size || baseSize.height !== baseEntry.size) return null

  for (const entry of alternateEntries) {
    const representation = nativeImage.createFromDataURL(entry.dataUrl)
    if (representation.isEmpty()) return null

    const size = representation.getSize()
    if (size.width !== entry.size || size.height !== entry.size) return null

    image.addRepresentation({ dataURL: entry.dataUrl })
  }

  return image.isEmpty() ? null : image
}

function applyRuntimeIconPayload(payload: unknown): boolean {
  const image = typeof payload === 'string'
    ? (isRuntimeIconDataUrl(payload) ? createRuntimeIconImageFromDataUrl(payload) : null)
    : createRuntimeIconImageFromImageSet(normalizeRuntimeIconImageSetPayload(payload) ?? [])

  if (!image) return false

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

function broadcastLyricsPopoutWindowState(): void {
  const payload = getLyricsPopoutWindowState()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('lyrics-popout:windowState', payload)
  }
  if (lyricsPopoutWindow && !lyricsPopoutWindow.isDestroyed()) {
    lyricsPopoutWindow.webContents.send('lyrics-popout:windowState', payload)
  }
}

function broadcastLocalApiStatus(): void {
  if (isAppQuitting) return
  const payload = localApiService.getStatus()
  sendToWindow(mainWindow, 'local-api:status', payload)
}

function broadcastPhoneRemoteStatus(): void {
  if (isAppQuitting) return
  const payload = phoneRemoteService.getStatus()
  sendToWindow(mainWindow, 'phone-remote:status', payload)
}

function broadcastLastFmStatus(): void {
  const payload = lastFmService.getStatus()
  sendToWindow(mainWindow, 'lastfm:status', payload)
}

function broadcastLyricsStatus(): void {
  const payload = lyricsService.getStatus()
  sendToWindow(mainWindow, 'lyrics:status', payload)
}

function broadcastSubsonicStatus(snapshot?: SubsonicStatusSnapshot): void {
  const payload = snapshot ?? subsonicStatusCache
  sendToWindow(mainWindow, 'subsonic:status', payload)
}

function setSubsonicSyncProgress(
  sourceId: number,
  progress: {
    phase: SubsonicSyncPhase
    activity: string
    current?: number | null
    total?: number | null
    detail?: string | null
  }
): void {
  subsonicSyncProgressBySourceId.set(sourceId, {
    phase: progress.phase,
    activity: progress.activity,
    current: progress.current ?? null,
    total: progress.total ?? null,
    detail: progress.detail ?? null,
    updatedAt: Date.now()
  })
  broadcastSubsonicStatus(refreshSubsonicStatusCache(subsonicSyncInFlight))
}

function clearSubsonicSyncProgress(sourceId: number): void {
  if (!subsonicSyncProgressBySourceId.has(sourceId)) return
  subsonicSyncProgressBySourceId.delete(sourceId)
  broadcastSubsonicStatus(refreshSubsonicStatusCache(subsonicSyncInFlight))
}

function computeSubsonicStatusSnapshot(isSyncing: boolean): SubsonicStatusSnapshot {
  const sources = library.listSubsonicSources().map((source) => ({
    sourceId: source.id,
    enabled: source.enabled === 1,
    status: source.last_status,
    error: source.last_error,
    lastSyncAt: source.last_sync_at,
    lastCheckedAt: source.last_checked_at,
    progress: subsonicSyncProgressBySourceId.get(source.id) ?? null
  }))

  return {
    isSyncing,
    updatedAt: Date.now(),
    sources
  }
}

function refreshSubsonicStatusCache(isSyncing: boolean = subsonicSyncInFlight): SubsonicStatusSnapshot {
  subsonicStatusCache = computeSubsonicStatusSnapshot(isSyncing)
  return subsonicStatusCache
}

function broadcastJellyfinStatus(snapshot?: JellyfinStatusSnapshot): void {
  const payload = snapshot ?? jellyfinStatusCache
  sendToWindow(mainWindow, 'jellyfin:status', payload)
}

function setJellyfinSyncProgress(
  sourceId: number,
  progress: {
    phase: JellyfinSyncPhase
    activity: string
    current?: number | null
    total?: number | null
    detail?: string | null
  }
): void {
  jellyfinSyncProgressBySourceId.set(sourceId, {
    phase: progress.phase,
    activity: progress.activity,
    current: progress.current ?? null,
    total: progress.total ?? null,
    detail: progress.detail ?? null,
    updatedAt: Date.now()
  })
  broadcastJellyfinStatus(refreshJellyfinStatusCache(jellyfinSyncInFlight))
}

function clearJellyfinSyncProgress(sourceId: number): void {
  if (!jellyfinSyncProgressBySourceId.has(sourceId)) return
  jellyfinSyncProgressBySourceId.delete(sourceId)
  broadcastJellyfinStatus(refreshJellyfinStatusCache(jellyfinSyncInFlight))
}

function computeJellyfinStatusSnapshot(isSyncing: boolean): JellyfinStatusSnapshot {
  const sources = library.listJellyfinSources().map((source) => ({
    sourceId: source.id,
    enabled: source.enabled === 1,
    status: source.last_status,
    error: source.last_error,
    lastSyncAt: source.last_sync_at,
    lastCheckedAt: source.last_checked_at,
    progress: jellyfinSyncProgressBySourceId.get(source.id) ?? null
  }))

  return {
    isSyncing,
    updatedAt: Date.now(),
    sources
  }
}

function refreshJellyfinStatusCache(isSyncing: boolean = jellyfinSyncInFlight): JellyfinStatusSnapshot {
  jellyfinStatusCache = computeJellyfinStatusSnapshot(isSyncing)
  return jellyfinStatusCache
}

function ensureSafeStorageAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Secure credential storage is unavailable. Unlock your OS keychain and restart Astra, then retry.'
    )
  }
}

function encryptSubsonicSecret(secret: string): string {
  ensureSafeStorageAvailable()
  const encrypted = safeStorage.encryptString(secret)
  return encrypted.toString('base64')
}

function decryptSubsonicSecret(secretEncrypted: string): string {
  ensureSafeStorageAvailable()
  if (!secretEncrypted) {
    throw new Error('Stored Subsonic credential is missing.')
  }
  const encryptedBuffer = Buffer.from(secretEncrypted, 'base64')
  return safeStorage.decryptString(encryptedBuffer)
}

function requireSubsonicSourceCredentials(sourceId: number): {
  source: library.SubsonicSourceRow
  connection: { baseUrl: string; username: string; password: string }
} {
  const source = library.getSubsonicSourceById(sourceId)
  if (!source) {
    throw new Error('Subsonic source not found.')
  }

  const password = decryptSubsonicSecret(source.secret_encrypted)
  return {
    source,
    connection: {
      baseUrl: source.base_url,
      username: source.username,
      password
    }
  }
}

function toSubsonicSourcePayload(source: library.SubsonicSourcePublic): SubsonicSource {
  return {
    id: source.id,
    name: source.name,
    base_url: source.base_url,
    username: source.username,
    enabled: source.enabled,
    last_status: source.last_status,
    last_error: source.last_error,
    last_sync_at: source.last_sync_at,
    last_checked_at: source.last_checked_at,
    created_at: source.created_at,
    updated_at: source.updated_at,
    has_stored_secret: source.has_stored_secret
  }
}

function normalizeSubsonicSourceCreateInput(raw: SubsonicSourceCreateInput): {
  name: string
  baseUrl: string
  username: string
  password: string
  enabled: boolean
} {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid Subsonic source payload.')
  }

  const name = String(raw.name ?? '').trim()
  const baseUrl = normalizeSubsonicBaseUrl(String(raw.baseUrl ?? ''))
  const username = String(raw.username ?? '').trim()
  const password = String(raw.password ?? '')
  const enabled = Boolean(raw.enabled)

  if (!name) throw new Error('Source name is required.')
  if (!username) throw new Error('Username is required.')
  if (!password) throw new Error('Password is required.')

  return { name, baseUrl, username, password, enabled }
}

function normalizeSubsonicSourceUpdateInput(raw: SubsonicSourceUpdateInput): {
  name?: string
  baseUrl?: string
  username?: string
  password?: string
  enabled?: boolean
} {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid Subsonic source update payload.')
  }

  const next: {
    name?: string
    baseUrl?: string
    username?: string
    password?: string
    enabled?: boolean
  } = {}

  if (raw.name !== undefined) {
    const value = String(raw.name).trim()
    if (!value) throw new Error('Source name cannot be empty.')
    next.name = value
  }
  if (raw.baseUrl !== undefined) {
    next.baseUrl = normalizeSubsonicBaseUrl(String(raw.baseUrl))
  }
  if (raw.username !== undefined) {
    const value = String(raw.username).trim()
    if (!value) throw new Error('Username cannot be empty.')
    next.username = value
  }
  if (raw.password !== undefined) {
    const value = String(raw.password)
    if (!value) throw new Error('Password cannot be empty.')
    next.password = value
  }
  if (raw.enabled !== undefined) {
    next.enabled = Boolean(raw.enabled)
  }

  return next
}

function resolveSubsonicTestConnectionInput(input: SubsonicSourceTestInput): {
  baseUrl: string
  username: string
  password: string
} {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid Subsonic test payload.')
  }

  if (typeof input.sourceId === 'number' && Number.isInteger(input.sourceId) && input.sourceId > 0) {
    const credentials = requireSubsonicSourceCredentials(input.sourceId)
    return credentials.connection
  }

  const baseUrl = normalizeSubsonicBaseUrl(String(input.baseUrl ?? ''))
  const username = String(input.username ?? '').trim()
  const password = String(input.password ?? '')

  if (!username) throw new Error('Username is required.')
  if (!password) throw new Error('Password is required.')

  return { baseUrl, username, password }
}

function encryptJellyfinSecret(secret: string): string {
  return encryptSubsonicSecret(secret)
}

function decryptJellyfinSecret(secretEncrypted: string): string {
  ensureSafeStorageAvailable()
  if (!secretEncrypted) {
    throw new Error('Stored Jellyfin credential is missing.')
  }
  const encryptedBuffer = Buffer.from(secretEncrypted, 'base64')
  return safeStorage.decryptString(encryptedBuffer)
}

function requireJellyfinSourceCredentials(sourceId: number): {
  source: library.JellyfinSourceRow
  connection: { baseUrl: string; username: string; password: string }
} {
  const source = library.getJellyfinSourceById(sourceId)
  if (!source) {
    throw new Error('Jellyfin source not found.')
  }

  const password = decryptJellyfinSecret(source.secret_encrypted)
  return {
    source,
    connection: {
      baseUrl: source.base_url,
      username: source.username,
      password
    }
  }
}

function clearJellyfinAuthContext(sourceId: number): void {
  jellyfinAuthCacheBySourceId.delete(sourceId)
}

function isJellyfinUnauthorizedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return message.includes('(401)') || message.includes(' 401') || message.endsWith('401')
}

async function getJellyfinAuthContext(
  sourceId: number,
  connection: { baseUrl: string; username: string; password: string },
  options: { forceRefresh?: boolean } = {}
): Promise<{ accessToken: string; userId: string }> {
  const now = Date.now()
  if (!options.forceRefresh) {
    const cached = jellyfinAuthCacheBySourceId.get(sourceId)
    if (cached && cached.expiresAt > now) {
      return cached.authContext
    }
  }

  const authContext = await authenticateJellyfin(connection, {
    timeoutMs: 12_000,
    retries: 1
  })
  jellyfinAuthCacheBySourceId.set(sourceId, {
    authContext,
    expiresAt: now + JELLYFIN_AUTH_CACHE_TTL_MS
  })
  return authContext
}

function toJellyfinSourcePayload(source: library.JellyfinSourcePublic): JellyfinSource {
  return {
    id: source.id,
    name: source.name,
    base_url: source.base_url,
    username: source.username,
    enabled: source.enabled,
    last_status: source.last_status,
    last_error: source.last_error,
    last_sync_at: source.last_sync_at,
    last_checked_at: source.last_checked_at,
    created_at: source.created_at,
    updated_at: source.updated_at,
    has_stored_secret: source.has_stored_secret
  }
}

function normalizeJellyfinSourceCreateInput(raw: JellyfinSourceCreateInput): {
  name: string
  baseUrl: string
  username: string
  password: string
  enabled: boolean
} {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid Jellyfin source payload.')
  }

  const name = String(raw.name ?? '').trim()
  const baseUrl = normalizeJellyfinBaseUrl(String(raw.baseUrl ?? ''))
  const username = String(raw.username ?? '').trim()
  const password = String(raw.password ?? '')
  const enabled = Boolean(raw.enabled)

  if (!name) throw new Error('Source name is required.')
  if (!username) throw new Error('Username is required.')
  if (!password) throw new Error('Password is required.')

  return { name, baseUrl, username, password, enabled }
}

function normalizeJellyfinSourceUpdateInput(raw: JellyfinSourceUpdateInput): {
  name?: string
  baseUrl?: string
  username?: string
  password?: string
  enabled?: boolean
} {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid Jellyfin source update payload.')
  }

  const next: {
    name?: string
    baseUrl?: string
    username?: string
    password?: string
    enabled?: boolean
  } = {}

  if (raw.name !== undefined) {
    const value = String(raw.name).trim()
    if (!value) throw new Error('Source name cannot be empty.')
    next.name = value
  }
  if (raw.baseUrl !== undefined) {
    next.baseUrl = normalizeJellyfinBaseUrl(String(raw.baseUrl))
  }
  if (raw.username !== undefined) {
    const value = String(raw.username).trim()
    if (!value) throw new Error('Username cannot be empty.')
    next.username = value
  }
  if (raw.password !== undefined) {
    const value = String(raw.password)
    if (!value) throw new Error('Password cannot be empty.')
    next.password = value
  }
  if (raw.enabled !== undefined) {
    next.enabled = Boolean(raw.enabled)
  }

  return next
}

function resolveJellyfinTestConnectionInput(input: JellyfinSourceTestInput): {
  baseUrl: string
  username: string
  password: string
} {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid Jellyfin test payload.')
  }

  if (typeof input.sourceId === 'number' && Number.isInteger(input.sourceId) && input.sourceId > 0) {
    const credentials = requireJellyfinSourceCredentials(input.sourceId)
    return credentials.connection
  }

  const baseUrl = normalizeJellyfinBaseUrl(String(input.baseUrl ?? ''))
  const username = String(input.username ?? '').trim()
  const password = String(input.password ?? '')

  if (!username) throw new Error('Username is required.')
  if (!password) throw new Error('Password is required.')

  return { baseUrl, username, password }
}

async function setSubsonicSourceDisabledState(sourceId: number): Promise<void> {
  clearSubsonicSyncProgress(sourceId)
  await library.updateSubsonicSourceStatus(
    sourceId,
    {
      status: 'disabled',
      error: null,
      checkedAt: Date.now()
    },
    { persist: false }
  )
  await library.markSubsonicTracksAvailability(sourceId, false, 'source_disabled', { persist: false })
}

async function syncOneSubsonicSource(sourceId: number, syncSessionKey: string): Promise<boolean> {
  const source = library.getSubsonicSourceById(sourceId)
  if (!source) return false

  if (source.enabled !== 1) {
    clearSubsonicSyncProgress(sourceId)
    await setSubsonicSourceDisabledState(sourceId)
    await library.persistLibraryDatabase()
    return false
  }

  await library.updateSubsonicSourceStatus(
    sourceId,
    {
      status: 'syncing',
      error: null,
      checkedAt: Date.now()
    },
    { persist: false }
  )
  setSubsonicSyncProgress(sourceId, {
    phase: 'connecting',
    activity: 'Connecting to server...'
  })
  broadcastSubsonicStatus(refreshSubsonicStatusCache(true))

  let credentials: ReturnType<typeof requireSubsonicSourceCredentials> | null = null
  try {
    credentials = requireSubsonicSourceCredentials(sourceId)
    await testSubsonicConnection(credentials.connection, {
      timeoutMs: 12_000,
      retries: 1
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to reach Subsonic source.'
    await library.markSubsonicTracksAvailability(sourceId, false, 'source_unavailable', { persist: false })
    await library.updateSubsonicSourceStatus(
      sourceId,
      {
        status: 'error',
        error: message,
        checkedAt: Date.now()
      },
      { persist: false }
    )
    await library.persistLibraryDatabase()
    clearSubsonicSyncProgress(sourceId)
    throw error
  }

  await library.restoreSubsonicTracksFromSourceUnavailable(sourceId, { persist: false })

  try {
    const result = await syncSubsonicCatalog(sourceId, credentials.connection, {
      timeoutMs: 12_000,
      retries: 1,
      onProgress: (progress) => {
        const label = progress.phase === 'artists'
          ? 'Loading artists...'
          : progress.phase === 'albums'
            ? 'Loading albums...'
            : 'Loading tracks...'
        setSubsonicSyncProgress(sourceId, {
          phase: progress.phase,
          activity: label,
          current: progress.current,
          total: progress.total,
          detail: progress.detail
        })
      }
    })

    setSubsonicSyncProgress(sourceId, {
      phase: 'finalizing',
      activity: 'Applying track metadata...'
    })
    await library.upsertSubsonicTracks(sourceId, result.tracks, {
      persist: false,
      syncSessionKey,
      preserveExistingArtwork: true
    })
    await library.markMissingSubsonicTracksUnavailable(
      sourceId,
      new Set(result.tracks.map((track) => track.source_track_id)),
      { persist: false }
    )
    await library.persistLibraryDatabase()

    setSubsonicSyncProgress(sourceId, {
      phase: 'playlists',
      activity: 'Loading favorites and playlists...'
    })
    const [starredResult, playlistsResult] = await Promise.allSettled([
      fetchSubsonicStarredTrackIds(credentials.connection, {
        timeoutMs: 12_000,
        retries: 1
      }),
      syncSubsonicPlaylists(sourceId, credentials.connection, {
        timeoutMs: 12_000,
        retries: 1,
        onProgress: (progress) => {
          setSubsonicSyncProgress(sourceId, {
            phase: progress.phase,
            activity: 'Loading favorites and playlists...',
            current: progress.current,
            total: progress.total,
            detail: progress.detail
          })
        }
      })
    ])

    setSubsonicSyncProgress(sourceId, {
      phase: 'finalizing',
      activity: 'Applying favorites and playlists...'
    })
    if (starredResult.status === 'fulfilled') {
      await library.syncSubsonicFavoriteTrackIds(sourceId, starredResult.value, { persist: false })
    } else {
      console.warn(`Failed to sync Subsonic starred tracks for source ${sourceId}:`, starredResult.reason)
    }
    if (playlistsResult.status === 'fulfilled') {
      await library.syncSubsonicRemotePlaylists(sourceId, playlistsResult.value, { persist: false })
    } else {
      console.warn(`Failed to sync Subsonic playlists for source ${sourceId}:`, playlistsResult.reason)
    }
    await library.updateSubsonicSourceStatus(
      sourceId,
      {
        status: 'ok',
        error: null,
        syncedAt: Date.now(),
        checkedAt: Date.now()
      },
      { persist: false }
    )
    await library.persistLibraryDatabase()
    clearSubsonicSyncProgress(sourceId)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Subsonic sync failure.'
    await library.updateSubsonicSourceStatus(
      sourceId,
      {
        status: 'error',
        error: message,
        checkedAt: Date.now()
      },
      { persist: false }
    )
    await library.persistLibraryDatabase()
    clearSubsonicSyncProgress(sourceId)
    throw error
  }
}

async function runSubsonicSync(sourceId?: number, requestedSyncSessionKey?: string | null): Promise<void> {
  if (subsonicSyncInFlight) {
    throw new Error('A Subsonic sync is already in progress.')
  }

  const sources = sourceId
    ? library.listSubsonicSources().filter((source) => source.id === sourceId)
    : library.listSubsonicSources()
  if (sources.length === 0) {
    return
  }

  const syncSessionKey = latestLibrarySyncCoordinator.beginOperation(requestedSyncSessionKey)

  subsonicSyncInFlight = true
  broadcastSubsonicStatus(refreshSubsonicStatusCache(true))
  logMemoryDiagnosticsMainEvent('subsonic_sync_started', {
    requestedSourceId: sourceId ?? null,
    sourceCount: sources.length
  })

  let failedSourceCount = 0
  let successfulSourceCount = 0
  try {
    for (const source of sources) {
      try {
        const didSync = await syncOneSubsonicSource(source.id, syncSessionKey)
        if (didSync) {
          successfulSourceCount += 1
        }
      } catch (error) {
        failedSourceCount += 1
        logMemoryDiagnosticsMainEvent('subsonic_sync_failed', {
          sourceId: source.id,
          message: error instanceof Error ? error.message : 'Unknown Subsonic sync failure.'
        })
        console.warn(`Subsonic sync failed for source ${source.id}:`, error)
      }
    }
  } finally {
    subsonicSyncInFlight = false
    broadcastSubsonicStatus(refreshSubsonicStatusCache(false))
    await finalizeLatestLibrarySyncSession(syncSessionKey, successfulSourceCount > 0, 'Subsonic sync')
    logMemoryDiagnosticsMainEvent('subsonic_sync_finished', {
      requestedSourceId: sourceId ?? null,
      sourceCount: sources.length,
      failedSourceCount,
      successfulSourceCount
    })
  }
}

function startSubsonicSyncScheduler(): void {
  if (subsonicSyncTimer !== null) {
    clearInterval(subsonicSyncTimer)
  }
  subsonicSyncTimer = setInterval(() => {
    void runSubsonicSync().catch((error) => {
      if (error instanceof Error && error.message.includes('already in progress')) {
        return
      }
      console.warn('Periodic Subsonic sync failed:', error)
    })
  }, SUBSONIC_SYNC_INTERVAL_MS)
}

async function setJellyfinSourceDisabledState(sourceId: number): Promise<void> {
  clearJellyfinAuthContext(sourceId)
  clearJellyfinSyncProgress(sourceId)
  await library.updateJellyfinSourceStatus(
    sourceId,
    {
      status: 'disabled',
      error: null,
      checkedAt: Date.now()
    },
    { persist: false }
  )
  await library.markJellyfinTracksAvailability(sourceId, false, 'source_disabled', { persist: false })
}

async function hydrateJellyfinTrackArtworkHashes(
  connection: { baseUrl: string; username: string; password: string },
  authContext: { accessToken: string; userId: string },
  tracks: Array<{ artwork_source_id: string | null }>,
  onProgress?: (current: number, total: number, artworkId: string | null) => void
): Promise<Map<string, string>> {
  const artworkIds = Array.from(new Set(
    tracks
      .map((track) => track.artwork_source_id)
      .filter((artworkId): artworkId is string => typeof artworkId === 'string' && artworkId.trim().length > 0)
  ))

  const hashesByArtworkId = new Map<string, string>()
  onProgress?.(0, artworkIds.length, null)
  let processed = 0
  for (const artworkId of artworkIds) {
    try {
      const artworkPayload = await fetchJellyfinCoverArt(connection, artworkId, authContext, {
        timeoutMs: 12_000,
        retries: 1
      })
      const hash = await library.cacheArtworkBuffer(artworkPayload.data, artworkPayload.contentType)
      if (hash) {
        hashesByArtworkId.set(artworkId, hash)
      }
    } catch (error) {
      console.warn(`Failed to sync Jellyfin cover art ${artworkId}:`, error)
    } finally {
      processed += 1
      onProgress?.(processed, artworkIds.length, artworkId)
    }
  }

  return hashesByArtworkId
}

async function syncOneJellyfinSource(sourceId: number, syncSessionKey: string): Promise<boolean> {
  const source = library.getJellyfinSourceById(sourceId)
  if (!source) return false

  if (source.enabled !== 1) {
    clearJellyfinSyncProgress(sourceId)
    await setJellyfinSourceDisabledState(sourceId)
    await library.persistLibraryDatabase()
    return false
  }

  await library.updateJellyfinSourceStatus(
    sourceId,
    {
      status: 'syncing',
      error: null,
      checkedAt: Date.now()
    },
    { persist: false }
  )
  setJellyfinSyncProgress(sourceId, {
    phase: 'connecting',
    activity: 'Connecting to server...'
  })
  broadcastJellyfinStatus(refreshJellyfinStatusCache(true))

  let credentials: ReturnType<typeof requireJellyfinSourceCredentials> | null = null
  try {
    credentials = requireJellyfinSourceCredentials(sourceId)
    clearJellyfinAuthContext(sourceId)
    await testJellyfinConnection(credentials.connection, {
      timeoutMs: 12_000,
      retries: 1
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to reach Jellyfin source.'
    await library.markJellyfinTracksAvailability(sourceId, false, 'source_unavailable', { persist: false })
    await library.updateJellyfinSourceStatus(
      sourceId,
      {
        status: 'error',
        error: message,
        checkedAt: Date.now()
      },
      { persist: false }
    )
    await library.persistLibraryDatabase()
    clearJellyfinSyncProgress(sourceId)
    throw error
  }

  await library.restoreJellyfinTracksFromSourceUnavailable(sourceId, { persist: false })

  try {
    const authContext = await authenticateJellyfin(credentials.connection, {
      timeoutMs: 12_000,
      retries: 1
    })
    const result = await syncJellyfinCatalog(sourceId, credentials.connection, {
      authContext,
      timeoutMs: 12_000,
      retries: 1,
      onProgress: (progress) => {
        setJellyfinSyncProgress(sourceId, {
          phase: progress.phase,
          activity: 'Loading library items...',
          current: progress.current,
          total: progress.total,
          detail: progress.detail
        })
      }
    })

    setJellyfinSyncProgress(sourceId, {
      phase: 'artwork',
      activity: 'Syncing artwork...'
    })
    const artworkHashesBySourceId = await hydrateJellyfinTrackArtworkHashes(
      credentials.connection,
      authContext,
      result.tracks,
      (current, total, artworkId) => {
        setJellyfinSyncProgress(sourceId, {
          phase: 'artwork',
          activity: 'Syncing artwork...',
          current,
          total,
          detail: artworkId
        })
      }
    )
    const tracksForUpsert = result.tracks.map((track) => ({
      ...track,
      artwork_hash: track.artwork_source_id
        ? (artworkHashesBySourceId.get(track.artwork_source_id) ?? track.artwork_hash)
        : track.artwork_hash
    }))

    setJellyfinSyncProgress(sourceId, {
      phase: 'finalizing',
      activity: 'Applying library updates...'
    })
    await library.upsertJellyfinTracks(sourceId, tracksForUpsert, {
      persist: false,
      syncSessionKey
    })
    await library.markMissingJellyfinTracksUnavailable(
      sourceId,
      new Set(result.tracks.map((track) => track.source_track_id)),
      { persist: false }
    )
    await library.updateJellyfinSourceStatus(
      sourceId,
      {
        status: 'ok',
        error: null,
        syncedAt: Date.now(),
        checkedAt: Date.now()
      },
      { persist: false }
    )
    await library.persistLibraryDatabase()
    clearJellyfinSyncProgress(sourceId)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Jellyfin sync failure.'
    await library.updateJellyfinSourceStatus(
      sourceId,
      {
        status: 'error',
        error: message,
        checkedAt: Date.now()
      },
      { persist: false }
    )
    await library.persistLibraryDatabase()
    clearJellyfinSyncProgress(sourceId)
    throw error
  }
}

async function runJellyfinSync(sourceId?: number, requestedSyncSessionKey?: string | null): Promise<void> {
  if (jellyfinSyncInFlight) {
    throw new Error('A Jellyfin sync is already in progress.')
  }

  const sources = sourceId
    ? library.listJellyfinSources().filter((source) => source.id === sourceId)
    : library.listJellyfinSources()
  if (sources.length === 0) {
    return
  }

  const syncSessionKey = latestLibrarySyncCoordinator.beginOperation(requestedSyncSessionKey)

  jellyfinSyncInFlight = true
  broadcastJellyfinStatus(refreshJellyfinStatusCache(true))
  logMemoryDiagnosticsMainEvent('jellyfin_sync_started', {
    requestedSourceId: sourceId ?? null,
    sourceCount: sources.length
  })

  let failedSourceCount = 0
  let successfulSourceCount = 0
  try {
    for (const source of sources) {
      try {
        const didSync = await syncOneJellyfinSource(source.id, syncSessionKey)
        if (didSync) {
          successfulSourceCount += 1
        }
      } catch (error) {
        failedSourceCount += 1
        logMemoryDiagnosticsMainEvent('jellyfin_sync_failed', {
          sourceId: source.id,
          message: error instanceof Error ? error.message : 'Unknown Jellyfin sync failure.'
        })
        console.warn(`Jellyfin sync failed for source ${source.id}:`, error)
      }
    }
  } finally {
    jellyfinSyncInFlight = false
    broadcastJellyfinStatus(refreshJellyfinStatusCache(false))
    await finalizeLatestLibrarySyncSession(syncSessionKey, successfulSourceCount > 0, 'Jellyfin sync')
    logMemoryDiagnosticsMainEvent('jellyfin_sync_finished', {
      requestedSourceId: sourceId ?? null,
      sourceCount: sources.length,
      failedSourceCount,
      successfulSourceCount
    })
  }
}

function startJellyfinSyncScheduler(): void {
  if (jellyfinSyncTimer !== null) {
    clearInterval(jellyfinSyncTimer)
  }
  jellyfinSyncTimer = setInterval(() => {
    void runJellyfinSync().catch((error) => {
      if (error instanceof Error && error.message.includes('already in progress')) {
        return
      }
      console.warn('Periodic Jellyfin sync failed:', error)
    })
  }, SUBSONIC_SYNC_INTERVAL_MS)
}

function captureMainWindowPrefs(): MainWindowPrefs | null {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const bounds = mainWindow.getNormalBounds()
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: mainWindow.isMaximized()
  }
}

async function persistMainWindowPrefs(): Promise<void> {
  const captured = captureMainWindowPrefs()
  if (!captured) return

  mainWindowPrefs = captured
  try {
    await saveMainWindowPrefs(captured)
  } catch (error) {
    console.warn('Failed to persist main window prefs:', error)
  }
}

function schedulePersistMainWindowPrefs(): void {
  if (mainWindowPersistTimer !== null) {
    clearTimeout(mainWindowPersistTimer)
  }
  mainWindowPersistTimer = setTimeout(() => {
    mainWindowPersistTimer = null
    void persistMainWindowPrefs()
  }, MAIN_WINDOW_PERSIST_DEBOUNCE_MS)
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

function captureLyricsPopoutWindowPrefs(): LyricsPopoutWindowPrefs | null {
  if (!lyricsPopoutWindow || lyricsPopoutWindow.isDestroyed()) return null
  const bounds = lyricsPopoutWindow.getBounds()
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  }
}

async function persistLyricsPopoutWindowPrefs(): Promise<void> {
  const captured = captureLyricsPopoutWindowPrefs()
  if (!captured) return

  lyricsPopoutWindowPrefs = captured
  try {
    await saveLyricsPopoutWindowPrefs(captured)
  } catch (error) {
    console.warn('Failed to persist lyrics popout window prefs:', error)
  }
}

function schedulePersistLyricsPopoutWindowPrefs(): void {
  if (lyricsPopoutWindowPersistTimer !== null) {
    clearTimeout(lyricsPopoutWindowPersistTimer)
  }
  lyricsPopoutWindowPersistTimer = setTimeout(() => {
    lyricsPopoutWindowPersistTimer = null
    void persistLyricsPopoutWindowPrefs()
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
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
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
  logMemoryDiagnosticsMainEvent('window_opened', {
    windowType: 'mini_player'
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
    logMemoryDiagnosticsMainEvent('window_closed', {
      windowType: 'mini_player'
    })
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

async function createLyricsPopoutWindow(): Promise<void> {
  if (lyricsPopoutWindow && !lyricsPopoutWindow.isDestroyed()) {
    if (lyricsPopoutWindow.isMinimized()) {
      lyricsPopoutWindow.restore()
    }
    lyricsPopoutWindow.focus()
    broadcastLyricsPopoutWindowState()
    return
  }

  const prefs = lyricsPopoutWindowPrefs ?? await loadLyricsPopoutWindowPrefs()
  lyricsPopoutWindowPrefs = prefs

  lyricsPopoutWindow = new BrowserWindow({
    width: prefs.width,
    height: prefs.height,
    x: prefs.x,
    y: prefs.y,
    minWidth: LYRICS_POPOUT_WINDOW_MIN_WIDTH,
    minHeight: LYRICS_POPOUT_WINDOW_MIN_HEIGHT,
    frame: false,
    transparent: false,
    backgroundColor: '#06060b',
    autoHideMenuBar: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    title: 'Astra Lyrics',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  logMemoryDiagnosticsMainEvent('window_opened', {
    windowType: 'lyrics_popout'
  })

  lyricsPopoutWindow.on('ready-to-show', () => {
    lyricsPopoutWindow?.show()
  })

  lyricsPopoutWindow.on('move', schedulePersistLyricsPopoutWindowPrefs)
  lyricsPopoutWindow.on('resize', schedulePersistLyricsPopoutWindowPrefs)
  lyricsPopoutWindow.on('close', () => {
    if (lyricsPopoutWindowPersistTimer !== null) {
      clearTimeout(lyricsPopoutWindowPersistTimer)
      lyricsPopoutWindowPersistTimer = null
    }
    void persistLyricsPopoutWindowPrefs()
  })
  lyricsPopoutWindow.on('closed', () => {
    lyricsPopoutWindow = null
    broadcastLyricsPopoutWindowState()
    logMemoryDiagnosticsMainEvent('window_closed', {
      windowType: 'lyrics_popout'
    })
  })

  lyricsPopoutWindow.webContents.on('did-finish-load', () => {
    if (latestLyricsPopoutSnapshot) {
      lyricsPopoutWindow?.webContents.send('lyrics-popout:snapshot', latestLyricsPopoutSnapshot)
    }
    broadcastLyricsPopoutWindowState()
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    await lyricsPopoutWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=lyrics-popout`)
  } else {
    await lyricsPopoutWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'lyrics-popout' }
    })
  }

  broadcastLyricsPopoutWindowState()
}

function createWindow(): void {
  associatedOpenRendererReady = false

  const prefs = mainWindowPrefs ?? {
    width: MAIN_WINDOW_DEFAULT_WIDTH,
    height: MAIN_WINDOW_DEFAULT_HEIGHT,
    maximized: false
  }
  mainWindowPrefs = prefs

  mainWindow = new BrowserWindow({
    width: prefs.width,
    height: prefs.height,
    x: prefs.x,
    y: prefs.y,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
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
  logMemoryDiagnosticsMainEvent('window_opened', {
    windowType: 'main'
  })

  if (prefs.maximized) {
    mainWindow.maximize()
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('move', schedulePersistMainWindowPrefs)
  mainWindow.on('resize', schedulePersistMainWindowPrefs)
  mainWindow.on('maximize', schedulePersistMainWindowPrefs)
  mainWindow.on('unmaximize', schedulePersistMainWindowPrefs)
  mainWindow.on('close', () => {
    if (mainWindowPersistTimer !== null) {
      clearTimeout(mainWindowPersistTimer)
      mainWindowPersistTimer = null
    }
    void persistMainWindowPrefs()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    associatedOpenRendererReady = false
    if (miniWindow && !miniWindow.isDestroyed()) {
      miniWindow.close()
    }
    if (lyricsPopoutWindow && !lyricsPopoutWindow.isDestroyed()) {
      lyricsPopoutWindow.close()
    }
    closeAllScopePopoutWindows()
    logMemoryDiagnosticsMainEvent('window_closed', {
      windowType: 'main'
    }, { captureSample: false })
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const action: UIScaleShortcutAction | null = resolveUIScaleShortcutAction(input, process.platform)
    if (!action) return

    event.preventDefault()
    mainWindow?.webContents.setZoomLevel(0)
    mainWindow?.webContents.send('ui-scale:shortcut', action)
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  flushAssociatedOpenFiles()
  broadcastMiniWindowState()
  broadcastLyricsPopoutWindowState()
  broadcastScopePopoutState()
  broadcastLocalApiStatus()
  broadcastLyricsStatus()
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

async function maybeRunFileCreatedAtBackfillOnce(): Promise<void> {
  if (library.getAppMeta(FILE_CREATED_AT_BACKFILL_MIGRATION_KEY) === '1') {
    return
  }

  try {
    const { scanned, updated, errors } = await library.backfillMissingFileCreatedAt()
    if (scanned > 0) {
      console.log(`File creation time backfill (one-time): scanned=${scanned}, updated=${updated}, errors=${errors}`)
    }
    if (updated > 0) {
      mainWindow?.webContents.send('library:fileCreatedAtBackfillComplete', { scanned, updated, errors })
    }
  } catch (err) {
    console.warn('File creation time backfill failed:', err)
  } finally {
    try {
      await library.setAppMeta(FILE_CREATED_AT_BACKFILL_MIGRATION_KEY, '1')
    } catch (err) {
      console.warn('Failed to persist file creation time backfill migration flag:', err)
    }
  }
}

function scheduleFileCreatedAtBackfillMigration(): void {
  if (library.getAppMeta(FILE_CREATED_AT_BACKFILL_MIGRATION_KEY) === '1') {
    return
  }

  if (fileCreatedAtBackfillTimer !== null) {
    clearTimeout(fileCreatedAtBackfillTimer)
  }

  fileCreatedAtBackfillTimer = setTimeout(() => {
    fileCreatedAtBackfillTimer = null
    void maybeRunFileCreatedAtBackfillOnce()
  }, FILE_CREATED_AT_BACKFILL_STARTUP_DELAY_MS)
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

async function maybeRunArtistCreditsBackfillOnce(): Promise<void> {
  if (library.getAppMeta(ARTIST_CREDITS_BACKFILL_MIGRATION_KEY) === '1') {
    return
  }

  let completed = false
  try {
    const { scanned, updated, errors } = await library.backfillMissingArtistCreditMetadata()
    if (scanned > 0) {
      console.log(`Artist credit metadata backfill (one-time): scanned=${scanned}, updated=${updated}, errors=${errors}`)
    }
    if (updated > 0) {
      mainWindow?.webContents.send('library:audioMetadataBackfillComplete', { scanned, updated, errors })
    }
    completed = true
  } catch (err) {
    console.warn('Artist credit metadata backfill failed:', err)
  } finally {
    if (completed) {
      try {
        await library.setAppMeta(ARTIST_CREDITS_BACKFILL_MIGRATION_KEY, '1')
      } catch (err) {
        console.warn('Failed to persist artist credit metadata backfill migration flag:', err)
      }
    }
  }
}

function scheduleArtistCreditsBackfillMigration(): void {
  if (library.getAppMeta(ARTIST_CREDITS_BACKFILL_MIGRATION_KEY) === '1') {
    return
  }

  if (artistCreditsBackfillTimer !== null) {
    clearTimeout(artistCreditsBackfillTimer)
  }

  artistCreditsBackfillTimer = setTimeout(() => {
    artistCreditsBackfillTimer = null
    void maybeRunArtistCreditsBackfillOnce()
  }, ARTIST_CREDITS_BACKFILL_STARTUP_DELAY_MS)
}

async function maybeRunReplayGainBackfillOnce(): Promise<void> {
  if (!replayGainScanEnabled) {
    return
  }

  if (library.getAppMeta(REPLAYGAIN_BACKFILL_MIGRATION_KEY) === '1') {
    return
  }

  let completed = false
  try {
    const { scanned, updated, errors } = await runLibraryScanOperation(async (signal) => {
      return library.backfillMissingReplayGainMetadata(undefined, { signal, persist: false })
    })
    if (scanned > 0) {
      console.log(`ReplayGain metadata backfill (one-time): scanned=${scanned}, updated=${updated}, errors=${errors}`)
    }
    if (updated > 0) {
      mainWindow?.webContents.send('library:audioMetadataBackfillComplete', { scanned, updated, errors })
    }
    completed = true
  } catch (err) {
    console.warn('ReplayGain metadata backfill failed:', err)
  } finally {
    if (completed) {
      try {
        await library.setAppMeta(REPLAYGAIN_BACKFILL_MIGRATION_KEY, '1')
      } catch (err) {
        console.warn('Failed to persist ReplayGain metadata backfill migration flag:', err)
      }
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

function getArtworkThumbnailCacheKey(hash: string, maxEdgePx: number): string {
  return createHash('md5')
    .update(`${ARTWORK_THUMB_CACHE_VERSION}:${hash}:${maxEdgePx}`)
    .digest('hex')
}

async function resolveSubsonicArtworkHash(hash: string): Promise<string | null> {
  const parsed = parseSubsonicArtworkHash(hash)
  if (!parsed) return hash

  if (subsonicArtworkResolveRequestCache.has(hash)) {
    return subsonicArtworkResolveRequestCache.get(hash)!
  }

  const request = (async () => {
    try {
      const credentials = requireSubsonicSourceCredentials(parsed.sourceId)
      const artworkPayload = await fetchSubsonicCoverArt(credentials.connection, parsed.artworkId, {
        timeoutMs: 12_000,
        retries: 1
      })
      const cachedHash = await library.cacheArtworkBuffer(artworkPayload.data, artworkPayload.contentType)
      if (!cachedHash) return null
      await library.replaceSubsonicArtworkHash(parsed.sourceId, hash, cachedHash)
      return cachedHash
    } catch (error) {
      console.warn(`Failed to resolve Subsonic artwork ${parsed.artworkId}:`, error)
      return null
    }
  })()
    .finally(() => {
      subsonicArtworkResolveRequestCache.delete(hash)
    })

  subsonicArtworkResolveRequestCache.set(hash, request)
  return request
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

function resizeArtworkForMaxEdge(sourceImage: Electron.NativeImage, maxEdgePx: number): Electron.NativeImage {
  const { width, height } = sourceImage.getSize()
  if (width <= 0 || height <= 0) return sourceImage

  const longestEdge = Math.max(width, height)
  if (longestEdge <= maxEdgePx) {
    return sourceImage
  }

  const scale = maxEdgePx / longestEdge
  return sourceImage.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'good'
  })
}

async function getArtworkDataUrlByHash(hash: string): Promise<string | null> {
  if (!hash) return null
  const resolvedHash = await resolveSubsonicArtworkHash(hash)
  if (!resolvedHash) return null
  try {
    const artworkPath = library.getArtworkPath(resolvedHash)
    const data = await readFile(artworkPath)
    return toDataUrl(detectArtworkMimeType(resolvedHash, data), data)
  } catch {
    return null
  }
}

async function getArtworkThumbnailDataUrlByHash(
  hash: string,
  options?: {
    maxEdgePx?: number
    jpegQuality?: number
  }
): Promise<string | null> {
  if (!hash) return null
  const resolvedHash = await resolveSubsonicArtworkHash(hash)
  if (!resolvedHash) return null

  try {
    await ensureArtworkThumbnailCacheDirectory()
    const maxEdgePx = options?.maxEdgePx ?? TRACKLIST_THUMB_MAX_EDGE_PX
    const jpegQuality = options?.jpegQuality ?? TRACKLIST_THUMB_JPEG_QUALITY
    const thumbnailPath = join(artworkThumbnailCacheDir, `${getArtworkThumbnailCacheKey(resolvedHash, maxEdgePx)}.jpg`)

    try {
      const cached = await readFile(thumbnailPath)
      if (cached.length > 0) {
        return toDataUrl('image/jpeg', cached)
      }
    } catch {
      // Cache miss: generate and persist below.
    }

    const artworkPath = library.getArtworkPath(resolvedHash)
    const sourceBuffer = await readFile(artworkPath)
    const sourceImage = nativeImage.createFromBuffer(sourceBuffer)
    if (sourceImage.isEmpty()) {
      return getArtworkDataUrlByHash(resolvedHash)
    }

    const resized = resizeArtworkForMaxEdge(sourceImage, maxEdgePx)
    const thumbnailBuffer = resized.toJPEG(jpegQuality)
    if (!thumbnailBuffer || thumbnailBuffer.length === 0) {
      return getArtworkDataUrlByHash(resolvedHash)
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
    console.warn('Failed to resolve artwork thumbnail data URL:', resolvedHash, error)
    return getArtworkDataUrlByHash(resolvedHash)
  }
}

app.on('second-instance', (_event, commandLine) => {
  queueAssociatedOpenFiles(parseAssociatedOpenPathsFromArgv(commandLine))
  if (app.isReady()) {
    focusOrCreateMainWindow()
  }
})

app.on('open-file', (event, filePath) => {
  event.preventDefault()

  const normalizedPath = normalizeAssociatedOpenPath(filePath)
  if (normalizedPath) {
    queueAssociatedOpenFiles([normalizedPath])
  }

  if (app.isReady()) {
    focusOrCreateMainWindow()
  }
})

queueAssociatedOpenFiles(parseAssociatedOpenPathsFromArgv(process.argv))

app.whenReady().then(async () => {
  // Initialize library database
  await library.initDatabase()
  try {
    const orphanedRemoteDeleted = await library.cleanupOrphanedRemoteTracks()
    if (orphanedRemoteDeleted > 0) {
      console.log(`Removed ${orphanedRemoteDeleted} orphaned remote tracks from library`)
    }
  } catch (error) {
    console.warn('Failed to cleanup orphaned remote tracks on startup:', error)
  }
  replayGainScanEnabled = await loadReplayGainScanEnabledFromMeta()
  try {
    await ensureArtworkThumbnailCacheDirectory()
  } catch (error) {
    console.warn('Failed to initialize artwork thumbnail cache directory:', error)
  }
  const memoryDiagnosticsEnabled = await loadMemoryDiagnosticsEnabledFromMeta()
  memoryDiagnosticsService = new MemoryDiagnosticsService({
    userDataPath: app.getPath('userData'),
    platform: process.platform,
    appVersion: app.getVersion(),
    sampleIntervalMs: MEMORY_DIAGNOSTICS_SAMPLE_INTERVAL_MS,
    getMainProcessMemoryUsage: () => process.memoryUsage(),
    getAppMetrics: () => app.getAppMetrics(),
    takeRendererHeapSnapshot: async (filePath: string) => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        throw new Error('Main window is unavailable for heap snapshot capture.')
      }
      await mainWindow.webContents.takeHeapSnapshot(filePath)
    },
    sendRendererSnapshotRequest,
    getProcessLabels: getMemoryDiagnosticsProcessLabels,
    getWindowRoleSummary: getMemoryDiagnosticsWindowRoleSummary,
    onStatusChange: () => {
      broadcastMemoryDiagnosticsStatus()
    }
  })
  await memoryDiagnosticsService.initialize(memoryDiagnosticsEnabled)
  mainWindowPrefs = await loadMainWindowPrefs()
  miniWindowPrefs = await loadMiniWindowPrefs()
  lyricsPopoutWindowPrefs = await loadLyricsPopoutWindowPrefs()
  localApiConfig = await loadLocalApiConfigFromMeta()
  phoneRemoteConfig = await loadPhoneRemoteConfigFromMeta(localApiConfig.controlsEnabled)
  phoneRemotePairedDevices = await loadPhoneRemotePairedDevicesFromMeta()
  phoneRemoteService.replacePairedDevices(phoneRemotePairedDevices)
  await localApiService.applyConfig(localApiConfig)
  await phoneRemoteService.applyConfig(phoneRemoteConfig)
  lastFmConfig = await loadLastFmConfigFromMeta()
  await lastFmService.applyConfig(lastFmConfig)
  lyricsOnlineEnabled = await loadLyricsConfigFromMeta()
  lyricsService.applyConfig(lyricsOnlineEnabled)
  localApiService.publishSnapshot(latestMiniPlayerSnapshot)
  phoneRemoteService.publishSnapshot(latestMiniPlayerSnapshot)
  refreshSubsonicStatusCache(false)
  refreshJellyfinStatusCache(false)

  createWindow()
  broadcastSubsonicStatus()
  broadcastJellyfinStatus()
  startSubsonicSyncScheduler()
  startJellyfinSyncScheduler()
  void runSubsonicSync().catch((error) => {
    if (error instanceof Error && error.message.includes('already in progress')) {
      return
    }
    console.warn('Startup Subsonic sync failed:', error)
  })
  void runJellyfinSync().catch((error) => {
    if (error instanceof Error && error.message.includes('already in progress')) {
      return
    }
    console.warn('Startup Jellyfin sync failed:', error)
  })
  void (async () => {
    try {
      const removedCount = await library.cleanupMissingTracks()
      if (removedCount > 0) {
        console.log(`Removed ${removedCount} missing tracks from library`)
      }
    } catch (error) {
      console.warn('Library cleanup on startup failed:', error)
    }
  })()
  scheduleFileCreatedAtBackfillMigration()
  scheduleAudioMetadataBackfillMigration()
  scheduleArtistCreditsBackfillMigration()
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
  isAppQuitting = true
  if (mainWindowPersistTimer !== null) {
    clearTimeout(mainWindowPersistTimer)
    mainWindowPersistTimer = null
  }
  if (miniWindowPersistTimer !== null) {
    clearTimeout(miniWindowPersistTimer)
    miniWindowPersistTimer = null
  }
  if (lyricsPopoutWindowPersistTimer !== null) {
    clearTimeout(lyricsPopoutWindowPersistTimer)
    lyricsPopoutWindowPersistTimer = null
  }
  if (audioMetadataBackfillTimer !== null) {
    clearTimeout(audioMetadataBackfillTimer)
    audioMetadataBackfillTimer = null
  }
  if (artistCreditsBackfillTimer !== null) {
    clearTimeout(artistCreditsBackfillTimer)
    artistCreditsBackfillTimer = null
  }
  if (replayGainBackfillTimer !== null) {
    clearTimeout(replayGainBackfillTimer)
    replayGainBackfillTimer = null
  }
  if (subsonicSyncTimer !== null) {
    clearInterval(subsonicSyncTimer)
    subsonicSyncTimer = null
  }
  if (jellyfinSyncTimer !== null) {
    clearInterval(jellyfinSyncTimer)
    jellyfinSyncTimer = null
  }
  void persistMainWindowPrefs()
  void persistMiniWindowPrefs()
  void persistLyricsPopoutWindowPrefs()
  closeAllScopePopoutWindows()
  void memoryDiagnosticsService?.shutdown()
  void localApiService.stop()
  void phoneRemoteService.stop()
  lastFmService.stop()
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

ipcMain.on('associated-open-files:rendererReady', () => {
  associatedOpenRendererReady = true
  flushAssociatedOpenFiles()
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
  const mergedSnapshot = mergeMiniPlayerSnapshots(latestMiniPlayerSnapshot, snapshot)
  latestMiniPlayerSnapshot = mergedSnapshot
  localApiService.publishSnapshot(mergedSnapshot)
  phoneRemoteService.publishSnapshot(mergedSnapshot)
  lastFmService.publishSnapshot(mergedSnapshot)
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.webContents.send('mini-player:snapshot', mergedSnapshot)
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

// Lyrics popout window controls/state
ipcMain.handle('lyrics-popout:open', async () => {
  await createLyricsPopoutWindow()
})

ipcMain.handle('lyrics-popout:close', async () => {
  if (lyricsPopoutWindow && !lyricsPopoutWindow.isDestroyed()) {
    lyricsPopoutWindow.close()
  }
})

ipcMain.handle('lyrics-popout:getWindowState', () => {
  return getLyricsPopoutWindowState()
})

ipcMain.handle('lyrics-popout:getSnapshot', () => {
  return latestLyricsPopoutSnapshot
})

ipcMain.on('lyrics-popout:publishSnapshot', (_event, snapshot: LyricsPopoutSnapshot) => {
  if (!lyricsPopoutWindow || lyricsPopoutWindow.isDestroyed()) {
    return
  }

  latestLyricsPopoutSnapshot = snapshot
  lyricsPopoutWindow.webContents.send('lyrics-popout:snapshot', snapshot)
})

ipcMain.on('lyrics-popout:sendCommand', (_event, command: LyricsPopoutCommand) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send('lyrics-popout:command', command)
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

ipcMain.handle('app:getBuildInfo', () => {
  return getAppBuildInfo()
})

ipcMain.handle('app:getPerformanceStats', () => {
  const metrics = app.getAppMetrics()
  const totalCpuPercent = metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0)
  const totalWorkingSetKb = metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0)

  return {
    cpuPercent: totalCpuPercent,
    workingSetMb: totalWorkingSetKb / 1024,
  }
})

ipcMain.handle('app:getMainProcessMemoryStats', () => {
  const memoryUsage = process.memoryUsage()
  return {
    rssBytes: memoryUsage.rss,
    heapUsedBytes: memoryUsage.heapUsed,
    heapTotalBytes: memoryUsage.heapTotal,
    externalBytes: memoryUsage.external,
    arrayBuffersBytes: memoryUsage.arrayBuffers,
  }
})

ipcMain.handle('diagnostics:getStatus', () => {
  return getMemoryDiagnosticsStatusSnapshot()
})

ipcMain.handle('diagnostics:setEnabled', async (_event, enabledValue: unknown) => {
  const enabled = Boolean(enabledValue)
  await library.setAppMeta(MEMORY_DIAGNOSTICS_ENABLED_META_KEY, enabled ? '1' : '0')
  if (!memoryDiagnosticsService) {
    return getMemoryDiagnosticsStatusSnapshot()
  }
  return memoryDiagnosticsService.setEnabled(enabled)
})

ipcMain.handle('diagnostics:revealCurrentLog', async () => {
  return memoryDiagnosticsService?.revealCurrentLog() ?? false
})

ipcMain.handle('diagnostics:revealPreviousLog', async () => {
  return memoryDiagnosticsService?.revealPreviousLog() ?? false
})

ipcMain.handle('diagnostics:captureMemoryBundle', async (_event, rawTag: unknown) => {
  if (!memoryDiagnosticsService) {
    throw new Error('Memory diagnostics service is unavailable.')
  }
  const tag = typeof rawTag === 'string' ? rawTag : undefined
  return memoryDiagnosticsService.captureMemoryBundle(tag)
})

ipcMain.handle('diagnostics:logEvent', async (_event, rawPayload: unknown) => {
  const payload = normalizeMemoryDiagnosticsEventPayload(rawPayload)
  if (!payload || !memoryDiagnosticsService) {
    return false
  }
  await memoryDiagnosticsService.logEvent(payload)
  return true
})

ipcMain.on('diagnostics:publishRendererSnapshot', (_event, requestId: unknown, rawSnapshot: unknown) => {
  if (typeof requestId !== 'string' || !rawSnapshot || typeof rawSnapshot !== 'object') {
    return
  }
  memoryDiagnosticsService?.publishRendererSnapshot(requestId, rawSnapshot as MemoryDiagnosticsRendererSnapshot)
})

ipcMain.handle('updates:check', async () => {
  return checkForUpdates(app.getVersion())
})

ipcMain.handle('updates:openReleasesPage', async (_event, releaseUrl: unknown) => {
  const targetUrl = resolveSafeReleaseUrl(releaseUrl)
  await shell.openExternal(targetUrl)
  return true
})

ipcMain.on('theme:setRuntimeIconDataUrl', (_event, payload: unknown) => {
  try {
    if (!applyRuntimeIconPayload(payload)) {
      console.warn('Ignored runtime icon update: invalid icon payload')
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

// Last.fm scrobbling
ipcMain.handle('lastfm:getStatus', () => {
  return lastFmService.getStatus()
})

ipcMain.handle('lastfm:setEnabled', async (_event, enabled: unknown) => {
  const nextConfig: LastFmServiceConfig = {
    ...lastFmConfig,
    enabled: Boolean(enabled)
  }
  return applyLastFmConfig(nextConfig)
})

function normalizeLastFmCustomProfileInput(input: unknown): LastFmCustomProfileInput {
  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
  return {
    protocol: normalizeLastFmScrobbleProtocol(record.protocol),
    name: typeof record.name === 'string' ? record.name : '',
    apiBaseUrl: typeof record.apiBaseUrl === 'string' ? record.apiBaseUrl : '',
    username: typeof record.username === 'string' ? record.username : null,
    sessionKey: typeof record.sessionKey === 'string' ? record.sessionKey : null
  }
}

ipcMain.handle('lastfm:createCustomProfile', async (_event, input: unknown) => {
  return lastFmService.createCustomProfile(normalizeLastFmCustomProfileInput(input))
})

ipcMain.handle('lastfm:updateCustomProfile', async (_event, profileId: unknown, input: unknown) => {
  return lastFmService.updateCustomProfile(
    typeof profileId === 'string' ? profileId : '',
    normalizeLastFmCustomProfileInput(input)
  )
})

ipcMain.handle('lastfm:deleteCustomProfile', async (_event, profileId: unknown) => {
  return lastFmService.deleteCustomProfile(typeof profileId === 'string' ? profileId : '')
})

ipcMain.handle('lastfm:setActiveProfile', async (_event, profileId: unknown) => {
  return lastFmService.setActiveProfile(typeof profileId === 'string' ? profileId : '')
})

ipcMain.handle('lastfm:setProfileEnabled', async (_event, profileId: unknown, enabled: unknown) => {
  return lastFmService.setProfileEnabled(typeof profileId === 'string' ? profileId : '', Boolean(enabled))
})

ipcMain.handle('lastfm:beginAuth', async (_event, profileId: unknown) => {
  return lastFmService.beginAuth(typeof profileId === 'string' ? profileId : undefined)
})

ipcMain.handle('lastfm:finishAuth', async () => {
  return lastFmService.finishAuth()
})

ipcMain.handle('lastfm:disconnect', async () => {
  return lastFmService.disconnect()
})

ipcMain.handle('lastfm:disconnectProfile', async (_event, profileId: unknown) => {
  return lastFmService.disconnectProfile(typeof profileId === 'string' ? profileId : '')
})

ipcMain.handle('lastfm:resetToDefaults', async () => {
  return lastFmService.resetToDefaults()
})

// Lyrics
ipcMain.handle('lyrics:getStatus', () => {
  return lyricsService.getStatus()
})

ipcMain.handle('lyrics:setEnabled', async (_event, enabled: unknown) => {
  return applyLyricsConfig(Boolean(enabled))
})

ipcMain.handle('lyrics:getForTrack', async (_event, rawQuery: unknown) => {
  const query = normalizeLyricsTrackQuery(rawQuery)
  if (!query) {
    return {
      status: 'not_found' as const,
      reason: 'embedded-missing' as const
    }
  }
  return lyricsService.getForTrack(query)
})

ipcMain.handle('lyrics:refreshForTrack', async (_event, rawQuery: unknown) => {
  const query = normalizeLyricsTrackQuery(rawQuery)
  if (!query) {
    return {
      status: 'not_found' as const,
      reason: 'embedded-missing' as const
    }
  }
  return lyricsService.getForTrack(query, { forceRefresh: true })
})

ipcMain.handle('lyrics:getTrackOverride', (_event, rawTrackPath: unknown) => {
  const trackPath = typeof rawTrackPath === 'string' ? rawTrackPath.trim() : ''
  return lyricsService.getTrackOverride(trackPath)
})

ipcMain.handle('lyrics:importManualLyrics', async (
  _event,
  rawTrackPaths: unknown,
  rawLyricsText: unknown,
  rawFormat: unknown
) => {
  const trackPaths = normalizeLyricsTrackPaths(rawTrackPaths)
  const lyricsText = typeof rawLyricsText === 'string' ? rawLyricsText : ''
  return lyricsService.importManualLyrics(trackPaths, lyricsText, normalizeLyricsImportFormat(rawFormat))
})

ipcMain.handle('lyrics:clearManualLyrics', async (_event, rawTrackPaths: unknown) => {
  const trackPaths = normalizeLyricsTrackPaths(rawTrackPaths)
  return lyricsService.clearManualLyrics(trackPaths)
})

ipcMain.handle('lyrics:setTrackOffset', async (_event, rawTrackPaths: unknown, rawOffsetMs: unknown) => {
  const trackPaths = normalizeLyricsTrackPaths(rawTrackPaths)
  const offsetMs = normalizeLyricsOffsetMs(rawOffsetMs)
  if (offsetMs === null) {
    throw new Error('Invalid sync offset.')
  }
  return lyricsService.setTrackOffset(trackPaths, offsetMs)
})

ipcMain.handle('lyrics:resetToDefaults', async () => {
  await library.clearLyricsCache()
  return applyLyricsConfig(false)
})

ipcMain.handle('subsonic:listSources', () => {
  return library.listSubsonicSources().map(toSubsonicSourcePayload)
})

ipcMain.handle('subsonic:createSource', async (_event, rawInput: SubsonicSourceCreateInput) => {
  const input = normalizeSubsonicSourceCreateInput(rawInput)
  const encryptedSecret = encryptSubsonicSecret(input.password)

  const created = await library.createSubsonicSource({
    name: input.name,
    base_url: input.baseUrl,
    username: input.username,
    secret_encrypted: encryptedSecret,
    enabled: input.enabled ? 1 : 0,
    last_status: input.enabled ? 'unknown' : 'disabled'
  })

  if (!input.enabled) {
    await setSubsonicSourceDisabledState(created.id)
    await library.persistLibraryDatabase()
  }

  broadcastSubsonicStatus(refreshSubsonicStatusCache(false))
  return toSubsonicSourcePayload(created)
})

ipcMain.handle('subsonic:updateSource', async (_event, sourceIdValue: unknown, rawInput: SubsonicSourceUpdateInput) => {
  const sourceId = Number(sourceIdValue)
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    throw new Error('Invalid Subsonic source id.')
  }

  const input = normalizeSubsonicSourceUpdateInput(rawInput)
  const updatePayload: {
    name?: string
    base_url?: string
    username?: string
    secret_encrypted?: string
    enabled?: number
    last_status?: SubsonicSourceLastStatus
    last_error?: string | null
  } = {}

  if (input.name !== undefined) updatePayload.name = input.name
  if (input.baseUrl !== undefined) updatePayload.base_url = input.baseUrl
  if (input.username !== undefined) updatePayload.username = input.username
  if (input.password !== undefined) {
    updatePayload.secret_encrypted = encryptSubsonicSecret(input.password)
  }
  if (input.enabled !== undefined) {
    updatePayload.enabled = input.enabled ? 1 : 0
    updatePayload.last_status = input.enabled ? 'unknown' : 'disabled'
    if (!input.enabled) {
      updatePayload.last_error = null
    }
  }

  const updated = await library.updateSubsonicSource(sourceId, updatePayload)
  if (input.enabled === false) {
    await setSubsonicSourceDisabledState(sourceId)
    await library.persistLibraryDatabase()
  }

  broadcastSubsonicStatus(refreshSubsonicStatusCache(false))
  return toSubsonicSourcePayload(updated)
})

ipcMain.handle('subsonic:deleteSource', async (_event, sourceIdValue: unknown, purgeTracksValue: unknown) => {
  const sourceId = Number(sourceIdValue)
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    throw new Error('Invalid Subsonic source id.')
  }
  const purgeTracks = Boolean(purgeTracksValue)
  await library.deleteSubsonicSource(sourceId, purgeTracks)
  clearSubsonicSyncProgress(sourceId)
  broadcastSubsonicStatus(refreshSubsonicStatusCache(false))
})

ipcMain.handle('subsonic:testSource', async (_event, rawInput: SubsonicSourceTestInput): Promise<SubsonicSourceTestResult> => {
  const sourceId = typeof rawInput?.sourceId === 'number' && Number.isInteger(rawInput.sourceId) && rawInput.sourceId > 0
    ? rawInput.sourceId
    : null
  try {
    const resolved = resolveSubsonicTestConnectionInput(rawInput)
    await testSubsonicConnection(resolved, { timeoutMs: 12_000, retries: 1 })
    if (sourceId !== null) {
      clearSubsonicSyncProgress(sourceId)
      await library.updateSubsonicSourceStatus(sourceId, {
        status: 'ok',
        error: null,
        checkedAt: Date.now()
      })
      broadcastSubsonicStatus(refreshSubsonicStatusCache(subsonicSyncInFlight))
    }
    return {
      ok: true,
      message: 'Connection successful.'
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Connection test failed.'
    if (sourceId !== null) {
      clearSubsonicSyncProgress(sourceId)
      await library.updateSubsonicSourceStatus(sourceId, {
        status: 'error',
        error: message,
        checkedAt: Date.now()
      })
      broadcastSubsonicStatus(refreshSubsonicStatusCache(subsonicSyncInFlight))
    }
    return {
      ok: false,
      message: 'Connection failed.',
      error: message
    }
  }
})

ipcMain.handle('subsonic:syncSource', async (_event, sourceIdValue: unknown, syncSessionKeyValue?: unknown) => {
  const sourceId = Number(sourceIdValue)
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    throw new Error('Invalid Subsonic source id.')
  }
  await runSubsonicSync(sourceId, normalizeLatestSyncSessionKey(syncSessionKeyValue))
})

ipcMain.handle('subsonic:syncAll', async (_event, syncSessionKeyValue?: unknown) => {
  await runSubsonicSync(undefined, normalizeLatestSyncSessionKey(syncSessionKeyValue))
})

ipcMain.handle('subsonic:getStatus', () => {
  return refreshSubsonicStatusCache(subsonicSyncInFlight)
})

ipcMain.handle('jellyfin:listSources', () => {
  return library.listJellyfinSources().map(toJellyfinSourcePayload)
})

ipcMain.handle('jellyfin:createSource', async (_event, rawInput: JellyfinSourceCreateInput) => {
  const input = normalizeJellyfinSourceCreateInput(rawInput)
  const encryptedSecret = encryptJellyfinSecret(input.password)

  const created = await library.createJellyfinSource({
    name: input.name,
    base_url: input.baseUrl,
    username: input.username,
    secret_encrypted: encryptedSecret,
    enabled: input.enabled ? 1 : 0,
    last_status: input.enabled ? 'unknown' : 'disabled'
  })

  if (!input.enabled) {
    await setJellyfinSourceDisabledState(created.id)
    await library.persistLibraryDatabase()
  }
  clearJellyfinAuthContext(created.id)

  broadcastJellyfinStatus(refreshJellyfinStatusCache(false))
  return toJellyfinSourcePayload(created)
})

ipcMain.handle('jellyfin:updateSource', async (_event, sourceIdValue: unknown, rawInput: JellyfinSourceUpdateInput) => {
  const sourceId = Number(sourceIdValue)
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    throw new Error('Invalid Jellyfin source id.')
  }

  const input = normalizeJellyfinSourceUpdateInput(rawInput)
  const updatePayload: {
    name?: string
    base_url?: string
    username?: string
    secret_encrypted?: string
    enabled?: number
    last_status?: JellyfinSourceLastStatus
    last_error?: string | null
  } = {}

  if (input.name !== undefined) updatePayload.name = input.name
  if (input.baseUrl !== undefined) updatePayload.base_url = input.baseUrl
  if (input.username !== undefined) updatePayload.username = input.username
  if (input.password !== undefined) {
    updatePayload.secret_encrypted = encryptJellyfinSecret(input.password)
  }
  if (input.enabled !== undefined) {
    updatePayload.enabled = input.enabled ? 1 : 0
    updatePayload.last_status = input.enabled ? 'unknown' : 'disabled'
    if (!input.enabled) {
      updatePayload.last_error = null
    }
  }

  const updated = await library.updateJellyfinSource(sourceId, updatePayload)
  clearJellyfinAuthContext(sourceId)
  if (input.enabled === false) {
    await setJellyfinSourceDisabledState(sourceId)
    await library.persistLibraryDatabase()
  }

  broadcastJellyfinStatus(refreshJellyfinStatusCache(false))
  return toJellyfinSourcePayload(updated)
})

ipcMain.handle('jellyfin:deleteSource', async (_event, sourceIdValue: unknown, purgeTracksValue: unknown) => {
  const sourceId = Number(sourceIdValue)
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    throw new Error('Invalid Jellyfin source id.')
  }
  const purgeTracks = Boolean(purgeTracksValue)
  await library.deleteJellyfinSource(sourceId, purgeTracks)
  clearJellyfinAuthContext(sourceId)
  clearJellyfinSyncProgress(sourceId)
  broadcastJellyfinStatus(refreshJellyfinStatusCache(false))
})

ipcMain.handle('jellyfin:testSource', async (_event, rawInput: JellyfinSourceTestInput): Promise<JellyfinSourceTestResult> => {
  const sourceId = typeof rawInput?.sourceId === 'number' && Number.isInteger(rawInput.sourceId) && rawInput.sourceId > 0
    ? rawInput.sourceId
    : null
  try {
    const resolved = resolveJellyfinTestConnectionInput(rawInput)
    await testJellyfinConnection(resolved, { timeoutMs: 12_000, retries: 1 })
    if (sourceId !== null) {
      clearJellyfinSyncProgress(sourceId)
      await library.updateJellyfinSourceStatus(sourceId, {
        status: 'ok',
        error: null,
        checkedAt: Date.now()
      })
      broadcastJellyfinStatus(refreshJellyfinStatusCache(jellyfinSyncInFlight))
    }
    return {
      ok: true,
      message: 'Connection successful.'
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Connection test failed.'
    if (sourceId !== null) {
      clearJellyfinSyncProgress(sourceId)
      await library.updateJellyfinSourceStatus(sourceId, {
        status: 'error',
        error: message,
        checkedAt: Date.now()
      })
      broadcastJellyfinStatus(refreshJellyfinStatusCache(jellyfinSyncInFlight))
    }
    return {
      ok: false,
      message: 'Connection failed.',
      error: message
    }
  }
})

ipcMain.handle('jellyfin:syncSource', async (_event, sourceIdValue: unknown, syncSessionKeyValue?: unknown) => {
  const sourceId = Number(sourceIdValue)
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    throw new Error('Invalid Jellyfin source id.')
  }
  await runJellyfinSync(sourceId, normalizeLatestSyncSessionKey(syncSessionKeyValue))
})

ipcMain.handle('jellyfin:syncAll', async (_event, syncSessionKeyValue?: unknown) => {
  await runJellyfinSync(undefined, normalizeLatestSyncSessionKey(syncSessionKeyValue))
})

ipcMain.handle('jellyfin:getStatus', () => {
  return refreshJellyfinStatusCache(jellyfinSyncInFlight)
})

// Local integration API
ipcMain.handle('local-api:getStatus', () => {
  return localApiService.getStatus()
})

ipcMain.handle('local-api:setEnabled', async (_event, enabled: unknown) => {
  const nextEnabled = Boolean(enabled)
  const nextConfig: LocalApiServiceConfig = {
    ...localApiConfig,
    enabled: nextEnabled
  }
  return applyLocalApiConfig(nextConfig)
})

ipcMain.handle('local-api:setControlsEnabled', async (_event, controlsEnabled: unknown) => {
  const nextControlsEnabled = Boolean(controlsEnabled)
  const nextLocalConfig: LocalApiServiceConfig = {
    ...localApiConfig,
    controlsEnabled: nextControlsEnabled
  }
  const nextPhoneRemoteConfig: PhoneRemoteServiceConfig = {
    ...phoneRemoteConfig,
    controlsEnabled: nextControlsEnabled
  }
  await applyPhoneRemoteConfig(nextPhoneRemoteConfig)
  return applyLocalApiConfig(nextLocalConfig)
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
  const nextPhoneRemoteConfig: PhoneRemoteServiceConfig = {
    enabled: false,
    controlsEnabled: false,
    port: PHONE_REMOTE_DEFAULT_PORT
  }
  phoneRemoteService.replacePairedDevices([])
  await persistPhoneRemotePairedDevices([])
  await applyPhoneRemoteConfig(nextPhoneRemoteConfig)
  return applyLocalApiConfig(nextConfig)
})

// Phone remote
ipcMain.handle('phone-remote:getStatus', () => {
  return phoneRemoteService.getStatus()
})

ipcMain.handle('phone-remote:createPairingTicket', (_event, baseUrl?: unknown) => {
  return phoneRemoteService.createPairingTicket(typeof baseUrl === 'string' ? baseUrl : undefined)
})

ipcMain.handle('phone-remote:listPairedDevices', () => {
  return phoneRemoteService.listPairedDevices()
})

ipcMain.handle('phone-remote:listPendingPairingRequests', () => {
  return phoneRemoteService.listPendingPairingRequests()
})

ipcMain.handle('phone-remote:approvePairingRequest', (_event, id: unknown) => {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('Invalid pairing request id.')
  }
  return phoneRemoteService.approvePairingRequest(id.trim())
})

ipcMain.handle('phone-remote:rejectPairingRequest', (_event, id: unknown) => {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('Invalid pairing request id.')
  }
  return phoneRemoteService.rejectPairingRequest(id.trim())
})

ipcMain.handle('phone-remote:revokePairedDevice', (_event, id: unknown) => {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('Invalid paired device id.')
  }
  return phoneRemoteService.revokePairedDevice(id.trim())
})

ipcMain.handle('phone-remote:revokeAllPairedDevices', () => {
  return phoneRemoteService.revokeAllPairedDevices()
})

ipcMain.handle('phone-remote:setEnabled', async (_event, enabled: unknown) => {
  const nextConfig: PhoneRemoteServiceConfig = {
    ...phoneRemoteConfig,
    enabled: Boolean(enabled)
  }
  return applyPhoneRemoteConfig(nextConfig)
})

ipcMain.handle('phone-remote:setPort', async (_event, rawPort: unknown) => {
  const nextPort = normalizePhoneRemotePort(rawPort)
  const nextConfig: PhoneRemoteServiceConfig = {
    ...phoneRemoteConfig,
    port: nextPort
  }
  return applyPhoneRemoteConfig(nextConfig)
})

ipcMain.handle('phone-remote:resetToDefaults', async () => {
  const nextConfig: PhoneRemoteServiceConfig = {
    enabled: false,
    controlsEnabled: localApiConfig.controlsEnabled,
    port: PHONE_REMOTE_DEFAULT_PORT
  }
  phoneRemoteService.replacePairedDevices([])
  await persistPhoneRemotePairedDevices([])
  return applyPhoneRemoteConfig(nextConfig)
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
ipcMain.handle('audio:loadFile', async (event, filePath: string, options?: LoadAudioFileOptions) => {
  return loadAudioFile(filePath, options, {
    onRemoteLoadProgress: (progress) => {
      event.sender.send('audio:remoteLoadProgress', progress)
    }
  })
})

ipcMain.handle('audio:getMetadata', async (_event, filePath: string) => {
  return loadAudioMetadata(filePath)
})

// Decode with FFmpeg when WebAudio decodeAudioData cannot handle the codec.
ipcMain.handle('audio:decodeWithFfmpeg', async (_event, filePath: string) => {
  return decodeAudioWithFfmpeg(filePath)
})

ipcMain.handle('audio:startRemoteStream', async (event, filePath: string, outputSampleRate: number, expectedChannels?: number | null) => {
  return startRemoteStreamSession(event.sender, filePath, outputSampleRate, expectedChannels)
})

ipcMain.handle('audio:cancelRemoteStream', async (_event, sessionId: number) => {
  await cancelRemoteStreamSession(sessionId)
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

const FS_READ_TEXT_ALLOWED_EXTENSIONS = new Set([
  '.json', '.txt', '.lrc', '.xlrc', '.csv', '.m3u', '.m3u8', '.xspf', '.wpl', '.asx'
])
const FS_READ_IMAGE_ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.avif'
])
const FS_WRITE_ALLOWED_EXTENSIONS = new Set(['.json', '.txt', '.lrc', '.csv'])
const FS_WRITE_MAX_BYTES = 10 * 1024 * 1024 // 10 MB

ipcMain.handle('fs:readTextFile', async (_event, filePath: unknown) => {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('Invalid file path.')
  }
  const ext = extname(filePath).toLowerCase()
  if (!FS_READ_TEXT_ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`File type not permitted for reading: ${ext || '(none)'}`)
  }
  return readFile(filePath, 'utf-8')
})

ipcMain.handle('fs:readDataUrl', async (_event, filePath: unknown) => {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('Invalid file path.')
  }
  const ext = extname(filePath).toLowerCase()
  if (!FS_READ_IMAGE_ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`File type not permitted for reading: ${ext || '(none)'}`)
  }
  const data = await readFile(filePath)
  if (data.length === 0) return null
  return toDataUrl(detectArtworkMimeType(filePath.toLowerCase(), data), data)
})

ipcMain.handle('fs:writeTextFile', async (_event, filePath: unknown, content: unknown) => {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('Invalid file path.')
  }
  if (typeof content !== 'string') {
    throw new Error('Invalid content.')
  }
  const ext = extname(filePath).toLowerCase()
  if (!FS_WRITE_ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`File type not permitted for writing: ${ext || '(none)'}`)
  }
  if (Buffer.byteLength(content, 'utf-8') > FS_WRITE_MAX_BYTES) {
    throw new Error('Content exceeds maximum allowed size.')
  }
  await writeFile(filePath, content, 'utf-8')
  return true
})

ipcMain.handle('fs:revealFileInFolder', async (_event, filePath: unknown) => {
  if (typeof filePath !== 'string') {
    return false
  }

  const normalizedPath = filePath.trim()
  if (normalizedPath.length === 0) {
    return false
  }

  try {
    shell.showItemInFolder(normalizedPath)
    return true
  } catch (error) {
    console.warn('Failed to reveal file in folder:', error)
    return false
  }
})

// ============================================
// Library IPC handlers
// ============================================

// Get all tracks
ipcMain.handle('library:getTracks', () => {
  return library.getAllTracks()
})

ipcMain.handle('library:getTracksPage', (_event, request?: library.LibraryTrackPageRequest) => {
  return library.getTrackPage(request)
})

ipcMain.handle('library:getTracksByPaths', (_event, trackPaths: string[]) => {
  return library.getTracksByPaths(trackPaths)
})

// Get tracks by artist
ipcMain.handle('library:getTracksByArtist', (_event, artist: string, mode?: library.ArtistBrowseMode) => {
  return library.getTracksByArtist(artist, mode)
})

// Get tracks by album
ipcMain.handle('library:getTracksByAlbum', (_event, album: string, artist?: string, identityKey?: string) => {
  return library.getTracksByAlbum(album, artist, identityKey)
})

// Get all artists
ipcMain.handle('library:getArtists', (_event, mode?: library.ArtistBrowseMode) => {
  return library.getArtists(mode)
})

ipcMain.handle('library:setArtistImageFromFile', async (_event, artist: string, mode: library.ArtistBrowseMode, imagePath: string) => {
  await library.setArtistImageFromFile(artist, mode, imagePath)
})

ipcMain.handle('library:clearArtistImage', async (_event, artist: string, mode: library.ArtistBrowseMode) => {
  await library.clearArtistImage(artist, mode)
})

// Get all albums
ipcMain.handle('library:getAlbums', (_event, options?: library.AlbumListOptions) => {
  return library.getAlbums(options)
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
type LibraryScanIssueLogEntry = library.LibraryScanIssue & { folderPath?: string }

interface LibraryScanIssueLog {
  total: number
  shown: number
  truncated: boolean
  entries: LibraryScanIssueLogEntry[]
}

let activeLibraryScanAbortController: AbortController | null = null
let activeLibraryScanStage: LibraryScanStage | null = null
const LIBRARY_SCAN_ISSUE_LOG_LIMIT = 200

function sendLibraryScanStage(stage: LibraryScanStage, message: string): void {
  activeLibraryScanStage = stage
  mainWindow?.webContents.send('library:scanStage', { stage, message })
}

function getScanErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function getScanErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim().length > 0) return error
  return 'Unknown error'
}

function createLibraryScanIssueFromError(
  phase: library.LibraryScanIssuePhase,
  path: string,
  error: unknown
): library.LibraryScanIssue {
  const code = getScanErrorCode(error)
  return {
    phase,
    path,
    code,
    message: getScanErrorMessage(error),
  }
}

function createLibraryScanIssueCollector(limit = LIBRARY_SCAN_ISSUE_LOG_LIMIT): {
  record: (issue: library.LibraryScanIssue, folderPath?: string) => void
  recordError: (phase: library.LibraryScanIssuePhase, path: string, error: unknown, folderPath?: string) => void
  build: () => LibraryScanIssueLog | undefined
} {
  const entries: LibraryScanIssueLogEntry[] = []
  let total = 0

  const record = (issue: library.LibraryScanIssue, folderPath?: string): void => {
    total += 1
    if (entries.length >= limit) return
    entries.push(folderPath ? { ...issue, folderPath } : issue)
  }

  const recordError = (
    phase: library.LibraryScanIssuePhase,
    path: string,
    error: unknown,
    folderPath?: string
  ): void => {
    record(createLibraryScanIssueFromError(phase, path, error), folderPath)
  }

  const build = (): LibraryScanIssueLog | undefined => {
    if (total <= 0) return undefined
    return {
      total,
      shown: entries.length,
      truncated: total > entries.length,
      entries,
    }
  }

  return { record, recordError, build }
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
  logMemoryDiagnosticsMainEvent('library_scan_cancel_requested', {
    stage: activeLibraryScanStage ?? 'scanning'
  })
  return { canceled: true }
})

let activeIntegrityScanAbortController: AbortController | null = null

function normalizeIntegrityScanMode(value: unknown): IntegrityScanMode {
  return value === 'deep' ? 'deep' : 'quick'
}

function normalizeIntegrityTrackPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const normalized = value
    .map((trackPath) => (typeof trackPath === 'string' ? trackPath.trim() : ''))
    .filter((trackPath) => trackPath.length > 0)
  return Array.from(new Set(normalized))
}

function normalizeIntegrityScanScope(value: unknown): IntegrityScanScope {
  if (!value || typeof value !== 'object') return { type: 'all' }
  const scope = value as Partial<IntegrityScanScope> & { folderPath?: unknown; trackPath?: unknown; trackPaths?: unknown }
  if (scope.type === 'folder' && typeof scope.folderPath === 'string' && scope.folderPath.trim()) {
    return { type: 'folder', folderPath: scope.folderPath }
  }
  if (scope.type === 'track' && typeof scope.trackPath === 'string' && scope.trackPath.trim()) {
    return { type: 'track', trackPath: scope.trackPath }
  }
  if (scope.type === 'tracks' && Array.isArray(scope.trackPaths)) {
    const trackPaths = normalizeIntegrityTrackPaths(scope.trackPaths)
    if (trackPaths.length > 0) {
      return { type: 'tracks', trackPaths }
    }
  }
  return { type: 'all' }
}

function getIntegrityScopePath(scope: IntegrityScanScope): string {
  if (scope.type === 'folder') return scope.folderPath
  if (scope.type === 'track') return scope.trackPath
  if (scope.type === 'tracks') return `${scope.trackPaths.length} selected tracks`
  return ''
}

function isOnBatteryPowerMain(): boolean {
  if (!app.isReady()) return false
  try {
    return powerMonitor.isOnBatteryPower()
  } catch {
    return false
  }
}

function createIntegrityScanAbortController(): AbortController {
  if (activeIntegrityScanAbortController && !activeIntegrityScanAbortController.signal.aborted) {
    throw new Error('An integrity scan is already in progress.')
  }
  const controller = new AbortController()
  activeIntegrityScanAbortController = controller
  return controller
}

function sendIntegrityScanProgress(progress: IntegrityScanProgress): void {
  mainWindow?.webContents.send('library:integrityScanProgress', progress)
}

function sendIntegrityScanFinding(finding: IntegrityFinding): void {
  mainWindow?.webContents.send('library:integrityScanFinding', finding)
}

function sendIntegrityScanComplete(result: IntegrityScanResult): void {
  mainWindow?.webContents.send('library:integrityScanComplete', result)
}

function countIntegrityFindings(findings: readonly IntegrityFinding[]): Pick<IntegrityScanSummary, 'errors' | 'warnings' | 'info'> {
  let errors = 0
  let warnings = 0
  let info = 0
  for (const finding of findings) {
    if (finding.severity === 'error') {
      errors += 1
    } else if (finding.severity === 'warning') {
      warnings += 1
    } else {
      info += 1
    }
  }
  return { errors, warnings, info }
}

function createIntegrityFindingRecorder(runId: string, emitEvents = true): {
  findings: IntegrityFinding[]
  record: (finding: IntegrityFindingInput) => IntegrityFinding
} {
  const findings: IntegrityFinding[] = []
  let sequence = 0

  const record = (input: IntegrityFindingInput): IntegrityFinding => {
    sequence += 1
    const finding: IntegrityFinding = {
      ...input,
      id: `${runId}:${sequence}`
    }
    findings.push(finding)
    if (emitEvents) {
      sendIntegrityScanFinding(finding)
    }
    return finding
  }

  return { findings, record }
}

function buildIntegritySummary(
  mode: IntegrityScanMode,
  scope: IntegrityScanScope,
  findings: readonly IntegrityFinding[],
  scanned: number,
  skipped: number,
  canceled: boolean,
  startedAt: number
): IntegrityScanSummary {
  return {
    mode,
    scope,
    scanned,
    skipped,
    ...countIntegrityFindings(findings),
    canceled,
    startedAt,
    completedAt: Date.now()
  }
}

function buildIntegrityResult(
  mode: IntegrityScanMode,
  scope: IntegrityScanScope,
  findings: IntegrityFinding[],
  scanned: number,
  skipped: number,
  canceled: boolean,
  startedAt: number
): IntegrityScanResult {
  return {
    summary: buildIntegritySummary(mode, scope, findings, scanned, skipped, canceled, startedAt),
    findings
  }
}

async function scanIntegrityTarget(
  target: IntegrityScanTrackTarget,
  mode: IntegrityScanMode,
  ffmpegPath: string | null,
  signal?: AbortSignal
): Promise<IntegrityFindingInput[]> {
  if (mode === 'quick') {
    return quickScanIntegrityTrack(target, { signal })
  }

  if (!isFlacTarget(target)) {
    return []
  }

  if (!ffmpegPath) {
    return [{
      severity: 'error',
      code: 'ffmpeg_unavailable',
      path: target.path,
      title: target.title,
      message: 'FFmpeg is unavailable for deep integrity checks.',
      detail: 'A packaged or system FFmpeg binary could not be resolved.'
    }]
  }

  return deepScanFlacIntegrityTrack(target, ffmpegPath, { signal, onBattery: isOnBatteryPowerMain() })
}

async function runIntegrityScan(
  mode: IntegrityScanMode,
  scope: IntegrityScanScope
): Promise<IntegrityScanResult> {
  const controller = createIntegrityScanAbortController()
  const startedAt = Date.now()
  const runId = `integrity:${startedAt}`
  const recorder = createIntegrityFindingRecorder(runId)
  let scanned = 0
  let skipped = 0
  let total = 0
  let completed = 0
  let canceled = false

  try {
    sendIntegrityScanProgress({
      mode,
      scope,
      current: 0,
      total: 0,
      filePath: getIntegrityScopePath(scope),
      message: 'Preparing integrity scan...',
      phase: 'preparing'
    })

    const allTargets = library.getIntegrityScanTrackTargets(scope)
    const targets = mode === 'deep' ? allTargets.filter(isFlacTarget) : allTargets
    skipped = mode === 'deep' ? allTargets.length - targets.length : 0
    total = targets.length
    const ffmpegPath = mode === 'deep' && targets.length > 0 ? await resolveBinary('ffmpeg') : null
    const workerCount = resolveIntegrityWorkerCount(total, mode, {
      onBattery: isOnBatteryPowerMain()
    })

    sendIntegrityScanProgress({
      mode,
      scope,
      current: 0,
      total,
      filePath: getIntegrityScopePath(scope),
      message: total === 0 ? 'No matching local tracks to scan.' : `Scanning with ${workerCount} worker${workerCount === 1 ? '' : 's'}...`,
      phase: mode
    })

    await runIntegrityWithConcurrency(targets, workerCount, async (target) => {
      const phase = mode === 'deep' ? 'deep' : 'quick'
      sendIntegrityScanProgress({
        mode,
        scope,
        current: completed,
        total,
        filePath: target.path,
        message: mode === 'deep' ? 'Decoding FLAC and checking quality signals...' : 'Checking file headers and metadata...',
        phase
      })

      try {
        const findings = await scanIntegrityTarget(target, mode, ffmpegPath, controller.signal)
        for (const finding of findings) {
          recorder.record(finding)
        }
      } catch (error) {
        if (isIntegrityScanCancelledError(error)) {
          throw error
        }
        recorder.record({
          severity: 'error',
          code: 'integrity_scan_failed',
          path: target.path,
          title: target.title,
          message: 'Integrity scan failed for this file.',
          detail: error instanceof Error ? error.message : 'Unknown error'
        })
      } finally {
        scanned += 1
        completed += 1
        sendIntegrityScanProgress({
          mode,
          scope,
          current: completed,
          total,
          filePath: target.path,
          message: completed >= total ? 'Finalizing report...' : 'Continuing integrity scan...',
          phase
        })
      }
    }, { signal: controller.signal })
  } catch (error) {
    if (isIntegrityScanCancelledError(error)) {
      canceled = true
    } else {
      throw error
    }
  } finally {
    if (activeIntegrityScanAbortController === controller) {
      activeIntegrityScanAbortController = null
    }
  }

  const result = buildIntegrityResult(mode, scope, recorder.findings, scanned, skipped, canceled, startedAt)
  sendIntegrityScanProgress({
    mode,
    scope,
    current: completed,
    total,
    filePath: getIntegrityScopePath(scope),
    message: canceled ? 'Integrity scan canceled.' : 'Integrity scan complete.',
    phase: canceled ? 'canceled' : 'complete'
  })
  sendIntegrityScanComplete(result)
  return result
}

ipcMain.handle('library:startIntegrityScan', async (_event, request?: { mode?: unknown; scope?: unknown }) => {
  const mode = normalizeIntegrityScanMode(request?.mode)
  const scope = normalizeIntegrityScanScope(request?.scope)
  return runIntegrityScan(mode, scope)
})

ipcMain.handle('library:cancelIntegrityScan', () => {
  if (!activeIntegrityScanAbortController || activeIntegrityScanAbortController.signal.aborted) {
    return { canceled: false }
  }
  activeIntegrityScanAbortController.abort()
  return { canceled: true }
})

function buildTrackIntegrityScope(trackPaths: string[]): IntegrityScanScope {
  if (trackPaths.length === 1) {
    return { type: 'track', trackPath: trackPaths[0] }
  }
  return { type: 'tracks', trackPaths }
}

async function runTrackIntegrityCheck(trackPaths: string[]): Promise<IntegrityScanResult> {
  const normalizedTrackPaths = normalizeIntegrityTrackPaths(trackPaths)
  const scope = buildTrackIntegrityScope(normalizedTrackPaths)
  const startedAt = Date.now()
  const runId = `track-integrity:${startedAt}`
  const recorder = createIntegrityFindingRecorder(runId, false)
  let scanned = 0
  let skipped = 0

  if (normalizedTrackPaths.length === 0) {
    recorder.record({
      severity: 'error',
      code: 'no_tracks_selected',
      path: '',
      message: 'No tracks were selected for integrity checking.'
    })
    return buildIntegrityResult('quick', scope, recorder.findings, scanned, skipped, false, startedAt)
  }

  const targetByPath = new Map(
    library.getIntegrityScanTrackTargets(scope).map((target) => [target.path, target])
  )
  const orderedTargets: IntegrityScanTrackTarget[] = []
  for (const trackPath of normalizedTrackPaths) {
    const target = targetByPath.get(trackPath)
    if (target) {
      orderedTargets.push(target)
      continue
    }
    skipped += 1
    recorder.record({
      severity: 'error',
      code: 'track_not_found',
      path: trackPath,
      message: 'Track is not a local indexed library file.'
    })
  }

  const mode: IntegrityScanMode = orderedTargets.some(isFlacTarget) ? 'deep' : 'quick'
  const ffmpegPath = mode === 'deep' ? await resolveBinary('ffmpeg') : null

  for (const target of orderedTargets) {
    if (isFlacTarget(target)) {
      const findings = await scanIntegrityTarget(target, 'deep', ffmpegPath)
      findings.forEach(recorder.record)
      scanned += 1
      continue
    }

    const findings = await scanIntegrityTarget(target, 'quick', null)
    findings.forEach(recorder.record)
    scanned += 1
    skipped += 1
    recorder.record({
      severity: 'info',
      code: 'deep_scan_flac_only',
      path: target.path,
      title: target.title,
      message: 'Deep integrity traversal is FLAC-only in this version.',
      detail: `${target.format.toUpperCase()} was checked with quick file and metadata validation.`,
      confidence: 'high'
    })
  }

  return buildIntegrityResult(mode, scope, recorder.findings, scanned, skipped, false, startedAt)
}

ipcMain.handle('library:checkTrackIntegrity', async (_event, trackPath: string) => {
  return runTrackIntegrityCheck([trackPath])
})

ipcMain.handle('library:checkTracksIntegrity', async (_event, trackPaths: string[]) => {
  return runTrackIntegrityCheck(trackPaths)
})

ipcMain.handle('library:backfillReplayGainMetadata', async () => {
  const issueCollector = createLibraryScanIssueCollector()
  logMemoryDiagnosticsMainEvent('library_backfill_started', {
    kind: 'replaygain_manual'
  })
  try {
    const result = await runLibraryScanOperation(async (signal) => {
      sendLibraryScanStage('backfill', 'Processing ReplayGain metadata...')
      return library.backfillMissingReplayGainMetadata((current, total, file) => {
        mainWindow?.webContents.send('library:scanProgress', { current, total, file })
      }, {
        signal,
        persist: false,
        onIssue: (issue) => issueCollector.record(issue)
      })
    })

    if (result.scanned > 0) {
      console.log(
        `ReplayGain metadata backfill (manual): scanned=${result.scanned}, updated=${result.updated}, errors=${result.errors}`
      )
    }
    if (result.updated > 0) {
      mainWindow?.webContents.send('library:audioMetadataBackfillComplete', result)
    }

    try {
      await library.setAppMeta(REPLAYGAIN_BACKFILL_MIGRATION_KEY, '1')
    } catch (error) {
      console.warn('Failed to persist ReplayGain metadata backfill migration flag:', error)
    }

    return {
      ...result,
      canceled: false,
      scanIssueLog: issueCollector.build()
    }
  } catch (error) {
    if (library.isLibraryScanCancelledError(error)) {
      logMemoryDiagnosticsMainEvent('library_backfill_canceled', {
        kind: 'replaygain_manual'
      })
      return {
        scanned: 0,
        updated: 0,
        errors: 0,
        canceled: true,
        scanIssueLog: issueCollector.build()
      }
    }
    throw error
  } finally {
    logMemoryDiagnosticsMainEvent('library_backfill_finished', {
      kind: 'replaygain_manual'
    })
  }
})

// Add library folder and scan
ipcMain.handle('library:addFolder', async (_event, folderPath: string) => {
  const folder = await library.addLibraryFolder(folderPath)
  if (!folder) {
    return { success: false, error: 'Folder already in library' }
  }

  const folderLabel = basename(folderPath) || folderPath
  const issueCollector = createLibraryScanIssueCollector()
  logMemoryDiagnosticsMainEvent('library_scan_started', {
    kind: 'add_folder',
    folderPath,
    folderLabel
  })
  const syncSessionKey = latestLibrarySyncCoordinator.beginOperation()
  let syncSessionSucceeded = false

  try {
    const result = await runLibraryScanOperation(async (signal) => {
      const onIssue = (issue: library.LibraryScanIssue) => {
        issueCollector.record(issue, folderPath)
      }

      let scanResult: { added: number; updated: number; errors: number; skippedDirs: string[] } = {
        added: 0,
        updated: 0,
        errors: 0,
        skippedDirs: [],
      }
      sendLibraryScanStage('scanning', `Scanning files in ${folderLabel}...`)
      try {
        scanResult = await library.scanFolder(folderPath, (current, total, file) => {
          mainWindow?.webContents.send('library:scanProgress', { current, total, file })
        }, { signal, persist: false, onIssue, syncSessionKey })
      } catch (error) {
        if (library.isLibraryScanCancelledError(error)) {
          throw error
        }
        issueCollector.recordError('scan', folderPath, error, folderPath)
        scanResult.errors += 1
        console.error(`Folder scan failed for ${folderPath}:`, error)
      }

      sendLibraryScanStage('cleanup', 'Updating artist images...')
      await library.refreshDetectedArtistImages()

      return { ...scanResult, scanIssueLog: issueCollector.build() }
    })

    syncSessionSucceeded = true
    return { success: true, canceled: false, folder, ...result }
  } catch (error) {
    if (library.isLibraryScanCancelledError(error)) {
      logMemoryDiagnosticsMainEvent('library_scan_canceled', {
        kind: 'add_folder',
        folderPath
      })
      return { success: false, canceled: true, folder, scanIssueLog: issueCollector.build() }
    }
    throw error
  } finally {
    await finalizeLatestLibrarySyncSession(syncSessionKey, syncSessionSucceeded, 'add folder scan')
    logMemoryDiagnosticsMainEvent('library_scan_finished', {
      kind: 'add_folder',
      folderPath
    })
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
    const issueCollector = createLibraryScanIssueCollector()
    logMemoryDiagnosticsMainEvent('library_scan_started', {
      kind: 'rescan_folder',
      folderPath,
      folderLabel
    })
    const syncSessionKey = latestLibrarySyncCoordinator.beginOperation()
    let syncSessionSucceeded = false
    try {
      const result = await runLibraryScanOperation(async (signal) => {
        const onIssue = (issue: library.LibraryScanIssue) => {
          issueCollector.record(issue, folderPath)
        }

        let scanResult: { added: number; updated: number; errors: number; skippedDirs: string[] } = {
          added: 0,
          updated: 0,
          errors: 0,
          skippedDirs: [],
        }
        sendLibraryScanStage('scanning', `Scanning files in ${folderLabel}...`)
        try {
          scanResult = await library.scanFolder(folderPath, (current, total, file) => {
            mainWindow?.webContents.send('library:scanProgress', { current, total, file })
          }, { signal, persist: false, onIssue, syncSessionKey })
        } catch (error) {
          if (library.isLibraryScanCancelledError(error)) {
            throw error
          }
          issueCollector.recordError('scan', folderPath, error, folderPath)
          scanResult.errors += 1
          console.error(`Folder scan failed for ${folderPath}:`, error)
        }

        sendLibraryScanStage('cleanup', `Finalizing ${folderLabel}...`)
        let removed = 0
        try {
          removed = await library.cleanupMissingTracks({ signal, persist: false, onIssue })
        } catch (error) {
          if (library.isLibraryScanCancelledError(error)) {
            throw error
          }
          issueCollector.recordError('cleanup', folderPath, error, folderPath)
          console.error(`Folder cleanup failed for ${folderPath}:`, error)
        }

        let summary: library.FolderSubfolderSummary | undefined
        try {
          summary = await library.getFolderSubfolderSummary(folderPath)
        } catch (error) {
          issueCollector.recordError('cleanup', folderPath, error, folderPath)
          console.error(`Failed to refresh folder summary for ${folderPath}:`, error)
        }

        sendLibraryScanStage('cleanup', 'Updating artist images...')
        await library.refreshDetectedArtistImages()

        return { ...scanResult, removed, summary, scanIssueLog: issueCollector.build() }
      })

      syncSessionSucceeded = true
      return { success: true, canceled: false, ...result }
    } catch (error) {
      if (library.isLibraryScanCancelledError(error)) {
        logMemoryDiagnosticsMainEvent('library_scan_canceled', {
          kind: 'rescan_folder',
          folderPath
        })
        return { success: false, canceled: true, scanIssueLog: issueCollector.build() }
      }
      throw error
    } finally {
      await finalizeLatestLibrarySyncSession(syncSessionKey, syncSessionSucceeded, 'rescan folder')
      logMemoryDiagnosticsMainEvent('library_scan_finished', {
        kind: 'rescan_folder',
        folderPath
      })
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
  const issueCollector = createLibraryScanIssueCollector()
  logMemoryDiagnosticsMainEvent('library_scan_started', {
    kind: 'rescan_all',
    folderCount: library.getLibraryFolders().length
  })
  const syncSessionKey = latestLibrarySyncCoordinator.beginOperation()
  let syncSessionSucceeded = false
  try {
    const result = await runLibraryScanOperation(async (signal) => {
      const folders = library.getLibraryFolders()
      let totalAdded = 0
      let totalUpdated = 0
      let totalErrors = 0
      const folderWarnings: Record<string, string[]> = {}
      const totalFolders = folders.length

      for (let folderIndex = 0; folderIndex < folders.length; folderIndex++) {
        const folder = folders[folderIndex]
        const folderLabel = basename(folder.path) || folder.path
        const onFolderIssue = (issue: library.LibraryScanIssue) => {
          issueCollector.record(issue, folder.path)
        }
        sendLibraryScanStage('scanning', `Scanning ${folderLabel} (${folderIndex + 1}/${totalFolders})...`)

        try {
          const scanResult = await library.scanFolder(folder.path, (current, total, file) => {
            mainWindow?.webContents.send('library:scanProgress', { current, total, file })
          }, { signal, persist: false, onIssue: onFolderIssue, syncSessionKey })
          totalAdded += scanResult.added
          totalUpdated += scanResult.updated
          totalErrors += scanResult.errors
          if (scanResult.skippedDirs.length > 0) {
            folderWarnings[folder.path] = scanResult.skippedDirs
          }
        } catch (error) {
          if (library.isLibraryScanCancelledError(error)) {
            throw error
          }
          issueCollector.recordError('scan', folder.path, error, folder.path)
          totalErrors += 1
          console.error(`Failed to scan folder ${folder.path}:`, error)
          continue
        }

      }

      // Clean up tracks that no longer exist on disk
      sendLibraryScanStage('cleanup', 'Finalizing library...')
      let removed = 0
      try {
        removed = await library.cleanupMissingTracks({
          signal,
          persist: false,
          onIssue: (issue) => issueCollector.record(issue)
        })
      } catch (error) {
        if (library.isLibraryScanCancelledError(error)) {
          throw error
        }
        issueCollector.recordError('cleanup', '(library)', error)
        totalErrors += 1
        console.error('Failed to finalize library cleanup:', error)
      }

      sendLibraryScanStage('cleanup', 'Updating artist images...')
      await library.refreshDetectedArtistImages()

      return {
        added: totalAdded,
        updated: totalUpdated,
        errors: totalErrors,
        removed,
        folderWarnings,
        scanIssueLog: issueCollector.build()
      }
    })

    syncSessionSucceeded = true
    return { ...result, canceled: false }
  } catch (error) {
    if (library.isLibraryScanCancelledError(error)) {
      logMemoryDiagnosticsMainEvent('library_scan_canceled', {
        kind: 'rescan_all'
      })
      return {
        added: 0,
        updated: 0,
        errors: 0,
        removed: 0,
        folderWarnings: {},
        scanIssueLog: issueCollector.build(),
        canceled: true
      }
    }
    throw error
  } finally {
    await finalizeLatestLibrarySyncSession(syncSessionKey, syncSessionSucceeded, 'full rescan')
    logMemoryDiagnosticsMainEvent('library_scan_finished', {
      kind: 'rescan_all'
    })
  }
})

ipcMain.handle('library:forceRescanAll', async () => {
  const issueCollector = createLibraryScanIssueCollector()
  logMemoryDiagnosticsMainEvent('library_scan_started', {
    kind: 'force_rescan_all',
    folderCount: library.getLibraryFolders().length
  })
  const syncSessionKey = latestLibrarySyncCoordinator.beginOperation()
  let syncSessionSucceeded = false
  try {
    const result = await runLibraryScanOperation(async (signal) => {
      const folders = library.getLibraryFolders()
      let totalAdded = 0
      let totalUpdated = 0
      let totalErrors = 0
      const folderWarnings: Record<string, string[]> = {}
      const totalFolders = folders.length

      for (let folderIndex = 0; folderIndex < folders.length; folderIndex++) {
        const folder = folders[folderIndex]
        const folderLabel = basename(folder.path) || folder.path
        const onFolderIssue = (issue: library.LibraryScanIssue) => {
          issueCollector.record(issue, folder.path)
        }
        sendLibraryScanStage('scanning', `Rewriting metadata in ${folderLabel} (${folderIndex + 1}/${totalFolders})...`)

        try {
          const scanResult = await library.scanFolder(folder.path, (current, total, file) => {
            mainWindow?.webContents.send('library:scanProgress', { current, total, file })
          }, { signal, persist: false, onIssue: onFolderIssue, syncSessionKey, mode: 'force' })
          totalAdded += scanResult.added
          totalUpdated += scanResult.updated
          totalErrors += scanResult.errors
          if (scanResult.skippedDirs.length > 0) {
            folderWarnings[folder.path] = scanResult.skippedDirs
          }
        } catch (error) {
          if (library.isLibraryScanCancelledError(error)) {
            throw error
          }
          issueCollector.recordError('scan', folder.path, error, folder.path)
          totalErrors += 1
          console.error(`Failed to force rescan folder ${folder.path}:`, error)
          continue
        }
      }

      sendLibraryScanStage('cleanup', 'Finalizing library...')
      let removed = 0
      try {
        removed = await library.cleanupMissingTracks({
          signal,
          persist: false,
          onIssue: (issue) => issueCollector.record(issue)
        })
      } catch (error) {
        if (library.isLibraryScanCancelledError(error)) {
          throw error
        }
        issueCollector.recordError('cleanup', '(library)', error)
        totalErrors += 1
        console.error('Failed to finalize force rescan cleanup:', error)
      }

      sendLibraryScanStage('cleanup', 'Updating artist images...')
      await library.refreshDetectedArtistImages()

      return {
        added: totalAdded,
        updated: totalUpdated,
        errors: totalErrors,
        removed,
        folderWarnings,
        scanIssueLog: issueCollector.build()
      }
    })

    syncSessionSucceeded = true
    return { ...result, canceled: false }
  } catch (error) {
    if (library.isLibraryScanCancelledError(error)) {
      logMemoryDiagnosticsMainEvent('library_scan_canceled', {
        kind: 'force_rescan_all'
      })
      return {
        added: 0,
        updated: 0,
        errors: 0,
        removed: 0,
        folderWarnings: {},
        scanIssueLog: issueCollector.build(),
        canceled: true
      }
    }
    throw error
  } finally {
    await finalizeLatestLibrarySyncSession(syncSessionKey, syncSessionSucceeded, 'force rescan all')
    logMemoryDiagnosticsMainEvent('library_scan_finished', {
      kind: 'force_rescan_all'
    })
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

  const requestKey = getArtworkThumbnailCacheKey(hash, TRACKLIST_THUMB_MAX_EDGE_PX)
  if (artworkThumbnailRequestCache.has(requestKey)) {
    return artworkThumbnailRequestCache.get(requestKey)!
  }

  const request = getArtworkThumbnailDataUrlByHash(hash, {
    maxEdgePx: TRACKLIST_THUMB_MAX_EDGE_PX,
    jpegQuality: TRACKLIST_THUMB_JPEG_QUALITY
  })
    .finally(() => {
      artworkThumbnailRequestCache.delete(requestKey)
    })

  artworkThumbnailRequestCache.set(requestKey, request)
  return request
})

// Get card-sized artwork thumbnail as data URL
ipcMain.handle('library:getArtworkCardDataUrl', async (_event, hash: string) => {
  if (!hash) return null

  const requestKey = getArtworkThumbnailCacheKey(hash, CARD_ARTWORK_MAX_EDGE_PX)
  if (artworkThumbnailRequestCache.has(requestKey)) {
    return artworkThumbnailRequestCache.get(requestKey)!
  }

  const request = getArtworkThumbnailDataUrlByHash(hash, {
    maxEdgePx: CARD_ARTWORK_MAX_EDGE_PX,
    jpegQuality: CARD_ARTWORK_JPEG_QUALITY
  })
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

ipcMain.handle('library:markTrackLatestSyncSeen', async (_event, trackPath: string) => {
  await library.markTrackLatestSyncSeen(trackPath)
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

ipcMain.handle('library:getPlaylistTrackEntries', (_event, playlistId: number) => {
  return library.getPlaylistTrackEntries(playlistId)
})

ipcMain.handle('library:addToPlaylist', async (_event, playlistId: number, trackPaths: string[]) => {
  await library.addToPlaylist(playlistId, trackPaths)
})

ipcMain.handle('library:removeFromPlaylist', async (_event, playlistId: number, trackPath: string) => {
  await library.removeFromPlaylist(playlistId, trackPath)
})

ipcMain.handle('library:reorderPlaylistTracks', async (_event, playlistId: number, orderedTrackPaths: string[]) => {
  await library.reorderPlaylistTracks(playlistId, orderedTrackPaths)
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

ipcMain.handle('library:getPlaylistsContainingTracks', (_event, trackPaths: string[]) => {
  return library.getPlaylistsContainingTracks(trackPaths)
})

ipcMain.handle('library:importPlaylistFromFile', async (_event, filePath: string) => {
  return library.importPlaylistFromFile(filePath)
})

ipcMain.handle('library:exportPlaylistToM3u', async (_event, playlistId: number, filePath: string) => {
  return library.exportPlaylistToM3u(playlistId, filePath)
})

// ============================================
// Helper functions
// ============================================

interface LoadedAudioMetadata {
  title: string
  artist: string
  artistNames?: string[]
  album: string
  albumArtist?: string
  albumArtistNames?: string[]
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

interface RemoteStreamSession {
  id: number
  sender: Electron.WebContents
  filePath: string
  sourceType: RemoteStreamSourceType
  sampleRate: number
  channels: number
  durationSeconds: number | null
  ffmpeg: ChildProcessWithoutNullStreams
  abortController: AbortController
  responseReader: ReadableStreamDefaultReader<Uint8Array> | null
  startupResolve: ((info: RemoteStreamInfo) => void) | null
  startupReject: ((error: Error) => void) | null
  startupSettled: boolean
  startupChunk: RemoteStreamChunk | null
  stdoutRemainder: Buffer
  stderrChunks: string[]
  loadedBytes: number
  totalBytes: number | null
  chunkCount: number
  decodedFrames: number
  lastProgressEmitAt: number
  done: boolean
  failed: boolean
  cancelled: boolean
  emittedStartedEvent: boolean
  stdinClosed: boolean
}

function resolveRemoteTrackDurationSeconds(filePath: string): number | null {
  const track = library.getTrackByPath(filePath)
  if (!track) return null
  return typeof track.duration === 'number' && Number.isFinite(track.duration) && track.duration > 0
    ? track.duration
    : null
}

function buildRemoteLoadProgress(
  session: Pick<
    RemoteStreamSession,
    'filePath' | 'sourceType' | 'loadedBytes' | 'totalBytes' | 'chunkCount' | 'decodedFrames' | 'sampleRate' | 'durationSeconds' | 'done' | 'failed'
  >,
  stage: RemoteAudioLoadProgress['stage']
): RemoteAudioLoadProgress {
  const percent = session.totalBytes && session.totalBytes > 0
    ? Math.max(0, Math.min(1, session.loadedBytes / session.totalBytes))
    : null
  const bufferedSeconds = session.sampleRate > 0 ? session.decodedFrames / session.sampleRate : 0
  const bufferedPercent = session.durationSeconds && session.durationSeconds > 0
    ? Math.max(0, Math.min(1, bufferedSeconds / session.durationSeconds))
    : null

  return {
    path: session.filePath,
    sourceType: session.sourceType,
    stage,
    loadedBytes: session.loadedBytes,
    totalBytes: session.totalBytes,
    chunkCount: session.chunkCount,
    percent,
    done: session.done,
    failed: session.failed,
    bufferedSeconds,
    bufferedPercent,
    analyzedSeconds: bufferedSeconds,
    analyzedPercent: bufferedPercent,
    playable: bufferedSeconds >= REMOTE_STREAM_PLAYABLE_SECONDS
  }
}

function safeSendRemoteLoadProgress(session: RemoteStreamSession, stage: RemoteAudioLoadProgress['stage'], force: boolean = false): void {
  if (session.sender.isDestroyed()) return
  const now = Date.now()
  if (!force && stage !== 'complete' && stage !== 'failed' && now - session.lastProgressEmitAt < SUBSONIC_DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS) {
    return
  }
  session.lastProgressEmitAt = now
  session.sender.send('audio:remoteLoadProgress', buildRemoteLoadProgress(session, stage))
}

function safeSendRemoteStreamEvent(session: RemoteStreamSession, payload: RemoteStreamEvent): void {
  if (session.sender.isDestroyed()) return
  session.sender.send('audio:remoteStreamEvent', payload)
}

function settleRemoteStreamStartup(session: RemoteStreamSession, outcome: { ok: true } | { ok: false; error: Error }): void {
  if (session.startupSettled) return
  session.startupSettled = true
  if (outcome.ok) {
    session.startupResolve?.({
      sessionId: session.id,
      path: session.filePath,
      sourceType: session.sourceType,
      sampleRate: session.sampleRate,
      channels: session.channels,
      durationSeconds: session.durationSeconds,
      initialChunk: session.startupChunk
    })
  } else {
    session.startupReject?.(outcome.error)
  }
  session.startupResolve = null
  session.startupReject = null
}

function emitRemoteStreamChunk(session: RemoteStreamSession, data: Buffer): void {
  if (session.sender.isDestroyed()) return

  const frameSizeBytes = session.channels * 4
  const frameCount = Math.floor(data.length / frameSizeBytes)
  if (frameCount <= 0) return

  session.decodedFrames += frameCount
  const payload: RemoteStreamChunk = {
    sessionId: session.id,
    path: session.filePath,
    sourceType: session.sourceType,
    sampleRate: session.sampleRate,
    channels: session.channels,
    frameCount,
    pcmData: Uint8Array.from(data).buffer,
    decodedFrames: session.decodedFrames,
    decodedSeconds: session.decodedFrames / session.sampleRate
  }

  if (!session.emittedStartedEvent) {
    session.startupChunk = payload
    session.emittedStartedEvent = true
    safeSendRemoteStreamEvent(session, {
      sessionId: session.id,
      path: session.filePath,
      sourceType: session.sourceType,
      type: 'started',
      sampleRate: session.sampleRate,
      channels: session.channels,
      durationSeconds: session.durationSeconds
    })
    settleRemoteStreamStartup(session, { ok: true })
  } else {
    session.sender.send('audio:remoteStreamChunk', payload)
  }

  safeSendRemoteLoadProgress(session, 'streaming')
}

function finalizeRemoteStreamSession(
  session: RemoteStreamSession,
  outcome: 'complete' | 'cancelled' | 'failed',
  error?: Error
): void {
  if (session.done) return

  session.done = true
  session.failed = outcome === 'failed'
  session.cancelled = outcome === 'cancelled'
  remoteStreamSessions.delete(session.id)

  try {
    session.abortController.abort()
  } catch {
    // Ignore abort races during teardown.
  }

  try {
    session.responseReader?.cancel().catch(() => undefined)
  } catch {
    // Ignore reader cancellation failures during teardown.
  }
  session.responseReader = null

  try {
    session.stdinClosed = true
    if (!session.ffmpeg.stdin.destroyed) {
      session.ffmpeg.stdin.end()
    }
  } catch {
    // Ignore stdin teardown failures.
  }

  try {
    if (!session.ffmpeg.killed) {
      session.ffmpeg.kill('SIGKILL')
    }
  } catch {
    // Ignore child teardown failures.
  }

  const decodedSeconds = session.sampleRate > 0 ? session.decodedFrames / session.sampleRate : 0
  if (outcome === 'complete') {
    if (!session.emittedStartedEvent) {
      settleRemoteStreamStartup(session, {
        ok: false,
        error: new Error('Remote stream produced no decodable audio.')
      })
    }
    safeSendRemoteLoadProgress(session, 'complete', true)
    safeSendRemoteStreamEvent(session, {
      sessionId: session.id,
      path: session.filePath,
      sourceType: session.sourceType,
      type: 'complete',
      decodedFrames: session.decodedFrames,
      decodedSeconds
    })
    return
  }

  const failure = error ?? new Error(outcome === 'cancelled' ? 'Remote stream was cancelled.' : 'Remote stream failed.')
  settleRemoteStreamStartup(session, { ok: false, error: failure })
  safeSendRemoteLoadProgress(session, 'failed', true)
  safeSendRemoteStreamEvent(session, outcome === 'cancelled'
    ? {
        sessionId: session.id,
        path: session.filePath,
        sourceType: session.sourceType,
        type: 'cancelled',
        decodedFrames: session.decodedFrames,
        decodedSeconds
      }
    : {
        sessionId: session.id,
        path: session.filePath,
        sourceType: session.sourceType,
        type: 'failed',
        message: failure.message,
        decodedFrames: session.decodedFrames,
        decodedSeconds
      }
  )
}

function isRemoteStreamPipeTeardownError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  const code = 'code' in error ? (error as { code?: unknown }).code : undefined
  if (typeof code === 'string' && (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED')) {
    return true
  }

  if (error instanceof Error) {
    return error.message.includes('EPIPE') || error.message.includes('ERR_STREAM_DESTROYED')
  }

  return false
}

async function writeRemoteStreamInput(session: RemoteStreamSession, chunk: Uint8Array): Promise<void> {
  if (session.cancelled || session.done) return
  if (session.stdinClosed || !session.ffmpeg.stdin.writable || session.ffmpeg.stdin.destroyed) {
    throw new Error('FFmpeg input pipe is not writable.')
  }

  await new Promise<void>((resolve, reject) => {
    session.ffmpeg.stdin.write(chunk, (error) => {
      if (error) {
        if (session.cancelled || session.done || session.stdinClosed) {
          resolve()
          return
        }
        reject(error)
        return
      }
      resolve()
    })
  })
}

function validateRemoteAudioResponse(response: Response, label: string): void {
  if (!response.ok) {
    throw new Error(`${label} stream request failed (${response.status})`)
  }

  const contentType = (response.headers.get('content-type') ?? '').trim().toLowerCase()
  if (
    contentType
    && (contentType.includes('json') || contentType.includes('xml') || contentType.startsWith('text/'))
  ) {
    throw new Error(`${label} stream response was not audio.`)
  }
}

async function openSubsonicRemoteStreamResponse(
  filePath: string,
  signal: AbortSignal
): Promise<{ response: Response; sourceType: 'subsonic' }> {
  const parsed = parseSubsonicTrackPath(filePath)
  if (!parsed) {
    throw new Error('Invalid Subsonic track path.')
  }

  const credentials = requireSubsonicSourceCredentials(parsed.sourceId)
  if (credentials.source.enabled !== 1) {
    await library.setTrackAvailability(filePath, false, 'source_disabled')
    throw new Error(`Subsonic source "${credentials.source.name}" is disabled.`)
  }

  const urls = [
    buildSubsonicStreamUrl(credentials.connection, parsed.sourceTrackId, {
      maxBitRateKbps: SUBSONIC_STREAM_MAX_BITRATE_KBPS
    }),
    buildSubsonicStreamUrl(credentials.connection, parsed.sourceTrackId)
  ]

  let lastError: Error | null = null
  for (const url of urls) {
    try {
      const response = await fetch(url, { method: 'GET', signal })
      validateRemoteAudioResponse(response, 'Subsonic')
      await library.setTrackAvailability(filePath, true, null, { persist: false })
      return { response, sourceType: 'subsonic' }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Subsonic stream request failed.')
    }
  }

  await library.setTrackAvailability(filePath, false, 'source_unavailable')
  throw lastError ?? new Error('Subsonic stream request failed.')
}

async function fetchJellyfinRemoteStreamResponse(
  filePath: string,
  signal: AbortSignal
): Promise<{ response: Response; sourceType: 'jellyfin' }> {
  const parsed = parseJellyfinTrackPath(filePath)
  if (!parsed) {
    throw new Error('Invalid Jellyfin track path.')
  }

  const credentials = requireJellyfinSourceCredentials(parsed.sourceId)
  if (credentials.source.enabled !== 1) {
    await library.setTrackAvailability(filePath, false, 'source_disabled')
    throw new Error(`Jellyfin source "${credentials.source.name}" is disabled.`)
  }

  const fetchWithContext = async (
    useTranscode: boolean,
    forceRefreshAuth: boolean = false
  ): Promise<Response> => {
    let authContext = await getJellyfinAuthContext(parsed.sourceId, credentials.connection, {
      forceRefresh: forceRefreshAuth
    })

    const performFetch = async (): Promise<Response> => {
      const url = useTranscode
        ? buildJellyfinTranscodeStreamUrl(credentials.connection, parsed.sourceTrackId, authContext, JELLYFIN_STREAM_MAX_BITRATE_KBPS)
        : buildJellyfinStreamUrl(credentials.connection, parsed.sourceTrackId, authContext.accessToken)
      const response = await fetch(url, {
        method: 'GET',
        signal,
        headers: buildJellyfinStreamRequestHeaders(credentials.connection, authContext)
      })
      validateRemoteAudioResponse(response, 'Jellyfin')
      return response
    }

    try {
      return await performFetch()
    } catch (error) {
      if (!isJellyfinUnauthorizedError(error)) {
        throw error
      }

      clearJellyfinAuthContext(parsed.sourceId)
      authContext = await getJellyfinAuthContext(parsed.sourceId, credentials.connection, { forceRefresh: true })
      return await performFetch()
    }
  }

  try {
    const response = await fetchWithContext(true)
    await library.setTrackAvailability(filePath, true, null, { persist: false })
    return { response, sourceType: 'jellyfin' }
  } catch (transcodeError) {
    console.warn(`Jellyfin bitrate-limited stream failed for ${filePath}, retrying raw stream:`, transcodeError)
  }

  try {
    const response = await fetchWithContext(false)
    await library.setTrackAvailability(filePath, true, null, { persist: false })
    return { response, sourceType: 'jellyfin' }
  } catch (error) {
    await library.setTrackAvailability(filePath, false, 'source_unavailable')
    throw error instanceof Error ? error : new Error('Jellyfin stream request failed.')
  }
}

async function openRemoteStreamResponse(
  filePath: string,
  signal: AbortSignal
): Promise<{ response: Response; sourceType: RemoteStreamSourceType }> {
  if (isSubsonicPath(filePath)) {
    return openSubsonicRemoteStreamResponse(filePath, signal)
  }
  if (isJellyfinPath(filePath)) {
    return fetchJellyfinRemoteStreamResponse(filePath, signal)
  }
  throw new Error('Remote streaming is only available for Subsonic and Jellyfin tracks.')
}

function pumpRemoteStreamOutput(session: RemoteStreamSession, chunk: Buffer): void {
  if (chunk.length === 0) return

  const frameSizeBytes = session.channels * 4
  if (frameSizeBytes <= 0) return

  session.stdoutRemainder = session.stdoutRemainder.length > 0
    ? Buffer.concat([session.stdoutRemainder, chunk])
    : chunk

  const chunkSizeBytes = REMOTE_STREAM_CHUNK_FRAMES * frameSizeBytes
  while (session.stdoutRemainder.length >= chunkSizeBytes) {
    const nextChunk = session.stdoutRemainder.subarray(0, chunkSizeBytes)
    session.stdoutRemainder = session.stdoutRemainder.subarray(chunkSizeBytes)
    emitRemoteStreamChunk(session, nextChunk)
  }
}

function flushRemoteStreamOutput(session: RemoteStreamSession): void {
  if (session.stdoutRemainder.length === 0) return

  const frameSizeBytes = session.channels * 4
  const alignedBytes = session.stdoutRemainder.length - (session.stdoutRemainder.length % frameSizeBytes)
  if (alignedBytes <= 0) {
    session.stdoutRemainder = Buffer.alloc(0)
    return
  }

  emitRemoteStreamChunk(session, session.stdoutRemainder.subarray(0, alignedBytes))
  session.stdoutRemainder = Buffer.alloc(0)
}

async function startRemoteStreamSession(
  sender: Electron.WebContents,
  filePath: string,
  outputSampleRate: number,
  expectedChannels?: number | null
): Promise<RemoteStreamInfo> {
  const ffmpegPath = await resolveBinary('ffmpeg')
  if (!ffmpegPath) {
    throw new Error('FFmpeg could not be resolved for remote streaming.')
  }

  const normalizedSampleRate = Number.isFinite(outputSampleRate) && outputSampleRate > 0
    ? Math.max(8_000, Math.round(outputSampleRate))
    : 48_000
  const dbTrack = library.getTrackByPath(filePath)
  const normalizedChannels = Number.isFinite(expectedChannels)
    ? Math.max(1, Math.min(8, Math.round(Number(expectedChannels))))
    : Math.max(1, Math.min(8, dbTrack?.channels ?? 2))
  const abortController = new AbortController()
  const { response, sourceType } = await openRemoteStreamResponse(filePath, abortController.signal)
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Remote stream response body was not readable.')
  }

  const contentLengthHeader = response.headers.get('content-length')
  const parsedContentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : Number.NaN
  const totalBytes = Number.isFinite(parsedContentLength) && parsedContentLength > 0 ? parsedContentLength : null
  const ffmpeg = spawn(
    ffmpegPath,
    [
      '-v', 'error',
      '-nostdin',
      '-i', 'pipe:0',
      '-map', '0:a:0',
      '-vn',
      '-acodec', 'pcm_f32le',
      '-f', 'f32le',
      '-ar', String(normalizedSampleRate),
      '-ac', String(normalizedChannels),
      'pipe:1'
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }
  )

  const sessionId = nextRemoteStreamSessionId
  nextRemoteStreamSessionId += 1

  const infoPromise = new Promise<RemoteStreamInfo>((resolve, reject) => {
    const session: RemoteStreamSession = {
      id: sessionId,
      sender,
      filePath,
      sourceType,
      sampleRate: normalizedSampleRate,
      channels: normalizedChannels,
      durationSeconds: resolveRemoteTrackDurationSeconds(filePath),
      ffmpeg,
      abortController,
      responseReader: reader,
      startupResolve: resolve,
      startupReject: reject,
      startupSettled: false,
      startupChunk: null,
      stdoutRemainder: Buffer.alloc(0),
      stderrChunks: [],
      loadedBytes: 0,
      totalBytes,
      chunkCount: 0,
      decodedFrames: 0,
      lastProgressEmitAt: 0,
      done: false,
      failed: false,
      cancelled: false,
      emittedStartedEvent: false,
      stdinClosed: false
    }

    remoteStreamSessions.set(session.id, session)
    safeSendRemoteLoadProgress(session, 'downloading', true)

    ffmpeg.stderr.setEncoding('utf8')
    ffmpeg.stderr.on('data', (data: string | Buffer) => {
      session.stderrChunks.push(String(data))
      if (session.stderrChunks.length > 8) {
        session.stderrChunks.shift()
      }
    })

    ffmpeg.stdin.on('finish', () => {
      session.stdinClosed = true
    })

    ffmpeg.stdin.on('close', () => {
      session.stdinClosed = true
    })

    ffmpeg.stdin.on('error', (error) => {
      session.stdinClosed = true
      if (session.done || session.cancelled) return
      if (isRemoteStreamPipeTeardownError(error)) {
        return
      }
      finalizeRemoteStreamSession(
        session,
        'failed',
        error instanceof Error ? error : new Error('Remote FFmpeg input pipe failed.')
      )
    })

    ffmpeg.stdout.on('data', (data: Buffer) => {
      pumpRemoteStreamOutput(session, data)
    })

    ffmpeg.stdout.on('end', () => {
      flushRemoteStreamOutput(session)
    })

    ffmpeg.on('error', (error) => {
      finalizeRemoteStreamSession(session, 'failed', error instanceof Error ? error : new Error('Remote FFmpeg process failed.'))
    })

    ffmpeg.on('close', (code) => {
      session.stdinClosed = true
      if (session.done) return
      if (session.cancelled) {
        finalizeRemoteStreamSession(session, 'cancelled')
        return
      }
      if (code === 0) {
        finalizeRemoteStreamSession(session, 'complete')
        return
      }

      const stderr = session.stderrChunks.join(' ').trim()
      finalizeRemoteStreamSession(session, 'failed', new Error(
        stderr.length > 0
          ? `Remote stream decode failed: ${stderr}`
          : `Remote stream decode failed (ffmpeg exit ${code ?? 'unknown'}).`
      ))
    })

    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value || value.byteLength === 0) continue

          session.loadedBytes += value.byteLength
          session.chunkCount += 1
          safeSendRemoteLoadProgress(session, session.decodedFrames > 0 ? 'streaming' : 'downloading')
          await writeRemoteStreamInput(session, value)
        }

        if (!ffmpeg.stdin.destroyed) {
          ffmpeg.stdin.end()
        }
      } catch (error) {
        if (session.done || session.cancelled) return
        if (isRemoteStreamPipeTeardownError(error)) return
        finalizeRemoteStreamSession(session, 'failed', error instanceof Error ? error : new Error('Remote stream download failed.'))
      }
    })()
  })

  return infoPromise
}

async function cancelRemoteStreamSession(sessionId: number): Promise<void> {
  const session = remoteStreamSessions.get(sessionId)
  if (!session) return
  session.cancelled = true
  finalizeRemoteStreamSession(session, 'cancelled')
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
  const packagedStaticCandidates = isDev
    ? []
    : (
        binary === 'ffmpeg'
          ? [join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', executable)]
          : [join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, executable)]
      )
  const systemCandidates = binary === 'ffmpeg'
    ? (isWindows ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'])
    : (isWindows ? ['ffprobe.exe', 'ffprobe'] : ['ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'])

  const staticModulePath = await resolveStaticModuleBinary(binary)
  const candidateSet = new Set<string>([
    ...(isDev ? [] : [
      join(process.resourcesPath, executable),
      join(process.resourcesPath, 'bin', executable)
    ]),
    ...packagedStaticCandidates,
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

function isSubsonicPath(pathValue: string): boolean {
  return parseSubsonicTrackPath(pathValue) !== null
}

function isJellyfinPath(pathValue: string): boolean {
  return parseJellyfinTrackPath(pathValue) !== null
}

function sanitizeAudioExtension(extension: string | null | undefined): string {
  const normalized = String(extension ?? '').trim().toLowerCase()
  if (!normalized) return ''
  const safe = normalized.replace(/[^a-z0-9]/g, '')
  if (!safe) return ''
  return `.${safe}`
}

async function writeTempAudioFileFromBuffer(
  buffer: ArrayBuffer,
  extension: string | null | undefined
): Promise<{ tempDir: string; filePath: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'astra-remote-'))
  const ext = sanitizeAudioExtension(extension)
  const tempPath = join(tempDir, `stream${ext || '.bin'}`)
  const data = Buffer.from(buffer)
  await writeFile(tempPath, data)
  return { tempDir, filePath: tempPath }
}

async function resolveSubsonicAudioPayload(
  filePath: string,
  options: {
    onDownloadProgress?: (progress: RemoteAudioLoadProgress) => void
  } = {}
): Promise<{
  parsed: { sourceId: number; sourceTrackId: string }
  track: library.DbTrack | null
  streamUrl: string
  data: ArrayBuffer
}> {
  const parsed = parseSubsonicTrackPath(filePath)
  if (!parsed) {
    throw new Error('Invalid Subsonic track path.')
  }

  const credentials = requireSubsonicSourceCredentials(parsed.sourceId)
  if (credentials.source.enabled !== 1) {
    await library.setTrackAvailability(filePath, false, 'source_disabled')
    throw new Error(`Subsonic source "${credentials.source.name}" is disabled.`)
  }

  const streamUrl = buildSubsonicStreamUrl(credentials.connection, parsed.sourceTrackId, {
    maxBitRateKbps: SUBSONIC_STREAM_MAX_BITRATE_KBPS
  })
  let latestProgress: {
    loadedBytes: number
    totalBytes: number | null
    chunkCount: number
  } = {
    loadedBytes: 0,
    totalBytes: null,
    chunkCount: 0
  }
  let lastProgressEmitAt = 0
  const emitDownloadProgress = (
    progress: SubsonicDownloadProgress,
    optionsOverride: { force?: boolean; failed?: boolean } = {}
  ) => {
    latestProgress = {
      loadedBytes: progress.loadedBytes,
      totalBytes: progress.totalBytes,
      chunkCount: progress.chunkCount
    }

    if (!options.onDownloadProgress) return
    const force = optionsOverride.force === true
    const now = Date.now()
    if (!force && !progress.done && now - lastProgressEmitAt < SUBSONIC_DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS) {
      return
    }
    lastProgressEmitAt = now

    const percent = progress.totalBytes && progress.totalBytes > 0
      ? Math.max(0, Math.min(1, progress.loadedBytes / progress.totalBytes))
      : null

    options.onDownloadProgress({
      path: filePath,
      sourceType: 'subsonic',
      stage: 'downloading',
      loadedBytes: progress.loadedBytes,
      totalBytes: progress.totalBytes,
      chunkCount: progress.chunkCount,
      percent,
      done: progress.done,
      failed: optionsOverride.failed === true,
      bufferedSeconds: 0,
      bufferedPercent: 0,
      analyzedSeconds: 0,
      analyzedPercent: 0,
      playable: false
    })
  }

  try {
    emitDownloadProgress(
      {
        loadedBytes: 0,
        totalBytes: null,
        chunkCount: 0,
        done: false
      },
      { force: true }
    )

    let data: ArrayBuffer
    try {
      data = await fetchSubsonicTrackBytes(credentials.connection, parsed.sourceTrackId, {
        timeoutMs: 20_000,
        retries: 1,
        maxBitRateKbps: SUBSONIC_STREAM_MAX_BITRATE_KBPS,
        onDownloadProgress: (progress) => {
          emitDownloadProgress(progress, { force: progress.done })
        }
      })
    } catch (transcodeError) {
      // Some servers or codecs cannot transcode; retry raw stream before failing.
      console.warn(`Subsonic bitrate-limited stream failed for ${filePath}, retrying raw stream:`, transcodeError)
      emitDownloadProgress(
        {
          loadedBytes: 0,
          totalBytes: null,
          chunkCount: 0,
          done: false
        },
        { force: true }
      )
      data = await fetchSubsonicTrackBytes(credentials.connection, parsed.sourceTrackId, {
        timeoutMs: 20_000,
        retries: 1,
        onDownloadProgress: (progress) => {
          emitDownloadProgress(progress, { force: progress.done })
        }
      })
    }
    await library.setTrackAvailability(filePath, true, null, { persist: false })
    return {
      parsed,
      track: library.getTrackByPath(filePath),
      streamUrl,
      data
    }
  } catch (error) {
    emitDownloadProgress(
      {
        loadedBytes: latestProgress.loadedBytes,
        totalBytes: latestProgress.totalBytes,
        chunkCount: latestProgress.chunkCount,
        done: true
      },
      { force: true, failed: true }
    )
    await library.setTrackAvailability(filePath, false, 'source_unavailable')
    throw error
  }
}

async function resolveJellyfinAudioPayload(
  filePath: string,
  options: {
    onDownloadProgress?: (progress: RemoteAudioLoadProgress) => void
  } = {}
): Promise<{
  parsed: { sourceId: number; sourceTrackId: string }
  track: library.DbTrack | null
  streamUrl: string
  data: ArrayBuffer
}> {
  const parsed = parseJellyfinTrackPath(filePath)
  if (!parsed) {
    throw new Error('Invalid Jellyfin track path.')
  }

  const credentials = requireJellyfinSourceCredentials(parsed.sourceId)
  if (credentials.source.enabled !== 1) {
    await library.setTrackAvailability(filePath, false, 'source_disabled')
    throw new Error(`Jellyfin source "${credentials.source.name}" is disabled.`)
  }

  let authContext = await getJellyfinAuthContext(parsed.sourceId, credentials.connection)
  let streamUrl = buildJellyfinStreamUrl(credentials.connection, parsed.sourceTrackId, authContext.accessToken)
  let latestProgress: {
    loadedBytes: number
    totalBytes: number | null
    chunkCount: number
  } = {
    loadedBytes: 0,
    totalBytes: null,
    chunkCount: 0
  }
  let lastProgressEmitAt = 0
  const emitDownloadProgress = (
    progress: JellyfinDownloadProgress,
    optionsOverride: { force?: boolean; failed?: boolean } = {}
  ) => {
    latestProgress = {
      loadedBytes: progress.loadedBytes,
      totalBytes: progress.totalBytes,
      chunkCount: progress.chunkCount
    }

    if (!options.onDownloadProgress) return
    const force = optionsOverride.force === true
    const now = Date.now()
    if (!force && !progress.done && now - lastProgressEmitAt < SUBSONIC_DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS) {
      return
    }
    lastProgressEmitAt = now

    const percent = progress.totalBytes && progress.totalBytes > 0
      ? Math.max(0, Math.min(1, progress.loadedBytes / progress.totalBytes))
      : null

    options.onDownloadProgress({
      path: filePath,
      sourceType: 'jellyfin',
      stage: 'downloading',
      loadedBytes: progress.loadedBytes,
      totalBytes: progress.totalBytes,
      chunkCount: progress.chunkCount,
      percent,
      done: progress.done,
      failed: optionsOverride.failed === true,
      bufferedSeconds: 0,
      bufferedPercent: 0,
      analyzedSeconds: 0,
      analyzedPercent: 0,
      playable: false
    })
  }

  try {
    emitDownloadProgress(
      {
        loadedBytes: 0,
        totalBytes: null,
        chunkCount: 0,
        done: false
      },
      { force: true }
    )

    const fetchWithAuthContext = async (
      context: { accessToken: string; userId: string },
      options: { allowTranscodeRetry?: boolean } = {}
    ): Promise<ArrayBuffer> => {
      try {
        return await fetchJellyfinTrackBytes(credentials.connection, parsed.sourceTrackId, context, {
          timeoutMs: 20_000,
          retries: 1,
          maxBitRateKbps: JELLYFIN_STREAM_MAX_BITRATE_KBPS,
          onDownloadProgress: (progress) => {
            emitDownloadProgress(progress, { force: progress.done })
          }
        })
      } catch (transcodeError) {
        if (options.allowTranscodeRetry === false) {
          throw transcodeError
        }

        console.warn(`Jellyfin bitrate-limited stream failed for ${filePath}, retrying raw stream:`, transcodeError)
        emitDownloadProgress(
          {
            loadedBytes: 0,
            totalBytes: null,
            chunkCount: 0,
            done: false
          },
          { force: true }
        )
        return fetchJellyfinTrackBytes(credentials.connection, parsed.sourceTrackId, context, {
          timeoutMs: 20_000,
          retries: 1,
          onDownloadProgress: (progress) => {
            emitDownloadProgress(progress, { force: progress.done })
          }
        })
      }
    }

    let data: ArrayBuffer
    try {
      data = await fetchWithAuthContext(authContext)
    } catch (error) {
      if (!isJellyfinUnauthorizedError(error)) {
        throw error
      }

      clearJellyfinAuthContext(parsed.sourceId)
      authContext = await getJellyfinAuthContext(parsed.sourceId, credentials.connection, { forceRefresh: true })
      streamUrl = buildJellyfinStreamUrl(credentials.connection, parsed.sourceTrackId, authContext.accessToken)
      emitDownloadProgress(
        {
          loadedBytes: 0,
          totalBytes: null,
          chunkCount: 0,
          done: false
        },
        { force: true }
      )
      data = await fetchWithAuthContext(authContext, { allowTranscodeRetry: true })
    }

    await library.setTrackAvailability(filePath, true, null, { persist: false })
    return {
      parsed,
      track: library.getTrackByPath(filePath),
      streamUrl,
      data
    }
  } catch (error) {
    emitDownloadProgress(
      {
        loadedBytes: latestProgress.loadedBytes,
        totalBytes: latestProgress.totalBytes,
        chunkCount: latestProgress.chunkCount,
        done: true
      },
      { force: true, failed: true }
    )
    await library.setTrackAvailability(filePath, false, 'source_unavailable')
    throw error
  }
}

async function decodeAudioWithFfmpeg(filePath: string): Promise<ArrayBuffer | null> {
  if (isSubsonicPath(filePath) || isJellyfinPath(filePath)) {
    let tempDir: string | null = null
    try {
      const payload = isSubsonicPath(filePath)
        ? await resolveSubsonicAudioPayload(filePath)
        : await resolveJellyfinAudioPayload(filePath)
      const temp = await writeTempAudioFileFromBuffer(payload.data, payload.track?.format)
      tempDir = temp.tempDir
      return await decodeAudioWithFfmpeg(temp.filePath)
    } catch (error) {
      console.warn(`FFmpeg compatibility decode failed for ${filePath}:`, error)
      return null
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

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

async function loadAudioMetadata(filePath: string): Promise<LoadedAudioMetadata | null> {
  if (isSubsonicPath(filePath) || isJellyfinPath(filePath)) {
    let tempDir: string | null = null
    const dbTrack = library.getTrackByPath(filePath)
    try {
      const payload = isSubsonicPath(filePath)
        ? await resolveSubsonicAudioPayload(filePath)
        : await resolveJellyfinAudioPayload(filePath)
      const temp = await writeTempAudioFileFromBuffer(payload.data, payload.track?.format)
      tempDir = temp.tempDir
      const parsed = await loadAudioMetadata(temp.filePath)
      if (parsed) {
        return {
          ...parsed,
          title: parsed.title ?? payload.track?.title ?? dbTrack?.title,
          artist: parsed.artist ?? payload.track?.artist ?? dbTrack?.artist,
          artistNames: parsed.artistNames && parsed.artistNames.length > 0 ? parsed.artistNames : dbTrack?.artist_names,
          album: parsed.album ?? payload.track?.album ?? dbTrack?.album,
          albumArtist: parsed.albumArtist ?? payload.track?.album_artist ?? dbTrack?.album_artist ?? undefined,
          albumArtistNames: parsed.albumArtistNames && parsed.albumArtistNames.length > 0 ? parsed.albumArtistNames : dbTrack?.album_artist_names,
          duration: parsed.duration ?? payload.track?.duration ?? dbTrack?.duration,
          format: payload.track?.format ?? dbTrack?.format ?? parsed.format
        }
      }
    } catch {
      // Fall back to DB metadata below.
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }

    if (!dbTrack) return null
    return {
      title: dbTrack.title,
      artist: dbTrack.artist,
      artistNames: dbTrack.artist_names,
      album: dbTrack.album,
      albumArtist: dbTrack.album_artist ?? undefined,
      albumArtistNames: dbTrack.album_artist_names,
      duration: dbTrack.duration,
      format: dbTrack.format,
      channels: dbTrack.channels ?? undefined,
      codec: dbTrack.codec ?? undefined,
      codecProfile: dbTrack.codec_profile ?? undefined,
      isAtmosJoc: dbTrack.is_atmos_joc === 1,
      replayGainTrackDb: replayGainScanEnabled
        ? (dbTrack.replaygain_track_gain_db ?? undefined)
        : undefined,
      replayGainAlbumDb: replayGainScanEnabled
        ? (dbTrack.replaygain_album_gain_db ?? undefined)
        : undefined
    }
  }

  const name = basename(filePath)
  const fallbackTitle = name.replace(/\.[^.]+$/, '')
  const format = filePath.split('.').pop()?.toLowerCase() ?? 'unknown'

  // Extract metadata using music-metadata with ffprobe enrichment fallback.
  let metadata: LoadedAudioMetadata = {
    title: fallbackTitle,
    artist: 'Unknown Artist',
    album: 'Unknown Album',
    format
  }

  try {
    const mm_metadata = await mm.parseFile(filePath, getMusicMetadataParseOptions(filePath))
    const common = mm_metadata.common
    const replayGain = extractReplayGainDb(mm_metadata)
    const parsedArtistNames = normalizeArtistNames(common.artists ?? [])
    const parsedAlbumArtistNames = normalizeArtistNames(common.albumartists ?? [])
    const artistDisplay = parsedArtistNames.length > 1
      ? formatArtistNames(parsedArtistNames)
      : common.artist || formatArtistNames(parsedArtistNames) || 'Unknown Artist'
    const albumArtistDisplay = parsedAlbumArtistNames.length > 1
      ? formatArtistNames(parsedAlbumArtistNames)
      : typeof common.albumartist === 'string'
        ? common.albumartist
        : formatArtistNames(parsedAlbumArtistNames) || undefined

    // Convert artwork to base64 data URL
    let artworkDataUrl: string | undefined
    if (common.picture && common.picture.length > 0) {
      const pic = common.picture[0]
      const base64 = Buffer.from(pic.data).toString('base64')
      artworkDataUrl = `data:${pic.format};base64,${base64}`
    }

    metadata = {
      title: common.title || fallbackTitle,
      artist: artistDisplay,
      artistNames: parsedArtistNames,
      album: common.album || 'Unknown Album',
      albumArtist: albumArtistDisplay,
      albumArtistNames: parsedAlbumArtistNames,
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

  return metadata
}

async function loadAudioFile(
  filePath: string,
  options: LoadAudioFileOptions = {},
  runtime: {
    onRemoteLoadProgress?: (progress: RemoteAudioLoadProgress) => void
  } = {}
) {
  const loadStartMs = Date.now()
  try {
    if (isSubsonicPath(filePath) || isJellyfinPath(filePath)) {
      const payload = isSubsonicPath(filePath)
        ? await resolveSubsonicAudioPayload(filePath, {
            onDownloadProgress: runtime.onRemoteLoadProgress
          })
        : await resolveJellyfinAudioPayload(filePath, {
            onDownloadProgress: runtime.onRemoteLoadProgress
          })
      const name = payload.track?.title ?? payload.parsed.sourceTrackId
      const response = {
        path: filePath,
        name,
        data: payload.data,
        metadata: options.metadataMode === 'none'
          ? undefined
          : (await loadAudioMetadata(filePath)) ?? undefined
      }

      const elapsedMs = Date.now() - loadStartMs
      if (isDev && elapsedMs > 1500) {
        console.warn(`[perf] loadAudioFile slow path (${elapsedMs}ms):`, {
          filePath,
          metadataMode: options.metadataMode ?? 'full',
          remote: true
        })
      }
      return response
    }

    // Read file as buffer
    const buffer = await readFile(filePath)
    const name = basename(filePath)
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

    const metadata = await loadAudioMetadata(filePath)

    const payload = {
      path: filePath,
      name: name,
      data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      metadata: metadata ?? undefined
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
