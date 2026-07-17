export const MIN_TRACK_RATING = 0.5
export const MAX_TRACK_RATING = 5

export interface TrackRatingEntry {
  track_path: string
  rating: number
  updated_at: number
}

/**
 * Normalizes a rating to a half-star step in [0.5, 5], or null for anything
 * unratable. Half steps are exactly representable in IEEE754, so normalized
 * values are safe for SQL equality comparisons.
 */
export function normalizeTrackRating(value: unknown): number | null {
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numberValue)) return null
  const halfStepped = Math.round(numberValue * 2) / 2
  if (halfStepped < MIN_TRACK_RATING) return null
  return Math.min(MAX_TRACK_RATING, halfStepped)
}
