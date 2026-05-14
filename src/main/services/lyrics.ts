import { createHash } from 'crypto'
import * as mm from 'music-metadata'
import * as library from './library'
import { lookupSidecarLrcLyrics } from './lyricsSidecar'
import {
  createLyricsPayload,
  normalizeLyricsText,
  parseLyricsText,
  parseLrcSyncedLines,
  sanitizeSyncLines,
  toPlainLyricsFromLines
} from './lyricsParsing'
import type {
  LyricsLine,
  LyricsManualClearResult,
  LyricsManualImportResult,
  LyricsLookupResult,
  LyricsOffsetSetResult,
  LyricsPayload,
  LyricsStatus,
  LyricsTrackOverride,
  LyricsTrackQuery,
} from '../../types/lyrics'

const LRCLIB_GET_URL = 'https://lrclib.net/api/get'
const LRCLIB_SEARCH_URL = 'https://lrclib.net/api/search'
const LRCLIB_USER_AGENT = 'Astra-Lyrics/0.1.0 (https://github.com/Boof2015/astra)'
const LRCLIB_REQUEST_TIMEOUT_MS = 9_000
const MAX_TRACK_OFFSET_MS = 3_600_000

interface LyricsServiceOptions {
  enabled: boolean
  onStatusChange?: (status: LyricsStatus) => void
}

type LrclibLookupResult =
  | { status: 'hit'; lyrics: LyricsPayload }
  | { status: 'not_found' }
  | { status: 'transient_error'; message: string; code?: string }

type FetchJsonResult<T> =
  | { kind: 'ok'; payload: T }
  | { kind: 'http_error'; status: number }
  | { kind: 'timeout' }
  | { kind: 'network_error' }
  | { kind: 'invalid_payload' }

interface ScoredLrclibCandidate {
  entry: Record<string, unknown>
  score: number
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/g, ' ').trim()
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

function normalizeTrackPathList(trackPaths: string[]): string[] {
  const normalized = trackPaths
    .map((trackPath) => trackPath.trim())
    .filter((trackPath) => trackPath.length > 0)
  return Array.from(new Set(normalized))
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

function hasManualLyricsOverride(entry: {
  plainLyrics: string | null
  syncedLyrics: string | null
  syncedLines: LyricsLine[]
}): boolean {
  return (
    entry.plainLyrics !== null
    || entry.syncedLyrics !== null
    || entry.syncedLines.length > 0
  )
}

function applySyncOffsetToLines(lines: LyricsLine[], offsetMs: number): LyricsLine[] {
  if (lines.length === 0 || offsetMs === 0) return lines

  const shifted = lines.map((line) => ({
    timestampMs: Math.max(0, line.timestampMs + offsetMs),
    text: line.text,
    ...(line.kind === 'silence' ? { kind: 'silence' as const } : {})
  }))
  shifted.sort((left, right) => left.timestampMs - right.timestampMs)
  return shifted
}

function applyTrackOffsetToPayload(payload: LyricsPayload, offsetMs: number): LyricsPayload {
  if (offsetMs === 0 || payload.syncedLines.length === 0) return payload
  return {
    ...payload,
    syncedLines: applySyncOffsetToLines(payload.syncedLines, offsetMs)
  }
}

function createMetadataSignature(query: LyricsTrackQuery): string {
  const title = normalizeMatchKey(query.title)
  const artist = normalizeMatchKey(query.artist)
  const album = normalizeMatchKey(query.album ?? '')
  const duration = normalizeDurationSeconds(query.durationSeconds) ?? -1
  const hash = createHash('sha1')
  hash.update(`${title}\u0000${artist}\u0000${album}\u0000${duration}`)
  return hash.digest('hex')
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

async function fetchJson<T>(url: string): Promise<FetchJsonResult<T>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LRCLIB_REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': LRCLIB_USER_AGENT
      },
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
  return createLyricsPayload('lrclib', 'lrclib', plainLyrics, syncedRaw, syncedLines)
}

