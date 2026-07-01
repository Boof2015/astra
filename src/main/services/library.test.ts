import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import test from 'node:test'
import { pathToFileURL } from 'url'
import { createRequire } from 'module'
import * as library from './library.ts'
import { createDefaultDynamicPlaylistRules } from '../../shared/playlists/dynamicPlaylist.ts'

interface TestSqliteStatement {
  run(...params: unknown[]): void
}

interface TestSqliteDatabase {
  prepare(sql: string): TestSqliteStatement
  close(): void
}

type TestSqliteDatabaseConstructor = new (path: string) => TestSqliteDatabase

const require = createRequire(import.meta.url)
const TestSqliteDatabase = require('better-sqlite3') as TestSqliteDatabaseConstructor

function createRiffChunk(id: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.write(id, 0, 'ascii')
  header.writeUInt32LE(payload.length, 4)
  const padding = payload.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0)
  return Buffer.concat([header, payload, padding])
}

function createInfoTextChunk(id: string, value: string): Buffer {
  return createRiffChunk(id, Buffer.from(`${value}\0`, 'ascii'))
}

function createTaggedWavFixture(title: string, artist: string): Buffer {
  const formatPayload = Buffer.alloc(16)
  formatPayload.writeUInt16LE(1, 0)
  formatPayload.writeUInt16LE(1, 2)
  formatPayload.writeUInt32LE(8000, 4)
  formatPayload.writeUInt32LE(16000, 8)
  formatPayload.writeUInt16LE(2, 12)
  formatPayload.writeUInt16LE(16, 14)

  const infoPayload = Buffer.concat([
    Buffer.from('INFO', 'ascii'),
    createInfoTextChunk('INAM', title),
    createInfoTextChunk('IART', artist)
  ])
  const body = Buffer.concat([
    Buffer.from('WAVE', 'ascii'),
    createRiffChunk('fmt ', formatPayload),
    createRiffChunk('LIST', infoPayload),
    createRiffChunk('data', Buffer.alloc(2))
  ])
  const header = Buffer.alloc(8)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body])
}

async function writeTaggedWavFixture(filePath: string, title: string, artist: string): Promise<void> {
  await writeFile(filePath, createTaggedWavFixture(title, artist))
}

const TINY_PNG_FIXTURE = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf000000050001a29903a60000000049454e44ae426082',
  'hex'
)

async function setupEmptyLibrary(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'astra-library-sqlite-'))
  process.env.ASTRA_TEST_USER_DATA = dir
  await library.initDatabase()

  t.after(async () => {
    library.closeDatabase()
    delete process.env.ASTRA_TEST_USER_DATA
    await rm(dir, { recursive: true, force: true })
  })

  return dir
}

function createRemoteTrack(
  overrides: Partial<library.SubsonicTrackUpsertInput> & Pick<library.SubsonicTrackUpsertInput, 'path' | 'title' | 'artist' | 'album'>
): library.SubsonicTrackUpsertInput {
  return {
    path: overrides.path,
    title: overrides.title,
    artist: overrides.artist,
    album: overrides.album,
    album_artist: overrides.album_artist ?? null,
    duration: overrides.duration ?? 180,
    track_number: overrides.track_number ?? null,
    disc_number: overrides.disc_number ?? null,
    year: overrides.year ?? null,
    genre: overrides.genre ?? null,
    genres: overrides.genres ?? (overrides.genre ? [overrides.genre] : []),
    artwork_hash: overrides.artwork_hash ?? null,
    format: overrides.format ?? 'flac',
    sample_rate: overrides.sample_rate ?? 44_100,
    bit_depth: overrides.bit_depth ?? 16,
    bitrate: overrides.bitrate ?? null,
    channels: overrides.channels ?? 2,
    codec: overrides.codec ?? 'flac',
    codec_profile: overrides.codec_profile ?? null,
    is_atmos_joc: overrides.is_atmos_joc ?? 0,
    replaygain_track_gain_db: overrides.replaygain_track_gain_db ?? null,
    replaygain_album_gain_db: overrides.replaygain_album_gain_db ?? null,
    bpm: overrides.bpm ?? null,
    musical_key: overrides.musical_key ?? null,
    source_track_id: overrides.source_track_id ?? overrides.path,
    source_path: overrides.source_path ?? overrides.path
  }
}

async function setupSeededLibrary(t: test.TestContext): Promise<void> {
  await setupEmptyLibrary(t)

  const source = await library.createSubsonicSource({
    name: 'Test Source',
    base_url: 'https://music.example.test',
    username: 'tester',
    secret_encrypted: 'secret',
    enabled: 1,
    last_status: 'ok'
  })

  await library.upsertSubsonicTracks(source.id, [
    createRemoteTrack({
      path: 'subsonic://1/split-a',
      source_track_id: 'split-a',
      title: 'Split A',
      artist: 'Artist A',
      album: 'Split Release',
      artwork_hash: 'shared-cover',
      track_number: 1,
      year: 2024
    }),
    createRemoteTrack({
      path: 'subsonic://1/split-b',
      source_track_id: 'split-b',
      title: 'Split B',
      artist: 'Artist B',
      album: 'Split Release',
      artwork_hash: 'shared-cover',
      track_number: 2,
      year: 2024
    }),
    createRemoteTrack({
      path: 'subsonic://1/teen-1',
      source_track_id: 'teen-1',
      title: 'Teen Intro',
      artist: 'Jane Remover',
      album: 'Teen Week',
      artwork_hash: 'teen-a',
      track_number: 1,
      year: 2021
    }),
    createRemoteTrack({
      path: 'subsonic://1/teen-2',
      source_track_id: 'teen-2',
      title: 'Teen Feature',
      artist: 'Jane Remover feat. Venturing',
      album: 'Teen Week',
      artwork_hash: 'teen-b',
      track_number: 2,
      year: 2021
    })
  ])
}

async function setupLegacyPlaycountLibrary(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'astra-library-playcount-migration-'))
  process.env.ASTRA_TEST_USER_DATA = dir

  const directDb = new TestSqliteDatabase(join(dir, 'library.db'))
  try {
    directDb.prepare(`
      CREATE TABLE tracks (
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
        sync_session_key TEXT,
        latest_sync_dismissed_at INTEGER,
        added_at INTEGER NOT NULL,
        modified_at INTEGER NOT NULL
      )
    `).run()
    directDb.prepare(`
      INSERT INTO tracks (
        path,
        title,
        artist,
        album,
        duration,
        format,
        source_type,
        is_available,
        added_at,
        modified_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'local', 1, ?, ?)
    `).run('/legacy/track.flac', 'Legacy Track', 'Legacy Artist', 'Legacy Album', 180, 'flac', 1_000, 1_000)
    directDb.prepare(`
      CREATE TABLE recently_played (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_path TEXT NOT NULL,
        played_at INTEGER NOT NULL
      )
    `).run()
    directDb.prepare('INSERT INTO recently_played (track_path, played_at) VALUES (?, ?)').run('/legacy/track.flac', 2_000)
  } finally {
    directDb.close()
  }

  await library.initDatabase()

  t.after(async () => {
    library.closeDatabase()
    delete process.env.ASTRA_TEST_USER_DATA
    await rm(dir, { recursive: true, force: true })
  })

  return dir
}

