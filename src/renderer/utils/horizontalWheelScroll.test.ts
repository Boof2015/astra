import test from 'node:test'
import assert from 'node:assert/strict'
import {
  type HorizontalWheelScrollElement,
  type HorizontalWheelScrollGesture,
  type HorizontalWheelScrollInput,
  resolveHorizontalWheelScroll
} from './horizontalWheelScroll.ts'

function createShelf(scrollLeft: number, scrollWidth = 500) {
  const element: HorizontalWheelScrollElement = { scrollLeft, scrollWidth, clientWidth: 200 }
  let gesture: HorizontalWheelScrollGesture | null = null

  return {
    element,
    wheel(deltaY: number, input: Partial<HorizontalWheelScrollInput> = {}) {
      const result = resolveHorizontalWheelScroll(element, {
        deltaX: 0,
        deltaY,
        deltaMode: 0,
        ...input
      }, gesture)
      gesture = result.gesture
      element.scrollLeft = result.nextScrollLeft
      return result
    }
  }
}

for (const { name, deltaY, input, expected } of [
  { name: 'vertical wheel', deltaY: 40, input: {}, expected: 140 },
  { name: 'horizontal-dominant trackpad', deltaY: 5, input: { deltaX: 36 }, expected: 136 },
  { name: 'line-based wheel', deltaY: 2, input: { deltaMode: 1 }, expected: 132 },
  { name: 'page-based wheel', deltaY: 1, input: { deltaMode: 2 }, expected: 300 }
]) {
  test(`horizontal wheel scroll normalizes ${name} input into scrollLeft`, () => {
    const shelf = createShelf(100, 700)
    assert.deepEqual(shelf.wheel(deltaY, input), {
      handled: true,
      nextScrollLeft: expected,
      pageDeltaY: 0,
      gesture: { edgeOverscroll: 0 }
    })
  })
}

for (const direction of [-1, 1]) {
  const edge = direction < 0 ? 0 : 300
  const initialPosition = edge - direction * 20
  const label = direction < 0 ? 'left' : 'right'

  test(`a fresh outward gesture at the ${label} edge scrolls the page`, () => {
    const shelf = createShelf(edge)
    assert.deepEqual(shelf.wheel(direction * 40), {
      handled: false,
      nextScrollLeft: edge,
      pageDeltaY: direction * 40,
      gesture: null
    })
  })

  test(`the ${label} edge absorbs 192 pixels of additional input before releasing`, () => {
    const shelf = createShelf(initialPosition)
    assert.deepEqual(shelf.wheel(direction * 40), {
      handled: true,
      nextScrollLeft: edge,
      pageDeltaY: 0,
      gesture: { edgeOverscroll: 0 }
    })

    let total = 0
    for (const distance of [48, 48, 48, 47]) {
      total += distance
      const result = shelf.wheel(direction * distance)
      assert.equal(result.handled, true)
      assert.equal(result.nextScrollLeft, edge)
      assert.equal(Math.abs(result.pageDeltaY), 0)
      assert.deepEqual(result.gesture, { edgeOverscroll: total })
    }

    const threshold = shelf.wheel(direction)
    assert.equal(threshold.handled, true)
    assert.equal(Math.abs(threshold.pageDeltaY), 0)
    assert.equal(threshold.gesture, null)

    assert.deepEqual(shelf.wheel(direction * 40), {
      handled: false,
      nextScrollLeft: edge,
      pageDeltaY: direction * 40,
      gesture: null
    })
  })

  test(`pushing through the ${label} edge forwards only the unabsorbed input`, () => {
    const shelf = createShelf(initialPosition)
    shelf.wheel(direction * 40)
    shelf.wheel(direction * 176)
    assert.deepEqual(shelf.wheel(direction * 40), {
      handled: true,
      nextScrollLeft: edge,
      pageDeltaY: direction * 24,
      gesture: null
    })
  })

  test(`a large scroll reaching the ${label} edge cannot immediately move the page`, () => {
    const shelf = createShelf(initialPosition)
    assert.equal(shelf.wheel(direction * 1000).pageDeltaY, 0)
    assert.equal(shelf.element.scrollLeft, edge)
    assert.equal(shelf.wheel(direction * 216).pageDeltaY, direction * 24)
  })

  test(`reversing at the ${label} edge moves immediately and clears accumulated resistance`, () => {
    const shelf = createShelf(initialPosition)
    shelf.wheel(direction * 40)
    shelf.wheel(direction * 80)
    assert.deepEqual(shelf.wheel(-direction * 30), {
      handled: true,
      nextScrollLeft: edge - direction * 30,
      pageDeltaY: 0,
      gesture: { edgeOverscroll: 0 }
    })
    shelf.wheel(direction * 40)
    assert.deepEqual(shelf.wheel(direction * 40).gesture, { edgeOverscroll: 40 })
  })

  test(`resistance respects the existing tolerance at the ${label} edge`, () => {
    const shelf = createShelf(initialPosition)
    const nearEdge = edge - direction * 0.5
    shelf.wheel(direction * 19.5)
    assert.equal(Math.abs(shelf.wheel(direction * 192).pageDeltaY), 0)
    assert.equal(shelf.wheel(direction * 5).pageDeltaY, direction * 5)
    assert.equal(shelf.element.scrollLeft, nearEdge)
  })
}

