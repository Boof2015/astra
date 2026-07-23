import { CSSProperties, memo, ReactElement, Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Grid, type CellComponentProps, type GridImperativeAPI } from 'react-window'
import { resolveArtistGridLayout } from '../../utils/artistGridLayout'
import { highlightSearchMatch } from '../../utils/searchHighlight'
import { normalizeKey } from '../../utils/albumIdentity'
import AlbumArtwork from './AlbumArtwork'
import {
  CONTROLLER_VIRTUAL_MOVE_EVENT,
  focusControllerTarget,
  type ControllerVirtualMoveDetail
} from '../../utils/controllerFocus'
import {
  resolveGridHorizontalInset,
  resolveVirtualGridContentWidth
} from '../../utils/virtualGridSizing'

interface GenreRecord {
  genre: string
  track_count: number
  album_count: number
  artwork_hash: string | null
}

export interface GenreGridViewportAPI {
  get element(): HTMLDivElement | null
}

interface GenreGridProps {
  genres: GenreRecord[]
  onSelectGenre: (genre: GenreRecord) => void
  viewportRef?: Ref<GenreGridViewportAPI>
  searchQuery?: string
}

interface GenreGridCellSharedProps {
  genres: GenreRecord[]
  columnCount: number
  onSelectGenre: (genre: GenreRecord) => void
  searchQuery: string
}

const GENRE_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX = 220
const GENRE_GRID_GAP_FALLBACK_PX = 14
const GENRE_GRID_PADDING_FALLBACK_PX = 20
const GENRE_GRID_OVERSCAN_COUNT = 3
// 56px artwork + 10px card padding top/bottom + 1px borders.
const GENRE_CARD_HEIGHT_ESTIMATE_PX = 78

function resolveCssPx(element: HTMLElement | null, propertyName: string, fallback: number): number {
  if (!element) return fallback

  const cssValue = getComputedStyle(element).getPropertyValue(propertyName).trim()
  const parsed = Number.parseFloat(cssValue)
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed)
  }

  return fallback
}

function formatTrackCount(count: number): string {
  return `${count} ${count === 1 ? 'track' : 'tracks'}`
}

function GenreGridCellRenderer({
  ariaAttributes,
  columnIndex,
  rowIndex,
  style,
  genres,
  columnCount,
  onSelectGenre,
  searchQuery
}: CellComponentProps<GenreGridCellSharedProps>): ReactElement | null {
  const genreIndex = (rowIndex * columnCount) + columnIndex
  const genre = genres[genreIndex]

  if (!genre) {
    return <div className="genre-grid-cell genre-grid-cell-empty" style={style as CSSProperties} {...ariaAttributes} />
  }

  return (
    <div className="genre-grid-cell" style={style as CSSProperties} {...ariaAttributes}>
      <button
        type="button"
        className="genre-card"
        data-controller-focusable="true"
        data-controller-key={`genre:${normalizeKey(genre.genre)}`}
        data-controller-index={genreIndex}
        onClick={() => {
          onSelectGenre(genre)
        }}
      >
        <div className="genre-card-artwork">
          {genre.artwork_hash ? (
            <AlbumArtwork hash={genre.artwork_hash} alt={genre.genre} variant="thumbnail" />
          ) : (
            <span>&#9835;</span>
          )}
        </div>
        <div className="genre-card-info">
          <div className="genre-card-title">{highlightSearchMatch(genre.genre, searchQuery)}</div>
          <div className="genre-card-meta">
            {formatTrackCount(genre.track_count)} · {genre.album_count} {genre.album_count === 1 ? 'album' : 'albums'}
          </div>
        </div>
      </button>
    </div>
  )
}

const GenreGridCell = memo(GenreGridCellRenderer) as (
  props: CellComponentProps<GenreGridCellSharedProps>
) => ReactElement | null

