import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import test from 'node:test'
import { pathToFileURL } from 'url'
import { createRequire } from 'module'
import * as library from './library.ts'
import type { StatsTransferTrackTuple } from '../../shared/stats/statsTransfer.ts'
import {
  createDefaultDynamicPlaylistRules,
  type DynamicPlaylistCondition
} from '../../shared/playlists/dynamicPlaylist.ts'

interface TestSqliteStatement {
  run(...params: unknown[]): void
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
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

async function setupSeededLibrary(t: test.TestContext): Promise<string> {
  const dir = await setupEmptyLibrary(t)

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

  return dir
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

  assert.equal(library.getListeningHistoryStatus().startedAt, null)

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

test('detailed listening checkpoints qualify once, stay idempotent, and reset without clearing play aggregates', async (t) => {
  await setupEmptyLibrary(t)

  const source = await library.createSubsonicSource({
    name: 'Short Track Source',
    base_url: 'https://short.example.test',
    username: 'tester',
    secret_encrypted: 'secret',
    enabled: 1,
    last_status: 'ok'
  })
  const trackPath = `subsonic://${source.id}/short`
  await library.upsertSubsonicTracks(source.id, [createRemoteTrack({
    path: trackPath,
    source_track_id: 'short',
    title: 'Five Seconds',
    artist: 'Short Artist',
    album: 'Short Album',
    duration: 5
  })])

  const initialStatus = library.getListeningHistoryStatus()
  assert.equal(initialStatus.startedAt, null)
  const playlist = await library.createPlaylist('Checkpoint Playlist')
  const first = await library.checkpointListeningSession({
    generation: initialStatus.generation,
    sessionKey: 'short-session',
    segmentKey: 'short-segment',
    trackPath,
    sourcePlaylistId: playlist.id,
    sessionStartedAt: 1_000_000,
    segmentStartedAt: 1_000_000,
    observedAt: 1_005_000,
    sessionListenedSeconds: 5,
    segmentListenedSeconds: 5,
    trackDurationSeconds: 5,
    qualificationEligible: true,
    finalizeSegment: true,
    finalizeSession: true,
    completedNaturally: true
  })
  assert.equal(first.accepted, true)
  assert.equal(first.qualifiedNow, true)
  assert.equal(first.status.startedAt, 1_000_000)

  const staleRetry = await library.checkpointListeningSession({
    generation: initialStatus.generation,
    sessionKey: 'short-session',
    segmentKey: 'short-segment',
    trackPath,
    sourcePlaylistId: null,
    sessionStartedAt: 1_000_000,
    segmentStartedAt: 1_000_000,
    observedAt: 1_003_000,
    sessionListenedSeconds: 3,
    segmentListenedSeconds: 3,
    trackDurationSeconds: 5,
    qualificationEligible: true
  })
  assert.equal(staleRetry.accepted, true)
  assert.equal(staleRetry.qualifiedNow, false)
  assert.equal(library.getTrackByPath(trackPath)?.play_count, 1)
  assert.equal(library.getRecentlyPlayed(10).filter((track) => track.path === trackPath).length, 1)
  assert.equal(library.getPlaylists().find((entry) => entry.id === playlist.id)?.last_played_at, 1_005_000)

  const dashboard = library.getListeningStatsDashboard({
    range: 'all',
    rankingMetric: 'plays',
    artistBrowseMode: 'canonical',
    now: 1_006_000
  })
  assert.equal(dashboard.summary.listenedSeconds, 5)
  assert.equal(dashboard.summary.qualifiedPlays, 1)
  assert.equal(dashboard.summary.tracksPlayed, 1)

  const clearedStatus = await library.clearDetailedListeningHistory()
  assert.notEqual(clearedStatus.generation, initialStatus.generation)
  assert.equal(clearedStatus.startedAt, null)
  const staleAfterReset = await library.checkpointListeningSession({
    generation: initialStatus.generation,
    sessionKey: 'short-session',
    segmentKey: 'short-segment',
    trackPath,
    sourcePlaylistId: null,
    sessionStartedAt: 1_000_000,
    segmentStartedAt: 1_000_000,
    observedAt: 1_010_000,
    sessionListenedSeconds: 10,
    segmentListenedSeconds: 10,
    trackDurationSeconds: 5,
    qualificationEligible: true
  })
  assert.equal(staleAfterReset.accepted, false)
  assert.equal(library.getListeningStatsDashboard({
    range: 'all',
    rankingMetric: 'plays',
    artistBrowseMode: 'canonical',
    now: 1_011_000
  }).status.startedAt, null)
  assert.equal(library.getTrackByPath(trackPath)?.play_count, 1)
  assert.equal(library.getRecentlyPlayed(10).filter((track) => track.path === trackPath).length, 1)
})

test('short-track qualification requires natural completion and uses a bounded tolerance', async (t) => {
  await setupEmptyLibrary(t)

  const source = await library.createSubsonicSource({
    name: 'Qualification Boundary Source',
    base_url: 'https://qualification.example.test',
    username: 'tester',
    secret_encrypted: 'secret',
    enabled: 1,
    last_status: 'ok'
  })
  const trackPaths = {
    five: `subsonic://${source.id}/five-seconds`,
    one: `subsonic://${source.id}/one-second`,
    fifteen: `subsonic://${source.id}/fifteen-seconds`,
    unknown: `subsonic://${source.id}/unknown-duration`
  }
  await library.upsertSubsonicTracks(source.id, [
    createRemoteTrack({
      path: trackPaths.five,
      title: 'Five Seconds',
      artist: 'Boundary Artist',
      album: 'Boundary Album',
      duration: 5
    }),
    createRemoteTrack({
      path: trackPaths.one,
      title: 'One Second',
      artist: 'Boundary Artist',
      album: 'Boundary Album',
      duration: 1
    }),
    createRemoteTrack({
      path: trackPaths.fifteen,
      title: 'Fifteen Seconds',
      artist: 'Boundary Artist',
      album: 'Boundary Album',
      duration: 15
    }),
    createRemoteTrack({
      path: trackPaths.unknown,
      title: 'Unknown Duration',
      artist: 'Boundary Artist',
      album: 'Boundary Album',
      duration: 0
    })
  ])

  const status = library.getListeningHistoryStatus()
  let nextStartedAt = 2_000_000
  const checkpoint = async (options: {
    sessionKey: string
    trackPath: string
    durationSeconds: number
    listenedSeconds: number
    completedNaturally?: boolean
  }) => {
    const startedAt = nextStartedAt
    nextStartedAt += 30_000
    return library.checkpointListeningSession({
      generation: status.generation,
      sessionKey: options.sessionKey,
      segmentKey: `${options.sessionKey}-segment`,
      trackPath: options.trackPath,
      sourcePlaylistId: null,
      sessionStartedAt: startedAt,
      segmentStartedAt: startedAt,
      observedAt: startedAt + Math.round(options.listenedSeconds * 1000),
      sessionListenedSeconds: options.listenedSeconds,
      segmentListenedSeconds: options.listenedSeconds,
      trackDurationSeconds: options.durationSeconds,
      qualificationEligible: true,
      finalizeSegment: true,
      finalizeSession: true,
      completedNaturally: options.completedNaturally
    })
  }

  const belowFiveSecondMargin = await checkpoint({
    sessionKey: 'five-below-margin',
    trackPath: trackPaths.five,
    durationSeconds: 5,
    listenedSeconds: 4.499,
    completedNaturally: true
  })
  assert.equal(belowFiveSecondMargin.qualifiedNow, false)

  const atFiveSecondMargin = await checkpoint({
    sessionKey: 'five-at-margin',
    trackPath: trackPaths.five,
    durationSeconds: 5,
    listenedSeconds: 4.5,
    completedNaturally: true
  })
  assert.equal(atFiveSecondMargin.qualifiedNow, true)

  const manualFiveSecondCompletion = await checkpoint({
    sessionKey: 'five-manual',
    trackPath: trackPaths.five,
    durationSeconds: 5,
    listenedSeconds: 5
  })
  assert.equal(manualFiveSecondCompletion.qualifiedNow, false)

  const idempotentRetry = await library.checkpointListeningSession({
    generation: status.generation,
    sessionKey: 'five-at-margin',
    segmentKey: 'five-at-margin-segment',
    trackPath: trackPaths.five,
    sourcePlaylistId: null,
    sessionStartedAt: 2_030_000,
    segmentStartedAt: 2_030_000,
    observedAt: 2_035_000,
    sessionListenedSeconds: 5,
    segmentListenedSeconds: 5,
    trackDurationSeconds: 5,
    qualificationEligible: true,
    finalizeSegment: true,
    finalizeSession: true,
    completedNaturally: true
  })
  assert.equal(idempotentRetry.qualifiedNow, false)
  assert.equal(library.getTrackByPath(trackPaths.five)?.play_count, 1)

  const belowOneSecondMargin = await checkpoint({
    sessionKey: 'one-below-margin',
    trackPath: trackPaths.one,
    durationSeconds: 1,
    listenedSeconds: 0.899,
    completedNaturally: true
  })
  assert.equal(belowOneSecondMargin.qualifiedNow, false)

  const atOneSecondMargin = await checkpoint({
    sessionKey: 'one-at-margin',
    trackPath: trackPaths.one,
    durationSeconds: 1,
    listenedSeconds: 0.9,
    completedNaturally: true
  })
  assert.equal(atOneSecondMargin.qualifiedNow, true)

  const incompleteFifteenSeconds = await checkpoint({
    sessionKey: 'fifteen-incomplete',
    trackPath: trackPaths.fifteen,
    durationSeconds: 15,
    listenedSeconds: 14.999,
    completedNaturally: true
  })
  assert.equal(incompleteFifteenSeconds.qualifiedNow, false)

  const completeFifteenSeconds = await checkpoint({
    sessionKey: 'fifteen-complete',
    trackPath: trackPaths.fifteen,
    durationSeconds: 15,
    listenedSeconds: 15
  })
  assert.equal(completeFifteenSeconds.qualifiedNow, true)

  const incompleteUnknownDuration = await checkpoint({
    sessionKey: 'unknown-incomplete',
    trackPath: trackPaths.unknown,
    durationSeconds: 0,
    listenedSeconds: 14.999,
    completedNaturally: true
  })
  assert.equal(incompleteUnknownDuration.qualifiedNow, false)

  const completeUnknownDuration = await checkpoint({
    sessionKey: 'unknown-complete',
    trackPath: trackPaths.unknown,
    durationSeconds: 0,
    listenedSeconds: 15
  })
  assert.equal(completeUnknownDuration.qualifiedNow, true)
})

test('listening stats allocate overlapping segments to local buckets', async (t) => {
  await setupSeededLibrary(t)

  const status = library.getListeningHistoryStatus()
  const midnight = new Date(2026, 6, 10, 0, 0, 0, 0).getTime()
  const segmentStart = midnight - 60_000
  const segmentEnd = midnight + 60_000
  await library.checkpointListeningSession({
    generation: status.generation,
    sessionKey: 'midnight-session',
    segmentKey: 'midnight-segment',
    trackPath: 'subsonic://1/split-a',
    sourcePlaylistId: null,
    sessionStartedAt: segmentStart,
    segmentStartedAt: segmentStart,
    observedAt: segmentEnd,
    sessionListenedSeconds: 120,
    segmentListenedSeconds: 120,
    trackDurationSeconds: 180,
    qualificationEligible: false,
    finalizeSegment: true,
    finalizeSession: true
  })

  const dashboard = library.getListeningStatsDashboard({
    range: '30d',
    rankingMetric: 'time',
    artistBrowseMode: 'canonical',
    now: midnight + 120_000
  })
  const previousDay = dashboard.activity.find((bucket) => bucket.startAt === midnight - 86_400_000)
  const currentDay = dashboard.activity.find((bucket) => bucket.startAt === midnight)
  assert.ok(previousDay)
  assert.ok(currentDay)
  assert.equal(Math.round(previousDay.listenedSeconds), 60)
  assert.equal(Math.round(currentDay.listenedSeconds), 60)
  assert.equal(Math.round(dashboard.summary.listenedSeconds), 120)
  assert.equal(dashboard.summary.activeDays, 2)
  assert.equal(dashboard.summary.qualifiedPlays, 0)

  const sevenDays = library.getListeningStatsDashboard({
    range: '7d', rankingMetric: 'time', artistBrowseMode: 'canonical', now: midnight + 120_000
  })
  const oneYear = library.getListeningStatsDashboard({
    range: '1y', rankingMetric: 'time', artistBrowseMode: 'canonical', now: midnight + 120_000
  })
  const allTime = library.getListeningStatsDashboard({
    range: 'all', rankingMetric: 'time', artistBrowseMode: 'canonical', now: midnight + 120_000
  })
  assert.equal(sevenDays.granularity, 'day')
  assert.equal(sevenDays.activity.length, 7)
  assert.equal(oneYear.granularity, 'week')
  assert.equal(oneYear.activity.length, 53)
  assert.equal(allTime.granularity, 'month')
  assert.equal(allTime.activity.length, 1)
})

test('listening rankings switch between plays and time and retain snapshots for removed tracks', async (t) => {
  await setupSeededLibrary(t)

  const status = library.getListeningHistoryStatus()
  const base = new Date(2026, 6, 12, 12, 0, 0, 0).getTime()
  const checkpoint = async (
    sessionKey: string,
    trackPath: string,
    offsetSeconds: number,
    listenedSeconds: number
  ) => library.checkpointListeningSession({
    generation: status.generation,
    sessionKey,
    segmentKey: `${sessionKey}-segment`,
    trackPath,
    sourcePlaylistId: null,
    sessionStartedAt: base + offsetSeconds * 1000,
    segmentStartedAt: base + offsetSeconds * 1000,
    observedAt: base + (offsetSeconds + listenedSeconds) * 1000,
    sessionListenedSeconds: listenedSeconds,
    segmentListenedSeconds: listenedSeconds,
    trackDurationSeconds: 180,
    qualificationEligible: true,
    finalizeSegment: true,
    finalizeSession: true
  })

  await checkpoint('track-a-one', 'subsonic://1/split-a', 0, 20)
  await checkpoint('track-a-two', 'subsonic://1/split-a', 30, 20)
  await checkpoint('track-b-one', 'subsonic://1/split-b', 60, 100)

  const queryNow = base + 180_000
  const byPlays = library.getListeningStatsDashboard({
    range: 'all', rankingMetric: 'plays', artistBrowseMode: 'canonical', now: queryNow
  })
  const byTime = library.getListeningStatsDashboard({
    range: 'all', rankingMetric: 'time', artistBrowseMode: 'canonical', now: queryNow
  })
  assert.equal(byPlays.topTracks[0]?.title, 'Split A')
  assert.equal(byPlays.topTracks[0]?.qualifiedPlays, 2)
  assert.equal(byTime.topTracks[0]?.title, 'Split B')
  assert.equal(Math.round(byTime.topTracks[0]?.listenedSeconds ?? 0), 100)

  await library.deleteSubsonicSource(1, true)
  const afterRemoval = library.getListeningStatsDashboard({
    range: 'all', rankingMetric: 'plays', artistBrowseMode: 'canonical', now: queryNow
  })
  assert.equal(afterRemoval.topTracks[0]?.title, 'Split A')
  assert.equal(afterRemoval.topTracks[0]?.available, false)
  assert.equal(afterRemoval.topTracks[0]?.trackPath, null)
  assert.equal(afterRemoval.topArtists.some((artist) => artist.artist === 'Artist A'), true)
  assert.equal(afterRemoval.topAlbums.some((album) => album.album === 'Split Release'), true)
})

function updateStoredArtistCredits(
  userDataDir: string,
  trackPath: string,
  artistNames: readonly string[],
  albumArtistNames: readonly string[] | null = null
): void {
  const directDb = new TestSqliteDatabase(join(userDataDir, 'library.db'))
  try {
    directDb.prepare(`
      UPDATE tracks
      SET artist_names_json = ?, album_artist_names_json = ?
      WHERE path = ?
    `).run(
      JSON.stringify(artistNames),
      albumArtistNames ? JSON.stringify(albumArtistNames) : null,
      trackPath
    )
  } finally {
    directDb.close()
  }
}

test('listening stats follow strict and canonical artist grouping without inflating totals', async (t) => {
  const userDataDir = await setupEmptyLibrary(t)
  const source = await library.createSubsonicSource({
    name: 'Stats Artist Source',
    base_url: 'https://stats-artists.example.test',
    username: 'tester',
    secret_encrypted: 'secret',
    enabled: 1,
    last_status: 'ok'
  })
  const trackPath = 'subsonic://stats-artists/collaboration'
  await library.upsertSubsonicTracks(source.id, [
    createRemoteTrack({
      path: trackPath,
      source_track_id: 'collaboration',
      title: 'Shared Song',
      artist: 'Primary Artist & Guest Artist',
      album: 'Shared Release',
      album_artist: 'Primary Artist feat. Guest Artist',
      duration: 180
    })
  ])
  updateStoredArtistCredits(
    userDataDir,
    trackPath,
    ['Primary Artist', 'Guest Artist'],
    ['Primary Artist', 'Guest Artist']
  )

  const status = library.getListeningHistoryStatus()
  const startedAt = 2_000_000
  await library.checkpointListeningSession({
    generation: status.generation,
    sessionKey: 'artist-grouping-session',
    segmentKey: 'artist-grouping-segment',
    trackPath,
    sourcePlaylistId: null,
    sessionStartedAt: startedAt,
    segmentStartedAt: startedAt,
    observedAt: startedAt + 30_000,
    sessionListenedSeconds: 30,
    segmentListenedSeconds: 30,
    trackDurationSeconds: 180,
    qualificationEligible: true,
    finalizeSegment: true,
    finalizeSession: true
  })

  const queryNow = startedAt + 60_000
  const strict = library.getListeningStatsDashboard({
    range: 'all',
    rankingMetric: 'plays',
    artistBrowseMode: 'strict',
    now: queryNow
  })
  assert.deepEqual(strict.topArtists.map((artist) => artist.artist), ['Primary Artist feat. Guest Artist'])
  assert.equal(strict.topArtists[0]?.qualifiedPlays, 1)
  assert.equal(strict.topArtists[0]?.listenedSeconds, 30)

  const canonical = library.getListeningStatsDashboard({
    range: 'all',
    rankingMetric: 'plays',
    artistBrowseMode: 'canonical',
    now: queryNow
  })
  const primaryArtist = canonical.topArtists.find((artist) => artist.artist === 'Primary Artist')
  const guestArtist = canonical.topArtists.find((artist) => artist.artist === 'Guest Artist')
  assert.ok(primaryArtist)
  assert.ok(guestArtist)
  assert.equal(primaryArtist.qualifiedPlays, 1)
  assert.equal(primaryArtist.listenedSeconds, 30)
  assert.equal(guestArtist.qualifiedPlays, 1)
  assert.equal(guestArtist.listenedSeconds, 30)
  assert.equal(canonical.summary.qualifiedPlays, 1)
  assert.equal(canonical.summary.listenedSeconds, 30)
  assert.equal(canonical.summary.tracksPlayed, 1)

  await library.deleteSubsonicSource(source.id, true)
  const afterRemoval = library.getListeningStatsDashboard({
    range: 'all',
    rankingMetric: 'plays',
    artistBrowseMode: 'canonical',
    now: queryNow
  })
  assert.equal(afterRemoval.topTracks[0]?.title, 'Shared Song')
  assert.equal(afterRemoval.topTracks[0]?.available, false)
  assert.equal(afterRemoval.topArtists.length > 0, true)
  assert.equal(afterRemoval.topArtists.every((artist) => !artist.available), true)
})

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

test('library year queries return complete eligible album groups', async (t) => {
  await setupEmptyLibrary(t)

  const source = await library.createSubsonicSource({
    name: 'Year Source',
    base_url: 'https://music.example.test',
    username: 'tester',
    secret_encrypted: 'secret',
    enabled: 1,
    last_status: 'ok'
  })

  await library.upsertSubsonicTracks(source.id, [
    createRemoteTrack({
      path: 'subsonic://1/mixed-old',
      title: 'Mixed Old',
      artist: 'Year Artist',
      album: 'Mixed Year Album',
      album_artist: 'Year Artist',
      track_number: 1,
      year: 2024
    }),
    createRemoteTrack({
      path: 'subsonic://1/mixed-new',
      title: 'Mixed New',
      artist: 'Year Artist',
      album: 'Mixed Year Album',
      album_artist: 'Year Artist',
      track_number: 2,
      year: 2025
    }),
    createRemoteTrack({
      path: 'subsonic://1/prior-one',
      title: 'Prior One',
      artist: 'Prior Artist',
      album: 'Prior Album',
      album_artist: 'Prior Artist',
      track_number: 1,
      year: 2024
    }),
    createRemoteTrack({
      path: 'subsonic://1/prior-two',
      title: 'Prior Two',
      artist: 'Prior Artist',
      album: 'Prior Album',
      album_artist: 'Prior Artist',
      track_number: 2,
      year: 2024
    }),
    createRemoteTrack({
      path: 'subsonic://1/undated-one',
      title: 'Undated One',
      artist: 'Undated Artist',
      album: 'Undated Album',
      album_artist: 'Undated Artist',
      track_number: 1
    }),
    createRemoteTrack({
      path: 'subsonic://1/undated-two',
      title: 'Undated Two',
      artist: 'Undated Artist',
      album: 'Undated Album',
      album_artist: 'Undated Artist',
      track_number: 2
    }),
    createRemoteTrack({
      path: 'subsonic://1/single',
      title: 'One Track Release',
      artist: 'Singles Artist',
      album: 'One Track Release',
      album_artist: 'Singles Artist',
      track_number: 1,
      year: 2025
    }),
    createRemoteTrack({
      path: 'subsonic://1/unknown-album-one',
      title: 'Unknown Album One',
      artist: 'Unknown Artist',
      album: 'Unknown Album',
      album_artist: 'Unknown Artist',
      track_number: 1,
      year: 2025
    }),
    createRemoteTrack({
      path: 'subsonic://1/unknown-album-two',
      title: 'Unknown Album Two',
      artist: 'Unknown Artist',
      album: 'Unknown Album',
      album_artist: 'Unknown Artist',
      track_number: 2,
      year: 2025
    })
  ])

  const tracks2025 = library.getTracksByYear(2025)
  assert.deepEqual(tracks2025.map((track) => track.title), [
    'Mixed Old',
    'Mixed New',
    'One Track Release'
  ])

  const mixedAlbum = library.getAlbums({ includeSingles: true })
    .find((album) => album.album === 'Mixed Year Album')
  assert.ok(mixedAlbum)
  assert.equal(mixedAlbum.year, 2025)
  assert.ok(
    tracks2025
      .filter((track) => track.album === 'Mixed Year Album')
      .every((track) => track.album_identity_key === mixedAlbum.identity_key)
  )

  assert.deepEqual(library.getTracksByYear(2024).map((track) => track.title), [
    'Prior One',
    'Prior Two'
  ])
  assert.deepEqual(library.getTracksByYear(null).map((track) => track.title), [
    'Undated One',
    'Undated Two'
  ])
  assert.deepEqual(library.getTracksByYear(Number.NaN), [])
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
        { path: secondPath, title: 'Remote B', artist: 'Remote Artist', album: 'Remote Album' },
        { path: firstPath, title: 'Remote A', artist: 'Remote Artist', album: 'Remote Album' }
      ]
    }
  ], { persist: false })
  assert.deepEqual(createdSummary, { created: 1, updated: 0, removed: 0 })

  const playlist = library.getPlaylists().find((entry) => entry.name === 'Server Mix')
  assert.ok(playlist)
  assert.equal(playlist.track_count, 3)
  assert.equal(library.getCompanionApiPlaylistTarget(playlist.id)?.remote_source_id, source.id)
  assert.equal(library.isCompanionApiPlaylistWritable(playlist.id), false)
  assert.deepEqual(library.getPlaylistTracks(playlist.id).map((track) => track.path), [firstPath, secondPath, firstPath])

  const updatedSummary = await library.syncSubsonicRemotePlaylists(source.id, [
    {
      source_playlist_id: 'playlist-1',
      name: 'Server Mix Renamed',
      tracks: [
        { path: secondPath, title: 'Remote B', artist: 'Remote Artist', album: 'Remote Album' },
        { path: secondPath, title: 'Remote B', artist: 'Remote Artist', album: 'Remote Album' }
      ]
    }
  ], { persist: false })
  assert.deepEqual(updatedSummary, { created: 0, updated: 1, removed: 0 })

  const updatedPlaylist = library.getPlaylists().find((entry) => entry.id === playlist.id)
  assert.ok(updatedPlaylist)
  assert.equal(updatedPlaylist.name, 'Server Mix Renamed')
  assert.deepEqual(library.getPlaylistTracks(playlist.id).map((track) => track.path), [secondPath, secondPath])

  const removedSummary = await library.syncSubsonicRemotePlaylists(source.id, [], { persist: false })
  assert.deepEqual(removedSummary, { created: 0, updated: 0, removed: 1 })
  assert.equal(library.getPlaylists().some((entry) => entry.id === playlist.id), false)
})

