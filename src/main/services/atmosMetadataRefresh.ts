export const ATMOS_METADATA_REFRESH_KEY = 'atmos_ffprobe_6_1_refresh_v1_done'

export interface AtmosRefreshResult {
  scanned: number
  updated: number
  errors: number
}

// Keep completion and invalidation together: interrupted/unavailable runs must be retried.
export async function runAtmosMetadataRefreshOnce(deps: {
  isComplete: () => boolean
  refresh: () => Promise<AtmosRefreshResult | null>
  markComplete: () => Promise<void>
  notify: (result: AtmosRefreshResult) => void
  signal?: AbortSignal
}): Promise<AtmosRefreshResult | null> {
  deps.signal?.throwIfAborted()
  if (deps.isComplete()) return null
  const result = await deps.refresh()
  deps.signal?.throwIfAborted()
  if (!result) return null
  await deps.markComplete()
  if (result.updated > 0) deps.notify(result)
  return result
}
