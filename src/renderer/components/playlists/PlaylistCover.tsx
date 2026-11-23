import ArtworkImage from '../library/ArtworkImage'

interface PlaylistCoverProps {
  hash: string | null
  name: string
  isFavorites?: boolean
  className?: string
}

function PlaylistIcon({ favorites }: { favorites: boolean }) {
  return favorites ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )
}

export default function PlaylistCover({
  hash,
  name,
  isFavorites = false,
  className = ''
}: PlaylistCoverProps) {
  return (
    <div className={`playlist-cover ${isFavorites ? 'is-favorites' : ''} ${className}`.trim()}>
      <ArtworkImage hash={isFavorites ? null : hash} variant="card" alt={`${name} cover`}
        className="playlist-cover-image" placeholderClassName="playlist-cover-fallback">
        <PlaylistIcon favorites={isFavorites} />
      </ArtworkImage>
    </div>
  )
}
