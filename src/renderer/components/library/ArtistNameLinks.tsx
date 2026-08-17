import { Fragment, memo } from 'react'
import { useLibraryStore, type LibraryArtistBrowseMode } from '../../stores/libraryStore'
import { parseArtistMetadata } from '../../utils/artistMetadata'
import { buildArtistNameTokens } from '../../../shared/library/artistCredits.ts'

interface ArtistNameLinksProps {
  artistText: string
  artistNames?: string[] | null
  browseArtistText?: string | null
  browseArtistNames?: string[] | null
  onArtistClick: (artist: string) => void | Promise<void>
  className?: string
  linkClassName?: string
  stopPropagation?: boolean
}

interface ArtistNameLinksContentProps extends ArtistNameLinksProps {
  artistBrowseMode: LibraryArtistBrowseMode
  artistSplitExceptions?: string[]
}

function joinClasses(...classNames: Array<string | undefined>): string {
  return classNames.filter(Boolean).join(' ')
}

export default function ArtistNameLinks({
  ...props
}: ArtistNameLinksProps) {
  const artistBrowseMode = useLibraryStore((state) => state.artistBrowseMode)
  const artistSplitExceptions = useLibraryStore((state) => state.artistSplitExceptions)
  return <ArtistNameLinksContent {...props} artistBrowseMode={artistBrowseMode} artistSplitExceptions={artistSplitExceptions} />
}

// Virtualized lists can select the browse mode once at the list level instead
// of subscribing every mounted row to the library store.
function ArtistNameLinksContentRenderer({
  artistText,
  artistNames,
  browseArtistText,
  browseArtistNames,
  onArtistClick,
  className,
  linkClassName,
  stopPropagation = false,
  artistBrowseMode,
  artistSplitExceptions = []
}: ArtistNameLinksContentProps) {
  const normalizedArtistText = artistText.replace(/\s+/g, ' ').trim()
  const normalizedBrowseArtistText = (browseArtistText ?? '').replace(/\s+/g, ' ').trim()
  const parsedArtistTokens = artistNames && artistNames.length > 0
    ? buildArtistNameTokens(artistNames)
    : parseArtistMetadata(artistText, artistSplitExceptions)
  const tokens = artistBrowseMode === 'canonical' ? parsedArtistTokens : []
  const containerClassName = joinClasses('artist-name-links', className)
  const buttonClassName = joinClasses('artist-name-link', linkClassName)

  const handleArtistClick = (event: React.MouseEvent<HTMLButtonElement>, artist: string) => {
    if (stopPropagation) {
      event.stopPropagation()
    }
    void onArtistClick(artist)
  }

  if (artistBrowseMode === 'strict') {
    const strictTargetArtist = (browseArtistNames && browseArtistNames.length === 1 ? browseArtistNames[0] : '')
      || normalizedBrowseArtistText
      || normalizedArtistText
    if (!strictTargetArtist) {
      return <span className={containerClassName}>{artistText}</span>
    }

    return (
      <span className={containerClassName}>
        <button
          type="button"
          className={buttonClassName}
          onClick={(event) => handleArtistClick(event, strictTargetArtist)}
          title={`Show tracks by ${strictTargetArtist}`}
        >
          {artistText}
        </button>
      </span>
    )
  }

  if (tokens.length === 0) {
    return <span className={containerClassName}>{artistText}</span>
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

export const ArtistNameLinksContent = memo(ArtistNameLinksContentRenderer)
