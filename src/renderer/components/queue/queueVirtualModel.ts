export interface QueueVirtualLayout {
  hasCurrent: boolean
  upcomingCount: number
  previousCount: number
  currentTrackIndex: number | null
  upcomingSectionIndex: number | null
  upcomingStartIndex: number
  previousSectionIndex: number | null
  previousStartIndex: number
  rowCount: number
}

export type QueueVirtualRowLocation =
  | { kind: 'section'; section: 'current' | 'upcoming' | 'previous' }
  | { kind: 'current' }
  | { kind: 'upcoming'; itemIndex: number }
  | { kind: 'previous'; itemIndex: number }

export function createQueueVirtualLayout(
  hasCurrent: boolean,
  upcomingCount: number,
  previousCount: number
): QueueVirtualLayout {
  let rowIndex = 0
  const currentTrackIndex = hasCurrent ? 1 : null
  if (hasCurrent) rowIndex += 2

  const upcomingSectionIndex = upcomingCount > 0 ? rowIndex : null
  const upcomingStartIndex = upcomingCount > 0 ? rowIndex + 1 : rowIndex
  if (upcomingCount > 0) rowIndex += upcomingCount + 1

  const previousSectionIndex = previousCount > 0 ? rowIndex : null
  const previousStartIndex = previousCount > 0 ? rowIndex + 1 : rowIndex
  if (previousCount > 0) rowIndex += previousCount + 1

  return {
    hasCurrent,
    upcomingCount,
    previousCount,
    currentTrackIndex,
    upcomingSectionIndex,
    upcomingStartIndex,
    previousSectionIndex,
    previousStartIndex,
    rowCount: rowIndex
  }
}

export function resolveQueueVirtualRowLocation(
  layout: QueueVirtualLayout,
  index: number
): QueueVirtualRowLocation | null {
  if (!Number.isInteger(index) || index < 0 || index >= layout.rowCount) return null

  if (layout.hasCurrent) {
    if (index === 0) return { kind: 'section', section: 'current' }
    if (index === layout.currentTrackIndex) return { kind: 'current' }
  }

  if (index === layout.upcomingSectionIndex) {
    return { kind: 'section', section: 'upcoming' }
  }
  const upcomingIndex = index - layout.upcomingStartIndex
  if (upcomingIndex >= 0 && upcomingIndex < layout.upcomingCount) {
    return { kind: 'upcoming', itemIndex: upcomingIndex }
  }

  if (index === layout.previousSectionIndex) {
    return { kind: 'section', section: 'previous' }
  }
  const previousIndex = index - layout.previousStartIndex
  if (previousIndex >= 0 && previousIndex < layout.previousCount) {
    return { kind: 'previous', itemIndex: previousIndex }
  }

  return null
}

export function resolveQueueDropIndex(
  localY: number,
  rowHeight: number,
  upcomingCount: number
): number {
  if (upcomingCount <= 0 || Number.isNaN(localY)) return 0
  if (!Number.isFinite(rowHeight) || rowHeight <= 0) return 0
  if (localY === Number.POSITIVE_INFINITY) return upcomingCount
  if (localY === Number.NEGATIVE_INFINITY) return 0
  return Math.max(0, Math.min(upcomingCount, Math.floor(localY / rowHeight + 0.5)))
}
