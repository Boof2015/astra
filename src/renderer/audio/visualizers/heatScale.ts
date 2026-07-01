export const HEAT_MIN_DB = -100
export const HEAT_LOW_DB = -80
export const HEAT_MID_DB = -60
export const HEAT_MAX_DB = -20

const HEAT_DB_RANGE = HEAT_MAX_DB - HEAT_MIN_DB

export function normalizeHeatDb(db: number): number {
  if (!Number.isFinite(db)) {
    return 0
  }
  return Math.max(0, Math.min(1, (db - HEAT_MIN_DB) / HEAT_DB_RANGE))
}
