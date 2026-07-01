import { createHash } from 'crypto'

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_RETRIES = 1
const DEFAULT_PAGE_SIZE = 500
const CLIENT_NAME = 'Astra'
const CLIENT_VERSION = '0.4.0'
const DEVICE_NAME = 'Astra Desktop'
const TRANSCODE_AUDIO_CODEC = 'mp3'
const TRANSCODE_CONTAINER = 'mp3'

export interface JellyfinConnectionConfig {
  baseUrl: string
  username: string
  password: string
}

export interface JellyfinAuthContext {
  accessToken: string
  userId: string
}

export interface JellyfinCatalogTrack {
  path: string
  source_track_id: string
  source_path: string | null
  artwork_source_id: string | null
  title: string
  artist: string
  album: string
  album_artist: string | null
  duration: number
  track_number: number | null
  disc_number: number | null
  year: number | null
  genre: string | null
  genres: string[]
  artwork_hash: string | null
  format: string
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  codec: string | null
  codec_profile: string | null
  is_atmos_joc: number | null
  replaygain_track_gain_db: number | null
  replaygain_album_gain_db: number | null
  bpm: number | null
  musical_key: string | null
}

export interface JellyfinCatalogSyncResult {
  itemsScanned: number
  tracksScanned: number
  tracks: JellyfinCatalogTrack[]
}

interface JellyfinRequestOptions {
  timeoutMs?: number
  retries?: number
  signal?: AbortSignal
  onDownloadProgress?: (progress: JellyfinDownloadProgress) => void
  maxBitRateKbps?: number
}

export interface JellyfinDownloadProgress {
  loadedBytes: number
  totalBytes: number | null
  chunkCount: number
  done: boolean
}

export interface JellyfinCatalogSyncProgress {
  phase: 'items'
  current: number
  total: number
  detail: string | null
}

export interface JellyfinCatalogSyncOptions extends JellyfinRequestOptions {
  authContext?: JellyfinAuthContext
  onProgress?: (progress: JellyfinCatalogSyncProgress) => void
}

interface JellyfinAuthenticateResponse {
  AccessToken?: unknown
  User?: {
    Id?: unknown
  }
  error?: unknown
  message?: unknown
}

interface JellyfinItemsResponse {
  Items?: unknown
  TotalRecordCount?: unknown
}

interface JellyfinAudioStream {
  Type?: unknown
  Codec?: unknown
  Profile?: unknown
  Channels?: unknown
  BitRate?: unknown
  SampleRate?: unknown
  BitDepth?: unknown
}

interface JellyfinAudioItem {
  Id?: unknown
  Name?: unknown
  Path?: unknown
  Artists?: unknown
  ArtistItems?: unknown
  Album?: unknown
  AlbumArtist?: unknown
  AlbumArtists?: unknown
  AlbumId?: unknown
  AlbumPrimaryImageTag?: unknown
  ImageTags?: unknown
  RunTimeTicks?: unknown
  IndexNumber?: unknown
  ParentIndexNumber?: unknown
  ProductionYear?: unknown
  Genres?: unknown
  Container?: unknown
  Bitrate?: unknown
  MediaStreams?: unknown
}

function asArray<T>(value: unknown): T[] {
  if (!value) return []
  return Array.isArray(value) ? value as T[] : [value as T]
}

function toTrimmedText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toFiniteInteger(value: unknown): number | null {
  const parsed = toFiniteNumber(value)
  if (parsed == null) return null
  const intValue = Math.trunc(parsed)
  return Number.isFinite(intValue) ? intValue : null
}

function normalizeBooleanQueryValue(value: boolean): string {
  return value ? 'true' : 'false'
}

export function normalizeJellyfinBaseUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim()
  if (!trimmed) {
    throw new Error('Server URL is required.')
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(trimmed)
  } catch {
    throw new Error('Server URL is invalid.')
  }

  const protocol = parsedUrl.protocol.toLowerCase()
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error('Server URL must use http:// or https://')
  }

  parsedUrl.hash = ''
  parsedUrl.search = ''
  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, '')
  return parsedUrl.toString().replace(/\/+$/, '')
}

function buildJellyfinDeviceId(config: JellyfinConnectionConfig): string {
  const base = normalizeJellyfinBaseUrl(config.baseUrl)
  const username = config.username.trim().toLowerCase()
  return createHash('sha1').update(`${base}|${username}|${CLIENT_NAME}`).digest('hex')
}

