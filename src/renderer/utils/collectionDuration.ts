export interface TrackDurationLike {
  duration: number | null | undefined
}

export function sumValidTrackDurations(tracks: readonly TrackDurationLike[]): number {
  return tracks.reduce((total, track) => {
    const duration = track.duration
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
      return total
    }
    return total + duration
  }, 0)
}

export function formatCompactDuration(totalSeconds: number): string | null {
  if (typeof totalSeconds !== 'number' || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return null
  }

  const seconds = Math.max(1, Math.floor(totalSeconds))
  if (seconds < 60) {
    return `${seconds} sec`
  }

  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} min`
  }

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`
}

export function formatExactDuration(totalSeconds: number): string {
  if (typeof totalSeconds !== 'number' || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return '0:00:00'
  }

  const seconds = Math.floor(totalSeconds)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = seconds % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
}

export function formatCompactTotalTrackDuration(tracks: readonly TrackDurationLike[]): string | null {
  return formatCompactDuration(sumValidTrackDurations(tracks))
}
