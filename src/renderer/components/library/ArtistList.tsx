import { CSSProperties, memo, ReactElement, Ref, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { List, ListImperativeAPI, RowComponentProps } from 'react-window'
import AlbumArtwork from './AlbumArtwork'

interface ArtistRecord {
  artist: string
  track_count: number
  artwork_hash: string | null
}

interface ArtistListProps {
  artists: ArtistRecord[]
  onSelectArtist: (artist: string) => void | Promise<void>
  listRef?: Ref<ListImperativeAPI>
}

interface ArtistListRowSharedProps {
  artists: ArtistRecord[]
  onSelectArtist: (artist: string) => void | Promise<void>
}

const ARTIST_ROW_HEIGHT_FALLBACK_PX = 64
const ARTIST_LIST_OVERSCAN_COUNT = 8

function resolveArtistRowHeightPx(element: HTMLElement | null): number {
  if (!element) return ARTIST_ROW_HEIGHT_FALLBACK_PX

  const cssValue = getComputedStyle(element).getPropertyValue('--artist-row-height').trim()
  const parsed = Number.parseFloat(cssValue)
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed)
  }

  return ARTIST_ROW_HEIGHT_FALLBACK_PX
}

function ArtistListRowRenderer({
  ariaAttributes,
  index,
  style,
  artists,
  onSelectArtist
}: RowComponentProps<ArtistListRowSharedProps>): ReactElement | null {
  const artist = artists[index]
  if (!artist) return null

  return (
    <div className="artist-list-item" style={style as CSSProperties} {...ariaAttributes}>
      <div
        className="artist-item"
        onClick={() => {
          void onSelectArtist(artist.artist)
        }}
      >
        <div className="artist-avatar">
          {artist.artwork_hash ? (
            <AlbumArtwork hash={artist.artwork_hash} alt={`${artist.artist} artwork`} className="artist-avatar-artwork" />
          ) : (
            artist.artist.charAt(0).toUpperCase()
          )}
        </div>
        <div className="artist-info">
          <div className="artist-name">{artist.artist}</div>
          <div className="artist-track-count">{artist.track_count} tracks</div>
        </div>
      </div>
    </div>
  )
}

const ArtistListRow = memo(ArtistListRowRenderer) as (
  props: RowComponentProps<ArtistListRowSharedProps>
) => ReactElement | null

export default function ArtistList({ artists, onSelectArtist, listRef }: ArtistListProps) {
  const [listViewportHeight, setListViewportHeight] = useState(0)
  const [artistRowHeight, setArtistRowHeight] = useState(ARTIST_ROW_HEIGHT_FALLBACK_PX)
  const listBodyRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const element = listBodyRef.current
    if (!element) return

    const updateMeasurements = () => {
      const nextHeight = Math.max(0, Math.round(element.clientHeight))
      const nextRowHeight = resolveArtistRowHeightPx(element)

      setListViewportHeight((previous) => (previous === nextHeight ? previous : nextHeight))
      setArtistRowHeight((previous) => (previous === nextRowHeight ? previous : nextRowHeight))
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
    onSelectArtist
  }), [artists, onSelectArtist])

  const listHeight = listViewportHeight > 0 ? listViewportHeight : artistRowHeight

  if (artists.length === 0) {
    return null
  }

  return (
    <div className="artist-list" ref={listBodyRef}>
      <List
        className="artist-list-virtualized"
        defaultHeight={ARTIST_ROW_HEIGHT_FALLBACK_PX * 8}
        listRef={listRef}
        overscanCount={ARTIST_LIST_OVERSCAN_COUNT}
        rowComponent={ArtistListRow}
        rowCount={artists.length}
        rowHeight={artistRowHeight}
        rowProps={rowProps}
        style={{ height: listHeight, width: '100%' }}
      />
    </div>
  )
}
