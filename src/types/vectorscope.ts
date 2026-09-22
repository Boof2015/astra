export const MIN_VECTORSCOPE_ZOOM_DB = -12
export const MAX_VECTORSCOPE_ZOOM_DB = 24
export const VECTORSCOPE_ZOOM_STEP_DB = 1
export const DEFAULT_VECTORSCOPE_ZOOM_DB = 0

export function normalizeVectorscopeZoomDb(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(numeric)) return DEFAULT_VECTORSCOPE_ZOOM_DB

  const clamped = Math.min(MAX_VECTORSCOPE_ZOOM_DB, Math.max(MIN_VECTORSCOPE_ZOOM_DB, numeric))
  return Math.round(clamped / VECTORSCOPE_ZOOM_STEP_DB) * VECTORSCOPE_ZOOM_STEP_DB
}

export function vectorscopeZoomDbToGain(value: unknown): number {
  return 10 ** (normalizeVectorscopeZoomDb(value) / 20)
}

export function vectorscopeReferenceDbfs(value: unknown): number {
  return -normalizeVectorscopeZoomDb(value)
}

export function formatVectorscopeZoomDb(value: unknown): string {
  const zoomDb = normalizeVectorscopeZoomDb(value)
  return `${zoomDb > 0 ? '+' : ''}${zoomDb} dB`
}

export function formatVectorscopeReferenceDbfs(value: unknown): string {
  const referenceDbfs = vectorscopeReferenceDbfs(value)
  return `${referenceDbfs > 0 ? '+' : ''}${referenceDbfs} dBFS`
}