test('desktop-mobile playlist replacement preserves repeated synced occurrences', async (t) => {
  await setupSeededLibrary(t)
  const track = library.getAllTracks()[0]
  assert.ok(track)

  const result = library.replaceSyncedPlaylist({
    syncUid: 'duplicate-sync-playlist',
    name: 'Synced Repeats',
    kind: 'normal',
    dynamicRules: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    entries: [0, 1].map((position) => ({
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationSeconds: track.duration,
      position,
      addedAt: 1_000 + position,
      sourcePath: track.path
    }))
  }, library.createTrackMetadataMatcher())

  assert.deepEqual(result, { status: 'created', entriesMatched: 2, entriesFallback: 0 })
  const synced = library.getSyncPlaylistsState().playlists.find((playlist) => playlist.syncUid === 'duplicate-sync-playlist')
  assert.ok(synced)
  assert.deepEqual(synced.entries?.map((entry) => entry.sourcePath), [track.path, track.path])
  assert.deepEqual(synced.entries?.map((entry) => entry.position), [0, 1])
})

test('companion API writes accept only locally owned normal playlists', async (t) => {
  await setupSeededLibrary(t)
  const trackPaths = library.getAllTracks().slice(0, 2).map((track) => track.path)
  assert.equal(trackPaths.length, 2)

  const normal = await library.createPlaylist('Companion Normal')
  await library.addToPlaylist(normal.id, trackPaths)
  assert.equal(library.isCompanionApiPlaylistWritable(normal.id), true)
  assert.equal(await library.moveCompanionApiPlaylistTrack(normal.id, trackPaths[1], 0), true)
  assert.deepEqual(library.getPlaylistTracks(normal.id).map((track) => track.path), [trackPaths[1], trackPaths[0]])

  const dynamic = await library.createDynamicPlaylist(
    'Companion Dynamic',
    createDefaultDynamicPlaylistRules()
  )
  assert.equal(library.getCompanionApiPlaylistTarget(dynamic.id)?.kind, 'dynamic')
  assert.equal(library.isCompanionApiPlaylistWritable(dynamic.id), false)
  assert.equal(await library.moveCompanionApiPlaylistTrack(dynamic.id, trackPaths[0], 0), false)
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

test('playlist import preserves repeated available and missing occurrences', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const availableTrackPath = join(musicDir, 'repeated.wav')
  const missingTrackPath = join(musicDir, 'repeated-missing.wav')
  await mkdir(musicDir)
  await writeTaggedWavFixture(availableTrackPath, 'Repeated Track', 'Import Artist')
  await library.scanFolder(musicDir)

  const playlistPath = join(dir, 'repeated.m3u8')
  await writeFile(playlistPath, [
    '#EXTM3U',
    relative(dir, availableTrackPath),
    relative(dir, missingTrackPath),
    relative(dir, availableTrackPath),
    relative(dir, missingTrackPath),
    ''
  ].join('\n'), 'utf-8')

  const result = await library.importPlaylistFromFile(playlistPath)
  assert.equal(result.entriesTotal, 4)
  assert.equal(result.importedCount, 2)
  assert.equal(result.missingEntryCount, 2)
  assert.ok(result.playlistId)

  const entries = library.getPlaylistTrackEntries(result.playlistId)
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 4)
  assert.deepEqual(entries.map((entry) => entry.track_path), [
    availableTrackPath,
    missingTrackPath,
    availableTrackPath,
    missingTrackPath
  ])
  assert.deepEqual(entries.map((entry) => entry.position), [0, 1, 2, 3])
  assert.deepEqual(library.getPlaylistTracks(result.playlistId).map((track) => track.path), [
    availableTrackPath,
    availableTrackPath
  ])

  const playlistSummary = library.getPlaylists().find((playlist) => playlist.id === result.playlistId)
  assert.equal(playlistSummary?.track_count, 2)
  assert.equal(playlistSummary?.missing_track_count, 2)

  const exportPath = join(dir, 'repeated-export.m3u8')
  const exportResult = await library.exportPlaylistToM3u(result.playlistId, exportPath)
  assert.equal(exportResult.exportedCount, 4)
  const exportedPaths = (await readFile(exportPath, 'utf-8'))
    .split(/\r?\n/)
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.deepEqual(exportedPaths, [
    'music/repeated.wav',
    'music/repeated-missing.wav',
    'music/repeated.wav',
    'music/repeated-missing.wav'
  ])

  await library.addToPlaylist(result.playlistId, [availableTrackPath, availableTrackPath])
  assert.equal(library.getPlaylistTrackEntries(result.playlistId).length, 4)

  await library.reorderPlaylistEntries(result.playlistId, entries.map((entry) => entry.id).reverse())
  assert.deepEqual(library.getPlaylistTrackEntries(result.playlistId).map((entry) => entry.id), entries.map((entry) => entry.id).reverse())

  await library.removePlaylistEntry(result.playlistId, entries[2].id)
  assert.equal(library.getPlaylistTracks(result.playlistId).length, 1)

  await library.removeFromPlaylist(result.playlistId, missingTrackPath)
  assert.deepEqual(library.getPlaylistTrackEntries(result.playlistId).map((entry) => entry.track_path), [availableTrackPath])
})

