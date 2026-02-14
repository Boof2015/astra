import { Fragment } from 'react'
import { parseArtistMetadata } from '../../utils/artistMetadata'

interface ArtistNameLinksProps {
  artistText: string
  onArtistClick: (artist: string) => void | Promise<void>
  className?: string
  linkClassName?: string
  stopPropagation?: boolean
}

function joinClasses(...classNames: Array<string | undefined>): string {
  return classNames.filter(Boolean).join(' ')
}

export default function ArtistNameLinks({
  artistText,
  onArtistClick,
  className,
  linkClassName,
  stopPropagation = false
}: ArtistNameLinksProps) {
  const tokens = parseArtistMetadata(artistText)
  const containerClassName = joinClasses('artist-name-links', className)
  const buttonClassName = joinClasses('artist-name-link', linkClassName)

  if (tokens.length === 0) {
    return <span className={containerClassName}>{artistText}</span>
  }

  const handleArtistClick = (event: React.MouseEvent<HTMLButtonElement>, artist: string) => {
    if (stopPropagation) {
      event.stopPropagation()
    }
    void onArtistClick(artist)
  }

  return (
    <span className={containerClassName}>
      {tokens.map((token, index) => (
        <Fragment key={`${token.artist}-${index}`}>
          <button
            type="button"
            className={buttonClassName}
            onClick={(event) => handleArtistClick(event, token.artist)}
            title={`Show tracks by ${token.artist}`}
          >
            {token.artist}
          </button>
          {token.separator && (
            <span className="artist-name-separator" aria-hidden="true">
              {token.separator}
            </span>
          )}
        </Fragment>
      ))}
    </span>
  )
}
