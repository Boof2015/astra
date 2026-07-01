const WHEEL_LINE_HEIGHT_PX = 16
const SCROLL_EDGE_TOLERANCE_PX = 1
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

export interface HorizontalWheelScrollResult {
  handled: boolean
  nextScrollLeft: number
}

export function resolveHorizontalWheelScroll(
  element: HorizontalWheelScrollElement,
  input: HorizontalWheelScrollInput
): HorizontalWheelScrollResult {
  const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth)
  const currentScrollLeft = Math.max(0, Math.min(maxScrollLeft, element.scrollLeft))

  if (maxScrollLeft <= 0) {
    return {
      handled: false,
      nextScrollLeft: currentScrollLeft
    }
  }

  const dominantDelta = Math.abs(input.deltaX) > Math.abs(input.deltaY)
    ? input.deltaX
    : input.deltaY

  if (dominantDelta === 0) {
    return {
      handled: false,
      nextScrollLeft: currentScrollLeft
    }
  }

  const isAtStart = currentScrollLeft <= SCROLL_EDGE_TOLERANCE_PX
  const isAtEnd = currentScrollLeft >= maxScrollLeft - SCROLL_EDGE_TOLERANCE_PX

  if ((dominantDelta < 0 && isAtStart) || (dominantDelta > 0 && isAtEnd)) {
    return {
      handled: false,
      nextScrollLeft: currentScrollLeft
    }
  }

  const scrollDelta = normalizeWheelDelta(dominantDelta, input.deltaMode, element.clientWidth)
  const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, currentScrollLeft + scrollDelta))

  return {
    handled: nextScrollLeft !== currentScrollLeft,
    nextScrollLeft
  }
}

function normalizeWheelDelta(delta: number, deltaMode: number, pageWidth: number): number {
  if (deltaMode === DOM_DELTA_LINE) {
    return delta * WHEEL_LINE_HEIGHT_PX
  }

  if (deltaMode === DOM_DELTA_PAGE) {
    return delta * pageWidth
  }

  return delta
}