test('database initialization removes the legacy unique playlist membership index', async (t) => {
  const dir = await setupEmptyLibrary(t)
  const playlist = await library.createPlaylist('Legacy Membership Index')
  await library.addToPlaylist(playlist.id, ['/music/legacy.flac'])

  library.closeDatabase()
  withDirectLibraryDb(dir, (directDb) => {
    directDb.prepare(`
      CREATE UNIQUE INDEX idx_playlist_tracks_membership
      ON playlist_tracks(playlist_id, track_path)
    `).run()
  })

  await library.initDatabase()
  const indexNames = withDirectLibraryDb(dir, (directDb) => (
    directDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'playlist_tracks'").all()
      .map((row) => (row as { name: string }).name)
  ))
  assert.equal(indexNames.includes('idx_playlist_tracks_membership'), false)

  await library.addToPlaylist(playlist.id, ['/music/legacy.flac'])
  assert.equal(library.getPlaylistTrackEntries(playlist.id).length, 1)
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

  const entriesBeforeReorder = library.getPlaylistTrackEntries(playlist.id)
  await library.reorderPlaylistEntries(playlist.id, [entriesBeforeReorder[1].id, entriesBeforeReorder[0].id])
  const reorderedEntries = library.getPlaylistTrackEntries(playlist.id)
  assert.deepEqual(reorderedEntries.map((entry) => entry.track_path), [availableTrackPath, missingTrackPath])
  assert.deepEqual(reorderedEntries.map((entry) => entry.missing), [false, true])
})

test('playlist cleanup reassociates a renamed track by captured metadata', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const originalTrackPath = join(musicDir, 'before-rename.wav')
  const renamedTrackPath = join(musicDir, 'after-rename.wav')
  await mkdir(musicDir)
  await writeTaggedWavFixture(originalTrackPath, 'Stable Metadata Title', 'Stable Metadata Artist')

  await library.scanFolder(musicDir)
  const playlist = await library.createPlaylist('Rename Recovery')
  await library.addToPlaylist(playlist.id, [originalTrackPath])
  const originalEntry = library.getPlaylistTrackEntries(playlist.id)[0]
  assert.ok(originalEntry)

  await rename(originalTrackPath, renamedTrackPath)
  const rescan = await library.scanFolder(musicDir)
  assert.equal(rescan.added, 1)
  assert.equal(library.getPlaylistTrackEntries(playlist.id)[0]?.track_path, originalTrackPath)

  const removed = await library.cleanupMissingTracks()
  assert.equal(removed, 1)

  const recoveredEntry = library.getPlaylistTrackEntries(playlist.id)[0]
  assert.ok(recoveredEntry)
  assert.equal(recoveredEntry.id, originalEntry.id)
  assert.equal(recoveredEntry.position, originalEntry.position)
  assert.equal(recoveredEntry.added_at, originalEntry.added_at)
  assert.equal(recoveredEntry.track_path, renamedTrackPath)
  assert.equal(recoveredEntry.missing, false)
  assert.equal(recoveredEntry.title, 'Stable Metadata Title')
  assert.equal(recoveredEntry.artist, 'Stable Metadata Artist')
  assert.equal(recoveredEntry.track?.path, renamedTrackPath)
})

test('playlist cleanup keeps ambiguous renamed tracks missing with fallback metadata', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const originalTrackPath = join(musicDir, 'ambiguous-before.wav')
  const firstCandidatePath = join(musicDir, 'ambiguous-after-one.wav')
  const secondCandidatePath = join(musicDir, 'ambiguous-after-two.wav')
  await mkdir(musicDir)
  await writeTaggedWavFixture(originalTrackPath, 'Ambiguous Metadata Title', 'Ambiguous Metadata Artist')

  await library.scanFolder(musicDir)
  const playlist = await library.createPlaylist('Ambiguous Rename')
  await library.addToPlaylist(playlist.id, [originalTrackPath])

  await rename(originalTrackPath, firstCandidatePath)
  await copyFile(firstCandidatePath, secondCandidatePath)
  await library.scanFolder(musicDir)
  await library.cleanupMissingTracks()

  const entry = library.getPlaylistTrackEntries(playlist.id)[0]
  assert.ok(entry)
  assert.equal(entry.track_path, originalTrackPath)
  assert.equal(entry.missing, true)
  assert.equal(entry.title, 'Ambiguous Metadata Title')
  assert.equal(entry.artist, 'Ambiguous Metadata Artist')
})

test('playlist cleanup preserves a repeated occurrence when it matches an existing playlist entry', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const missingTrackPath = join(musicDir, 'duplicate-before.wav')
  const existingTargetPath = join(musicDir, 'duplicate-target.wav')
  await mkdir(musicDir)
  await writeTaggedWavFixture(missingTrackPath, 'Duplicate Metadata Title', 'Duplicate Metadata Artist')
  await writeTaggedWavFixture(existingTargetPath, 'Duplicate Metadata Title', 'Duplicate Metadata Artist')

  await library.scanFolder(musicDir)
  const playlist = await library.createPlaylist('Duplicate Target')
  await library.addToPlaylist(playlist.id, [missingTrackPath, existingTargetPath])

  await rm(missingTrackPath)
  await library.cleanupMissingTracks()

  const entries = library.getPlaylistTrackEntries(playlist.id)
  assert.deepEqual(entries.map((entry) => entry.track_path), [existingTargetPath, existingTargetPath])
  assert.deepEqual(entries.map((entry) => entry.missing), [false, false])
})

test('manual playlist reassociation replaces a missing entry and preserves its ordering metadata', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const anchorTrackPath = join(musicDir, 'manual-anchor.wav')
  const missingTrackPath = join(musicDir, 'manual-missing.wav')
  const targetTrackPath = join(musicDir, 'manual-target.wav')
  await mkdir(musicDir)
  await writeTaggedWavFixture(anchorTrackPath, 'Manual Anchor', 'Manual Artist')
  await writeTaggedWavFixture(missingTrackPath, 'Manual Missing', 'Manual Artist')
  await writeTaggedWavFixture(targetTrackPath, 'Manual Target', 'Replacement Artist')

  await library.scanFolder(musicDir)
  const playlist = await library.createPlaylist('Manual Reassociation')
  await library.addToPlaylist(playlist.id, [anchorTrackPath, missingTrackPath])
  const originalEntry = library.getPlaylistTrackEntries(playlist.id)[1]
  assert.ok(originalEntry)

  await rm(missingTrackPath)
  await library.cleanupMissingTracks()
  await library.reassociatePlaylistEntry(playlist.id, originalEntry.id, targetTrackPath)

  const reassociatedEntry = library.getPlaylistTrackEntries(playlist.id)[1]
  assert.ok(reassociatedEntry)
  assert.equal(reassociatedEntry.id, originalEntry.id)
  assert.equal(reassociatedEntry.position, originalEntry.position)
  assert.equal(reassociatedEntry.added_at, originalEntry.added_at)
  assert.equal(reassociatedEntry.track_path, targetTrackPath)
  assert.equal(reassociatedEntry.title, 'Manual Target')
  assert.equal(reassociatedEntry.artist, 'Replacement Artist')
  assert.equal(reassociatedEntry.missing, false)
})

test('manual playlist reassociation rejects invalid inputs but permits repeated target occurrences', async (t) => {
  const dir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
  })

  const musicDir = join(dir, 'music')
  const availableTrackPath = join(musicDir, 'guard-available.wav')
  const missingTrackPath = join(musicDir, 'guard-missing.wav')
  const duplicateTargetPath = join(musicDir, 'guard-target.wav')
  await mkdir(musicDir)
  await writeTaggedWavFixture(availableTrackPath, 'Guard Available', 'Guard Artist')
  await writeTaggedWavFixture(missingTrackPath, 'Guard Missing', 'Guard Artist')
  await writeTaggedWavFixture(duplicateTargetPath, 'Guard Target', 'Guard Artist')

  await library.scanFolder(musicDir)
  const playlist = await library.createPlaylist('Reassociation Guards')
  await library.addToPlaylist(playlist.id, [availableTrackPath, missingTrackPath, duplicateTargetPath])
  const initialEntries = library.getPlaylistTrackEntries(playlist.id)
  const availableEntry = initialEntries[0]
  const missingEntry = initialEntries[1]
  assert.ok(availableEntry)
  assert.ok(missingEntry)

  await assert.rejects(
    () => library.reassociatePlaylistEntry(playlist.id, availableEntry.id, duplicateTargetPath),
    /Only missing playlist entries/
  )

  await rm(missingTrackPath)
  await library.cleanupMissingTracks()

  await assert.rejects(
    () => library.reassociatePlaylistEntry(playlist.id, missingEntry.id, join(musicDir, 'not-indexed.wav')),
    /isn't in your Astra library/
  )
  await assert.rejects(
    () => library.reassociatePlaylistEntry(playlist.id + 999, missingEntry.id, duplicateTargetPath),
    /Playlist not found/
  )
  await library.reassociatePlaylistEntry(playlist.id, missingEntry.id, duplicateTargetPath)
  assert.deepEqual(library.getPlaylistTrackEntries(playlist.id).map((entry) => entry.track_path), [
    availableTrackPath,
    duplicateTargetPath,
    duplicateTargetPath
  ])
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

test('dynamic playlist date filters evaluate fractional-day rolling cutoffs', async (t) => {
  const userDataDir = await setupSeededLibrary(t)
  const originalDateNow = Date.now
  const now = 2_000_000_000_000
  const sixHours = 6 * 60 * 60 * 1000
  const twelveHours = 12 * 60 * 60 * 1000
  const eighteenHours = 18 * 60 * 60 * 1000

  withDirectLibraryDb(userDataDir, (directDb) => {
    const updateDates = directDb.prepare(
      'UPDATE tracks SET added_at = ?, last_played_at = ? WHERE path = ?'
    )
    updateDates.run(now - sixHours, now - sixHours, 'subsonic://1/split-a')
    updateDates.run(now - twelveHours, now - twelveHours, 'subsonic://1/split-b')
    updateDates.run(now - eighteenHours, now - eighteenHours, 'subsonic://1/teen-1')
    updateDates.run(now - eighteenHours, null, 'subsonic://1/teen-2')
  })

  Date.now = () => now
  try {
    const previewPaths = (condition: DynamicPlaylistCondition) => library.previewDynamicPlaylist({
      version: 1,
      conditions: [condition],
      sort: { field: 'title', direction: 'asc' },
      limit: null
    }).tracks.map((track) => track.path)

    assert.deepEqual(previewPaths({
      kind: 'date',
      field: 'added_at',
      operator: 'within_days',
      value: 0.5
    }), [
      'subsonic://1/split-a',
      'subsonic://1/split-b'
    ])
    assert.deepEqual(previewPaths({
      kind: 'date',
      field: 'added_at',
      operator: 'older_than_days',
      value: 0.5
    }), [
      'subsonic://1/teen-2',
      'subsonic://1/teen-1'
    ])
    assert.deepEqual(previewPaths({
      kind: 'date',
      field: 'last_played_at',
      operator: 'within_days',
      value: 0.5
    }), [
      'subsonic://1/split-a',
      'subsonic://1/split-b'
    ])
    assert.deepEqual(previewPaths({
      kind: 'date',
      field: 'last_played_at',
      operator: 'not_within_days',
      value: 0.5
    }), [
      'subsonic://1/teen-2',
      'subsonic://1/teen-1'
    ])
  } finally {
    Date.now = originalDateNow
  }
})

