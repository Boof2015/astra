import { randomUUID } from 'node:crypto'
import { PROVIDER_CLIENT_VERSION, buildProviderRequestHeaders } from './providerClientIdentity'
import type { JellyfinCatalogTrack } from './jellyfin'
import type { PlexLibraryChoice } from '../../types/plex'
import type { RemoteCompatibilityCodec, StreamQualityTarget } from '../../types/streamingQuality'
import type { ProviderUserState } from '../../types/providerSync'
import { validProviderValue } from '../../shared/sync/providerState'

const ACCOUNT_API = 'https://clients.plex.tv/api/v2/'
export interface PlexDevice { clientId: string }
export interface PlexAccount extends PlexDevice { token: string; accountId: string; username: string }
export interface PlexConnection { uri: string; local: boolean; relay: boolean }
export interface PlexServer { id: string; name: string; owned: boolean; token: string; connections: PlexConnection[] }
export interface PlexCredentials { account: PlexAccount; server: PlexServer; baseUrl: string }
export type PlexFetch = (url: URL, init: RequestInit) => Promise<Response>
export interface PlexRequestOptions { signal?: AbortSignal; timeoutMs?: number; fetch?: PlexFetch; accountApi?: string }

type PlexConnectionFailure = 'certificate' | 'dns' | 'timeout' | 'network' | 'response' | 'identity'
class PlexConnectionError extends Error {
  readonly reason: PlexConnectionFailure
  constructor(reason: PlexConnectionFailure, message: string) { super(message); this.reason = reason }
}

function networkFailure(error: unknown): PlexConnectionFailure {
  const value = error as { name?: string; message?: string; code?: string; cause?: { code?: string } } | null
  // Read only known error codes; never copy an upstream message or URL into IPC.
  const code = value?.cause?.code ?? value?.code ?? ''
  if (/CERT|ISSUER|SELF_SIGNED|SSL|TLS/.test(code) || /net::ERR_CERT_|net::ERR_SSL_/.test(value?.message ?? '')) return 'certificate'
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code) || /net::ERR_NAME_NOT_RESOLVED/.test(value?.message ?? '')) return 'dns'
  if (value?.name === 'TimeoutError' || /TIMEDOUT|TIMEOUT/.test(code) || /net::ERR_TIMED_OUT/.test(value?.message ?? '')) return 'timeout'
  return 'network'
}