test('playcount migration adds fresh aggregate fields without backfilling recent history', async (t) => {
  await setupLegacyPlaycountLibrary(t)

  const track = library.getTrackByPath('/legacy/track.flac')
  assert.equal(track?.play_count, 0)
  assert.equal(track?.last_played_at, null)

  const recent = library.getRecentlyPlayed(1)
  assert.equal(recent[0]?.path, '/legacy/track.flac')
  assert.equal(recent[0]?.play_count, 0)
  assert.equal(recent[0]?.last_played_at, null)
})

test('qualified play records recent history and updates track aggregates', async (t) => {
  await setupSeededLibrary(t)

  const trackPath = 'subsonic://1/split-a'
  const originalDateNow = Date.now
  let now = 1_800_000
  Date.now = () => now

  try {
    const initialTrack = library.getTrackByPath(trackPath)
    assert.equal(initialTrack?.play_count, 0)
    assert.equal(initialTrack?.last_played_at, null)

    await library.addRecentlyPlayed(trackPath)
    const firstPlayTrack = library.getTrackByPath(trackPath)
    assert.equal(firstPlayTrack?.play_count, 1)
    assert.equal(firstPlayTrack?.last_played_at, 1_800_000)

    now = 1_805_000
    await library.addRecentlyPlayed(trackPath)
    const secondPlayTrack = library.getTrackByPath(trackPath)
    assert.equal(secondPlayTrack?.play_count, 2)
    assert.equal(secondPlayTrack?.last_played_at, 1_805_000)

    const recent = library.getRecentlyPlayed(5)
    assert.equal(recent[0]?.path, trackPath)
    assert.equal(recent[0]?.play_count, 2)
    assert.equal(recent[0]?.last_played_at, 1_805_000)
    assert.equal(recent.filter((track) => track.path === trackPath).length, 2)
  } finally {
    Date.now = originalDateNow
  }
})

function updateStoredArtistCredits(userDataDir: string, trackPath: string, artistNames: readonly string[]): void {
  const directDb = new TestSqliteDatabase(join(userDataDir, 'library.db'))
  try {
    directDb.prepare('UPDATE tracks SET artist_names_json = ? WHERE path = ?').run(
      JSON.stringify(artistNames),
      trackPath
    )
  } finally {
    directDb.close()
  }
}

function updateStoredGenreStorage(
  userDataDir: string,
  trackPath: string,
  genre: string | null,
  genreNames: readonly string[] | null
): void {
  const directDb = new TestSqliteDatabase(join(userDataDir, 'library.db'))
  try {
    directDb.prepare('UPDATE tracks SET genre = ?, genre_names_json = ? WHERE path = ?').run(
      genre,
      genreNames ? JSON.stringify(genreNames) : null,
      trackPath
    )
  } finally {
    directDb.close()
  }
}

test('metadata file writes rebuild core tags instead of layering changed fields', () => {
  const args = library.buildFfmpegMetadataRewriteArgs({
    title: 'One Song',
    artist: 'One Artist',
    album: 'One Album',
    albumArtist: 'Album Artist',
    genre: 'Electronic',
    year: 2026,
    trackNumber: 7,
    discNumber: 1
  })

  assert.deepEqual(args, [
    '-map_metadata', '-1',
    '-metadata', 'title=One Song',
    '-metadata', 'artist=One Artist',
    '-metadata', 'album=One Album',
    '-metadata', 'album_artist=Album Artist',
    '-metadata', 'genre=Electronic',
    '-metadata', 'date=2026',
    '-metadata', 'year=2026',
    '-metadata', 'track=7',
    '-metadata', 'disc=1'
  ])
})

test('total track duration sums positive durations and returns zero for empty libraries', async (t) => {
  await setupEmptyLibrary(t)

  assert.equal(library.getTotalTrackDuration(), 0)

  const source = await library.createSubsonicSource({
    name: 'Duration Source',
    base_url: 'https://duration.example.test',
    username: 'tester',
    secret_encrypted: 'secret',
    enabled: 1,
    last_status: 'ok'
  })

  await library.upsertSubsonicTracks(source.id, [
    createRemoteTrack({
      path: 'subsonic://duration/short',
      source_track_id: 'duration-short',
      title: 'Short Track',
      artist: 'Duration Artist',
      album: 'Duration Album',
      duration: 61.5
    }),
    createRemoteTrack({
      path: 'subsonic://duration/long',
      source_track_id: 'duration-long',
      title: 'Long Track',
      artist: 'Duration Artist',
      album: 'Duration Album',
      duration: 3661
    }),
    createRemoteTrack({
      path: 'subsonic://duration/unknown',
      source_track_id: 'duration-unknown',
      title: 'Unknown Duration',
      artist: 'Duration Artist',
      album: 'Duration Album',
      duration: 0
    })
  ])

  assert.equal(library.getTotalTrackDuration(), 3722.5)
})

test('library grouping queries preserve shared-cover compilation identities', async (t) => {
  await setupSeededLibrary(t)

  const splitAlbum = library.getAlbums().find((album) => album.album === 'Split Release')
  assert.ok(splitAlbum)
  assert.equal(splitAlbum.artist, 'Various Artists')
  assert.equal(splitAlbum.primary_artist, null)
  assert.equal(splitAlbum.track_count, 2)
  assert.equal(splitAlbum.identity_key, 'album:split release::ah:shared-cover')

  const byAlbum = library.getTracksByAlbum('Split Release', 'Various Artists', splitAlbum.identity_key)
  assert.deepEqual(byAlbum.map((track) => track.title), ['Split A', 'Split B'])
  assert.ok(byAlbum.every((track) => track.album_identity_key === splitAlbum.identity_key))

  const byArtist = library.getTracksByArtist('Artist A')
  assert.deepEqual(byArtist.map((track) => track.title), ['Split A'])
  assert.equal(byArtist[0].album_identity_key, splitAlbum.identity_key)
  assert.deepEqual(byArtist[0].artist_names, [])
  assert.deepEqual(byArtist[0].album_artist_names, [])
})

