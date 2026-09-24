const DAY_MS = 24 * 60 * 60 * 1000

function calendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS
}

export function formatHomeAddedAge(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(new Date(timestamp).getTime())) return 'New to your library'
  const days = Math.max(0, calendarDay(new Date(now)) - calendarDay(new Date(timestamp)))
  if (days === 0) return 'Added today'
  if (days === 1) return 'Added yesterday'
  if (days < 60) return `Added ${days} days ago`
  const months = Math.floor(days / 30)
  if (months < 18) return `Added ${months} months ago`
  const years = Math.floor(days / 365)
  return `Added ${years} ${years === 1 ? 'year' : 'years'} ago`
}
