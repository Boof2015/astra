import type { StreamingQuality } from '../../../../types/streamingQuality'
import type { ConnectionFailureKind } from '../../../../types/subsonic'

export type ServerProvider = 'subsonic' | 'jellyfin' | 'plex'

/**
 * What a server's row says about it. Offline, sign-in expired and a sync problem are
 * all 'failed'; `serverProblem` says which.
 */
export type ServerState = 'connected' | 'syncing' | 'checking' | 'failed' | 'off'

/**
 * What went wrong with a failed server, for the fix the app offers: wait for it to
 * come back (offline), sign in again (signed-out), or retry and read the message (sync).
 */
export type ServerProblem = 'offline' | 'signed-out' | 'sync'

export function serverProblem(errorKind: string | null | undefined): ServerProblem {
  return errorKind === 'unreachable' ? 'offline' : errorKind === 'auth' ? 'signed-out' : 'sync'
}

export interface ServerProgress {
  activity: string
  current: number | null
  total: number | null
}

export const PROVIDER_KIND: Record<ServerProvider, string> = {
  subsonic: 'Subsonic / Navidrome',
  jellyfin: 'Jellyfin',
  plex: 'Plex'
}

export const PROVIDER_MONOGRAM: Record<ServerProvider, string> = {
  subsonic: 'SN',
  jellyfin: 'JF',
  plex: 'PX'
}

export function deriveServerState(enabled: boolean, status: string | undefined, progress: ServerProgress | null): ServerState {
  if (!enabled) return 'off'
  if (progress || status === 'syncing') return 'syncing'
  if (status === 'error') return 'failed'
  if (status === 'ok') return 'connected'
  return 'checking'
}

/**
 * Whether a sync worked, by what the source recorded rather than by the request
 * settling: Subsonic and Jellyfin record a failed sync and still resolve. Live
 * status wins over the stored row. Anything but 'ok' (still syncing, error) isn't success.
 */
export function syncSucceeded(liveStatus: string | undefined, storedStatus: string | undefined): boolean {
  return (liveStatus ?? storedStatus) === 'ok'
}

/** Host and port only, for the quiet meta line. The full address shows on the server's page. */
export function hostOf(address: string): string {
  try { return new URL(address).host || address } catch { return address }
}

/** Error text without Electron's "Error invoking remote method …" wrapper. */
export function cleanIpcError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').trim() || fallback
}

