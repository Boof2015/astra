import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveHorizontalWheelScroll } from './horizontalWheelScroll.ts'

test('horizontal wheel scroll maps vertical wheel movement into scrollLeft', () => {
  assert.deepEqual(resolveHorizontalWheelScroll({
    scrollLeft: 100,
    scrollWidth: 500,
    clientWidth: 200
  }, {
    deltaX: 0,
    deltaY: 40,
    deltaMode: 0
  }), {
    handled: true,
    nextScrollLeft: 140
  })
})

test('horizontal wheel scroll releases upward wheel movement at the left edge', () => {
  assert.deepEqual(resolveHorizontalWheelScroll({
    scrollLeft: 0,
    scrollWidth: 500,
    clientWidth: 200
  }, {
    deltaX: 0,
    deltaY: -40,
    deltaMode: 0
  }), {
    handled: false,
    nextScrollLeft: 0
  })
})

test('horizontal wheel scroll releases downward wheel movement at the right edge', () => {
  assert.deepEqual(resolveHorizontalWheelScroll({
    scrollLeft: 300,
    scrollWidth: 500,
    clientWidth: 200
  }, {
    deltaX: 0,
    deltaY: 40,
    deltaMode: 0
  }), {
    handled: false,
    nextScrollLeft: 300
  })
})

test('horizontal wheel scroll handles horizontal-dominant trackpad input', () => {
  assert.deepEqual(resolveHorizontalWheelScroll({
    scrollLeft: 100,
    scrollWidth: 500,
    clientWidth: 200
  }, {
    deltaX: 36,
    deltaY: 5,
    deltaMode: 0
  }), {
    handled: true,
    nextScrollLeft: 136
  })
})

test('horizontal wheel scroll ignores rails without horizontal overflow', () => {
  assert.deepEqual(resolveHorizontalWheelScroll({
    scrollLeft: 0,
    scrollWidth: 200,
    clientWidth: 200
  }, {
    deltaX: 0,
    deltaY: 40,
    deltaMode: 0
  }), {
    handled: false,
    nextScrollLeft: 0
  })
})

test('horizontal wheel scroll normalizes line-based wheel deltas', () => {
  assert.deepEqual(resolveHorizontalWheelScroll({
    scrollLeft: 100,
    scrollWidth: 500,
    clientWidth: 200
  }, {
    deltaX: 0,
    deltaY: 2,
    deltaMode: 1
  }), {
    handled: true,
    nextScrollLeft: 132
  })
})

test('horizontal wheel scroll normalizes page-based wheel deltas', () => {
  assert.deepEqual(resolveHorizontalWheelScroll({
    scrollLeft: 100,
    scrollWidth: 700,
    clientWidth: 200
  }, {
    deltaX: 0,
    deltaY: 1,
    deltaMode: 2
  }), {
    handled: true,
    nextScrollLeft: 300
  })
})
