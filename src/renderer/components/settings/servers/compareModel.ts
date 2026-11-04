import { resolveProviderChoice, validProviderValue } from '../../../../shared/sync/providerState'
import type { ProviderSyncChoice, ProviderSyncDifference, ProviderSyncRef, ProviderSyncValue } from '../../../../types/providerSync'

type Provider = ProviderSyncRef['provider']

/** How the differences are settled. "Keep both" is the default. */
export type CompareRule = 'both' | 'astra' | 'server'
/** The side that wins when both have a different rating. */
export type ClashChoice = 'local' | 'server'
export type RoundChoice = 'up' | 'down'
export interface CompareSettings { rule: CompareRule; clash: ClashChoice; round: RoundChoice }
export const DEFAULT_COMPARE: CompareSettings = { rule: 'both', clash: 'local', round: 'up' }

/** Favorites, ratings, and (Subsonic only) half-star ratings the server can't store. */
export type RowKind = 'favorite' | 'rating' | 'half'

export function rowKind(row: ProviderSyncDifference, provider: Provider): RowKind {
  if (row.field === 'favorite') return 'favorite'
  return typeof row.local === 'number' && !validProviderValue('rating', row.local, provider) ? 'half' : 'rating'
}

/** A rating set on both sides, to different values. */
export function isClash(row: ProviderSyncDifference): boolean {
  return row.field === 'rating' && row.local !== null && row.server !== null
}

function valid(row: ProviderSyncDifference, choice: ProviderSyncChoice, provider: Provider): boolean {
  try { resolveProviderChoice(row, choice, provider); return true } catch { return false }
}

/**
 * What the rule chooses for one difference. Keep both: a favorite on either side
 * stays a favorite, a rating set on one side only is copied, and a clash follows
 * the clash choice. A half star the server can't store is rounded, unless the
 * server's values win (or, under Keep both, the server's rating wins a clash).
 */
export function ruleChoice(row: ProviderSyncDifference, provider: Provider, settings: CompareSettings): ProviderSyncChoice {
  const kind = rowKind(row, provider)
  let choice: ProviderSyncChoice
  if (settings.rule === 'server') choice = 'server'
  else if (kind === 'half') {
    choice = settings.rule === 'both' && isClash(row) && settings.clash === 'server' ? 'server' : settings.round
  } else if (settings.rule === 'astra') choice = 'local'
  else if (row.field === 'favorite') choice = row.local === true ? 'local' : 'server'
  else if (!isClash(row)) choice = row.local !== null ? 'local' : 'server'
  else choice = settings.clash
  // The server's own value is always storable; never send a choice the server would refuse.
  return valid(row, choice, provider) ? choice : 'server'
}

/** One choice per difference: the rule, unless the user picked one for that row. */
export function resolveChoices(rows: readonly ProviderSyncDifference[], provider: Provider, settings: CompareSettings,
  overrides: Readonly<Record<string, ProviderSyncChoice>>): Record<string, ProviderSyncChoice> {
  const choices: Record<string, ProviderSyncChoice> = {}
  for (const row of rows) {
    const picked = overrides[row.key]
    choices[row.key] = picked && valid(row, picked, provider) ? picked : ruleChoice(row, provider, settings)
  }
  return choices
}

/**
 * Tracks whose server values change, and tracks whose Astra values change, by the
 * value each choice actually produces: rounding 3.5 up to a server's existing 4
 * changes only Astra. Tracks with several changed fields count once per side.
 */
export function compareSummary(rows: readonly ProviderSyncDifference[], choices: Readonly<Record<string, ProviderSyncChoice>>,
  provider: Provider) {
  const server = new Set<string>(), astra = new Set<string>()
  for (const row of rows) {
    let value: ProviderSyncValue
    try { value = resolveProviderChoice(row, choices[row.key], provider) } catch { continue }
    if (value !== row.server) server.add(row.path)
    if (value !== row.local) astra.add(row.path)
  }
  return { serverTracks: server.size, astraTracks: astra.size }
}

/**
 * Tracks whose values already agree. The review's `matchedTracks` counts every
 * track found on the server, differing ones included, so those are taken out.
 */
export function agreeingTracks(matchedTracks: number, rows: readonly ProviderSyncDifference[]): number {
  return Math.max(0, matchedTracks - new Set(rows.map(row => row.path)).size)
}

export function formatProviderValue(value: ProviderSyncValue): string {
  if (typeof value === 'boolean') return value ? 'Favorite' : 'Not a favorite'
  if (value === null) return 'Unrated'
  return '★'.repeat(Math.floor(value)) + (value % 1 ? '½' : '')
}

/**
 * The choices a row offers, each labelled with the value it keeps. A rating set on
 * both sides can also be cleared on both; otherwise picking the unrated side clears it.
 */
export function rowOptions(row: ProviderSyncDifference, provider: Provider): { value: ProviderSyncChoice; label: string }[] {
  const options: { value: ProviderSyncChoice; label: string }[] = rowKind(row, provider) === 'half' && typeof row.local === 'number'
    ? [
        { value: 'up', label: `Up · ${formatProviderValue(Math.min(5, Math.ceil(row.local)))}` },
        { value: 'down', label: `Down · ${formatProviderValue(Math.max(1, Math.floor(row.local)))}` },
        { value: 'server', label: `Server · ${formatProviderValue(row.server)}` }
      ]
    : [
        { value: 'local', label: `Astra · ${formatProviderValue(row.local)}` },
        { value: 'server', label: `Server · ${formatProviderValue(row.server)}` }
      ]
  if (isClash(row)) options.push({ value: 'clear', label: 'Clear' })
  return options
}

export const SYNCED_VALUES: Record<Provider, string> = {
  subsonic: 'favorites and ratings',
  jellyfin: 'favorites',
  plex: 'ratings'
}

export const KEEP_BOTH_DESCRIPTION: Record<Provider, string> = {
  subsonic: 'A favorite on either side stays a favorite, and a rating set on only one side is copied to the other.',
  jellyfin: 'A favorite on either side stays a favorite.',
  plex: 'A rating set on only one side is copied to the other.'
}
