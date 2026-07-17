export type PlayCountSortDirection = 'asc' | 'desc'

export function compareTrackPlayCounts(
  left: number,
  right: number,
  direction: PlayCountSortDirection,
  leftMissing = false,
  rightMissing = false
): number {
  if (leftMissing && rightMissing) return 0
  if (leftMissing) return 1
  if (rightMissing) return -1
  return direction === 'asc' ? left - right : right - left
}
