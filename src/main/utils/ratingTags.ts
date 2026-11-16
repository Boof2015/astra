import { normalizeTrackRating } from '../../shared/ratings/trackRating'

export interface RatingTagMetadata {
  common: { rating?: Array<{ source?: string; rating?: number }> }
  native: Record<string, Array<{ id: string; value: unknown }>>
}

const POPM_STARS = [0, 1, 64, 128, 196, 255]
export const ASTRA_RATING_OWNER = 'astra'

function numeric(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function scaled(value: unknown, max: number): number | null | undefined {
  const number = numeric(value)
  if (number === undefined || number < 0 || number > max) return undefined
  if (number === 0) return null
  return normalizeTrackRating(number * 5 / max)
}

export function popmToStars(value: unknown): number | null | undefined {
  const number = numeric(value)
  if (number === undefined || !Number.isInteger(number) || number < 0 || number > 255) return undefined
  if (number === 0) return null
  let nearest = 1
  for (let stars = 2; stars <= 5; stars++) {
    if (Math.abs(number - POPM_STARS[stars]) < Math.abs(number - POPM_STARS[nearest])) nearest = stars
  }
  return nearest
}

function fieldName(id: string): string {
  return id.toUpperCase().replace(/^TXXX:/, '').replace(/^----:COM.APPLE.ITUNES:/, '')
}

/** Pure projection of an existing parse. Undefined means malformed; null means unrated. */
export function extractRatingTag(metadata: RatingTagMetadata): number | null | undefined {
  let malformed = false
  // FMPS preserves half stars that POPM's interoperable whole-star mapping cannot.
  for (const tags of Object.values(metadata.native)) {
    for (const tag of tags) {
      if (fieldName(tag.id) !== 'FMPS_RATING') continue
      const rating = scaled(tag.value, 1)
      if (rating !== undefined) return rating
      malformed = true
    }
  }
  for (const [format, tags] of Object.entries(metadata.native)) {
    for (const tag of tags) {
      const key = fieldName(tag.id)
      let rating: number | null | undefined
      if (key === 'POPM' && tag.value && typeof tag.value === 'object') {
        rating = popmToStars((tag.value as { rating?: unknown }).rating)
      } else if (key === 'RATING' || (key === 'RATE' && format.toLowerCase() === 'itunes')) {
        rating = scaled(tag.value, 100)
      } else if (key.startsWith('RATING:') && format.toLowerCase() === 'vorbis') {
        rating = scaled(tag.value, 1)
      } else continue
      if (rating !== undefined) return rating
      malformed = true
    }
  }
  // A malformed native rating must not be replaced by a differently normalized
  // view of the very same tag. In particular, never treat MP4 rtng as a star rating.
  if (malformed) return undefined
  for (const entry of metadata.common.rating ?? []) {
    const rating = scaled(entry.rating, 1)
    if (rating !== undefined) return rating
    malformed = true
  }
  return malformed ? undefined : null
}

/** Only personal-rating fields are supplied to the writer; omitted tags survive. */
export function buildRatingTagPatch(metadata: RatingTagMetadata, extension: string, rating: number | null): Record<string, unknown> {
  const value = rating ?? 0
  if (extension === '.mp3') {
    const popms = Object.values(metadata.native).flatMap(tags => tags.filter(tag => tag.id === 'POPM').map(tag => tag.value))
    const entries = popms.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    const selected = entries[0] ?? { email: ASTRA_RATING_OWNER, counter: 0 }
    return {
      POPM: [{ ...selected, rating: POPM_STARS[Math.round(value)] }, ...entries.slice(1)],
      'TXXX:FMPS_RATING': String(value / 5)
    }
  }
  if (extension === '.m4a') {
    return { rate: String(value * 20), '----:com.apple.iTunes:RATING': String(value * 20), '----:com.apple.iTunes:FMPS_RATING': String(value / 5) }
  }
  return { RATING: String(value * 20), FMPS_RATING: String(value / 5) }
}
