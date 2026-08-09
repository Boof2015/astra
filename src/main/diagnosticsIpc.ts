import type { LocalPcmOutputSink, MemoryDiagnosticsLogEventOptions } from '../types/diagnostics'

export function normalizeLocalPcmOutputSink(value: unknown): LocalPcmOutputSink | null {
  if (
    value === 'stdout_pipe'
    || value === 'rechunked_pipe'
    || value === 'native_pipe'
    || value === 'preload_native'
    || value === 'worker_thread'
    || value === 'temporary_file'
  ) {
    return value
  }
  return null
}

export function resolveLegacyLocalPcmTempFileSinkChange(
  currentSink: LocalPcmOutputSink,
  enabled: boolean
): LocalPcmOutputSink {
  if (enabled) return 'temporary_file'
  return currentSink === 'temporary_file' ? 'stdout_pipe' : currentSink
}

export function normalizeMemoryDiagnosticsLogEventOptions(
  rawOptions: unknown
): MemoryDiagnosticsLogEventOptions | null {
  if (rawOptions === undefined) return {}
  if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) return null
  const captureSample = (rawOptions as MemoryDiagnosticsLogEventOptions).captureSample
  if (captureSample !== undefined && typeof captureSample !== 'boolean') return null
  return captureSample === undefined ? {} : { captureSample }
}
