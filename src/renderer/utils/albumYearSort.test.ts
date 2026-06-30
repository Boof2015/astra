import test from 'node:test'
import assert from 'node:assert/strict'
import { compareAlbumsByYearDescending, type AlbumYearSortRecord } from './albumYearSort.ts'

function album(overrides: Partial<AlbumYearSortRecord> & Pick<AlbumYearSortRecord, 'identity_key' | 'album'>): AlbumYearSortRecord {
  return {
    artist: overrides.artist ?? 'Artist',
    year: overrides.year ?? null,
    ...overrides
  }
}

test('compareAlbumsByYearDescending sorts newest first with missing years last', () => {
  const albums = [
    album({ identity_key: 'undated:a', album: 'Undated A', year: null }),
    album({ identity_key: 'old', album: 'Old', year: 2019 }),
    album({ identity_key: 'new', album: 'New', year: 2024 }),
    album({ identity_key: 'undated:b', album: 'Undated B' }),
    album({ identity_key: 'middle', album: 'Middle', year: 2021 })
  ]

  albums.sort(compareAlbumsByYearDescending)

  assert.deepEqual(albums.map((entry) => entry.identity_key), [
    'new',
    'middle',
    'old',
    'undated:a',
    'undated:b'
  ])
})

test('compareAlbumsByYearDescending uses stable text and identity tie-breaks', () => {
  const albums = [
    album({ identity_key: 'same:b', album: 'Alpha', artist: 'Zeta', year: 2024 }),
    album({ identity_key: 'same:a', album: 'Alpha', artist: 'Zeta', year: 2024 }),
    album({ identity_key: 'artist', album: 'Alpha', artist: 'Beta', year: 2024 }),
    album({ identity_key: 'album', album: 'Aardvark', artist: 'Zeta', year: 2024 })
  ]

  albums.sort(compareAlbumsByYearDescending)

  assert.deepEqual(albums.map((entry) => entry.identity_key), [
    'album',
    'artist',
    'same:a',
    'same:b'
  ])
})
