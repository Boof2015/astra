import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, clipboard, screen, safeStorage, powerMonitor, protocol, session, globalShortcut } from 'electron'
import { join, basename, extname } from 'path'
import { readFile, writeFile, mkdtemp, rm, access, mkdir, stat } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { tmpdir, hostname, networkInterfaces } from 'os'
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams, type ExecFileOptions } from 'child_process'
import { createHash, randomBytes, randomUUID } from 'crypto'
import * as mm from 'music-metadata'
import * as library from './services/library'
import type { DynamicPlaylistRulesV1 } from '../shared/playlists/dynamicPlaylist'
import type {
  ListeningSessionCheckpoint,
  ListeningStatsApplyRequest,
  ListeningStatsExportRequest,
  ListeningStatsQuery
} from '../types/listeningStats'
import { collectIamfStreamStats } from '../shared/iamf/obuWalker'
import { mp4HasIamfTrack, readMp4DurationSeconds } from '../shared/iamf/mp4'
import {
  deepScanFlacIntegrityTrack,
  isFlacTarget,
  isIntegrityScanCancelledError,
  quickScanIntegrityTrack,
  resolveIntegrityWorkerCount,
  runIntegrityWithConcurrency,
  scanIntegrityDuplicates,
  type IntegrityDuplicateSnapshotMember,
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
import { CompanionApiLibrary } from './services/companionApiLibrary'
import { CompanionApiReferenceSigner } from './services/companionApiRefs'
import { PhoneRemoteService } from './services/phoneRemote'
import { applyPhoneSyncChanges, buildPhoneSyncState, parsePhoneSyncApplyPayload } from './services/phoneSync'
import { PhoneRemoteDiscoveryService } from './services/phoneRemoteDiscovery'
import {
  createPhoneRemoteTlsIdentity,
  normalizePhoneRemoteFingerprint,
  validatePhoneRemoteTlsIdentity,
  type PhoneRemoteTlsIdentity
} from './services/phoneRemoteSecurity'
import { ParallaxService, type PersistedParallaxPairedSink } from './services/parallax'
import { ParallaxDiscoveryService } from './services/parallaxDiscovery'
import { ParallaxSinkListener } from './services/parallaxSinkListener'
import {
  createParallaxTlsIdentity,
  normalizeParallaxFingerprint,
  parallaxCertificateFingerprint,
  validateParallaxTlsIdentity,
  type ParallaxTlsIdentity
} from './services/parallaxSecurity'
import { LastFmService, sanitizePendingScrobbles } from './services/lastFm'
import { LyricsService } from './services/lyrics'
import { MemoryDiagnosticsService } from './services/memoryDiagnostics'
import { collectAppMemoryFootprint } from './services/appMemoryFootprint'
import { normalizeStatsShareFileName, validateStatsSharePng } from './services/statsShareImage'
import { normalizeSignalShareFileName, validateSignalSharePng } from './services/signalShareImage'
import { getMusicMetadataParseOptions } from './utils/musicMetadata'
import { extractReplayGainDb } from './utils/replayGain'
import {
  MINI_WINDOW_MAX_HEIGHT,
  MINI_WINDOW_MAX_WIDTH,
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
  type MiniPlayerQueueSnapshot,
  type MiniPlayerSnapshot,
  type MiniPlayerVisualizerStreamChunk,
  type MiniPlayerWindowPrefs,
  type MiniPlayerWindowState,
} from '../types/miniPlayer'
import type {
  CompanionApiLibraryEvent,
  CompanionApiRendererCommand
} from '../types/companionApi'
import companionApiOpenApiDocument from '../../docs/api/openapi-v2.json'
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
  PHONE_REMOTE_PROTOCOL_VERSION,
  type PhoneRemoteClientKind,
  type PhoneRemoteCredentialScope,
  type PhoneRemoteIdentity,
  type PhoneRemoteServiceConfig
} from '../types/phoneRemote'
import {
  PARALLAX_DEFAULT_PORT,
  PARALLAX_MAX_PORT,
  PARALLAX_MIN_PORT,
  PARALLAX_SINK_DEFAULT_PORT,
  decideParallaxSinkEnabledFromMeta,
  decideParallaxSecurityV2Migration,
  resolveParallaxPlaybackEnabled,
  type ParallaxAudioChunk,
  type ParallaxDiscoveryEvent,
  type ParallaxHostConfig,
  type ParallaxHostStreamStartOptions,
  type ParallaxHostNextStreamStartOptions,
  type ParallaxHostTimelinePublishOptions,
  type ParallaxOutputLatencyMetrics,
  ParallaxAuthError,
  type ParallaxSinkTelemetry,
  type ParallaxStreamInfo,
  type ParallaxTimelineState,
  type PersistedParallaxSinkConnection
} from '../types/parallax'
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
import {
  LRCLIB_OFFICIAL_BASE_URL,
  parseLrclibBaseUrl,
  type LyricsFormat,
  type LyricsTrackQuery
} from '../types/lyrics'
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
  IntegrityDuplicateGroup,
  IntegrityDuplicateTrashRequest,
  IntegrityDuplicateTrashResult,
  IntegrityFinding,
  IntegrityScanMode,
  IntegrityScanProgress,
  IntegrityScanResult,
  IntegrityScanScope,
  IntegrityScanSummary
} from '../types/libraryIntegrity'
import {
  resolveInterceptedKeyboardInput,
  resolveMouseAppCommand,
  sanitizeGlobalShortcutRegistrationRequests
} from './inputBindings'
import { GlobalInputShortcutService } from './services/globalInputShortcuts'
import type { InputActionId } from '../types/inputBindings'
import { checkSettingsTransferWrite } from './utils/settingsTransferWrite'
import { parseListeningImportFile } from '../shared/stats/listeningImportFile'

// Check if running in development
const isDev = process.env.NODE_ENV === 'development'
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')
}

const globalInputShortcutService = new GlobalInputShortcutService(globalShortcut)
const GLOBAL_ACTIONS_THAT_FOCUS_MAIN_WINDOW = new Set<InputActionId>([
  'quick-launch-open',
  'keybinds-open',
  'jump-to-now-playing',
  'focus-search-field',
  'navigate-back',
  'navigate-forward'
])

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
let latestMiniPlayerQueueSnapshot: MiniPlayerQueueSnapshot | null = null
let latestMiniVisualizerChunk: MiniPlayerVisualizerStreamChunk | null = null
let latestLyricsPopoutSnapshot: LyricsPopoutSnapshot | null = null
const latestScopePopoutChunks: Partial<Record<ScopeKind, ScopePopoutChunk>> = {}
let mainWindowPersistTimer: ReturnType<typeof setTimeout> | null = null
let miniWindowPersistTimer: ReturnType<typeof setTimeout> | null = null
let lyricsPopoutWindowPersistTimer: ReturnType<typeof setTimeout> | null = null
let fileCreatedAtBackfillTimer: ReturnType<typeof setTimeout> | null = null
let audioMetadataBackfillTimer: ReturnType<typeof setTimeout> | null = null
let artistCreditsBackfillTimer: ReturnType<typeof setTimeout> | null = null
let genreMetadataBackfillTimer: ReturnType<typeof setTimeout> | null = null
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
const MINI_WINDOW_TITLE = 'Astra Mini Player'
const MAIN_WINDOW_PERSIST_DEBOUNCE_MS = MINI_WINDOW_PERSIST_DEBOUNCE_MS
const FILE_CREATED_AT_BACKFILL_STARTUP_DELAY_MS = 13_000
const FILE_CREATED_AT_BACKFILL_MIGRATION_KEY = 'file_created_at_backfill_v1_done'
const AUDIO_METADATA_BACKFILL_STARTUP_DELAY_MS = 15_000
const AUDIO_METADATA_BACKFILL_MIGRATION_KEY = 'audio_metadata_backfill_v2_done'
const ARTIST_CREDITS_BACKFILL_STARTUP_DELAY_MS = 16_000
const ARTIST_CREDITS_BACKFILL_MIGRATION_KEY = 'artist_credits_backfill_v1_done'
const GENRE_METADATA_BACKFILL_STARTUP_DELAY_MS = 16_500
const GENRE_METADATA_BACKFILL_MIGRATION_KEY = 'genre_metadata_backfill_v1_done'
const REPLAYGAIN_BACKFILL_STARTUP_DELAY_MS = 17_000
const REPLAYGAIN_SCAN_ENABLED_META_KEY = 'replaygain_scan_enabled_v1'
const REPLAYGAIN_BACKFILL_MIGRATION_KEY = 'replaygain_backfill_v3_done'
const RUNTIME_ICON_DATA_URL_PREFIX = 'data:image/'
const MAX_RUNTIME_ICON_DATA_URL_LENGTH = 2_000_000
const MAX_RUNTIME_ICON_IMAGE_SET_DATA_URL_LENGTH = 3_500_000
const MAX_RUNTIME_ICON_IMAGE_SET_IMAGES = 10
const MIN_RUNTIME_ICON_IMAGE_SIZE = 16
const MAX_RUNTIME_ICON_IMAGE_SIZE = 2048
const LOCAL_API_ENABLED_META_KEY = 'local_api_enabled_v1'
const LOCAL_API_CONTROLS_ENABLED_META_KEY = 'local_api_controls_enabled_v1'
const LOCAL_API_LIBRARY_SEARCH_ENABLED_META_KEY = 'local_api_library_search_enabled_v2'
const LOCAL_API_LIBRARY_WRITE_ENABLED_META_KEY = 'local_api_library_write_enabled_v2'
const LOCAL_API_PORT_META_KEY = 'local_api_port_v1'
const LOCAL_API_TOKEN_META_KEY = 'local_api_token_v1'
const COMPANION_API_REFERENCE_SECRET_META_KEY = 'companion_api_reference_secret_v2'
const PHONE_REMOTE_ENABLED_META_KEY = 'local_api_remote_web_enabled_v1'
const PHONE_REMOTE_PORT_META_KEY = 'phone_remote_port_v1'
const PHONE_REMOTE_SYNC_ENABLED_META_KEY = 'phone_remote_sync_enabled_v1'
const PHONE_REMOTE_PAIRED_DEVICES_META_KEY = 'local_api_paired_devices_v1'
const PHONE_REMOTE_TLS_IDENTITY_META_KEY = 'phone_remote_tls_identity_v3'
const PHONE_REMOTE_TLS_FINGERPRINT_META_KEY = 'phone_remote_tls_fingerprint_v3'
const PHONE_REMOTE_SECURITY_VERSION_META_KEY = 'phone_remote_security_version'
const PHONE_REMOTE_SECURITY_MIGRATION_NOTICE_META_KEY = 'phone_remote_security_migration_notice_v3'
const PARALLAX_HOST_ENABLED_META_KEY = 'parallax_host_enabled_v1'
const PARALLAX_HOST_PORT_META_KEY = 'parallax_host_port_v1'
const PARALLAX_PAIRED_SINKS_META_KEY = 'parallax_paired_sinks_v1'
// §14.1.2 / §16.2. Sink-side durable credential. Single slot (one paired host); re-pairing
// replaces it. Schema-versioned suffix matches sibling keys.
const PARALLAX_SINK_CONNECTION_META_KEY = 'parallax_sink_connection_v1'
// §20 / §14.1.5. Persisted sink-role toggle. Independent from `parallax_host_enabled_v1`; off
// by default for new installs. Migration in `migrateParallaxSinkEnabledOnFirstRead`: if a
// persisted sink connection from §14.1.2 already exists (the user paired this device pre-§20),
// we flip this true on first read so auto-reconnect doesn't silently break for them.
const PARALLAX_SINK_ENABLED_META_KEY = 'parallax_sink_enabled_v1'
// §20.19(c). One role-neutral UUID per Astra install, generated at first launch in any role.
// Advertised over mDNS when sink-enabled; sent in pair-request when acting as host. Auth still
// uses host-issued `sinkId` — this is discovery memory only ("seen before / renamed / already
// paired"). Never a secret.
const PARALLAX_ENDPOINT_UUID_META_KEY = 'parallax_endpoint_uuid_v1'
const PARALLAX_TLS_IDENTITY_META_KEY = 'parallax_tls_identity_v2'
const PARALLAX_SECURITY_VERSION_META_KEY = 'parallax_security_version'
const PARALLAX_SECURITY_MIGRATION_NOTICE_META_KEY = 'parallax_security_migration_notice_v2'
const LASTFM_ENABLED_META_KEY = 'lastfm_enabled_v1'
const LASTFM_API_BASE_URL_META_KEY = 'lastfm_api_base_url_v1'
const LASTFM_SESSION_KEY_META_KEY = 'lastfm_session_key_v1'
const LASTFM_SESSION_USERNAME_META_KEY = 'lastfm_session_username_v1'
const LASTFM_PENDING_SCROBBLES_META_KEY = 'lastfm_pending_scrobbles_v1'
const LASTFM_ACTIVE_PROFILE_ID_META_KEY = 'lastfm_active_profile_id_v1'
const LASTFM_PROFILES_META_KEY = 'lastfm_profiles_v1'
const LYRICS_ONLINE_ENABLED_META_KEY = 'lyrics_online_enabled_v1'
const LYRICS_LRCLIB_BASE_URL_META_KEY = 'lyrics_lrclib_base_url_v1'
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
const LOCAL_STREAM_STARTUP_CHUNK_FRAMES = 8192
const LOCAL_STREAM_STEADY_CHUNK_FRAMES = 65_536
const LOCAL_STREAM_STEADY_AFTER_SECONDS = 1
const JELLYFIN_AUTH_CACHE_TTL_MS = 30 * 60 * 1000

// Artwork is served to renderers over a custom protocol instead of base64
// data URLs over IPC: bytes go through Chromium's network pipeline, images
// get short stable URL keys with real cache semantics, and the renderer
// needs no blob bookkeeping. Must be registered before app ready.
const ARTWORK_PROTOCOL_SCHEME = 'astra-artwork'
protocol.registerSchemesAsPrivileged([{
  scheme: ARTWORK_PROTOCOL_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    corsEnabled: true
  }
}])

let artworkThumbnailCacheDir = ''
interface ArtworkBytes {
  bytes: Buffer
  mimeType: string
}
const artworkThumbnailRequestCache = new Map<string, Promise<ArtworkBytes | null>>()
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

function getActiveMemoryFootprintChildProcessPids(): number[] {
  const pids: number[] = []
  const seen = new Set<number>()
  for (const session of remoteStreamSessions.values()) {
    if (session.done || session.cancelled) continue
    const pid = session.ffmpeg.pid
    if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0 || seen.has(pid)) continue
    seen.add(pid)
    pids.push(pid)
  }
  return pids
}

interface ProgressiveStreamStartOptions {
  startTimeSeconds?: number | null
}

let localApiConfig: LocalApiServiceConfig = {
  enabled: false,
  controlsEnabled: false,
  librarySearchEnabled: false,
  libraryWriteEnabled: false,
  port: LOCAL_API_DEFAULT_PORT,
  token: generateLocalApiToken(),
}
let phoneRemoteConfig: PhoneRemoteServiceConfig = {
  enabled: false,
  controlsEnabled: false,
  syncEnabled: true,
  port: PHONE_REMOTE_DEFAULT_PORT
}
let parallaxHostConfig: ParallaxHostConfig = {
  enabled: false,
  port: PARALLAX_DEFAULT_PORT
}
type PersistedPhoneRemotePairedDevice = {
  id: string
  name: string
  clientLabel: string
  tokenPrefix: string
  syncTokenPrefix: string | null
  clientKind: PhoneRemoteClientKind
  scopes: PhoneRemoteCredentialScope[]
  credentialIssuedAt: number
  credentialRotatedAt: number
  expiresAt: number
  controlTokenHash: string
  syncTokenHash: string | null
  previousControlTokenHash: string | null
  previousSyncTokenHash: string | null
  previousTokensValidUntil: number | null
  createdAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}
let phoneRemotePairedDevices: PersistedPhoneRemotePairedDevice[] = []
let parallaxPairedSinks: PersistedParallaxPairedSink[] = []
// §20 / §14.1.5. Sink-role enablement, gates mDNS advertisement, the sink HTTP listener, and
// auto-reconnect. Off by default for new installs; migrated to true on first read when a
// persisted sink connection from §14.1.2 already exists (so existing paired sinks survive the
// §20 cutover transparently — §20.19(d)).
let parallaxSinkEnabled = false
// §20.19(c). Role-neutral identity UUID per Astra install. Generated lazily at first read.
// Discovery memory only (never a secret) — auth identity is still the host-issued `sinkId`.
let parallaxEndpointUuid = ''
let phoneRemoteTlsIdentity: PhoneRemoteTlsIdentity | null = null
let parallaxTlsIdentity: ParallaxTlsIdentity | null = null
let parallaxSecurityMigrationRequired = false
// §20 Commit 2. mDNS wrapper. Owns one bonjour-service instance for both advertise + browse.
// Constructed eagerly (cheap, no sockets bound until start*); lifecycle hooks below honor the
// sinkEnabled toggle for advertise and renderer-driven browse on/off for the wizard.
const parallaxDiscoveryService = new ParallaxDiscoveryService()
const phoneRemoteDiscoveryService = new PhoneRemoteDiscoveryService()
// §20 Commit 3. Sink HTTP listener — only the pre-pair endpoints (sink-identity, pair-request,
// pair-confirm). Started/stopped in lockstep with `parallaxSinkEnabled`. PIN state lives on the
// listener itself; this top-level mirror just feeds the renderer via status push.
let parallaxIncomingPairRequest: import('../types/parallax').ParallaxIncomingPairRequest | null = null
const parallaxSinkListener = new ParallaxSinkListener({
  getEndpointUuid: () => parallaxEndpointUuid,
  getSinkName: () => hostname() || 'Astra Sink',
  getHasPersistedConnection: () => parallaxSinkConnection !== null,
  onPaired: async (info) => {
    // Persist through the existing §14.1.2 path so the sink-side credential lands in the same
    // schema auto-reconnect already consumes. The cleared/persisted sequence mirrors what
    // `parallax:setSinkConnection` IPC does for the legacy "Connect This Astra as Sink" flow.
    await clearParallaxSinkConnection().catch((error) => {
      console.warn('Failed to clear stale Parallax sink connection during pair-commit:', error)
    })
    const persisted = {
      protocolVersion: info.protocolVersion,
      baseUrl: info.hostUrl,
      sinkId: info.sinkId,
      token: info.token,
      hostCertificatePem: info.hostCertificatePem,
      hostCertificateFingerprint: info.hostCertificateFingerprint,
      hostName: info.hostName,
      pairedAt: info.pairedAt,
      lastConnectedAt: null,
      hostParallaxEndpointUuid: info.hostParallaxEndpointUuid ?? undefined
    }
    const sanitized = sanitizeParallaxSinkConnection(persisted)
    if (sanitized) {
      await persistParallaxSinkConnection(sanitized)
      await clearParallaxSecurityMigrationNotice()
      broadcastParallaxStatus()
      // Pair-confirm happens in the sink HTTP listener, but the actual sink connection must be
      // renderer-driven so the Standard-output gate, subscriptions, and audioEngine.stop() prep
      // from reconnectFromPersisted() still run. This event is the "new durable credential is
      // ready" edge that lets the renderer connect immediately without requiring an app restart.
      //
      // The host promotes its pending candidate only after it receives this pair-confirm
      // response. Defer the reconnect edge briefly so the sink doesn't race the host activation
      // and turn a successful pair into an immediate 401/revocation.
      setTimeout(() => {
        sendToWindow(mainWindow, 'parallax:sinkPaired')
      }, 500)
    }
  },
  onIncomingPairChange: (state) => {
    parallaxIncomingPairRequest = state
    broadcastParallaxStatus()
  }
})
parallaxSinkListener.on('error', (error) => {
  console.warn('Parallax sink listener error:', error)
})
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
let lyricsLrclibBaseUrl = LRCLIB_OFFICIAL_BASE_URL
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

