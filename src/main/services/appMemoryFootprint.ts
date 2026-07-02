import { app, type ProcessMetric } from 'electron'
import { createRequire } from 'module'
import { join } from 'path'
import {
  createUnavailableAppMemoryFootprintSummary,
  summarizeNativeProcessMemoryFootprints,
  type AppMemoryFootprintSummary,
  type NativeProcessMemoryFootprintsResult
} from '../../shared/processMemoryFootprint'

interface NativeProcessMemoryAddon {
  processMemory?: {
    getProcessFootprints: (pids: number[]) => NativeProcessMemoryFootprintsResult
  }
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
    if (typeof nativeAddon.processMemory?.getProcessFootprints !== 'function') {
      logNativeAddonWarning('Native addon loaded, but process memory exports are missing. Falling back to Electron memory metrics.')
      nativeAddon = null
    }
  } catch (error) {
    logNativeAddonWarning('Failed to load native process memory helper. Falling back to Electron memory metrics.', error)
    nativeAddon = null
  }

  return nativeAddon
}

export function collectAppMemoryFootprint(options: {
  metrics: readonly ProcessMetric[]
  extraPids?: readonly number[]
  rawWorkingSetMb: number | null
}): AppMemoryFootprintSummary {
  const pids = collectUniqueProcessIds(options.metrics, options.extraPids ?? [])
  const addon = loadNativeProcessMemoryAddon()
  if (!addon?.processMemory) {
    return createUnavailableAppMemoryFootprintSummary(pids, options.rawWorkingSetMb)
  }

  try {
    const result = addon.processMemory.getProcessFootprints(pids)
    return summarizeNativeProcessMemoryFootprints(result, pids, options.rawWorkingSetMb)
  } catch (error) {
    logNativeAddonWarning('Native process memory helper failed. Falling back to Electron memory metrics.', error)
    return createUnavailableAppMemoryFootprintSummary(pids, options.rawWorkingSetMb)
  }
}
