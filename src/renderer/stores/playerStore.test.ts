import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createQueueEntriesFromPaths,
  createQueueEntryFromTrack,
  GAPLESS_PREBUFFER_LEAD_SECONDS,
  getGaplessPrebufferDelayMs,
  MAX_PLAYBACK_HISTORY,
  usePlayerStore,
  type QueueTrackEntry
} from './playerStore.ts'
import { useLibraryStore, type DbTrack } from './libraryStore.ts'
import type { Track } from '../types/audio.ts'

function makeTrack(path: string, overrides: Partial<Track> = {}): Track {
  return {
    id: overrides.id ?? path,
    path,
    origin: overrides.origin,
    title: overrides.title ?? path,
    artist: overrides.artist ?? 'Artist',
    artistNames: overrides.artistNames,
    album: overrides.album ?? 'Album',
    albumArtist: overrides.albumArtist,
    albumArtistNames: overrides.albumArtistNames,
    albumIdentityKey: overrides.albumIdentityKey,
    duration: overrides.duration ?? 180,
    trackNumber: overrides.trackNumber,
    discNumber: overrides.discNumber,
    year: overrides.year,
    genre: overrides.genre,
    artworkData: overrides.artworkData,
    artworkHash: overrides.artworkHash,
    format: overrides.format ?? 'flac',
    sampleRate: overrides.sampleRate,
    bitDepth: overrides.bitDepth,
    bitrate: overrides.bitrate,
    channels: overrides.channels,
    codec: overrides.codec,
    codecProfile: overrides.codecProfile,
    isAtmosJoc: overrides.isAtmosJoc,
    replayGainTrackDb: overrides.replayGainTrackDb,
    replayGainAlbumDb: overrides.replayGainAlbumDb,
    sourceType: overrides.sourceType,
    sourceId: overrides.sourceId,
    sourceTrackId: overrides.sourceTrackId,
    sourcePath: overrides.sourcePath,
    isAvailable: overrides.isAvailable,
    availabilityReason: overrides.availabilityReason
  }
}

function makeDbTrack(path: string, overrides: Partial<DbTrack> = {}): DbTrack {
  return {
    id: overrides.id ?? Math.abs(path.split('').reduce((total, char) => total + char.charCodeAt(0), 0)),
    path,
    album_identity_key: overrides.album_identity_key ?? 'album:key',
    is_new: overrides.is_new ?? false,
    title: overrides.title ?? path,
    artist: overrides.artist ?? 'Artist',
    artist_names: overrides.artist_names ?? ['Artist'],
    album: overrides.album ?? 'Album',
    album_artist: overrides.album_artist ?? 'Artist',
    album_artist_names: overrides.album_artist_names ?? ['Artist'],
    duration: overrides.duration ?? 180,
    track_number: overrides.track_number ?? 1,
    disc_number: overrides.disc_number ?? 1,
    year: overrides.year ?? 2026,
    genre: overrides.genre ?? null,
    artwork_hash: overrides.artwork_hash ?? null,
    base_artwork_hash: overrides.base_artwork_hash ?? null,
    format: overrides.format ?? 'flac',
    sample_rate: overrides.sample_rate ?? 44100,
    bit_depth: overrides.bit_depth ?? 16,
    bitrate: overrides.bitrate ?? null,
    channels: overrides.channels ?? 2,
    bpm: overrides.bpm ?? null,
    musical_key: overrides.musical_key ?? null,
    source_type: overrides.source_type ?? 'local',
    source_id: overrides.source_id ?? null,
    source_track_id: overrides.source_track_id ?? null,
    source_path: overrides.source_path ?? null,
    is_available: overrides.is_available ?? 1,
    availability_reason: overrides.availability_reason ?? null,
    file_created_at: overrides.file_created_at ?? null,
    replaygain_track_gain_db: overrides.replaygain_track_gain_db ?? null,
    replaygain_album_gain_db: overrides.replaygain_album_gain_db ?? null,
    added_at: overrides.added_at ?? 1,
    modified_at: overrides.modified_at ?? 1
  }
}

function hasArtworkData(entry: QueueTrackEntry): boolean {
  return Object.hasOwn(entry.snapshot as Record<string, unknown>, 'artworkData')
}

