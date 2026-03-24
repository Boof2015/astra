export type LUFSMeterMode = 'bar'

export const LUFS_METER_MODES: readonly LUFSMeterMode[] = ['bar']

export const DEFAULT_LUFS_METER_MODE: LUFSMeterMode = 'bar'

export function isLUFSMeterMode(value: unknown): value is LUFSMeterMode {
  return typeof value === 'string' && LUFS_METER_MODES.includes(value as LUFSMeterMode)
}
