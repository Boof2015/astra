export type LUFSMeterMode = 'bar'
export type LUFSMeterReadout = 'integrated' | 'shortTerm' | 'momentary'

export const LUFS_METER_MODES: readonly LUFSMeterMode[] = ['bar']
export const LUFS_METER_READOUTS: readonly LUFSMeterReadout[] = ['integrated', 'shortTerm', 'momentary']

export const DEFAULT_LUFS_METER_MODE: LUFSMeterMode = 'bar'
export const DEFAULT_LUFS_METER_READOUT: LUFSMeterReadout = 'shortTerm'

export function isLUFSMeterMode(value: unknown): value is LUFSMeterMode {
  return typeof value === 'string' && LUFS_METER_MODES.includes(value as LUFSMeterMode)
}

export function isLUFSMeterReadout(value: unknown): value is LUFSMeterReadout {
  return typeof value === 'string' && LUFS_METER_READOUTS.includes(value as LUFSMeterReadout)
}
