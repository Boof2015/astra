import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatCompactDuration,
  formatExactDuration,
  formatCompactTotalTrackDuration,
  sumValidTrackDurations
} from './collectionDuration.ts'

test('sumValidTrackDurations ignores zero, negative, invalid, and missing durations', () => {
  assert.equal(
    sumValidTrackDurations([
      { duration: 20 },
      { duration: 0 },
      { duration: -4 },
      { duration: Number.NaN },
      { duration: Number.POSITIVE_INFINITY },
      { duration: null },
      { duration: undefined },
      { duration: 25 }
    ]),
    45
  )
})

test('formatCompactDuration formats seconds-only totals', () => {
  assert.equal(formatCompactDuration(45), '45 sec')
  assert.equal(formatCompactDuration(0.4), '1 sec')
})

test('formatCompactDuration formats minute totals', () => {
  assert.equal(formatCompactDuration(60), '1 min')
  assert.equal(formatCompactDuration(2598), '43 min')
})

test('formatCompactDuration formats hour-plus totals', () => {
  assert.equal(formatCompactDuration(4080), '1 hr 8 min')
  assert.equal(formatCompactDuration(7200), '2 hr')
})

test('formatCompactDuration returns null for unavailable totals', () => {
  assert.equal(formatCompactDuration(0), null)
  assert.equal(formatCompactDuration(-1), null)
  assert.equal(formatCompactDuration(Number.NaN), null)
})

test('formatExactDuration formats exact clock-style totals', () => {
  assert.equal(formatExactDuration(0), '0:00:00')
  assert.equal(formatExactDuration(65), '0:01:05')
  assert.equal(formatExactDuration(3661), '1:01:01')
  assert.equal(formatExactDuration(90061), '25:01:01')
})

test('formatCompactTotalTrackDuration returns null when all durations are unavailable', () => {
  assert.equal(formatCompactTotalTrackDuration([{ duration: 0 }, { duration: null }]), null)
})