test('track ratings persist, overwrite, remove, and validate values', async (t) => {
  await setupSeededLibrary(t)

  const changed = await library.setTrackRatingForPaths(['subsonic://1/teen-1', 'subsonic://1/teen-2'], 4)
  assert.equal(changed, 2)
  await library.setTrackRatingForPaths(['subsonic://1/teen-2'], 2.5)

  let entries = library.getTrackRatingEntries()
  assert.deepEqual(
    entries.map((entry) => [entry.track_path, entry.rating]).sort(),
    [['subsonic://1/teen-1', 4], ['subsonic://1/teen-2', 2.5]]
  )
  assert.ok(entries.every((entry) => entry.updated_at > 0))

  await library.setTrackRatingForPaths(['subsonic://1/teen-1'], null)
  entries = library.getTrackRatingEntries()
  assert.deepEqual(entries.map((entry) => entry.track_path), ['subsonic://1/teen-2'])

  await assert.rejects(
    () => library.setTrackRatingForPaths(['subsonic://1/teen-2'], Number.NaN),
    /Rating must be between/
  )

  const cleared = await library.resetAllTrackRatings()
  assert.equal(cleared, 1)
  assert.deepEqual(library.getTrackRatingEntries(), [])
  assert.equal(await library.resetAllTrackRatings(), 0)
})

test('dynamic playlists filter by rating, target unrated tracks, and sort by rating without a rating condition', async (t) => {
  await setupSeededLibrary(t)

  await library.setTrackRatingForPaths(['subsonic://1/teen-1'], 5)
  await library.setTrackRatingForPaths(['subsonic://1/teen-2'], 3)
  await library.setTrackRatingForPaths(['subsonic://1/split-a'], 3.5)
  // subsonic://1/split-b stays unrated.

  const highlyRated = library.previewDynamicPlaylist({
    version: 1,
    conditions: [{ kind: 'numeric', field: 'rating', operator: 'gte', value: 3.5 }],
    sort: { field: 'rating', direction: 'desc' },
    limit: null
  })
  assert.deepEqual(highlyRated.tracks.map((track) => track.path), ['subsonic://1/teen-1', 'subsonic://1/split-a'])

  // Half-star equality is exact (halves are IEEE754-exact).
  const exact = library.previewDynamicPlaylist({
    version: 1,
    conditions: [{ kind: 'numeric', field: 'rating', operator: 'eq', value: 3.5 }],
    sort: { field: 'title', direction: 'asc' },
    limit: null
  })
  assert.deepEqual(exact.tracks.map((track) => track.path), ['subsonic://1/split-a'])

  // Numeric rating conditions can never match unrated (NULL) tracks; the
  // 'rated' exact field is how they are reached.
  const unrated = library.previewDynamicPlaylist({
    version: 1,
    conditions: [{ kind: 'exact', field: 'rated', operator: 'is', value: false }],
    sort: { field: 'title', direction: 'asc' },
    limit: null
  })
  assert.deepEqual(unrated.tracks.map((track) => track.path), ['subsonic://1/split-b'])

  // Regression: sorting by rating with no rating condition must still emit the
  // track_ratings join for the ORDER BY. Unrated tracks sort last.
  const sortOnly = library.previewDynamicPlaylist({
    version: 1,
    conditions: [],
    sort: { field: 'rating', direction: 'desc' },
    limit: null
  })
  assert.deepEqual(sortOnly.tracks.map((track) => track.path), [
    'subsonic://1/teen-1',
    'subsonic://1/split-a',
    'subsonic://1/teen-2',
    'subsonic://1/split-b'
  ])
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
    () => library.reorderPlaylistEntries(dynamicPlaylist.id, [1]),
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

test('large library track pages stay fast and reflect writes', async (t) => {
  await setupEmptyLibrary(t)

  const source = await library.createSubsonicSource({
    name: 'Perf Source',
    base_url: 'https://music.example.test',
    username: 'tester',
    secret_encrypted: 'secret',
    enabled: 1,
    last_status: 'ok'
  })

  const ALBUM_COUNT = 2_500
  const TRACKS_PER_ALBUM = 10
  const seeded: library.SubsonicTrackUpsertInput[] = []
  for (let albumIndex = 0; albumIndex < ALBUM_COUNT; albumIndex += 1) {
    for (let trackNumber = 1; trackNumber <= TRACKS_PER_ALBUM; trackNumber += 1) {
      seeded.push(createRemoteTrack({
        path: `subsonic://perf/${albumIndex}/${trackNumber}`,
        source_track_id: `perf-${albumIndex}-${trackNumber}`,
        title: `Track ${String(trackNumber).padStart(2, '0')} of Album ${String(albumIndex).padStart(4, '0')}`,
        artist: `Perf Artist ${albumIndex % 400}`,
        album: `Perf Album ${String(albumIndex).padStart(4, '0')}`,
        album_artist: `Perf Artist ${albumIndex % 400}`,
        artwork_hash: `perf-art-${albumIndex}`,
        track_number: trackNumber,
        year: 2000 + (albumIndex % 25)
      }))
    }
  }

  library.beginLibraryWriteTransaction()
  try {
    await library.upsertSubsonicTracks(source.id, seeded)
    library.commitLibraryWriteTransaction()
  } catch (error) {
    library.rollbackLibraryWriteTransaction()
    throw error
  }

  const totalTracks = ALBUM_COUNT * TRACKS_PER_ALBUM

  // First page pays the one-time snapshot rebuild.
  const firstPage = library.getTrackPage({ offset: 0, limit: 2000 })
  assert.equal(firstPage.total, totalTracks)
  assert.equal(firstPage.tracks.length, 2000)

  // Warm pages must not scale with library size.
  const warmStartedAt = process.hrtime.bigint()
  const midPage = library.getTrackPage({ offset: Math.floor(totalTracks / 2), limit: 2000 })
  const warmMs = Number(process.hrtime.bigint() - warmStartedAt) / 1_000_000
  assert.equal(midPage.tracks.length, 2000)
  assert.ok(warmMs < 250, `warm getTrackPage took ${warmMs.toFixed(1)}ms`)

  // Page contents must match the canonical full ordering.
  const allTracks = library.getAllTracks()
  assert.equal(allTracks.length, totalTracks)
  assert.deepEqual(
    midPage.tracks.map((track) => track.path),
    allTracks.slice(Math.floor(totalTracks / 2), Math.floor(totalTracks / 2) + 2000).map((track) => track.path)
  )
  assert.ok(midPage.tracks.every((track) => typeof track.album_identity_key === 'string' && track.album_identity_key.length > 0))

  // Writes must invalidate cached pages.
  await library.upsertSubsonicTracks(source.id, [createRemoteTrack({
    path: 'subsonic://perf/0/1',
    source_track_id: 'perf-0-1',
    title: 'AAAA Renamed To Sort First',
    artist: 'Perf Artist 0',
    album: 'Perf Album 0000',
    album_artist: 'Perf Artist 0',
    artwork_hash: 'perf-art-0',
    track_number: 1,
    year: 2000
  })])
  const afterWritePage = library.getTrackPage({ offset: 0, limit: 10 })
  assert.equal(afterWritePage.tracks[0]?.title, 'AAAA Renamed To Sort First')
})

// ── Casing-only folder renames (#180) ────────────────────

function withDirectLibraryDb<T>(userDataDir: string, fn: (directDb: TestSqliteDatabase) => T): T {
  const directDb = new TestSqliteDatabase(join(userDataDir, 'library.db'))
  try {
    return fn(directDb)
  } finally {
    directDb.close()
  }
}

function getStoredTrackPaths(userDataDir: string): string[] {
  return withDirectLibraryDb(userDataDir, (directDb) =>
    (directDb.prepare('SELECT path FROM tracks ORDER BY id').all() as Array<{ path: string }>).map((row) => row.path)
  )
}

async function isCaseInsensitiveFsDir(dir: string): Promise<boolean> {
  const probePath = join(dir, 'case-probe.tmp')
  await writeFile(probePath, 'probe')
  try {
    await stat(join(dir, 'CASE-PROBE.TMP'))
    return true
  } catch {
    return false
  } finally {
    await rm(probePath, { force: true })
  }
}

interface CasingRenameFixture {
  userDataDir: string
  musicDir: string
  trackPath: string
  stalePath: string
}

// Scans one track at its on-disk casing; tests then rewrite the stored path to
// stalePath via direct SQL to simulate the library state after a casing-only
// folder rename. Works on any host filesystem: the stale path either resolves
// to the same inode (case-insensitive) or not at all (case-sensitive), and
// both count as the same file for repair purposes.
async function setupCasingRenameFixture(t: test.TestContext): Promise<CasingRenameFixture> {
  const userDataDir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  library.setFsPathCaseFoldingForTests(true)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
    library.setFsPathCaseFoldingForTests(null)
  })

  const musicDir = join(userDataDir, 'music')
  const artistDir = join(musicDir, 'artist')
  const trackPath = join(artistDir, 'track.wav')
  await mkdir(artistDir, { recursive: true })
  await writeTaggedWavFixture(trackPath, 'Case Bug Title', 'Case Bug Artist')

  const initialScan = await library.scanFolder(musicDir)
  assert.equal(initialScan.added, 1)

  return { userDataDir, musicDir, trackPath, stalePath: join(musicDir, 'Artist', 'track.wav') }
}

test('rescan after a real casing-only folder rename keeps a single entry (#180 repro)', async (t) => {
  const { userDataDir, musicDir, trackPath } = await setupCasingRenameFixture(t)
  await library.setTrackRatingForPaths([trackPath], 4)

  const renamedDir = join(musicDir, 'ARTIST')
  await rename(join(musicDir, 'artist'), renamedDir)
  const renamedTrackPath = join(renamedDir, 'track.wav')

  const rescan = await library.scanFolder(musicDir)
  assert.equal(rescan.added, 0)
  assert.equal(rescan.errors, 0)
  assert.deepEqual(getStoredTrackPaths(userDataDir), [renamedTrackPath])
  assert.deepEqual(library.getTrackRatingEntries().map((entry) => [entry.track_path, entry.rating]), [[renamedTrackPath, 4]])
})

test('rescan repairs a casing-only folder rename in place and keeps user data', async (t) => {
  const { userDataDir, musicDir, trackPath, stalePath } = await setupCasingRenameFixture(t)

  withDirectLibraryDb(userDataDir, (directDb) => {
    directDb.prepare('UPDATE tracks SET path = ? WHERE path = ?').run(stalePath, trackPath)
    directDb.prepare('INSERT INTO track_ratings (track_path, rating, updated_at) VALUES (?, ?, ?)').run(stalePath, 4.5, 1)
    directDb.prepare(
      "INSERT INTO lyrics_cache (track_path, metadata_signature, status, source, synced_lines_json, updated_at) VALUES (?, 'sig', 'found', 'remote', '[]', 1)"
    ).run(stalePath)
    directDb.prepare("INSERT INTO track_metadata_overrides (track_path, title, updated_at) VALUES (?, 'Overridden Title', 1)").run(stalePath)
    directDb.prepare("INSERT INTO track_loudness (track_path, loudness_lufs, method, analyzed_at) VALUES (?, -14, 'ebur128', 1)").run(stalePath)
  })
  await library.addFavorite(stalePath)
  const playlist = await library.createPlaylist('Casing Playlist')
  await library.addToPlaylist(playlist.id, [stalePath])

  const rescan = await library.scanFolder(musicDir)
  assert.equal(rescan.added, 0)
  assert.equal(rescan.errors, 0)

  assert.deepEqual(getStoredTrackPaths(userDataDir), [trackPath])
  assert.deepEqual(library.getTrackRatingEntries().map((entry) => [entry.track_path, entry.rating]), [[trackPath, 4.5]])
  assert.deepEqual(library.getFavoritePaths(), [trackPath])
  assert.deepEqual(library.getPlaylistTracks(playlist.id).map((track) => track.path), [trackPath])
  const childPaths = withDirectLibraryDb(userDataDir, (directDb) => ({
    lyrics: directDb.prepare('SELECT track_path FROM lyrics_cache').all(),
    overrides: directDb.prepare('SELECT track_path FROM track_metadata_overrides').all(),
    loudness: directDb.prepare('SELECT track_path FROM track_loudness').all()
  }))
  assert.deepEqual(childPaths.lyrics, [{ track_path: trackPath }])
  assert.deepEqual(childPaths.overrides, [{ track_path: trackPath }])
  assert.deepEqual(childPaths.loudness, [{ track_path: trackPath }])
})

test('rescan merges pre-existing case-variant duplicate rows preserving user data', async (t) => {
  const { userDataDir, musicDir, trackPath, stalePath } = await setupCasingRenameFixture(t)

  // The reporter's state: the pre-rename row (old casing) plus the duplicate a
  // later scan inserted at the on-disk casing.
  withDirectLibraryDb(userDataDir, (directDb) => {
    directDb.prepare('UPDATE tracks SET path = ?, play_count = 3, last_played_at = 1000, added_at = 500 WHERE path = ?').run(stalePath, trackPath)
    directDb.prepare(`
      INSERT INTO tracks (path, title, artist, album, duration, format, play_count, last_played_at, added_at, modified_at)
      SELECT ?, title, artist, album, duration, format, 2, 2000, 900, modified_at FROM tracks WHERE path = ?
    `).run(trackPath, stalePath)
    directDb.prepare('INSERT INTO track_ratings (track_path, rating, updated_at) VALUES (?, ?, ?)').run(stalePath, 5, 1)
    directDb.prepare('INSERT INTO track_ratings (track_path, rating, updated_at) VALUES (?, ?, ?)').run(trackPath, 2, 2)
  })
  await library.addFavorite(stalePath)
  const playlist = await library.createPlaylist('Merge Playlist')
  await library.addToPlaylist(playlist.id, [stalePath, trackPath])
  assert.equal(library.getPlaylistTracks(playlist.id).length, 2)

  const rescan = await library.scanFolder(musicDir)
  assert.equal(rescan.added, 0)
  assert.equal(rescan.errors, 0)

  assert.deepEqual(getStoredTrackPaths(userDataDir), [trackPath])
  const merged = withDirectLibraryDb(userDataDir, (directDb) =>
    directDb.prepare('SELECT play_count, last_played_at, added_at FROM tracks').get()
  ) as { play_count: number; last_played_at: number | null; added_at: number }
  assert.equal(merged.play_count, 5)
  assert.equal(merged.last_played_at, 2000)
  assert.equal(merged.added_at, 500)
  // On conflict the survivor's (older row's) rating wins; the duplicate's is dropped.
  assert.deepEqual(library.getTrackRatingEntries().map((entry) => [entry.track_path, entry.rating]), [[trackPath, 5]])
  assert.deepEqual(library.getFavoritePaths(), [trackPath])
  assert.deepEqual(library.getPlaylistTracks(playlist.id).map((track) => track.path), [trackPath, trackPath])
})

