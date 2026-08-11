import assert from 'node:assert/strict'
import test from 'node:test'
import { compareTracksBySortRules, type TrackSortRecord } from './trackSort.ts'

function track(path: string, patch: Partial<TrackSortRecord>): TrackSortRecord {
  return {
    path,
    title: path,
    artist: '',
    album: '',
    year: null,
    genre: null,
    bpm: null,
    musical_key: null,
    format: null,
    duration: 120,
    source_type: 'local',
    file_created_at: null,
    added_at: 1,
    play_count: 0,
    ...patch
  }
}

test('multikey track sorting applies rules in priority order', () => {
  const tracks = [
    track('/a', { artist: 'Same', year: 2020, album: 'A' }),
    track('/b', { artist: 'Same', year: 2024, album: 'B' }),
    track('/c', { artist: 'Other', year: 2022, album: 'C' })
  ]
  tracks.sort((left, right) => compareTracksBySortRules(left, right, [
    { key: 'artist', direction: 'asc' },
    { key: 'year', direction: 'desc' }
  ]))
  assert.deepEqual(tracks.map((item) => item.path), ['/c', '/b', '/a'])
})

test('nullable track metadata stays last in both directions', () => {
  const known = track('/known', { year: 2020 })
  const missing = track('/missing', { year: null })
  assert.ok(compareTracksBySortRules(known, missing, [{ key: 'year', direction: 'asc' }]) < 0)
  assert.ok(compareTracksBySortRules(known, missing, [{ key: 'year', direction: 'desc' }]) < 0)

  const knownArtist = track('/artist', { artist: 'Known' })
  const missingArtist = track('/missing-artist', { artist: '' })
  assert.ok(compareTracksBySortRules(knownArtist, missingArtist, [{ key: 'artist', direction: 'desc' }]) < 0)
})

test('Year and Codec sort in both directions while missing values remain last', () => {
  const tracks = [
    track('/missing', { year: null, format: null }),
    track('/old-flac', { year: 2020, format: 'flac' }),
    track('/new-opus', { year: 2024, format: 'opus' })
  ]
  assert.deepEqual([...tracks].sort((a, b) => compareTracksBySortRules(a, b, [{ key: 'year', direction: 'desc' }])).map((item) => item.path), [
    '/new-opus', '/old-flac', '/missing'
  ])
  assert.deepEqual([...tracks].sort((a, b) => compareTracksBySortRules(a, b, [{ key: 'codec', direction: 'desc' }])).map((item) => item.path), [
    '/new-opus', '/old-flac', '/missing'
  ])
})

test('codec and rating sorting use deterministic path fallback', () => {
  const left = track('/a', { format: 'flac' })
  const right = track('/b', { format: 'opus' })
  assert.ok(compareTracksBySortRules(left, right, [{ key: 'codec', direction: 'asc' }]) < 0)
  assert.ok(compareTracksBySortRules(left, right, [{ key: 'rating', direction: 'desc' }], () => 4) < 0)
})
