const WHEEL_LINE_HEIGHT_PX = 16
const SCROLL_EDGE_TOLERANCE_PX = 1
const SCROLL_EDGE_RESISTANCE_PX = 192
const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2

export interface HorizontalWheelScrollElement {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}

export interface HorizontalWheelScrollInput {
  deltaX: number
  deltaY: number
  deltaMode: number
}

// A null gesture means the shelf has not captured scrolling.
export interface HorizontalWheelScrollGesture {
  edgeOverscroll: number
}

export interface HorizontalWheelScrollResult {
  handled: boolean
  nextScrollLeft: number
  // The part of deltaY left for the page, in the input's original deltaMode.
  pageDeltaY: number
  gesture: HorizontalWheelScrollGesture | null
}

export function resolveHorizontalWheelScroll(
  element: HorizontalWheelScrollElement,
  input: HorizontalWheelScrollInput,
  previousGesture: HorizontalWheelScrollGesture | null = null
): HorizontalWheelScrollResult {
  const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth)
  const currentScrollLeft = Math.max(0, Math.min(maxScrollLeft, element.scrollLeft))

  if (maxScrollLeft <= 0) {
    return {
      handled: false,
      nextScrollLeft: currentScrollLeft,
      pageDeltaY: input.deltaY,
      gesture: null
    }
  }

  const dominantDelta = Math.abs(input.deltaX) > Math.abs(input.deltaY)
    ? input.deltaX
    : input.deltaY
  const gesture = previousGesture

  if (dominantDelta === 0) {
    return {
      handled: false,
      nextScrollLeft: currentScrollLeft,
      pageDeltaY: 0,
      gesture
    }
  }

  const isAtStart = currentScrollLeft <= SCROLL_EDGE_TOLERANCE_PX
  const isAtEnd = currentScrollLeft >= maxScrollLeft - SCROLL_EDGE_TOLERANCE_PX
  const scrollDelta = normalizeWheelDelta(dominantDelta, input.deltaMode, element.clientWidth)

  if ((dominantDelta < 0 && isAtStart) || (dominantDelta > 0 && isAtEnd)) {
    if (!gesture) {
      return {
        handled: false,
        nextScrollLeft: currentScrollLeft,
        pageDeltaY: input.deltaY,
        gesture: null
      }
    }

    // Absorb a fixed distance of additional input, regardless of wheel speed.
    // Forward only the remainder of the event that pushes through the edge.
    const distance = Math.abs(scrollDelta)
    const resistance = Math.max(0, SCROLL_EDGE_RESISTANCE_PX - gesture.edgeOverscroll)
    const absorbed = Math.min(distance, resistance)
    const released = distance >= resistance
    return {
      handled: true,
      nextScrollLeft: currentScrollLeft,
      pageDeltaY: distance > absorbed ? (input.deltaY / distance) * (distance - absorbed) : 0,
      gesture: released ? null : { edgeOverscroll: gesture.edgeOverscroll + absorbed }
    }
  }

  const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, currentScrollLeft + scrollDelta))
  const handled = gesture !== null || nextScrollLeft !== currentScrollLeft

  return {
    handled,
    nextScrollLeft,
    pageDeltaY: handled ? 0 : input.deltaY,
    // Reaching an edge consumes this event; resistance starts on the next one.
    // Moving away from an edge also clears any accumulated resistance.
    gesture: handled ? { edgeOverscroll: 0 } : null
  }
}

export function normalizeWheelDelta(delta: number, deltaMode: number, pageSize: number): number {
  if (deltaMode === DOM_DELTA_LINE) {
    return delta * WHEEL_LINE_HEIGHT_PX
  }

  if (deltaMode === DOM_DELTA_PAGE) {
    return delta * pageSize
  }

  return delta
}
