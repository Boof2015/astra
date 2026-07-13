const TRACK_DRAG_INTERACTIVE_TARGET_SELECTOR = 'button, a, input, textarea, select, [role="button"]'

interface ClosestInteractiveTarget {
  closest: (selector: string) => object | null
}

export function shouldSuppressTrackRowDrag(
  target: ClosestInteractiveTarget | null,
  trackRow: object
): boolean {
  const interactiveTarget = target?.closest(TRACK_DRAG_INTERACTIVE_TARGET_SELECTOR) ?? null
  return interactiveTarget !== null && interactiveTarget !== trackRow
}