let companionApiReferenceSigner = new CompanionApiReferenceSigner(randomBytes(32))

function sendCompanionApiRendererCommand(command: CompanionApiRendererCommand): boolean {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) return false
  if (command.type === 'open-target') {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  mainWindow.webContents.send('companion-api:command', command)
  return true
}

function publishCompanionApiLibraryEvent(event: CompanionApiLibraryEvent): void {
  localApiService.publishLibraryEvent(event)
  phoneRemoteService.publishLibraryEvent(event)
}

function publishCompanionFavoriteEvent(trackPath: string, favorite: boolean): void {
  const track = library.getTrackByPath(trackPath)
  publishCompanionApiLibraryEvent({
    kind: 'favorite',
    change: 'favorite-set',
    ref: track ? companionApiReferenceSigner.create('track', track.id) : null,
    favorite,
    updatedAt: Date.now()
  })
}

function publishCompanionPlaylistEvent(
  playlistId: number,
  change: Extract<CompanionApiLibraryEvent['change'], 'created' | 'renamed' | 'items-changed' | 'deleted'>
): void {
  publishCompanionApiLibraryEvent({
    kind: 'playlist',
    change,
    ref: companionApiReferenceSigner.create('playlist', playlistId),
    updatedAt: Date.now()
  })
}

const companionApiLibrary = new CompanionApiLibrary({
  getSigner: () => companionApiReferenceSigner,
  resolveArtworkByHash: async (artworkHash) => getArtworkThumbnailDataUrlByHash(artworkHash, {
    maxEdgePx: REMOTE_CONTROLLER_ARTWORK_MAX_EDGE_PX,
    jpegQuality: REMOTE_CONTROLLER_ARTWORK_JPEG_QUALITY,
    allowOriginalFallback: false
  }),
  onLibraryEvent: publishCompanionApiLibraryEvent,
  onRendererLibraryMutation: () => {
    mainWindow?.webContents.send('library:externalLibraryMutation')
  }
})

const companionApiOptions = {
  getPlayback: () => companionApiLibrary.getPlayback(latestMiniPlayerSnapshot),
  getQueue: () => companionApiLibrary.getQueue(latestMiniPlayerQueueSnapshot),
  search: (
    query: string,
    types: ReadonlySet<import('../types/companionApi').CompanionApiTargetType>,
    limit: number
  ) => companionApiLibrary.search(query, types, limit),
  resolveTarget: (ref: string, expectedType?: import('../types/companionApi').CompanionApiTargetType) => (
    companionApiLibrary.resolveTarget(ref, expectedType)
  ),
  dispatchRendererCommand: sendCompanionApiRendererCommand,
  resolveArtworkDataUrl: (ref: string) => companionApiLibrary.resolveArtworkDataUrl(ref),
  setFavorite: (trackRef: string, favorite: boolean) => companionApiLibrary.setFavorite(trackRef, favorite),
  createPlaylist: (name: string) => companionApiLibrary.createPlaylist(name),
  renamePlaylist: (playlistRef: string, name: string) => companionApiLibrary.renamePlaylist(playlistRef, name),
  addPlaylistItems: (playlistRef: string, trackRefs: string[]) => companionApiLibrary.addPlaylistItems(playlistRef, trackRefs),
  removePlaylistItem: (playlistRef: string, trackRef: string) => companionApiLibrary.removePlaylistItem(playlistRef, trackRef),
  movePlaylistItem: (playlistRef: string, trackRef: string, position: number) => (
    companionApiLibrary.movePlaylistItem(playlistRef, trackRef, position)
  ),
  getOpenApiDocument: () => companionApiOpenApiDocument
}