export class PlexRequestError extends Error {
  readonly status: number
  constructor(status: number, message = [401, 498].includes(status)
    ? `Plex rejected authorization (${status}). Sign in to Plex again.`
    : `Plex request failed (${status}).`) { super(message); this.status = status }
}
export function plexHeaders(device: Pick<PlexDevice, 'clientId'>, token?: string): Record<string, string> {
  return { ...buildProviderRequestHeaders(), Accept: 'application/json', 'X-Plex-Client-Identifier': device.clientId,
    'X-Plex-Product': 'Astra', 'X-Plex-Version': PROVIDER_CLIENT_VERSION, 'X-Plex-Platform': process.platform,
    'X-Plex-Device': 'Desktop', 'X-Plex-Device-Name': 'Astra Desktop', ...(token ? { 'X-Plex-Token': token } : {}) }
}
export function plexUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl)
  const url = new URL(path, base)
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin || url.username || url.password
    || [...url.searchParams.keys()].some(key => /^x-plex-token$/i.test(key))) throw new Error('Invalid Plex resource address.')
  return url
}
async function request(url: URL, headers: Record<string, string>, options: PlexRequestOptions, init: RequestInit = {}): Promise<Response> {
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 12000)])
  try {
    const response = await (options.fetch ?? fetch)(url, { ...init, headers: { ...headers, ...init.headers }, signal, redirect: 'error' })
    if (!response.ok) { await response.body?.cancel(); throw new PlexRequestError(response.status) }
    return response
  } catch (error) {
    options.signal?.throwIfAborted()
    if (error instanceof PlexRequestError) throw error
    // Do not expose token-bearing query strings, server responses or private URLs.
    throw new PlexConnectionError(networkFailure(error), 'Could not reach Plex. Check the connection and try again.')
  }
}
async function accountJson(device: PlexDevice, path: string, options: PlexRequestOptions, token?: string, body?: unknown): Promise<any> {
  const response = await request(new URL(path, options.accountApi ?? ACCOUNT_API), plexHeaders(device, token), options,
    body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try { return await response.json() } catch { throw new Error('Plex returned an invalid account response.') }
}
export async function plexJson(credentials: PlexCredentials, path: string, options: PlexRequestOptions = {}, init: RequestInit = {}): Promise<any> {
  const response = await request(plexUrl(credentials.baseUrl, path), plexHeaders(credentials.account, credentials.server.token), options, init)
  try { return await response.json() } catch { throw new PlexConnectionError('response', 'Plex returned an invalid server response.') }
}
/** Playlist mutations may return JSON, text or no content. Never replay them. */
export async function plexWrite(credentials: PlexCredentials, path: string, method: 'PUT' | 'DELETE', options: PlexRequestOptions = {}): Promise<void> {
  const response = await request(plexUrl(credentials.baseUrl, path), plexHeaders(credentials.account, credentials.server.token), options, { method })
  await response.body?.cancel()
}
export function createPlexDevice(): PlexDevice {
  return { clientId: randomUUID() }
}
export async function beginPlexSignIn(device: PlexDevice, options: PlexRequestOptions = {}): Promise<{ pinId: number; url: string; expiresAt: number }> {
  // Use Plex's traditional browser PIN flow. Registering a JWK opts into JWT
  // tokens, including resource tokens that some PMS installations still reject.
  // https://developer.plex.tv/pms/ — Traditional Token Authentication
  const pin = await accountJson(device, 'pins', options, undefined, { strong: true })
  if (!Number.isSafeInteger(pin.id) || typeof pin.code !== 'string' || !pin.code) throw new Error('Plex could not start sign-in.')
  const expiry = Date.parse(pin.expiresAt)
  return { pinId: pin.id, expiresAt: Number.isFinite(expiry) ? expiry : Date.now() + 5 * 60_000,
    url: `https://app.plex.tv/auth#?${new URLSearchParams({ clientID: device.clientId, code: pin.code, 'context[device][product]': 'Astra' })}` }
}
export async function pollPlexSignIn(device: PlexDevice, pinId: number, options: PlexRequestOptions = {}): Promise<PlexAccount | null> {
  const pin = await accountJson(device, `pins/${pinId}`, options)
  if (!pin.authToken) return null
  if (typeof pin.authToken !== 'string') throw new Error('Plex returned an invalid sign-in token.')
  const user = await accountJson(device, 'user', options, pin.authToken)
  if (!user.id || typeof (user.username ?? user.friendlyName) !== 'string') throw new Error('Plex account could not be identified.')
  return { ...device, token: pin.authToken, accountId: String(user.id), username: user.username ?? user.friendlyName }
}
export async function discoverPlexServers(account: PlexAccount, options: PlexRequestOptions = {}): Promise<PlexServer[]> {
  const data = await accountJson(account, 'resources?includeHttps=1&includeRelay=1&includeIPv6=1', options, account.token)
  if (!Array.isArray(data)) throw new Error('Plex returned an invalid server list.')
  return data.filter(item => typeof item.provides === 'string' && item.provides.split(',').includes('server')
    && typeof item.clientIdentifier === 'string' && typeof item.accessToken === 'string' && item.accessToken).map(item => ({
    id: item.clientIdentifier, name: String(item.name || 'Plex server'), owned: item.owned === true || item.owned === 1,
    token: item.accessToken, connections: (Array.isArray(item.connections) ? item.connections : []).flatMap((connection: any) => {
      try {
        const url = plexUrl(connection.uri, connection.uri)
        if (url.search || url.hash) return []
        return [{ uri: url.toString().replace(/\/$/, ''), local: connection.local === true || connection.local === 1,
          relay: connection.relay === true || connection.relay === 1 }]
      } catch { return [] }
    })
  }))
}
export async function connectPlexServer(account: PlexAccount, server: PlexServer, options: PlexRequestOptions = {}): Promise<PlexCredentials> {
  const rank = (c: PlexConnection) => (c.relay ? 8 : 0) + (c.local ? 0 : 2) + (c.uri.startsWith('https:') ? 0 : 1)
  const failures = new Set<PlexConnectionFailure>()
  for (const connection of [...server.connections].sort((a, b) => rank(a) - rank(b))) {
    options.signal?.throwIfAborted()
    try {
      const credentials = { account, server, baseUrl: connection.uri }
      const data = await plexJson(credentials, '/identity', { ...options, timeoutMs: 3000 })
      if (data.MediaContainer?.machineIdentifier === server.id) return credentials
      failures.add('identity')
    } catch (error) {
      if (error instanceof PlexRequestError && [401, 403, 498].includes(error.status)) throw error
      failures.add(error instanceof PlexConnectionError ? error.reason : 'network')
    }
  }
  options.signal?.throwIfAborted()
  if (failures.has('certificate')) throw new Error('Plex could not establish a trusted secure connection. Check the server certificate and this computer’s date and time.')
  if (failures.has('response')) throw new Error('A Plex address responded, but did not return valid server information.')
  if (failures.has('identity')) throw new Error('The responding Plex server did not match the selected server. Refresh the server list and try again.')
  if (failures.has('dns')) throw new Error('Plex server names could not be resolved. Check this computer’s DNS connection.')
  throw new Error('This Plex server is unavailable. Check that it is running and accessible from this computer.')
}
export async function listPlexLibraries(credentials: PlexCredentials, options: PlexRequestOptions = {}): Promise<PlexLibraryChoice[]> {
  const data = await plexJson(credentials, '/library/sections', options)
  if (!Array.isArray(data.MediaContainer?.Directory) && data.MediaContainer?.size !== 0) throw new Error('Plex returned an invalid library list.')
  return (data.MediaContainer.Directory ?? []).filter((item: any) => item.type === 'artist' && /^\d+$/.test(String(item.key)))
    .map((item: any) => ({ id: String(item.key), name: String(item.title || 'Music') }))
}
export function buildPlexTrackPath(sourceId: number, trackId: string): string { return `plex://${sourceId}/${encodeURIComponent(trackId)}` }
export function parsePlexTrackPath(path: string): { sourceId: number; sourceTrackId: string } | null {
  const match = /^plex:\/\/([1-9]\d*)\/(\d+)$/.exec(path)
  return match && Number.isSafeInteger(Number(match[1])) ? { sourceId: Number(match[1]), sourceTrackId: match[2] } : null
}
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const number = (value: unknown): number | null => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
export function mapPlexTrack(sourceId: number, item: any): JellyfinCatalogTrack | null {
  if (item?.type !== 'track' || !/^\d+$/.test(String(item.ratingKey))) return null
  const media = item.Media?.[0], part = media?.Part?.[0]
  const stream = part?.Stream?.find((s: any) => Number(s.streamType) === 2)
  const artist = text(item.originalTitle) ?? text(item.grandparentTitle) ?? 'Unknown Artist'
  const genres = (Array.isArray(item.Genre) ? item.Genre : []).map((g: any) => text(g.tag)).filter(Boolean) as string[]
  return { path: buildPlexTrackPath(sourceId, String(item.ratingKey)), source_track_id: String(item.ratingKey),
    source_path: text(part?.key), artwork_source_id: text(item.thumb) ?? text(item.parentThumb),
    title: text(item.title) ?? 'Unknown Title', artist, artist_names: [artist], album: text(item.parentTitle) ?? 'Unknown Album',
    album_artist: text(item.grandparentTitle), album_artist_names: text(item.grandparentTitle) ? [item.grandparentTitle] : [],
    duration: Math.max(0, (number(item.duration) ?? number(media?.duration) ?? 0) / 1000),
    track_number: number(item.index), disc_number: number(item.parentIndex), year: number(item.parentYear ?? item.year),
    genre: genres[0] ?? null, genres, artwork_hash: null, format: text(media?.container) ?? text(stream?.codec) ?? 'unknown',
    sample_rate: number(stream?.samplingRate), bit_depth: number(stream?.bitDepth), bitrate: number(media?.bitrate),
    channels: number(stream?.channels ?? media?.audioChannels), codec: text(stream?.codec ?? media?.audioCodec), codec_profile: text(stream?.profile),
    is_atmos_joc: null, replaygain_track_gain_db: null, replaygain_album_gain_db: null,
    bpm: null, musical_key: null }
}
export async function fetchPlexCatalog(sourceId: number, credentials: PlexCredentials, libraryId: string,
  options: PlexRequestOptions & { onProgress?: (current: number, total: number | null) => void } = {}): Promise<JellyfinCatalogTrack[]> {
  if (!/^\d+$/.test(libraryId)) throw new Error('Invalid Plex music library.')
  const tracks = new Map<string, JellyfinCatalogTrack>()
  let expectedTotal: number | null = null
  for (let offset = 0; ; ) {
    const data = await plexJson(credentials, `/library/sections/${libraryId}/all?type=10&includeMedia=1&includeGuids=1`, options,
      { headers: { 'X-Plex-Container-Start': String(offset), 'X-Plex-Container-Size': '500' } })
    const container = data.MediaContainer
    if (!container || (!Array.isArray(container.Metadata) && container.size !== 0)) throw new Error('Plex returned an incomplete catalog.')
    const items = container.Metadata ?? []
    if (container.offset !== undefined && Number(container.offset) !== offset) throw new Error('Plex returned an inconsistent catalog page. Try refreshing again.')
    const total = number(container.totalSize)
    if (total !== null) {
      if (!Number.isSafeInteger(total) || total < 0 || (expectedTotal !== null && expectedTotal !== total)) throw new Error('Plex library changed during refresh. Try again.')
      expectedTotal = total
    }
    const previousSize = tracks.size
    for (const item of items) {
      const track = mapPlexTrack(sourceId, item)
      if (!track || tracks.has(track.source_track_id)) throw new Error('Plex returned an inconsistent catalog. Try refreshing again.')
      tracks.set(track.source_track_id, track)
    }
    offset += items.length
    options.onProgress?.(offset, total)
    if (total !== null && offset > total) throw new Error('Plex returned an inconsistent catalog size.')
    if (total !== null && offset === total) break
    if (total !== null && !items.length) throw new Error('Plex returned an incomplete catalog.')
    if (!items.length || (total === null && container.offset === undefined)) break
    if (tracks.size === previousSize || offset > 2_000_000) throw new Error('Plex catalog pagination did not advance.')
  }
  return [...tracks.values()]
}
/** Plex likes share userRating; never synthesize an independent favorite flag. */
export async function fetchPlexUserStates(credentials: PlexCredentials, libraryId: string,
  options: PlexRequestOptions = {}, ids?: string[]): Promise<Map<string, ProviderUserState>> {
  if (!/^\d+$/.test(libraryId) || ids?.some(id => !/^\d+$/.test(id))) throw new Error('Invalid Plex music selection.')
  const result = new Map<string, ProviderUserState>()
  const add = (item: any) => {
    if (item?.type !== 'track' || !/^\d+$/.test(String(item.ratingKey)) || result.has(String(item.ratingKey))) {
      throw new Error('Plex returned an inconsistent rating listing.')
    }
    // A moved track is unavailable in the selected library, not newly unrated.
    if (item.librarySectionID != null && String(item.librarySectionID) !== libraryId) return
    const raw = item.userRating
    const rating = raw == null || raw === 0 ? null : typeof raw === 'number' ? raw / 2 : NaN
    if (!validProviderValue('rating', rating, 'plex')) throw new Error('Plex returned an unsupported rating.')
    result.set(String(item.ratingKey), { rating })
  }
  if (ids) {
    for (const id of new Set(ids)) {
      options.signal?.throwIfAborted()
      let data: any
      try { data = await plexJson(credentials, `/library/metadata/${id}`, options) }
      catch (error) {
        if (error instanceof PlexRequestError && error.status === 404) continue
        throw error
      }
      const items = data.MediaContainer?.Metadata
      if (!Array.isArray(items) || items.length !== 1 || String(items[0]?.ratingKey) !== id) {
        throw new Error('Plex did not return the requested track rating.')
      }
      add(items[0])
    }
    return result
  }
  let expectedTotal: number | null = null
  const seen = new Set<string>()
  for (let offset = 0; ; ) {
    options.signal?.throwIfAborted()
    const data = await plexJson(credentials, `/library/sections/${libraryId}/all?type=10`, options,
      { headers: { 'X-Plex-Container-Start': String(offset), 'X-Plex-Container-Size': '500' } })
    const container = data.MediaContainer
    if (!container || (!Array.isArray(container.Metadata) && container.size !== 0)) throw new Error('Plex returned an incomplete rating listing.')
    const items = container.Metadata ?? []
    if (container.offset !== undefined && Number(container.offset) !== offset) throw new Error('Plex returned an inconsistent rating page.')
    const total = number(container.totalSize)
    if (total !== null) {
      if (!Number.isSafeInteger(total) || total < 0 || (expectedTotal !== null && expectedTotal !== total)) throw new Error('Plex library changed during rating sync. Try again.')
      expectedTotal = total
    }
    for (const item of items) {
      const id = String(item?.ratingKey)
      if (seen.has(id)) throw new Error('Plex returned a repeated rating page.')
      seen.add(id)
      add(item)
    }
    offset += items.length
    if (offset > 2_000_000 || (expectedTotal !== null && offset > expectedTotal)) throw new Error('Plex returned an inconsistent rating count.')
    if (expectedTotal !== null && offset === expectedTotal) break
    if (!items.length) {
      if (expectedTotal !== null) throw new Error('Plex returned an incomplete rating listing.')
      break
    }
  }
  return result
}

export async function writePlexRating(credentials: PlexCredentials, id: string, rating: number | null,
  options: PlexRequestOptions = {}): Promise<void> {
  if (!/^\d+$/.test(id) || !validProviderValue('rating', rating, 'plex')) throw new Error('Invalid Plex rating.')
  const url = plexUrl(credentials.baseUrl, '/:/rate')
  url.searchParams.set('identifier', 'com.plexapp.plugins.library')
  url.searchParams.set('key', id)
  url.searchParams.set('rating', String(rating === null ? 0 : rating * 2))
  const response = await request(url, plexHeaders(credentials.account, credentials.server.token), options, { method: 'PUT' })
  // Successful rating writes can have an empty body. The sync service reads back
  // the value before acknowledging it locally or advancing the baseline.
  await response.body?.cancel()
}

export async function fetchPlexArtwork(credentials: PlexCredentials, path: string, options: PlexRequestOptions = {}): Promise<Buffer> {
  if (!/^\/library\/metadata\/\d+\/(?:thumb|art)\//.test(path)) throw new Error('Invalid Plex artwork path.')
  const response = await request(plexUrl(credentials.baseUrl, path), plexHeaders(credentials.account, credentials.server.token), options)
  if (!response.headers.get('content-type')?.startsWith('image/')) { await response.body?.cancel(); throw new Error('Plex returned invalid artwork.') }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > 20 * 1024 ** 2) throw new Error('Plex artwork is too large.')
  return bytes
}
export function buildPlexTranscodeUrl(credentials: PlexCredentials, trackId: string, target: StreamQualityTarget,
  codec: RemoteCompatibilityCodec, sessionId: string): URL {
  if (!/^\d+$/.test(trackId)) throw new Error('Invalid Plex track.')
  const container = codec === 'opus' ? 'ogg' : codec
  const url = plexUrl(credentials.baseUrl, `/music/:/transcode/universal/start.${container}`)
  const params: Record<string, string> = { path: `/library/metadata/${trackId}`, protocol: 'http', offset: '0',
    directPlay: '0', directStream: '0', directStreamAudio: '0', mediaIndex: '0', partIndex: '0',
    transcodeSessionId: sessionId, 'X-Plex-Session-Identifier': sessionId, 'X-Plex-Client-Profile-Name': 'Generic',
    'X-Plex-Client-Profile-Extra': `add-transcode-target(type=musicProfile&context=streaming&protocol=http&container=${container}&audioCodec=${codec}&replace=true)`,
    audioBoost: '100', normalizeLoudness: '0', ...(codec === 'flac' ? {} : { musicBitrate: String(target === 'original' ? 320 : target), audioChannelCount: '2' }) }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url
}

export async function reportPlexPlayback(credentials: PlexCredentials, trackId: string,
  report: { sessionId: string; state: string; position: number; duration: number }, options: PlexRequestOptions = {}): Promise<void> {
  const url = plexUrl(credentials.baseUrl, '/:/timeline')
  for (const [key, value] of Object.entries({ ratingKey: trackId, key: `/library/metadata/${trackId}`,
    state: report.state === 'loading' ? 'buffering' : report.state, time: Math.round(report.position * 1000),
    duration: Math.round(report.duration * 1000) })) url.searchParams.set(key, String(value))
  const response = await request(url, { ...plexHeaders(credentials.account, credentials.server.token),
    'X-Plex-Session-Identifier': report.sessionId }, options, { method: 'POST' })
  await response.body?.cancel()
}
