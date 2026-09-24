import assert from 'node:assert/strict'
import test from 'node:test'
import { filterHomeRecentTracks, type HomeRecentTrack } from './homeRecentTracks.ts'

const tracks: HomeRecentTrack[] = [
  { path: '/one', title: 'Nyärt Beat', artist: 'Issey', album: 'Late Night', artwork_hash: null },
  { path: '/two', title: 'シミュラクル', artist: '獅白ぼたん', album: 'Mirage', artwork_hash: null },
  { path: '/three', title: 'Old Favorite', artist: 'Issey', album: 'Nyärt Sessions', artwork_hash: null }
]

test('recent search matches title, artist, album and combined terms without reordering results', () => {
  assert.deepEqual(filterHomeRecentTracks(tracks, ' NYART '), [tracks[0], tracks[2]])
  assert.deepEqual(filterHomeRecentTracks(tracks, 'late issey'), [tracks[0]])
  assert.deepEqual(filterHomeRecentTracks(tracks, 'mirage'), [tracks[1]])
  assert.deepEqual(filterHomeRecentTracks(tracks, '獅白'), [tracks[1]])
  assert.deepEqual(filterHomeRecentTracks(tracks, 'nothing matches'), [])
  assert.equal(filterHomeRecentTracks(tracks, '\t  '), tracks)
})

test('the full recent list remains searchable past the Home preview and retains playback identities', () => {
  const history = Array.from({ length: 120 }, (_, index) => ({ ...tracks[0], path: `/track/${index}`, title: index === 119 ? 'Oldest available' : `Track ${index}` }))
  const result = filterHomeRecentTracks(history, 'oldest')
  assert.equal(result.length, 1)
  assert.equal(result[0], history[119])
  assert.equal(history.findIndex((entry) => entry.path === result[0].path), 119)
  assert.equal(filterHomeRecentTracks(history, '').length, 120)
  assert.deepEqual(filterHomeRecentTracks([], 'oldest'), [])
})
