import test from 'node:test'
import assert from 'node:assert/strict'
import { bindHorizontalWheelScroll } from './horizontalWheelScrollBinding.ts'

// EventTarget exercises the real listener and cancellation without a browser
// supplying default scroll chaining (the part that can stay latched to a shelf).
class ScrollElement extends EventTarget {
  scrollLeft = 0
  scrollWidth = 200
  clientWidth = 200
  scrollTop = 0
  scrollHeight = 200
  clientHeight = 200
  overflowY = 'visible'
  overscrollBehaviorY = 'auto'
  parentElement: ScrollElement | null = null
  ownerDocument = {
    defaultView: {
      getComputedStyle: (element: ScrollElement) => element
    }
  }

  bind() {
    return bindHorizontalWheelScroll(this as unknown as HTMLElement)
  }

  wheel(timeStamp: number, deltaY: number, deltaX = 0, deltaMode = 0, cancelable = true) {
    const event = new Event('wheel', { cancelable })
    Object.defineProperties(event, {
      timeStamp: { value: timeStamp },
      deltaY: { value: deltaY },
      deltaX: { value: deltaX },
      deltaMode: { value: deltaMode }
    })
    this.dispatchEvent(event)
    return event
  }
}

function createShelfPage(scrollLeft = 280) {
  const page = new ScrollElement()
  page.scrollHeight = 1000
  page.scrollTop = 100
  page.overflowY = 'auto'
  const wrapper = new ScrollElement()
  wrapper.parentElement = page
  const shelf = new ScrollElement()
  shelf.scrollWidth = 500
  shelf.scrollLeft = scrollLeft
  shelf.parentElement = wrapper
  const cleanup = shelf.bind()
  return { shelf, wrapper, page, cleanup }
}

for (const direction of [-1, 1]) {
  test(`continuous ${direction < 0 ? 'upward' : 'downward'} scrolling pushes through the edge without stopping or moving the pointer`, () => {
    const edge = direction < 0 ? 0 : 300
    const { shelf, page, cleanup } = createShelfPage(edge - direction * 20)
    assert.equal(shelf.wheel(0, direction * 40).defaultPrevented, true)
    assert.equal(shelf.scrollLeft, edge)
    for (const timeStamp of [10, 20, 30, 40]) {
      assert.equal(shelf.wheel(timeStamp, direction * 40).defaultPrevented, true)
      assert.equal(page.scrollTop, 100)
    }

    const releasedEvent = shelf.wheel(50, direction * 40)
    assert.equal(page.scrollTop, 100 + direction * 8)
    assert.equal(shelf.scrollLeft, edge)
    // Native scrolling must be canceled so browsers that do retarget cannot scroll twice.
    assert.equal(releasedEvent.defaultPrevented, true)

    shelf.wheel(60, direction * 40)
    assert.equal(page.scrollTop, 100 + direction * 48)
    cleanup()
  })
}

test('trackpad input forwards only the vertical portion left after resistance', () => {
  const { shelf, page, cleanup } = createShelfPage()
  shelf.wheel(0, 5, 40)
  shelf.wheel(10, 8, 160)
  assert.equal(page.scrollTop, 100)
  shelf.wheel(20, 5, 40)
  assert.equal(page.scrollTop, 101)
  assert.equal(shelf.wheel(500, 0, 12).defaultPrevented, false)
  assert.equal(page.scrollTop, 101)
  cleanup()
})

for (const interval of [10, 100, 1000]) {
  test(`resistance consumes the same distance with wheel events ${interval} ms apart`, () => {
    const { shelf, page, cleanup } = createShelfPage()
    shelf.wheel(0, 40)
    shelf.wheel(interval, 40)
    shelf.wheel(interval * 2, 40)
    shelf.wheel(interval * 3, 40)
    shelf.wheel(interval * 4, 40)
    assert.equal(page.scrollTop, 100)
    shelf.wheel(interval * 5, 40)
    assert.equal(page.scrollTop, 108)
    cleanup()
  })
}

test('crossing the resistance threshold does not replay the absorbed scroll distance', () => {
  const { shelf, page, cleanup } = createShelfPage()
  shelf.wheel(0, 1000)
  assert.equal(page.scrollTop, 100)
  shelf.wheel(1, 196)
  assert.equal(page.scrollTop, 104)
  cleanup()
})

