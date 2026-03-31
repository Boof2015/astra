import initSqlJs, { Database } from 'sql.js'
import * as mm from 'music-metadata'
import { app, powerMonitor } from 'electron'
import { join, extname, basename, dirname, isAbsolute, normalize as normalizePath, resolve as resolvePath, relative as relativePath, sep as pathSep } from 'path'
import { readdir, stat, mkdir, writeFile, readFile, access, rm, mkdtemp, copyFile } from 'fs/promises'
import { createHash } from 'crypto'
import { execFile, type ExecFileOptions } from 'child_process'
import { fileURLToPath } from 'url'
import { tmpdir, cpus } from 'os'
import { parsePlaylistDocument, type ParsedPlaylistEntry, type PlaylistImportDetectedFormat } from './playlistImport'
import { getMusicMetadataParseOptions } from '../utils/musicMetadata'
import type { LyricsLine, LyricsProvider } from '../../types/lyrics'
import type {
  JellyfinSourceLastStatus,
  SubsonicSourceLastStatus,
  TrackSourceType
} from '../../types/subsonic'

// Supported audio extensions
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.wav', '.ogg', '.aac', '.m4a',
  '.opus', '.wma', '.aiff', '.alac', '.ape', '.wv'
])

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
  base_artwork_hash?: string | null
  format: string
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  codec: string | null
  codec_profile: string | null
  is_atmos_joc: number | null
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
  added_at: number
  modified_at: number
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
  artwork_hash: string | null
  format: string
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  codec: string | null
  codec_profile: string | null
  is_atmos_joc: number | null
  replaygain_track_gain_db: number | null
  replaygain_album_gain_db: number | null
  bpm: number | null
  musical_key: string | null
  source_track_id: string
  source_path: string | null
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
  artwork_hash: string | null
  format: string
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  codec: string | null
  codec_profile: string | null
  is_atmos_joc: number | null
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
export type LyricsCacheSource = 'embedded' | 'lrclib'

export interface LyricsCacheEntry {
  trackPath: string
  metadataSignature: string
  status: LyricsCacheStatus
  source: LyricsCacheSource
  provider: LyricsProvider | null
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
  plainLyrics: string | null
  syncedLyrics: string | null
  syncedLines: LyricsLine[]
  syncOffsetMs: number
  updatedAt: number
}

export interface LyricsTrackManualInput {
  plainLyrics: string | null
  syncedLyrics: string | null
  syncedLines: LyricsLine[]
}

export interface Playlist {
  id: number
  name: string
  created_at: number
  updated_at: number
  last_played_at: number | null
  custom_cover_hash: string | null
  auto_cover_hash: string | null
  track_count: number
}

export interface PlaylistImportResult {
  sourceFilePath: string
  detectedFormat: PlaylistImportDetectedFormat
  playlistId: number | null
  playlistName: string | null
  entriesTotal: number
  importedCount: number
  matchedByPathCount: number
  matchedByMetadataCount: number
  unmatchedCount: number
  ambiguousMetadataCount: number
  unsupportedEntryCount: number
  warnings: string[]
}

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

interface ScanWriteOptions extends ScanControlOptions {
  persist?: boolean
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

let db: Database | null = null
let dbPath: string = ''
let artworkDir: string = ''
let playlistCoverDir: string = ''
let replayGainScanEnabled: boolean = true
const SCAN_PARALLEL_MIN_FILES = 250
const SCAN_PARALLEL_MIN_WORKERS = 2
const SCAN_PARALLEL_MAX_WORKERS = 4
const BACKFILL_PARALLEL_MIN_FILES = 80
const BACKFILL_PARALLEL_MIN_WORKERS = 2
const BACKFILL_PARALLEL_MAX_WORKERS = 3
const SQLITE_SAFE_MAX_VARIABLES = 900
const PLAYLIST_COVER_HASH_PREFIX = 'plc:'
const EFFECTIVE_TRACK_SELECT_COLUMNS = `
  t.id AS id,
  t.path AS path,
  COALESCE(o.title, t.title) AS title,
  COALESCE(o.artist, t.artist) AS artist,
  COALESCE(o.album, t.album) AS album,
  COALESCE(o.album_artist, t.album_artist) AS album_artist,
  t.duration AS duration,
  COALESCE(o.track_number, t.track_number) AS track_number,
  COALESCE(o.disc_number, t.disc_number) AS disc_number,
  COALESCE(o.year, t.year) AS year,
  COALESCE(o.genre, t.genre) AS genre,
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

// Save database to file
async function saveDatabase(): Promise<void> {
  if (!db || !dbPath) return
  const data = db.export()
  const buffer = Buffer.from(data)
  await writeFile(dbPath, buffer)
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

function readCount(sql: string): number {
  if (!db) return 0
  const result = db.exec(sql)
  if (result.length === 0 || result[0].values.length === 0) return 0
  const raw = result[0].values[0][0]
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

// Helper to convert sql.js result to objects
function rowsToObjects<T>(columns: string[], values: unknown[][]): T[] {
  return values.map(row => {
    const obj: Record<string, unknown> = {}
    columns.forEach((col, i) => {
      obj[col] = row[i]
    })
    return obj as T
  })
}

function readEffectiveTracks(sql: string): DbTrack[] {
  if (!db) return []
  const result = db.exec(sql)
  if (result.length === 0) return []
  return rowsToObjects<DbTrack>(result[0].columns, result[0].values)
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

type AlbumGroupingMode = 'explicit-album-artist' | 'artwork-hash' | 'track-artist'

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
  tracks: DbTrack[]
}

const UNKNOWN_ALBUM_NAME = 'Unknown Album'
const UNKNOWN_ALBUM_KEY = UNKNOWN_ALBUM_NAME.toLocaleLowerCase()
const UNKNOWN_ARTIST_NAME = 'Unknown Artist'
const MIN_TRACKS_FOR_ALBUM = 2
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

function isUnknownAlbumKey(albumKey: string): boolean {
  return albumKey === UNKNOWN_ALBUM_KEY
}

function isEligibleAlbumGroup(group: AlbumGroupAccumulator): boolean {
  if (group.trackCount < MIN_TRACKS_FOR_ALBUM) return false
  if (isUnknownAlbumKey(group.albumKey)) return false
  return true
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

function getPrimaryArtistFromTrackArtist(trackArtist: string): string {
  const contributors = splitCollaborators(trackArtist)
  return contributors[0] ?? UNKNOWN_ARTIST_NAME
}

function getPrimaryArtistFromAlbumArtist(albumArtist: string): string {
  const contributors = splitAlbumArtistCollaborators(albumArtist)
  if (contributors.length > 0) return contributors[0]
  return normalizeDisplay(albumArtist) || UNKNOWN_ARTIST_NAME
}

function resolveStrictBrowseArtist(track: Pick<DbTrack, 'artist' | 'album_artist'>): string {
  const normalizedAlbumArtist = normalizeDisplay(track.album_artist ?? '')
  if (normalizedAlbumArtist) return normalizedAlbumArtist

  const normalizedTrackArtist = normalizeDisplay(track.artist)
  return normalizedTrackArtist || UNKNOWN_ARTIST_NAME
}

function resolveCanonicalBrowseArtist(track: Pick<DbTrack, 'artist' | 'album_artist'>): string {
  const normalizedAlbumArtist = normalizeDisplay(track.album_artist ?? '')
  if (normalizedAlbumArtist) {
    return getPrimaryArtistFromAlbumArtist(normalizedAlbumArtist)
  }

  const normalizedPrimaryArtist = normalizeDisplay(getPrimaryArtistFromTrackArtist(track.artist))
  return normalizedPrimaryArtist || UNKNOWN_ARTIST_NAME
}

function trackMatchesBrowseArtist(track: DbTrack, targetArtistKey: string, mode: ArtistBrowseMode): boolean {
  const browseArtistKey = normalizeKey(
    mode === 'strict' ? resolveStrictBrowseArtist(track) : resolveCanonicalBrowseArtist(track)
  )
  if (browseArtistKey === targetArtistKey) return true

  if (mode === 'strict') {
    return false
  }

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

function readAllTracksUnordered(): DbTrack[] {
  return readEffectiveTracks(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
  `)
}

