import type { LyricsLine, LyricsPayload } from '../../types/lyrics'
import { getSubsonicLyrics, parseSubsonicTrackPath, SubsonicRequestError, type SubsonicConnectionConfig } from './subsonic'

const MISS_TTL_MS = 5 * 60_000
const MAX_SOURCES = 64
const MAX_MISSES = 256

export interface ServerLyricsContext {
  isCurrent(): boolean
  lookup(options: { forceRefresh?: boolean }): Promise<LyricsPayload | null>
}

export interface ServerLyricsResolver {
  resolve(trackPath: string): ServerLyricsContext | null
}

interface Dependencies {
  source(id: number): { binding: string; enabled: boolean } | null
  credentials(id: number): SubsonicConnectionConfig
  request?: typeof getSubsonicLyrics
  now?: () => number
}

interface SourceState {
  binding: string
  unsupportedUntil: number
  misses: Map<string, number>
  requests: Map<string, { controller: AbortController; promise: Promise<LyricsPayload | null> }>
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function lrcTimestamp(ms: number): string {
  return `${String(Math.floor(ms / 60_000)).padStart(2, '0')}:${String(Math.floor(ms / 1_000) % 60).padStart(2, '0')}.${String(ms % 1_000).padStart(3, '0')}`
}

/** Select one complete lyric track, retaining the server's order among equally usable tracks. */
export function parseSubsonicLyrics(raw: unknown): LyricsPayload | null {
  if (!Array.isArray(raw)) return null
  let plain: LyricsPayload | null = null
  for (const value of raw) {
    const entry = record(value)
    if (!entry || typeof entry.synced !== 'boolean' || !Array.isArray(entry.line)) continue
    if (entry.kind !== undefined && entry.kind !== 'main') continue
    const rows = entry.line.map(record).filter((line): line is Record<string, unknown> & { value: string } =>
      line !== null && typeof line.value === 'string')
    if (!rows.some(line => line.value.trim())) continue
    const text = rows.map(line => line.value.replace(/\r\n/g, '\n')).join('\n')
    const synced = entry.synced && rows.every(line =>
      typeof line.start === 'number' && Number.isFinite(line.start) && line.start >= 0)
    // OpenSubsonic's positive offset means earlier, unlike Astra's track adjustment.
    const offset = typeof entry.offset === 'number' && Number.isFinite(entry.offset) ? entry.offset : 0
    const lines: LyricsLine[] = synced ? rows.map(line => {
      const timestampMs = Math.max(0, Math.floor((line.start as number) - offset))
      return line.value.trim()
        ? { timestampMs, text: line.value }
        : { timestampMs, text: '', kind: 'silence' as const }
    }).sort((a, b) => a.timestampMs - b.timestampMs) : []
    const payload: LyricsPayload = {
      source: 'server', provider: null, format: synced ? 'lrc' : 'plain',
      plainLyrics: text,
      syncedLyrics: synced ? lines.map(line => `[${lrcTimestamp(line.timestampMs)}]${line.text}`).join('\n') : null,
      syncedLines: lines
    }
    if (synced) return payload
    plain ??= payload
  }
  return plain
}

/** Short-lived misses and in-flight requests belong to a particular saved connection. */
export class SubsonicLyricsResolver implements ServerLyricsResolver {
  private readonly states = new Map<number, SourceState>()
  private readonly deps: Dependencies
  private readonly now: () => number

  constructor(deps: Dependencies) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  invalidate(sourceId: number): void {
    const state = this.states.get(sourceId)
    this.states.delete(sourceId)
    for (const request of state?.requests.values() ?? []) request.controller.abort()
  }

  resolve(trackPath: string): ServerLyricsContext | null {
    const parsed = parseSubsonicTrackPath(trackPath)
    if (!parsed) return null
    const { sourceId, sourceTrackId } = parsed
    const source = this.deps.source(sourceId)
    if (!source?.enabled) {
      this.invalidate(sourceId)
      return null
    }
    let state = this.states.get(sourceId)
    if (!state || state.binding !== source.binding) {
      this.invalidate(sourceId)
      state = { binding: source.binding, unsupportedUntil: 0, misses: new Map(), requests: new Map() }
      this.states.set(sourceId, state)
      if (this.states.size > MAX_SOURCES) this.invalidate(this.states.keys().next().value!)
    }
    const captured = state
    const isCurrent = (): boolean => {
      const current = this.deps.source(sourceId)
      return this.states.get(sourceId) === captured && current?.enabled === true && current.binding === captured.binding
    }
    return {
      isCurrent,
      lookup: options => this.lookup(sourceId, sourceTrackId, captured, isCurrent, options.forceRefresh === true)
    }
  }

  private async lookup(
    sourceId: number, trackId: string, state: SourceState, isCurrent: () => boolean, forceRefresh: boolean
  ): Promise<LyricsPayload | null> {
    if (!isCurrent()) return null
    if (forceRefresh) {
      state.unsupportedUntil = 0
      state.misses.delete(trackId)
    } else if (state.unsupportedUntil > this.now() || (state.misses.get(trackId) ?? 0) > this.now()) {
      return null
    }
    const pending = state.requests.get(trackId)
    if (pending) return pending.promise
    const controller = new AbortController()
    const promise = (async (): Promise<LyricsPayload | null> => {
      try {
        const raw = await (this.deps.request ?? getSubsonicLyrics)(this.deps.credentials(sourceId), trackId, {
          signal: controller.signal
        })
        if (!isCurrent()) return null
        const payload = parseSubsonicLyrics(raw)
        // Malformed responses and failures must not become remembered lyric misses.
        if (Array.isArray(raw) && raw.length === 0) {
          state.misses.delete(trackId)
          state.misses.set(trackId, this.now() + MISS_TTL_MS)
          if (state.misses.size > MAX_MISSES) state.misses.delete(state.misses.keys().next().value!)
        }
        return payload
      } catch (error) {
        if (isCurrent() && error instanceof SubsonicRequestError && (error.httpStatus === 404 || error.httpStatus === 501)) {
          state.unsupportedUntil = this.now() + MISS_TTL_MS
        }
        return null
      }
    })()
    state.requests.set(trackId, { controller, promise })
    try { return await promise } finally { state.requests.delete(trackId) }
  }
}
