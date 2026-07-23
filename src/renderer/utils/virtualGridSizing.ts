export function resolveVirtualGridContentWidth(
  clientWidth: number,
  horizontalInset = 0
): number {
  const safeClientWidth = Number.isFinite(clientWidth) ? Math.max(0, clientWidth) : 0
  const safeHorizontalInset = Number.isFinite(horizontalInset) ? Math.max(0, horizontalInset) : 0
  return Math.max(0, Math.floor(safeClientWidth - safeHorizontalInset))
}

export function resolveGridHorizontalInset(padding: number, gap: number): number {
  const safePadding = Number.isFinite(padding) ? Math.max(0, padding) : 0
  const safeGap = Number.isFinite(gap) ? Math.max(0, gap) : 0
  return Math.max(0, (safePadding * 2) - safeGap)
}
