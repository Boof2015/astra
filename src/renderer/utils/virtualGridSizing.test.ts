import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveGridHorizontalInset,
  resolveVirtualGridContentWidth
} from './virtualGridSizing.ts'

test('virtual grid sizing uses the mounted element client width', () => {
  assert.equal(resolveVirtualGridContentWidth(960), 960)
  assert.equal(resolveVirtualGridContentWidth(1200), 1200)
})

test('virtual grid sizing subtracts scroller padding while preserving scrollbar adjustment', () => {
  const outerWidth = 1000
  const classicScrollbarWidth = 15
  const clientWidth = outerWidth - classicScrollbarWidth
  const horizontalInset = resolveGridHorizontalInset(14, 14)

  assert.equal(horizontalInset, 14)
  assert.equal(resolveVirtualGridContentWidth(clientWidth, horizontalInset), 971)
})

test('virtual grid sizing does not reuse a stale callback fallback width', () => {
  const reactWindowFallbackWidth = 480
  const mountedClientWidth = 1185

  assert.notEqual(mountedClientWidth, reactWindowFallbackWidth)
  assert.equal(resolveVirtualGridContentWidth(mountedClientWidth), 1185)
})

test('virtual grid sizing clamps invalid and over-inset measurements to zero', () => {
  assert.equal(resolveVirtualGridContentWidth(Number.NaN, 14), 0)
  assert.equal(resolveVirtualGridContentWidth(10, 14), 0)
  assert.equal(resolveGridHorizontalInset(4, 12), 0)
})
