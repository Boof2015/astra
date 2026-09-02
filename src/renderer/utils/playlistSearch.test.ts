import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildVisiblePlaylistSearchRows,
  matchesPlaylistTrackQuery
} from './playlistSearch.ts'

const track = {
  title: 'Jóga',
  artist: 'Björk',
  album: 'Homogenic'
}

test('playlist track search uses conservative title, artist, and album matching', () => {
  assert.equal(matchesPlaylistTrackQuery(track, 'joga'), true)
  assert.equal(matchesPlaylistTrackQuery(track, 'bjork'), true)
  assert.equal(matchesPlaylistTrackQuery(track, 'hmg'), false)
  assert.equal(matchesPlaylistTrackQuery(track, 'moge'), true)
  assert.equal(matchesPlaylistTrackQuery(track, 'unrelated'), false)
})

test('playlist track search treats whitespace as an inactive query', () => {
  assert.equal(matchesPlaylistTrackQuery(track, '   '), true)
})

test('filtered playlist rows retain full-context occurrence indexes', () => {
  const rows = [
    { id: 'first-match', playable: true, track: { title: 'Signal', artist: 'One', album: 'A' } },
    { id: 'hidden-playable', playable: true, track: { title: 'Interlude', artist: 'Two', album: 'B' } },
    { id: 'missing-match', playable: false, track: { title: 'Signal Lost', artist: 'Three', album: 'C' } },
    { id: 'duplicate-match', playable: true, track: { title: 'Signal', artist: 'One', album: 'A' } }
  ]

  const visibleRows = buildVisiblePlaylistSearchRows(rows, 'signal', (row) => row.playable)

  assert.deepEqual(
    visibleRows.map(({ row, queueSeedIndex }) => ({ id: row.id, queueSeedIndex })),
    [
      { id: 'first-match', queueSeedIndex: 0 },
      { id: 'missing-match', queueSeedIndex: null },
      { id: 'duplicate-match', queueSeedIndex: 2 }
    ]
  )
})