test('library artist queries preserve primary-artist album grouping', async (t) => {
  await setupSeededLibrary(t)

  const teenAlbum = library.getAlbums().find((album) => album.album === 'Teen Week')
  assert.ok(teenAlbum)
  assert.equal(teenAlbum.artist, 'Jane Remover')
  assert.equal(teenAlbum.primary_artist, 'Jane Remover')
  assert.equal(teenAlbum.track_count, 2)
  assert.equal(teenAlbum.identity_key, 'album:teen week::ta:jane remover')

  const janeTracks = library.getTracksByArtist('Jane Remover')
  assert.deepEqual(janeTracks.map((track) => track.title), ['Teen Intro', 'Teen Feature'])
  assert.ok(janeTracks.every((track) => track.album_identity_key === teenAlbum.identity_key))
})

test('library artist records distinguish primary and collaborator-only canonical artists', async (t) => {
  const userDataDir = await setupEmptyLibrary(t)

  const source = await library.createSubsonicSource({
    name: 'Test Source',
    base_url: 'https://music.example.test',
    username: 'tester',
    secret_encrypted: 'secret',
    enabled: 1,
    last_status: 'ok'
  })

  await library.upsertSubsonicTracks(source.id, [
    createRemoteTrack({
      path: 'subsonic://1/collab-1',
      source_track_id: 'collab-1',
      title: 'Shared Song',
      artist: 'Primary Artist & Guest Artist',
      album: 'Collab Release',
      track_number: 1
    }),
    createRemoteTrack({
      path: 'subsonic://1/collab-2',
      source_track_id: 'collab-2',
      title: 'Follow Up',
      artist: 'Primary Artist',
      album: 'Collab Release',
      track_number: 2
    }),
    createRemoteTrack({
      path: 'subsonic://1/single',
      source_track_id: 'single',
      title: 'Loose Single',
      artist: 'Primary Artist',
      album: 'Loose Single'
    })
  ])
  updateStoredArtistCredits(userDataDir, 'subsonic://1/collab-1', ['Primary Artist', 'Guest Artist'])

  const canonicalArtists = library.getArtists('canonical')
  const primaryArtist = canonicalArtists.find((artist) => artist.artist === 'Primary Artist')
  const guestArtist = canonicalArtists.find((artist) => artist.artist === 'Guest Artist')

  assert.ok(primaryArtist)
  assert.equal(primaryArtist.track_count, 3)
  assert.equal(primaryArtist.primary_track_count, 3)
  assert.equal(primaryArtist.album_count, 1)
  assert.ok(guestArtist)
  assert.equal(guestArtist.track_count, 1)
  assert.equal(guestArtist.primary_track_count, 0)
  assert.equal(guestArtist.album_count, 1)

  const strictArtists = library.getArtists('strict')
  const strictArtist = strictArtists.find((artist) => artist.artist === 'Primary Artist & Guest Artist')
  assert.ok(strictArtist)
  assert.equal(strictArtist.track_count, 1)
  assert.equal(strictArtist.primary_track_count, strictArtist.track_count)
  assert.equal(strictArtist.album_count, 1)

  const strictPrimaryArtist = strictArtists.find((artist) => artist.artist === 'Primary Artist')
  assert.ok(strictPrimaryArtist)
  assert.equal(strictPrimaryArtist.track_count, 2)
  assert.equal(strictPrimaryArtist.primary_track_count, strictPrimaryArtist.track_count)
  assert.equal(strictPrimaryArtist.album_count, 1)
})

test('library genre queries normalize multi-genre tags and fall back to scalar genre', async (t) => {
  const userDataDir = await setupEmptyLibrary(t)

  const source = await library.createSubsonicSource({
    name: 'Genre Source',
    base_url: 'https://music.example.test',
    username: 'tester',
    secret_encrypted: 'secret',
    enabled: 1,
    last_status: 'ok'
  })

  await library.upsertSubsonicTracks(source.id, [
    createRemoteTrack({
      path: 'subsonic://1/genre-multi',
      source_track_id: 'genre-multi',
      title: 'Multi Genre',
      artist: 'Genre Artist',
      album: 'Album One',
      artwork_hash: 'cover-one',
      track_number: 1,
      year: 2024,
      genres: ['Electronic; Ambient', 'Jazz, Funk/ Fusion', 'Electronic']
    }),
    createRemoteTrack({
      path: 'subsonic://1/genre-electronic',
      source_track_id: 'genre-electronic',
      title: 'Electronic Two',
      artist: 'Genre Artist',
      album: 'Album Two',
      artwork_hash: 'cover-two',
      track_number: 1,
      year: 2025,
      genres: ['Electronic']
    }),
    createRemoteTrack({
      path: 'subsonic://1/genre-scalar',
      source_track_id: 'genre-scalar',
      title: 'Scalar Fallback',
      artist: 'Fallback Artist',
      album: 'Fallback Album',
      artwork_hash: 'cover-fallback',
      genre: 'Trip Hop; Downtempo'
    })
  ])
  updateStoredGenreStorage(userDataDir, 'subsonic://1/genre-scalar', 'Trip Hop; Downtempo', null)

  const genres = library.getGenres()
  const byGenre = new Map(genres.map((genre) => [genre.genre, genre]))

  assert.equal(byGenre.get('Electronic')?.track_count, 2)
  assert.equal(byGenre.get('Electronic')?.album_count, 2)
  assert.equal(byGenre.get('Electronic')?.artwork_hash, 'cover-two')
  assert.equal(byGenre.get('Ambient')?.track_count, 1)
  assert.equal(byGenre.get('Jazz, Funk/ Fusion')?.track_count, 1)
  assert.equal(byGenre.get('Trip Hop')?.track_count, 1)
  assert.equal(byGenre.get('Downtempo')?.track_count, 1)
  assert.equal(byGenre.has('Jazz'), false)
  assert.equal(byGenre.has('Funk'), false)
  assert.equal(byGenre.has('Fusion'), false)

  const multiGenreTrack = library.getTrackByPath('subsonic://1/genre-multi')
  assert.ok(multiGenreTrack)
  assert.equal(multiGenreTrack.genre, 'Electronic; Ambient; Jazz, Funk/ Fusion')
  assert.deepEqual(multiGenreTrack.genres, ['Electronic', 'Ambient', 'Jazz, Funk/ Fusion'])

  const electronicTracks = library.getTracksByGenre('electronic')
  assert.deepEqual(electronicTracks.map((track) => track.title), ['Multi Genre', 'Electronic Two'])
  assert.ok(electronicTracks.every((track) => track.genres.includes('Electronic')))

  const fallbackTracks = library.getTracksByGenre('downtempo')
  assert.deepEqual(fallbackTracks.map((track) => track.title), ['Scalar Fallback'])
  assert.equal(fallbackTracks[0].genre, 'Trip Hop; Downtempo')
  assert.deepEqual(fallbackTracks[0].genres, ['Trip Hop', 'Downtempo'])

  assert.deepEqual(library.getTracksByGenre('Jazz').map((track) => track.title), [])
  assert.deepEqual(library.getTracksByGenre('Jazz, Funk/ Fusion').map((track) => track.title), ['Multi Genre'])
})