function escapeHeaderTokenValue(value: string): string {
  return value.replace(/"/g, '\\"')
}

function buildJellyfinAuthorizationHeader(
  config: JellyfinConnectionConfig,
  options: { token?: string } = {}
): string {
  const parts = [
    `Client=\"${escapeHeaderTokenValue(CLIENT_NAME)}\"`,
    `Device=\"${escapeHeaderTokenValue(DEVICE_NAME)}\"`,
    `DeviceId=\"${escapeHeaderTokenValue(buildJellyfinDeviceId(config))}\"`,
    `Version=\"${escapeHeaderTokenValue(CLIENT_VERSION)}\"`
  ]
  if (options.token) {
    parts.push(`Token=\"${escapeHeaderTokenValue(options.token)}\"`)
  }
  return `MediaBrowser ${parts.join(', ')}`
}

export function buildJellyfinStreamRequestHeaders(
  config: JellyfinConnectionConfig,
  authContext: JellyfinAuthContext
): Record<string, string> {
  return {
    'X-Emby-Authorization': buildJellyfinAuthorizationHeader(config, { token: authContext.accessToken }),
    'X-Emby-Token': authContext.accessToken
  }
}

function buildJellyfinUrl(
  config: JellyfinConnectionConfig,
  endpoint: string,
  params: Record<string, string | number | boolean | null | undefined>
): URL {
  const baseUrl = normalizeJellyfinBaseUrl(config.baseUrl)
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
  const url = new URL(`${baseUrl}${normalizedEndpoint}`)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'boolean') {
      url.searchParams.set(key, normalizeBooleanQueryValue(value))
    } else {
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

function mergeAbortSignals(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal
  cleanup: () => void
} {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) {
      controller.abort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId)
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }
    }
  }
}

async function requestJellyfinJson(
  config: JellyfinConnectionConfig,
  authContext: JellyfinAuthContext,
  endpoint: string,
  params: Record<string, string | number | boolean | null | undefined>,
  options: JellyfinRequestOptions = {}
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES)
  const url = buildJellyfinUrl(config, endpoint, params)

  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const merged = mergeAbortSignals(options.signal, timeoutMs)
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: merged.signal,
        headers: {
          Accept: 'application/json',
          'X-Emby-Authorization': buildJellyfinAuthorizationHeader(config, { token: authContext.accessToken }),
          'X-Emby-Token': authContext.accessToken
        }
      })

      if (!response.ok) {
        throw new Error(`Jellyfin request failed (${response.status})`)
      }

      return await response.json() as Record<string, unknown>
    } catch (error) {
      lastError = error
      if (attempt >= retries) {
        throw error
      }
    } finally {
      merged.cleanup()
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Jellyfin request failed.')
}

async function requestJellyfinBytesFromUrl(
  url: URL,
  headers: Record<string, string>,
  options: JellyfinRequestOptions = {}
): Promise<ArrayBuffer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES)

  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const merged = mergeAbortSignals(options.signal, timeoutMs)
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: merged.signal,
        headers
      })
      if (!response.ok) {
        throw new Error(`Jellyfin stream request failed (${response.status})`)
      }

      const contentType = toTrimmedText(response.headers.get('content-type'))?.toLowerCase() ?? ''
      if (
        contentType
        && (contentType.includes('json') || contentType.includes('xml') || contentType.startsWith('text/'))
      ) {
        throw new Error('Jellyfin stream response was not audio.')
      }

      const contentLengthHeader = response.headers.get('content-length')
      const parsedContentLength = contentLengthHeader
        ? Number.parseInt(contentLengthHeader, 10)
        : Number.NaN
      const totalBytes = Number.isFinite(parsedContentLength) && parsedContentLength > 0
        ? parsedContentLength
        : null

      const reader = response.body?.getReader()
      if (!reader) {
        const data = await response.arrayBuffer()
        options.onDownloadProgress?.({
          loadedBytes: data.byteLength,
          totalBytes: totalBytes ?? data.byteLength,
          chunkCount: data.byteLength > 0 ? 1 : 0,
          done: true
        })
        return data
      }

      options.onDownloadProgress?.({
        loadedBytes: 0,
        totalBytes,
        chunkCount: 0,
        done: false
      })

      const chunks: Uint8Array[] = []
      let loadedBytes = 0
      let chunkCount = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue

        chunks.push(value)
        loadedBytes += value.byteLength
        chunkCount += 1

        options.onDownloadProgress?.({
          loadedBytes,
          totalBytes,
          chunkCount,
          done: false
        })
      }

      const data = new Uint8Array(loadedBytes)
      let offset = 0
      for (const chunk of chunks) {
        data.set(chunk, offset)
        offset += chunk.byteLength
      }

      options.onDownloadProgress?.({
        loadedBytes,
        totalBytes: totalBytes ?? loadedBytes,
        chunkCount,
        done: true
      })

      return data.buffer
    } catch (error) {
      lastError = error
      if (attempt >= retries) {
        throw error
      }
    } finally {
      merged.cleanup()
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Jellyfin stream request failed.')
}

