import { useEffect } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { useDiscordSettingsStore } from '../stores/discordSettingsStore'

type PlayerSnapshot = ReturnType<typeof usePlayerStore.getState>

const PLAYING_PROGRESS_BUCKET_SECONDS = 15
const IDLE_PROGRESS_BUCKET_SECONDS = 1
const COVER_ART_CACHE_STORAGE_KEY_V2 = 'astra-discord-cover-art-cache-v2'
const COVER_ART_CACHE_STORAGE_KEY_V1 = 'astra-discord-cover-art-cache-v1'
const COVER_ART_CACHE_MAX_ENTRIES = 500
const COVER_ART_CACHE_HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const COVER_ART_CACHE_NOT_FOUND_TTL_MS = 6 * 60 * 60 * 1000
const COVER_ART_CACHE_TRANSIENT_ERROR_TTL_MS = 2 * 60 * 1000
const COVER_ART_LOG_INTERVAL_MS = 5000

interface DiscordCoverArtLookupQuery {
  album: string
  artist?: string
  albumArtist?: string
  title?: string
}

type DiscordCoverArtLookupResult =
  | { status: 'hit'; url: string }
  | { status: 'not_found' }
  | { status: 'transient_error'; code?: string }

type CachedCoverArtStatus = 'hit' | 'not_found' | 'transient_error'

interface CachedCoverArtEntry {
  status: CachedCoverArtStatus
  url?: string
  updatedAt: number
  expiresAt: number
}

interface LegacyCachedCoverArtEntry {
  url: string | null
  updatedAt: number
  expiresAt: number
}

type CachedCoverArtStore = Record<string, CachedCoverArtEntry>
type LegacyCachedCoverArtStore = Record<string, LegacyCachedCoverArtEntry>

interface DiscordTrackPayload {
  title: string
  artist?: string
  album?: string
  albumArtist?: string
  coverArtUrl?: string
  durationSeconds?: number
  format?: string
  sampleRate?: number
  bitDepth?: number
  bitrate?: number
  channels?: number
  codec?: string
  codecProfile?: string
  isAtmosJoc?: boolean
}

interface DiscordPresencePayload {
  playbackState: 'stopped' | 'playing' | 'paused' | 'loading'
  currentTimeSeconds?: number
  durationSeconds?: number
  track?: DiscordTrackPayload | null
}

interface DiscordPresenceSnapshot {
  key: string
  payload: DiscordPresencePayload
  trackPath: string | null
  coverArtLookupKey: string | null
  coverArtLookupQuery: DiscordCoverArtLookupQuery | null
}

let cachedCoverArtStore: CachedCoverArtStore | null = null
const pendingCoverArtLookups = new Map<string, Promise<DiscordCoverArtLookupResult>>()
const coverArtLogTimestamps = new Map<string, number>()

export function clearDiscordCoverArtLookupCache(): void {
  cachedCoverArtStore = null
  pendingCoverArtLookups.clear()
  coverArtLogTimestamps.clear()

  try {
    localStorage.removeItem(COVER_ART_CACHE_STORAGE_KEY_V1)
    localStorage.removeItem(COVER_ART_CACHE_STORAGE_KEY_V2)
  } catch {
    // Ignore storage failures when resetting cache.
  }
}

function normalizeSeconds(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined
  if (value < 0) return 0
  return Math.floor(value)
}

function normalizeLookupText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeLookupKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isUnknownLookupValue(value: string, type: 'artist' | 'album'): boolean {
  const normalized = normalizeLookupKey(value)
  if (!normalized) return true
  if (type === 'artist') {
    return normalized === 'unknown artist'
  }
  return normalized === 'unknown album'
}