const localApiService = new LocalApiService({
  config: localApiConfig,
  getSnapshot: () => latestMiniPlayerSnapshot,
  dispatchCommand: sendMiniPlayerCommand,
  companionApi: companionApiOptions,
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
  companionApi: companionApiOptions,
  getIdentity: () => getPhoneRemoteIdentity(),
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
  getSyncState: () => buildPhoneSyncState(),
  applySyncChanges: (rawPayload) => {
    const payload = parsePhoneSyncApplyPayload(rawPayload)
    if (!payload) return null
    library.beginLibraryWriteTransaction()
    let result
    try {
      result = applyPhoneSyncChanges(payload)
      library.commitLibraryWriteTransaction()
    } catch (error) {
      library.rollbackLibraryWriteTransaction()
      throw error
    }
    // The sync applied in the main process; the renderer stores are now stale.
    mainWindow?.webContents.send('library:externalLibraryMutation')
    if (result.favorites.added > 0 || result.favorites.removed > 0) {
      publishCompanionApiLibraryEvent({
        kind: 'favorite',
        change: 'favorite-set',
        ref: null,
        updatedAt: Date.now()
      })
    }
    if (result.playlists.length > 0) {
      publishCompanionApiLibraryEvent({
        kind: 'playlist',
        change: 'items-changed',
        ref: null,
        updatedAt: Date.now()
      })
    }
    return result
  },
  onStatusChange: () => {
    broadcastPhoneRemoteStatus()
    const status = phoneRemoteService.getStatus()
    refreshPhoneRemoteDiscoveryAdvertisement(status)
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

const parallaxService = new ParallaxService({
  config: parallaxHostConfig,
  pairedSinks: parallaxPairedSinks,
  softwareVersion: app.getVersion(),
  onDiagnostic: (diagnostic) => {
    console.warn(`Parallax join validation failed: ${JSON.stringify(diagnostic)}`)
  },
  // Phase-3 sink transport lane — play/pause/skip from a Parallax node's web page / touch
  // screen / TV remote rides the same dispatch as the mini player and phone remote.
  dispatchCommand: sendMiniPlayerCommand,
  onPairedSinksChange: (sinks) => {
    parallaxPairedSinks = sinks.map((sink) => ({ ...sink }))
    void persistParallaxPairedSinks(parallaxPairedSinks).catch((error) => {
      console.warn('Failed to persist Parallax paired sinks:', error)
    })
    if (sinks.some((sink) => sink.revokedAt === null)) {
      void clearParallaxSecurityMigrationNotice()
    }
  },
  onStatusChange: () => {
    broadcastParallaxStatus()
    const status = parallaxService.getStatus()
    logMemoryDiagnosticsMainEvent('parallax_status_changed', {
      role: status.role,
      hostEnabled: status.host.enabled,
      hostActive: status.host.active,
      hostPort: status.host.port,
      connectedSinkCount: status.host.connectedSinkCount,
      activePlaybackSinkCount: status.host.activePlaybackSinkCount,
      sinkConnected: status.sink.connected,
      activeStreamId: status.host.activeStream?.streamId ?? status.sink.activeStream?.streamId ?? null,
      hostLastError: status.host.lastError,
      sinkLastError: status.sink.lastError
    })
  },
  onSinkEvent: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('parallax:event', event)
    }
  },
  onSinkAudioChunk: (chunk) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('parallax:audioChunk', chunk)
    }
  },
  // §14.1.2 / §16.7 follow-up (Codex round 1, finding 1). R-clear sink: host explicitly
  // revoked our credential (initial-connect 401, in-session SSE/audio 401, scheduled-reconnect
  // 401). Wipe the persisted credential + stop any in-flight auto-reconnect attempts. The
  // service has already disconnected and set sinkRemovedByHost=true before this fires, so the
  // status push reaches the renderer after the persisted credential cache has been cleared.
  onSinkAuthRevoked: () => {
    cancelParallaxAutoReconnect()
    void clearParallaxSinkConnection()
      .then(() => {
        broadcastParallaxStatus()
      })
      .catch((error) => {
        console.warn('Failed to clear Parallax sink connection after auth-revoked:', error)
      })
  },
  // Pillar 3 — host relocation. The in-session reconnect path calls this once the persisted host
  // address has failed repeatedly. Resolve the host's current address via mDNS (by its remembered
  // endpoint UUID), persist the new baseUrl, and hand it back so the service retargets there.
  onSinkRelocate: () => relocateParallaxHost(),
  // §14.1.2 follow-up (Codex round 1, finding 3). Service reads on every getStatus() so the
  // status payload mirrors the live app-meta state without the service holding its own copy.
  // Token is intentionally never returned — only the boolean and host name reach the renderer.
  getSinkConnectionInfo: () => ({
    hasPersistedConnection: parallaxSinkConnection !== null,
    persistedHostName: parallaxSinkConnection?.hostName ?? parallaxSinkConnection?.baseUrl ?? null
  }),
  // §14.1.4 / §19.18(e) — same resolver used by playbackHttpCore + phoneRemote.
  resolveArtworkDataUrl: async (artworkHash) => getArtworkThumbnailDataUrlByHash(artworkHash, {
    maxEdgePx: CARD_ARTWORK_MAX_EDGE_PX
  }),
  // §20 Commit 1. Read each status call so the service stays ignorant of meta-key storage.
  getSinkEnabled: () => parallaxSinkEnabled,
  getEndpointUuid: () => parallaxEndpointUuid,
  // §20 Commit 3. Sink's PIN card shows "<this> wants to pair" — fall back to the OS hostname
  // (same source the §14.1.4 identity card uses) when no better label exists.
  getHostDisplayName: () => hostname() || 'Astra Host',
  // §20 Commit 3 sink side. Reads the listener's live pending-pair so it lands in
  // ParallaxStatus.sink.incomingPairRequest on every status push.
  getIncomingPairRequest: () => parallaxIncomingPairRequest,
  getSecurityMigrationRequired: () => parallaxSecurityMigrationRequired
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
  lrclibBaseUrl: lyricsLrclibBaseUrl,
  onStatusChange: () => {
    broadcastLyricsStatus()
    const status = lyricsService.getStatus()
    logMemoryDiagnosticsMainEvent('lyrics_status_changed', {
      enabled: status.enabled,
      provider: status.provider,
      lrclibBaseUrl: status.lrclibBaseUrl,
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
const AUDIO_EXTENSIONS = ['mp3', 'flac', 'wav', 'ogg', 'aac', 'm4a', 'opus', 'wma', 'aiff', 'alac', 'ape', 'wv', 'iamf', 'mp4']
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

function normalizeParallaxPort(rawPort: unknown): number {
  const parsed = typeof rawPort === 'number' ? rawPort : Number(rawPort)
  if (!Number.isInteger(parsed)) {
    throw new Error(`Port must be an integer between ${PARALLAX_MIN_PORT} and ${PARALLAX_MAX_PORT}.`)
  }
  if (parsed < PARALLAX_MIN_PORT || parsed > PARALLAX_MAX_PORT) {
    throw new Error(`Port must be between ${PARALLAX_MIN_PORT} and ${PARALLAX_MAX_PORT}.`)
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
    const tokenPrefix = typeof value.tokenPrefix === 'string' ? value.tokenPrefix.trim() : ''
    const syncTokenPrefix = typeof value.syncTokenPrefix === 'string' ? value.syncTokenPrefix.trim() : null
    const clientKind = value.clientKind === 'native' || value.clientKind === 'web' ? value.clientKind : null
    const scopes = Array.isArray(value.scopes)
      ? value.scopes.filter((scope): scope is PhoneRemoteCredentialScope => (
          scope === 'control'
          || scope === 'sync'
          || scope === 'observe'
          || scope === 'playback-control'
          || scope === 'library-search'
          || scope === 'library-write'
        ))
      : []
    const controlTokenHash = typeof value.controlTokenHash === 'string' ? value.controlTokenHash.trim() : ''
    const syncTokenHash = typeof value.syncTokenHash === 'string' ? value.syncTokenHash.trim() : null
    const previousControlTokenHash = typeof value.previousControlTokenHash === 'string'
      ? value.previousControlTokenHash.trim()
      : null
    const previousSyncTokenHash = typeof value.previousSyncTokenHash === 'string'
      ? value.previousSyncTokenHash.trim()
      : null
    const credentialIssuedAt = typeof value.credentialIssuedAt === 'number' && Number.isFinite(value.credentialIssuedAt)
      ? Math.max(0, value.credentialIssuedAt)
      : 0
    const credentialRotatedAt = typeof value.credentialRotatedAt === 'number' && Number.isFinite(value.credentialRotatedAt)
      ? Math.max(0, value.credentialRotatedAt)
      : 0
    const expiresAt = typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
      ? Math.max(0, value.expiresAt)
      : 0
    const previousTokensValidUntil = typeof value.previousTokensValidUntil === 'number' && Number.isFinite(value.previousTokensValidUntil)
      ? Math.max(0, value.previousTokensValidUntil)
      : null
    const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
      ? Math.max(0, value.createdAt)
      : 0
    const lastSeenAt = typeof value.lastSeenAt === 'number' && Number.isFinite(value.lastSeenAt)
      ? Math.max(0, value.lastSeenAt)
      : null
    const revokedAt = typeof value.revokedAt === 'number' && Number.isFinite(value.revokedAt)
      ? Math.max(0, value.revokedAt)
      : null
    const expectedScopes: PhoneRemoteCredentialScope[] = clientKind === 'native'
      ? ['control', 'sync']
      : ['control']
    const normalizedScopes = new Set<PhoneRemoteCredentialScope>(scopes)
    const hasExplicitCompanionScopes = scopes.some((scope) => (
      scope === 'observe'
      || scope === 'playback-control'
      || scope === 'library-search'
      || scope === 'library-write'
    ))
    normalizedScopes.add('control')
    // Only pre-v2 rows need the legacy control-to-companion migration. Newer
    // rows already contain the exact subset approved for that credential.
    normalizedScopes.add('observe')
    if (!hasExplicitCompanionScopes) normalizedScopes.add('playback-control')
    if (clientKind === 'native') normalizedScopes.add('sync')
    else normalizedScopes.delete('sync')
    if (
      !id || !name || !clientLabel || !clientKind || !controlTokenHash || !tokenPrefix || createdAt <= 0 ||
      credentialIssuedAt <= 0 || credentialRotatedAt <= 0 || expiresAt <= 0 ||
      expectedScopes.some((scope) => !scopes.includes(scope)) ||
      (clientKind === 'native' && (!syncTokenHash || !syncTokenPrefix)) ||
      (clientKind === 'web' && (syncTokenHash || syncTokenPrefix || scopes.includes('sync')))
    ) {
      continue
    }

    sanitized.push({
      id,
      name: name.slice(0, 80),
      clientLabel: clientLabel.slice(0, 80),
      tokenPrefix: tokenPrefix.slice(0, 16),
      syncTokenPrefix: syncTokenPrefix?.slice(0, 16) ?? null,
      clientKind,
      scopes: Array.from(normalizedScopes),
      credentialIssuedAt,
      credentialRotatedAt,
      expiresAt,
      controlTokenHash,
      syncTokenHash,
      previousControlTokenHash,
      previousSyncTokenHash,
      previousTokensValidUntil,
      createdAt,
      lastSeenAt,
      revokedAt
    })
  }

  return sanitized
}

// §14.1.1. Per-trim sanitizer with the same ±500 ms clamp the service applies on the live path
// (defense in depth — a hand-edited meta file shouldn't be able to push a 30s offset). Drops
// entries with non-string device id or non-finite advanceMs; unknown `source` collapses to
// 'manual' so a future calibration source string doesn't kill the row.
function sanitizeParallaxSinkTrim(candidate: unknown): import('../types/parallax').ParallaxSinkTrim | null {
  if (!candidate || typeof candidate !== 'object') return null
  const value = candidate as Record<string, unknown>
  const outputDeviceId = typeof value.outputDeviceId === 'string' ? value.outputDeviceId.trim() : ''
  if (!outputDeviceId) return null
  const rawAdvance = Number(value.advanceMs)
  if (!Number.isFinite(rawAdvance)) return null
  const advanceMs = Math.max(-500, Math.min(500, rawAdvance))
  const outputDeviceLabel = typeof value.outputDeviceLabel === 'string'
    ? value.outputDeviceLabel.slice(0, 200)
    : null
  const updatedAtMs = typeof value.updatedAtMs === 'number' && Number.isFinite(value.updatedAtMs)
    ? Math.max(0, value.updatedAtMs)
    : 0
  const source = value.source === 'calibration' ? 'calibration' : 'manual'
  return { outputDeviceId, outputDeviceLabel, advanceMs, updatedAtMs, source }
}

function sanitizeParallaxPairedSinks(rawSinks: unknown): PersistedParallaxPairedSink[] {
  if (!Array.isArray(rawSinks)) return []
  const sanitized: PersistedParallaxPairedSink[] = []

  for (const candidate of rawSinks) {
    if (!candidate || typeof candidate !== 'object') continue
    const value = candidate as Record<string, unknown>
    const id = typeof value.id === 'string' ? value.id.trim() : ''
    const name = typeof value.name === 'string' ? value.name.trim() : ''
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
    // Active-by-default migration for pairings written before zone selection existed.
    const playbackEnabled = resolveParallaxPlaybackEnabled(value.playbackEnabled)

    if (!id || !name || !tokenHash || !tokenPrefix || createdAt <= 0) {
      continue
    }

    // §14.1.1. Round-trip trims through the per-trim sanitizer. Dedupe by `outputDeviceId`
    // keeping the last (most-recent) entry, since the live service does upsert-by-deviceId; if
    // duplicates ever slipped into the meta file we want the same semantic on read.
    const rawTrims = Array.isArray(value.trims) ? value.trims : []
    const sanitizedTrims: import('../types/parallax').ParallaxSinkTrim[] = []
    const seenDevices = new Map<string, number>()
    for (const rawTrim of rawTrims) {
      const trim = sanitizeParallaxSinkTrim(rawTrim)
      if (!trim) continue
      const existingIdx = seenDevices.get(trim.outputDeviceId)
      if (existingIdx !== undefined) {
        sanitizedTrims[existingIdx] = trim
      } else {
        seenDevices.set(trim.outputDeviceId, sanitizedTrims.push(trim) - 1)
      }
    }

    // §20.19(g). Round-trip the remote endpoint UUID so it survives disk reads. Pre-§20 rows
    // simply leave it undefined; the wizard renders the "Already paired" badge only when the
    // discovered TXT carries a UUID that matches a paired row.
    const remoteParallaxEndpointUuid = typeof value.remoteParallaxEndpointUuid === 'string' && value.remoteParallaxEndpointUuid.trim()
      ? (value.remoteParallaxEndpointUuid as string).trim()
      : undefined
    sanitized.push({
      id,
      name: name.slice(0, 80),
      tokenHash,
      tokenPrefix: tokenPrefix.slice(0, 16),
      createdAt,
      lastSeenAt,
      revokedAt,
      playbackEnabled,
      trims: sanitizedTrims,
      ...(remoteParallaxEndpointUuid ? { remoteParallaxEndpointUuid } : {})
    })
  }

  return sanitized
}

async function persistLocalApiConfig(config: LocalApiServiceConfig): Promise<void> {
  await library.setAppMeta(LOCAL_API_ENABLED_META_KEY, config.enabled ? '1' : '0')
  await library.setAppMeta(LOCAL_API_CONTROLS_ENABLED_META_KEY, config.controlsEnabled ? '1' : '0')
  await library.setAppMeta(LOCAL_API_LIBRARY_SEARCH_ENABLED_META_KEY, config.librarySearchEnabled ? '1' : '0')
  await library.setAppMeta(LOCAL_API_LIBRARY_WRITE_ENABLED_META_KEY, config.libraryWriteEnabled ? '1' : '0')
  await library.setAppMeta(LOCAL_API_PORT_META_KEY, String(config.port))
  await library.setAppMeta(LOCAL_API_TOKEN_META_KEY, config.token)
}

async function persistPhoneRemoteConfig(config: PhoneRemoteServiceConfig): Promise<void> {
  await library.setAppMeta(PHONE_REMOTE_ENABLED_META_KEY, config.enabled ? '1' : '0')
  await library.setAppMeta(PHONE_REMOTE_SYNC_ENABLED_META_KEY, config.syncEnabled ? '1' : '0')
  await library.setAppMeta(PHONE_REMOTE_PORT_META_KEY, String(config.port))
}

async function persistParallaxHostConfig(config: ParallaxHostConfig): Promise<void> {
  await library.setAppMeta(PARALLAX_HOST_ENABLED_META_KEY, config.enabled ? '1' : '0')
  await library.setAppMeta(PARALLAX_HOST_PORT_META_KEY, String(config.port))
}

// §20.19(d). Load `parallaxSinkEnabled`. Decision logic lives in
// `decideParallaxSinkEnabledFromMeta` (pure, in `types/parallax.ts` — tested without sqlite);
// this wrapper just does the IO: read meta, ask the helper, persist on first-read migration.
//
// Codex round 1 finding (low): pass the already-sanitized `parallaxSinkConnection` so corrupt
// JSON that sanitizes to null can't false-migrate sinkEnabled to true.
async function loadParallaxSinkEnabledFromMeta(): Promise<boolean> {
  const raw = library.getAppMeta(PARALLAX_SINK_ENABLED_META_KEY)
  const decision = decideParallaxSinkEnabledFromMeta(raw, parallaxSinkConnection !== null)
  if (decision.needsPersist) {
    try {
      await library.setAppMeta(PARALLAX_SINK_ENABLED_META_KEY, decision.enabled ? '1' : '0')
    } catch (error) {
      console.warn('Failed to persist initial Parallax sink-enabled flag:', error)
    }
  }
  return decision.enabled
}

async function persistParallaxSinkEnabled(enabled: boolean): Promise<void> {
  await library.setAppMeta(PARALLAX_SINK_ENABLED_META_KEY, enabled ? '1' : '0')
}

interface ProtectedLocalSecret {
  protection: 'safe-storage' | 'plaintext-fallback'
  value: string
}

function canUseSecureLocalStorage(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform !== 'linux') return true
  return safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

function protectLocalSecret(value: string): ProtectedLocalSecret {
  if (canUseSecureLocalStorage()) {
    return {
      protection: 'safe-storage',
      value: safeStorage.encryptString(value).toString('base64')
    }
  }
  console.warn('Secure OS storage is unavailable; using an explicit plaintext local credential fallback.')
  return { protection: 'plaintext-fallback', value }
}

function unprotectLocalSecret(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.protection === 'plaintext-fallback' && typeof record.value === 'string') {
    return record.value
  }
  if (record.protection === 'safe-storage' && typeof record.value === 'string') {
    try {
      return safeStorage.decryptString(Buffer.from(record.value, 'base64'))
    } catch {
      return null
    }
  }
  return null
}

async function loadOrCreateParallaxTlsIdentity(): Promise<ParallaxTlsIdentity> {
  const raw = library.getAppMeta(PARALLAX_TLS_IDENTITY_META_KEY)
  let invalidExistingIdentity = false
  if (raw) {
    try {
      const stored = JSON.parse(raw) as Record<string, unknown>
      const privateKeyPem = unprotectLocalSecret(stored.privateKey)
      const candidate = privateKeyPem && typeof stored.certificatePem === 'string' && typeof stored.fingerprint256 === 'string'
        ? validateParallaxTlsIdentity({
          certificatePem: stored.certificatePem,
          privateKeyPem,
          fingerprint256: stored.fingerprint256
        })
        : null
      if (candidate) return candidate
    } catch {
      // Regenerate below.
    }
    invalidExistingIdentity = true
  }

  const identity = await createParallaxTlsIdentity(hostname() || 'Astra Parallax')
  await library.setAppMeta(PARALLAX_TLS_IDENTITY_META_KEY, JSON.stringify({
    version: 2,
    certificatePem: identity.certificatePem,
    fingerprint256: identity.fingerprint256,
    privateKey: protectLocalSecret(identity.privateKeyPem)
  }))
  if (invalidExistingIdentity) {
    parallaxSecurityMigrationRequired = true
    await library.setAppMeta(PARALLAX_PAIRED_SINKS_META_KEY, '[]')
    await library.setAppMeta(PARALLAX_SINK_CONNECTION_META_KEY, '')
    await library.setAppMeta(PARALLAX_SECURITY_MIGRATION_NOTICE_META_KEY, '1')
  }
  return identity
}

async function loadOrCreatePhoneRemoteTlsIdentity(): Promise<PhoneRemoteTlsIdentity> {
  const raw = library.getAppMeta(PHONE_REMOTE_TLS_IDENTITY_META_KEY)
  const expectedFingerprint = normalizePhoneRemoteFingerprint(
    library.getAppMeta(PHONE_REMOTE_TLS_FINGERPRINT_META_KEY) ?? ''
  )
  const rawPairings = library.getAppMeta(PHONE_REMOTE_PAIRED_DEVICES_META_KEY)
  let hasPersistedPairings = false
  try {
    const parsed = rawPairings ? JSON.parse(rawPairings) : []
    hasPersistedPairings = Array.isArray(parsed) && parsed.length > 0
  } catch {
    hasPersistedPairings = Boolean(rawPairings)
  }
  let invalidExistingIdentity = !raw && hasPersistedPairings
  if (raw) {
    try {
      const stored = JSON.parse(raw) as Record<string, unknown>
      const privateKeyPem = unprotectLocalSecret(stored.privateKey)
      const candidate = privateKeyPem && typeof stored.certificatePem === 'string' && typeof stored.fingerprint256 === 'string'
        ? validatePhoneRemoteTlsIdentity({
          certificatePem: stored.certificatePem,
          privateKeyPem,
          fingerprint256: stored.fingerprint256
        })
        : null
      if (candidate) {
        if (expectedFingerprint && expectedFingerprint !== normalizePhoneRemoteFingerprint(candidate.fingerprint256)) {
          invalidExistingIdentity = true
        } else {
          await library.setAppMeta(PHONE_REMOTE_TLS_FINGERPRINT_META_KEY, candidate.fingerprint256)
          return candidate
        }
      }
    } catch {
      // Regenerate below and invalidate pairings. A replacement certificate is never trusted silently.
    }
    invalidExistingIdentity = true
  }

  const identity = await createPhoneRemoteTlsIdentity(hostname() || 'Astra Phone Remote')
  await library.setAppMeta(PHONE_REMOTE_TLS_IDENTITY_META_KEY, JSON.stringify({
    version: 3,
    certificatePem: identity.certificatePem,
    fingerprint256: identity.fingerprint256,
    privateKey: protectLocalSecret(identity.privateKeyPem)
  }))
  await library.setAppMeta(PHONE_REMOTE_TLS_FINGERPRINT_META_KEY, identity.fingerprint256)
  if (invalidExistingIdentity) {
    phoneRemotePairedDevices = []
    await library.setAppMeta(PHONE_REMOTE_PAIRED_DEVICES_META_KEY, '[]')
    await library.setAppMeta(PHONE_REMOTE_SECURITY_MIGRATION_NOTICE_META_KEY, '1')
  }
  return identity
}

async function migratePhoneRemoteSecurityV3(): Promise<void> {
  const version = library.getAppMeta(PHONE_REMOTE_SECURITY_VERSION_META_KEY)
  if (version === '3') return
  const rawDevices = library.getAppMeta(PHONE_REMOTE_PAIRED_DEVICES_META_KEY)
  let hadLegacyPairing = false
  if (rawDevices) {
    try {
      const parsed = JSON.parse(rawDevices)
      hadLegacyPairing = Array.isArray(parsed) && parsed.length > 0
    } catch {
      hadLegacyPairing = true
    }
  }
  phoneRemotePairedDevices = []
  await library.setAppMeta(PHONE_REMOTE_PAIRED_DEVICES_META_KEY, '[]')
  await library.setAppMeta(PHONE_REMOTE_SECURITY_VERSION_META_KEY, '3')
  await library.setAppMeta(PHONE_REMOTE_SECURITY_MIGRATION_NOTICE_META_KEY, hadLegacyPairing ? '1' : '0')
}

async function migrateParallaxSecurityV2(): Promise<void> {
  const currentVersion = library.getAppMeta(PARALLAX_SECURITY_VERSION_META_KEY)
  const rawPairedSinks = library.getAppMeta(PARALLAX_PAIRED_SINKS_META_KEY)
  const rawSinkConnection = library.getAppMeta(PARALLAX_SINK_CONNECTION_META_KEY)
  const decision = decideParallaxSecurityV2Migration(currentVersion, rawPairedSinks, rawSinkConnection)
  if (!decision.needsMigration) {
    parallaxSecurityMigrationRequired = library.getAppMeta(PARALLAX_SECURITY_MIGRATION_NOTICE_META_KEY) === '1'
    return
  }
  parallaxSecurityMigrationRequired = decision.showRepairNotice
  await library.setAppMeta(PARALLAX_PAIRED_SINKS_META_KEY, '[]')
  await library.setAppMeta(PARALLAX_SINK_CONNECTION_META_KEY, '')
  await library.setAppMeta(PARALLAX_SECURITY_VERSION_META_KEY, '2')
  await library.setAppMeta(
    PARALLAX_SECURITY_MIGRATION_NOTICE_META_KEY,
    parallaxSecurityMigrationRequired ? '1' : '0'
  )
}

async function clearParallaxSecurityMigrationNotice(): Promise<void> {
  if (!parallaxSecurityMigrationRequired) return
  parallaxSecurityMigrationRequired = false
  await library.setAppMeta(PARALLAX_SECURITY_MIGRATION_NOTICE_META_KEY, '0')
  broadcastParallaxStatus()
}

// §20.19(c). Lazy load — generate and persist on first read. Validated as a v4-ish UUID; if a
// persisted value is malformed (manual edit, schema mismatch), regenerate.
async function loadParallaxEndpointUuidFromMeta(): Promise<string> {
  const PARALLAX_ENDPOINT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const raw = library.getAppMeta(PARALLAX_ENDPOINT_UUID_META_KEY)
  if (raw && PARALLAX_ENDPOINT_UUID_PATTERN.test(raw)) {
    return raw
  }
  const fresh = randomUUID()
  try {
    await library.setAppMeta(PARALLAX_ENDPOINT_UUID_META_KEY, fresh)
  } catch (error) {
    console.warn('Failed to persist Parallax endpoint UUID:', error)
  }
  return fresh
}

async function persistPhoneRemotePairedDevices(devices: PersistedPhoneRemotePairedDevice[]): Promise<void> {
  phoneRemotePairedDevices = devices.map((device) => ({ ...device }))
  await library.setAppMeta(PHONE_REMOTE_PAIRED_DEVICES_META_KEY, JSON.stringify(phoneRemotePairedDevices))
}

async function persistParallaxPairedSinks(sinks: PersistedParallaxPairedSink[]): Promise<void> {
  parallaxPairedSinks = sinks.map((sink) => ({ ...sink }))
  await library.setAppMeta(PARALLAX_PAIRED_SINKS_META_KEY, JSON.stringify(parallaxPairedSinks))
}

// §14.1.2 / §16. Sink-side durable credential. In-memory cache mirrors the persisted value so
// host-vs-sink precedence checks on boot (and any sync renderer reads) don't go through SQL on
// the hot path. Always written via `persistParallaxSinkConnection` / cleared via
// `clearParallaxSinkConnection` — never mutated directly.
let parallaxSinkConnection: PersistedParallaxSinkConnection | null = null

function sanitizeParallaxSinkConnection(raw: unknown): PersistedParallaxSinkConnection | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.protocolVersion !== 2) return null
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : ''
  const sinkId = typeof value.sinkId === 'string' ? value.sinkId.trim() : ''
  const token = typeof value.token === 'string' ? value.token.trim() : ''
  const hostCertificatePem = typeof value.hostCertificatePem === 'string' ? value.hostCertificatePem.trim() : ''
  const hostCertificateFingerprint = typeof value.hostCertificateFingerprint === 'string'
    ? normalizeParallaxFingerprint(value.hostCertificateFingerprint)
    : ''
  if (!baseUrl || !sinkId || !token || !hostCertificatePem || !hostCertificateFingerprint) return null
  try {
    if (new URL(baseUrl).protocol !== 'https:') return null
    if (parallaxCertificateFingerprint(hostCertificatePem) !== hostCertificateFingerprint) return null
  } catch {
    return null
  }
  const hostName = typeof value.hostName === 'string' ? value.hostName.slice(0, 80) : null
  const pairedAt = typeof value.pairedAt === 'number' && Number.isFinite(value.pairedAt)
    ? Math.max(0, value.pairedAt)
    : 0
  const lastConnectedAt = typeof value.lastConnectedAt === 'number' && Number.isFinite(value.lastConnectedAt)
    ? Math.max(0, value.lastConnectedAt)
    : null
  // §20.19(g). Round-trip the host's endpoint UUID (committed at pair time) so the sink
  // remembers "I was paired with this host before" symmetric to the sink-UUID-on-host pattern.
  // Pre-§20 connections leave it undefined.
  const hostParallaxEndpointUuid = typeof value.hostParallaxEndpointUuid === 'string' && value.hostParallaxEndpointUuid.trim()
    ? value.hostParallaxEndpointUuid.trim()
    : undefined
  return {
    protocolVersion: 2,
    baseUrl,
    sinkId,
    token,
    hostCertificatePem,
    hostCertificateFingerprint,
    hostName,
    pairedAt,
    lastConnectedAt,
    ...(hostParallaxEndpointUuid ? { hostParallaxEndpointUuid } : {})
  }
}

function loadParallaxSinkConnectionFromMeta(): PersistedParallaxSinkConnection | null {
  const raw = library.getAppMeta(PARALLAX_SINK_CONNECTION_META_KEY)
  if (!raw) return null
  try {
    const stored = JSON.parse(raw) as Record<string, unknown>
    const token = unprotectLocalSecret(stored.protectedToken)
    return token ? sanitizeParallaxSinkConnection({ ...stored, token }) : null
  } catch {
    return null
  }
}

async function persistParallaxSinkConnection(next: PersistedParallaxSinkConnection): Promise<void> {
  parallaxSinkConnection = { ...next }
  const { token, ...publicFields } = parallaxSinkConnection
  await library.setAppMeta(PARALLAX_SINK_CONNECTION_META_KEY, JSON.stringify({
    ...publicFields,
    protectedToken: protectLocalSecret(token)
  }))
}

async function clearParallaxSinkConnection(): Promise<void> {
  parallaxSinkConnection = null
  await library.setAppMeta(PARALLAX_SINK_CONNECTION_META_KEY, '')
}

// §14.1.2 / §16.4 / §16.12(a). Boot-path auto-reconnect retry loop. The service's existing
// `sinkReconnectTimer` ONLY covers in-session SSE/audio drops, not initial-connect failure
// (verified at parallax.ts:728-733). So this owns the "sink boots while host is down, host
// comes up later" case. Exponential backoff bounded at 60 s, indefinite retries — the sink
// is supposed to be appliance-like and just reconnect when the host comes back. 401 is the
// R-clear branch (§16.7 + §16.12(c)): the host explicitly revoked us, give up + clear creds.
let parallaxAutoReconnectTimer: ReturnType<typeof setTimeout> | null = null
let parallaxAutoReconnectAttempt = 0
let parallaxAutoReconnectGeneration = 0

function cancelParallaxAutoReconnect(): void {
  if (parallaxAutoReconnectTimer !== null) {
    clearTimeout(parallaxAutoReconnectTimer)
    parallaxAutoReconnectTimer = null
  }
  parallaxAutoReconnectAttempt = 0
  parallaxAutoReconnectGeneration += 1
}

async function attemptParallaxAutoReconnect(
  connection: PersistedParallaxSinkConnection,
  generation: number
): Promise<void> {
  if (generation !== parallaxAutoReconnectGeneration) return
  // §16.12(b) host-vs-sink precedence: never silently turn a host instance into a sink. If
  // host mode flipped on between scheduling and firing, abandon this attempt; the user can
  // press Connect manually after disabling host.
  if (parallaxHostConfig.enabled) {
    cancelParallaxAutoReconnect()
    return
  }
  // Use the latest persisted connection as the source of truth for the address — relocation
  // (Pillar 3) updates it mid-loop, and we must not connect to / persist a stale baseUrl.
  const active = parallaxSinkConnection ?? connection
  try {
    await parallaxService.connectSink(active)
    if (generation !== parallaxAutoReconnectGeneration) return
    parallaxAutoReconnectAttempt = 0
    const updated: PersistedParallaxSinkConnection = { ...active, lastConnectedAt: Date.now() }
    await persistParallaxSinkConnection(updated)
  } catch (error) {
    if (generation !== parallaxAutoReconnectGeneration) return
    if (error instanceof ParallaxAuthError && error.status === 401) {
      // R-clear per §16.7 — host explicitly revoked us. Wipe the credential, stop retrying.
      await clearParallaxSinkConnection()
      cancelParallaxAutoReconnect()
      return
    }
    parallaxAutoReconnectAttempt += 1
    // Pillar 3 — after a few failures against the persisted address, the host may have moved (sink
    // booted while the host was at a new IP). Try to relocate it via mDNS; on success the persisted
    // baseUrl is updated and the next attempt picks it up (and the attempt counter resets).
    if (parallaxAutoReconnectAttempt >= PARALLAX_BOOT_RELOCATE_AFTER_ATTEMPTS) {
      const relocated = await relocateParallaxHost()
      if (generation !== parallaxAutoReconnectGeneration) return
      if (relocated) parallaxAutoReconnectAttempt = 0
    }
    const next = parallaxSinkConnection ?? connection
    const delayMs = Math.min(60_000, 1_000 * Math.pow(2, Math.min(parallaxAutoReconnectAttempt - 1, 6)))
    parallaxAutoReconnectTimer = setTimeout(() => {
      void attemptParallaxAutoReconnect(next, generation)
    }, delayMs)
  }
}

function startParallaxAutoReconnect(connection: PersistedParallaxSinkConnection): void {
  cancelParallaxAutoReconnect()
  const generation = parallaxAutoReconnectGeneration
  void attemptParallaxAutoReconnect(connection, generation)
}

// Pillar 2 — OS power events. After the machine wakes, sockets that were live before sleep are
// almost always half-open (no FIN), so without an explicit kick both roles would sit wedged until a
// timeout/backoff elapsed. On resume we force a clean re-handshake immediately. Honors host-vs-sink
// precedence and the sink-role toggle exactly like `parallax:startAutoReconnect`.
function handleParallaxPowerResume(): void {
  // Re-publish the mDNS advert — the multicast socket may have gone stale across sleep, and a paired
  // sink relocating this host (Pillar 3) needs a fresh announcement to find it.
  refreshParallaxAdvertisement()
  if (parallaxHostConfig.enabled) {
    // Host: drop phantom (half-open) sink clients so the woken host's view is accurate and
    // reconnecting sinks get a clean handshake. The listening socket + activeStream are preserved.
    parallaxService.handleHostPowerResume()
    return
  }
  // Sink: force a fresh connect (attempt counter reset to 0 → no backoff delay). connectSink tears
  // down the half-open connection first, so this recovers a wedged sink instantly instead of waiting
  // out the liveness watchdog.
  if (!parallaxSinkConnection || !parallaxSinkEnabled) return
  startParallaxAutoReconnect(parallaxSinkConnection)
}

// Pillar 2 — proactive teardown on suspend so peers see a clean FIN and start reconnecting at once
// rather than waiting out half-open detection. Best-effort: may not flush before the machine sleeps,
// in which case the peer's own reconnect path still recovers it on resume.
function handleParallaxPowerSuspend(): void {
  if (parallaxHostConfig.enabled) {
    parallaxService.handleHostPowerSuspend()
    return
  }
  if (parallaxService.getStatus().sink.connected) {
    void parallaxService.disconnectSink().catch(() => undefined)
  }
}

// Pillar 3 — host relocation. Resolve a paired host's current address via mDNS by its remembered
// endpoint UUID and, if it has moved, persist + return the new baseUrl. Returns null when there's no
// UUID to search by (pre-Pillar-3 pairing), the host can't be found, or it's still at the persisted
// address. Shared by the in-session reconnect (onSinkRelocate callback) and the boot-path loop.
const PARALLAX_HOST_RESOLVE_TIMEOUT_MS = 4_000
// Boot-path counterpart to the service's PARALLAX_RELOCATE_AFTER_ATTEMPTS — relocate after this many
// failed initial-connect attempts against the persisted address (~3 ≈ the first few backoff cycles).
const PARALLAX_BOOT_RELOCATE_AFTER_ATTEMPTS = 3
async function relocateParallaxHost(): Promise<string | null> {
  const connection = parallaxSinkConnection
  const uuid = connection?.hostParallaxEndpointUuid?.trim()
  if (!connection || !uuid) return null
  let resolved: Awaited<ReturnType<typeof parallaxDiscoveryService.resolveHostByUuid>> = null
  try {
    resolved = await parallaxDiscoveryService.resolveHostByUuid(uuid, PARALLAX_HOST_RESOLVE_TIMEOUT_MS)
  } catch (error) {
    console.warn('Parallax host relocation lookup failed:', error)
    return null
  }
  if (!resolved) return null
  // Re-read: the connection may have been cleared/replaced while we were browsing.
  const current = parallaxSinkConnection
  if (!current || current.hostParallaxEndpointUuid?.trim() !== uuid) return null
  if (resolved.baseUrl === current.baseUrl) return null
  const updated: PersistedParallaxSinkConnection = { ...current, baseUrl: resolved.baseUrl }
  try {
    await persistParallaxSinkConnection(updated)
  } catch (error) {
    // Persist failure is non-fatal — still return the new URL so the live reconnect can use it; the
    // next successful connect will re-persist lastConnectedAt anyway.
    console.warn('Failed to persist relocated Parallax host address:', error)
  }
  console.log(`[parallax] relocated host ${uuid} → ${resolved.baseUrl}`)
  return resolved.baseUrl
}

async function loadLocalApiConfigFromMeta(): Promise<LocalApiServiceConfig> {
  const enabled = parseMetaBoolean(library.getAppMeta(LOCAL_API_ENABLED_META_KEY), false)
  const controlsEnabledStored = parseMetaBoolean(library.getAppMeta(LOCAL_API_CONTROLS_ENABLED_META_KEY), false)
  const librarySearchEnabled = parseMetaBoolean(library.getAppMeta(LOCAL_API_LIBRARY_SEARCH_ENABLED_META_KEY), false)
  const libraryWriteEnabled = parseMetaBoolean(library.getAppMeta(LOCAL_API_LIBRARY_WRITE_ENABLED_META_KEY), false)

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
    librarySearchEnabled,
    libraryWriteEnabled,
    port,
    token
  }

  const needsPersistence =
    library.getAppMeta(LOCAL_API_ENABLED_META_KEY) !== (normalized.enabled ? '1' : '0') ||
    library.getAppMeta(LOCAL_API_CONTROLS_ENABLED_META_KEY) !== (normalized.controlsEnabled ? '1' : '0') ||
    library.getAppMeta(LOCAL_API_LIBRARY_SEARCH_ENABLED_META_KEY) !== (normalized.librarySearchEnabled ? '1' : '0') ||
    library.getAppMeta(LOCAL_API_LIBRARY_WRITE_ENABLED_META_KEY) !== (normalized.libraryWriteEnabled ? '1' : '0') ||
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

async function loadCompanionApiReferenceSigner(): Promise<CompanionApiReferenceSigner> {
  const persisted = library.getAppMeta(COMPANION_API_REFERENCE_SECRET_META_KEY)?.trim() ?? ''
  if (persisted) {
    try {
      return new CompanionApiReferenceSigner(persisted)
    } catch {
      // Replace invalid legacy or corrupted material below.
    }
  }

  const secret = randomBytes(32).toString('base64url')
  await library.setAppMeta(COMPANION_API_REFERENCE_SECRET_META_KEY, secret)
  return new CompanionApiReferenceSigner(secret)
}

async function loadPhoneRemoteConfigFromMeta(controlsEnabled: boolean): Promise<PhoneRemoteServiceConfig> {
  const enabled = parseMetaBoolean(library.getAppMeta(PHONE_REMOTE_ENABLED_META_KEY), false)
  const syncEnabled = parseMetaBoolean(library.getAppMeta(PHONE_REMOTE_SYNC_ENABLED_META_KEY), true)

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
    syncEnabled,
    port
  }

  const needsPersistence =
    library.getAppMeta(PHONE_REMOTE_ENABLED_META_KEY) !== (normalized.enabled ? '1' : '0') ||
    library.getAppMeta(PHONE_REMOTE_SYNC_ENABLED_META_KEY) !== (normalized.syncEnabled ? '1' : '0') ||
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

async function loadParallaxHostConfigFromMeta(): Promise<ParallaxHostConfig> {
  const enabled = parseMetaBoolean(library.getAppMeta(PARALLAX_HOST_ENABLED_META_KEY), false)

  const rawPort = library.getAppMeta(PARALLAX_HOST_PORT_META_KEY)
  let port = PARALLAX_DEFAULT_PORT
  if (rawPort !== null) {
    try {
      port = normalizeParallaxPort(rawPort)
    } catch {
      port = PARALLAX_DEFAULT_PORT
    }
  }

  const normalized: ParallaxHostConfig = { enabled, port }
  const needsPersistence =
    library.getAppMeta(PARALLAX_HOST_ENABLED_META_KEY) !== (normalized.enabled ? '1' : '0') ||
    library.getAppMeta(PARALLAX_HOST_PORT_META_KEY) !== String(normalized.port)

  if (needsPersistence) {
    try {
      await persistParallaxHostConfig(normalized)
    } catch (error) {
      console.warn('Failed to persist normalized Parallax host settings:', error)
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

async function loadParallaxPairedSinksFromMeta(): Promise<PersistedParallaxPairedSink[]> {
  let pairedSinks = sanitizeParallaxPairedSinks([])
  const rawPairedSinks = library.getAppMeta(PARALLAX_PAIRED_SINKS_META_KEY)
  if (rawPairedSinks) {
    try {
      pairedSinks = sanitizeParallaxPairedSinks(JSON.parse(rawPairedSinks))
    } catch {
      pairedSinks = sanitizeParallaxPairedSinks([])
    }
  }

  if (library.getAppMeta(PARALLAX_PAIRED_SINKS_META_KEY) !== JSON.stringify(pairedSinks)) {
    try {
      await persistParallaxPairedSinks(pairedSinks)
    } catch (error) {
      console.warn('Failed to persist normalized Parallax paired sinks:', error)
    }
  } else {
    parallaxPairedSinks = pairedSinks.map((sink) => ({ ...sink }))
  }

  return pairedSinks
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
  const status = await phoneRemoteService.applyConfig(phoneRemoteConfig)
  refreshPhoneRemoteDiscoveryAdvertisement(status)
  return status
}

async function applyParallaxHostConfig(
  config: ParallaxHostConfig
): Promise<ReturnType<typeof parallaxService.getStatus>> {
  parallaxHostConfig = { ...config }
  await persistParallaxHostConfig(parallaxHostConfig)
  const status = await parallaxService.applyHostConfig(parallaxHostConfig)
  // Pillar 3 — keep the mDNS advert in step with host enable/disable so a paired sink can relocate
  // this host by UUID. Precedence-aware: falls back to the sink advert (or none) when host is off.
  refreshParallaxAdvertisement()
  return status
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

interface PersistedLyricsConfig {
  enabled: boolean
  lrclibBaseUrl: string
}

async function persistLyricsConfig(config: PersistedLyricsConfig): Promise<void> {
  await library.setAppMeta(LYRICS_ONLINE_ENABLED_META_KEY, config.enabled ? '1' : '0')
  await library.setAppMeta(LYRICS_LRCLIB_BASE_URL_META_KEY, config.lrclibBaseUrl)
}

async function loadLyricsConfigFromMeta(): Promise<PersistedLyricsConfig> {
  const enabled = parseMetaBoolean(library.getAppMeta(LYRICS_ONLINE_ENABLED_META_KEY), false)
  const lrclibBaseUrl = parseLrclibBaseUrl(library.getAppMeta(LYRICS_LRCLIB_BASE_URL_META_KEY))
    ?? LRCLIB_OFFICIAL_BASE_URL

  const normalizedStoredValue = enabled ? '1' : '0'
  if (
    library.getAppMeta(LYRICS_ONLINE_ENABLED_META_KEY) !== normalizedStoredValue
    || library.getAppMeta(LYRICS_LRCLIB_BASE_URL_META_KEY) !== lrclibBaseUrl
  ) {
    try {
      await persistLyricsConfig({ enabled, lrclibBaseUrl })
    } catch (error) {
      console.warn('Failed to persist normalized lyrics integration setting:', error)
    }
  }

  return { enabled, lrclibBaseUrl }
}

async function applyLyricsConfig(config: PersistedLyricsConfig): Promise<ReturnType<typeof lyricsService.getStatus>> {
  const endpointChanged = config.lrclibBaseUrl !== lyricsLrclibBaseUrl
  lyricsOnlineEnabled = Boolean(config.enabled)
  lyricsLrclibBaseUrl = config.lrclibBaseUrl
  await persistLyricsConfig({
    enabled: lyricsOnlineEnabled,
    lrclibBaseUrl: lyricsLrclibBaseUrl
  })
  if (endpointChanged) {
    await library.clearLyricsCacheMisses()
  }
  return lyricsService.applyConfig(lyricsOnlineEnabled, lyricsLrclibBaseUrl)
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

function broadcastParallaxStatus(): void {
  if (isAppQuitting) return
  const payload = parallaxService.getStatus()
  sendToWindow(mainWindow, 'parallax:status', payload)
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
    maxWidth: MINI_WINDOW_MAX_WIDTH,
    maxHeight: MINI_WINDOW_MAX_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    alwaysOnTop: prefs.alwaysOnTop,
    autoHideMenuBar: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    title: MINI_WINDOW_TITLE,
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

  miniWindow.on('page-title-updated', (event) => {
    event.preventDefault()
    miniWindow?.setTitle(MINI_WINDOW_TITLE)
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

  mainWindow.on('app-command', (event, command) => {
    const input = resolveMouseAppCommand(command)
    if (!input) return
    event.preventDefault()
    mainWindow?.webContents.send('input-bindings:input', input)
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
    globalInputShortcutService.clear()
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
    const interceptedInput = resolveInterceptedKeyboardInput(input, process.platform)
    if (!interceptedInput) return

    event.preventDefault()
    mainWindow?.webContents.setZoomLevel(0)
    mainWindow?.webContents.send('input-bindings:input', interceptedInput)
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

async function maybeRunGenreMetadataBackfillOnce(): Promise<void> {
  if (library.getAppMeta(GENRE_METADATA_BACKFILL_MIGRATION_KEY) === '1') {
    return
  }

  let completed = false
  try {
    const { scanned, updated, errors } = await library.backfillMissingGenreMetadata()
    if (scanned > 0) {
      console.log(`Genre metadata backfill (one-time): scanned=${scanned}, updated=${updated}, errors=${errors}`)
    }
    if (updated > 0) {
      mainWindow?.webContents.send('library:audioMetadataBackfillComplete', { scanned, updated, errors })
    }
    completed = true
  } catch (err) {
    console.warn('Genre metadata backfill failed:', err)
  } finally {
    if (completed) {
      try {
        await library.setAppMeta(GENRE_METADATA_BACKFILL_MIGRATION_KEY, '1')
      } catch (err) {
        console.warn('Failed to persist genre metadata backfill migration flag:', err)
      }
    }
  }
}

function scheduleGenreMetadataBackfillMigration(): void {
  if (library.getAppMeta(GENRE_METADATA_BACKFILL_MIGRATION_KEY) === '1') {
    return
  }

  if (genreMetadataBackfillTimer !== null) {
    clearTimeout(genreMetadataBackfillTimer)
  }

  genreMetadataBackfillTimer = setTimeout(() => {
    genreMetadataBackfillTimer = null
    void maybeRunGenreMetadataBackfillOnce()
  }, GENRE_METADATA_BACKFILL_STARTUP_DELAY_MS)
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

async function getArtworkBytesByHash(hash: string): Promise<ArtworkBytes | null> {
  if (!hash) return null
  const resolvedHash = await resolveSubsonicArtworkHash(hash)
  if (!resolvedHash) return null
  try {
    const artworkPath = library.getArtworkPath(resolvedHash)
    const data = await readFile(artworkPath)
    return { bytes: data, mimeType: detectArtworkMimeType(resolvedHash, data) }
  } catch {
    return null
  }
}

async function getArtworkDataUrlByHash(hash: string): Promise<string | null> {
  const artwork = await getArtworkBytesByHash(hash)
  return artwork ? toDataUrl(artwork.mimeType, artwork.bytes) : null
}

async function resolveArtworkThumbnailBytesByHash(
  hash: string,
  maxEdgePx: number,
  jpegQuality: number,
  allowOriginalFallback: boolean
): Promise<ArtworkBytes | null> {
  const resolvedHash = await resolveSubsonicArtworkHash(hash)
  if (!resolvedHash) return null

  try {
    await ensureArtworkThumbnailCacheDirectory()
    const thumbnailPath = join(artworkThumbnailCacheDir, `${getArtworkThumbnailCacheKey(resolvedHash, maxEdgePx)}.jpg`)

    try {
      const cached = await readFile(thumbnailPath)
      if (cached.length > 0) {
        return { bytes: cached, mimeType: 'image/jpeg' }
      }
    } catch {
      // Cache miss: generate and persist below.
    }

    const artworkPath = library.getArtworkPath(resolvedHash)
    const sourceBuffer = await readFile(artworkPath)
    const sourceImage = nativeImage.createFromBuffer(sourceBuffer)
    if (sourceImage.isEmpty()) {
      return allowOriginalFallback ? getArtworkBytesByHash(resolvedHash) : null
    }

    const resized = resizeArtworkForMaxEdge(sourceImage, maxEdgePx)
    const thumbnailBuffer = resized.toJPEG(jpegQuality)
    if (!thumbnailBuffer || thumbnailBuffer.length === 0) {
      return allowOriginalFallback ? getArtworkBytesByHash(resolvedHash) : null
    }

    try {
      await writeFile(thumbnailPath, thumbnailBuffer, { flag: 'wx' })
    } catch (error) {
      if (getErrorCode(error) !== 'EEXIST') {
        console.warn('Failed to persist artwork thumbnail cache file:', thumbnailPath, error)
      }
    }

    return { bytes: thumbnailBuffer, mimeType: 'image/jpeg' }
  } catch (error) {
    console.warn('Failed to resolve artwork thumbnail data URL:', resolvedHash, error)
    return allowOriginalFallback ? getArtworkBytesByHash(resolvedHash) : null
  }
}

function getArtworkThumbnailBytesByHash(
  hash: string,
  options?: {
    maxEdgePx?: number
    jpegQuality?: number
    allowOriginalFallback?: boolean
  }
): Promise<ArtworkBytes | null> {
  if (!hash) return Promise.resolve(null)

  const maxEdgePx = options?.maxEdgePx ?? TRACKLIST_THUMB_MAX_EDGE_PX
  const jpegQuality = options?.jpegQuality ?? TRACKLIST_THUMB_JPEG_QUALITY
  const allowOriginalFallback = options?.allowOriginalFallback !== false

  // Deduplicate concurrent generation per hash+size across all entry points
  // (IPC, custom protocol, remote controller services).
  const requestKey = `${getArtworkThumbnailCacheKey(hash, maxEdgePx)}:${allowOriginalFallback ? 'fallback' : 'strict'}`
  const pending = artworkThumbnailRequestCache.get(requestKey)
  if (pending) return pending

  const request = resolveArtworkThumbnailBytesByHash(hash, maxEdgePx, jpegQuality, allowOriginalFallback)
    .finally(() => {
      artworkThumbnailRequestCache.delete(requestKey)
    })
  artworkThumbnailRequestCache.set(requestKey, request)
  return request
}

async function getArtworkThumbnailDataUrlByHash(
  hash: string,
  options?: {
    maxEdgePx?: number
    jpegQuality?: number
    allowOriginalFallback?: boolean
  }
): Promise<string | null> {
  const artwork = await getArtworkThumbnailBytesByHash(hash, options)
  return artwork ? toDataUrl(artwork.mimeType, artwork.bytes) : null
}

// URL shape: astra-artwork://art/<thumb|card|full>/<encodeURIComponent(hash)>
// Hashes are md5 hex with an optional extension, optionally prefixed with
// "plc:" (playlist covers) or "ari:" (artist images).
const ARTWORK_PROTOCOL_HASH_PATTERN = /^(?:plc:|ari:)?[A-Za-z0-9][A-Za-z0-9._ -]*$/

function artworkProtocolNotFound(): Response {
  return new Response(null, { status: 404 })
}

function registerArtworkProtocolHandler(): void {
  protocol.handle(ARTWORK_PROTOCOL_SCHEME, async (request) => {
    let variant: string
    let hash: string
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'art') return artworkProtocolNotFound()
      const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
      if (segments.length !== 2) return artworkProtocolNotFound()
      variant = segments[0]
      hash = decodeURIComponent(segments[1])
    } catch {
      return artworkProtocolNotFound()
    }

    // library.getArtworkPath joins the hash into a path, so reject anything
    // that could traverse outside the artwork directories.
    if (!ARTWORK_PROTOCOL_HASH_PATTERN.test(hash) || hash.includes('..')) {
      return artworkProtocolNotFound()
    }

    let artwork: ArtworkBytes | null = null
    if (variant === 'thumb') {
      artwork = await getArtworkThumbnailBytesByHash(hash, {
        maxEdgePx: TRACKLIST_THUMB_MAX_EDGE_PX,
        jpegQuality: TRACKLIST_THUMB_JPEG_QUALITY
      })
    } else if (variant === 'card') {
      artwork = await getArtworkThumbnailBytesByHash(hash, {
        maxEdgePx: CARD_ARTWORK_MAX_EDGE_PX,
        jpegQuality: CARD_ARTWORK_JPEG_QUALITY
      })
    } else if (variant === 'full') {
      artwork = await getArtworkBytesByHash(hash)
    } else {
      return artworkProtocolNotFound()
    }

    if (!artwork) return artworkProtocolNotFound()

    return new Response(new Uint8Array(artwork.bytes), {
      headers: {
        'Content-Type': artwork.mimeType,
        // Hash-addressed and versioned via the on-disk thumb cache key, so
        // responses never change for a given URL.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*'
      }
    })
  })
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

// §14.1.4 — `--zone` CLI flag forces the renderer into Zone Display layout for this launch
// without mutating the persisted `openZoneDisplayOnLaunch` preference. Translated to an env var
// here so the preload (which can't reach argv with contextIsolation) reads a single signal.
// PARALLAX_LAUNCH_ZONE=1 set externally works too — same code path on the preload side.
if (process.argv.includes('--zone')) {
  process.env.PARALLAX_LAUNCH_ZONE = '1'
}

app.whenReady().then(async () => {
  // Grant audio-capture permission up front so Web Audio's AudioContext.outputLatency reports at
  // 1ms precision instead of 8ms — Blink quantizes it coarsely until the document holds microphone
  // permission, and Parallax output-latency compensation depends on accurate readings. This app
  // only loads its own trusted bundled UI (and already uses getUserMedia for output calibration),
  // so this is not a meaningful expansion of what the renderer could already do.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true)
  })
  session.defaultSession.setPermissionCheckHandler(() => true)

  // Initialize library database
  await library.initDatabase()
  companionApiReferenceSigner = await loadCompanionApiReferenceSigner()
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
  registerArtworkProtocolHandler()
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
  parallaxHostConfig = await loadParallaxHostConfigFromMeta()
  await migratePhoneRemoteSecurityV3()
  await migrateParallaxSecurityV2()
  phoneRemoteTlsIdentity = await loadOrCreatePhoneRemoteTlsIdentity()
  phoneRemoteService.setTlsIdentity(phoneRemoteTlsIdentity)
  parallaxTlsIdentity = await loadOrCreateParallaxTlsIdentity()
  parallaxService.setTlsIdentity(parallaxTlsIdentity)
  phoneRemotePairedDevices = await loadPhoneRemotePairedDevicesFromMeta()
  parallaxPairedSinks = await loadParallaxPairedSinksFromMeta()
  parallaxSinkConnection = loadParallaxSinkConnectionFromMeta()
  // §20 Commit 1. Sink-enabled migration MUST read after `parallaxSinkConnection` is loaded —
  // the migration condition checks "did this user have a persisted sink connection pre-§20."
  // Endpoint UUID is lazy-generated regardless of role and persisted on first launch.
  parallaxSinkEnabled = await loadParallaxSinkEnabledFromMeta()
  parallaxEndpointUuid = await loadParallaxEndpointUuidFromMeta()
  // §20 Commit 2 + 3. Kick the sink surface at boot if sink is already enabled from a previous
  // launch (either user-toggled or migrated per §20.19(d)). Safe to call before mainWindow
  // exists — mDNS + listener don't need the renderer. `startParallaxSinkSurface` enforces the
  // listener-before-advertise ordering per Codex round 1 finding (medium).
  if (parallaxSinkEnabled) {
    await startParallaxSinkSurface()
  }
  phoneRemoteService.replacePairedDevices(phoneRemotePairedDevices)
  parallaxService.replacePairedSinks(parallaxPairedSinks)
  await localApiService.applyConfig(localApiConfig)
  await phoneRemoteService.applyConfig(phoneRemoteConfig)
  refreshPhoneRemoteDiscoveryAdvertisement()
  await parallaxService.applyHostConfig(parallaxHostConfig)
  // Pillar 3 — publish the role-appropriate mDNS advert now that both host config and sink-enabled
  // are loaded (the sink surface above may have advertised role=sink before host config was known;
  // this corrects to role=host when host mode is the active role).
  refreshParallaxAdvertisement()
  // Pillar 2 — wire OS power events so parallax recovers instantly on sleep→wake instead of waiting
  // out a timeout/backoff. Registered once at boot; the handlers themselves are role-aware and
  // no-op when parallax isn't active.
  powerMonitor.on('resume', handleParallaxPowerResume)
  powerMonitor.on('suspend', handleParallaxPowerSuspend)
  // §14.1.2 follow-up (Codex round 2, finding 1). Auto-reconnect used to kick off here, BEFORE
  // createWindow(). But `onSinkEvent` / `onSinkAudioChunk` only forward to mainWindow if it
  // exists — a successful pre-window /join would drop the one-shot `stream-start` event and
  // early audio chunks on the floor. The renderer-side `parallaxStore.init()` now calls
  // `parallax:startAutoReconnect` after subscriptions + AudioEngine are ready; main just stages
  // the saved connection in memory here and waits.
  lastFmConfig = await loadLastFmConfigFromMeta()
  await lastFmService.applyConfig(lastFmConfig)
  const lyricsConfig = await loadLyricsConfigFromMeta()
  lyricsOnlineEnabled = lyricsConfig.enabled
  lyricsLrclibBaseUrl = lyricsConfig.lrclibBaseUrl
  lyricsService.applyConfig(lyricsOnlineEnabled, lyricsLrclibBaseUrl)
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
  scheduleGenreMetadataBackfillMigration()
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
  globalInputShortcutService.clear()
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
  if (genreMetadataBackfillTimer !== null) {
    clearTimeout(genreMetadataBackfillTimer)
    genreMetadataBackfillTimer = null
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
  phoneRemoteDiscoveryService.destroy()
  void parallaxService.stop()
  // §20 Commit 2. Release the mDNS socket on quit so a relaunched Astra doesn't fight the
  // prior instance for the multicast group. Idempotent — safe even when no advert was running.
  parallaxDiscoveryService.destroy()
  // §20 Commit 3. Close the sink listener port. Fire-and-forget — the listen socket will close
  // when the process exits regardless, this just keeps the quit log clean.
  void parallaxSinkListener.stop().catch((error) => {
    console.warn('Failed to stop Parallax sink listener on quit:', error)
  })
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

ipcMain.handle('mini-player:isCursorInsideWindow', (event) => {
  if (!miniWindow || miniWindow.isDestroyed() || event.sender !== miniWindow.webContents) {
    return false
  }

  const cursor = screen.getCursorScreenPoint()
  const bounds = miniWindow.getBounds()
  return cursor.x >= bounds.x
    && cursor.x < bounds.x + bounds.width
    && cursor.y >= bounds.y
    && cursor.y < bounds.y + bounds.height
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

ipcMain.on('mini-player:publishQueueSnapshot', (_event, snapshot: MiniPlayerQueueSnapshot) => {
  latestMiniPlayerQueueSnapshot = snapshot
  localApiService.publishQueueSnapshot(snapshot)
  phoneRemoteService.publishQueueSnapshot(snapshot)
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

ipcMain.handle('app:getPerformanceStats', async (event) => {
  const metrics = app.getAppMetrics()
  const totalCpuPercent = metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0)
  const totalWorkingSetKb = metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0)
  const memoryFootprint = collectAppMemoryFootprint({
    metrics,
    extraPids: getActiveMemoryFootprintChildProcessPids(),
    rawWorkingSetMb: totalWorkingSetKb / 1024
  })

  // Working sets double-count framework pages shared between Electron
  // processes, so their sum badly overstates what the app actually costs.
  // Build a private-memory total instead: per-process privateBytes where the
  // platform reports it (Windows), a direct measurement for the main process,
  // and working set only for processes that can't be measured (GPU/utility
  // on macOS). The calling renderer is excluded here because it adds its own
  // directly measured private value to this sum.
  let callerPid: number | null = null
  try {
    callerPid = event.sender.getOSProcessId()
  } catch {
    // Sender may be gone mid-call; fall through with no private total.
  }
  let mainPrivateKb: number | null = null
  try {
    mainPrivateKb = (await process.getProcessMemoryInfo()).private
  } catch {
    // Process metrics can be briefly unavailable; report null below.
  }

  let mainProcessKb: number | null = null
  let helperProcessesKb: number | null = 0
  if (callerPid === null) {
    helperProcessesKb = null
  } else {
    for (const metric of metrics) {
      if (metric.pid === callerPid) continue
      const privateKb = metric.memory.privateBytes
      const measuredKb = typeof privateKb === 'number' && Number.isFinite(privateKb) && privateKb > 0
        ? privateKb
        : metric.type === 'Browser' && mainPrivateKb !== null
          ? mainPrivateKb
          : metric.memory.workingSetSize
      if (metric.type === 'Browser') {
        mainProcessKb = measuredKb
      } else {
        helperProcessesKb += measuredKb
      }
    }
  }

  const privateExcludingCallerKb = helperProcessesKb === null
    ? null
    : helperProcessesKb + (mainProcessKb ?? 0)

  return {
    cpuPercent: totalCpuPercent,
    workingSetMb: totalWorkingSetKb / 1024,
    footprintMb: memoryFootprint.footprintMb,
    appProcessFootprintMb: memoryFootprint.appProcessFootprintMb,
    childProcessFootprintMb: memoryFootprint.childProcessFootprintMb,
    footprintSource: memoryFootprint.footprintSource,
    footprintComplete: memoryFootprint.footprintComplete,
    footprintFailedPids: memoryFootprint.footprintFailedPids,
    footprintProcessCount: memoryFootprint.footprintProcessCount,
    footprintAppProcessCount: memoryFootprint.footprintAppProcessCount,
    footprintChildProcessCount: memoryFootprint.footprintChildProcessCount,
    privateMemoryExcludingCallerMb: privateExcludingCallerKb === null
      ? null
      : privateExcludingCallerKb / 1024,
    mainProcessMemoryMb: mainProcessKb === null ? null : mainProcessKb / 1024,
    helperProcessesMemoryMb: helperProcessesKb === null ? null : helperProcessesKb / 1024,
  }
})

ipcMain.handle('input-bindings:configure-global', (event, rawRequests: unknown) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return []
  const requests = sanitizeGlobalShortcutRegistrationRequests(rawRequests)
  return globalInputShortcutService.configure(requests, (actionId) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (GLOBAL_ACTIONS_THAT_FOCUS_MAIN_WINDOW.has(actionId)) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
    mainWindow.webContents.send('input-bindings:global-action', actionId)
  })
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
  return applyLyricsConfig({
    enabled: Boolean(enabled),
    lrclibBaseUrl: lyricsLrclibBaseUrl
  })
})

ipcMain.handle('lyrics:setLrclibBaseUrl', async (_event, rawBaseUrl: unknown) => {
  const input = typeof rawBaseUrl === 'string' ? rawBaseUrl.trim() : ''
  const lrclibBaseUrl = input.length === 0
    ? LRCLIB_OFFICIAL_BASE_URL
    : parseLrclibBaseUrl(input)
  if (!lrclibBaseUrl) {
    throw new Error('Enter a valid HTTP or HTTPS LRCLIB base URL without credentials.')
  }
  return applyLyricsConfig({
    enabled: lyricsOnlineEnabled,
    lrclibBaseUrl
  })
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
  return applyLyricsConfig({
    enabled: false,
    lrclibBaseUrl: LRCLIB_OFFICIAL_BASE_URL
  })
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

ipcMain.handle('local-api:setLibrarySearchEnabled', async (_event, enabled: unknown) => {
  return applyLocalApiConfig({
    ...localApiConfig,
    librarySearchEnabled: Boolean(enabled)
  })
})

ipcMain.handle('local-api:setLibraryWriteEnabled', async (_event, enabled: unknown) => {
  return applyLocalApiConfig({
    ...localApiConfig,
    libraryWriteEnabled: Boolean(enabled)
  })
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
    librarySearchEnabled: false,
    libraryWriteEnabled: false,
    port: LOCAL_API_DEFAULT_PORT,
    token: generateLocalApiToken(),
  }
  const nextPhoneRemoteConfig: PhoneRemoteServiceConfig = {
    enabled: false,
    controlsEnabled: false,
    syncEnabled: true,
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

ipcMain.handle('phone-remote:createPairingTicket', (_event, baseUrl?: unknown, clientKind?: unknown) => {
  return phoneRemoteService.createPairingTicket(
    typeof baseUrl === 'string' ? baseUrl : undefined,
    clientKind === 'web' ? 'web' : 'native'
  )
})

ipcMain.handle('phone-remote:listPairedDevices', () => {
  return phoneRemoteService.listPairedDevices()
})

ipcMain.handle('phone-remote:listPendingPairingRequests', () => {
  return phoneRemoteService.listPendingPairingRequests()
})

ipcMain.handle('phone-remote:approvePairingRequest', (_event, id: unknown, grantedScopes?: unknown) => {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('Invalid pairing request id.')
  }
  const normalizedScopes = Array.isArray(grantedScopes)
    ? grantedScopes.filter((scope): scope is import('../types/companionApi').CompanionApiScope => (
        scope === 'observe'
        || scope === 'playback-control'
        || scope === 'library-search'
        || scope === 'library-write'
      ))
    : undefined
  return phoneRemoteService.approvePairingRequest(id.trim(), normalizedScopes)
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

ipcMain.handle('phone-remote:setSyncEnabled', async (_event, enabled: unknown) => {
  const nextConfig: PhoneRemoteServiceConfig = {
    ...phoneRemoteConfig,
    syncEnabled: Boolean(enabled)
  }
  return applyPhoneRemoteConfig(nextConfig)
})

ipcMain.handle('phone-remote:requestSync', () => {
  phoneRemoteService.requestSync()
  return phoneRemoteService.getStatus()
})

ipcMain.handle('phone-remote:resolveSyncConflict', (_event, syncUid: unknown, resolution: unknown) => {
  if (typeof syncUid !== 'string' || !syncUid.trim()) {
    throw new Error('Invalid sync conflict id.')
  }
  if (
    resolution !== 'desktop' &&
    resolution !== 'phone' &&
    resolution !== 'both' &&
    resolution !== 'merge'
  ) {
    throw new Error('Invalid sync conflict resolution.')
  }
  phoneRemoteService.resolveSyncConflict(syncUid.trim(), resolution)
  return phoneRemoteService.getStatus()
})

ipcMain.handle('phone-remote:resetToDefaults', async () => {
  const nextConfig: PhoneRemoteServiceConfig = {
    enabled: false,
    controlsEnabled: localApiConfig.controlsEnabled,
    syncEnabled: true,
    port: PHONE_REMOTE_DEFAULT_PORT
  }
  phoneRemoteService.replacePairedDevices([])
  await persistPhoneRemotePairedDevices([])
  return applyPhoneRemoteConfig(nextConfig)
})

// Parallax LAN sync
ipcMain.handle('parallax:getStatus', () => {
  return parallaxService.getStatus()
})

// §14.1.4 / §19.18(e) — sink-side artwork fetch. Main holds the token; renderer never sees it
// (§14.1.2 invariant). Returns a base64 data URL on success, null on any failure — Zone Display
// falls back to placeholder.
ipcMain.handle('parallax:fetchSinkArtwork', async (_event, streamId: unknown) => {
  if (typeof streamId !== 'string' || streamId.length === 0) return null
  return parallaxService.fetchSinkArtworkDataUrl(streamId)
})

// §14.1.4 / Codex finding 2 (high). Sink → host trim push from the Zone Display overlay.
ipcMain.handle(
  'parallax:requestSinkTrimUpdate',
  async (_event, outputDeviceId: unknown, outputDeviceLabel: unknown, advanceMs: unknown) => {
    if (typeof outputDeviceId !== 'string' || outputDeviceId.length === 0) return false
    if (typeof advanceMs !== 'number' || !Number.isFinite(advanceMs)) return false
    const label = typeof outputDeviceLabel === 'string' ? outputDeviceLabel : null
    return parallaxService.pushSinkTrimUpdate(outputDeviceId, label, advanceMs)
  }
)

// §14.1.4 — device-identity for the Zone Display identity card. Returns this machine's OS hostname
// and LAN IPv4 addresses regardless of whether the Parallax host is currently enabled, so the
// unpaired/revoked surface ("This endpoint") can identify the device even when host mode is off.
ipcMain.handle('parallax:getEndpointIdentity', () => {
  // Codex finding 4 (low): return ALL non-internal IPv4s, sorted with common LAN ranges first.
  // The prior implementation filtered to 192.168.* if any existed, hiding 10.* / 172.16.* on
  // multi-interface machines (corporate LANs, mesh routers, container hosts).
  const lanIps: string[] = []
  const interfaces = networkInterfaces()
  for (const addresses of Object.values(interfaces)) {
    for (const addressInfo of addresses ?? []) {
      if (addressInfo.internal) continue
      if (addressInfo.family !== 'IPv4') continue
      const address = addressInfo.address.trim()
      if (address) lanIps.push(address)
    }
  }
  const rankLanIp = (ip: string): number => {
    if (/^192\.168\./.test(ip)) return 0
    if (/^10\./.test(ip)) return 1
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return 2
    return 3
  }
  lanIps.sort((left, right) => {
    const rankDelta = rankLanIp(left) - rankLanIp(right)
    if (rankDelta !== 0) return rankDelta
    return left.localeCompare(right)
  })
  return { hostname: hostname(), lanIps }
})

ipcMain.handle('parallax:listPairedSinks', () => {
  return parallaxService.listPairedSinks()
})

ipcMain.handle('parallax:setHostEnabled', async (_event, enabled: unknown) => {
  const nextConfig: ParallaxHostConfig = {
    ...parallaxHostConfig,
    enabled: Boolean(enabled)
  }
  return applyParallaxHostConfig(nextConfig)
})

ipcMain.handle('parallax:setHostPort', async (_event, rawPort: unknown) => {
  const nextPort = normalizeParallaxPort(rawPort)
  const nextConfig: ParallaxHostConfig = {
    ...parallaxHostConfig,
    port: nextPort
  }
  return applyParallaxHostConfig(nextConfig)
})

// §14.1.2 follow-up (Codex round 1, finding 3). Renderer-facing manual-reconnect that reuses
// the credential main already holds — eliminates the need for SettingsView to keep the raw
// token in component state just so it can drive a Connect button.
ipcMain.handle('parallax:reconnectFromPersisted', async () => {
  if (!parallaxSinkConnection) {
    throw new Error('No persisted Parallax sink connection.')
  }
  cancelParallaxAutoReconnect()
  return parallaxService.connectSink(parallaxSinkConnection)
})

// §14.1.2 follow-up (Codex round 2, finding 1). Renderer calls this from parallaxStore.init()
// once the audio engine + event subscriptions are wired. Boot-path auto-reconnect previously
// fired from main during initialize() — but `onSinkEvent` / `onSinkAudioChunk` need mainWindow
// to exist + the renderer store to be subscribed, otherwise the join's `stream-start` event
// and early audio chunks are silently dropped. Moving the trigger to the renderer guarantees
// the host data path is alive before any /join completes. Returns `{ scheduled: boolean }` so
// the renderer knows whether it should monitor reconnect progress via status, or whether
// nothing was scheduled (no persisted creds, or host mode wins per §16.12(b) precedence).
ipcMain.handle('parallax:startAutoReconnect', () => {
  if (!parallaxSinkConnection) return { scheduled: false, reason: 'no-persisted-connection' as const }
  if (parallaxHostConfig.enabled) return { scheduled: false, reason: 'host-mode-active' as const }
  // §20 Commit 1. Auto-reconnect honors the sink-role toggle — turning the sink off must not
  // leave a background reconnect loop running. Persisted credentials are preserved (use
  // "Forget Host" for explicit credential wipe per §14.1.2).
  if (!parallaxSinkEnabled) return { scheduled: false, reason: 'sink-disabled' as const }
  startParallaxAutoReconnect(parallaxSinkConnection)
  return { scheduled: true as const }
})

// §20 Commit 1. Sink-role enablement toggle. Off → cancel in-flight reconnect, disconnect any
// live session, persist; existing credentials stay (use "Forget Host" to clear). On → persist
// only; the renderer follows up through `reconnectFromPersisted` so the Standard-output gate
// and audioEngine.stop() prep run before reconnect (Codex round 1 finding, high). Starting the
// reconnect loop from main here would bypass that prep and could collide with local playback
// or bitperfect mode.
//
// §20 Commit 2. Sink-role also gates mDNS advertisement. Advertise starts on enable + at boot
// when the persisted flag is already on; stops on disable + at app quit (see destroy hook below).
ipcMain.handle('parallax:setSinkEnabled', async (_event, enabled: unknown) => {
  const nextEnabled = Boolean(enabled)
  if (nextEnabled === parallaxSinkEnabled) return parallaxService.getStatus()
  parallaxSinkEnabled = nextEnabled
  try {
    await persistParallaxSinkEnabled(parallaxSinkEnabled)
  } catch (error) {
    console.warn('Failed to persist Parallax sink-enabled flag:', error)
  }
  if (!parallaxSinkEnabled) {
    cancelParallaxAutoReconnect()
    await parallaxService.disconnectSink()
    await stopParallaxSinkSurface()
  } else {
    await startParallaxSinkSurface()
  }
  // On-enable reconnect is renderer-driven; main intentionally does nothing else here.
  return parallaxService.getStatus()
})

// §20 Commit 2 / Pillar 3. mDNS advertisement, honoring host-vs-sink precedence (a machine is host
// XOR sink). A host advertises role=host so a paired sink can relocate it by UUID after its IP
// changes (Pillar 3); a sink advertises role=sink on the listener port so the pairing wizard can
// discover it (§20). Idempotent — startAdvertising replaces any prior advert; with neither role
// active we stop advertising entirely. Call this whenever host-enabled or sink-enabled changes.
function refreshParallaxAdvertisement(): void {
  if (!parallaxEndpointUuid) return
  if (parallaxHostConfig.enabled) {
    try {
      parallaxDiscoveryService.startAdvertising({
        role: 'host',
        name: hostname() || 'Astra Host',
        port: parallaxHostConfig.port,
        endpointUuid: parallaxEndpointUuid
      })
    } catch (error) {
      console.warn('Failed to start Parallax host advertisement:', error)
    }
    return
  }
  if (parallaxSinkEnabled) {
    try {
      parallaxDiscoveryService.startAdvertising({
        role: 'sink',
        name: hostname() || 'Astra Sink',
        port: PARALLAX_SINK_DEFAULT_PORT,
        endpointUuid: parallaxEndpointUuid
      })
    } catch (error) {
      console.warn('Failed to start Parallax sink advertisement:', error)
    }
    return
  }
  stopParallaxDiscoveryAdvertisement()
}

function getPhoneRemoteIdentity(): PhoneRemoteIdentity {
  return {
    endpointUuid: parallaxEndpointUuid || null,
    desktopName: hostname() || 'Astra Desktop',
    protocolVersion: PHONE_REMOTE_PROTOCOL_VERSION
  }
}

function refreshPhoneRemoteDiscoveryAdvertisement(status = phoneRemoteService.getStatus()): void {
  if (!parallaxEndpointUuid) return
  if (!status.active) {
    phoneRemoteDiscoveryService.stopAdvertising()
    return
  }
  try {
    const identity = getPhoneRemoteIdentity()
    phoneRemoteDiscoveryService.startAdvertising({
      name: identity.desktopName,
      port: status.port,
      endpointUuid: identity.endpointUuid,
      protocolVersion: identity.protocolVersion,
      transport: 'https',
      certificateFingerprint: phoneRemoteTlsIdentity?.fingerprint256 ?? ''
    })
  } catch (error) {
    console.warn('Failed to refresh phone remote discovery advertisement:', error)
  }
}

function stopParallaxDiscoveryAdvertisement(): void {
  try {
    parallaxDiscoveryService.stopAdvertising()
  } catch (error) {
    console.warn('Failed to stop Parallax discovery advertisement:', error)
  }
}

// §20 Commit 3. Sink HTTP listener lifecycle. Started when sink-enabled at boot or via toggle,
// stopped on disable. Bind failures (port in use) leave the sink not pairable; the wizard pair
// flow just won't reach this device until the port frees. Returns true on successful bind so
// callers (boot path, setSinkEnabled IPC) can decide whether to advertise — Codex round 1
// finding (medium): no point advertising an endpoint we can't actually serve.
async function startParallaxSinkListener(): Promise<boolean> {
  if (!parallaxSinkEnabled) return false
  try {
    await parallaxSinkListener.start(PARALLAX_SINK_DEFAULT_PORT)
    return true
  } catch (error) {
    console.warn('Failed to start Parallax sink listener:', error)
    return false
  }
}

async function stopParallaxSinkListener(): Promise<void> {
  try {
    await parallaxSinkListener.stop()
  } catch (error) {
    console.warn('Failed to stop Parallax sink listener:', error)
  }
}

// §20 Commit 3 Codex round 1 finding (medium): pair "start sink, then advertise" / "stop
// advertise, then stop sink" into one helper so both the boot path and the toggle path are
// guaranteed to honor the ordering invariant.
async function startParallaxSinkSurface(): Promise<void> {
  const bound = await startParallaxSinkListener()
  if (!bound) {
    // Listener didn't bind — don't advertise a dead endpoint.
    stopParallaxDiscoveryAdvertisement()
    return
  }
  refreshParallaxAdvertisement()
}

async function stopParallaxSinkSurface(): Promise<void> {
  stopParallaxDiscoveryAdvertisement()
  await stopParallaxSinkListener()
}

// Forward bonjour 'added' / 'removed' events to the renderer. Renderer keeps its own map keyed
// by endpointUuid || `${address}:${port}` and reconciles. Subscribed once at construction —
// no add/remove required because the wrapper itself starts/stops the underlying browser based
// on the IPCs below.
parallaxDiscoveryService.on('event', (event: ParallaxDiscoveryEvent) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('parallax:discoveryEvent', event)
  }
})

ipcMain.handle('parallax:startDiscoveryBrowse', () => {
  parallaxDiscoveryService.startBrowse()
  return { ok: true as const }
})

ipcMain.handle('parallax:stopDiscoveryBrowse', () => {
  parallaxDiscoveryService.stopBrowse()
  return { ok: true as const }
})

// §20 Commit 3 host-side pair flow IPCs. Wizard calls `initiate` with the sink's base URL (from
// discovery or manual entry), waits for the user to read the sink's PIN, then calls `submitPin`.
// `cancel` discards the candidate locally — the sink will time out on its own per §20.7.
ipcMain.handle('parallax:initiatePair', async (_event, sinkBaseUrl: unknown) => {
  if (typeof sinkBaseUrl !== 'string' || sinkBaseUrl.length === 0) {
    throw new Error('sinkBaseUrl is required.')
  }
  return parallaxService.initiatePair(sinkBaseUrl)
})

ipcMain.handle('parallax:submitPairPin', async (_event, pairingId: unknown, pin: unknown, sinkName: unknown) => {
  if (typeof pairingId !== 'string' || typeof pin !== 'string') {
    throw new Error('pairingId and pin are required.')
  }
  const name = typeof sinkName === 'string' ? sinkName : undefined
  return parallaxService.submitPairPin(pairingId, pin, name)
})

ipcMain.handle('parallax:cancelPair', (_event, pairingId: unknown) => {
  if (typeof pairingId !== 'string') return { ok: false as const }
  parallaxService.cancelPair(pairingId)
  return { ok: true as const }
})

// §20 Commit 3 sink-side cancel. Renderer's PIN card "Reject" button (Commit 4 may or may not
// expose this; the spec deferred a UI for v1) calls this to force-clear pending state without
// waiting for expiry. Toggling sink-enabled off also clears via the listener stop path.
ipcMain.handle('parallax:cancelIncomingPair', () => {
  parallaxSinkListener.cancelPending()
  return { ok: true as const }
})

ipcMain.handle('parallax:approveIncomingPair', () => {
  return { ok: parallaxSinkListener.approvePending() }
})

ipcMain.handle('parallax:disconnectSink', async () => {
  return parallaxService.disconnectSink()
})

ipcMain.handle('parallax:publishHostStreamStart', (_event, info: Omit<ParallaxStreamInfo, 'chunkFrames' | 'groupLatencyMs' | 'createdAt'>, options?: ParallaxHostStreamStartOptions) => {
  return parallaxService.publishHostStreamStart(info, options ?? {})
})

// §21 Gapless sink handoff — pre-announce / withdraw / promote the next stream.
ipcMain.handle('parallax:publishHostNextStreamStart', (_event, info: Omit<ParallaxStreamInfo, 'chunkFrames' | 'groupLatencyMs' | 'createdAt'>, options: ParallaxHostNextStreamStartOptions) => {
  return parallaxService.publishHostNextStreamStart(info, options)
})

ipcMain.handle('parallax:publishHostNextStreamCancel', () => {
  parallaxService.publishHostNextStreamCancel()
})

ipcMain.handle('parallax:publishHostPromoteNextStream', () => {
  return parallaxService.publishHostPromoteNextStream()
})

ipcMain.handle('parallax:publishHostAudioChunk', (_event, chunk: ParallaxAudioChunk) => {
  parallaxService.publishHostAudioChunk(chunk)
})

ipcMain.handle('parallax:publishHostTimeline', (_event, timeline: ParallaxTimelineState, options?: ParallaxHostTimelinePublishOptions) => {
  parallaxService.publishHostTimeline(timeline, options ?? {})
})

ipcMain.handle('parallax:publishHostEmitAnchor', (_event, anchor: Parameters<typeof parallaxService.publishHostEmitAnchor>[0]) => {
  parallaxService.publishHostEmitAnchor(anchor)
})

ipcMain.handle('parallax:stopHostStream', () => {
  parallaxService.stopHostStream()
})

ipcMain.handle('parallax:publishSinkTelemetry', async (_event, telemetry: ParallaxSinkTelemetry) => {
  await parallaxService.publishSinkTelemetry(telemetry)
})

ipcMain.handle('parallax:reportHostLatency', (_event, metrics: ParallaxOutputLatencyMetrics) => {
  parallaxService.recordHostLatencyMetrics(metrics)
})

ipcMain.handle('parallax:revokePairedSink', (_event, id: unknown) => {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('Invalid Parallax sink id.')
  }
  return parallaxService.revokePairedSink(id.trim())
})

ipcMain.handle('parallax:renamePairedSink', (_event, id: unknown, name: unknown) => {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('Invalid Parallax sink id.')
  }
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Parallax sink name is required.')
  }
  return parallaxService.renamePairedSink(id.trim(), name)
})

ipcMain.handle('parallax:setSinkPlaybackEnabled', (_event, id: unknown, enabled: unknown) => {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('Invalid Parallax sink id.')
  }
  return parallaxService.setSinkPlaybackEnabled(id.trim(), Boolean(enabled))
})

ipcMain.handle('parallax:setAllSinksPlaybackEnabled', (_event, enabled: unknown) => {
  return parallaxService.setAllSinksPlaybackEnabled(Boolean(enabled))
})

ipcMain.handle('parallax:revokeAllPairedSinks', () => {
  return parallaxService.revokeAllPairedSinks()
})

ipcMain.handle('parallax:clearHostPresenceCache', (_event, sinkId: unknown) => {
  const normalizedSinkId = typeof sinkId === 'string' && sinkId.trim() ? sinkId.trim() : undefined
  return parallaxService.clearHostPresenceCache(normalizedSinkId)
})

ipcMain.handle('parallax:resetToDefaults', async () => {
  const nextConfig: ParallaxHostConfig = {
    enabled: false,
    port: PARALLAX_DEFAULT_PORT
  }
  parallaxService.replacePairedSinks([])
  await persistParallaxPairedSinks([])
  await parallaxService.disconnectSink()
  // §14.1.2. Full reset wipes the sink-side credential too so the next launch starts clean.
  cancelParallaxAutoReconnect()
  await clearParallaxSinkConnection()
  return applyParallaxHostConfig(nextConfig)
})

// §14.1.2 / §16.6 / §16.8. "Forget host" path. Stops any in-flight reconnect, disconnects an
// established connection if any, and wipes the persisted credential. After this the sink is
// back to the initial unpaired state — the only path forward is re-pair via PIN.
ipcMain.handle('parallax:forgetSinkConnection', async () => {
  cancelParallaxAutoReconnect()
  const connectionToForget = parallaxSinkConnection ? { ...parallaxSinkConnection } : null
  if (connectionToForget) {
    await parallaxService.forgetSinkOnHost(connectionToForget).catch((error) => {
      // Best-effort host cleanup. The local forget action must still work when the host is
      // offline, revoked us already, or is an older build without /sink/forget.
      console.warn('Failed to notify Parallax host about sink forget:', error)
    })
  }
  await parallaxService.disconnectSink()
  await clearParallaxSinkConnection()
  broadcastParallaxStatus()
  return parallaxService.getStatus()
})

// §14.1.1. Persist per-sink trim + broadcast to the sink. Renderer validates the basic shape; the
// service guards on `Number.isFinite` and clamps to ±500 ms (§15.1) before persisting.
ipcMain.handle(
  'parallax:setSinkTrim',
  (
    _event,
    sinkId: unknown,
    outputDeviceId: unknown,
    outputDeviceLabel: unknown,
    advanceMs: unknown
  ) => {
    if (typeof sinkId !== 'string' || !sinkId.trim()) {
      throw new Error('Invalid Parallax sink id.')
    }
    if (typeof outputDeviceId !== 'string' || !outputDeviceId.trim()) {
      throw new Error('Invalid Parallax output device id.')
    }
    const label = typeof outputDeviceLabel === 'string' ? outputDeviceLabel : null
    const ms = Number(advanceMs)
    if (!Number.isFinite(ms)) {
      throw new Error('Invalid Parallax trim value.')
    }
    return parallaxService.setSinkTrim(sinkId.trim(), outputDeviceId.trim(), label, ms)
  }
)

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
  const metadata = await loadAudioMetadata(filePath)
  return {
    path: filePath,
    name: basename(filePath),
    metadata: metadata ?? undefined
  }
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
      event.sender.send('audio:progressiveLoadProgress', progress)
      event.sender.send('audio:remoteLoadProgress', progress)
    }
  })
})

ipcMain.handle('audio:getMetadata', async (_event, filePath: string) => {
  return loadAudioMetadata(filePath)
})

ipcMain.handle('audio:getFileStat', async (_event, filePath: string) => {
  if (!filePath || isSubsonicPath(filePath) || isJellyfinPath(filePath)) return null
  try {
    const fileStat = await stat(filePath)
    return {
      size: fileStat.size,
      mtimeMs: Math.round(fileStat.mtimeMs)
    }
  } catch {
    return null
  }
})

// Decode with FFmpeg when WebAudio decodeAudioData cannot handle the codec.
ipcMain.handle('audio:decodeWithFfmpeg', async (_event, filePath: string) => {
  return decodeAudioWithFfmpeg(filePath)
})

// Loudness for playback normalization: stored value or a fresh ffmpeg ebur128 pass.
ipcMain.handle('audio:analyzeTrackLoudness', async (_event, filePath: string) => {
  return analyzeTrackLoudness(filePath, 'interactive')
})

ipcMain.handle('audio:warmupTrackLoudness', async (_event, filePath: string) => {
  return analyzeTrackLoudness(filePath, 'background')
})

ipcMain.handle('audio:storeTrackLoudness', async (_event, filePath: string, payload: RendererTrackLoudnessPayload) => {
  return storeRendererTrackLoudness(filePath, payload)
})

ipcMain.handle('audio:startRemoteStream', async (event, filePath: string, outputSampleRate: number, expectedChannels?: number | null) => {
  return startProgressiveStreamSession(event.sender, filePath, outputSampleRate, expectedChannels)
})

ipcMain.handle('audio:cancelRemoteStream', async (_event, sessionId: number) => {
  await cancelProgressiveStreamSession(sessionId)
})

ipcMain.handle('audio:startProgressiveStream', async (
  event,
  filePath: string,
  outputSampleRate: number,
  expectedChannels?: number | null,
  options?: ProgressiveStreamStartOptions
) => {
  return startProgressiveStreamSession(event.sender, filePath, outputSampleRate, expectedChannels, options)
})

ipcMain.handle('audio:cancelProgressiveStream', async (_event, sessionId: number) => {
  await cancelProgressiveStreamSession(sessionId)
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
  rememberUserChosenSavePath(result.filePath)
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

// Paths this process handed back from a save dialog, which the settings-transfer write
// channel is restricted to. See main/utils/settingsTransferWrite.ts for the rationale.
const userChosenSavePaths = new Set<string>()
const USER_CHOSEN_SAVE_PATH_LIMIT = 32

function rememberUserChosenSavePath(filePath: string): void {
  // Bounded so a session of repeated exports cannot grow this without limit.
  if (userChosenSavePaths.size >= USER_CHOSEN_SAVE_PATH_LIMIT) {
    const oldest = userChosenSavePaths.values().next()
    if (!oldest.done) userChosenSavePaths.delete(oldest.value)
  }
  userChosenSavePaths.add(filePath)
}

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

ipcMain.handle('settings-transfer:writeFile', async (_event, filePath: unknown, content: unknown) => {
  const check = checkSettingsTransferWrite({
    filePath,
    content,
    byteLength: typeof content === 'string' ? Buffer.byteLength(content, 'utf-8') : Number.NaN,
    isUserChosenPath: (candidate) => userChosenSavePaths.has(candidate),
    extensionOf: extname,
  })
  if (!check.ok) throw new Error(check.error)

  await writeFile(filePath as string, content as string, 'utf-8')
  // One dialog grants one write; re-exporting means picking a destination again.
  userChosenSavePaths.delete(filePath as string)
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

ipcMain.handle('library:getTracksByGenre', (_event, genre: string) => {
  return library.getTracksByGenre(genre)
})

ipcMain.handle('library:getTracksByYear', (_event, year: number | null) => {
  return library.getTracksByYear(year)
})

// Get tracks by album
ipcMain.handle('library:getTracksByAlbum', (_event, album: string, artist?: string, identityKey?: string) => {
  return library.getTracksByAlbum(album, artist, identityKey)
})

// Get all artists
ipcMain.handle('library:getArtists', (_event, mode?: library.ArtistBrowseMode) => {
  return library.getArtists(mode)
})

ipcMain.handle('library:getGenres', () => {
  return library.getGenres()
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

interface CompletedDuplicateScanSnapshot {
  runId: string
  groups: IntegrityDuplicateGroup[]
  members: Map<string, IntegrityDuplicateSnapshotMember>
}

let latestDuplicateScanSnapshot: CompletedDuplicateScanSnapshot | null = null

function normalizeIntegrityScanMode(value: unknown): IntegrityScanMode {
  if (value === 'duplicates') return 'duplicates'
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
  duplicateGroups: readonly IntegrityDuplicateGroup[],
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
    duplicateGroups: duplicateGroups.length,
    duplicateFiles: new Set(duplicateGroups.flatMap((group) => group.members.map((member) => member.path))).size,
    exactDuplicateGroups: duplicateGroups.filter((group) => group.evidence === 'exact').length,
    possibleDuplicateGroups: duplicateGroups.filter((group) => group.evidence === 'possible').length,
    mixedDuplicateGroups: duplicateGroups.filter((group) => group.evidence === 'mixed').length,
    canceled,
    startedAt,
    completedAt: Date.now()
  }
}

function buildIntegrityResult(
  runId: string,
  mode: IntegrityScanMode,
  scope: IntegrityScanScope,
  findings: IntegrityFinding[],
  duplicateGroups: IntegrityDuplicateGroup[],
  scanned: number,
  skipped: number,
  canceled: boolean,
  startedAt: number
): IntegrityScanResult {
  return {
    runId,
    summary: buildIntegritySummary(mode, scope, findings, duplicateGroups, scanned, skipped, canceled, startedAt),
    findings,
    duplicateGroups
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
  let duplicateGroups: IntegrityDuplicateGroup[] = []
  let duplicateSnapshots = new Map<string, IntegrityDuplicateSnapshotMember>()
  latestDuplicateScanSnapshot = null

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

    if (mode === 'duplicates') {
      const allTargets = library.getIntegrityScanTrackTargets({ type: 'all' })
      total = allTargets.length
      sendIntegrityScanProgress({
        mode,
        scope,
        current: 0,
        total,
        filePath: getIntegrityScopePath(scope),
        message: total === 0 ? 'No local tracks to compare.' : 'Comparing duplicate candidates across the library...',
        phase: 'duplicates'
      })
      const output = await scanIntegrityDuplicates(allTargets, scope, runId, {
        signal: controller.signal,
        onBattery: isOnBatteryPowerMain(),
        onProgress: (current, progressTotal, filePath, message) => {
          completed = current
          total = progressTotal
          sendIntegrityScanProgress({
            mode,
            scope,
            current,
            total: progressTotal,
            filePath,
            message,
            phase: 'duplicates'
          })
        }
      })
      for (const finding of output.findings) recorder.record(finding)
      duplicateGroups = output.groups
      duplicateSnapshots = output.snapshots
      scanned = output.scanned
      skipped = output.skipped
      completed = scanned + skipped
      total = completed
    } else {
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
          for (const finding of findings) recorder.record(finding)
        } catch (error) {
          if (isIntegrityScanCancelledError(error)) throw error
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
    }
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

  if (!canceled && mode === 'duplicates') {
    latestDuplicateScanSnapshot = {
      runId,
      groups: duplicateGroups,
      members: duplicateSnapshots
    }
  }
  const result = buildIntegrityResult(
    runId,
    mode,
    scope,
    recorder.findings,
    duplicateGroups,
    scanned,
    skipped,
    canceled,
    startedAt
  )
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

function staleDuplicateTrashResult(runId: string, error: string): IntegrityDuplicateTrashResult {
  return {
    runId,
    stale: true,
    error,
    outcomes: [],
    replacements: {},
    remainingGroups: latestDuplicateScanSnapshot?.runId === runId
      ? latestDuplicateScanSnapshot.groups
      : []
  }
}

function refreshDuplicateGroupEvidence(groups: readonly IntegrityDuplicateGroup[]): IntegrityDuplicateGroup[] {
  return groups
    .filter((group) => group.members.length >= 2)
    .map((group) => {
      const exactCounts = new Map<string, number>()
      for (const member of group.members) {
        if (!member.exactSetId) continue
        exactCounts.set(member.exactSetId, (exactCounts.get(member.exactSetId) ?? 0) + 1)
      }
      const members: IntegrityDuplicateGroup['members'] = group.members.map((member) => {
        if (!member.exactSetId || (exactCounts.get(member.exactSetId) ?? 0) < 2) {
          const { exactSetId: _exactSetId, ...rest } = member
          return rest
        }
        return member
      })
      const retainedExactIds = new Set(members.map((member) => member.exactSetId).filter(Boolean))
      const allExact = retainedExactIds.size === 1 && members.every((member) => Boolean(member.exactSetId))
      return {
        ...group,
        evidence: allExact ? 'exact' : retainedExactIds.size > 0 ? 'mixed' : 'possible',
        members
      }
    })
}

async function handleDuplicateTrashRequest(request: IntegrityDuplicateTrashRequest): Promise<IntegrityDuplicateTrashResult> {
  const runId = typeof request?.runId === 'string' ? request.runId.trim() : ''
  const snapshot = latestDuplicateScanSnapshot
  if (!runId || !snapshot || snapshot.runId !== runId) {
    return staleDuplicateTrashResult(runId, 'This duplicate report is no longer current. Run Duplicate Scan again.')
  }
  if (activeIntegrityScanAbortController || activeLibraryScanAbortController) {
    return staleDuplicateTrashResult(runId, 'Wait for the active library operation to finish before moving files to Trash.')
  }
  if (!Array.isArray(request.actions) || request.actions.length === 0) {
    return staleDuplicateTrashResult(runId, 'No duplicate files were selected.')
  }

  const groupById = new Map(snapshot.groups.map((group) => [group.id, group]))
  const normalizedActions: Array<{ groupId: string; keepPath: string; trashPaths: string[] }> = []
  const seenGroups = new Set<string>()
  const selectedPaths = new Set<string>()
  const pathsToValidate = new Set<string>()

  for (const input of request.actions) {
    const groupId = typeof input?.groupId === 'string' ? input.groupId.trim() : ''
    const keepPath = typeof input?.keepPath === 'string' ? input.keepPath.trim() : ''
    const trashPaths = Array.isArray(input?.trashPaths)
      ? Array.from(new Set(input.trashPaths.map((path) => (typeof path === 'string' ? path.trim() : '')).filter(Boolean)))
      : []
    const group = groupById.get(groupId)
    if (!group || seenGroups.has(groupId)) {
      return staleDuplicateTrashResult(runId, 'The duplicate selection does not match this report.')
    }
    seenGroups.add(groupId)
    const memberPaths = new Set(group.members.map((member) => member.path))
    if (!keepPath || !memberPaths.has(keepPath) || trashPaths.length === 0) {
      return staleDuplicateTrashResult(runId, 'Choose one valid Keep file for every selected duplicate group.')
    }
    if (trashPaths.includes(keepPath) || trashPaths.length >= group.members.length) {
      return staleDuplicateTrashResult(runId, 'Astra will not move the Keep file or every member of a duplicate group to Trash.')
    }
    for (const trashPath of trashPaths) {
      if (!memberPaths.has(trashPath) || selectedPaths.has(trashPath)) {
        return staleDuplicateTrashResult(runId, 'The duplicate selection contains an invalid or repeated file.')
      }
      selectedPaths.add(trashPath)
      pathsToValidate.add(trashPath)
    }
    pathsToValidate.add(keepPath)
    normalizedActions.push({ groupId, keepPath, trashPaths })
  }

  const currentTracks = library.getTracksByPaths(Array.from(pathsToValidate))
  const currentByPath = new Map(currentTracks.map((track) => [track.path, track]))
  if (currentByPath.size !== pathsToValidate.size) {
    return staleDuplicateTrashResult(runId, 'One or more duplicate files are no longer indexed. Run Duplicate Scan again.')
  }

  for (const trackPath of pathsToValidate) {
    const current = currentByPath.get(trackPath)
    const original = snapshot.members.get(trackPath)
    if (!current || current.source_type !== 'local' || !original) {
      return staleDuplicateTrashResult(runId, 'Only unchanged local-library files can be moved to Trash from this report.')
    }
    if (current.title !== original.title || current.artist !== original.artist || current.duration !== original.duration) {
      return staleDuplicateTrashResult(runId, 'Track metadata changed after the scan. Run Duplicate Scan again before removing files.')
    }
    try {
      const currentStat = await stat(trackPath)
      if (!currentStat.isFile()
        || currentStat.size !== original.sizeBytes
        || Math.abs(currentStat.mtimeMs - original.modifiedAtMs) > 0.5) {
        return staleDuplicateTrashResult(runId, 'A duplicate file changed after the scan. Run Duplicate Scan again before removing files.')
      }
    } catch {
      return staleDuplicateTrashResult(runId, 'A duplicate file is no longer readable. Run Duplicate Scan again.')
    }
  }

  const outcomes: IntegrityDuplicateTrashResult['outcomes'] = []
  const replacements: Record<string, string> = {}
  let requiresRescan = false

  for (const action of normalizedActions) {
    const trashedPaths: string[] = []
    for (const trashPath of action.trashPaths) {
      try {
        await shell.trashItem(trashPath)
        trashedPaths.push(trashPath)
      } catch (error) {
        outcomes.push({
          path: trashPath,
          keepPath: action.keepPath,
          status: 'failed',
          error: getScanErrorMessage(error)
        })
      }
    }

    if (trashedPaths.length === 0) continue
    try {
      await library.mergeLocalDuplicateTracks(action.keepPath, trashedPaths)
      for (const trashPath of trashedPaths) {
        outcomes.push({ path: trashPath, keepPath: action.keepPath, status: 'trashed' })
        replacements[trashPath] = action.keepPath
        snapshot.members.delete(trashPath)
      }
    } catch (error) {
      requiresRescan = true
      for (const trashPath of trashedPaths) {
        outcomes.push({
          path: trashPath,
          keepPath: action.keepPath,
          status: 'trashed_merge_failed',
          error: getScanErrorMessage(error)
        })
      }
    }
  }

  if (requiresRescan) {
    latestDuplicateScanSnapshot = null
    return {
      runId,
      stale: false,
      error: 'Some files reached Trash, but Astra could not merge their library records. Rescan the library before continuing.',
      outcomes,
      replacements,
      remainingGroups: []
    }
  }

  const successfullyTrashed = new Set(
    outcomes.filter((outcome) => outcome.status === 'trashed').map((outcome) => outcome.path)
  )
  snapshot.groups = refreshDuplicateGroupEvidence(snapshot.groups.map((group) => ({
    ...group,
    members: group.members.filter((member) => !successfullyTrashed.has(member.path))
  })))
  return {
    runId,
    stale: false,
    outcomes,
    replacements,
    remainingGroups: snapshot.groups
  }
}

ipcMain.handle('library:trashIntegrityDuplicates', async (_event, request: IntegrityDuplicateTrashRequest) => {
  return handleDuplicateTrashRequest(request)
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
    return buildIntegrityResult(runId, 'quick', scope, recorder.findings, [], scanned, skipped, false, startedAt)
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

  return buildIntegrityResult(runId, mode, scope, recorder.findings, [], scanned, skipped, false, startedAt)
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

ipcMain.handle('library:setFolderHidden', async (_event, folderPath: string, hidden: boolean) => {
  const updated = await library.setLibraryFolderHidden(folderPath, hidden)
  if (!updated) {
    return { success: false, error: 'Invalid folder path.' }
  }
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

ipcMain.handle('library:getTotalTrackDuration', () => {
  return library.getTotalTrackDuration()
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
  return getArtworkThumbnailDataUrlByHash(hash, {
    maxEdgePx: TRACKLIST_THUMB_MAX_EDGE_PX,
    jpegQuality: TRACKLIST_THUMB_JPEG_QUALITY
  })
})

// Get card-sized artwork thumbnail as data URL
ipcMain.handle('library:getArtworkCardDataUrl', async (_event, hash: string) => {
  return getArtworkThumbnailDataUrlByHash(hash, {
    maxEdgePx: CARD_ARTWORK_MAX_EDGE_PX,
    jpegQuality: CARD_ARTWORK_JPEG_QUALITY
  })
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
  publishCompanionFavoriteEvent(trackPath, true)
})

ipcMain.handle('library:removeFavorite', async (_event, trackPath: string) => {
  await library.removeFavorite(trackPath)
  publishCompanionFavoriteEvent(trackPath, false)
})

// ============================================
// Track Ratings IPC handlers
// ============================================

ipcMain.handle('library:getTrackRatings', () => {
  return library.getTrackRatingEntries()
})

ipcMain.handle('library:setTrackRating', async (_event, trackPaths: string[], rating: number | null) => {
  await library.setTrackRatingForPaths(trackPaths, rating)
})

ipcMain.handle('library:resetTrackRatings', async () => {
  const cleared = await library.resetAllTrackRatings()
  return { success: true, cleared }
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

ipcMain.handle('library:getListeningHistoryStatus', () => {
  return library.getListeningHistoryStatus()
})

ipcMain.handle('library:checkpointListeningSession', async (_event, checkpoint: ListeningSessionCheckpoint) => {
  return library.checkpointListeningSession(checkpoint)
})

ipcMain.handle('library:getListeningStatsDashboard', (_event, query: ListeningStatsQuery) => {
  return library.getListeningStatsDashboard(query)
})

ipcMain.handle('library:clearDetailedListeningHistory', async () => {
  return library.clearDetailedListeningHistory()
})

ipcMain.handle('library:getListeningStatsTransferAvailability', () => {
  return library.getListeningStatsTransferAvailability()
})

ipcMain.handle('library:exportListeningStatsTransfer', (_event, request?: ListeningStatsExportRequest) => {
  return library.exportListeningStatsTransfer(request)
})

ipcMain.handle('library:applyListeningStatsTransfer', async (_event, request: ListeningStatsApplyRequest) => {
  return library.applyListeningStatsTransfer(request)
})

// External listening imports. Parsing happens here rather than in the renderer so the
// format contract has exactly one implementation, and so a hostile file never reaches the
// database without going through it.
ipcMain.handle('library:readListeningImportFile', async (_event, filePath: unknown) => {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('Invalid file path.')
  }
  if (extname(filePath).toLowerCase() !== '.json') {
    throw new Error('Listening import files must be .json.')
  }
  const content = await readFile(filePath, 'utf-8')
  const parsed = parseListeningImportFile(content)
  if (!parsed.ok) return { ok: false as const, error: parsed.error }
  return {
    ok: true as const,
    warnings: parsed.warnings,
    source: parsed.file.source,
    generator: parsed.file.generator,
    trackCount: parsed.file.tracks.length,
    playCount: parsed.file.plays.length,
    eventCount: parsed.file.events.length,
  }
})

ipcMain.handle('library:applyListeningImportFile', async (_event, filePath: unknown) => {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('Invalid file path.')
  }
  if (extname(filePath).toLowerCase() !== '.json') {
    throw new Error('Listening import files must be .json.')
  }
  const parsed = parseListeningImportFile(await readFile(filePath, 'utf-8'))
  if (!parsed.ok) throw new Error(parsed.error)
  return library.applyExternalListeningImport(parsed.file)
})

ipcMain.handle('library:getImportedListeningSources', () => {
  return library.getImportedListeningSources()
})

ipcMain.handle('library:removeImportedListeningSource', async (_event, source: unknown) => {
  if (typeof source !== 'string') throw new Error('Invalid source.')
  return library.removeImportedListeningSource(source)
})

ipcMain.handle('stats-share:copy-png', (_event, input: unknown) => {
  const bytes = validateStatsSharePng(input)
  const image = nativeImage.createFromBuffer(Buffer.from(bytes))
  if (image.isEmpty()) throw new Error('Share-card PNG could not be decoded.')
  clipboard.writeImage(image)
  return true
})

ipcMain.handle('stats-share:save-png', async (_event, input: unknown, suggestedFileName: unknown) => {
  if (!mainWindow) return null
  const bytes = validateStatsSharePng(input)
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Listening Stats',
    defaultPath: normalizeStatsShareFileName(suggestedFileName),
    filters: [{ name: 'PNG Image', extensions: ['png'] }]
  })
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, Buffer.from(bytes))
  return result.filePath
})

ipcMain.handle('signal-share:copy-png', (_event, input: unknown) => {
  const bytes = validateSignalSharePng(input)
  const image = nativeImage.createFromBuffer(Buffer.from(bytes))
  if (image.isEmpty()) throw new Error('Signal PNG could not be decoded.')
  clipboard.writeImage(image)
  return true
})

ipcMain.handle('signal-share:save-png', async (_event, input: unknown, suggestedFileName: unknown) => {
  if (!mainWindow) return null
  const bytes = validateSignalSharePng(input)
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Astra Signal',
    defaultPath: normalizeSignalShareFileName(suggestedFileName),
    filters: [{ name: 'PNG Image', extensions: ['png'] }]
  })
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, Buffer.from(bytes))
  return result.filePath
})

// ============================================
// Playlist IPC handlers
// ============================================

ipcMain.handle('library:getPlaylists', () => {
  return library.getPlaylists()
})

ipcMain.handle('library:createPlaylist', async (_event, name: string) => {
  const playlist = await library.createPlaylist(name)
  publishCompanionPlaylistEvent(playlist.id, 'created')
  return playlist
})

ipcMain.handle('library:createDynamicPlaylist', async (_event, name: string, rules: DynamicPlaylistRulesV1) => {
  const playlist = await library.createDynamicPlaylist(name, rules)
  publishCompanionPlaylistEvent(playlist.id, 'created')
  return playlist
})

ipcMain.handle('library:getDynamicPlaylistRules', (_event, playlistId: number) => {
  return library.getDynamicPlaylistRules(playlistId)
})

ipcMain.handle('library:updateDynamicPlaylistRules', async (_event, playlistId: number, rules: DynamicPlaylistRulesV1) => {
  await library.updateDynamicPlaylistRules(playlistId, rules)
  publishCompanionPlaylistEvent(playlistId, 'items-changed')
})

ipcMain.handle('library:previewDynamicPlaylist', (_event, rules: DynamicPlaylistRulesV1) => {
  return library.previewDynamicPlaylist(rules)
})

ipcMain.handle('library:renamePlaylist', async (_event, id: number, name: string) => {
  await library.renamePlaylist(id, name)
  publishCompanionPlaylistEvent(id, 'renamed')
})

ipcMain.handle('library:deletePlaylist', async (_event, id: number) => {
  await library.deletePlaylist(id)
  publishCompanionPlaylistEvent(id, 'deleted')
})

ipcMain.handle('library:getPlaylistTracks', (_event, playlistId: number) => {
  return library.getPlaylistTracks(playlistId)
})

ipcMain.handle('library:getPlaylistTrackEntries', (_event, playlistId: number) => {
  return library.getPlaylistTrackEntries(playlistId)
})

ipcMain.handle('library:addToPlaylist', async (_event, playlistId: number, trackPaths: string[]) => {
  await library.addToPlaylist(playlistId, trackPaths)
  publishCompanionPlaylistEvent(playlistId, 'items-changed')
})

ipcMain.handle('library:removeFromPlaylist', async (_event, playlistId: number, trackPath: string) => {
  await library.removeFromPlaylist(playlistId, trackPath)
  publishCompanionPlaylistEvent(playlistId, 'items-changed')
})

ipcMain.handle('library:removePlaylistEntry', async (_event, playlistId: number, entryId: number) => {
  await library.removePlaylistEntry(playlistId, entryId)
  publishCompanionPlaylistEvent(playlistId, 'items-changed')
})

ipcMain.handle('library:reassociatePlaylistEntry', async (
  _event,
  playlistId: number,
  entryId: number,
  targetTrackPath: string
) => {
  await library.reassociatePlaylistEntry(playlistId, entryId, targetTrackPath)
  publishCompanionPlaylistEvent(playlistId, 'items-changed')
})

ipcMain.handle('library:reorderPlaylistEntries', async (_event, playlistId: number, orderedEntryIds: number[]) => {
  await library.reorderPlaylistEntries(playlistId, orderedEntryIds)
  publishCompanionPlaylistEvent(playlistId, 'items-changed')
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
  artworkHash?: string
  artwork?: string
  channels?: number
  codec?: string
  codecProfile?: string
  isAtmosJoc?: boolean
  isIamf?: boolean
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
  startTimeSeconds: number
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
  releaseSenderHooks: (() => void) | null
}

function resolveRemoteTrackDurationSeconds(filePath: string): number | null {
  const track = library.getTrackByPath(filePath)
  if (!track) return null
  return typeof track.duration === 'number' && Number.isFinite(track.duration) && track.duration > 0
    ? track.duration
    : null
}

function resolveProgressiveStreamSourceType(filePath: string): RemoteStreamSourceType {
  if (isSubsonicPath(filePath)) return 'subsonic'
  if (isJellyfinPath(filePath)) return 'jellyfin'
  return 'local'
}

function normalizeProgressiveStartTimeSeconds(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return numeric
}

function buildRemoteLoadProgress(
  session: Pick<
    RemoteStreamSession,
    'filePath' | 'sourceType' | 'startTimeSeconds' | 'loadedBytes' | 'totalBytes' | 'chunkCount' | 'decodedFrames' | 'sampleRate' | 'durationSeconds' | 'done' | 'failed'
  >,
  stage: RemoteAudioLoadProgress['stage']
): RemoteAudioLoadProgress {
  const percent = session.totalBytes && session.totalBytes > 0
    ? Math.max(0, Math.min(1, session.loadedBytes / session.totalBytes))
    : null
  const decodedSeconds = session.sampleRate > 0 ? session.decodedFrames / session.sampleRate : 0
  const bufferedSeconds = session.sourceType === 'local'
    ? session.startTimeSeconds + decodedSeconds
    : decodedSeconds
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
  const progress = buildRemoteLoadProgress(session, stage)
  session.sender.send('audio:progressiveLoadProgress', progress)
  if (session.sourceType !== 'local') {
    session.sender.send('audio:remoteLoadProgress', progress)
  }
}

function safeSendRemoteStreamEvent(session: RemoteStreamSession, payload: RemoteStreamEvent): void {
  if (session.sender.isDestroyed()) return
  session.sender.send('audio:progressiveStreamEvent', payload)
  if (session.sourceType !== 'local') {
    session.sender.send('audio:remoteStreamEvent', payload)
  }
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
      startTimeSeconds: session.startTimeSeconds,
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
  session.chunkCount += 1
  const payload: RemoteStreamChunk = {
    sessionId: session.id,
    path: session.filePath,
    sourceType: session.sourceType,
    sampleRate: session.sampleRate,
    channels: session.channels,
    frameCount,
    pcmData: toStandaloneArrayBuffer(data),
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
      durationSeconds: session.durationSeconds,
      startTimeSeconds: session.startTimeSeconds
    })
    settleRemoteStreamStartup(session, { ok: true })
  } else {
    session.sender.send('audio:progressiveStreamChunk', payload)
    if (session.sourceType !== 'local') {
      session.sender.send('audio:remoteStreamChunk', payload)
    }
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

  session.releaseSenderHooks?.()
  session.releaseSenderHooks = null

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
        error: new Error('Progressive stream produced no decodable audio.')
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

  const failure = error ?? new Error(outcome === 'cancelled' ? 'Progressive stream was cancelled.' : 'Progressive stream failed.')
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

  while (true) {
    const chunkFrames = session.sourceType === 'local'
      ? session.decodedFrames >= Math.floor(session.sampleRate * LOCAL_STREAM_STEADY_AFTER_SECONDS)
        ? LOCAL_STREAM_STEADY_CHUNK_FRAMES
        : LOCAL_STREAM_STARTUP_CHUNK_FRAMES
      : REMOTE_STREAM_CHUNK_FRAMES
    const chunkSizeBytes = chunkFrames * frameSizeBytes
    if (session.stdoutRemainder.length < chunkSizeBytes) break

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

async function startProgressiveStreamSession(
  sender: Electron.WebContents,
  filePath: string,
  outputSampleRate: number,
  expectedChannels?: number | null,
  options: ProgressiveStreamStartOptions = {}
): Promise<RemoteStreamInfo> {
  const ffmpegPath = await resolveBinary('ffmpeg')
  if (!ffmpegPath) {
    throw new Error('FFmpeg could not be resolved for progressive streaming.')
  }

  const sourceType = resolveProgressiveStreamSourceType(filePath)
  const requestedStartTimeSeconds = sourceType === 'local'
    ? normalizeProgressiveStartTimeSeconds(options.startTimeSeconds)
    : 0
  const normalizedSampleRate = Number.isFinite(outputSampleRate) && outputSampleRate > 0
    ? Math.max(8_000, Math.round(outputSampleRate))
    : 48_000
  const dbTrack = library.getTrackByPath(filePath)
  const normalizedChannels = Number.isFinite(expectedChannels)
    ? Math.max(1, Math.min(8, Math.round(Number(expectedChannels))))
    : Math.max(1, Math.min(8, dbTrack?.channels ?? 2))
  const abortController = new AbortController()

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let totalBytes: number | null = null
  if (sourceType === 'local') {
    totalBytes = null
  } else {
    const { response } = await openRemoteStreamResponse(filePath, abortController.signal)
    reader = response.body?.getReader() ?? null
    if (!reader) {
      throw new Error('Remote stream response body was not readable.')
    }

    const contentLengthHeader = response.headers.get('content-length')
    const parsedContentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : Number.NaN
    totalBytes = Number.isFinite(parsedContentLength) && parsedContentLength > 0 ? parsedContentLength : null
  }

  const ffmpegInputArgs = sourceType === 'local'
    ? [
        ...(requestedStartTimeSeconds > 0 ? ['-ss', String(requestedStartTimeSeconds)] : []),
        '-i', filePath
      ]
    : ['-i', 'pipe:0']
  const ffmpeg = spawn(
    ffmpegPath,
    [
      '-v', 'error',
      '-nostdin',
      ...ffmpegInputArgs,
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
      startTimeSeconds: requestedStartTimeSeconds,
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
      stdinClosed: false,
      releaseSenderHooks: null
    }

    remoteStreamSessions.set(session.id, session)

    // Tear the session down if the renderer goes away mid-stream (window
    // closed or reloaded); otherwise ffmpeg keeps decoding for nothing.
    const handleSenderDestroyed = (): void => {
      finalizeRemoteStreamSession(session, 'cancelled')
    }
    const handleSenderNavigation = (
      _event: Electron.Event,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame || isInPlace) return
      finalizeRemoteStreamSession(session, 'cancelled')
    }
    sender.once('destroyed', handleSenderDestroyed)
    sender.on('did-start-navigation', handleSenderNavigation)
    session.releaseSenderHooks = () => {
      try {
        sender.removeListener('destroyed', handleSenderDestroyed)
        sender.removeListener('did-start-navigation', handleSenderNavigation)
      } catch {
        // Listener removal can race with sender teardown.
      }
    }

    safeSendRemoteLoadProgress(session, sourceType === 'local' ? 'streaming' : 'downloading', true)

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
        error instanceof Error ? error : new Error('Progressive FFmpeg input pipe failed.')
      )
    })

    ffmpeg.stdout.on('data', (data: Buffer) => {
      pumpRemoteStreamOutput(session, data)
    })

    ffmpeg.stdout.on('end', () => {
      flushRemoteStreamOutput(session)
    })

    ffmpeg.on('error', (error) => {
      finalizeRemoteStreamSession(session, 'failed', error instanceof Error ? error : new Error('Progressive FFmpeg process failed.'))
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
          ? `Progressive stream decode failed: ${stderr}`
          : `Progressive stream decode failed (ffmpeg exit ${code ?? 'unknown'}).`
      ))
    })

    if (sourceType === 'local') {
      try {
        if (!ffmpeg.stdin.destroyed) {
          ffmpeg.stdin.end()
        }
      } catch {
        // FFmpeg reads local files directly; stdin is intentionally unused.
      }
    } else if (reader) {
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value || value.byteLength === 0) continue

            session.loadedBytes += value.byteLength
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
    }
  })

  return infoPromise
}

async function cancelProgressiveStreamSession(sessionId: number): Promise<void> {
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
    return toStandaloneArrayBuffer(decoded)
  } catch (error) {
    console.warn(`FFmpeg compatibility decode failed for ${filePath}:`, error)
    return null
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

interface TrackLoudnessAnalysisResult {
  loudnessLufs: number
  peakLinear: number | null
  method: string
}

interface RendererTrackLoudnessPayload {
  loudnessLufs: number
  peakLinear?: number | null
  method?: string
}

const LOUDNESS_FFMPEG_TIMEOUT_MS = 180_000
// The ebur128 filter logs a running line per 100ms of audio, so stderr for an
// hour-long track runs to a few MB.
const LOUDNESS_FFMPEG_MAX_STDERR_BYTES = 32 * 1024 * 1024

type LoudnessAnalysisPriority = 'interactive' | 'background'

interface LoudnessAnalysisJob {
  filePath: string
  fileStat: { size: number; mtimeMs: number }
  priority: LoudnessAnalysisPriority
  abortController: AbortController
  resolve: (result: TrackLoudnessAnalysisResult | null) => void
  reject: (error: unknown) => void
}

const loudnessAnalysisInFlight = new Map<string, Promise<TrackLoudnessAnalysisResult | null>>()
const loudnessAnalysisQueue: LoudnessAnalysisJob[] = []
let activeLoudnessAnalysisJob: LoudnessAnalysisJob | null = null

function execFileCaptureStderr(
  command: string,
  args: string[],
  options: ExecFileOptions = {},
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        ...options,
        ...(signal ? { signal } : {}),
        encoding: 'utf8',
        windowsHide: true
      },
      (error, _stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stderr ?? '')
      }
    )
  })
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const maybeError = error as { name?: unknown; code?: unknown }
  return maybeError.name === 'AbortError' || maybeError.code === 'ABORT_ERR'
}

async function statForLoudness(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stats = await stat(filePath)
    return { size: stats.size, mtimeMs: Math.round(stats.mtimeMs) }
  } catch {
    return null
  }
}

