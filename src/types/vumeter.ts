export type VUMeterMode = 'needle' | 'bar'
export type VUMeterOrientation = 'horizontal' | 'vertical'

export const VU_METER_MODES: readonly VUMeterMode[] = ['needle', 'bar']
export const VU_METER_ORIENTATIONS: readonly VUMeterOrientation[] = ['horizontal', 'vertical']

export const DEFAULT_VU_METER_MODE: VUMeterMode = 'bar'
export const DEFAULT_VU_METER_ORIENTATION: VUMeterOrientation = 'horizontal'

export function isVUMeterMode(value: unknown): value is VUMeterMode {
  return typeof value === 'string' && VU_METER_MODES.includes(value as VUMeterMode)
}

export function isVUMeterOrientation(value: unknown): value is VUMeterOrientation {
  return typeof value === 'string' && VU_METER_ORIENTATIONS.includes(value as VUMeterOrientation)
}
