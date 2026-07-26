import * as mm from 'music-metadata'
import { app, powerMonitor } from 'electron'
import { join, extname, basename, dirname, isAbsolute as isAbsolutePath, normalize as normalizePath, resolve as resolvePath, relative as relativePath, sep as pathSep } from 'path'
import { readdir, stat, mkdir, writeFile, readFile, access, rm, mkdtemp, copyFile, open } from 'fs/promises'
import type { Stats } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { execFile, type ExecFileOptions } from 'child_process'
import { tmpdir, cpus } from 'os'
import { createRequire } from 'module'
import { parsePlaylistDocument, type ParsedPlaylistEntry, type PlaylistImportDetectedFormat } from './playlistImport'
import {
  normalizePlaylistPathForLookup,
  resolveImportedPlaylistEntryPaths,
  stripPlaylistEntryOuterQuotes
} from './playlistPathResolver'
import { getMusicMetadataParseOptions } from '../utils/musicMetadata'
import { collectIamfStreamStats } from '../../shared/iamf/obuWalker'
import { mp4HasIamfTrack, readMp4DurationSeconds } from '../../shared/iamf/mp4'
import {
  buildAlbumIdentityKeyByTrackId,
  buildCanonicalAlbumIdentityKey,
  buildAlbumIdentityKeyFromTrack as buildFallbackAlbumIdentityKeyFromTrack,
  groupTracksByAlbumIdentity,
  type AlbumGroupingMode
} from '../../shared/library/albumGrouping'
import {
  isAlbumGroupEligible,
  type AlbumEligibilityOptions
} from '../../shared/library/albumEligibility'
import {
  getArtistImageKey,
  isSupportedArtistImageExtension,
  pickBestArtistImageCandidate,
  resolveArtistArtwork,
  type ArtistArtworkSource,
  type ArtistImageCandidate
} from '../../shared/library/artistImages'
import {
  deserializeArtistNames,
  formatArtistNames,
  normalizeArtistNames,
  serializeArtistNames
} from '../../shared/library/artistCredits'
import { buildTrackSyncKey, normalizeSyncKeyPart } from '../../shared/sync/identity'
import type {
  SyncFavorite,
  SyncKeyTombstone,
  SyncPlaylist,
  SyncPlaylistEntry,
  SyncUidTombstone
} from '../../types/phoneSync'
import {
  createDefaultDynamicPlaylistRules,
  normalizeDynamicPlaylistRules,
  type DynamicPlaylistCondition,
  type DynamicPlaylistDateField,
  type DynamicPlaylistNumericField,
  type DynamicPlaylistRulesV1,
  type DynamicPlaylistSortField,
  type DynamicPlaylistTextField,
  type PlaylistKind
} from '../../shared/playlists/dynamicPlaylist'
import { normalizeTrackRating, type TrackRatingEntry } from '../../shared/ratings/trackRating'
import {
  LISTENING_STATS_TRANSFER_VERSION,
  createEmptyListeningStatsImportResult,
  createStatsTransferTrackDictionary,
  decodeListeningCountsPayload,
  decodeListeningHistoryPayload,
  encodeListeningCountsPayload,
  encodeListeningHistoryPayload,
  shouldReplaceRating,
  type ListeningCountsPayload,
  type ListeningHistoryPayload,
  type ListeningStatsImportResult,
  type StatsTransferFavoriteTuple,
  type StatsTransferPlayTuple,
  type StatsTransferRatingTuple,
  type StatsTransferSegmentTuple,
  type StatsTransferSessionTuple,
  type StatsTransferTrackIdentity,
  type StatsTransferTrackTuple
} from '../../shared/stats/statsTransfer'
import {
  importOriginId,
  importSessionKey,
  isValidImportSource,
  type ListeningImportFile
} from '../../shared/stats/listeningImportFile'
import {
  isAlbumNewForLatestSync,
  isTrackNewForLatestSync,
  type LatestLibrarySyncSummary
} from './libraryLatestSync'
import { sanitizeLyricsLines } from './lyricsParsing'
import type { LyricsFormat, LyricsLine, LyricsProvider } from '../../types/lyrics'
import type {
  JellyfinSourceLastStatus,
  SubsonicSourceLastStatus,
  TrackSourceType
} from '../../types/subsonic'
import type { IntegrityScanScope } from '../../types/libraryIntegrity'
import type {
  ListeningHistoryStatus,
  ListeningSessionCheckpoint,
  ListeningSessionCheckpointResult,
  ImportedListeningSource,
  ImportedListeningSourceRemoval,
  ListeningStatsActivityBucket,
  ListeningStatsApplyRequest,
  ListeningStatsBucketGranularity,
  ListeningStatsDashboard,
  ListeningStatsExportBundle,
  ListeningStatsExportRequest,
  ListeningStatsQuery,
  ListeningStatsTransferAvailability,
  ListeningStatsRange,
  ListeningStatsRankedAlbum,
  ListeningStatsRankedArtist,
  ListeningStatsRankedTrack,
  ListeningStatsRankingMetric
} from '../../types/listeningStats'
import {
  filterIntegrityTargetsByScope,
  type IntegrityScanTrackTarget
} from './libraryIntegrity'
import { extractReplayGainDb } from '../utils/replayGain'

interface BetterSqliteDatabaseConstructor {
  new(filename: string, options?: { timeout?: number; fileMustExist?: boolean }): BetterSqliteDatabase
}

interface BetterSqliteDatabase {
  inTransaction: boolean
  prepare(sql: string): BetterSqliteStatement
  exec(sql: string): BetterSqliteDatabase
  pragma(sql: string): unknown
  function(name: string, options: { deterministic?: boolean; varargs?: boolean }, fn: (...args: unknown[]) => unknown): BetterSqliteDatabase
  close(): BetterSqliteDatabase
}

interface BetterSqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  iterate(...params: unknown[]): IterableIterator<unknown>
}

const require = createRequire(import.meta.url)
const BetterSqliteDatabase = require('better-sqlite3') as BetterSqliteDatabaseConstructor

// Supported audio extensions
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.wav', '.ogg', '.aac', '.m4a',
  '.opus', '.wma', '.aiff', '.alac', '.ape', '.wv',
  // Eclipsa Audio: standalone IAMF bitstreams, and IAMF-in-MP4 (only .mp4
  // files with an IAMF audio track are indexed — see extractMetadata).
  '.iamf', '.mp4'
])
const FOLDER_ARTWORK_BASENAME_PRIORITY = [
  'cover',
  'folder',
  'front',
  'album',
  'artwork',
  'albumart'
] as const
const FOLDER_ARTWORK_EXTENSION_PRIORITY = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp'
] as const
const FOLDER_ARTWORK_BASENAME_RANK = new Map<string, number>(
  FOLDER_ARTWORK_BASENAME_PRIORITY.map((name, index) => [name, index])
)
const FOLDER_ARTWORK_EXTENSION_RANK = new Map<string, number>(
  FOLDER_ARTWORK_EXTENSION_PRIORITY.map((extension, index) => [extension, index])
)
const LISTENING_HISTORY_GENERATION_META_KEY = 'listening_history_generation_v1'
const LISTENING_HISTORY_STARTED_AT_META_KEY = 'listening_history_started_at_v1'
// Identifies this install as the origin of the play counts it records, so counts from
// several machines can be summed without any of them being counted twice.
const INSTALL_ID_META_KEY = 'install_id_v1'
const PLAY_ORIGIN_BACKFILL_META_KEY = 'track_play_origins_backfilled_v1'
const LISTENING_STATS_TOP_LIMIT = 10

export interface DbTrack {
  id: number
  path: string
  album_identity_key?: string
  is_new: boolean
  title: string
  artist: string
  artist_names: string[]
  album: string
  album_artist: string | null
  album_artist_names: string[]
  duration: number
  track_number: number | null
  disc_number: number | null
  year: number | null
  genre: string | null
  genres: string[]
  artwork_hash: string | null
  base_artwork_hash?: string | null
  format: string
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  codec: string | null
  codec_profile: string | null
  is_atmos_joc: number | null
  is_iamf?: number | null
  replaygain_track_gain_db: number | null
  replaygain_album_gain_db: number | null
  bpm: number | null
  musical_key: string | null
  source_type: TrackSourceType
  source_id: number | null
  source_track_id: string | null
  source_path: string | null
  is_available: number
  availability_reason: string | null
  file_created_at: number | null
  play_count: number
  last_played_at: number | null
  added_at: number
  modified_at: number
}

export interface LibraryTrackPageRequest {
  offset?: number
  limit?: number
}

export interface LibraryTrackPage {
  tracks: DbTrack[]
  offset: number
  limit: number
  total: number
  nextOffset: number
  hasMore: boolean
}

interface DbTrackRow extends Omit<DbTrack, 'is_new' | 'artist_names' | 'album_artist_names' | 'genres'> {
  artist_names_json: string | null
  album_artist_names_json: string | null
  genre_names_json: string | null
  sync_session_key: string | null
  latest_sync_dismissed_at: number | null
}

export interface SubsonicSourceRow {
  id: number
  name: string
  base_url: string
  username: string
  secret_encrypted: string
  enabled: number
  last_status: SubsonicSourceLastStatus
  last_error: string | null
  last_sync_at: number | null
  last_checked_at: number | null
  created_at: number
  updated_at: number
}

export interface SubsonicSourcePublic {
  id: number
  name: string
  base_url: string
  username: string
  enabled: number
  last_status: SubsonicSourceLastStatus
  last_error: string | null
  last_sync_at: number | null
  last_checked_at: number | null
  created_at: number
  updated_at: number
  has_stored_secret: boolean
}

export interface JellyfinSourceRow {
  id: number
  name: string
  base_url: string
  username: string
  secret_encrypted: string
  enabled: number
  last_status: JellyfinSourceLastStatus
  last_error: string | null
  last_sync_at: number | null
  last_checked_at: number | null
  created_at: number
  updated_at: number
}

export interface JellyfinSourcePublic {
  id: number
  name: string
  base_url: string
  username: string
  enabled: number
  last_status: JellyfinSourceLastStatus
  last_error: string | null
  last_sync_at: number | null
  last_checked_at: number | null
  created_at: number
  updated_at: number
  has_stored_secret: boolean
}

export interface SubsonicTrackUpsertInput {
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
  genres?: readonly string[] | null
  artwork_hash: string | null
  format: string
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  codec: string | null
  codec_profile: string | null
  is_atmos_joc: number | null
  is_iamf?: number | null
  replaygain_track_gain_db: number | null
  replaygain_album_gain_db: number | null
  bpm: number | null
  musical_key: string | null
  source_track_id: string
  source_path: string | null
}

export interface SubsonicRemotePlaylistSyncInput {
  source_playlist_id: string
  name: string
  tracks: Array<{
    path: string
    title?: string | null
    artist?: string | null
    album?: string | null
  }>
}

export interface JellyfinTrackUpsertInput {
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
  genres?: readonly string[] | null
  artwork_hash: string | null
  format: string
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  codec: string | null
  codec_profile: string | null
  is_atmos_joc: number | null
  is_iamf?: number | null
  replaygain_track_gain_db: number | null
  replaygain_album_gain_db: number | null
  bpm: number | null
  musical_key: string | null
  source_track_id: string
  source_path: string | null
}

export interface LibraryFolder {
  id: number
  path: string
  added_at: number
  hidden: number
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
  audioFileCount: number
}

export type LyricsCacheStatus = 'hit' | 'not_found'
export type LyricsCacheSource = 'embedded' | 'lrclib' | 'xlrcdb'

export interface LyricsCacheEntry {
  trackPath: string
  metadataSignature: string
  status: LyricsCacheStatus
  source: LyricsCacheSource
  provider: LyricsProvider | null
  format: LyricsFormat
  plainLyrics: string | null
  syncedLyrics: string | null
  syncedLines: LyricsLine[]
  updatedAt: number
}

export interface LyricsCacheUpsertInput {
  trackPath: string
  metadataSignature: string
  status: LyricsCacheStatus
  source: LyricsCacheSource
  provider: LyricsProvider | null
  plainLyrics: string | null
  syncedLyrics: string | null
  syncedLines: LyricsLine[]
  updatedAt?: number
}

export interface LyricsTrackOverrideEntry {
  trackPath: string
  format: LyricsFormat
  plainLyrics: string | null
  syncedLyrics: string | null
  syncedLines: LyricsLine[]
  syncOffsetMs: number
  updatedAt: number
}

export interface LyricsTrackManualInput {
  format: LyricsFormat
  plainLyrics: string | null
  syncedLyrics: string | null
  syncedLines: LyricsLine[]
}

export interface Playlist {
  id: number
  name: string
  kind: PlaylistKind
  created_at: number
  updated_at: number
  last_played_at: number | null
  custom_cover_hash: string | null
  auto_cover_hash: string | null
  track_count: number
  missing_track_count: number
}

export interface CompanionApiPlaylistTarget {
  id: number
  name: string
  kind: PlaylistKind
  remote_source_id: number | null
  artwork_hash: string | null
}

export interface PlaylistTrackEntry {
  id: number
  track_path: string
  position: number
  added_at: number
  missing: boolean
  title: string | null
  artist: string | null
  album: string | null
  track: DbTrack | null
}

export interface DynamicPlaylistPreview {
  track_count: number
  tracks: DbTrack[]
}

export interface ArtistRecord {
  artist: string
  track_count: number
  primary_track_count: number
  album_count: number
  artwork_hash: string | null
  artwork_source: ArtistArtworkSource
}

export interface GenreRecord {
  genre: string
  track_count: number
  album_count: number
  artwork_hash: string | null
}

export interface PlaylistImportResult {
  sourceFilePath: string
  detectedFormat: PlaylistImportDetectedFormat
  playlistId: number | null
  playlistName: string | null
  entriesTotal: number
  importedCount: number
  missingEntryCount: number
  matchedByPathCount: number
  matchedByMetadataCount: number
  unmatchedCount: number
  ambiguousMetadataCount: number
  unsupportedEntryCount: number
  warnings: string[]
}

export interface PlaylistExportResult {
  filePath: string
  format: 'm3u' | 'm3u8'
  playlistId: number
  exportedCount: number
  warnings: string[]
}

export interface Album {
  identity_key: string
  album: string
  artist: string
  primary_artist: string | null
  year: number | null
  artwork_hash: string | null
  track_count: number
  is_new: boolean
}

export type AlbumListOptions = AlbumEligibilityOptions

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
  artworkPath?: string | null
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

export type LibraryScanIssuePhase = 'discovery' | 'scan' | 'backfill' | 'cleanup'

export interface LibraryScanIssue {
  phase: LibraryScanIssuePhase
  path: string
  message: string
  code?: string
}

interface ScanIssueOptions {
  onIssue?: (issue: LibraryScanIssue) => void
}

interface ScanControlOptions extends ScanIssueOptions {
  signal?: AbortSignal
}

type LibraryFolderScanMode = 'incremental' | 'force'

interface ScanWriteOptions extends ScanControlOptions {
  persist?: boolean
  syncSessionKey?: string | null
}

interface FolderScanOptions extends ScanWriteOptions {
  mode?: LibraryFolderScanMode
}

export class LibraryScanCancelledError extends Error {
  constructor(message = 'Library scan canceled') {
    super(message)
    this.name = 'LibraryScanCancelledError'
  }
}

function throwIfScanCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new LibraryScanCancelledError()
  }
}

export function isLibraryScanCancelledError(error: unknown): error is LibraryScanCancelledError {
  return error instanceof LibraryScanCancelledError
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim().length > 0) return error
  return 'Unknown error'
}

function createLibraryScanIssue(phase: LibraryScanIssuePhase, path: string, error: unknown): LibraryScanIssue {
  const code = getErrorCode(error)
  return {
    phase,
    path,
    code,
    message: getErrorMessage(error),
  }
}

class LibrarySqliteDatabase {
  private readonly database: BetterSqliteDatabase

  constructor(database: BetterSqliteDatabase) {
    this.database = database
  }

  get inTransaction(): boolean {
    return this.database.inTransaction
  }

  run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number | bigint } {
    noteLibrarySqlMutation(sql)
    if (params.length > 0) {
      return this.database.prepare(sql).run(...params)
    }

    this.database.exec(sql)
    return { changes: 0, lastInsertRowid: 0 }
  }

  exec(sql: string): void {
    noteLibrarySqlMutation(sql)
    this.database.exec(sql)
  }

  get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    return this.database.prepare(sql).get(...params) as T | undefined
  }

  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.database.prepare(sql).all(...params) as T[]
  }

  iterate<T = Record<string, unknown>>(sql: string, params: unknown[] = []): IterableIterator<T> {
    return this.database.prepare(sql).iterate(...params) as IterableIterator<T>
  }

  pragma(sql: string): unknown {
    return this.database.pragma(sql)
  }

  registerFunction(name: string, options: { deterministic?: boolean; varargs?: boolean }, fn: (...args: unknown[]) => unknown): void {
    this.database.function(name, options, fn)
  }

  close(): void {
    this.database.close()
  }
}

let db: LibrarySqliteDatabase | null = null
let dbPath: string = ''
let artworkDir: string = ''
let playlistCoverDir: string = ''
let artistImageDir: string = ''
let replayGainScanEnabled: boolean = true
const SCAN_PARALLEL_MIN_FILES = 250
const SCAN_PARALLEL_MIN_WORKERS = 2
const SCAN_PARALLEL_MAX_WORKERS = 4
const BACKFILL_PARALLEL_MIN_FILES = 80
const BACKFILL_PARALLEL_MIN_WORKERS = 2
const BACKFILL_PARALLEL_MAX_WORKERS = 3
const SQLITE_SAFE_MAX_VARIABLES = 900
const DEFAULT_LIBRARY_TRACK_PAGE_LIMIT = 500
const MAX_LIBRARY_TRACK_PAGE_LIMIT = 2000
const PLAYLIST_COVER_HASH_PREFIX = 'plc:'
const ARTIST_IMAGE_HASH_PREFIX = 'ari:'
const LATEST_LIBRARY_SYNC_SUMMARY_META_KEY = 'library_latest_sync_summary_v1'
const LIBRARY_QUERY_METRICS_ENV = 'ASTRA_LIBRARY_QUERY_METRICS'
const EFFECTIVE_TRACK_SELECT_COLUMNS = `
  t.id AS id,
  t.path AS path,
  COALESCE(o.title, t.title) AS title,
  COALESCE(o.artist, t.artist) AS artist,
  CASE
    WHEN o.artist IS NULL THEN t.artist_names_json
    ELSE NULL
  END AS artist_names_json,
  COALESCE(o.album, t.album) AS album,
  COALESCE(o.album_artist, t.album_artist) AS album_artist,
  CASE
    WHEN o.album_artist IS NULL THEN t.album_artist_names_json
    ELSE NULL
  END AS album_artist_names_json,
  t.duration AS duration,
  COALESCE(o.track_number, t.track_number) AS track_number,
  COALESCE(o.disc_number, t.disc_number) AS disc_number,
  COALESCE(o.year, t.year) AS year,
  COALESCE(o.genre, t.genre) AS genre,
  CASE
    WHEN o.genre IS NULL THEN t.genre_names_json
    ELSE NULL
  END AS genre_names_json,
  CASE
    WHEN COALESCE(o.artwork_cleared, 0) = 1 THEN NULL
    ELSE COALESCE(o.artwork_hash, t.artwork_hash)
  END AS artwork_hash,
  t.artwork_hash AS base_artwork_hash,
  t.format AS format,
  t.sample_rate AS sample_rate,
  t.bit_depth AS bit_depth,
  t.bitrate AS bitrate,
  t.channels AS channels,
  t.codec AS codec,
  t.codec_profile AS codec_profile,
  t.is_atmos_joc AS is_atmos_joc,
  t.is_iamf AS is_iamf,
  t.replaygain_track_gain_db AS replaygain_track_gain_db,
  t.replaygain_album_gain_db AS replaygain_album_gain_db,
  t.bpm AS bpm,
  t.musical_key AS musical_key,
  t.source_type AS source_type,
  t.source_id AS source_id,
  t.source_track_id AS source_track_id,
  t.source_path AS source_path,
  t.is_available AS is_available,
  t.availability_reason AS availability_reason,
  t.file_created_at AS file_created_at,
  t.play_count AS play_count,
  t.last_played_at AS last_played_at,
  t.sync_session_key AS sync_session_key,
  t.latest_sync_dismissed_at AS latest_sync_dismissed_at,
  t.added_at AS added_at,
  t.modified_at AS modified_at
`
const EFFECTIVE_TRACK_FROM_CLAUSE = `
  FROM tracks t
  LEFT JOIN track_metadata_overrides o ON o.track_path = t.path
`

interface TrackMetadataOverrideRow {
  title: string | null
  artist: string | null
  album: string | null
  album_artist: string | null
  genre: string | null
  year: number | null
  track_number: number | null
  disc_number: number | null
  artwork_hash: string | null
  artwork_cleared: number | null
}

interface EditableTrackSnapshot {
  path: string
  base: {
    title: string
    artist: string
    album: string
    albumArtist: string | null
    genre: string | null
    year: number | null
    trackNumber: number | null
    discNumber: number | null
    artworkHash: string | null
  }
  effective: {
    title: string
    artist: string
    album: string
    albumArtist: string | null
    genre: string | null
    year: number | null
    trackNumber: number | null
    discNumber: number | null
    artworkHash: string | null
  }
}

type ResolvedMetadataArtworkChange =
  | { kind: 'unchanged' }
  | { kind: 'remove' }
  | { kind: 'replace'; imagePath: string; artworkHash: string }

function isRunningOnBatteryPower(): boolean {
  if (!app.isReady()) return false
  try {
    return powerMonitor.isOnBatteryPower()
  } catch {
    return false
  }
}

function resolveScanWorkerCount(fileCount: number): number {
  if (fileCount <= 0) return 1
  if (fileCount < SCAN_PARALLEL_MIN_FILES) return 1
  if (isRunningOnBatteryPower()) return 1

  const cpuCount = cpus().length
  if (!Number.isFinite(cpuCount) || cpuCount <= 1) {
    return 1
  }

  const adaptiveConcurrency = Math.floor(cpuCount / 2)
  return Math.max(
    SCAN_PARALLEL_MIN_WORKERS,
    Math.min(SCAN_PARALLEL_MAX_WORKERS, adaptiveConcurrency)
  )
}

function resolveBackfillWorkerCount(fileCount: number): number {
  if (fileCount <= 0) return 1
  if (fileCount < BACKFILL_PARALLEL_MIN_FILES) return 1
  if (isRunningOnBatteryPower()) return 1

  const cpuCount = cpus().length
  if (!Number.isFinite(cpuCount) || cpuCount <= 1) {
    return 1
  }

  const adaptiveConcurrency = Math.max(1, Math.floor(cpuCount / 3))
  return Math.max(
    BACKFILL_PARALLEL_MIN_WORKERS,
    Math.min(BACKFILL_PARALLEL_MAX_WORKERS, adaptiveConcurrency)
  )
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  options: ScanControlOptions = {}
): Promise<void> {
  if (items.length === 0) return

  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  let nextIndex = 0

  async function runWorker(): Promise<void> {
    while (true) {
      throwIfScanCancelled(options.signal)
      const currentIndex = nextIndex
      nextIndex += 1
      if (currentIndex >= items.length) return
      await worker(items[currentIndex], currentIndex)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function backupExistingSqlJsDatabase(): Promise<void> {
  if (!dbPath || !(await pathExists(dbPath))) return

  const backupPath = `${dbPath}.sqljs-backup`
  if (await pathExists(backupPath)) return

  await copyFile(dbPath, backupPath)
}

// Writes are file-backed with better-sqlite3, so persistence no longer exports
// the entire database into JS memory.
async function saveDatabase(): Promise<void> {
  return
}

export function beginLibraryWriteTransaction(): void {
  if (!db) return
  db.run('BEGIN IMMEDIATE TRANSACTION')
}

export function commitLibraryWriteTransaction(): void {
  if (!db) return
  db.run('COMMIT')
}

export function rollbackLibraryWriteTransaction(): void {
  if (!db) return
  db.run('ROLLBACK')
}

export async function persistLibraryDatabase(): Promise<void> {
  await saveDatabase()
}

function isLibraryQueryMetricsEnabled(): boolean {
  const value = process.env[LIBRARY_QUERY_METRICS_ENV]
  return value === '1' || value?.toLowerCase() === 'true'
}

function countQueryResultRows(result: unknown): number | null {
  if (Array.isArray(result)) return result.length
  return null
}

function formatMetricBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

function measureLibraryQuery<T>(name: string, query: () => T): T {
  if (!isLibraryQueryMetricsEnabled()) {
    return query()
  }

  const beforeMemory = process.memoryUsage()
  const startedAt = process.hrtime.bigint()
  const result = query()
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
  const afterMemory = process.memoryUsage()
  const resultCount = countQueryResultRows(result)

  console.info('[library:sqlite-query]', {
    name,
    durationMs: Number(durationMs.toFixed(2)),
    resultCount,
    heapBefore: formatMetricBytes(beforeMemory.heapUsed),
    heapAfter: formatMetricBytes(afterMemory.heapUsed),
    heapDelta: formatMetricBytes(afterMemory.heapUsed - beforeMemory.heapUsed),
    rssBefore: formatMetricBytes(beforeMemory.rss),
    rssAfter: formatMetricBytes(afterMemory.rss),
    rssDelta: formatMetricBytes(afterMemory.rss - beforeMemory.rss),
  })

  return result
}

function readCount(sql: string): number {
  if (!db) return 0
  const row = db.get<Record<string, unknown>>(sql)
  if (!row) return 0
  const raw = Object.values(row)[0]
  return typeof raw === 'number' ? raw : Number(raw) || 0
}

async function clearArtworkCacheDirectory(): Promise<void> {
  if (!artworkDir) return

  try {
    await rm(artworkDir, { recursive: true, force: true })
    await mkdir(artworkDir, { recursive: true })
  } catch (error) {
    console.warn('Failed to clear artwork cache directory:', artworkDir, error)
  }
}

async function clearPlaylistCoverDirectory(): Promise<void> {
  if (!playlistCoverDir) return

  try {
    await rm(playlistCoverDir, { recursive: true, force: true })
    await mkdir(playlistCoverDir, { recursive: true })
  } catch (error) {
    console.warn('Failed to clear playlist cover directory:', playlistCoverDir, error)
  }
}

async function clearArtistImageDirectory(): Promise<void> {
  if (!artistImageDir) return

  try {
    await rm(artistImageDir, { recursive: true, force: true })
    await mkdir(artistImageDir, { recursive: true })
  } catch (error) {
    console.warn('Failed to clear artist image directory:', artistImageDir, error)
  }
}

function readEffectiveTrackRows(sql: string, params: unknown[] = []): DbTrackRow[] {
  if (!db) return []
  return db.all<DbTrackRow>(sql, params)
}

function iterateEffectiveTrackRows(sql: string, params: unknown[] = []): Iterable<DbTrackRow> {
  if (!db) return []
  return db.iterate<DbTrackRow>(sql, params)
}

function buildAlbumIdentityKeysByPath(tracks: readonly DbTrackRow[]): Map<string, string> {
  return buildAlbumIdentityKeyByTrackId(tracks, (track) => track.path)
}

function readAllTrackRowsUnordered(): DbTrackRow[] {
  return readEffectiveTrackRows(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
  `)
}

function normalizeSqliteAlbumKey(value: unknown): string {
  const album = typeof value === 'string' ? value : String(value ?? '')
  return normalizeKey(normalizeAlbumName(album))
}

function readAlbumIdentityRowsByAlbumKeys(albumKeys: Iterable<string>): DbTrackRow[] {
  if (!db) return []
  const normalizedAlbumKeys = Array.from(new Set(
    Array.from(albumKeys)
      .map((albumKey) => normalizeKey(albumKey))
      .filter((albumKey) => albumKey.length > 0)
  ))
  if (normalizedAlbumKeys.length === 0) return []

  const rows: DbTrackRow[] = []
  for (let offset = 0; offset < normalizedAlbumKeys.length; offset += SQLITE_SAFE_MAX_VARIABLES) {
    const chunk = normalizedAlbumKeys.slice(offset, offset + SQLITE_SAFE_MAX_VARIABLES)
    const placeholders = chunk.map(() => '?').join(', ')
    rows.push(...readEffectiveTrackRows(`
      SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
      ${EFFECTIVE_TRACK_FROM_CLAUSE}
      WHERE astra_normalize_album_key(COALESCE(o.album, t.album)) IN (${placeholders})
    `, chunk))
  }
  return rows
}

function readAlbumIdentityRowsForTracks(tracks: readonly DbTrackRow[]): DbTrackRow[] {
  const albumKeys = tracks.map((track) => normalizeKey(normalizeAlbumName(track.album)))
  return readAlbumIdentityRowsByAlbumKeys(albumKeys)
}

// Cached, library-wide derived state for hot read paths. Album identity keys
// depend on grouping context from the whole library, so computing them per
// query forces full-table scans through the astra_normalize_album_key JS UDF;
// the snapshot computes them once per write generation instead.
interface LibraryTrackSnapshot {
  generation: number
  sortedPaths: string[]
  identityKeysByPath: Map<string, string>
  albumKeysByPath: Map<string, string>
}

let libraryWriteGeneration = 0
let trackSnapshot: LibraryTrackSnapshot | null = null

const SNAPSHOT_WRITE_STATEMENT_PATTERN = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/im
const SNAPSHOT_ALWAYS_INVALIDATE_PATTERN = /^\s*(?:CREATE|DROP|ALTER|ROLLBACK)\b/im
const SNAPSHOT_SOURCE_TABLE_PATTERN = /\b(?:tracks|track_metadata_overrides|app_meta)\b/i

function invalidateLibraryTrackSnapshot(): void {
  libraryWriteGeneration += 1
  trackSnapshot = null
}

function noteLibrarySqlMutation(sql: string): void {
  if (SNAPSHOT_ALWAYS_INVALIDATE_PATTERN.test(sql)) {
    invalidateLibraryTrackSnapshot()
    return
  }
  if (SNAPSHOT_WRITE_STATEMENT_PATTERN.test(sql) && SNAPSHOT_SOURCE_TABLE_PATTERN.test(sql)) {
    invalidateLibraryTrackSnapshot()
  }
}

// The main process is single threaded and all library reads/writes are
// synchronous, so a rebuild can never interleave with a write.
function getLibraryTrackSnapshot(): LibraryTrackSnapshot | null {
  if (!db) return null
  if (trackSnapshot && trackSnapshot.generation === libraryWriteGeneration) {
    return trackSnapshot
  }

  return measureLibraryQuery('rebuildTrackSnapshot', () => {
    const generation = libraryWriteGeneration
    const rows = readEffectiveTrackRows(`
      SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
      ${EFFECTIVE_TRACK_FROM_CLAUSE}
      ${ALL_TRACKS_ORDER_BY_CLAUSE}
    `)
    const identityKeysByPath = buildAlbumIdentityKeysByPath(rows)
    const sortedPaths: string[] = new Array(rows.length)
    const albumKeysByPath = new Map<string, string>()
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      sortedPaths[index] = row.path
      albumKeysByPath.set(row.path, normalizeSqliteAlbumKey(row.album))
    }
    trackSnapshot = { generation, sortedPaths, identityKeysByPath, albumKeysByPath }
    return trackSnapshot
  })
}

function readEffectiveTrackRowsByPaths(paths: readonly string[]): DbTrackRow[] {
  if (!db || paths.length === 0) return []

  const uniquePaths = Array.from(new Set(paths))
  const rowsByPath = new Map<string, DbTrackRow>()
  for (let offset = 0; offset < uniquePaths.length; offset += SQLITE_SAFE_MAX_VARIABLES) {
    const chunk = uniquePaths.slice(offset, offset + SQLITE_SAFE_MAX_VARIABLES)
    const placeholders = chunk.map(() => '?').join(', ')
    for (const row of readEffectiveTrackRows(`
      SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
      ${EFFECTIVE_TRACK_FROM_CLAUSE}
      WHERE t.path IN (${placeholders})
    `, chunk)) {
      rowsByPath.set(row.path, row)
    }
  }

  const rows: DbTrackRow[] = []
  for (const path of paths) {
    const row = rowsByPath.get(path)
    if (row) rows.push(row)
  }
  return rows
}

function readEffectiveTrackRowsByAlbumKey(albumKey: string): DbTrackRow[] {
  const normalizedAlbumKey = normalizeKey(albumKey)
  if (!normalizedAlbumKey) return []

  const snapshot = getLibraryTrackSnapshot()
  if (snapshot) {
    const matchedPaths = snapshot.sortedPaths.filter((path) => (
      snapshot.albumKeysByPath.get(path) === normalizedAlbumKey
    ))
    return readEffectiveTrackRowsByPaths(matchedPaths)
  }

  return readEffectiveTrackRows(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
    WHERE astra_normalize_album_key(COALESCE(o.album, t.album)) = ?
  `, [normalizedAlbumKey])
}

function normalizeGenreName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function normalizeGenreNames(values: readonly unknown[] | null | undefined): string[] {
  if (!values) return []

  const unique = new Map<string, string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    for (const rawPart of value.split(/[;\u0000]+/)) {
      const display = normalizeGenreName(rawPart)
      if (!display) continue
      const key = display.toLocaleLowerCase()
      if (!key || unique.has(key)) continue
      unique.set(key, display)
    }
  }

  return Array.from(unique.values())
}

function serializeGenreNames(names: readonly unknown[] | null | undefined): string | null {
  const normalized = normalizeGenreNames(names)
  return normalized.length > 0 ? JSON.stringify(normalized) : null
}

function deserializeGenreNames(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) return []

  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? normalizeGenreNames(parsed) : []
  } catch {
    return []
  }
}

function formatGenreNames(names: readonly unknown[] | null | undefined): string {
  return normalizeGenreNames(names).join('; ')
}

function getGenreNamesForTrack(track: Pick<DbTrackRow, 'genre' | 'genre_names_json'>): string[] {
  const storedGenres = deserializeGenreNames(track.genre_names_json)
  if (storedGenres.length > 0) return storedGenres
  return normalizeGenreNames(track.genre ? [track.genre] : [])
}

function resolveGenreStorageFields(values: readonly unknown[] | null | undefined): {
  genre: string | null
  genreNamesJson: string | null
} {
  const genres = normalizeGenreNames(values)
  return {
    genre: genres.length > 0 ? formatGenreNames(genres) : null,
    genreNamesJson: serializeGenreNames(genres)
  }
}

function resolveTrackGenreStorageFields(track: { genre: string | null; genres?: readonly string[] | null }): {
  genre: string | null
  genreNamesJson: string | null
} {
  const sourceGenres = track.genres && track.genres.length > 0 ? track.genres : (track.genre ? [track.genre] : [])
  return resolveGenreStorageFields(sourceGenres)
}

function attachAlbumIdentityKeys(
  tracks: readonly DbTrackRow[],
  libraryTracks?: readonly DbTrackRow[],
  latestSyncSummary: LatestLibrarySyncSummary | null = getLatestLibrarySyncSummary()
): DbTrack[] {
  if (tracks.length === 0) return []

  if (!libraryTracks) {
    const snapshot = getLibraryTrackSnapshot()
    if (snapshot) {
      return attachAlbumIdentityKeysWithMap(tracks, snapshot.identityKeysByPath, latestSyncSummary)
    }
  }

  const effectiveLibraryTracks = libraryTracks ?? readAlbumIdentityRowsForTracks(tracks)
  const albumIdentityKeysByPath = buildAlbumIdentityKeysByPath(effectiveLibraryTracks)
  return attachAlbumIdentityKeysWithMap(tracks, albumIdentityKeysByPath, latestSyncSummary)
}

function attachAlbumIdentityKeysWithMap(
  tracks: readonly DbTrackRow[],
  albumIdentityKeysByPath: ReadonlyMap<string, string>,
  latestSyncSummary: LatestLibrarySyncSummary | null = getLatestLibrarySyncSummary()
): DbTrack[] {
  if (tracks.length === 0) return []

  return tracks.map((track) => {
    const {
      sync_session_key,
      latest_sync_dismissed_at,
      artist_names_json,
      album_artist_names_json,
      genre_names_json,
      ...rest
    } = track
    const artistNames = deserializeArtistNames(artist_names_json)
    const albumArtistNames = deserializeArtistNames(album_artist_names_json)
    const genres = getGenreNamesForTrack({ genre: rest.genre, genre_names_json })
    return {
      ...rest,
      artist: artistNames.length > 1 ? formatArtistNames(artistNames) : rest.artist,
      artist_names: artistNames,
      album_artist: albumArtistNames.length > 1
        ? formatArtistNames(albumArtistNames)
        : rest.album_artist ?? (albumArtistNames[0] ?? null),
      album_artist_names: albumArtistNames,
      genre: genres.length > 0 ? formatGenreNames(genres) : rest.genre,
      genres,
      album_identity_key: albumIdentityKeysByPath.get(track.path) ?? buildFallbackAlbumIdentityKeyFromTrack(track),
      is_new: isTrackNewForLatestSync(sync_session_key, latestSyncSummary, latest_sync_dismissed_at)
    }
  })
}

function readEffectiveTracks(sql: string, libraryTracks?: readonly DbTrackRow[], params: unknown[] = []): DbTrack[] {
  const tracks = readEffectiveTrackRows(sql, params)
  return attachAlbumIdentityKeys(tracks, libraryTracks)
}

function normalizeRequiredTextField(value: string, fieldName: 'title' | 'artist' | 'album'): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`${fieldName} cannot be empty.`)
  }
  return normalized
}

function normalizeOptionalTextField(value: string | null): string | null {
  if (value === null) return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeOptionalIntegerField(value: number | null, fieldName: 'year' | 'trackNumber' | 'discNumber'): number | null {
  if (value === null) return null
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer.`)
  }
  return value
}

function hasOverrideValues(row: TrackMetadataOverrideRow): boolean {
  return (
    row.title !== null ||
    row.artist !== null ||
    row.album !== null ||
    row.album_artist !== null ||
    row.genre !== null ||
    row.year !== null ||
    row.track_number !== null ||
    row.disc_number !== null ||
    row.artwork_hash !== null ||
    row.artwork_cleared === 1
  )
}

interface CountedDisplayVariant {
  display: string
  count: number
}

interface AlbumGroupAccumulator {
  identityKey: string
  groupingMode: AlbumGroupingMode
  albumKey: string
  artistKey: string
  albumVariants: Map<string, CountedDisplayVariant>
  artistVariants: Map<string, CountedDisplayVariant>
  primaryArtistKeys: Set<string>
  aliasArtistKeys: Set<string>
  artworkCounts: Map<string, number>
  firstArtworkHash: string | null
  year: number | null
  trackCount: number
  tracks: DbTrackRow[]
}

const UNKNOWN_ALBUM_NAME = 'Unknown Album'
const UNKNOWN_ARTIST_NAME = 'Unknown Artist'
const VARIOUS_ARTISTS_NAME = 'Various Artists'

export type ArtistBrowseMode = 'strict' | 'canonical'

function normalizeDisplay(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeKey(value: string): string {
  return normalizeDisplay(value).toLocaleLowerCase()
}

function normalizeAlbumName(album: string): string {
  const normalized = normalizeDisplay(album)
  return normalized || UNKNOWN_ALBUM_NAME
}

function splitCollaborators(rawArtist: string): string[] {
  const normalized = normalizeDisplay(rawArtist)
  if (!normalized) return []

  const unified = normalized
    .replace(/\s*;\s*/g, ',')
    .replace(/\s+&\s+/g, ',')
    .replace(/\s+[x×]\s+/gi, ',')
    .replace(/\s+(?:feat\.?|ft\.?|featuring|with)\s+/gi, ',')

  const unique = new Map<string, string>()
  for (const part of unified.split(',')) {
    const display = normalizeDisplay(part)
    if (!display) continue
    const key = normalizeKey(display)
    if (!key || unique.has(key)) continue
    unique.set(key, display)
  }

  return Array.from(unique.values())
}

function splitAlbumArtistCollaborators(rawAlbumArtist: string): string[] {
  const normalized = normalizeDisplay(rawAlbumArtist)
  if (!normalized) return []

  const unified = normalized
    .replace(/\s*;\s*/g, ',')
    .replace(/\s+[x×]\s+/gi, ',')
    .replace(/\s+(?:feat\.?|ft\.?|featuring|with)\s+/gi, ',')

  const unique = new Map<string, string>()
  for (const part of unified.split(',')) {
    const display = normalizeDisplay(part)
    if (!display) continue
    const key = normalizeKey(display)
    if (!key || unique.has(key)) continue
    unique.set(key, display)
  }

  return Array.from(unique.values())
}

function getParsedTrackArtistNames(track: Pick<DbTrackRow, 'artist_names_json'>): string[] {
  return deserializeArtistNames(track.artist_names_json)
}

function getParsedAlbumArtistNames(track: Pick<DbTrackRow, 'album_artist_names_json'>): string[] {
  return deserializeArtistNames(track.album_artist_names_json)
}

function getCanonicalArtistIndexNames(track: Pick<DbTrackRow, 'artist' | 'album_artist' | 'artist_names_json' | 'album_artist_names_json'>): string[] {
  const unique = new Map<string, string>()
  const addArtistName = (artistName: string) => {
    const display = normalizeDisplay(artistName)
    const key = normalizeKey(display)
    if (!key || unique.has(key)) return
    unique.set(key, display)
  }

  addArtistName(resolveCanonicalBrowseArtist(track))

  const parsedTrackArtists = getParsedTrackArtistNames(track)
  for (const artistName of parsedTrackArtists) addArtistName(artistName)

  const parsedAlbumArtists = getParsedAlbumArtistNames(track)
  if (parsedTrackArtists.length === 0) {
    for (const artistName of parsedAlbumArtists) addArtistName(artistName)
  }

  return Array.from(unique.values())
}

function getPrimaryArtistFromTrackArtist(trackArtist: string): string {
  const contributors = splitCollaborators(trackArtist)
  return contributors[0] ?? UNKNOWN_ARTIST_NAME
}

function getPrimaryArtistFromTrack(track: Pick<DbTrackRow, 'artist' | 'artist_names_json'>): string {
  const parsedTrackArtists = getParsedTrackArtistNames(track)
  if (parsedTrackArtists.length > 0) return parsedTrackArtists[0]
  return getPrimaryArtistFromTrackArtist(track.artist)
}

function getPrimaryArtistFromAlbumArtist(albumArtist: string): string {
  const contributors = splitAlbumArtistCollaborators(albumArtist)
  if (contributors.length > 0) return contributors[0]
  return normalizeDisplay(albumArtist) || UNKNOWN_ARTIST_NAME
}

function getNormalizedAlbumArtistForAlbumIdentity(
  track: Pick<DbTrackRow, 'album_artist' | 'album_artist_names_json'>
): string {
  const normalizedAlbumArtist = normalizeDisplay(track.album_artist ?? '')
  if (normalizedAlbumArtist) return normalizedAlbumArtist

  const parsedAlbumArtists = getParsedAlbumArtistNames(track)
  if (parsedAlbumArtists.length > 0) return formatArtistNames(parsedAlbumArtists)
  return ''
}

function normalizeArtworkIdentityHash(hash: string | null | undefined): string | null {
  const normalized = normalizeDisplay(hash ?? '')
  return normalized ? normalized.toLocaleLowerCase() : null
}

function resolveStrictBrowseArtist(track: Pick<DbTrack, 'artist' | 'album_artist'>): string {
  const normalizedAlbumArtist = normalizeDisplay(track.album_artist ?? '')
  if (normalizedAlbumArtist) return normalizedAlbumArtist

  const normalizedTrackArtist = normalizeDisplay(track.artist)
  return normalizedTrackArtist || UNKNOWN_ARTIST_NAME
}

function resolveCanonicalBrowseArtist(
  track: Pick<DbTrackRow, 'artist' | 'album_artist' | 'artist_names_json' | 'album_artist_names_json'>
): string {
  const normalizedAlbumArtist = normalizeDisplay(track.album_artist ?? '')
  if (normalizedAlbumArtist) {
    const parsedAlbumArtists = getParsedAlbumArtistNames(track)
    if (parsedAlbumArtists.length > 0) return parsedAlbumArtists[0]
    return getPrimaryArtistFromAlbumArtist(normalizedAlbumArtist)
  }

  const normalizedPrimaryArtist = normalizeDisplay(getPrimaryArtistFromTrack(track))
  return normalizedPrimaryArtist || UNKNOWN_ARTIST_NAME
}

function trackMatchesBrowseArtist(track: DbTrackRow, targetArtistKey: string, mode: ArtistBrowseMode): boolean {
  const browseArtistKey = normalizeKey(
    mode === 'strict' ? resolveStrictBrowseArtist(track) : resolveCanonicalBrowseArtist(track)
  )
  if (browseArtistKey === targetArtistKey) return true

  if (mode === 'strict') {
    return false
  }

  if (getParsedTrackArtistNames(track).some((name) => normalizeKey(name) === targetArtistKey)) return true
  if (getParsedAlbumArtistNames(track).some((name) => normalizeKey(name) === targetArtistKey)) return true

  const albumArtistKey = normalizeKey(track.album_artist ?? '')
  if (albumArtistKey && albumArtistKey === targetArtistKey) return true

  const trackArtistKey = normalizeKey(track.artist)
  if (trackArtistKey && trackArtistKey === targetArtistKey) return true

  return splitCollaborators(track.artist).some((name) => normalizeKey(name) === targetArtistKey)
}

function incrementDisplayVariant(map: Map<string, CountedDisplayVariant>, display: string): void {
  const key = normalizeKey(display)
  if (!key) return
  const existing = map.get(key)
  if (existing) {
    existing.count += 1
    return
  }
  map.set(key, { display, count: 1 })
}

function pickMostFrequentDisplayVariant(
  map: Map<string, CountedDisplayVariant>,
  fallback: string
): string {
  let best: CountedDisplayVariant | null = null
  for (const variant of map.values()) {
    if (!best || variant.count > best.count) {
      best = variant
      continue
    }
    if (
      variant.count === best.count &&
      variant.display.localeCompare(best.display, undefined, { sensitivity: 'base' }) < 0
    ) {
      best = variant
    }
  }
  return best?.display ?? fallback
}

function pickMostFrequentArtworkHash(
  artworkCounts: Map<string, number>,
  fallback: string | null
): string | null {
  let bestHash: string | null = null
  let bestCount = -1

  for (const [hash, count] of artworkCounts.entries()) {
    if (count > bestCount) {
      bestHash = hash
      bestCount = count
      continue
    }
    if (count === bestCount && bestHash && hash.localeCompare(bestHash) < 0) {
      bestHash = hash
    }
  }

  return bestHash ?? fallback
}

function compareTracksByDiscTrackTitle(
  a: Pick<DbTrackRow, 'disc_number' | 'track_number' | 'title' | 'path'>,
  b: Pick<DbTrackRow, 'disc_number' | 'track_number' | 'title' | 'path'>
): number {
  const discA = a.disc_number ?? 0
  const discB = b.disc_number ?? 0
  if (discA !== discB) return discA - discB

  const trackA = a.track_number ?? 0
  const trackB = b.track_number ?? 0
  if (trackA !== trackB) return trackA - trackB

  const titleCompare = normalizeDisplay(a.title).localeCompare(normalizeDisplay(b.title), undefined, { sensitivity: 'base' })
  if (titleCompare !== 0) return titleCompare

  return a.path.localeCompare(b.path)
}

function compareTracksByAlbumDiscTrackTitle(
  a: Pick<DbTrackRow, 'album' | 'disc_number' | 'track_number' | 'title' | 'path'>,
  b: Pick<DbTrackRow, 'album' | 'disc_number' | 'track_number' | 'title' | 'path'>
): number {
  const albumCompare = normalizeAlbumName(a.album).localeCompare(normalizeAlbumName(b.album), undefined, { sensitivity: 'base' })
  if (albumCompare !== 0) return albumCompare
  return compareTracksByDiscTrackTitle(a, b)
}

function addAliasArtistKey(aliasArtistKeys: Set<string>, rawValue: string): void {
  const key = normalizeKey(rawValue)
  if (!key) return
  aliasArtistKeys.add(key)
}

function addTrackArtistAliases(group: AlbumGroupAccumulator, track: DbTrackRow, primaryArtist: string): void {
  addAliasArtistKey(group.aliasArtistKeys, primaryArtist)
  addAliasArtistKey(group.aliasArtistKeys, track.artist)

  for (const collaborator of splitCollaborators(track.artist)) {
    addAliasArtistKey(group.aliasArtistKeys, collaborator)
  }
  for (const artistName of getParsedTrackArtistNames(track)) {
    addAliasArtistKey(group.aliasArtistKeys, artistName)
  }

  const normalizedAlbumArtist = normalizeDisplay(track.album_artist ?? '')
  if (normalizedAlbumArtist) {
    addAliasArtistKey(group.aliasArtistKeys, normalizedAlbumArtist)
  }
  for (const artistName of getParsedAlbumArtistNames(track)) {
    addAliasArtistKey(group.aliasArtistKeys, artistName)
  }
}

function createAlbumGroupAccumulator(
  identityKey: string,
  groupingMode: AlbumGroupingMode,
  albumKey: string,
  initialArtist: string
): AlbumGroupAccumulator {
  const artistKey = normalizeKey(initialArtist) || normalizeKey('Unknown Artist')
  const aliasArtistKeys = new Set<string>()
  if (artistKey) {
    aliasArtistKeys.add(artistKey)
  }

  return {
    identityKey,
    groupingMode,
    albumKey,
    artistKey,
    albumVariants: new Map(),
    artistVariants: new Map(),
    primaryArtistKeys: new Set(),
    aliasArtistKeys,
    artworkCounts: new Map(),
    firstArtworkHash: null,
    year: null,
    trackCount: 0,
    tracks: []
  }
}

function addTrackToAlbumGroup(
  group: AlbumGroupAccumulator,
  track: DbTrackRow,
  albumName: string,
  displayArtist: string,
  primaryArtist: string
): void {
  incrementDisplayVariant(group.albumVariants, albumName)
  incrementDisplayVariant(group.artistVariants, displayArtist)
  group.trackCount += 1
  group.tracks.push(track)

  const primaryArtistKey = normalizeKey(primaryArtist)
  if (primaryArtistKey) {
    group.primaryArtistKeys.add(primaryArtistKey)
  }

  addTrackArtistAliases(group, track, primaryArtist)

  if (track.year !== null && (group.year === null || track.year > group.year)) {
    group.year = track.year
  }

  if (track.artwork_hash) {
    if (group.firstArtworkHash === null) {
      group.firstArtworkHash = track.artwork_hash
    }
    group.artworkCounts.set(track.artwork_hash, (group.artworkCounts.get(track.artwork_hash) ?? 0) + 1)
  }
}

function finalizeAlbumGroup(group: AlbumGroupAccumulator): void {
  if (group.groupingMode === 'shared-artwork-compilation') {
    group.artistVariants = new Map()
    incrementDisplayVariant(group.artistVariants, VARIOUS_ARTISTS_NAME)
    group.artistKey = normalizeKey(VARIOUS_ARTISTS_NAME)
  } else {
    const displayArtist = pickMostFrequentDisplayVariant(group.artistVariants, 'Unknown Artist')
    group.artistKey = normalizeKey(displayArtist) || normalizeKey('Unknown Artist')
  }

  if (group.artistKey) {
    group.aliasArtistKeys.add(group.artistKey)
  }
}

function buildAlbumGroups(tracks: DbTrackRow[]): Map<string, AlbumGroupAccumulator> {
  const groups = new Map<string, AlbumGroupAccumulator>()

  for (const identityGroup of groupTracksByAlbumIdentity(tracks, (track) => track.path).values()) {
    const group = createAlbumGroupAccumulator(
      identityGroup.identityKey,
      identityGroup.groupingMode,
      identityGroup.albumKey,
      identityGroup.displayArtist
    )

    for (const track of identityGroup.tracks) {
      const albumName = normalizeAlbumName(track.album)
      const primaryArtist = normalizeDisplay(getPrimaryArtistFromTrack(track)) || UNKNOWN_ARTIST_NAME
      addTrackToAlbumGroup(group, track, albumName, identityGroup.displayArtist, primaryArtist)
    }

    groups.set(group.identityKey, group)
  }

  for (const group of groups.values()) {
    finalizeAlbumGroup(group)
  }

  return groups
}

interface MissingAlbumArtistBucketProbe {
  primaryArtistKeys: Set<string>
  firstArtworkHash: string | null
  hasArtworkMismatch: boolean
}

interface ResolvedAlbumIdentity {
  identityKey: string
  groupingMode: AlbumGroupingMode
  albumKey: string
  displayArtist: string
}

interface AlbumSummaryAccumulator {
  identityKey: string
  groupingMode: AlbumGroupingMode
  albumKey: string
  displayArtist: string
  albumVariants: Map<string, CountedDisplayVariant>
  artistVariants: Map<string, CountedDisplayVariant>
  artworkCounts: Map<string, number>
  firstArtworkHash: string | null
  year: number | null
  trackCount: number
  hasUnplayedLatestSyncTrack: boolean
}

function readMissingAlbumArtistBucketProbes(): Map<string, MissingAlbumArtistBucketProbe> {
  const probes = new Map<string, MissingAlbumArtistBucketProbe>()

  for (const track of iterateEffectiveTrackRows(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
  `)) {
    if (getNormalizedAlbumArtistForAlbumIdentity(track)) continue

    const albumKey = normalizeKey(normalizeAlbumName(track.album))
    const primaryArtist = normalizeDisplay(getPrimaryArtistFromTrack(track)) || UNKNOWN_ARTIST_NAME
    const primaryArtistKey = normalizeKey(primaryArtist) || normalizeKey(UNKNOWN_ARTIST_NAME)
    const artworkHash = normalizeArtworkIdentityHash(track.base_artwork_hash)
    let probe = probes.get(albumKey)
    if (!probe) {
      probe = {
        primaryArtistKeys: new Set<string>(),
        firstArtworkHash: artworkHash,
        hasArtworkMismatch: false
      }
      probes.set(albumKey, probe)
    } else if (probe.firstArtworkHash !== artworkHash) {
      probe.hasArtworkMismatch = true
    }
    probe.primaryArtistKeys.add(primaryArtistKey)
  }

  return probes
}

function getSharedArtworkHashForProbe(probe: MissingAlbumArtistBucketProbe | undefined): string | null {
  if (!probe || probe.primaryArtistKeys.size <= 1) return null
  if (probe.hasArtworkMismatch) return null
  return probe.firstArtworkHash
}

function resolveAlbumIdentityForTrack(
  track: DbTrackRow,
  missingAlbumArtistBucketProbes: ReadonlyMap<string, MissingAlbumArtistBucketProbe>
): ResolvedAlbumIdentity {
  const albumKey = normalizeKey(normalizeAlbumName(track.album))
  const normalizedAlbumArtist = getNormalizedAlbumArtistForAlbumIdentity(track)
  if (normalizedAlbumArtist) {
    const albumArtistKey = normalizeKey(normalizedAlbumArtist) || normalizeKey(UNKNOWN_ARTIST_NAME)
    return {
      identityKey: buildCanonicalAlbumIdentityKey(albumKey, `aa:${albumArtistKey}`),
      groupingMode: 'explicit-album-artist',
      albumKey,
      displayArtist: normalizedAlbumArtist
    }
  }

  const sharedArtworkHash = getSharedArtworkHashForProbe(missingAlbumArtistBucketProbes.get(albumKey))
  if (sharedArtworkHash) {
    return {
      identityKey: buildCanonicalAlbumIdentityKey(albumKey, `ah:${sharedArtworkHash}`),
      groupingMode: 'shared-artwork-compilation',
      albumKey,
      displayArtist: VARIOUS_ARTISTS_NAME
    }
  }

  const primaryArtist = normalizeDisplay(getPrimaryArtistFromTrack(track)) || UNKNOWN_ARTIST_NAME
  const primaryArtistKey = normalizeKey(primaryArtist) || normalizeKey(UNKNOWN_ARTIST_NAME)
  return {
    identityKey: buildCanonicalAlbumIdentityKey(albumKey, `ta:${primaryArtistKey}`),
    groupingMode: 'track-artist',
    albumKey,
    displayArtist: primaryArtist
  }
}

function createAlbumSummaryAccumulator(identity: ResolvedAlbumIdentity): AlbumSummaryAccumulator {
  return {
    identityKey: identity.identityKey,
    groupingMode: identity.groupingMode,
    albumKey: identity.albumKey,
    displayArtist: identity.displayArtist,
    albumVariants: new Map(),
    artistVariants: new Map(),
    artworkCounts: new Map(),
    firstArtworkHash: null,
    year: null,
    trackCount: 0,
    hasUnplayedLatestSyncTrack: false
  }
}

function addTrackToAlbumSummary(
  group: AlbumSummaryAccumulator,
  track: DbTrackRow,
  latestSyncSummary: LatestLibrarySyncSummary | null
): void {
  incrementDisplayVariant(group.albumVariants, normalizeAlbumName(track.album))
  incrementDisplayVariant(group.artistVariants, group.displayArtist)
  group.trackCount += 1

  if (track.year !== null && (group.year === null || track.year > group.year)) {
    group.year = track.year
  }

  if (track.artwork_hash) {
    if (group.firstArtworkHash === null) {
      group.firstArtworkHash = track.artwork_hash
    }
    group.artworkCounts.set(track.artwork_hash, (group.artworkCounts.get(track.artwork_hash) ?? 0) + 1)
  }

  if (!group.hasUnplayedLatestSyncTrack) {
    group.hasUnplayedLatestSyncTrack = isTrackNewForLatestSync(
      track.sync_session_key,
      latestSyncSummary,
      track.latest_sync_dismissed_at
    )
  }
}

function collectAlbumSummaryGroups(
  missingAlbumArtistBucketProbes: ReadonlyMap<string, MissingAlbumArtistBucketProbe>,
  latestSyncSummary: LatestLibrarySyncSummary | null
): Map<string, AlbumSummaryAccumulator> {
  const groups = new Map<string, AlbumSummaryAccumulator>()

  for (const track of iterateEffectiveTrackRows(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
  `)) {
    const identity = resolveAlbumIdentityForTrack(track, missingAlbumArtistBucketProbes)
    let group = groups.get(identity.identityKey)
    if (!group) {
      group = createAlbumSummaryAccumulator(identity)
      groups.set(identity.identityKey, group)
    }
    addTrackToAlbumSummary(group, track, latestSyncSummary)
  }

  return groups
}

function collectEligibleAlbumIdentityKeys(
  missingAlbumArtistBucketProbes: ReadonlyMap<string, MissingAlbumArtistBucketProbe>,
  options: AlbumListOptions = {}
): Set<string> {
  const albumEligibilityOptions: AlbumEligibilityOptions = {
    includeSingles: options.includeSingles === true
  }
  const groups = collectAlbumSummaryGroups(missingAlbumArtistBucketProbes, null)
  const identityKeys = new Set<string>()

  for (const group of groups.values()) {
    if (isAlbumGroupEligible(group, albumEligibilityOptions)) {
      identityKeys.add(group.identityKey)
    }
  }

  return identityKeys
}

// Initialize database
export async function initDatabase(): Promise<void> {
  const userDataPath = app.getPath('userData')
  dbPath = join(userDataPath, 'library.db')
  artworkDir = join(userDataPath, 'artwork')
  playlistCoverDir = join(userDataPath, 'playlist-covers')
  artistImageDir = join(userDataPath, 'artist-images')

  // Create artwork and custom image directories.
  try {
    await mkdir(artworkDir, { recursive: true })
    await mkdir(playlistCoverDir, { recursive: true })
    await mkdir(artistImageDir, { recursive: true })
  } catch (err) {
    console.error('Failed to create media cache directories:', { artworkDir, playlistCoverDir, artistImageDir }, err)
  }

  await backupExistingSqlJsDatabase()

  invalidateLibraryTrackSnapshot()
  db = new LibrarySqliteDatabase(new BetterSqliteDatabase(dbPath, { timeout: 5000 }))
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.registerFunction('astra_normalize_album_key', { deterministic: true }, normalizeSqliteAlbumKey)

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      artist_names_json TEXT,
      album TEXT NOT NULL,
      album_artist TEXT,
      album_artist_names_json TEXT,
      duration REAL NOT NULL,
      track_number INTEGER,
      disc_number INTEGER,
      year INTEGER,
      genre TEXT,
      genre_names_json TEXT,
      artwork_hash TEXT,
      format TEXT NOT NULL,
      sample_rate INTEGER,
      bit_depth INTEGER,
      bitrate INTEGER,
      channels INTEGER,
      codec TEXT,
      codec_profile TEXT,
      is_atmos_joc INTEGER,
      is_iamf INTEGER,
      replaygain_track_gain_db REAL,
      replaygain_album_gain_db REAL,
      bpm REAL,
      musical_key TEXT,
      source_type TEXT NOT NULL DEFAULT 'local',
      source_id INTEGER,
      source_track_id TEXT,
      source_path TEXT,
      is_available INTEGER NOT NULL DEFAULT 1,
      availability_reason TEXT,
      file_created_at INTEGER,
      play_count INTEGER NOT NULL DEFAULT 0,
      last_played_at INTEGER,
      sync_session_key TEXT,
      latest_sync_dismissed_at INTEGER,
      added_at INTEGER NOT NULL,
      modified_at INTEGER NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS track_metadata_overrides (
      track_path TEXT PRIMARY KEY NOT NULL,
      title TEXT,
      artist TEXT,
      album TEXT,
      album_artist TEXT,
      genre TEXT,
      year INTEGER,
      track_number INTEGER,
      disc_number INTEGER,
      artwork_hash TEXT,
      artwork_cleared INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (track_path) REFERENCES tracks(path) ON DELETE CASCADE
    )
  `)

  db.run(`
    CREATE TRIGGER IF NOT EXISTS trg_track_metadata_overrides_cleanup
    AFTER DELETE ON tracks
    FOR EACH ROW
    BEGIN
      DELETE FROM track_metadata_overrides WHERE track_path = OLD.path;
    END;
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS lyrics_cache (
      track_path TEXT PRIMARY KEY NOT NULL,
      metadata_signature TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      provider TEXT,
      plain_lyrics TEXT,
      synced_lyrics TEXT,
      synced_lines_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  db.run(`
    CREATE TRIGGER IF NOT EXISTS trg_lyrics_cache_cleanup
    AFTER DELETE ON tracks
    FOR EACH ROW
    BEGIN
      DELETE FROM lyrics_cache WHERE track_path = OLD.path;
    END;
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS lyrics_track_overrides (
      track_path TEXT PRIMARY KEY NOT NULL,
      format TEXT,
      plain_lyrics TEXT,
      synced_lyrics TEXT,
      synced_lines_json TEXT NOT NULL,
      sync_offset_ms INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (track_path) REFERENCES tracks(path) ON DELETE CASCADE
    )
  `)

  db.run(`
    CREATE TRIGGER IF NOT EXISTS trg_lyrics_track_overrides_cleanup
    AFTER DELETE ON tracks
    FOR EACH ROW
    BEGIN
      DELETE FROM lyrics_track_overrides WHERE track_path = OLD.path;
    END;
  `)

  // Per-track loudness analysis results. Deliberately a separate table from
  // tracks: per-play writes here must not invalidate the library track snapshot.
  db.run(`
    CREATE TABLE IF NOT EXISTS track_loudness (
      track_path TEXT PRIMARY KEY NOT NULL,
      loudness_lufs REAL NOT NULL,
      peak_linear REAL,
      method TEXT NOT NULL,
      file_size INTEGER,
      file_mtime_ms INTEGER,
      analyzed_at INTEGER NOT NULL
    )
  `)

  db.run(`
    CREATE TRIGGER IF NOT EXISTS trg_track_loudness_cleanup
    AFTER DELETE ON tracks
    FOR EACH ROW
    BEGIN
      DELETE FROM track_loudness WHERE track_path = OLD.path;
    END;
  `)

  // User-assigned track ratings (half-star steps, 0.5-5). Like favorites,
  // deliberately NOT cleaned up by an AFTER DELETE trigger: remote resyncs
  // delete and re-insert tracks, and ratings must survive that round trip.
  // updated_at is the hook for a future mobile sync; note an unrate cannot be
  // synced without tombstones (accepted for now).
  db.run(`
    CREATE TABLE IF NOT EXISTS track_ratings (
      track_path TEXT PRIMARY KEY NOT NULL,
      rating REAL NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Play counts broken down by the install that produced them, so stats imported from
  // another machine ADD to the local count instead of one overwriting the other, while
  // re-importing the same file stays a no-op (each origin merges with MAX, not addition).
  // tracks.play_count is the denormalized sum over these rows and stays the read path for
  // sorting, the tracklist column, and dynamic playlists.
  // Path-keyed and trigger-free for the same reason as ratings and favorites: a remote
  // resync deletes and re-inserts track rows, and counts must survive that.
  db.run(`
    CREATE TABLE IF NOT EXISTS track_play_origins (
      track_path TEXT NOT NULL,
      origin_id TEXT NOT NULL,
      play_count INTEGER NOT NULL DEFAULT 0,
      last_played_at INTEGER,
      PRIMARY KEY (track_path, origin_id)
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_track_play_origins_path ON track_play_origins(track_path)')

  // Schema migration: existing libraries may not have channels yet.
  try {
    db.run('ALTER TABLE tracks ADD COLUMN channels INTEGER')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN artist_names_json TEXT')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN album_artist_names_json TEXT')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN genre_names_json TEXT')
  } catch {
    // Column already exists.
  }

  // Schema migration: extended codec metadata for pre-play Atmos/multichannel indicators.
  try {
    db.run('ALTER TABLE tracks ADD COLUMN codec TEXT')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN codec_profile TEXT')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN is_atmos_joc INTEGER')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN is_iamf INTEGER')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN replaygain_track_gain_db REAL')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN replaygain_album_gain_db REAL')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN bpm REAL')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN musical_key TEXT')
  } catch {
    // Column already exists.
  }
  try {
    db.run(`ALTER TABLE tracks ADD COLUMN source_type TEXT NOT NULL DEFAULT 'local'`)
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN source_id INTEGER')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN source_track_id TEXT')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN source_path TEXT')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN is_available INTEGER NOT NULL DEFAULT 1')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN availability_reason TEXT')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN file_created_at INTEGER')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN sync_session_key TEXT')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN latest_sync_dismissed_at INTEGER')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN last_played_at INTEGER')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE track_metadata_overrides ADD COLUMN artwork_hash TEXT')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE track_metadata_overrides ADD COLUMN artwork_cleared INTEGER')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE lyrics_track_overrides ADD COLUMN sync_offset_ms INTEGER NOT NULL DEFAULT 0')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE lyrics_track_overrides ADD COLUMN format TEXT')
  } catch {
    // Column already exists.
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      added_at INTEGER NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0
    )
  `)
  try {
    db.run('ALTER TABLE folders ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
  } catch {
    // Column already exists.
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS folder_exclusions (
      folder_id INTEGER NOT NULL,
      relative_path TEXT NOT NULL,
      absolute_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(folder_id, relative_path)
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_folder_exclusions_folder ON folder_exclusions(folder_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_folder_exclusions_absolute ON folder_exclusions(absolute_path)')

  db.run('CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tracks_source_scope ON tracks(source_type, source_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tracks_source_track ON tracks(source_type, source_id, source_track_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tracks_sync_session_key ON tracks(sync_session_key)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tracks_play_count ON tracks(play_count DESC)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tracks_last_played ON tracks(last_played_at DESC)')
  db.run('CREATE INDEX IF NOT EXISTS idx_lyrics_cache_updated_at ON lyrics_cache(updated_at)')
  db.run('CREATE INDEX IF NOT EXISTS idx_lyrics_track_overrides_updated_at ON lyrics_track_overrides(updated_at)')

  db.run(`
    CREATE TABLE IF NOT EXISTS subsonic_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      username TEXT NOT NULL,
      secret_encrypted TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_status TEXT NOT NULL DEFAULT 'unknown',
      last_error TEXT,
      last_sync_at INTEGER,
      last_checked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_subsonic_sources_enabled ON subsonic_sources(enabled)')

  db.run(`
    CREATE TABLE IF NOT EXISTS jellyfin_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      username TEXT NOT NULL,
      secret_encrypted TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_status TEXT NOT NULL DEFAULT 'unknown',
      last_error TEXT,
      last_sync_at INTEGER,
      last_checked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_jellyfin_sources_enabled ON jellyfin_sources(enabled)')

  db.run(`UPDATE tracks SET source_type = 'local' WHERE source_type IS NULL OR TRIM(source_type) = ''`)
  db.run('UPDATE tracks SET is_available = 1 WHERE is_available IS NULL')

  // Favorites table
  db.run(`
    CREATE TABLE IF NOT EXISTS favorites (
      track_path TEXT PRIMARY KEY NOT NULL,
      added_at INTEGER NOT NULL
    )
  `)

  // Recently played table
  db.run(`
    CREATE TABLE IF NOT EXISTS recently_played (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_path TEXT NOT NULL,
      played_at INTEGER NOT NULL
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_recently_played_time ON recently_played(played_at DESC)')

  // Detailed local listening history. Sessions retain a metadata snapshot so
  // personal history remains intelligible after a track leaves the library;
  // segments represent only continuous wall-clock time spent in `playing`.
  db.run(`
    CREATE TABLE IF NOT EXISTS listening_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generation TEXT NOT NULL,
      session_key TEXT NOT NULL,
      track_id INTEGER,
      track_path TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT NOT NULL,
      album_artist TEXT,
      album_identity_key TEXT NOT NULL,
      artwork_hash TEXT,
      source_type TEXT NOT NULL,
      duration_seconds REAL NOT NULL DEFAULT 0,
      source_playlist_id INTEGER,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      listened_seconds REAL NOT NULL DEFAULT 0,
      qualified_at INTEGER,
      UNIQUE(generation, session_key),
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL,
      FOREIGN KEY (source_playlist_id) REFERENCES playlists(id) ON DELETE SET NULL
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_listening_sessions_started ON listening_sessions(started_at)')
  db.run('CREATE INDEX IF NOT EXISTS idx_listening_sessions_qualified ON listening_sessions(qualified_at)')
  db.run('CREATE INDEX IF NOT EXISTS idx_listening_sessions_track ON listening_sessions(track_id)')

  db.run(`
    CREATE TABLE IF NOT EXISTS listening_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      segment_key TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      last_observed_at INTEGER NOT NULL,
      ended_at INTEGER,
      listened_seconds REAL NOT NULL DEFAULT 0,
      UNIQUE(session_id, segment_key),
      FOREIGN KEY (session_id) REFERENCES listening_sessions(id) ON DELETE CASCADE
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_listening_segments_time ON listening_segments(started_at, last_observed_at)')

  // Playlists table
  db.run(`
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_played_at INTEGER,
      custom_cover_hash TEXT,
      kind TEXT NOT NULL DEFAULT 'normal',
      dynamic_rules_json TEXT,
      remote_source_type TEXT,
      remote_source_id INTEGER,
      remote_playlist_id TEXT
    )
  `)
  try {
    db.run('ALTER TABLE playlists ADD COLUMN last_played_at INTEGER')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE playlists ADD COLUMN custom_cover_hash TEXT')
  } catch {
    // Column already exists.
  }
  try {
    db.run("ALTER TABLE playlists ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'")
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE playlists ADD COLUMN dynamic_rules_json TEXT')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE playlists ADD COLUMN remote_source_type TEXT')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE playlists ADD COLUMN remote_source_id INTEGER')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE playlists ADD COLUMN remote_playlist_id TEXT')
  } catch {
    // Column already exists.
  }
  db.run("UPDATE playlists SET kind = 'normal' WHERE kind IS NULL OR kind NOT IN ('normal', 'dynamic')")
  db.run("UPDATE playlists SET dynamic_rules_json = NULL WHERE kind <> 'dynamic'")
  db.run('CREATE INDEX IF NOT EXISTS idx_playlists_last_played ON playlists(last_played_at DESC)')
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_remote_source
    ON playlists(remote_source_type, remote_source_id, remote_playlist_id)
    WHERE remote_source_type IS NOT NULL
      AND remote_source_id IS NOT NULL
      AND remote_playlist_id IS NOT NULL
  `)

  // Artist images table
  db.run(`
    CREATE TABLE IF NOT EXISTS artist_images (
      browse_mode TEXT NOT NULL,
      artist_key TEXT NOT NULL,
      artist_name TEXT NOT NULL,
      manual_image_hash TEXT,
      detected_image_hash TEXT,
      detected_source_path TEXT,
      detected_source_mtime INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (browse_mode, artist_key)
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_artist_images_browse_mode ON artist_images(browse_mode)')

  // Playlist tracks table
  db.run(`
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL,
      track_path TEXT NOT NULL,
      position INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      fallback_title TEXT,
      fallback_artist TEXT,
      fallback_album TEXT,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
    )
  `)
  try {
    db.run('ALTER TABLE playlist_tracks ADD COLUMN fallback_title TEXT')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE playlist_tracks ADD COLUMN fallback_artist TEXT')
  } catch {
    // Column already exists.
  }
  try {
    db.run('ALTER TABLE playlist_tracks ADD COLUMN fallback_album TEXT')
  } catch {
    // Column already exists.
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id, position)')
  // Playlist rows are ordered occurrences, not unique memberships. Older
  // databases may still carry the legacy membership constraint, so remove it
  // before any imports or path-repair work can create repeated occurrences.
  db.run('DROP INDEX IF EXISTS idx_playlist_tracks_membership')

  // Desktop<->mobile LAN sync (phoneSync.ts): playlist sync identity, deletion
  // tombstones, and incoming favorites that haven't matched a local track yet.
  db.run(`
    CREATE TABLE IF NOT EXISTS favorite_tombstones (
      sync_key TEXT PRIMARY KEY NOT NULL,
      deleted_at INTEGER NOT NULL
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS favorite_sync_pending (
      sync_key TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT NOT NULL,
      added_at INTEGER NOT NULL
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS playlist_tombstones (
      sync_uid TEXT PRIMARY KEY NOT NULL,
      deleted_at INTEGER NOT NULL
    )
  `)
  try {
    db.run('ALTER TABLE playlists ADD COLUMN sync_uid TEXT')
  } catch {
    // Column already exists.
  }
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_sync_uid
    ON playlists(sync_uid)
    WHERE sync_uid IS NOT NULL
  `)

  // Generic app metadata table (schema/migration flags, etc.)
  db.run(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Last, because it reads its completion flag out of app_meta.
  backfillTrackPlayOrigins()

  await saveDatabase()
}

// Close database
export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
  invalidateLibraryTrackSnapshot()
}

export function setReplayGainScanEnabled(enabled: boolean): void {
  replayGainScanEnabled = Boolean(enabled)
}

export function getAppMeta(key: string): string | null {
  if (!db) return null
  const row = db.get<{ value?: unknown }>('SELECT value FROM app_meta WHERE key = ? LIMIT 1', [key])
  return typeof row?.value === 'string' ? row.value : null
}

export async function setAppMeta(key: string, value: string): Promise<void> {
  if (!db) return
  const now = Date.now()
  db.run(
    `INSERT INTO app_meta (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, now]
  )
  await saveDatabase()
}

export function getLatestLibrarySyncSummary(): LatestLibrarySyncSummary | null {
  const rawValue = getAppMeta(LATEST_LIBRARY_SYNC_SUMMARY_META_KEY)
  if (!rawValue) return null

  try {
    const parsed = JSON.parse(rawValue) as {
      sessionKey?: unknown
      completedAt?: unknown
      newAlbumIdentityKeys?: unknown
    }

    const sessionKey = typeof parsed.sessionKey === 'string' ? parsed.sessionKey.trim() : ''
    const completedAt = typeof parsed.completedAt === 'number' && Number.isFinite(parsed.completedAt)
      ? parsed.completedAt
      : Number.NaN
    if (!sessionKey || !Number.isFinite(completedAt)) {
      return null
    }

    const keys = Array.isArray(parsed.newAlbumIdentityKeys)
      ? parsed.newAlbumIdentityKeys
      : []
    const newAlbumIdentityKeys = Array.from(new Set(
      keys
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )).sort((a, b) => a.localeCompare(b))

    return {
      sessionKey,
      completedAt,
      newAlbumIdentityKeys
    }
  } catch {
    return null
  }
}

export async function setLatestLibrarySyncSummary(summary: LatestLibrarySyncSummary): Promise<void> {
  await setAppMeta(LATEST_LIBRARY_SYNC_SUMMARY_META_KEY, JSON.stringify(summary))
}

function normalizeSubsonicLastStatus(value: unknown): SubsonicSourceLastStatus {
  if (value === 'ok') return 'ok'
  if (value === 'error') return 'error'
  if (value === 'disabled') return 'disabled'
  if (value === 'syncing') return 'syncing'
  return 'unknown'
}

function normalizeJellyfinLastStatus(value: unknown): JellyfinSourceLastStatus {
  if (value === 'ok') return 'ok'
  if (value === 'error') return 'error'
  if (value === 'disabled') return 'disabled'
  if (value === 'syncing') return 'syncing'
  return 'unknown'
}

function toSubsonicSourcePublic(row: SubsonicSourceRow): SubsonicSourcePublic {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    username: row.username,
    enabled: row.enabled,
    last_status: normalizeSubsonicLastStatus(row.last_status),
    last_error: row.last_error,
    last_sync_at: row.last_sync_at,
    last_checked_at: row.last_checked_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_stored_secret: typeof row.secret_encrypted === 'string' && row.secret_encrypted.trim().length > 0
  }
}

function toJellyfinSourcePublic(row: JellyfinSourceRow): JellyfinSourcePublic {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    username: row.username,
    enabled: row.enabled,
    last_status: normalizeJellyfinLastStatus(row.last_status),
    last_error: row.last_error,
    last_sync_at: row.last_sync_at,
    last_checked_at: row.last_checked_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_stored_secret: typeof row.secret_encrypted === 'string' && row.secret_encrypted.trim().length > 0
  }
}

export function listSubsonicSources(): SubsonicSourcePublic[] {
  if (!db) return []
  return db.all<SubsonicSourceRow>(`
    SELECT
      id,
      name,
      base_url,
      username,
      secret_encrypted,
      enabled,
      last_status,
      last_error,
      last_sync_at,
      last_checked_at,
      created_at,
      updated_at
    FROM subsonic_sources
    ORDER BY created_at ASC, id ASC
  `).map(toSubsonicSourcePublic)
}

export function getSubsonicSourceById(sourceId: number): SubsonicSourceRow | null {
  if (!db) return null
  const row = db.get<SubsonicSourceRow>(`
    SELECT
      id,
      name,
      base_url,
      username,
      secret_encrypted,
      enabled,
      last_status,
      last_error,
      last_sync_at,
      last_checked_at,
      created_at,
      updated_at
    FROM subsonic_sources
    WHERE id = ?
    LIMIT 1
  `, [sourceId]) ?? null
  if (!row) return null
  row.last_status = normalizeSubsonicLastStatus(row.last_status)
  return row
}

export async function createSubsonicSource(input: {
  name: string
  base_url: string
  username: string
  secret_encrypted: string
  enabled: number
  last_status?: SubsonicSourceLastStatus
}): Promise<SubsonicSourcePublic> {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const now = Date.now()
  db.run(
    `INSERT INTO subsonic_sources (
      name,
      base_url,
      username,
      secret_encrypted,
      enabled,
      last_status,
      last_error,
      last_sync_at,
      last_checked_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    [
      input.name.trim(),
      input.base_url.trim(),
      input.username.trim(),
      input.secret_encrypted,
      input.enabled ? 1 : 0,
      normalizeSubsonicLastStatus(input.last_status),
      now,
      now
    ]
  )

  const sourceId = Number(db.get<{ id?: unknown }>('SELECT last_insert_rowid() as id')?.id ?? 0)
  const source = getSubsonicSourceById(sourceId)
  if (!source) {
    throw new Error('Failed to create Subsonic source.')
  }
  await saveDatabase()
  return toSubsonicSourcePublic(source)
}

export async function updateSubsonicSource(
  sourceId: number,
  input: {
    name?: string
    base_url?: string
    username?: string
    secret_encrypted?: string
    enabled?: number
    last_status?: SubsonicSourceLastStatus
    last_error?: string | null
    last_sync_at?: number | null
    last_checked_at?: number | null
  },
  options: { persist?: boolean } = {}
): Promise<SubsonicSourcePublic> {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const current = getSubsonicSourceById(sourceId)
  if (!current) {
    throw new Error('Subsonic source not found.')
  }

  const now = Date.now()
  db.run(
    `UPDATE subsonic_sources
     SET name = ?,
         base_url = ?,
         username = ?,
         secret_encrypted = ?,
         enabled = ?,
         last_status = ?,
         last_error = ?,
         last_sync_at = ?,
         last_checked_at = ?,
         updated_at = ?
     WHERE id = ?`,
    [
      input.name !== undefined ? input.name.trim() : current.name,
      input.base_url !== undefined ? input.base_url.trim() : current.base_url,
      input.username !== undefined ? input.username.trim() : current.username,
      input.secret_encrypted !== undefined ? input.secret_encrypted : current.secret_encrypted,
      input.enabled !== undefined ? (input.enabled ? 1 : 0) : current.enabled,
      input.last_status !== undefined ? normalizeSubsonicLastStatus(input.last_status) : normalizeSubsonicLastStatus(current.last_status),
      input.last_error !== undefined ? input.last_error : current.last_error,
      input.last_sync_at !== undefined ? input.last_sync_at : current.last_sync_at,
      input.last_checked_at !== undefined ? input.last_checked_at : current.last_checked_at,
      now,
      sourceId
    ]
  )

  const next = getSubsonicSourceById(sourceId)
  if (!next) {
    throw new Error('Failed to update Subsonic source.')
  }

  if (options.persist !== false) {
    await saveDatabase()
  }

  return toSubsonicSourcePublic(next)
}

export function listJellyfinSources(): JellyfinSourcePublic[] {
  if (!db) return []
  return db.all<JellyfinSourceRow>(`
    SELECT
      id,
      name,
      base_url,
      username,
      secret_encrypted,
      enabled,
      last_status,
      last_error,
      last_sync_at,
      last_checked_at,
      created_at,
      updated_at
    FROM jellyfin_sources
    ORDER BY created_at ASC, id ASC
  `).map(toJellyfinSourcePublic)
}

export function getJellyfinSourceById(sourceId: number): JellyfinSourceRow | null {
  if (!db) return null
  const row = db.get<JellyfinSourceRow>(`
    SELECT
      id,
      name,
      base_url,
      username,
      secret_encrypted,
      enabled,
      last_status,
      last_error,
      last_sync_at,
      last_checked_at,
      created_at,
      updated_at
    FROM jellyfin_sources
    WHERE id = ?
    LIMIT 1
  `, [sourceId]) ?? null
  if (!row) return null
  row.last_status = normalizeJellyfinLastStatus(row.last_status)
  return row
}

export async function createJellyfinSource(input: {
  name: string
  base_url: string
  username: string
  secret_encrypted: string
  enabled: number
  last_status?: JellyfinSourceLastStatus
}): Promise<JellyfinSourcePublic> {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const now = Date.now()
  db.run(
    `INSERT INTO jellyfin_sources (
      name,
      base_url,
      username,
      secret_encrypted,
      enabled,
      last_status,
      last_error,
      last_sync_at,
      last_checked_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    [
      input.name.trim(),
      input.base_url.trim(),
      input.username.trim(),
      input.secret_encrypted,
      input.enabled ? 1 : 0,
      normalizeJellyfinLastStatus(input.last_status),
      now,
      now
    ]
  )

  const sourceId = Number(db.get<{ id?: unknown }>('SELECT last_insert_rowid() as id')?.id ?? 0)
  const source = getJellyfinSourceById(sourceId)
  if (!source) {
    throw new Error('Failed to create Jellyfin source.')
  }
  await saveDatabase()
  return toJellyfinSourcePublic(source)
}

export async function updateJellyfinSource(
  sourceId: number,
  input: {
    name?: string
    base_url?: string
    username?: string
    secret_encrypted?: string
    enabled?: number
    last_status?: JellyfinSourceLastStatus
    last_error?: string | null
    last_sync_at?: number | null
    last_checked_at?: number | null
  },
  options: { persist?: boolean } = {}
): Promise<JellyfinSourcePublic> {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const current = getJellyfinSourceById(sourceId)
  if (!current) {
    throw new Error('Jellyfin source not found.')
  }

  const now = Date.now()
  db.run(
    `UPDATE jellyfin_sources
     SET name = ?,
         base_url = ?,
         username = ?,
         secret_encrypted = ?,
         enabled = ?,
         last_status = ?,
         last_error = ?,
         last_sync_at = ?,
         last_checked_at = ?,
         updated_at = ?
     WHERE id = ?`,
    [
      input.name !== undefined ? input.name.trim() : current.name,
      input.base_url !== undefined ? input.base_url.trim() : current.base_url,
      input.username !== undefined ? input.username.trim() : current.username,
      input.secret_encrypted !== undefined ? input.secret_encrypted : current.secret_encrypted,
      input.enabled !== undefined ? (input.enabled ? 1 : 0) : current.enabled,
      input.last_status !== undefined ? normalizeJellyfinLastStatus(input.last_status) : normalizeJellyfinLastStatus(current.last_status),
      input.last_error !== undefined ? input.last_error : current.last_error,
      input.last_sync_at !== undefined ? input.last_sync_at : current.last_sync_at,
      input.last_checked_at !== undefined ? input.last_checked_at : current.last_checked_at,
      now,
      sourceId
    ]
  )

  const next = getJellyfinSourceById(sourceId)
  if (!next) {
    throw new Error('Failed to update Jellyfin source.')
  }

  if (options.persist !== false) {
    await saveDatabase()
  }

  return toJellyfinSourcePublic(next)
}

function deleteTrackRelatedRows(trackPaths: string[]): void {
  if (!db || trackPaths.length === 0) return
  for (let offset = 0; offset < trackPaths.length; offset += SQLITE_SAFE_MAX_VARIABLES) {
    const chunk = trackPaths.slice(offset, offset + SQLITE_SAFE_MAX_VARIABLES)
    const placeholders = chunk.map(() => '?').join(', ')
    db.run(`DELETE FROM playlist_tracks WHERE track_path IN (${placeholders})`, chunk)
    db.run(`DELETE FROM favorites WHERE track_path IN (${placeholders})`, chunk)
    db.run(`DELETE FROM track_ratings WHERE track_path IN (${placeholders})`, chunk)
    db.run(`DELETE FROM ${PLAY_ORIGIN_TABLE} WHERE track_path IN (${placeholders})`, chunk)
    db.run(`DELETE FROM recently_played WHERE track_path IN (${placeholders})`, chunk)
    db.run(`DELETE FROM track_metadata_overrides WHERE track_path IN (${placeholders})`, chunk)
    db.run(`DELETE FROM lyrics_cache WHERE track_path IN (${placeholders})`, chunk)
    db.run(`DELETE FROM lyrics_track_overrides WHERE track_path IN (${placeholders})`, chunk)
  }
}

function deleteTrackRelatedRowsByPathPattern(trackPathPattern: string): void {
  if (!db || trackPathPattern.trim().length === 0) return
  db.run('DELETE FROM playlist_tracks WHERE track_path LIKE ?', [trackPathPattern])
  db.run('DELETE FROM favorites WHERE track_path LIKE ?', [trackPathPattern])
  db.run('DELETE FROM track_ratings WHERE track_path LIKE ?', [trackPathPattern])
  db.run(`DELETE FROM ${PLAY_ORIGIN_TABLE} WHERE track_path LIKE ?`, [trackPathPattern])
  db.run('DELETE FROM recently_played WHERE track_path LIKE ?', [trackPathPattern])
  db.run('DELETE FROM track_metadata_overrides WHERE track_path LIKE ?', [trackPathPattern])
  db.run('DELETE FROM lyrics_cache WHERE track_path LIKE ?', [trackPathPattern])
  db.run('DELETE FROM lyrics_track_overrides WHERE track_path LIKE ?', [trackPathPattern])
}

// Tables keyed by track_path with a PK/UNIQUE constraint on it. track_loudness
// is deliberately absent from deleteTrackRelatedRows (its delete trigger covers
// that path) but must move here or a path rewrite would orphan its rows.
const UNIQUE_TRACK_PATH_KEYED_TABLES = [
  'track_metadata_overrides',
  'lyrics_cache',
  'lyrics_track_overrides',
  'track_loudness',
  'track_ratings',
  'favorites'
] as const

// Keyed on (track_path, origin_id) rather than track_path alone, so it needs its own
// rename handling instead of riding UNIQUE_TRACK_PATH_KEYED_TABLES.
const PLAY_ORIGIN_TABLE = 'track_play_origins'

function moveTrackChildRows(oldPath: string, newPath: string): void {
  if (!db || oldPath === newPath) return
  // Every playlist row is an occurrence, so carry all of them to the repaired
  // path even when the target track already appears in the same playlist.
  db.run('UPDATE playlist_tracks SET track_path = ? WHERE track_path = ?', [newPath, oldPath])
  for (const table of UNIQUE_TRACK_PATH_KEYED_TABLES) {
    db.run(`UPDATE OR IGNORE ${table} SET track_path = ? WHERE track_path = ?`, [newPath, oldPath])
    // Leftovers exist only when the target path already had a row (PK/UNIQUE
    // conflict) — the surviving path's data wins.
    db.run(`DELETE FROM ${table} WHERE track_path = ?`, [oldPath])
  }
  movePlayOriginRows(oldPath, newPath)
  db.run('UPDATE recently_played SET track_path = ? WHERE track_path = ?', [newPath, oldPath])
}

/**
 * Folds one path's play origins into another's. Unlike the other child tables, a collision
 * here is summed rather than resolved in the survivor's favour: both rows are the same
 * install's plays of the same physical file recorded under two path spellings, so dropping
 * one would lose real plays.
 */
function movePlayOriginRows(oldPath: string, newPath: string): void {
  if (!db || oldPath === newPath) return
  db.run(`
    INSERT INTO ${PLAY_ORIGIN_TABLE} (track_path, origin_id, play_count, last_played_at)
    SELECT ?, origin_id, play_count, last_played_at FROM ${PLAY_ORIGIN_TABLE} WHERE track_path = ?
    ON CONFLICT(track_path, origin_id) DO UPDATE SET
      play_count = ${PLAY_ORIGIN_TABLE}.play_count + excluded.play_count,
      last_played_at = CASE
        WHEN excluded.last_played_at IS NULL THEN ${PLAY_ORIGIN_TABLE}.last_played_at
        WHEN ${PLAY_ORIGIN_TABLE}.last_played_at IS NULL THEN excluded.last_played_at
        ELSE MAX(${PLAY_ORIGIN_TABLE}.last_played_at, excluded.last_played_at)
      END
  `, [newPath, oldPath])
  db.run(`DELETE FROM ${PLAY_ORIGIN_TABLE} WHERE track_path = ?`, [oldPath])
}

/** Rewrites tracks.play_count / last_played_at from the per-origin rows. */
function recomputePlayCountsFromOrigins(trackPaths: readonly string[]): number {
  if (!db || trackPaths.length === 0) return 0
  let updated = 0
  for (let offset = 0; offset < trackPaths.length; offset += SQLITE_SAFE_MAX_VARIABLES) {
    const chunk = trackPaths.slice(offset, offset + SQLITE_SAFE_MAX_VARIABLES)
    const placeholders = chunk.map(() => '?').join(', ')
    db.run(`
      UPDATE tracks SET
        play_count = COALESCE((
          SELECT SUM(o.play_count) FROM ${PLAY_ORIGIN_TABLE} o WHERE o.track_path = tracks.path
        ), 0),
        last_played_at = (
          SELECT MAX(o.last_played_at) FROM ${PLAY_ORIGIN_TABLE} o WHERE o.track_path = tracks.path
        )
      WHERE tracks.path IN (${placeholders})
        AND (
          tracks.play_count IS NOT COALESCE((
            SELECT SUM(o.play_count) FROM ${PLAY_ORIGIN_TABLE} o WHERE o.track_path = tracks.path
          ), 0)
          OR tracks.last_played_at IS NOT (
            SELECT MAX(o.last_played_at) FROM ${PLAY_ORIGIN_TABLE} o WHERE o.track_path = tracks.path
          )
        )
    `, chunk)
    updated += Number(db.get<{ changed?: unknown }>('SELECT changes() AS changed')?.changed) || 0
  }
  return updated
}

// Rewrite a track's path in place (casing repair after a folder rename),
// carrying every path-keyed child row along so ratings, favorites and playlist
// membership survive. Callers must ensure no other tracks row occupies newPath.
function renameTrackPath(oldPath: string, newPath: string): void {
  if (!db || oldPath === newPath) return
  const ownsTransaction = !db.inTransaction
  if (ownsTransaction) beginLibraryWriteTransaction()
  try {
    // track_metadata_overrides / lyrics_track_overrides hold FKs on
    // tracks(path); with immediate enforcement neither parent-first nor
    // child-first rewrites can succeed, so defer checks until COMMIT.
    db.pragma('defer_foreign_keys = ON')
    db.run('UPDATE tracks SET path = ? WHERE path = ?', [newPath, oldPath])
    moveTrackChildRows(oldPath, newPath)
    if (ownsTransaction) commitLibraryWriteTransaction()
  } catch (err) {
    if (ownsTransaction) rollbackLibraryWriteTransaction()
    throw err
  }
}

interface DuplicateTrackRowRef {
  id: number
  path: string
}

interface TrackMergeStatsRow {
  play_count: number | null
  last_played_at: number | null
  added_at: number | null
}

// Collapse case-variant duplicate rows for one physical file into the survivor,
// preserving user data: child rows move to the survivor's path (survivor wins
// on conflict), play counts sum, added_at keeps the earliest date.
function mergeDuplicateTrackRows(survivorId: number, survivorPath: string, losers: DuplicateTrackRowRef[]): void {
  if (!db || losers.length === 0) return
  let playCount = 0
  let lastPlayedAt: number | null = null
  let addedAt: number | null = null

  const accumulateStats = (row: TrackMergeStatsRow | undefined): void => {
    if (!row) return
    playCount += row.play_count ?? 0
    if (row.last_played_at !== null && (lastPlayedAt === null || row.last_played_at > lastPlayedAt)) {
      lastPlayedAt = row.last_played_at
    }
    if (row.added_at !== null && (addedAt === null || row.added_at < addedAt)) {
      addedAt = row.added_at
    }
  }

  accumulateStats(db.get<TrackMergeStatsRow>('SELECT play_count, last_played_at, added_at FROM tracks WHERE id = ?', [survivorId]))
  for (const loser of losers) {
    accumulateStats(db.get<TrackMergeStatsRow>('SELECT play_count, last_played_at, added_at FROM tracks WHERE id = ?', [loser.id]))
    db.run('UPDATE listening_sessions SET track_id = ? WHERE track_id = ?', [survivorId, loser.id])
    // Move children before deleting the loser row so its delete triggers and
    // FK cascades fire against an already-emptied path.
    moveTrackChildRows(loser.path, survivorPath)
    db.run('DELETE FROM tracks WHERE id = ?', [loser.id])
  }
  db.run(
    'UPDATE tracks SET play_count = ?, last_played_at = ?, added_at = COALESCE(?, added_at) WHERE id = ?',
    [playCount, lastPlayedAt, addedAt, survivorId]
  )
  // moveTrackChildRows already folded each loser's origin rows into the survivor's path, so
  // the breakdown and the summed column agree without recomputing from scratch.
}

export async function mergeLocalDuplicateTracks(keepPath: string, removedPaths: readonly string[]): Promise<string[]> {
  if (!db) throw new Error('Database not initialized')
  const normalizedKeepPath = typeof keepPath === 'string' ? keepPath.trim() : ''
  const uniqueRemovedPaths = Array.from(new Set(
    removedPaths
      .map((trackPath) => (typeof trackPath === 'string' ? trackPath.trim() : ''))
      .filter((trackPath) => trackPath.length > 0 && trackPath !== normalizedKeepPath)
  ))
  if (!normalizedKeepPath || uniqueRemovedPaths.length === 0) return []

  const survivor = db.get<DuplicateTrackRowRef>(
    "SELECT id, path FROM tracks WHERE path = ? AND source_type = 'local'",
    [normalizedKeepPath]
  )
  if (!survivor) throw new Error('The selected Keep track is no longer in the local library.')

  const losers: DuplicateTrackRowRef[] = []
  for (const removedPath of uniqueRemovedPaths) {
    const loser = db.get<DuplicateTrackRowRef>(
      "SELECT id, path FROM tracks WHERE path = ? AND source_type = 'local'",
      [removedPath]
    )
    if (!loser) throw new Error(`A trashed track is no longer indexed: ${removedPath}`)
    losers.push(loser)
  }

  const ownsTransaction = !db.inTransaction
  if (ownsTransaction) beginLibraryWriteTransaction()
  try {
    mergeDuplicateTrackRows(survivor.id, survivor.path, losers)
    if (ownsTransaction) commitLibraryWriteTransaction()
  } catch (error) {
    if (ownsTransaction) rollbackLibraryWriteTransaction()
    throw error
  }
  await saveDatabase()
  return losers.map((loser) => loser.path)
}

export async function deleteSubsonicSource(sourceId: number, purgeTracks: boolean): Promise<void> {
  if (!db) return
  const source = getSubsonicSourceById(sourceId)

  if (purgeTracks) {
    const sourcePathPattern = `subsonic://${sourceId}/%`
    let includeUnknownSourceTracks = false
    if (source) {
      const countRow = db.get<{ count?: unknown }>('SELECT COUNT(*) as count FROM subsonic_sources WHERE id <> ?', [sourceId])
      const otherSourcesCount = Number(countRow?.count ?? 0)
      includeUnknownSourceTracks = Number.isFinite(otherSourcesCount) && otherSourcesCount <= 0
    }

    const trackSelectSql = includeUnknownSourceTracks
      ? "SELECT path FROM tracks WHERE ((source_type = 'subsonic' AND (source_id = ? OR source_id IS NULL)) OR path LIKE ?)"
      : "SELECT path FROM tracks WHERE ((source_type = 'subsonic' AND source_id = ?) OR path LIKE ?)"
    const trackPaths = db.all<{ path?: unknown }>(trackSelectSql, [sourceId, sourcePathPattern])
      .map((row) => (typeof row.path === 'string' && row.path.trim().length > 0 ? row.path : null))
      .filter((path): path is string => path !== null)

    deleteTrackRelatedRows(trackPaths)
    deleteTrackRelatedRowsByPathPattern(sourcePathPattern)
    if (includeUnknownSourceTracks) {
      db.run(
        "DELETE FROM tracks WHERE ((source_type = 'subsonic' AND (source_id = ? OR source_id IS NULL)) OR path LIKE ?)",
        [sourceId, sourcePathPattern]
      )
    } else {
      db.run(
        "DELETE FROM tracks WHERE ((source_type = 'subsonic' AND source_id = ?) OR path LIKE ?)",
        [sourceId, sourcePathPattern]
      )
    }
  } else {
    db.run(
      `UPDATE tracks
       SET is_available = 0,
           availability_reason = 'source_deleted',
           modified_at = ?
       WHERE source_type = 'subsonic' AND source_id = ?`,
      [Date.now(), sourceId]
    )
  }

  if (source) {
    db.run(`
      DELETE FROM playlist_tracks
      WHERE playlist_id IN (
        SELECT id
        FROM playlists
        WHERE remote_source_type = 'subsonic'
          AND remote_source_id = ?
      )
    `, [sourceId])
    db.run(
      "DELETE FROM playlists WHERE remote_source_type = 'subsonic' AND remote_source_id = ?",
      [sourceId]
    )
    db.run('DELETE FROM subsonic_sources WHERE id = ?', [sourceId])
  }
  await saveDatabase()
}

export async function updateSubsonicSourceStatus(
  sourceId: number,
  input: {
    status: SubsonicSourceLastStatus
    error?: string | null
    syncedAt?: number | null
    checkedAt?: number | null
  },
  options: { persist?: boolean } = {}
): Promise<void> {
  if (!db) return
  const existing = getSubsonicSourceById(sourceId)
  if (!existing) return
  await updateSubsonicSource(
    sourceId,
    {
      last_status: normalizeSubsonicLastStatus(input.status),
      last_error: input.error === undefined ? existing.last_error : input.error,
      last_sync_at: input.syncedAt === undefined ? existing.last_sync_at : input.syncedAt,
      last_checked_at: input.checkedAt === undefined ? existing.last_checked_at : input.checkedAt
    },
    { persist: options.persist }
  )
}

export async function markSubsonicTracksAvailability(
  sourceId: number,
  isAvailable: boolean,
  reason: string | null,
  options: { persist?: boolean } = {}
): Promise<number> {
  if (!db) return 0
  const result = db.run(
    `UPDATE tracks
     SET is_available = ?,
         availability_reason = ?,
         modified_at = ?
     WHERE source_type = 'subsonic' AND source_id = ?`,
    [isAvailable ? 1 : 0, isAvailable ? null : reason, Date.now(), sourceId]
  )
  const count = result.changes
  if (options.persist !== false && count > 0) {
    await saveDatabase()
  }
  return Number.isFinite(count) ? count : 0
}

export async function restoreSubsonicTracksFromSourceUnavailable(
  sourceId: number,
  options: { persist?: boolean } = {}
): Promise<number> {
  if (!db) return 0

  const result = db.run(
    `UPDATE tracks
     SET is_available = 1,
         availability_reason = NULL,
         modified_at = ?
     WHERE source_type = 'subsonic'
       AND source_id = ?
       AND is_available = 0
       AND availability_reason = 'source_unavailable'`,
    [Date.now(), sourceId]
  )
  const count = result.changes
  if (options.persist !== false && count > 0) {
    await saveDatabase()
  }
  return Number.isFinite(count) ? count : 0
}

export async function upsertSubsonicTracks(
  sourceId: number,
  tracks: SubsonicTrackUpsertInput[],
  options: { persist?: boolean; syncSessionKey?: string | null; preserveExistingArtwork?: boolean } = {}
): Promise<{ inserted: number; updated: number }> {
  if (!db || tracks.length === 0) {
    return { inserted: 0, updated: 0 }
  }

  const sourceExists = Boolean(db.get('SELECT 1 FROM subsonic_sources WHERE id = ? LIMIT 1', [sourceId]))
  if (!sourceExists) {
    return { inserted: 0, updated: 0 }
  }

  let inserted = 0
  let updated = 0
  const now = Date.now()

  for (const track of tracks) {
    const genreFields = resolveTrackGenreStorageFields(track)
    const existing = db.get<{ id?: unknown; artwork_hash?: unknown }>(
      'SELECT id, artwork_hash FROM tracks WHERE path = ? LIMIT 1',
      [track.path]
    )
    const exists = Boolean(existing)
    const artworkHash = track.artwork_hash
      ?? (
        options.preserveExistingArtwork && typeof existing?.artwork_hash === 'string'
          ? existing.artwork_hash
          : null
      )

    if (exists) {
      db.run(
        `UPDATE tracks
         SET title = ?,
             artist = ?,
             artist_names_json = NULL,
             album = ?,
             album_artist = ?,
             album_artist_names_json = NULL,
             duration = ?,
             track_number = ?,
             disc_number = ?,
             year = ?,
             genre = ?,
             genre_names_json = ?,
             artwork_hash = ?,
             format = ?,
             sample_rate = ?,
             bit_depth = ?,
             bitrate = ?,
             channels = ?,
             codec = ?,
             codec_profile = ?,
             is_atmos_joc = ?,
             replaygain_track_gain_db = ?,
             replaygain_album_gain_db = ?,
             bpm = ?,
             musical_key = ?,
             source_type = 'subsonic',
             source_id = ?,
             source_track_id = ?,
             source_path = ?,
             is_available = 1,
             availability_reason = NULL,
             file_created_at = NULL,
             modified_at = ?
         WHERE path = ?`,
        [
          track.title,
          track.artist,
          track.album,
          track.album_artist,
          track.duration,
          track.track_number,
          track.disc_number,
          track.year,
          genreFields.genre,
          genreFields.genreNamesJson,
          artworkHash,
          track.format,
          track.sample_rate,
          track.bit_depth,
          track.bitrate,
          track.channels,
          track.codec,
          track.codec_profile,
          track.is_atmos_joc,
          track.replaygain_track_gain_db,
          track.replaygain_album_gain_db,
          track.bpm,
          track.musical_key,
          sourceId,
          track.source_track_id,
          track.source_path,
          now,
          track.path
        ]
      )
      updated += 1
      continue
    }

    db.run(
      `INSERT INTO tracks (
        path,
        title,
        artist,
        album,
        album_artist,
        duration,
        track_number,
        disc_number,
        year,
        genre,
        genre_names_json,
        artwork_hash,
        format,
        sample_rate,
        bit_depth,
        bitrate,
        channels,
        codec,
        codec_profile,
        is_atmos_joc,
        replaygain_track_gain_db,
        replaygain_album_gain_db,
        bpm,
        musical_key,
        source_type,
        source_id,
        source_track_id,
        source_path,
        is_available,
        availability_reason,
        sync_session_key,
        added_at,
        modified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'subsonic', ?, ?, ?, 1, NULL, ?, ?, ?)`,
      [
        track.path,
        track.title,
        track.artist,
        track.album,
        track.album_artist,
        track.duration,
        track.track_number,
        track.disc_number,
        track.year,
        genreFields.genre,
        genreFields.genreNamesJson,
        artworkHash,
        track.format,
        track.sample_rate,
        track.bit_depth,
        track.bitrate,
        track.channels,
        track.codec,
        track.codec_profile,
        track.is_atmos_joc,
        track.replaygain_track_gain_db,
        track.replaygain_album_gain_db,
        track.bpm,
        track.musical_key,
        sourceId,
        track.source_track_id,
        track.source_path,
        options.syncSessionKey ?? null,
        now,
        now
      ]
    )
    inserted += 1
  }

  if (options.persist !== false && (inserted > 0 || updated > 0)) {
    await saveDatabase()
  }

  return { inserted, updated }
}

export async function markMissingSubsonicTracksUnavailable(
  sourceId: number,
  seenSourceTrackIds: Set<string>,
  options: { persist?: boolean } = {}
): Promise<number> {
  if (!db) return 0

  const params: Array<number | string> = [Date.now(), sourceId]
  let sql = `
    UPDATE tracks
    SET is_available = 0,
        availability_reason = 'missing_upstream',
        modified_at = ?
    WHERE source_type = 'subsonic'
      AND source_id = ?
  `

  if (seenSourceTrackIds.size > 0) {
    const placeholders = Array.from(seenSourceTrackIds).map(() => '?').join(', ')
    sql += ` AND (source_track_id IS NULL OR source_track_id NOT IN (${placeholders}))`
    params.push(...seenSourceTrackIds)
  }

  const result = db.run(sql, params)
  const count = result.changes
  if (options.persist !== false && count > 0) {
    await saveDatabase()
  }
  return Number.isFinite(count) ? count : 0
}

export async function replaceSubsonicArtworkHash(
  sourceId: number,
  currentArtworkHash: string,
  nextArtworkHash: string,
  options: { persist?: boolean } = {}
): Promise<number> {
  if (!db) return 0
  const current = currentArtworkHash.trim()
  const next = nextArtworkHash.trim()
  if (!current || !next || current === next) return 0

  const result = db.run(
    `UPDATE tracks
     SET artwork_hash = ?,
         modified_at = ?
     WHERE source_type = 'subsonic'
       AND source_id = ?
       AND artwork_hash = ?`,
    [next, Date.now(), sourceId, current]
  )
  const count = result.changes
  if (options.persist !== false && count > 0) {
    await saveDatabase()
  }
  return Number.isFinite(count) ? count : 0
}

export function getTrackByPath(trackPath: string): DbTrack | null {
  if (!db) return null
  const row = db.get<DbTrackRow>(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
    WHERE t.path = ?
    LIMIT 1
  `, [trackPath]) ?? null
  return row ? attachAlbumIdentityKeys([row])[0] ?? null : null
}

export function getTrackById(trackId: number): DbTrack | null {
  if (!db || !Number.isInteger(trackId) || trackId <= 0) return null
  const row = db.get<DbTrackRow>(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
    WHERE t.id = ?
    LIMIT 1
  `, [trackId]) ?? null
  return row ? attachAlbumIdentityKeys([row])[0] ?? null : null
}

export async function setTrackAvailability(
  trackPath: string,
  isAvailable: boolean,
  reason: string | null,
  options: { persist?: boolean } = {}
): Promise<void> {
  if (!db) return
  db.run(
    `UPDATE tracks
     SET is_available = ?,
         availability_reason = ?,
         modified_at = ?
     WHERE path = ?`,
    [isAvailable ? 1 : 0, isAvailable ? null : reason, Date.now(), trackPath]
  )
  if (options.persist !== false) {
    await saveDatabase()
  }
}

export function getSubsonicTrackCountsBySource(sourceId: number): { total: number; available: number } {
  if (!db) return { total: 0, available: 0 }
  const row = db.get<{ total?: unknown; available?: unknown }>(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN is_available = 1 THEN 1 ELSE 0 END) AS available
    FROM tracks
    WHERE source_type = 'subsonic' AND source_id = ?
  `, [sourceId])
  const total = Number(row?.total ?? 0)
  const available = Number(row?.available ?? 0)
  return {
    total: Number.isFinite(total) ? total : 0,
    available: Number.isFinite(available) ? available : 0
  }
}

export async function deleteJellyfinSource(sourceId: number, purgeTracks: boolean): Promise<void> {
  if (!db) return
  const source = getJellyfinSourceById(sourceId)

  if (purgeTracks) {
    const sourcePathPattern = `jellyfin://${sourceId}/%`
    let includeUnknownSourceTracks = false
    if (source) {
      const countRow = db.get<{ count?: unknown }>('SELECT COUNT(*) as count FROM jellyfin_sources WHERE id <> ?', [sourceId])
      const otherSourcesCount = Number(countRow?.count ?? 0)
      includeUnknownSourceTracks = Number.isFinite(otherSourcesCount) && otherSourcesCount <= 0
    }

    const trackSelectSql = includeUnknownSourceTracks
      ? "SELECT path FROM tracks WHERE ((source_type = 'jellyfin' AND (source_id = ? OR source_id IS NULL)) OR path LIKE ?)"
      : "SELECT path FROM tracks WHERE ((source_type = 'jellyfin' AND source_id = ?) OR path LIKE ?)"
    const trackPaths = db.all<{ path?: unknown }>(trackSelectSql, [sourceId, sourcePathPattern])
      .map((row) => (typeof row.path === 'string' && row.path.trim().length > 0 ? row.path : null))
      .filter((path): path is string => path !== null)

    deleteTrackRelatedRows(trackPaths)
    deleteTrackRelatedRowsByPathPattern(sourcePathPattern)
    if (includeUnknownSourceTracks) {
      db.run(
        "DELETE FROM tracks WHERE ((source_type = 'jellyfin' AND (source_id = ? OR source_id IS NULL)) OR path LIKE ?)",
        [sourceId, sourcePathPattern]
      )
    } else {
      db.run(
        "DELETE FROM tracks WHERE ((source_type = 'jellyfin' AND source_id = ?) OR path LIKE ?)",
        [sourceId, sourcePathPattern]
      )
    }
  } else {
    db.run(
      `UPDATE tracks
       SET is_available = 0,
           availability_reason = 'source_deleted',
           modified_at = ?
       WHERE source_type = 'jellyfin' AND source_id = ?`,
      [Date.now(), sourceId]
    )
  }

  if (source) {
    db.run('DELETE FROM jellyfin_sources WHERE id = ?', [sourceId])
  }
  await saveDatabase()
}

export async function updateJellyfinSourceStatus(
  sourceId: number,
  input: {
    status: JellyfinSourceLastStatus
    error?: string | null
    syncedAt?: number | null
    checkedAt?: number | null
  },
  options: { persist?: boolean } = {}
): Promise<void> {
  if (!db) return
  const existing = getJellyfinSourceById(sourceId)
  if (!existing) return
  await updateJellyfinSource(
    sourceId,
    {
      last_status: normalizeJellyfinLastStatus(input.status),
      last_error: input.error === undefined ? existing.last_error : input.error,
      last_sync_at: input.syncedAt === undefined ? existing.last_sync_at : input.syncedAt,
      last_checked_at: input.checkedAt === undefined ? existing.last_checked_at : input.checkedAt
    },
    { persist: options.persist }
  )
}

export async function markJellyfinTracksAvailability(
  sourceId: number,
  isAvailable: boolean,
  reason: string | null,
  options: { persist?: boolean } = {}
): Promise<number> {
  if (!db) return 0
  const result = db.run(
    `UPDATE tracks
     SET is_available = ?,
         availability_reason = ?,
         modified_at = ?
     WHERE source_type = 'jellyfin' AND source_id = ?`,
    [isAvailable ? 1 : 0, isAvailable ? null : reason, Date.now(), sourceId]
  )
  const count = result.changes
  if (options.persist !== false && count > 0) {
    await saveDatabase()
  }
  return Number.isFinite(count) ? count : 0
}

export async function restoreJellyfinTracksFromSourceUnavailable(
  sourceId: number,
  options: { persist?: boolean } = {}
): Promise<number> {
  if (!db) return 0

  const result = db.run(
    `UPDATE tracks
     SET is_available = 1,
         availability_reason = NULL,
         modified_at = ?
     WHERE source_type = 'jellyfin'
       AND source_id = ?
       AND is_available = 0
       AND availability_reason = 'source_unavailable'`,
    [Date.now(), sourceId]
  )
  const count = result.changes
  if (options.persist !== false && count > 0) {
    await saveDatabase()
  }
  return Number.isFinite(count) ? count : 0
}

export async function upsertJellyfinTracks(
  sourceId: number,
  tracks: JellyfinTrackUpsertInput[],
  options: { persist?: boolean; syncSessionKey?: string | null } = {}
): Promise<{ inserted: number; updated: number }> {
  if (!db || tracks.length === 0) {
    return { inserted: 0, updated: 0 }
  }

  const sourceExists = Boolean(db.get('SELECT 1 FROM jellyfin_sources WHERE id = ? LIMIT 1', [sourceId]))
  if (!sourceExists) {
    return { inserted: 0, updated: 0 }
  }

  let inserted = 0
  let updated = 0
  const now = Date.now()

  for (const track of tracks) {
    const genreFields = resolveTrackGenreStorageFields(track)
    const exists = Boolean(db.get('SELECT id FROM tracks WHERE path = ? LIMIT 1', [track.path]))

    if (exists) {
      db.run(
        `UPDATE tracks
         SET title = ?,
             artist = ?,
             artist_names_json = NULL,
             album = ?,
             album_artist = ?,
             album_artist_names_json = NULL,
             duration = ?,
             track_number = ?,
             disc_number = ?,
             year = ?,
             genre = ?,
             genre_names_json = ?,
             artwork_hash = ?,
             format = ?,
             sample_rate = ?,
             bit_depth = ?,
             bitrate = ?,
             channels = ?,
             codec = ?,
             codec_profile = ?,
             is_atmos_joc = ?,
             replaygain_track_gain_db = ?,
             replaygain_album_gain_db = ?,
             bpm = ?,
             musical_key = ?,
             source_type = 'jellyfin',
             source_id = ?,
             source_track_id = ?,
             source_path = ?,
             is_available = 1,
             availability_reason = NULL,
             file_created_at = NULL,
             modified_at = ?
         WHERE path = ?`,
        [
          track.title,
          track.artist,
          track.album,
          track.album_artist,
          track.duration,
          track.track_number,
          track.disc_number,
          track.year,
          genreFields.genre,
          genreFields.genreNamesJson,
          track.artwork_hash,
          track.format,
          track.sample_rate,
          track.bit_depth,
          track.bitrate,
          track.channels,
          track.codec,
          track.codec_profile,
          track.is_atmos_joc,
          track.replaygain_track_gain_db,
          track.replaygain_album_gain_db,
          track.bpm,
          track.musical_key,
          sourceId,
          track.source_track_id,
          track.source_path,
          now,
          track.path
        ]
      )
      updated += 1
      continue
    }

    db.run(
      `INSERT INTO tracks (
        path,
        title,
        artist,
        album,
        album_artist,
        duration,
        track_number,
        disc_number,
        year,
        genre,
        genre_names_json,
        artwork_hash,
        format,
        sample_rate,
        bit_depth,
        bitrate,
        channels,
        codec,
        codec_profile,
        is_atmos_joc,
        replaygain_track_gain_db,
        replaygain_album_gain_db,
        bpm,
        musical_key,
        source_type,
        source_id,
        source_track_id,
        source_path,
        is_available,
        availability_reason,
        sync_session_key,
        added_at,
        modified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'jellyfin', ?, ?, ?, 1, NULL, ?, ?, ?)`,
      [
        track.path,
        track.title,
        track.artist,
        track.album,
        track.album_artist,
        track.duration,
        track.track_number,
        track.disc_number,
        track.year,
        genreFields.genre,
        genreFields.genreNamesJson,
        track.artwork_hash,
        track.format,
        track.sample_rate,
        track.bit_depth,
        track.bitrate,
        track.channels,
        track.codec,
        track.codec_profile,
        track.is_atmos_joc,
        track.replaygain_track_gain_db,
        track.replaygain_album_gain_db,
        track.bpm,
        track.musical_key,
        sourceId,
        track.source_track_id,
        track.source_path,
        options.syncSessionKey ?? null,
        now,
        now
      ]
    )
    inserted += 1
  }

  if (options.persist !== false && (inserted > 0 || updated > 0)) {
    await saveDatabase()
  }

  return { inserted, updated }
}

export async function markMissingJellyfinTracksUnavailable(
  sourceId: number,
  seenSourceTrackIds: Set<string>,
  options: { persist?: boolean } = {}
): Promise<number> {
  if (!db) return 0

  const params: Array<number | string> = [Date.now(), sourceId]
  let sql = `
    UPDATE tracks
    SET is_available = 0,
        availability_reason = 'missing_upstream',
        modified_at = ?
    WHERE source_type = 'jellyfin'
      AND source_id = ?
  `

  if (seenSourceTrackIds.size > 0) {
    const placeholders = Array.from(seenSourceTrackIds).map(() => '?').join(', ')
    sql += ` AND (source_track_id IS NULL OR source_track_id NOT IN (${placeholders}))`
    params.push(...seenSourceTrackIds)
  }

  const result = db.run(sql, params)
  const count = result.changes
  if (options.persist !== false && count > 0) {
    await saveDatabase()
  }
  return Number.isFinite(count) ? count : 0
}

export function getJellyfinTrackCountsBySource(sourceId: number): { total: number; available: number } {
  if (!db) return { total: 0, available: 0 }
  const row = db.get<{ total?: unknown; available?: unknown }>(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN is_available = 1 THEN 1 ELSE 0 END) AS available
    FROM tracks
    WHERE source_type = 'jellyfin' AND source_id = ?
  `, [sourceId])
  const total = Number(row?.total ?? 0)
  const available = Number(row?.available ?? 0)
  return {
    total: Number.isFinite(total) ? total : 0,
    available: Number.isFinite(available) ? available : 0
  }
}

export async function cleanupOrphanedRemoteTracks(options: { persist?: boolean } = {}): Promise<number> {
  if (!db) return 0

  const rows = db.all<{ path?: unknown }>(`
    SELECT path
    FROM tracks
    WHERE (
      source_type = 'subsonic'
      AND (source_id IS NULL OR source_id NOT IN (SELECT id FROM subsonic_sources))
      AND COALESCE(availability_reason, '') <> 'source_deleted'
    ) OR (
      source_type = 'jellyfin'
      AND (source_id IS NULL OR source_id NOT IN (SELECT id FROM jellyfin_sources))
      AND COALESCE(availability_reason, '') <> 'source_deleted'
    )
  `)
  const orphanPaths = Array.from(new Set(
    rows
      .map((row) => (typeof row.path === 'string' ? row.path.trim() : ''))
      .filter((path): path is string => path.length > 0)
  ))
  if (orphanPaths.length === 0) return 0

  deleteTrackRelatedRows(orphanPaths)

  let deletedCount = 0
  for (let offset = 0; offset < orphanPaths.length; offset += SQLITE_SAFE_MAX_VARIABLES) {
    const chunk = orphanPaths.slice(offset, offset + SQLITE_SAFE_MAX_VARIABLES)
    const placeholders = chunk.map(() => '?').join(', ')
    const chunkDeleted = db.run(`DELETE FROM tracks WHERE path IN (${placeholders})`, chunk).changes
    if (Number.isFinite(chunkDeleted) && chunkDeleted > 0) {
      deletedCount += chunkDeleted
    }
  }

  if (options.persist !== false && deletedCount > 0) {
    await saveDatabase()
  }

  return deletedCount
}

function normalizeLyricsCacheStatus(value: unknown): LyricsCacheStatus | null {
  if (value === 'hit' || value === 'not_found') return value
  return null
}

function normalizeLyricsCacheSource(value: unknown): LyricsCacheSource | null {
  if (value === 'embedded' || value === 'lrclib' || value === 'xlrcdb') return value
  return null
}

function normalizeLyricsCacheProvider(value: unknown): LyricsProvider | null {
  if (value === 'lrclib') return 'lrclib'
  if (value === 'xlrcdb') return 'xlrcdb'
  return null
}

function parseLyricsLinesJson(value: string | null): LyricsLine[] {
  if (value == null) return []
  const normalized = value.trim()
  if (!normalized) return []

  try {
    return sanitizeLyricsLines(JSON.parse(normalized))
  } catch {
    return []
  }
}

function normalizeLyricsFormat(value: unknown): LyricsFormat | null {
  if (value === 'plain' || value === 'lrc' || value === 'xlrc') return value
  return null
}

function hasRichLyricsLine(line: LyricsLine): boolean {
  return (
    (line.words?.length ?? 0) > 0
    || (line.furigana?.length ?? 0) > 0
    || (line.translations?.length ?? 0) > 0
    || Boolean(line.voice)
  )
}

function inferLyricsFormat(entry: {
  source?: LyricsCacheSource
  syncedLyrics: string | null
  syncedLines: LyricsLine[]
}): LyricsFormat {
  const hasSyncedLyrics = entry.syncedLyrics !== null || entry.syncedLines.length > 0
  if (entry.source === 'xlrcdb') return hasSyncedLyrics ? 'xlrc' : 'plain'
  if (entry.source === 'lrclib' || entry.source === 'embedded') {
    return hasSyncedLyrics ? 'lrc' : 'plain'
  }
  if (entry.syncedLines.some(hasRichLyricsLine)) return 'xlrc'
  if (hasSyncedLyrics) return 'lrc'
  return 'plain'
}

function normalizeLyricsTrackPath(trackPath: string): string {
  return trackPath.trim()
}

function hasManualLyricsOverride(entry: {
  plainLyrics: string | null
  syncedLyrics: string | null
  syncedLines: LyricsLine[]
}): boolean {
  return (
    entry.plainLyrics !== null
    || entry.syncedLyrics !== null
    || entry.syncedLines.length > 0
  )
}

export function getLyricsCache(trackPath: string, metadataSignature: string): LyricsCacheEntry | null {
  if (!db) return null

  const row = db.get<Record<string, unknown>>(`
    SELECT
      track_path,
      metadata_signature,
      status,
      source,
      provider,
      plain_lyrics,
      synced_lyrics,
      synced_lines_json,
      updated_at
    FROM lyrics_cache
    WHERE track_path = ? AND metadata_signature = ?
    LIMIT 1
  `, [trackPath, metadataSignature])
  if (!row) return null

  const normalizedPath = toText(row.track_path)
  const normalizedSignature = toText(row.metadata_signature)
  const normalizedStatus = normalizeLyricsCacheStatus(row.status)
  const normalizedSource = normalizeLyricsCacheSource(row.source)
  if (!normalizedPath || !normalizedSignature || !normalizedStatus || !normalizedSource) {
    return null
  }

  const plainLyrics = toText(row.plain_lyrics)
  const syncedLyrics = toText(row.synced_lyrics)
  const syncedLines = parseLyricsLinesJson(typeof row.synced_lines_json === 'string' ? row.synced_lines_json : null)

  return {
    trackPath: normalizedPath,
    metadataSignature: normalizedSignature,
    status: normalizedStatus,
    source: normalizedSource,
    provider: normalizeLyricsCacheProvider(row.provider),
    format: inferLyricsFormat({ source: normalizedSource, syncedLyrics, syncedLines }),
    plainLyrics,
    syncedLyrics,
    syncedLines,
    updatedAt: toNumber(row.updated_at) ?? Date.now()
  }
}

export async function upsertLyricsCache(entry: LyricsCacheUpsertInput): Promise<void> {
  if (!db) return

  db.run(
    `INSERT INTO lyrics_cache (
      track_path,
      metadata_signature,
      status,
      source,
      provider,
      plain_lyrics,
      synced_lyrics,
      synced_lines_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(track_path) DO UPDATE SET
      metadata_signature = excluded.metadata_signature,
      status = excluded.status,
      source = excluded.source,
      provider = excluded.provider,
      plain_lyrics = excluded.plain_lyrics,
      synced_lyrics = excluded.synced_lyrics,
      synced_lines_json = excluded.synced_lines_json,
      updated_at = excluded.updated_at`,
    [
      entry.trackPath,
      entry.metadataSignature,
      entry.status,
      entry.source,
      entry.provider,
      entry.plainLyrics,
      entry.syncedLyrics,
      JSON.stringify(sanitizeLyricsLines(entry.syncedLines)),
      entry.updatedAt ?? Date.now()
    ]
  )
  await saveDatabase()
}

export async function deleteLyricsCache(trackPath: string): Promise<void> {
  if (!db) return
  db.run('DELETE FROM lyrics_cache WHERE track_path = ?', [trackPath])
  await saveDatabase()
}

export async function clearLyricsCache(): Promise<void> {
  if (!db) return
  db.run('DELETE FROM lyrics_cache')
  await saveDatabase()
}

export async function clearLyricsCacheMisses(): Promise<void> {
  if (!db) return
  db.run("DELETE FROM lyrics_cache WHERE status = 'not_found'")
  await saveDatabase()
}

export interface TrackLoudnessEntry {
  trackPath: string
  loudnessLufs: number
  peakLinear: number | null
  method: string
  fileSize: number | null
  fileMtimeMs: number | null
  analyzedAt: number
}

export interface TrackLoudnessUpsertInput {
  trackPath: string
  loudnessLufs: number
  peakLinear: number | null
  method: string
  fileSize: number | null
  fileMtimeMs: number | null
}

export function getTrackLoudness(trackPath: string): TrackLoudnessEntry | null {
  if (!db) return null

  const row = db.get<Record<string, unknown>>(`
    SELECT
      track_path,
      loudness_lufs,
      peak_linear,
      method,
      file_size,
      file_mtime_ms,
      analyzed_at
    FROM track_loudness
    WHERE track_path = ?
    LIMIT 1
  `, [trackPath])
  if (!row) return null

  const resolvedPath = toText(row.track_path)
  const loudnessLufs = toNumber(row.loudness_lufs)
  const method = toText(row.method)
  if (!resolvedPath || loudnessLufs == null || !method) return null

  return {
    trackPath: resolvedPath,
    loudnessLufs,
    peakLinear: toNumber(row.peak_linear),
    method,
    fileSize: toNumber(row.file_size),
    fileMtimeMs: toNumber(row.file_mtime_ms),
    analyzedAt: toNumber(row.analyzed_at) ?? 0
  }
}

export async function setTrackLoudness(entry: TrackLoudnessUpsertInput): Promise<void> {
  if (!db) return
  if (!entry.trackPath || !Number.isFinite(entry.loudnessLufs)) return

  db.run(
    `INSERT INTO track_loudness (
      track_path,
      loudness_lufs,
      peak_linear,
      method,
      file_size,
      file_mtime_ms,
      analyzed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(track_path) DO UPDATE SET
      loudness_lufs = excluded.loudness_lufs,
      peak_linear = excluded.peak_linear,
      method = excluded.method,
      file_size = excluded.file_size,
      file_mtime_ms = excluded.file_mtime_ms,
      analyzed_at = excluded.analyzed_at`,
    [
      entry.trackPath,
      entry.loudnessLufs,
      entry.peakLinear,
      entry.method,
      entry.fileSize,
      entry.fileMtimeMs,
      Date.now()
    ]
  )
  await saveDatabase()
}

export async function deleteTrackLoudness(trackPath: string): Promise<void> {
  if (!db) return
  db.run('DELETE FROM track_loudness WHERE track_path = ?', [trackPath])
  await saveDatabase()
}

export function getLyricsTrackOverride(trackPath: string): LyricsTrackOverrideEntry | null {
  if (!db) return null

  const normalizedTrackPath = normalizeLyricsTrackPath(trackPath)
  if (!normalizedTrackPath) return null

  const row = db.get<Record<string, unknown>>(`
    SELECT
      track_path,
      format,
      plain_lyrics,
      synced_lyrics,
      synced_lines_json,
      sync_offset_ms,
      updated_at
    FROM lyrics_track_overrides
    WHERE track_path = ?
    LIMIT 1
  `, [normalizedTrackPath])
  if (!row) return null

  const resolvedTrackPath = toText(row.track_path)
  if (!resolvedTrackPath) return null

  return {
    trackPath: resolvedTrackPath,
    format: normalizeLyricsFormat(row.format) ?? inferLyricsFormat({
      syncedLyrics: toText(row.synced_lyrics),
      syncedLines: parseLyricsLinesJson(typeof row.synced_lines_json === 'string' ? row.synced_lines_json : null)
    }),
    plainLyrics: toText(row.plain_lyrics),
    syncedLyrics: toText(row.synced_lyrics),
    syncedLines: parseLyricsLinesJson(typeof row.synced_lines_json === 'string' ? row.synced_lines_json : null),
    syncOffsetMs: toNumber(row.sync_offset_ms) ?? 0,
    updatedAt: toNumber(row.updated_at) ?? Date.now()
  }
}

export async function upsertLyricsTrackManual(
  trackPaths: string[],
  input: LyricsTrackManualInput
): Promise<number> {
  if (!db) return 0

  const normalizedTrackPaths = normalizeMetadataEditTrackPaths(trackPaths)
  if (normalizedTrackPaths.length === 0) return 0

  const syncedLines = sanitizeLyricsLines(input.syncedLines)
  const syncedLinesJson = JSON.stringify(syncedLines)
  const now = Date.now()

  let updated = 0
  for (const trackPath of normalizedTrackPaths) {
    const existing = getLyricsTrackOverride(trackPath)
    const preservedOffset = existing?.syncOffsetMs ?? 0
    db.run(
      `INSERT INTO lyrics_track_overrides (
        track_path,
        format,
        plain_lyrics,
        synced_lyrics,
        synced_lines_json,
        sync_offset_ms,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_path) DO UPDATE SET
        format = excluded.format,
        plain_lyrics = excluded.plain_lyrics,
        synced_lyrics = excluded.synced_lyrics,
        synced_lines_json = excluded.synced_lines_json,
        sync_offset_ms = excluded.sync_offset_ms,
        updated_at = excluded.updated_at`,
      [
        trackPath,
        input.format,
        input.plainLyrics,
        input.syncedLyrics,
        syncedLinesJson,
        preservedOffset,
        now
      ]
    )
    updated += 1
  }

  await saveDatabase()
  return updated
}

export async function clearLyricsTrackManual(trackPaths: string[]): Promise<number> {
  if (!db) return 0

  const normalizedTrackPaths = normalizeMetadataEditTrackPaths(trackPaths)
  if (normalizedTrackPaths.length === 0) return 0

  let cleared = 0
  const now = Date.now()
  for (const trackPath of normalizedTrackPaths) {
    const existing = getLyricsTrackOverride(trackPath)
    if (!existing || !hasManualLyricsOverride(existing)) {
      continue
    }

    if (existing.syncOffsetMs === 0) {
      db.run('DELETE FROM lyrics_track_overrides WHERE track_path = ?', [trackPath])
    } else {
      db.run(
        `UPDATE lyrics_track_overrides
         SET format = NULL,
             plain_lyrics = NULL,
             synced_lyrics = NULL,
             synced_lines_json = ?,
             updated_at = ?
         WHERE track_path = ?`,
        ['[]', now, trackPath]
      )
    }
    cleared += 1
  }

  if (cleared > 0) {
    await saveDatabase()
  }
  return cleared
}

export async function setLyricsTrackSyncOffset(trackPaths: string[], offsetMs: number): Promise<number> {
  if (!db) return 0

  const normalizedTrackPaths = normalizeMetadataEditTrackPaths(trackPaths)
  if (normalizedTrackPaths.length === 0) return 0

  const resolvedOffset = Number.isFinite(offsetMs) ? Math.trunc(offsetMs) : 0
  const now = Date.now()
  let updated = 0

  for (const trackPath of normalizedTrackPaths) {
    const existing = getLyricsTrackOverride(trackPath)
    if (!existing) {
      if (resolvedOffset === 0) continue
      db.run(
        `INSERT INTO lyrics_track_overrides (
          track_path,
          plain_lyrics,
          synced_lyrics,
          synced_lines_json,
          sync_offset_ms,
          updated_at
        ) VALUES (?, NULL, NULL, ?, ?, ?)`,
        [trackPath, '[]', resolvedOffset, now]
      )
      updated += 1
      continue
    }

    if (existing.syncOffsetMs === resolvedOffset) continue

    if (resolvedOffset === 0 && !hasManualLyricsOverride(existing)) {
      db.run('DELETE FROM lyrics_track_overrides WHERE track_path = ?', [trackPath])
    } else {
      db.run(
        `UPDATE lyrics_track_overrides
         SET sync_offset_ms = ?,
             updated_at = ?
         WHERE track_path = ?`,
        [resolvedOffset, now, trackPath]
      )
    }

    updated += 1
  }

  if (updated > 0) {
    await saveDatabase()
  }
  return updated
}

const ALL_TRACKS_ORDER_BY_CLAUSE = `
  ORDER BY
    COALESCE(o.title, t.title) COLLATE NOCASE,
    COALESCE(o.album, t.album) COLLATE NOCASE,
    COALESCE(o.disc_number, t.disc_number, 0),
    COALESCE(o.track_number, t.track_number, 0),
    t.path COLLATE NOCASE
`

function normalizeLibraryTrackPageRequest(
  request?: LibraryTrackPageRequest | null
): { offset: number; limit: number } {
  const rawOffset = Number(request?.offset)
  const rawLimit = Number(request?.limit)
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0
  const requestedLimit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.trunc(rawLimit)
    : DEFAULT_LIBRARY_TRACK_PAGE_LIMIT
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_LIBRARY_TRACK_PAGE_LIMIT)
  return { offset, limit }
}

// Get all tracks
export function getAllTracks(): DbTrack[] {
  return measureLibraryQuery('getTracks', () => {
    const tracks = readEffectiveTrackRows(`
      SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
      ${EFFECTIVE_TRACK_FROM_CLAUSE}
      ${ALL_TRACKS_ORDER_BY_CLAUSE}
    `)
    const snapshot = getLibraryTrackSnapshot()
    if (snapshot) {
      return attachAlbumIdentityKeysWithMap(tracks, snapshot.identityKeysByPath)
    }
    return attachAlbumIdentityKeys(tracks, tracks)
  })
}

export function getTrackPage(request?: LibraryTrackPageRequest | null): LibraryTrackPage {
  return measureLibraryQuery('getTrackPage', () => {
    const { offset, limit } = normalizeLibraryTrackPageRequest(request)
    const snapshot = getLibraryTrackSnapshot()
    const total = snapshot ? snapshot.sortedPaths.length : 0
    if (!snapshot || total === 0 || offset >= total) {
      return {
        tracks: [],
        offset,
        limit,
        total,
        nextOffset: offset,
        hasMore: false
      }
    }

    const pagePaths = snapshot.sortedPaths.slice(offset, offset + limit)
    const rows = readEffectiveTrackRowsByPaths(pagePaths)
    const tracks = attachAlbumIdentityKeysWithMap(rows, snapshot.identityKeysByPath)
    const nextOffset = offset + pagePaths.length

    return {
      tracks,
      offset,
      limit,
      total,
      nextOffset,
      hasMore: nextOffset < total
    }
  })
}

export function getTracksByPaths(trackPaths: readonly string[] | null | undefined): DbTrack[] {
  return measureLibraryQuery('getTracksByPaths', () => {
    if (!db || !Array.isArray(trackPaths) || trackPaths.length === 0) return []

    const requestedPaths = trackPaths.filter((trackPath): trackPath is string => (
      typeof trackPath === 'string' && trackPath.length > 0
    ))
    if (requestedPaths.length === 0) return []

    const rows = readEffectiveTrackRowsByPaths(requestedPaths)
    const tracksByPath = new Map(attachAlbumIdentityKeys(rows).map((track) => [track.path, track]))
    const tracks: DbTrack[] = []
    for (const trackPath of requestedPaths) {
      const track = tracksByPath.get(trackPath)
      if (track) tracks.push(track)
    }
    return tracks
  })
}

export function getIntegrityScanTrackTargets(scope: IntegrityScanScope): IntegrityScanTrackTarget[] {
  if (!db) return []
  const tracks = readEffectiveTrackRows(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
    WHERE t.source_type = 'local'
    ORDER BY t.path COLLATE NOCASE
  `)

  return filterIntegrityTargetsByScope(
    tracks.map((track) => ({
      path: track.path,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      format: track.format,
      sampleRate: track.sample_rate,
      bitDepth: track.bit_depth,
      bitrate: track.bitrate,
      channels: track.channels
    })),
    scope
  )
}

// Get tracks by artist
export function getTracksByArtist(artist: string, mode: ArtistBrowseMode = 'canonical'): DbTrack[] {
  return measureLibraryQuery('getTracksByArtist', () => {
    if (!db) return []
    const targetArtistKey = normalizeKey(artist)
    if (!targetArtistKey) return []
    const resolvedMode: ArtistBrowseMode = mode === 'strict' ? 'strict' : 'canonical'

    const matched: DbTrackRow[] = []
    for (const track of iterateEffectiveTrackRows(`
      SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
      ${EFFECTIVE_TRACK_FROM_CLAUSE}
    `)) {
      if (trackMatchesBrowseArtist(track, targetArtistKey, resolvedMode)) {
        matched.push(track)
      }
    }

    return attachAlbumIdentityKeys(matched.sort(compareTracksByAlbumDiscTrackTitle))
  })
}

// Get tracks by album
export function getTracksByAlbum(album: string, artist?: string, identityKey?: string): DbTrack[] {
  return measureLibraryQuery('getTracksByAlbum', () => {
    if (!db) return []
    const albumKey = normalizeKey(normalizeAlbumName(album))
    const tracks = readEffectiveTrackRowsByAlbumKey(albumKey)
    if (tracks.length === 0) return []
    const groups = buildAlbumGroups(tracks)

    const normalizedIdentityKey = normalizeDisplay(identityKey ?? '')
    if (normalizedIdentityKey) {
      const directGroup = groups.get(normalizedIdentityKey)
      if (directGroup && directGroup.albumKey === albumKey) {
        return attachAlbumIdentityKeys([...directGroup.tracks].sort(compareTracksByDiscTrackTitle), tracks)
      }
    }

    if (!artist || !normalizeDisplay(artist)) {
      const matched = tracks.filter((track) => normalizeKey(normalizeAlbumName(track.album)) === albumKey)
      return attachAlbumIdentityKeys(matched.sort(compareTracksByDiscTrackTitle), tracks)
    }

    const artistKey = normalizeKey(artist)
    if (!artistKey) {
      const matched = tracks.filter((track) => normalizeKey(normalizeAlbumName(track.album)) === albumKey)
      return attachAlbumIdentityKeys(matched.sort(compareTracksByDiscTrackTitle), tracks)
    }

    const albumGroups = Array.from(groups.values()).filter((group) => group.albumKey === albumKey)
    for (const group of albumGroups) {
      if (group.artistKey === artistKey) {
        return attachAlbumIdentityKeys([...group.tracks].sort(compareTracksByDiscTrackTitle), tracks)
      }
    }

    const aliasMatches = albumGroups.filter((group) => group.aliasArtistKeys.has(artistKey))
    if (aliasMatches.length === 1) {
      return attachAlbumIdentityKeys([...aliasMatches[0].tracks].sort(compareTracksByDiscTrackTitle), tracks)
    }

    // Defensive fallback if canonical grouping misses a case.
    const fallback = tracks.filter((track) => {
      if (normalizeKey(normalizeAlbumName(track.album)) !== albumKey) return false
      if (normalizeKey(track.album_artist ?? '') === artistKey) return true
      if (normalizeKey(track.artist) === artistKey) return true
      if (getParsedTrackArtistNames(track).some((name) => normalizeKey(name) === artistKey)) return true
      if (getParsedAlbumArtistNames(track).some((name) => normalizeKey(name) === artistKey)) return true
      return splitCollaborators(track.artist).some((name) => normalizeKey(name) === artistKey)
    })
    return attachAlbumIdentityKeys(fallback.sort(compareTracksByDiscTrackTitle), tracks)
  })
}

export function getTracksByGenre(genre: string): DbTrack[] {
  return measureLibraryQuery('getTracksByGenre', () => {
    if (!db) return []
    const targetGenreKey = normalizeKey(normalizeGenreName(genre))
    if (!targetGenreKey) return []

    const matched: DbTrackRow[] = []
    for (const track of iterateEffectiveTrackRows(`
      SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
      ${EFFECTIVE_TRACK_FROM_CLAUSE}
    `)) {
      if (getGenreNamesForTrack(track).some((name) => normalizeKey(name) === targetGenreKey)) {
        matched.push(track)
      }
    }

    return attachAlbumIdentityKeys(
      matched.sort(compareTracksByAlbumDiscTrackTitle),
      readAlbumIdentityRowsForTracks(matched)
    )
  })
}

export function getTracksByYear(year: number | null): DbTrack[] {
  return measureLibraryQuery('getTracksByYear', () => {
    if (!db) return []
    if (year !== null && !Number.isInteger(year)) return []

    const tracks = Array.from(iterateEffectiveTrackRows(`
      SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
      ${EFFECTIVE_TRACK_FROM_CLAUSE}
    `))
    const groups = buildAlbumGroups(tracks)
    const matched: DbTrackRow[] = []

    for (const group of groups.values()) {
      if (group.year !== year) continue
      if (!isAlbumGroupEligible(group, { includeSingles: true })) continue
      matched.push(...group.tracks)
    }

    return attachAlbumIdentityKeys(
      matched.sort(compareTracksByAlbumDiscTrackTitle),
      tracks
    )
  })
}

export function getGenres(): GenreRecord[] {
  return measureLibraryQuery('getGenres', () => {
    if (!db) return []

    interface GenreAggregate {
      genre: string
      track_count: number
      album_identity_keys: Set<string>
      artwork_hash: string | null
      newestArtworkYear: number
      newestArtworkAddedAt: number
      newestArtworkModifiedAt: number
    }

    const missingAlbumArtistBucketProbes = readMissingAlbumArtistBucketProbes()
    const genreCounts = new Map<string, GenreAggregate>()

    for (const track of iterateEffectiveTrackRows(`
      SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
      ${EFFECTIVE_TRACK_FROM_CLAUSE}
    `)) {
      const genreNames = getGenreNamesForTrack(track)
      if (genreNames.length === 0) continue

      const albumIdentityKey = resolveAlbumIdentityForTrack(track, missingAlbumArtistBucketProbes).identityKey
      const seenTrackGenreKeys = new Set<string>()

      for (const genreName of genreNames) {
        const key = normalizeKey(genreName)
        if (!key || seenTrackGenreKeys.has(key)) continue
        seenTrackGenreKeys.add(key)

        let aggregate = genreCounts.get(key)
        if (!aggregate) {
          aggregate = {
            genre: genreName,
            track_count: 0,
            album_identity_keys: new Set<string>(),
            artwork_hash: null,
            newestArtworkYear: -1,
            newestArtworkAddedAt: -1,
            newestArtworkModifiedAt: -1
          }
          genreCounts.set(key, aggregate)
        }

        aggregate.track_count += 1
        aggregate.album_identity_keys.add(albumIdentityKey)

        if (!track.artwork_hash) continue
        const candidateYear = track.year ?? -1
        const shouldReplaceArtwork = (
          aggregate.artwork_hash == null
          || candidateYear > aggregate.newestArtworkYear
          || (
            candidateYear === aggregate.newestArtworkYear
            && (
              track.added_at > aggregate.newestArtworkAddedAt
              || (
                track.added_at === aggregate.newestArtworkAddedAt
                && track.modified_at > aggregate.newestArtworkModifiedAt
              )
            )
          )
        )

        if (!shouldReplaceArtwork) continue
        aggregate.artwork_hash = track.artwork_hash
        aggregate.newestArtworkYear = candidateYear
        aggregate.newestArtworkAddedAt = track.added_at
        aggregate.newestArtworkModifiedAt = track.modified_at
      }
    }

    return Array.from(genreCounts.values())
      .map(({ genre, track_count, album_identity_keys, artwork_hash }) => ({
        genre,
        track_count,
        album_count: album_identity_keys.size,
        artwork_hash
      }))
      .sort((a, b) => a.genre.localeCompare(b.genre, undefined, { sensitivity: 'base' }))
  })
}

interface ArtistImageRow {
  browse_mode: ArtistBrowseMode
  artist_key: string
  artist_name: string
  manual_image_hash: string | null
  detected_image_hash: string | null
  detected_source_path: string | null
  detected_source_mtime: number | null
  updated_at: number
}

function normalizeArtistBrowseMode(mode?: ArtistBrowseMode): ArtistBrowseMode {
  return mode === 'strict' ? 'strict' : 'canonical'
}

function normalizeArtistImageInput(artist: string, mode?: ArtistBrowseMode): {
  mode: ArtistBrowseMode
  artistName: string
  artistKey: string
} {
  const artistName = normalizeDisplay(artist) || UNKNOWN_ARTIST_NAME
  const artistKey = getArtistImageKey(artistName)
  if (!artistKey) {
    throw new Error('Artist name is required.')
  }

  return {
    mode: normalizeArtistBrowseMode(mode),
    artistName,
    artistKey
  }
}

function readArtistImageRowsForMode(mode: ArtistBrowseMode): Map<string, ArtistImageRow> {
  const rows = new Map<string, ArtistImageRow>()
  if (!db) return rows

  for (const row of db.iterate<Record<string, unknown>>(`
    SELECT
      browse_mode,
      artist_key,
      artist_name,
      manual_image_hash,
      detected_image_hash,
      detected_source_path,
      detected_source_mtime,
      updated_at
    FROM artist_images
    WHERE browse_mode = ?
  `, [mode])) {
    const artistKey = typeof row.artist_key === 'string' ? row.artist_key : ''
    if (!artistKey) continue

    const detectedSourceMtime = typeof row.detected_source_mtime === 'number'
      ? row.detected_source_mtime
      : (row.detected_source_mtime == null ? null : Number(row.detected_source_mtime))
    const normalizedDetectedSourceMtime = typeof detectedSourceMtime === 'number' && Number.isFinite(detectedSourceMtime)
      ? detectedSourceMtime
      : null

    rows.set(artistKey, {
      browse_mode: mode,
      artist_key: artistKey,
      artist_name: typeof row.artist_name === 'string' ? row.artist_name : UNKNOWN_ARTIST_NAME,
      manual_image_hash: typeof row.manual_image_hash === 'string' ? row.manual_image_hash : null,
      detected_image_hash: typeof row.detected_image_hash === 'string' ? row.detected_image_hash : null,
      detected_source_path: typeof row.detected_source_path === 'string' ? row.detected_source_path : null,
      detected_source_mtime: normalizedDetectedSourceMtime,
      updated_at: typeof row.updated_at === 'number' ? row.updated_at : Date.now()
    })
  }

  return rows
}

function normalizeCachedImageExtension(imagePath: string): string {
  const rawExtension = extname(imagePath).toLowerCase()
  if (rawExtension === '.png') return '.png'
  if (rawExtension === '.webp') return '.webp'
  if (rawExtension === '.gif') return '.gif'
  if (rawExtension === '.bmp') return '.bmp'
  if (rawExtension === '.jpg' || rawExtension === '.jpeg') return '.jpg'
  return '.jpg'
}

async function cacheArtistImageFile(imagePath: string): Promise<string> {
  const normalizedPath = imagePath.trim()
  if (!normalizedPath) {
    throw new Error('Artist image path is required.')
  }

  const imageData = await readFile(normalizedPath)
  if (imageData.length === 0) {
    throw new Error('Artist image file is empty.')
  }

  await mkdir(artistImageDir, { recursive: true })
  const extension = normalizeCachedImageExtension(normalizedPath)
  const contentHash = createHash('sha256').update(imageData).digest('hex')
  const fileName = `${contentHash}${extension}`
  const targetPath = join(artistImageDir, fileName)

  try {
    await writeFile(targetPath, imageData, { flag: 'wx' })
  } catch (error) {
    if (getErrorCode(error) !== 'EEXIST') {
      throw error
    }
  }

  return `${ARTIST_IMAGE_HASH_PREFIX}${fileName}`
}

export async function setArtistImageFromFile(
  artist: string,
  mode: ArtistBrowseMode,
  imagePath: string
): Promise<void> {
  if (!db) throw new Error('Database not initialized')

  const input = normalizeArtistImageInput(artist, mode)
  const imageHash = await cacheArtistImageFile(imagePath)
  const now = Date.now()

  db.run(
    `INSERT INTO artist_images (
      browse_mode,
      artist_key,
      artist_name,
      manual_image_hash,
      detected_image_hash,
      detected_source_path,
      detected_source_mtime,
      updated_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)
    ON CONFLICT(browse_mode, artist_key) DO UPDATE SET
      artist_name = excluded.artist_name,
      manual_image_hash = excluded.manual_image_hash,
      updated_at = excluded.updated_at`,
    [
      input.mode,
      input.artistKey,
      input.artistName,
      imageHash,
      now
    ]
  )

  await saveDatabase()
}

export async function clearArtistImage(
  artist: string,
  mode: ArtistBrowseMode
): Promise<void> {
  if (!db) return

  const input = normalizeArtistImageInput(artist, mode)
  db.run(
    `UPDATE artist_images
     SET artist_name = ?,
         manual_image_hash = NULL,
         updated_at = ?
     WHERE browse_mode = ? AND artist_key = ?`,
    [
      input.artistName,
      Date.now(),
      input.mode,
      input.artistKey
    ]
  )

  await saveDatabase()
}

function collectArtistImageSearchDirectories(trackPath: string): string[] {
  const directories: string[] = []
  const trackDirectory = dirname(trackPath)
  const parentDirectory = dirname(trackDirectory)

  for (const directory of [parentDirectory, trackDirectory]) {
    if (!directory || directories.includes(directory)) continue
    directories.push(directory)
  }

  return directories
}

async function readArtistImageCandidatesInDirectory(directoryPath: string): Promise<ArtistImageCandidate[]> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true })
    const candidates: ArtistImageCandidate[] = []

    for (const entry of entries) {
      if (!entry.isFile()) continue

      const extension = extname(entry.name).toLowerCase()
      if (!isSupportedArtistImageExtension(extension)) continue

      const filePath = join(directoryPath, entry.name)
      let fileStat: Awaited<ReturnType<typeof stat>>
      try {
        fileStat = await stat(filePath)
      } catch {
        continue
      }
      if (!fileStat.isFile()) continue

      const sourceMtime = Math.round(fileStat.mtimeMs)
      candidates.push({
        path: filePath,
        baseName: basename(entry.name, extension),
        extension,
        mtimeMs: sourceMtime
      })
    }

    return candidates
  } catch {
    return []
  }
}

async function refreshDetectedArtistImagesForMode(
  mode: ArtistBrowseMode,
  localTracks: DbTrackRow[]
): Promise<void> {
  if (!db) return

  const browseArtistResolver = mode === 'strict' ? resolveStrictBrowseArtist : resolveCanonicalBrowseArtist
  const artists = new Map<string, { artistName: string; directories: Set<string> }>()

  for (const track of localTracks) {
    const artistName = browseArtistResolver(track)
    const artistKey = getArtistImageKey(artistName)
    if (!artistKey) continue

    let entry = artists.get(artistKey)
    if (!entry) {
      entry = { artistName, directories: new Set() }
      artists.set(artistKey, entry)
    }

    for (const directory of collectArtistImageSearchDirectories(track.path)) {
      entry.directories.add(directory)
    }
  }

  const existingRows = readArtistImageRowsForMode(mode)
  const directoryCandidateCache = new Map<string, Promise<ArtistImageCandidate[]>>()
  const now = Date.now()

  for (const [artistKey, entry] of artists.entries()) {
    const candidates: ArtistImageCandidate[] = []
    for (const directory of entry.directories) {
      let pendingCandidates = directoryCandidateCache.get(directory)
      if (!pendingCandidates) {
        pendingCandidates = readArtistImageCandidatesInDirectory(directory)
        directoryCandidateCache.set(directory, pendingCandidates)
      }
      candidates.push(...await pendingCandidates)
    }

    const bestCandidate = pickBestArtistImageCandidate(candidates, entry.artistName)
    const existing = existingRows.get(artistKey)
    let detectedImageHash: string | null = null
    let detectedSourcePath: string | null = null
    let detectedSourceMtime: number | null = null

    if (bestCandidate) {
      detectedSourcePath = bestCandidate.path
      detectedSourceMtime = Math.round(bestCandidate.mtimeMs)
      try {
        detectedImageHash = (
          existing?.detected_image_hash &&
          existing.detected_source_path === detectedSourcePath &&
          existing.detected_source_mtime === detectedSourceMtime
        )
          ? existing.detected_image_hash
          : await cacheArtistImageFile(bestCandidate.path)
      } catch (error) {
        console.warn('Failed to cache detected artist image:', bestCandidate.path, error)
        detectedImageHash = null
        detectedSourcePath = null
        detectedSourceMtime = null
      }
    }

    db.run(
      `INSERT INTO artist_images (
        browse_mode,
        artist_key,
        artist_name,
        manual_image_hash,
        detected_image_hash,
        detected_source_path,
        detected_source_mtime,
        updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
      ON CONFLICT(browse_mode, artist_key) DO UPDATE SET
        artist_name = excluded.artist_name,
        detected_image_hash = excluded.detected_image_hash,
        detected_source_path = excluded.detected_source_path,
        detected_source_mtime = excluded.detected_source_mtime,
        updated_at = excluded.updated_at`,
      [
        mode,
        artistKey,
        entry.artistName,
        detectedImageHash,
        detectedSourcePath,
        detectedSourceMtime,
        now
      ]
    )
  }

  for (const [artistKey, row] of existingRows.entries()) {
    if (artists.has(artistKey)) continue
    if (!row.detected_image_hash && !row.detected_source_path && row.detected_source_mtime == null) continue

    db.run(
      `UPDATE artist_images
       SET detected_image_hash = NULL,
           detected_source_path = NULL,
           detected_source_mtime = NULL,
           updated_at = ?
       WHERE browse_mode = ? AND artist_key = ?`,
      [now, mode, artistKey]
    )
  }
}

export async function refreshDetectedArtistImages(): Promise<void> {
  if (!db) return

  const localTracks = readAllTrackRowsUnordered().filter((track) => track.source_type === 'local')
  await refreshDetectedArtistImagesForMode('canonical', localTracks)
  await refreshDetectedArtistImagesForMode('strict', localTracks)
}

// Get unique artists
export function getArtists(mode: ArtistBrowseMode = 'canonical'): ArtistRecord[] {
  return measureLibraryQuery('getArtists', () => {
    if (!db) return []
    const resolvedMode = normalizeArtistBrowseMode(mode)
    const artistImageRows = readArtistImageRowsForMode(resolvedMode)
    const missingAlbumArtistBucketProbes = readMissingAlbumArtistBucketProbes()
    const eligibleAlbumIdentityKeys = collectEligibleAlbumIdentityKeys(missingAlbumArtistBucketProbes)

    interface ArtistAggregate {
      artist: string
      track_count: number
      primary_track_count: number
      album_identity_keys: Set<string>
      artwork_hash: string | null
      newestArtworkYear: number
      newestArtworkAddedAt: number
      newestArtworkModifiedAt: number
    }

    const artistCounts = new Map<string, ArtistAggregate>()

    const addTrackToArtist = (
      track: DbTrackRow,
      browseArtist: string,
      isPrimaryArtist: boolean,
      albumIdentityKey: string | null
    ) => {
      const key = normalizeKey(browseArtist)
      if (!key) return

      const existing = artistCounts.get(key)
      if (existing) {
        existing.track_count += 1
        if (isPrimaryArtist) {
          existing.primary_track_count += 1
        }
        if (albumIdentityKey) {
          existing.album_identity_keys.add(albumIdentityKey)
        }
      } else {
        artistCounts.set(key, {
          artist: browseArtist,
          track_count: 1,
          primary_track_count: isPrimaryArtist ? 1 : 0,
          album_identity_keys: new Set<string>(albumIdentityKey ? [albumIdentityKey] : []),
          artwork_hash: null,
          newestArtworkYear: -1,
          newestArtworkAddedAt: -1,
          newestArtworkModifiedAt: -1,
        })
      }

      if (!track.artwork_hash) return
      const aggregate = artistCounts.get(key)
      if (!aggregate) return

      const candidateYear = track.year ?? -1
      const shouldReplaceArtwork = (
        aggregate.artwork_hash == null
        || candidateYear > aggregate.newestArtworkYear
        || (
          candidateYear === aggregate.newestArtworkYear
          && (
            track.added_at > aggregate.newestArtworkAddedAt
            || (
              track.added_at === aggregate.newestArtworkAddedAt
              && track.modified_at > aggregate.newestArtworkModifiedAt
            )
          )
        )
      )

      if (!shouldReplaceArtwork) return
      aggregate.artwork_hash = track.artwork_hash
      aggregate.newestArtworkYear = candidateYear
      aggregate.newestArtworkAddedAt = track.added_at
      aggregate.newestArtworkModifiedAt = track.modified_at
    }

    for (const track of iterateEffectiveTrackRows(`
      SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
      ${EFFECTIVE_TRACK_FROM_CLAUSE}
    `)) {
      const trackAlbumIdentityKey = resolveAlbumIdentityForTrack(track, missingAlbumArtistBucketProbes).identityKey
      const countedAlbumIdentityKey = eligibleAlbumIdentityKeys.has(trackAlbumIdentityKey)
        ? trackAlbumIdentityKey
        : null
      const primaryBrowseArtist = resolvedMode === 'strict'
        ? resolveStrictBrowseArtist(track)
        : resolveCanonicalBrowseArtist(track)
      const primaryArtistKey = normalizeKey(primaryBrowseArtist)
      const browseArtists = resolvedMode === 'strict'
        ? [primaryBrowseArtist]
        : getCanonicalArtistIndexNames(track)

      const seenTrackArtistKeys = new Set<string>()
      for (const browseArtist of browseArtists) {
        const key = normalizeKey(browseArtist)
        if (!key || seenTrackArtistKeys.has(key)) continue
        seenTrackArtistKeys.add(key)
        addTrackToArtist(track, browseArtist, key === primaryArtistKey, countedAlbumIdentityKey)
      }
    }

    return Array.from(artistCounts.values())
      .map(({ artist, track_count, primary_track_count, album_identity_keys, artwork_hash }) => {
        const artistImageRow = artistImageRows.get(getArtistImageKey(artist))
        const resolvedArtwork = resolveArtistArtwork(
          artistImageRow?.manual_image_hash,
          artistImageRow?.detected_image_hash,
          artwork_hash
        )
        return {
          artist,
          track_count,
          primary_track_count,
          album_count: album_identity_keys.size,
          artwork_hash: resolvedArtwork.artwork_hash,
          artwork_source: resolvedArtwork.artwork_source
        }
      })
      .sort((a, b) => a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }))
  })
}

// Get unique albums
export function listAlbumIdentityKeys(): string[] {
  const missingAlbumArtistBucketProbes = readMissingAlbumArtistBucketProbes()
  const identityKeys = new Set<string>()
  for (const track of iterateEffectiveTrackRows(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
  `)) {
    identityKeys.add(resolveAlbumIdentityForTrack(track, missingAlbumArtistBucketProbes).identityKey)
  }
  return Array.from(identityKeys).sort((a, b) => a.localeCompare(b))
}

export function getAlbums(options: AlbumListOptions = {}): Album[] {
  return measureLibraryQuery('getAlbums', () => {
    if (!db) return []

    const missingAlbumArtistBucketProbes = readMissingAlbumArtistBucketProbes()
    const latestSyncSummary = getLatestLibrarySyncSummary()
    const groups = collectAlbumSummaryGroups(missingAlbumArtistBucketProbes, latestSyncSummary)

    const albumEligibilityOptions: AlbumEligibilityOptions = {
      includeSingles: options.includeSingles === true
    }
    const albums = Array.from(groups.values())
      .filter((group) => isAlbumGroupEligible(group, albumEligibilityOptions))
      .map((group) => {
        const album = pickMostFrequentDisplayVariant(group.albumVariants, 'Unknown Album')
        const artist = pickMostFrequentDisplayVariant(group.artistVariants, 'Unknown Artist')

        let primaryArtist: string | null
        if (group.groupingMode === 'explicit-album-artist') {
          primaryArtist = getPrimaryArtistFromAlbumArtist(artist)
        } else if (group.groupingMode === 'shared-artwork-compilation') {
          primaryArtist = null
        } else {
          primaryArtist = artist
        }

        if (normalizeKey(primaryArtist ?? '') === normalizeKey(VARIOUS_ARTISTS_NAME)) {
          primaryArtist = null
        }

        return {
          identity_key: group.identityKey,
          album,
          artist,
          primary_artist: primaryArtist,
          year: group.year,
          artwork_hash: pickMostFrequentArtworkHash(group.artworkCounts, group.firstArtworkHash),
          track_count: group.trackCount,
          is_new: isAlbumNewForLatestSync(group.identityKey, latestSyncSummary, group.hasUnplayedLatestSyncTrack)
        }
      })

    return albums.sort((a, b) => {
      const albumCompare = a.album.localeCompare(b.album, undefined, { sensitivity: 'base' })
      if (albumCompare !== 0) return albumCompare
      const artistCompare = a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' })
      if (artistCompare !== 0) return artistCompare
      return a.identity_key.localeCompare(b.identity_key)
    })
  })
}

// Search tracks
export function searchTracks(query: string): DbTrack[] {
  return measureLibraryQuery('search', () => {
    if (!db) return []
    const pattern = `%${query}%`
    const tracks = db.all<DbTrackRow>(`
      SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
      ${EFFECTIVE_TRACK_FROM_CLAUSE}
      WHERE COALESCE(o.title, t.title) LIKE ?
        OR COALESCE(o.artist, t.artist) LIKE ?
        OR (o.artist IS NULL AND t.artist_names_json LIKE ?)
        OR COALESCE(o.album, t.album) LIKE ?
        OR (o.album_artist IS NULL AND t.album_artist_names_json LIKE ?)
      ORDER BY
        COALESCE(o.title, t.title) COLLATE NOCASE,
        COALESCE(o.album, t.album) COLLATE NOCASE,
        COALESCE(o.disc_number, t.disc_number, 0),
        COALESCE(o.track_number, t.track_number, 0),
        t.path COLLATE NOCASE
      LIMIT 100
    `, [pattern, pattern, pattern, pattern, pattern])
    return attachAlbumIdentityKeys(tracks)
  })
}

function getEditableTrackSnapshot(trackPath: string): EditableTrackSnapshot | null {
  if (!db) return null

  const row = db.get<Record<string, unknown>>(`
    SELECT
      t.path AS path,
      t.title AS base_title,
      t.artist AS base_artist,
      t.album AS base_album,
      t.album_artist AS base_album_artist,
      t.genre AS base_genre,
      t.year AS base_year,
      t.track_number AS base_track_number,
      t.disc_number AS base_disc_number,
      t.artwork_hash AS base_artwork_hash,
      COALESCE(o.title, t.title) AS effective_title,
      COALESCE(o.artist, t.artist) AS effective_artist,
      COALESCE(o.album, t.album) AS effective_album,
      COALESCE(o.album_artist, t.album_artist) AS effective_album_artist,
      COALESCE(o.genre, t.genre) AS effective_genre,
      COALESCE(o.year, t.year) AS effective_year,
      COALESCE(o.track_number, t.track_number) AS effective_track_number,
      COALESCE(o.disc_number, t.disc_number) AS effective_disc_number,
      CASE
        WHEN COALESCE(o.artwork_cleared, 0) = 1 THEN NULL
        ELSE COALESCE(o.artwork_hash, t.artwork_hash)
      END AS effective_artwork_hash
    FROM tracks t
    LEFT JOIN track_metadata_overrides o ON o.track_path = t.path
    WHERE t.path = ?
      AND t.source_type = 'local'
    LIMIT 1
  `, [trackPath])
  if (!row) return null

  const path = toText(row.path)
  const baseTitle = toText(row.base_title)
  const baseArtist = toText(row.base_artist)
  const baseAlbum = toText(row.base_album)
  const effectiveTitle = toText(row.effective_title)
  const effectiveArtist = toText(row.effective_artist)
  const effectiveAlbum = toText(row.effective_album)
  if (!path || !baseTitle || !baseArtist || !baseAlbum || !effectiveTitle || !effectiveArtist || !effectiveAlbum) {
    return null
  }

  return {
    path,
    base: {
      title: baseTitle,
      artist: baseArtist,
      album: baseAlbum,
      albumArtist: toText(row.base_album_artist),
      genre: toText(row.base_genre),
      year: toNumber(row.base_year),
      trackNumber: toNumber(row.base_track_number),
      discNumber: toNumber(row.base_disc_number),
      artworkHash: toText(row.base_artwork_hash)
    },
    effective: {
      title: effectiveTitle,
      artist: effectiveArtist,
      album: effectiveAlbum,
      albumArtist: toText(row.effective_album_artist),
      genre: toText(row.effective_genre),
      year: toNumber(row.effective_year),
      trackNumber: toNumber(row.effective_track_number),
      discNumber: toNumber(row.effective_disc_number),
      artworkHash: toText(row.effective_artwork_hash)
    }
  }
}

function normalizeMetadataArtworkPath(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error('artworkPath cannot be empty.')
  }
  return normalized
}

function normalizeArtworkOverrideImageExtension(imagePath: string): string {
  const rawExtension = extname(imagePath).toLowerCase()
  if (rawExtension === '.png') return '.png'
  if (rawExtension === '.webp') return '.webp'
  if (rawExtension === '.gif') return '.gif'
  if (rawExtension === '.bmp') return '.bmp'
  if (rawExtension === '.jpg' || rawExtension === '.jpeg') return '.jpg'
  return '.jpg'
}

async function resolveMetadataArtworkChange(
  mode: MetadataSaveMode,
  changes: MetadataEditChanges
): Promise<ResolvedMetadataArtworkChange> {
  if (changes.artworkPath === undefined) {
    return { kind: 'unchanged' }
  }

  if (changes.artworkPath === null) {
    return { kind: 'remove' }
  }

  const imagePath = normalizeMetadataArtworkPath(changes.artworkPath)
  const imageData = await readFile(imagePath)
  if (imageData.length === 0) {
    throw new Error('Selected artwork image is empty.')
  }

  const extension = normalizeArtworkOverrideImageExtension(imagePath)
  const artworkHash = `${createHash('md5').update(imageData).digest('hex')}${extension}`

  if (mode === 'virtual') {
    const artworkPath = join(artworkDir, artworkHash)
    try {
      await writeFile(artworkPath, imageData, { flag: 'wx' })
    } catch (error: unknown) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
        throw error
      }
    }
  }

  return { kind: 'replace', imagePath, artworkHash }
}

function buildNextOverrideRow(
  snapshot: EditableTrackSnapshot,
  changes: MetadataEditChanges,
  artworkChange: ResolvedMetadataArtworkChange
): TrackMetadataOverrideRow {
  const nextTitle = changes.title === undefined
    ? snapshot.effective.title
    : normalizeRequiredTextField(changes.title, 'title')
  const nextArtist = changes.artist === undefined
    ? snapshot.effective.artist
    : normalizeRequiredTextField(changes.artist, 'artist')
  const nextAlbum = changes.album === undefined
    ? snapshot.effective.album
    : normalizeRequiredTextField(changes.album, 'album')
  const nextAlbumArtist = changes.albumArtist === undefined
    ? snapshot.effective.albumArtist
    : normalizeOptionalTextField(changes.albumArtist)
  const nextGenre = changes.genre === undefined
    ? snapshot.effective.genre
    : normalizeOptionalTextField(changes.genre)
  const nextYear = changes.year === undefined
    ? snapshot.effective.year
    : normalizeOptionalIntegerField(changes.year, 'year')
  const nextTrackNumber = changes.trackNumber === undefined
    ? snapshot.effective.trackNumber
    : normalizeOptionalIntegerField(changes.trackNumber, 'trackNumber')
  const nextDiscNumber = changes.discNumber === undefined
    ? snapshot.effective.discNumber
    : normalizeOptionalIntegerField(changes.discNumber, 'discNumber')
  let nextArtworkHash = snapshot.effective.artworkHash
  if (artworkChange.kind === 'remove') {
    nextArtworkHash = null
  } else if (artworkChange.kind === 'replace') {
    nextArtworkHash = artworkChange.artworkHash
  }

  return {
    title: nextTitle !== snapshot.base.title ? nextTitle : null,
    artist: nextArtist !== snapshot.base.artist ? nextArtist : null,
    album: nextAlbum !== snapshot.base.album ? nextAlbum : null,
    album_artist: nextAlbumArtist !== snapshot.base.albumArtist ? nextAlbumArtist : null,
    genre: nextGenre !== snapshot.base.genre ? nextGenre : null,
    year: nextYear !== snapshot.base.year ? nextYear : null,
    track_number: nextTrackNumber !== snapshot.base.trackNumber ? nextTrackNumber : null,
    disc_number: nextDiscNumber !== snapshot.base.discNumber ? nextDiscNumber : null,
    artwork_hash: nextArtworkHash !== snapshot.base.artworkHash && nextArtworkHash !== null ? nextArtworkHash : null,
    artwork_cleared: nextArtworkHash === null && snapshot.base.artworkHash !== null ? 1 : null
  }
}

function upsertTrackMetadataOverride(trackPath: string, row: TrackMetadataOverrideRow): void {
  if (!db) return
  if (!hasOverrideValues(row)) {
    db.run('DELETE FROM track_metadata_overrides WHERE track_path = ?', [trackPath])
    return
  }

  db.run(
    `INSERT INTO track_metadata_overrides (
      track_path, title, artist, album, album_artist, genre, year, track_number, disc_number, artwork_hash, artwork_cleared, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(track_path) DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      album = excluded.album,
      album_artist = excluded.album_artist,
      genre = excluded.genre,
      year = excluded.year,
      track_number = excluded.track_number,
      disc_number = excluded.disc_number,
      artwork_hash = excluded.artwork_hash,
      artwork_cleared = excluded.artwork_cleared,
      updated_at = excluded.updated_at`,
    [
      trackPath,
      row.title,
      row.artist,
      row.album,
      row.album_artist,
      row.genre,
      row.year,
      row.track_number,
      row.disc_number,
      row.artwork_hash,
      row.artwork_cleared,
      Date.now()
    ]
  )
}

interface FolderExclusionRow {
  relative_path: string
  absolute_path: string
}

let fsPathCaseFoldingOverrideForTests: boolean | null = null

export function setFsPathCaseFoldingForTests(override: boolean | null): void {
  fsPathCaseFoldingOverrideForTests = override
}

// Windows (NTFS) and macOS (APFS/HFS+) filesystems are case-insensitive by
// default, so path comparisons must fold case there or a casing-only rename
// makes the same file look like two different tracks (#180). Case-sensitive
// APFS volumes are rare; the scan-side inode guard keeps genuinely distinct
// case-variant files from being merged on them.
function comparableFsPathFoldsCase(): boolean {
  return fsPathCaseFoldingOverrideForTests ?? (process.platform === 'win32' || process.platform === 'darwin')
}

function normalizeComparableFsPath(pathValue: string): string {
  const normalized = normalizePath(resolvePath(pathValue))
  if (!comparableFsPathFoldsCase()) return normalized
  // APFS/HFS+ are also Unicode-normalization-insensitive; NTFS is not.
  const unicodeNormalized = process.platform === 'darwin' ? normalized.normalize('NFC') : normalized
  return unicodeNormalized.toLocaleLowerCase()
}

function isSameOrDescendantPath(candidatePath: string, ancestorPath: string): boolean {
  const normalizedCandidate = normalizeComparableFsPath(candidatePath)
  const normalizedAncestor = normalizeComparableFsPath(ancestorPath)
  if (normalizedCandidate === normalizedAncestor) return true
  const ancestorWithSeparator = normalizedAncestor.endsWith(pathSep)
    ? normalizedAncestor
    : `${normalizedAncestor}${pathSep}`
  return normalizedCandidate.startsWith(ancestorWithSeparator)
}

function normalizeRelativeSubfolderPath(relativeSubfolderPath: string): string | null {
  const normalized = relativeSubfolderPath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/')

  if (!normalized || normalized === '..') return null
  if (normalized.split('/').some((segment) => segment === '..')) return null
  return normalized
}

function getRelativeParentPath(relativeSubfolderPath: string): string {
  const separatorIndex = relativeSubfolderPath.lastIndexOf('/')
  if (separatorIndex === -1) return ''
  return relativeSubfolderPath.slice(0, separatorIndex)
}

// Get library folders
export function getLibraryFolders(): LibraryFolder[] {
  if (!db) return []
  return db.all<LibraryFolder>('SELECT * FROM folders ORDER BY path')
}

function getLibraryFolderByPath(folderPath: string): LibraryFolder | null {
  const normalizedTargetPath = normalizeComparableFsPath(folderPath)
  return getLibraryFolders().find((folder) => normalizeComparableFsPath(folder.path) === normalizedTargetPath) ?? null
}

function getFolderExclusionRows(folderId: number): FolderExclusionRow[] {
  if (!db) return []

  const rows: FolderExclusionRow[] = []
  for (const row of db.iterate<FolderExclusionRow>('SELECT relative_path, absolute_path FROM folder_exclusions WHERE folder_id = ? ORDER BY relative_path', [folderId])) {
    if (typeof row.relative_path === 'string' && typeof row.absolute_path === 'string') {
      rows.push(row)
    }
  }
  return rows
}

function getFolderExcludedRelativePathSet(folderId: number): Set<string> {
  const excludedRelativePaths = new Set<string>()
  for (const row of getFolderExclusionRows(folderId)) {
    const normalizedRelativePath = normalizeRelativeSubfolderPath(row.relative_path)
    if (normalizedRelativePath) {
      excludedRelativePaths.add(normalizedRelativePath)
    }
  }
  return excludedRelativePaths
}

function isRelativeSubfolderExcluded(relativeSubfolderPath: string, excludedRelativePaths: Set<string>): boolean {
  const normalizedRelativePath = normalizeRelativeSubfolderPath(relativeSubfolderPath)
  if (!normalizedRelativePath) return false

  if (excludedRelativePaths.has(normalizedRelativePath)) {
    return true
  }

  let cursor = normalizedRelativePath
  while (cursor.includes('/')) {
    cursor = getRelativeParentPath(cursor)
    if (excludedRelativePaths.has(cursor)) {
      return true
    }
  }

  return false
}

function resolveRelativeSubfolder(
  folderPath: string,
  relativeSubfolderPath: string
): { relativePath: string; absolutePath: string } | null {
  const normalizedRelativePath = normalizeRelativeSubfolderPath(relativeSubfolderPath)
  if (!normalizedRelativePath) return null

  const absolutePath = resolvePath(folderPath, normalizedRelativePath)
  if (!isSameOrDescendantPath(absolutePath, folderPath)) return null
  if (normalizeComparableFsPath(absolutePath) === normalizeComparableFsPath(folderPath)) return null

  const canonicalRelativePath = normalizeRelativeSubfolderPath(relativePath(folderPath, absolutePath))
  if (!canonicalRelativePath) return null

  return {
    relativePath: canonicalRelativePath,
    absolutePath: normalizePath(absolutePath),
  }
}

function getExcludedAbsolutePathsForFolder(folderPath: string): string[] {
  const folder = getLibraryFolderByPath(folderPath)
  if (!folder) return []

  const rows = getFolderExclusionRows(folder.id)
  const uniquePaths = new Set<string>()
  for (const row of rows) {
    if (typeof row.absolute_path !== 'string' || row.absolute_path.trim().length === 0) continue
    uniquePaths.add(normalizePath(row.absolute_path))
  }
  return Array.from(uniquePaths)
}

function deleteTracksByAbsolutePrefixes(absolutePrefixes: string[]): number {
  if (!db || absolutePrefixes.length === 0) return 0

  const normalizedPrefixes = Array.from(new Set(
    absolutePrefixes
      .map((prefix) => prefix.trim())
      .filter((prefix) => prefix.length > 0)
      .map((prefix) => normalizeComparableFsPath(prefix))
  ))
  if (normalizedPrefixes.length === 0) return 0

  const trackIdsToRemove: number[] = []

  for (const track of db.iterate<{ id: number; path: string }>("SELECT id, path FROM tracks WHERE source_type = 'local'")) {
    const normalizedTrackPath = normalizeComparableFsPath(track.path)
    const matchesExcludedPrefix = normalizedPrefixes.some((normalizedPrefix) => {
      if (normalizedTrackPath === normalizedPrefix) return true
      const prefixWithSeparator = normalizedPrefix.endsWith(pathSep)
        ? normalizedPrefix
        : `${normalizedPrefix}${pathSep}`
      return normalizedTrackPath.startsWith(prefixWithSeparator)
    })
    if (!matchesExcludedPrefix) continue

    trackIdsToRemove.push(track.id)
  }

  for (const trackId of trackIdsToRemove) {
    db.run('DELETE FROM tracks WHERE id = ?', [trackId])
  }

  return trackIdsToRemove.length
}

// Add library folder
export async function addLibraryFolder(folderPath: string): Promise<LibraryFolder | null> {
  if (!db) return null
  // The binary UNIQUE constraint on folders.path would let a case-variant of
  // an existing root through, indexing every file twice on a case-insensitive
  // filesystem.
  if (getLibraryFolderByPath(folderPath)) return null
  const now = Date.now()
  try {
    const insertResult = db.run('INSERT INTO folders (path, added_at) VALUES (?, ?)', [folderPath, now])
    const id = Number(insertResult.lastInsertRowid)
    await saveDatabase()
    return { id, path: folderPath, added_at: now, hidden: 0 }
  } catch {
    return null // Folder already exists
  }
}

async function collectDiscoveredSubdirectories(folderPath: string): Promise<Set<string>> {
  const discovered = new Set<string>()

  async function walk(currentAbsolutePath: string, currentRelativePath: string): Promise<void> {
    let entries
    try {
      entries = await readdir(currentAbsolutePath, { withFileTypes: true })
    } catch (error: unknown) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && (error.code === 'EACCES' || error.code === 'EPERM')
      ) {
        return
      }
      throw error
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const childRelativePath = normalizeRelativeSubfolderPath(
        currentRelativePath ? `${currentRelativePath}/${entry.name}` : entry.name
      )
      if (!childRelativePath) continue

      discovered.add(childRelativePath)
      await walk(join(currentAbsolutePath, entry.name), childRelativePath)
    }
  }

  await walk(folderPath, '')
  return discovered
}

export async function listFolderSubdirectories(
  folderPath: string,
  parentRelativePath: string = ''
): Promise<FolderSubdirectoryEntry[]> {
  const folder = getLibraryFolderByPath(folderPath)
  if (!folder) return []

  let currentRelativePath = ''
  let currentAbsolutePath = folder.path
  if (parentRelativePath.trim().length > 0) {
    const resolved = resolveRelativeSubfolder(folder.path, parentRelativePath)
    if (!resolved) return []
    currentRelativePath = resolved.relativePath
    currentAbsolutePath = resolved.absolutePath
  }

  const excludedRelativePaths = getFolderExcludedRelativePathSet(folder.id)
  const directChildren = new Map<string, FolderSubdirectoryEntry>()

  try {
    const entries = await readdir(currentAbsolutePath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const childRelativePath = normalizeRelativeSubfolderPath(
        currentRelativePath ? `${currentRelativePath}/${entry.name}` : entry.name
      )
      if (!childRelativePath) continue

      const childAbsolutePath = join(currentAbsolutePath, entry.name)
      let hasChildDirs = false
      let audioCount = 0
      try {
        const childEntries = await readdir(childAbsolutePath, { withFileTypes: true })
        for (const ce of childEntries) {
          if (ce.isDirectory()) hasChildDirs = true
          else if (ce.isFile()) {
            const ext = extname(ce.name).toLowerCase()
            if (AUDIO_EXTENSIONS.has(ext)) audioCount++
          }
        }
      } catch {
        // Permission denied or inaccessible
      }
      directChildren.set(childRelativePath, {
        name: entry.name,
        relativePath: childRelativePath,
        excluded: isRelativeSubfolderExcluded(childRelativePath, excludedRelativePaths),
        hasChildren: hasChildDirs,
        audioFileCount: audioCount,
        missing: false,
      })
    }
  } catch (error: unknown) {
    if (
      !(
        error
        && typeof error === 'object'
        && 'code' in error
        && (error.code === 'EACCES' || error.code === 'EPERM')
      )
    ) {
      throw error
    }
  }

  for (const excludedRelativePath of excludedRelativePaths.values()) {
    if (getRelativeParentPath(excludedRelativePath) !== currentRelativePath) continue
    if (directChildren.has(excludedRelativePath)) continue

    const pathParts = excludedRelativePath.split('/')
    const pathName = pathParts[pathParts.length - 1] ?? excludedRelativePath
    directChildren.set(excludedRelativePath, {
      name: pathName,
      relativePath: excludedRelativePath,
      excluded: true,
      hasChildren: Array.from(excludedRelativePaths.values())
        .some((candidatePath) => candidatePath !== excludedRelativePath && candidatePath.startsWith(`${excludedRelativePath}/`)),
      audioFileCount: 0,
      missing: true,
    })
  }

  return Array.from(directChildren.values()).sort((a, b) => {
    const nameCompare = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    if (nameCompare !== 0) return nameCompare
    return a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: 'base' })
  })
}

export async function getFolderSubfolderSummary(folderPath: string): Promise<FolderSubfolderSummary> {
  const folder = getLibraryFolderByPath(folderPath)
  if (!folder) {
    return { totalSubfolders: 0, excludedSubfolders: 0 }
  }

  const discoveredSubfolders = await collectDiscoveredSubdirectories(folder.path)
  const excludedRelativePaths = getFolderExcludedRelativePathSet(folder.id)
  const pathsForExclusionCount = new Set<string>([
    ...discoveredSubfolders,
    ...excludedRelativePaths,
  ])

  let excludedSubfolderCount = 0
  for (const relativeSubfolderPath of pathsForExclusionCount.values()) {
    if (isRelativeSubfolderExcluded(relativeSubfolderPath, excludedRelativePaths)) {
      excludedSubfolderCount += 1
    }
  }

  return {
    totalSubfolders: discoveredSubfolders.size,
    excludedSubfolders: excludedSubfolderCount,
  }
}

export async function setFolderSubfolderExcluded(
  folderPath: string,
  relativeSubfolderPath: string,
  excluded: boolean
): Promise<boolean> {
  if (!db) return false
  const folder = getLibraryFolderByPath(folderPath)
  if (!folder) return false

  const resolvedSubfolder = resolveRelativeSubfolder(folder.path, relativeSubfolderPath)
  if (!resolvedSubfolder) return false

  if (excluded) {
    const now = Date.now()
    db.run(
      `INSERT INTO folder_exclusions (folder_id, relative_path, absolute_path, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(folder_id, relative_path)
       DO UPDATE SET absolute_path = excluded.absolute_path, created_at = excluded.created_at`,
      [folder.id, resolvedSubfolder.relativePath, resolvedSubfolder.absolutePath, now]
    )
  } else {
    db.run('DELETE FROM folder_exclusions WHERE folder_id = ? AND relative_path = ?', [
      folder.id,
      resolvedSubfolder.relativePath
    ])
  }

  await saveDatabase()
  return true
}

// Remove library folder
export async function removeLibraryFolder(folderPath: string): Promise<void> {
  if (!db) return
  const folder = getLibraryFolderByPath(folderPath)
  if (!folder) return

  deleteTracksByAbsolutePrefixes([folder.path])
  db.run('DELETE FROM folder_exclusions WHERE folder_id = ?', [folder.id])
  db.run('DELETE FROM folders WHERE id = ?', [folder.id])
  await saveDatabase()
}

// Toggle a library folder's visibility. Hidden folders stay fully indexed; their tracks are
// filtered out of the browsable library in the renderer. This deletes nothing (unlike
// removeLibraryFolder / folder exclusions).
export async function setLibraryFolderHidden(folderPath: string, hidden: boolean): Promise<boolean> {
  if (!db) return false
  const folder = getLibraryFolderByPath(folderPath)
  if (!folder) return false

  db.run('UPDATE folders SET hidden = ? WHERE id = ?', [hidden ? 1 : 0, folder.id])
  await saveDatabase()
  return true
}

export async function resetMappedFoldersData(): Promise<{ clearedFolders: number; clearedTracks: number }> {
  if (!db) {
    return { clearedFolders: 0, clearedTracks: 0 }
  }

  const clearedFolders = readCount('SELECT COUNT(*) FROM folders')
  const clearedTracks = readCount('SELECT COUNT(*) FROM tracks')

  db.run('DELETE FROM playlist_tracks')
  db.run('DELETE FROM listening_segments')
  db.run('DELETE FROM listening_sessions')
  db.run('DELETE FROM app_meta WHERE key IN (?, ?)', [
    LISTENING_HISTORY_STARTED_AT_META_KEY,
    LISTENING_HISTORY_GENERATION_META_KEY
  ])
  db.run('DELETE FROM recently_played')
  db.run('DELETE FROM favorites')
  db.run('DELETE FROM track_ratings')
  db.run(`DELETE FROM ${PLAY_ORIGIN_TABLE}`)
  db.run('DELETE FROM lyrics_cache')
  db.run('DELETE FROM lyrics_track_overrides')
  db.run('DELETE FROM tracks')
  db.run('DELETE FROM folder_exclusions')
  db.run('DELETE FROM folders')
  db.run('UPDATE artist_images SET detected_image_hash = NULL, detected_source_path = NULL, detected_source_mtime = NULL, updated_at = ?', [Date.now()])

  await clearArtworkCacheDirectory()
  await saveDatabase()

  return { clearedFolders, clearedTracks }
}

export async function factoryResetLibraryData(): Promise<void> {
  if (!db) return

  db.run('DELETE FROM playlist_tracks')
  db.run('DELETE FROM listening_segments')
  db.run('DELETE FROM listening_sessions')
  db.run('DELETE FROM playlists')
  db.run('DELETE FROM recently_played')
  db.run('DELETE FROM favorites')
  db.run('DELETE FROM track_ratings')
  db.run(`DELETE FROM ${PLAY_ORIGIN_TABLE}`)
  db.run('DELETE FROM lyrics_cache')
  db.run('DELETE FROM lyrics_track_overrides')
  db.run('DELETE FROM tracks')
  db.run('DELETE FROM folder_exclusions')
  db.run('DELETE FROM folders')
  db.run('DELETE FROM artist_images')
  db.run('DELETE FROM app_meta')

  await clearArtworkCacheDirectory()
  await clearPlaylistCoverDirectory()
  await clearArtistImageDirectory()
  await saveDatabase()
}

// Scan a folder for audio files
interface ExistingTrackScanState {
  id: number
  modified_at: number
  file_created_at: number | null
  artwork_hash: string | null
  replaygain_track_gain_db: number | null
  replaygain_album_gain_db: number | null
}

interface FolderArtworkCandidate {
  path: string
  modifiedAtMs: number
}

interface FolderArtworkScanCache {
  candidatesByDirectory: Map<string, Promise<FolderArtworkCandidate | null>>
  hashesByPath: Map<string, Promise<string | null>>
}

function shouldSkipIncrementalTrackScan(
  existing: ExistingTrackScanState | undefined,
  fileModifiedAtMs: number,
  folderArtworkCandidate: FolderArtworkCandidate | null
): boolean {
  if (!existing) {
    return false
  }

  const replayGainMissing = Boolean(
    replayGainScanEnabled
    && (
      existing.replaygain_track_gain_db == null
      || existing.replaygain_album_gain_db == null
    )
  )
  const fileCreatedAtMissing = existing.file_created_at == null
  const folderArtworkBackfillAvailable = existing.artwork_hash == null && folderArtworkCandidate !== null
  const folderArtworkNewerThanLastScan = Boolean(
    folderArtworkCandidate
    && folderArtworkCandidate.modifiedAtMs > existing.modified_at
  )

  return (
    existing.modified_at >= fileModifiedAtMs
    && !replayGainMissing
    && !fileCreatedAtMissing
    && !folderArtworkBackfillAvailable
    && !folderArtworkNewerThanLastScan
  )
}

interface ExistingTrackScanRow extends ExistingTrackScanState {
  path: string
}

// Find the DB row for a scanned file among case-fold-equal candidates. A
// stored path whose casing differs from disk (folder renamed, #180) is
// repaired in place — and pre-existing case-variant duplicates are merged —
// but only for rows proven to reference this physical file: same inode
// (case-insensitive FS) or a path that no longer resolves. A candidate with a
// different inode is a genuinely distinct file on a case-sensitive volume and
// is left untouched.
async function resolveExistingTrackForScannedFile(
  filePath: string,
  fileStat: Stats,
  candidates: ExistingTrackScanRow[] | undefined
): Promise<ExistingTrackScanState | undefined> {
  if (!candidates || candidates.length === 0) return undefined
  if (candidates.length === 1 && candidates[0].path === filePath) return candidates[0]

  const verified: ExistingTrackScanRow[] = []
  for (const candidate of candidates) {
    if (candidate.path === filePath) {
      verified.push(candidate)
      continue
    }
    try {
      const candidateStat = await stat(candidate.path)
      if (candidateStat.dev === fileStat.dev && candidateStat.ino === fileStat.ino) {
        verified.push(candidate)
      }
    } catch (err: unknown) {
      const code = getErrorCode(err)
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        verified.push(candidate)
      }
      // Other errors (EACCES…): leave the row alone.
    }
  }
  if (verified.length === 0) return undefined

  // Everything below is synchronous, so it is atomic with respect to the
  // other cooperative scan workers.
  const survivor = verified.reduce((lowest, row) => (row.id < lowest.id ? row : lowest))
  const losers = verified.filter((row) => row.id !== survivor.id)
  mergeDuplicateTrackRows(survivor.id, survivor.path, losers)
  if (survivor.path !== filePath) {
    renameTrackPath(survivor.path, filePath)
  }
  return survivor
}

function createFolderArtworkScanCache(): FolderArtworkScanCache {
  return {
    candidatesByDirectory: new Map(),
    hashesByPath: new Map()
  }
}

function getFolderArtworkCandidateRank(fileName: string): { basenameRank: number; extensionRank: number } | null {
  const extension = extname(fileName).toLowerCase()
  const extensionRank = FOLDER_ARTWORK_EXTENSION_RANK.get(extension)
  if (extensionRank === undefined) return null

  const normalizedBasename = basename(fileName, extname(fileName)).toLowerCase()
  const basenameRank = FOLDER_ARTWORK_BASENAME_RANK.get(normalizedBasename)
  if (basenameRank === undefined) return null

  return { basenameRank, extensionRank }
}

async function discoverFolderArtworkCandidate(directoryPath: string): Promise<FolderArtworkCandidate | null> {
  let entries
  try {
    entries = await readdir(directoryPath, { withFileTypes: true })
  } catch {
    return null
  }

  const rankedCandidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const rank = getFolderArtworkCandidateRank(entry.name)
      if (!rank) return null
      return {
        ...rank,
        name: entry.name,
        path: join(directoryPath, entry.name)
      }
    })
    .filter((candidate): candidate is {
      basenameRank: number
      extensionRank: number
      name: string
      path: string
    } => candidate !== null)
    .sort((a, b) => (
      a.basenameRank - b.basenameRank
      || a.extensionRank - b.extensionRank
      || a.name.localeCompare(b.name)
    ))

  const [candidate] = rankedCandidates
  if (!candidate) return null

  try {
    const candidateStat = await stat(candidate.path)
    return {
      path: candidate.path,
      modifiedAtMs: candidateStat.mtimeMs
    }
  } catch {
    return null
  }
}

function getFolderArtworkCandidate(
  directoryPath: string,
  cache: FolderArtworkScanCache
): Promise<FolderArtworkCandidate | null> {
  const cached = cache.candidatesByDirectory.get(directoryPath)
  if (cached) return cached

  const lookup = discoverFolderArtworkCandidate(directoryPath)
  cache.candidatesByDirectory.set(directoryPath, lookup)
  return lookup
}

async function cacheFolderArtworkCandidate(candidate: FolderArtworkCandidate): Promise<string | null> {
  try {
    const imageData = await readFile(candidate.path)
    return cacheArtworkBuffer(imageData)
  } catch (error) {
    console.warn('Failed to cache folder artwork image:', candidate.path, error)
    return null
  }
}

function getFolderArtworkHash(
  candidate: FolderArtworkCandidate,
  cache: FolderArtworkScanCache
): Promise<string | null> {
  const cached = cache.hashesByPath.get(candidate.path)
  if (cached) return cached

  const lookup = cacheFolderArtworkCandidate(candidate)
  cache.hashesByPath.set(candidate.path, lookup)
  return lookup
}

async function resolveFolderArtworkHash(
  filePath: string,
  cache: FolderArtworkScanCache
): Promise<string | null> {
  const candidate = await getFolderArtworkCandidate(dirname(filePath), cache)
  if (!candidate) return null
  return getFolderArtworkHash(candidate, cache)
}

export async function scanFolder(
  folderPath: string,
  onProgress?: (current: number, total: number, file: string) => void,
  options: FolderScanOptions = {}
): Promise<{ added: number; updated: number; errors: number; skippedDirs: string[] }> {
  const { persist = true, signal, onIssue, syncSessionKey = null, mode = 'incremental' } = options
  if (!db) return { added: 0, updated: 0, errors: 0, skippedDirs: [] }
  throwIfScanCancelled(signal)

  const excludedAbsolutePaths = getExcludedAbsolutePathsForFolder(folderPath)
  if (excludedAbsolutePaths.length > 0) {
    deleteTracksByAbsolutePrefixes(excludedAbsolutePaths)
  }

  const { files, skippedDirs } = await collectAudioFiles(folderPath, excludedAbsolutePaths, { signal, onIssue })
  let added = 0
  let updated = 0
  let errors = 0
  let processed = 0

  // Existing rows keyed by case-folded path so a casing-only folder rename
  // still matches the stored row instead of inserting a duplicate (#180).
  const existingByComparablePath = new Map<string, ExistingTrackScanRow[]>()
  if (files.length > 0) {
    for (const row of db.iterate<ExistingTrackScanRow>(
      "SELECT id, path, modified_at, file_created_at, artwork_hash, replaygain_track_gain_db, replaygain_album_gain_db FROM tracks WHERE source_type = 'local'"
    )) {
      if (!isSameOrDescendantPath(row.path, folderPath)) continue
      const key = normalizeComparableFsPath(row.path)
      const rows = existingByComparablePath.get(key)
      if (rows) rows.push(row)
      else existingByComparablePath.set(key, [row])
    }
  }

  const scanWorkerCount = resolveScanWorkerCount(files.length)
  const folderArtworkCache = createFolderArtworkScanCache()

  await runWithConcurrency(files, scanWorkerCount, async (filePath) => {
    try {
      throwIfScanCancelled(signal)
      if (!db) return

      const fileStat = await stat(filePath)
      const fileCreatedAt = normalizeFileCreatedAtMs(fileStat.birthtimeMs)

      const existing = await resolveExistingTrackForScannedFile(
        filePath,
        fileStat,
        existingByComparablePath.get(normalizeComparableFsPath(filePath))
      )

      const folderArtworkCandidate = mode === 'incremental'
        ? await getFolderArtworkCandidate(dirname(filePath), folderArtworkCache)
        : null
      const shouldSkipKnownFile = mode === 'incremental' && shouldSkipIncrementalTrackScan(
        existing,
        fileStat.mtimeMs,
        folderArtworkCandidate
      )
      if (shouldSkipKnownFile) {
        return
      }

      const metadata = await extractMetadata(filePath, { folderArtworkCache })
      const now = Date.now()

      if (existing) {
        db.run(`
          UPDATE tracks SET title=?, artist=?, artist_names_json=?, album=?, album_artist=?, album_artist_names_json=?, duration=?, track_number=?, disc_number=?, year=?, genre=?, genre_names_json=?, artwork_hash=?, format=?, sample_rate=?, bit_depth=?, bitrate=?, channels=?, codec=?, codec_profile=?, is_atmos_joc=?, is_iamf=?, replaygain_track_gain_db=?, replaygain_album_gain_db=?, bpm=?, musical_key=?, source_type='local', source_id=NULL, source_track_id=NULL, source_path=NULL, is_available=1, availability_reason=NULL, file_created_at=?, modified_at=?
          WHERE path=?
        `, [
          metadata.title, metadata.artist, metadata.artistNamesJson, metadata.album, metadata.albumArtist, metadata.albumArtistNamesJson,
          metadata.duration, metadata.trackNumber, metadata.discNumber, metadata.year,
          metadata.genre, metadata.genreNamesJson, metadata.artworkHash, metadata.format, metadata.sampleRate,
          metadata.bitDepth, metadata.bitrate, metadata.channels, metadata.codec, metadata.codecProfile, metadata.isAtmosJoc, metadata.isIamf,
          metadata.replayGainTrackDb, metadata.replayGainAlbumDb, metadata.bpm, metadata.musicalKey, fileCreatedAt, now, filePath
        ])
        updated++
      } else {
        db.run(`
          INSERT INTO tracks (path, title, artist, artist_names_json, album, album_artist, album_artist_names_json, duration, track_number, disc_number, year, genre, genre_names_json, artwork_hash, format, sample_rate, bit_depth, bitrate, channels, codec, codec_profile, is_atmos_joc, is_iamf, replaygain_track_gain_db, replaygain_album_gain_db, bpm, musical_key, source_type, source_id, source_track_id, source_path, is_available, availability_reason, file_created_at, sync_session_key, added_at, modified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', NULL, NULL, NULL, 1, NULL, ?, ?, ?, ?)
        `, [
          filePath, metadata.title, metadata.artist, metadata.artistNamesJson, metadata.album, metadata.albumArtist, metadata.albumArtistNamesJson,
          metadata.duration, metadata.trackNumber, metadata.discNumber, metadata.year,
          metadata.genre, metadata.genreNamesJson, metadata.artworkHash, metadata.format, metadata.sampleRate,
          metadata.bitDepth, metadata.bitrate, metadata.channels, metadata.codec, metadata.codecProfile, metadata.isAtmosJoc, metadata.isIamf,
          metadata.replayGainTrackDb, metadata.replayGainAlbumDb, metadata.bpm, metadata.musicalKey, fileCreatedAt, syncSessionKey, now, now
        ])
        added++
      }
    } catch (err: unknown) {
      if (isLibraryScanCancelledError(err)) {
        throw err
      }
      const issue = createLibraryScanIssue('scan', filePath, err)
      onIssue?.(issue)
      if (issue.code !== 'ENOENT' && issue.code !== 'ENOTDIR') {
        console.error(`Error processing ${filePath}:`, err)
      }
      errors++
    } finally {
      processed += 1
      onProgress?.(processed, files.length, filePath)
    }
  }, { signal })

  throwIfScanCancelled(signal)
  reconcileMissingPlaylistEntriesByMetadata()
  if (persist) {
    await saveDatabase()
  }
  return { added, updated, errors, skippedDirs }
}

function isDirectoryExcludedPath(directoryPath: string, excludedDirectories: string[]): boolean {
  const normalizedDirectoryPath = normalizeComparableFsPath(directoryPath)
  return excludedDirectories.some((excludedDirectoryPath) => {
    if (normalizedDirectoryPath === excludedDirectoryPath) return true
    const prefixWithSeparator = excludedDirectoryPath.endsWith(pathSep)
      ? excludedDirectoryPath
      : `${excludedDirectoryPath}${pathSep}`
    return normalizedDirectoryPath.startsWith(prefixWithSeparator)
  })
}

// Collect all audio files in a directory recursively
async function collectAudioFiles(
  dir: string,
  excludedAbsoluteDirs: string[] = [],
  options: ScanControlOptions = {}
): Promise<{ files: string[]; skippedDirs: string[] }> {
  const files: string[] = []
  const skippedDirs: string[] = []
  const normalizedExcludedDirectories = Array.from(new Set(
    excludedAbsoluteDirs
      .map((excludedPath) => excludedPath.trim())
      .filter((excludedPath) => excludedPath.length > 0)
      .map((excludedPath) => normalizeComparableFsPath(excludedPath))
  ))

  async function walk(currentDir: string): Promise<void> {
    throwIfScanCancelled(options.signal)
    if (isDirectoryExcludedPath(currentDir, normalizedExcludedDirectories)) {
      return
    }

    let entries
    try {
      entries = await readdir(currentDir, { withFileTypes: true })
    } catch (err: unknown) {
      const issue = createLibraryScanIssue('discovery', currentDir, err)
      options.onIssue?.(issue)

      if (issue.code === 'EACCES' || issue.code === 'EPERM') {
        skippedDirs.push(currentDir)
      } else if (issue.code !== 'ENOENT' && issue.code !== 'ENOTDIR') {
        console.warn(`Skipping unreadable directory during scan: ${currentDir}`, err)
      }
      return
    }

    for (const entry of entries) {
      throwIfScanCancelled(options.signal)
      const fullPath = join(currentDir, entry.name)

      if (entry.isDirectory()) {
        if (isDirectoryExcludedPath(fullPath, normalizedExcludedDirectories)) {
          continue
        }
        await walk(fullPath)
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase()
        if (AUDIO_EXTENSIONS.has(ext)) {
          files.push(fullPath)
        }
      }
    }
  }

  throwIfScanCancelled(options.signal)
  await walk(dir)
  return { files, skippedDirs }
}

interface ResolvedCodecMetadata {
  channels: number | null
  codec: string | null
  codecProfile: string | null
  isAtmosJoc: boolean
}

interface FfprobeAudioMetadata {
  channels: number | null
  codec: string | null
  codecProfile: string | null
  hints: string[]
}

let resolvedFfprobeBinaryPath: string | null | undefined
let resolvedFfmpegBinaryPath: string | null | undefined

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

async function resolveFfprobeBinaryPath(): Promise<string | null> {
  if (resolvedFfprobeBinaryPath !== undefined) {
    return resolvedFfprobeBinaryPath
  }

  const isWindows = process.platform === 'win32'
  const executable = `ffprobe${isWindows ? '.exe' : ''}`
  const staticModulePath = await resolveStaticFfprobeBinaryPath()
  const packagedStaticCandidates = app.isPackaged
    ? [join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, executable)]
    : []
  const candidates = [
    ...(app.isPackaged
      ? [
          join(process.resourcesPath, executable),
          join(process.resourcesPath, 'bin', executable)
        ]
      : []),
    ...packagedStaticCandidates,
    ...(staticModulePath ? [staticModulePath] : []),
    ...(isWindows
      ? ['ffprobe.exe', 'ffprobe']
      : ['ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'])
  ].flatMap((candidate) => {
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
      resolvedFfprobeBinaryPath = candidate
      return candidate
    } catch {
      // Try next candidate.
    }
  }

  resolvedFfprobeBinaryPath = null
  return null
}

async function resolveFfmpegBinaryPath(): Promise<string | null> {
  if (resolvedFfmpegBinaryPath !== undefined) {
    return resolvedFfmpegBinaryPath
  }

  const isWindows = process.platform === 'win32'
  const executable = `ffmpeg${isWindows ? '.exe' : ''}`
  const staticModulePath = await resolveStaticFfmpegBinaryPath()
  const packagedStaticCandidates = app.isPackaged
    ? [join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', executable)]
    : []
  const candidates = [
    ...(app.isPackaged
      ? [
          join(process.resourcesPath, executable),
          join(process.resourcesPath, 'bin', executable)
        ]
      : []),
    ...packagedStaticCandidates,
    ...(staticModulePath ? [staticModulePath] : []),
    ...(isWindows
      ? ['ffmpeg.exe', 'ffmpeg']
      : ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'])
  ].flatMap((candidate) => {
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
      resolvedFfmpegBinaryPath = candidate
      return candidate
    } catch {
      // Try next candidate.
    }
  }

  resolvedFfmpegBinaryPath = null
  return null
}

async function resolveStaticFfprobeBinaryPath(): Promise<string | null> {
  try {
    const module = await import('ffprobe-static') as { path?: string; default?: { path?: string } }
    const modulePath = module.path ?? module.default?.path
    return typeof modulePath === 'string' ? modulePath : null
  } catch {
    return null
  }
}

async function resolveStaticFfmpegBinaryPath(): Promise<string | null> {
  try {
    const module = await import('ffmpeg-static')
    return typeof module.default === 'string' ? module.default : null
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

function toText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function normalizeFileCreatedAtMs(value: unknown): number | null {
  const timestamp = toNumber(value)
  if (timestamp === null || timestamp <= 0) return null
  return timestamp
}

function normalizeBpm(value: unknown): number | null {
  const normalizeParsedValue = (candidate: number): number | null => {
    if (!Number.isFinite(candidate)) return null
    if (candidate <= 0 || candidate > 400) return null
    return Math.round(candidate * 1000) / 1000
  }

  if (typeof value === 'number') {
    return normalizeParsedValue(value)
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = normalizeBpm(entry)
      if (parsed != null) return parsed
    }
    return null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null

    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) {
      return normalizeParsedValue(parsed)
    }

    const match = trimmed.match(/[+-]?\d+(?:[.,]\d+)?/)
    if (!match) return null
    const parsedFromMatch = Number(match[0].replace(',', '.'))
    return normalizeParsedValue(parsedFromMatch)
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const objectCandidates: unknown[] = [
      record.bpm,
      record.value,
      record.text
    ]
    for (const candidate of objectCandidates) {
      const parsed = normalizeBpm(candidate)
      if (parsed != null) return parsed
    }
  }

  return null
}

function normalizeKeyTagId(id: string): string {
  return id.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function isBpmTagId(id: string): boolean {
  const normalized = normalizeKeyTagId(id)
  return normalized === 'bpm'
    || normalized === 'tbpm'
    || normalized.endsWith('_bpm')
    || normalized.includes('beats_per_minute')
}

function normalizeMusicalKey(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim()
    return normalized.length > 0 ? normalized : null
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = normalizeMusicalKey(entry)
      if (parsed) return parsed
    }
    return null
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const objectCandidates: unknown[] = [
      record.key,
      record.value,
      record.text,
      record.name
    ]
    for (const candidate of objectCandidates) {
      const parsed = normalizeMusicalKey(candidate)
      if (parsed) return parsed
    }
  }

  return null
}

function isMusicalKeyTagId(id: string): boolean {
  const normalized = normalizeKeyTagId(id)
  return normalized === 'key'
    || normalized === 'tkey'
    || normalized === 'initialkey'
    || normalized === 'initial_key'
    || normalized === 'musical_key'
}

function extractBpmFromCommon(metadata: mm.IAudioMetadata): number | null {
  const common = metadata.common as unknown as Record<string, unknown>
  let bpm = normalizeBpm(common.bpm)
  if (bpm != null) return bpm

  for (const [key, rawValue] of Object.entries(common)) {
    if (!isBpmTagId(key)) continue
    bpm = normalizeBpm(rawValue)
    if (bpm != null) return bpm
  }

  return null
}

function extractBpmFromNative(metadata: mm.IAudioMetadata): number | null {
  const nativeCollections = Object.values(metadata.native ?? {})
  for (const tags of nativeCollections) {
    if (!Array.isArray(tags)) continue
    for (const rawTag of tags) {
      if (!rawTag || typeof rawTag !== 'object') continue
      const tag = rawTag as { id?: unknown; value?: unknown }
      const id = typeof tag.id === 'string' ? tag.id : ''
      if (!id || !isBpmTagId(id)) continue

      const parsed = normalizeBpm(tag.value)
      if (parsed != null) return parsed
    }
  }

  return null
}

function extractBpm(metadata: mm.IAudioMetadata): number | null {
  return extractBpmFromCommon(metadata) ?? extractBpmFromNative(metadata)
}

function extractMusicalKeyFromCommon(metadata: mm.IAudioMetadata): string | null {
  const common = metadata.common as unknown as Record<string, unknown>
  let musicalKey = normalizeMusicalKey(common.key)
  if (musicalKey) return musicalKey

  for (const [key, rawValue] of Object.entries(common)) {
    if (!isMusicalKeyTagId(key)) continue
    musicalKey = normalizeMusicalKey(rawValue)
    if (musicalKey) return musicalKey
  }

  return null
}

function extractMusicalKeyFromNative(metadata: mm.IAudioMetadata): string | null {
  const nativeCollections = Object.values(metadata.native ?? {})
  for (const tags of nativeCollections) {
    if (!Array.isArray(tags)) continue
    for (const rawTag of tags) {
      if (!rawTag || typeof rawTag !== 'object') continue
      const tag = rawTag as { id?: unknown; value?: unknown }
      const id = typeof tag.id === 'string' ? tag.id : ''
      if (!id || !isMusicalKeyTagId(id)) continue

      const parsed = normalizeMusicalKey(tag.value)
      if (parsed) return parsed
    }
  }

  return null
}

function extractMusicalKey(metadata: mm.IAudioMetadata): string | null {
  return extractMusicalKeyFromCommon(metadata) ?? extractMusicalKeyFromNative(metadata)
}

function collectFfprobeHints(stream: Record<string, unknown>, format?: Record<string, unknown>): string[] {
  const hints: string[] = []
  const push = (value: unknown) => {
    const text = toText(value)
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

function isAtmosJocStream(codec?: string | null, codecProfile?: string | null, hints: string[] = []): boolean {
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

  if (combined.includes('joc')) return true
  return mentionsAtmos && isEc3Family
}

function shouldProbeWithFfprobe(
  filePath: string,
  channels: number | null,
  codec: string | null,
  codecProfile: string | null
): boolean {
  const extension = extname(filePath).toLowerCase()
  // The bundled ffprobe (6.0) cannot read IAMF; skip the doomed spawn.
  if (extension === '.iamf') {
    return false
  }
  if (extension === '.m4a' || extension === '.mp4' || extension === '.m4b' || extension === '.m4p' || extension === '.aac') {
    return true
  }

  return !channels || !codec || !codecProfile
}

async function probeAudioMetadataWithFfprobe(filePath: string): Promise<FfprobeAudioMetadata | null> {
  const ffprobePath = await resolveFfprobeBinaryPath()
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

    const parsed = JSON.parse(stdout) as {
      streams?: Array<Record<string, unknown>>
      format?: Record<string, unknown>
    }
    const stream = parsed.streams?.find((entry) => entry.codec_type === 'audio') ?? parsed.streams?.[0]
    if (!stream) return null

    return {
      channels: toNumber(stream.channels),
      codec: toText(stream.codec_name) ?? toText(stream.codec_long_name),
      codecProfile: toText(stream.profile),
      hints: collectFfprobeHints(stream, parsed.format)
    }
  } catch (error) {
    console.warn(`ffprobe metadata probe failed for ${filePath}:`, error)
    return null
  }
}

async function resolveCodecMetadata(
  filePath: string,
  base: { channels: number | null; codec: string | null; codecProfile: string | null }
): Promise<ResolvedCodecMetadata> {
  let channels = base.channels
  let codec = base.codec
  let codecProfile = base.codecProfile
  let hints: string[] = []

  if (shouldProbeWithFfprobe(filePath, channels, codec, codecProfile)) {
    const ffprobeMetadata = await probeAudioMetadataWithFfprobe(filePath)
    if (ffprobeMetadata) {
      channels = ffprobeMetadata.channels ?? channels
      codec = ffprobeMetadata.codec ?? codec
      codecProfile = ffprobeMetadata.codecProfile ?? codecProfile
      hints = ffprobeMetadata.hints
    }
  }

  return {
    channels,
    codec,
    codecProfile,
    isAtmosJoc: isAtmosJocStream(codec, codecProfile, hints)
  }
}

// Extract metadata from audio file
interface ExtractedTrackMetadata {
  title: string
  artist: string
  artistNamesJson: string | null
  album: string
  albumArtist: string | null
  albumArtistNamesJson: string | null
  duration: number
  trackNumber: number | null
  discNumber: number | null
  year: number | null
  genre: string | null
  genreNamesJson: string | null
  artworkHash: string | null
  format: string
  sampleRate: number | null
  bitDepth: number | null
  bitrate: number | null
  channels: number | null
  codec: string | null
  codecProfile: string | null
  isAtmosJoc: number
  isIamf: number
  replayGainTrackDb: number | null
  replayGainAlbumDb: number | null
  bpm: number | null
  musicalKey: string | null
}

/**
 * Reads just the top-level moov box from an MP4 file (fd-based; never loads
 * mdat, so multi-GB videos cost only a few header reads + the moov itself).
 * Returns null when the file is not ISO-BMFF or has no moov.
 */
export async function readMp4MoovBox(filePath: string): Promise<Uint8Array | null> {
  const MAX_MOOV_BYTES = 64 * 1024 * 1024 // sanity cap; music moov is ~KBs
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(filePath, 'r')
    const fileSize = (await handle.stat()).size
    const header = Buffer.alloc(16)
    let offset = 0
    let sawFtyp = false
    while (offset + 8 <= fileSize) {
      const { bytesRead } = await handle.read(header, 0, 16, offset)
      if (bytesRead < 8) return null
      let size = header.readUInt32BE(0)
      const type = header.toString('latin1', 4, 8)
      let headerLength = 8
      if (size === 1) {
        if (bytesRead < 16) return null
        const large = header.readBigUInt64BE(8)
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null
        size = Number(large)
        headerLength = 16
      } else if (size === 0) {
        size = fileSize - offset
      }
      if (size < headerLength) return null
      if (offset === 0 && type !== 'ftyp') return null
      if (type === 'ftyp') sawFtyp = true
      if (type === 'moov' && sawFtyp) {
        if (size > MAX_MOOV_BYTES) return null
        const moov = Buffer.alloc(size)
        const read = await handle.read(moov, 0, size, offset)
        if (read.bytesRead !== size) return null
        return new Uint8Array(moov)
      }
      offset += size
    }
    return null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

// IAMF (Eclipsa) sources: music-metadata cannot parse them — and a throw
// inside extractMetadata drops the file from the library entirely — so
// metadata comes from the container (OBU walker / moov) plus filename and
// folder-artwork fallbacks.
async function buildIamfTrackMetadata(
  filePath: string,
  options: { folderArtworkCache?: FolderArtworkScanCache },
  info: { duration: number; sampleRate: number | null; format: string }
): Promise<ExtractedTrackMetadata> {
  const fileName = basename(filePath, extname(filePath))
  const folderArtworkCache = options.folderArtworkCache ?? createFolderArtworkScanCache()
  const artworkHash = await resolveFolderArtworkHash(filePath, folderArtworkCache)

  return {
    title: fileName,
    artist: 'Unknown Artist',
    artistNamesJson: null,
    album: 'Unknown Album',
    albumArtist: null,
    albumArtistNamesJson: null,
    duration: info.duration,
    trackNumber: null,
    discNumber: null,
    year: null,
    genre: null,
    genreNamesJson: null,
    artworkHash,
    format: info.format,
    sampleRate: info.sampleRate,
    bitDepth: null,
    bitrate: null,
    // The decoder always materializes 7.1.4 — this is what byte-budget
    // estimates and the channels indicator should see.
    channels: 12,
    codec: 'iamf',
    codecProfile: null,
    isAtmosJoc: 0,
    isIamf: 1,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    bpm: null,
    musicalKey: null
  }
}

async function extractIamfMetadata(filePath: string, options: {
  folderArtworkCache?: FolderArtworkScanCache
} = {}): Promise<ExtractedTrackMetadata> {
  let duration = 0
  let sampleRate: number | null = null
  try {
    const stats = collectIamfStreamStats(new Uint8Array(await readFile(filePath)))
    if (stats) {
      duration = stats.durationSeconds ?? 0
      sampleRate = stats.sampleRate
    }
  } catch {
    // Unreadable/corrupt stream: index with filename only; playback surfaces
    // the real error.
  }
  return buildIamfTrackMetadata(filePath, options, { duration, sampleRate, format: 'iamf' })
}

async function extractMetadata(filePath: string, options: {
  folderArtworkCache?: FolderArtworkScanCache
} = {}): Promise<ExtractedTrackMetadata> {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.iamf') {
    return extractIamfMetadata(filePath, options)
  }
  if (extension === '.mp4') {
    const moov = await readMp4MoovBox(filePath)
    if (!moov || !mp4HasIamfTrack(moov)) {
      // Deliberate: .mp4 is only indexed when it carries an IAMF track —
      // plain video files must not enter the music library. (Throwing keeps
      // today's behavior: the scanner counts an error and skips the file.)
      throw new Error('.mp4 without an IAMF audio track is not indexed as music')
    }
    return buildIamfTrackMetadata(filePath, options, {
      duration: readMp4DurationSeconds(moov) ?? 0,
      sampleRate: null,
      format: 'mp4'
    })
  }

  const metadata = await mm.parseFile(filePath, getMusicMetadataParseOptions(filePath))
  const common = metadata.common
  const format = metadata.format
  const resolvedCodecMetadata = await resolveCodecMetadata(filePath, {
    channels: format.numberOfChannels || null,
    codec: toText(format.codec),
    codecProfile: toText(format.codecProfile)
  })
  const replayGain = replayGainScanEnabled
    ? extractReplayGainDb(metadata)
    : { trackGainDb: null, albumGainDb: null }
  const bpm = extractBpm(metadata)
  const musicalKey = extractMusicalKey(metadata)

  // Extract and save artwork using selectCover for best image selection
  let artworkHash: string | null = null
  const picture = mm.selectCover(common.picture)
  if (picture && picture.data && picture.data.length > 0) {
    // Get MIME type - picture.format should be like "image/jpeg" or "image/png"
    const mimeType = picture.format || 'image/jpeg'
    const formatExt = getImageExtension(mimeType)
    const hash = createHash('md5').update(picture.data).digest('hex') + formatExt
    const artworkPath = join(artworkDir, hash)

    // Save artwork if not already cached
    try {
      await writeFile(artworkPath, picture.data, { flag: 'wx' })
      artworkHash = hash
    } catch (err: unknown) {
      // File already exists - that's fine, use the hash
      if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
        artworkHash = hash
      } else {
        // Verify file exists anyway (might have been written by another track)
        try {
          await stat(artworkPath)
          artworkHash = hash
        } catch {
          // artworkHash remains null
        }
      }
    }
  }
  if (!artworkHash) {
    const folderArtworkCache = options.folderArtworkCache ?? createFolderArtworkScanCache()
    artworkHash = await resolveFolderArtworkHash(filePath, folderArtworkCache)
  }

  const fileName = basename(filePath, extname(filePath))
    const parsedArtistNames = normalizeArtistNames(common.artists ?? [])
    const parsedAlbumArtistNames = normalizeArtistNames(common.albumartists ?? [])
    const genreFields = resolveGenreStorageFields(common.genre ?? [])
    const artistDisplay = parsedArtistNames.length > 1
      ? formatArtistNames(parsedArtistNames)
    : toText(common.artist) ?? (formatArtistNames(parsedArtistNames) || 'Unknown Artist')
  const albumArtistDisplay = parsedAlbumArtistNames.length > 1
    ? formatArtistNames(parsedAlbumArtistNames)
    : toText(common.albumartist) ?? (formatArtistNames(parsedAlbumArtistNames) || null)

  return {
    title: common.title || fileName,
    artist: artistDisplay,
    artistNamesJson: parsedArtistNames.length > 1 ? serializeArtistNames(parsedArtistNames) : null,
    album: common.album || 'Unknown Album',
    albumArtist: albumArtistDisplay,
    albumArtistNamesJson: parsedAlbumArtistNames.length > 1 ? serializeArtistNames(parsedAlbumArtistNames) : null,
    duration: format.duration || 0,
      trackNumber: common.track?.no || null,
      discNumber: common.disk?.no || null,
      year: common.year || null,
      genre: genreFields.genre,
      genreNamesJson: genreFields.genreNamesJson,
      artworkHash,
    format: extname(filePath).slice(1).toLowerCase(),
    sampleRate: format.sampleRate || null,
    bitDepth: format.bitsPerSample || null,
    bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null,
    channels: resolvedCodecMetadata.channels,
    codec: resolvedCodecMetadata.codec,
    codecProfile: resolvedCodecMetadata.codecProfile,
    isAtmosJoc: resolvedCodecMetadata.isAtmosJoc ? 1 : 0,
    isIamf: 0,
    replayGainTrackDb: replayGain.trackGainDb,
    replayGainAlbumDb: replayGain.albumGainDb,
    bpm,
    musicalKey
  }
}

function getBackfillCandidatePaths(options: {
  folderPath?: string
  includeLegacyAtmosHeuristic: boolean
}): string[] {
  if (!db) return []

  const missingMetadataClause = `
    channels IS NULL
    OR codec IS NULL
    OR codec_profile IS NULL
    OR is_atmos_joc IS NULL
    OR bpm IS NULL
    OR musical_key IS NULL
  `
  const legacyAtmosClause = `
    LOWER(format) IN ('m4a', 'mp4', 'm4b', 'm4p', 'aac')
    AND COALESCE(channels, 0) > 2
    AND COALESCE(is_atmos_joc, 0) = 0
  `

  const candidateClauses = [missingMetadataClause]
  if (options.includeLegacyAtmosHeuristic) {
    candidateClauses.push(legacyAtmosClause)
  }

  // IAMF rows always have null codec_profile etc. and ffprobe can't fill
  // them in — keep them out of the backfill queue permanently.
  let sql = `SELECT path FROM tracks WHERE source_type = 'local' AND COALESCE(is_iamf, 0) = 0 AND (${candidateClauses.join(' OR ')})`
  const params: unknown[] = []
  if (options.folderPath) {
    sql += ' AND path LIKE ?'
    params.push(`${options.folderPath}%`)
  }

  const paths: string[] = []
  for (const row of db.iterate<{ path?: unknown }>(sql, params)) {
    if (typeof row.path === 'string') {
      paths.push(row.path)
    }
  }
  return paths
}

function getReplayGainBackfillCandidatePaths(): string[] {
  if (!db) return []
  return db.all<{ path?: unknown }>(`
    SELECT path
    FROM tracks
    WHERE source_type = 'local'
      AND (
        replaygain_track_gain_db IS NULL
        OR replaygain_album_gain_db IS NULL
      )
  `)
    .map((row) => (typeof row.path === 'string' ? row.path : null))
    .filter((value): value is string => value !== null)
}

function getFileCreatedAtBackfillCandidatePaths(): string[] {
  if (!db) return []
  return db.all<{ path?: unknown }>(`
    SELECT path
    FROM tracks
    WHERE source_type = 'local'
      AND file_created_at IS NULL
  `)
    .map((row) => (typeof row.path === 'string' ? row.path : null))
    .filter((value): value is string => value !== null)
}

function getArtistCreditBackfillCandidatePaths(): string[] {
  if (!db) return []
  return db.all<{ path?: unknown }>(`
    SELECT path
    FROM tracks
    WHERE source_type = 'local'
    ORDER BY path COLLATE NOCASE
  `)
    .map((row) => (typeof row.path === 'string' ? row.path : null))
    .filter((value): value is string => value !== null)
}

function getGenreBackfillCandidatePaths(): string[] {
  if (!db) return []
  return db.all<{ path?: unknown }>(`
    SELECT path
    FROM tracks
    WHERE source_type = 'local'
      AND genre_names_json IS NULL
    ORDER BY path COLLATE NOCASE
  `)
    .map((row) => (typeof row.path === 'string' ? row.path : null))
    .filter((value): value is string => value !== null)
}

async function backfillTrackAudioMetadata(path: string): Promise<void> {
  if (!db) return

  let baseChannels: number | null = null
  let baseCodec: string | null = null
  let baseCodecProfile: string | null = null
  let bpm: number | null = null
  let musicalKey: string | null = null

  try {
    const metadata = await mm.parseFile(path, getMusicMetadataParseOptions(path))
    baseChannels = metadata.format.numberOfChannels || null
    baseCodec = toText(metadata.format.codec)
    baseCodecProfile = toText(metadata.format.codecProfile)
    bpm = extractBpm(metadata)
    musicalKey = extractMusicalKey(metadata)
  } catch {
    // We'll still attempt ffprobe-only resolution below.
  }

  const resolvedCodecMetadata = await resolveCodecMetadata(path, {
    channels: baseChannels,
    codec: baseCodec,
    codecProfile: baseCodecProfile
  })

  db.run(
    "UPDATE tracks SET channels = ?, codec = ?, codec_profile = ?, is_atmos_joc = ?, bpm = ?, musical_key = ? WHERE path = ? AND source_type = 'local'",
    [
      resolvedCodecMetadata.channels,
      resolvedCodecMetadata.codec,
      resolvedCodecMetadata.codecProfile,
      resolvedCodecMetadata.isAtmosJoc ? 1 : 0,
      bpm,
      musicalKey,
      path
    ]
  )
}

async function backfillTrackArtistCreditMetadata(path: string): Promise<void> {
  if (!db) return
  const metadata = await mm.parseFile(path, getMusicMetadataParseOptions(path, { skipCovers: true }))
  const artistNames = normalizeArtistNames(metadata.common.artists ?? [])
  const albumArtistNames = normalizeArtistNames(metadata.common.albumartists ?? [])

  db.run(
    "UPDATE tracks SET artist_names_json = ?, album_artist_names_json = ? WHERE path = ? AND source_type = 'local'",
    [
      artistNames.length > 1 ? serializeArtistNames(artistNames) : null,
      albumArtistNames.length > 1 ? serializeArtistNames(albumArtistNames) : null,
      path
    ]
  )
}

async function backfillTrackGenreMetadata(path: string): Promise<void> {
  if (!db) return
  const metadata = await mm.parseFile(path, getMusicMetadataParseOptions(path, { skipCovers: true }))
  const genreFields = resolveGenreStorageFields(metadata.common.genre ?? [])

  db.run(
    "UPDATE tracks SET genre = ?, genre_names_json = ? WHERE path = ? AND source_type = 'local'",
    [
      genreFields.genre,
      genreFields.genreNamesJson,
      path
    ]
  )
}

async function backfillTrackReplayGainMetadata(path: string): Promise<void> {
  if (!db) return

  let replayGainTrackDb: number | null = null
  let replayGainAlbumDb: number | null = null

  if (replayGainScanEnabled) {
    try {
      const metadata = await mm.parseFile(path, getMusicMetadataParseOptions(path))
      const replayGain = extractReplayGainDb(metadata)
      replayGainTrackDb = replayGain.trackGainDb
      replayGainAlbumDb = replayGain.albumGainDb
    } catch {
      // Keep null values when tags cannot be parsed.
    }
  }

  db.run(
    "UPDATE tracks SET replaygain_track_gain_db = ?, replaygain_album_gain_db = ? WHERE path = ? AND source_type = 'local'",
    [replayGainTrackDb, replayGainAlbumDb, path]
  )
}

async function backfillTrackFileCreatedAt(path: string): Promise<void> {
  if (!db) return
  const fileStat = await stat(path)
  const fileCreatedAt = normalizeFileCreatedAtMs(fileStat.birthtimeMs)

  db.run(
    "UPDATE tracks SET file_created_at = ? WHERE path = ? AND source_type = 'local'",
    [fileCreatedAt, path]
  )
}

type BackfillProgressCallback = (current: number, total: number, path: string) => void

async function backfillPaths(
  paths: string[],
  onProgress?: BackfillProgressCallback,
  options: ScanWriteOptions = {}
): Promise<{ scanned: number; updated: number; errors: number }> {
  const { persist = true, signal, onIssue } = options
  if (!db || paths.length === 0) {
    onProgress?.(0, 0, '')
    return { scanned: 0, updated: 0, errors: 0 }
  }

  let updated = 0
  let errors = 0
  let processed = 0
  const workerCount = resolveBackfillWorkerCount(paths.length)
  onProgress?.(0, paths.length, '')

  await runWithConcurrency(paths, workerCount, async (path) => {
    try {
      throwIfScanCancelled(signal)
      await backfillTrackAudioMetadata(path)
      updated++
    } catch (err) {
      if (isLibraryScanCancelledError(err)) {
        throw err
      }
      const issue = createLibraryScanIssue('backfill', path, err)
      onIssue?.(issue)
      if (issue.code !== 'ENOENT' && issue.code !== 'ENOTDIR') {
        console.warn(`Failed to backfill audio metadata for ${path}:`, err)
      }
      errors++
    } finally {
      processed += 1
      onProgress?.(processed, paths.length, path)
    }
  }, { signal })

  throwIfScanCancelled(signal)
  if (persist && updated > 0) {
    await saveDatabase()
  }

  return { scanned: paths.length, updated, errors }
}

export async function backfillMissingChannelCounts(
  options: ScanWriteOptions = {}
): Promise<{ scanned: number; updated: number; errors: number }> {
  const paths = getBackfillCandidatePaths({
    includeLegacyAtmosHeuristic: true
  })
  return backfillPaths(paths, undefined, options)
}

export async function backfillMissingFileCreatedAt(
  options: ScanWriteOptions = {}
): Promise<{ scanned: number; updated: number; errors: number }> {
  const { persist = true, signal, onIssue } = options
  const paths = getFileCreatedAtBackfillCandidatePaths()
  if (paths.length === 0) {
    return { scanned: 0, updated: 0, errors: 0 }
  }

  let updated = 0
  let errors = 0
  const workerCount = resolveBackfillWorkerCount(paths.length)

  await runWithConcurrency(paths, workerCount, async (path) => {
    try {
      throwIfScanCancelled(signal)
      await backfillTrackFileCreatedAt(path)
      updated += 1
    } catch (err) {
      if (isLibraryScanCancelledError(err)) {
        throw err
      }
      const issue = createLibraryScanIssue('backfill', path, err)
      onIssue?.(issue)
      if (issue.code !== 'ENOENT' && issue.code !== 'ENOTDIR') {
        console.warn(`Failed to backfill file creation time for ${path}:`, err)
      }
      errors += 1
    }
  }, { signal })

  throwIfScanCancelled(signal)
  if (persist && updated > 0) {
    await saveDatabase()
  }

  return { scanned: paths.length, updated, errors }
}

export async function backfillMissingArtistCreditMetadata(
  onProgress?: BackfillProgressCallback,
  options: ScanWriteOptions = {}
): Promise<{ scanned: number; updated: number; errors: number }> {
  const { persist = true, signal, onIssue } = options
  const paths = getArtistCreditBackfillCandidatePaths()
  if (paths.length === 0) {
    onProgress?.(0, 0, '')
    return { scanned: 0, updated: 0, errors: 0 }
  }

  let updated = 0
  let errors = 0
  let processed = 0
  const workerCount = resolveBackfillWorkerCount(paths.length)
  onProgress?.(0, paths.length, '')

  await runWithConcurrency(paths, workerCount, async (path) => {
    try {
      throwIfScanCancelled(signal)
      await backfillTrackArtistCreditMetadata(path)
      updated += 1
    } catch (err) {
      if (isLibraryScanCancelledError(err)) {
        throw err
      }
      const issue = createLibraryScanIssue('backfill', path, err)
      onIssue?.(issue)
      if (issue.code !== 'ENOENT' && issue.code !== 'ENOTDIR') {
        console.warn(`Failed to backfill artist credit metadata for ${path}:`, err)
      }
      errors += 1
    } finally {
      processed += 1
      onProgress?.(processed, paths.length, path)
    }
  }, { signal })

  throwIfScanCancelled(signal)
  if (persist && updated > 0) {
    await saveDatabase()
  }

  return { scanned: paths.length, updated, errors }
}

export async function backfillMissingGenreMetadata(
  onProgress?: BackfillProgressCallback,
  options: ScanWriteOptions = {}
): Promise<{ scanned: number; updated: number; errors: number }> {
  const { persist = true, signal, onIssue } = options
  const paths = getGenreBackfillCandidatePaths()
  if (paths.length === 0) {
    onProgress?.(0, 0, '')
    return { scanned: 0, updated: 0, errors: 0 }
  }

  let updated = 0
  let errors = 0
  let processed = 0
  const workerCount = resolveBackfillWorkerCount(paths.length)
  onProgress?.(0, paths.length, '')

  await runWithConcurrency(paths, workerCount, async (path) => {
    try {
      throwIfScanCancelled(signal)
      await backfillTrackGenreMetadata(path)
      updated += 1
    } catch (err) {
      if (isLibraryScanCancelledError(err)) {
        throw err
      }
      const issue = createLibraryScanIssue('backfill', path, err)
      onIssue?.(issue)
      if (issue.code !== 'ENOENT' && issue.code !== 'ENOTDIR') {
        console.warn(`Failed to backfill genre metadata for ${path}:`, err)
      }
      errors += 1
    } finally {
      processed += 1
      onProgress?.(processed, paths.length, path)
    }
  }, { signal })

  throwIfScanCancelled(signal)
  if (persist && updated > 0) {
    await saveDatabase()
  }

  return { scanned: paths.length, updated, errors }
}

export async function backfillMissingReplayGainMetadata(
  onProgress?: BackfillProgressCallback,
  options: ScanWriteOptions = {}
): Promise<{ scanned: number; updated: number; errors: number }> {
  const { persist = true, signal, onIssue } = options
  if (!replayGainScanEnabled) {
    onProgress?.(0, 0, '')
    return { scanned: 0, updated: 0, errors: 0 }
  }

  const paths = getReplayGainBackfillCandidatePaths()
  if (paths.length === 0) {
    onProgress?.(0, 0, '')
    return { scanned: 0, updated: 0, errors: 0 }
  }

  let updated = 0
  let errors = 0
  let processed = 0
  const workerCount = resolveBackfillWorkerCount(paths.length)
  onProgress?.(0, paths.length, '')

  await runWithConcurrency(paths, workerCount, async (path) => {
    try {
      throwIfScanCancelled(signal)
      await backfillTrackReplayGainMetadata(path)
      updated++
    } catch (err) {
      if (isLibraryScanCancelledError(err)) {
        throw err
      }
      const issue = createLibraryScanIssue('backfill', path, err)
      onIssue?.(issue)
      if (issue.code !== 'ENOENT' && issue.code !== 'ENOTDIR') {
        console.warn(`Failed to backfill ReplayGain metadata for ${path}:`, err)
      }
      errors++
    } finally {
      processed += 1
      onProgress?.(processed, paths.length, path)
    }
  }, { signal })

  throwIfScanCancelled(signal)
  if (persist && updated > 0) {
    await saveDatabase()
  }

  return { scanned: paths.length, updated, errors }
}

export async function backfillIncompleteAudioMetadataForFolder(
  folderPath: string,
  onProgress?: BackfillProgressCallback,
  options: ScanWriteOptions = {}
): Promise<{ scanned: number; updated: number; errors: number }> {
  const normalizedPath = folderPath.trim()
  if (!normalizedPath) return { scanned: 0, updated: 0, errors: 0 }

  const paths = getBackfillCandidatePaths({
    folderPath: normalizedPath,
    includeLegacyAtmosHeuristic: false
  })
  return backfillPaths(paths, onProgress, options)
}

// Get image extension from mime type
function getImageExtension(mimeType: string): string {
  const type = mimeType.toLowerCase()
  if (type.includes('png')) return '.png'
  if (type.includes('gif')) return '.gif'
  if (type.includes('webp')) return '.webp'
  if (type.includes('bmp')) return '.bmp'
  return '.jpg' // Default to jpg for jpeg and unknown types
}

function detectImageExtensionFromBytes(data: Uint8Array): string {
  if (data.length >= 8) {
    if (
      data[0] === 0x89 &&
      data[1] === 0x50 &&
      data[2] === 0x4e &&
      data[3] === 0x47 &&
      data[4] === 0x0d &&
      data[5] === 0x0a &&
      data[6] === 0x1a &&
      data[7] === 0x0a
    ) {
      return '.png'
    }
  }
  if (data.length >= 6) {
    const header = Buffer.from(data.subarray(0, 6)).toString('ascii')
    if (header === 'GIF87a' || header === 'GIF89a') {
      return '.gif'
    }
  }
  if (data.length >= 12) {
    const riff = Buffer.from(data.subarray(0, 4)).toString('ascii')
    const webp = Buffer.from(data.subarray(8, 12)).toString('ascii')
    if (riff === 'RIFF' && webp === 'WEBP') {
      return '.webp'
    }
  }
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) {
    return '.jpg'
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
    return '.bmp'
  }
  return '.jpg'
}

export async function cacheArtworkBuffer(
  imageData: ArrayBuffer | Uint8Array | Buffer,
  mimeType?: string | null
): Promise<string | null> {
  if (!artworkDir) return null

  const bytes: Uint8Array = imageData instanceof ArrayBuffer
    ? new Uint8Array(imageData)
    : imageData

  if (bytes.byteLength === 0) return null

  const extension = mimeType && mimeType.trim().length > 0
    ? getImageExtension(mimeType)
    : detectImageExtensionFromBytes(bytes)

  const hash = `${createHash('md5').update(bytes).digest('hex')}${extension}`
  const artworkPath = join(artworkDir, hash)

  try {
    await writeFile(artworkPath, bytes, { flag: 'wx' })
    return hash
  } catch (error) {
    if (getErrorCode(error) !== 'EEXIST') {
      console.warn('Failed to persist artwork cache entry:', artworkPath, error)
      return null
    }
  }

  try {
    await stat(artworkPath)
    return hash
  } catch {
    return null
  }
}

// Get artwork path by hash
export function getArtworkPath(hash: string): string {
  if (hash.startsWith(PLAYLIST_COVER_HASH_PREFIX)) {
    return join(playlistCoverDir, hash.slice(PLAYLIST_COVER_HASH_PREFIX.length))
  }
  if (hash.startsWith(ARTIST_IMAGE_HASH_PREFIX)) {
    return join(artistImageDir, hash.slice(ARTIST_IMAGE_HASH_PREFIX.length))
  }

  // New format: hash includes extension (e.g., "abc123.png")
  // Old format: hash is just the md5, file saved as .jpg
  if (hash.includes('.')) {
    return join(artworkDir, hash)
  }
  // Backward compatibility: old artwork saved with .jpg extension
  return join(artworkDir, `${hash}.jpg`)
}

// Get track count
export function getTrackCount(): number {
  if (!db) return 0
  return Number(db.get<{ count?: unknown }>('SELECT COUNT(*) as count FROM tracks')?.count ?? 0)
}

export function getTotalTrackDuration(): number {
  if (!db) return 0
  const total = Number(db.get<{ total?: unknown }>(
    'SELECT SUM(duration) as total FROM tracks WHERE duration > 0'
  )?.total ?? 0)
  return Number.isFinite(total) && total > 0 ? total : 0
}

function resolveEditableValuesForSave(
  snapshot: EditableTrackSnapshot,
  changes: MetadataEditChanges
): {
  title: string
  artist: string
  album: string
  albumArtist: string | null
  genre: string | null
  year: number | null
  trackNumber: number | null
  discNumber: number | null
} {
  const title = changes.title === undefined
    ? snapshot.effective.title
    : normalizeRequiredTextField(changes.title, 'title')
  const artist = changes.artist === undefined
    ? snapshot.effective.artist
    : normalizeRequiredTextField(changes.artist, 'artist')
  const album = changes.album === undefined
    ? snapshot.effective.album
    : normalizeRequiredTextField(changes.album, 'album')
  const albumArtist = changes.albumArtist === undefined
    ? snapshot.effective.albumArtist
    : normalizeOptionalTextField(changes.albumArtist)
  const genre = changes.genre === undefined
    ? snapshot.effective.genre
    : normalizeOptionalTextField(changes.genre)
  const year = changes.year === undefined
    ? snapshot.effective.year
    : normalizeOptionalIntegerField(changes.year, 'year')
  const trackNumber = changes.trackNumber === undefined
    ? snapshot.effective.trackNumber
    : normalizeOptionalIntegerField(changes.trackNumber, 'trackNumber')
  const discNumber = changes.discNumber === undefined
    ? snapshot.effective.discNumber
    : normalizeOptionalIntegerField(changes.discNumber, 'discNumber')

  return { title, artist, album, albumArtist, genre, year, trackNumber, discNumber }
}

export interface ResolvedMetadataValues {
  title: string
  artist: string
  album: string
  albumArtist: string | null
  genre: string | null
  year: number | null
  trackNumber: number | null
  discNumber: number | null
}

export function buildFfmpegMetadataRewriteArgs(values: ResolvedMetadataValues): string[] {
  const yearValue = values.year !== null ? String(values.year) : ''
  return [
    '-map_metadata', '-1',
    '-metadata', `title=${values.title}`,
    '-metadata', `artist=${values.artist}`,
    '-metadata', `album=${values.album}`,
    '-metadata', `album_artist=${values.albumArtist ?? ''}`,
    '-metadata', `genre=${values.genre ?? ''}`,
    '-metadata', `date=${yearValue}`,
    '-metadata', `year=${yearValue}`,
    '-metadata', `track=${values.trackNumber !== null ? String(values.trackNumber) : ''}`,
    '-metadata', `disc=${values.discNumber !== null ? String(values.discNumber) : ''}`
  ]
}

function buildFfmpegArtworkArgs(artworkChange: ResolvedMetadataArtworkChange): string[] {
  if (artworkChange.kind === 'unchanged') {
    return ['-map', '0']
  }
  if (artworkChange.kind === 'remove') {
    return ['-map', '0', '-map', '-0:v']
  }

  return [
    '-map', '0',
    '-map', '-0:v',
    '-map', '1:v:0',
    '-disposition:v:0', 'attached_pic',
    '-metadata:s:v:0', 'title=Cover',
    '-metadata:s:v:0', 'comment=Cover (front)'
  ]
}

async function writeTrackMetadataToFile(
  trackPath: string,
  values: ResolvedMetadataValues,
  artworkChange: ResolvedMetadataArtworkChange
): Promise<void> {
  const ffmpegPath = await resolveFfmpegBinaryPath()
  if (!ffmpegPath) {
    throw new Error('FFmpeg binary is not available.')
  }

  const extension = extname(trackPath).toLowerCase()
  const tempDir = await mkdtemp(join(tmpdir(), 'astra-tag-write-'))
  const outputPath = join(tempDir, `updated${extension || '.media'}`)

  try {
    const ffmpegArgs: string[] = [
      '-v', 'error',
      '-y',
      '-i', trackPath
    ]

    if (artworkChange.kind === 'replace') {
      ffmpegArgs.push('-i', artworkChange.imagePath)
    }

    ffmpegArgs.push(
      ...buildFfmpegArtworkArgs(artworkChange),
      ...buildFfmpegMetadataRewriteArgs(values),
      '-c', 'copy'
    )

    if (artworkChange.kind === 'replace') {
      ffmpegArgs.push('-c:v', 'mjpeg')
    }

    ffmpegArgs.push(outputPath)

    await execFileAsync(
      ffmpegPath,
      ffmpegArgs,
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }
    )

    await copyFile(outputPath, trackPath)
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function updateTrackRowFromFileMetadata(trackPath: string): Promise<void> {
  if (!db) return
  const metadata = await extractMetadata(trackPath)
  const fileStat = await stat(trackPath)
  const fileCreatedAt = normalizeFileCreatedAtMs(fileStat.birthtimeMs)
  const now = Date.now()

  db.run(`
    UPDATE tracks SET title=?, artist=?, artist_names_json=?, album=?, album_artist=?, album_artist_names_json=?, duration=?, track_number=?, disc_number=?, year=?, genre=?, genre_names_json=?, artwork_hash=?, format=?, sample_rate=?, bit_depth=?, bitrate=?, channels=?, codec=?, codec_profile=?, is_atmos_joc=?, is_iamf=?, replaygain_track_gain_db=?, replaygain_album_gain_db=?, bpm=?, musical_key=?, source_type='local', source_id=NULL, source_track_id=NULL, source_path=NULL, is_available=1, availability_reason=NULL, file_created_at=?, modified_at=?
    WHERE path=?
  `, [
    metadata.title, metadata.artist, metadata.artistNamesJson, metadata.album, metadata.albumArtist, metadata.albumArtistNamesJson,
    metadata.duration, metadata.trackNumber, metadata.discNumber, metadata.year,
    metadata.genre, metadata.genreNamesJson, metadata.artworkHash, metadata.format, metadata.sampleRate,
    metadata.bitDepth, metadata.bitrate, metadata.channels, metadata.codec, metadata.codecProfile, metadata.isAtmosJoc, metadata.isIamf,
    metadata.replayGainTrackDb, metadata.replayGainAlbumDb, metadata.bpm, metadata.musicalKey, fileCreatedAt, now, trackPath
  ])
}

function normalizeMetadataEditChanges(changes: MetadataEditChanges): MetadataEditChanges {
  const normalized: MetadataEditChanges = {}
  if (changes.title !== undefined) normalized.title = changes.title
  if (changes.artist !== undefined) normalized.artist = changes.artist
  if (changes.album !== undefined) normalized.album = changes.album
  if (changes.albumArtist !== undefined) normalized.albumArtist = changes.albumArtist
  if (changes.genre !== undefined) normalized.genre = changes.genre
  if (changes.year !== undefined) normalized.year = changes.year
  if (changes.trackNumber !== undefined) normalized.trackNumber = changes.trackNumber
  if (changes.discNumber !== undefined) normalized.discNumber = changes.discNumber
  if (changes.artworkPath !== undefined) {
    normalized.artworkPath = changes.artworkPath === null
      ? null
      : normalizeMetadataArtworkPath(changes.artworkPath)
  }
  return normalized
}

function normalizeMetadataEditTrackPaths(trackPaths: string[]): string[] {
  const normalizedPaths = trackPaths
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
  return Array.from(new Set(normalizedPaths))
}

export function getMetadataOverridePaths(): string[] {
  if (!db) return []
  return db.all<{ track_path?: unknown }>('SELECT track_path FROM track_metadata_overrides ORDER BY track_path COLLATE NOCASE')
    .map((row) => String(row.track_path ?? ''))
    .filter((trackPath) => trackPath.length > 0)
}

export async function clearMetadataOverrides(trackPaths: string[]): Promise<{ cleared: number }> {
  if (!db) return { cleared: 0 }
  const normalizedPaths = normalizeMetadataEditTrackPaths(trackPaths)
  if (normalizedPaths.length === 0) return { cleared: 0 }

  const placeholders = normalizedPaths.map(() => '?').join(', ')
  const cleared = db.run(`DELETE FROM track_metadata_overrides WHERE track_path IN (${placeholders})`, normalizedPaths).changes
  await saveDatabase()
  return { cleared: Number.isFinite(cleared) ? cleared : 0 }
}

export async function saveMetadataEdits(
  request: MetadataEditRequest,
  onProgress?: (current: number, total: number, trackPath: string) => void
): Promise<MetadataEditResult> {
  if (!db) {
    throw new Error('Database not initialized')
  }

  const mode = request.mode
  if (mode !== 'virtual' && mode !== 'file') {
    throw new Error('Invalid metadata save mode.')
  }

  const normalizedPaths = normalizeMetadataEditTrackPaths(request.trackPaths)
  const normalizedChanges = normalizeMetadataEditChanges(request.changes)
  if (normalizedPaths.length === 0) {
    throw new Error('No track paths were provided.')
  }
  if (Object.keys(normalizedChanges).length === 0) {
    throw new Error('No metadata changes were provided.')
  }

  const artworkChange = await resolveMetadataArtworkChange(mode, normalizedChanges)
  const failures: MetadataEditFailure[] = []
  const updatedTrackPaths: string[] = []

  for (let i = 0; i < normalizedPaths.length; i += 1) {
    const trackPath = normalizedPaths[i]
    onProgress?.(i + 1, normalizedPaths.length, trackPath)
    try {
      const snapshot = getEditableTrackSnapshot(trackPath)
      if (!snapshot) {
        throw new Error('Track not found in library.')
      }

      if (mode === 'virtual') {
        const row = buildNextOverrideRow(snapshot, normalizedChanges, artworkChange)
        upsertTrackMetadataOverride(trackPath, row)
      } else {
        const resolvedValues = resolveEditableValuesForSave(snapshot, normalizedChanges)
        await writeTrackMetadataToFile(trackPath, resolvedValues, artworkChange)
        await updateTrackRowFromFileMetadata(trackPath)
        db.run('DELETE FROM track_metadata_overrides WHERE track_path = ?', [trackPath])
      }

      updatedTrackPaths.push(trackPath)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown metadata write failure.'
      failures.push({ trackPath, message })
    }
  }

  if (updatedTrackPaths.length > 0) {
    await saveDatabase()
  }

  return {
    mode,
    requested: normalizedPaths.length,
    succeeded: updatedTrackPaths.length,
    failed: failures.length,
    updatedTrackPaths,
    failures
  }
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
  artwork_hash: string | null
  artwork_cleared: number | null
}

export function getTrackOverrideSnapshots(trackPaths: string[]): Record<string, TrackOverrideSnapshot | null> {
  if (!db) return {}
  const result: Record<string, TrackOverrideSnapshot | null> = {}

  for (const trackPath of trackPaths) {
    const row = db.get<Record<string, unknown>>(
      'SELECT title, artist, album, album_artist, genre, year, track_number, disc_number, artwork_hash, artwork_cleared FROM track_metadata_overrides WHERE track_path = ?',
      [trackPath]
    )
    if (row) {
      result[trackPath] = {
        title: row.title as string | null,
        artist: row.artist as string | null,
        album: row.album as string | null,
        album_artist: row.album_artist as string | null,
        genre: row.genre as string | null,
        year: row.year as number | null,
        track_number: row.track_number as number | null,
        disc_number: row.disc_number as number | null,
        artwork_hash: row.artwork_hash as string | null,
        artwork_cleared: row.artwork_cleared as number | null
      }
    } else {
      result[trackPath] = null
    }
  }

  return result
}

export async function restoreTrackOverrides(overrides: Record<string, TrackOverrideSnapshot | null>): Promise<void> {
  if (!db) return

  for (const [trackPath, row] of Object.entries(overrides)) {
    if (row === null) {
      db.run('DELETE FROM track_metadata_overrides WHERE track_path = ?', [trackPath])
    } else {
      upsertTrackMetadataOverride(trackPath, row)
    }
  }

  await saveDatabase()
}

export function getTrackOverrideFields(trackPaths: string[]): Record<string, string[]> {
  if (!db) return {}
  const result: Record<string, string[]> = {}
  const fieldKeys: Array<keyof EditableTrackSnapshot['base']> = [
    'title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'trackNumber', 'discNumber', 'artworkHash'
  ]

  for (const trackPath of trackPaths) {
    const snapshot = getEditableTrackSnapshot(trackPath)
    if (!snapshot) continue

    const overriddenFields: string[] = []
    for (const field of fieldKeys) {
      if (snapshot.base[field] !== snapshot.effective[field]) {
        overriddenFields.push(field)
      }
    }
    if (overriddenFields.length > 0) {
      result[trackPath] = overriddenFields
    }
  }

  return result
}

// ── Favorites ────────────────────────────────────────────

export function getFavorites(): DbTrack[] {
  return readEffectiveTracks(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
    INNER JOIN favorites f ON f.track_path = t.path
    ORDER BY f.added_at DESC
  `)
}

export function getFavoritePaths(): string[] {
  if (!db) return []
  return db.all<{ track_path?: unknown }>('SELECT track_path FROM favorites')
    .map((row) => (typeof row.track_path === 'string' ? row.track_path : null))
    .filter((trackPath): trackPath is string => trackPath !== null)
}

export async function addFavorite(trackPath: string): Promise<void> {
  if (!db) return
  db.run('INSERT OR IGNORE INTO favorites (track_path, added_at) VALUES (?, ?)', [trackPath, Date.now()])
  clearFavoriteSyncRowsForPaths([trackPath])
  await saveDatabase()
}

export async function addFavoritePaths(
  trackPaths: string[],
  options: { persist?: boolean } = {}
): Promise<number> {
  if (!db || trackPaths.length === 0) return 0

  const uniqueTrackPaths = Array.from(new Set(
    trackPaths
      .map((trackPath) => (typeof trackPath === 'string' ? trackPath.trim() : ''))
      .filter((trackPath) => trackPath.length > 0)
  ))
  if (uniqueTrackPaths.length === 0) return 0

  const now = Date.now()
  let inserted = 0
  const insertedTrackPaths: string[] = []
  for (const trackPath of uniqueTrackPaths) {
    const result = db.run('INSERT OR IGNORE INTO favorites (track_path, added_at) VALUES (?, ?)', [trackPath, now])
    if (Number(result.changes) > 0) {
      inserted += 1
      insertedTrackPaths.push(trackPath)
    }
  }
  clearFavoriteSyncRowsForPaths(insertedTrackPaths)

  if (options.persist !== false && inserted > 0) {
    await saveDatabase()
  }
  return inserted
}

export async function syncSubsonicFavoriteTrackIds(
  sourceId: number,
  sourceTrackIds: string[],
  options: { persist?: boolean } = {}
): Promise<number> {
  if (!db || sourceTrackIds.length === 0) return 0

  const uniqueSourceTrackIds = Array.from(new Set(
    sourceTrackIds
      .map((sourceTrackId) => (typeof sourceTrackId === 'string' ? sourceTrackId.trim() : ''))
      .filter((sourceTrackId) => sourceTrackId.length > 0)
  ))
  if (uniqueSourceTrackIds.length === 0) return 0

  const trackPaths: string[] = []
  for (let offset = 0; offset < uniqueSourceTrackIds.length; offset += SQLITE_SAFE_MAX_VARIABLES) {
    const chunk = uniqueSourceTrackIds.slice(offset, offset + SQLITE_SAFE_MAX_VARIABLES)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db.all<{ path?: unknown }>(`
      SELECT path
      FROM tracks
      WHERE source_type = 'subsonic'
        AND source_id = ?
        AND source_track_id IN (${placeholders})
    `, [sourceId, ...chunk])
    for (const row of rows) {
      if (typeof row.path === 'string' && row.path.trim().length > 0) {
        trackPaths.push(row.path)
      }
    }
  }

  return addFavoritePaths(trackPaths, options)
}

export async function removeFavorite(trackPath: string): Promise<void> {
  if (!db) return
  // Record a deletion tombstone so a mobile LAN sync propagates the unfavorite
  // instead of resurrecting it from the peer's copy (phoneSync.ts).
  const syncKey = trackSyncKeyForPath(trackPath)
  if (syncKey) {
    db.run('INSERT OR REPLACE INTO favorite_tombstones (sync_key, deleted_at) VALUES (?, ?)', [syncKey, Date.now()])
    db.run('DELETE FROM favorite_sync_pending WHERE sync_key = ?', [syncKey])
  }
  db.run('DELETE FROM favorites WHERE track_path = ?', [trackPath])
  await saveDatabase()
}

// ── Track Ratings ────────────────────────────────────────

export function getTrackRatingEntries(): TrackRatingEntry[] {
  if (!db) return []
  return db.all<{ track_path?: unknown; rating?: unknown; updated_at?: unknown }>(
    'SELECT track_path, rating, updated_at FROM track_ratings'
  )
    .map((row) => {
      if (typeof row.track_path !== 'string' || row.track_path.length === 0) return null
      const rating = normalizeTrackRating(row.rating)
      if (rating === null) return null
      const updatedAt = typeof row.updated_at === 'number' ? row.updated_at : 0
      return { track_path: row.track_path, rating, updated_at: updatedAt }
    })
    .filter((entry): entry is TrackRatingEntry => entry !== null)
}

export async function setTrackRatingForPaths(
  trackPaths: string[],
  rating: number | null,
  options: { persist?: boolean } = {}
): Promise<number> {
  if (!db || trackPaths.length === 0) return 0

  const uniqueTrackPaths = Array.from(new Set(
    trackPaths
      .map((trackPath) => (typeof trackPath === 'string' ? trackPath.trim() : ''))
      .filter((trackPath) => trackPath.length > 0)
  ))
  if (uniqueTrackPaths.length === 0) return 0

  let changed = 0
  if (rating === null) {
    for (const trackPath of uniqueTrackPaths) {
      const result = db.run('DELETE FROM track_ratings WHERE track_path = ?', [trackPath])
      changed += Number(result.changes) > 0 ? 1 : 0
    }
  } else {
    const normalizedRating = normalizeTrackRating(rating)
    if (normalizedRating === null) {
      throw new Error('Rating must be between 0.5 and 5 in half-star steps.')
    }
    const now = Date.now()
    for (const trackPath of uniqueTrackPaths) {
      db.run(`
        INSERT INTO track_ratings (track_path, rating, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(track_path) DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at
      `, [trackPath, normalizedRating, now])
      changed += 1
    }
  }

  if (options.persist !== false && changed > 0) {
    await saveDatabase()
  }
  return changed
}

export async function resetAllTrackRatings(): Promise<number> {
  if (!db) return 0
  // Count first: the run() wrapper reports changes: 0 for parameterless
  // statements (they go through exec).
  const cleared = readCount('SELECT COUNT(*) FROM track_ratings')
  db.run('DELETE FROM track_ratings')
  if (cleared > 0) {
    await saveDatabase()
  }
  return cleared
}

// ── Recently Played ──────────────────────────────────────

interface ListeningSessionRow {
  id: number
  track_id: number | null
  track_path: string
  title: string
  artist: string
  album: string
  album_artist: string | null
  album_identity_key: string
  artwork_hash: string | null
  source_type: string
  started_at: number
  ended_at: number | null
  listened_seconds: number
  qualified_at: number | null
  current_path: string | null
  current_title: string | null
  current_artist: string | null
  current_artist_names_json: string | null
  current_album: string | null
  current_album_artist: string | null
  current_album_artist_names_json: string | null
  current_artwork_hash: string | null
  current_is_available: number | null
}

interface ListeningSegmentRow {
  session_id: number
  started_at: number
  last_observed_at: number
  listened_seconds: number
}

interface ListeningIdentity {
  trackKey: string
  trackPath: string | null
  title: string
  artist: string
  browseArtists: string[]
  album: string
  albumKey: string
  artworkHash: string | null
  available: boolean
}

interface ListeningAggregate {
  listenedSeconds: number
  qualifiedPlays: number
}

function finiteNonNegative(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0
}

function finiteTimestamp(value: unknown, fallback: number): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : fallback
}

function writeAppMetaValue(key: string, value: string, updatedAt: number = Date.now()): void {
  if (!db) return
  db.run(
    `INSERT INTO app_meta (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, updatedAt]
  )
}

export function ensureInstallId(): string {
  const existing = getAppMeta(INSTALL_ID_META_KEY)?.trim()
  if (existing) return existing
  const installId = randomUUID()
  writeAppMetaValue(INSTALL_ID_META_KEY, installId)
  return installId
}

function ensureListeningHistoryGeneration(): string {
  const existing = getAppMeta(LISTENING_HISTORY_GENERATION_META_KEY)?.trim()
  if (existing) return existing
  const generation = randomUUID()
  writeAppMetaValue(LISTENING_HISTORY_GENERATION_META_KEY, generation)
  return generation
}

function readListeningHistoryStartedAt(): number | null {
  const raw = getAppMeta(LISTENING_HISTORY_STARTED_AT_META_KEY)
  if (!raw) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

export function getListeningHistoryStatus(): ListeningHistoryStatus {
  return {
    generation: ensureListeningHistoryGeneration(),
    startedAt: readListeningHistoryStartedAt()
  }
}

/**
 * Seeds the per-origin breakdown from the counts a library already had. Everything recorded
 * before this table existed necessarily came from this install, so it all lands under the
 * local origin. Runs once — the flag matters because a later import writes foreign origin
 * rows, and re-running would fold those into the local total.
 */
function backfillTrackPlayOrigins(): void {
  if (!db) return
  if (getAppMeta(PLAY_ORIGIN_BACKFILL_META_KEY)) return

  const installId = ensureInstallId()
  db.run(`
    INSERT INTO track_play_origins (track_path, origin_id, play_count, last_played_at)
    SELECT path, ?, play_count, last_played_at
    FROM tracks
    WHERE play_count > 0 OR last_played_at IS NOT NULL
    ON CONFLICT(track_path, origin_id) DO UPDATE SET
      play_count = MAX(track_play_origins.play_count, excluded.play_count),
      last_played_at = CASE
        WHEN excluded.last_played_at IS NULL THEN track_play_origins.last_played_at
        WHEN track_play_origins.last_played_at IS NULL THEN excluded.last_played_at
        ELSE MAX(track_play_origins.last_played_at, excluded.last_played_at)
      END
  `, [installId])
  writeAppMetaValue(PLAY_ORIGIN_BACKFILL_META_KEY, '1')
}

/** Records one local play against this install's origin row. */
function recordLocalPlayOrigin(trackPath: string, playedAt: number): void {
  if (!db) return
  db.run(`
    INSERT INTO track_play_origins (track_path, origin_id, play_count, last_played_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(track_path, origin_id) DO UPDATE SET
      play_count = track_play_origins.play_count + 1,
      last_played_at = MAX(COALESCE(track_play_origins.last_played_at, 0), excluded.last_played_at)
  `, [trackPath, ensureInstallId(), playedAt])
}

function qualifyListeningSession(track: DbTrack, sourcePlaylistId: number | null, qualifiedAt: number): void {
  if (!db) return
  db.run(
    'UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE id = ?',
    [qualifiedAt, track.id]
  )
  recordLocalPlayOrigin(track.path, qualifiedAt)
  db.run('INSERT INTO recently_played (track_path, played_at) VALUES (?, ?)', [track.path, qualifiedAt])
  db.run(`
    DELETE FROM recently_played WHERE id NOT IN (
      SELECT id FROM recently_played ORDER BY played_at DESC LIMIT 200
    )
  `)
  if (sourcePlaylistId !== null) {
    db.run('UPDATE playlists SET last_played_at = ? WHERE id = ?', [qualifiedAt, sourcePlaylistId])
  }
}

const LISTENING_QUALIFICATION_SECONDS = 15
const SHORT_TRACK_COMPLETION_TOLERANCE_SECONDS = 0.5
const SHORT_TRACK_COMPLETION_TOLERANCE_RATIO = 0.1

function listeningSessionQualifies(
  checkpoint: ListeningSessionCheckpoint,
  session: { listened_seconds: number; duration_seconds: number }
): boolean {
  if (session.duration_seconds > 0 && session.duration_seconds < LISTENING_QUALIFICATION_SECONDS) {
    if (checkpoint.finalizeSession !== true || checkpoint.completedNaturally !== true) return false

    const toleranceSeconds = Math.min(
      SHORT_TRACK_COMPLETION_TOLERANCE_SECONDS,
      session.duration_seconds * SHORT_TRACK_COMPLETION_TOLERANCE_RATIO
    )
    return session.listened_seconds >= session.duration_seconds - toleranceSeconds
  }

  return session.listened_seconds >= LISTENING_QUALIFICATION_SECONDS
}

export async function checkpointListeningSession(
  checkpoint: ListeningSessionCheckpoint
): Promise<ListeningSessionCheckpointResult> {
  const status = getListeningHistoryStatus()
  if (!db || checkpoint.generation !== status.generation) {
    return { accepted: false, qualifiedNow: false, status }
  }

  const sessionKey = typeof checkpoint.sessionKey === 'string' ? checkpoint.sessionKey.trim() : ''
  const segmentKey = typeof checkpoint.segmentKey === 'string' ? checkpoint.segmentKey.trim() : ''
  const trackPath = typeof checkpoint.trackPath === 'string' ? checkpoint.trackPath.trim() : ''
  if (!sessionKey || !segmentKey || !trackPath) {
    return { accepted: false, qualifiedNow: false, status }
  }

  const track = getTrackByPath(trackPath)
  if (!track) {
    return { accepted: false, qualifiedNow: false, status }
  }

  const now = Date.now()
  const observedAt = finiteTimestamp(checkpoint.observedAt, now)
  const sessionStartedAt = Math.min(observedAt, finiteTimestamp(checkpoint.sessionStartedAt, observedAt))
  const segmentStartedAt = Math.min(observedAt, finiteTimestamp(checkpoint.segmentStartedAt, observedAt))
  const sessionListenedSeconds = finiteNonNegative(checkpoint.sessionListenedSeconds)
  const segmentListenedSeconds = Math.min(
    sessionListenedSeconds,
    finiteNonNegative(checkpoint.segmentListenedSeconds)
  )
  const durationSeconds = finiteNonNegative(checkpoint.trackDurationSeconds || track.duration)
  const sourcePlaylistId = Number.isInteger(checkpoint.sourcePlaylistId) && Number(checkpoint.sourcePlaylistId) > 0
    ? Number(checkpoint.sourcePlaylistId)
    : null
  const sessionEndedAt = checkpoint.finalizeSession ? observedAt : null
  const segmentEndedAt = checkpoint.finalizeSegment || checkpoint.finalizeSession ? observedAt : null
  let qualifiedNow = false

  beginLibraryWriteTransaction()
  try {
    if (sessionListenedSeconds > 0 && readListeningHistoryStartedAt() === null) {
      writeAppMetaValue(LISTENING_HISTORY_STARTED_AT_META_KEY, String(segmentStartedAt), observedAt)
    }

    db.run(
      `INSERT INTO listening_sessions (
         generation, session_key, track_id, track_path, title, artist, album, album_artist,
         album_identity_key, artwork_hash, source_type, duration_seconds, source_playlist_id,
         started_at, ended_at, listened_seconds, qualified_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(generation, session_key) DO UPDATE SET
         track_id = excluded.track_id,
         duration_seconds = MAX(listening_sessions.duration_seconds, excluded.duration_seconds),
         source_playlist_id = COALESCE(listening_sessions.source_playlist_id, excluded.source_playlist_id),
         ended_at = CASE
           WHEN excluded.ended_at IS NULL THEN listening_sessions.ended_at
           WHEN listening_sessions.ended_at IS NULL THEN excluded.ended_at
           ELSE MAX(listening_sessions.ended_at, excluded.ended_at)
         END,
         listened_seconds = MAX(listening_sessions.listened_seconds, excluded.listened_seconds)`,
      [
        status.generation,
        sessionKey,
        track.id,
        track.path,
        track.title,
        track.artist,
        track.album,
        track.album_artist,
        track.album_identity_key ?? `${normalizeKey(track.album_artist ?? track.artist)}\u0000${normalizeKey(track.album)}`,
        track.artwork_hash,
        track.source_type,
        durationSeconds,
        sourcePlaylistId,
        sessionStartedAt,
        sessionEndedAt,
        sessionListenedSeconds
      ]
    )

    const session = db.get<{ id: number; qualified_at: number | null; listened_seconds: number; duration_seconds: number }>(
      'SELECT id, qualified_at, listened_seconds, duration_seconds FROM listening_sessions WHERE generation = ? AND session_key = ?',
      [status.generation, sessionKey]
    )
    if (!session) throw new Error('Failed to persist listening session.')

    db.run(
      `INSERT INTO listening_segments (
         session_id, segment_key, started_at, last_observed_at, ended_at, listened_seconds
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, segment_key) DO UPDATE SET
         last_observed_at = MAX(listening_segments.last_observed_at, excluded.last_observed_at),
         ended_at = CASE
           WHEN excluded.ended_at IS NULL THEN listening_segments.ended_at
           WHEN listening_segments.ended_at IS NULL THEN excluded.ended_at
           ELSE MAX(listening_segments.ended_at, excluded.ended_at)
         END,
         listened_seconds = MAX(listening_segments.listened_seconds, excluded.listened_seconds)`,
      [session.id, segmentKey, segmentStartedAt, observedAt, segmentEndedAt, segmentListenedSeconds]
    )

    if (
      checkpoint.qualificationEligible !== false
      && session.qualified_at === null
      && listeningSessionQualifies(checkpoint, session)
    ) {
      const qualification = db.run(
        'UPDATE listening_sessions SET qualified_at = ? WHERE id = ? AND qualified_at IS NULL',
        [observedAt, session.id]
      )
      if (qualification.changes > 0) {
        qualifiedNow = true
        qualifyListeningSession(track, sourcePlaylistId, observedAt)
      }
    }

    commitLibraryWriteTransaction()
  } catch (error) {
    rollbackLibraryWriteTransaction()
    throw error
  }

  await saveDatabase()
  return {
    accepted: true,
    qualifiedNow,
    status: getListeningHistoryStatus()
  }
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function addLocalDays(timestamp: number, days: number): number {
  const date = new Date(timestamp)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

function addLocalMonths(timestamp: number, months: number): number {
  const date = new Date(timestamp)
  date.setMonth(date.getMonth() + months)
  return date.getTime()
}

function startOfLocalMonth(timestamp: number): number {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
}

const shortBucketDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const monthBucketDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' })

function normalizeListeningStatsRange(value: unknown): ListeningStatsRange {
  return value === '7d' || value === '1y' || value === 'all' ? value : '30d'
}

function normalizeListeningStatsRankingMetric(value: unknown): ListeningStatsRankingMetric {
  return value === 'time' ? 'time' : 'plays'
}

function getListeningStatsRangeStart(range: ListeningStatsRange, now: number, baseline: number | null): number | null {
  if (range === 'all') return baseline
  const today = startOfLocalDay(now)
  if (range === '7d') return addLocalDays(today, -6)
  if (range === '1y') return addLocalDays(today, -364)
  return addLocalDays(today, -29)
}

function buildListeningActivityBuckets(
  range: ListeningStatsRange,
  rangeStartAt: number | null,
  now: number
): { granularity: ListeningStatsBucketGranularity; buckets: ListeningStatsActivityBucket[] } {
  if (rangeStartAt === null) {
    return { granularity: range === 'all' ? 'month' : range === '1y' ? 'week' : 'day', buckets: [] }
  }

  const buckets: ListeningStatsActivityBucket[] = []
  if (range === '7d' || range === '30d') {
    let cursor = startOfLocalDay(rangeStartAt)
    while (cursor <= now) {
      const endAt = addLocalDays(cursor, 1)
      buckets.push({
        startAt: cursor,
        endAt,
        label: shortBucketDateFormatter.format(cursor),
        listenedSeconds: 0,
        qualifiedPlays: 0
      })
      cursor = endAt
    }
    return { granularity: 'day', buckets }
  }

  if (range === '1y') {
    let cursor = startOfLocalDay(rangeStartAt)
    while (cursor <= now) {
      const endAt = addLocalDays(cursor, 7)
      buckets.push({
        startAt: cursor,
        endAt,
        label: shortBucketDateFormatter.format(cursor),
        listenedSeconds: 0,
        qualifiedPlays: 0
      })
      cursor = endAt
    }
    return { granularity: 'week', buckets }
  }

  let cursor = startOfLocalMonth(rangeStartAt)
  while (cursor <= now) {
    const endAt = addLocalMonths(cursor, 1)
    buckets.push({
      startAt: cursor,
      endAt,
      label: monthBucketDateFormatter.format(cursor),
      listenedSeconds: 0,
      qualifiedPlays: 0
    })
    cursor = endAt
  }
  return { granularity: 'month', buckets }
}

function getSegmentOverlapSeconds(
  segment: ListeningSegmentRow,
  startAt: number,
  endAt: number
): number {
  const segmentStart = Number(segment.started_at)
  const segmentEnd = Math.max(segmentStart, Number(segment.last_observed_at))
  const listenedSeconds = finiteNonNegative(segment.listened_seconds)
  if (listenedSeconds <= 0 || segmentEnd <= startAt || segmentStart >= endAt) return 0

  const wallDurationMs = segmentEnd - segmentStart
  if (wallDurationMs <= 0) {
    return segmentStart >= startAt && segmentStart < endAt ? listenedSeconds : 0
  }
  const overlapMs = Math.max(0, Math.min(segmentEnd, endAt) - Math.max(segmentStart, startAt))
  return listenedSeconds * Math.min(1, overlapMs / wallDurationMs)
}

function resolveListeningIdentity(
  session: ListeningSessionRow,
  artistBrowseMode: ArtistBrowseMode
): ListeningIdentity {
  const available = session.current_path !== null && session.current_is_available === 1
  const title = session.current_title?.trim() || session.title
  const artist = session.current_artist?.trim() || session.artist
  const album = session.current_album?.trim() || session.album
  const currentAlbumArtist = session.current_album_artist?.trim() || session.album_artist?.trim() || null
  const albumArtist = currentAlbumArtist || artist
  const artistTrack = {
    artist,
    album_artist: currentAlbumArtist,
    artist_names_json: session.current_artist_names_json,
    album_artist_names_json: session.current_album_artist_names_json
  }
  const browseArtists = artistBrowseMode === 'strict'
    ? [resolveStrictBrowseArtist(artistTrack)]
    : getCanonicalArtistIndexNames(artistTrack)
  const snapshotKey = `${normalizeKey(session.artist)}\u0000${normalizeKey(session.album)}\u0000${normalizeKey(session.title)}`
  return {
    trackKey: session.track_id !== null ? `track:${session.track_id}` : `snapshot:${snapshotKey}`,
    trackPath: available ? session.current_path : null,
    title,
    artist,
    browseArtists,
    album,
    albumKey: session.album_identity_key || `${normalizeKey(albumArtist)}\u0000${normalizeKey(album)}`,
    artworkHash: session.current_artwork_hash?.trim() || session.artwork_hash,
    available
  }
}

function compareListeningAggregate(
  left: ListeningAggregate & { label: string },
  right: ListeningAggregate & { label: string },
  metric: ListeningStatsRankingMetric
): number {
  const primary = metric === 'time'
    ? right.listenedSeconds - left.listenedSeconds
    : right.qualifiedPlays - left.qualifiedPlays
  if (primary !== 0) return primary
  const secondary = metric === 'time'
    ? right.qualifiedPlays - left.qualifiedPlays
    : right.listenedSeconds - left.listenedSeconds
  if (secondary !== 0) return secondary
  return left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
}

export function getListeningStatsDashboard(query: ListeningStatsQuery): ListeningStatsDashboard {
  const status = getListeningHistoryStatus()
  const range = normalizeListeningStatsRange(query?.range)
  const rankingMetric = normalizeListeningStatsRankingMetric(query?.rankingMetric)
  const artistBrowseMode = normalizeArtistBrowseMode(query?.artistBrowseMode)
  const now = finiteTimestamp(query?.now, Date.now())
  const rangeStartAt = getListeningStatsRangeStart(range, now, status.startedAt)
  const bucketResult = buildListeningActivityBuckets(range, rangeStartAt, now)
  const empty: ListeningStatsDashboard = {
    status,
    range,
    rankingMetric,
    rangeStartAt,
    rangeEndAt: now,
    granularity: bucketResult.granularity,
    summary: { listenedSeconds: 0, qualifiedPlays: 0, tracksPlayed: 0, activeDays: 0 },
    activity: bucketResult.buckets,
    topTracks: [],
    topArtists: [],
    topAlbums: []
  }
  if (!db || rangeStartAt === null) return empty

  const sessions = db.all<ListeningSessionRow>(`
    SELECT
      s.id,
      s.track_id,
      s.track_path,
      s.title,
      s.artist,
      s.album,
      s.album_artist,
      s.album_identity_key,
      s.artwork_hash,
      s.source_type,
      s.started_at,
      s.ended_at,
      s.listened_seconds,
      s.qualified_at,
      t.path AS current_path,
      COALESCE(o.title, t.title) AS current_title,
      COALESCE(o.artist, t.artist) AS current_artist,
      CASE
        WHEN o.artist IS NULL THEN t.artist_names_json
        ELSE NULL
      END AS current_artist_names_json,
      COALESCE(o.album, t.album) AS current_album,
      COALESCE(o.album_artist, t.album_artist) AS current_album_artist,
      CASE
        WHEN o.album_artist IS NULL THEN t.album_artist_names_json
        ELSE NULL
      END AS current_album_artist_names_json,
      CASE WHEN o.artwork_cleared = 1 THEN NULL ELSE COALESCE(o.artwork_hash, t.artwork_hash) END AS current_artwork_hash,
      t.is_available AS current_is_available
    FROM listening_sessions s
    LEFT JOIN tracks t ON t.id = s.track_id
    LEFT JOIN track_metadata_overrides o ON o.track_path = t.path
    WHERE s.generation = ?
      AND (
        (s.started_at <= ? AND COALESCE(s.ended_at, ?) >= ?)
        OR (s.qualified_at >= ? AND s.qualified_at <= ?)
      )
  `, [status.generation, now, now, rangeStartAt, rangeStartAt, now])
  if (sessions.length === 0) return empty

  const sessionIds = sessions.map((session) => session.id)
  const segments: ListeningSegmentRow[] = []
  for (let offset = 0; offset < sessionIds.length; offset += SQLITE_SAFE_MAX_VARIABLES) {
    const chunk = sessionIds.slice(offset, offset + SQLITE_SAFE_MAX_VARIABLES)
    const placeholders = chunk.map(() => '?').join(', ')
    segments.push(...db.all<ListeningSegmentRow>(`
      SELECT session_id, started_at, last_observed_at, listened_seconds
      FROM listening_segments
      WHERE session_id IN (${placeholders})
        AND last_observed_at >= ?
        AND started_at <= ?
    `, [...chunk, rangeStartAt, now]))
  }

  const sessionsById = new Map(sessions.map((session) => [session.id, session]))
  const trackAggregates = new Map<string, ListeningStatsRankedTrack>()
  const artistAggregates = new Map<string, ListeningStatsRankedArtist>()
  const albumAggregates = new Map<string, ListeningStatsRankedAlbum>()
  const tracksPlayed = new Set<string>()
  const activeDays = new Set<number>()
  let listenedSeconds = 0
  let qualifiedPlays = 0

  const ensureAggregates = (identity: ListeningIdentity) => {
    let track = trackAggregates.get(identity.trackKey)
    if (!track) {
      track = {
        key: identity.trackKey,
        trackPath: identity.trackPath,
        title: identity.title,
        artist: identity.artist,
        album: identity.album,
        artworkHash: identity.artworkHash,
        listenedSeconds: 0,
        qualifiedPlays: 0,
        available: identity.available
      }
      trackAggregates.set(identity.trackKey, track)
    }

    const artists: ListeningStatsRankedArtist[] = []
    for (const browseArtist of identity.browseArtists) {
      const artistKey = normalizeKey(browseArtist) || browseArtist
      let artist = artistAggregates.get(artistKey)
      if (!artist) {
        artist = {
          key: artistKey,
          artist: browseArtist,
          artworkHash: identity.artworkHash,
          listenedSeconds: 0,
          qualifiedPlays: 0,
          available: identity.available
        }
        artistAggregates.set(artistKey, artist)
      } else {
        artist.available ||= identity.available
        artist.artworkHash ||= identity.artworkHash
      }
      artists.push(artist)
    }

    let album = albumAggregates.get(identity.albumKey)
    if (!album) {
      album = {
        key: identity.albumKey,
        album: identity.album,
        artist: identity.artist,
        artworkHash: identity.artworkHash,
        listenedSeconds: 0,
        qualifiedPlays: 0,
        available: identity.available
      }
      albumAggregates.set(identity.albumKey, album)
    } else {
      album.available ||= identity.available
      album.artworkHash ||= identity.artworkHash
    }
    return { track, artists, album }
  }

  for (const segment of segments) {
    const session = sessionsById.get(segment.session_id)
    if (!session) continue
    const overlapSeconds = getSegmentOverlapSeconds(segment, rangeStartAt, now + 1)
    if (overlapSeconds <= 0) continue
    const identity = resolveListeningIdentity(session, artistBrowseMode)
    const aggregates = ensureAggregates(identity)
    aggregates.track.listenedSeconds += overlapSeconds
    for (const artist of aggregates.artists) {
      artist.listenedSeconds += overlapSeconds
    }
    aggregates.album.listenedSeconds += overlapSeconds
    tracksPlayed.add(identity.trackKey)
    listenedSeconds += overlapSeconds

    for (const bucket of bucketResult.buckets) {
      bucket.listenedSeconds += getSegmentOverlapSeconds(segment, bucket.startAt, Math.min(bucket.endAt, now + 1))
    }
    let dayCursor = startOfLocalDay(Math.max(segment.started_at, rangeStartAt))
    const dayEnd = Math.min(segment.last_observed_at, now)
    while (dayCursor <= dayEnd) {
      const nextDay = addLocalDays(dayCursor, 1)
      if (getSegmentOverlapSeconds(segment, dayCursor, nextDay) > 0) activeDays.add(dayCursor)
      dayCursor = nextDay
    }
  }

  for (const session of sessions) {
    if (session.qualified_at === null || session.qualified_at < rangeStartAt || session.qualified_at > now) continue
    const identity = resolveListeningIdentity(session, artistBrowseMode)
    const aggregates = ensureAggregates(identity)
    aggregates.track.qualifiedPlays += 1
    for (const artist of aggregates.artists) {
      artist.qualifiedPlays += 1
    }
    aggregates.album.qualifiedPlays += 1
    qualifiedPlays += 1
    const bucket = bucketResult.buckets.find((candidate) => (
      session.qualified_at !== null
      && session.qualified_at >= candidate.startAt
      && session.qualified_at < candidate.endAt
    ))
    if (bucket) bucket.qualifiedPlays += 1
  }

  const topTracks = Array.from(trackAggregates.values())
    .sort((left, right) => compareListeningAggregate(
      { ...left, label: `${left.title}\u0000${left.artist}` },
      { ...right, label: `${right.title}\u0000${right.artist}` },
      rankingMetric
    ))
    .slice(0, LISTENING_STATS_TOP_LIMIT)
  const topArtists = Array.from(artistAggregates.values())
    .sort((left, right) => compareListeningAggregate(
      { ...left, label: left.artist },
      { ...right, label: right.artist },
      rankingMetric
    ))
    .slice(0, LISTENING_STATS_TOP_LIMIT)
  const topAlbums = Array.from(albumAggregates.values())
    .sort((left, right) => compareListeningAggregate(
      { ...left, label: `${left.album}\u0000${left.artist}` },
      { ...right, label: `${right.album}\u0000${right.artist}` },
      rankingMetric
    ))
    .slice(0, LISTENING_STATS_TOP_LIMIT)

  return {
    ...empty,
    summary: {
      listenedSeconds,
      qualifiedPlays,
      tracksPlayed: tracksPlayed.size,
      activeDays: activeDays.size
    },
    activity: bucketResult.buckets,
    topTracks,
    topArtists,
    topAlbums
  }
}

export async function clearDetailedListeningHistory(): Promise<ListeningHistoryStatus> {
  if (!db) return { generation: randomUUID(), startedAt: null }
  const generation = randomUUID()
  beginLibraryWriteTransaction()
  try {
    db.run('DELETE FROM listening_segments')
    db.run('DELETE FROM listening_sessions')
    db.run('DELETE FROM app_meta WHERE key = ?', [LISTENING_HISTORY_STARTED_AT_META_KEY])
    writeAppMetaValue(LISTENING_HISTORY_GENERATION_META_KEY, generation)
    commitLibraryWriteTransaction()
  } catch (error) {
    rollbackLibraryWriteTransaction()
    throw error
  }
  await saveDatabase()
  return { generation, startedAt: null }
}

// ── Listening stats transfer ─────────────────────────────
//
// Serializes play counts, ratings, favorites and detailed listening history so they can
// ride inside the settings transfer file, and merges them back on another install. Track
// paths never match across machines, so every row travels with its metadata identity and
// is re-resolved locally through the same matcher playlist import uses.
//
// Import is merge-only: the larger value always wins, so a mistaken import can never
// destroy local stats. See shared/stats/statsTransfer.ts for the wire format.

/**
 * A backstop against pathological data rather than a real ceiling: settings exports have
 * their own generous write limit, and at roughly 300 bytes per session this is far more
 * history than continuous listening could produce in a lifetime.
 */
export const DEFAULT_LISTENING_HISTORY_EXPORT_MAX_SESSIONS = 500_000

export function getListeningStatsTransferAvailability(): ListeningStatsTransferAvailability {
  if (!db) return { hasHistory: false, sessionCount: 0 }
  const generation = ensureListeningHistoryGeneration()
  const row = db.get<{ count?: unknown }>(
    'SELECT COUNT(*) AS count FROM listening_sessions WHERE generation = ?',
    [generation]
  )
  const sessionCount = Number(row?.count) || 0
  return { hasHistory: sessionCount > 0, sessionCount }
}

export function exportListeningStatsTransfer(
  request: ListeningStatsExportRequest = {}
): ListeningStatsExportBundle {
  const emptyCounts: ListeningCountsPayload = {
    v: LISTENING_STATS_TRANSFER_VERSION,
    tracks: [],
    origins: [],
    plays: [],
    ratings: [],
    favorites: []
  }
  if (!db) {
    return {
      counts: {
        encoded: encodeListeningCountsPayload(emptyCounts),
        trackCount: 0,
        playCount: 0,
        ratingCount: 0,
        favoriteCount: 0
      },
      history: null
    }
  }

  const countsDictionary = createStatsTransferTrackDictionary()
  const plays: StatsTransferPlayTuple[] = []
  const ratings: StatsTransferRatingTuple[] = []
  const favorites: StatsTransferFavoriteTuple[] = []

  // Exported per originating install, not as a single total, so the receiving library can
  // add this machine's plays to its own without either side being counted twice.
  const originIds: string[] = []
  const originIndexById = new Map<string, number>()
  const originIndexOf = (originId: string): number => {
    const existing = originIndexById.get(originId)
    if (existing !== undefined) return existing
    const index = originIds.length
    originIds.push(originId)
    originIndexById.set(originId, index)
    return index
  }

  for (const row of db.all<Record<string, unknown>>(`
    SELECT o.track_path AS path, o.origin_id, o.play_count, o.last_played_at,
           t.title, t.artist, t.album, t.album_artist
    FROM ${PLAY_ORIGIN_TABLE} o
    LEFT JOIN tracks t ON t.path = o.track_path
    WHERE o.play_count > 0 OR o.last_played_at IS NOT NULL
  `)) {
    const path = typeof row.path === 'string' ? row.path : ''
    const originId = typeof row.origin_id === 'string' ? row.origin_id : ''
    if (!path || !originId) continue
    const lastPlayedAt = row.last_played_at === null ? null : Number(row.last_played_at) || null
    plays.push([
      countsDictionary.indexOf(identityFromRow(row)),
      originIndexOf(originId),
      Math.max(0, Math.trunc(Number(row.play_count) || 0)),
      lastPlayedAt
    ])
  }

  // LEFT JOIN, not INNER: track_ratings and favorites deliberately have no foreign key and
  // no delete trigger so they survive a remote resync, which means they legitimately hold
  // paths with no track row. Those export with path-only identity and re-match on the same
  // machine via the exact-path fast path.
  for (const row of db.all<Record<string, unknown>>(`
    SELECT r.track_path AS path, r.rating, r.updated_at,
           t.title, t.artist, t.album, t.album_artist
    FROM track_ratings r
    LEFT JOIN tracks t ON t.path = r.track_path
  `)) {
    const path = typeof row.path === 'string' ? row.path : ''
    if (!path) continue
    const rating = normalizeTrackRating(row.rating)
    if (rating === null) continue
    ratings.push([countsDictionary.indexOf(identityFromRow(row)), rating, Number(row.updated_at) || 0])
  }

  for (const row of db.all<Record<string, unknown>>(`
    SELECT f.track_path AS path, f.added_at,
           t.title, t.artist, t.album, t.album_artist
    FROM favorites f
    LEFT JOIN tracks t ON t.path = f.track_path
  `)) {
    const path = typeof row.path === 'string' ? row.path : ''
    if (!path) continue
    favorites.push([countsDictionary.indexOf(identityFromRow(row)), Number(row.added_at) || 0])
  }

  const counts: ListeningCountsPayload = {
    v: LISTENING_STATS_TRANSFER_VERSION,
    tracks: countsDictionary.tuples(),
    origins: originIds,
    plays,
    ratings,
    favorites
  }

  const bundle: ListeningStatsExportBundle = {
    counts: {
      encoded: encodeListeningCountsPayload(counts),
      trackCount: countsDictionary.size(),
      playCount: plays.length,
      ratingCount: ratings.length,
      favoriteCount: favorites.length
    },
    history: null
  }

  if (request.includeHistory !== true) return bundle

  const generation = ensureListeningHistoryGeneration()
  const maxSessions = Number.isFinite(Number(request.maxSessions)) && Number(request.maxSessions) > 0
    ? Math.trunc(Number(request.maxSessions))
    : DEFAULT_LISTENING_HISTORY_EXPORT_MAX_SESSIONS
  const sessionsTotal = Number(db.get<{ count?: unknown }>(
    'SELECT COUNT(*) AS count FROM listening_sessions WHERE generation = ?',
    [generation]
  )?.count) || 0

  const historyDictionary = createStatsTransferTrackDictionary()
  const sessions: StatsTransferSessionTuple[] = []
  const sessionIndexById = new Map<number, number>()

  for (const row of db.all<Record<string, unknown>>(`
    SELECT id, session_key, track_path, title, artist, album, album_artist,
           source_type, duration_seconds, started_at, ended_at, listened_seconds, qualified_at
    FROM listening_sessions
    WHERE generation = ?
    ORDER BY started_at DESC, id DESC
    LIMIT ?
  `, [generation, maxSessions])) {
    const sessionId = Number(row.id)
    const sessionKey = typeof row.session_key === 'string' ? row.session_key : ''
    if (!Number.isInteger(sessionId) || !sessionKey) continue

    sessionIndexById.set(sessionId, sessions.length)
    sessions.push([
      historyDictionary.indexOf({
        ...trackPathHashes(typeof row.track_path === 'string' ? row.track_path : ''),
        title: typeof row.title === 'string' ? row.title : '',
        artist: typeof row.artist === 'string' ? row.artist : '',
        album: typeof row.album === 'string' ? row.album : '',
        albumArtist: typeof row.album_artist === 'string' ? row.album_artist : ''
      }),
      sessionKey,
      typeof row.source_type === 'string' ? row.source_type : 'local',
      finiteNonNegative(row.duration_seconds),
      Number(row.started_at) || 0,
      row.ended_at === null ? null : Number(row.ended_at) || null,
      finiteNonNegative(row.listened_seconds),
      row.qualified_at === null ? null : Number(row.qualified_at) || null
    ])
  }

  const segments: StatsTransferSegmentTuple[] = []
  const sessionIds = Array.from(sessionIndexById.keys())
  for (let offset = 0; offset < sessionIds.length; offset += SQLITE_SAFE_MAX_VARIABLES) {
    const chunk = sessionIds.slice(offset, offset + SQLITE_SAFE_MAX_VARIABLES)
    const placeholders = chunk.map(() => '?').join(', ')
    for (const row of db.all<Record<string, unknown>>(`
      SELECT session_id, segment_key, started_at, last_observed_at, ended_at, listened_seconds
      FROM listening_segments
      WHERE session_id IN (${placeholders})
    `, chunk)) {
      const sessionIndex = sessionIndexById.get(Number(row.session_id))
      const segmentKey = typeof row.segment_key === 'string' ? row.segment_key : ''
      if (sessionIndex === undefined || !segmentKey) continue
      segments.push([
        sessionIndex,
        segmentKey,
        Number(row.started_at) || 0,
        Number(row.last_observed_at) || 0,
        row.ended_at === null ? null : Number(row.ended_at) || null,
        finiteNonNegative(row.listened_seconds)
      ])
    }
  }

  bundle.history = {
    encoded: encodeListeningHistoryPayload({
      v: LISTENING_STATS_TRANSFER_VERSION,
      historyStartedAt: readListeningHistoryStartedAt(),
      sessionsTotal,
      truncated: sessionsTotal > sessions.length,
      tracks: historyDictionary.tuples(),
      sessions,
      segments
    }),
    sessionCount: sessions.length,
    segmentCount: segments.length,
    sessionsTotal,
    truncated: sessionsTotal > sessions.length
  }

  return bundle
}

/**
 * A short digest of a track path, for same-machine matching without disclosing the path.
 * Truncated to 16 hex chars: collisions within one library are negligible, and a miss just
 * falls through to the metadata tiers, which is what a different machine does anyway.
 */
function hashTrackPathForTransfer(trackPath: string): string {
  if (!trackPath) return ''
  return createHash('sha256').update(trackPath).digest('hex').slice(0, 16)
}

function trackPathHashes(trackPath: string): { pathHash: string; pathFoldHash: string } {
  const normalized = trackPath ? normalizePlaylistPathForLookup(trackPath) : ''
  if (!normalized) return { pathHash: '', pathFoldHash: '' }
  return {
    pathHash: hashTrackPathForTransfer(normalized),
    pathFoldHash: hashTrackPathForTransfer(normalized.toLocaleLowerCase())
  }
}

function identityFromRow(row: Record<string, unknown>): StatsTransferTrackIdentity {
  const path = typeof row.path === 'string' ? row.path : ''
  return {
    ...trackPathHashes(path),
    title: typeof row.title === 'string' ? row.title : '',
    artist: typeof row.artist === 'string' ? row.artist : '',
    album: typeof row.album === 'string' ? row.album : '',
    albumArtist: typeof row.album_artist === 'string' ? row.album_artist : ''
  }
}

// Joins the fields of a track tuple into one comparable identity key.
const STATS_TRANSFER_IDENTITY_SEPARATOR = '\u001f'

interface StatsTransferResolution {
  trackPath: string | null
  ambiguous: boolean
}

interface StatsTransferResolver {
  resolve: (tuple: StatsTransferTrackTuple) => StatsTransferResolution
  /** Every distinct identity resolved so far, for the import summary. */
  resolutions: () => StatsTransferResolution[]
  rowByPath: Map<string, DbTrackRow>
  albumIdentityKeyByPath: ReadonlyMap<string, string>
}

/**
 * One full-table read feeding the metadata matcher, a path lookup, and the album identity
 * keys. `createTrackMetadataMatcher()` would do the same work but force a second read.
 */
function buildStatsTransferTrackResolver(): StatsTransferResolver {
  const rows = readAllTrackRowsUnordered()
  const lookup = buildPlaylistImportLookupIndex(rows)
  const rowByPath = new Map<string, DbTrackRow>()
  // Local path digests, so a file exported from this same install matches exactly. A file
  // from another machine misses here by definition and resolves on metadata instead.
  const pathByHash = new Map<string, string>()
  const pathByFoldHash = new Map<string, string | null>()
  for (const row of rows) {
    rowByPath.set(row.path, row)
    const { pathHash, pathFoldHash } = trackPathHashes(row.path)
    if (pathHash) pathByHash.set(pathHash, row.path)
    if (pathFoldHash) {
      // null marks an ambiguous digest, mirroring buildPlaylistImportLookupIndex: on a
      // case-sensitive filesystem two files can differ only in case.
      pathByFoldHash.set(pathFoldHash, pathByFoldHash.has(pathFoldHash) ? null : row.path)
    }
  }

  const cache = new Map<StatsTransferTrackTuple, StatsTransferResolution>()

  return {
    rowByPath,
    albumIdentityKeyByPath: buildAlbumIdentityKeysByPath(rows),
    resolutions() {
      // Deduped by identity, not by tuple object: the counts and history payloads carry
      // separate dictionaries, so a track appearing in both would otherwise be reported to
      // the user twice ("4 of 6 tracks matched" for three songs).
      const byIdentity = new Map<string, StatsTransferResolution>()
      for (const [tuple, resolution] of cache) {
        byIdentity.set(tuple.join(STATS_TRANSFER_IDENTITY_SEPARATOR), resolution)
      }
      return Array.from(byIdentity.values())
    },
    resolve(tuple) {
      const cached = cache.get(tuple)
      if (cached) return cached

      let resolution: StatsTransferResolution = { trackPath: null, ambiguous: false }
      const [pathHash, pathFoldHash, title, artist, album] = tuple

      if (pathHash) {
        const exact = pathByHash.get(pathHash)
        if (exact) resolution = { trackPath: exact, ambiguous: false }
      }
      if (!resolution.trackPath && pathFoldHash) {
        const folded = pathByFoldHash.get(pathFoldHash)
        if (typeof folded === 'string') resolution = { trackPath: folded, ambiguous: false }
      }

      // The cross-machine path: paths never line up between installs, so metadata is what
      // actually resolves these rows against whatever this library happens to hold.
      if (!resolution.trackPath) {
        const match = matchPlaylistEntryByMetadata({ title, artist, album }, lookup)
        if (match.kind === 'matched') {
          resolution = { trackPath: match.trackPath, ambiguous: false }
        } else if (match.kind === 'ambiguous') {
          resolution = { trackPath: null, ambiguous: true }
        }
      }

      cache.set(tuple, resolution)
      return resolution
    }
  }
}

// ── External listening imports ───────────────────────────
//
// Data from outside Astra (a Last.fm history, another player) arrives in the public format
// in shared/stats/listeningImportFile.ts and is translated here into the internal payloads.
// The translation is where provenance is enforced rather than trusted: the file supplies the
// listening data, Astra supplies the origin id, the source type and the session-key prefix.
// A file therefore cannot attribute plays to another install, and cannot collide with a
// session this machine recorded itself.

export async function applyExternalListeningImport(
  file: ListeningImportFile
): Promise<ListeningStatsImportResult> {
  if (!db) return createEmptyListeningStatsImportResult()

  const originId = importOriginId(file.source)
  const sourceType = originId

  // External data has no local paths, so both digest slots are empty and every row resolves
  // through the metadata tiers — the same route data from another machine takes.
  const tracks: StatsTransferTrackTuple[] = file.tracks.map(
    ([title, artist, album, albumArtist]) => ['', '', title, artist, album, albumArtist]
  )

  const counts: ListeningCountsPayload = {
    v: LISTENING_STATS_TRANSFER_VERSION,
    tracks,
    origins: [originId],
    plays: file.plays.map(([trackIndex, playCount, lastPlayedAt]) => [
      trackIndex, 0, playCount, lastPlayedAt
    ]),
    // Ratings and favorites remain exclusive to Astra-to-Astra settings transfer. External
    // listening imports carry only data that can be removed cleanly by source.
    ratings: [],
    favorites: []
  }

  const sessions: StatsTransferSessionTuple[] = []
  const segments: StatsTransferSegmentTuple[] = []
  let historyStartedAt: number | null = null
  file.events.forEach(([trackIndex, playKey, startedAt, endedAt, listenedSeconds, countsAsPlay], index) => {
    const resolvedEnd = endedAt ?? startedAt + Math.round(listenedSeconds * 1000)
    historyStartedAt = historyStartedAt === null
      ? startedAt
      : Math.min(historyStartedAt, startedAt)
    sessions.push([
      trackIndex,
      importSessionKey(file.source, playKey),
      sourceType,
      listenedSeconds,
      startedAt,
      resolvedEnd,
      listenedSeconds,
      // qualified_at is what makes a listen count as a play on the Stats page.
      countsAsPlay ? startedAt : null
    ])
    // One segment per listen. Without it the listen contributes a play but no listening
    // time, because every time figure on the dashboard is computed from segments.
    segments.push([index, `${playKey}:s`, startedAt, resolvedEnd, resolvedEnd, listenedSeconds])
  })

  const history: ListeningHistoryPayload = {
    v: LISTENING_STATS_TRANSFER_VERSION,
    historyStartedAt,
    sessionsTotal: sessions.length,
    truncated: false,
    tracks,
    sessions,
    segments
  }

  const result = await applyListeningStatsTransfer({
    counts: encodeListeningCountsPayload(counts),
    history: sessions.length > 0 ? encodeListeningHistoryPayload(history) : undefined
  })

  recordListeningImportSource(file.source, file.generator)
  await saveDatabase()
  return result
}

const LISTENING_IMPORT_SOURCES_META_KEY = 'listening_import_sources_v1'

interface ListeningImportSourceRecord {
  source: string
  generator: string
  importedAt: number
}

function readListeningImportSourceRecords(): ListeningImportSourceRecord[] {
  const raw = getAppMeta(LISTENING_IMPORT_SOURCES_META_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is ListeningImportSourceRecord => (
        Boolean(entry) && typeof entry === 'object' && typeof entry.source === 'string'
      ))
      .map((entry) => ({
        source: entry.source,
        generator: typeof entry.generator === 'string' ? entry.generator : '',
        importedAt: Number(entry.importedAt) || 0
      }))
  } catch {
    return []
  }
}

function recordListeningImportSource(source: string, generator: string): void {
  const records = readListeningImportSourceRecords().filter((entry) => entry.source !== source)
  records.push({ source, generator, importedAt: Date.now() })
  writeAppMetaValue(LISTENING_IMPORT_SOURCES_META_KEY, JSON.stringify(records))
}

export function getImportedListeningSources(): ImportedListeningSource[] {
  if (!db) return []
  const records = new Map(readListeningImportSourceRecords().map((entry) => [entry.source, entry]))
  const generation = ensureListeningHistoryGeneration()
  const sources = new Map<string, ImportedListeningSource>()

  const ensure = (source: string): ImportedListeningSource => {
    let entry = sources.get(source)
    if (!entry) {
      const record = records.get(source)
      entry = {
        source,
        generator: record?.generator ?? '',
        importedAt: record?.importedAt ?? 0,
        sessionCount: 0,
        trackCount: 0,
        playCount: 0
      }
      sources.set(source, entry)
    }
    return entry
  }

  for (const row of db.all<{ source_type?: unknown; count?: unknown }>(`
    SELECT source_type, COUNT(*) AS count
    FROM listening_sessions
    WHERE generation = ? AND source_type LIKE 'import:%'
    GROUP BY source_type
  `, [generation])) {
    const sourceType = typeof row.source_type === 'string' ? row.source_type : ''
    if (!sourceType.startsWith('import:')) continue
    ensure(sourceType.slice('import:'.length)).sessionCount = Number(row.count) || 0
  }

  for (const row of db.all<{ origin_id?: unknown; tracks?: unknown; plays?: unknown }>(`
    SELECT origin_id, COUNT(*) AS tracks, SUM(play_count) AS plays
    FROM ${PLAY_ORIGIN_TABLE}
    WHERE origin_id LIKE 'import:%'
    GROUP BY origin_id
  `)) {
    const originId = typeof row.origin_id === 'string' ? row.origin_id : ''
    if (!originId.startsWith('import:')) continue
    const entry = ensure(originId.slice('import:'.length))
    entry.trackCount = Number(row.tracks) || 0
    entry.playCount = Number(row.plays) || 0
  }

  return Array.from(sources.values()).sort((a, b) => b.importedAt - a.importedAt)
}

/**
 * Removes the play counts and sessions contributed by one external source. Third-party
 * imports do not carry ratings or favorites, so no unrelated library state is involved.
 */
export async function removeImportedListeningSource(source: string): Promise<ImportedListeningSourceRemoval> {
  const removal: ImportedListeningSourceRemoval = { source, sessionsRemoved: 0, tracksAffected: 0 }
  if (!db || !isValidImportSource(source)) return removal

  const originId = importOriginId(source)
  const affectedPaths = new Set<string>()
  for (const row of db.all<{ track_path?: unknown }>(
    `SELECT track_path FROM ${PLAY_ORIGIN_TABLE} WHERE origin_id = ?`,
    [originId]
  )) {
    if (typeof row.track_path === 'string') affectedPaths.add(row.track_path)
  }

  beginLibraryWriteTransaction()
  try {
    // Segments are ON DELETE CASCADE from sessions, but the pragma is not guaranteed on
    // every connection, so they are removed explicitly first.
    db.run(`
      DELETE FROM listening_segments
      WHERE session_id IN (SELECT id FROM listening_sessions WHERE source_type = ?)
    `, [originId])
    const sessions = db.run('DELETE FROM listening_sessions WHERE source_type = ?', [originId])
    removal.sessionsRemoved = Number(sessions.changes) || 0

    db.run(`DELETE FROM ${PLAY_ORIGIN_TABLE} WHERE origin_id = ?`, [originId])
    // The denormalized column has to be rebuilt from whatever origins remain.
    removal.tracksAffected = recomputePlayCountsFromOrigins(Array.from(affectedPaths))

    const records = readListeningImportSourceRecords().filter((entry) => entry.source !== source)
    if (records.length > 0) {
      writeAppMetaValue(LISTENING_IMPORT_SOURCES_META_KEY, JSON.stringify(records))
    } else {
      db.run('DELETE FROM app_meta WHERE key = ?', [LISTENING_IMPORT_SOURCES_META_KEY])
    }

    commitLibraryWriteTransaction()
  } catch (error) {
    rollbackLibraryWriteTransaction()
    throw error
  }

  await saveDatabase()
  return removal
}

export async function applyListeningStatsTransfer(
  request: ListeningStatsApplyRequest
): Promise<ListeningStatsImportResult> {
  const result = createEmptyListeningStatsImportResult()
  if (!db) return result

  // Decode outside the transaction — a malformed payload must not open a write.
  let counts: ListeningCountsPayload | null = null
  if (typeof request.counts === 'string' && request.counts.trim().length > 0) {
    const decoded = decodeListeningCountsPayload(request.counts)
    if (!decoded.ok) throw new Error(decoded.error)
    counts = decoded.payload
  }

  let history: ListeningHistoryPayload | null = null
  if (typeof request.history === 'string' && request.history.trim().length > 0) {
    const decoded = decodeListeningHistoryPayload(request.history)
    if (!decoded.ok) throw new Error(decoded.error)
    history = decoded.payload
  }

  if (!counts && !history) return result

  // Every read that informs the merge happens here, before the first write. db.run
  // invalidates the track snapshot cache, so a read interleaved with the write loop would
  // rebuild it repeatedly — and a read after a partial write would see half-merged state.
  const resolver = buildStatsTransferTrackResolver()
  const generation = ensureListeningHistoryGeneration()
  const localRatings = new Map<string, number>()
  const localFavorites = new Set<string>()
  const localSessionIdByKey = new Map<string, number>()

  if (counts) {
    for (const row of db.all<{ track_path?: unknown; updated_at?: unknown }>(
      'SELECT track_path, updated_at FROM track_ratings'
    )) {
      if (typeof row.track_path === 'string') {
        localRatings.set(row.track_path, Number(row.updated_at) || 0)
      }
    }
    for (const row of db.all<{ track_path?: unknown }>('SELECT track_path FROM favorites')) {
      if (typeof row.track_path === 'string') localFavorites.add(row.track_path)
    }
  }

  if (history) {
    for (const row of db.all<{ id?: unknown; session_key?: unknown }>(
      'SELECT id, session_key FROM listening_sessions WHERE generation = ?',
      [generation]
    )) {
      if (typeof row.session_key === 'string') {
        localSessionIdByKey.set(row.session_key, Number(row.id))
      }
    }
  }

  const localHistoryStartedAt = readListeningHistoryStartedAt()

  // Each payload carries its own track dictionary, so the same index means different tracks
  // in the counts and history sections. Resolution is therefore keyed on the tuple itself
  // (inside the resolver), never on the index.
  const resolveTrack = (tuples: StatsTransferTrackTuple[], index: number): StatsTransferResolution => {
    return resolver.resolve(tuples[index])
  }

  beginLibraryWriteTransaction()
  try {
    if (counts) {
      applyListeningCountsSection(counts, {
        resolveTrack,
        rowByPath: resolver.rowByPath,
        localRatings,
        localFavorites,
        result
      })
      result.countsApplied = true
    }
    if (history) {
      applyListeningHistorySection(history, {
        resolveTrack,
        rowByPath: resolver.rowByPath,
        albumIdentityKeyByPath: resolver.albumIdentityKeyByPath,
        generation,
        localSessionIdByKey,
        localHistoryStartedAt,
        result
      })
      result.historyApplied = true
    }
    commitLibraryWriteTransaction()
  } catch (error) {
    rollbackLibraryWriteTransaction()
    throw error
  }

  const uniqueResolutions = resolver.resolutions()
  result.identitiesInPayload = uniqueResolutions.length
  result.identitiesMatched = uniqueResolutions.filter((entry) => entry.trackPath !== null).length
  result.identitiesAmbiguous = uniqueResolutions.filter((entry) => entry.ambiguous).length
  result.identitiesUnmatched = result.identitiesInPayload - result.identitiesMatched

  await saveDatabase()
  return result
}

type ResolveTrackFn = (tuples: StatsTransferTrackTuple[], index: number) => StatsTransferResolution

interface ListeningCountsSectionContext {
  resolveTrack: ResolveTrackFn
  rowByPath: Map<string, DbTrackRow>
  localRatings: Map<string, number>
  localFavorites: Set<string>
  result: ListeningStatsImportResult
}

function applyListeningCountsSection(
  payload: ListeningCountsPayload,
  context: ListeningCountsSectionContext
): void {
  if (!db) return
  const { resolveTrack, rowByPath, localRatings, localFavorites, result } = context

  // Each row is one install's running total for one track, so it merges with MAX against
  // the matching origin row. Distinct origins never collide, which is what lets counts from
  // several machines add up while a repeated import of the same file changes nothing.
  // Several source identities can resolve to the same local track (for example, editions
  // with different album tags). Sum those rows within this payload before the idempotent
  // MAX merge, otherwise only the largest contribution would survive the PK collision.
  const playRowsByPath = new Map<string, Map<string, { playCount: number; lastPlayedAt: number | null }>>()
  const touchedPaths = new Set<string>()
  for (const [trackIndex, originIndex, playCount, lastPlayedAt] of payload.plays) {
    const originId = payload.origins[originIndex]
    if (!originId) continue
    const resolution = resolveTrack(payload.tracks, trackIndex)
    if (!resolution.trackPath) continue
    if (!rowByPath.has(resolution.trackPath)) continue
    let rowsByOrigin = playRowsByPath.get(resolution.trackPath)
    if (!rowsByOrigin) {
      rowsByOrigin = new Map()
      playRowsByPath.set(resolution.trackPath, rowsByOrigin)
    }
    const existing = rowsByOrigin.get(originId)
    if (existing) {
      existing.playCount += playCount
      if (
        lastPlayedAt !== null
        && (existing.lastPlayedAt === null || lastPlayedAt > existing.lastPlayedAt)
      ) {
        existing.lastPlayedAt = lastPlayedAt
      }
    } else {
      rowsByOrigin.set(originId, { playCount, lastPlayedAt })
    }
    touchedPaths.add(resolution.trackPath)
  }
  const playRows: Array<[string, string, number, number | null]> = []
  for (const [trackPath, rowsByOrigin] of playRowsByPath) {
    for (const [originId, row] of rowsByOrigin) {
      playRows.push([trackPath, originId, row.playCount, row.lastPlayedAt])
    }
  }

  if (playRows.length > 0) {
    const playsPerChunk = Math.floor(SQLITE_SAFE_MAX_VARIABLES / 4)
    for (let offset = 0; offset < playRows.length; offset += playsPerChunk) {
      const chunk = playRows.slice(offset, offset + playsPerChunk)
      const placeholders = chunk.map(() => '(?, ?, ?, ?)').join(', ')
      db.run(`
        INSERT INTO ${PLAY_ORIGIN_TABLE} (track_path, origin_id, play_count, last_played_at)
        VALUES ${placeholders}
        ON CONFLICT(track_path, origin_id) DO UPDATE SET
          play_count = MAX(${PLAY_ORIGIN_TABLE}.play_count, excluded.play_count),
          last_played_at = CASE
            WHEN excluded.last_played_at IS NULL THEN ${PLAY_ORIGIN_TABLE}.last_played_at
            WHEN ${PLAY_ORIGIN_TABLE}.last_played_at IS NULL THEN excluded.last_played_at
            ELSE MAX(${PLAY_ORIGIN_TABLE}.last_played_at, excluded.last_played_at)
          END
      `, chunk.flat())
    }

    // tracks.play_count is the denormalized sum, so it is rebuilt from the breakdown rather
    // than merged directly. Only genuinely changed rows are counted.
    result.playCountsUpdated = recomputePlayCountsFromOrigins(Array.from(touchedPaths))
  }

  const ratingRows: Array<[string, number, number]> = []
  for (const [trackIndex, rating, updatedAt] of payload.ratings) {
    const resolution = resolveTrack(payload.tracks, trackIndex)
    if (!resolution.trackPath) continue
    const normalizedRating = normalizeTrackRating(rating)
    if (normalizedRating === null) continue
    const localUpdatedAt = localRatings.get(resolution.trackPath)
    if (localUpdatedAt !== undefined && !shouldReplaceRating(localUpdatedAt, updatedAt)) {
      result.ratingsKeptLocal += 1
      continue
    }
    ratingRows.push([resolution.trackPath, normalizedRating, updatedAt])
  }

  const ratingsPerChunk = Math.floor(SQLITE_SAFE_MAX_VARIABLES / 3)
  for (let offset = 0; offset < ratingRows.length; offset += ratingsPerChunk) {
    const chunk = ratingRows.slice(offset, offset + ratingsPerChunk)
    const placeholders = chunk.map(() => '(?, ?, ?)').join(', ')
    db.run(`
      INSERT INTO track_ratings (track_path, rating, updated_at)
      VALUES ${placeholders}
      ON CONFLICT(track_path) DO UPDATE SET
        rating = CASE
          WHEN excluded.updated_at > track_ratings.updated_at THEN excluded.rating
          ELSE track_ratings.rating
        END,
        updated_at = MAX(track_ratings.updated_at, excluded.updated_at)
    `, chunk.flat())
  }
  result.ratingsApplied = ratingRows.length

  const favoriteRows: Array<[string, number]> = []
  const insertedFavoritePaths: string[] = []
  for (const [trackIndex, addedAt] of payload.favorites) {
    const resolution = resolveTrack(payload.tracks, trackIndex)
    if (!resolution.trackPath) continue
    favoriteRows.push([resolution.trackPath, addedAt])
    if (localFavorites.has(resolution.trackPath)) {
      result.favoritesAlreadyPresent += 1
    } else {
      insertedFavoritePaths.push(resolution.trackPath)
    }
  }

  const favoritesPerChunk = Math.floor(SQLITE_SAFE_MAX_VARIABLES / 2)
  for (let offset = 0; offset < favoriteRows.length; offset += favoritesPerChunk) {
    const chunk = favoriteRows.slice(offset, offset + favoritesPerChunk)
    const placeholders = chunk.map(() => '(?, ?)').join(', ')
    db.run(`
      INSERT INTO favorites (track_path, added_at)
      VALUES ${placeholders}
      ON CONFLICT(track_path) DO UPDATE SET added_at = MIN(favorites.added_at, excluded.added_at)
    `, chunk.flat())
  }
  result.favoritesAdded = insertedFavoritePaths.length

  // Mirrors addFavoritePaths: a newly favorited path must drop any unfavorite tombstone,
  // otherwise the next LAN sync replays the tombstone and deletes the favorite again.
  if (insertedFavoritePaths.length > 0) {
    result.favoriteTombstonesCleared = countFavoriteTombstonesForPaths(insertedFavoritePaths)
    clearFavoriteSyncRowsForPaths(insertedFavoritePaths)
  }
}

/** Counts the unfavorite tombstones about to be cleared, for the import summary. */
function countFavoriteTombstonesForPaths(trackPaths: readonly string[]): number {
  if (!db || trackPaths.length === 0) return 0
  let count = 0
  for (const row of readEffectiveTrackRowsByPaths(trackPaths)) {
    if (!normalizeSyncKeyPart(row.title)) continue
    const syncKey = buildTrackSyncKey(row.title, row.artist, row.album)
    const existing = db.get<{ count?: unknown }>(
      'SELECT COUNT(*) AS count FROM favorite_tombstones WHERE sync_key = ?',
      [syncKey]
    )
    if ((Number(existing?.count) || 0) > 0) count += 1
  }
  return count
}

interface ListeningHistorySectionContext {
  resolveTrack: ResolveTrackFn
  rowByPath: Map<string, DbTrackRow>
  albumIdentityKeyByPath: ReadonlyMap<string, string>
  generation: string
  localSessionIdByKey: Map<string, number>
  localHistoryStartedAt: number | null
  result: ListeningStatsImportResult
}

function applyListeningHistorySection(
  payload: ListeningHistoryPayload,
  context: ListeningHistorySectionContext
): void {
  if (!db) return
  const {
    resolveTrack,
    rowByPath,
    albumIdentityKeyByPath,
    generation,
    localSessionIdByKey,
    localHistoryStartedAt,
    result
  } = context

  result.sessionsTruncatedAtExport = payload.truncated

  const sessionRows: unknown[][] = []
  // Segment indices point into payload.sessions, including positions that may be skipped.
  // Preserve that index space so a bad session cannot shift its segments onto a later row.
  const sessionKeyByPayloadIndex: Array<string | null> = Array(payload.sessions.length).fill(null)
  let earliestStartedAt: number | null = payload.historyStartedAt

  for (const [payloadIndex, session] of payload.sessions.entries()) {
    const [trackIndex, sessionKey, sourceType, durationSeconds, startedAt, endedAt, listenedSeconds, qualifiedAt] = session
    const tuple = payload.tracks[trackIndex]
    if (!tuple) {
      result.sessionsSkipped += 1
      continue
    }
    const resolution = resolveTrack(payload.tracks, trackIndex)
    const title = tuple[2]
    const artist = tuple[3]
    const album = tuple[4]
    const albumArtist = tuple[5]

    // An unmatched session still imports with track_id NULL — resolveListeningIdentity
    // falls back to the denormalized snapshot, so it renders on the Stats page. Only a row
    // with no usable identity at all is unusable.
    if (!resolution.trackPath && !title) {
      result.sessionsSkipped += 1
      continue
    }

    // A session from another machine names a file this library does not have, and the
    // payload only carries a digest of that path anyway. Fall back to the same synthetic
    // identifier the phone sync uses for unresolved entries rather than storing a hash that
    // reads like a real path.
    const trackPath = resolution.trackPath
      ?? `astra-sync://unmatched/${buildTrackSyncKey(title, artist, album)}`

    const localRow = resolution.trackPath ? rowByPath.get(resolution.trackPath) : undefined
    sessionKeyByPayloadIndex[payloadIndex] = sessionKey
    sessionRows.push([
      generation,
      sessionKey,
      localRow ? localRow.id : null,
      trackPath,
      title,
      artist,
      album,
      albumArtist,
      // A matched track reuses the library's own album identity so imported sessions group
      // with locally recorded ones; only unmatched rows fall back to the derived key, which
      // is the same precedence checkpointListeningSession applies.
      (resolution.trackPath ? albumIdentityKeyByPath.get(resolution.trackPath) : undefined)
        ?? `${normalizeKey(albumArtist || artist)}\u0000${normalizeKey(album)}`,
      sourceType || 'local',
      durationSeconds,
      startedAt,
      endedAt,
      listenedSeconds,
      qualifiedAt
    ])

    earliestStartedAt = earliestStartedAt === null ? startedAt : Math.min(earliestStartedAt, startedAt)
    if (localSessionIdByKey.has(sessionKey)) {
      result.sessionsMerged += 1
    } else {
      result.sessionsInserted += 1
    }
  }

  // artwork_hash and source_playlist_id are local-only and written as literal NULL:
  // the artwork hash names a file in this machine's cache, and the playlist id is a
  // foreign key into a playlists table the source install's ids mean nothing in.
  const sessionsPerChunk = Math.floor(SQLITE_SAFE_MAX_VARIABLES / 15)
  for (let offset = 0; offset < sessionRows.length; offset += sessionsPerChunk) {
    const chunk = sessionRows.slice(offset, offset + sessionsPerChunk)
    const placeholders = chunk
      .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)')
      .join(', ')
    db.run(`
      INSERT INTO listening_sessions (
        generation, session_key, track_id, track_path, title, artist, album, album_artist,
        album_identity_key, artwork_hash, source_type, duration_seconds, source_playlist_id,
        started_at, ended_at, listened_seconds, qualified_at
      ) VALUES ${placeholders}
      ON CONFLICT(generation, session_key) DO UPDATE SET
        track_id = COALESCE(listening_sessions.track_id, excluded.track_id),
        duration_seconds = MAX(listening_sessions.duration_seconds, excluded.duration_seconds),
        started_at = MIN(listening_sessions.started_at, excluded.started_at),
        ended_at = CASE
          WHEN excluded.ended_at IS NULL THEN listening_sessions.ended_at
          WHEN listening_sessions.ended_at IS NULL THEN excluded.ended_at
          ELSE MAX(listening_sessions.ended_at, excluded.ended_at)
        END,
        listened_seconds = MAX(listening_sessions.listened_seconds, excluded.listened_seconds),
        qualified_at = CASE
          WHEN excluded.qualified_at IS NULL THEN listening_sessions.qualified_at
          WHEN listening_sessions.qualified_at IS NULL THEN excluded.qualified_at
          ELSE MIN(listening_sessions.qualified_at, excluded.qualified_at)
        END
    `, chunk.flat())
  }

  // qualifyListeningSession() is deliberately never called here: qualified_at travels
  // verbatim, and play counts import through their own section. Replaying qualification
  // would increment play_count a second time for every imported session.

  if (sessionRows.length === 0) return

  const sessionIdByKey = new Map<string, number>()
  for (const row of db.all<{ id?: unknown; session_key?: unknown }>(
    'SELECT id, session_key FROM listening_sessions WHERE generation = ?',
    [generation]
  )) {
    if (typeof row.session_key === 'string') {
      sessionIdByKey.set(row.session_key, Number(row.id))
    }
  }

  const segmentRows: unknown[][] = []
  for (const [sessionIndex, segmentKey, startedAt, lastObservedAt, endedAt, listenedSeconds] of payload.segments) {
    const sessionKey = sessionKeyByPayloadIndex[sessionIndex]
    if (!sessionKey) continue
    const sessionId = sessionIdByKey.get(sessionKey)
    if (sessionId === undefined) continue
    segmentRows.push([sessionId, segmentKey, startedAt, lastObservedAt, endedAt, listenedSeconds])
    if (localSessionIdByKey.has(sessionKey)) {
      result.segmentsMerged += 1
    } else {
      result.segmentsInserted += 1
    }
  }

  const segmentsPerChunk = Math.floor(SQLITE_SAFE_MAX_VARIABLES / 6)
  for (let offset = 0; offset < segmentRows.length; offset += segmentsPerChunk) {
    const chunk = segmentRows.slice(offset, offset + segmentsPerChunk)
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')
    db.run(`
      INSERT INTO listening_segments (
        session_id, segment_key, started_at, last_observed_at, ended_at, listened_seconds
      ) VALUES ${placeholders}
      ON CONFLICT(session_id, segment_key) DO UPDATE SET
        started_at = MIN(listening_segments.started_at, excluded.started_at),
        last_observed_at = MAX(listening_segments.last_observed_at, excluded.last_observed_at),
        ended_at = CASE
          WHEN excluded.ended_at IS NULL THEN listening_segments.ended_at
          WHEN listening_segments.ended_at IS NULL THEN excluded.ended_at
          ELSE MAX(listening_segments.ended_at, excluded.ended_at)
        END,
        listened_seconds = MAX(listening_segments.listened_seconds, excluded.listened_seconds)
    `, chunk.flat())
  }

  // The "history since" baseline must move back to cover imported listens. When nothing was
  // recorded locally the imported value wins outright rather than staying unset.
  if (earliestStartedAt !== null && Number.isFinite(earliestStartedAt) && earliestStartedAt > 0) {
    const next = localHistoryStartedAt === null
      ? earliestStartedAt
      : Math.min(localHistoryStartedAt, earliestStartedAt)
    if (next !== localHistoryStartedAt) {
      writeAppMetaValue(LISTENING_HISTORY_STARTED_AT_META_KEY, String(next))
      result.historyStartedAtMovedTo = next
    }
  }
}

export function getRecentlyPlayed(limit: number = 50): DbTrack[] {
  return readEffectiveTracks(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
    INNER JOIN recently_played r ON r.track_path = t.path
    ORDER BY r.played_at DESC
    LIMIT ${limit}
  `)
}

export async function markTrackLatestSyncSeen(trackPath: string): Promise<void> {
  if (!db) return
  db.run('UPDATE tracks SET latest_sync_dismissed_at = ? WHERE path = ?', [Date.now(), trackPath])
  await saveDatabase()
}

export async function addRecentlyPlayed(trackPath: string): Promise<void> {
  if (!db) return
  const playedAt = Date.now()
  const result = db.run(
    'UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE path = ?',
    [playedAt, trackPath]
  )
  if (result.changes === 0) return
  recordLocalPlayOrigin(trackPath, playedAt)
  db.run('INSERT INTO recently_played (track_path, played_at) VALUES (?, ?)', [trackPath, playedAt])
  // Prune old entries, keep last 200
  db.run(`
    DELETE FROM recently_played WHERE id NOT IN (
      SELECT id FROM recently_played ORDER BY played_at DESC LIMIT 200
    )
  `)
  await saveDatabase()
}

// ── Playlists ────────────────────────────────────────────

interface PlaylistSummaryRow {
  id: number
  name: string
  kind?: unknown
  dynamic_rules_json?: unknown
  created_at: number
  updated_at: number
  last_played_at: number | null
  custom_cover_hash: string | null
  auto_cover_hash: string | null
  track_count: number
  missing_track_count: number
}

interface PlaylistRuleRow {
  id?: unknown
  kind?: unknown
  dynamic_rules_json?: unknown
}

const DYNAMIC_PLAYLIST_PREVIEW_TRACK_LIMIT = 25

const DYNAMIC_TEXT_FIELD_SQL: Record<DynamicPlaylistTextField, string> = {
  title: 'COALESCE(o.title, t.title)',
  artist: 'COALESCE(o.artist, t.artist)',
  album: 'COALESCE(o.album, t.album)',
  album_artist: 'COALESCE(o.album_artist, t.album_artist)',
  genre: 'COALESCE(o.genre, t.genre)',
  format: 't.format',
  musical_key: 't.musical_key'
}

const DYNAMIC_NUMERIC_FIELD_SQL: Record<DynamicPlaylistNumericField, string> = {
  play_count: 'COALESCE(t.play_count, 0)',
  year: 'COALESCE(o.year, t.year)',
  duration_seconds: 't.duration',
  bpm: 't.bpm',
  // NULL for unrated tracks, so numeric conditions never match them; the
  // 'rated' exact field is the way to target unrated tracks.
  rating: 'r.rating'
}

const DYNAMIC_DATE_FIELD_SQL: Record<DynamicPlaylistDateField, string> = {
  last_played_at: 't.last_played_at',
  added_at: 't.added_at'
}

const DYNAMIC_SORT_FIELD_SQL: Record<DynamicPlaylistSortField, { expression: string; nullable: boolean; text?: boolean }> = {
  title: { expression: 'COALESCE(o.title, t.title)', nullable: false, text: true },
  artist: { expression: 'COALESCE(o.artist, t.artist)', nullable: false, text: true },
  album: { expression: 'COALESCE(o.album, t.album)', nullable: false, text: true },
  added_at: { expression: 't.added_at', nullable: false },
  last_played_at: { expression: 't.last_played_at', nullable: true },
  play_count: { expression: 'COALESCE(t.play_count, 0)', nullable: false },
  year: { expression: 'COALESCE(o.year, t.year)', nullable: true },
  duration_seconds: { expression: 't.duration', nullable: false },
  bpm: { expression: 't.bpm', nullable: true },
  rating: { expression: 'r.rating', nullable: true }
}

function normalizePlaylistKind(value: unknown): PlaylistKind {
  return value === 'dynamic' ? 'dynamic' : 'normal'
}

function serializeDynamicPlaylistRules(rules: DynamicPlaylistRulesV1): string {
  return JSON.stringify(normalizeDynamicPlaylistRules(rules))
}

function parseDynamicPlaylistRules(rawRules: unknown): DynamicPlaylistRulesV1 {
  if (typeof rawRules !== 'string' || rawRules.trim().length === 0) {
    return createDefaultDynamicPlaylistRules()
  }

  try {
    return normalizeDynamicPlaylistRules(JSON.parse(rawRules))
  } catch {
    return createDefaultDynamicPlaylistRules()
  }
}

function readPlaylistRuleRow(playlistId: number): PlaylistRuleRow | null {
  if (!db || !Number.isInteger(playlistId) || playlistId <= 0) return null
  return db.get<PlaylistRuleRow>('SELECT id, kind, dynamic_rules_json FROM playlists WHERE id = ? LIMIT 1', [playlistId]) ?? null
}

function getPlaylistKindById(playlistId: number): PlaylistKind | null {
  const row = readPlaylistRuleRow(playlistId)
  if (!row) return null
  return normalizePlaylistKind(row.kind)
}

function assertNormalPlaylist(playlistId: number, action: string): void {
  const kind = getPlaylistKindById(playlistId)
  if (kind === 'dynamic') {
    throw new Error(`Dynamic playlists cannot ${action}.`)
  }
}

function requireDynamicPlaylistRulesForId(playlistId: number): DynamicPlaylistRulesV1 {
  const row = readPlaylistRuleRow(playlistId)
  if (!row) {
    throw new Error('Playlist not found.')
  }
  if (normalizePlaylistKind(row.kind) !== 'dynamic') {
    throw new Error('Playlist is not dynamic.')
  }
  return parseDynamicPlaylistRules(row.dynamic_rules_json)
}

function appendDynamicTextCondition(
  condition: Extract<DynamicPlaylistCondition, { kind: 'text' }>,
  whereClauses: string[],
  params: unknown[]
): void {
  const expression = DYNAMIC_TEXT_FIELD_SQL[condition.field]
  const normalizedValue = condition.value.toLocaleLowerCase()
  if (condition.operator === 'contains') {
    whereClauses.push(`LOWER(COALESCE(${expression}, '')) LIKE ?`)
    params.push(`%${normalizedValue}%`)
    return
  }

  whereClauses.push(`LOWER(COALESCE(${expression}, '')) ${condition.operator === 'is' ? '=' : '<>'} ?`)
  params.push(normalizedValue)
}

function appendDynamicExactCondition(
  condition: Extract<DynamicPlaylistCondition, { kind: 'exact' }>,
  whereClauses: string[],
  params: unknown[]
): void {
  if (condition.field === 'source_type') {
    whereClauses.push(`t.source_type ${condition.operator === 'is' ? '=' : '<>'} ?`)
    params.push(condition.value)
    return
  }

  if (condition.field === 'rated') {
    const expectsRated = condition.operator === 'is' ? condition.value : !condition.value
    whereClauses.push(`r.track_path IS ${expectsRated ? 'NOT NULL' : 'NULL'}`)
    return
  }

  const expectsFavorite = condition.operator === 'is' ? condition.value : !condition.value
  whereClauses.push(`f.track_path IS ${expectsFavorite ? 'NOT NULL' : 'NULL'}`)
}

function appendDynamicNumericCondition(
  condition: Extract<DynamicPlaylistCondition, { kind: 'numeric' }>,
  whereClauses: string[],
  params: unknown[]
): void {
  const expression = DYNAMIC_NUMERIC_FIELD_SQL[condition.field]
  const operator = condition.operator === 'eq'
    ? '='
    : condition.operator === 'gte'
      ? '>='
      : '<='
  whereClauses.push(`${expression} ${operator} ?`)
  params.push(condition.value)
}

function appendDynamicDateCondition(
  condition: Extract<DynamicPlaylistCondition, { kind: 'date' }>,
  whereClauses: string[],
  params: unknown[],
  now: number
): void {
  const expression = DYNAMIC_DATE_FIELD_SQL[condition.field]
  if (condition.field === 'last_played_at' && condition.operator === 'never') {
    whereClauses.push(`${expression} IS NULL`)
    return
  }

  const dayValue = typeof condition.value === 'number' ? condition.value : 1
  const cutoff = now - dayValue * 24 * 60 * 60 * 1000
  if (condition.field === 'last_played_at') {
    if (condition.operator === 'within_days') {
      whereClauses.push(`${expression} >= ?`)
      params.push(cutoff)
      return
    }
    whereClauses.push(`(${expression} IS NULL OR ${expression} < ?)`)
    params.push(cutoff)
    return
  }

  whereClauses.push(`${expression} ${condition.operator === 'within_days' ? '>=' : '<'} ?`)
  params.push(cutoff)
}

function buildDynamicPlaylistWhereClause(
  rules: DynamicPlaylistRulesV1,
  now: number = Date.now()
): { joins: string; where: string; params: unknown[] } {
  const whereClauses = ['COALESCE(t.is_available, 1) = 1']
  const params: unknown[] = []
  const needsFavoriteJoin = rules.conditions.some((condition) => (
    condition.kind === 'exact' && condition.field === 'favorite'
  ))
  // The sort field must be part of the join check: these joins also feed the
  // ORDER BY query, and sorting by rating without a rating condition would
  // otherwise reference r.rating with no track_ratings join.
  const needsRatingJoin = rules.sort.field === 'rating' || rules.conditions.some((condition) => (
    (condition.kind === 'exact' && condition.field === 'rated')
    || (condition.kind === 'numeric' && condition.field === 'rating')
  ))

  for (const condition of rules.conditions) {
    if (condition.kind === 'text') {
      appendDynamicTextCondition(condition, whereClauses, params)
    } else if (condition.kind === 'exact') {
      appendDynamicExactCondition(condition, whereClauses, params)
    } else if (condition.kind === 'numeric') {
      appendDynamicNumericCondition(condition, whereClauses, params)
    } else {
      appendDynamicDateCondition(condition, whereClauses, params, now)
    }
  }

  const joins: string[] = []
  if (needsFavoriteJoin) joins.push('LEFT JOIN favorites f ON f.track_path = t.path')
  if (needsRatingJoin) joins.push('LEFT JOIN track_ratings r ON r.track_path = t.path')

  return {
    joins: joins.join('\n      '),
    where: whereClauses.join('\n      AND '),
    params
  }
}

function buildDynamicPlaylistOrderByClause(rules: DynamicPlaylistRulesV1): string {
  const sort = DYNAMIC_SORT_FIELD_SQL[rules.sort.field] ?? DYNAMIC_SORT_FIELD_SQL.title
  const direction = rules.sort.direction === 'desc' ? 'DESC' : 'ASC'
  const expression = sort.text ? `${sort.expression} COLLATE NOCASE` : sort.expression
  const nullablePrefix = sort.nullable ? `CASE WHEN ${sort.expression} IS NULL THEN 1 ELSE 0 END ASC, ` : ''
  return `${nullablePrefix}${expression} ${direction}, t.path COLLATE NOCASE ASC`
}

function getDynamicPlaylistTracksForRules(rules: DynamicPlaylistRulesV1): DbTrack[] {
  return measureLibraryQuery('getDynamicPlaylistTracks', () => {
    const normalizedRules = normalizeDynamicPlaylistRules(rules)
    const { joins, where, params } = buildDynamicPlaylistWhereClause(normalizedRules)
    const orderBy = buildDynamicPlaylistOrderByClause(normalizedRules)
    const limitSql = normalizedRules.limit === null ? '' : '\n    LIMIT ?'
    const limitParams = normalizedRules.limit === null ? [] : [normalizedRules.limit]

    return readEffectiveTracks(`
      SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
      ${EFFECTIVE_TRACK_FROM_CLAUSE}
      ${joins}
      WHERE ${where}
      ORDER BY ${orderBy}${limitSql}
    `, undefined, [...params, ...limitParams])
  })
}

function getDynamicPlaylistTracksForId(playlistId: number): DbTrack[] {
  return getDynamicPlaylistTracksForRules(requireDynamicPlaylistRulesForId(playlistId))
}

function buildDynamicPlaylistSummary(row: PlaylistSummaryRow): Playlist {
  const tracks = getDynamicPlaylistTracksForRules(parseDynamicPlaylistRules(row.dynamic_rules_json))
  return {
    id: row.id,
    name: row.name,
    kind: 'dynamic',
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_played_at: row.last_played_at,
    custom_cover_hash: row.custom_cover_hash,
    auto_cover_hash: tracks[0]?.artwork_hash ?? null,
    track_count: tracks.length,
    missing_track_count: 0
  }
}

function buildNormalPlaylistSummary(row: PlaylistSummaryRow): Playlist {
  return {
    id: row.id,
    name: row.name,
    kind: 'normal',
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_played_at: row.last_played_at,
    custom_cover_hash: row.custom_cover_hash,
    auto_cover_hash: row.auto_cover_hash,
    track_count: row.track_count,
    missing_track_count: row.missing_track_count
  }
}

export function getPlaylists(): Playlist[] {
  if (!db) return []
  return db.all<PlaylistSummaryRow>(`
    SELECT
      p.id,
      p.name,
      p.kind,
      p.dynamic_rules_json,
      p.created_at,
      p.updated_at,
      p.last_played_at,
      p.custom_cover_hash,
      (
        SELECT t.artwork_hash
        FROM playlist_tracks ptc
        INNER JOIN tracks t ON t.path = ptc.track_path
        WHERE ptc.playlist_id = p.id
        ORDER BY ptc.position ASC
        LIMIT 1
      ) as auto_cover_hash,
      (
        SELECT COUNT(*)
        FROM playlist_tracks pt
        INNER JOIN tracks t ON t.path = pt.track_path
        WHERE pt.playlist_id = p.id
      ) as track_count,
      (
        SELECT COUNT(*)
        FROM playlist_tracks ptm
        LEFT JOIN tracks t ON t.path = ptm.track_path
        WHERE ptm.playlist_id = p.id
          AND t.path IS NULL
      ) as missing_track_count
    FROM playlists p
    ORDER BY
      CASE WHEN p.last_played_at IS NULL THEN 1 ELSE 0 END,
      p.last_played_at DESC,
      p.updated_at DESC
  `).map((row) => (
    normalizePlaylistKind(row.kind) === 'dynamic'
      ? buildDynamicPlaylistSummary(row)
      : buildNormalPlaylistSummary(row)
  ))
}

export function getCompanionApiPlaylistTarget(playlistId: number): CompanionApiPlaylistTarget | null {
  if (!db || !Number.isInteger(playlistId) || playlistId <= 0) return null
  const row = db.get<{
    id?: unknown
    name?: unknown
    kind?: unknown
    remote_source_id?: unknown
    custom_cover_hash?: unknown
    auto_cover_hash?: unknown
  }>(`
    SELECT
      p.id,
      p.name,
      p.kind,
      p.remote_source_id,
      p.custom_cover_hash,
      (
        SELECT t.artwork_hash
        FROM playlist_tracks pt
        INNER JOIN tracks t ON t.path = pt.track_path
        WHERE pt.playlist_id = p.id
        ORDER BY pt.position ASC, pt.id ASC
        LIMIT 1
      ) AS auto_cover_hash
    FROM playlists p
    WHERE p.id = ?
    LIMIT 1
  `, [playlistId])
  const id = Number(row?.id)
  if (!Number.isInteger(id) || id <= 0 || typeof row?.name !== 'string') return null
  return {
    id,
    name: row.name,
    kind: row.kind === 'dynamic' ? 'dynamic' : 'normal',
    remote_source_id: row.remote_source_id !== null
      && row.remote_source_id !== undefined
      && Number.isInteger(Number(row.remote_source_id))
      ? Number(row.remote_source_id)
      : null,
    artwork_hash: typeof row.custom_cover_hash === 'string'
      ? row.custom_cover_hash
      : typeof row.auto_cover_hash === 'string'
        ? row.auto_cover_hash
        : null
  }
}

export function isCompanionApiPlaylistWritable(playlistId: number): boolean {
  const playlist = getCompanionApiPlaylistTarget(playlistId)
  return Boolean(playlist && playlist.kind === 'normal' && playlist.remote_source_id === null)
}

export async function createPlaylist(name: string): Promise<Playlist> {
  if (!db) throw new Error('Database not initialized')
  const now = Date.now()
  const insertResult = db.run('INSERT INTO playlists (name, created_at, updated_at, last_played_at, custom_cover_hash) VALUES (?, ?, ?, ?, ?)', [
    name,
    now,
    now,
    null,
    null
  ])
  const id = Number(insertResult.lastInsertRowid)
  await saveDatabase()
  return {
    id,
    name,
    kind: 'normal',
    created_at: now,
    updated_at: now,
    last_played_at: null,
    custom_cover_hash: null,
    auto_cover_hash: null,
    track_count: 0,
    missing_track_count: 0
  }
}

export async function createDynamicPlaylist(name: string, rules: DynamicPlaylistRulesV1): Promise<Playlist> {
  if (!db) throw new Error('Database not initialized')
  const trimmedName = name.trim()
  if (!trimmedName) {
    throw new Error('Playlist name is required.')
  }

  const normalizedRules = normalizeDynamicPlaylistRules(rules)
  const now = Date.now()
  const insertResult = db.run(
    `INSERT INTO playlists (
      name,
      created_at,
      updated_at,
      last_played_at,
      custom_cover_hash,
      kind,
      dynamic_rules_json
    ) VALUES (?, ?, ?, NULL, NULL, 'dynamic', ?)`,
    [trimmedName, now, now, serializeDynamicPlaylistRules(normalizedRules)]
  )
  await saveDatabase()

  return buildDynamicPlaylistSummary({
    id: Number(insertResult.lastInsertRowid),
    name: trimmedName,
    kind: 'dynamic',
    dynamic_rules_json: serializeDynamicPlaylistRules(normalizedRules),
    created_at: now,
    updated_at: now,
    last_played_at: null,
    custom_cover_hash: null,
    auto_cover_hash: null,
    track_count: 0,
    missing_track_count: 0
  })
}

export function getDynamicPlaylistRules(playlistId: number): DynamicPlaylistRulesV1 {
  return requireDynamicPlaylistRulesForId(playlistId)
}

export async function updateDynamicPlaylistRules(playlistId: number, rules: DynamicPlaylistRulesV1): Promise<void> {
  if (!db) throw new Error('Database not initialized')
  if (!Number.isInteger(playlistId) || playlistId <= 0) {
    throw new Error('Playlist id is required.')
  }

  requireDynamicPlaylistRulesForId(playlistId)
  const normalizedRules = normalizeDynamicPlaylistRules(rules)
  db.run('UPDATE playlists SET dynamic_rules_json = ?, updated_at = ? WHERE id = ?', [
    serializeDynamicPlaylistRules(normalizedRules),
    Date.now(),
    playlistId
  ])
  await saveDatabase()
}

export function previewDynamicPlaylist(rules: DynamicPlaylistRulesV1): DynamicPlaylistPreview {
  const tracks = getDynamicPlaylistTracksForRules(normalizeDynamicPlaylistRules(rules))
  return {
    track_count: tracks.length,
    tracks: tracks.slice(0, DYNAMIC_PLAYLIST_PREVIEW_TRACK_LIMIT)
  }
}

export async function syncSubsonicRemotePlaylists(
  sourceId: number,
  playlists: SubsonicRemotePlaylistSyncInput[],
  options: { persist?: boolean } = {}
): Promise<{ created: number; updated: number; removed: number }> {
  if (!db) return { created: 0, updated: 0, removed: 0 }

  const normalizedPlaylists = playlists
    .map((playlist) => {
      const sourcePlaylistId = typeof playlist.source_playlist_id === 'string'
        ? playlist.source_playlist_id.trim()
        : ''
      if (!sourcePlaylistId) return null

      const name = typeof playlist.name === 'string' && playlist.name.trim().length > 0
        ? playlist.name.trim()
        : `Playlist ${sourcePlaylistId}`

      const tracks: PlaylistEntryInsertInput[] = []
      for (const track of playlist.tracks) {
        const trackPath = typeof track.path === 'string' ? track.path.trim() : ''
        if (!trackPath) continue
        tracks.push({
          trackPath,
          fallbackTitle: normalizeOptionalTextField(track.title ?? null),
          fallbackArtist: normalizeOptionalTextField(track.artist ?? null),
          fallbackAlbum: normalizeOptionalTextField(track.album ?? null)
        })
      }

      return {
        sourcePlaylistId,
        name,
        tracks
      }
    })
    .filter((playlist): playlist is { sourcePlaylistId: string; name: string; tracks: PlaylistEntryInsertInput[] } => playlist !== null)

  const seenRemotePlaylistIds = new Set(normalizedPlaylists.map((playlist) => playlist.sourcePlaylistId))
  const existingRows = db.all<{ id?: unknown; remote_playlist_id?: unknown }>(`
    SELECT id, remote_playlist_id
    FROM playlists
    WHERE remote_source_type = 'subsonic'
      AND remote_source_id = ?
  `, [sourceId])

  const existingByRemotePlaylistId = new Map<string, number>()
  for (const row of existingRows) {
    const id = Number(row.id)
    const remotePlaylistId = typeof row.remote_playlist_id === 'string' ? row.remote_playlist_id : ''
    if (Number.isInteger(id) && id > 0 && remotePlaylistId) {
      existingByRemotePlaylistId.set(remotePlaylistId, id)
    }
  }

  const now = Date.now()
  let created = 0
  let updated = 0

  for (const playlist of normalizedPlaylists) {
    let playlistId = existingByRemotePlaylistId.get(playlist.sourcePlaylistId) ?? null
    if (playlistId === null) {
      const insertResult = db.run(
        `INSERT INTO playlists (
          name,
          created_at,
          updated_at,
          last_played_at,
          custom_cover_hash,
          remote_source_type,
          remote_source_id,
          remote_playlist_id
        ) VALUES (?, ?, ?, NULL, NULL, 'subsonic', ?, ?)`,
        [playlist.name, now, now, sourceId, playlist.sourcePlaylistId]
      )
      playlistId = Number(insertResult.lastInsertRowid)
      existingByRemotePlaylistId.set(playlist.sourcePlaylistId, playlistId)
      created += 1
    } else {
      db.run('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?', [playlist.name, now, playlistId])
      db.run('DELETE FROM playlist_tracks WHERE playlist_id = ?', [playlistId])
      updated += 1
    }

    let position = 0
    for (const entry of playlist.tracks) {
      db.run(
        'INSERT INTO playlist_tracks (playlist_id, track_path, position, added_at, fallback_title, fallback_artist, fallback_album) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          playlistId,
          entry.trackPath,
          position++,
          now,
          entry.fallbackTitle ?? null,
          entry.fallbackArtist ?? null,
          entry.fallbackAlbum ?? null
        ]
      )
    }
  }

  let removed = 0
  for (const [remotePlaylistId, playlistId] of existingByRemotePlaylistId.entries()) {
    if (seenRemotePlaylistIds.has(remotePlaylistId)) continue
    db.run('DELETE FROM playlist_tracks WHERE playlist_id = ?', [playlistId])
    const result = db.run('DELETE FROM playlists WHERE id = ?', [playlistId])
    removed += Number(result.changes) || 0
  }

  if (options.persist !== false && (created > 0 || updated > 0 || removed > 0)) {
    await saveDatabase()
  }

  return { created, updated, removed }
}

export async function renamePlaylist(id: number, name: string): Promise<void> {
  if (!db) return
  db.run('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?', [name, Date.now(), id])
  await saveDatabase()
}

export async function deletePlaylist(id: number): Promise<void> {
  if (!db) return
  // Tombstone sync-eligible playlists so a mobile LAN sync propagates the
  // deletion (server-mirrored playlists are excluded from that sync).
  const row = db.get<{ sync_uid?: unknown; remote_source_id?: unknown }>(
    'SELECT sync_uid, remote_source_id FROM playlists WHERE id = ?',
    [id]
  )
  if (
    row &&
    typeof row.sync_uid === 'string' &&
    row.sync_uid.length > 0 &&
    (row.remote_source_id === null || row.remote_source_id === undefined)
  ) {
    db.run('INSERT OR REPLACE INTO playlist_tombstones (sync_uid, deleted_at) VALUES (?, ?)', [row.sync_uid, Date.now()])
  }
  db.run('DELETE FROM playlist_tracks WHERE playlist_id = ?', [id])
  db.run('DELETE FROM playlists WHERE id = ?', [id])
  await saveDatabase()
}

export async function markPlaylistPlayed(id: number): Promise<void> {
  if (!db) return
  if (id <= 0) return
  db.run('UPDATE playlists SET last_played_at = ? WHERE id = ?', [Date.now(), id])
  await saveDatabase()
}

export function getPlaylistTracks(playlistId: number): DbTrack[] {
  if (getPlaylistKindById(playlistId) === 'dynamic') {
    return getDynamicPlaylistTracksForId(playlistId)
  }

  return readEffectiveTracks(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
    INNER JOIN playlist_tracks pt ON pt.track_path = t.path
    WHERE pt.playlist_id = ${playlistId}
    ORDER BY pt.position ASC, pt.id ASC
  `)
}

type PlaylistTrackEntryRow = Partial<DbTrackRow> & {
  playlist_track_id?: unknown
  playlist_track_path?: unknown
  playlist_position?: unknown
  playlist_added_at?: unknown
  fallback_title?: unknown
  fallback_artist?: unknown
  fallback_album?: unknown
}

function getDynamicPlaylistTrackEntries(playlistId: number): PlaylistTrackEntry[] {
  return getDynamicPlaylistTracksForId(playlistId).map((track, index) => ({
    id: -(index + 1),
    track_path: track.path,
    position: index,
    added_at: track.added_at,
    missing: false,
    title: null,
    artist: null,
    album: null,
    track
  }))
}

export function getPlaylistTrackEntries(playlistId: number): PlaylistTrackEntry[] {
  if (!db) return []
  if (!Number.isInteger(playlistId) || playlistId <= 0) return []
  if (getPlaylistKindById(playlistId) === 'dynamic') {
    return getDynamicPlaylistTrackEntries(playlistId)
  }

  const rows = db.all<PlaylistTrackEntryRow>(`
    SELECT
      pt.id AS playlist_track_id,
      pt.track_path AS playlist_track_path,
      pt.position AS playlist_position,
      pt.added_at AS playlist_added_at,
      pt.fallback_title AS fallback_title,
      pt.fallback_artist AS fallback_artist,
      pt.fallback_album AS fallback_album,
      ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    FROM playlist_tracks pt
    LEFT JOIN tracks t ON t.path = pt.track_path
    LEFT JOIN track_metadata_overrides o ON o.track_path = t.path
    WHERE pt.playlist_id = ?
    ORDER BY pt.position ASC, pt.id ASC
  `, [playlistId])

  const availableRows: DbTrackRow[] = []
  for (const row of rows) {
    if (typeof row.path === 'string' && Number(row.id) > 0) {
      availableRows.push(row as DbTrackRow)
    }
  }
  const tracksByPath = new Map(attachAlbumIdentityKeys(availableRows).map((track) => [track.path, track]))

  return rows.map((row, index) => {
    const entryId = Number(row.playlist_track_id)
    const position = Number(row.playlist_position)
    const addedAt = Number(row.playlist_added_at)
    const trackPath = typeof row.playlist_track_path === 'string' ? row.playlist_track_path : ''
    if (!Number.isInteger(entryId) || entryId <= 0 || !trackPath) {
      throw new Error('Invalid playlist track rows for playlist entry lookup.')
    }

    const track = tracksByPath.get(trackPath) ?? null
    return {
      id: entryId,
      track_path: trackPath,
      position: Number.isFinite(position) ? position : index,
      added_at: Number.isFinite(addedAt) ? addedAt : 0,
      missing: track === null,
      title: typeof row.fallback_title === 'string' && row.fallback_title.trim().length > 0 ? row.fallback_title : null,
      artist: typeof row.fallback_artist === 'string' && row.fallback_artist.trim().length > 0 ? row.fallback_artist : null,
      album: typeof row.fallback_album === 'string' && row.fallback_album.trim().length > 0 ? row.fallback_album : null,
      track
    }
  })
}

interface PlaylistEntryInsertInput {
  trackPath: string
  fallbackTitle?: string | null
  fallbackArtist?: string | null
  fallbackAlbum?: string | null
}

async function addPlaylistEntries(
  playlistId: number,
  entries: PlaylistEntryInsertInput[],
  options: { preserveOccurrences?: boolean } = {}
): Promise<void> {
  if (!db || entries.length === 0) return

  const normalizedEntries: PlaylistEntryInsertInput[] = []
  for (const entry of entries) {
    const trackPath = typeof entry.trackPath === 'string' ? entry.trackPath.trim() : ''
    if (!trackPath) continue
    normalizedEntries.push({
      trackPath,
      fallbackTitle: normalizeOptionalTextField(entry.fallbackTitle ?? null),
      fallbackArtist: normalizeOptionalTextField(entry.fallbackArtist ?? null),
      fallbackAlbum: normalizeOptionalTextField(entry.fallbackAlbum ?? null)
    })
  }
  if (normalizedEntries.length === 0) return

  let pendingEntries = normalizedEntries
  if (!options.preserveOccurrences) {
    const existingTrackPaths = new Set<string>()
    for (const row of db.iterate<{ track_path?: unknown }>('SELECT track_path FROM playlist_tracks WHERE playlist_id = ?', [playlistId])) {
      if (typeof row.track_path === 'string' && row.track_path.length > 0) {
        existingTrackPaths.add(row.track_path)
      }
    }

    const seenTrackPaths = new Set(existingTrackPaths)
    pendingEntries = normalizedEntries.filter((entry) => {
      if (seenTrackPaths.has(entry.trackPath)) return false
      seenTrackPaths.add(entry.trackPath)
      return true
    })
  }
  if (pendingEntries.length === 0) return

  const maxPosRow = db.get<{ max_pos?: unknown }>('SELECT COALESCE(MAX(position), -1) as max_pos FROM playlist_tracks WHERE playlist_id = ?', [playlistId])
  const maxPos = typeof maxPosRow?.max_pos === 'number' ? maxPosRow.max_pos : -1
  let position = maxPos + 1
  const now = Date.now()
  for (const entry of pendingEntries) {
    db.run(
      'INSERT INTO playlist_tracks (playlist_id, track_path, position, added_at, fallback_title, fallback_artist, fallback_album) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [playlistId, entry.trackPath, position++, now, entry.fallbackTitle ?? null, entry.fallbackArtist ?? null, entry.fallbackAlbum ?? null]
    )
  }
  db.run('UPDATE playlists SET updated_at = ? WHERE id = ?', [now, playlistId])
  await saveDatabase()
}

export async function addToPlaylist(playlistId: number, trackPaths: string[]): Promise<void> {
  assertNormalPlaylist(playlistId, 'accept manual tracks')
  await addPlaylistEntries(playlistId, trackPaths.map((trackPath) => ({ trackPath })))
}

export async function removeFromPlaylist(playlistId: number, trackPath: string): Promise<void> {
  if (!db) return
  assertNormalPlaylist(playlistId, 'remove tracks manually')
  db.run('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_path = ?', [playlistId, trackPath])
  renumberPlaylistEntries(playlistId)
  db.run('UPDATE playlists SET updated_at = ? WHERE id = ?', [Date.now(), playlistId])
  await saveDatabase()
}

function renumberPlaylistEntries(playlistId: number): void {
  if (!db) return
  const idRows: Array<{ id?: unknown }> = []
  for (const row of db.iterate<{ id?: unknown }>('SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC, id ASC', [playlistId])) {
    idRows.push(row)
  }
  idRows.forEach((row, i) => {
    db!.run('UPDATE playlist_tracks SET position = ? WHERE id = ?', [i, row.id])
  })
}

export async function removePlaylistEntry(playlistId: number, entryId: number): Promise<void> {
  if (!db) return
  assertNormalPlaylist(playlistId, 'remove tracks manually')
  if (!Number.isInteger(entryId) || entryId <= 0) return

  const result = db.run('DELETE FROM playlist_tracks WHERE playlist_id = ? AND id = ?', [playlistId, entryId])
  if (result.changes <= 0) return

  renumberPlaylistEntries(playlistId)
  db.run('UPDATE playlists SET updated_at = ? WHERE id = ?', [Date.now(), playlistId])
  await saveDatabase()
}

export async function moveCompanionApiPlaylistTrack(
  playlistId: number,
  trackPath: string,
  requestedPosition: number
): Promise<boolean> {
  if (!db || !isCompanionApiPlaylistWritable(playlistId)) return false
  if (typeof trackPath !== 'string' || !trackPath || !Number.isInteger(requestedPosition) || requestedPosition < 0) {
    return false
  }

  const rows = db.all<{ id?: unknown; track_path?: unknown }>(`
    SELECT id, track_path
    FROM playlist_tracks
    WHERE playlist_id = ?
    ORDER BY position ASC, id ASC
  `, [playlistId])
  const currentIndex = rows.findIndex((row) => row.track_path === trackPath)
  if (currentIndex < 0) return false

  const [moved] = rows.splice(currentIndex, 1)
  const targetIndex = Math.min(requestedPosition, rows.length)
  rows.splice(targetIndex, 0, moved)
  const now = Date.now()
  beginLibraryWriteTransaction()
  try {
    rows.forEach((row, index) => {
      db!.run('UPDATE playlist_tracks SET position = ? WHERE id = ?', [index, row.id])
    })
    db!.run('UPDATE playlists SET updated_at = ? WHERE id = ?', [now, playlistId])
    commitLibraryWriteTransaction()
  } catch (error) {
    rollbackLibraryWriteTransaction()
    throw error
  }
  await saveDatabase()
  return true
}

export async function reassociatePlaylistEntry(
  playlistId: number,
  entryId: number,
  targetTrackPath: string
): Promise<void> {
  if (!db) throw new Error('Database not initialized')
  if (!Number.isInteger(playlistId) || playlistId <= 0) {
    throw new Error('Playlist not found.')
  }
  if (!Number.isInteger(entryId) || entryId <= 0) {
    throw new Error('Playlist entry not found.')
  }

  const playlistKind = getPlaylistKindById(playlistId)
  if (playlistKind === null) {
    throw new Error('Playlist not found.')
  }
  if (playlistKind !== 'normal') {
    throw new Error('Dynamic playlists cannot change associated files.')
  }

  const entry = db.get<{ track_path?: unknown; indexed_track_path?: unknown }>(`
    SELECT pt.track_path, t.path AS indexed_track_path
    FROM playlist_tracks pt
    LEFT JOIN tracks t ON t.path = pt.track_path
    WHERE pt.playlist_id = ? AND pt.id = ?
    LIMIT 1
  `, [playlistId, entryId])
  if (!entry) {
    throw new Error('Playlist entry not found.')
  }
  if (typeof entry.indexed_track_path === 'string') {
    throw new Error('Only missing playlist entries can change their associated file.')
  }

  const normalizedTargetPath = typeof targetTrackPath === 'string' ? targetTrackPath.trim() : ''
  const targetTrack = normalizedTargetPath ? getTrackByPath(normalizedTargetPath) : null
  if (!targetTrack || targetTrack.source_type !== 'local' || targetTrack.is_available !== 1) {
    throw new Error("That file isn't in your Astra library. Add or rescan its folder first.")
  }

  db.run(`
    UPDATE playlist_tracks
    SET track_path = ?, fallback_title = ?, fallback_artist = ?, fallback_album = ?
    WHERE playlist_id = ? AND id = ?
  `, [targetTrack.path, targetTrack.title, targetTrack.artist, targetTrack.album, playlistId, entryId])
  db.run('UPDATE playlists SET updated_at = ? WHERE id = ?', [Date.now(), playlistId])
  await saveDatabase()
}

export async function reorderPlaylistEntries(playlistId: number, orderedEntryIds: number[]): Promise<void> {
  if (!db) return
  if (!Number.isInteger(playlistId) || playlistId <= 0) return
  assertNormalPlaylist(playlistId, 'reorder tracks manually')
  if (!Array.isArray(orderedEntryIds) || orderedEntryIds.length === 0) return

  const existingEntryIds: number[] = []

  for (const row of db.iterate<{ id?: unknown }>('SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC, id ASC', [playlistId])) {
    const rowId = Number(row.id)
    if (!Number.isInteger(rowId) || rowId <= 0) {
      throw new Error('Invalid playlist track rows for reorder operation.')
    }
    existingEntryIds.push(rowId)
  }

  if (existingEntryIds.length === 0) {
    throw new Error('Cannot reorder an empty playlist.')
  }

  if (orderedEntryIds.length !== existingEntryIds.length) {
    throw new Error('Playlist reorder payload length does not match current playlist tracks.')
  }

  const existingEntryIdSet = new Set(existingEntryIds)
  const orderedEntryIdSet = new Set<number>()
  for (const entryId of orderedEntryIds) {
    if (!Number.isInteger(entryId) || entryId <= 0) {
      throw new Error('Playlist reorder payload contains an invalid entry id.')
    }
    if (!existingEntryIdSet.has(entryId) || orderedEntryIdSet.has(entryId)) {
      throw new Error('Playlist reorder payload does not match current playlist content.')
    }
    orderedEntryIdSet.add(entryId)
  }

  const now = Date.now()
  for (let index = 0; index < orderedEntryIds.length; index += 1) {
    db.run('UPDATE playlist_tracks SET position = ? WHERE id = ?', [index, orderedEntryIds[index]])
  }
  db.run('UPDATE playlists SET updated_at = ? WHERE id = ?', [now, playlistId])

  await saveDatabase()
}

function normalizePlaylistCoverExtension(imagePath: string): string {
  const rawExtension = extname(imagePath).toLowerCase()
  if (rawExtension === '.png') return '.png'
  if (rawExtension === '.webp') return '.webp'
  if (rawExtension === '.gif') return '.gif'
  if (rawExtension === '.bmp') return '.bmp'
  if (rawExtension === '.jpg' || rawExtension === '.jpeg') return '.jpg'
  return '.jpg'
}

export async function setPlaylistCustomCoverFromFile(playlistId: number, imagePath: string): Promise<void> {
  if (!db || playlistId <= 0) return

  const normalizedPath = imagePath.trim()
  if (!normalizedPath) return

  const imageData = await readFile(normalizedPath)
  if (imageData.length === 0) return

  const extension = normalizePlaylistCoverExtension(normalizedPath)
  const contentHash = createHash('sha256').update(imageData).digest('hex')
  const fileName = `${contentHash}${extension}`
  const prefixedHash = `${PLAYLIST_COVER_HASH_PREFIX}${fileName}`
  const targetPath = join(playlistCoverDir, fileName)

  try {
    await writeFile(targetPath, imageData, { flag: 'wx' })
  } catch (error: unknown) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
      throw error
    }
  }

  db.run('UPDATE playlists SET custom_cover_hash = ?, updated_at = ? WHERE id = ?', [prefixedHash, Date.now(), playlistId])
  await saveDatabase()
}

export async function clearPlaylistCustomCover(playlistId: number): Promise<void> {
  if (!db || playlistId <= 0) return
  db.run('UPDATE playlists SET custom_cover_hash = NULL, updated_at = ? WHERE id = ?', [Date.now(), playlistId])
  await saveDatabase()
}

export function getPlaylistsContainingTrack(trackPath: string): number[] {
  if (!db) return []
  const ids: number[] = []
  for (const row of db.iterate<{ playlist_id?: unknown }>('SELECT DISTINCT playlist_id FROM playlist_tracks WHERE track_path = ? ORDER BY playlist_id', [trackPath])) {
    const playlistId = Number(row.playlist_id)
    if (Number.isFinite(playlistId) && playlistId > 0) {
      ids.push(playlistId)
    }
  }
  return ids
}

export interface PlaylistTrackMembershipSummary {
  playlistId: number
  matchedTrackCount: number
}

export function getPlaylistsContainingTracks(trackPaths: string[]): PlaylistTrackMembershipSummary[] {
  if (!db || !Array.isArray(trackPaths) || trackPaths.length === 0) return []

  const uniqueTrackPaths: string[] = []
  const seen = new Set<string>()
  for (const trackPath of trackPaths) {
    if (typeof trackPath !== 'string') continue
    const normalizedPath = trackPath.trim()
    if (!normalizedPath || seen.has(normalizedPath)) continue
    seen.add(normalizedPath)
    uniqueTrackPaths.push(normalizedPath)
  }
  if (uniqueTrackPaths.length === 0) return []

  const summaryByPlaylistId = new Map<number, number>()
  for (let offset = 0; offset < uniqueTrackPaths.length; offset += SQLITE_SAFE_MAX_VARIABLES) {
    const chunk = uniqueTrackPaths.slice(offset, offset + SQLITE_SAFE_MAX_VARIABLES)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = db.all<{ playlist_id?: unknown; matched_track_count?: unknown }>(`
      SELECT playlist_id, COUNT(DISTINCT track_path) AS matched_track_count
      FROM playlist_tracks
      WHERE track_path IN (${placeholders})
      GROUP BY playlist_id
      ORDER BY playlist_id
    `, chunk)

    for (const row of rows) {
      const playlistId = Number(row.playlist_id)
      const matchedTrackCount = Number(row.matched_track_count)
      if (!Number.isInteger(playlistId) || playlistId <= 0 || !Number.isFinite(matchedTrackCount) || matchedTrackCount <= 0) {
        continue
      }
      summaryByPlaylistId.set(playlistId, (summaryByPlaylistId.get(playlistId) ?? 0) + matchedTrackCount)
    }
  }

  return Array.from(summaryByPlaylistId.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([playlistId, matchedTrackCount]) => ({ playlistId, matchedTrackCount }))
}

interface PlaylistImportLookupIndex {
  exactPath: Map<string, string>
  caseInsensitivePath: Map<string, string | null>
  metadataByTitleArtistAlbum: Map<string, string | null>
  metadataByTitleArtist: Map<string, string | null>
  metadataByTitle: Map<string, string | null>
}

type MetadataMatchResult =
  | { kind: 'matched'; trackPath: string }
  | { kind: 'ambiguous' }
  | { kind: 'none' }

function buildPlaylistImportLookupIndex(
  tracks: Array<Pick<DbTrackRow, 'path' | 'title' | 'artist' | 'artist_names_json' | 'album' | 'album_artist_names_json'>>
): PlaylistImportLookupIndex {
  const index: PlaylistImportLookupIndex = {
    exactPath: new Map(),
    caseInsensitivePath: new Map(),
    metadataByTitleArtistAlbum: new Map(),
    metadataByTitleArtist: new Map(),
    metadataByTitle: new Map()
  }

  for (const track of tracks) {
    const normalizedTrackPath = normalizePlaylistPathForLookup(track.path)
    if (normalizedTrackPath) {
      index.exactPath.set(normalizedTrackPath, track.path)
      upsertUniqueLookupEntry(index.caseInsensitivePath, normalizedTrackPath.toLocaleLowerCase(), track.path)
    }

    const titleKey = normalizeKey(track.title)
    const artistKeys = new Set<string>()
    const displayArtistKey = normalizeKey(track.artist)
    if (displayArtistKey) artistKeys.add(displayArtistKey)
    for (const artistName of getParsedTrackArtistNames(track)) {
      const key = normalizeKey(artistName)
      if (key) artistKeys.add(key)
    }
    for (const artistName of getParsedAlbumArtistNames(track)) {
      const key = normalizeKey(artistName)
      if (key) artistKeys.add(key)
    }
    const albumKey = normalizeKey(track.album)

    if (titleKey) {
      upsertUniqueLookupEntry(index.metadataByTitle, titleKey, track.path)
    }
    for (const artistKey of artistKeys) {
      if (titleKey && artistKey) {
        upsertUniqueLookupEntry(index.metadataByTitleArtist, `${titleKey}\u0000${artistKey}`, track.path)
      }
      if (titleKey && artistKey && albumKey) {
        upsertUniqueLookupEntry(index.metadataByTitleArtistAlbum, `${titleKey}\u0000${artistKey}\u0000${albumKey}`, track.path)
      }
    }
  }

  return index
}

function upsertUniqueLookupEntry(map: Map<string, string | null>, key: string, value: string): void {
  if (!key) return
  const existing = map.get(key)
  if (existing === undefined) {
    map.set(key, value)
    return
  }
  if (existing !== value) {
    map.set(key, null)
  }
}

function matchPlaylistEntryByMetadata(entry: ParsedPlaylistEntry, index: PlaylistImportLookupIndex): MetadataMatchResult {
  const titleKey = normalizeKey(entry.title ?? '')
  if (!titleKey) {
    return { kind: 'none' }
  }

  const artistKey = normalizeKey(entry.artist ?? '')
  const albumKey = normalizeKey(entry.album ?? '')

  if (artistKey && albumKey) {
    const candidate = index.metadataByTitleArtistAlbum.get(`${titleKey}\u0000${artistKey}\u0000${albumKey}`)
    if (typeof candidate === 'string') return { kind: 'matched', trackPath: candidate }
    if (candidate === null) return { kind: 'ambiguous' }
  }

  if (artistKey) {
    const candidate = index.metadataByTitleArtist.get(`${titleKey}\u0000${artistKey}`)
    if (typeof candidate === 'string') return { kind: 'matched', trackPath: candidate }
    if (candidate === null) return { kind: 'ambiguous' }
  }

  const titleOnlyCandidate = index.metadataByTitle.get(titleKey)
  if (typeof titleOnlyCandidate === 'string') return { kind: 'matched', trackPath: titleOnlyCandidate }
  if (titleOnlyCandidate === null) return { kind: 'ambiguous' }

  return { kind: 'none' }
}

function deriveImportedPlaylistName(filePath: string): string {
  const rawName = basename(filePath, extname(filePath)).trim()
  return rawName.length > 0 ? rawName : 'Imported Playlist'
}

function normalizePreservedPlaylistImportEntryPath(rawPath: string): string | null {
  const normalized = stripPlaylistEntryOuterQuotes(rawPath.trim())
  return normalized.length > 0 ? normalized : null
}

const SYSTEM_FAVORITES_PLAYLIST_ID = -1

interface PlaylistM3uExportEntry {
  trackPath: string
  title: string | null
  artist: string | null
  duration: number | null
  sourceType: TrackSourceType | null
}

function derivePlaylistExportFormat(filePath: string): 'm3u' | 'm3u8' {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.m3u') return 'm3u'
  if (extension === '.m3u8') return 'm3u8'
  throw new Error('Unsupported playlist export format. Use .m3u or .m3u8.')
}

function isWindowsAbsolutePlaylistPath(inputPath: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(inputPath)
    || /^\\\\[^\\]/.test(inputPath)
    || /^\/\/[^/]/.test(inputPath)
}

function hasNonFilePlaylistUriScheme(inputPath: string): boolean {
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(inputPath)
  if (!schemeMatch || isWindowsAbsolutePlaylistPath(inputPath)) return false
  return schemeMatch[1].toLocaleLowerCase() !== 'file'
}

function canWriteRelativeM3uPath(inputPath: string): boolean {
  if (process.platform !== 'win32' && isWindowsAbsolutePlaylistPath(inputPath)) {
    return false
  }
  return isAbsolutePath(inputPath)
}

function normalizeM3uLineValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function normalizeM3uPathValue(value: string): string {
  return normalizeM3uLineValue(value).replace(/\\/g, '/')
}

function basenameFromPlaylistPath(value: string): string {
  const normalized = normalizeM3uLineValue(value)
  const parts = normalized.split(/[\\/]/)
  return parts[parts.length - 1] || normalized
}

function formatM3uDuration(duration: number | null): number {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
    return -1
  }
  return Math.max(0, Math.round(duration))
}

function formatM3uDisplayTitle(entry: PlaylistM3uExportEntry): string {
  const title = normalizeM3uLineValue(entry.title ?? '')
  const artist = normalizeM3uLineValue(entry.artist ?? '')

  if (title && artist) return `${artist} - ${title}`
  if (title) return title
  if (artist) return artist
  return basenameFromPlaylistPath(entry.trackPath)
}

function formatM3uEntryPath(entry: PlaylistM3uExportEntry, exportFilePath: string): string {
  const rawPath = normalizeM3uLineValue(entry.trackPath)
  if (!rawPath) return rawPath

  if (entry.sourceType === 'local' && canWriteRelativeM3uPath(rawPath)) {
    const relativeExportPath = relativePath(dirname(exportFilePath), rawPath)
    if (relativeExportPath && !isAbsolutePath(relativeExportPath)) {
      return normalizeM3uPathValue(relativeExportPath)
    }
  }

  return normalizeM3uPathValue(rawPath)
}

function serializePlaylistEntriesToM3u(entries: PlaylistM3uExportEntry[], exportFilePath: string): string {
  const lines = ['#EXTM3U']

  for (const entry of entries) {
    const entryPath = formatM3uEntryPath(entry, exportFilePath)
    if (!entryPath) continue

    lines.push(`#EXTINF:${formatM3uDuration(entry.duration)},${formatM3uDisplayTitle(entry)}`)
    lines.push(entryPath)
  }

  return `${lines.join('\n')}\n`
}

function getPlaylistM3uExportEntries(playlistId: number): PlaylistM3uExportEntry[] {
  if (!db) throw new Error('Database not initialized')
  if (!Number.isInteger(playlistId)) {
    throw new Error('Playlist id is required.')
  }

  if (playlistId === SYSTEM_FAVORITES_PLAYLIST_ID) {
    return getFavorites().map((track) => ({
      trackPath: track.path,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
      sourceType: track.source_type
    }))
  }

  if (playlistId <= 0) {
    throw new Error('Playlist id is required.')
  }

  const playlistRow = db.get<{ id?: unknown }>('SELECT id FROM playlists WHERE id = ? LIMIT 1', [playlistId])
  if (!playlistRow) {
    throw new Error('Playlist not found.')
  }

  return getPlaylistTrackEntries(playlistId).map((entry) => ({
    trackPath: entry.track_path,
    title: entry.track?.title ?? entry.title,
    artist: entry.track?.artist ?? entry.artist,
    duration: entry.track?.duration ?? null,
    sourceType: entry.track?.source_type ?? (hasNonFilePlaylistUriScheme(entry.track_path) ? null : 'local')
  }))
}

function countPotentiallyNonPortableM3uEntries(entries: PlaylistM3uExportEntry[]): number {
  return entries.reduce((count, entry) => {
    if (entry.sourceType && entry.sourceType !== 'local') {
      return count + 1
    }
    if (entry.sourceType === null && hasNonFilePlaylistUriScheme(entry.trackPath)) {
      return count + 1
    }
    return count
  }, 0)
}

export async function exportPlaylistToM3u(playlistId: number, filePath: string): Promise<PlaylistExportResult> {
  if (!db) throw new Error('Database not initialized')

  const exportFilePath = filePath.trim()
  if (!exportFilePath) {
    throw new Error('Playlist export file path is required.')
  }

  const format = derivePlaylistExportFormat(exportFilePath)
  const entries = getPlaylistM3uExportEntries(playlistId)
  const warnings: string[] = []
  const nonPortableEntryCount = countPotentiallyNonPortableM3uEntries(entries)
  if (nonPortableEntryCount > 0) {
    warnings.push(`${nonPortableEntryCount} entries reference remote or app-specific locations and may not work outside Astra.`)
  }

  await writeFile(exportFilePath, serializePlaylistEntriesToM3u(entries, exportFilePath), 'utf-8')

  return {
    filePath: exportFilePath,
    format,
    playlistId,
    exportedCount: entries.length,
    warnings
  }
}

function reconcileMissingPlaylistEntriesByMetadata(): number {
  if (!db) return 0

  const rows = db.all<{
    id?: unknown
    playlist_id?: unknown
    fallback_title?: unknown
    fallback_artist?: unknown
    fallback_album?: unknown
  }>(`
    SELECT
      pt.id,
      pt.playlist_id,
      pt.fallback_title,
      pt.fallback_artist,
      pt.fallback_album
    FROM playlist_tracks pt
    LEFT JOIN tracks t ON t.path = pt.track_path
    WHERE t.path IS NULL
      AND pt.fallback_title IS NOT NULL
      AND TRIM(pt.fallback_title) <> ''
    ORDER BY pt.playlist_id ASC, pt.position ASC, pt.id ASC
  `)
  if (rows.length === 0) return 0

  const lookup = buildPlaylistImportLookupIndex(readAllTrackRowsUnordered())
  let reconciled = 0

  for (const row of rows) {
    const rowId = Number(row.id)
    const playlistId = Number(row.playlist_id)
    if (!Number.isInteger(rowId) || rowId <= 0 || !Number.isInteger(playlistId) || playlistId <= 0) {
      continue
    }

    const metadataMatch = matchPlaylistEntryByMetadata({
      title: typeof row.fallback_title === 'string' ? row.fallback_title : undefined,
      artist: typeof row.fallback_artist === 'string' ? row.fallback_artist : undefined,
      album: typeof row.fallback_album === 'string' ? row.fallback_album : undefined
    }, lookup)
    if (metadataMatch.kind !== 'matched') continue

    const result = db.run(
      'UPDATE playlist_tracks SET track_path = ? WHERE id = ?',
      [metadataMatch.trackPath, rowId]
    )
    if (result.changes > 0) {
      reconciled += result.changes
    }
  }

  return reconciled
}

function snapshotPlaylistFallbackMetadata(track: { path: string; title: string; artist: string; album: string }): void {
  if (!db) return
  db.run(`
    UPDATE playlist_tracks
    SET
      fallback_title = CASE
        WHEN fallback_title IS NULL OR TRIM(fallback_title) = '' THEN ?
        ELSE fallback_title
      END,
      fallback_artist = CASE
        WHEN fallback_artist IS NULL OR TRIM(fallback_artist) = '' THEN ?
        ELSE fallback_artist
      END,
      fallback_album = CASE
        WHEN fallback_album IS NULL OR TRIM(fallback_album) = '' THEN ?
        ELSE fallback_album
      END
    WHERE track_path = ?
  `, [track.title, track.artist, track.album, track.path])
}

export async function importPlaylistFromFile(filePath: string): Promise<PlaylistImportResult> {
  if (!db) throw new Error('Database not initialized')

  const sourceFilePath = filePath.trim()
  if (!sourceFilePath) {
    throw new Error('Playlist file path is required.')
  }

  const content = await readFile(sourceFilePath, 'utf-8')
  const parsed = parsePlaylistDocument(sourceFilePath, content)
  const lookup = buildPlaylistImportLookupIndex(readAllTrackRowsUnordered())
  const matchedTrackPaths: string[] = []
  const playlistEntries: PlaylistEntryInsertInput[] = []
  const warnings = [...parsed.warnings]

  let matchedByPathCount = 0
  let matchedByMetadataCount = 0
  let missingEntryCount = 0
  let unmatchedCount = 0
  let ambiguousMetadataCount = 0
  let unsupportedEntryCount = 0

  for (const entry of parsed.entries) {
    let matchedTrackPath: string | null = null
    let missingTrackPath: string | null = null
    let hasUnsupportedPath = false

    if (entry.path) {
      const resolvedPaths = resolveImportedPlaylistEntryPaths(entry.path, sourceFilePath)
      if (!resolvedPaths) {
        hasUnsupportedPath = true
        missingTrackPath = normalizePreservedPlaylistImportEntryPath(entry.path)
      } else {
        missingTrackPath = resolvedPaths[0]?.normalizedPath ?? null
        for (const resolvedPath of resolvedPaths) {
          matchedTrackPath = lookup.exactPath.get(resolvedPath.normalizedPath)
            ?? null

          if (!matchedTrackPath) {
            const caseInsensitiveMatch = lookup.caseInsensitivePath.get(resolvedPath.caseInsensitivePath)
            if (typeof caseInsensitiveMatch === 'string') {
              matchedTrackPath = caseInsensitiveMatch
            }
          }

          if (matchedTrackPath) break
        }

        if (matchedTrackPath) {
          matchedByPathCount += 1
        }
      }
    }

    if (!matchedTrackPath) {
      const metadataMatch = matchPlaylistEntryByMetadata(entry, lookup)
      if (metadataMatch.kind === 'matched') {
        matchedTrackPath = metadataMatch.trackPath
        matchedByMetadataCount += 1
      } else if (metadataMatch.kind === 'ambiguous') {
        if (missingTrackPath) {
          playlistEntries.push({
            trackPath: missingTrackPath,
            fallbackTitle: entry.title ?? null,
            fallbackArtist: entry.artist ?? null,
            fallbackAlbum: entry.album ?? null
          })
          missingEntryCount += 1
          unmatchedCount += 1
          continue
        }
        ambiguousMetadataCount += 1
        if (hasUnsupportedPath) {
          unsupportedEntryCount += 1
        }
        unmatchedCount += 1
        continue
      }
    }

    if (!matchedTrackPath) {
      if (missingTrackPath) {
        playlistEntries.push({
          trackPath: missingTrackPath,
          fallbackTitle: entry.title ?? null,
          fallbackArtist: entry.artist ?? null,
          fallbackAlbum: entry.album ?? null
        })
        missingEntryCount += 1
        unmatchedCount += 1
        continue
      }
      if (hasUnsupportedPath) {
        unsupportedEntryCount += 1
      }
      unmatchedCount += 1
      continue
    }

    matchedTrackPaths.push(matchedTrackPath)
    playlistEntries.push({ trackPath: matchedTrackPath })
  }

  const importedCount = matchedTrackPaths.length
  let playlistId: number | null = null
  let playlistName: string | null = null

  if (playlistEntries.length > 0) {
    playlistName = deriveImportedPlaylistName(sourceFilePath)
    const playlist = await createPlaylist(playlistName)
    await addPlaylistEntries(playlist.id, playlistEntries, { preserveOccurrences: true })
    playlistId = playlist.id
  }

  if (unsupportedEntryCount > 0) {
    warnings.push(`${unsupportedEntryCount} entries were skipped due to unsupported path/URI formats.`)
  }
  if (ambiguousMetadataCount > 0) {
    warnings.push(`${ambiguousMetadataCount} entries were skipped due to ambiguous metadata matches.`)
  }
  if (missingEntryCount > 0) {
    warnings.push(`${missingEntryCount} unmatched entries were preserved as missing playlist tracks.`)
  }
  const unmatchedNonAmbiguous = unmatchedCount - ambiguousMetadataCount - missingEntryCount
  if (unmatchedNonAmbiguous > 0) {
    warnings.push(`${unmatchedNonAmbiguous} entries could not be matched to library tracks.`)
  }

  return {
    sourceFilePath,
    detectedFormat: parsed.detectedFormat,
    playlistId,
    playlistName,
    entriesTotal: parsed.entries.length,
    importedCount,
    missingEntryCount,
    matchedByPathCount,
    matchedByMetadataCount,
    unmatchedCount,
    ambiguousMetadataCount,
    unsupportedEntryCount,
    warnings
  }
}

// Remove tracks that no longer exist on disk
export async function cleanupMissingTracks(options: ScanWriteOptions = {}): Promise<number> {
  const { persist = true, signal, onIssue } = options
  if (!db) return 0

  const tracks = db.all<{ id: number; path: string; title: string; artist: string; album: string }>(`
    SELECT
      t.id,
      t.path,
      COALESCE(o.title, t.title) AS title,
      COALESCE(o.artist, t.artist) AS artist,
      COALESCE(o.album, t.album) AS album
    FROM tracks t
    LEFT JOIN track_metadata_overrides o ON o.track_path = t.path
    WHERE t.source_type = 'local'
  `)
  let removed = 0
  const caseFoldedGroups = comparableFsPathFoldsCase()
    ? new Map<string, Array<{ id: number; path: string; dev: number; ino: number }>>()
    : null

  for (const track of tracks) {
    throwIfScanCancelled(signal)
    try {
      const trackStat = await stat(track.path)
      if (caseFoldedGroups) {
        const key = normalizeComparableFsPath(track.path)
        const entry = { id: track.id, path: track.path, dev: trackStat.dev, ino: trackStat.ino }
        const group = caseFoldedGroups.get(key)
        if (group) group.push(entry)
        else caseFoldedGroups.set(key, [entry])
      }
    } catch (err: unknown) {
      const code = getErrorCode(err)
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        snapshotPlaylistFallbackMetadata(track)
        db.run('DELETE FROM tracks WHERE id = ?', [track.id])
        removed++
      } else {
        onIssue?.(createLibraryScanIssue('cleanup', track.path, err))
        console.warn(`Failed to validate track during cleanup for ${track.path}:`, err)
      }
    }
  }

  // Case-variant duplicate rows for one physical file (casing-only folder
  // rename, #180): stat resolves for every casing on a case-insensitive FS,
  // so the missing-file path above never prunes them. Collapse each group
  // whose rows all point at the same inode; the folder's next scan repairs
  // the surviving row's casing. Mixed inodes mean genuinely distinct files
  // on a case-sensitive volume — leave those alone.
  if (caseFoldedGroups) {
    for (const group of caseFoldedGroups.values()) {
      if (group.length < 2) continue
      const first = group[0]
      if (!group.every((entry) => entry.dev === first.dev && entry.ino === first.ino)) continue
      const survivor = group.reduce((lowest, entry) => (entry.id < lowest.id ? entry : lowest))
      const losers = group.filter((entry) => entry.id !== survivor.id)
      mergeDuplicateTrackRows(survivor.id, survivor.path, losers)
      removed += losers.length
    }
  }

  throwIfScanCancelled(signal)
  const reconciled = reconcileMissingPlaylistEntriesByMetadata()
  if (persist && (removed > 0 || reconciled > 0)) {
    await saveDatabase()
  }

  return removed
}

// ── Desktop<->Mobile LAN sync (phoneSync.ts) ─────────────────────────────────
// Favorites and playlist entries cross devices as metadata identity keys
// (shared/sync/identity.ts); playlists cross as sync_uid rows. Everything here
// either serializes local state for GET /v1/sync/state or applies a merged
// diff from POST /v1/sync/apply. Apply-variants deliberately use the caller's
// timestamps and never write tombstones for the rows they touch — otherwise an
// applied change would look like a fresh local edit on the next sync and
// ping-pong between devices.

export interface TrackMetadataQuery {
  title: string
  artist: string
  album: string
  sourcePath?: string | null
}

export type TrackMetadataMatch = MetadataMatchResult

export type TrackMetadataMatcher = (query: TrackMetadataQuery) => TrackMetadataMatch

function trackSyncKeyForPath(trackPath: string): string | null {
  const row = readEffectiveTrackRowsByPaths([trackPath])[0]
  if (!row) return null
  if (!normalizeSyncKeyPart(row.title)) return null
  return buildTrackSyncKey(row.title, row.artist, row.album)
}

function clearFavoriteSyncRowsForPaths(trackPaths: readonly string[]): void {
  if (!db || trackPaths.length === 0) return
  for (const row of readEffectiveTrackRowsByPaths(trackPaths)) {
    if (!normalizeSyncKeyPart(row.title)) continue
    const syncKey = buildTrackSyncKey(row.title, row.artist, row.album)
    db.run('DELETE FROM favorite_tombstones WHERE sync_key = ?', [syncKey])
    db.run('DELETE FROM favorite_sync_pending WHERE sync_key = ?', [syncKey])
  }
}

export function createTrackMetadataMatcher(): TrackMetadataMatcher {
  const lookup = buildPlaylistImportLookupIndex(readAllTrackRowsUnordered())
  return (query) => {
    const sourcePath = typeof query.sourcePath === 'string' ? query.sourcePath.trim() : ''
    if (sourcePath) {
      const normalizedPath = normalizePlaylistPathForLookup(sourcePath)
      if (normalizedPath) {
        const exact = lookup.exactPath.get(normalizedPath)
        if (exact) return { kind: 'matched', trackPath: exact }
        const caseInsensitive = lookup.caseInsensitivePath.get(normalizedPath.toLocaleLowerCase())
        if (typeof caseInsensitive === 'string') return { kind: 'matched', trackPath: caseInsensitive }
      }
    }
    return matchPlaylistEntryByMetadata(
      { title: query.title, artist: query.artist, album: query.album },
      lookup
    )
  }
}

export function ensurePlaylistSyncUids(): void {
  if (!db) return
  const rows = db.all<{ id?: unknown }>(`
    SELECT id FROM playlists
    WHERE sync_uid IS NULL
      AND remote_source_type IS NULL
      AND remote_source_id IS NULL
  `)
  for (const row of rows) {
    const id = Number(row.id)
    if (!Number.isInteger(id) || id <= 0) continue
    // Assigning identity is not an edit: leave updated_at untouched.
    db.run('UPDATE playlists SET sync_uid = ? WHERE id = ?', [randomUUID(), id])
  }
}

export function getSyncFavoritesState(): { favorites: SyncFavorite[]; tombstones: SyncKeyTombstone[] } {
  if (!db) return { favorites: [], tombstones: [] }

  const addedAtByPath = new Map<string, number>()
  for (const row of db.all<{ track_path?: unknown; added_at?: unknown }>('SELECT track_path, added_at FROM favorites')) {
    if (typeof row.track_path === 'string' && row.track_path.length > 0) {
      addedAtByPath.set(row.track_path, Number(row.added_at) || 0)
    }
  }

  const favoritesByKey = new Map<string, SyncFavorite>()
  for (const row of readEffectiveTrackRowsByPaths(Array.from(addedAtByPath.keys()))) {
    if (!normalizeSyncKeyPart(row.title)) continue
    const key = buildTrackSyncKey(row.title, row.artist, row.album)
    const addedAt = addedAtByPath.get(row.path) ?? 0
    const existing = favoritesByKey.get(key)
    if (!existing || existing.addedAt < addedAt) {
      favoritesByKey.set(key, { key, title: row.title, artist: row.artist, album: row.album, addedAt })
    }
  }

  // Pending favorites re-enter sync state so they keep propagating to peers
  // even while unresolved locally.
  for (const row of db.all<{ sync_key?: unknown; title?: unknown; artist?: unknown; album?: unknown; added_at?: unknown }>(
    'SELECT sync_key, title, artist, album, added_at FROM favorite_sync_pending'
  )) {
    if (typeof row.sync_key !== 'string' || row.sync_key.length === 0) continue
    if (favoritesByKey.has(row.sync_key)) continue
    favoritesByKey.set(row.sync_key, {
      key: row.sync_key,
      title: typeof row.title === 'string' ? row.title : '',
      artist: typeof row.artist === 'string' ? row.artist : '',
      album: typeof row.album === 'string' ? row.album : '',
      addedAt: Number(row.added_at) || 0
    })
  }

  const tombstones: SyncKeyTombstone[] = []
  for (const row of db.all<{ sync_key?: unknown; deleted_at?: unknown }>('SELECT sync_key, deleted_at FROM favorite_tombstones')) {
    if (typeof row.sync_key !== 'string' || row.sync_key.length === 0) continue
    tombstones.push({ key: row.sync_key, deletedAt: Number(row.deleted_at) || 0 })
  }

  return { favorites: Array.from(favoritesByKey.values()), tombstones }
}

export function getFavoriteTrackPathsBySyncKey(): Map<string, string[]> {
  const result = new Map<string, string[]>()
  if (!db) return result
  const paths = getFavoritePaths()
  for (const row of readEffectiveTrackRowsByPaths(paths)) {
    if (!normalizeSyncKeyPart(row.title)) continue
    const key = buildTrackSyncKey(row.title, row.artist, row.album)
    const bucket = result.get(key)
    if (bucket) {
      bucket.push(row.path)
    } else {
      result.set(key, [row.path])
    }
  }
  return result
}

export function getSyncPlaylistsState(): { playlists: SyncPlaylist[]; tombstones: SyncUidTombstone[] } {
  if (!db) return { playlists: [], tombstones: [] }

  const playlists: SyncPlaylist[] = []
  const rows = db.all<{
    id?: unknown
    name?: unknown
    kind?: unknown
    dynamic_rules_json?: unknown
    created_at?: unknown
    updated_at?: unknown
    sync_uid?: unknown
  }>(`
    SELECT id, name, kind, dynamic_rules_json, created_at, updated_at, sync_uid
    FROM playlists
    WHERE sync_uid IS NOT NULL
      AND remote_source_type IS NULL
      AND remote_source_id IS NULL
  `)

  for (const row of rows) {
    const id = Number(row.id)
    if (!Number.isInteger(id) || id <= 0) continue
    if (typeof row.sync_uid !== 'string' || row.sync_uid.length === 0) continue
    const kind = row.kind === 'dynamic' ? 'dynamic' : 'normal'

    let entries: SyncPlaylistEntry[] | null = null
    if (kind === 'normal') {
      entries = getPlaylistTrackEntries(id).map((entry) => ({
        title: entry.track?.title ?? entry.title ?? '',
        artist: entry.track?.artist ?? entry.artist ?? '',
        album: entry.track?.album ?? entry.album ?? '',
        durationSeconds: typeof entry.track?.duration === 'number' ? entry.track.duration : null,
        position: entry.position,
        addedAt: entry.added_at,
        sourcePath: entry.track_path || null
      }))
    }

    playlists.push({
      syncUid: row.sync_uid,
      name: typeof row.name === 'string' ? row.name : '',
      kind,
      dynamicRules: kind === 'dynamic' && typeof row.dynamic_rules_json === 'string' ? row.dynamic_rules_json : null,
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
      entries
    })
  }

  const tombstones: SyncUidTombstone[] = []
  for (const row of db.all<{ sync_uid?: unknown; deleted_at?: unknown }>('SELECT sync_uid, deleted_at FROM playlist_tombstones')) {
    if (typeof row.sync_uid !== 'string' || row.sync_uid.length === 0) continue
    tombstones.push({ syncUid: row.sync_uid, deletedAt: Number(row.deleted_at) || 0 })
  }

  return { playlists, tombstones }
}

export function resolvePendingSyncFavorites(matcher?: TrackMetadataMatcher): number {
  if (!db) return 0
  const pending = db.all<{ sync_key?: unknown; title?: unknown; artist?: unknown; album?: unknown; added_at?: unknown }>(
    'SELECT sync_key, title, artist, album, added_at FROM favorite_sync_pending'
  )
  if (pending.length === 0) return 0

  const match = matcher ?? createTrackMetadataMatcher()
  let resolved = 0
  for (const row of pending) {
    if (typeof row.sync_key !== 'string' || row.sync_key.length === 0) continue
    const result = match({
      title: typeof row.title === 'string' ? row.title : '',
      artist: typeof row.artist === 'string' ? row.artist : '',
      album: typeof row.album === 'string' ? row.album : ''
    })
    if (result.kind !== 'matched') continue
    db.run('INSERT OR IGNORE INTO favorites (track_path, added_at) VALUES (?, ?)', [
      result.trackPath,
      Number(row.added_at) || Date.now()
    ])
    db.run('DELETE FROM favorite_sync_pending WHERE sync_key = ?', [row.sync_key])
    resolved += 1
  }
  return resolved
}

export function upsertPendingSyncFavorite(item: SyncFavorite): void {
  if (!db) return
  db.run(
    'INSERT OR REPLACE INTO favorite_sync_pending (sync_key, title, artist, album, added_at) VALUES (?, ?, ?, ?, ?)',
    [item.key, item.title, item.artist, item.album, item.addedAt]
  )
}

export function applySyncedFavoriteAdd(trackPath: string, syncKey: string, addedAt: number): void {
  if (!db) return
  db.run('INSERT OR REPLACE INTO favorites (track_path, added_at) VALUES (?, ?)', [trackPath, addedAt])
  db.run('DELETE FROM favorite_tombstones WHERE sync_key = ?', [syncKey])
  db.run('DELETE FROM favorite_sync_pending WHERE sync_key = ?', [syncKey])
}

export function applySyncedFavoriteRemove(trackPaths: readonly string[], syncKey: string, deletedAt: number): void {
  if (!db) return
  for (const trackPath of trackPaths) {
    db.run('DELETE FROM favorites WHERE track_path = ?', [trackPath])
  }
  db.run('DELETE FROM favorite_sync_pending WHERE sync_key = ?', [syncKey])
  db.run('INSERT OR REPLACE INTO favorite_tombstones (sync_key, deleted_at) VALUES (?, ?)', [syncKey, deletedAt])
}

export function replaceSyncedPlaylist(
  input: SyncPlaylist,
  matcher: TrackMetadataMatcher
): { status: 'created' | 'replaced' | 'skipped-incompatible'; entriesMatched: number; entriesFallback: number } {
  if (!db) throw new Error('Database not initialized')

  const kind = input.kind === 'dynamic' ? 'dynamic' : 'normal'
  let rulesJson: string | null = null
  if (kind === 'dynamic') {
    try {
      rulesJson = serializeDynamicPlaylistRules(normalizeDynamicPlaylistRules(JSON.parse(input.dynamicRules ?? '')))
    } catch {
      return { status: 'skipped-incompatible', entriesMatched: 0, entriesFallback: 0 }
    }
  }

  const existing = db.get<{ id?: unknown }>('SELECT id FROM playlists WHERE sync_uid = ?', [input.syncUid])
  const existingId = existing ? Number(existing.id) : NaN
  let playlistId: number
  let created = false
  if (Number.isInteger(existingId) && existingId > 0) {
    playlistId = existingId
    db.run('UPDATE playlists SET name = ?, kind = ?, dynamic_rules_json = ?, updated_at = ? WHERE id = ?', [
      input.name,
      kind,
      rulesJson,
      input.updatedAt,
      playlistId
    ])
  } else {
    const insertResult = db.run(
      'INSERT INTO playlists (name, kind, dynamic_rules_json, created_at, updated_at, sync_uid) VALUES (?, ?, ?, ?, ?, ?)',
      [input.name, kind, rulesJson, input.createdAt, input.updatedAt, input.syncUid]
    )
    playlistId = Number(insertResult.lastInsertRowid)
    created = true
  }

  db.run('DELETE FROM playlist_tracks WHERE playlist_id = ?', [playlistId])
  db.run('DELETE FROM playlist_tombstones WHERE sync_uid = ?', [input.syncUid])

  let entriesMatched = 0
  let entriesFallback = 0
  if (kind === 'normal' && Array.isArray(input.entries)) {
    const orderedEntries = [...input.entries].sort((a, b) => a.position - b.position)
    let position = 0
    for (const entry of orderedEntries) {
      const match = matcher({
        title: entry.title,
        artist: entry.artist,
        album: entry.album,
        sourcePath: entry.sourcePath
      })
      let trackPath: string
      let matched = false
      if (match.kind === 'matched') {
        trackPath = match.trackPath
        matched = true
      } else {
        const sourcePath = typeof entry.sourcePath === 'string' ? entry.sourcePath.trim() : ''
        trackPath = sourcePath || `astra-sync://unmatched/${buildTrackSyncKey(entry.title, entry.artist, entry.album)}`
      }
      db.run(
        'INSERT INTO playlist_tracks (playlist_id, track_path, position, added_at, fallback_title, fallback_artist, fallback_album) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          playlistId,
          trackPath,
          position++,
          Number(entry.addedAt) || input.updatedAt,
          matched ? null : entry.title || null,
          matched ? null : entry.artist || null,
          matched ? null : entry.album || null
        ]
      )
      if (matched) {
        entriesMatched += 1
      } else {
        entriesFallback += 1
      }
    }
  }

  return { status: created ? 'created' : 'replaced', entriesMatched, entriesFallback }
}

export function applySyncedPlaylistDelete(syncUid: string, deletedAt: number): void {
  if (!db) return
  const row = db.get<{ id?: unknown }>('SELECT id FROM playlists WHERE sync_uid = ?', [syncUid])
  const id = row ? Number(row.id) : NaN
  if (Number.isInteger(id) && id > 0) {
    db.run('DELETE FROM playlist_tracks WHERE playlist_id = ?', [id])
    db.run('DELETE FROM playlists WHERE id = ?', [id])
  }
  db.run('INSERT OR REPLACE INTO playlist_tombstones (sync_uid, deleted_at) VALUES (?, ?)', [syncUid, deletedAt])
}
