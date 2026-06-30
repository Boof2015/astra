export interface TrackListDiscTrackLike {
  disc_number: number | null | undefined
}

export type TrackListVirtualRow =
  | { kind: 'disc-header'; discNumber: number }
  | { kind: 'track'; trackIndex: number }

function normalizeDiscNumber(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 1
  return Math.trunc(value)
}

function shouldShowDiscHeaders(tracks: readonly TrackListDiscTrackLike[]): boolean {
  const distinctDiscNumbers = new Set<number>()
  for (const track of tracks) {
    distinctDiscNumbers.add(normalizeDiscNumber(track.disc_number))
    if (distinctDiscNumbers.size >= 2) return true
  }
  return false
}

export function buildTrackListRows(
  tracks: readonly TrackListDiscTrackLike[],
  showDiscHeaders: boolean
): TrackListVirtualRow[] {
  if (!showDiscHeaders || !shouldShowDiscHeaders(tracks)) {
    return tracks.map((_, trackIndex) => ({ kind: 'track', trackIndex }))
  }

  const rows: TrackListVirtualRow[] = []
  let previousDiscNumber: number | null = null

  tracks.forEach((track, trackIndex) => {
    const discNumber = normalizeDiscNumber(track.disc_number)
    if (discNumber !== previousDiscNumber) {
      rows.push({ kind: 'disc-header', discNumber })
      previousDiscNumber = discNumber
    }
    rows.push({ kind: 'track', trackIndex })
  })

  return rows
}
