import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeTrackRating } from './trackRating.ts'

test('normalizeTrackRating rounds to half-star steps within range', () => {
  assert.equal(normalizeTrackRating(3.24), 3)
  assert.equal(normalizeTrackRating(3.25), 3.5)
  assert.equal(normalizeTrackRating(0.5), 0.5)
  assert.equal(normalizeTrackRating(5), 5)
  assert.equal(normalizeTrackRating('4.5'), 4.5)
})

test('normalizeTrackRating clamps above the maximum and rejects unratable values', () => {
  assert.equal(normalizeTrackRating(7), 5)
  assert.equal(normalizeTrackRating(0), null)
  assert.equal(normalizeTrackRating(-1), null)
  assert.equal(normalizeTrackRating(Number.NaN), null)
  assert.equal(normalizeTrackRating('abc'), null)
  assert.equal(normalizeTrackRating(undefined), null)
  assert.equal(normalizeTrackRating(null), null)
})
