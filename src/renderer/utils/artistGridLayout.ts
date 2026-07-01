export interface ArtistGridLayoutOptions {
  containerWidth: number
  itemCount: number
  minColumnWidth: number
  gap: number
}

export interface ArtistGridLayout {
  columnCount: number
  rowCount: number
  columnWidth: number
}

export function resolveArtistGridLayout({
  containerWidth,
  itemCount,
  minColumnWidth,
  gap
}: ArtistGridLayoutOptions): ArtistGridLayout {
  const safeItemCount = Math.max(0, Math.floor(itemCount))
  const safeMinColumnWidth = Math.max(1, Math.round(minColumnWidth))
  const safeGap = Math.max(0, Math.round(gap))
  const safeContainerWidth = Math.max(0, Math.floor(containerWidth))

  if (safeItemCount === 0) {
    return {
      columnCount: 1,
      rowCount: 0,
      columnWidth: safeMinColumnWidth
    }
  }

  if (safeContainerWidth === 0) {
    return {
      columnCount: 1,
      rowCount: safeItemCount,
      columnWidth: safeMinColumnWidth
    }
  }

  const maxColumnsByWidth = Math.floor((safeContainerWidth + safeGap) / (safeMinColumnWidth + safeGap))
  const columnCount = Math.max(1, maxColumnsByWidth)

  return {
    columnCount,
    rowCount: Math.ceil(safeItemCount / columnCount),
    columnWidth: Math.max(1, Math.floor(safeContainerWidth / columnCount))
  }
}