function splitArtistCandidates(value: string): string[] {
  const normalized = normalizeLookupText(value)
  if (!normalized) return []

  const unified = normalized
    .replace(/\s*;\s*/g, ',')
    .replace(/\s+&\s+/g, ',')
    .replace(/\s+[x×]\s+/gi, ',')
    .replace(/\s+(?:feat\.?|ft\.?|featuring|with)\s+/gi, ',')

  const seen = new Set<string>()
  const candidates: string[] = []
  for (const part of unified.split(',')) {
    const candidate = normalizeLookupText(part)
    if (!candidate) continue
    const key = normalizeLookupKey(candidate)
    if (!key || seen.has(key)) continue
    seen.add(key)
    candidates.push(candidate)
  }
  return candidates
}

function pickPrimaryArtist(value: string | null): string | null {
  if (!value) return null
  const candidates = splitArtistCandidates(value)
  return candidates[0] ?? value
}

function isValidHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const normalized = value.trim()
  if (!normalized) return false

  try {
    const parsed = new URL(normalized)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function getProgressBucket(playbackState: PlayerSnapshot['playbackState'], currentTime: number): number {
  const seconds = normalizeSeconds(currentTime) ?? 0
  const bucketSize = playbackState === 'playing'
    ? PLAYING_PROGRESS_BUCKET_SECONDS
    : IDLE_PROGRESS_BUCKET_SECONDS
  return Math.floor(seconds / bucketSize)
}

function shouldEmitUpdate(nextState: PlayerSnapshot, prevState: PlayerSnapshot): boolean {
  if (nextState.currentTrack?.path !== prevState.currentTrack?.path) return true
  if (nextState.playbackState !== prevState.playbackState) return true
  if (Math.floor(nextState.duration) !== Math.floor(prevState.duration)) return true
  return getProgressBucket(nextState.playbackState, nextState.currentTime) !==
    getProgressBucket(prevState.playbackState, prevState.currentTime)
}

function logCoverArtLookup(event: string, lookupKey: string, details: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return

  const logKey = `${event}:${lookupKey}`
  const now = Date.now()
  const previous = coverArtLogTimestamps.get(logKey) ?? 0
  if (now - previous < COVER_ART_LOG_INTERVAL_MS) return
  coverArtLogTimestamps.set(logKey, now)
  console.debug(`[discord-cover-art] ${event}`, details)
}

function readLegacyCoverArtStore(): LegacyCachedCoverArtStore {
  try {
    const raw = localStorage.getItem(COVER_ART_CACHE_STORAGE_KEY_V1)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as LegacyCachedCoverArtStore
  } catch {
    return {}
  }
}

function migrateLegacyCoverArtStore(): CachedCoverArtStore {
  const migrated: CachedCoverArtStore = {}
  const now = Date.now()
  const legacyStore = readLegacyCoverArtStore()

  for (const [key, entry] of Object.entries(legacyStore)) {
    if (!entry || typeof entry !== 'object') continue
    if (!Number.isFinite(entry.updatedAt)) continue
    if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) continue
    if (!isValidHttpsUrl(entry.url)) continue

    migrated[key] = {
      status: 'hit',
      url: entry.url,
      updatedAt: entry.updatedAt,
      expiresAt: entry.expiresAt
    }
  }

  return migrated
}

function persistCoverArtStore(store: CachedCoverArtStore): void {
  try {
    localStorage.setItem(COVER_ART_CACHE_STORAGE_KEY_V2, JSON.stringify(store))
  } catch {
    // Ignore persistence failures and continue with in-memory cache.
  }
}

function pruneCoverArtStore(store: CachedCoverArtStore): void {
  const now = Date.now()
  const entries = Object.entries(store)
  for (const [key, entry] of entries) {
    if (!entry || typeof entry !== 'object') {
      delete store[key]
      continue
    }

    if (
      entry.status !== 'hit'
      && entry.status !== 'not_found'
      && entry.status !== 'transient_error'
    ) {
      delete store[key]
      continue
    }

    if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) {
      delete store[key]
      continue
    }

    if (!Number.isFinite(entry.updatedAt)) {
      delete store[key]
      continue
    }

    if (entry.status === 'hit') {
      if (!isValidHttpsUrl(entry.url)) {
        delete store[key]
      }
    } else if (entry.url !== undefined) {
      delete store[key]
    }
  }

  const validEntries = Object.entries(store)
  if (validEntries.length <= COVER_ART_CACHE_MAX_ENTRIES) return

  validEntries
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(COVER_ART_CACHE_MAX_ENTRIES)
    .forEach(([key]) => {
      delete store[key]
    })
}