// Parse the summary block ffmpeg's ebur128 filter prints at the end of stderr.
// Only summary lines start with the bare "I:"/"Peak:" labels; the per-frame
// progress lines embed them mid-line. Use the last match to be safe.
function parseEbur128Summary(stderr: string): { loudnessLufs: number; peakLinear: number | null } | null {
  const integratedMatches = [...stderr.matchAll(/^\s+I:\s+(-?[\d.]+)\s+LUFS\s*$/gm)]
  const lastIntegrated = integratedMatches[integratedMatches.length - 1]
  if (!lastIntegrated) return null
  const loudnessLufs = Number(lastIntegrated[1])
  if (!Number.isFinite(loudnessLufs)) return null

  const peakMatches = [...stderr.matchAll(/^\s+Peak:\s+(-?[\d.]+|-?inf)\s+dBFS\s*$/gm)]
  const lastPeak = peakMatches[peakMatches.length - 1]
  let peakLinear: number | null = null
  if (lastPeak) {
    if (lastPeak[1] === '-inf') {
      peakLinear = 0
    } else {
      const peakDb = Number(lastPeak[1])
      if (Number.isFinite(peakDb)) {
        peakLinear = Math.pow(10, peakDb / 20)
      }
    }
  }

  return { loudnessLufs, peakLinear }
}