test('mergeLocalDuplicateTracks preserves duplicate user data on the explicit Keep track', async (t) => {
  const userDataDir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  t.after(() => library.setReplayGainScanEnabled(true))

  const musicDir = join(userDataDir, 'duplicate-merge')
  const keepPath = join(musicDir, 'keep.wav')
  const removedPath = join(musicDir, 'remove.wav')
  await mkdir(musicDir, { recursive: true })
  await writeTaggedWavFixture(keepPath, 'Duplicate Title', 'Duplicate Artist')
  await writeTaggedWavFixture(removedPath, 'Duplicate Title', 'Duplicate Artist')
  const scan = await library.scanFolder(musicDir)
  assert.equal(scan.added, 2)

  withDirectLibraryDb(userDataDir, (directDb) => {
    directDb.prepare('UPDATE tracks SET play_count = 2, last_played_at = 2000, added_at = 900 WHERE path = ?').run(keepPath)
    directDb.prepare('UPDATE tracks SET play_count = 3, last_played_at = 1000, added_at = 500 WHERE path = ?').run(removedPath)
    directDb.prepare('INSERT INTO track_ratings (track_path, rating, updated_at) VALUES (?, 2, 2)').run(keepPath)
    directDb.prepare('INSERT INTO track_ratings (track_path, rating, updated_at) VALUES (?, 5, 1)').run(removedPath)
    directDb.prepare("INSERT INTO track_metadata_overrides (track_path, title, updated_at) VALUES (?, 'Moved Override', 1)").run(removedPath)
    directDb.prepare(
      "INSERT INTO lyrics_cache (track_path, metadata_signature, status, source, synced_lines_json, updated_at) VALUES (?, 'sig', 'not_found', 'embedded', '[]', 1)"
    ).run(removedPath)
    directDb.prepare("INSERT INTO track_loudness (track_path, loudness_lufs, method, analyzed_at) VALUES (?, -14, 'ebur128', 1)").run(removedPath)
    directDb.prepare('INSERT INTO recently_played (track_path, played_at) VALUES (?, 1000)').run(removedPath)
    const removedTrack = directDb.prepare('SELECT id FROM tracks WHERE path = ?').get(removedPath) as { id: number }
    directDb.prepare(`
      INSERT INTO listening_sessions (
        generation, session_key, track_id, track_path, title, artist, album,
        album_identity_key, source_type, duration_seconds, started_at, listened_seconds
      ) VALUES ('test', 'removed-session', ?, ?, 'Duplicate Title', 'Duplicate Artist',
        'Album', 'duplicate-artist-album', 'local', 1, 1, 1)
    `).run(removedTrack.id, removedPath)
  })
  await library.addFavorite(removedPath)
  const playlist = await library.createPlaylist('Duplicate Merge Playlist')
  await library.addToPlaylist(playlist.id, [removedPath, keepPath])

  assert.deepEqual(await library.mergeLocalDuplicateTracks(keepPath, [removedPath]), [removedPath])
  assert.deepEqual(getStoredTrackPaths(userDataDir), [keepPath])
  const merged = withDirectLibraryDb(userDataDir, (directDb) => ({
    track: directDb.prepare('SELECT id, play_count, last_played_at, added_at FROM tracks WHERE path = ?').get(keepPath) as {
      id: number
      play_count: number
      last_played_at: number
      added_at: number
    },
    session: directDb.prepare("SELECT track_id, track_path FROM listening_sessions WHERE session_key = 'removed-session'").get() as {
      track_id: number
      track_path: string
    },
    override: directDb.prepare('SELECT track_path FROM track_metadata_overrides').get(),
    lyrics: directDb.prepare('SELECT track_path FROM lyrics_cache').get(),
    loudness: directDb.prepare('SELECT track_path FROM track_loudness').get(),
    recent: directDb.prepare('SELECT track_path FROM recently_played').get()
  }))
  assert.deepEqual(
    { play_count: merged.track.play_count, last_played_at: merged.track.last_played_at, added_at: merged.track.added_at },
    { play_count: 5, last_played_at: 2000, added_at: 500 }
  )
  assert.equal(merged.session.track_id, merged.track.id)
  assert.equal(merged.session.track_path, removedPath)
  assert.deepEqual(merged.override, { track_path: keepPath })
  assert.deepEqual(merged.lyrics, { track_path: keepPath })
  assert.deepEqual(merged.loudness, { track_path: keepPath })
  assert.deepEqual(merged.recent, { track_path: keepPath })
  assert.deepEqual(library.getTrackRatingEntries().map((entry) => [entry.track_path, entry.rating]), [[keepPath, 2]])
  assert.deepEqual(library.getFavoritePaths(), [keepPath])
  assert.deepEqual(library.getPlaylistTracks(playlist.id).map((track) => track.path), [keepPath, keepPath])
})

test('case-variant paths stay distinct when case folding is disabled', async (t) => {
  const { userDataDir, musicDir, trackPath, stalePath } = await setupCasingRenameFixture(t)
  library.setFsPathCaseFoldingForTests(false)

  withDirectLibraryDb(userDataDir, (directDb) => {
    directDb.prepare('UPDATE tracks SET path = ? WHERE path = ?').run(stalePath, trackPath)
  })

  const rescan = await library.scanFolder(musicDir)
  assert.equal(rescan.added, 1)
  assert.deepEqual(getStoredTrackPaths(userDataDir), [stalePath, trackPath])
})

test('casing repair folds unicode paths, not just ascii', async (t) => {
  const userDataDir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  library.setFsPathCaseFoldingForTests(true)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
    library.setFsPathCaseFoldingForTests(null)
  })

  const musicDir = join(userDataDir, 'music')
  const artistDir = join(musicDir, 'übermüt')
  const trackPath = join(artistDir, 'track.wav')
  await mkdir(artistDir, { recursive: true })
  await writeTaggedWavFixture(trackPath, 'Unicode Title', 'Unicode Artist')
  const initialScan = await library.scanFolder(musicDir)
  assert.equal(initialScan.added, 1)

  const stalePath = join(musicDir, 'ÜBERMÜT', 'track.wav')
  withDirectLibraryDb(userDataDir, (directDb) => {
    directDb.prepare('UPDATE tracks SET path = ? WHERE path = ?').run(stalePath, trackPath)
  })

  const rescan = await library.scanFolder(musicDir)
  assert.equal(rescan.added, 0)
  assert.deepEqual(getStoredTrackPaths(userDataDir), [trackPath])
})

test('casing repair matches NFD-stored unicode paths on macOS', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('NFC normalization of comparable paths only applies on darwin')
    return
  }
  const userDataDir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  library.setFsPathCaseFoldingForTests(true)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
    library.setFsPathCaseFoldingForTests(null)
  })

  const musicDir = join(userDataDir, 'music')
  const artistDir = join(musicDir, 'übermüt')
  const trackPath = join(artistDir, 'track.wav')
  await mkdir(artistDir, { recursive: true })
  await writeTaggedWavFixture(trackPath, 'NFD Title', 'NFD Artist')
  const initialScan = await library.scanFolder(musicDir)
  assert.equal(initialScan.added, 1)

  const stalePath = join(musicDir, 'ÜBERMÜT'.normalize('NFD'), 'track.wav')
  withDirectLibraryDb(userDataDir, (directDb) => {
    directDb.prepare('UPDATE tracks SET path = ? WHERE path = ?').run(stalePath, trackPath)
  })

  const rescan = await library.scanFolder(musicDir)
  assert.equal(rescan.added, 0)
  assert.deepEqual(getStoredTrackPaths(userDataDir), [trackPath])
})

test('genuinely distinct case-variant files never merge even with folding forced', async (t) => {
  const userDataDir = await setupEmptyLibrary(t)
  library.setReplayGainScanEnabled(false)
  library.setFsPathCaseFoldingForTests(true)
  t.after(() => {
    library.setReplayGainScanEnabled(true)
    library.setFsPathCaseFoldingForTests(null)
  })

  const musicDir = join(userDataDir, 'music')
  await mkdir(musicDir, { recursive: true })
  if (await isCaseInsensitiveFsDir(musicDir)) {
    t.skip('requires a case-sensitive filesystem')
    return
  }

  await writeTaggedWavFixture(join(musicDir, 'dup.wav'), 'Lower Title', 'Dup Artist')
  await writeTaggedWavFixture(join(musicDir, 'DUP.wav'), 'Upper Title', 'Dup Artist')

  const scan = await library.scanFolder(musicDir)
  assert.equal(scan.added, 2)
  const rescan = await library.scanFolder(musicDir)
  assert.equal(rescan.added, 0)
  assert.equal(await library.cleanupMissingTracks(), 0)
  assert.equal(getStoredTrackPaths(userDataDir).length, 2)
})

test('cleanupMissingTracks collapses case-variant duplicates of one physical file', async (t) => {
  const { userDataDir, musicDir, trackPath, stalePath } = await setupCasingRenameFixture(t)
  const caseInsensitiveFs = await isCaseInsensitiveFsDir(musicDir)

  withDirectLibraryDb(userDataDir, (directDb) => {
    directDb.prepare('UPDATE tracks SET path = ? WHERE path = ?').run(stalePath, trackPath)
    directDb.prepare(`
      INSERT INTO tracks (path, title, artist, album, duration, format, added_at, modified_at)
      SELECT ?, title, artist, album, duration, format, added_at, modified_at FROM tracks WHERE path = ?
    `).run(trackPath, stalePath)
    directDb.prepare('INSERT INTO track_ratings (track_path, rating, updated_at) VALUES (?, 3, 1)').run(stalePath)
  })

  const removed = await library.cleanupMissingTracks()
  assert.equal(removed, 1)
  const remaining = getStoredTrackPaths(userDataDir)
  assert.equal(remaining.length, 1)
  if (caseInsensitiveFs) {
    // The merge keeps the older row; its casing gets repaired by the folder's
    // next scan, not by cleanup.
    assert.deepEqual(remaining, [stalePath])
    assert.deepEqual(library.getTrackRatingEntries().map((entry) => [entry.track_path, entry.rating]), [[stalePath, 3]])
  } else {
    // On a case-sensitive filesystem the stale path is simply missing.
    assert.deepEqual(remaining, [trackPath])
  }
})

test('casing repair works inside an outer library write transaction', async (t) => {
  const { userDataDir, musicDir, trackPath, stalePath } = await setupCasingRenameFixture(t)

  withDirectLibraryDb(userDataDir, (directDb) => {
    directDb.prepare('UPDATE tracks SET path = ? WHERE path = ?').run(stalePath, trackPath)
  })

  library.beginLibraryWriteTransaction()
  try {
    const rescan = await library.scanFolder(musicDir)
    assert.equal(rescan.added, 0)
    library.commitLibraryWriteTransaction()
  } catch (error) {
    library.rollbackLibraryWriteTransaction()
    throw error
  }
  assert.deepEqual(getStoredTrackPaths(userDataDir), [trackPath])
})

test('addLibraryFolder rejects a case-variant of an existing root when folding', async (t) => {
  const userDataDir = await setupEmptyLibrary(t)
  library.setFsPathCaseFoldingForTests(true)
  t.after(() => {
    library.setFsPathCaseFoldingForTests(null)
  })

  const musicDir = join(userDataDir, 'music')
  await mkdir(musicDir, { recursive: true })
  assert.ok(await library.addLibraryFolder(musicDir))
  assert.equal(await library.addLibraryFolder(join(userDataDir, 'Music')), null)
  assert.equal(library.getLibraryFolders().length, 1)
})

test('clearLyricsCacheMisses preserves cached lyric hits', async (t) => {
  await setupEmptyLibrary(t)
  const source = await library.createSubsonicSource({
    name: 'Lyrics Cache Source',
    base_url: 'https://music.example.test',
    username: 'tester',
    secret_encrypted: 'secret',
    enabled: 1,
    last_status: 'ok'
  })
  await library.upsertSubsonicTracks(source.id, [
    createRemoteTrack({ path: 'subsonic://lyrics/hit', title: 'Hit', artist: 'Artist', album: 'Album' }),
    createRemoteTrack({ path: 'subsonic://lyrics/miss', title: 'Miss', artist: 'Artist', album: 'Album' })
  ])

  await library.upsertLyricsCache({
    trackPath: 'subsonic://lyrics/hit',
    metadataSignature: 'hit-signature',
    status: 'hit',
    source: 'lrclib',
    provider: 'lrclib',
    plainLyrics: 'Cached lyrics',
    syncedLyrics: null,
    syncedLines: []
  })
  await library.upsertLyricsCache({
    trackPath: 'subsonic://lyrics/miss',
    metadataSignature: 'miss-signature',
    status: 'not_found',
    source: 'xlrcdb',
    provider: 'xlrcdb',
    plainLyrics: null,
    syncedLyrics: null,
    syncedLines: []
  })

  await library.clearLyricsCacheMisses()

  assert.equal(library.getLyricsCache('subsonic://lyrics/hit', 'hit-signature')?.status, 'hit')
  assert.equal(library.getLyricsCache('subsonic://lyrics/miss', 'miss-signature'), null)
})

test('cached Enhanced LRC word timing keeps its LRC format', async (t) => {
  await setupEmptyLibrary(t)
  const source = await library.createSubsonicSource({
    name: 'Enhanced Lyrics Cache Source',
    base_url: 'https://music.example.test',
    username: 'tester',
    secret_encrypted: 'secret',
    enabled: 1,
    last_status: 'ok'
  })
  const trackPath = 'subsonic://lyrics/enhanced'
  await library.upsertSubsonicTracks(source.id, [
    createRemoteTrack({
      path: trackPath,
      title: 'Enhanced',
      artist: 'Artist',
      album: 'Album'
    })
  ])

  await library.upsertLyricsCache({
    trackPath,
    metadataSignature: 'enhanced-signature',
    status: 'hit',
    source: 'lrclib',
    provider: 'lrclib',
    plainLyrics: 'Hello world',
    syncedLyrics: '[00:10.00]<00:10.00>Hello <00:10.30>world',
    syncedLines: [
      {
        timestampMs: 10_000,
        text: 'Hello world',
        words: [
          { timestampMs: 10_000, text: 'Hello ' },
          { timestampMs: 10_300, text: 'world' }
        ]
      }
    ]
  })

  const cached = library.getLyricsCache(trackPath, 'enhanced-signature')
  assert.equal(cached?.format, 'lrc')
  assert.deepEqual(cached?.syncedLines[0]?.words, [
    { timestampMs: 10_000, text: 'Hello ' },
    { timestampMs: 10_300, text: 'world' }
  ])
})

