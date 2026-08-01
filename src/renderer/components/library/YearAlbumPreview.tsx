import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { highlightSearchMatch } from '../../utils/searchHighlight'
import { resolveYearAlbumPreviewLayout } from '../../utils/yearAlbumPreview'
import AlbumArtwork from './AlbumArtwork'

export interface YearAlbumPreviewRecord {
  identity_key: string
  album: string
  artist: string
  year: number | null
  artwork_hash: string | null
  track_count: number
  is_new: boolean
}

interface YearAlbumPreviewProps {
  albums: YearAlbumPreviewRecord[]
  onSelectAlbum: (album: YearAlbumPreviewRecord) => void
  onAlbumContextMenu: (album: YearAlbumPreviewRecord, x: number, y: number) => void
  searchQuery?: string
  emptyMessage: string
}

function formatAlbumCount(count: number): string {
  return `${count} ${count === 1 ? 'album' : 'albums'}`
}

function formatTrackCount(count: number): string {
  return `${count} ${count === 1 ? 'track' : 'tracks'}`
}

export default function YearAlbumPreview({
  albums,
  onSelectAlbum,
  onAlbumContextMenu,
  searchQuery = '',
  emptyMessage
}: YearAlbumPreviewProps) {
  const [containerWidth, setContainerWidth] = useState(0)
  const [isExpanded, setIsExpanded] = useState(false)
  const gridRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const element = gridRef.current
    if (!element) return

    const updateWidth = () => {
      const nextWidth = Math.max(0, Math.round(element.clientWidth))
      setContainerWidth((previous) => (previous === nextWidth ? previous : nextWidth))
    }

    updateWidth()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth)
      return () => {
        window.removeEventListener('resize', updateWidth)
      }
    }

    const resizeObserver = new ResizeObserver(updateWidth)
    resizeObserver.observe(element)

    return () => {
      resizeObserver.disconnect()
    }
  }, [])

  const layout = useMemo(() => resolveYearAlbumPreviewLayout({
    containerWidth,
    itemCount: albums.length
  }), [albums.length, containerWidth])
  const visibleAlbums = isExpanded ? albums : albums.slice(0, layout.collapsedItemCount)
  const hiddenAlbumCount = Math.max(0, albums.length - layout.collapsedItemCount)

  return (
    <section className="year-detail-section year-detail-albums" aria-labelledby="year-detail-albums-heading">
      <div className="year-detail-section-header">
        <div className="year-detail-section-heading-row">
          <h3 id="year-detail-albums-heading">Albums</h3>
          <span>{formatAlbumCount(albums.length)}</span>
        </div>
        {layout.hasOverflow && (
          <button
            type="button"
            className="year-album-preview-toggle"
            data-controller-focusable="true"
            data-controller-key="year-albums:toggle"
            aria-expanded={isExpanded}
            onClick={() => setIsExpanded((expanded) => !expanded)}
          >
            {isExpanded ? 'Show less' : `Show all (+${hiddenAlbumCount})`}
          </button>
        )}
      </div>

      <div
        ref={gridRef}
        className="year-album-preview-grid"
        style={{ gridTemplateColumns: `repeat(${layout.columnCount}, minmax(0, 1fr))` }}
        data-controller-scroll
        data-controller-group="year-albums"
        data-controller-axis="grid"
        data-controller-auto-items="true"
      >
        {albums.length > 0 ? (
          visibleAlbums.map((album, index) => (
            <button
              key={album.identity_key}
              type="button"
              className={`year-album-preview-card ${album.is_new ? 'is-new' : ''} ${
                isExpanded && index >= layout.collapsedItemCount ? 'is-expansion-reveal' : ''
              }`}
              style={isExpanded && index >= layout.collapsedItemCount
                ? { animationDelay: `${Math.min(index - layout.collapsedItemCount, 8) * 18}ms` } as CSSProperties
                : undefined}
              data-controller-focusable="true"
              data-controller-context="true"
              data-controller-key={`album:${album.identity_key}`}
              data-controller-index={index}
              onClick={() => onSelectAlbum(album)}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onAlbumContextMenu(album, event.clientX, event.clientY)
              }}
            >
              {album.is_new && (
                <span className="library-latest-sync-pill year-album-preview-sync-pill" title="Added in latest library sync">
                  NEW
                </span>
              )}
              <div className="year-album-preview-artwork">
                <AlbumArtwork hash={album.artwork_hash} alt={album.album} variant="thumbnail" />
              </div>
              <div className="year-album-preview-info">
                <div className="year-album-preview-title">
                  {highlightSearchMatch(album.album, searchQuery)}
                </div>
                <div className="year-album-preview-artist">
                  {highlightSearchMatch(album.artist, searchQuery)}
                </div>
                <div className="year-album-preview-meta">
                  {formatTrackCount(album.track_count)}{album.year ? ` · ${album.year}` : ''}
                </div>
              </div>
            </button>
          ))
        ) : (
          <div className="year-detail-section-empty">{emptyMessage}</div>
        )}
      </div>
    </section>
  )
}
