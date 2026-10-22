export const REMOTE_CACHE_DEFAULT_GB = 5
export const REMOTE_CACHE_MIN_GB = 1
export const REMOTE_CACHE_MAX_GB = 50

export interface RemoteAudioCacheStatus {
  limitGb: number
  usedBytes: number
  activeBytes: number
}

export function normalizeRemoteCacheLimitGb(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= REMOTE_CACHE_MIN_GB
    ? Math.min(REMOTE_CACHE_MAX_GB, Math.round(numeric))
    : REMOTE_CACHE_DEFAULT_GB
}
