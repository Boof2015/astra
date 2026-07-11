import { Ref, useImperativeHandle, useRef } from 'react'
import { normalizeKey } from '../../utils/albumIdentity'
import { highlightSearchMatch } from '../../utils/searchHighlight'
import type { LibraryYearGroup } from '../../utils/libraryYears'
import AlbumArtwork from './AlbumArtwork'

export interface YearGridViewportAPI {
  get element(): HTMLDivElement | null
}

interface YearGridProps {
  years: LibraryYearGroup[]
  onSelectYear: (year: LibraryYearGroup) => void
  viewportRef?: Ref<YearGridViewportAPI>
  searchQuery?: string
}

function formatAlbumCount(count: number): string {
  return `${count} ${count === 1 ? 'album' : 'albums'}`
}

function formatTrackCount(count: number): string {
  return `${count} ${count === 1 ? 'track' : 'tracks'}`
}

export default function YearGrid({
  years,
  onSelectYear,
  viewportRef,
  searchQuery = ''
}: YearGridProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null)

  useImperativeHandle(viewportRef, () => ({
    get element() {
      return bodyRef.current
    }
  }), [])

  return (
    <div
      ref={bodyRef}
      className="year-grid"
      data-controller-scroll
      data-controller-group="library-years"
      data-controller-axis="grid"
      data-controller-auto-items="true"
    >
      {years.map((year, index) => (
        <button
          key={year.key}
          type="button"
          className="year-card"
          data-controller-focusable="true"
          data-controller-key={`year:${normalizeKey(year.label)}`}
          data-controller-index={index}
          onClick={() => onSelectYear(year)}
        >
          <div className="year-card-artwork">
            {year.artwork_hash ? (
              <AlbumArtwork hash={year.artwork_hash} alt={year.label} variant="thumbnail" />
            ) : (
              <span aria-hidden="true">{year.key === 'unknown' ? '?' : year.key}</span>
            )}
          </div>
          <div className="year-card-info">
            <div className="year-card-title">{highlightSearchMatch(year.label, searchQuery)}</div>
            <div className="year-card-meta">
              {formatAlbumCount(year.album_count)} · {formatTrackCount(year.track_count)}
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}
