const BYTES_PER_MB = 1024 * 1024

export type AppMemoryFootprintSource =
  | 'linux-pss'
  | 'macos-private-resident'
  | 'windows-private-working-set'
  | 'fallback-private-working-set'
  | 'unavailable'

export interface NativeProcessMemoryFootprintSample {
  pid: number
  source: AppMemoryFootprintSource
  ok: boolean
  bytes: number | null
  error?: string | null
}

export interface NativeProcessMemoryFootprintsResult {
  source: AppMemoryFootprintSource
  totalBytes: number
  complete: boolean
  failedPids: number[]
  processes: NativeProcessMemoryFootprintSample[]
}

export interface AppMemoryFootprintSummary {
  footprintMb: number | null
  appProcessFootprintMb: number | null
  childProcessFootprintMb: number | null
  footprintSource: AppMemoryFootprintSource
  footprintComplete: boolean
  footprintFailedPids: number[]
  footprintProcessCount: number
  footprintAppProcessCount: number
  footprintChildProcessCount: number
  footprintRawWorkingSetMb: number | null
  footprintProcesses: NativeProcessMemoryFootprintSample[]
}

export interface TitleBarAppFootprintResolution {
  appFootprintMb: number | null
  appFootprintSource: AppMemoryFootprintSource | null
  appFootprintComplete: boolean | null
}

function normalizePid(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const normalized = Math.trunc(value)
  return normalized > 0 ? normalized : null
}

function normalizeBytes(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function normalizeMb(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function uniquePids(values: readonly unknown[]): number[] {
  const pids: number[] = []
  const seen = new Set<number>()
  for (const value of values) {
    const pid = normalizePid(value)
    if (pid === null || seen.has(pid)) continue
    seen.add(pid)
    pids.push(pid)
  }
  return pids
}

export function bytesToFootprintMb(value: number | null | undefined): number | null {
  const bytes = normalizeBytes(value)
  return bytes === null ? null : bytes / BYTES_PER_MB
}

export function summarizeNativeProcessMemoryFootprints(
  result: NativeProcessMemoryFootprintsResult,
  requestedPids: readonly number[],
  rawWorkingSetMb: number | null,
  groups: {
    appPids?: readonly number[]
    childPids?: readonly number[]
  } = {}
): AppMemoryFootprintSummary {
  const expectedPids = uniquePids(requestedPids)
  const appPids = uniquePids(groups.appPids ?? requestedPids)
  const childPids = uniquePids(groups.childPids ?? [])
  const expectedPidSet = new Set(expectedPids)
  const appPidSet = new Set(appPids)
  const childPidSet = new Set(childPids)
  const seenPids = new Set<number>()
  const failedPids = new Set<number>()
  const processes: NativeProcessMemoryFootprintSample[] = []
  let totalBytes = 0
  let appProcessBytes = 0
  let childProcessBytes = 0
  let successfulSamples = 0
  let appProcessSamples = 0
  let childProcessSamples = 0

  for (const process of result.processes ?? []) {
    const pid = normalizePid(process.pid)
    if (pid === null) continue

    seenPids.add(pid)
    const bytes = normalizeBytes(process.bytes)
    const ok = process.ok === true && bytes !== null
    if (ok) {
      totalBytes += bytes
      successfulSamples += 1
      if (appPidSet.has(pid)) {
        appProcessBytes += bytes
        appProcessSamples += 1
      } else if (childPidSet.has(pid)) {
        childProcessBytes += bytes
        childProcessSamples += 1
      }
    } else {
      failedPids.add(pid)
    }

    processes.push({
      pid,
      source: process.source ?? result.source,
      ok,
      bytes: ok ? bytes : null,
      error: ok ? null : process.error ?? null
    })
  }

  for (const value of result.failedPids ?? []) {
    const pid = normalizePid(value)
    if (pid !== null) {
      failedPids.add(pid)
    }
  }

  for (const pid of expectedPidSet) {
    if (!seenPids.has(pid)) {
      failedPids.add(pid)
      processes.push({
        pid,
        source: result.source,
        ok: false,
        bytes: null,
        error: 'Native process memory sample was missing.'
      })
    }
  }

  return {
    footprintMb: successfulSamples > 0 ? bytesToFootprintMb(totalBytes) : null,
    appProcessFootprintMb: appProcessSamples > 0 ? bytesToFootprintMb(appProcessBytes) : null,
    childProcessFootprintMb: childProcessSamples > 0 ? bytesToFootprintMb(childProcessBytes) : null,
    footprintSource: result.source,
    footprintComplete: failedPids.size === 0 && result.complete === true,
    footprintFailedPids: [...failedPids],
    footprintProcessCount: expectedPids.length,
    footprintAppProcessCount: appPids.length,
    footprintChildProcessCount: childPids.length,
    footprintRawWorkingSetMb: normalizeMb(rawWorkingSetMb),
    footprintProcesses: processes
  }
}

export function createUnavailableAppMemoryFootprintSummary(
  requestedPids: readonly number[],
  rawWorkingSetMb: number | null,
  groups: {
    appPids?: readonly number[]
    childPids?: readonly number[]
  } = {}
): AppMemoryFootprintSummary {
  const pids = uniquePids(requestedPids)
  const appPids = uniquePids(groups.appPids ?? requestedPids)
  const childPids = uniquePids(groups.childPids ?? [])
  return {
    footprintMb: null,
    appProcessFootprintMb: null,
    childProcessFootprintMb: null,
    footprintSource: 'unavailable',
    footprintComplete: pids.length === 0,
    footprintFailedPids: pids,
    footprintProcessCount: pids.length,
    footprintAppProcessCount: appPids.length,
    footprintChildProcessCount: childPids.length,
    footprintRawWorkingSetMb: normalizeMb(rawWorkingSetMb),
    footprintProcesses: pids.map((pid) => ({
      pid,
      source: 'unavailable',
      ok: false,
      bytes: null,
      error: 'Native process memory helper is unavailable.'
    }))
  }
}

export function resolveTitleBarAppFootprint(values: {
  measuredFootprintMb: number | null | undefined
  measuredSource: AppMemoryFootprintSource | null | undefined
  measuredComplete: boolean | null | undefined
  fallbackPrivateMb: number | null | undefined
}): TitleBarAppFootprintResolution {
  const measuredFootprintMb = normalizeMb(values.measuredFootprintMb)
  const measuredSource = values.measuredSource ?? 'unavailable'
  const measuredComplete = values.measuredComplete ?? null
  const fallbackPrivateMb = normalizeMb(values.fallbackPrivateMb)
  const measuredIsPreferred =
    measuredFootprintMb !== null
    && measuredComplete === true

  if (measuredIsPreferred) {
    return {
      appFootprintMb: measuredFootprintMb,
      appFootprintSource: measuredSource,
      appFootprintComplete: measuredComplete
    }
  }

  if (fallbackPrivateMb !== null) {
    return {
      appFootprintMb: fallbackPrivateMb,
      appFootprintSource: 'fallback-private-working-set',
      appFootprintComplete: false
    }
  }

  if (measuredFootprintMb !== null) {
    return {
      appFootprintMb: measuredFootprintMb,
      appFootprintSource: measuredSource,
      appFootprintComplete: measuredComplete
    }
  }

  return {
    appFootprintMb: null,
    appFootprintSource: values.measuredSource ?? null,
    appFootprintComplete: measuredComplete
  }
}
