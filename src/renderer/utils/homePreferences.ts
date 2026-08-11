export type HomeSkyTimeMode = 'realtime' | 'fixed'

export interface HomeSkyTimePreference {
  mode: HomeSkyTimeMode
  fixedMinutes: number | null
}

export type HomeModuleId =
  | 'jump-back-in'
  | 'rediscover'
  | 'pinned-playlists'
  | 'recent-tracks'
  | 'newly-added'
  | 'listening-snapshot'

export interface HomeModulePreference {
  id: HomeModuleId
  visible: boolean
}

export interface HomeLayoutPreference {
  version: 1
  modules: HomeModulePreference[]
}

export const HOME_SKY_TIME_STEP_MINUTES = 30
export const HOME_SKY_TIME_MAX_MINUTES = 23 * 60 + 30
export const DEFAULT_HOME_SKY_TIME_PREFERENCE: HomeSkyTimePreference = {
  mode: 'realtime',
  fixedMinutes: null
}

export const HOME_MODULE_IDS: readonly HomeModuleId[] = [
  'jump-back-in',
  'rediscover',
  'pinned-playlists',
  'recent-tracks',
  'newly-added',
  'listening-snapshot'
]

export const DEFAULT_HOME_LAYOUT_PREFERENCE: HomeLayoutPreference = {
  version: 1,
  modules: [
    { id: 'jump-back-in', visible: true },
    { id: 'rediscover', visible: true },
    { id: 'pinned-playlists', visible: true },
    { id: 'recent-tracks', visible: false },
    { id: 'newly-added', visible: false },
    { id: 'listening-snapshot', visible: false }
  ]
}

const HOME_MODULE_ID_SET = new Set<HomeModuleId>(HOME_MODULE_IDS)

export function normalizeHomeSkyFixedMinutes(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  const snapped = Math.round(numeric / HOME_SKY_TIME_STEP_MINUTES) * HOME_SKY_TIME_STEP_MINUTES
  return Math.max(0, Math.min(HOME_SKY_TIME_MAX_MINUTES, snapped))
}

export function getRoundedCurrentSkyMinutes(date: Date): number {
  const rawMinutes = date.getHours() * 60 + date.getMinutes()
  const snapped = Math.round(rawMinutes / HOME_SKY_TIME_STEP_MINUTES) * HOME_SKY_TIME_STEP_MINUTES
  return snapped > HOME_SKY_TIME_MAX_MINUTES ? 0 : snapped
}

export function setHomeSkyTimeModePreference(
  preference: HomeSkyTimePreference,
  mode: HomeSkyTimeMode,
  now: Date = new Date()
): HomeSkyTimePreference {
  const current = normalizeHomeSkyTimePreference(preference)
  const nextMode: HomeSkyTimeMode = mode === 'fixed' ? 'fixed' : 'realtime'
  return normalizeHomeSkyTimePreference({
    mode: nextMode,
    fixedMinutes: nextMode === 'fixed' && current.fixedMinutes === null
      ? getRoundedCurrentSkyMinutes(now)
      : current.fixedMinutes
  })
}

export function normalizeHomeSkyTimePreference(value: unknown): HomeSkyTimePreference {
  if (!value || typeof value !== 'object') return { ...DEFAULT_HOME_SKY_TIME_PREFERENCE }
  const candidate = value as Partial<HomeSkyTimePreference>
  const fixedMinutes = normalizeHomeSkyFixedMinutes(candidate.fixedMinutes)
  const mode = candidate.mode === 'fixed' && fixedMinutes !== null ? 'fixed' : 'realtime'
  return {
    mode,
    fixedMinutes
  }
}

export function resolveHomeSkyDate(realDate: Date, preference: HomeSkyTimePreference): Date {
  if (preference.mode !== 'fixed' || preference.fixedMinutes === null) return realDate
  const skyDate = new Date(realDate)
  skyDate.setHours(
    Math.floor(preference.fixedMinutes / 60),
    preference.fixedMinutes % 60,
    0,
    0
  )
  return skyDate
}

export function formatHomeSkyTime(minutes: number | null, locales?: string | string[]): string {
  const normalized = normalizeHomeSkyFixedMinutes(minutes) ?? 0
  const date = new Date(2000, 0, 1, Math.floor(normalized / 60), normalized % 60)
  return new Intl.DateTimeFormat(locales, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
}

function cloneDefaultHomeLayout(): HomeLayoutPreference {
  return {
    version: 1,
    modules: DEFAULT_HOME_LAYOUT_PREFERENCE.modules.map((module) => ({ ...module }))
  }
}

export function normalizeHomeLayoutPreference(value: unknown): HomeLayoutPreference {
  if (!value || typeof value !== 'object') return cloneDefaultHomeLayout()
  const candidate = value as { version?: unknown; modules?: unknown }
  if (candidate.version !== 1 || !Array.isArray(candidate.modules)) return cloneDefaultHomeLayout()

  const modules: HomeModulePreference[] = []
  const seen = new Set<HomeModuleId>()
  for (const rawModule of candidate.modules) {
    if (!rawModule || typeof rawModule !== 'object') continue
    const module = rawModule as { id?: unknown; visible?: unknown }
    if (typeof module.id !== 'string' || !HOME_MODULE_ID_SET.has(module.id as HomeModuleId)) continue
    const id = module.id as HomeModuleId
    if (seen.has(id)) continue
    seen.add(id)
    modules.push({ id, visible: module.visible === true })
  }

  if (modules.length === 0) return cloneDefaultHomeLayout()
  for (const id of HOME_MODULE_IDS) {
    if (!seen.has(id)) modules.push({ id, visible: false })
  }
  return { version: 1, modules }
}

export function moveHomeModule(
  preference: HomeLayoutPreference,
  moduleId: HomeModuleId,
  targetIndex: number
): HomeLayoutPreference {
  const normalized = normalizeHomeLayoutPreference(preference)
  const sourceIndex = normalized.modules.findIndex((module) => module.id === moduleId)
  if (sourceIndex < 0) return normalized
  const clampedTarget = Math.max(0, Math.min(normalized.modules.length - 1, Math.trunc(targetIndex)))
  if (sourceIndex === clampedTarget) return normalized
  const modules = normalized.modules.map((module) => ({ ...module }))
  const [moved] = modules.splice(sourceIndex, 1)
  modules.splice(clampedTarget, 0, moved)
  return { version: 1, modules }
}

export function setHomeModuleVisible(
  preference: HomeLayoutPreference,
  moduleId: HomeModuleId,
  visible: boolean
): HomeLayoutPreference {
  const normalized = normalizeHomeLayoutPreference(preference)
  return {
    version: 1,
    modules: normalized.modules.map((module) => (
      module.id === moduleId ? { ...module, visible: Boolean(visible) } : { ...module }
    ))
  }
}