function loadCoverArtStore(): CachedCoverArtStore {
  if (cachedCoverArtStore) return cachedCoverArtStore

  let store: CachedCoverArtStore = {}
  try {
    const raw = localStorage.getItem(COVER_ART_CACHE_STORAGE_KEY_V2)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        store = parsed as CachedCoverArtStore
      }
    } else {
      store = migrateLegacyCoverArtStore()
    }
  } catch {
    store = migrateLegacyCoverArtStore()
  }

  pruneCoverArtStore(store)
  persistCoverArtStore(store)
  try {
    localStorage.removeItem(COVER_ART_CACHE_STORAGE_KEY_V1)
  } catch {
    // Ignore storage failures.
  }

  cachedCoverArtStore = store
  return cachedCoverArtStore
}

function getCachedCoverArtEntry(cacheKey: string): CachedCoverArtEntry | undefined {
  const store = loadCoverArtStore()
  const entry = store[cacheKey]
  if (!entry) return undefined

  if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= Date.now()) {
    delete store[cacheKey]
    persistCoverArtStore(store)
    return undefined
  }

  return entry
}

function resolveCacheTtl(status: CachedCoverArtStatus): number {
  if (status === 'hit') return COVER_ART_CACHE_HIT_TTL_MS
  if (status === 'not_found') return COVER_ART_CACHE_NOT_FOUND_TTL_MS
  return COVER_ART_CACHE_TRANSIENT_ERROR_TTL_MS
}

function setCachedCoverArtEntry(
  cacheKey: string,
  status: CachedCoverArtStatus,
  url?: string
): void {
  const store = loadCoverArtStore()
  const now = Date.now()

  const entry: CachedCoverArtEntry = {
    status,
    updatedAt: now,
    expiresAt: now + resolveCacheTtl(status)
  }
  if (status === 'hit' && url) {
    entry.url = url
  }

  store[cacheKey] = entry
  pruneCoverArtStore(store)
  persistCoverArtStore(store)
}

function cachedEntryToLookupResult(entry: CachedCoverArtEntry): DiscordCoverArtLookupResult {
  if (entry.status === 'hit' && isValidHttpsUrl(entry.url)) {
    return {
      status: 'hit',
      url: entry.url
    }
  }
  if (entry.status === 'not_found') {
    return { status: 'not_found' }
  }
  return { status: 'transient_error' }
}

function normalizeLookupResult(value: unknown): DiscordCoverArtLookupResult {
  if (!value || typeof value !== 'object') {
    return {
      status: 'transient_error',
      code: 'invalid_lookup_payload'
    }
  }

  const normalized = value as Record<string, unknown>
  if (normalized.status === 'hit' && isValidHttpsUrl(normalized.url)) {
    return {
      status: 'hit',
      url: normalized.url
    }
  }

  if (normalized.status === 'not_found') {
    return { status: 'not_found' }
  }

  if (normalized.status === 'transient_error') {
    return {
      status: 'transient_error',
      code: typeof normalized.code === 'string' ? normalized.code : undefined
    }
  }

  return {
    status: 'transient_error',
    code: 'invalid_lookup_status'
  }
}