test('library search returns public track shape with album identities', async (t) => {
  await setupSeededLibrary(t)

  const results = library.searchTracks('Split')
  assert.deepEqual(results.map((track) => track.title), ['Split A', 'Split B'])
  assert.ok(results.every((track) => track.album_identity_key === 'album:split release::ah:shared-cover'))
  assert.ok(results.every((track) => Array.isArray(track.artist_names)))
  assert.ok(results.every((track) => Array.isArray(track.album_artist_names)))
  assert.ok(results.every((track) => track.is_new === false))
})

test('library track pages preserve ordering and album identities across page boundaries', async (t) => {
  await setupSeededLibrary(t)

  const allTracks = library.getAllTracks()
  const firstPage = library.getTrackPage({ offset: 0, limit: 1 })
  const secondPage = library.getTrackPage({ offset: 1, limit: 2 })

  assert.equal(firstPage.total, allTracks.length)
  assert.equal(firstPage.limit, 1)
  assert.equal(firstPage.offset, 0)
  assert.equal(firstPage.nextOffset, 1)
  assert.equal(firstPage.hasMore, true)
  assert.deepEqual(firstPage.tracks.map((track) => track.path), allTracks.slice(0, 1).map((track) => track.path))
  assert.deepEqual(secondPage.tracks.map((track) => track.path), allTracks.slice(1, 3).map((track) => track.path))

  const splitAlbum = library.getAlbums().find((album) => album.album === 'Split Release')
  assert.ok(splitAlbum)
  assert.equal(firstPage.tracks[0].album_identity_key, splitAlbum.identity_key)
  assert.equal(secondPage.tracks[0].album_identity_key, splitAlbum.identity_key)
})

test('getTracksByPaths preserves request order, duplicates, and public metadata shape', async (t) => {
  await setupSeededLibrary(t)

  const tracks = library.getTracksByPaths([
    'subsonic://1/teen-2',
    'missing://track',
    'subsonic://1/split-a',
    'subsonic://1/teen-2'
  ])

  assert.deepEqual(tracks.map((track) => track.path), [
    'subsonic://1/teen-2',
    'subsonic://1/split-a',
    'subsonic://1/teen-2'
  ])
  assert.deepEqual(tracks.map((track) => track.title), [
    'Teen Feature',
    'Split A',
    'Teen Feature'
  ])

  const splitTrack = tracks[1]
  assert.equal(splitTrack.artist, 'Artist A')
  assert.deepEqual(splitTrack.artist_names, [])
  assert.equal(splitTrack.codec, 'flac')
  assert.equal(splitTrack.channels, 2)
  assert.equal(splitTrack.source_type, 'subsonic')
  assert.ok(splitTrack.album_identity_key)
  assert.equal(splitTrack.is_new, false)
})

test('subsonic metadata upsert can preserve existing artwork until lazy cover refresh', async (t) => {
  await setupEmptyLibrary(t)

  const source = await library.createSubsonicSource({
    name: 'Artwork Source',
    base_url: 'https://music.example.test',
    username: 'tester',
    secret_encrypted: 'secret',
    enabled: 1,
    last_status: 'ok'
  })
  const trackPath = `subsonic://${source.id}/track/artwork-track`

  await library.upsertSubsonicTracks(source.id, [
    createRemoteTrack({
      path: trackPath,
      source_track_id: 'artwork-track',
      title: 'Artwork Track',
      artist: 'Artwork Artist',
      album: 'Artwork Album',
      artwork_hash: 'cached-cover.jpg'
    })
  ])
  await library.upsertSubsonicTracks(source.id, [
    createRemoteTrack({
      path: trackPath,
      source_track_id: 'artwork-track',
      title: 'Artwork Track',
      artist: 'Artwork Artist',
      album: 'Artwork Album',
      artwork_hash: null
    })
  ], {
    preserveExistingArtwork: true
  })

  assert.equal(library.getTrackByPath(trackPath)?.artwork_hash, 'cached-cover.jpg')
})

test('subsonic sync helpers import starred tracks and server playlists', async (t) => {
  await setupEmptyLibrary(t)

  const source = await library.createSubsonicSource({
    name: 'Remote Source',
    base_url: 'https://music.example.test',
    username: 'tester',
    secret_encrypted: 'secret',
    enabled: 1,
    last_status: 'ok'
  })
  const firstPath = `subsonic://${source.id}/track/remote-a`
  const secondPath = `subsonic://${source.id}/track/remote-b`

  await library.upsertSubsonicTracks(source.id, [
    createRemoteTrack({
      path: firstPath,
      source_track_id: 'remote-a',
      title: 'Remote A',
      artist: 'Remote Artist',
      album: 'Remote Album'
    }),
    createRemoteTrack({
      path: secondPath,
      source_track_id: 'remote-b',
      title: 'Remote B',
      artist: 'Remote Artist',
      album: 'Remote Album'
    })
  ])

  const favoritesInserted = await library.syncSubsonicFavoriteTrackIds(source.id, ['remote-b', 'missing'], { persist: false })
  assert.equal(favoritesInserted, 1)
  assert.deepEqual(library.getFavoritePaths(), [secondPath])

  const createdSummary = await library.syncSubsonicRemotePlaylists(source.id, [
    {
      source_playlist_id: 'playlist-1',
      name: 'Server Mix',
      tracks: [
        { path: firstPath, title: 'Remote A', artist: 'Remote Artist', album: 'Remote Album' },
        { path: secondPath, title: 'Remote B', artist: 'Remote Artist', album: 'Remote Album' }
      ]
    }
  ], { persist: false })
  assert.deepEqual(createdSummary, { created: 1, updated: 0, removed: 0 })

  const playlist = library.getPlaylists().find((entry) => entry.name === 'Server Mix')
  assert.ok(playlist)
  assert.equal(playlist.track_count, 2)
  assert.deepEqual(library.getPlaylistTracks(playlist.id).map((track) => track.path), [firstPath, secondPath])

  const updatedSummary = await library.syncSubsonicRemotePlaylists(source.id, [
    {
      source_playlist_id: 'playlist-1',
      name: 'Server Mix Renamed',
      tracks: [
        { path: secondPath, title: 'Remote B', artist: 'Remote Artist', album: 'Remote Album' }
      ]
    }
  ], { persist: false })
  assert.deepEqual(updatedSummary, { created: 0, updated: 1, removed: 0 })

  const updatedPlaylist = library.getPlaylists().find((entry) => entry.id === playlist.id)
  assert.ok(updatedPlaylist)
  assert.equal(updatedPlaylist.name, 'Server Mix Renamed')
  assert.deepEqual(library.getPlaylistTracks(playlist.id).map((track) => track.path), [secondPath])

  const removedSummary = await library.syncSubsonicRemotePlaylists(source.id, [], { persist: false })
  assert.deepEqual(removedSummary, { created: 0, updated: 0, removed: 1 })
  assert.equal(library.getPlaylists().some((entry) => entry.id === playlist.id), false)
})

