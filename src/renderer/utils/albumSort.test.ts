import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareAlbumsBySortState,
  getDefaultAlbumSortDirection,
  normalizeAlbumSortState,
  type AlbumSortRecord
} from './albumSort.ts'

const albums: AlbumSortRecord[] = [
  { identity_key: 'b-2020', album: 'Beta', artist: 'Artist A', year: 2020 },
  { identity_key: 'a-2024', album: 'Alpha', artist: 'Artist B', year: 2024 },
  { identity_key: 'a-unknown', album: 'Alpha', artist: 'Artist A', year: null }
]

test('album sort state migrates legacy modes and normalizes malformed values', () => {
  assert.deepEqual(normalizeAlbumSortState('artist'), { key: 'artist', direction: 'asc' })
  assert.deepEqual(normalizeAlbumSortState('title'), { key: 'title', direction: 'asc' })
  assert.deepEqual(normalizeAlbumSortState({ key: 'year', direction: 'desc' }), { key: 'year', direction: 'desc' })
  assert.deepEqual(normalizeAlbumSortState({ key: 'bad', direction: 'desc' }), { key: 'title', direction: 'desc' })
  assert.equal(getDefaultAlbumSortDirection('title'), 'asc')
  assert.equal(getDefaultAlbumSortDirection('artist'), 'asc')
  assert.equal(getDefaultAlbumSortDirection('year'), 'desc')
})

test('album title and artist directions keep ascending fixed tie-breakers', () => {
  const byTitleAsc = [...albums].sort((left, right) => compareAlbumsBySortState(left, right, { key: 'title', direction: 'asc' }))
  assert.deepEqual(byTitleAsc.map((album) => album.identity_key), ['a-unknown', 'a-2024', 'b-2020'])

  const byTitleDesc = [...albums].sort((left, right) => compareAlbumsBySortState(left, right, { key: 'title', direction: 'desc' }))
  assert.deepEqual(byTitleDesc.map((album) => album.identity_key), ['b-2020', 'a-unknown', 'a-2024'])

  const byArtistAsc = [...albums].sort((left, right) => compareAlbumsBySortState(left, right, { key: 'artist', direction: 'asc' }))
  assert.deepEqual(byArtistAsc.map((album) => album.identity_key), ['a-unknown', 'b-2020', 'a-2024'])

  const byArtistDesc = [...albums].sort((left, right) => compareAlbumsBySortState(left, right, { key: 'artist', direction: 'desc' }))
  assert.deepEqual(byArtistDesc.map((album) => album.identity_key), ['a-2024', 'a-unknown', 'b-2020'])
})

test('album sorting falls back to identity only after fixed tie-breakers', () => {
  const ties: AlbumSortRecord[] = [
    { identity_key: 'z', album: 'Same', artist: 'Same', year: 2024 },
    { identity_key: 'a', album: 'Same', artist: 'Same', year: 2024 }
  ]
  for (const key of ['title', 'artist', 'year'] as const) {
    const sorted = [...ties].sort((left, right) => compareAlbumsBySortState(left, right, { key, direction: 'desc' }))
    assert.deepEqual(sorted.map((album) => album.identity_key), ['a', 'z'])
  }
})

test('album year sorting supports both directions and keeps missing years last', () => {
  const newest = [...albums].sort((left, right) => compareAlbumsBySortState(left, right, { key: 'year', direction: 'desc' }))
  assert.deepEqual(newest.map((album) => album.identity_key), ['a-2024', 'b-2020', 'a-unknown'])

  const oldest = [...albums].sort((left, right) => compareAlbumsBySortState(left, right, { key: 'year', direction: 'asc' }))
  assert.deepEqual(oldest.map((album) => album.identity_key), ['b-2020', 'a-2024', 'a-unknown'])
})
