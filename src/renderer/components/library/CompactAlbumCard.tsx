import { memo, type CSSProperties } from 'react'
import { highlightSearchMatch } from '../../utils/searchHighlight'
import type { AlbumPlaybackTarget } from '../../utils/albumCardPlayback'
import { HomePlaybackGlyph, homePlaybackLabel, type HomePlaybackControlState } from '../home/HomePlaybackControl'
import AlbumArtwork from './AlbumArtwork'

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
  const label = homePlaybackLabel(`${album.album} by ${album.artist}`, playback)
  return (
    <article
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
        title={`${album.album} — ${album.artist}`}
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
          <span className="compact-album-title">{highlightSearchMatch(album.album, searchQuery)}</span>
          <span className="compact-album-artist">{highlightSearchMatch(album.artist, searchQuery)}</span>
          <span className="compact-album-meta">{album.track_count} {album.track_count === 1 ? 'track' : 'tracks'}{album.year ? ` · ${album.year}` : ''}</span>
        </span>
      </button>
      <span className="compact-album-playback-anchor">
        <button
          type="button"
          className="compact-album-playback home-playback-control"
          // Native disabled drops keyboard focus during an async playback request.
          aria-disabled={playback.disabled}
          tabIndex={playback.disabled ? -1 : 0}
          aria-label={label}
          aria-busy={playback.pending}
          title={label}
          data-controller-focusable={playback.disabled ? undefined : 'true'}
          data-controller-context="true"
          data-controller-key={`album:${album.identity_key}:play`}
          data-controller-index={controllerIndex}
          data-controller-action="play"
          onClick={() => { if (!playback.disabled) onPlay(album) }}
        >
          <HomePlaybackGlyph state={playback} />
        </button>
      </span>
      {album.is_new && (
        <span className="library-latest-sync-pill album-card-sync-pill" title="Added in latest library sync">NEW</span>
      )}
    </article>
  )
}

export default memo(CompactAlbumCard)
