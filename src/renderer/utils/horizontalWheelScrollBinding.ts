import {
  type HorizontalWheelScrollGesture,
  normalizeWheelDelta,
  resolveHorizontalWheelScroll
} from './horizontalWheelScroll'

function scrollVerticalAncestor(element: HTMLElement, event: WheelEvent, deltaY: number): boolean {

  const view = element.ownerDocument.defaultView
  if (!view) return false

  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent)
    if (style.overflowY !== 'auto' && style.overflowY !== 'scroll' && style.overflowY !== 'overlay') {
      continue
    }

    const maxScrollTop = Math.max(0, parent.scrollHeight - parent.clientHeight)
    const currentScrollTop = Math.max(0, Math.min(maxScrollTop, parent.scrollTop))
    const delta = normalizeWheelDelta(deltaY, event.deltaMode, parent.clientHeight)
    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, currentScrollTop + delta))
    if (nextScrollTop !== currentScrollTop) {
      // Do not rely on native wheel retargeting after canceling the shelf gesture.
      // The browser may keep it latched to the shelf until the pointer moves.
      event.preventDefault()
      parent.scrollTop = nextScrollTop
      return true
    }

    if (style.overscrollBehaviorY === 'contain' || style.overscrollBehaviorY === 'none') {
      break
    }
  }

  return false
}

export function bindHorizontalWheelScroll(element: HTMLElement): () => void {
  let gesture: HorizontalWheelScrollGesture | null = null

  const handleWheel = (event: WheelEvent) => {
    if (event.defaultPrevented || !event.cancelable) return

    const result = resolveHorizontalWheelScroll(element, event, gesture)
    gesture = result.gesture

    if (result.handled) {
      event.preventDefault()
      if (element.scrollLeft !== result.nextScrollLeft) {
        element.scrollLeft = result.nextScrollLeft
      }
    }
    if (result.pageDeltaY !== 0 && element.scrollWidth > element.clientWidth) {
      scrollVerticalAncestor(element, event, result.pageDeltaY)
    }
  }

  const handlePointerLeave = () => { gesture = null }
  element.addEventListener('wheel', handleWheel, { passive: false })
  element.addEventListener('pointerleave', handlePointerLeave)
  return () => {
    element.removeEventListener('wheel', handleWheel)
    element.removeEventListener('pointerleave', handlePointerLeave)
  }
}
