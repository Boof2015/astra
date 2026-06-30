import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSubsonicArtworkHash,
  parseSubsonicArtworkHash
} from './subsonic.ts'

test('subsonic artwork hashes round-trip source and cover art ids', () => {
  const hash = buildSubsonicArtworkHash(42, 'album/cover id')

  assert.equal(hash, 'subsonic-artwork:42:album%2Fcover%20id')
  assert.deepEqual(parseSubsonicArtworkHash(hash), {
    sourceId: 42,
    artworkId: 'album/cover id'
  })
  assert.equal(parseSubsonicArtworkHash('cached-cover.jpg'), null)
  assert.equal(parseSubsonicArtworkHash('subsonic-artwork:0:cover'), null)
})