test('force scan rewrites unchanged local metadata that incremental scan skips', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const trackPath = join(musicDir, 'track.wav')
  await mkdir(musicDir)
  await writeTaggedWavFixture(trackPath, 'Initial Title', 'Initial Artist')

  const initialScan = await library.scanFolder(musicDir)
  assert.equal(initialScan.added, 1)
  assert.equal(initialScan.updated, 0)
  assert.equal(initialScan.errors, 0)
  assert.equal(library.getTrackByPath(trackPath)?.title, 'Initial Title')

  const originalStat = await stat(trackPath)
  await writeTaggedWavFixture(trackPath, 'Updated Title', 'Updated Artist')
  await utimes(trackPath, originalStat.atime, originalStat.mtime)

  const incrementalScan = await library.scanFolder(musicDir, undefined, { mode: 'incremental' })
  assert.equal(incrementalScan.added, 0)
  assert.equal(incrementalScan.updated, 0)
  assert.equal(incrementalScan.errors, 0)
  assert.equal(library.getTrackByPath(trackPath)?.title, 'Initial Title')

  const forceScan = await library.scanFolder(musicDir, undefined, { mode: 'force' })
  assert.equal(forceScan.added, 0)
  assert.equal(forceScan.updated, 1)
  assert.equal(forceScan.errors, 0)
  assert.equal(library.getTrackByPath(trackPath)?.title, 'Updated Title')
  assert.equal(library.getTrackByPath(trackPath)?.artist, 'Updated Artist')
})

test('local scan uses same-folder cover image when embedded artwork is missing', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const trackPath = join(musicDir, 'track.wav')
  const coverPath = join(musicDir, 'cover.png')
  await mkdir(musicDir)
  await writeTaggedWavFixture(trackPath, 'Sidecar Title', 'Sidecar Artist')
  await writeFile(coverPath, TINY_PNG_FIXTURE)

  const scan = await library.scanFolder(musicDir)
  assert.equal(scan.added, 1)
  assert.equal(scan.updated, 0)
  assert.equal(scan.errors, 0)

  const artworkHash = library.getTrackByPath(trackPath)?.artwork_hash
  assert.ok(artworkHash)
  assert.equal(artworkHash.endsWith('.png'), true)
  assert.deepEqual(await readFile(library.getArtworkPath(artworkHash)), TINY_PNG_FIXTURE)
})

test('local scan finds folder artwork names case-insensitively', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const trackPath = join(musicDir, 'track.wav')
  await mkdir(musicDir)
  await writeTaggedWavFixture(trackPath, 'Case Title', 'Case Artist')
  await writeFile(join(musicDir, 'Folder.JPG'), TINY_PNG_FIXTURE)

  const scan = await library.scanFolder(musicDir)
  assert.equal(scan.added, 1)
  assert.equal(scan.errors, 0)

  const artworkHash = library.getTrackByPath(trackPath)?.artwork_hash
  assert.ok(artworkHash)
  assert.deepEqual(await readFile(library.getArtworkPath(artworkHash)), TINY_PNG_FIXTURE)
})

test('incremental local scan backfills sidecar artwork for unchanged tracks', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const trackPath = join(musicDir, 'track.wav')
  await mkdir(musicDir)
  await writeTaggedWavFixture(trackPath, 'Backfill Title', 'Backfill Artist')

  const initialScan = await library.scanFolder(musicDir)
  assert.equal(initialScan.added, 1)
  assert.equal(initialScan.updated, 0)
  assert.equal(initialScan.errors, 0)
  assert.equal(library.getTrackByPath(trackPath)?.artwork_hash, null)

  await writeFile(join(musicDir, 'cover.png'), TINY_PNG_FIXTURE)

  const incrementalScan = await library.scanFolder(musicDir, undefined, { mode: 'incremental' })
  assert.equal(incrementalScan.added, 0)
  assert.equal(incrementalScan.updated, 1)
  assert.equal(incrementalScan.errors, 0)

  const artworkHash = library.getTrackByPath(trackPath)?.artwork_hash
  assert.ok(artworkHash)
  assert.deepEqual(await readFile(library.getArtworkPath(artworkHash)), TINY_PNG_FIXTURE)
})

test('playlist import matches percent-encoded local M3U paths', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const encodedTrackPath = join(musicDir, 'Encoded Name.wav')
  const literalPercentTrackPath = join(musicDir, 'Literal%20Name.wav')
  await mkdir(musicDir)
  await writeTaggedWavFixture(encodedTrackPath, 'Encoded Name', 'Import Artist')
  await writeTaggedWavFixture(literalPercentTrackPath, 'Literal Percent Name', 'Import Artist')

  const scan = await library.scanFolder(musicDir)
  assert.equal(scan.added, 2)
  assert.equal(scan.errors, 0)

  const encodedEntry = relative(dir, encodedTrackPath).replace('Encoded Name', 'Encoded%20Name')
  const encodedPlaylistPath = join(dir, 'encoded-path.m3u')
  await writeFile(encodedPlaylistPath, `#EXTM3U\n${encodedEntry}\n`, 'utf-8')

  const encodedResult = await library.importPlaylistFromFile(encodedPlaylistPath)
  assert.equal(encodedResult.detectedFormat, 'm3u')
  assert.equal(encodedResult.entriesTotal, 1)
  assert.equal(encodedResult.importedCount, 1)
  assert.equal(encodedResult.missingEntryCount, 0)
  assert.equal(encodedResult.matchedByPathCount, 1)
  assert.equal(encodedResult.unmatchedCount, 0)
  assert.equal(encodedResult.unsupportedEntryCount, 0)
  assert.ok(encodedResult.playlistId)
  assert.deepEqual(library.getPlaylistTracks(encodedResult.playlistId).map((track) => track.path), [encodedTrackPath])

  const literalPercentPlaylistPath = join(dir, 'literal-percent-path.m3u')
  await writeFile(literalPercentPlaylistPath, `#EXTM3U\n${relative(dir, literalPercentTrackPath)}\n`, 'utf-8')

  const literalPercentResult = await library.importPlaylistFromFile(literalPercentPlaylistPath)
  assert.equal(literalPercentResult.importedCount, 1)
  assert.equal(literalPercentResult.missingEntryCount, 0)
  assert.equal(literalPercentResult.matchedByPathCount, 1)
  assert.ok(literalPercentResult.playlistId)
  assert.deepEqual(library.getPlaylistTracks(literalPercentResult.playlistId).map((track) => track.path), [literalPercentTrackPath])
})

