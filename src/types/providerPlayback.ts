/** Actual playback observations; fetching and decoding never publish these. */
export interface ProviderPlaybackSnapshot {
  sessionId: string
  path: string
  state: 'playing' | 'paused' | 'loading' | 'stopped'
  position: number
  duration: number
}

export function normalizeProviderPlaybackSnapshot(value: unknown): ProviderPlaybackSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<ProviderPlaybackSnapshot>
  if (typeof v.sessionId !== 'string' || !v.sessionId || v.sessionId.length > 200
    || typeof v.path !== 'string' || v.path.length > 4096
    || !['playing', 'paused', 'loading', 'stopped'].includes(v.state ?? '')
    || typeof v.position !== 'number' || !Number.isFinite(v.position) || v.position < 0
    || typeof v.duration !== 'number' || !Number.isFinite(v.duration) || v.duration < 0) return null
  return { sessionId: v.sessionId, path: v.path, state: v.state!, position: v.position, duration: v.duration }
}