export default function GenreGrid({
  genres,
  onSelectGenre,
  viewportRef,
  searchQuery = ''
}: GenreGridProps) {
  const [viewportSize, setViewportSize] = useState({ height: 0, width: 0 })
  const [gridContentWidth, setGridContentWidth] = useState(0)
  const [minColumnWidth, setMinColumnWidth] = useState(GENRE_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX)
  const [gap, setGap] = useState(GENRE_GRID_GAP_FALLBACK_PX)
  const [padding, setPadding] = useState(GENRE_GRID_PADDING_FALLBACK_PX)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const gridApiRef = useRef<GridImperativeAPI | null>(null)

  useImperativeHandle(viewportRef, () => ({
    get element() {
      return gridApiRef.current?.element ?? null
    }
  }), [])

  useLayoutEffect(() => {
    const element = bodyRef.current
    if (!element) return

    const updateMeasurements = () => {
      const nextHeight = Math.max(0, Math.round(element.clientHeight))
      const nextWidth = Math.max(0, Math.round(element.clientWidth))
      const nextMinColumnWidth = resolveCssPx(element, '--genre-grid-min-column-width', GENRE_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX)
      const nextGap = resolveCssPx(element, '--genre-grid-gap', GENRE_GRID_GAP_FALLBACK_PX)
      const nextPadding = resolveCssPx(element, '--genre-grid-padding', GENRE_GRID_PADDING_FALLBACK_PX)

      setViewportSize((previous) => (
        previous.height === nextHeight && previous.width === nextWidth
          ? previous
          : { height: nextHeight, width: nextWidth }
      ))
      setMinColumnWidth((previous) => (previous === nextMinColumnWidth ? previous : nextMinColumnWidth))
      setGap((previous) => (previous === nextGap ? previous : nextGap))
      setPadding((previous) => (previous === nextPadding ? previous : nextPadding))
    }

    updateMeasurements()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateMeasurements)
      return () => {
        window.removeEventListener('resize', updateMeasurements)
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      updateMeasurements()
    })
    resizeObserver.observe(element)

    return () => {
      resizeObserver.disconnect()
    }
  }, [])

  // Cells carry gap/2 padding on every side; the scroller adds
  // (padding - gap/2) so outer edges land at the CSS-grid padding. Prefer the
  // mounted scroller's clientWidth because it excludes any classic vertical
  // scrollbar; then remove the scroller padding to get the cell content width.
  const horizontalInset = resolveGridHorizontalInset(padding, gap)
  const fallbackGridContentWidth = resolveVirtualGridContentWidth(viewportSize.width, horizontalInset)
  const availableGridContentWidth = gridContentWidth > 0 ? gridContentWidth : fallbackGridContentWidth
  const gridLayout = useMemo(() => resolveArtistGridLayout({
    containerWidth: availableGridContentWidth,
    itemCount: genres.length,
    minColumnWidth,
    gap
  }), [availableGridContentWidth, gap, genres.length, minColumnWidth])

  const handleGridResize = useCallback(() => {
    const element = gridApiRef.current?.element
    if (!element) return

    if (element.scrollLeft !== 0) {
      element.scrollLeft = 0
    }

    const nextWidth = resolveVirtualGridContentWidth(element.clientWidth, horizontalInset)
    if (nextWidth <= 0) return
    setGridContentWidth((previous) => (previous === nextWidth ? previous : nextWidth))
  }, [horizontalInset])

  useLayoutEffect(() => {
    const element = gridApiRef.current?.element
    if (element && element.scrollLeft !== 0) {
      element.scrollLeft = 0
    }
  }, [gridLayout.columnCount, gridLayout.columnWidth])

  const rowHeight = GENRE_CARD_HEIGHT_ESTIMATE_PX + gap

  const cellProps = useMemo<GenreGridCellSharedProps>(() => ({
    genres,
    columnCount: gridLayout.columnCount,
    onSelectGenre,
    searchQuery
  }), [genres, gridLayout.columnCount, onSelectGenre, searchQuery])

  useEffect(() => {
    const group = bodyRef.current
    if (!group) return

    let frameId = 0
    const handleVirtualMove = (rawEvent: Event): void => {
      const event = rawEvent as CustomEvent<ControllerVirtualMoveDetail>
      const step = gridLayout.columnCount
      const nextIndex = event.detail.currentIndex + (event.detail.direction === 'up' ? -step : step)
      if (nextIndex < 0 || nextIndex >= genres.length) return
      event.preventDefault()

      gridApiRef.current?.scrollToRow({
        index: Math.floor(nextIndex / gridLayout.columnCount),
        align: 'center',
        behavior: 'auto'
      })

      let attempts = 8
      const focusMountedGenre = (): void => {
        const target = bodyRef.current?.querySelector<HTMLElement>(
          `[data-controller-focusable="true"][data-controller-index="${nextIndex}"]`
        )
        if (target) {
          focusControllerTarget(target)
          return
        }
        attempts -= 1
        if (attempts > 0) frameId = window.requestAnimationFrame(focusMountedGenre)
      }
      frameId = window.requestAnimationFrame(focusMountedGenre)
    }

    group.addEventListener(CONTROLLER_VIRTUAL_MOVE_EVENT, handleVirtualMove)
    return () => {
      window.cancelAnimationFrame(frameId)
      group.removeEventListener(CONTROLLER_VIRTUAL_MOVE_EVENT, handleVirtualMove)
    }
  }, [genres.length, gridLayout.columnCount])

  const viewportHeight = viewportSize.height > 0 ? viewportSize.height : rowHeight

  if (genres.length === 0) {
    return null
  }

  return (
    <div
      className="genre-grid-shell"
      ref={bodyRef}
      data-controller-scroll
      data-controller-group="library-genres"
      data-controller-axis="grid"
      data-controller-virtual="true"
    >
      <Grid
        cellComponent={GenreGridCell}
        cellProps={cellProps}
        className="genre-grid-virtualized"
        columnCount={gridLayout.columnCount}
        columnWidth={gridLayout.columnWidth}
        defaultHeight={GENRE_CARD_HEIGHT_ESTIMATE_PX * 4}
        defaultWidth={GENRE_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX * 3}
        gridRef={gridApiRef}
        onResize={handleGridResize}
        overscanCount={GENRE_GRID_OVERSCAN_COUNT}
        rowCount={gridLayout.rowCount}
        rowHeight={rowHeight}
        style={{
          height: viewportHeight,
          width: '100%',
          overflowX: 'hidden',
          overflowY: 'auto'
        }}
      />
    </div>
  )
}
