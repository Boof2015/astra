import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addTrackDragRangeToSelection,
  hasTrackDragActivated,
  isTrackDragSpringRequestCurrent,
  resolveTrackDragScrollDelta,
  resolveTrackDragDropSurface,
  resolveTrackDragSelectionIndexes,
  resolveTrackInsertionIndex,
  TRACK_PLAYLIST_SPRING_OPEN_MS,
  TRACK_NAV_SPRING_OPEN_MS,
  TRACK_QUEUE_SPRING_OPEN_MS
} from './trackDragModel.ts'

test('track dragging starts only beyond the six pixel threshold', () => {
  assert.equal(hasTrackDragActivated(10, 10, 16, 10), false)
  assert.equal(hasTrackDragActivated(10, 10, 16.01, 10), true)
  assert.equal(hasTrackDragActivated(10, 10, 14, 15), true)
})

test('track insertion uses the row midpoint as the before/after boundary', () => {
  assert.equal(resolveTrackInsertionIndex(12, 119.99, 100, 40), 12)
  assert.equal(resolveTrackInsertionIndex(12, 120, 100, 40), 13)
})

test('drop target arbitration prefers precise list surfaces over sidebar targets', () => {
  assert.equal(resolveTrackDragDropSurface(true, true, true), 'playlist')
  assert.equal(resolveTrackDragDropSurface(false, true, true), 'queue')
  assert.equal(resolveTrackDragDropSurface(false, false, true), 'sidebar')
  assert.equal(resolveTrackDragDropSurface(false, false, false), null)
})

test('drag selection uses stable occurrence keys and preserves visible order', () => {
  const visibleKeys = ['playlist-entry:4', 'playlist-entry:8', 'playlist-entry:12']
  assert.deepEqual(
    resolveTrackDragSelectionIndexes(visibleKeys, new Set(['playlist-entry:12', 'playlist-entry:4']), 2),
    [0, 2]
  )
  assert.deepEqual(
    resolveTrackDragSelectionIndexes(visibleKeys, new Set(['playlist-entry:4']), 1),
    [1]
  )
})

test('modifier range dragging grows selection by stable occurrence key', () => {
  const visibleKeys = ['playlist-entry:4', 'playlist-entry:8', 'playlist-entry:12', 'playlist-entry:16']
  assert.deepEqual(
    [...addTrackDragRangeToSelection(visibleKeys, new Set(['playlist-entry:16']), 2, 0)],
    ['playlist-entry:16', 'playlist-entry:4', 'playlist-entry:8', 'playlist-entry:12']
  )
  assert.deepEqual(
    [...addTrackDragRangeToSelection(visibleKeys, new Set(), 1, 2)],
    ['playlist-entry:8', 'playlist-entry:12']
  )
})

test('edge scrolling accelerates toward an available viewport edge', () => {
  assert.equal(resolveTrackDragScrollDelta(100, 100, 500, true, true), -10)
  assert.equal(resolveTrackDragScrollDelta(120, 100, 500, true, true), -5)
  assert.equal(resolveTrackDragScrollDelta(300, 100, 500, true, true), 0)
  assert.equal(resolveTrackDragScrollDelta(499, 100, 500, true, true), 10)
  assert.equal(resolveTrackDragScrollDelta(100, 100, 500, false, true), 0)
})

test('spring loading uses the interaction delays and rejects stale async opens', () => {
  assert.equal(TRACK_PLAYLIST_SPRING_OPEN_MS, 650)
  assert.equal(TRACK_QUEUE_SPRING_OPEN_MS, 350)
  assert.equal(TRACK_NAV_SPRING_OPEN_MS, 450)
  assert.equal(isTrackDragSpringRequestCurrent(4, 4, true), true)
  assert.equal(isTrackDragSpringRequestCurrent(4, 5, true), false)
  assert.equal(isTrackDragSpringRequestCurrent(4, 4, false), false)
})
