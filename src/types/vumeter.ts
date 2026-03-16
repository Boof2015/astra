export type VUMeterMode = 'needle' | 'bar'

export const VU_METER_MODES: readonly VUMeterMode[] = ['needle', 'bar']

export const DEFAULT_VU_METER_MODE: VUMeterMode = 'bar'

export function isVUMeterMode(value: unknown): value is VUMeterMode {
  return typeof value === 'string' && VU_METER_MODES.includes(value as VUMeterMode)
}
