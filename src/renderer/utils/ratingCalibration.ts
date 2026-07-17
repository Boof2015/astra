export interface RatingNeighborEntry {
  trackPath: string
  rating: number
  updatedAt: number
}

export interface RatingNeighborSelection {
  above: RatingNeighborEntry[]
  below: RatingNeighborEntry[]
}

function compareByDistance(
  a: RatingNeighborEntry,
  b: RatingNeighborEntry,
  tentative: number
): number {
  const distanceDelta = Math.abs(a.rating - tentative) - Math.abs(b.rating - tentative)
  if (distanceDelta !== 0) return distanceDelta
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  return a.trackPath < b.trackPath ? -1 : a.trackPath > b.trackPath ? 1 : 0
}

/**
 * Picks the rated tracks nearest above and below a tentative rating, so the
 * calibration preview can show where a track would land in the library.
 * Tracks rated exactly at the tentative value count as "above" (they render
 * adjacent to the insertion marker without appearing in both groups).
 */
export function selectRatingNeighbors(
  tentative: number,
  ratings: ReadonlyMap<string, { rating: number; updatedAt: number }>,
  excludedPaths: ReadonlySet<string>,
  perSide: number = 2
): RatingNeighborSelection {
  const above: RatingNeighborEntry[] = []
  const below: RatingNeighborEntry[] = []

  for (const [trackPath, entry] of ratings) {
    if (excludedPaths.has(trackPath)) continue
    const candidate: RatingNeighborEntry = {
      trackPath,
      rating: entry.rating,
      updatedAt: entry.updatedAt
    }
    if (entry.rating >= tentative) {
      above.push(candidate)
    } else {
      below.push(candidate)
    }
  }

  above.sort((a, b) => compareByDistance(a, b, tentative))
  below.sort((a, b) => compareByDistance(a, b, tentative))

  return {
    above: above.slice(0, perSide),
    below: below.slice(0, perSide)
  }
}
