import {
  createLyricsPayload,
  normalizeLyricsText,
  parseLrcSyncedLines
} from './lyricsParsing'
import type { LyricsPayload, LyricsTrackQuery } from '../../types/lyrics'
import {
  LRCLIB_OFFICIAL_BASE_URL,
  normalizeLrclibBaseUrl
} from '../../types/lyrics'

export const LRCLIB_PROJECT_URL = 'https://github.com/Boof2015/astra'
export const LRCLIB_REQUEST_TIMEOUT_MS = 15_000
export const LRCLIB_PROVIDER_UNAVAILABLE_MESSAGE = "LRCLIB didn't respond in time. A retry may work."
export const LRCLIB_PROVIDER_COOLDOWN_MS = 60_000

const UNKNOWN_APP_VERSION = 'unknown'

export interface LrclibClientConfig {
  appVersion: string
  baseUrl: string
  requestTimeoutMs: number
  now: () => number
}

export type LrclibLookupResult =
  | { status: 'hit'; lyrics: LyricsPayload }
  | { status: 'not_found' }
  | { status: 'provider_unavailable' }
  | { status: 'transient_error'; message: string; code?: string }

export type FetchJsonResult<T> =
  | { kind: 'ok'; payload: T }
  | { kind: 'http_error'; status: number }
  | { kind: 'timeout' }
  | { kind: 'network_error' }
  | { kind: 'invalid_payload' }

interface ScoredLrclibCandidate {
  entry: Record<string, unknown>
  score: number
}

export function normalizeLrclibAppVersion(value: string | null | undefined): string {
  const normalized = typeof value === 'string'
    ? value.trim().replace(/\s+/g, '-')
    : ''
  return normalized.length > 0 ? normalized : UNKNOWN_APP_VERSION
}

export function createLrclibClientConfig(options: {
  appVersion: string
  baseUrl?: string
  requestTimeoutMs?: number
  now?: () => number
}): LrclibClientConfig {
  return {
    appVersion: normalizeLrclibAppVersion(options.appVersion),
    baseUrl: normalizeLrclibBaseUrl(options.baseUrl ?? LRCLIB_OFFICIAL_BASE_URL),
    requestTimeoutMs: options.requestTimeoutMs ?? LRCLIB_REQUEST_TIMEOUT_MS,
    now: options.now ?? Date.now
  }
}

export function buildLrclibApiUrl(
  config: Pick<LrclibClientConfig, 'baseUrl'>,
  endpoint: 'get' | 'search',
  params: URLSearchParams
): string {
  const url = new URL(`${config.baseUrl}/api/${endpoint}`)
  url.search = params.toString()
  return url.toString()
}

export function createLrclibClientHeaders(config: Pick<LrclibClientConfig, 'appVersion'>): Record<string, string> {
  const client = `Astra/${normalizeLrclibAppVersion(config.appVersion)} (${LRCLIB_PROJECT_URL})`
  return {
    Accept: 'application/json',
    'Lrclib-Client': client,
    'User-Agent': client
  }
}

export function normalizeLrclibMetadataText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeMatchKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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

function scoreMatch(candidate: string | null, target: string): number {
  if (!candidate) return 0
  const normalizedCandidate = normalizeMatchKey(candidate)
  const normalizedTarget = normalizeMatchKey(target)
  if (!normalizedCandidate || !normalizedTarget) return 0
  if (normalizedCandidate === normalizedTarget) return 100
  if (normalizedCandidate.startsWith(normalizedTarget) || normalizedTarget.startsWith(normalizedCandidate)) return 60
  if (normalizedCandidate.includes(normalizedTarget) || normalizedTarget.includes(normalizedCandidate)) return 30
  return 0
}

function isTransientHttpStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function fetchResultToTransientCode(prefix: string, result: FetchJsonResult<unknown>): string {
  if (result.kind === 'timeout') return `${prefix}_timeout`
  if (result.kind === 'network_error') return `${prefix}_network_error`
  if (result.kind === 'invalid_payload') return `${prefix}_invalid_payload`
  if (result.kind === 'http_error') return `${prefix}_http_${result.status}`
  return `${prefix}_error`
}