function buildCoverArtLookupQuery(track: PlayerSnapshot['currentTrack']): DiscordCoverArtLookupQuery | null {
  if (!track) return null

  const album = normalizeLookupText(track.album)
  const artist = pickPrimaryArtist(normalizeLookupText(track.artist))
  const albumArtist = pickPrimaryArtist(normalizeLookupText(track.albumArtist))
  const title = normalizeLookupText(track.title)
  const preferredArtist = albumArtist ?? artist

  if (!album || !preferredArtist) return null
  if (isUnknownLookupValue(album, 'album')) return null
  if (isUnknownLookupValue(preferredArtist, 'artist')) return null

  return {
    album,
    artist: artist ?? undefined,
    albumArtist: albumArtist ?? undefined,
    title: title ?? undefined
  }
}

function buildCoverArtLookupKey(query: DiscordCoverArtLookupQuery | null): string | null {
  if (!query) return null
  const albumKey = normalizeLookupKey(query.album)
  const preferredArtist = normalizeLookupText(query.albumArtist) ?? normalizeLookupText(query.artist)
  if (!albumKey || !preferredArtist) return null

  const artistKey = normalizeLookupKey(preferredArtist)
  if (!artistKey) return null

  return `${artistKey}::${albumKey}`
}

async function resolveCoverArtWithCache(
  lookupKey: string,
  query: DiscordCoverArtLookupQuery
): Promise<DiscordCoverArtLookupResult> {
  const cachedEntry = getCachedCoverArtEntry(lookupKey)
  if (cachedEntry) {
    logCoverArtLookup('cache-hit', lookupKey, { status: cachedEntry.status })
    return cachedEntryToLookupResult(cachedEntry)
  }

  const inFlight = pendingCoverArtLookups.get(lookupKey)
  if (inFlight) {
    return inFlight
  }

  logCoverArtLookup('cache-miss', lookupKey, {})

  const request = window.electronAPI.discord.resolveCoverArt(query)
    .then((result) => normalizeLookupResult(result))
    .catch(() => ({ status: 'transient_error', code: 'renderer_ipc_error' } as const))
    .then((result) => {
      if (result.status === 'hit') {
        setCachedCoverArtEntry(lookupKey, 'hit', result.url)
      } else if (result.status === 'not_found') {
        setCachedCoverArtEntry(lookupKey, 'not_found')
      } else {
        setCachedCoverArtEntry(lookupKey, 'transient_error')
      }

      logCoverArtLookup('lookup-outcome', lookupKey, {
        status: result.status,
        code: result.status === 'transient_error' ? result.code : undefined
      })
      return result
    })
    .finally(() => {
      pendingCoverArtLookups.delete(lookupKey)
    })

  pendingCoverArtLookups.set(lookupKey, request)
  return request
}

function buildPresenceUpdate(
  state: PlayerSnapshot,
  coverArtByTrackPath: Map<string, string>
): DiscordPresenceSnapshot {
  const { currentTrack, playbackState } = state
  if (!currentTrack || playbackState === 'stopped') {
    return {
      key: 'stopped',
      payload: {
        playbackState: 'stopped',
        track: null
      },
      trackPath: null,
      coverArtLookupKey: null,
      coverArtLookupQuery: null
    }
  }

  const currentTimeSeconds = normalizeSeconds(state.currentTime)
  const durationSeconds = normalizeSeconds(state.duration || currentTrack.duration)
  const progressBucket = getProgressBucket(playbackState, state.currentTime)
  const trackPath = currentTrack.path
  const coverArtLookupQuery = buildCoverArtLookupQuery(currentTrack)
  const coverArtLookupKey = buildCoverArtLookupKey(coverArtLookupQuery)
  const coverArtUrl = coverArtByTrackPath.get(trackPath)

  return {
    key: JSON.stringify({
      trackPath: currentTrack.path,
      playbackState,
      progressBucket,
      durationSeconds,
      albumArtist: currentTrack.albumArtist,
      format: currentTrack.format,
      sampleRate: currentTrack.sampleRate,
      bitDepth: currentTrack.bitDepth,
      bitrate: currentTrack.bitrate,
      channels: currentTrack.channels,
      codec: currentTrack.codec,
      codecProfile: currentTrack.codecProfile,
      isAtmosJoc: currentTrack.isAtmosJoc,
      coverArtUrl
    }),
    payload: {
      playbackState,
      currentTimeSeconds,
      durationSeconds,
      track: {
        title: currentTrack.title,
        artist: currentTrack.artist,
        album: currentTrack.album,
        albumArtist: currentTrack.albumArtist,
        coverArtUrl,
        durationSeconds: normalizeSeconds(currentTrack.duration),
        format: currentTrack.format,
        sampleRate: currentTrack.sampleRate,
        bitDepth: currentTrack.bitDepth,
        bitrate: currentTrack.bitrate,
        channels: currentTrack.channels,
        codec: currentTrack.codec,
        codecProfile: currentTrack.codecProfile,
        isAtmosJoc: currentTrack.isAtmosJoc
      }
    },
    trackPath,
    coverArtLookupKey,
    coverArtLookupQuery
  }
}

