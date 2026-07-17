import assert from 'node:assert/strict'
import test from 'node:test'
import { compareTrackPlayCounts } from './trackPlayCountSort.ts'

test('play count sorting starts highest-first and toggles numerically', () => {
  const values = [2, 11, 0]
  assert.deepEqual([...values].sort((left, right) => compareTrackPlayCounts(left, right, 'desc')), [11, 2, 0])
  assert.deepEqual([...values].sort((left, right) => compareTrackPlayCounts(left, right, 'asc')), [0, 2, 11])
})

test('missing playlist entries stay after real play counts in either direction', () => {
  assert.equal(compareTrackPlayCounts(0, 0, 'desc', true, false) > 0, true)
  assert.equal(compareTrackPlayCounts(0, 0, 'asc', false, true) < 0, true)
})
