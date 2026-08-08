import type { MemoryDiagnosticsLogEventOptions } from '../types/diagnostics'

export function normalizeMemoryDiagnosticsLogEventOptions(
  rawOptions: unknown
): MemoryDiagnosticsLogEventOptions | null {
  if (rawOptions === undefined) return {}
  if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) return null
  const captureSample = (rawOptions as MemoryDiagnosticsLogEventOptions).captureSample
  if (captureSample !== undefined && typeof captureSample !== 'boolean') return null
  return captureSample === undefined ? {} : { captureSample }
}
