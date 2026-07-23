import { CSSProperties, memo, ReactElement, Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Grid, List, type CellComponentProps, type GridImperativeAPI, type ListImperativeAPI, type RowComponentProps } from 'react-window'
import type { ArtworkVariant } from '../../stores/libraryStore'
import { resolveArtistGridLayout } from '../../utils/artistGridLayout'
import { highlightSearchMatch } from '../../utils/searchHighlight'
import AlbumArtwork from './AlbumArtwork'
import {
  CONTROLLER_VIRTUAL_MOVE_EVENT,
  focusControllerTarget,
  type ControllerVirtualMoveDetail
} from '../../utils/controllerFocus'
import { resolveVirtualGridContentWidth } from '../../utils/virtualGridSizing'

interface ArtistRecord {
  artist: string
  track_count: number
  album_count: number
  artwork_hash: string | null
}

export type ArtistListViewMode = 'list' | 'grid'

export interface ArtistListViewportAPI {
  get element(): HTMLDivElement | null
}

interface ArtistListProps {
  artists: ArtistRecord[]
  onSelectArtist: (artist: string) => void | Promise<void>
  viewMode?: ArtistListViewMode
  viewportRef?: Ref<ArtistListViewportAPI>
  searchQuery?: string
}

interface ArtistListRowSharedProps {
  artists: ArtistRecord[]
  onSelectArtist: (artist: string) => void | Promise<void>
  searchQuery: string
}

interface ArtistGridCellSharedProps {
  artists: ArtistRecord[]
  columnCount: number
  onSelectArtist: (artist: string) => void | Promise<void>
  searchQuery: string
}

const ARTIST_ROW_HEIGHT_FALLBACK_PX = 64
const ARTIST_LIST_OVERSCAN_COUNT = 8
const ARTIST_GRID_ROW_HEIGHT_FALLBACK_PX = 168
const ARTIST_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX = 124
const ARTIST_GRID_GAP_FALLBACK_PX = 12
const ARTIST_GRID_OVERSCAN_COUNT = 3

function resolveCssPx(element: HTMLElement | null, propertyName: string, fallback: number): number {
  if (!element) return fallback

  const cssValue = getComputedStyle(element).getPropertyValue(propertyName).trim()
  const parsed = Number.parseFloat(cssValue)
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed)
  }

  return fallback
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function formatArtistLibrarySummary(artist: ArtistRecord): string {
  const trackCount = formatCount(artist.track_count, 'track', 'tracks')
  if (artist.album_count === 0) return trackCount
  return `${trackCount} · ${formatCount(artist.album_count, 'album', 'albums')}`
}

function getArtistInitial(artist: string): string {
  return artist.trim().charAt(0).toUpperCase()
}

function ArtistAvatar({
  artist,
  className,
  artworkClassName,
  artworkVariant = 'thumbnail'
}: {
  artist: ArtistRecord
  className: string
  artworkClassName: string
  artworkVariant?: ArtworkVariant
}): ReactElement {
  return (
    <div className={className}>
      {artist.artwork_hash ? (
        <AlbumArtwork
          hash={artist.artwork_hash}
          alt={`${artist.artist} artwork`}
          className={artworkClassName}
          variant={artworkVariant}
        />
      ) : (
        getArtistInitial(artist.artist)
      )}
    </div>
  )
}

function ArtistListRowRenderer({
  ariaAttributes,
  index,
  style,
  artists,
  onSelectArtist,
  searchQuery
}: RowComponentProps<ArtistListRowSharedProps>): ReactElement | null {
  const artist = artists[index]
  if (!artist) return null

  return (
    <div className="artist-list-item" style={style as CSSProperties} {...ariaAttributes}>
      <div
        className="artist-item"
        data-controller-focusable="true"
        data-controller-key={`artist:${artist.artist}`}
        data-controller-index={index}
        tabIndex={-1}
        role="button"
        aria-label={`Open ${artist.artist}`}
        onClick={() => {
          void onSelectArtist(artist.artist)
        }}
      >
        <ArtistAvatar
          artist={artist}
          className="artist-avatar"
          artworkClassName="artist-avatar-artwork"
        />
        <div className="artist-info">
          <div className="artist-name">{highlightSearchMatch(artist.artist, searchQuery)}</div>
          <div className="artist-track-count">{formatArtistLibrarySummary(artist)}</div>
        </div>
      </div>
    </div>
  )
}

const ArtistListRow = memo(ArtistListRowRenderer) as (
  props: RowComponentProps<ArtistListRowSharedProps>
) => ReactElement | null