export async function authenticateJellyfin(
  config: JellyfinConnectionConfig,
  options: JellyfinRequestOptions = {}
): Promise<JellyfinAuthContext> {
  const baseUrl = normalizeJellyfinBaseUrl(config.baseUrl)
  const username = config.username.trim()
  const password = config.password

  if (!username) {
    throw new Error('Username is required.')
  }
  if (!password) {
    throw new Error('Password is required.')
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES)
  const url = new URL(`${baseUrl}/Users/AuthenticateByName`)

  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const merged = mergeAbortSignals(options.signal, timeoutMs)
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: merged.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Emby-Authorization': buildJellyfinAuthorizationHeader(config)
        },
        body: JSON.stringify({
          Username: username,
          Pw: password
        })
      })

      if (!response.ok) {
        throw new Error(`Jellyfin authentication failed (${response.status})`)
      }

      const payload = await response.json() as JellyfinAuthenticateResponse
      const accessToken = toTrimmedText(payload.AccessToken)
      const userId = toTrimmedText(payload.User?.Id)

      if (!accessToken || !userId) {
        throw new Error('Invalid Jellyfin authentication response.')
      }

      return {
        accessToken,
        userId
      }
    } catch (error) {
      lastError = error
      if (attempt >= retries) {
        throw error
      }
    } finally {
      merged.cleanup()
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Jellyfin authentication failed.')
}

export async function testJellyfinConnection(
  config: JellyfinConnectionConfig,
  options: JellyfinRequestOptions = {}
): Promise<void> {
  await authenticateJellyfin(config, options)
}

function resolveJellyfinArtist(item: JellyfinAudioItem): string {
  const artists = asArray<string>(item.Artists)
    .map((value) => toTrimmedText(value))
    .filter((value): value is string => Boolean(value))
  if (artists.length > 0) return artists[0]

  const artistItems = asArray<Record<string, unknown>>(item.ArtistItems)
  for (const artistItem of artistItems) {
    const candidate = toTrimmedText(artistItem.Name)
    if (candidate) return candidate
  }

  return 'Unknown Artist'
}

function resolveJellyfinAlbumArtist(item: JellyfinAudioItem): string | null {
  const direct = toTrimmedText(item.AlbumArtist)
  if (direct) return direct

  const albumArtists = asArray<string>(item.AlbumArtists)
    .map((value) => toTrimmedText(value))
    .filter((value): value is string => Boolean(value))

  if (albumArtists.length > 0) return albumArtists[0]
  return null
}

function resolveJellyfinArtworkSourceId(item: JellyfinAudioItem, sourceTrackId: string): string | null {
  const albumId = toTrimmedText(item.AlbumId)
  const albumPrimaryImageTag = toTrimmedText(item.AlbumPrimaryImageTag)
  if (albumId && albumPrimaryImageTag) {
    return albumId
  }

  const imageTags = item.ImageTags
  if (imageTags && typeof imageTags === 'object') {
    const primary = toTrimmedText((imageTags as Record<string, unknown>).Primary)
    if (primary) {
      return sourceTrackId
    }
  }

  return null
}

function normalizeJellyfinFormat(item: JellyfinAudioItem): string {
  const container = toTrimmedText(item.Container)
  if (container) {
    return container.toLowerCase()
  }

  const pathValue = toTrimmedText(item.Path)
  if (pathValue && pathValue.includes('.')) {
    const ext = pathValue.split('.').pop()?.trim().toLowerCase()
    if (ext) return ext
  }

  return 'unknown'
}

function isAtmosJoc(codec: string | null, profile: string | null): boolean {
  const combined = `${codec ?? ''} ${profile ?? ''}`.toLowerCase()
  return combined.includes('atmos') || combined.includes('joc')
}

