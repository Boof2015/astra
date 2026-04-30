import type {
  MemoryDiagnosticsProcessMemoryStats,
  MemoryDiagnosticsRendererMemoryStats,
  MemoryDiagnosticsTitleBarPeakSnapshot,
  MemoryDiagnosticsTitleBarSampleSnapshot
} from '../../types/diagnostics'
import { audioEngine } from '../audio/AudioEngine'

export const BYTES_PER_MB = 1024 * 1024
export const TITLE_BAR_MEMORY_SAMPLE_INTERVAL_MS = 1000

interface AppPerformanceStats {
  cpuPercent: number
  workingSetMb: number
}

export interface TitleBarPerformanceSample {
  cpuPercent: number | null
  memory: MemoryDiagnosticsTitleBarSampleSnapshot
}

function normalizeMb(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null
}

function bytesToMb(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value / BYTES_PER_MB)
    : null
}

function fulfilledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

export function createEmptyTitleBarSample(): MemoryDiagnosticsTitleBarSampleSnapshot {
  return {
    sampledAt: null,
    rendererPrivateMb: null,
    appMemoryMb: null,
    bufferMemoryMb: null,
    currentBufferMemoryMb: null,
    nextBufferMemoryMb: null,
    otherProcessMemoryMb: null,
    totalWorkingSetMb: null,
    rendererHeapUsedMb: null,
    rendererExternalMb: null,
    rendererArrayBuffersMb: null,
    rendererOldSpaceMb: null,
    rendererLargeObjectSpaceMb: null,
    mainRssMb: null,
    mainHeapUsedMb: null,
    mainExternalMb: null,
    mainArrayBuffersMb: null
  }
}

export function createEmptyTitleBarPeaks(): MemoryDiagnosticsTitleBarPeakSnapshot {
  return {
    capturedAt: null,
    rendererPrivateMb: null,
    appMemoryMb: null,
    bufferMemoryMb: null,
    currentBufferMemoryMb: null,
    nextBufferMemoryMb: null,
    otherProcessMemoryMb: null,
    totalWorkingSetMb: null,
    rendererHeapUsedMb: null,
    rendererExternalMb: null,
    rendererArrayBuffersMb: null,
    rendererOldSpaceMb: null,
    rendererLargeObjectSpaceMb: null,
    mainRssMb: null,
    mainHeapUsedMb: null,
    mainExternalMb: null,
    mainArrayBuffersMb: null
  }
}

export function createEmptyTitleBarPerformanceSample(): TitleBarPerformanceSample {
  return {
    cpuPercent: null,
    memory: createEmptyTitleBarSample()
  }
}

export function buildTitleBarSample(values: {
  sampledAt: number
  rendererPrivateMb: number | null
  rendererHeapUsedBytes: number | null
  rendererExternalBytes: number | null
  rendererArrayBuffersBytes: number | null
  rendererOldSpaceUsedBytes: number | null
  rendererLargeObjectSpaceUsedBytes: number | null
  mainRssBytes: number | null
  mainHeapUsedBytes: number | null
  mainExternalBytes: number | null
  mainArrayBuffersBytes: number | null
  totalWorkingSetMb: number | null
  bufferMemoryMb: number | null
  currentBufferMemoryMb: number | null
  nextBufferMemoryMb: number | null
}): MemoryDiagnosticsTitleBarSampleSnapshot {
  const rendererPrivateMb = normalizeMb(values.rendererPrivateMb)
  const bufferMemoryMb = normalizeMb(values.bufferMemoryMb)
  const totalWorkingSetMb = normalizeMb(values.totalWorkingSetMb)
  const appMemoryMb = rendererPrivateMb === null || bufferMemoryMb === null
    ? null
    : Math.max(rendererPrivateMb - bufferMemoryMb, 0)
  const otherProcessMemoryMb = totalWorkingSetMb === null || rendererPrivateMb === null
    ? null
    : Math.max(totalWorkingSetMb - rendererPrivateMb, 0)

  return {
    sampledAt: values.sampledAt,
    rendererPrivateMb,
    appMemoryMb,
    bufferMemoryMb,
    currentBufferMemoryMb: normalizeMb(values.currentBufferMemoryMb),
    nextBufferMemoryMb: normalizeMb(values.nextBufferMemoryMb),
    otherProcessMemoryMb,
    totalWorkingSetMb,
    rendererHeapUsedMb: bytesToMb(values.rendererHeapUsedBytes),
    rendererExternalMb: bytesToMb(values.rendererExternalBytes),
    rendererArrayBuffersMb: bytesToMb(values.rendererArrayBuffersBytes),
    rendererOldSpaceMb: bytesToMb(values.rendererOldSpaceUsedBytes),
    rendererLargeObjectSpaceMb: bytesToMb(values.rendererLargeObjectSpaceUsedBytes),
    mainRssMb: bytesToMb(values.mainRssBytes),
    mainHeapUsedMb: bytesToMb(values.mainHeapUsedBytes),
    mainExternalMb: bytesToMb(values.mainExternalBytes),
    mainArrayBuffersMb: bytesToMb(values.mainArrayBuffersBytes)
  }
}

