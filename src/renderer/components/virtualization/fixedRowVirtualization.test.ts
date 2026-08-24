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

test('getFixedRowRange offsets the window by leading content', () => {
  const common = {
    rowCount: 100,
    rowHeight: 40,
    viewportHeight: 400,
    overscanCount: 0,
    leadingHeight: 240
  }

  // Leading block still fully on screen: only the 160px below it holds rows.
  assert.deepEqual(getFixedRowRange({ ...common, scrollTop: 0 }), {
    visibleStartIndex: 0,
    visibleStopIndex: 3,
    overscanStartIndex: 0,
    overscanStopIndex: 3
  })

  // Scrolled exactly past the leading block: a full viewport of rows.
  assert.deepEqual(getFixedRowRange({ ...common, scrollTop: 240 }), {
    visibleStartIndex: 0,
    visibleStopIndex: 9,
    overscanStartIndex: 0,
    overscanStopIndex: 9
  })

  assert.deepEqual(getFixedRowRange({ ...common, scrollTop: 1_000 }), {
    visibleStartIndex: 19,
    visibleStopIndex: 28,
    overscanStartIndex: 19,
    overscanStopIndex: 28
  })
})

test('getFixedRowRange clamps against the page maximum with leading content', () => {
  const common = {
    rowCount: 100,
    rowHeight: 40,
    viewportHeight: 400,
    overscanCount: 0,
    leadingHeight: 240
  }
  const bottomRange = {
    visibleStartIndex: 90,
    visibleStopIndex: 99,
    overscanStartIndex: 90,
    overscanStopIndex: 99
  }

  // 240 leading + 4000 rows - 400 viewport is the page's maximum scrollTop.
  assert.deepEqual(getFixedRowRange({ ...common, scrollTop: 3_840 }), bottomRange)
  assert.deepEqual(getFixedRowRange({ ...common, scrollTop: Number.MAX_SAFE_INTEGER }), bottomRange)
})

test('getFixedRowRange treats overscroll as zero before subtracting leading content', () => {
  const common = {
    rowCount: 100,
    rowHeight: 40,
    viewportHeight: 400,
    overscanCount: 0,
    leadingHeight: 240
  }

  // Rubber-band overscroll must not subtract the leading height twice.
  assert.deepEqual(
    getFixedRowRange({ ...common, scrollTop: -200 }),
    getFixedRowRange({ ...common, scrollTop: 0 })
  )
})

test('getFixedRowRange keeps the first row mounted when the list starts below the fold', () => {
  assert.deepEqual(getFixedRowRange({
    rowCount: 100,
    rowHeight: 40,
    viewportHeight: 400,
    scrollTop: 0,
    overscanCount: 0,
    leadingHeight: 1_000
  }), {
    visibleStartIndex: 0,
    visibleStopIndex: 0,
    overscanStartIndex: 0,
    overscanStopIndex: 0
  })
})

test('getFixedRowScrollOffset accounts for leading content', () => {
  const common = {
    rowCount: 100,
    rowHeight: 40,
    viewportHeight: 400,
    leadingHeight: 240,
    index: 20
  }

  assert.equal(getFixedRowScrollOffset({ ...common, align: 'start', currentScrollTop: 0 }), 1_040)
  assert.equal(getFixedRowScrollOffset({ ...common, align: 'end', currentScrollTop: 0 }), 680)
  assert.equal(getFixedRowScrollOffset({ ...common, align: 'center', currentScrollTop: 0 }), 860)
  assert.equal(getFixedRowScrollOffset({ ...common, align: 'auto', currentScrollTop: 0 }), 680)
  assert.equal(getFixedRowScrollOffset({ ...common, align: 'auto', currentScrollTop: 2_000 }), 1_040)

  // The last row clamps to the page maximum, not the rows-only maximum.
  assert.equal(getFixedRowScrollOffset({
    ...common,
    align: 'start',
    currentScrollTop: 0,
    index: 99
  }), 3_840)
})

test('getFixedRowScrollOffset defaults leadingHeight to zero', () => {
  assert.equal(getFixedRowScrollOffset({
    rowCount: 100,
    rowHeight: 40,
    viewportHeight: 400,
    index: 20,
    align: 'center',
    currentScrollTop: 0
  }), 620)
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
