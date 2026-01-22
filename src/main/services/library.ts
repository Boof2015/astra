import initSqlJs, { Database } from 'sql.js'
import * as mm from 'music-metadata'
import { app } from 'electron'
import { join, extname, basename } from 'path'
import { readdir, stat, mkdir, writeFile, readFile } from 'fs/promises'
import { createHash } from 'crypto'

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
  added_at: number
  modified_at: number
}

export interface LibraryFolder {
  id: number
  path: string
  added_at: number
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
      added_at INTEGER NOT NULL,
      modified_at INTEGER NOT NULL
    )
  `)

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
): Promise<{ added: number; updated: number; errors: number }> {
  if (!db) return { added: 0, updated: 0, errors: 0 }

  const files = await collectAudioFiles(folderPath)
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
          UPDATE tracks SET title=?, artist=?, album=?, album_artist=?, duration=?, track_number=?, disc_number=?, year=?, genre=?, artwork_hash=?, format=?, sample_rate=?, bit_depth=?, bitrate=?, modified_at=?
          WHERE path=?
        `, [
          metadata.title, metadata.artist, metadata.album, metadata.albumArtist,
          metadata.duration, metadata.trackNumber, metadata.discNumber, metadata.year,
          metadata.genre, metadata.artworkHash, metadata.format, metadata.sampleRate,
          metadata.bitDepth, metadata.bitrate, now, filePath
        ])
        updated++
      } else {
        db.run(`
          INSERT INTO tracks (path, title, artist, album, album_artist, duration, track_number, disc_number, year, genre, artwork_hash, format, sample_rate, bit_depth, bitrate, added_at, modified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          filePath, metadata.title, metadata.artist, metadata.album, metadata.albumArtist,
          metadata.duration, metadata.trackNumber, metadata.discNumber, metadata.year,
          metadata.genre, metadata.artworkHash, metadata.format, metadata.sampleRate,
          metadata.bitDepth, metadata.bitrate, now, now
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
  return { added, updated, errors }
}

// Collect all audio files in a directory recursively
async function collectAudioFiles(dir: string): Promise<string[]> {
  const files: string[] = []

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true })

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
  return files
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
}> {
  const metadata = await mm.parseFile(filePath)
  const common = metadata.common
  const format = metadata.format

  // Extract and save artwork
  let artworkHash: string | null = null
  if (common.picture && common.picture.length > 0) {
    const picture = common.picture[0]
    // Include format in hash to differentiate same image in different formats
    const formatExt = getImageExtension(picture.format)
    const hash = createHash('md5').update(picture.data).digest('hex') + formatExt
    const artworkPath = join(artworkDir, hash)

    // Save artwork if not already cached
    try {
      await writeFile(artworkPath, picture.data, { flag: 'wx' })
      artworkHash = hash // Only set hash if write succeeded
    } catch (err: unknown) {
      // Check if file already exists (EEXIST error) - that's fine, use the hash
      if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
        artworkHash = hash
      } else {
        // Verify file exists anyway (might have been written by another track)
        try {
          await stat(artworkPath)
          artworkHash = hash
        } catch {
          console.error(`Failed to save artwork for ${filePath}:`, err)
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
    bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null
  }
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

// Get mime type from file extension
function getMimeTypeFromExtension(filename: string): string {
  const ext = filename.toLowerCase()
  if (ext.endsWith('.png')) return 'image/png'
  if (ext.endsWith('.gif')) return 'image/gif'
  if (ext.endsWith('.webp')) return 'image/webp'
  if (ext.endsWith('.bmp')) return 'image/bmp'
  return 'image/jpeg' // Default
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
