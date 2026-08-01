export const DETAIL_HEADER_COLLAPSE_SCROLL_TOP_PX = 40
export const DETAIL_HEADER_EXPAND_SCROLL_TOP_PX = 8

const DEFAULT_DETAIL_HEADER_EXPANDED_HEIGHT_PX = 132
const DEFAULT_DETAIL_HEADER_COLLAPSED_HEIGHT_PX = 58
const DETAIL_HEADER_EXPANDED_HEIGHT_PROPERTY = '--library-detail-header-expanded-height'
const DETAIL_HEADER_COLLAPSED_HEIGHT_PROPERTY = '--library-detail-header-collapsed-height'

export interface DetailHeaderScrollMetrics {
  isCollapsed: boolean
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  collapseDistance: number
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function resolveDetailHeaderCollapsed({
  isCollapsed,
  scrollTop,
  scrollHeight,
  clientHeight,
  collapseDistance
}: DetailHeaderScrollMetrics): boolean {
  const normalizedScrollTop = finiteNonNegative(scrollTop)

  if (isCollapsed) {
    return normalizedScrollTop > DETAIL_HEADER_EXPAND_SCROLL_TOP_PX
  }

  const maxScrollTop = Math.max(
    0,
    finiteNonNegative(scrollHeight) - finiteNonNegative(clientHeight)
  )
  const remainingScrollRange = maxScrollTop - finiteNonNegative(collapseDistance)

  return normalizedScrollTop > DETAIL_HEADER_COLLAPSE_SCROLL_TOP_PX
    && remainingScrollRange > DETAIL_HEADER_EXPAND_SCROLL_TOP_PX
}

function parseCssPixelValue(value: string): number | null {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export function getDetailHeaderCollapseDistance(header: HTMLElement | null): number {
  const fallbackDistance = DEFAULT_DETAIL_HEADER_EXPANDED_HEIGHT_PX
    - DEFAULT_DETAIL_HEADER_COLLAPSED_HEIGHT_PX

  if (!header || typeof window === 'undefined') return fallbackDistance

  const style = window.getComputedStyle(header)
  const expandedHeight = parseCssPixelValue(style.getPropertyValue(DETAIL_HEADER_EXPANDED_HEIGHT_PROPERTY))
  const collapsedHeight = parseCssPixelValue(style.getPropertyValue(DETAIL_HEADER_COLLAPSED_HEIGHT_PROPERTY))

  if (expandedHeight === null || collapsedHeight === null) return fallbackDistance
  return Math.max(0, expandedHeight - collapsedHeight)
}
