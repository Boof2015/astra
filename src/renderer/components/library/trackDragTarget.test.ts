import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldSuppressTrackRowDrag } from './trackDragTarget.ts'

function targetWithClosestResult(result: object | null): { closest: (selector: string) => object | null } {
  return {
    closest: () => result
  }
}

test('allows dragging from a track-row descendant when the row is the closest interactive target', () => {
  const trackRow = {}

  assert.equal(shouldSuppressTrackRowDrag(targetWithClosestResult(trackRow), trackRow), false)
})

test('suppresses dragging when a nested control is the closest interactive target', () => {
  const trackRow = {}
  const nestedControl = {}

  assert.equal(shouldSuppressTrackRowDrag(targetWithClosestResult(nestedControl), trackRow), true)
})

test('allows dragging when the pointer target has no interactive ancestor', () => {
  const trackRow = {}

  assert.equal(shouldSuppressTrackRowDrag(targetWithClosestResult(null), trackRow), false)
})
