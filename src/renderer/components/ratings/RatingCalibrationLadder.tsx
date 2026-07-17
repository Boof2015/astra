import { useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { useLibraryStore, type DbTrack } from '../../stores/libraryStore'
import { useRatingsStore } from '../../stores/ratingsStore'
import { selectRatingNeighbors, type RatingNeighborEntry } from '../../utils/ratingCalibration'
import AlbumArtwork from '../library/AlbumArtwork'
import StarRating from './StarRating'
import type { PresencePhase } from '../../hooks/usePresence'

interface RatingCalibrationLadderProps {
  tentative: number
  trackPaths: string[]
  presencePhase: PresencePhase
}

// The track cache in libraryStore only holds loaded tracks, so neighbor
// metadata may need a one-off fetch. Cached outside the component (null =
// confirmed missing, i.e. an orphaned rating row for a removed track).
const neighborTrackCache = new Map<string, DbTrack | null>()
const pendingNeighborPaths = new Set<string>()

const CHIP_STAGGER_MS = 45

function pathBasename(trackPath: string): string {
  const segments = trackPath.split(/[\\/]/)
  return segments[segments.length - 1] || trackPath
}

interface LadderChipModel {
  trackPath: string
  rating: number
  title: string
  artworkHash: string | null
  distance: number
}

function LadderChip({ chip }: { chip: LadderChipModel }): ReactElement {
  return (
    <div
      className="rating-ladder-chip"
      data-distance={chip.distance}
      style={{ '--ladder-delay': `${chip.distance * CHIP_STAGGER_MS}ms` } as CSSProperties}
    >
      <AlbumArtwork hash={chip.artworkHash} alt={chip.title} variant="thumbnail" className="rating-ladder-art" />
      <StarRating value={chip.rating} size="sm" ariaLabel={`${chip.rating} stars`} />
      <span className="rating-ladder-title">{chip.title}</span>
    </div>
  )
}

export default function RatingCalibrationLadder({
  tentative,
  trackPaths,
  presencePhase
}: RatingCalibrationLadderProps): ReactElement | null {
  const ratings = useRatingsStore((s) => s.ratings)
  const trackByPath = useLibraryStore((s) => s.trackByPath)
  const [, setFetchGeneration] = useState(0)

  // Ratings orphaned by track removal stay in the DB (favorites parity);
  // drop the ones we have already confirmed missing so they never surface.
  const excludedPaths = new Set(trackPaths)
  for (const [trackPath, cached] of neighborTrackCache) {
    if (cached === null) excludedPaths.add(trackPath)
  }
  const neighbors = selectRatingNeighbors(tentative, ratings, excludedPaths)

  const resolveTrack = (trackPath: string): DbTrack | null | undefined => {
    return trackByPath.get(trackPath) ?? neighborTrackCache.get(trackPath)
  }

  const unresolvedPaths = [...neighbors.above, ...neighbors.below]
    .map((neighbor) => neighbor.trackPath)
    .filter((trackPath) => resolveTrack(trackPath) === undefined && !pendingNeighborPaths.has(trackPath))

  const unresolvedKey = unresolvedPaths.join('\n')
  useEffect(() => {
    if (unresolvedPaths.length === 0) return
    const toFetch = unresolvedPaths
    for (const trackPath of toFetch) pendingNeighborPaths.add(trackPath)
    let cancelled = false
    void window.electronAPI.library.getTracksByPaths(toFetch)
      .then((tracks: DbTrack[]) => {
        const found = new Set<string>()
        for (const track of tracks) {
          neighborTrackCache.set(track.path, track)
          found.add(track.path)
        }
        for (const trackPath of toFetch) {
          if (!found.has(trackPath)) neighborTrackCache.set(trackPath, null)
        }
      })
      .catch(() => {
        // Leave paths unresolved; chips fall back to file names.
      })
      .finally(() => {
        for (const trackPath of toFetch) pendingNeighborPaths.delete(trackPath)
        if (!cancelled) setFetchGeneration((generation) => generation + 1)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unresolvedKey])

  if (neighbors.above.length === 0 && neighbors.below.length === 0) {
    return null
  }

  const toChipModel = (neighbor: RatingNeighborEntry, distance: number): LadderChipModel => {
    const track = resolveTrack(neighbor.trackPath)
    return {
      trackPath: neighbor.trackPath,
      rating: neighbor.rating,
      title: track?.title || pathBasename(neighbor.trackPath),
      artworkHash: track?.artwork_hash ?? null,
      distance
    }
  }

  // Above strip reads downward toward the row: farther neighbor on top,
  // nearest directly above the stars being dragged. Below strip: nearest first.
  const aboveChips = neighbors.above.map(toChipModel).reverse()
  const belowChips = neighbors.below.map(toChipModel)

  return (
    <div className="rating-ladder" data-presence={presencePhase} aria-hidden="true">
      {aboveChips.length > 0 && (
        <div className="rating-ladder-strip rating-ladder-above">
          {aboveChips.map((chip) => <LadderChip key={chip.trackPath} chip={chip} />)}
        </div>
      )}
      {belowChips.length > 0 && (
        <div className="rating-ladder-strip rating-ladder-below">
          {belowChips.map((chip) => <LadderChip key={chip.trackPath} chip={chip} />)}
        </div>
      )}
    </div>
  )
}
