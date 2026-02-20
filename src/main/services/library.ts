import initSqlJs, { Database } from 'sql.js'
import * as mm from 'music-metadata'
import { app } from 'electron'
import { join, extname, basename, dirname, isAbsolute, normalize as normalizePath, resolve as resolvePath } from 'path'
import { readdir, stat, mkdir, writeFile, readFile, access, rm } from 'fs/promises'
import { createHash } from 'crypto'
import { execFile, type ExecFileOptions } from 'child_process'
import { fileURLToPath } from 'url'
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
  added_at: number
  modified_at: number
}

export interface LibraryFolder {
  id: number
  path: string
  added_at: number
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

let db: Database | null = null
let dbPath: string = ''
let artworkDir: string = ''
let playlistCoverDir: string = ''
const BACKFILL_BATCH_SIZE = 5
const BACKFILL_PAUSE_MS = 25
const PLAYLIST_COVER_HASH_PREFIX = 'plc:'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Save database to file
async function saveDatabase(): Promise<void> {
  if (!db || !dbPath) return
  const data = db.export()
  const buffer = Buffer.from(data)
  await writeFile(dbPath, buffer)
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
  if (!db) return []
  const result = db.exec('SELECT * FROM tracks')
  if (result.length === 0) return []
  return rowsToObjects<DbTrack>(result[0].columns, result[0].values)
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
      added_at INTEGER NOT NULL,
      modified_at INTEGER NOT NULL
    )
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

  db.run(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      added_at INTEGER NOT NULL
    )
  `)

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
  if (!db) return []
  const result = db.exec(`
    SELECT * FROM tracks
    ORDER BY
      title COLLATE NOCASE,
      album COLLATE NOCASE,
      COALESCE(disc_number, 0),
      COALESCE(track_number, 0),
      path COLLATE NOCASE
  `)
  if (result.length === 0) return []
  return rowsToObjects<DbTrack>(result[0].columns, result[0].values)
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
    SELECT * FROM tracks
    WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?
    ORDER BY
      title COLLATE NOCASE,
      album COLLATE NOCASE,
      COALESCE(disc_number, 0),
      COALESCE(track_number, 0),
      path COLLATE NOCASE
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

// Get library folders
export function getLibraryFolders(): LibraryFolder[] {
  if (!db) return []
  const result = db.exec('SELECT * FROM folders ORDER BY path')
  if (result.length === 0) return []
  return rowsToObjects<LibraryFolder>(result[0].columns, result[0].values)
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

// Remove library folder
export async function removeLibraryFolder(folderPath: string): Promise<void> {
  if (!db) return
  db.run('DELETE FROM folders WHERE path = ?', [folderPath])
  db.run('DELETE FROM tracks WHERE path LIKE ?', [`${folderPath}%`])
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
  db.run('DELETE FROM folders')
  db.run('DELETE FROM app_meta')

  await clearArtworkCacheDirectory()
  await clearPlaylistCoverDirectory()
  await saveDatabase()
}

// Scan a folder for audio files
export async function scanFolder(
  folderPath: string,
  onProgress?: (current: number, total: number, file: string) => void
): Promise<{ added: number; updated: number; errors: number; skippedDirs: string[] }> {
  if (!db) return { added: 0, updated: 0, errors: 0, skippedDirs: [] }

  const { files, skippedDirs } = await collectAudioFiles(folderPath)
  let added = 0
  let updated = 0
  let errors = 0

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]
    onProgress?.(i + 1, files.length, filePath)

    try {
      const fileStat = await stat(filePath)

      // Check if track exists
      const checkStmt = db.prepare('SELECT id, modified_at FROM tracks WHERE path = ?')
      checkStmt.bind([filePath])
      let existing: { id: number; modified_at: number } | undefined
      if (checkStmt.step()) {
        existing = checkStmt.getAsObject() as { id: number; modified_at: number }
      }
      checkStmt.free()

      // Skip if file hasn't changed
      if (existing && existing.modified_at >= fileStat.mtimeMs) {
        continue
      }

      const metadata = await extractMetadata(filePath)
      const now = Date.now()

      if (existing) {
        db.run(`
          UPDATE tracks SET title=?, artist=?, album=?, album_artist=?, duration=?, track_number=?, disc_number=?, year=?, genre=?, artwork_hash=?, format=?, sample_rate=?, bit_depth=?, bitrate=?, channels=?, codec=?, codec_profile=?, is_atmos_joc=?, modified_at=?
          WHERE path=?
        `, [
          metadata.title, metadata.artist, metadata.album, metadata.albumArtist,
          metadata.duration, metadata.trackNumber, metadata.discNumber, metadata.year,
          metadata.genre, metadata.artworkHash, metadata.format, metadata.sampleRate,
          metadata.bitDepth, metadata.bitrate, metadata.channels, metadata.codec, metadata.codecProfile, metadata.isAtmosJoc, now, filePath
        ])
        updated++
      } else {
        db.run(`
          INSERT INTO tracks (path, title, artist, album, album_artist, duration, track_number, disc_number, year, genre, artwork_hash, format, sample_rate, bit_depth, bitrate, channels, codec, codec_profile, is_atmos_joc, added_at, modified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          filePath, metadata.title, metadata.artist, metadata.album, metadata.albumArtist,
          metadata.duration, metadata.trackNumber, metadata.discNumber, metadata.year,
          metadata.genre, metadata.artworkHash, metadata.format, metadata.sampleRate,
          metadata.bitDepth, metadata.bitrate, metadata.channels, metadata.codec, metadata.codecProfile, metadata.isAtmosJoc, now, now
        ])
        added++
      }
    } catch (err: unknown) {
      // If file doesn't exist (deleted between scan and processing), skip silently
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        // File was deleted, will be cleaned up by cleanupMissingTracks
        continue
      }
      console.error(`Error processing ${filePath}:`, err)
      errors++
    }
  }

  await saveDatabase()
  return { added, updated, errors, skippedDirs }
}