test('playlist import matches VLC-style file URI M3U paths', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const vlcMusicDir = join(musicDir, '\u25b6 Music')
  const trackPath = join(vlcMusicDir, '01 Tia Na S\u00e9.wav')
  await mkdir(vlcMusicDir, { recursive: true })
  await writeTaggedWavFixture(trackPath, 'Tia Na Se', 'Rambo goyard')

  const scan = await library.scanFolder(musicDir)
  assert.equal(scan.added, 1)
  assert.equal(scan.errors, 0)

  const playlistPath = join(dir, 'vlc-file-uri-path.m3u')
  await writeFile(
    playlistPath,
    [
      '#EXTM3U',
      '#EXTINF:165,Rambo goyard - Tia Na S\u00e9',
      pathToFileURL(trackPath).href,
      ''
    ].join('\n'),
    'utf-8'
  )

  const result = await library.importPlaylistFromFile(playlistPath)
  assert.equal(result.detectedFormat, 'm3u')
  assert.equal(result.entriesTotal, 1)
  assert.equal(result.importedCount, 1)
  assert.equal(result.missingEntryCount, 0)
  assert.equal(result.matchedByPathCount, 1)
  assert.equal(result.unmatchedCount, 0)
  assert.equal(result.unsupportedEntryCount, 0)
  assert.ok(result.playlistId)
  assert.deepEqual(library.getPlaylistTracks(result.playlistId).map((track) => track.path), [trackPath])
})

test('playlist import falls back to metadata for unsupported M3U URIs', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const matchedTrackPath = join(musicDir, 'unsupported-uri-match.wav')
  await mkdir(musicDir)
  await writeTaggedWavFixture(matchedTrackPath, 'Unsupported URI Match', 'Import Artist')

  const scan = await library.scanFolder(musicDir)
  assert.equal(scan.added, 1)
  assert.equal(scan.errors, 0)

  const matchedPlaylistPath = join(dir, 'unsupported-uri-match.m3u')
  await writeFile(
    matchedPlaylistPath,
    '#EXTM3U\n#EXTINF:123,Import Artist - Unsupported URI Match\nspotify:track:matched\n',
    'utf-8'
  )

  const matchedResult = await library.importPlaylistFromFile(matchedPlaylistPath)
  assert.equal(matchedResult.detectedFormat, 'm3u')
  assert.equal(matchedResult.entriesTotal, 1)
  assert.equal(matchedResult.importedCount, 1)
  assert.equal(matchedResult.missingEntryCount, 0)
  assert.equal(matchedResult.matchedByPathCount, 0)
  assert.equal(matchedResult.matchedByMetadataCount, 1)
  assert.equal(matchedResult.unmatchedCount, 0)
  assert.equal(matchedResult.unsupportedEntryCount, 0)
  assert.ok(matchedResult.playlistId)
  assert.deepEqual(library.getPlaylistTracks(matchedResult.playlistId).map((track) => track.path), [matchedTrackPath])

  const unmatchedPlaylistPath = join(dir, 'unsupported-uri-unmatched.m3u')
  await writeFile(
    unmatchedPlaylistPath,
    '#EXTM3U\n#EXTINF:123,Import Artist - Missing Unsupported URI\nspotify:track:missing\n',
    'utf-8'
  )

  const unmatchedResult = await library.importPlaylistFromFile(unmatchedPlaylistPath)
  assert.equal(unmatchedResult.entriesTotal, 1)
  assert.equal(unmatchedResult.importedCount, 0)
  assert.equal(unmatchedResult.missingEntryCount, 1)
  assert.equal(unmatchedResult.matchedByMetadataCount, 0)
  assert.equal(unmatchedResult.unmatchedCount, 1)
  assert.equal(unmatchedResult.unsupportedEntryCount, 0)
  assert.ok(unmatchedResult.playlistId)
  assert.deepEqual(library.getPlaylistTracks(unmatchedResult.playlistId).map((track) => track.path), [])
  assert.deepEqual(library.getPlaylistTrackEntries(unmatchedResult.playlistId).map((entry) => ({
    path: entry.track_path,
    title: entry.title,
    artist: entry.artist,
    missing: entry.missing
  })), [{ path: 'spotify:track:missing', title: 'Missing Unsupported URI', artist: 'Import Artist', missing: true }])

  const recoveredTrackPath = join(musicDir, 'recovered-unsupported-uri.wav')
  await writeTaggedWavFixture(recoveredTrackPath, 'Missing Unsupported URI', 'Import Artist')
  const recoveryScan = await library.scanFolder(musicDir)
  assert.equal(recoveryScan.added, 1)
  assert.equal(recoveryScan.errors, 0)

  const recoveredEntries = library.getPlaylistTrackEntries(unmatchedResult.playlistId)
  assert.deepEqual(recoveredEntries.map((entry) => ({
    path: entry.track_path,
    missing: entry.missing,
    title: entry.track?.title ?? entry.title
  })), [{ path: recoveredTrackPath, missing: false, title: 'Missing Unsupported URI' }])
})

test('playlist import preserves unmatched local paths as missing playlist entries', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const availableTrackPath = join(musicDir, 'available-import.wav')
  const missingTrackPath = join(musicDir, 'missing-import.wav')
  const secondMissingTrackPath = join(musicDir, 'missing-import-two.wav')
  await mkdir(musicDir)
  await writeTaggedWavFixture(availableTrackPath, 'Available Import', 'Import Artist')

  const scan = await library.scanFolder(musicDir)
  assert.equal(scan.added, 1)
  assert.equal(scan.errors, 0)

  const playlistPath = join(dir, 'mixed-existing-and-missing.m3u')
  await writeFile(
    playlistPath,
    [
      '#EXTM3U',
      relative(dir, availableTrackPath),
      relative(dir, missingTrackPath),
      '#EXTINF:123,Missing Artist - Missing Import Two',
      relative(dir, secondMissingTrackPath),
      ''
    ].join('\n'),
    'utf-8'
  )

  const result = await library.importPlaylistFromFile(playlistPath)
  assert.equal(result.detectedFormat, 'm3u')
  assert.equal(result.entriesTotal, 3)
  assert.equal(result.importedCount, 1)
  assert.equal(result.missingEntryCount, 2)
  assert.equal(result.matchedByPathCount, 1)
  assert.equal(result.unmatchedCount, 2)
  assert.equal(result.unsupportedEntryCount, 0)
  assert.ok(result.playlistId)

  assert.deepEqual(library.getPlaylistTracks(result.playlistId).map((track) => track.path), [availableTrackPath])

  const entries = library.getPlaylistTrackEntries(result.playlistId)
  assert.deepEqual(entries.map((entry) => entry.track_path), [
    availableTrackPath,
    missingTrackPath,
    secondMissingTrackPath
  ])
  assert.deepEqual(entries.map((entry) => entry.missing), [false, true, true])

  const playlistSummary = library.getPlaylists().find((entry) => entry.id === result.playlistId)
  assert.ok(playlistSummary)
  assert.equal(playlistSummary.track_count, 1)
  assert.equal(playlistSummary.missing_track_count, 2)
})

