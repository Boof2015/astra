import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import test from 'node:test'
import { pathToFileURL } from 'url'
import * as library from './library.ts'

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
