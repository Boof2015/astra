import assert from 'node:assert/strict'
import test from 'node:test'
import { matchesTrackIdentityQuery } from './trackSearch.ts'

const track = {
  title: 'Jóga',
  artist: 'Björk feat. String Octet',
  artist_names: ['Björk', 'Icelandic String Octet'],
  album: 'Homogenic',
  album_artist: 'Björk',
  album_artist_names: ['Björk']
}

test('track identity search uses the same complete identity across surfaces', () => {
  assert.equal(matchesTrackIdentityQuery(track, 'joga'), true)
  assert.equal(matchesTrackIdentityQuery(track, 'icelandic'), true)
  assert.equal(matchesTrackIdentityQuery(track, 'homogenic'), true)
  assert.equal(matchesTrackIdentityQuery(track, 'bjork joga'), true)
  assert.equal(matchesTrackIdentityQuery(track, 'hmg'), false)
  assert.equal(matchesTrackIdentityQuery(track, 'unrelated'), false)
})