// ── Listening stats transfer ─────────────────────────────

async function seedListeningSession(
  generation: string,
  options: {
    sessionKey: string
    trackPath: string
    startedAt: number
    listenedSeconds: number
    durationSeconds?: number
  }
): Promise<void> {
  await library.checkpointListeningSession({
    generation,
    sessionKey: options.sessionKey,
    segmentKey: `${options.sessionKey}-segment`,
    trackPath: options.trackPath,
    sourcePlaylistId: null,
    sessionStartedAt: options.startedAt,
    segmentStartedAt: options.startedAt,
    observedAt: options.startedAt + options.listenedSeconds * 1000,
    sessionListenedSeconds: options.listenedSeconds,
    segmentListenedSeconds: options.listenedSeconds,
    trackDurationSeconds: options.durationSeconds ?? 180,
    qualificationEligible: true,
    finalizeSegment: true,
    finalizeSession: true
  })
}

test('stats transfer round trips into the same library without changing anything', async (t) => {
  await setupSeededLibrary(t)

  await library.setTrackRatingForPaths(['subsonic://1/teen-1'], 4.5)
  await library.addFavoritePaths(['subsonic://1/split-a'])
  const generation = library.getListeningHistoryStatus().generation
  await seedListeningSession(generation, {
    sessionKey: 'round-trip',
    trackPath: 'subsonic://1/teen-1',
    startedAt: 1_700_000_000_000,
    listenedSeconds: 60
  })

  const before = {
    playCount: library.getTrackByPath('subsonic://1/teen-1')?.play_count,
    lastPlayedAt: library.getTrackByPath('subsonic://1/teen-1')?.last_played_at,
    ratings: library.getTrackRatingEntries(),
    favorites: library.getFavorites().map((track) => track.path),
    dashboard: library.getListeningStatsDashboard({
      range: 'all',
      rankingMetric: 'plays',
      artistBrowseMode: 'canonical',
      now: 1_700_000_100_000
    })
  }

  const bundle = library.exportListeningStatsTransfer({ includeHistory: true })
  const result = await library.applyListeningStatsTransfer({
    counts: bundle.counts.encoded,
    history: bundle.history?.encoded
  })

  assert.equal(result.countsApplied, true)
  assert.equal(result.historyApplied, true)
  assert.equal(result.playCountsUpdated, 0, 'a same-library import should change no play counts')
  assert.equal(result.sessionsInserted, 0)
  assert.equal(result.sessionsMerged, 1)

  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, before.playCount)
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.last_played_at, before.lastPlayedAt)
  assert.deepEqual(library.getTrackRatingEntries(), before.ratings)
  assert.deepEqual(library.getFavorites().map((track) => track.path), before.favorites)

  const after = library.getListeningStatsDashboard({
    range: 'all',
    rankingMetric: 'plays',
    artistBrowseMode: 'canonical',
    now: 1_700_000_100_000
  })
  assert.equal(after.summary.listenedSeconds, before.dashboard.summary.listenedSeconds)
  assert.equal(after.summary.qualifiedPlays, before.dashboard.summary.qualifiedPlays)
})

test('play counts from another install add to the local count', async (t) => {
  await setupSeededLibrary(t)

  const encoded = JSON.stringify({
    v: 2,
    tracks: [
      ['', '', 'Teen Intro', 'Jane Remover', 'Teen Week', ''],
      ['', '', 'Teen Feature', 'Jane Remover feat. Venturing', 'Teen Week', '']
    ],
    origins: ['remote-install'],
    plays: [[0, 0, 25, 2_000_000], [1, 0, 4, 500]],
    ratings: [],
    favorites: []
  })

  const generation = library.getListeningHistoryStatus().generation
  await seedListeningSession(generation, {
    sessionKey: 'local-play',
    trackPath: 'subsonic://1/teen-2',
    startedAt: 3_000_000,
    listenedSeconds: 60
  })
  const localTeen2 = library.getTrackByPath('subsonic://1/teen-2')
  assert.equal(localTeen2?.play_count, 1)

  const result = await library.applyListeningStatsTransfer({ counts: encoded })

  // teen-1 had no local plays, so it shows only the imported install's count.
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 25)
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.last_played_at, 2_000_000)
  // teen-2 was played on both machines: 1 local + 4 remote.
  assert.equal(library.getTrackByPath('subsonic://1/teen-2')?.play_count, 5)
  // last_played_at is still a MAX, so the newer local timestamp survives.
  assert.equal(library.getTrackByPath('subsonic://1/teen-2')?.last_played_at, localTeen2?.last_played_at)
  assert.equal(result.playCountsUpdated, 2)
})

test('re-importing the same counts file does not inflate the totals', async (t) => {
  await setupSeededLibrary(t)

  const encoded = JSON.stringify({
    v: 2,
    tracks: [['', '', 'Teen Intro', 'Jane Remover', 'Teen Week', '']],
    origins: ['remote-install'],
    plays: [[0, 0, 25, 2_000_000]],
    ratings: [],
    favorites: []
  })

  await library.applyListeningStatsTransfer({ counts: encoded })
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 25)

  // The same origin merges with MAX, so applying the file again is a no-op even though
  // counts from *different* origins would have added.
  const second = await library.applyListeningStatsTransfer({ counts: encoded })
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 25)
  assert.equal(second.playCountsUpdated, 0)

  // A stale file reporting fewer plays than already recorded cannot lower the count.
  const stale = JSON.stringify({
    v: 2,
    tracks: [['', '', 'Teen Intro', 'Jane Remover', 'Teen Week', '']],
    origins: ['remote-install'],
    plays: [[0, 0, 3, 1_000]],
    ratings: [],
    favorites: []
  })
  await library.applyListeningStatsTransfer({ counts: stale })
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 25)
})

test('a local play after an import adds to the imported total', async (t) => {
  await setupSeededLibrary(t)

  const encoded = JSON.stringify({
    v: 2,
    tracks: [['', '', 'Teen Intro', 'Jane Remover', 'Teen Week', '']],
    origins: ['remote-install'],
    plays: [[0, 0, 10, 1_000]],
    ratings: [],
    favorites: []
  })
  await library.applyListeningStatsTransfer({ counts: encoded })
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 10)

  // The local play lands on this install's own origin row, so it adds rather than
  // colliding with the imported one.
  const generation = library.getListeningHistoryStatus().generation
  await seedListeningSession(generation, {
    sessionKey: 'after-import',
    trackPath: 'subsonic://1/teen-1',
    startedAt: 5_000_000,
    listenedSeconds: 60
  })
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 11)

  // Re-exporting now carries both origins, so the other machine can take our play back.
  const bundle = library.exportListeningStatsTransfer()
  const payload = JSON.parse(bundle.counts.encoded) as { origins: string[] }
  assert.equal(payload.origins.length, 2)
  assert.ok(payload.origins.includes('remote-install'))
})

test('imported ratings apply only when newer than the local rating', async (t) => {
  await setupSeededLibrary(t)

  await library.setTrackRatingForPaths(['subsonic://1/teen-1'], 4)
  const localUpdatedAt = library.getTrackRatingEntries()
    .find((entry) => entry.track_path === 'subsonic://1/teen-1')?.updated_at ?? 0

  const encoded = JSON.stringify({
    v: 2,
    tracks: [
      ['', '', 'Teen Intro', 'Jane Remover', 'Teen Week', ''],
      ['', '', 'Teen Feature', 'Jane Remover feat. Venturing', 'Teen Week', '']
    ],
    origins: [],
    plays: [],
    ratings: [[0, 1.5, localUpdatedAt - 1000], [1, 3.5, localUpdatedAt + 1000]],
    favorites: []
  })

  const result = await library.applyListeningStatsTransfer({ counts: encoded })
  const ratings = new Map(library.getTrackRatingEntries().map((entry) => [entry.track_path, entry.rating]))

  assert.equal(ratings.get('subsonic://1/teen-1'), 4, 'the newer local rating should survive')
  assert.equal(ratings.get('subsonic://1/teen-2'), 3.5)
  assert.equal(result.ratingsKeptLocal, 1)
  assert.equal(result.ratingsApplied, 1)
})

test('imported favorites union with the earliest added_at and clear stale tombstones', async (t) => {
  await setupSeededLibrary(t)

  await library.addFavoritePaths(['subsonic://1/split-a'])
  // Unfavoriting writes a sync tombstone. Re-importing the favorite must clear it, or the
  // next LAN sync would replay the tombstone and delete it again.
  await library.removeFavorite('subsonic://1/split-a')

  const encoded = JSON.stringify({
    v: 2,
    tracks: [['', '', 'Split A', 'Artist A', 'Split Release', '']],
    origins: [],
    plays: [],
    ratings: [],
    favorites: [[0, 1000]]
  })

  const result = await library.applyListeningStatsTransfer({ counts: encoded })

  assert.deepEqual(library.getFavorites().map((track) => track.path), ['subsonic://1/split-a'])
  assert.equal(result.favoritesAdded, 1)
  assert.equal(result.favoriteTombstonesCleared, 1)
  assert.equal(library.getSyncFavoritesState().tombstones.length, 0)

  // A second import keeps the earliest added_at rather than overwriting it.
  const laterEncoded = JSON.stringify({
    v: 2,
    tracks: [['', '', 'Split A', 'Artist A', 'Split Release', '']],
    origins: [],
    plays: [],
    ratings: [],
    favorites: [[0, 9_000_000]]
  })
  await library.applyListeningStatsTransfer({ counts: laterEncoded })
  const favorite = library.getSyncFavoritesState().favorites[0]
  assert.equal(favorite.addedAt, 1000)
})

test('imported history lands under the local generation without touching play counts', async (t) => {
  await setupSeededLibrary(t)

  const generation = library.getListeningHistoryStatus().generation
  const encoded = JSON.stringify({
    v: 2,
    historyStartedAt: 1_600_000_000_000,
    sessionsTotal: 1,
    truncated: false,
    tracks: [['', '', 'Teen Intro', 'Jane Remover', 'Teen Week', '']],
    sessions: [[0, 'foreign-session', 'subsonic', 180, 1_600_000_000_000, 1_600_000_180_000, 180, 1_600_000_015_000]],
    segments: [[0, 'foreign-segment', 1_600_000_000_000, 1_600_000_180_000, 1_600_000_180_000, 180]]
  })

  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 0)
  const result = await library.applyListeningStatsTransfer({ history: encoded })

  assert.equal(result.sessionsInserted, 1)
  assert.equal(result.segmentsInserted, 1)
  // Play counts are imported by the counts category, never replayed from qualified sessions.
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 0)

  const dashboard = library.getListeningStatsDashboard({
    range: 'all',
    rankingMetric: 'plays',
    artistBrowseMode: 'canonical',
    now: 1_600_000_300_000
  })
  assert.equal(dashboard.status.generation, generation)
  assert.equal(dashboard.summary.qualifiedPlays, 1)
  assert.equal(dashboard.summary.listenedSeconds, 180)
  assert.equal(dashboard.status.startedAt, 1_600_000_000_000)
})

test('history for a track missing from this library still imports and renders', async (t) => {
  await setupSeededLibrary(t)

  const encoded = JSON.stringify({
    v: 2,
    historyStartedAt: 1_600_000_000_000,
    sessionsTotal: 1,
    truncated: false,
    tracks: [['', '', 'Ghost Track', 'Ghost Artist', 'Ghost Album', 'Ghost Artist']],
    sessions: [[0, 'ghost-session', 'local', 200, 1_600_000_000_000, 1_600_000_200_000, 200, 1_600_000_015_000]],
    segments: [[0, 'ghost-segment', 1_600_000_000_000, 1_600_000_200_000, 1_600_000_200_000, 200]]
  })

  const result = await library.applyListeningStatsTransfer({ history: encoded })
  assert.equal(result.sessionsInserted, 1)
  assert.equal(result.identitiesUnmatched, 1)

  const dashboard = library.getListeningStatsDashboard({
    range: 'all',
    rankingMetric: 'plays',
    artistBrowseMode: 'canonical',
    now: 1_600_000_300_000
  })
  assert.equal(dashboard.summary.qualifiedPlays, 1)
  const ghost = dashboard.topTracks.find((entry) => entry.title === 'Ghost Track')
  assert.ok(ghost, 'the unmatched session should still rank')
  assert.equal(ghost?.available, false)
})

test('imported sessions drop local-only columns and rebuild the album identity key', async (t) => {
  const dir = await setupSeededLibrary(t)

  const encoded = JSON.stringify({
    v: 2,
    historyStartedAt: 1_600_000_000_000,
    sessionsTotal: 1,
    truncated: false,
    tracks: [['', '', 'Teen Intro', 'Jane Remover', 'Teen Week', 'Jane Remover']],
    sessions: [[0, 'shape-session', 'subsonic', 180, 1_600_000_000_000, null, 180, null]],
    segments: []
  })
  await library.applyListeningStatsTransfer({ history: encoded })

  // Compare against what checkpointListeningSession writes for the same track.
  const generation = library.getListeningHistoryStatus().generation
  await seedListeningSession(generation, {
    sessionKey: 'native-session',
    trackPath: 'subsonic://1/teen-1',
    startedAt: 1_700_000_000_000,
    listenedSeconds: 60
  })

  const directDb = new TestSqliteDatabase(join(dir, 'library.db'))
  try {
    const imported = directDb
      .prepare('SELECT artwork_hash, source_playlist_id, album_identity_key FROM listening_sessions WHERE session_key = ?')
      .get('shape-session') as Record<string, unknown>
    const native = directDb
      .prepare('SELECT album_identity_key FROM listening_sessions WHERE session_key = ?')
      .get('native-session') as Record<string, unknown>

    assert.equal(imported.artwork_hash, null)
    assert.equal(imported.source_playlist_id, null)
    assert.equal(imported.album_identity_key, native.album_identity_key)
  } finally {
    directDb.close()
  }
})

