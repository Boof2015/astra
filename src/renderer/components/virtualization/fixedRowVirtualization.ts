export type FixedRowAlignment = 'auto' | 'center' | 'end' | 'smart' | 'start'

export interface FixedRowRange {
  visibleStartIndex: number
  visibleStopIndex: number
  overscanStartIndex: number
  overscanStopIndex: number
}

interface FixedRowRangeOptions {
  rowCount: number
  rowHeight: number
  viewportHeight: number
  scrollTop: number
  overscanCount: number
  // Height of content rendered above row zero inside the same scrollport. Zero
  // when the list owns its scroller; non-zero when a detail view scrolls the
  // list together with a header block above it.
  leadingHeight?: number
}

interface FixedRowScrollOffsetOptions {
  align: FixedRowAlignment
  currentScrollTop: number
  index: number
  rowCount: number
  rowHeight: number
  viewportHeight: number
  leadingHeight?: number
}

const EMPTY_FIXED_ROW_RANGE: FixedRowRange = {
  visibleStartIndex: 0,
  visibleStopIndex: -1,
  overscanStartIndex: 0,
  overscanStopIndex: -1
}

function normalizeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

function normalizePositiveFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

export function getFixedRowTotalHeight(rowCount: number, rowHeight: number): number {
  return normalizeNonNegativeInteger(rowCount) * normalizePositiveFinite(rowHeight)
}

export function getFixedRowRange({
  rowCount,
  rowHeight,
  viewportHeight,
  scrollTop,
  overscanCount,
  leadingHeight
}: FixedRowRangeOptions): FixedRowRange {
  const normalizedRowCount = normalizeNonNegativeInteger(rowCount)
  const normalizedRowHeight = normalizePositiveFinite(rowHeight)
  const normalizedViewportHeight = normalizePositiveFinite(viewportHeight)
  if (normalizedRowCount === 0 || normalizedRowHeight === 0 || normalizedViewportHeight === 0) {
    return EMPTY_FIXED_ROW_RANGE
  }

  const normalizedLeadingHeight = normalizePositiveFinite(leadingHeight ?? 0)
  const totalHeight = normalizedRowCount * normalizedRowHeight
  const maximumScrollTop = Math.max(0, totalHeight - normalizedViewportHeight)
  // Rubber-band overscroll is clamped away before the leading offset is
  // removed, so a negative scrollTop still resolves to the first window.
  const rawScrollTop = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0
  // Deliberately allowed to go negative: while the leading block is still on
  // screen the effective window shrinks from the top instead of over-mounting.
  const localScrollTop = Math.min(rawScrollTop - normalizedLeadingHeight, maximumScrollTop)
  const visibleTop = clamp(localScrollTop, 0, maximumScrollTop)
  const visibleBottom = clamp(localScrollTop + normalizedViewportHeight, 0, totalHeight)
  const normalizedOverscanCount = normalizeNonNegativeInteger(overscanCount)
  const visibleStartIndex = Math.min(
    normalizedRowCount - 1,
    Math.floor(visibleTop / normalizedRowHeight)
  )
  const visibleStopIndex = Math.min(
    normalizedRowCount - 1,
    Math.max(
      visibleStartIndex,
      Math.ceil(visibleBottom / normalizedRowHeight) - 1
    )
  )

  return {
    visibleStartIndex,
    visibleStopIndex,
    overscanStartIndex: Math.max(0, visibleStartIndex - normalizedOverscanCount),
    overscanStopIndex: Math.min(normalizedRowCount - 1, visibleStopIndex + normalizedOverscanCount)
  }
}

export function getFixedRowScrollOffset({
  align,
  currentScrollTop,
  index,
  rowCount,
  rowHeight,
  viewportHeight,
  leadingHeight
}: FixedRowScrollOffsetOptions): number {
  const normalizedRowCount = normalizeNonNegativeInteger(rowCount)
  if (!Number.isInteger(index) || index < 0 || index >= normalizedRowCount) {
    throw new RangeError(`Invalid row index ${index}; expected 0-${Math.max(0, normalizedRowCount - 1)}`)
  }

  const normalizedRowHeight = normalizePositiveFinite(rowHeight)
  const normalizedViewportHeight = normalizePositiveFinite(viewportHeight)
  if (normalizedRowHeight === 0 || normalizedViewportHeight === 0) return 0

  // Offsets are returned in scroll-container coordinates, so the leading block
  // above row zero shifts every row and the maximum alike.
  const normalizedLeadingHeight = normalizePositiveFinite(leadingHeight ?? 0)
  const totalHeight = normalizedRowCount * normalizedRowHeight
  const maximumScrollTop = Math.max(0, normalizedLeadingHeight + totalHeight - normalizedViewportHeight)
  const normalizedCurrentScrollTop = Number.isFinite(currentScrollTop)
    ? clamp(currentScrollTop, 0, maximumScrollTop)
    : 0
  const rowStart = normalizedLeadingHeight + (index * normalizedRowHeight)
  const startOffset = clamp(rowStart, 0, maximumScrollTop)
  const endOffset = clamp(rowStart + normalizedRowHeight - normalizedViewportHeight, 0, maximumScrollTop)
  const centerOffset = clamp(
    rowStart + (normalizedRowHeight / 2) - (normalizedViewportHeight / 2),
    0,
    maximumScrollTop
  )
  const isVisible = normalizedCurrentScrollTop >= endOffset && normalizedCurrentScrollTop <= startOffset

  const resolvedAlign = align === 'smart'
    ? (isVisible ? 'auto' : 'center')
    : align

  switch (resolvedAlign) {
    case 'start':
      return startOffset
    case 'end':
      return endOffset
    case 'center':
      return centerOffset
    case 'auto':
    default:
      if (isVisible) return normalizedCurrentScrollTop
      return normalizedCurrentScrollTop < endOffset ? endOffset : startOffset
  }
}
