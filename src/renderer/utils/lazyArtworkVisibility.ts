const SCROLLABLE_OVERFLOW_VALUES = new Set(['auto', 'scroll', 'overlay'])

export const ARTWORK_PRELOAD_MARGIN_PX = 240

function hasScrollableOverflow(value: string): boolean {
  return SCROLLABLE_OVERFLOW_VALUES.has(value.trim().toLowerCase())
}

function isScrollableAncestor(element: HTMLElement): boolean {
  const styles = window.getComputedStyle(element)
  return hasScrollableOverflow(styles.overflowX) || hasScrollableOverflow(styles.overflowY)
}

export function resolveArtworkScrollRoot(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null

  while (current) {
    if (isScrollableAncestor(current)) {
      return current
    }

    current = current.parentElement
  }

  return null
}

export function isElementWithinPreloadRange(
  element: HTMLElement,
  root: HTMLElement | null,
  marginPx = ARTWORK_PRELOAD_MARGIN_PX
): boolean {
  const targetRect = element.getBoundingClientRect()
  if (targetRect.width <= 0 || targetRect.height <= 0) {
    return false
  }

  const rootRect = root
    ? root.getBoundingClientRect()
    : {
        top: 0,
        left: 0,
        right: window.innerWidth,
        bottom: window.innerHeight
      }

  return (
    targetRect.bottom >= rootRect.top - marginPx
    && targetRect.top <= rootRect.bottom + marginPx
    && targetRect.right >= rootRect.left - marginPx
    && targetRect.left <= rootRect.right + marginPx
  )
}