function mapJellyfinItemToCatalogTrack(sourceId: number, item: JellyfinAudioItem): JellyfinCatalogTrack | null {
  const sourceTrackId = toTrimmedText(item.Id)
  if (!sourceTrackId) return null

  const title = toTrimmedText(item.Name) ?? `Track ${sourceTrackId}`
  const artist = resolveJellyfinArtist(item)
  const album = toTrimmedText(item.Album) ?? 'Unknown Album'
  const albumArtist = resolveJellyfinAlbumArtist(item)
  const durationTicks = toFiniteNumber(item.RunTimeTicks)
  const duration = durationTicks && durationTicks > 0
    ? durationTicks / 10_000_000
    : 0
  const trackNumber = toFiniteInteger(item.IndexNumber)
  const discNumber = toFiniteInteger(item.ParentIndexNumber)
  const year = toFiniteInteger(item.ProductionYear)
  const genres = asArray<string>(item.Genres)
    .map((value) => toTrimmedText(value))
    .filter((value): value is string => Boolean(value))
  const genre = genres[0] ?? null

  const sourcePath = toTrimmedText(item.Path)
  const mediaStreams = asArray<JellyfinAudioStream>(item.MediaStreams)
  const audioStream = mediaStreams.find((stream) => toTrimmedText(stream.Type)?.toLowerCase() === 'audio')
  const codec = toTrimmedText(audioStream?.Codec)
  const codecProfile = toTrimmedText(audioStream?.Profile)
  const channels = toFiniteInteger(audioStream?.Channels)
  const sampleRate = toFiniteInteger(audioStream?.SampleRate)
  const bitDepth = toFiniteInteger(audioStream?.BitDepth)
  const streamBitrate = toFiniteInteger(audioStream?.BitRate)
  const itemBitrate = toFiniteInteger(item.Bitrate)
  const artworkSourceId = resolveJellyfinArtworkSourceId(item, sourceTrackId)

  return {
    path: buildJellyfinTrackPath(sourceId, sourceTrackId),
    source_track_id: sourceTrackId,
    source_path: sourcePath,
    artwork_source_id: artworkSourceId,
    title,
    artist,
    album,
    album_artist: albumArtist,
    duration,
    track_number: trackNumber,
    disc_number: discNumber,
    year,
    genre,
    genres,
    artwork_hash: null,
    format: normalizeJellyfinFormat(item),
    sample_rate: sampleRate,
    bit_depth: bitDepth,
    bitrate: streamBitrate ?? itemBitrate,
    channels,
    codec,
    codec_profile: codecProfile,
    is_atmos_joc: isAtmosJoc(codec, codecProfile) ? 1 : null,
    replaygain_track_gain_db: null,
    replaygain_album_gain_db: null,
    bpm: null,
    musical_key: null
  }
}

export async function syncJellyfinCatalog(
  sourceId: number,
  config: JellyfinConnectionConfig,
  options: JellyfinCatalogSyncOptions = {}
): Promise<JellyfinCatalogSyncResult> {
  const authContext = options.authContext ?? await authenticateJellyfin(config, options)
  const byTrackId = new Map<string, JellyfinCatalogTrack>()
  let startIndex = 0
  let totalRecordCount: number | null = null

  while (true) {
    const response = await requestJellyfinJson(
      config,
      authContext,
      `/Users/${encodeURIComponent(authContext.userId)}/Items`,
      {
        Recursive: true,
        IncludeItemTypes: 'Audio',
        Fields: 'Path,Genres,Container,Bitrate,RunTimeTicks,ProductionYear,IndexNumber,ParentIndexNumber,Album,AlbumArtist,AlbumArtists,AlbumId,AlbumPrimaryImageTag,ImageTags,MediaStreams',
        SortBy: 'SortName',
        SortOrder: 'Ascending',
        StartIndex: startIndex,
        Limit: DEFAULT_PAGE_SIZE
      },
      options
    ) as JellyfinItemsResponse

    const total = toFiniteInteger(response.TotalRecordCount)
    if (totalRecordCount === null && total !== null && total >= 0) {
      totalRecordCount = total
    }

    const items = asArray<JellyfinAudioItem>(response.Items)
    for (const item of items) {
      const mapped = mapJellyfinItemToCatalogTrack(sourceId, item)
      if (!mapped) continue
      byTrackId.set(mapped.source_track_id, mapped)
    }

    options.onProgress?.({
      phase: 'items',
      current: startIndex + items.length,
      total: totalRecordCount ?? (startIndex + items.length),
      detail: null
    })

    if (items.length === 0) break
    startIndex += items.length
    if (totalRecordCount !== null && startIndex >= totalRecordCount) break
    if (items.length < DEFAULT_PAGE_SIZE) break
  }

  const tracks = Array.from(byTrackId.values())
  return {
    itemsScanned: totalRecordCount ?? tracks.length,
    tracksScanned: tracks.length,
    tracks
  }
}