function ArtistGridCellRenderer({
  ariaAttributes,
  columnIndex,
  rowIndex,
  style,
  artists,
  columnCount,
  onSelectArtist,
  searchQuery
}: CellComponentProps<ArtistGridCellSharedProps>): ReactElement | null {
  const artist = artists[(rowIndex * columnCount) + columnIndex]
  const artistIndex = (rowIndex * columnCount) + columnIndex

  if (!artist) {
    return <div className="artist-grid-cell artist-grid-cell-empty" style={style as CSSProperties} {...ariaAttributes} />
  }

  return (
    <div className="artist-grid-cell" style={style as CSSProperties} {...ariaAttributes}>
      <button
        type="button"
        className="artist-grid-card"
        data-controller-focusable="true"
        data-controller-key={`artist:${artist.artist}`}
        data-controller-index={artistIndex}
        onClick={() => {
          void onSelectArtist(artist.artist)
        }}
      >
        <ArtistAvatar
          artist={artist}
          className="artist-grid-avatar"
          artworkClassName="artist-grid-avatar-artwork"
          artworkVariant="card"
        />
        <div className="artist-grid-info">
          <div className="artist-grid-name">{highlightSearchMatch(artist.artist, searchQuery)}</div>
          <div className="artist-grid-track-count">{formatArtistLibrarySummary(artist)}</div>
        </div>
      </button>
    </div>
  )
}

const ArtistGridCell = memo(ArtistGridCellRenderer) as (
  props: CellComponentProps<ArtistGridCellSharedProps>
) => ReactElement | null