function parseAddress(address: string): URL | null {
  const trimmed = address.trim()
  if (!trimmed) return null
  try { return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`) } catch { return null }
}

/** Which server type to try first. Jellyfin's usual port or path makes it the likelier one. */
export function detectionOrder(address: string): ('subsonic' | 'jellyfin')[] {
  const lower = address.toLowerCase()
  return lower.includes(':8096') || lower.includes('/jellyfin') ? ['jellyfin', 'subsonic'] : ['subsonic', 'jellyfin']
}

/** The name a new server starts with: its host, without scheme or port. */
export function defaultServerName(address: string): string {
  return parseAddress(address)?.hostname || address.trim()
}

/** "Couldn't sign in to <this>". */
export function addressHost(address: string): string {
  return parseAddress(address)?.host || address.trim() || 'that address'
}

/** One connection check while adding or changing an address server. */
export interface ConnectionAttempt {
  failure?: ConnectionFailureKind
  /** The main process's plain sentence. */
  error?: string
}

// When detection tried both types, the attempt that learned the most speaks: a server that
// answered (refusing the sign-in, or with its own error) over one that couldn't be reached,
// and that over "not this kind of server", which the other type's attempt usually explains.
const FAILURE_WEIGHT: Record<ConnectionFailureKind, number> = {
  auth: 6, incompatible: 5, 'server-error': 4, other: 3, certificate: 2, 'secure-connection': 2, unreachable: 1, 'not-server': 0
}

/**
 * What a failed Connect says: a title, a sentence, and whether choosing the server type
 * could help (not when nothing answered or no secure connection could be set up: the type
 * doesn't matter then).
 */
export function connectionFailureText(host: string, attempts: readonly ConnectionAttempt[]): { title: string; detail: string; offerTypes: boolean } {
  const best = [...attempts].sort((a, b) => FAILURE_WEIGHT[b.failure ?? 'other'] - FAILURE_WEIGHT[a.failure ?? 'other'])[0]
  const kind = best?.failure ?? 'other'
  const neitherType = attempts.length > 1 && attempts.every(attempt => attempt.failure === 'not-server')
  return {
    title: kind === 'auth' ? `Couldn’t sign in to ${host}.` : `Couldn’t connect to ${host}.`,
    detail: neitherType
      ? 'The server answered, but not as a Jellyfin, Navidrome or Subsonic server. Check the address, including any path (like /jellyfin).'
      : best?.error ?? 'Check the address, username and password.',
    offerTypes: kind !== 'unreachable' && kind !== 'certificate' && kind !== 'secure-connection'
  }
}

/** How a Subsonic-compatible server introduces itself: "navidrome" reads as Navidrome. */
export function subsonicProductName(serverType: string | null | undefined): string {
  if (!serverType) return 'Subsonic'
  return serverType.charAt(0).toUpperCase() + serverType.slice(1)
}

const count = (value: number) => value.toLocaleString('en-US')

/** "Loading tracks 1,240 / 8,412", or "Connecting to server…" while there's nothing to count yet. */
export function progressText(progress: ServerProgress): string {
  const label = progress.activity.trim().replace(/(?:\.\.\.|…)$/, '')
  return progressFraction(progress) === null ? `${label}…` : `${label} ${count(progress.current ?? 0)} / ${count(progress.total!)}`
}

/** Null while the phase has no total, which shows the transport's sweeping bar instead of a fill. */
export function progressFraction(progress: ServerProgress): number | null {
  if (progress.total === null || !(progress.total > 0)) return null
  return Math.min(1, Math.max(0, (progress.current ?? 0) / progress.total))
}

export function formatAgo(timestamp: number, now: number): string {
  const minutes = Math.floor((now - timestamp) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}

/** The Details row. A server that's not in use isn't contacted, so it isn't checked either. */
export function lastSyncedText(server: { state: ServerState; enabled: boolean; lastSyncAt: number | null }, now: number): string {
  if (server.state === 'syncing') return 'Syncing now · checks every 20 min'
  const ago = server.lastSyncAt ? formatAgo(server.lastSyncAt, now) : 'Not yet'
  return server.enabled ? `${ago} · checks every 20 min` : ago
}

/** "1 track", "8,412 tracks". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

/**
 * Details' "In your library": hidden while the server is off, "8,412 tracks · 1,204 albums"
 * once its music is in. Nothing to show (null) until the counts are read, or before a
 * first sync has brought anything in.
 */
export function libraryCountsText(server: { enabled: boolean; lastSyncAt: number | null },
  counts: { tracks: number; albums: number | null } | null): string | null {
  if (!server.enabled) return 'Hidden'
  if (!counts || (counts.tracks === 0 && server.lastSyncAt === null)) return null
  if (counts.tracks === 0) return 'No tracks'
  return counts.albums === null ? plural(counts.tracks, 'track') : `${plural(counts.tracks, 'track')} · ${plural(counts.albums, 'album')}`
}

/* ---------- Streaming quality ---------- */

export type QualityMode = 'automatic' | 'original' | 'fixed'
export type AutomaticPriority = 'balanced' | 'original'
export const QUALITY_BITRATES = [64, 128, 192, 256, 320] as const
export type QualityBitrate = typeof QUALITY_BITRATES[number]
export const DEFAULT_FIXED_BITRATE: QualityBitrate = 192

export const QUALITY_DESCRIPTION: Record<QualityMode, string> = {
  automatic: 'Adapts to your connection.',
  original: 'Plays the server’s file as is.',
  fixed: 'Always streams at the bitrate you pick.'
}

export function qualityMode(quality: StreamingQuality): QualityMode {
  if (quality === 'automatic' || quality === 'automatic-original') return 'automatic'
  return quality === 'original' ? 'original' : 'fixed'
}

export function qualityLabel(quality: StreamingQuality): string {
  if (quality === 'automatic') return 'Automatic'
  if (quality === 'automatic-original') return 'Automatic, prefer original'
  if (quality === 'original') return 'Original'
  return `Fixed, ${quality} kbps`
}

/** The three choices plus their follow-ups resolve to one of the eight stored values. */
export function qualityFromChoice(mode: QualityMode, priority: AutomaticPriority, bitrate: QualityBitrate): StreamingQuality {
  if (mode === 'automatic') return priority === 'original' ? 'automatic-original' : 'automatic'
  return mode === 'original' ? 'original' : bitrate
}

/**
 * What the follow-up rows show. The open row always reflects the saved value, so a
 * failed save can't leave an unsaved choice selected. The remembered choice only fills
 * the closed row, so switching modes back restores what you had.
 */
export function qualityFollowUps(current: StreamingQuality | null, remembered: { priority: AutomaticPriority; bitrate: QualityBitrate }) {
  return {
    priority: current === 'automatic-original' ? 'original' as const : current === 'automatic' ? 'balanced' as const : remembered.priority,
    bitrate: typeof current === 'number' ? current : remembered.bitrate
  }
}

export interface QualityCopyInput {
  global: StreamingQuality
  overrides: Readonly<Record<string, StreamingQuality>>
  /** Keys match streaming quality override keys ("provider:id"). */
  servers: readonly { key: string; name: string }[]
  /** Set for one server's own control. */
  serverKey?: string
}

function namesSentence(names: string[]): string {
  if (names.length === 1) return `${names[0]} uses its own setting.`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} use their own settings.`
}

/**
 * Label and description for a quality control. With one server, quality reads as a
 * single setting, unless that server already has its own setting (left by the old
 * panel, or by removing the other servers): then the control is the default, and the
 * exception is named with its value, since there's no server page to see it on.
 */
export function qualityCopy({ global, overrides, servers, serverKey }: QualityCopyInput): {
  label: string
  description: string
  /** Servers that don't follow the default; empty for a server's own control. */
  overridden: { key: string; name: string; quality: StreamingQuality }[]
} {
  if (serverKey) {
    const own = overrides[serverKey]
    return {
      label: 'Quality for this server',
      description: own === undefined
        ? `Follows your default (${qualityLabel(global)}).`
        : `Overrides your default (${qualityLabel(global)}). ${QUALITY_DESCRIPTION[qualityMode(own)]}`,
      overridden: []
    }
  }
  const overridden = servers.filter(server => overrides[server.key] !== undefined)
    .map(server => ({ key: server.key, name: server.name, quality: overrides[server.key] }))
  const base = QUALITY_DESCRIPTION[qualityMode(global)]
  if (servers.length <= 1) {
    if (!overridden.length) return { label: 'Quality', description: base, overridden }
    const [own] = overridden
    return { label: 'Default quality', description: `${base} ${own.name} uses its own setting (${qualityLabel(own.quality)}).`, overridden }
  }
  return {
    label: 'Default quality',
    description: `${base} ${overridden.length ? namesSentence(overridden.map(server => server.name)) : 'Each server can override it.'}`,
    overridden
  }
}

/* ---------- Ordered saves ---------- */

/** Runs writes one at a time, in the order they were asked for. */
export class SerialQueue {
  private chain: Promise<unknown> = Promise.resolve()
  run<R>(work: () => Promise<R>): Promise<R> {
    const next = this.chain.then(work)
    this.chain = next.catch(() => undefined)
    return next
  }
}

/**
 * The cache limit, saved when a drag or key press ends. Saves run in order, and a save
 * finishing only ends the edit if nothing changed since it started, so an older save
 * can't undo a newer choice. `save` reports its own errors and shouldn't reject.
 */
export class CacheLimitEdits {
  draft: number | null = null
  private revision = 0
  private saving = 0
  private requested: number | null = null
  private readonly queue: SerialQueue
  private readonly save: (gb: number) => Promise<unknown>
  private readonly changed: () => void
  constructor(queue: SerialQueue, save: (gb: number) => Promise<unknown>, changed: () => void) {
    this.queue = queue
    this.save = save
    this.changed = changed
  }

  edit(gb: number): void {
    if (gb === this.draft) return
    this.draft = gb
    this.revision++
    this.changed()
  }

  /** `saved` is the limit the last finished save reported. */
  async release(saved: number): Promise<void> {
    const gb = this.draft
    if (gb === null) return
    const at = this.revision
    // While saves are queued, the limit will end up at the last one requested, not at `saved`.
    const target = this.saving > 0 ? this.requested : saved
    if (gb !== target) {
      this.requested = gb
      this.saving++
      try { await this.queue.run(() => this.save(gb)) }
      finally { this.saving-- }
    } else if (this.saving > 0) {
      // Already on its way: keep showing it until that save lands.
      await this.queue.run(async () => undefined)
    }
    if (this.revision === at && this.draft === gb) {
      this.draft = null
      this.changed()
    }
  }

  get busy(): boolean { return this.saving > 0 }
}

/* ---------- Cache limit ---------- */

/**
 * Stops as [GB, position on a 0-5 scale]. The six main stops are evenly spaced;
 * 10→20 is halved (15) and 20→50 quartered (25, 30, 40), so steps get finer as sizes grow.
 */
export const CACHE_STOPS: readonly (readonly [number, number])[] = [
  [1, 0], [2, 1], [5, 2], [10, 3], [15, 3.5], [20, 4], [25, 4.25], [30, 4.5], [40, 4.75], [50, 5]
]
export const CACHE_MAJOR_STOPS: readonly number[] = [1, 2, 5, 10, 20, 50]
const CACHE_SPAN = 5
/** The range input runs 0-1000 and snaps, since the stops aren't evenly spaced. */
export const CACHE_SLIDER_MAX = 1000

export function cachePosition(gb: number): number {
  const first = CACHE_STOPS[0], last = CACHE_STOPS[CACHE_STOPS.length - 1]
  if (gb <= first[0]) return first[1]
  if (gb >= last[0]) return last[1]
  // A limit set before the stops existed (any whole GB) sits between its neighbours.
  for (let i = 1; i < CACHE_STOPS.length; i++) {
    const [gbHigh, posHigh] = CACHE_STOPS[i], [gbLow, posLow] = CACHE_STOPS[i - 1]
    if (gb <= gbHigh) return posLow + (posHigh - posLow) * (gb - gbLow) / (gbHigh - gbLow)
  }
  return last[1]
}

export function cacheSliderValue(gb: number): number {
  return Math.round(cachePosition(gb) / CACHE_SPAN * CACHE_SLIDER_MAX)
}

export function nearestCacheStop(sliderValue: number): number {
  const position = sliderValue / CACHE_SLIDER_MAX * CACHE_SPAN
  let best = CACHE_STOPS[0]
  for (const stop of CACHE_STOPS) if (Math.abs(stop[1] - position) < Math.abs(best[1] - position)) best = stop
  return best[0]
}

/** Arrow keys move one stop at a time, also from a limit that sits between stops. */
export function stepCacheStop(gb: number, direction: 1 | -1): number {
  if (direction > 0) return CACHE_STOPS.find(([stop]) => stop > gb)?.[0] ?? CACHE_STOPS[CACHE_STOPS.length - 1][0]
  return [...CACHE_STOPS].reverse().find(([stop]) => stop < gb)?.[0] ?? CACHE_STOPS[0][0]
}

export function cacheTickOffset(gb: number): number {
  return cachePosition(gb) / CACHE_SPAN
}

const GB = 1024 ** 3
export function formatGb(bytes: number): string {
  const gb = bytes / GB
  return gb >= 10 || gb === 0 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`
}
