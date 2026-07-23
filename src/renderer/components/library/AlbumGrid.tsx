import { CSSProperties, memo, ReactElement, Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Grid, type CellComponentProps, type GridImperativeAPI } from 'react-window'
import { resolveArtistGridLayout } from '../../utils/artistGridLayout'
import { highlightSearchMatch } from '../../utils/searchHighlight'
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

interface AlbumRecord {
  identity_key: string
  album: string
  artist: string
  year: number | null
  artwork_hash: string | null
  track_count: number
  is_new: boolean
}

export interface AlbumGridViewportAPI {
  get element(): HTMLDivElement | null
}

interface AlbumGridProps {
  albums: AlbumRecord[]
  onSelectAlbum: (album: AlbumRecord) => void
  onAlbumContextMenu: (album: AlbumRecord, x: number, y: number) => void
  viewportRef?: Ref<AlbumGridViewportAPI>
  searchQuery?: string
}

interface AlbumGridCellSharedProps {
  albums: AlbumRecord[]
  columnCount: number
  onSelectAlbum: (album: AlbumRecord) => void
  onAlbumContextMenu: (album: AlbumRecord, x: number, y: number) => void
  searchQuery: string
}

const ALBUM_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX = 160
const ALBUM_GRID_GAP_FALLBACK_PX = 14
const ALBUM_GRID_PADDING_FALLBACK_PX = 14
const ALBUM_GRID_OVERSCAN_COUNT = 3
// Card chrome that stacks on top of the square artwork: card padding + borders
// + artwork margin + three single-line info rows. Only used until the first
// mounted card is measured.
const ALBUM_CARD_NON_ARTWORK_HEIGHT_ESTIMATE_PX = 91

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

function AlbumGridCellRenderer({
  ariaAttributes,
  columnIndex,
  rowIndex,
  style,
  albums,
  columnCount,
  onSelectAlbum,
  onAlbumContextMenu,
  searchQuery
}: CellComponentProps<AlbumGridCellSharedProps>): ReactElement | null {
  const albumIndex = (rowIndex * columnCount) + columnIndex
  const album = albums[albumIndex]

  if (!album) {
    return <div className="album-grid-cell album-grid-cell-empty" style={style as CSSProperties} {...ariaAttributes} />
  }

  return (
    <div className="album-grid-cell" style={style as CSSProperties} {...ariaAttributes}>
      <div
        className="album-card"
        data-controller-focusable="true"
        data-controller-context="true"
        data-controller-key={`album:${album.identity_key}`}
        data-controller-index={albumIndex}
        tabIndex={-1}
        role="button"
        aria-label={`Open ${album.album} by ${album.artist}`}
        onClick={() => {
          onSelectAlbum(album)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onAlbumContextMenu(album, event.clientX, event.clientY)
        }}
      >
        {album.is_new && (
          <span className="library-latest-sync-pill album-card-sync-pill" title="Added in latest library sync">
            NEW
          </span>
        )}
        <div className="album-artwork">
          <AlbumArtwork hash={album.artwork_hash} alt={album.album} variant="card" />
        </div>
        <div className="album-info">
          <div className="album-title">{highlightSearchMatch(album.album, searchQuery)}</div>
          <div className="album-artist">{highlightSearchMatch(album.artist, searchQuery)}</div>
          <div className="album-meta">{formatTrackCount(album.track_count)}{album.year ? ` • ${album.year}` : ''}</div>
        </div>
      </div>
    </div>
  )
}

const AlbumGridCell = memo(AlbumGridCellRenderer) as (
  props: CellComponentProps<AlbumGridCellSharedProps>
) => ReactElement | null