test('small fractional deltas accumulate by distance rather than event count', () => {
  const shelf = createShelf(280)
  shelf.wheel(20)
  for (let i = 0; i < 767; i++) {
    assert.equal(shelf.wheel(0.25).pageDeltaY, 0)
  }
  assert.equal(shelf.wheel(0.5).pageDeltaY, 0.25)
})

test('different event sizes consume the same amount of resistance', () => {
  const single = createShelf(280)
  const split = createShelf(280)
  single.wheel(20)
  split.wheel(20)
  const singlePageDelta = single.wheel(216).pageDeltaY
  const splitPageDelta = [54, 54, 54, 54].reduce((total, delta) => total + split.wheel(delta).pageDeltaY, 0)
  assert.equal(singlePageDelta, 24)
  assert.equal(splitPageDelta, singlePageDelta)
})

test('line-based resistance forwards the remainder in the original input units', () => {
  const shelf = createShelf(280)
  shelf.wheel(20)
  shelf.wheel(10, { deltaMode: 1 })
  assert.equal(shelf.wheel(3, { deltaMode: 1 }).pageDeltaY, 1)
})

test('page-based resistance forwards the remaining fraction of a page', () => {
  const shelf = createShelf(280)
  shelf.wheel(20)
  assert.equal(shelf.wheel(1, { deltaMode: 2 }).pageDeltaY, 0.04)
})

test('horizontal trackpad resistance scales the vertical remainder proportionally', () => {
  const shelf = createShelf(280)
  shelf.wheel(5, { deltaX: 40 })
  assert.equal(shelf.wheel(8, { deltaX: 160 }).pageDeltaY, 0)
  assert.deepEqual(shelf.wheel(5, { deltaX: 40 }), {
    handled: true,
    nextScrollLeft: 300,
    pageDeltaY: 1,
    gesture: null
  })
})

test('zero-delta events neither acquire capture nor clear accumulated resistance', () => {
  const shelf = createShelf(280)
  assert.equal(shelf.wheel(0).gesture, null)
  shelf.wheel(20)
  shelf.wheel(160)
  assert.deepEqual(shelf.wheel(0), {
    handled: false,
    nextScrollLeft: 300,
    pageDeltaY: 0,
    gesture: { edgeOverscroll: 160 }
  })
  assert.equal(shelf.wheel(40).pageDeltaY, 8)
})

test('capture and accumulated resistance stay independent for each shelf', () => {
  const first = createShelf(280)
  const second = createShelf(280)
  first.wheel(20)
  second.wheel(20)
  first.wheel(176)
  assert.equal(second.wheel(40).pageDeltaY, 0)
  assert.equal(first.wheel(40).pageDeltaY, 24)
})

test('loss of horizontal overflow clears capture and allows native scrolling', () => {
  const shelf = createShelf(280)
  shelf.wheel(20)
  shelf.wheel(80)
  shelf.element.clientWidth = 500
  assert.deepEqual(shelf.wheel(10), {
    handled: false,
    nextScrollLeft: 0,
    pageDeltaY: 10,
    gesture: null
  })
  shelf.element.clientWidth = 200
  assert.equal(shelf.wheel(-10).handled, false)
})

test('moving across the shelf does not count toward edge resistance', () => {
  const shelf = createShelf(0)
  shelf.wheel(100)
  shelf.wheel(100)
  shelf.wheel(80)
  shelf.wheel(40)
  assert.equal(shelf.wheel(176).pageDeltaY, 0)
  assert.equal(shelf.wheel(40).pageDeltaY, 24)
})

test('crossing to the opposite edge starts fresh resistance', () => {
  const shelf = createShelf(280)
  shelf.wheel(20)
  shelf.wheel(80)
  shelf.wheel(-400)
  assert.deepEqual(shelf.wheel(-40).gesture, { edgeOverscroll: 40 })
})