function resetStores(): void {
  useLibraryStore.setState({
    trackByPath: new Map<string, DbTrack>(),
    trackCacheVersion: 0
  })

  usePlayerStore.setState({
    currentTrack: null,
    currentTrackSource: 'manual',
    playbackState: 'stopped',
    currentTime: 0,
    duration: 0,
    userQueue: [],
    autoQueue: [],
    autoQueueIndex: -1,
    autoQueueSourcePlaylistId: null,
    autoQueueContextLabel: null,
    shuffle: false,
    repeat: 'none',
    shuffledAutoIndices: [],
    playbackHistory: [],
    playbackFuture: []
  })
}

test('queue entries strip artworkData from retained snapshots', () => {
  resetStores()

  const entry = createQueueEntryFromTrack(makeTrack('/external/track.flac', {
    artworkData: 'data:image/jpeg;base64,large',
    artworkHash: 'cached-hash'
  }))

  assert.equal(entry.path, '/external/track.flac')
  assert.equal(hasArtworkData(entry), false)
  assert.equal(entry.snapshot.artworkHash, 'cached-hash')
})

test('path queue entries hydrate snapshots from cached library metadata', () => {
  resetStores()

  const dbTrack = makeDbTrack('/music/a.flac', {
    title: 'Cached Title',
    artist: 'Cached Artist',
    artwork_hash: 'art-hash'
  })
  useLibraryStore.setState({
    trackByPath: new Map([[dbTrack.path, dbTrack]])
  })

  const [entry] = createQueueEntriesFromPaths([dbTrack.path])
  assert.ok(entry)
  assert.equal(entry.snapshot.title, 'Cached Title')
  assert.equal(entry.snapshot.artist, 'Cached Artist')
  assert.equal(entry.snapshot.artworkHash, 'art-hash')
  assert.equal(hasArtworkData(entry), false)

  usePlayerStore.setState({ userQueue: [entry] })
  const [resolved] = usePlayerStore.getState().getResolvedUserQueueEntries()
  assert.equal(resolved?.track.title, 'Cached Title')
  assert.equal(resolved?.track.artworkHash, 'art-hash')
})

test('associated external queue entries use sanitized snapshots instead of library hydration', () => {
  resetStores()

  const trackPath = '/music/opened.flac'
  useLibraryStore.setState({
    trackByPath: new Map([[trackPath, makeDbTrack(trackPath, { title: 'Library Title' })]])
  })

  const entry = createQueueEntryFromTrack(makeTrack(trackPath, {
    origin: 'associated-external',
    title: 'Opened File Title',
    artworkData: 'data:image/png;base64,large'
  }))
  usePlayerStore.setState({ userQueue: [entry] })

  const [resolved] = usePlayerStore.getState().getResolvedUserQueueEntries()
  assert.equal(hasArtworkData(entry), false)
  assert.equal(resolved?.track.title, 'Opened File Title')
  assert.equal(resolved?.track.origin, 'associated-external')
  assert.equal(Object.hasOwn(resolved?.track as unknown as Record<string, unknown>, 'artworkData'), false)
})

test('gapless prebuffer delay waits until the late handoff window', () => {
  assert.equal(getGaplessPrebufferDelayMs(0, 180), 165_000)
  assert.equal(getGaplessPrebufferDelayMs(164.6, 180), 400)
  assert.equal(getGaplessPrebufferDelayMs(165, 180), 0)
  assert.equal(getGaplessPrebufferDelayMs(0, GAPLESS_PREBUFFER_LEAD_SECONDS), 0)
  assert.equal(getGaplessPrebufferDelayMs(0, 0), 0)
})

test('playback history is capped and stores sanitized queue entries', async () => {
  resetStores()

  const originalLoadAndPlayTrack = usePlayerStore.getState()._loadAndPlayTrack
  usePlayerStore.setState({
    _loadAndPlayTrack: async () => 'loaded'
  })

  try {
    const iterations = MAX_PLAYBACK_HISTORY + 5
    for (let index = 0; index < iterations; index += 1) {
      usePlayerStore.setState({
        currentTrack: makeTrack(`/history/current-${index}.flac`, {
          artworkData: `data:image/jpeg;base64,${index}`
        }),
        currentTrackSource: 'manual',
        autoQueueIndex: -1
      })

      await usePlayerStore.getState().startPlaybackContext([
        makeTrack(`/history/next-${index}.flac`)
      ], 0)
    }

    const history = usePlayerStore.getState().playbackHistory
    assert.equal(history.length, MAX_PLAYBACK_HISTORY)
    assert.equal(history[0]?.entry.path, '/history/current-5.flac')
    assert.equal(history.every((entry) => !hasArtworkData(entry.entry)), true)
  } finally {
    usePlayerStore.setState({
      _loadAndPlayTrack: originalLoadAndPlayTrack
    })
  }
})