export function useDiscordPresence(): void {
  const enabled = useDiscordSettingsStore((s) => s.enabled)
  const coverArtEnabled = useDiscordSettingsStore((s) => s.coverArtEnabled)

  useEffect(() => {
    if (!enabled) {
      window.electronAPI.discord.clearPresence()
      return
    }

    let disposed = false
    let lastKey = ''
    let lookupToken = 0
    const coverArtByTrackPath = new Map<string, string>()

    const emitLatest = (): DiscordPresenceSnapshot => {
      const state = usePlayerStore.getState()
      let snapshot = buildPresenceUpdate(state, coverArtByTrackPath)

      if (
        coverArtEnabled
        && snapshot.trackPath
        && !coverArtByTrackPath.has(snapshot.trackPath)
        && snapshot.coverArtLookupKey
      ) {
        const cachedEntry = getCachedCoverArtEntry(snapshot.coverArtLookupKey)
        if (cachedEntry?.status === 'hit' && isValidHttpsUrl(cachedEntry.url)) {
          coverArtByTrackPath.set(snapshot.trackPath, cachedEntry.url)
          snapshot = buildPresenceUpdate(state, coverArtByTrackPath)
        }
      }

      if (snapshot.key !== lastKey) {
        lastKey = snapshot.key
        window.electronAPI.discord.updatePresence(snapshot.payload)
      }
      return snapshot
    }

    const resolveCoverArtForSnapshot = (snapshot: DiscordPresenceSnapshot) => {
      if (!coverArtEnabled) return
      if (!snapshot.trackPath || !snapshot.coverArtLookupKey || !snapshot.coverArtLookupQuery) return
      if (coverArtByTrackPath.has(snapshot.trackPath)) return

      const requestToken = ++lookupToken
      const requestTrackPath = snapshot.trackPath
      const requestLookupKey = snapshot.coverArtLookupKey

      void resolveCoverArtWithCache(requestLookupKey, snapshot.coverArtLookupQuery)
        .then((result) => {
          if (disposed) return
          if (requestToken !== lookupToken) return
          if (result.status !== 'hit') return

          const latestTrackPath = usePlayerStore.getState().currentTrack?.path ?? null
          if (latestTrackPath !== requestTrackPath) return

          coverArtByTrackPath.set(requestTrackPath, result.url)
          logCoverArtLookup('presence-cover-applied', requestLookupKey, {
            trackPath: requestTrackPath
          })
          emitLatest()
        })
    }

    const initialSnapshot = emitLatest()
    resolveCoverArtForSnapshot(initialSnapshot)

    const unsubscribe = usePlayerStore.subscribe((nextState, prevState) => {
      if (!shouldEmitUpdate(nextState, prevState)) return

      const snapshot = emitLatest()
      if (nextState.currentTrack?.path !== prevState.currentTrack?.path) {
        resolveCoverArtForSnapshot(snapshot)
      }
    })

    return () => {
      disposed = true
      lookupToken += 1
      unsubscribe()
    }
  }, [enabled, coverArtEnabled])
}