// Resolve a track's integrated loudness for playback normalization: stored DB
// value when fresh, otherwise a single queued ffmpeg ebur128 pass (native
// decode+analysis in a separate process, parallel to the renderer's decode).
async function runLoudnessAnalysisJob(job: LoudnessAnalysisJob): Promise<TrackLoudnessAnalysisResult | null> {
  const ffmpegPath = await resolveBinary('ffmpeg')
  if (!ffmpegPath || job.abortController.signal.aborted) return null

  const startMs = Date.now()
  try {
    const stderr = await execFileCaptureStderr(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostats',
        '-i', job.filePath,
        '-map', '0:a:0',
        '-vn',
        '-af', 'ebur128=peak=sample',
        '-f', 'null', '-'
      ],
      { timeout: LOUDNESS_FFMPEG_TIMEOUT_MS, maxBuffer: LOUDNESS_FFMPEG_MAX_STDERR_BYTES },
      job.abortController.signal
    )
    const parsed = parseEbur128Summary(stderr)
    if (!parsed) {
      console.warn(`Loudness analysis produced no summary for ${job.filePath}`)
      return null
    }

    await library.setTrackLoudness({
      trackPath: job.filePath,
      loudnessLufs: parsed.loudnessLufs,
      peakLinear: parsed.peakLinear,
      method: 'ebur128',
      fileSize: job.fileStat.size,
      fileMtimeMs: job.fileStat.mtimeMs
    })
    if (isDev) {
      console.log(`[loudness] ebur128 analysis (${Date.now() - startMs}ms): ${parsed.loudnessLufs} LUFS`, job.filePath)
    }
    return { loudnessLufs: parsed.loudnessLufs, peakLinear: parsed.peakLinear, method: 'ebur128' }
  } catch (error) {
    if (isAbortError(error) || job.abortController.signal.aborted) {
      return null
    }
    console.warn(`Loudness analysis failed for ${job.filePath}:`, error)
    return null
  }
}

