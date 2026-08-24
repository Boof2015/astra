export interface LibraryScanProgressUpdate {
  current: number
  total: number
  file: string
}

export interface LibraryScanProgressThrottleOptions {
  minIntervalMs?: number
  now?: () => number
}

const DEFAULT_LIBRARY_SCAN_PROGRESS_INTERVAL_MS = 100

/**
 * Keep scan progress useful without sending one IPC event (and causing one
 * renderer store update) for every file. The first and terminal updates are
 * always immediate; intermediate updates are sampled at a human-visible rate.
 */
export function createThrottledLibraryScanProgressReporter(
  send: (update: LibraryScanProgressUpdate) => void,
  options: LibraryScanProgressThrottleOptions = {}
): (current: number, total: number, file: string) => void {
  const minIntervalMs = Math.max(
    0,
    Number.isFinite(options.minIntervalMs)
      ? Number(options.minIntervalMs)
      : DEFAULT_LIBRARY_SCAN_PROGRESS_INTERVAL_MS
  )
  const now = options.now ?? (() => performance.now())
  let lastSentAt: number | null = null
  let lastSentCurrent = -1
  let lastSentTotal = -1

  return (current, total, file) => {
    const timestamp = now()
    const isFirst = lastSentAt === null
    const isTerminal = total > 0 && current >= total
    const intervalElapsed = lastSentAt !== null && timestamp - lastSentAt >= minIntervalMs
    if (!isFirst && !isTerminal && !intervalElapsed) return
    if (current === lastSentCurrent && total === lastSentTotal) return

    lastSentAt = timestamp
    lastSentCurrent = current
    lastSentTotal = total
    send({ current, total, file })
  }
}