test('importing the same history twice is idempotent', async (t) => {
  const dir = await setupSeededLibrary(t)

  const encoded = JSON.stringify({
    v: 2,
    historyStartedAt: 1_600_000_000_000,
    sessionsTotal: 1,
    truncated: false,
    tracks: [['', '', 'Teen Intro', 'Jane Remover', 'Teen Week', '']],
    sessions: [[0, 'twice-session', 'subsonic', 180, 1_600_000_000_000, 1_600_000_180_000, 180, 1_600_000_015_000]],
    segments: [[0, 'twice-segment', 1_600_000_000_000, 1_600_000_180_000, 1_600_000_180_000, 180]]
  })

  await library.applyListeningStatsTransfer({ history: encoded })
  const second = await library.applyListeningStatsTransfer({ history: encoded })

  assert.equal(second.sessionsInserted, 0)
  assert.equal(second.sessionsMerged, 1)

  const directDb = new TestSqliteDatabase(join(dir, 'library.db'))
  try {
    const sessions = directDb.prepare('SELECT COUNT(*) AS count FROM listening_sessions').get() as { count: number }
    const segments = directDb.prepare('SELECT COUNT(*) AS count FROM listening_segments').get() as { count: number }
    assert.equal(sessions.count, 1)
    assert.equal(segments.count, 1)
  } finally {
    directDb.close()
  }
})

test('the history baseline moves back to cover imported listens', async (t) => {
  await setupSeededLibrary(t)

  const generation = library.getListeningHistoryStatus().generation
  await seedListeningSession(generation, {
    sessionKey: 'local-recent',
    trackPath: 'subsonic://1/teen-1',
    startedAt: 1_700_000_000_000,
    listenedSeconds: 60
  })
  assert.equal(library.getListeningHistoryStatus().startedAt, 1_700_000_000_000)

  const older = JSON.stringify({
    v: 2,
    historyStartedAt: 1_500_000_000_000,
    sessionsTotal: 1,
    truncated: false,
    tracks: [['', '', 'Teen Feature', 'Jane Remover feat. Venturing', 'Teen Week', '']],
    sessions: [[0, 'older-session', 'subsonic', 180, 1_500_000_000_000, 1_500_000_180_000, 180, null]],
    segments: []
  })

  const result = await library.applyListeningStatsTransfer({ history: older })
  assert.equal(result.historyStartedAtMovedTo, 1_500_000_000_000)
  assert.equal(library.getListeningHistoryStatus().startedAt, 1_500_000_000_000)

  // A newer import must not push the baseline forward again.
  const newer = JSON.stringify({
    v: 2,
    historyStartedAt: 1_900_000_000_000,
    sessionsTotal: 1,
    truncated: false,
    tracks: [['', '', 'Teen Feature', 'Jane Remover feat. Venturing', 'Teen Week', '']],
    sessions: [[0, 'newer-session', 'subsonic', 180, 1_900_000_000_000, null, 180, null]],
    segments: []
  })
  await library.applyListeningStatsTransfer({ history: newer })
  assert.equal(library.getListeningHistoryStatus().startedAt, 1_500_000_000_000)
})

test('history export honours the session budget and carries only surviving segments', async (t) => {
  await setupSeededLibrary(t)

  const generation = library.getListeningHistoryStatus().generation
  for (let index = 0; index < 5; index += 1) {
    await seedListeningSession(generation, {
      sessionKey: `budget-${index}`,
      trackPath: 'subsonic://1/teen-1',
      startedAt: 1_600_000_000_000 + index * 600_000,
      listenedSeconds: 60
    })
  }

  const bundle = library.exportListeningStatsTransfer({ includeHistory: true, maxSessions: 2 })
  assert.ok(bundle.history)
  assert.equal(bundle.history?.sessionCount, 2)
  assert.equal(bundle.history?.sessionsTotal, 5)
  assert.equal(bundle.history?.truncated, true)
  assert.equal(bundle.history?.segmentCount, 2)

  const payload = JSON.parse(bundle.history?.encoded ?? '{}') as {
    sessions: Array<[number, string]>
    segments: unknown[]
  }
  // Newest first: budget-4 and budget-3.
  assert.deepEqual(payload.sessions.map((session) => session[1]).sort(), ['budget-3', 'budget-4'])
  assert.equal(payload.segments.length, 2)
})

test('ratings and favorites for tracks missing from the library still export and re-import', async (t) => {
  const dir = await setupSeededLibrary(t)

  // Ratings and favorites deliberately outlive their track rows across a remote resync.
  const directDb = new TestSqliteDatabase(join(dir, 'library.db'))
  try {
    directDb.prepare('INSERT INTO track_ratings (track_path, rating, updated_at) VALUES (?, ?, ?)')
      .run('subsonic://1/vanished', 3.5, 1000)
    directDb.prepare('INSERT INTO favorites (track_path, added_at) VALUES (?, ?)')
      .run('subsonic://1/vanished', 2000)
  } finally {
    directDb.close()
  }

  const bundle = library.exportListeningStatsTransfer()
  const payload = JSON.parse(bundle.counts.encoded) as {
    tracks: StatsTransferTrackTuple[]
    ratings: Array<[number, number, number]>
  }

  // The row has no track to borrow metadata from, so its only identity is the path digest.
  // That is still worth carrying: if the track reappears on this machine later, the digest
  // re-attaches it. On another machine it simply cannot match, which is correct.
  const orphanIndex = payload.tracks.findIndex((tuple) => tuple[2] === '' && tuple[0] !== '')
  assert.ok(orphanIndex >= 0, 'the orphaned rating should still be exported')
  assert.deepEqual(payload.tracks[orphanIndex].slice(2), ['', '', '', ''])
  assert.ok(payload.ratings.some((rating) => rating[0] === orphanIndex))
  assert.equal(bundle.counts.encoded.includes('vanished'), false, 'the path itself must not leak')
})

test('a path digest re-attaches stats on the machine that produced them', async (t) => {
  await setupSeededLibrary(t)

  await library.setTrackRatingForPaths(['subsonic://1/teen-1'], 4)
  const exported = JSON.parse(library.exportListeningStatsTransfer().counts.encoded) as {
    tracks: StatsTransferTrackTuple[]
    ratings: Array<[number, number, number]>
  }
  const ratedIndex = exported.ratings[0][0]
  const [pathHash, pathFoldHash] = exported.tracks[ratedIndex]
  assert.ok(pathHash, 'a track with a real path should export a digest')

  await library.resetAllTrackRatings()
  assert.equal(library.getTrackRatingEntries().length, 0)

  // Metadata deliberately blanked: only the digest can resolve this row, which is the
  // same-machine fast path a backup restore relies on.
  const digestOnly = JSON.stringify({
    v: 2,
    tracks: [[pathHash, pathFoldHash, '', '', '', '']],
    origins: ['this-machine'],
    plays: [],
    ratings: [[0, 4.5, 9_000_000]],
    favorites: []
  })
  const result = await library.applyListeningStatsTransfer({ counts: digestOnly })

  assert.equal(result.identitiesMatched, 1)
  const ratings = new Map(library.getTrackRatingEntries().map((entry) => [entry.track_path, entry.rating]))
  assert.equal(ratings.get('subsonic://1/teen-1'), 4.5)
})

test('a malformed payload is rejected before any write happens', async (t) => {
  await setupSeededLibrary(t)

  await library.setTrackRatingForPaths(['subsonic://1/teen-1'], 4)
  const before = library.getTrackRatingEntries()

  await assert.rejects(
    () => library.applyListeningStatsTransfer({ counts: '{"v":99,"tracks":[]}' }),
    /unsupported listening data version/i
  )
  await assert.rejects(
    () => library.applyListeningStatsTransfer({ counts: 'not json at all' }),
    /could not be read/i
  )

  assert.deepEqual(library.getTrackRatingEntries(), before)
})

test('the denormalized play count always equals the sum of its origin rows', async (t) => {
  const dir = await setupSeededLibrary(t)

  const encoded = JSON.stringify({
    v: 2,
    tracks: [['', '', 'Teen Intro', 'Jane Remover', 'Teen Week', '']],
    origins: ['remote-install'],
    plays: [[0, 0, 9, 1000]],
    ratings: [],
    favorites: []
  })
  await library.applyListeningStatsTransfer({ counts: encoded })
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 9)

  const generation = library.getListeningHistoryStatus().generation
  await seedListeningSession(generation, {
    sessionKey: 'sum-check',
    trackPath: 'subsonic://1/teen-1',
    startedAt: 5_000_000,
    listenedSeconds: 60
  })

  const directDb = new TestSqliteDatabase(join(dir, 'library.db'))
  try {
    const summed = directDb
      .prepare('SELECT SUM(play_count) AS total FROM track_play_origins WHERE track_path = ?')
      .get('subsonic://1/teen-1') as { total: number }
    const stored = directDb
      .prepare('SELECT play_count FROM tracks WHERE path = ?')
      .get('subsonic://1/teen-1') as { play_count: number }

    assert.equal(summed.total, 10)
    assert.equal(stored.play_count, summed.total)
  } finally {
    directDb.close()
  }
})

test('stats transfer availability reports whether history exists', async (t) => {
  await setupSeededLibrary(t)

  assert.deepEqual(library.getListeningStatsTransferAvailability(), { hasHistory: false, sessionCount: 0 })
  assert.equal(library.exportListeningStatsTransfer({ includeHistory: true }).history?.sessionCount, 0)

  const generation = library.getListeningHistoryStatus().generation
  await seedListeningSession(generation, {
    sessionKey: 'availability',
    trackPath: 'subsonic://1/teen-1',
    startedAt: 1_600_000_000_000,
    listenedSeconds: 60
  })

  assert.deepEqual(library.getListeningStatsTransferAvailability(), { hasHistory: true, sessionCount: 1 })
})

test('counts and history resolve independently despite sharing index numbers', async (t) => {
  await setupSeededLibrary(t)

  // The two payloads carry separate track dictionaries, so index 0 means a different track
  // in each. Importing them together must not let one section's resolution leak into the other.
  const counts = JSON.stringify({
    v: 2,
    tracks: [['', '', 'Teen Intro', 'Jane Remover', 'Teen Week', '']],
    origins: ['remote-install'],
    plays: [[0, 0, 11, 1000]],
    ratings: [],
    favorites: []
  })
  const history = JSON.stringify({
    v: 2,
    historyStartedAt: 1_600_000_000_000,
    sessionsTotal: 1,
    truncated: false,
    tracks: [['', '', 'Split B', 'Artist B', 'Split Release', '']],
    sessions: [[0, 'cross-session', 'subsonic', 180, 1_600_000_000_000, 1_600_000_180_000, 180, 1_600_000_015_000]],
    segments: [[0, 'cross-segment', 1_600_000_000_000, 1_600_000_180_000, 1_600_000_180_000, 180]]
  })

  await library.applyListeningStatsTransfer({ counts, history })

  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 11)

  const dashboard = library.getListeningStatsDashboard({
    range: 'all',
    rankingMetric: 'plays',
    artistBrowseMode: 'canonical',
    now: 1_600_000_300_000
  })
  const ranked = dashboard.topTracks.find((entry) => entry.qualifiedPlays > 0)
  assert.equal(ranked?.title, 'Split B', 'the session must resolve to its own dictionary entry')
  assert.equal(ranked?.trackPath, 'subsonic://1/split-b')
  assert.equal(ranked?.available, true)
})

test('stats from a different machine resolve onto the local library by metadata', async (t) => {
  await setupSeededLibrary(t)

  // The realistic cross-machine case: the other install stored the same music under
  // completely different paths, so nothing matches on path and everything has to resolve
  // through the metadata tiers.
  const counts = JSON.stringify({
    v: 2,
    tracks: [
      ['deadbeefdeadbeef', 'cafebabecafebabe', 'Teen Intro', 'Jane Remover', 'Teen Week', ''],
      ['0123456789abcdef', 'fedcba9876543210', 'Split A', 'Artist A', 'Split Release', '']
    ],
    origins: ['other-machine'],
    plays: [[0, 0, 9, 2_000_000], [1, 0, 4, 2_100_000]],
    ratings: [[0, 5, 9_000_000]],
    favorites: [[1, 1_500_000]]
  })
  const history = JSON.stringify({
    v: 2,
    historyStartedAt: 1_600_000_000_000,
    sessionsTotal: 1,
    truncated: false,
    tracks: [['deadbeefdeadbeef', 'cafebabecafebabe', 'Teen Intro', 'Jane Remover', 'Teen Week', '']],
    sessions: [[0, 'other-machine-session', 'local', 180, 1_600_000_000_000, 1_600_000_180_000, 180, 1_600_000_015_000]],
    segments: [[0, 'other-machine-segment', 1_600_000_000_000, 1_600_000_180_000, 1_600_000_180_000, 180]]
  })

  const result = await library.applyListeningStatsTransfer({ counts, history })

  // Path digests from another machine match nothing, yet every row still lands.
  assert.equal(result.identitiesUnmatched, 0)
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 9)
  assert.equal(library.getTrackByPath('subsonic://1/split-a')?.play_count, 4)
  assert.deepEqual(library.getFavorites().map((track) => track.path), ['subsonic://1/split-a'])

  const ratings = new Map(library.getTrackRatingEntries().map((entry) => [entry.track_path, entry.rating]))
  assert.equal(ratings.get('subsonic://1/teen-1'), 5)

  // The session attaches to the real local track, not a synthetic unmatched placeholder.
  const dashboard = library.getListeningStatsDashboard({
    range: 'all',
    rankingMetric: 'plays',
    artistBrowseMode: 'canonical',
    now: 1_600_000_300_000
  })
  const ranked = dashboard.topTracks.find((entry) => entry.title === 'Teen Intro')
  assert.equal(ranked?.trackPath, 'subsonic://1/teen-1')
  assert.equal(ranked?.available, true)
})

