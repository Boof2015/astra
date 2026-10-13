import type { ProviderSyncChoice, ProviderSyncDifference, ProviderSyncField, ProviderSyncRef, ProviderSyncValue } from '../../types/providerSync'

export function providerSyncFields(provider: ProviderSyncRef['provider']): readonly ProviderSyncField[] {
  return provider === 'plex' ? ['rating'] : provider === 'jellyfin' ? ['favorite'] : ['favorite', 'rating']
}

export function validProviderValue(field: ProviderSyncField, value: unknown,
  provider: ProviderSyncRef['provider'] = 'subsonic'): value is ProviderSyncValue {
  if (!providerSyncFields(provider).includes(field)) return false
  const step = provider === 'plex' ? 0.5 : 1
  return field === 'favorite' ? typeof value === 'boolean'
    : value === null || (typeof value === 'number' && Number.isInteger(value / step) && value >= step && value <= 5)
}

export function compareProviderValue(field: ProviderSyncField, local: ProviderSyncValue,
  server: ProviderSyncValue, baseline: ProviderSyncValue | undefined,
  provider: ProviderSyncRef['provider'] = 'subsonic'): 'equal' | 'incoming' | 'outgoing' | 'review' {
  if (!validProviderValue(field, local, provider)) return 'review'
  if (local === server) return 'equal'
  if (baseline !== undefined && local === baseline) return 'incoming'
  if (baseline !== undefined && server === baseline) return 'outgoing'
  return 'review'
}

export function resolveProviderChoice(row: ProviderSyncDifference, choice: ProviderSyncChoice,
  provider: ProviderSyncRef['provider'] = 'subsonic'): ProviderSyncValue {
  let value: ProviderSyncValue
  if (choice === 'server') value = row.server
  else if (choice === 'local') value = row.local
  else if (row.field === 'rating' && choice === 'clear') value = null
  else if (provider === 'subsonic' && row.field === 'rating' && typeof row.local === 'number' && (choice === 'up' || choice === 'down')) {
    value = Math.max(1, Math.min(5, choice === 'up' ? Math.ceil(row.local) : Math.floor(row.local)))
  } else throw new Error('Choose a supported value for each difference.')
  if (!validProviderValue(row.field, value, provider)) throw new Error(provider === 'subsonic'
    ? 'Subsonic ratings must be whole stars. Choose how to convert the existing rating.' : 'Choose a supported value for this server.')
  return value
}

export function providerSyncKey(ref: { provider: string; sourceId: number }): string {
  return `${ref.provider}:${ref.sourceId}`
}

export function normalizeProviderSyncRef(value: unknown): ProviderSyncRef {
  const ref = value as { provider?: unknown; sourceId?: unknown } | null
  if (!ref || (ref.provider !== 'subsonic' && ref.provider !== 'jellyfin' && ref.provider !== 'plex')
    || !Number.isSafeInteger(ref.sourceId) || Number(ref.sourceId) <= 0) throw new Error('Invalid server.')
  return { provider: ref.provider, sourceId: Number(ref.sourceId) }
}