export function buildJellyfinTrackPath(sourceId: number, sourceTrackId: string): string {
  return `jellyfin://${sourceId}/track/${encodeURIComponent(sourceTrackId)}`
}

export function parseJellyfinTrackPath(path: string): { sourceId: number; sourceTrackId: string } | null {
  const match = /^jellyfin:\/\/(\d+)\/track\/(.+)$/.exec(path)
  if (!match) return null

  const sourceId = Number.parseInt(match[1], 10)
  if (!Number.isInteger(sourceId) || sourceId <= 0) return null

  const sourceTrackIdRaw = match[2]
  if (!sourceTrackIdRaw) return null
  try {
    const sourceTrackId = decodeURIComponent(sourceTrackIdRaw)
    if (!sourceTrackId) return null
    return { sourceId, sourceTrackId }
  } catch {
    return null
  }
}

export function buildJellyfinStreamUrl(
  config: JellyfinConnectionConfig,
  sourceTrackId: string,
  accessToken: string
): string {
  return buildJellyfinUrl(
    config,
    `/Items/${encodeURIComponent(sourceTrackId)}/Download`,
    {
      api_key: accessToken
    }
  ).toString()
}

export function buildJellyfinTranscodeStreamUrl(
  config: JellyfinConnectionConfig,
  sourceTrackId: string,
  authContext: JellyfinAuthContext,
  maxBitRateKbps: number
): string {
  const normalizedMaxBitrate = Math.max(16, Math.trunc(maxBitRateKbps)) * 1000
  return buildJellyfinUrl(
    config,
    `/Audio/${encodeURIComponent(sourceTrackId)}/universal`,
    {
      UserId: authContext.userId,
      DeviceId: buildJellyfinDeviceId(config),
      api_key: authContext.accessToken,
      AudioCodec: TRANSCODE_AUDIO_CODEC,
      Container: TRANSCODE_CONTAINER,
      TranscodingContainer: TRANSCODE_CONTAINER,
      MaxStreamingBitrate: normalizedMaxBitrate
    }
  ).toString()
}

export async function fetchJellyfinTrackBytes(
  config: JellyfinConnectionConfig,
  sourceTrackId: string,
  authContext: JellyfinAuthContext,
  options: JellyfinRequestOptions = {}
): Promise<ArrayBuffer> {
  const maxBitRateKbps = options.maxBitRateKbps
  const useTranscode = typeof maxBitRateKbps === 'number' && Number.isFinite(maxBitRateKbps) && maxBitRateKbps > 0
  const streamUrl = useTranscode
    ? buildJellyfinTranscodeStreamUrl(config, sourceTrackId, authContext, maxBitRateKbps)
    : buildJellyfinStreamUrl(config, sourceTrackId, authContext.accessToken)
  const url = new URL(streamUrl)
  return requestJellyfinBytesFromUrl(
    url,
    {
      'X-Emby-Authorization': buildJellyfinAuthorizationHeader(config, { token: authContext.accessToken }),
      'X-Emby-Token': authContext.accessToken
    },
    options
  )
}

export async function fetchJellyfinCoverArt(
  config: JellyfinConnectionConfig,
  itemId: string,
  authContext: JellyfinAuthContext,
  options: JellyfinRequestOptions = {}
): Promise<{ data: ArrayBuffer; contentType: string | null }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES)
  const url = buildJellyfinUrl(
    config,
    `/Items/${encodeURIComponent(itemId)}/Images/Primary`,
    {
      api_key: authContext.accessToken,
      quality: 90
    }
  )

  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const merged = mergeAbortSignals(options.signal, timeoutMs)
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: merged.signal,
        headers: {
          'X-Emby-Authorization': buildJellyfinAuthorizationHeader(config, { token: authContext.accessToken }),
          'X-Emby-Token': authContext.accessToken
        }
      })

      if (!response.ok) {
        throw new Error(`Jellyfin cover art request failed (${response.status})`)
      }

      const contentType = toTrimmedText(response.headers.get('content-type'))
      if (contentType && !contentType.toLowerCase().startsWith('image/')) {
        throw new Error('Jellyfin cover art response was not an image.')
      }

      return {
        data: await response.arrayBuffer(),
        contentType
      }
    } catch (error) {
      lastError = error
      if (attempt >= retries) {
        throw error
      }
    } finally {
      merged.cleanup()
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Jellyfin cover art request failed.')
}
