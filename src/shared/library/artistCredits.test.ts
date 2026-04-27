import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildArtistNameTokens,
  deserializeArtistNames,
  formatArtistNames,
  normalizeArtistNames,
  serializeArtistNames
} from './artistCredits.ts'

test('normalizes and deduplicates parsed artist names', () => {
  assert.deepEqual(
    normalizeArtistNames([' Paul McCartney ', 'Michael   Jackson', 'paul mccartney', '', null]),
    ['Paul McCartney', 'Michael Jackson']
  )
})

test('formats parsed artist names with stable display separators', () => {
  assert.equal(formatArtistNames(['Paul McCartney', 'Michael Jackson']), 'Paul McCartney & Michael Jackson')
  assert.equal(formatArtistNames(['A', 'B', 'C']), 'A, B & C')
})

test('serializes and deserializes stored artist credits', () => {
  const stored = serializeArtistNames(['A', 'B'])
  assert.equal(stored, '["A","B"]')
  assert.deepEqual(deserializeArtistNames(stored), ['A', 'B'])
  assert.deepEqual(deserializeArtistNames('not json'), [])
})

test('builds link tokens without splitting artist names that contain separators', () => {
  assert.deepEqual(
    buildArtistNameTokens(['Earth, Wind & Fire', 'The Emotions']),
    [
      { artist: 'Earth, Wind & Fire', separator: ' & ' },
      { artist: 'The Emotions', separator: null }
    ]
  )
})