function pumpLoudnessAnalysisQueue(): void {
  if (activeLoudnessAnalysisJob) return
  const job = loudnessAnalysisQueue.shift()
  if (!job) return

  activeLoudnessAnalysisJob = job
  void runLoudnessAnalysisJob(job)
    .then(job.resolve, job.reject)
    .finally(() => {
      if (activeLoudnessAnalysisJob === job) {
        activeLoudnessAnalysisJob = null
      }
      pumpLoudnessAnalysisQueue()
    })
}

function enqueueLoudnessAnalysisJob(
  filePath: string,
  fileStat: { size: number; mtimeMs: number },
  priority: LoudnessAnalysisPriority
): Promise<TrackLoudnessAnalysisResult | null> {
  const existing = loudnessAnalysisInFlight.get(filePath)
  if (existing) return existing

  const abortController = new AbortController()
  const promise = new Promise<TrackLoudnessAnalysisResult | null>((resolve, reject) => {
    const job: LoudnessAnalysisJob = {
      filePath,
      fileStat,
      priority,
      abortController,
      resolve,
      reject
    }

    if (priority === 'interactive') {
      loudnessAnalysisQueue.unshift(job)
      if (
        activeLoudnessAnalysisJob
        && activeLoudnessAnalysisJob.priority === 'background'
        && activeLoudnessAnalysisJob.filePath !== filePath
      ) {
        activeLoudnessAnalysisJob.abortController.abort()
      }
    } else {
      loudnessAnalysisQueue.push(job)
    }

    pumpLoudnessAnalysisQueue()
  }).finally(() => {
    loudnessAnalysisInFlight.delete(filePath)
  })

  loudnessAnalysisInFlight.set(filePath, promise)
  return promise
}