test('playlist reorder preserves missing track entries after cleanup', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const missingTrackPath = join(musicDir, 'missing.wav')
  const availableTrackPath = join(musicDir, 'available.wav')
  await mkdir(musicDir)
  await writeTaggedWavFixture(missingTrackPath, 'Missing Track', 'Playlist Artist')
  await writeTaggedWavFixture(availableTrackPath, 'Available Track', 'Playlist Artist')

  const scan = await library.scanFolder(musicDir)
  assert.equal(scan.added, 2)
  assert.equal(scan.errors, 0)

  const playlist = await library.createPlaylist('Preserved Missing Entries')
  await library.addToPlaylist(playlist.id, [missingTrackPath, availableTrackPath])

  await rm(missingTrackPath)
  const removed = await library.cleanupMissingTracks()
  assert.equal(removed, 1)

  assert.deepEqual(library.getPlaylistTracks(playlist.id).map((track) => track.path), [availableTrackPath])

  const entries = library.getPlaylistTrackEntries(playlist.id)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map((entry) => entry.track_path), [missingTrackPath, availableTrackPath])
  assert.deepEqual(entries.map((entry) => entry.missing), [true, false])
  assert.equal(entries[0].track, null)
  assert.equal(entries[1].track?.path, availableTrackPath)

  const playlistSummary = library.getPlaylists().find((entry) => entry.id === playlist.id)
  assert.ok(playlistSummary)
  assert.equal(playlistSummary.track_count, 1)
  assert.equal(playlistSummary.missing_track_count, 1)
  assert.equal(playlistSummary.auto_cover_hash, library.getTrackByPath(availableTrackPath)?.artwork_hash ?? null)

  await library.reorderPlaylistTracks(playlist.id, [availableTrackPath, missingTrackPath])
  const reorderedEntries = library.getPlaylistTrackEntries(playlist.id)
  assert.deepEqual(reorderedEntries.map((entry) => entry.track_path), [availableTrackPath, missingTrackPath])
  assert.deepEqual(reorderedEntries.map((entry) => entry.missing), [false, true])
})

test('playlist export writes extended M3U with relative local paths', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const nestedDir = join(musicDir, 'Export Artist')
  const firstTrackPath = join(nestedDir, 'First Track.wav')
  const secondTrackPath = join(musicDir, 'Second Track.wav')
  await mkdir(nestedDir, { recursive: true })
  await writeTaggedWavFixture(firstTrackPath, 'First Track', 'Export Artist')
  await writeTaggedWavFixture(secondTrackPath, 'Second Track', 'Export Artist')

  const scan = await library.scanFolder(musicDir)
  assert.equal(scan.added, 2)
  assert.equal(scan.errors, 0)

  const playlist = await library.createPlaylist('Export Set')
  await library.addToPlaylist(playlist.id, [firstTrackPath, secondTrackPath])

  const exportDir = join(dir, 'exports')
  await mkdir(exportDir)
  const exportPath = join(exportDir, 'Export Set.m3u8')
  const result = await library.exportPlaylistToM3u(playlist.id, exportPath)

  assert.equal(result.format, 'm3u8')
  assert.equal(result.exportedCount, 2)
  assert.deepEqual(result.warnings, [])

  const lines = (await readFile(exportPath, 'utf-8')).trimEnd().split('\n')
  assert.equal(lines[0], '#EXTM3U')
  assert.match(lines[1], /^#EXTINF:-?\d+,Export Artist - First Track$/)
  assert.equal(lines[2], relative(exportDir, firstTrackPath).replace(/\\/g, '/'))
  assert.match(lines[3], /^#EXTINF:-?\d+,Export Artist - Second Track$/)
  assert.equal(lines[4], relative(exportDir, secondTrackPath).replace(/\\/g, '/'))
})

test('playlist export preserves missing imported entries', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const missingTrackPath = join(musicDir, 'missing-export.wav')
  await mkdir(musicDir)

  const playlistPath = join(dir, 'missing-export-source.m3u')
  await writeFile(
    playlistPath,
    [
      '#EXTM3U',
      '#EXTINF:123,Missing Artist - Missing Export',
      relative(dir, missingTrackPath),
      ''
    ].join('\n'),
    'utf-8'
  )

  const importResult = await library.importPlaylistFromFile(playlistPath)
  assert.equal(importResult.importedCount, 0)
  assert.equal(importResult.missingEntryCount, 1)
  assert.ok(importResult.playlistId)

  const exportDir = join(dir, 'exports')
  await mkdir(exportDir)
  const exportPath = join(exportDir, 'missing-export.m3u8')
  const exportResult = await library.exportPlaylistToM3u(importResult.playlistId, exportPath)

  assert.equal(exportResult.exportedCount, 1)
  const lines = (await readFile(exportPath, 'utf-8')).trimEnd().split('\n')
  assert.deepEqual(lines, [
    '#EXTM3U',
    '#EXTINF:-1,Missing Artist - Missing Export',
    relative(exportDir, missingTrackPath).replace(/\\/g, '/')
  ])
})

test('playlist export supports Favorites as an M3U playlist', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const favoriteTrackPath = join(musicDir, 'favorite-export.wav')
  await mkdir(musicDir)
  await writeTaggedWavFixture(favoriteTrackPath, 'Favorite Export', 'Favorite Artist')

  const scan = await library.scanFolder(musicDir)
  assert.equal(scan.added, 1)
  assert.equal(scan.errors, 0)
  await library.addFavorite(favoriteTrackPath)

  const exportDir = join(dir, 'exports')
  await mkdir(exportDir)
  const exportPath = join(exportDir, 'Favorites.m3u8')
  const result = await library.exportPlaylistToM3u(-1, exportPath)

  assert.equal(result.playlistId, -1)
  assert.equal(result.exportedCount, 1)
  const lines = (await readFile(exportPath, 'utf-8')).trimEnd().split('\n')
  assert.equal(lines[0], '#EXTM3U')
  assert.match(lines[1], /^#EXTINF:-?\d+,Favorite Artist - Favorite Export$/)
  assert.equal(lines[2], relative(exportDir, favoriteTrackPath).replace(/\\/g, '/'))
})

