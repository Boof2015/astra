import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DETAIL_HEADER_COLLAPSE_SCROLL_TOP_PX,
  DETAIL_HEADER_EXPAND_SCROLL_TOP_PX,
  resolveDetailHeaderCollapsed
} from './detailHeaderScroll.ts'

const DESKTOP_COLLAPSE_DISTANCE_PX = 132 - 58
const RESPONSIVE_COLLAPSE_DISTANCE_PX = 112 - 58
const CLIENT_HEIGHT_PX = 700

function resolveExpanded(maxScrollTop: number, collapseDistance: number, scrollTop = 41): boolean {
  return resolveDetailHeaderCollapsed({
    isCollapsed: false,
    scrollTop,
    scrollHeight: CLIENT_HEIGHT_PX + maxScrollTop,
    clientHeight: CLIENT_HEIGHT_PX,
    collapseDistance
  })
}

test('keeps the detail header expanded in the short-list coincidence range', () => {
  assert.equal(resolveExpanded(60, DESKTOP_COLLAPSE_DISTANCE_PX), false)
})

test('requires scroll range beyond the desktop collapse distance and expansion threshold', () => {
  const exactBoundary = DESKTOP_COLLAPSE_DISTANCE_PX + DETAIL_HEADER_EXPAND_SCROLL_TOP_PX

  assert.equal(resolveExpanded(exactBoundary, DESKTOP_COLLAPSE_DISTANCE_PX), false)
  assert.equal(resolveExpanded(exactBoundary + 1, DESKTOP_COLLAPSE_DISTANCE_PX), true)
})

test('collapses long detail lists only after the collapse scroll threshold', () => {
  const longListMaxScrollTop = 200

  assert.equal(resolveExpanded(
    longListMaxScrollTop,
    DESKTOP_COLLAPSE_DISTANCE_PX,
    DETAIL_HEADER_COLLAPSE_SCROLL_TOP_PX
  ), false)
  assert.equal(resolveExpanded(
    longListMaxScrollTop,
    DESKTOP_COLLAPSE_DISTANCE_PX,
    DETAIL_HEADER_COLLAPSE_SCROLL_TOP_PX + 1
  ), true)
})

test('expands at 8px and stays collapsed at 9px', () => {
  const baseMetrics = {
    isCollapsed: true,
    scrollHeight: 900,
    clientHeight: CLIENT_HEIGHT_PX,
    collapseDistance: DESKTOP_COLLAPSE_DISTANCE_PX
  }

  assert.equal(resolveDetailHeaderCollapsed({
    ...baseMetrics,
    scrollTop: DETAIL_HEADER_EXPAND_SCROLL_TOP_PX
  }), false)
  assert.equal(resolveDetailHeaderCollapsed({
    ...baseMetrics,
    scrollTop: DETAIL_HEADER_EXPAND_SCROLL_TOP_PX + 1
  }), true)
})

test('uses the responsive header collapse distance at narrow widths', () => {
  const exactBoundary = RESPONSIVE_COLLAPSE_DISTANCE_PX + DETAIL_HEADER_EXPAND_SCROLL_TOP_PX

  assert.equal(resolveExpanded(exactBoundary, RESPONSIVE_COLLAPSE_DISTANCE_PX), false)
  assert.equal(resolveExpanded(exactBoundary + 1, RESPONSIVE_COLLAPSE_DISTANCE_PX), true)
})