async function analyzeTrackLoudness(
  filePath: string,
  priority: LoudnessAnalysisPriority = 'interactive'
): Promise<TrackLoudnessAnalysisResult | null> {
  if (!filePath || isSubsonicPath(filePath) || isJellyfinPath(filePath)) return null

  const fileStat = await statForLoudness(filePath)
  if (!fileStat) return null

  const stored = library.getTrackLoudness(filePath)
  if (stored) {
    const matchesFile = (stored.fileSize == null || stored.fileSize === fileStat.size)
      && (stored.fileMtimeMs == null || stored.fileMtimeMs === fileStat.mtimeMs)
    if (matchesFile) {
      return {
        loudnessLufs: stored.loudnessLufs,
        peakLinear: stored.peakLinear,
        method: stored.method
      }
    }
    await library.deleteTrackLoudness(filePath)
  }

  const inFlight = loudnessAnalysisInFlight.get(filePath)
  if (inFlight) return inFlight
  // The bundled ffmpeg (6.0) cannot read IAMF, so skip the doomed ebur128
  // spawn; the renderer's buffer-based analyzer computes and stores loudness
  // after the wasm decode instead (returned from the DB above on later plays).
  if (extname(filePath).toLowerCase() === '.iamf') return null
  return enqueueLoudnessAnalysisJob(filePath, fileStat, priority)
}

