import initSqlJs, { Database } from 'sql.js'
import * as mm from 'music-metadata'
import { app } from 'electron'
import { join, extname, basename } from 'path'
import { readdir, stat, mkdir, writeFile, readFile } from 'fs/promises'
import { createHash } from 'crypto'
import { execFile, type ExecFileOptions } from 'child_process'

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
  track_count: number
}

let db: Database | null = null
let dbPath: string = ''
let artworkDir: string = ''

// Save database to file
async function saveDatabase(): Promise<void> {
  if (!db || !dbPath) return
  const data = db.export()
  const buffer = Buffer.from(data)
  await writeFile(dbPath, buffer)
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

// Initialize database
export async function initDatabase(): Promise<void> {
  const userDataPath = app.getPath('userData')
  dbPath = join(userDataPath, 'library.db')
  artworkDir = join(userDataPath, 'artwork')

  // Create artwork directory
  try {
    await mkdir(artworkDir, { recursive: true })
  } catch (err) {
    console.error('Failed to create artwork directory:', artworkDir, err)
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
      updated_at INTEGER NOT NULL
    )
  `)

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

  await saveDatabase()
}

// Close database
export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

// Get all tracks
export function getAllTracks(): DbTrack[] {
  if (!db) return []
  const result = db.exec('SELECT * FROM tracks ORDER BY artist, album, disc_number, track_number')
  if (result.length === 0) return []
  return rowsToObjects<DbTrack>(result[0].columns, result[0].values)
}

// Get tracks by artist
export function getTracksByArtist(artist: string): DbTrack[] {
  if (!db) return []
  const stmt = db.prepare('SELECT * FROM tracks WHERE artist = ? ORDER BY album, disc_number, track_number')
  stmt.bind([artist])
  const tracks: DbTrack[] = []
  while (stmt.step()) {
    const row = stmt.getAsObject() as DbTrack
    tracks.push(row)
  }
  stmt.free()
  return tracks
}

// Get tracks by album
export function getTracksByAlbum(album: string, artist?: string): DbTrack[] {
  if (!db) return []
  let stmt
  if (artist) {
    stmt = db.prepare('SELECT * FROM tracks WHERE album = ? AND (artist = ? OR album_artist = ?) ORDER BY disc_number, track_number')
    stmt.bind([album, artist, artist])
  } else {
    stmt = db.prepare('SELECT * FROM tracks WHERE album = ? ORDER BY disc_number, track_number')
    stmt.bind([album])
  }
  const tracks: DbTrack[] = []
  while (stmt.step()) {
    const row = stmt.getAsObject() as DbTrack
    tracks.push(row)
  }
  stmt.free()
  return tracks
}

// Get unique artists
export function getArtists(): { artist: string; track_count: number }[] {
  if (!db) return []
  const result = db.exec(`
    SELECT artist, COUNT(*) as track_count
    FROM tracks
    GROUP BY artist
    ORDER BY artist
  `)
  if (result.length === 0) return []
  return rowsToObjects<{ artist: string; track_count: number }>(result[0].columns, result[0].values)
}

// Get unique albums
export function getAlbums(): { album: string; artist: string; year: number | null; artwork_hash: string | null; track_count: number }[] {
  if (!db) return []
  const result = db.exec(`
    SELECT
      album,
      COALESCE(album_artist, artist) as artist,
      MAX(year) as year,
      MAX(artwork_hash) as artwork_hash,
      COUNT(*) as track_count
    FROM tracks
    GROUP BY album, COALESCE(album_artist, artist)
    ORDER BY artist, album
  `)
  if (result.length === 0) return []
  return rowsToObjects<{ album: string; artist: string; year: number | null; artwork_hash: string | null; track_count: number }>(result[0].columns, result[0].values)
}

// Search tracks
export function searchTracks(query: string): DbTrack[] {
  if (!db) return []
  const pattern = `%${query}%`
  const stmt = db.prepare(`
    SELECT * FROM tracks
    WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?
    ORDER BY artist, album, track_number
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
  const candidates = isWindows
    ? ['ffprobe.exe', 'ffprobe']
    : ['ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe']

  for (const candidate of candidates) {
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
  const mentionsAtmos = combined.includes('joc') || combined.includes('atmos')
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

export async function backfillMissingChannelCounts(): Promise<{ scanned: number; updated: number; errors: number }> {
  if (!db) return { scanned: 0, updated: 0, errors: 0 }

  const result = db.exec(`
    SELECT path FROM tracks
    WHERE channels IS NULL
       OR codec IS NULL
       OR codec_profile IS NULL
       OR is_atmos_joc IS NULL
  `)
  if (result.length === 0) return { scanned: 0, updated: 0, errors: 0 }

  const pathColumnIndex = result[0].columns.indexOf('path')
  if (pathColumnIndex === -1) return { scanned: 0, updated: 0, errors: 0 }

  const paths = result[0].values.map((row: unknown[]) => row[pathColumnIndex] as string)
  let updated = 0
  let errors = 0

  for (const path of paths) {
    try {
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
      updated++
    } catch (err) {
      console.warn(`Failed to backfill audio metadata for ${path}:`, err)
      errors++
    }
  }

  if (updated > 0) {
    await saveDatabase()
  }

  return { scanned: paths.length, updated, errors }
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
    SELECT p.id, p.name, p.created_at, p.updated_at,
           COUNT(pt.id) as track_count
    FROM playlists p
    LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `)
  if (result.length === 0) return []
  return rowsToObjects<Playlist>(result[0].columns, result[0].values)
}

export async function createPlaylist(name: string): Promise<Playlist> {
  if (!db) throw new Error('Database not initialized')
  const now = Date.now()
  db.run('INSERT INTO playlists (name, created_at, updated_at) VALUES (?, ?, ?)', [name, now, now])
  const result = db.exec('SELECT last_insert_rowid() as id')
  const id = result[0].values[0][0] as number
  await saveDatabase()
  return { id, name, created_at: now, updated_at: now, track_count: 0 }
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