function maxNullable(current: number | null, next: number | null): number | null {
  if (next === null || !Number.isFinite(next)) return current
  if (current === null || !Number.isFinite(current)) return next
  return next > current ? next : current
}

export function updateTitleBarPeaks(
  current: MemoryDiagnosticsTitleBarPeakSnapshot,
  sample: MemoryDiagnosticsTitleBarSampleSnapshot
): MemoryDiagnosticsTitleBarPeakSnapshot {
  let capturedAt = current.capturedAt
  const next: MemoryDiagnosticsTitleBarPeakSnapshot = {
    capturedAt,
    rendererPrivateMb: current.rendererPrivateMb,
    appMemoryMb: current.appMemoryMb,
    bufferMemoryMb: current.bufferMemoryMb,
    currentBufferMemoryMb: current.currentBufferMemoryMb,
    nextBufferMemoryMb: current.nextBufferMemoryMb,
    otherProcessMemoryMb: current.otherProcessMemoryMb,
    totalWorkingSetMb: current.totalWorkingSetMb,
    rendererHeapUsedMb: current.rendererHeapUsedMb,
    rendererExternalMb: current.rendererExternalMb,
    rendererArrayBuffersMb: current.rendererArrayBuffersMb,
    rendererOldSpaceMb: current.rendererOldSpaceMb,
    rendererLargeObjectSpaceMb: current.rendererLargeObjectSpaceMb,
    mainRssMb: current.mainRssMb,
    mainHeapUsedMb: current.mainHeapUsedMb,
    mainExternalMb: current.mainExternalMb,
    mainArrayBuffersMb: current.mainArrayBuffersMb
  }

  const applyPeak = (
    key: Exclude<keyof MemoryDiagnosticsTitleBarPeakSnapshot, 'capturedAt'>,
    value: number | null
  ) => {
    const previous = next[key]
    const peak = maxNullable(previous, value)
    next[key] = peak
    if (peak !== previous && sample.sampledAt !== null) {
      capturedAt = sample.sampledAt
    }
  }

  applyPeak('rendererPrivateMb', sample.rendererPrivateMb)
  applyPeak('appMemoryMb', sample.appMemoryMb)
  applyPeak('bufferMemoryMb', sample.bufferMemoryMb)
  applyPeak('currentBufferMemoryMb', sample.currentBufferMemoryMb)
  applyPeak('nextBufferMemoryMb', sample.nextBufferMemoryMb)
  applyPeak('otherProcessMemoryMb', sample.otherProcessMemoryMb)
  applyPeak('totalWorkingSetMb', sample.totalWorkingSetMb)
  applyPeak('rendererHeapUsedMb', sample.rendererHeapUsedMb)
  applyPeak('rendererExternalMb', sample.rendererExternalMb)
  applyPeak('rendererArrayBuffersMb', sample.rendererArrayBuffersMb)
  applyPeak('rendererOldSpaceMb', sample.rendererOldSpaceMb)
  applyPeak('rendererLargeObjectSpaceMb', sample.rendererLargeObjectSpaceMb)
  applyPeak('mainRssMb', sample.mainRssMb)
  applyPeak('mainHeapUsedMb', sample.mainHeapUsedMb)
  applyPeak('mainExternalMb', sample.mainExternalMb)
  applyPeak('mainArrayBuffersMb', sample.mainArrayBuffersMb)

  next.capturedAt = capturedAt
  return next
}

