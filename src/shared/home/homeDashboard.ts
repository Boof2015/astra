import type { HomeRediscoveryRelease, HomeReleaseSummary } from '../../types/home'

const DAY_MS = 24 * 60 * 60 * 1000
const FAVORITE_AGE_MS = 30 * DAY_MS
const NEVER_PLAYED_GRACE_MS = 14 * DAY_MS
const LONG_UNHEARD_AGE_MS = 90 * DAY_MS

export interface SelectHomeRediscoveryOptions {
  now: number
  dayKey: string
  rotation: number
  limit: number
  excludedIdentityKeys?: ReadonlySet<string>
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function orderForRotation(
  releases: readonly HomeRediscoveryRelease[],
  dayKey: string,
  rotation: number,
  pool: string
): HomeRediscoveryRelease[] {
  const seed = `${dayKey}:${Math.max(0, Math.trunc(rotation))}:${pool}:`
  return [...releases].sort((a, b) => {
    const comparison = stableHash(seed + a.identity_key) - stableHash(seed + b.identity_key)
    return comparison || a.identity_key.localeCompare(b.identity_key)
  })
}

export function formatHomeRediscoveryAge(timestamp: number, now: number): string {
  const days = Math.max(1, Math.floor((now - timestamp) / DAY_MS))
  if (days < 60) return `${days} ${days === 1 ? 'day' : 'days'} ago`
  const months = Math.max(2, Math.floor(days / 30))
  if (months < 18) return `${months} months ago`
  const years = Math.max(1, Math.floor(months / 12))
  return `${years} ${years === 1 ? 'year' : 'years'} ago`
}

function classifyRelease(release: HomeReleaseSummary, now: number): HomeRediscoveryRelease | null {
  const lastPlayedAge = release.last_played_at === null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, now - release.last_played_at)

  if (release.favorite_track_count > 0 && lastPlayedAge >= FAVORITE_AGE_MS) {
    return {
      ...release,
      reason: release.last_played_at === null
        ? 'Favorite'
        : `Favorite · ${formatHomeRediscoveryAge(release.last_played_at, now)}`,
      reason_kind: 'favorite'
    }
  }

  if (
    release.favorite_track_count === 0
    && release.play_count <= 0
    && now - release.latest_added_at >= NEVER_PLAYED_GRACE_MS
  ) {
    return {
      ...release,
      reason: release.latest_added_at > 0
        ? `Added ${formatHomeRediscoveryAge(release.latest_added_at, now)}`
        : 'Unplayed release',
      reason_kind: 'never-played'
    }
  }

  if (release.last_played_at !== null && lastPlayedAge >= LONG_UNHEARD_AGE_MS) {
    return {
      ...release,
      reason: `Last played ${formatHomeRediscoveryAge(release.last_played_at, now)}`,
      reason_kind: 'long-unheard'
    }
  }

  return null
}

export function selectHomeRediscovery(
  releases: readonly HomeReleaseSummary[],
  options: SelectHomeRediscoveryOptions
): HomeRediscoveryRelease[] {
  const limit = Math.max(0, Math.min(24, Math.trunc(options.limit)))
  if (limit === 0) return []
  const excluded = options.excludedIdentityKeys ?? new Set<string>()
  const eligible = releases.filter((release) => (
    release.available_track_count > 0 && !excluded.has(release.identity_key)
  ))
  const classified = eligible.map((release) => classifyRelease(release, options.now)).filter(
    (release): release is HomeRediscoveryRelease => release !== null
  )
  const pools = (['favorite', 'never-played', 'long-unheard'] as const).map((kind) => (
    orderForRotation(
      classified.filter((release) => release.reason_kind === kind),
      options.dayKey,
      options.rotation,
      kind
    )
  ))

  const selected: HomeRediscoveryRelease[] = []
  const selectedKeys = new Set<string>()
  let poolIndex = 0
  while (selected.length < limit && pools.some((pool) => pool.length > 0)) {
    const pool = pools[poolIndex % pools.length]
    const candidate = pool.shift()
    poolIndex += 1
    if (!candidate || selectedKeys.has(candidate.identity_key)) continue
    selected.push(candidate)
    selectedKeys.add(candidate.identity_key)
  }

  if (selected.length >= limit) return selected
  const fallback = orderForRotation(
    eligible
      .filter((release) => (
        !selectedKeys.has(release.identity_key)
        && (release.last_played_at === null || options.now - release.last_played_at >= FAVORITE_AGE_MS)
      ))
      .map((release): HomeRediscoveryRelease => ({
        ...release,
        reason: 'From your library',
        reason_kind: 'fallback'
      })),
    options.dayKey,
    options.rotation,
    'fallback'
  )
  return selected.concat(fallback.slice(0, limit - selected.length))
}

export function getLocalDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
