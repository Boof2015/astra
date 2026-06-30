import {
  lookup as lookupXlrcdb,
  serializeXLRC,
  type FetchLike,
  type FetchResponseLike,
  type XLRCFile
} from '@boof2015/xlrc'
import {
  createLyricsPayload
} from './lyricsParsing'
import type { LyricsPayload, LyricsTrackQuery } from '../../types/lyrics'

export const XLRCDB_SOURCE_URL = 'https://boof2015.github.io/xlrcdb'
export const XLRCDB_REQUEST_TIMEOUT_MS = 15_000
export const XLRCDB_PROVIDER_COOLDOWN_MS = 60_000

export interface XlrcdbClientConfig {
  sourceUrl: string
  requestTimeoutMs: number
  now: () => number
}

export type XlrcdbLookupResult =
  | { status: 'hit'; lyrics: LyricsPayload }
  | { status: 'not_found' }
  | { status: 'skipped'; reason: 'duration_missing' }
  | { status: 'provider_unavailable' }
  | { status: 'transient_error'; message: string; code?: string }

export function createXlrcdbClientConfig(options: {
  sourceUrl?: string
  requestTimeoutMs?: number
  now?: () => number
} = {}): XlrcdbClientConfig {
  return {
    sourceUrl: (options.sourceUrl ?? XLRCDB_SOURCE_URL).replace(/\/+$/u, ''),
    requestTimeoutMs: options.requestTimeoutMs ?? XLRCDB_REQUEST_TIMEOUT_MS,
    now: options.now ?? Date.now
  }
}

function normalizeDurationSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value)
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed)
    }
  }
  return null
}

function createXlrcdbPayload(file: XLRCFile): LyricsPayload | null {
  return createLyricsPayload('xlrcdb', 'xlrcdb', 'xlrc', null, serializeXLRC(file), [])
}

function createTimeoutFetch(
  config: XlrcdbClientConfig,
  setFailureKind: (kind: 'timeout' | 'network_error') => void
): FetchLike {
  return async (input: string): Promise<FetchResponseLike> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs)

    try {
      return await fetch(input, {
        signal: controller.signal
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setFailureKind('timeout')
      } else {
        setFailureKind('network_error')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}

function toTransientCode(reason: 'fetch_error' | 'parse_error', failureKind: 'timeout' | 'network_error' | null): string {
  if (reason === 'parse_error') return 'xlrcdb_parse_error'
  if (failureKind === 'timeout') return 'xlrcdb_timeout'
  if (failureKind === 'network_error') return 'xlrcdb_network_error'
  return 'xlrcdb_fetch_error'
}

async function lookupXlrcdbRaw(
  query: LyricsTrackQuery,
  config: XlrcdbClientConfig
): Promise<XlrcdbLookupResult> {
  const duration = normalizeDurationSeconds(query.durationSeconds)
  if (duration === null) {
    return {
      status: 'skipped',
      reason: 'duration_missing'
    }
  }

  let failureKind: 'timeout' | 'network_error' | null = null
  const result = await lookupXlrcdb({
    artist: query.artist,
    title: query.title,
    length: duration,
    source: config.sourceUrl,
    fetch: createTimeoutFetch(config, (kind) => {
      failureKind = kind
    })
  })

  if (result.found) {
    const lyrics = createXlrcdbPayload(result.lyrics)
    return lyrics ? { status: 'hit', lyrics } : { status: 'not_found' }
  }

  if (result.reason === 'artist_not_found' || result.reason === 'track_not_found') {
    return { status: 'not_found' }
  }

  return {
    status: 'transient_error',
    message: result.reason === 'parse_error'
      ? 'XLRCDB lookup returned lyrics that could not be parsed.'
      : 'XLRCDB lookup failed due to a transient network error.',
    code: toTransientCode(result.reason, failureKind)
  }
}

export class XlrcdbLookupCoordinator {
  private readonly config: XlrcdbClientConfig
  private cooldownUntil = 0
  private readonly inFlightLookups = new Map<string, Promise<XlrcdbLookupResult>>()

  constructor(config: XlrcdbClientConfig) {
    this.config = config
  }

  isCoolingDown(): boolean {
    return this.config.now() < this.cooldownUntil
  }

  async lookup(
    query: LyricsTrackQuery,
    lookupKey: string,
    options: { forceRefresh?: boolean } = {}
  ): Promise<XlrcdbLookupResult> {
    const forceRefresh = Boolean(options.forceRefresh)
    if (!forceRefresh && this.isCoolingDown()) {
      return { status: 'provider_unavailable' }
    }

    const result = await this.lookupDeduped(query, lookupKey)
    if (result.status === 'transient_error') {
      if (!forceRefresh) {
        this.cooldownUntil = this.config.now() + XLRCDB_PROVIDER_COOLDOWN_MS
        return { status: 'provider_unavailable' }
      }
      return result
    }

    if (result.status !== 'skipped') {
      this.cooldownUntil = 0
    }
    return result
  }

  private lookupDeduped(query: LyricsTrackQuery, lookupKey: string): Promise<XlrcdbLookupResult> {
    const existing = this.inFlightLookups.get(lookupKey)
    if (existing) return existing

    const lookup = lookupXlrcdbRaw(query, this.config)
      .finally(() => {
        if (this.inFlightLookups.get(lookupKey) === lookup) {
          this.inFlightLookups.delete(lookupKey)
        }
      })
    this.inFlightLookups.set(lookupKey, lookup)
    return lookup
  }
}
