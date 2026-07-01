export type VUMeterMode = 'needle' | 'bar'
export type VUMeterOrientation = 'horizontal' | 'vertical'
export type VUMeterNeedleChannels = 'stereo' | 'combined'

export const VU_METER_MODES: readonly VUMeterMode[] = ['needle', 'bar']
export const VU_METER_ORIENTATIONS: readonly VUMeterOrientation[] = ['horizontal', 'vertical']
export const VU_METER_NEEDLE_CHANNELS: readonly VUMeterNeedleChannels[] = ['stereo', 'combined']

export const DEFAULT_VU_METER_MODE: VUMeterMode = 'bar'
export const DEFAULT_VU_METER_ORIENTATION: VUMeterOrientation = 'horizontal'
export const DEFAULT_VU_METER_NEEDLE_CHANNELS: VUMeterNeedleChannels = 'stereo'

// Reference-level calibration: 0 VU corresponds to this dBFS value.
export const DEFAULT_VU_REFERENCE_DBFS = -14
export const VU_REFERENCE_MIN_DBFS = -30
export const VU_REFERENCE_MAX_DBFS = 0

export interface VUReferencePreset {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly dbfs: number
}

export const VU_REFERENCE_PRESETS: readonly VUReferencePreset[] = [
  { id: 'k20', label: 'K-20', description: 'SMPTE film', dbfs: -20 },
  { id: 'k18', label: 'K-18', description: 'EBU broadcast', dbfs: -18 },
  { id: 'k14', label: 'K-14', description: 'Streaming', dbfs: -14 },
  { id: 'k12', label: 'K-12', description: 'Modern music', dbfs: -12 },
  { id: 'k10', label: 'K-10', description: 'Loud masters', dbfs: -10 },
  { id: 'k6', label: 'K-6', description: 'Hot / legacy', dbfs: -6 },
]

export function isVUMeterMode(value: unknown): value is VUMeterMode {
  return typeof value === 'string' && VU_METER_MODES.includes(value as VUMeterMode)
}

export function isVUMeterOrientation(value: unknown): value is VUMeterOrientation {
  return typeof value === 'string' && VU_METER_ORIENTATIONS.includes(value as VUMeterOrientation)
}

export function isVUMeterNeedleChannels(value: unknown): value is VUMeterNeedleChannels {
  return typeof value === 'string' && VU_METER_NEEDLE_CHANNELS.includes(value as VUMeterNeedleChannels)
}

export function sanitizeVUReferenceDbfs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_VU_REFERENCE_DBFS
  }
  if (value < VU_REFERENCE_MIN_DBFS) return VU_REFERENCE_MIN_DBFS
  if (value > VU_REFERENCE_MAX_DBFS) return VU_REFERENCE_MAX_DBFS
  return value
}

export function findVUReferencePreset(dbfs: number): VUReferencePreset | null {
  return VU_REFERENCE_PRESETS.find((preset) => Math.abs(preset.dbfs - dbfs) < 1e-6) ?? null
}