function scoreSearchEntry(entry: Record<string, unknown>, query: LyricsTrackQuery): number {
  const titleValue = normalizeText(entry.trackName) ?? normalizeText(entry.track_name)
  const artistValue = normalizeText(entry.artistName) ?? normalizeText(entry.artist_name)
  const albumValue = normalizeText(entry.albumName) ?? normalizeText(entry.album_name)
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

async function lookupLrclibByMetadata(query: LyricsTrackQuery): Promise<LrclibLookupResult> {
  const params = new URLSearchParams({
    track_name: query.title,
    artist_name: query.artist
  })
  const album = normalizeText(query.album)
  if (album) {
    params.set('album_name', album)
  }
  const duration = normalizeDurationSeconds(query.durationSeconds)
  if (duration !== null) {
    params.set('duration', String(duration))
  }

  const response = await fetchJson<Record<string, unknown>>(`${LRCLIB_GET_URL}?${params.toString()}`)
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

async function lookupLrclibBySearch(query: LyricsTrackQuery): Promise<LrclibLookupResult> {
  const searchTerm = [query.title, query.artist, query.album ?? '']
    .map((value) => normalizeText(value))
    .filter((value): value is string => Boolean(value))
    .join(' ')
  if (!searchTerm) return { status: 'not_found' }

  const params = new URLSearchParams({ q: searchTerm })
  const response = await fetchJson<unknown[]>(`${LRCLIB_SEARCH_URL}?${params.toString()}`)
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

async function resolveEmbeddedLyrics(trackPath: string): Promise<LyricsPayload | null> {
  try {
    const metadata = await mm.parseFile(trackPath, { skipCovers: true })
    const lyricTags = Array.isArray(metadata.common.lyrics) ? metadata.common.lyrics : []
    if (lyricTags.length === 0) return null

    let plainLyrics: string | null = null
    let bestSyncedLines: LyricsLine[] = []
    for (const lyricTag of lyricTags) {
      if (!plainLyrics) {
        plainLyrics = normalizeLyricsText(lyricTag.text)
      }

      const syncedLines = sanitizeSyncLines(lyricTag.syncText)
      if (syncedLines.length > bestSyncedLines.length) {
        bestSyncedLines = syncedLines
      }
    }

    const syncedLyrics = toPlainLyricsFromLines(bestSyncedLines)
    return createLyricsPayload('embedded', null, plainLyrics, syncedLyrics, bestSyncedLines)
  } catch {
    return null
  }
}

export class LyricsService {
  private enabled: boolean
  private lastError: string | null = null
  private readonly onStatusChange?: (status: LyricsStatus) => void

  constructor(options: LyricsServiceOptions) {
    this.enabled = Boolean(options.enabled)
    this.onStatusChange = options.onStatusChange
  }

  getStatus(): LyricsStatus {
    if (!this.enabled) {
      return {
        enabled: false,
        provider: 'lrclib',
        statusMessage: 'Online lyrics lookup is disabled. Astra will only use local LRC and embedded lyrics.',
        lastError: this.lastError
      }
    }

    if (this.lastError) {
      return {
        enabled: true,
        provider: 'lrclib',
        statusMessage: 'Online lyrics lookup is enabled with LRCLIB, but the last request failed.',
        lastError: this.lastError
      }
    }

    return {
      enabled: true,
      provider: 'lrclib',
      statusMessage: 'Online lyrics lookup is enabled with LRCLIB fallback.',
      lastError: null
    }
  }

  applyConfig(enabled: boolean): LyricsStatus {
    this.enabled = Boolean(enabled)
    if (!this.enabled) {
      this.lastError = null
    }
    this.emitStatus()
    return this.getStatus()
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.getStatus())
  }

  private setLastError(error: string | null): void {
    if (this.lastError === error) return
    this.lastError = error
    this.emitStatus()
  }

  getTrackOverride(trackPath: string): LyricsTrackOverride {
    const normalizedTrackPath = normalizeText(trackPath)
    if (!normalizedTrackPath) {
      return {
        trackPath: '',
        hasManualLyrics: false,
        plainLyrics: null,
        syncedLyrics: null,
        syncedLines: [],
        syncOffsetMs: 0,
        updatedAt: null
      }
    }

    const override = library.getLyricsTrackOverride(normalizedTrackPath)
    if (!override) {
      return {
        trackPath: normalizedTrackPath,
        hasManualLyrics: false,
        plainLyrics: null,
        syncedLyrics: null,
        syncedLines: [],
        syncOffsetMs: 0,
        updatedAt: null
      }
    }

    const hasManualLyrics = hasManualLyricsOverride(override)
    return {
      trackPath: override.trackPath,
      hasManualLyrics,
      plainLyrics: override.plainLyrics,
      syncedLyrics: override.syncedLyrics,
      syncedLines: override.syncedLines,
      syncOffsetMs: override.syncOffsetMs,
      updatedAt: override.updatedAt
    }
  }

  async importManualLyrics(trackPaths: string[], lyricsText: string): Promise<LyricsManualImportResult> {
    const normalizedTrackPaths = normalizeTrackPathList(trackPaths)
    if (normalizedTrackPaths.length === 0) {
      throw new Error('Select at least one track before importing lyrics.')
    }

    const payload = parseLyricsText(lyricsText, 'manual')
    if (!payload) {
      throw new Error('Selected lyrics file is empty or could not be parsed.')
    }

    const updated = await library.upsertLyricsTrackManual(normalizedTrackPaths, {
      plainLyrics: payload.plainLyrics,
      syncedLyrics: payload.syncedLyrics,
      syncedLines: payload.syncedLines
    })

    return {
      updated,
      hasPlainLyrics: payload.plainLyrics !== null,
      hasSyncedLyrics: payload.syncedLines.length > 0
    }
  }

  async clearManualLyrics(trackPaths: string[]): Promise<LyricsManualClearResult> {
    const normalizedTrackPaths = normalizeTrackPathList(trackPaths)
    if (normalizedTrackPaths.length === 0) {
      return { cleared: 0 }
    }

    const cleared = await library.clearLyricsTrackManual(normalizedTrackPaths)
    return { cleared }
  }

  async setTrackOffset(trackPaths: string[], offsetMs: number): Promise<LyricsOffsetSetResult> {
    const normalizedTrackPaths = normalizeTrackPathList(trackPaths)
    if (normalizedTrackPaths.length === 0) {
      return { updated: 0, offsetMs: 0 }
    }

    if (!Number.isFinite(offsetMs)) {
      throw new Error('Sync offset must be a finite integer value.')
    }

    const normalizedOffset = Math.trunc(offsetMs)
    if (normalizedOffset < -MAX_TRACK_OFFSET_MS || normalizedOffset > MAX_TRACK_OFFSET_MS) {
      throw new Error(`Sync offset must be between -${MAX_TRACK_OFFSET_MS} and ${MAX_TRACK_OFFSET_MS} ms.`)
    }

    const updated = await library.setLyricsTrackSyncOffset(normalizedTrackPaths, normalizedOffset)
    return {
      updated,
      offsetMs: normalizedOffset
    }
  }

  async getForTrack(
    query: LyricsTrackQuery,
    options: { forceRefresh?: boolean } = {}
  ): Promise<LyricsLookupResult> {
    const path = normalizeText(query.path)
    const title = normalizeText(query.title)
    const artist = normalizeText(query.artist)
    const album = normalizeText(query.album)
    const durationSeconds = normalizeDurationSeconds(query.durationSeconds) ?? undefined

    if (!path || !title || !artist) {
      return {
        status: 'not_found',
        reason: 'embedded-missing'
      }
    }

    const normalizedQuery: LyricsTrackQuery = {
      path,
      title,
      artist,
      album: album ?? undefined,
      durationSeconds
    }
    const metadataSignature = createMetadataSignature(normalizedQuery)
    const trackOverride = library.getLyricsTrackOverride(path)
    const trackOffsetMs = trackOverride?.syncOffsetMs ?? 0

    if (trackOverride && hasManualLyricsOverride(trackOverride)) {
      const manualPayload = createLyricsPayload(
        'manual',
        null,
        trackOverride.plainLyrics,
        trackOverride.syncedLyrics,
        trackOverride.syncedLines
      )

      if (manualPayload) {
        return {
          status: 'hit',
          lyrics: applyTrackOffsetToPayload(manualPayload, trackOffsetMs),
          cached: false
        }
      }
    }

    const sidecarLrc = await lookupSidecarLrcLyrics(path)
    if (sidecarLrc) {
      this.setLastError(null)
      return {
        ...sidecarLrc,
        lyrics: applyTrackOffsetToPayload(sidecarLrc.lyrics, trackOffsetMs)
      }
    }

    if (!options.forceRefresh) {
      const cached = library.getLyricsCache(path, metadataSignature)
      if (cached) {
        if (cached.status === 'hit') {
          const payload = createLyricsPayload(
            cached.source,
            cached.provider,
            cached.plainLyrics,
            cached.syncedLyrics,
            cached.syncedLines
          )
          if (payload) {
            return {
              status: 'hit',
              lyrics: applyTrackOffsetToPayload(payload, trackOffsetMs),
              cached: true
            }
          }
        }

        return {
          status: 'not_found',
          reason: cached.source === 'lrclib' ? 'provider-not-found' : 'embedded-missing'
        }
      }
    }

    const embedded = await resolveEmbeddedLyrics(path)
    if (embedded) {
      this.setLastError(null)
      await library.upsertLyricsCache({
        trackPath: path,
        metadataSignature,
        status: 'hit',
        source: 'embedded',
        provider: embedded.provider,
        plainLyrics: embedded.plainLyrics,
        syncedLyrics: embedded.syncedLyrics,
        syncedLines: embedded.syncedLines
      })
      return {
        status: 'hit',
        lyrics: applyTrackOffsetToPayload(embedded, trackOffsetMs),
        cached: false
      }
    }

    if (!this.enabled) {
      return {
        status: 'not_found',
        reason: 'online-disabled'
      }
    }

    const metadataLookup = await lookupLrclibByMetadata(normalizedQuery)
    if (metadataLookup.status === 'hit') {
      this.setLastError(null)
      await library.upsertLyricsCache({
        trackPath: path,
        metadataSignature,
        status: 'hit',
        source: 'lrclib',
        provider: 'lrclib',
        plainLyrics: metadataLookup.lyrics.plainLyrics,
        syncedLyrics: metadataLookup.lyrics.syncedLyrics,
        syncedLines: metadataLookup.lyrics.syncedLines
      })
      return {
        status: 'hit',
        lyrics: applyTrackOffsetToPayload(metadataLookup.lyrics, trackOffsetMs),
        cached: false
      }
    }
    if (metadataLookup.status === 'transient_error') {
      this.setLastError(metadataLookup.message)
      return {
        status: 'transient_error',
        message: metadataLookup.message,
        code: metadataLookup.code
      }
    }

    const searchLookup = await lookupLrclibBySearch(normalizedQuery)
    if (searchLookup.status === 'hit') {
      this.setLastError(null)
      await library.upsertLyricsCache({
        trackPath: path,
        metadataSignature,
        status: 'hit',
        source: 'lrclib',
        provider: 'lrclib',
        plainLyrics: searchLookup.lyrics.plainLyrics,
        syncedLyrics: searchLookup.lyrics.syncedLyrics,
        syncedLines: searchLookup.lyrics.syncedLines
      })
      return {
        status: 'hit',
        lyrics: applyTrackOffsetToPayload(searchLookup.lyrics, trackOffsetMs),
        cached: false
      }
    }
    if (searchLookup.status === 'transient_error') {
      this.setLastError(searchLookup.message)
      return {
        status: 'transient_error',
        message: searchLookup.message,
        code: searchLookup.code
      }
    }

    this.setLastError(null)
    await library.upsertLyricsCache({
      trackPath: path,
      metadataSignature,
      status: 'not_found',
      source: 'lrclib',
      provider: 'lrclib',
      plainLyrics: null,
      syncedLyrics: null,
      syncedLines: []
    })
    return {
      status: 'not_found',
      reason: 'provider-not-found'
    }
  }
}
