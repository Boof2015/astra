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
  added_at: number
  modified_at: number
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

interface ScanControlOptions {
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
  t.artwork_hash AS artwork_hash,
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
  }
}

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
    row.disc_number !== null
  )
}

interface CountedDisplayVariant {
  display: string
  count: number
}

interface AlbumGroupAccumulator {
  albumKey: string
  artistKey: string
  albumVariants: Map<string, CountedDisplayVariant>
  artistVariants: Map<string, CountedDisplayVariant>
  artworkCounts: Map<string, number>
  firstArtworkHash: string | null
  year: number | null
  trackCount: number
  tracks: DbTrack[]
}

const UNKNOWN_ALBUM_NAME = 'Unknown Album'
const UNKNOWN_ALBUM_KEY = UNKNOWN_ALBUM_NAME.toLocaleLowerCase()
const MIN_TRACKS_FOR_ALBUM = 2

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

function getPrimaryArtistFromTrackArtist(trackArtist: string): string {
  const contributors = splitCollaborators(trackArtist)
  return contributors[0] ?? 'Unknown Artist'
}

function getAlbumIdentityArtist(track: Pick<DbTrack, 'artist' | 'album_artist'>): string {
  const albumArtist = normalizeDisplay(track.album_artist ?? '')
  if (albumArtist) return albumArtist
  return getPrimaryArtistFromTrackArtist(track.artist)
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

function buildAlbumGroups(tracks: DbTrack[]): Map<string, AlbumGroupAccumulator> {
  const groups = new Map<string, AlbumGroupAccumulator>()

  for (const track of tracks) {
    const albumName = normalizeAlbumName(track.album)
    const identityArtist = normalizeDisplay(getAlbumIdentityArtist(track)) || 'Unknown Artist'
    const albumKey = normalizeKey(albumName)
    const artistKey = normalizeKey(identityArtist)
    const groupKey = `${albumKey}\u0000${artistKey}`

    let group = groups.get(groupKey)
    if (!group) {
      group = {
        albumKey,
        artistKey,
        albumVariants: new Map(),
        artistVariants: new Map(),
        artworkCounts: new Map(),
        firstArtworkHash: null,
        year: null,
        trackCount: 0,
        tracks: []
      }
      groups.set(groupKey, group)
    }

    incrementDisplayVariant(group.albumVariants, albumName)
    incrementDisplayVariant(group.artistVariants, identityArtist)
    group.trackCount += 1
    group.tracks.push(track)

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
export function getTracksByArtist(artist: string): DbTrack[] {
  if (!db) return []
  const targetArtistKey = normalizeKey(artist)
  if (!targetArtistKey) return []

  const tracks = readAllTracksUnordered()
  const matched = tracks.filter((track) => {
    const contributors = splitCollaborators(track.artist)
    const effectiveContributors = contributors.length > 0 ? contributors : ['Unknown Artist']
    return effectiveContributors.some((name) => normalizeKey(name) === targetArtistKey)
  })

  return matched.sort(compareTracksByAlbumDiscTrackTitle)
}

// Get tracks by album
export function getTracksByAlbum(album: string, artist?: string): DbTrack[] {
  if (!db) return []
  const albumKey = normalizeKey(normalizeAlbumName(album))
  const tracks = readAllTracksUnordered()
  if (tracks.length === 0) return []

  if (!artist || !normalizeDisplay(artist)) {
    const matched = tracks.filter((track) => normalizeKey(normalizeAlbumName(track.album)) === albumKey)
    return matched.sort(compareTracksByDiscTrackTitle)
  }

  const artistKey = normalizeKey(artist)
  const groups = buildAlbumGroups(tracks)
  for (const group of groups.values()) {
    if (group.albumKey === albumKey && group.artistKey === artistKey) {
      return [...group.tracks].sort(compareTracksByDiscTrackTitle)
    }
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
export function getArtists(): { artist: string; track_count: number; artwork_hash: string | null }[] {
  if (!db) return []
  const tracks = readAllTracksUnordered()
  if (tracks.length === 0) return []

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
    const contributors = splitCollaborators(track.artist)
    const effectiveContributors = contributors.length > 0 ? contributors : ['Unknown Artist']
    const seenForTrack = new Set<string>()

    for (const contributor of effectiveContributors) {
      const key = normalizeKey(contributor)
      if (!key || seenForTrack.has(key)) continue
      seenForTrack.add(key)

      const existing = artistCounts.get(key)
      if (existing) {
        existing.track_count += 1
      } else {
        artistCounts.set(key, {
          artist: contributor,
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
  }

  return Array.from(artistCounts.values())
    .map(({ artist, track_count, artwork_hash }) => ({ artist, track_count, artwork_hash }))
    .sort((a, b) => a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }))
}

// Get unique albums
export function getAlbums(): { album: string; artist: string; year: number | null; artwork_hash: string | null; track_count: number }[] {
  if (!db) return []
  const tracks = readAllTracksUnordered()
  if (tracks.length === 0) return []

  const groups = buildAlbumGroups(tracks)
  const albums = Array.from(groups.values())
    .filter(isEligibleAlbumGroup)
    .map((group) => ({
      album: pickMostFrequentDisplayVariant(group.albumVariants, 'Unknown Album'),
      artist: pickMostFrequentDisplayVariant(group.artistVariants, 'Unknown Artist'),
      year: group.year,
      artwork_hash: pickMostFrequentArtworkHash(group.artworkCounts, group.firstArtworkHash),
      track_count: group.trackCount
    }))

  return albums.sort((a, b) => {
    const albumCompare = a.album.localeCompare(b.album, undefined, { sensitivity: 'base' })
    if (albumCompare !== 0) return albumCompare
    return a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' })
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
      COALESCE(o.title, t.title) AS effective_title,
      COALESCE(o.artist, t.artist) AS effective_artist,
      COALESCE(o.album, t.album) AS effective_album,
      COALESCE(o.album_artist, t.album_artist) AS effective_album_artist,
      COALESCE(o.genre, t.genre) AS effective_genre,
      COALESCE(o.year, t.year) AS effective_year,
      COALESCE(o.track_number, t.track_number) AS effective_track_number,
      COALESCE(o.disc_number, t.disc_number) AS effective_disc_number
    FROM tracks t
    LEFT JOIN track_metadata_overrides o ON o.track_path = t.path
    WHERE t.path = ?
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
      discNumber: toNumber(row.base_disc_number)
    },
    effective: {
      title: effectiveTitle,
      artist: effectiveArtist,
      album: effectiveAlbum,
      albumArtist: toText(row.effective_album_artist),
      genre: toText(row.effective_genre),
      year: toNumber(row.effective_year),
      trackNumber: toNumber(row.effective_track_number),
      discNumber: toNumber(row.effective_disc_number)
    }
  }
}

function buildNextOverrideRow(snapshot: EditableTrackSnapshot, changes: MetadataEditChanges): TrackMetadataOverrideRow {
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

  return {
    title: nextTitle !== snapshot.base.title ? nextTitle : null,
    artist: nextArtist !== snapshot.base.artist ? nextArtist : null,
    album: nextAlbum !== snapshot.base.album ? nextAlbum : null,
    album_artist: nextAlbumArtist !== snapshot.base.albumArtist ? nextAlbumArtist : null,
    genre: nextGenre !== snapshot.base.genre ? nextGenre : null,
    year: nextYear !== snapshot.base.year ? nextYear : null,
    track_number: nextTrackNumber !== snapshot.base.trackNumber ? nextTrackNumber : null,
    disc_number: nextDiscNumber !== snapshot.base.discNumber ? nextDiscNumber : null
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
      track_path, title, artist, album, album_artist, genre, year, track_number, disc_number, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(track_path) DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      album = excluded.album,
      album_artist = excluded.album_artist,
      genre = excluded.genre,
      year = excluded.year,
      track_number = excluded.track_number,
      disc_number = excluded.disc_number,
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

  const result = db.exec('SELECT id, path FROM tracks')
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

async function directoryHasSubdirectories(directoryPath: string): Promise<boolean> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true })
    return entries.some((entry) => entry.isDirectory())
  } catch {
    return false
  }
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
      directChildren.set(childRelativePath, {
        name: entry.name,
        relativePath: childRelativePath,
        excluded: isRelativeSubfolderExcluded(childRelativePath, excludedRelativePaths),
        hasChildren: await directoryHasSubdirectories(childAbsolutePath),
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
  const { persist = true, signal } = options
  if (!db) return { added: 0, updated: 0, errors: 0, skippedDirs: [] }
  throwIfScanCancelled(signal)

  const excludedAbsolutePaths = getExcludedAbsolutePathsForFolder(folderPath)
  if (excludedAbsolutePaths.length > 0) {
    deleteTracksByAbsolutePrefixes(excludedAbsolutePaths)
  }

  const { files, skippedDirs } = await collectAudioFiles(folderPath, excludedAbsolutePaths, { signal })
  let added = 0
  let updated = 0
  let errors = 0
  let processed = 0

  interface ExistingTrackScanState {
    id: number
    modified_at: number
    replaygain_track_gain_db: number | null
    replaygain_album_gain_db: number | null
  }

  const scanWorkerCount = resolveScanWorkerCount(files.length)

  await runWithConcurrency(files, scanWorkerCount, async (filePath) => {
    try {
      throwIfScanCancelled(signal)
      if (!db) return

      const fileStat = await stat(filePath)

      const checkStmt = db.prepare(
        'SELECT id, modified_at, replaygain_track_gain_db, replaygain_album_gain_db FROM tracks WHERE path = ?'
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
      if (existing && existing.modified_at >= fileStat.mtimeMs && !replayGainMissing) {
        return
      }

      const metadata = await extractMetadata(filePath)
      const now = Date.now()

      if (existing) {
        db.run(`
          UPDATE tracks SET title=?, artist=?, album=?, album_artist=?, duration=?, track_number=?, disc_number=?, year=?, genre=?, artwork_hash=?, format=?, sample_rate=?, bit_depth=?, bitrate=?, channels=?, codec=?, codec_profile=?, is_atmos_joc=?, replaygain_track_gain_db=?, replaygain_album_gain_db=?, modified_at=?
          WHERE path=?
        `, [
          metadata.title, metadata.artist, metadata.album, metadata.albumArtist,
          metadata.duration, metadata.trackNumber, metadata.discNumber, metadata.year,
          metadata.genre, metadata.artworkHash, metadata.format, metadata.sampleRate,
          metadata.bitDepth, metadata.bitrate, metadata.channels, metadata.codec, metadata.codecProfile, metadata.isAtmosJoc,
          metadata.replayGainTrackDb, metadata.replayGainAlbumDb, now, filePath
        ])
        updated++
      } else {
        db.run(`
          INSERT INTO tracks (path, title, artist, album, album_artist, duration, track_number, disc_number, year, genre, artwork_hash, format, sample_rate, bit_depth, bitrate, channels, codec, codec_profile, is_atmos_joc, replaygain_track_gain_db, replaygain_album_gain_db, added_at, modified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          filePath, metadata.title, metadata.artist, metadata.album, metadata.albumArtist,
          metadata.duration, metadata.trackNumber, metadata.discNumber, metadata.year,
          metadata.genre, metadata.artworkHash, metadata.format, metadata.sampleRate,
          metadata.bitDepth, metadata.bitrate, metadata.channels, metadata.codec, metadata.codecProfile, metadata.isAtmosJoc,
          metadata.replayGainTrackDb, metadata.replayGainAlbumDb, now, now
        ])
        added++
      }
    } catch (err: unknown) {
      if (isLibraryScanCancelledError(err)) {
        throw err
      }
      if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')) {
        console.error(`Error processing ${filePath}:`, err)
        errors++
      }
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
      if (err && typeof err === 'object' && 'code' in err &&
          (err.code === 'EACCES' || err.code === 'EPERM')) {
        skippedDirs.push(currentDir)
        return
      }
      throw err
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
  const candidates = [
    ...(app.isPackaged
      ? [
          join(process.resourcesPath, executable),
          join(process.resourcesPath, 'bin', executable)
        ]
      : []),
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
  const candidates = [
    ...(app.isPackaged
      ? [
          join(process.resourcesPath, executable),
          join(process.resourcesPath, 'bin', executable)
        ]
      : []),
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
}> {
  const metadata = await mm.parseFile(filePath)
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
    replayGainAlbumDb: replayGain.albumGainDb
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

  let sql = `SELECT path FROM tracks WHERE (${candidateClauses.join(' OR ')})`
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
    WHERE replaygain_track_gain_db IS NULL
       OR replaygain_album_gain_db IS NULL
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

  try {
    const metadata = await mm.parseFile(path)
    baseChannels = metadata.format.numberOfChannels || null
    baseCodec = toText(metadata.format.codec)
    baseCodecProfile = toText(metadata.format.codecProfile)
  } catch {
    // We'll still attempt ffprobe-only resolution below.
  }

  const resolvedCodecMetadata = await resolveCodecMetadata(path, {
    channels: baseChannels,
    codec: baseCodec,
    codecProfile: baseCodecProfile
  })

  db.run(
    'UPDATE tracks SET channels = ?, codec = ?, codec_profile = ?, is_atmos_joc = ? WHERE path = ?',
    [
      resolvedCodecMetadata.channels,
      resolvedCodecMetadata.codec,
      resolvedCodecMetadata.codecProfile,
      resolvedCodecMetadata.isAtmosJoc ? 1 : 0,
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
      const metadata = await mm.parseFile(path)
      const replayGain = extractReplayGainDb(metadata)
      replayGainTrackDb = replayGain.trackGainDb
      replayGainAlbumDb = replayGain.albumGainDb
    } catch {
      // Keep null values when tags cannot be parsed.
    }
  }

  db.run(
    'UPDATE tracks SET replaygain_track_gain_db = ?, replaygain_album_gain_db = ? WHERE path = ?',
    [replayGainTrackDb, replayGainAlbumDb, path]
  )
}

type BackfillProgressCallback = (current: number, total: number, path: string) => void

async function backfillPaths(
  paths: string[],
  onProgress?: BackfillProgressCallback,
  options: ScanWriteOptions = {}
): Promise<{ scanned: number; updated: number; errors: number }> {
  const { persist = true, signal } = options
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
      console.warn(`Failed to backfill audio metadata for ${path}:`, err)
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

export async function backfillMissingReplayGainMetadata(
  options: ScanWriteOptions = {}
): Promise<{ scanned: number; updated: number; errors: number }> {
  const { persist = true, signal } = options
  if (!replayGainScanEnabled) {
    return { scanned: 0, updated: 0, errors: 0 }
  }

  const paths = getReplayGainBackfillCandidatePaths()
  if (paths.length === 0) {
    return { scanned: 0, updated: 0, errors: 0 }
  }

  let updated = 0
  let errors = 0
  const workerCount = resolveBackfillWorkerCount(paths.length)

  await runWithConcurrency(paths, workerCount, async (path) => {
    try {
      throwIfScanCancelled(signal)
      await backfillTrackReplayGainMetadata(path)
      updated++
    } catch (err) {
      if (isLibraryScanCancelledError(err)) {
        throw err
      }
      console.warn(`Failed to backfill ReplayGain metadata for ${path}:`, err)
      errors++
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
  }
): Promise<void> {
  const ffmpegPath = await resolveFfmpegBinaryPath()
  if (!ffmpegPath) {
    throw new Error('FFmpeg binary is not available.')
  }

  const extension = extname(trackPath).toLowerCase()
  const tempDir = await mkdtemp(join(tmpdir(), 'astra-tag-write-'))
  const outputPath = join(tempDir, `updated${extension || '.media'}`)

  try {
    await execFileAsync(
      ffmpegPath,
      [
        '-v', 'error',
        '-y',
        '-i', trackPath,
        '-map', '0',
        '-c', 'copy',
        ...buildFfmpegMetadataArgs(values),
        outputPath
      ],
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
  const now = Date.now()

  db.run(`
    UPDATE tracks SET title=?, artist=?, album=?, album_artist=?, duration=?, track_number=?, disc_number=?, year=?, genre=?, artwork_hash=?, format=?, sample_rate=?, bit_depth=?, bitrate=?, channels=?, codec=?, codec_profile=?, is_atmos_joc=?, replaygain_track_gain_db=?, replaygain_album_gain_db=?, modified_at=?
    WHERE path=?
  `, [
    metadata.title, metadata.artist, metadata.album, metadata.albumArtist,
    metadata.duration, metadata.trackNumber, metadata.discNumber, metadata.year,
    metadata.genre, metadata.artworkHash, metadata.format, metadata.sampleRate,
    metadata.bitDepth, metadata.bitrate, metadata.channels, metadata.codec, metadata.codecProfile, metadata.isAtmosJoc,
    metadata.replayGainTrackDb, metadata.replayGainAlbumDb, now, trackPath
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
        const row = buildNextOverrideRow(snapshot, normalizedChanges)
        upsertTrackMetadataOverride(trackPath, row)
      } else {
        const resolvedValues = resolveEditableValuesForSave(snapshot, normalizedChanges)
        await writeTrackMetadataToFile(trackPath, resolvedValues)
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
}

export function getTrackOverrideSnapshots(trackPaths: string[]): Record<string, TrackOverrideSnapshot | null> {
  if (!db) return {}
  const result: Record<string, TrackOverrideSnapshot | null> = {}

  for (const trackPath of trackPaths) {
    const stmt = db.prepare('SELECT title, artist, album, album_artist, genre, year, track_number, disc_number FROM track_metadata_overrides WHERE track_path = ?')
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
        disc_number: row.disc_number as number | null
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
    'title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'trackNumber', 'discNumber'
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
    ORDER BY pt.position
  `)
}

export async function addToPlaylist(playlistId: number, trackPaths: string[]): Promise<void> {
  if (!db || trackPaths.length === 0) return
  // Get current max position
  const result = db.exec(`SELECT COALESCE(MAX(position), -1) as max_pos FROM playlist_tracks WHERE playlist_id = ${playlistId}`)
  let position = (result[0].values[0][0] as number) + 1
  const now = Date.now()
  for (const trackPath of trackPaths) {
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
  const result = db.exec(`SELECT id FROM playlist_tracks WHERE playlist_id = ${playlistId} ORDER BY position`)
  if (result.length > 0) {
    result[0].values.forEach((row: unknown[], i: number) => {
      db!.run('UPDATE playlist_tracks SET position = ? WHERE id = ?', [i, row[0]])
    })
  }
  db.run('UPDATE playlists SET updated_at = ? WHERE id = ?', [Date.now(), playlistId])
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
  const stmt = db.prepare('SELECT playlist_id FROM playlist_tracks WHERE track_path = ? ORDER BY playlist_id')
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
  const { persist = true, signal } = options
  if (!db) return 0

  const result = db.exec('SELECT id, path FROM tracks')
  if (result.length === 0) return 0

  const tracks = rowsToObjects<{ id: number; path: string }>(result[0].columns, result[0].values)
  let removed = 0

  for (const track of tracks) {
    throwIfScanCancelled(signal)
    try {
      await stat(track.path)
    } catch {
      db.run('DELETE FROM tracks WHERE id = ?', [track.id])
      removed++
    }
  }

  throwIfScanCancelled(signal)
  if (persist && removed > 0) {
    await saveDatabase()
  }

  return removed
}
