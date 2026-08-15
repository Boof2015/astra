export const TRACK_DRAG_ACTIVATION_DISTANCE_PX = 6
export const TRACK_DRAG_SCROLL_EDGE_PX = 40
export const TRACK_PLAYLIST_SPRING_OPEN_MS = 650
export const TRACK_QUEUE_SPRING_OPEN_MS = 350
export const TRACK_NAV_SPRING_OPEN_MS = 450

export type TrackDragDropSurfaceCandidate = 'playlist' | 'queue' | 'sidebar'

export function resolveTrackDragDropSurface(
  playlistHit: boolean,
  queueHit: boolean,
  sidebarHit: boolean
): TrackDragDropSurfaceCandidate | null {
  if (playlistHit) return 'playlist'
  if (queueHit) return 'queue'
  if (sidebarHit) return 'sidebar'
  return null
}

export function hasTrackDragActivated(
  startX: number,
  startY: number,
  pointerX: number,
  pointerY: number,
  threshold = TRACK_DRAG_ACTIVATION_DISTANCE_PX
): boolean {
  return Math.hypot(pointerX - startX, pointerY - startY) > threshold
}

export function resolveTrackInsertionIndex(
  rowIndex: number,
  pointerY: number,
  rowTop: number,
  rowHeight: number
): number {
  return Math.max(0, rowIndex) + (pointerY >= rowTop + Math.max(0, rowHeight) / 2 ? 1 : 0)
}

export function resolveTrackDragSelectionIndexes(
  visibleKeys: readonly string[],
  selectedKeys: ReadonlySet<string>,
  anchorIndex: number
): number[] {
  if (anchorIndex < 0 || anchorIndex >= visibleKeys.length) return []
  const anchorKey = visibleKeys[anchorIndex]
  if (!selectedKeys.has(anchorKey)) return [anchorIndex]
  return visibleKeys.flatMap((key, index) => selectedKeys.has(key) ? [index] : [])
}

export function addTrackDragRangeToSelection(
  visibleKeys: readonly string[],
  baseSelectedKeys: ReadonlySet<string>,
  anchorIndex: number,
  hoverIndex: number
): Set<string> {
  const nextSelectedKeys = new Set(baseSelectedKeys)
  if (visibleKeys.length === 0) return nextSelectedKeys

  const startIndex = Math.max(0, Math.min(anchorIndex, hoverIndex))
  const endIndex = Math.min(visibleKeys.length - 1, Math.max(anchorIndex, hoverIndex))
  for (let index = startIndex; index <= endIndex; index += 1) {
    const key = visibleKeys[index]
    if (key !== undefined) nextSelectedKeys.add(key)
  }
  return nextSelectedKeys
}

export function isTrackDragSpringRequestCurrent(
  requestToken: number,
  currentToken: number,
  targetStillActive: boolean
): boolean {
  return requestToken === currentToken && targetStillActive
}

export function resolveTrackDragScrollDelta(
  pointerY: number,
  viewportTop: number,
  viewportBottom: number,
  canScrollUp: boolean,
  canScrollDown: boolean,
  edgeSize = TRACK_DRAG_SCROLL_EDGE_PX
): number {
  if (pointerY < viewportTop || pointerY > viewportBottom || edgeSize <= 0) return 0
  const distanceFromTop = pointerY - viewportTop
  const distanceFromBottom = viewportBottom - pointerY
  if (distanceFromTop < edgeSize && canScrollUp) {
    return -Math.ceil((edgeSize - distanceFromTop) / 4)
  }
  if (distanceFromBottom < edgeSize && canScrollDown) {
    return Math.ceil((edgeSize - distanceFromBottom) / 4)
  }
  return 0
}