export function createTitleBarPeaksFromSample(
  sample: MemoryDiagnosticsTitleBarSampleSnapshot
): MemoryDiagnosticsTitleBarPeakSnapshot {
  if (sample.sampledAt === null) {
    return createEmptyTitleBarPeaks()
  }
  return {
    capturedAt: sample.sampledAt,
    rendererPrivateMb: sample.rendererPrivateMb,
    appMemoryMb: sample.appMemoryMb,
    bufferMemoryMb: sample.bufferMemoryMb,
    currentBufferMemoryMb: sample.currentBufferMemoryMb,
    nextBufferMemoryMb: sample.nextBufferMemoryMb,
    otherProcessMemoryMb: sample.otherProcessMemoryMb,
    totalWorkingSetMb: sample.totalWorkingSetMb,
    rendererHeapUsedMb: sample.rendererHeapUsedMb,
    rendererExternalMb: sample.rendererExternalMb,
    rendererArrayBuffersMb: sample.rendererArrayBuffersMb,
    rendererOldSpaceMb: sample.rendererOldSpaceMb,
    rendererLargeObjectSpaceMb: sample.rendererLargeObjectSpaceMb,
    mainRssMb: sample.mainRssMb,
    mainHeapUsedMb: sample.mainHeapUsedMb,
    mainExternalMb: sample.mainExternalMb,
    mainArrayBuffersMb: sample.mainArrayBuffersMb
  }
}

export async function captureTitleBarPerformanceSample(): Promise<TitleBarPerformanceSample> {
  const sampledAt = Date.now()
  const [appStatsResult, rendererMemoryResult, mainMemoryResult, bufferStatsResult] = await Promise.allSettled([
    window.electronAPI?.getAppPerformanceStats
      ? window.electronAPI.getAppPerformanceStats()
      : Promise.reject(new Error('App performance stats unavailable.')),
    window.electronAPI?.getRendererMemoryStats
      ? window.electronAPI.getRendererMemoryStats()
      : Promise.reject(new Error('Renderer memory stats unavailable.')),
    window.electronAPI?.getMainProcessMemoryStats
      ? window.electronAPI.getMainProcessMemoryStats()
      : Promise.reject(new Error('Main process memory stats unavailable.')),
    audioEngine.getBufferMemoryStats()
  ])

  const appStats = fulfilledValue<AppPerformanceStats>(appStatsResult)
  const rendererMemory = fulfilledValue<MemoryDiagnosticsRendererMemoryStats>(rendererMemoryResult)
  const mainMemory = fulfilledValue<MemoryDiagnosticsProcessMemoryStats>(mainMemoryResult)
  const bufferStats = fulfilledValue(bufferStatsResult)

  return {
    cpuPercent: typeof appStats?.cpuPercent === 'number' && Number.isFinite(appStats.cpuPercent)
      ? appStats.cpuPercent
      : null,
    memory: buildTitleBarSample({
      sampledAt,
      totalWorkingSetMb: appStats?.workingSetMb ?? null,
      rendererPrivateMb: rendererMemory?.privateMb ?? null,
      rendererHeapUsedBytes: rendererMemory?.heapUsedBytes ?? null,
      rendererExternalBytes: rendererMemory?.externalBytes ?? null,
      rendererArrayBuffersBytes: rendererMemory?.arrayBuffersBytes ?? null,
      rendererOldSpaceUsedBytes: rendererMemory?.heapSpaces.oldSpaceUsedBytes ?? null,
      rendererLargeObjectSpaceUsedBytes: rendererMemory?.heapSpaces.largeObjectSpaceUsedBytes ?? null,
      mainRssBytes: mainMemory?.rssBytes ?? null,
      mainHeapUsedBytes: mainMemory?.heapUsedBytes ?? null,
      mainExternalBytes: mainMemory?.externalBytes ?? null,
      mainArrayBuffersBytes: mainMemory?.arrayBuffersBytes ?? null,
      bufferMemoryMb: bufferStats ? bufferStats.totalBytes / BYTES_PER_MB : null,
      currentBufferMemoryMb: bufferStats ? bufferStats.currentBytes / BYTES_PER_MB : null,
      nextBufferMemoryMb: bufferStats ? bufferStats.nextBytes / BYTES_PER_MB : null
    })
  }
}

export async function captureTitleBarSample(): Promise<MemoryDiagnosticsTitleBarSampleSnapshot> {
  return (await captureTitleBarPerformanceSample()).memory
}
