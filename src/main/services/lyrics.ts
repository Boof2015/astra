import { createHash } from 'crypto'
import * as mm from 'music-metadata'
import * as library from './library'
import { lookupSidecarLyrics } from './lyricsSidecar'
import {
  createLyricsPayload,
  normalizeLyricsText,
  parseLyricsText,
  sanitizeSyncLines,
  toPlainLyricsFromLines
} from './lyricsParsing'
import {
  LrclibLookupCoordinator,
  createLrclibClientConfig,
  normalizeLrclibMetadataText
} from './lyricsLrclib'
import type { LrclibLookupResult } from './lyricsLrclib'
import {
  XlrcdbLookupCoordinator,
  createXlrcdbClientConfig,
  type XlrcdbLookupResult
} from './lyricsXlrcdb'
import type {
  LyricsFormat,
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
import {
  LRCLIB_OFFICIAL_BASE_URL,
  normalizeLrclibBaseUrl
} from '../../types/lyrics'

const MAX_TRACK_OFFSET_MS = 3_600_000

export interface LyricsServiceLibraryApi {
  getLyricsTrackOverride: typeof library.getLyricsTrackOverride
  upsertLyricsTrackManual: typeof library.upsertLyricsTrackManual
  clearLyricsTrackManual: typeof library.clearLyricsTrackManual
  setLyricsTrackSyncOffset: typeof library.setLyricsTrackSyncOffset
  getLyricsCache: typeof library.getLyricsCache
  upsertLyricsCache: typeof library.upsertLyricsCache
}

type LyricsOnlineLookupResult = LrclibLookupResult | XlrcdbLookupResult

export interface LyricsOnlineLookupProvider {
  lookup: (
    query: LyricsTrackQuery,
    lookupKey: string,
    options?: { forceRefresh?: boolean }
  ) => Promise<LyricsOnlineLookupResult>
  setBaseUrl?: (baseUrl: string) => void
}

interface LyricsServiceOptions {
  enabled: boolean
  appVersion: string
  lrclibBaseUrl?: string
  requestTimeoutMs?: number
  now?: () => number
  onStatusChange?: (status: LyricsStatus) => void
  libraryApi?: LyricsServiceLibraryApi
  sidecarLookup?: typeof lookupSidecarLyrics
  embeddedResolver?: typeof resolveEmbeddedLyrics
  xlrcdbProvider?: LyricsOnlineLookupProvider
  lrclibProvider?: LyricsOnlineLookupProvider
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

  const shifted = lines.map((line): LyricsLine => {
    const timestampMs = Math.max(0, line.timestampMs + offsetMs)
    if (line.kind === 'silence') {
      return { timestampMs, text: '', kind: 'silence' }
    }

    return {
      ...line,
      timestampMs,
      words: line.words?.map((word) => ({
        ...word,
        timestampMs: Math.max(0, word.timestampMs + offsetMs)
      }))
    }
  })
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
    return createLyricsPayload('embedded', null, bestSyncedLines.length > 0 ? 'lrc' : 'plain', plainLyrics, syncedLyrics, bestSyncedLines)
  } catch {
    return null
  }
}

export class LyricsService {
  private enabled: boolean
  private lrclibBaseUrl: string
  private lastError: string | null = null
  private readonly libraryApi: LyricsServiceLibraryApi
  private readonly sidecarLookup: typeof lookupSidecarLyrics
  private readonly embeddedResolver: typeof resolveEmbeddedLyrics
  private readonly xlrcdb: LyricsOnlineLookupProvider
  private readonly lrclib: LyricsOnlineLookupProvider
  private readonly onStatusChange?: (status: LyricsStatus) => void

  constructor(options: LyricsServiceOptions) {
    this.enabled = Boolean(options.enabled)
    this.lrclibBaseUrl = normalizeLrclibBaseUrl(options.lrclibBaseUrl ?? LRCLIB_OFFICIAL_BASE_URL)
    this.libraryApi = options.libraryApi ?? library
    this.sidecarLookup = options.sidecarLookup ?? lookupSidecarLyrics
    this.embeddedResolver = options.embeddedResolver ?? resolveEmbeddedLyrics
    this.xlrcdb = options.xlrcdbProvider ?? new XlrcdbLookupCoordinator(createXlrcdbClientConfig({
      requestTimeoutMs: options.requestTimeoutMs,
      now: options.now
    }))
    this.lrclib = options.lrclibProvider ?? new LrclibLookupCoordinator(createLrclibClientConfig({
      appVersion: options.appVersion,
      baseUrl: this.lrclibBaseUrl,
      requestTimeoutMs: options.requestTimeoutMs,
      now: options.now
    }))
    this.onStatusChange = options.onStatusChange
  }