// Collect all audio files in a directory recursively
async function collectAudioFiles(dir: string): Promise<{ files: string[]; skippedDirs: string[] }> {
  const files: string[] = []
  const skippedDirs: string[] = []

  async function walk(currentDir: string): Promise<void> {
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
      const fullPath = join(currentDir, entry.name)

      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase()
        if (AUDIO_EXTENSIONS.has(ext)) {
          files.push(fullPath)
        }
      }
    }
  }

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

async function resolveStaticFfprobeBinaryPath(): Promise<string | null> {
  try {
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
}> {
  const metadata = await mm.parseFile(filePath)
  const common = metadata.common
  const format = metadata.format
  const resolvedCodecMetadata = await resolveCodecMetadata(filePath, {
    channels: format.numberOfChannels || null,
    codec: toText(format.codec),
    codecProfile: toText(format.codecProfile)
  })

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
    isAtmosJoc: resolvedCodecMetadata.isAtmosJoc ? 1 : 0
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

async function backfillPaths(paths: string[]): Promise<{ scanned: number; updated: number; errors: number }> {
  if (!db || paths.length === 0) {
    return { scanned: 0, updated: 0, errors: 0 }
  }

  let updated = 0
  let errors = 0

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]
    try {
      await backfillTrackAudioMetadata(path)
      updated++
    } catch (err) {
      console.warn(`Failed to backfill audio metadata for ${path}:`, err)
      errors++
    }

    if ((i + 1) % BACKFILL_BATCH_SIZE === 0 && i < paths.length - 1) {
      await sleep(BACKFILL_PAUSE_MS)
    }
  }

  if (updated > 0) {
    await saveDatabase()
  }

  return { scanned: paths.length, updated, errors }
}

export async function backfillMissingChannelCounts(): Promise<{ scanned: number; updated: number; errors: number }> {
  const paths = getBackfillCandidatePaths({
    includeLegacyAtmosHeuristic: true
  })
  return backfillPaths(paths)
}

export async function backfillIncompleteAudioMetadataForFolder(folderPath: string): Promise<{ scanned: number; updated: number; errors: number }> {
  const normalizedPath = folderPath.trim()
  if (!normalizedPath) return { scanned: 0, updated: 0, errors: 0 }

  const paths = getBackfillCandidatePaths({
    folderPath: normalizedPath,
    includeLegacyAtmosHeuristic: false
  })
  return backfillPaths(paths)
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

// ── Favorites ────────────────────────────────────────────

export function getFavorites(): DbTrack[] {
  if (!db) return []
  const result = db.exec(`
    SELECT t.* FROM tracks t
    INNER JOIN favorites f ON f.track_path = t.path
    ORDER BY f.added_at DESC
  `)
  if (result.length === 0) return []
  return rowsToObjects<DbTrack>(result[0].columns, result[0].values)
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
  if (!db) return []
  const result = db.exec(`
    SELECT t.* FROM tracks t
    INNER JOIN recently_played r ON r.track_path = t.path
    ORDER BY r.played_at DESC
    LIMIT ${limit}
  `)
  if (result.length === 0) return []
  return rowsToObjects<DbTrack>(result[0].columns, result[0].values)
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
  if (!db) return []
  const result = db.exec(`
    SELECT t.* FROM tracks t
    INNER JOIN playlist_tracks pt ON pt.track_path = t.path
    WHERE pt.playlist_id = ${playlistId}
    ORDER BY pt.position
  `)
  if (result.length === 0) return []
  return rowsToObjects<DbTrack>(result[0].columns, result[0].values)
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
export async function cleanupMissingTracks(): Promise<number> {
  if (!db) return 0

  const result = db.exec('SELECT id, path FROM tracks')
  if (result.length === 0) return 0

  const tracks = rowsToObjects<{ id: number; path: string }>(result[0].columns, result[0].values)
  let removed = 0

  for (const track of tracks) {
    try {
      await stat(track.path)
    } catch {
      db.run('DELETE FROM tracks WHERE id = ?', [track.id])
      removed++
    }
  }

  if (removed > 0) {
    await saveDatabase()
  }

  return removed
}
