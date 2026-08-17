import type { CSSProperties } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'
import { useUIStore } from '../../stores/uiStore'
import AlbumArtwork from './AlbumArtwork'
import { ALBUM_CARD_NON_ARTWORK_HEIGHT_ESTIMATE_PX, ALBUM_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX } from './AlbumGrid'
import {
  ArtistAvatar,
  ARTIST_GRID_AVATAR_HEIGHT_FALLBACK_PX,
  ARTIST_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX,
  ARTIST_GRID_ROW_HEIGHT_FALLBACK_PX
} from './ArtistList'

// Sizing the box for the slider's absolute max (200%) left too much empty space at the common,
// lower-percentage case. Reference a more modest percentage instead — the internal overflow-y:
// auto (see globals.css) takes over above this, so nothing gets clipped, it just scrolls sooner.
const GRID_SCALE_PREVIEW_HEIGHT_REFERENCE_PERCENT = 140

// A little headroom below the card sized at the reference percentage (so the hover
// translateY(-4px) doesn't clip) and above (padding-top in CSS covers that side). Keeps the
// preview box a fixed size regardless of the current scale, so the rest of the card (slider,
// toggle) never moves as it's dragged.
const GRID_SCALE_PREVIEW_HEIGHT_BUFFER_PX = 8

const ALBUM_GRID_PREVIEW_HEIGHT_PX = Math.round(
  ALBUM_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX * (GRID_SCALE_PREVIEW_HEIGHT_REFERENCE_PERCENT / 100)
) + ALBUM_CARD_NON_ARTWORK_HEIGHT_ESTIMATE_PX + GRID_SCALE_PREVIEW_HEIGHT_BUFFER_PX

const ARTIST_GRID_PREVIEW_HEIGHT_PX = Math.round(
  ARTIST_GRID_ROW_HEIGHT_FALLBACK_PX * (GRID_SCALE_PREVIEW_HEIGHT_REFERENCE_PERCENT / 100)
) + GRID_SCALE_PREVIEW_HEIGHT_BUFFER_PX

interface PreviewAlbum {
  key: string
  album: string
  artist: string
  year: number
  track_count: number
}

interface PreviewArtist {
  key: string
  artist: string
  track_count: number
  album_count: number
}

const PREVIEW_ALBUMS: PreviewAlbum[] = [
  { key: 'preview-album-1', album: 'Album Title', artist: 'Artist Name', year: 2024, track_count: 12 },
  { key: 'preview-album-2', album: 'Second Album', artist: 'Another Artist', year: 2021, track_count: 9 },
  { key: 'preview-album-3', album: 'Third Album', artist: 'Third Artist', year: 2019, track_count: 14 }
]

const PREVIEW_ARTISTS: PreviewArtist[] = [
  { key: 'preview-artist-1', artist: 'Artist Name', track_count: 24, album_count: 3 },
  { key: 'preview-artist-2', artist: 'Another Artist', track_count: 18, album_count: 2 },
  { key: 'preview-artist-3', artist: 'Third Artist', track_count: 31, album_count: 5 }
]

function formatTrackCount(count: number): string {
  return `${count} ${count === 1 ? 'track' : 'tracks'}`
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function formatArtistSummary(artist: PreviewArtist): string {
  return `${formatCount(artist.track_count, 'track', 'tracks')} · ${formatCount(artist.album_count, 'album', 'albums')}`
}

// Decorative, non-interactive stand-ins for the real grids' scale sliders — reuse the same CSS
// classes, AlbumArtwork/ArtistAvatar (with artwork_hash: null for their native placeholder), and
// the same base-pixel constants the real override effects scale from, so the preview always
// matches what the grid actually renders at the current slider value.
export function AlbumGridScalePreview() {
  const albumGridScalePercent = useUIStore((state) => state.albumGridScalePercent)
  const showAlbumGridYear = useLibraryStore((state) => state.showAlbumGridYear)
  const cardWidth = Math.round(ALBUM_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX * (albumGridScalePercent / 100))

  return (
    <div
      className="settings-grid-scale-preview"
      style={{ height: `${ALBUM_GRID_PREVIEW_HEIGHT_PX}px` }}
      aria-hidden="true"
    >
      {PREVIEW_ALBUMS.map((album) => (
        <div key={album.key} className="album-card" style={{ width: `${cardWidth}px` }}>
          <div className="album-artwork">
            <AlbumArtwork hash={null} alt={album.album} variant="card" />
          </div>
          <div className="album-info">
            <div className="album-title">{album.album}</div>
            <div className="album-artist">{album.artist}</div>
            <div className="album-meta">
              {formatTrackCount(album.track_count)}{showAlbumGridYear ? ` • ${album.year}` : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function ArtistGridScalePreview() {
  const artistGridScalePercent = useUIStore((state) => state.artistGridScalePercent)
  const scale = artistGridScalePercent / 100
  const cardWidth = Math.round(ARTIST_GRID_MIN_COLUMN_WIDTH_FALLBACK_PX * scale)
  const cardHeight = Math.round(ARTIST_GRID_ROW_HEIGHT_FALLBACK_PX * scale)
  const avatarHeight = Math.round(ARTIST_GRID_AVATAR_HEIGHT_FALLBACK_PX * scale)
  const cardStyle = {
    width: `${cardWidth}px`,
    height: `${cardHeight}px`,
    '--artist-grid-avatar-height': `${avatarHeight}px`
  } as CSSProperties

  return (
    <div
      className="settings-grid-scale-preview"
      style={{ height: `${ARTIST_GRID_PREVIEW_HEIGHT_PX}px` }}
      aria-hidden="true"
    >
      {PREVIEW_ARTISTS.map((artist) => (
        <div key={artist.key} className="artist-grid-card" style={cardStyle}>
          <ArtistAvatar
            artist={{ artist: artist.artist, track_count: artist.track_count, album_count: artist.album_count, artwork_hash: null }}
            className="artist-grid-avatar"
            artworkClassName="artist-grid-avatar-artwork"
            artworkVariant="card"
          />
          <div className="artist-grid-info">
            <div className="artist-grid-name">{artist.artist}</div>
            <div className="artist-grid-track-count">{formatArtistSummary(artist)}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