test('an unmatched cross-machine session stores a synthetic id, never a path digest', async (t) => {
  const dir = await setupSeededLibrary(t)

  const history = JSON.stringify({
    v: 2,
    historyStartedAt: 1_600_000_000_000,
    sessionsTotal: 1,
    truncated: false,
    tracks: [['deadbeefdeadbeef', 'cafebabecafebabe', 'Foreign Song', 'Foreign Artist', 'Foreign Album', '']],
    sessions: [[0, 'foreign', 'local', 180, 1_600_000_000_000, null, 180, null]],
    segments: []
  })
  await library.applyListeningStatsTransfer({ history })

  const directDb = new TestSqliteDatabase(join(dir, 'library.db'))
  try {
    const row = directDb
      .prepare('SELECT track_path, track_id FROM listening_sessions WHERE session_key = ?')
      .get('foreign') as { track_path: string; track_id: number | null }

    assert.equal(row.track_id, null)
    assert.ok(row.track_path.startsWith('astra-sync://unmatched/'))
    assert.equal(row.track_path.includes('deadbeefdeadbeef'), false)
  } finally {
    directDb.close()
  }
})

test('an exported settings payload contains no filesystem paths', async (t) => {
  await setupSeededLibrary(t)

  await library.setTrackRatingForPaths(['subsonic://1/teen-1'], 4)
  await library.addFavoritePaths(['subsonic://1/split-a'])
  const generation = library.getListeningHistoryStatus().generation
  await seedListeningSession(generation, {
    sessionKey: 'privacy',
    trackPath: 'subsonic://1/teen-1',
    startedAt: 1_600_000_000_000,
    listenedSeconds: 60
  })

  const bundle = library.exportListeningStatsTransfer({ includeHistory: true })
  for (const encoded of [bundle.counts.encoded, bundle.history?.encoded ?? '']) {
    assert.equal(encoded.includes('subsonic://'), false, 'track paths must not be exported in the clear')
    assert.equal(encoded.includes('/teen-1'), false)
  }
})

// ── External listening imports ───────────────────────────

function buildImportFile(overrides: Record<string, unknown> = {}) {
  const base = 1_750_000_000_000
  return {
    kind: 'astra-listening-import' as const,
    formatVersion: 1 as const,
    source: 'lastfm',
    generator: 'test-converter',
    generatedAt: '2026-07-24T00:00:00.000Z',
    tracks: [['Teen Intro', 'Jane Remover', 'Teen Week', '']] as Array<[string, string, string, string]>,
    plays: [[0, 6, base]] as Array<[number, number, number | null]>,
    events: [
      [0, 'p1', base, base + 180_000, 180, true],
      [0, 'p2', base + 200_000, base + 380_000, 180, true]
    ] as Array<[number, string, number, number | null, number, boolean]>,
    ...overrides
  }
}

test('an external import lands on matched tracks and is attributed to its source', async (t) => {
  const dir = await setupSeededLibrary(t)

  const result = await library.applyExternalListeningImport(buildImportFile())
  assert.equal(result.identitiesMatched, 1)
  assert.equal(result.sessionsInserted, 2)
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 6)

  const dashboard = library.getListeningStatsDashboard({
    range: 'all', rankingMetric: 'time', artistBrowseMode: 'canonical', now: 1_750_500_000_000
  })
  assert.equal(dashboard.summary.qualifiedPlays, 2)
  assert.equal(dashboard.summary.listenedSeconds, 360)

  // Provenance is derived by Astra, never taken from the file.
  const directDb = new TestSqliteDatabase(join(dir, 'library.db'))
  try {
    const session = directDb
      .prepare('SELECT source_type, session_key FROM listening_sessions LIMIT 1')
      .get() as { source_type: string; session_key: string }
    const origin = directDb
      .prepare('SELECT origin_id FROM track_play_origins WHERE track_path = ?')
      .get('subsonic://1/teen-1') as { origin_id: string }

    assert.equal(session.source_type, 'import:lastfm')
    assert.ok(session.session_key.startsWith('import:lastfm:'))
    assert.equal(origin.origin_id, 'import:lastfm')
  } finally {
    directDb.close()
  }
})

test('an import file cannot claim another install as the origin of its plays', async (t) => {
  const dir = await setupSeededLibrary(t)

  // Local listening first, so there is a real origin row that must not be touched.
  const generation = library.getListeningHistoryStatus().generation
  await seedListeningSession(generation, {
    sessionKey: 'genuine', trackPath: 'subsonic://1/teen-1',
    startedAt: 1_700_000_000_000, listenedSeconds: 60
  })
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 1)

  // The public format has no field for an origin id, so nothing a converter writes can
  // reach one. Play counts add rather than overwrite.
  await library.applyExternalListeningImport(buildImportFile({ plays: [[0, 6, 1_750_000_000_000]] }))
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 7)

  const directDb = new TestSqliteDatabase(join(dir, 'library.db'))
  try {
    const origins = directDb
      .prepare('SELECT origin_id, play_count FROM track_play_origins WHERE track_path = ? ORDER BY origin_id')
      .all('subsonic://1/teen-1') as Array<{ origin_id: string; play_count: number }>
    assert.equal(origins.length, 2, 'local and imported plays stay in separate origin rows')
    assert.equal(origins.find((o) => o.origin_id === 'import:lastfm')?.play_count, 6)
    assert.equal(origins.find((o) => o.origin_id !== 'import:lastfm')?.play_count, 1)
  } finally {
    directDb.close()
  }
})

test('re-importing the same external file changes nothing', async (t) => {
  await setupSeededLibrary(t)

  await library.applyExternalListeningImport(buildImportFile())
  const first = library.getListeningStatsDashboard({
    range: 'all', rankingMetric: 'time', artistBrowseMode: 'canonical', now: 1_750_500_000_000
  })

  const second = await library.applyExternalListeningImport(buildImportFile())
  const after = library.getListeningStatsDashboard({
    range: 'all', rankingMetric: 'time', artistBrowseMode: 'canonical', now: 1_750_500_000_000
  })

  assert.equal(second.sessionsInserted, 0)
  assert.equal(second.sessionsMerged, 2)
  assert.equal(after.summary.listenedSeconds, first.summary.listenedSeconds)
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 6)
})

test('external play counts sum when distinct source identities resolve to one local track', async (t) => {
  await setupSeededLibrary(t)

  const file = buildImportFile({
    tracks: [
      ['Teen Intro', 'Jane Remover', 'Edition A', ''],
      ['Teen Intro', 'Jane Remover', 'Edition B', '']
    ],
    plays: [
      [0, 5, 1_750_000_000_000],
      [1, 7, 1_750_100_000_000]
    ],
    events: []
  })

  await library.applyExternalListeningImport(file)
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 12)
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.last_played_at, 1_750_100_000_000)

  await library.applyExternalListeningImport(file)
  assert.equal(
    library.getTrackByPath('subsonic://1/teen-1')?.play_count,
    12,
    'the summed source contribution must remain idempotent'
  )
})

test('skipping an unusable imported session does not shift segments onto a later session', async (t) => {
  const dir = await setupSeededLibrary(t)
  const base = 1_750_000_000_000

  const result = await library.applyExternalListeningImport(buildImportFile({
    tracks: [
      ['', 'Unknown Artist', '', ''],
      ['Teen Intro', 'Jane Remover', 'Teen Week', '']
    ],
    plays: [],
    events: [
      [0, 'skipped', base, base + 90_000, 90, true],
      [1, 'kept', base + 200_000, base + 380_000, 180, true]
    ]
  }))

  assert.equal(result.sessionsSkipped, 1)
  assert.equal(result.sessionsInserted, 1)
  assert.equal(result.segmentsInserted, 1)

  const directDb = new TestSqliteDatabase(join(dir, 'library.db'))
  try {
    const rows = directDb.prepare(`
      SELECT s.session_key, seg.segment_key, seg.started_at, seg.listened_seconds
      FROM listening_sessions s
      INNER JOIN listening_segments seg ON seg.session_id = s.id
      WHERE s.source_type = 'import:lastfm'
    `).all() as Array<{
      session_key: string
      segment_key: string
      started_at: number
      listened_seconds: number
    }>

    assert.deepEqual(rows, [{
      session_key: 'import:lastfm:kept',
      segment_key: 'kept:s',
      started_at: base + 200_000,
      listened_seconds: 180
    }])
  } finally {
    directDb.close()
  }
})

test('external history conversion supports more than 125,000 listens', async (t) => {
  await setupSeededLibrary(t)
  const eventCount = 125_001
  const base = 1_750_000_000_000
  const events = Array.from({ length: eventCount }, (_, index) => (
    [0, `large-${index}`, base + index, base + index + 1, 0.001, false]
  )) as Array<[number, string, number, number, number, boolean]>

  const result = await library.applyExternalListeningImport(buildImportFile({
    tracks: [['', 'Unknown Artist', '', '']],
    plays: [],
    events
  }))

  assert.equal(result.sessionsSkipped, eventCount)
  assert.equal(result.sessionsInserted, 0)
})

test('imported sources are listed with their totals', async (t) => {
  await setupSeededLibrary(t)
  assert.deepEqual(library.getImportedListeningSources(), [])

  await library.applyExternalListeningImport(buildImportFile())
  const sources = library.getImportedListeningSources()

  assert.equal(sources.length, 1)
  assert.equal(sources[0].source, 'lastfm')
  assert.equal(sources[0].generator, 'test-converter')
  assert.equal(sources[0].sessionCount, 2)
  assert.equal(sources[0].playCount, 6)
  assert.equal(sources[0].trackCount, 1)
  assert.ok(sources[0].importedAt > 0)
})

test('removing an imported source leaves locally recorded listening intact', async (t) => {
  const dir = await setupSeededLibrary(t)

  await library.setTrackRatingForPaths(['subsonic://1/teen-1'], 4.5)
  await library.addFavoritePaths(['subsonic://1/teen-1'])
  const generation = library.getListeningHistoryStatus().generation
  await seedListeningSession(generation, {
    sessionKey: 'genuine', trackPath: 'subsonic://1/teen-1',
    startedAt: 1_700_000_000_000, listenedSeconds: 90
  })
  await library.applyExternalListeningImport(buildImportFile())
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 7)

  const removal = await library.removeImportedListeningSource('lastfm')
  assert.equal(removal.sessionsRemoved, 2)

  // The local play survives; the imported ones are gone.
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 1)
  assert.equal(
    library.getTrackRatingEntries().find((entry) => entry.track_path === 'subsonic://1/teen-1')?.rating,
    4.5
  )
  assert.deepEqual(library.getFavoritePaths(), ['subsonic://1/teen-1'])
  assert.deepEqual(library.getImportedListeningSources(), [])

  const dashboard = library.getListeningStatsDashboard({
    range: 'all', rankingMetric: 'time', artistBrowseMode: 'canonical', now: 1_750_500_000_000
  })
  assert.equal(dashboard.summary.qualifiedPlays, 1)
  assert.equal(dashboard.summary.listenedSeconds, 90)

  const directDb = new TestSqliteDatabase(join(dir, 'library.db'))
  try {
    const orphanSegments = directDb.prepare(`
      SELECT COUNT(*) AS count FROM listening_segments
      WHERE session_id NOT IN (SELECT id FROM listening_sessions)
    `).get() as { count: number }
    assert.equal(orphanSegments.count, 0, 'segments must not outlive their sessions')
  } finally {
    directDb.close()
  }
})

test('removing one source leaves other imported sources alone', async (t) => {
  await setupSeededLibrary(t)

  await library.applyExternalListeningImport(buildImportFile())
  await library.applyExternalListeningImport(buildImportFile({
    source: 'itunes',
    plays: [[0, 3, 1_750_000_000_000]],
    events: [[0, 'q1', 1_750_100_000_000, 1_750_100_180_000, 180, true]]
  }))
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 9)
  assert.equal(library.getImportedListeningSources().length, 2)

  await library.removeImportedListeningSource('lastfm')

  const remaining = library.getImportedListeningSources()
  assert.deepEqual(remaining.map((entry) => entry.source), ['itunes'])
  assert.equal(library.getTrackByPath('subsonic://1/teen-1')?.play_count, 3)
})

test('removing an unknown or malformed source is a no-op', async (t) => {
  await setupSeededLibrary(t)
  await library.applyExternalListeningImport(buildImportFile())

  assert.deepEqual(await library.removeImportedListeningSource('nope'), {
    source: 'nope', sessionsRemoved: 0, tracksAffected: 0
  })
  assert.deepEqual(await library.removeImportedListeningSource('NOT A SLUG'), {
    source: 'NOT A SLUG', sessionsRemoved: 0, tracksAffected: 0
  })
  assert.equal(library.getImportedListeningSources().length, 1)
})

test('an external listen for a track outside the library still records', async (t) => {
  await setupSeededLibrary(t)

  const result = await library.applyExternalListeningImport(buildImportFile({
    tracks: [['Unknown Song', 'Unknown Artist', 'Unknown Album', '']],
    plays: [],
    events: [[0, 'p1', 1_750_000_000_000, 1_750_000_180_000, 180, true]]
  }))

  assert.equal(result.identitiesUnmatched, 1)
  const dashboard = library.getListeningStatsDashboard({
    range: 'all', rankingMetric: 'time', artistBrowseMode: 'canonical', now: 1_750_500_000_000
  })
  const ranked = dashboard.topTracks.find((entry) => entry.title === 'Unknown Song')
  assert.ok(ranked)
  assert.equal(ranked?.available, false)
})

test('an external listen can be recorded without counting as a play', async (t) => {
  await setupSeededLibrary(t)

  await library.applyExternalListeningImport(buildImportFile({
    plays: [],
    events: [[0, 'p1', 1_750_000_000_000, 1_750_000_180_000, 180, false]]
  }))

  const dashboard = library.getListeningStatsDashboard({
    range: 'all', rankingMetric: 'time', artistBrowseMode: 'canonical', now: 1_750_500_000_000
  })
  assert.equal(dashboard.summary.listenedSeconds, 180, 'time still counts')
  assert.equal(dashboard.summary.qualifiedPlays, 0, 'but it is not a play')
})