// Persist a loudness value the renderer computed via its JS fallback analyzer.
async function storeRendererTrackLoudness(filePath: string, payload: RendererTrackLoudnessPayload): Promise<boolean> {
  if (!filePath || isSubsonicPath(filePath) || isJellyfinPath(filePath)) return false
  if (typeof payload?.loudnessLufs !== 'number' || !Number.isFinite(payload.loudnessLufs)) return false

  const fileStat = await statForLoudness(filePath)
  await library.setTrackLoudness({
    trackPath: filePath,
    loudnessLufs: payload.loudnessLufs,
    peakLinear: typeof payload.peakLinear === 'number' && Number.isFinite(payload.peakLinear) ? payload.peakLinear : null,
    method: typeof payload.method === 'string' && payload.method.length > 0 ? payload.method : 'kweight-ungated',
    fileSize: fileStat?.size ?? null,
    fileMtimeMs: fileStat?.mtimeMs ?? null
  })
  return true
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
          format: payload.track?.format ?? dbTrack?.format ?? parsed.format,
          artworkHash: parsed.artworkHash ?? dbTrack?.artwork_hash ?? undefined,
          artwork: parsed.artworkHash || dbTrack?.artwork_hash ? undefined : parsed.artwork
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
      artworkHash: dbTrack.artwork_hash ?? undefined,
      channels: dbTrack.channels ?? undefined,
      codec: dbTrack.codec ?? undefined,
      codecProfile: dbTrack.codec_profile ?? undefined,
      isAtmosJoc: dbTrack.is_atmos_joc === 1,
      isIamf: dbTrack.is_iamf === 1,
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
  const cachedDbTrack = library.getTrackByPath(filePath)

  // Extract metadata using music-metadata with ffprobe enrichment fallback.
  let metadata: LoadedAudioMetadata = {
    title: fallbackTitle,
    artist: 'Unknown Artist',
    album: 'Unknown Album',
    format
  }

  // IAMF (Eclipsa) sources: neither music-metadata nor the bundled ffprobe
  // (6.0) can read them; duration comes from the OBU walker / moov and
  // channels from the fixed 7.1.4 decode target.
  if (format === 'iamf') {
    try {
      const stats = collectIamfStreamStats(new Uint8Array(await readFile(filePath)))
      if (stats?.durationSeconds) metadata.duration = stats.durationSeconds
    } catch {
      // Filename-only metadata; playback surfaces the real error.
    }
    metadata.channels = 12
    metadata.codec = 'iamf'
    metadata.isIamf = true
    return metadata
  }
  if (format === 'mp4') {
    const moov = await library.readMp4MoovBox(filePath)
    if (moov && mp4HasIamfTrack(moov)) {
      metadata.duration = readMp4DurationSeconds(moov) ?? undefined
      metadata.channels = 12
      metadata.codec = 'iamf'
      metadata.isIamf = true
      return metadata
    }
    // Non-IAMF .mp4 falls through to the regular parsers (dialog-opened
    // files only; the library scanner rejects them).
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

    // Prefer cached artwork hashes so currentTrack does not retain large data URLs.
    let artworkHash = cachedDbTrack?.artwork_hash ?? undefined
    let artworkDataUrl: string | undefined
    if (!artworkHash && common.picture && common.picture.length > 0) {
      const pic = common.picture[0]
      const pictureData = Buffer.from(pic.data)
      artworkHash = (await library.cacheArtworkBuffer(pictureData, pic.format)) ?? undefined
      if (!artworkHash) {
        const base64 = pictureData.toString('base64')
        artworkDataUrl = `data:${pic.format};base64,${base64}`
      }
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
      artworkHash,
      artwork: artworkDataUrl,
      channels: mm_metadata.format.numberOfChannels,
      codec: mm_metadata.format.codec,
      codecProfile: mm_metadata.format.codecProfile,
      isAtmosJoc: isAtmosJocStream(mm_metadata.format.codec, mm_metadata.format.codecProfile),
      replayGainTrackDb: replayGainScanEnabled
        ? (replayGain.trackGainDb ?? undefined)
        : undefined,
      replayGainAlbumDb: replayGainScanEnabled
        ? (replayGain.albumGainDb ?? undefined)
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

// readFile allocates an exact-size, non-pooled Buffer for anything >= Buffer.poolSize / 2
// (4KB), so audio payloads can hand out the underlying ArrayBuffer without a full copy.
function toStandaloneArrayBuffer(buffer: Buffer): ArrayBuffer {
  const underlying = buffer.buffer as ArrayBuffer
  return buffer.byteOffset === 0 && buffer.byteLength === underlying.byteLength
    ? underlying
    : underlying.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
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
        data: toStandaloneArrayBuffer(buffer)
      }
    }

    const metadata = await loadAudioMetadata(filePath)

    const payload = {
      path: filePath,
      name: name,
      data: toStandaloneArrayBuffer(buffer),
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
