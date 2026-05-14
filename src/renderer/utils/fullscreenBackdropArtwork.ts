import type { ArtworkRequestOptions } from '../stores/libraryStore'

export const FULLSCREEN_BACKDROP_INLINE_ARTWORK_MAX_CHARS = 1_500_000

export interface FullscreenBackdropArtworkTrack {
  artworkHash?: string | null
  artworkData?: string | null
}

type GetArtwork = (hash: string | null, options?: ArtworkRequestOptions) => Promise<string | null>

export function shouldUseInlineArtworkAsFullscreenBackdrop(artworkData: string | null | undefined): artworkData is string {
  return typeof artworkData === 'string'
    && artworkData.length > 0
    && artworkData.length <= FULLSCREEN_BACKDROP_INLINE_ARTWORK_MAX_CHARS
}

export async function getFullscreenBackdropArtworkCandidates(
  track: FullscreenBackdropArtworkTrack | null,
  getArtwork: GetArtwork
): Promise<string[]> {
  if (!track) return []

  const candidates: string[] = []

  if (track.artworkHash) {
    const hashArtwork = await getArtwork(track.artworkHash, { variant: 'card' }).catch(() => null)
    if (hashArtwork) {
      candidates.push(hashArtwork)
    }
  }

  if (shouldUseInlineArtworkAsFullscreenBackdrop(track.artworkData)) {
    candidates.push(track.artworkData)
  }

  return [...new Set(candidates)]
}
