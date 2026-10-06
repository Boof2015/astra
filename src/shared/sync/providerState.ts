import type { ProviderSyncChoice, ProviderSyncDifference, ProviderSyncField, ProviderSyncValue } from '../../types/providerSync'

export function validProviderValue(field: ProviderSyncField, value: unknown): value is ProviderSyncValue {
  return field === 'favorite' ? typeof value === 'boolean'
    : value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5)
}

export function compareProviderValue(field: ProviderSyncField, local: ProviderSyncValue,
  server: ProviderSyncValue, baseline: ProviderSyncValue | undefined): 'equal' | 'incoming' | 'outgoing' | 'review' {
  if (!validProviderValue(field, local)) return 'review'
  if (local === server) return 'equal'
  if (baseline !== undefined && local === baseline) return 'incoming'
  if (baseline !== undefined && server === baseline) return 'outgoing'
  return 'review'
}

export function resolveProviderChoice(row: ProviderSyncDifference, choice: ProviderSyncChoice): ProviderSyncValue {
  let value: ProviderSyncValue
  if (choice === 'server') value = row.server
  else if (choice === 'local') value = row.local
  else if (row.field === 'rating' && choice === 'clear') value = null
  else if (row.field === 'rating' && typeof row.local === 'number' && (choice === 'up' || choice === 'down')) {
    value = Math.max(1, Math.min(5, choice === 'up' ? Math.ceil(row.local) : Math.floor(row.local)))
  } else throw new Error('Choose a supported value for each difference.')
  if (!validProviderValue(row.field, value)) throw new Error('Subsonic ratings must be whole stars. Choose how to convert the existing rating.')
  return value
}

export function providerSyncKey(ref: { provider: string; sourceId: number }): string {
  return `${ref.provider}:${ref.sourceId}`
}

export function normalizeProviderSyncRef(value: unknown): { provider: 'subsonic' | 'jellyfin'; sourceId: number } {
  const ref = value as { provider?: unknown; sourceId?: unknown } | null
  if (!ref || (ref.provider !== 'subsonic' && ref.provider !== 'jellyfin')
    || !Number.isSafeInteger(ref.sourceId) || Number(ref.sourceId) <= 0) throw new Error('Invalid server.')
  return { provider: ref.provider, sourceId: Number(ref.sourceId) }
}
