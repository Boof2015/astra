import assert from 'node:assert/strict'
import test from 'node:test'
import {
  albumMatchesLibraryYear,
  buildLibraryYearGroups,
  formatLibraryYearKey
} from './libraryYears.ts'

test('buildLibraryYearGroups sorts newest-first and keeps Unknown Year last', () => {
  const groups = buildLibraryYearGroups([
    { identity_key: 'album:c', year: null, artwork_hash: 'unknown-art', track_count: 2 },
    { identity_key: 'album:b', year: 2021, artwork_hash: 'older-art', track_count: 8 },
    { identity_key: 'album:d', year: 2025, artwork_hash: null, track_count: 4 },
    { identity_key: 'album:a', year: 2025, artwork_hash: 'newer-art', track_count: 6 }
  ])

  assert.deepEqual(groups, [
    {
      key: 2025,
      label: '2025',
      album_count: 2,
      track_count: 10,
      artwork_hash: 'newer-art'
    },
    {
      key: 2021,
      label: '2021',
      album_count: 1,
      track_count: 8,
      artwork_hash: 'older-art'
    },
    {
      key: 'unknown',
      label: 'Unknown Year',
      album_count: 1,
      track_count: 2,
      artwork_hash: 'unknown-art'
    }
  ])
})

test('year helpers distinguish an unknown year from no selection', () => {
  assert.equal(formatLibraryYearKey('unknown'), 'Unknown Year')
  assert.equal(albumMatchesLibraryYear({ year: null }, 'unknown'), true)
  assert.equal(albumMatchesLibraryYear({ year: 2025 }, 2025), true)
  assert.equal(albumMatchesLibraryYear({ year: 2024 }, 2025), false)
})
