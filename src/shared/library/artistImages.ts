export type ArtistArtworkSource = 'manual' | 'detected' | 'track' | null

export interface ArtistArtworkResolution {
  artwork_hash: string | null
  artwork_source: ArtistArtworkSource
}

export interface ArtistImageCandidate {
  path: string
  baseName: string
  extension: string
  mtimeMs: number
}

export type ArtistImageCandidateKind = 'exact' | 'artist' | 'poster'

export interface RankedArtistImageCandidate extends ArtistImageCandidate {
  kind: ArtistImageCandidateKind
  priority: number
}

const SUPPORTED_ARTIST_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])

function normalizeArtistImageKeyText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase()
}

function normalizeArtistImageFilenameText(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase()
}

export function getArtistImageKey(artist: string): string {
  return normalizeArtistImageKeyText(artist)
}

export function isSupportedArtistImageExtension(extension: string): boolean {
  return SUPPORTED_ARTIST_IMAGE_EXTENSIONS.has(extension.toLocaleLowerCase())
}

export function classifyArtistImageCandidate(
  fileBaseName: string,
  artistName: string
): ArtistImageCandidateKind | null {
  const normalizedBaseName = normalizeArtistImageFilenameText(fileBaseName)
  if (!normalizedBaseName) return null

  if (
    normalizedBaseName === normalizeArtistImageFilenameText(artistName) ||
    normalizedBaseName === getArtistImageKey(artistName)
  ) return 'exact'
  if (normalizedBaseName === 'artist') return 'artist'
  if (normalizedBaseName === 'poster') return 'poster'
  return null
}

function getCandidatePriority(kind: ArtistImageCandidateKind): number {
  if (kind === 'exact') return 0
  if (kind === 'artist') return 1
  return 2
}

export function rankArtistImageCandidate(
  candidate: ArtistImageCandidate,
  artistName: string
): RankedArtistImageCandidate | null {
  if (!isSupportedArtistImageExtension(candidate.extension)) return null

  const kind = classifyArtistImageCandidate(candidate.baseName, artistName)
  if (!kind) return null

  return {
    ...candidate,
    kind,
    priority: getCandidatePriority(kind)
  }
}

export function compareRankedArtistImageCandidates(
  a: RankedArtistImageCandidate,
  b: RankedArtistImageCandidate
): number {
  if (a.priority !== b.priority) return a.priority - b.priority
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs
  return a.path.localeCompare(b.path, undefined, { sensitivity: 'base' })
}

export function pickBestArtistImageCandidate(
  candidates: ArtistImageCandidate[],
  artistName: string
): RankedArtistImageCandidate | null {
  const ranked = candidates
    .map((candidate) => rankArtistImageCandidate(candidate, artistName))
    .filter((candidate): candidate is RankedArtistImageCandidate => candidate !== null)
    .sort(compareRankedArtistImageCandidates)

  return ranked[0] ?? null
}

export function resolveArtistArtwork(
  manualImageHash: string | null | undefined,
  detectedImageHash: string | null | undefined,
  trackArtworkHash: string | null | undefined
): ArtistArtworkResolution {
  if (manualImageHash) {
    return { artwork_hash: manualImageHash, artwork_source: 'manual' }
  }
  if (detectedImageHash) {
    return { artwork_hash: detectedImageHash, artwork_source: 'detected' }
  }
  if (trackArtworkHash) {
    return { artwork_hash: trackArtworkHash, artwork_source: 'track' }
  }
  return { artwork_hash: null, artwork_source: null }
}