export default function ArtistList({
  artists,
  onSelectArtist,
  viewMode = 'list',
  viewportRef,
  searchQuery = ''
}: ArtistListProps) {
  const [viewportSize, setViewportSize] = useState({ height: 0, width: 0 })
  const [gridContentWidth, setGridContentWidth] = useState(0)
  const [artistRowHeight, setArtistRowHeight] = useState(ARTIST_ROW_HEIGHT_FALLBACK_PX)
  const [artistGridRowHeight, setArtistGridRowHeight] = useState(ARTIST_GRID_ROW_HEIGHT_FALLBACK_PX)
  const [artistGridMinColumnWidth, setArtistGridMinColumnWidth] = useState(ARTIST_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX)
  const [artistGridGap, setArtistGridGap] = useState(ARTIST_GRID_GAP_FALLBACK_PX)
  const listBodyRef = useRef<HTMLDivElement | null>(null)
  const listApiRef = useRef<ListImperativeAPI | null>(null)
  const gridApiRef = useRef<GridImperativeAPI | null>(null)

  useImperativeHandle(viewportRef, () => ({
    get element() {
      return viewMode === 'grid'
        ? gridApiRef.current?.element ?? null
        : listApiRef.current?.element ?? null
    }
  }), [viewMode])

  useLayoutEffect(() => {
    const element = listBodyRef.current
    if (!element) return

    const updateMeasurements = () => {
      const nextHeight = Math.max(0, Math.round(element.clientHeight))
      const nextWidth = Math.max(0, Math.round(element.clientWidth))
      const nextRowHeight = resolveCssPx(element, '--artist-row-height', ARTIST_ROW_HEIGHT_FALLBACK_PX)
      const nextGridRowHeight = resolveCssPx(element, '--artist-grid-row-height', ARTIST_GRID_ROW_HEIGHT_FALLBACK_PX)
      const nextGridMinColumnWidth = resolveCssPx(element, '--artist-grid-min-column-width', ARTIST_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX)
      const nextGridGap = resolveCssPx(element, '--artist-grid-gap', ARTIST_GRID_GAP_FALLBACK_PX)

      setViewportSize((previous) => (
        previous.height === nextHeight && previous.width === nextWidth
          ? previous
          : { height: nextHeight, width: nextWidth }
      ))
      setArtistRowHeight((previous) => (previous === nextRowHeight ? previous : nextRowHeight))
      setArtistGridRowHeight((previous) => (previous === nextGridRowHeight ? previous : nextGridRowHeight))
      setArtistGridMinColumnWidth((previous) => (previous === nextGridMinColumnWidth ? previous : nextGridMinColumnWidth))
      setArtistGridGap((previous) => (previous === nextGridGap ? previous : nextGridGap))
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

  const rowProps = useMemo<ArtistListRowSharedProps>(() => ({
    artists,
    onSelectArtist,
    searchQuery
  }), [artists, onSelectArtist, searchQuery])

  const availableGridContentWidth = gridContentWidth > 0 ? gridContentWidth : viewportSize.width
  const gridLayout = useMemo(() => resolveArtistGridLayout({
    containerWidth: availableGridContentWidth,
    itemCount: artists.length,
    minColumnWidth: artistGridMinColumnWidth,
    gap: artistGridGap
  }), [artistGridGap, artistGridMinColumnWidth, artists.length, availableGridContentWidth])

  const handleGridResize = useCallback(() => {
    const element = gridApiRef.current?.element
    if (!element) return

    if (element.scrollLeft !== 0) {
      element.scrollLeft = 0
    }

    const nextWidth = resolveVirtualGridContentWidth(element.clientWidth)
    if (nextWidth <= 0) return
    setGridContentWidth((previous) => (previous === nextWidth ? previous : nextWidth))
  }, [])

  useLayoutEffect(() => {
    const element = gridApiRef.current?.element
    if (element && element.scrollLeft !== 0) {
      element.scrollLeft = 0
    }
  }, [gridLayout.columnCount, gridLayout.columnWidth])

  useEffect(() => {
    if (viewMode !== 'grid') {
      setGridContentWidth(0)
    }
  }, [viewMode])

  const gridProps = useMemo<ArtistGridCellSharedProps>(() => ({
    artists,
    columnCount: gridLayout.columnCount,
    onSelectArtist,
    searchQuery
  }), [artists, gridLayout.columnCount, onSelectArtist, searchQuery])

  useEffect(() => {
    const group = listBodyRef.current
    if (!group) return

    let frameId = 0
    const handleVirtualMove = (rawEvent: Event): void => {
      const event = rawEvent as CustomEvent<ControllerVirtualMoveDetail>
      const step = viewMode === 'grid' ? gridLayout.columnCount : 1
      const nextIndex = event.detail.currentIndex + (event.detail.direction === 'up' ? -step : step)
      if (nextIndex < 0 || nextIndex >= artists.length) return
      event.preventDefault()

      if (viewMode === 'grid') {
        gridApiRef.current?.scrollToRow({
          index: Math.floor(nextIndex / gridLayout.columnCount),
          align: 'center',
          behavior: 'auto'
        })
      } else {
        listApiRef.current?.scrollToRow({ index: nextIndex, align: 'center', behavior: 'auto' })
      }

      let attempts = 8
      const focusMountedArtist = (): void => {
        const target = listBodyRef.current?.querySelector<HTMLElement>(
          `[data-controller-focusable="true"][data-controller-index="${nextIndex}"]`
        )
        if (target) {
          focusControllerTarget(target)
          return
        }
        attempts -= 1
        if (attempts > 0) frameId = window.requestAnimationFrame(focusMountedArtist)
      }
      frameId = window.requestAnimationFrame(focusMountedArtist)
    }

    group.addEventListener(CONTROLLER_VIRTUAL_MOVE_EVENT, handleVirtualMove)
    return () => {
      window.cancelAnimationFrame(frameId)
      group.removeEventListener(CONTROLLER_VIRTUAL_MOVE_EVENT, handleVirtualMove)
    }
  }, [artists.length, gridLayout.columnCount, viewMode])

  const viewportHeight = viewportSize.height > 0 ? viewportSize.height : artistRowHeight

  if (artists.length === 0) {
    return null
  }

  if (viewMode === 'grid') {
    return (
      <div
        className="artist-list artist-list-grid-mode"
        ref={listBodyRef}
        data-controller-scroll
        data-controller-group="library-artists"
        data-controller-axis="grid"
        data-controller-virtual="true"
      >
        <Grid
          cellComponent={ArtistGridCell}
          cellProps={gridProps}
          className="artist-grid"
          columnCount={gridLayout.columnCount}
          columnWidth={gridLayout.columnWidth}
          defaultHeight={ARTIST_GRID_ROW_HEIGHT_FALLBACK_PX * 4}
          defaultWidth={ARTIST_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX * 4}
          gridRef={gridApiRef}
          onResize={handleGridResize}
          overscanCount={ARTIST_GRID_OVERSCAN_COUNT}
          rowCount={gridLayout.rowCount}
          rowHeight={artistGridRowHeight}
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

  return (
    <div
      className="artist-list"
      ref={listBodyRef}
      data-controller-scroll
      data-controller-group="library-artists"
      data-controller-axis="vertical"
      data-controller-virtual="true"
    >
      <List
        className="artist-list-virtualized"
        defaultHeight={ARTIST_ROW_HEIGHT_FALLBACK_PX * 8}
        listRef={listApiRef}
        overscanCount={ARTIST_LIST_OVERSCAN_COUNT}
        rowComponent={ArtistListRow}
        rowCount={artists.length}
        rowHeight={artistRowHeight}
        rowProps={rowProps}
        style={{ height: viewportHeight, width: '100%' }}
      />
    </div>
  )
}
