import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findSpatialCandidate,
  resolveControllerGroupIndex,
  resolveControllerRegionTransition,
  resolveSectionTabIndex,
  type SpatialRect
} from './controllerFocus.ts'

const rect = (left: number, top: number, width = 20, height = 20): SpatialRect => ({
  left,
  top,
  right: left + width,
  bottom: top + height
})

test('chooses the nearest aligned target in the requested direction', () => {
  const candidates = [
    { item: 'right-near', rect: rect(40, 0) },
    { item: 'right-diagonal', rect: rect(25, 90) },
    { item: 'right-far', rect: rect(100, 0) },
    { item: 'left', rect: rect(-50, 0) }
  ]
  assert.equal(findSpatialCandidate(rect(0, 0), candidates, 'right'), 'right-near')
  assert.equal(findSpatialCandidate(rect(0, 0), candidates, 'left'), 'left')
})

test('selects vertical targets independently of horizontal distance', () => {
  const candidates = [
    { item: 'down-aligned', rect: rect(0, 60) },
    { item: 'down-diagonal', rect: rect(80, 30) },
    { item: 'up', rect: rect(0, -50) }
  ]
  assert.equal(findSpatialCandidate(rect(0, 0), candidates, 'down'), 'down-aligned')
  assert.equal(findSpatialCandidate(rect(0, 0), candidates, 'up'), 'up')
})

test('returns null when no target exists in the requested direction', () => {
  assert.equal(findSpatialCandidate(rect(0, 0), [
    { item: 'left', rect: rect(-40, 0) }
  ], 'right'), null)
})

test('only crosses regions through explicit directional boundaries', () => {
  const regions = new Set(['sidebar', 'view:library', 'queue', 'transport'])
  assert.equal(resolveControllerRegionTransition('sidebar', 'up', regions), null)
  assert.equal(resolveControllerRegionTransition('sidebar', 'right', regions), 'view:library')
  assert.equal(resolveControllerRegionTransition('view:library', 'up', regions), null)
  assert.equal(resolveControllerRegionTransition('view:library', 'left', regions), 'sidebar')
  assert.equal(resolveControllerRegionTransition('view:library', 'right', regions), 'queue')
  assert.equal(resolveControllerRegionTransition('view:library', 'down', regions), 'transport')
  assert.equal(resolveControllerRegionTransition('queue', 'left', regions), 'view:library')
  assert.equal(resolveControllerRegionTransition('transport', 'up', regions), 'view:library')
})

test('semantic groups only move along their declared axis', () => {
  assert.equal(resolveControllerGroupIndex('vertical', 1, 4, 'up'), 0)
  assert.equal(resolveControllerGroupIndex('vertical', 1, 4, 'down'), 2)
  assert.equal(resolveControllerGroupIndex('vertical', 1, 4, 'left'), null)
  assert.equal(resolveControllerGroupIndex('horizontal', 1, 4, 'left'), 0)
  assert.equal(resolveControllerGroupIndex('horizontal', 1, 4, 'right'), 2)
  assert.equal(resolveControllerGroupIndex('horizontal', 1, 4, 'up'), null)
  assert.equal(resolveControllerGroupIndex('horizontal', 0, 4, 'left'), null)
  assert.equal(resolveControllerGroupIndex('vertical', 3, 4, 'down'), null)
})

test('bumper section switching wraps around and defaults to the first tab', () => {
  // Active tab in the middle moves either way.
  assert.equal(resolveSectionTabIndex(1, 4, 'next'), 2)
  assert.equal(resolveSectionTabIndex(1, 4, 'previous'), 0)
  // Wrap-around at the ends.
  assert.equal(resolveSectionTabIndex(3, 4, 'next'), 0)
  assert.equal(resolveSectionTabIndex(0, 4, 'previous'), 3)
  // No active tab found falls back to index 0 as the base.
  assert.equal(resolveSectionTabIndex(-1, 4, 'next'), 1)
  assert.equal(resolveSectionTabIndex(-1, 4, 'previous'), 3)
  // A single (or empty) strip has nothing to switch to.
  assert.equal(resolveSectionTabIndex(0, 1, 'next'), null)
  assert.equal(resolveSectionTabIndex(-1, 0, 'next'), null)
})
