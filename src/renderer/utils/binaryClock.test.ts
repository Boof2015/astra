import assert from 'node:assert/strict'
import test from 'node:test'
import {
  encodeBinaryClock,
  formatBinaryClockTime,
  getBinaryClockDigits
} from './binaryClock.ts'

test('encodes midnight as a complete inactive BCD grid', () => {
  const midnight = new Date(2026, 0, 1, 0, 0, 0)

  assert.deepEqual(getBinaryClockDigits(midnight), [0, 0, 0, 0, 0, 0])
  assert.deepEqual(encodeBinaryClock(midnight), [
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0]
  ])
  assert.equal(formatBinaryClockTime(midnight), '00:00:00')
})

test('preserves leading zero columns when encoding BCD time', () => {
  const time = new Date(2026, 0, 1, 1, 2, 3)

  assert.deepEqual(getBinaryClockDigits(time), [0, 1, 0, 2, 0, 3])
  assert.deepEqual(encodeBinaryClock(time), [
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 1, 0, 1],
    [0, 1, 0, 0, 0, 1]
  ])
  assert.equal(formatBinaryClockTime(time), '01:02:03')
})

test('encodes the maximum 24-hour clock value in HHMMSS column order', () => {
  const time = new Date(2026, 0, 1, 23, 59, 59)

  assert.deepEqual(getBinaryClockDigits(time), [2, 3, 5, 9, 5, 9])
  assert.deepEqual(encodeBinaryClock(time), [
    [0, 0, 0, 1, 0, 1],
    [0, 0, 1, 0, 1, 0],
    [1, 1, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 1]
  ])
  assert.equal(formatBinaryClockTime(time), '23:59:59')
})