test('line-based input forwards only unabsorbed lines to the page', () => {
  const { shelf, page, cleanup } = createShelfPage()
  shelf.wheel(0, 20)
  shelf.wheel(10, 10, 0, 1)
  assert.equal(page.scrollTop, 100)
  shelf.wheel(20, 3, 0, 1)
  assert.equal(page.scrollTop, 116)
  cleanup()
})

test('page-based input forwards the remaining fraction using the parent viewport height', () => {
  const { shelf, page, cleanup } = createShelfPage()
  page.clientHeight = 400
  shelf.wheel(0, 20)
  shelf.wheel(10, 1, 0, 2)
  assert.equal(page.scrollTop, 116)
  cleanup()
})

test('leaving a shelf clears its resistance for a later visit', () => {
  const { shelf, page, cleanup } = createShelfPage()
  shelf.wheel(0, 20)
  shelf.wheel(10, 40)
  shelf.dispatchEvent(new Event('pointerleave'))
  shelf.wheel(20, 40)
  assert.equal(page.scrollTop, 140)
  cleanup()
})

test('released wheel deltas use line height or the vertical viewport height', () => {
  const { shelf, page, cleanup } = createShelfPage(300)
  shelf.wheel(0, 2, 0, 1)
  assert.equal(page.scrollTop, 132)
  shelf.wheel(10, 1, 0, 2)
  assert.equal(page.scrollTop, 332)
  cleanup()
})

test('reversing direction moves the shelf without scrolling the page', () => {
  const { shelf, page, cleanup } = createShelfPage()
  shelf.wheel(0, 40)
  shelf.wheel(10, -30)
  assert.equal(shelf.scrollLeft, 270)
  assert.equal(page.scrollTop, 100)
  cleanup()
})

test('released scrolling skips wrappers with hidden or non-scrollable overflow', () => {
  const { shelf, wrapper, page, cleanup } = createShelfPage(300)
  wrapper.overflowY = 'hidden'
  wrapper.scrollHeight = 1000
  shelf.wheel(0, 40)
  assert.equal(wrapper.scrollTop, 0)
  assert.equal(page.scrollTop, 140)
  cleanup()
})

test('released scrolling selects the nearest vertical scrollport and clamps at its edge', () => {
  const { shelf, wrapper, page, cleanup } = createShelfPage(300)
  wrapper.overflowY = 'scroll'
  wrapper.scrollHeight = 300
  wrapper.scrollTop = 90
  shelf.wheel(0, 40)
  assert.equal(wrapper.scrollTop, 100)
  assert.equal(page.scrollTop, 100)
  shelf.wheel(10, 40)
  assert.equal(page.scrollTop, 140)
  cleanup()
})

for (const overscroll of ['contain', 'none']) {
  test(`released scrolling respects ancestor overscroll-behavior-y: ${overscroll}`, () => {
    const { shelf, wrapper, page, cleanup } = createShelfPage(300)
    wrapper.overflowY = 'auto'
    wrapper.overscrollBehaviorY = overscroll
    assert.equal(shelf.wheel(0, 40).defaultPrevented, false)
    assert.equal(page.scrollTop, 100)
    cleanup()
  })
}

test('shelves without horizontal overflow retain native scrolling', () => {
  const { shelf, page, cleanup } = createShelfPage(0)
  shelf.scrollWidth = shelf.clientWidth
  assert.equal(shelf.wheel(0, 40).defaultPrevented, false)
  assert.equal(page.scrollTop, 100)
  cleanup()
})

test('noncancelable wheel events cannot cause manual and native scrolling together', () => {
  const { shelf, page, cleanup } = createShelfPage(300)
  assert.equal(shelf.wheel(0, 40, 0, 0, false).defaultPrevented, false)
  assert.equal(page.scrollTop, 100)
  cleanup()
})

test('an event already consumed by another control is left alone', () => {
  const { shelf, page, cleanup } = createShelfPage(300)
  cleanup()
  shelf.addEventListener('wheel', (event) => event.preventDefault())
  const unbind = shelf.bind()
  shelf.wheel(0, 40)
  assert.equal(page.scrollTop, 100)
  unbind()
})

test('unbinding removes the listener and rebinding starts with fresh gesture state', () => {
  const { shelf, page, cleanup } = createShelfPage()
  shelf.wheel(0, 40)
  cleanup()
  assert.equal(shelf.wheel(10, 40).defaultPrevented, false)
  assert.equal(page.scrollTop, 100)
  const unbind = shelf.bind()
  shelf.wheel(20, 40)
  assert.equal(page.scrollTop, 140)
  unbind()
})
