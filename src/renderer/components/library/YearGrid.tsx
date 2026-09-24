import { Ref, useImperativeHandle, useRef } from 'react'
import { normalizeKey } from '../../utils/albumIdentity'
import type { LibraryYearGroup } from '../../utils/libraryYears'
import AlbumArtwork from './AlbumArtwork'
import LibraryCollectionCard from './LibraryCollectionCard'
import { getLibraryCardPlaybackState, type LibraryCardPlaybackSnapshot } from '../../utils/libraryCardPlayback'

export interface YearGridViewportAPI {
  get element(): HTMLDivElement | null
}

interface YearGridProps {
  years: LibraryYearGroup[]
  playback: LibraryCardPlaybackSnapshot
  onPlayYear: (year: LibraryYearGroup) => void
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
  playback,
  onPlayYear,
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
      data-controller-action-rows="true"
      data-controller-auto-items="true"
    >
      {years.map((year, index) => (
        <LibraryCollectionCard
          key={year.key}
          className={`year-card${year.key === 'unknown' ? ' year-card--unknown' : ''}`}
          title={year.label}
          subtitle={`${formatAlbumCount(year.album_count)} · ${formatTrackCount(year.track_count)}`}
          searchQuery={searchQuery}
          controllerKey={`year:${normalizeKey(year.label)}`}
          controllerIndex={index}
          onOpen={() => onSelectYear(year)}
          onPlay={() => onPlayYear(year)}
          playback={getLibraryCardPlaybackState({ type: 'year', year: year.key }, playback)}
          artwork={
            <span className={`year-cover-collage year-cover-collage--${year.artwork_hashes.length}`}>
              {year.artwork_hashes.length > 0 ? year.artwork_hashes.map((hash) => (
                <AlbumArtwork key={hash} hash={hash} alt="" variant="thumbnail" />
              )) : <span className="year-cover-fallback">♫</span>}
            </span>
          }
        />
      ))}
    </div>
  )
}
