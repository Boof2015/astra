import assert from 'node:assert/strict'
import test from 'node:test'
import { getFixedRowRange, getFixedRowScrollOffset, getFixedRowTotalHeight } from './fixedRowVirtualization.ts'

test('getFixedRowRange calculates deep ranges without depending on preceding rows', () => {
  assert.deepEqual(getFixedRowRange({
    rowCount: 21_520,
    rowHeight: 40,
    viewportHeight: 400,
    scrollTop: 800_000,
    overscanCount: 4
  }), {
    visibleStartIndex: 20_000,
    visibleStopIndex: 20_009,
    overscanStartIndex: 19_996,
    overscanStopIndex: 20_013
  })

  assert.deepEqual(getFixedRowRange({
    rowCount: 21_520,
    rowHeight: 40,
    viewportHeight: 400,
    scrollTop: 800_001,
    overscanCount: 4
  }), {
    visibleStartIndex: 20_000,
    visibleStopIndex: 20_010,
    overscanStartIndex: 19_996,
    overscanStopIndex: 20_014
  })
})

test('getFixedRowRange clips top, bottom, overscroll, and overscan', () => {
  assert.deepEqual(getFixedRowRange({
    rowCount: 21_520,
    rowHeight: 40,
    viewportHeight: 400,
    scrollTop: -200,
    overscanCount: 4
  }), {
    visibleStartIndex: 0,
    visibleStopIndex: 9,
    overscanStartIndex: 0,
    overscanStopIndex: 13
  })

  const bottomRange = {
    visibleStartIndex: 21_510,
    visibleStopIndex: 21_519,
    overscanStartIndex: 21_506,
    overscanStopIndex: 21_519
  }
  assert.deepEqual(getFixedRowRange({
    rowCount: 21_520,
    rowHeight: 40,
    viewportHeight: 400,
    scrollTop: 860_400,
    overscanCount: 4
  }), bottomRange)
  assert.deepEqual(getFixedRowRange({
    rowCount: 21_520,
    rowHeight: 40,
    viewportHeight: 400,
    scrollTop: Number.MAX_SAFE_INTEGER,
    overscanCount: 4
  }), bottomRange)
})

test('getFixedRowRange handles empty or invalid geometry and list shrink', () => {
  const emptyRange = {
    visibleStartIndex: 0,
    visibleStopIndex: -1,
    overscanStartIndex: 0,
    overscanStopIndex: -1
  }
  assert.deepEqual(getFixedRowRange({
    rowCount: 0,
    rowHeight: 40,
    viewportHeight: 400,
    scrollTop: 0,
    overscanCount: 4
  }), emptyRange)
  assert.deepEqual(getFixedRowRange({
    rowCount: 100,
    rowHeight: Number.NaN,
    viewportHeight: 400,
    scrollTop: 0,
    overscanCount: 4
  }), emptyRange)
  assert.deepEqual(getFixedRowRange({
    rowCount: 100,
    rowHeight: 40,
    viewportHeight: 0,
    scrollTop: 0,
    overscanCount: 4
  }), emptyRange)

  assert.deepEqual(getFixedRowRange({
    rowCount: 5,
    rowHeight: 40,
    viewportHeight: 80,
    scrollTop: 800_000,
    overscanCount: 1
  }), {
    visibleStartIndex: 3,
    visibleStopIndex: 4,
    overscanStartIndex: 2,
    overscanStopIndex: 4
  })
})

test('getFixedRowScrollOffset preserves react-window alignment behavior', () => {
  const common = {
    rowCount: 100,
    rowHeight: 40,
    viewportHeight: 400,
    index: 20
  }

  assert.equal(getFixedRowScrollOffset({ ...common, align: 'start', currentScrollTop: 0 }), 800)
  assert.equal(getFixedRowScrollOffset({ ...common, align: 'end', currentScrollTop: 0 }), 440)
  assert.equal(getFixedRowScrollOffset({ ...common, align: 'center', currentScrollTop: 0 }), 620)
  assert.equal(getFixedRowScrollOffset({ ...common, align: 'auto', currentScrollTop: 600 }), 600)
  assert.equal(getFixedRowScrollOffset({ ...common, align: 'auto', currentScrollTop: 0 }), 440)
  assert.equal(getFixedRowScrollOffset({ ...common, align: 'auto', currentScrollTop: 1_000 }), 800)
  assert.equal(getFixedRowScrollOffset({ ...common, align: 'smart', currentScrollTop: 600 }), 600)
  assert.equal(getFixedRowScrollOffset({ ...common, align: 'smart', currentScrollTop: 0 }), 620)
})

test('getFixedRowScrollOffset clamps edges and rejects invalid indexes', () => {
  const common = {
    rowCount: 100,
    rowHeight: 40,
    viewportHeight: 400,
    currentScrollTop: 0
  }

  assert.equal(getFixedRowScrollOffset({ ...common, align: 'center', index: 0 }), 0)
  assert.equal(getFixedRowScrollOffset({ ...common, align: 'center', index: 99 }), 3_600)
  assert.equal(getFixedRowScrollOffset({ ...common, align: 'start', index: 99 }), 3_600)
  assert.throws(
    () => getFixedRowScrollOffset({ ...common, align: 'auto', index: 100 }),
    RangeError
  )
  assert.equal(getFixedRowTotalHeight(21_520, 40), 860_800)
})
