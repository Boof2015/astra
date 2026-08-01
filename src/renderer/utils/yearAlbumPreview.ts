export const YEAR_ALBUM_PREVIEW_MIN_COLUMN_WIDTH_PX = 220
export const YEAR_ALBUM_PREVIEW_COLUMN_GAP_PX = 12
export const YEAR_ALBUM_PREVIEW_COLLAPSED_ROWS = 2

export interface YearAlbumPreviewLayout {
  columnCount: number
  collapsedItemCount: number
  hasOverflow: boolean
}

export function resolveYearAlbumPreviewLayout({
  containerWidth,
  itemCount,
  minColumnWidth = YEAR_ALBUM_PREVIEW_MIN_COLUMN_WIDTH_PX,
  columnGap = YEAR_ALBUM_PREVIEW_COLUMN_GAP_PX,
  collapsedRows = YEAR_ALBUM_PREVIEW_COLLAPSED_ROWS
}: {
  containerWidth: number
  itemCount: number
  minColumnWidth?: number
  columnGap?: number
  collapsedRows?: number
}): YearAlbumPreviewLayout {
  const normalizedWidth = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0
  const normalizedItemCount = Number.isFinite(itemCount) ? Math.max(0, Math.floor(itemCount)) : 0
  const normalizedMinColumnWidth = Number.isFinite(minColumnWidth) ? Math.max(1, minColumnWidth) : 1
  const normalizedColumnGap = Number.isFinite(columnGap) ? Math.max(0, columnGap) : 0
  const normalizedCollapsedRows = Number.isFinite(collapsedRows) ? Math.max(1, Math.floor(collapsedRows)) : 1
  const columnCount = Math.max(1, Math.floor(
    (normalizedWidth + normalizedColumnGap) / (normalizedMinColumnWidth + normalizedColumnGap)
  ))
  const collapsedItemCount = Math.min(normalizedItemCount, columnCount * normalizedCollapsedRows)

  return {
    columnCount,
    collapsedItemCount,
    hasOverflow: normalizedItemCount > collapsedItemCount
  }
}