export async function fetchLrclibJson<T>(url: string, config: LrclibClientConfig): Promise<FetchJsonResult<T>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs)

  try {
    const response = await fetch(url, {
      headers: createLrclibClientHeaders(config),
      signal: controller.signal
    })

    if (!response.ok) {
      return {
        kind: 'http_error',
        status: response.status
      }
    }

    try {
      const payload = await response.json()
      return {
        kind: 'ok',
        payload: payload as T
      }
    } catch {
      return { kind: 'invalid_payload' }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { kind: 'timeout' }
    }
    return { kind: 'network_error' }
  } finally {
    clearTimeout(timeout)
  }
}

function parseLrclibEntry(entry: Record<string, unknown>): LyricsPayload | null {
  const plainLyrics = normalizeLyricsText(entry.plainLyrics) ?? normalizeLyricsText(entry.plain_lyrics)
  const syncedRaw = normalizeLyricsText(entry.syncedLyrics) ?? normalizeLyricsText(entry.synced_lyrics)
  const syncedLines = syncedRaw ? parseLrcSyncedLines(syncedRaw) : []
  return createLyricsPayload('lrclib', 'lrclib', syncedLines.length > 0 ? 'lrc' : 'plain', plainLyrics, syncedRaw, syncedLines)
}

function scoreSearchEntry(entry: Record<string, unknown>, query: LyricsTrackQuery): number {
  const titleValue = normalizeLrclibMetadataText(entry.trackName) ?? normalizeLrclibMetadataText(entry.track_name)
  const artistValue = normalizeLrclibMetadataText(entry.artistName) ?? normalizeLrclibMetadataText(entry.artist_name)
  const albumValue = normalizeLrclibMetadataText(entry.albumName) ?? normalizeLrclibMetadataText(entry.album_name)
  const durationValue = normalizeDurationSeconds(entry.duration)

  const titleScore = scoreMatch(titleValue, query.title)
  const artistScore = scoreMatch(artistValue, query.artist)
  if (titleScore === 0 || artistScore === 0) return 0

  let score = (titleScore * 5) + (artistScore * 4)
  if (query.album) {
    score += scoreMatch(albumValue, query.album) * 2
  }

  const queryDuration = normalizeDurationSeconds(query.durationSeconds)
  if (queryDuration !== null && durationValue !== null) {
    const delta = Math.abs(queryDuration - durationValue)
    if (delta <= 2) {
      score += 120
    } else if (delta <= 5) {
      score += 80
    } else if (delta <= 10) {
      score += 40
    }
  }

  return score
}

async function lookupLrclibByMetadata(
  query: LyricsTrackQuery,
  config: LrclibClientConfig
): Promise<LrclibLookupResult> {
  const params = new URLSearchParams({
    track_name: query.title,
    artist_name: query.artist
  })
  const album = normalizeLrclibMetadataText(query.album)
  if (album) {
    params.set('album_name', album)
  }
  const duration = normalizeDurationSeconds(query.durationSeconds)
  if (duration !== null) {
    params.set('duration', String(duration))
  }

  const response = await fetchLrclibJson<Record<string, unknown>>(buildLrclibApiUrl(config, 'get', params), config)
  if (response.kind === 'http_error') {
    if (response.status === 404) {
      return { status: 'not_found' }
    }
    if (isTransientHttpStatus(response.status)) {
      return {
        status: 'transient_error',
        message: 'LRCLIB metadata lookup failed due to a transient HTTP error.',
        code: fetchResultToTransientCode('lrclib_get', response)
      }
    }
    return { status: 'not_found' }
  }

  if (response.kind !== 'ok') {
    return {
      status: 'transient_error',
      message: 'LRCLIB metadata lookup failed due to a transient network error.',
      code: fetchResultToTransientCode('lrclib_get', response)
    }
  }

  if (!response.payload || typeof response.payload !== 'object' || Array.isArray(response.payload)) {
    return {
      status: 'transient_error',
      message: 'LRCLIB metadata lookup returned an invalid payload.',
      code: 'lrclib_get_invalid_payload'
    }
  }

  const parsed = parseLrclibEntry(response.payload)
  if (!parsed) return { status: 'not_found' }
  return { status: 'hit', lyrics: parsed }
}

