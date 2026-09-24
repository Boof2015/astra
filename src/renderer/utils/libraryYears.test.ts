import assert from 'node:assert/strict'
import test from 'node:test'
import {
  albumMatchesLibraryYear,
  buildLibraryYearGroups,
  filterTracksByLibraryYearAlbums,
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
      artwork_hash: 'newer-art',
      artwork_hashes: ['newer-art']
    },
    {
      key: 2021,
      label: '2021',
      album_count: 1,
      track_count: 8,
      artwork_hash: 'older-art',
      artwork_hashes: ['older-art']
    },
    {
      key: 'unknown',
      label: 'Unknown Year',
      album_count: 1,
      track_count: 2,
      artwork_hash: 'unknown-art',
      artwork_hashes: ['unknown-art']
    }
  ])
})

test('year helpers distinguish an unknown year from no selection', () => {
  assert.equal(formatLibraryYearKey('unknown'), 'Unknown Year')
  assert.equal(albumMatchesLibraryYear({ year: null }, 'unknown'), true)
  assert.equal(albumMatchesLibraryYear({ year: 2025 }, 2025), true)
  assert.equal(albumMatchesLibraryYear({ year: 2024 }, 2025), false)
})

test('year playback membership follows the supplied unsearched album collection', () => {
  const tracks = [
    { path: '/albums/visible.flac', album_identity_key: 'album:visible' },
    { path: '/singles/optional.flac', album_identity_key: 'album:single' },
    { path: '/albums/other-year.flac', album_identity_key: 'album:other-year' },
    { path: '/albums/unknown-year.flac', album_identity_key: 'album:unknown-year' }
  ]
  const albumsWithoutSingles = [
    { identity_key: 'album:visible', year: 2025 },
    { identity_key: 'album:other-year', year: 2024 },
    { identity_key: 'album:unknown-year', year: null }
  ]
  const albumsWithSingles = [
    ...albumsWithoutSingles,
    { identity_key: 'album:single', year: 2025 }
  ]

  assert.deepEqual(
    filterTracksByLibraryYearAlbums(tracks, albumsWithoutSingles, 2025).map((track) => track.path),
    ['/albums/visible.flac']
  )
  assert.deepEqual(
    filterTracksByLibraryYearAlbums(tracks, albumsWithSingles, 2025).map((track) => track.path),
    ['/albums/visible.flac', '/singles/optional.flac']
  )
  assert.deepEqual(
    filterTracksByLibraryYearAlbums(tracks, albumsWithSingles, 'unknown').map((track) => track.path),
    ['/albums/unknown-year.flac']
  )
})


test('year collages choose up to four distinct covers in stable album identity order', () => {
  const albums = [null, 'one', 'one', 'two', 'three', 'four', 'five'].map((artwork_hash, index) => ({
    identity_key: `album:${index}`, year: 2025, artwork_hash, track_count: 2
  }))
  const [year] = buildLibraryYearGroups(albums)
  assert.deepEqual(year.artwork_hashes, ['one', 'two', 'three', 'four'])
  assert.equal(year.artwork_hash, 'one')
  assert.equal(year.album_count, 7)
  assert.deepEqual(buildLibraryYearGroups([...albums].reverse()), [year])
  assert.deepEqual(buildLibraryYearGroups([albums[0]])[0].artwork_hashes, [])
})
