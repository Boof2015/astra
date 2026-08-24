import assert from 'node:assert/strict'
import test from 'node:test'
import { isAllowedArtworkProtocolHash } from './artworkProtocol.ts'
import { buildSubsonicArtworkHash } from './subsonic.ts'

test('accepts supported local artwork hashes', () => {
  assert.equal(isAllowedArtworkProtocolHash('0123456789abcdef.jpg'), true)
  assert.equal(isAllowedArtworkProtocolHash('0123456789abcdef'), true)
  assert.equal(isAllowedArtworkProtocolHash('plc:playlist-cover.png'), true)
  assert.equal(isAllowedArtworkProtocolHash('ari:artist image.webp'), true)
})

test('accepts valid Subsonic artwork references', () => {
  const hash = buildSubsonicArtworkHash(42, 'album/cover id')

  assert.equal(hash, 'subsonic-artwork:42:album%2Fcover%20id')
  assert.equal(isAllowedArtworkProtocolHash(hash), true)
})

test('rejects malformed and unsafe artwork references', () => {
  const rejected = [
    '',
    'unknown:cover.jpg',
    'subsonic-artwork:0:cover',
    'subsonic-artwork:1:',
    'subsonic-artwork:1:%not-encoded',
    '../cover.jpg',
    'plc:..',
    'ari:../cover.jpg',
    'folder/cover.jpg',
    '/absolute-cover.jpg'
  ]

  for (const hash of rejected) {
    assert.equal(isAllowedArtworkProtocolHash(hash), false, hash)
  }
})