async function lookupLrclibBySearch(
  query: LyricsTrackQuery,
  config: LrclibClientConfig
): Promise<LrclibLookupResult> {
  const searchTerm = [query.title, query.artist, query.album ?? '']
    .map((value) => normalizeLrclibMetadataText(value))
    .filter((value): value is string => Boolean(value))
    .join(' ')
  if (!searchTerm) return { status: 'not_found' }

  const params = new URLSearchParams({ q: searchTerm })
  const response = await fetchLrclibJson<unknown[]>(buildLrclibApiUrl(config, 'search', params), config)
  if (response.kind === 'http_error') {
    if (response.status === 404) return { status: 'not_found' }
    if (isTransientHttpStatus(response.status)) {
      return {
        status: 'transient_error',
        message: 'LRCLIB search lookup failed due to a transient HTTP error.',
        code: fetchResultToTransientCode('lrclib_search', response)
      }
    }
    return { status: 'not_found' }
  }

  if (response.kind !== 'ok') {
    return {
      status: 'transient_error',
      message: 'LRCLIB search lookup failed due to a transient network error.',
      code: fetchResultToTransientCode('lrclib_search', response)
    }
  }

  if (!Array.isArray(response.payload)) {
    return {
      status: 'transient_error',
      message: 'LRCLIB search lookup returned an invalid payload.',
      code: 'lrclib_search_invalid_payload'
    }
  }

  const candidates: ScoredLrclibCandidate[] = []
  for (const item of response.payload) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const score = scoreSearchEntry(entry, query)
    if (score <= 0) continue
    candidates.push({ entry, score })
  }

  candidates.sort((left, right) => right.score - left.score)
  for (const candidate of candidates) {
    const parsed = parseLrclibEntry(candidate.entry)
    if (!parsed) continue
    return {
      status: 'hit',
      lyrics: parsed
    }
  }

  return { status: 'not_found' }
}

async function lookupLrclibRaw(
  query: LyricsTrackQuery,
  config: LrclibClientConfig
): Promise<LrclibLookupResult> {
  const metadataLookup = await lookupLrclibByMetadata(query, config)
  if (metadataLookup.status === 'hit' || metadataLookup.status === 'transient_error') {
    return metadataLookup
  }
  return lookupLrclibBySearch(query, config)
}

export class LrclibLookupCoordinator {
  private readonly config: LrclibClientConfig
  private cooldownUntil = 0
  private configRevision = 0
  private readonly inFlightLookups = new Map<string, Promise<LrclibLookupResult>>()

  constructor(config: LrclibClientConfig) {
    this.config = config
  }

  isCoolingDown(): boolean {
    return this.config.now() < this.cooldownUntil
  }

  setBaseUrl(baseUrl: string): void {
    const normalized = normalizeLrclibBaseUrl(baseUrl)
    if (normalized === this.config.baseUrl) return

    this.config.baseUrl = normalized
    this.cooldownUntil = 0
    this.configRevision += 1
    this.inFlightLookups.clear()
  }

  async lookup(
    query: LyricsTrackQuery,
    lookupKey: string,
    options: { forceRefresh?: boolean } = {}
  ): Promise<LrclibLookupResult> {
    const forceRefresh = Boolean(options.forceRefresh)
    if (!forceRefresh && this.isCoolingDown()) {
      return { status: 'provider_unavailable' }
    }

    const revision = this.configRevision
    const result = await this.lookupDeduped(query, lookupKey)
    if (revision !== this.configRevision) {
      return { status: 'provider_unavailable' }
    }
    if (result.status === 'transient_error') {
      if (!forceRefresh) {
        this.cooldownUntil = this.config.now() + LRCLIB_PROVIDER_COOLDOWN_MS
        return { status: 'provider_unavailable' }
      }
      return result
    }

    this.cooldownUntil = 0
    return result
  }

  private lookupDeduped(query: LyricsTrackQuery, lookupKey: string): Promise<LrclibLookupResult> {
    const existing = this.inFlightLookups.get(lookupKey)
    if (existing) return existing

    const lookup = lookupLrclibRaw(query, this.config)
      .finally(() => {
        if (this.inFlightLookups.get(lookupKey) === lookup) {
          this.inFlightLookups.delete(lookupKey)
        }
      })
    this.inFlightLookups.set(lookupKey, lookup)
    return lookup
  }
}
