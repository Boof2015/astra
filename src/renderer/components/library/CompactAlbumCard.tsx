import { memo, type CSSProperties } from 'react'
import { highlightSearchMatch } from '../../utils/searchHighlight'
import type { AlbumPlaybackTarget } from '../../utils/libraryCardPlayback'
import type { HomePlaybackControlState } from '../home/HomePlaybackControl'
import LibraryCardPlaybackControl from './LibraryCardPlaybackControl'
import AlbumArtwork from './AlbumArtwork'
import HoverRevealText from '../common/HoverRevealText'
import { useHoverRevealCard } from '../../hooks/useHoverRevealCard'

export interface CompactAlbumRecord extends AlbumPlaybackTarget {
  year: number | null
  artwork_hash: string | null
  track_count: number
  is_new: boolean
}

interface CompactAlbumCardProps {
  album: CompactAlbumRecord
  density: 'grid' | 'discography'
  playback: HomePlaybackControlState
  onOpen: (album: CompactAlbumRecord) => void
  onPlay: (album: CompactAlbumRecord) => void
  onContextMenu: (album: CompactAlbumRecord, x: number, y: number) => void
  searchQuery?: string
  controllerIndex?: number
  style?: CSSProperties
}

function CompactAlbumCard({ album, density, playback, onOpen, onPlay, onContextMenu, searchQuery = '', controllerIndex, style }: CompactAlbumCardProps) {
  const reveal = useHoverRevealCard(`${album.identity_key}:${searchQuery}`)
  return (
    <article
      {...reveal.cardProps}
      className={`compact-album-card compact-album-card--${density} ${density === 'grid' ? 'album-card' : 'library-artist-rail-card'}${playback.playing || playback.pending ? ' has-playback-indicator' : ''}`}
      style={style}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onContextMenu(album, event.clientX, event.clientY)
      }}
    >
      <button
        type="button"
        className="compact-album-open"
        aria-label={`Open ${album.album} by ${album.artist}`}
        title={reveal.reducedMotion ? `${album.album} — ${album.artist}` : undefined}
        data-controller-focusable="true"
        data-controller-context="true"
        data-controller-key={`album:${album.identity_key}`}
        data-controller-index={controllerIndex}
        data-controller-action="open"
        onClick={() => onOpen(album)}
      >
        <span className="compact-album-artwork">
          <AlbumArtwork hash={album.artwork_hash} alt="" variant="card" virtualized={density === 'grid'} />
        </span>
        <span className="compact-album-info">
          <HoverRevealText className="compact-album-title" text={album.album} {...reveal.textProps}>{highlightSearchMatch(album.album, searchQuery)}</HoverRevealText>
          <HoverRevealText className="compact-album-artist" text={album.artist} {...reveal.textProps}>{highlightSearchMatch(album.artist, searchQuery)}</HoverRevealText>
          <span className="compact-album-meta">{album.track_count} {album.track_count === 1 ? 'track' : 'tracks'}{album.year ? ` · ${album.year}` : ''}</span>
        </span>
      </button>
      <span className="compact-album-playback-anchor">
        <LibraryCardPlaybackControl
          className="compact-album-playback"
          title={`${album.album} by ${album.artist}`}
          state={playback}
          onPlay={() => onPlay(album)}
          controllerKey={`album:${album.identity_key}`}
          controllerIndex={controllerIndex}
          contextMenu
        />
      </span>
      {album.is_new && (
        <span className="library-latest-sync-pill album-card-sync-pill" title="Added in latest library sync">NEW</span>
      )}
    </article>
  )
}

export default memo(CompactAlbumCard)
