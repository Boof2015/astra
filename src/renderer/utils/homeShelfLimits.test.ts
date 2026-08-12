import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveHomeShelfLimits } from './homeShelfLimits.ts'

test('Home shelves retain their reference-size minimums', () => {
  assert.deepEqual(resolveHomeShelfLimits(1200), {
    jumpBackIn: 6,
    rediscover: 8,
    newlyAdded: 8,
    recentTracks: 10
  })
})

test('Home shelves fill wider panes without becoming unbounded', () => {
  const wide = resolveHomeShelfLimits(3000)
  assert.equal(wide.jumpBackIn, 12)
  assert.equal(wide.rediscover, 16)
  assert.equal(wide.newlyAdded, 16)
  assert.equal(wide.recentTracks, 18)
  assert.deepEqual(resolveHomeShelfLimits(10000), {
    jumpBackIn: 14,
    rediscover: 20,
    newlyAdded: 20,
    recentTracks: 20
  })
})
