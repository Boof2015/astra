import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getUniqueTrackPaths,
  pruneCachedTracks,
  resolveCachedTrackPaths,
  updateFullTrackConsumers,
  type DbTrack
} from './libraryStore.ts'

function makeTrack(path: string, overrides: Partial<DbTrack> = {}): DbTrack {
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

test('getUniqueTrackPaths de-duplicates while preserving first-seen order', () => {
  assert.deepEqual(
    getUniqueTrackPaths([
      makeTrack('/music/a.flac'),
      makeTrack('/music/b.flac'),
      makeTrack('/music/a.flac', { title: 'Duplicate' }),
      makeTrack('/music/c.flac')
    ]),
    ['/music/a.flac', '/music/b.flac', '/music/c.flac']
  )
})

test('resolveCachedTrackPaths preserves requested order and reports incomplete caches', () => {
  const cache = new Map([
    ['/music/a.flac', makeTrack('/music/a.flac')],
    ['/music/c.flac', makeTrack('/music/c.flac')]
  ])

  assert.deepEqual(resolveCachedTrackPaths(['/music/c.flac', '/music/a.flac'], cache), {
    tracks: [cache.get('/music/c.flac'), cache.get('/music/a.flac')],
    complete: true
  })

  assert.deepEqual(resolveCachedTrackPaths(['/music/a.flac', '/music/b.flac'], cache), {
    tracks: [cache.get('/music/a.flac')],
    complete: false
  })
})

test('pruneCachedTracks removes unreferenced tracks even when retained set size matches cache size', () => {
  const cache = new Map([
    ['/music/a.flac', makeTrack('/music/a.flac')],
    ['/music/b.flac', makeTrack('/music/b.flac')]
  ])

  const pruned = pruneCachedTracks(cache, new Set(['/music/b.flac', '/music/c.flac']))

  assert.deepEqual([...pruned.keys()], ['/music/b.flac'])
})

test('updateFullTrackConsumers releases full tracks only after the last consumer leaves', () => {
  const retained = updateFullTrackConsumers(new Set(['library', 'graph']), 'graph', 'release')
  assert.deepEqual([...retained.consumers], ['library'])
  assert.equal(retained.shouldReleaseFullTracks, false)

  const released = updateFullTrackConsumers(retained.consumers, 'library', 'release')
  assert.deepEqual([...released.consumers], [])
  assert.equal(released.shouldReleaseFullTracks, true)
})
