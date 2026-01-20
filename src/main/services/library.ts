import Database from 'better-sqlite3'
import * as mm from 'music-metadata'
import { app } from 'electron'
import { join, extname, basename } from 'path'
import { readdir, stat, mkdir, writeFile } from 'fs/promises'
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

let db: Database.Database | null = null
let artworkDir: string = ''

// Initialize database
export function initDatabase(): void {
  const userDataPath = app.getPath('userData')
  const dbPath = join(userDataPath, 'library.db')
  artworkDir = join(userDataPath, 'artwork')

  // Create artwork directory
  mkdir(artworkDir, { recursive: true }).catch(() => {})

  db = new Database(dbPath)

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL')

  // Create tables
  db.exec(`
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
    );

    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      added_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
    CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);
    CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
  `)
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
  return db.prepare('SELECT * FROM tracks ORDER BY artist, album, disc_number, track_number').all() as DbTrack[]
}

// Get tracks by artist
export function getTracksByArtist(artist: string): DbTrack[] {
  if (!db) return []
  return db.prepare('SELECT * FROM tracks WHERE artist = ? ORDER BY album, disc_number, track_number').all(artist) as DbTrack[]
}

// Get tracks by album
export function getTracksByAlbum(album: string, artist?: string): DbTrack[] {
  if (!db) return []
  if (artist) {
    return db.prepare('SELECT * FROM tracks WHERE album = ? AND (artist = ? OR album_artist = ?) ORDER BY disc_number, track_number')
      .all(album, artist, artist) as DbTrack[]
  }
  return db.prepare('SELECT * FROM tracks WHERE album = ? ORDER BY disc_number, track_number').all(album) as DbTrack[]
}

// Get unique artists
export function getArtists(): { artist: string; track_count: number }[] {
  if (!db) return []
  return db.prepare(`
    SELECT artist, COUNT(*) as track_count
    FROM tracks
    GROUP BY artist
    ORDER BY artist
  `).all() as { artist: string; track_count: number }[]
}

// Get unique albums
export function getAlbums(): { album: string; artist: string; year: number | null; artwork_hash: string | null; track_count: number }[] {
  if (!db) return []
  return db.prepare(`
    SELECT
      album,
      COALESCE(album_artist, artist) as artist,
      MAX(year) as year,
      MAX(artwork_hash) as artwork_hash,
      COUNT(*) as track_count
    FROM tracks
    GROUP BY album, COALESCE(album_artist, artist)
    ORDER BY artist, album
  `).all() as { album: string; artist: string; year: number | null; artwork_hash: string | null; track_count: number }[]
}

// Search tracks
export function searchTracks(query: string): DbTrack[] {
  if (!db) return []
  const pattern = `%${query}%`
  return db.prepare(`
    SELECT * FROM tracks
    WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?
    ORDER BY artist, album, track_number
    LIMIT 100
  `).all(pattern, pattern, pattern) as DbTrack[]
}

// Get library folders
export function getLibraryFolders(): LibraryFolder[] {
  if (!db) return []
  return db.prepare('SELECT * FROM folders ORDER BY path').all() as LibraryFolder[]
}

// Add library folder
export function addLibraryFolder(folderPath: string): LibraryFolder | null {
  if (!db) return null
  const now = Date.now()
  try {
    const result = db.prepare('INSERT INTO folders (path, added_at) VALUES (?, ?)').run(folderPath, now)
    return { id: result.lastInsertRowid as number, path: folderPath, added_at: now }
  } catch {
    return null // Folder already exists
  }
}

// Remove library folder
export function removeLibraryFolder(folderPath: string): void {
  if (!db) return
  db.prepare('DELETE FROM folders WHERE path = ?').run(folderPath)
  // Also remove tracks from this folder
  db.prepare('DELETE FROM tracks WHERE path LIKE ?').run(`${folderPath}%`)
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

  const insertStmt = db.prepare(`
    INSERT INTO tracks (path, title, artist, album, album_artist, duration, track_number, disc_number, year, genre, artwork_hash, format, sample_rate, bit_depth, bitrate, added_at, modified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const updateStmt = db.prepare(`
    UPDATE tracks SET title=?, artist=?, album=?, album_artist=?, duration=?, track_number=?, disc_number=?, year=?, genre=?, artwork_hash=?, format=?, sample_rate=?, bit_depth=?, bitrate=?, modified_at=?
    WHERE path=?
  `)

  const checkStmt = db.prepare('SELECT id, modified_at FROM tracks WHERE path = ?')

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]
    onProgress?.(i + 1, files.length, filePath)

    try {
      const fileStat = await stat(filePath)
      const existing = checkStmt.get(filePath) as { id: number; modified_at: number } | undefined

      // Skip if file hasn't changed
      if (existing && existing.modified_at >= fileStat.mtimeMs) {
        continue
      }

      const metadata = await extractMetadata(filePath)
      const now = Date.now()

      if (existing) {
        updateStmt.run(
          metadata.title, metadata.artist, metadata.album, metadata.albumArtist,
          metadata.duration, metadata.trackNumber, metadata.discNumber, metadata.year,
          metadata.genre, metadata.artworkHash, metadata.format, metadata.sampleRate,
          metadata.bitDepth, metadata.bitrate, now, filePath
        )
        updated++
      } else {
        insertStmt.run(
          filePath, metadata.title, metadata.artist, metadata.album, metadata.albumArtist,
          metadata.duration, metadata.trackNumber, metadata.discNumber, metadata.year,
          metadata.genre, metadata.artworkHash, metadata.format, metadata.sampleRate,
          metadata.bitDepth, metadata.bitrate, now, now
        )
        added++
      }
    } catch (err) {
      console.error(`Error processing ${filePath}:`, err)
      errors++
    }
  }

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
    artworkHash = createHash('md5').update(picture.data).digest('hex')
    const artworkPath = join(artworkDir, `${artworkHash}.jpg`)

    // Save artwork if not already cached
    try {
      await writeFile(artworkPath, picture.data, { flag: 'wx' })
    } catch {
      // File already exists, ignore
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

// Get artwork path by hash
export function getArtworkPath(hash: string): string {
  return join(artworkDir, `${hash}.jpg`)
}

// Get track count
export function getTrackCount(): number {
  if (!db) return 0
  const result = db.prepare('SELECT COUNT(*) as count FROM tracks').get() as { count: number }
  return result.count
}

// Remove tracks that no longer exist on disk
export async function cleanupMissingTracks(): Promise<number> {
  if (!db) return 0

  const tracks = db.prepare('SELECT id, path FROM tracks').all() as { id: number; path: string }[]
  let removed = 0

  for (const track of tracks) {
    try {
      await stat(track.path)
    } catch {
      db.prepare('DELETE FROM tracks WHERE id = ?').run(track.id)
      removed++
    }
  }

  return removed
}