test('playlist export rejects unsupported file extensions', async (t) => {
  const dir = await setupEmptyLibrary(t)
  const playlist = await library.createPlaylist('Invalid Export')

  await assert.rejects(
    () => library.exportPlaylistToM3u(playlist.id, join(dir, 'invalid-export.txt')),
    /Unsupported playlist export format/
  )
})

test('normal playlists default to normal kind', async (t) => {
  await setupSeededLibrary(t)

  const playlist = await library.createPlaylist('Normal Kind')
  assert.equal(playlist.kind, 'normal')

  const summary = library.getPlaylists().find((entry) => entry.id === playlist.id)
  assert.ok(summary)
  assert.equal(summary.kind, 'normal')
})

test('dynamic playlists evaluate metadata rules without stored membership', async (t) => {
  await setupSeededLibrary(t)

  const playlist = await library.createDynamicPlaylist('Jane Dynamic', {
    version: 1,
    conditions: [
      { kind: 'text', field: 'artist', operator: 'contains', value: 'Jane' }
    ],
    sort: { field: 'title', direction: 'asc' },
    limit: null
  })

  assert.equal(playlist.kind, 'dynamic')
  assert.equal(playlist.track_count, 2)

  const tracks = library.getPlaylistTracks(playlist.id)
  assert.deepEqual(tracks.map((track) => track.title), ['Teen Feature', 'Teen Intro'])

  const entries = library.getPlaylistTrackEntries(playlist.id)
  assert.deepEqual(entries.map((entry) => entry.track_path), tracks.map((track) => track.path))
  assert.deepEqual(entries.map((entry) => entry.missing), [false, false])
  assert.ok(entries.every((entry) => entry.id < 0))

  const summary = library.getPlaylists().find((entry) => entry.id === playlist.id)
  assert.ok(summary)
  assert.equal(summary.kind, 'dynamic')
  assert.equal(summary.track_count, 2)
  assert.equal(summary.missing_track_count, 0)
})

test('dynamic playlist filters favorites, play counts, last played, sorting, and limits', async (t) => {
  await setupSeededLibrary(t)

  const playedFavoritePath = 'subsonic://1/teen-1'
  const unplayedFavoritePath = 'subsonic://1/split-a'
  await library.addFavorite(playedFavoritePath)
  await library.addFavorite(unplayedFavoritePath)
  await library.addRecentlyPlayed(playedFavoritePath)

  const playlist = await library.createDynamicPlaylist('Played Favorites', {
    version: 1,
    conditions: [
      { kind: 'exact', field: 'favorite', operator: 'is', value: true },
      { kind: 'numeric', field: 'play_count', operator: 'gte', value: 1 },
      { kind: 'date', field: 'last_played_at', operator: 'within_days', value: 1 }
    ],
    sort: { field: 'play_count', direction: 'desc' },
    limit: 1
  })

  assert.deepEqual(library.getPlaylistTracks(playlist.id).map((track) => track.path), [playedFavoritePath])

  const preview = library.previewDynamicPlaylist({
    version: 1,
    conditions: [
      { kind: 'exact', field: 'favorite', operator: 'is', value: true },
      { kind: 'date', field: 'last_played_at', operator: 'not_within_days', value: 1 }
    ],
    sort: { field: 'title', direction: 'asc' },
    limit: null
  })
  assert.deepEqual(preview.tracks.map((track) => track.path), [unplayedFavoritePath])
  assert.equal(preview.track_count, 1)
})

test('dynamic playlists reject manual membership edits while normal playlists still accept them', async (t) => {
  await setupSeededLibrary(t)

  const dynamicPlaylist = await library.createDynamicPlaylist('All Dynamic', createDefaultDynamicPlaylistRules())
  const normalPlaylist = await library.createPlaylist('Manual Set')
  const trackPath = 'subsonic://1/split-a'

  await assert.rejects(
    () => library.addToPlaylist(dynamicPlaylist.id, [trackPath]),
    /Dynamic playlists cannot accept manual tracks/
  )
  await assert.rejects(
    () => library.removeFromPlaylist(dynamicPlaylist.id, trackPath),
    /Dynamic playlists cannot remove tracks manually/
  )
  await assert.rejects(
    () => library.reorderPlaylistTracks(dynamicPlaylist.id, [trackPath]),
    /Dynamic playlists cannot reorder tracks manually/
  )

  await library.addToPlaylist(normalPlaylist.id, [trackPath])
  assert.deepEqual(library.getPlaylistTracks(normalPlaylist.id).map((track) => track.path), [trackPath])
})

test('dynamic playlist rules are validated before storage', async (t) => {
  await setupSeededLibrary(t)

  await assert.rejects(
    () => library.createDynamicPlaylist('Bad Dynamic', {
      version: 1,
      conditions: [
        { kind: 'text', field: 'title', operator: 'contains', value: '' }
      ],
      sort: { field: 'title', direction: 'asc' },
      limit: null
    }),
    /Text value is required/
  )
})

test('dynamic playlist export writes the current evaluated result', async (t) => {
  const dir = await setupEmptyLibrary(t)

  const source = await library.createSubsonicSource({
    name: 'Export Source',
    base_url: 'https://music.example.test',
    username: 'tester',
    secret_encrypted: 'secret',
    enabled: 1,
    last_status: 'ok'
  })
  await library.upsertSubsonicTracks(source.id, [
    createRemoteTrack({
      path: 'subsonic://export/a',
      source_track_id: 'export-a',
      title: 'Export A',
      artist: 'Export Artist',
      album: 'Dynamic Export'
    }),
    createRemoteTrack({
      path: 'subsonic://export/b',
      source_track_id: 'export-b',
      title: 'Export B',
      artist: 'Other Artist',
      album: 'Dynamic Export'
    })
  ])

  const playlist = await library.createDynamicPlaylist('Dynamic Export', {
    version: 1,
    conditions: [
      { kind: 'text', field: 'artist', operator: 'is', value: 'Export Artist' }
    ],
    sort: { field: 'title', direction: 'asc' },
    limit: null
  })

  const exportDir = join(dir, 'exports')
  await mkdir(exportDir)
  const exportPath = join(exportDir, 'dynamic-export.m3u8')
  const result = await library.exportPlaylistToM3u(playlist.id, exportPath)

  assert.equal(result.exportedCount, 1)
  assert.deepEqual(result.warnings, ['1 entries reference remote or app-specific locations and may not work outside Astra.'])
  const lines = (await readFile(exportPath, 'utf-8')).trimEnd().split('\n')
  assert.equal(lines[0], '#EXTM3U')
  assert.match(lines[1], /^#EXTINF:-?\d+,Export Artist - Export A$/)
  assert.equal(lines[2], 'subsonic://export/a')
})