function compareTracksByDiscTrackTitle(a: DbTrack, b: DbTrack): number {
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

function compareTracksByAlbumDiscTrackTitle(a: DbTrack, b: DbTrack): number {
  const albumCompare = normalizeAlbumName(a.album).localeCompare(normalizeAlbumName(b.album), undefined, { sensitivity: 'base' })
  if (albumCompare !== 0) return albumCompare
  return compareTracksByDiscTrackTitle(a, b)
}

function normalizeArtworkHash(hash: string | null): string | null {
  const normalized = normalizeDisplay(hash ?? '')
  return normalized ? normalized.toLocaleLowerCase() : null
}

function buildAlbumIdentityKey(albumKey: string, discriminator: string): string {
  return `album:${albumKey}::${discriminator}`
}

function addAliasArtistKey(aliasArtistKeys: Set<string>, rawValue: string): void {
  const key = normalizeKey(rawValue)
  if (!key) return
  aliasArtistKeys.add(key)
}

function addTrackArtistAliases(group: AlbumGroupAccumulator, track: DbTrack, primaryArtist: string): void {
  addAliasArtistKey(group.aliasArtistKeys, primaryArtist)
  addAliasArtistKey(group.aliasArtistKeys, track.artist)

  for (const collaborator of splitCollaborators(track.artist)) {
    addAliasArtistKey(group.aliasArtistKeys, collaborator)
  }

  const normalizedAlbumArtist = normalizeDisplay(track.album_artist ?? '')
  if (normalizedAlbumArtist) {
    addAliasArtistKey(group.aliasArtistKeys, normalizedAlbumArtist)
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
  track: DbTrack,
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
  if (
    group.groupingMode === 'artwork-hash'
    && group.trackCount >= MIN_TRACKS_FOR_ALBUM
    && group.primaryArtistKeys.size > 1
  ) {
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

function buildAlbumGroups(tracks: DbTrack[]): Map<string, AlbumGroupAccumulator> {
  const groups = new Map<string, AlbumGroupAccumulator>()

  for (const track of tracks) {
    const albumName = normalizeAlbumName(track.album)
    const albumKey = normalizeKey(albumName)
    const primaryArtist = normalizeDisplay(getPrimaryArtistFromTrackArtist(track.artist)) || 'Unknown Artist'
    const primaryArtistKey = normalizeKey(primaryArtist) || normalizeKey('Unknown Artist')
    const normalizedAlbumArtist = normalizeDisplay(track.album_artist ?? '')
    const artworkIdentityHash = normalizeArtworkHash(track.base_artwork_hash ?? track.artwork_hash)

    let identityKey: string
    let groupingMode: AlbumGroupingMode
    let displayArtist: string

    if (normalizedAlbumArtist) {
      const albumArtistKey = normalizeKey(normalizedAlbumArtist) || normalizeKey('Unknown Artist')
      identityKey = buildAlbumIdentityKey(albumKey, `aa:${albumArtistKey}`)
      groupingMode = 'explicit-album-artist'
      displayArtist = normalizedAlbumArtist
    } else if (artworkIdentityHash) {
      identityKey = buildAlbumIdentityKey(albumKey, `ah:${artworkIdentityHash}`)
      groupingMode = 'artwork-hash'
      displayArtist = primaryArtist
    } else {
      identityKey = buildAlbumIdentityKey(albumKey, `ta:${primaryArtistKey}`)
      groupingMode = 'track-artist'
      displayArtist = primaryArtist
    }

    let group = groups.get(identityKey)
    if (!group) {
      group = createAlbumGroupAccumulator(identityKey, groupingMode, albumKey, displayArtist)
      groups.set(identityKey, group)
    }

    addTrackToAlbumGroup(group, track, albumName, displayArtist, primaryArtist)
  }

  for (const group of groups.values()) {
    finalizeAlbumGroup(group)
  }

  return groups
}

// Initialize database
export async function initDatabase(): Promise<void> {
  const userDataPath = app.getPath('userData')
  dbPath = join(userDataPath, 'library.db')
  artworkDir = join(userDataPath, 'artwork')
  playlistCoverDir = join(userDataPath, 'playlist-covers')

  // Create artwork and playlist cover directories.
  try {
    await mkdir(artworkDir, { recursive: true })
    await mkdir(playlistCoverDir, { recursive: true })
  } catch (err) {
    console.error('Failed to create media cache directories:', { artworkDir, playlistCoverDir }, err)
  }

  // Initialize sql.js
  const SQL = await initSqlJs()

  // Try to load existing database
  try {
    const fileBuffer = await readFile(dbPath)
    db = new SQL.Database(fileBuffer)
  } catch {
    // Create new database
    db = new SQL.Database()
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT NOT NULL,
      album_artist TEXT,
      duration REAL NOT NULL,
      track_number INTEGER,
      disc_number INTEGER,
      year INTEGER,
      genre TEXT,
      artwork_hash TEXT,
      format TEXT NOT NULL,
      sample_rate INTEGER,
      bit_depth INTEGER,
      bitrate INTEGER,
      channels INTEGER,
      codec TEXT,
      codec_profile TEXT,
      is_atmos_joc INTEGER,
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

  // Schema migration: existing libraries may not have channels yet.
  try {
    db.run('ALTER TABLE tracks ADD COLUMN channels INTEGER')
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

  db.run(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      added_at INTEGER NOT NULL
    )
  `)

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
  db.run('CREATE INDEX IF NOT EXISTS idx_tracks_source_scope ON tracks(source_type, source_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tracks_source_track ON tracks(source_type, source_id, source_track_id)')
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

  // Playlists table
  db.run(`
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_played_at INTEGER,
      custom_cover_hash TEXT
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
  db.run('CREATE INDEX IF NOT EXISTS idx_playlists_last_played ON playlists(last_played_at DESC)')

  // Playlist tracks table
  db.run(`
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL,
      track_path TEXT NOT NULL,
      position INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id, position)')
  normalizePlaylistTrackMemberships()
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_playlist_tracks_membership ON playlist_tracks(playlist_id, track_path)')

  // Generic app metadata table (schema/migration flags, etc.)
  db.run(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  await saveDatabase()
}

// Close database
export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

export function setReplayGainScanEnabled(enabled: boolean): void {
  replayGainScanEnabled = Boolean(enabled)
}

export function getAppMeta(key: string): string | null {
  if (!db) return null
  const stmt = db.prepare('SELECT value FROM app_meta WHERE key = ? LIMIT 1')
  stmt.bind([key])
  const value = stmt.step() ? (stmt.getAsObject().value as string | undefined) : undefined
  stmt.free()
  return value ?? null
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

function normalizePlaylistTrackMemberships(): void {
  if (!db) return

  const stmt = db.prepare(`
    SELECT id, playlist_id, track_path
    FROM playlist_tracks
    ORDER BY playlist_id ASC, position ASC, id ASC
  `)

  const playlistRowIds = new Map<number, number[]>()
  const playlistTrackPaths = new Map<number, Set<string>>()
  const duplicateRowIds: number[] = []

  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as { id?: unknown; playlist_id?: unknown; track_path?: unknown }
      const rowId = Number(row.id)
      const playlistId = Number(row.playlist_id)
      const trackPath = typeof row.track_path === 'string' ? row.track_path : ''
      if (!Number.isInteger(rowId) || rowId <= 0 || !Number.isInteger(playlistId) || playlistId <= 0 || !trackPath) {
        continue
      }

      let seenTrackPaths = playlistTrackPaths.get(playlistId)
      if (!seenTrackPaths) {
        seenTrackPaths = new Set<string>()
        playlistTrackPaths.set(playlistId, seenTrackPaths)
      }

      if (seenTrackPaths.has(trackPath)) {
        duplicateRowIds.push(rowId)
        continue
      }

      seenTrackPaths.add(trackPath)
      const rowIds = playlistRowIds.get(playlistId)
      if (rowIds) {
        rowIds.push(rowId)
      } else {
        playlistRowIds.set(playlistId, [rowId])
      }
    }
  } finally {
    stmt.free()
  }

  for (const rowId of duplicateRowIds) {
    db.run('DELETE FROM playlist_tracks WHERE id = ?', [rowId])
  }

  for (const rowIds of playlistRowIds.values()) {
    for (let index = 0; index < rowIds.length; index += 1) {
      db.run('UPDATE playlist_tracks SET position = ? WHERE id = ?', [index, rowIds[index]])
    }
  }
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
  const result = db.exec(`
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
  `)
  if (result.length === 0) return []
  return rowsToObjects<SubsonicSourceRow>(result[0].columns, result[0].values).map(toSubsonicSourcePublic)
}

export function getSubsonicSourceById(sourceId: number): SubsonicSourceRow | null {
  if (!db) return null
  const stmt = db.prepare(`
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
  `)
  stmt.bind([sourceId])
  const row = stmt.step() ? (stmt.getAsObject() as SubsonicSourceRow) : null
  stmt.free()
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

  const insertedIdResult = db.exec('SELECT last_insert_rowid() as id')
  const sourceId = Number(insertedIdResult[0]?.values?.[0]?.[0] ?? 0)
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
  const result = db.exec(`
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
  `)
  if (result.length === 0) return []
  return rowsToObjects<JellyfinSourceRow>(result[0].columns, result[0].values).map(toJellyfinSourcePublic)
}

export function getJellyfinSourceById(sourceId: number): JellyfinSourceRow | null {
  if (!db) return null
  const stmt = db.prepare(`
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
  `)
  stmt.bind([sourceId])
  const row = stmt.step() ? (stmt.getAsObject() as JellyfinSourceRow) : null
  stmt.free()
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

  const insertedIdResult = db.exec('SELECT last_insert_rowid() as id')
  const sourceId = Number(insertedIdResult[0]?.values?.[0]?.[0] ?? 0)
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
  db.run('DELETE FROM recently_played WHERE track_path LIKE ?', [trackPathPattern])
  db.run('DELETE FROM track_metadata_overrides WHERE track_path LIKE ?', [trackPathPattern])
  db.run('DELETE FROM lyrics_cache WHERE track_path LIKE ?', [trackPathPattern])
  db.run('DELETE FROM lyrics_track_overrides WHERE track_path LIKE ?', [trackPathPattern])
}

export async function deleteSubsonicSource(sourceId: number, purgeTracks: boolean): Promise<void> {
  if (!db) return
  const source = getSubsonicSourceById(sourceId)

  if (purgeTracks) {
    const sourcePathPattern = `subsonic://${sourceId}/%`
    let includeUnknownSourceTracks = false
    if (source) {
      const countStmt = db.prepare('SELECT COUNT(*) as count FROM subsonic_sources WHERE id <> ?')
      countStmt.bind([sourceId])
      const countRow = countStmt.step() ? (countStmt.getAsObject() as { count?: unknown }) : null
      countStmt.free()
      const otherSourcesCount = Number(countRow?.count ?? 0)
      includeUnknownSourceTracks = Number.isFinite(otherSourcesCount) && otherSourcesCount <= 0
    }

    const trackSelectSql = includeUnknownSourceTracks
      ? "SELECT path FROM tracks WHERE ((source_type = 'subsonic' AND (source_id = ? OR source_id IS NULL)) OR path LIKE ?)"
      : "SELECT path FROM tracks WHERE ((source_type = 'subsonic' AND source_id = ?) OR path LIKE ?)"
    const stmt = db.prepare(trackSelectSql)
    stmt.bind([sourceId, sourcePathPattern])
    const trackPaths: string[] = []
    while (stmt.step()) {
      const row = stmt.getAsObject() as { path?: unknown }
      if (typeof row.path === 'string' && row.path.trim().length > 0) {
        trackPaths.push(row.path)
      }
    }
    stmt.free()

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
  db.run(
    `UPDATE tracks
     SET is_available = ?,
         availability_reason = ?,
         modified_at = ?
     WHERE source_type = 'subsonic' AND source_id = ?`,
    [isAvailable ? 1 : 0, isAvailable ? null : reason, Date.now(), sourceId]
  )
  const changesResult = db.exec('SELECT changes() as count')
  const count = Number(changesResult[0]?.values?.[0]?.[0] ?? 0)
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

  db.run(
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
  const changesResult = db.exec('SELECT changes() as count')
  const count = Number(changesResult[0]?.values?.[0]?.[0] ?? 0)
  if (options.persist !== false && count > 0) {
    await saveDatabase()
  }
  return Number.isFinite(count) ? count : 0
}

export async function upsertSubsonicTracks(
  sourceId: number,
  tracks: SubsonicTrackUpsertInput[],
  options: { persist?: boolean } = {}
): Promise<{ inserted: number; updated: number }> {
  if (!db || tracks.length === 0) {
    return { inserted: 0, updated: 0 }
  }

  const sourceExistsStmt = db.prepare('SELECT 1 FROM subsonic_sources WHERE id = ? LIMIT 1')
  sourceExistsStmt.bind([sourceId])
  const sourceExists = sourceExistsStmt.step()
  sourceExistsStmt.free()
  if (!sourceExists) {
    return { inserted: 0, updated: 0 }
  }

  let inserted = 0
  let updated = 0
  const now = Date.now()

  for (const track of tracks) {
    const existingStmt = db.prepare('SELECT id FROM tracks WHERE path = ? LIMIT 1')
    existingStmt.bind([track.path])
    const exists = existingStmt.step()
    existingStmt.free()

    if (exists) {
      db.run(
        `UPDATE tracks
         SET title = ?,
             artist = ?,
             album = ?,
             album_artist = ?,
             duration = ?,
             track_number = ?,
             disc_number = ?,
             year = ?,
             genre = ?,
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
          track.genre,
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
        added_at,
        modified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'subsonic', ?, ?, ?, 1, NULL, ?, ?)`,
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
        track.genre,
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

  db.run(sql, params)
  const changesResult = db.exec('SELECT changes() as count')
  const count = Number(changesResult[0]?.values?.[0]?.[0] ?? 0)
  if (options.persist !== false && count > 0) {
    await saveDatabase()
  }
  return Number.isFinite(count) ? count : 0
}

export function getTrackByPath(trackPath: string): DbTrack | null {
  if (!db) return null
  const stmt = db.prepare(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
    WHERE t.path = ?
    LIMIT 1
  `)
  stmt.bind([trackPath])
  const row = stmt.step() ? (stmt.getAsObject() as DbTrack) : null
  stmt.free()
  return row
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
  const stmt = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN is_available = 1 THEN 1 ELSE 0 END) AS available
    FROM tracks
    WHERE source_type = 'subsonic' AND source_id = ?
  `)
  stmt.bind([sourceId])
  let total = 0
  let available = 0
  if (stmt.step()) {
    const row = stmt.getAsObject() as { total?: unknown; available?: unknown }
    total = Number(row.total ?? 0)
    available = Number(row.available ?? 0)
  }
  stmt.free()
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
      const countStmt = db.prepare('SELECT COUNT(*) as count FROM jellyfin_sources WHERE id <> ?')
      countStmt.bind([sourceId])
      const countRow = countStmt.step() ? (countStmt.getAsObject() as { count?: unknown }) : null
      countStmt.free()
      const otherSourcesCount = Number(countRow?.count ?? 0)
      includeUnknownSourceTracks = Number.isFinite(otherSourcesCount) && otherSourcesCount <= 0
    }

    const trackSelectSql = includeUnknownSourceTracks
      ? "SELECT path FROM tracks WHERE ((source_type = 'jellyfin' AND (source_id = ? OR source_id IS NULL)) OR path LIKE ?)"
      : "SELECT path FROM tracks WHERE ((source_type = 'jellyfin' AND source_id = ?) OR path LIKE ?)"
    const stmt = db.prepare(trackSelectSql)
    stmt.bind([sourceId, sourcePathPattern])
    const trackPaths: string[] = []
    while (stmt.step()) {
      const row = stmt.getAsObject() as { path?: unknown }
      if (typeof row.path === 'string' && row.path.trim().length > 0) {
        trackPaths.push(row.path)
      }
    }
    stmt.free()

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
  db.run(
    `UPDATE tracks
     SET is_available = ?,
         availability_reason = ?,
         modified_at = ?
     WHERE source_type = 'jellyfin' AND source_id = ?`,
    [isAvailable ? 1 : 0, isAvailable ? null : reason, Date.now(), sourceId]
  )
  const changesResult = db.exec('SELECT changes() as count')
  const count = Number(changesResult[0]?.values?.[0]?.[0] ?? 0)
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

  db.run(
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
  const changesResult = db.exec('SELECT changes() as count')
  const count = Number(changesResult[0]?.values?.[0]?.[0] ?? 0)
  if (options.persist !== false && count > 0) {
    await saveDatabase()
  }
  return Number.isFinite(count) ? count : 0
}

export async function upsertJellyfinTracks(
  sourceId: number,
  tracks: JellyfinTrackUpsertInput[],
  options: { persist?: boolean } = {}
): Promise<{ inserted: number; updated: number }> {
  if (!db || tracks.length === 0) {
    return { inserted: 0, updated: 0 }
  }

  const sourceExistsStmt = db.prepare('SELECT 1 FROM jellyfin_sources WHERE id = ? LIMIT 1')
  sourceExistsStmt.bind([sourceId])
  const sourceExists = sourceExistsStmt.step()
  sourceExistsStmt.free()
  if (!sourceExists) {
    return { inserted: 0, updated: 0 }
  }

  let inserted = 0
  let updated = 0
  const now = Date.now()

  for (const track of tracks) {
    const existingStmt = db.prepare('SELECT id FROM tracks WHERE path = ? LIMIT 1')
    existingStmt.bind([track.path])
    const exists = existingStmt.step()
    existingStmt.free()

    if (exists) {
      db.run(
        `UPDATE tracks
         SET title = ?,
             artist = ?,
             album = ?,
             album_artist = ?,
             duration = ?,
             track_number = ?,
             disc_number = ?,
             year = ?,
             genre = ?,
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
          track.genre,
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
        added_at,
        modified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'jellyfin', ?, ?, ?, 1, NULL, ?, ?)`,
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
        track.genre,
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

  db.run(sql, params)
  const changesResult = db.exec('SELECT changes() as count')
  const count = Number(changesResult[0]?.values?.[0]?.[0] ?? 0)
  if (options.persist !== false && count > 0) {
    await saveDatabase()
  }
  return Number.isFinite(count) ? count : 0
}

export function getJellyfinTrackCountsBySource(sourceId: number): { total: number; available: number } {
  if (!db) return { total: 0, available: 0 }
  const stmt = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN is_available = 1 THEN 1 ELSE 0 END) AS available
    FROM tracks
    WHERE source_type = 'jellyfin' AND source_id = ?
  `)
  stmt.bind([sourceId])
  let total = 0
  let available = 0
  if (stmt.step()) {
    const row = stmt.getAsObject() as { total?: unknown; available?: unknown }
    total = Number(row.total ?? 0)
    available = Number(row.available ?? 0)
  }
  stmt.free()
  return {
    total: Number.isFinite(total) ? total : 0,
    available: Number.isFinite(available) ? available : 0
  }
}

export async function cleanupOrphanedRemoteTracks(options: { persist?: boolean } = {}): Promise<number> {
  if (!db) return 0

  const result = db.exec(`
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
  if (result.length === 0) return 0

  const rows = rowsToObjects<{ path?: unknown }>(result[0].columns, result[0].values)
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
    db.run(`DELETE FROM tracks WHERE path IN (${placeholders})`, chunk)
    const changesResult = db.exec('SELECT changes() as count')
    const chunkDeleted = Number(changesResult[0]?.values?.[0]?.[0] ?? 0)
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
  if (value === 'embedded' || value === 'lrclib') return value
  return null
}

function normalizeLyricsCacheProvider(value: unknown): LyricsProvider | null {
  if (value === 'lrclib') return 'lrclib'
  return null
}

function sanitizeLyricsLines(rawValue: unknown): LyricsLine[] {
  if (!Array.isArray(rawValue)) return []

  const lines: LyricsLine[] = []
  for (const entry of rawValue) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const line = entry as { timestampMs?: unknown; text?: unknown }
    if (typeof line.text !== 'string') continue

    const text = line.text.trim()
    if (!text) continue

    const timestamp = typeof line.timestampMs === 'number' && Number.isFinite(line.timestampMs)
      ? Math.max(0, Math.floor(line.timestampMs))
      : null
    if (timestamp === null) continue

    lines.push({
      timestampMs: timestamp,
      text
    })
  }

  lines.sort((left, right) => left.timestampMs - right.timestampMs)
  return lines
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

  const stmt = db.prepare(`
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
  `)
  stmt.bind([trackPath, metadataSignature])
  if (!stmt.step()) {
    stmt.free()
    return null
  }

  const row = stmt.getAsObject() as Record<string, unknown>
  stmt.free()

  const normalizedPath = toText(row.track_path)
  const normalizedSignature = toText(row.metadata_signature)
  const normalizedStatus = normalizeLyricsCacheStatus(row.status)
  const normalizedSource = normalizeLyricsCacheSource(row.source)
  if (!normalizedPath || !normalizedSignature || !normalizedStatus || !normalizedSource) {
    return null
  }

  return {
    trackPath: normalizedPath,
    metadataSignature: normalizedSignature,
    status: normalizedStatus,
    source: normalizedSource,
    provider: normalizeLyricsCacheProvider(row.provider),
    plainLyrics: toText(row.plain_lyrics),
    syncedLyrics: toText(row.synced_lyrics),
    syncedLines: parseLyricsLinesJson(typeof row.synced_lines_json === 'string' ? row.synced_lines_json : null),
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

export function getLyricsTrackOverride(trackPath: string): LyricsTrackOverrideEntry | null {
  if (!db) return null

  const normalizedTrackPath = normalizeLyricsTrackPath(trackPath)
  if (!normalizedTrackPath) return null

  const stmt = db.prepare(`
    SELECT
      track_path,
      plain_lyrics,
      synced_lyrics,
      synced_lines_json,
      sync_offset_ms,
      updated_at
    FROM lyrics_track_overrides
    WHERE track_path = ?
    LIMIT 1
  `)
  stmt.bind([normalizedTrackPath])
  if (!stmt.step()) {
    stmt.free()
    return null
  }

  const row = stmt.getAsObject() as Record<string, unknown>
  stmt.free()

  const resolvedTrackPath = toText(row.track_path)
  if (!resolvedTrackPath) return null

  return {
    trackPath: resolvedTrackPath,
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
        plain_lyrics,
        synced_lyrics,
        synced_lines_json,
        sync_offset_ms,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_path) DO UPDATE SET
        plain_lyrics = excluded.plain_lyrics,
        synced_lyrics = excluded.synced_lyrics,
        synced_lines_json = excluded.synced_lines_json,
        sync_offset_ms = excluded.sync_offset_ms,
        updated_at = excluded.updated_at`,
      [
        trackPath,
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
         SET plain_lyrics = NULL,
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

// Get all tracks
export function getAllTracks(): DbTrack[] {
  return readEffectiveTracks(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
    ORDER BY
      COALESCE(o.title, t.title) COLLATE NOCASE,
      COALESCE(o.album, t.album) COLLATE NOCASE,
      COALESCE(o.disc_number, t.disc_number, 0),
      COALESCE(o.track_number, t.track_number, 0),
      t.path COLLATE NOCASE
  `)
}

// Get tracks by artist
export function getTracksByArtist(artist: string, mode: ArtistBrowseMode = 'canonical'): DbTrack[] {
  if (!db) return []
  const targetArtistKey = normalizeKey(artist)
  if (!targetArtistKey) return []
  const resolvedMode: ArtistBrowseMode = mode === 'strict' ? 'strict' : 'canonical'

  const tracks = readAllTracksUnordered()
  const matched = tracks.filter((track) => trackMatchesBrowseArtist(track, targetArtistKey, resolvedMode))

  return matched.sort(compareTracksByAlbumDiscTrackTitle)
}

// Get tracks by album
export function getTracksByAlbum(album: string, artist?: string, identityKey?: string): DbTrack[] {
  if (!db) return []
  const albumKey = normalizeKey(normalizeAlbumName(album))
  const tracks = readAllTracksUnordered()
  if (tracks.length === 0) return []
  const groups = buildAlbumGroups(tracks)

  const normalizedIdentityKey = normalizeDisplay(identityKey ?? '')
  if (normalizedIdentityKey) {
    const directGroup = groups.get(normalizedIdentityKey)
    if (directGroup && directGroup.albumKey === albumKey) {
      return [...directGroup.tracks].sort(compareTracksByDiscTrackTitle)
    }
  }

  if (!artist || !normalizeDisplay(artist)) {
    const matched = tracks.filter((track) => normalizeKey(normalizeAlbumName(track.album)) === albumKey)
    return matched.sort(compareTracksByDiscTrackTitle)
  }

  const artistKey = normalizeKey(artist)
  if (!artistKey) {
    const matched = tracks.filter((track) => normalizeKey(normalizeAlbumName(track.album)) === albumKey)
    return matched.sort(compareTracksByDiscTrackTitle)
  }

  const albumGroups = Array.from(groups.values()).filter((group) => group.albumKey === albumKey)
  for (const group of albumGroups) {
    if (group.artistKey === artistKey) {
      return [...group.tracks].sort(compareTracksByDiscTrackTitle)
    }
  }

  const aliasMatches = albumGroups.filter((group) => group.aliasArtistKeys.has(artistKey))
  if (aliasMatches.length === 1) {
    return [...aliasMatches[0].tracks].sort(compareTracksByDiscTrackTitle)
  }

  // Defensive fallback if canonical grouping misses a case.
  const fallback = tracks.filter((track) => {
    if (normalizeKey(normalizeAlbumName(track.album)) !== albumKey) return false
    if (normalizeKey(track.album_artist ?? '') === artistKey) return true
    if (normalizeKey(track.artist) === artistKey) return true
    return splitCollaborators(track.artist).some((name) => normalizeKey(name) === artistKey)
  })
  return fallback.sort(compareTracksByDiscTrackTitle)
}

// Get unique artists
export function getArtists(mode: ArtistBrowseMode = 'canonical'): { artist: string; track_count: number; artwork_hash: string | null }[] {
  if (!db) return []
  const tracks = readAllTracksUnordered()
  if (tracks.length === 0) return []
  const resolvedMode: ArtistBrowseMode = mode === 'strict' ? 'strict' : 'canonical'
  const browseArtistResolver = resolvedMode === 'strict' ? resolveStrictBrowseArtist : resolveCanonicalBrowseArtist

  interface ArtistAggregate {
    artist: string
    track_count: number
    artwork_hash: string | null
    newestArtworkYear: number
    newestArtworkAddedAt: number
    newestArtworkModifiedAt: number
  }

  const artistCounts = new Map<string, ArtistAggregate>()

  for (const track of tracks) {
    const browseArtist = browseArtistResolver(track)
    const key = normalizeKey(browseArtist)
    if (!key) continue

    const existing = artistCounts.get(key)
    if (existing) {
      existing.track_count += 1
    } else {
      artistCounts.set(key, {
        artist: browseArtist,
        track_count: 1,
        artwork_hash: null,
        newestArtworkYear: -1,
        newestArtworkAddedAt: -1,
        newestArtworkModifiedAt: -1,
      })
    }

    if (!track.artwork_hash) continue
    const aggregate = artistCounts.get(key)
    if (!aggregate) continue

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

  return Array.from(artistCounts.values())
    .map(({ artist, track_count, artwork_hash }) => ({ artist, track_count, artwork_hash }))
    .sort((a, b) => a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }))
}

// Get unique albums
export function getAlbums(): {
  identity_key: string
  album: string
  artist: string
  primary_artist: string | null
  year: number | null
  artwork_hash: string | null
  track_count: number
}[] {
  if (!db) return []
  const tracks = readAllTracksUnordered()
  if (tracks.length === 0) return []

  const groups = buildAlbumGroups(tracks)
  const albums = Array.from(groups.values())
    .filter(isEligibleAlbumGroup)
    .map((group) => {
      const album = pickMostFrequentDisplayVariant(group.albumVariants, 'Unknown Album')
      const artist = pickMostFrequentDisplayVariant(group.artistVariants, 'Unknown Artist')

      let primaryArtist: string | null
      if (group.groupingMode === 'explicit-album-artist') {
        primaryArtist = getPrimaryArtistFromAlbumArtist(artist)
      } else if (group.groupingMode === 'artwork-hash' && group.primaryArtistKeys.size > 1) {
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
        track_count: group.trackCount
      }
    })

  return albums.sort((a, b) => {
    const albumCompare = a.album.localeCompare(b.album, undefined, { sensitivity: 'base' })
    if (albumCompare !== 0) return albumCompare
    const artistCompare = a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' })
    if (artistCompare !== 0) return artistCompare
    return a.identity_key.localeCompare(b.identity_key)
  })
}

// Search tracks
export function searchTracks(query: string): DbTrack[] {
  if (!db) return []
  const pattern = `%${query}%`
  const stmt = db.prepare(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
    WHERE COALESCE(o.title, t.title) LIKE ? OR COALESCE(o.artist, t.artist) LIKE ? OR COALESCE(o.album, t.album) LIKE ?
    ORDER BY
      COALESCE(o.title, t.title) COLLATE NOCASE,
      COALESCE(o.album, t.album) COLLATE NOCASE,
      COALESCE(o.disc_number, t.disc_number, 0),
      COALESCE(o.track_number, t.track_number, 0),
      t.path COLLATE NOCASE
    LIMIT 100
  `)
  stmt.bind([pattern, pattern, pattern])
  const tracks: DbTrack[] = []
  while (stmt.step()) {
    const row = stmt.getAsObject() as DbTrack
    tracks.push(row)
  }
  stmt.free()
  return tracks
}

function getEditableTrackSnapshot(trackPath: string): EditableTrackSnapshot | null {
  if (!db) return null

  const stmt = db.prepare(`
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
  `)
  stmt.bind([trackPath])

  if (!stmt.step()) {
    stmt.free()
    return null
  }

  const row = stmt.getAsObject() as Record<string, unknown>
  stmt.free()

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

function normalizeComparableFsPath(pathValue: string): string {
  const normalized = normalizePath(resolvePath(pathValue))
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized
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
  const result = db.exec('SELECT * FROM folders ORDER BY path')
  if (result.length === 0) return []
  return rowsToObjects<LibraryFolder>(result[0].columns, result[0].values)
}

function getLibraryFolderByPath(folderPath: string): LibraryFolder | null {
  const normalizedTargetPath = normalizeComparableFsPath(folderPath)
  return getLibraryFolders().find((folder) => normalizeComparableFsPath(folder.path) === normalizedTargetPath) ?? null
}

function getFolderExclusionRows(folderId: number): FolderExclusionRow[] {
  if (!db) return []

  const stmt = db.prepare('SELECT relative_path, absolute_path FROM folder_exclusions WHERE folder_id = ? ORDER BY relative_path')
  stmt.bind([folderId])

  const rows: FolderExclusionRow[] = []
  while (stmt.step()) {
    const row = stmt.getAsObject() as FolderExclusionRow
    if (typeof row.relative_path === 'string' && typeof row.absolute_path === 'string') {
      rows.push(row)
    }
  }
  stmt.free()
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

  const result = db.exec("SELECT id, path FROM tracks WHERE source_type = 'local'")
  if (result.length === 0) return 0

  const tracks = rowsToObjects<{ id: number; path: string }>(result[0].columns, result[0].values)
  let removedCount = 0

  for (const track of tracks) {
    const normalizedTrackPath = normalizeComparableFsPath(track.path)
    const matchesExcludedPrefix = normalizedPrefixes.some((normalizedPrefix) => {
      if (normalizedTrackPath === normalizedPrefix) return true
      const prefixWithSeparator = normalizedPrefix.endsWith(pathSep)
        ? normalizedPrefix
        : `${normalizedPrefix}${pathSep}`
      return normalizedTrackPath.startsWith(prefixWithSeparator)
    })
    if (!matchesExcludedPrefix) continue

    db.run('DELETE FROM tracks WHERE id = ?', [track.id])
    removedCount += 1
  }

  return removedCount
}

// Add library folder
export async function addLibraryFolder(folderPath: string): Promise<LibraryFolder | null> {
  if (!db) return null
  const now = Date.now()
  try {
    db.run('INSERT INTO folders (path, added_at) VALUES (?, ?)', [folderPath, now])
    const result = db.exec('SELECT last_insert_rowid() as id')
    const id = result[0].values[0][0] as number
    await saveDatabase()
    return { id, path: folderPath, added_at: now }
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

export async function resetMappedFoldersData(): Promise<{ clearedFolders: number; clearedTracks: number }> {
  if (!db) {
    return { clearedFolders: 0, clearedTracks: 0 }
  }

  const clearedFolders = readCount('SELECT COUNT(*) FROM folders')
  const clearedTracks = readCount('SELECT COUNT(*) FROM tracks')

  db.run('DELETE FROM playlist_tracks')
  db.run('DELETE FROM recently_played')
  db.run('DELETE FROM favorites')
  db.run('DELETE FROM lyrics_cache')
  db.run('DELETE FROM lyrics_track_overrides')
  db.run('DELETE FROM tracks')
  db.run('DELETE FROM folder_exclusions')
  db.run('DELETE FROM folders')

  await clearArtworkCacheDirectory()
  await saveDatabase()

  return { clearedFolders, clearedTracks }
}

export async function factoryResetLibraryData(): Promise<void> {
  if (!db) return

  db.run('DELETE FROM playlist_tracks')
  db.run('DELETE FROM playlists')
  db.run('DELETE FROM recently_played')
  db.run('DELETE FROM favorites')
  db.run('DELETE FROM lyrics_cache')
  db.run('DELETE FROM lyrics_track_overrides')
  db.run('DELETE FROM tracks')
  db.run('DELETE FROM folder_exclusions')
  db.run('DELETE FROM folders')
  db.run('DELETE FROM app_meta')

  await clearArtworkCacheDirectory()
  await clearPlaylistCoverDirectory()
  await saveDatabase()
}

// Scan a folder for audio files
export async function scanFolder(
  folderPath: string,
  onProgress?: (current: number, total: number, file: string) => void,
  options: ScanWriteOptions = {}
): Promise<{ added: number; updated: number; errors: number; skippedDirs: string[] }> {
  const { persist = true, signal, onIssue } = options
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

  interface ExistingTrackScanState {
    id: number
    modified_at: number
    file_created_at: number | null
    replaygain_track_gain_db: number | null
    replaygain_album_gain_db: number | null
  }

  const scanWorkerCount = resolveScanWorkerCount(files.length)

  await runWithConcurrency(files, scanWorkerCount, async (filePath) => {
    try {
      throwIfScanCancelled(signal)
      if (!db) return

      const fileStat = await stat(filePath)
      const fileCreatedAt = normalizeFileCreatedAtMs(fileStat.birthtimeMs)

      const checkStmt = db.prepare(
        'SELECT id, modified_at, file_created_at, replaygain_track_gain_db, replaygain_album_gain_db FROM tracks WHERE path = ?'
      )
      checkStmt.bind([filePath])
      let existing: ExistingTrackScanState | undefined
      if (checkStmt.step()) {
        existing = checkStmt.getAsObject() as ExistingTrackScanState
      }
      checkStmt.free()

      const replayGainMissing = Boolean(
        replayGainScanEnabled
        && existing
        && (
          existing.replaygain_track_gain_db == null
          || existing.replaygain_album_gain_db == null
        )
      )
      const fileCreatedAtMissing = Boolean(existing && existing.file_created_at == null)
      if (existing && existing.modified_at >= fileStat.mtimeMs && !replayGainMissing && !fileCreatedAtMissing) {
        return
      }

      const metadata = await extractMetadata(filePath)
      const now = Date.now()

      if (existing) {
        db.run(`
          UPDATE tracks SET title=?, artist=?, album=?, album_artist=?, duration=?, track_number=?, disc_number=?, year=?, genre=?, artwork_hash=?, format=?, sample_rate=?, bit_depth=?, bitrate=?, channels=?, codec=?, codec_profile=?, is_atmos_joc=?, replaygain_track_gain_db=?, replaygain_album_gain_db=?, bpm=?, musical_key=?, source_type='local', source_id=NULL, source_track_id=NULL, source_path=NULL, is_available=1, availability_reason=NULL, file_created_at=?, modified_at=?
          WHERE path=?
        `, [
          metadata.title, metadata.artist, metadata.album, metadata.albumArtist,
          metadata.duration, metadata.trackNumber, metadata.discNumber, metadata.year,
          metadata.genre, metadata.artworkHash, metadata.format, metadata.sampleRate,
          metadata.bitDepth, metadata.bitrate, metadata.channels, metadata.codec, metadata.codecProfile, metadata.isAtmosJoc,
          metadata.replayGainTrackDb, metadata.replayGainAlbumDb, metadata.bpm, metadata.musicalKey, fileCreatedAt, now, filePath
        ])
        updated++
      } else {
        db.run(`
          INSERT INTO tracks (path, title, artist, album, album_artist, duration, track_number, disc_number, year, genre, artwork_hash, format, sample_rate, bit_depth, bitrate, channels, codec, codec_profile, is_atmos_joc, replaygain_track_gain_db, replaygain_album_gain_db, bpm, musical_key, source_type, source_id, source_track_id, source_path, is_available, availability_reason, file_created_at, added_at, modified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', NULL, NULL, NULL, 1, NULL, ?, ?, ?)
        `, [
          filePath, metadata.title, metadata.artist, metadata.album, metadata.albumArtist,
          metadata.duration, metadata.trackNumber, metadata.discNumber, metadata.year,
          metadata.genre, metadata.artworkHash, metadata.format, metadata.sampleRate,
          metadata.bitDepth, metadata.bitrate, metadata.channels, metadata.codec, metadata.codecProfile, metadata.isAtmosJoc,
          metadata.replayGainTrackDb, metadata.replayGainAlbumDb, metadata.bpm, metadata.musicalKey, fileCreatedAt, now, now
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

function normalizeReplayGainDb(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = normalizeReplayGainDb(entry)
      if (parsed != null) return parsed
    }
    return null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null

    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) return parsed

    const withDbSuffix = trimmed.replace(/\s*dB\s*$/i, '').trim()
    const parsedWithDbSuffix = Number(withDbSuffix)
    if (Number.isFinite(parsedWithDbSuffix)) return parsedWithDbSuffix

    const match = trimmed.match(/[+-]?\d+(?:[.,]\d+)?/)
    if (!match) return null
    const parsedFromMatch = Number(match[0].replace(',', '.'))
    return Number.isFinite(parsedFromMatch) ? parsedFromMatch : null
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const objectCandidates: unknown[] = [
      record.dB,
      record.db,
      record.gain,
      record.value,
      record.text
    ]
    for (const candidate of objectCandidates) {
      const parsed = normalizeReplayGainDb(candidate)
      if (parsed != null) return parsed
    }
  }
  return null
}

function extractReplayGainFromCommon(metadata: mm.IAudioMetadata): {
  trackGainDb: number | null
  albumGainDb: number | null
} {
  const common = metadata.common as unknown as Record<string, unknown>
  let trackGainDb = normalizeReplayGainDb(common.replaygain_track_gain)
  let albumGainDb = normalizeReplayGainDb(common.replaygain_album_gain)

  for (const [key, rawValue] of Object.entries(common)) {
    if (trackGainDb == null && isTrackReplayGainTagId(key)) {
      trackGainDb = normalizeReplayGainDb(rawValue)
    }
    if (albumGainDb == null && isAlbumReplayGainTagId(key)) {
      albumGainDb = normalizeReplayGainDb(rawValue)
    }
    if (trackGainDb != null && albumGainDb != null) {
      break
    }
  }

  return {
    trackGainDb,
    albumGainDb
  }
}

function extractReplayGainFromNative(metadata: mm.IAudioMetadata): {
  trackGainDb: number | null
  albumGainDb: number | null
} {
  let trackGainDb: number | null = null
  let albumGainDb: number | null = null
  const nativeCollections = Object.values(metadata.native ?? {})

  for (const tags of nativeCollections) {
    if (!Array.isArray(tags)) continue
    for (const rawTag of tags) {
      if (!rawTag || typeof rawTag !== 'object') continue
      const tag = rawTag as { id?: unknown; value?: unknown }
      const id = typeof tag.id === 'string' ? tag.id : ''
      if (!id) continue

      if (trackGainDb == null && isTrackReplayGainTagId(id)) {
        trackGainDb = normalizeReplayGainDb(tag.value)
      }
      if (albumGainDb == null && isAlbumReplayGainTagId(id)) {
        albumGainDb = normalizeReplayGainDb(tag.value)
      }

      if (trackGainDb != null && albumGainDb != null) {
        return { trackGainDb, albumGainDb }
      }
    }
  }

  return { trackGainDb, albumGainDb }
}

function extractReplayGainDb(metadata: mm.IAudioMetadata): {
  trackGainDb: number | null
  albumGainDb: number | null
} {
  const commonReplayGain = extractReplayGainFromCommon(metadata)
  const nativeReplayGain = extractReplayGainFromNative(metadata)
  const trackGainDb = commonReplayGain.trackGainDb
    ?? normalizeReplayGainDb(metadata.format.trackGain)
    ?? nativeReplayGain.trackGainDb
  const albumGainDb = commonReplayGain.albumGainDb
    ?? normalizeReplayGainDb(metadata.format.albumGain)
    ?? nativeReplayGain.albumGainDb

  return {
    trackGainDb,
    albumGainDb
  }
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
async function extractMetadata(filePath: string): Promise<{
  title: string
  artist: string
  album: string
  albumArtist: string | null
  duration: number
  trackNumber: number | null
  discNumber: number | null
  year: number | null
  genre: string | null
  artworkHash: string | null
  format: string
  sampleRate: number | null
  bitDepth: number | null
  bitrate: number | null
  channels: number | null
  codec: string | null
  codecProfile: string | null
  isAtmosJoc: number
  replayGainTrackDb: number | null
  replayGainAlbumDb: number | null
  bpm: number | null
  musicalKey: string | null
}> {
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

  const fileName = basename(filePath, extname(filePath))

  return {
    title: common.title || fileName,
    artist: common.artist || 'Unknown Artist',
    album: common.album || 'Unknown Album',
    albumArtist: common.albumartist || null,
    duration: format.duration || 0,
    trackNumber: common.track?.no || null,
    discNumber: common.disk?.no || null,
    year: common.year || null,
    genre: common.genre?.[0] || null,
    artworkHash,
    format: extname(filePath).slice(1).toLowerCase(),
    sampleRate: format.sampleRate || null,
    bitDepth: format.bitsPerSample || null,
    bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null,
    channels: resolvedCodecMetadata.channels,
    codec: resolvedCodecMetadata.codec,
    codecProfile: resolvedCodecMetadata.codecProfile,
    isAtmosJoc: resolvedCodecMetadata.isAtmosJoc ? 1 : 0,
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

  let sql = `SELECT path FROM tracks WHERE source_type = 'local' AND (${candidateClauses.join(' OR ')})`
  const params: unknown[] = []
  if (options.folderPath) {
    sql += ' AND path LIKE ?'
    params.push(`${options.folderPath}%`)
  }

  const stmt = db.prepare(sql)
  if (params.length > 0) {
    stmt.bind(params)
  }

  const paths: string[] = []
  while (stmt.step()) {
    const row = stmt.getAsObject()
    if (typeof row.path === 'string') {
      paths.push(row.path)
    }
  }
  stmt.free()
  return paths
}

function getReplayGainBackfillCandidatePaths(): string[] {
  if (!db) return []
  const result = db.exec(`
    SELECT path
    FROM tracks
    WHERE source_type = 'local'
      AND (
        replaygain_track_gain_db IS NULL
        OR replaygain_album_gain_db IS NULL
      )
  `)
  if (result.length === 0) return []
  return result[0].values
    .map((row) => (typeof row[0] === 'string' ? row[0] : null))
    .filter((value): value is string => value !== null)
}

function getFileCreatedAtBackfillCandidatePaths(): string[] {
  if (!db) return []
  const result = db.exec(`
    SELECT path
    FROM tracks
    WHERE source_type = 'local'
      AND file_created_at IS NULL
  `)
  if (result.length === 0) return []
  return result[0].values
    .map((row) => (typeof row[0] === 'string' ? row[0] : null))
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
  const result = db.exec('SELECT COUNT(*) as count FROM tracks')
  if (result.length === 0) return 0
  return result[0].values[0][0] as number
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

function buildFfmpegMetadataArgs(values: {
  title: string
  artist: string
  album: string
  albumArtist: string | null
  genre: string | null
  year: number | null
  trackNumber: number | null
  discNumber: number | null
}): string[] {
  const args: string[] = [
    '-metadata', `title=${values.title}`,
    '-metadata', `artist=${values.artist}`,
    '-metadata', `album=${values.album}`,
    '-metadata', `album_artist=${values.albumArtist ?? ''}`,
    '-metadata', `genre=${values.genre ?? ''}`,
    '-metadata', `date=${values.year !== null ? String(values.year) : ''}`,
    '-metadata', `year=${values.year !== null ? String(values.year) : ''}`,
    '-metadata', `track=${values.trackNumber !== null ? String(values.trackNumber) : ''}`,
    '-metadata', `disc=${values.discNumber !== null ? String(values.discNumber) : ''}`
  ]
  return args
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
  values: {
    title: string
    artist: string
    album: string
    albumArtist: string | null
    genre: string | null
    year: number | null
    trackNumber: number | null
    discNumber: number | null
  },
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
      '-c', 'copy'
    )

    if (artworkChange.kind === 'replace') {
      ffmpegArgs.push('-c:v', 'mjpeg')
    }

    ffmpegArgs.push(
      ...buildFfmpegMetadataArgs(values),
      outputPath
    )

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
    UPDATE tracks SET title=?, artist=?, album=?, album_artist=?, duration=?, track_number=?, disc_number=?, year=?, genre=?, artwork_hash=?, format=?, sample_rate=?, bit_depth=?, bitrate=?, channels=?, codec=?, codec_profile=?, is_atmos_joc=?, replaygain_track_gain_db=?, replaygain_album_gain_db=?, bpm=?, musical_key=?, source_type='local', source_id=NULL, source_track_id=NULL, source_path=NULL, is_available=1, availability_reason=NULL, file_created_at=?, modified_at=?
    WHERE path=?
  `, [
    metadata.title, metadata.artist, metadata.album, metadata.albumArtist,
    metadata.duration, metadata.trackNumber, metadata.discNumber, metadata.year,
    metadata.genre, metadata.artworkHash, metadata.format, metadata.sampleRate,
    metadata.bitDepth, metadata.bitrate, metadata.channels, metadata.codec, metadata.codecProfile, metadata.isAtmosJoc,
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
  const result = db.exec('SELECT track_path FROM track_metadata_overrides ORDER BY track_path COLLATE NOCASE')
  if (result.length === 0) return []
  return result[0].values.map((row) => String(row[0]))
}

export async function clearMetadataOverrides(trackPaths: string[]): Promise<{ cleared: number }> {
  if (!db) return { cleared: 0 }
  const normalizedPaths = normalizeMetadataEditTrackPaths(trackPaths)
  if (normalizedPaths.length === 0) return { cleared: 0 }

  const placeholders = normalizedPaths.map(() => '?').join(', ')
  db.run(`DELETE FROM track_metadata_overrides WHERE track_path IN (${placeholders})`, normalizedPaths)
  const changesResult = db.exec('SELECT changes() as count')
  const cleared = changesResult.length > 0 ? Number(changesResult[0].values[0][0] ?? 0) : 0
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
    const stmt = db.prepare('SELECT title, artist, album, album_artist, genre, year, track_number, disc_number, artwork_hash, artwork_cleared FROM track_metadata_overrides WHERE track_path = ?')
    stmt.bind([trackPath])
    if (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>
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
    stmt.free()
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
  const result = db.exec('SELECT track_path FROM favorites')
  if (result.length === 0) return []
  return result[0].values.map((row: unknown[]) => row[0] as string)
}

export async function addFavorite(trackPath: string): Promise<void> {
  if (!db) return
  db.run('INSERT OR IGNORE INTO favorites (track_path, added_at) VALUES (?, ?)', [trackPath, Date.now()])
  await saveDatabase()
}

export async function removeFavorite(trackPath: string): Promise<void> {
  if (!db) return
  db.run('DELETE FROM favorites WHERE track_path = ?', [trackPath])
  await saveDatabase()
}

// ── Recently Played ──────────────────────────────────────

export function getRecentlyPlayed(limit: number = 50): DbTrack[] {
  return readEffectiveTracks(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
    INNER JOIN recently_played r ON r.track_path = t.path
    ORDER BY r.played_at DESC
    LIMIT ${limit}
  `)
}

export async function addRecentlyPlayed(trackPath: string): Promise<void> {
  if (!db) return
  db.run('INSERT INTO recently_played (track_path, played_at) VALUES (?, ?)', [trackPath, Date.now()])
  // Prune old entries, keep last 200
  db.run(`
    DELETE FROM recently_played WHERE id NOT IN (
      SELECT id FROM recently_played ORDER BY played_at DESC LIMIT 200
    )
  `)
  await saveDatabase()
}

// ── Playlists ────────────────────────────────────────────

export function getPlaylists(): Playlist[] {
  if (!db) return []
  const result = db.exec(`
    SELECT
      p.id,
      p.name,
      p.created_at,
      p.updated_at,
      p.last_played_at,
      p.custom_cover_hash,
      (
        SELECT t.artwork_hash
        FROM playlist_tracks ptc
        LEFT JOIN tracks t ON t.path = ptc.track_path
        WHERE ptc.playlist_id = p.id
        ORDER BY ptc.position ASC
        LIMIT 1
      ) as auto_cover_hash,
      (
        SELECT COUNT(*)
        FROM playlist_tracks pt
        INNER JOIN tracks t ON t.path = pt.track_path
        WHERE pt.playlist_id = p.id
      ) as track_count
    FROM playlists p
    ORDER BY
      CASE WHEN p.last_played_at IS NULL THEN 1 ELSE 0 END,
      p.last_played_at DESC,
      p.updated_at DESC
  `)
  if (result.length === 0) return []
  return rowsToObjects<Playlist>(result[0].columns, result[0].values)
}

export async function createPlaylist(name: string): Promise<Playlist> {
  if (!db) throw new Error('Database not initialized')
  const now = Date.now()
  db.run('INSERT INTO playlists (name, created_at, updated_at, last_played_at, custom_cover_hash) VALUES (?, ?, ?, ?, ?)', [
    name,
    now,
    now,
    null,
    null
  ])
  const result = db.exec('SELECT last_insert_rowid() as id')
  const id = result[0].values[0][0] as number
  await saveDatabase()
  return {
    id,
    name,
    created_at: now,
    updated_at: now,
    last_played_at: null,
    custom_cover_hash: null,
    auto_cover_hash: null,
    track_count: 0
  }
}

export async function renamePlaylist(id: number, name: string): Promise<void> {
  if (!db) return
  db.run('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?', [name, Date.now(), id])
  await saveDatabase()
}

export async function deletePlaylist(id: number): Promise<void> {
  if (!db) return
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
  return readEffectiveTracks(`
    SELECT ${EFFECTIVE_TRACK_SELECT_COLUMNS}
    ${EFFECTIVE_TRACK_FROM_CLAUSE}
    INNER JOIN playlist_tracks pt ON pt.track_path = t.path
    WHERE pt.playlist_id = ${playlistId}
    ORDER BY pt.position ASC, pt.id ASC
  `)
}

export async function addToPlaylist(playlistId: number, trackPaths: string[]): Promise<void> {
  if (!db || trackPaths.length === 0) return

  const uniqueTrackPaths: string[] = []
  const seenTrackPaths = new Set<string>()
  for (const trackPath of trackPaths) {
    if (typeof trackPath !== 'string' || trackPath.length === 0 || seenTrackPaths.has(trackPath)) continue
    seenTrackPaths.add(trackPath)
    uniqueTrackPaths.push(trackPath)
  }
  if (uniqueTrackPaths.length === 0) return

  const existingStmt = db.prepare('SELECT track_path FROM playlist_tracks WHERE playlist_id = ?')
  const existingTrackPaths = new Set<string>()
  try {
    existingStmt.bind([playlistId])
    while (existingStmt.step()) {
      const row = existingStmt.getAsObject() as { track_path?: unknown }
      if (typeof row.track_path === 'string' && row.track_path.length > 0) {
        existingTrackPaths.add(row.track_path)
      }
    }
  } finally {
    existingStmt.free()
  }

  const pendingTrackPaths = uniqueTrackPaths.filter((trackPath) => !existingTrackPaths.has(trackPath))
  if (pendingTrackPaths.length === 0) return

  // Get current max position
  const maxStmt = db.prepare('SELECT COALESCE(MAX(position), -1) as max_pos FROM playlist_tracks WHERE playlist_id = ?')
  maxStmt.bind([playlistId])
  const maxPosRow = maxStmt.step() ? (maxStmt.getAsObject() as { max_pos?: unknown }) : null
  const maxPos = typeof maxPosRow?.max_pos === 'number' ? maxPosRow.max_pos : -1
  maxStmt.free()
  let position = maxPos + 1
  const now = Date.now()
  for (const trackPath of pendingTrackPaths) {
    db.run(
      'INSERT INTO playlist_tracks (playlist_id, track_path, position, added_at) VALUES (?, ?, ?, ?)',
      [playlistId, trackPath, position++, now]
    )
  }
  db.run('UPDATE playlists SET updated_at = ? WHERE id = ?', [now, playlistId])
  await saveDatabase()
}

export async function removeFromPlaylist(playlistId: number, trackPath: string): Promise<void> {
  if (!db) return
  db.run('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_path = ?', [playlistId, trackPath])
  // Reorder positions
  const idStmt = db.prepare('SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC, id ASC')
  idStmt.bind([playlistId])
  const idRows: Array<{ id?: unknown }> = []
  while (idStmt.step()) {
    idRows.push(idStmt.getAsObject() as { id?: unknown })
  }
  idStmt.free()
  idRows.forEach((row, i) => {
    db!.run('UPDATE playlist_tracks SET position = ? WHERE id = ?', [i, row.id])
  })
  db.run('UPDATE playlists SET updated_at = ? WHERE id = ?', [Date.now(), playlistId])
  await saveDatabase()
}

export async function reorderPlaylistTracks(playlistId: number, orderedTrackPaths: string[]): Promise<void> {
  if (!db) return
  if (!Number.isInteger(playlistId) || playlistId <= 0) return
  if (!Array.isArray(orderedTrackPaths) || orderedTrackPaths.length === 0) return

  const rowStmt = db.prepare('SELECT id, track_path FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC, id ASC')
  const existingRows: Array<{ id: number; track_path: string }> = []

  try {
    rowStmt.bind([playlistId])
    while (rowStmt.step()) {
      const row = rowStmt.getAsObject() as { id?: unknown; track_path?: unknown }
      const rowId = Number(row.id)
      const trackPath = typeof row.track_path === 'string' ? row.track_path : ''
      if (!Number.isFinite(rowId) || rowId <= 0 || !trackPath) {
        throw new Error('Invalid playlist track rows for reorder operation.')
      }
      existingRows.push({ id: rowId, track_path: trackPath })
    }
  } finally {
    rowStmt.free()
  }

  if (existingRows.length === 0) {
    throw new Error('Cannot reorder an empty playlist.')
  }

  if (orderedTrackPaths.length !== existingRows.length) {
    throw new Error('Playlist reorder payload length does not match current playlist tracks.')
  }

  const rowIdsByPath = new Map<string, number[]>()
  for (const row of existingRows) {
    const ids = rowIdsByPath.get(row.track_path)
    if (ids) {
      ids.push(row.id)
    } else {
      rowIdsByPath.set(row.track_path, [row.id])
    }
  }

  const resolvedRowOrder: number[] = []
  for (const path of orderedTrackPaths) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('Playlist reorder payload contains an invalid track path.')
    }

    const idsForPath = rowIdsByPath.get(path)
    if (!idsForPath || idsForPath.length === 0) {
      throw new Error('Playlist reorder payload does not match current playlist content.')
    }

    const nextRowId = idsForPath.shift()
    if (!nextRowId) {
      throw new Error('Playlist reorder payload could not be resolved.')
    }
    resolvedRowOrder.push(nextRowId)
  }

  for (const idsForPath of rowIdsByPath.values()) {
    if (idsForPath.length > 0) {
      throw new Error('Playlist reorder payload does not include all current playlist tracks.')
    }
  }

  const now = Date.now()
  for (let index = 0; index < resolvedRowOrder.length; index += 1) {
    db.run('UPDATE playlist_tracks SET position = ? WHERE id = ?', [index, resolvedRowOrder[index]])
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
  const stmt = db.prepare('SELECT DISTINCT playlist_id FROM playlist_tracks WHERE track_path = ? ORDER BY playlist_id')
  stmt.bind([trackPath])

  const ids: number[] = []
  while (stmt.step()) {
    const row = stmt.getAsObject() as { playlist_id?: unknown }
    const playlistId = Number(row.playlist_id)
    if (Number.isFinite(playlistId) && playlistId > 0) {
      ids.push(playlistId)
    }
  }

  stmt.free()
  return ids
}

interface PlaylistImportLookupIndex {
  exactPath: Map<string, string>
  caseInsensitivePath: Map<string, string | null>
  metadataByTitleArtistAlbum: Map<string, string | null>
  metadataByTitleArtist: Map<string, string | null>
  metadataByTitle: Map<string, string | null>
}

interface ResolvedPlaylistImportPath {
  normalizedPath: string
  caseInsensitivePath: string
}

type MetadataMatchResult =
  | { kind: 'matched'; trackPath: string }
  | { kind: 'ambiguous' }
  | { kind: 'none' }

function buildPlaylistImportLookupIndex(tracks: DbTrack[]): PlaylistImportLookupIndex {
  const index: PlaylistImportLookupIndex = {
    exactPath: new Map(),
    caseInsensitivePath: new Map(),
    metadataByTitleArtistAlbum: new Map(),
    metadataByTitleArtist: new Map(),
    metadataByTitle: new Map()
  }

  for (const track of tracks) {
    const normalizedTrackPath = normalizePathForLookup(track.path)
    if (normalizedTrackPath) {
      index.exactPath.set(normalizedTrackPath, track.path)
      upsertUniqueLookupEntry(index.caseInsensitivePath, normalizedTrackPath.toLocaleLowerCase(), track.path)
    }

    const titleKey = normalizeKey(track.title)
    const artistKey = normalizeKey(track.artist)
    const albumKey = normalizeKey(track.album)

    if (titleKey) {
      upsertUniqueLookupEntry(index.metadataByTitle, titleKey, track.path)
    }
    if (titleKey && artistKey) {
      upsertUniqueLookupEntry(index.metadataByTitleArtist, `${titleKey}\u0000${artistKey}`, track.path)
    }
    if (titleKey && artistKey && albumKey) {
      upsertUniqueLookupEntry(index.metadataByTitleArtistAlbum, `${titleKey}\u0000${artistKey}\u0000${albumKey}`, track.path)
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

function normalizePathForLookup(inputPath: string): string {
  const trimmed = inputPath.trim()
  if (!trimmed) return ''

  const platformAwarePath = process.platform === 'win32'
    ? trimmed.replace(/\//g, '\\')
    : trimmed.replace(/\\/g, '/')

  return normalizePath(platformAwarePath)
}

function stripOuterQuotes(value: string): string {
  if (value.length < 2) return value
  const startsWithSingle = value.startsWith("'") && value.endsWith("'")
  const startsWithDouble = value.startsWith('"') && value.endsWith('"')
  if (!startsWithSingle && !startsWithDouble) return value
  return value.slice(1, -1)
}

function resolveImportedPlaylistEntryPath(rawPath: string, importFilePath: string): ResolvedPlaylistImportPath | null {
  const trimmed = stripOuterQuotes(rawPath.trim())
  if (!trimmed) return null

  const isWindowsAbsolutePath = /^[a-zA-Z]:[\\/]/.test(trimmed) || /^\\\\[^\\]/.test(trimmed)
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)
  let candidatePath = trimmed

  if (schemeMatch && !isWindowsAbsolutePath) {
    const scheme = schemeMatch[1].toLocaleLowerCase()
    if (scheme === 'file') {
      try {
        candidatePath = fileURLToPath(trimmed)
      } catch {
        return null
      }
    } else {
      return null
    }
  }

  let absolutePath = candidatePath
  if (isWindowsAbsolutePath && process.platform !== 'win32') {
    // Keep explicit Windows absolute paths as-is; these can still match on Windows,
    // and should not be resolved relative to a POSIX import directory.
    absolutePath = candidatePath
  } else {
    const normalizedSeparators = process.platform === 'win32'
      ? candidatePath.replace(/\//g, '\\')
      : candidatePath.replace(/\\/g, '/')
    absolutePath = isAbsolute(normalizedSeparators)
      ? normalizedSeparators
      : resolvePath(dirname(importFilePath), normalizedSeparators)
  }

  const normalizedPath = normalizePathForLookup(absolutePath)
  if (!normalizedPath) return null

  return {
    normalizedPath,
    caseInsensitivePath: normalizedPath.toLocaleLowerCase()
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

export async function importPlaylistFromFile(filePath: string): Promise<PlaylistImportResult> {
  if (!db) throw new Error('Database not initialized')

  const sourceFilePath = filePath.trim()
  if (!sourceFilePath) {
    throw new Error('Playlist file path is required.')
  }

  const content = await readFile(sourceFilePath, 'utf-8')
  const parsed = parsePlaylistDocument(sourceFilePath, content)
  const lookup = buildPlaylistImportLookupIndex(readAllTracksUnordered())
  const matchedTrackPaths: string[] = []
  const warnings = [...parsed.warnings]

  let matchedByPathCount = 0
  let matchedByMetadataCount = 0
  let unmatchedCount = 0
  let ambiguousMetadataCount = 0
  let unsupportedEntryCount = 0

  for (const entry of parsed.entries) {
    let matchedTrackPath: string | null = null

    if (entry.path) {
      const resolvedPath = resolveImportedPlaylistEntryPath(entry.path, sourceFilePath)
      if (!resolvedPath) {
        unsupportedEntryCount += 1
        continue
      }

      matchedTrackPath = lookup.exactPath.get(resolvedPath.normalizedPath)
        ?? null

      if (!matchedTrackPath) {
        const caseInsensitiveMatch = lookup.caseInsensitivePath.get(resolvedPath.caseInsensitivePath)
        if (typeof caseInsensitiveMatch === 'string') {
          matchedTrackPath = caseInsensitiveMatch
        }
      }

      if (matchedTrackPath) {
        matchedByPathCount += 1
      }
    }

    if (!matchedTrackPath) {
      const metadataMatch = matchPlaylistEntryByMetadata(entry, lookup)
      if (metadataMatch.kind === 'matched') {
        matchedTrackPath = metadataMatch.trackPath
        matchedByMetadataCount += 1
      } else if (metadataMatch.kind === 'ambiguous') {
        ambiguousMetadataCount += 1
        unmatchedCount += 1
        continue
      }
    }

    if (!matchedTrackPath) {
      unmatchedCount += 1
      continue
    }

    matchedTrackPaths.push(matchedTrackPath)
  }

  const importedCount = matchedTrackPaths.length
  let playlistId: number | null = null
  let playlistName: string | null = null

  if (importedCount > 0) {
    playlistName = deriveImportedPlaylistName(sourceFilePath)
    const playlist = await createPlaylist(playlistName)
    await addToPlaylist(playlist.id, matchedTrackPaths)
    playlistId = playlist.id
  }

  if (unsupportedEntryCount > 0) {
    warnings.push(`${unsupportedEntryCount} entries were skipped due to unsupported path/URI formats.`)
  }
  if (ambiguousMetadataCount > 0) {
    warnings.push(`${ambiguousMetadataCount} entries were skipped due to ambiguous metadata matches.`)
  }
  const unmatchedNonAmbiguous = unmatchedCount - ambiguousMetadataCount
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

  const result = db.exec("SELECT id, path FROM tracks WHERE source_type = 'local'")
  if (result.length === 0) return 0

  const tracks = rowsToObjects<{ id: number; path: string }>(result[0].columns, result[0].values)
  let removed = 0

  for (const track of tracks) {
    throwIfScanCancelled(signal)
    try {
      await stat(track.path)
    } catch (err: unknown) {
      const code = getErrorCode(err)
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        db.run('DELETE FROM tracks WHERE id = ?', [track.id])
        removed++
      } else {
        onIssue?.(createLibraryScanIssue('cleanup', track.path, err))
        console.warn(`Failed to validate track during cleanup for ${track.path}:`, err)
      }
    }
  }

  throwIfScanCancelled(signal)
  if (persist && removed > 0) {
    await saveDatabase()
  }

  return removed
}
