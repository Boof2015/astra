import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRatingTagPatch, extractRatingTag, popmToStars, type RatingTagMetadata } from './ratingTags.ts'

const metadata = (native: RatingTagMetadata['native']): RatingTagMetadata => ({ common: {}, native })

test('rating tags normalize documented scales and do not confuse advisory ratings with stars', () => {
  for (const [raw, stars] of [[0, null], [1, 1], [64, 2], [128, 3], [196, 4], [255, 5]]) assert.equal(popmToStars(raw), stars)
  assert.equal(extractRatingTag(metadata({ vorbis: [{ id: 'RATING', value: '90' }] })), 4.5)
  assert.equal(extractRatingTag(metadata({ vorbis: [{ id: 'RATING:user', value: '0.7' }] })), 3.5)
  assert.equal(extractRatingTag(metadata({ iTunes: [{ id: 'rate', value: '80' }] })), 4)
  assert.equal(extractRatingTag(metadata({ iTunes: [{ id: 'rtng', value: 1 }] })), null)
  assert.equal(extractRatingTag(metadata({})), null)
  for (const value of ['', 'bad', '0.7garbage', -1, 101, Infinity, NaN]) {
    assert.equal(extractRatingTag(metadata({ vorbis: [{ id: 'RATING', value }] })), undefined)
  }
})

test('FMPS preserves half stars and explicit zero prevents fallback to another owner', () => {
  const native = metadata({ 'ID3v2.4': [{ id: 'POPM', value: { rating: 255, email: 'other' } }, { id: 'TXXX:FMPS_RATING', value: '0.1' }] })
  assert.equal(extractRatingTag(native), 0.5)
  native.native['ID3v2.4'][1].value = '0'
  assert.equal(extractRatingTag(native), null)
  assert.equal(extractRatingTag(metadata({ 'ID3v2.3': [{ id: 'POPM', value: { rating: 64 } }, { id: 'POPM', value: { rating: 255 } }] })), 2)
})

test('native rating patches retain POPM ownership and counters without touching other tags', () => {
  const source = metadata({ 'ID3v2.4': [
    { id: 'POPM', value: { email: 'first', rating: 1, counter: 42 } },
    { id: 'POPM', value: { email: 'second', rating: 64, counter: 123 } }
  ] })
  assert.deepEqual(buildRatingTagPatch(source, '.mp3', 4.5), {
    POPM: [{ email: 'first', rating: 255, counter: 42 }, { email: 'second', rating: 64, counter: 123 }],
    'TXXX:FMPS_RATING': '0.9'
  })
  assert.equal(buildRatingTagPatch(source, '.flac', null).FMPS_RATING, '0')
})