export default function AlbumGrid({
  albums,
  onSelectAlbum,
  onAlbumContextMenu,
  viewportRef,
  searchQuery = ''
}: AlbumGridProps) {
  const [viewportSize, setViewportSize] = useState({ height: 0, width: 0 })
  const [gridContentWidth, setGridContentWidth] = useState(0)
  const [minColumnWidth, setMinColumnWidth] = useState(ALBUM_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX)
  const [gap, setGap] = useState(ALBUM_GRID_GAP_FALLBACK_PX)
  const [padding, setPadding] = useState(ALBUM_GRID_PADDING_FALLBACK_PX)
  const [measuredCardHeight, setMeasuredCardHeight] = useState<number | null>(null)
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
      const nextMinColumnWidth = resolveCssPx(element, '--album-grid-min-column-width', ALBUM_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX)
      const nextGap = resolveCssPx(element, '--album-grid-gap', ALBUM_GRID_GAP_FALLBACK_PX)
      const nextPadding = resolveCssPx(element, '--album-grid-padding', ALBUM_GRID_PADDING_FALLBACK_PX)

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
    itemCount: albums.length,
    minColumnWidth,
    gap
  }), [albums.length, availableGridContentWidth, gap, minColumnWidth])

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

  // Card height tracks column width (square artwork), so measure a mounted
  // card instead of hardcoding font metrics; falls back to an estimate for
  // the first frame only.
  const measureCardHeight = useCallback(() => {
    const card = bodyRef.current?.querySelector<HTMLElement>('.album-card')
    if (!card) return
    const nextHeight = card.offsetHeight
    if (nextHeight <= 0) return
    setMeasuredCardHeight((previous) => (previous === nextHeight ? previous : nextHeight))
  }, [])

  useLayoutEffect(() => {
    measureCardHeight()
  }, [gridLayout.columnWidth, measureCardHeight, viewportSize.height])

  useEffect(() => {
    let cancelled = false
    document.fonts?.ready?.then(() => {
      if (!cancelled) measureCardHeight()
    }).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [measureCardHeight])

  const cardHeightEstimate = Math.max(1, gridLayout.columnWidth - gap) + ALBUM_CARD_NON_ARTWORK_HEIGHT_ESTIMATE_PX
  const rowHeight = (measuredCardHeight ?? cardHeightEstimate) + gap

  const cellProps = useMemo<AlbumGridCellSharedProps>(() => ({
    albums,
    columnCount: gridLayout.columnCount,
    onSelectAlbum,
    onAlbumContextMenu,
    searchQuery
  }), [albums, gridLayout.columnCount, onAlbumContextMenu, onSelectAlbum, searchQuery])

  useEffect(() => {
    const group = bodyRef.current
    if (!group) return

    let frameId = 0
    const handleVirtualMove = (rawEvent: Event): void => {
      const event = rawEvent as CustomEvent<ControllerVirtualMoveDetail>
      const step = gridLayout.columnCount
      const nextIndex = event.detail.currentIndex + (event.detail.direction === 'up' ? -step : step)
      if (nextIndex < 0 || nextIndex >= albums.length) return
      event.preventDefault()

      gridApiRef.current?.scrollToRow({
        index: Math.floor(nextIndex / gridLayout.columnCount),
        align: 'center',
        behavior: 'auto'
      })

      let attempts = 8
      const focusMountedAlbum = (): void => {
        const target = bodyRef.current?.querySelector<HTMLElement>(
          `[data-controller-focusable="true"][data-controller-index="${nextIndex}"]`
        )
        if (target) {
          focusControllerTarget(target)
          return
        }
        attempts -= 1
        if (attempts > 0) frameId = window.requestAnimationFrame(focusMountedAlbum)
      }
      frameId = window.requestAnimationFrame(focusMountedAlbum)
    }

    group.addEventListener(CONTROLLER_VIRTUAL_MOVE_EVENT, handleVirtualMove)
    return () => {
      window.cancelAnimationFrame(frameId)
      group.removeEventListener(CONTROLLER_VIRTUAL_MOVE_EVENT, handleVirtualMove)
    }
  }, [albums.length, gridLayout.columnCount])

  const viewportHeight = viewportSize.height > 0 ? viewportSize.height : rowHeight

  if (albums.length === 0) {
    return null
  }

  return (
    <div
      className="album-grid-shell"
      ref={bodyRef}
      data-controller-scroll
      data-controller-group="library-albums"
      data-controller-axis="grid"
      data-controller-virtual="true"
    >
      <Grid
        cellComponent={AlbumGridCell}
        cellProps={cellProps}
        className="album-grid-virtualized"
        columnCount={gridLayout.columnCount}
        columnWidth={gridLayout.columnWidth}
        defaultHeight={ALBUM_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX * 3}
        defaultWidth={ALBUM_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX * 4}
        gridRef={gridApiRef}
        onResize={handleGridResize}
        overscanCount={ALBUM_GRID_OVERSCAN_COUNT}
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
