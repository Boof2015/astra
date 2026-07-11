export interface ArtistDiscographyReleaseLike {
  track_count: number
}

export interface ArtistDiscographyCandidate<T extends ArtistDiscographyReleaseLike> {
  release: T
  isPrimary: boolean
}

export interface ArtistDiscographySections<T extends ArtistDiscographyReleaseLike> {
  albums: T[]
  singles: T[]
  featured: T[]
}

export function partitionArtistDiscography<T extends ArtistDiscographyReleaseLike>(
  candidates: readonly ArtistDiscographyCandidate<T>[]
): ArtistDiscographySections<T> {
  const albums: T[] = []
  const singles: T[] = []
  const featured: T[] = []

  for (const candidate of candidates) {
    if (!candidate.isPrimary) {
      featured.push(candidate.release)
    } else if (candidate.release.track_count === 1) {
      singles.push(candidate.release)
    } else {
      albums.push(candidate.release)
    }
  }

  return { albums, singles, featured }
}
