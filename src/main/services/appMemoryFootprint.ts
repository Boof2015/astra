import { app, type ProcessMetric } from 'electron'
import { createRequire } from 'module'
import { join } from 'path'
import {
  createUnavailableAppMemoryFootprintSummary,
  summarizeNativeProcessMemoryFootprints,
  type AppMemoryFootprintSummary,
  type NativeProcessMemoryFootprintsResult
} from '../../shared/processMemoryFootprint'

export interface NativeProcessMemoryAddon {
  processMemory?: {
    getProcessFootprints?: (pids: number[]) => NativeProcessMemoryFootprintsResult
    getProcessFootprintsAsync?: (pids: number[]) => Promise<NativeProcessMemoryFootprintsResult>
  }
}

export interface AppMemoryFootprintOptions {
  metrics: readonly ProcessMetric[]
  extraPids?: readonly number[]
  rawWorkingSetMb: number | null
}

const require = createRequire(import.meta.url)

let nativeAddon: NativeProcessMemoryAddon | null | undefined
let nativeAddonWarningLogged = false

function normalizePid(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const pid = Math.trunc(value)
  return pid > 0 ? pid : null
}

function collectUniqueProcessIds(metrics: readonly ProcessMetric[], extraPids: readonly number[]): number[] {
  const pids: number[] = []
  const seen = new Set<number>()
  const addPid = (value: unknown) => {
    const pid = normalizePid(value)
    if (pid === null || seen.has(pid)) return
    seen.add(pid)
    pids.push(pid)
  }

  for (const metric of metrics) {
    addPid(metric.pid)
  }
  for (const pid of extraPids) {
    addPid(pid)
  }

  return pids
}

function collectMetricProcessIds(metrics: readonly ProcessMetric[]): number[] {
  return collectUniqueProcessIds(metrics, [])
}

function resolveNativeAddonPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'native/visualizer_dsp.node')
    : join(__dirname, '../../native/build/Release/visualizer_dsp.node')
}

function logNativeAddonWarning(message: string, error?: unknown): void {
  if (nativeAddonWarningLogged) return
  nativeAddonWarningLogged = true
  if (error) {
    console.warn(message, error)
    return
  }
  console.warn(message)
}

function loadNativeProcessMemoryAddon(): NativeProcessMemoryAddon | null {
  if (nativeAddon !== undefined) return nativeAddon

  try {
    const modulePath = resolveNativeAddonPath()
    nativeAddon = require(modulePath) as NativeProcessMemoryAddon
    if (typeof nativeAddon.processMemory?.getProcessFootprintsAsync !== 'function') {
      logNativeAddonWarning('Native addon loaded, but its async process memory export is missing. Falling back to Electron memory metrics.')
      nativeAddon = null
    }
  } catch (error) {
    logNativeAddonWarning('Failed to load native process memory helper. Falling back to Electron memory metrics.', error)
    nativeAddon = null
  }

  return nativeAddon
}

export function createAppMemoryFootprintCollector(
  loadAddon: () => NativeProcessMemoryAddon | null = loadNativeProcessMemoryAddon
): (options: AppMemoryFootprintOptions) => Promise<AppMemoryFootprintSummary> {
  const inFlightMeasurements = new Map<string, Promise<NativeProcessMemoryFootprintsResult>>()

  const measure = (
    getProcessFootprintsAsync: (pids: number[]) => Promise<NativeProcessMemoryFootprintsResult>,
    pids: number[]
  ): Promise<NativeProcessMemoryFootprintsResult> => {
    const key = [...pids].sort((left, right) => left - right).join(',')
    const existing = inFlightMeasurements.get(key)
    if (existing) return existing

    let tracked: Promise<NativeProcessMemoryFootprintsResult>
    tracked = Promise.resolve()
      .then(() => getProcessFootprintsAsync(pids))
      .finally(() => {
        if (inFlightMeasurements.get(key) === tracked) {
          inFlightMeasurements.delete(key)
        }
      })
    inFlightMeasurements.set(key, tracked)
    return tracked
  }

  return async (options: AppMemoryFootprintOptions): Promise<AppMemoryFootprintSummary> => {
    const appPids = collectMetricProcessIds(options.metrics)
    const childPids = options.extraPids ?? []
    const pids = collectUniqueProcessIds(options.metrics, childPids)
    const addon = loadAddon()
    const getProcessFootprintsAsync = addon?.processMemory?.getProcessFootprintsAsync
    if (typeof getProcessFootprintsAsync !== 'function') {
      return createUnavailableAppMemoryFootprintSummary(pids, options.rawWorkingSetMb, { appPids, childPids })
    }

    try {
      const result = await measure(getProcessFootprintsAsync, pids)
      return summarizeNativeProcessMemoryFootprints(result, pids, options.rawWorkingSetMb, { appPids, childPids })
    } catch (error) {
      logNativeAddonWarning('Native process memory helper failed. Falling back to Electron memory metrics.', error)
      return createUnavailableAppMemoryFootprintSummary(pids, options.rawWorkingSetMb, { appPids, childPids })
    }
  }
}

export const collectAppMemoryFootprint = createAppMemoryFootprintCollector()
