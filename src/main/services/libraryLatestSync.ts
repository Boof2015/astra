import { randomUUID } from 'crypto'

export interface LatestLibrarySyncSummary {
  sessionKey: string
  completedAt: number
  newAlbumIdentityKeys: string[]
}

interface LatestLibrarySyncSession {
  activeCount: number
  hadSuccess: boolean
  beforeAlbumIdentityKeys: Set<string>
}

export interface LibraryLatestSyncCoordinatorOptions {
  getCurrentAlbumIdentityKeys: () => Iterable<string>
  publishSummary: (summary: LatestLibrarySyncSummary) => Promise<void> | void
  now?: () => number
  createSessionKey?: () => string
}

function normalizeIdentityKeys(keys: Iterable<string>): string[] {
  const uniqueKeys = new Set<string>()

  for (const key of keys) {
    if (typeof key !== 'string') continue
    const normalized = key.trim()
    if (!normalized) continue
    uniqueKeys.add(normalized)
  }

  return Array.from(uniqueKeys).sort((a, b) => a.localeCompare(b))
}

export function createLibraryLatestSyncSessionKey(): string {
  return randomUUID()
}

export function buildLatestLibrarySyncSummary(
  sessionKey: string,
  beforeAlbumIdentityKeys: Iterable<string>,
  afterAlbumIdentityKeys: Iterable<string>,
  completedAt: number
): LatestLibrarySyncSummary {
  const beforeKeys = new Set(normalizeIdentityKeys(beforeAlbumIdentityKeys))
  const afterKeys = normalizeIdentityKeys(afterAlbumIdentityKeys)

  return {
    sessionKey,
    completedAt,
    newAlbumIdentityKeys: afterKeys.filter((key) => !beforeKeys.has(key))
  }
}

export function isTrackNewForLatestSync(
  trackSyncSessionKey: string | null | undefined,
  summary: LatestLibrarySyncSummary | null,
  latestSyncDismissedAt?: number | null
): boolean {
  if (!summary?.sessionKey) return false
  if (
    typeof latestSyncDismissedAt === 'number'
    && Number.isFinite(latestSyncDismissedAt)
    && latestSyncDismissedAt >= summary.completedAt
  ) {
    return false
  }
  return trackSyncSessionKey === summary.sessionKey
}

export function isAlbumNewForLatestSync(
  albumIdentityKey: string,
  summary: LatestLibrarySyncSummary | null,
  hasUnplayedLatestSyncTrack: boolean = true
): boolean {
  if (!summary) return false
  if (!hasUnplayedLatestSyncTrack) return false
  return summary.newAlbumIdentityKeys.includes(albumIdentityKey)
}

export class LibraryLatestSyncCoordinator {
  private readonly options: LibraryLatestSyncCoordinatorOptions
  private readonly sessions = new Map<string, LatestLibrarySyncSession>()
  private readonly now: () => number
  private readonly createSessionKey: () => string

  constructor(options: LibraryLatestSyncCoordinatorOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
    this.createSessionKey = options.createSessionKey ?? createLibraryLatestSyncSessionKey
  }

  beginOperation(requestedSessionKey?: string | null): string {
    const sessionKey = typeof requestedSessionKey === 'string' && requestedSessionKey.trim()
      ? requestedSessionKey.trim()
      : this.createSessionKey()

    const existing = this.sessions.get(sessionKey)
    if (existing) {
      existing.activeCount += 1
      return sessionKey
    }

    this.sessions.set(sessionKey, {
      activeCount: 1,
      hadSuccess: false,
      beforeAlbumIdentityKeys: new Set(normalizeIdentityKeys(this.options.getCurrentAlbumIdentityKeys()))
    })

    return sessionKey
  }

  async endOperation(sessionKey: string, success: boolean): Promise<LatestLibrarySyncSummary | null> {
    const session = this.sessions.get(sessionKey)
    if (!session) return null

    if (success) {
      session.hadSuccess = true
    }

    session.activeCount = Math.max(0, session.activeCount - 1)
    if (session.activeCount > 0) {
      return null
    }

    this.sessions.delete(sessionKey)
    if (!session.hadSuccess) {
      return null
    }

    const summary = buildLatestLibrarySyncSummary(
      sessionKey,
      session.beforeAlbumIdentityKeys,
      this.options.getCurrentAlbumIdentityKeys(),
      this.now()
    )
    await this.options.publishSummary(summary)
    return summary
  }
}
