export interface LoudnessWarmupTrackLike {
  path: string
  sourceType?: string
  isAvailable?: boolean
}

export function selectUpcomingLoudnessWarmupTracks<T extends LoudnessWarmupTrackLike>(
  candidates: readonly T[],
  shouldAnalyze: (track: T) => boolean,
  limit = 1
): T[] {
  const normalizedLimit = Math.max(0, Math.floor(limit))
  if (normalizedLimit === 0) return []

  const selected: T[] = []
  const seenPaths = new Set<string>()
  for (const track of candidates) {
    if ((track.sourceType ?? 'local') !== 'local') continue
    if (track.isAvailable === false || seenPaths.has(track.path)) continue
    seenPaths.add(track.path)
    if (!shouldAnalyze(track)) continue

    selected.push(track)
    if (selected.length >= normalizedLimit) break
  }
  return selected
}