  getStatus(): LyricsStatus {
    if (!this.enabled) {
      return {
        enabled: false,
        provider: 'xlrcdb',
        lrclibBaseUrl: this.lrclibBaseUrl,
        statusMessage: 'Online lyrics lookup is disabled. Astra will only use local lyrics and embedded lyrics.',
        lastError: this.lastError
      }
    }

    if (this.lastError) {
      return {
        enabled: true,
        provider: 'xlrcdb',
        lrclibBaseUrl: this.lrclibBaseUrl,
        statusMessage: 'Online lyrics lookup is enabled with XLRCDB and LRCLIB fallback, but the last request failed.',
        lastError: this.lastError
      }
    }

    return {
      enabled: true,
      provider: 'xlrcdb',
      lrclibBaseUrl: this.lrclibBaseUrl,
      statusMessage: 'Online lyrics lookup is enabled with XLRCDB and LRCLIB fallback.',
      lastError: null
    }
  }

  applyConfig(enabled: boolean, lrclibBaseUrl: string = this.lrclibBaseUrl): LyricsStatus {
    this.enabled = Boolean(enabled)
    const normalizedBaseUrl = normalizeLrclibBaseUrl(lrclibBaseUrl)
    if (normalizedBaseUrl !== this.lrclibBaseUrl) {
      this.lrclibBaseUrl = normalizedBaseUrl
      this.lrclib.setBaseUrl?.(normalizedBaseUrl)
      this.lastError = null
    }
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
        format: 'plain',
        plainLyrics: null,
        syncedLyrics: null,
        syncedLines: [],
        syncOffsetMs: 0,
        updatedAt: null
      }
    }

    const override = this.libraryApi.getLyricsTrackOverride(normalizedTrackPath)
    if (!override) {
      return {
        trackPath: normalizedTrackPath,
        hasManualLyrics: false,
        format: 'plain',
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
      format: override.format,
      plainLyrics: override.plainLyrics,
      syncedLyrics: override.syncedLyrics,
      syncedLines: override.syncedLines,
      syncOffsetMs: override.syncOffsetMs,
      updatedAt: override.updatedAt
    }
  }

  async importManualLyrics(
    trackPaths: string[],
    lyricsText: string,
    format: LyricsFormat = 'lrc'
  ): Promise<LyricsManualImportResult> {
    const normalizedTrackPaths = normalizeTrackPathList(trackPaths)
    if (normalizedTrackPaths.length === 0) {
      throw new Error('Select at least one track before importing lyrics.')
    }

    const payload = parseLyricsText(lyricsText, 'manual', format)
    if (!payload) {
      throw new Error('Selected lyrics file is empty or could not be parsed.')
    }

    const updated = await this.libraryApi.upsertLyricsTrackManual(normalizedTrackPaths, {
      format: payload.format,
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

    const cleared = await this.libraryApi.clearLyricsTrackManual(normalizedTrackPaths)
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

    const updated = await this.libraryApi.setLyricsTrackSyncOffset(normalizedTrackPaths, normalizedOffset)
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
    const title = normalizeLrclibMetadataText(query.title)
    const artist = normalizeLrclibMetadataText(query.artist)
    const album = normalizeLrclibMetadataText(query.album)
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
    const trackOverride = this.libraryApi.getLyricsTrackOverride(path)
    const trackOffsetMs = trackOverride?.syncOffsetMs ?? 0
    let lrclibCached: library.LyricsCacheEntry | null = null

    if (trackOverride && hasManualLyricsOverride(trackOverride)) {
      const manualPayload = createLyricsPayload(
        'manual',
        null,
        trackOverride.format,
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

    const sidecarLyrics = await this.sidecarLookup(path)
    if (sidecarLyrics) {
      this.setLastError(null)
      return {
        ...sidecarLyrics,
        lyrics: applyTrackOffsetToPayload(sidecarLyrics.lyrics, trackOffsetMs)
      }
    }

    if (!options.forceRefresh) {
      const cached = this.libraryApi.getLyricsCache(path, metadataSignature)
      if (cached) {
        if (cached.source === 'lrclib' && this.enabled) {
          lrclibCached = cached
        } else {
          const cachedResult = this.createLookupResultFromCache(cached, trackOffsetMs)
          if (cachedResult) return cachedResult
        }
      }
    }

    const embedded = await this.embeddedResolver(path)
    if (embedded) {
      this.setLastError(null)
      await this.libraryApi.upsertLyricsCache({
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

    const xlrcdbLookup = await this.xlrcdb.lookup(normalizedQuery, metadataSignature, {
      forceRefresh: options.forceRefresh
    })
    if (xlrcdbLookup.status === 'hit') {
      this.setLastError(null)
      await this.libraryApi.upsertLyricsCache({
        trackPath: path,
        metadataSignature,
        status: 'hit',
        source: 'xlrcdb',
        provider: 'xlrcdb',
        plainLyrics: xlrcdbLookup.lyrics.plainLyrics,
        syncedLyrics: xlrcdbLookup.lyrics.syncedLyrics,
        syncedLines: xlrcdbLookup.lyrics.syncedLines
      })
      return {
        status: 'hit',
        lyrics: applyTrackOffsetToPayload(xlrcdbLookup.lyrics, trackOffsetMs),
        cached: false
      }
    }

    if (lrclibCached) {
      if (lrclibCached.status === 'not_found' && xlrcdbLookup.status === 'not_found') {
        await this.cacheOnlineNotFound(path, metadataSignature)
      }
      const cachedResult = this.createLookupResultFromCache(lrclibCached, trackOffsetMs)
      if (cachedResult) {
        this.setLastError(null)
        return cachedResult
      }
    }

    const lrclibLookup = await this.lrclib.lookup(normalizedQuery, metadataSignature, {
      forceRefresh: options.forceRefresh
    })
    if (lrclibLookup.status === 'hit') {
      this.setLastError(null)
      await this.libraryApi.upsertLyricsCache({
        trackPath: path,
        metadataSignature,
        status: 'hit',
        source: 'lrclib',
        provider: 'lrclib',
        plainLyrics: lrclibLookup.lyrics.plainLyrics,
        syncedLyrics: lrclibLookup.lyrics.syncedLyrics,
        syncedLines: lrclibLookup.lyrics.syncedLines
      })
      return {
        status: 'hit',
        lyrics: applyTrackOffsetToPayload(lrclibLookup.lyrics, trackOffsetMs),
        cached: false
      }
    }

    if (lrclibLookup.status === 'provider_unavailable') {
      this.setLastError(null)
      return {
        status: 'not_found',
        reason: 'provider-unavailable'
      }
    }

    if (lrclibLookup.status === 'transient_error') {
      this.setLastError(lrclibLookup.message)
      return {
        status: 'transient_error',
        message: lrclibLookup.message,
        code: lrclibLookup.code
      }
    }

    this.setLastError(null)
    if (xlrcdbLookup.status === 'not_found') {
      await this.cacheOnlineNotFound(path, metadataSignature)
    }
    return {
      status: 'not_found',
      reason: 'provider-not-found'
    }
  }

  private createLookupResultFromCache(
    cached: library.LyricsCacheEntry,
    trackOffsetMs: number
  ): LyricsLookupResult | null {
    if (cached.status === 'hit') {
      const payload = createLyricsPayload(
        cached.source,
        cached.provider,
        cached.format,
        cached.plainLyrics,
        cached.syncedLyrics,
        cached.syncedLines
      )
      if (!payload) return null
      return {
        status: 'hit',
        lyrics: applyTrackOffsetToPayload(payload, trackOffsetMs),
        cached: true
      }
    }

    return {
      status: 'not_found',
      reason: cached.source === 'embedded' ? 'embedded-missing' : 'provider-not-found'
    }
  }

  private async cacheOnlineNotFound(trackPath: string, metadataSignature: string): Promise<void> {
    await this.libraryApi.upsertLyricsCache({
      trackPath,
      metadataSignature,
      status: 'not_found',
      source: 'xlrcdb',
      provider: 'xlrcdb',
      plainLyrics: null,
      syncedLyrics: null,
      syncedLines: []
    })
  }
}
