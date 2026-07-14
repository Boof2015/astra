import type { IncomingMessage, ServerResponse } from 'http'
import type {
  CompanionApiLibraryEvent,
  CompanionApiPlaybackAction,
  CompanionApiPlaybackSnapshot,
  CompanionApiQueueSnapshot,
  CompanionApiRendererCommand,
  CompanionApiScope,
  CompanionApiSearchResponse,
  CompanionApiTargetType,
  CompanionApiTransport
} from '../../types/companionApi'
import {
  COMPANION_API_DEFAULT_POSITION_INTERVAL_MS,
  COMPANION_API_DEFAULT_SEARCH_LIMIT,
  COMPANION_API_MAX_MUTATION_REFS,
  COMPANION_API_MAX_POSITION_INTERVAL_MS,
  COMPANION_API_MAX_SEARCH_LIMIT,
  COMPANION_API_MIN_POSITION_INTERVAL_MS,
  COMPANION_API_VERSION
} from '../../types/companionApi'

const MAX_SSE_CLIENTS = 8
const MAX_BODY_BYTES = 64 * 1024
const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_ARTWORK_BYTES = 2 * 1024 * 1024
const MAX_QUERY_LENGTH = 200
const MAX_NAME_LENGTH = 200
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 120
const SSE_HEARTBEAT_INTERVAL_MS = 20_000

const CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
const CORS_ALLOW_HEADERS = 'Authorization, Content-Type'
const CORS_MAX_AGE_SECONDS = 600

type CompanionApiEventTopic = 'playback' | 'queue' | 'favorite' | 'playlist'

export interface CompanionApiSession {
  id: string
  scopes: ReadonlySet<CompanionApiScope>
}

export interface CompanionApiResolvedTarget {
  type: CompanionApiTargetType
  ref: string
  trackPaths: string[]
  openTarget: Extract<CompanionApiRendererCommand, { type: 'open-target' }>['target']
}

interface CompanionApiSseClient {
  response: ServerResponse<IncomingMessage>
  topics: ReadonlySet<CompanionApiEventTopic>
  positionIntervalMs: number
  lastPlaybackSentAt: number
  lastPlaybackFingerprint: string
}

interface RateLimitState {
  count: number
  windowStartedAt: number
}

export interface CompanionApiV2Options {
  transport: CompanionApiTransport
  authenticateRequest: (req: IncomingMessage) => CompanionApiSession | null
  getPlayback: () => CompanionApiPlaybackSnapshot
  getQueue: () => CompanionApiQueueSnapshot
  search: (
    query: string,
    types: ReadonlySet<CompanionApiTargetType>,
    limit: number
  ) => Promise<CompanionApiSearchResponse> | CompanionApiSearchResponse
  resolveTarget: (ref: string, expectedType?: CompanionApiTargetType) => CompanionApiResolvedTarget | null
  dispatchRendererCommand: (command: CompanionApiRendererCommand) => boolean
  resolveArtworkDataUrl: (ref: string) => Promise<string | null>
  setFavorite: (trackRef: string, favorite: boolean) => Promise<boolean>
  createPlaylist: (name: string) => Promise<{ ref: string; title: string } | null>
  renamePlaylist: (playlistRef: string, name: string) => Promise<boolean>
  addPlaylistItems: (playlistRef: string, trackRefs: string[]) => Promise<boolean>
  removePlaylistItem: (playlistRef: string, trackRef: string) => Promise<boolean>
  movePlaylistItem: (playlistRef: string, trackRef: string, position: number) => Promise<boolean>
  getOpenApiDocument: () => unknown
  onConnectedClientsChange?: () => void
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function normalizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) return null
  return normalized
}

function decodePathPart(value: string, maxLength: number = 2_048): string | null {
  try {
    const decoded = decodeURIComponent(value)
    return decoded.length > 0 && decoded.length <= maxLength ? decoded : null
  } catch {
    return null
  }
}

function playbackFingerprint(snapshot: CompanionApiPlaybackSnapshot): string {
  return JSON.stringify({
    state: snapshot.state,
    durationSeconds: snapshot.durationSeconds,
    volume: snapshot.volume,
    muted: snapshot.muted,
    shuffle: snapshot.shuffle,
    repeat: snapshot.repeat,
    outputDeviceLabel: snapshot.outputDeviceLabel,
    queueCount: snapshot.queueCount,
    currentTrack: snapshot.currentTrack
  })
}

function parseArtworkDataUrl(value: string): { mimeType: string; bytes: Buffer } | null {
  const match = /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value.trim())
  if (!match) return null
  const payload = match[2].replace(/\s+/g, '')
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null
  const bytes = Buffer.from(payload, 'base64')
  const mimeType = match[1].toLowerCase()
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return null
  if (!bytes.length || bytes.length > MAX_ARTWORK_BYTES) return null
  if (bytes.toString('base64') !== payload) return null
  return { mimeType, bytes }
}

function parseTargetTypes(value: string | null): ReadonlySet<CompanionApiTargetType> | null {
  const allTypes: CompanionApiTargetType[] = ['track', 'album', 'artist', 'playlist']
  if (!value) return new Set(allTypes)
  const parsed = new Set<CompanionApiTargetType>()
  for (const rawType of value.split(',')) {
    const type = rawType.trim()
    if (!allTypes.includes(type as CompanionApiTargetType)) return null
    parsed.add(type as CompanionApiTargetType)
  }
  return parsed.size > 0 ? parsed : null
}

function parseEventTopics(value: string | null): Set<CompanionApiEventTopic> | null {
  const allTopics: CompanionApiEventTopic[] = ['playback', 'queue', 'favorite', 'playlist']
  if (!value) return new Set(allTopics)
  const parsed = new Set<CompanionApiEventTopic>()
  for (const rawTopic of value.split(',')) {
    const topic = rawTopic.trim()
    if (!allTopics.includes(topic as CompanionApiEventTopic)) return null
    parsed.add(topic as CompanionApiEventTopic)
  }
  return parsed.size > 0 ? parsed : null
}

export class CompanionApiV2 {
  private readonly options: CompanionApiV2Options
  private readonly sseClients = new Set<CompanionApiSseClient>()
  private readonly rateLimits = new Map<string, RateLimitState>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: CompanionApiV2Options) {
    this.options = options
  }

  getConnectedClientCount(): number {
    return this.sseClients.size
  }

  startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.sseClients) {
        try {
          client.response.write(': heartbeat\n\n')
        } catch {
          this.sseClients.delete(client)
        }
      }
    }, SSE_HEARTBEAT_INTERVAL_MS)
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  closeAllSseClients(): void {
    let changed = false
    for (const client of this.sseClients) {
      try {
        client.response.end()
      } catch {
        // Ignore shutdown failures.
      }
      changed = this.sseClients.delete(client) || changed
    }
    if (changed) this.options.onConnectedClientsChange?.()
  }

  publishPlayback(snapshot: CompanionApiPlaybackSnapshot): void {
    const now = Date.now()
    const fingerprint = playbackFingerprint(snapshot)
    for (const client of this.sseClients) {
      if (!client.topics.has('playback')) continue
      const discreteChanged = fingerprint !== client.lastPlaybackFingerprint
      if (!discreteChanged && now - client.lastPlaybackSentAt < client.positionIntervalMs) continue
      if (this.writeSse(client, 'playback', snapshot)) {
        client.lastPlaybackSentAt = now
        client.lastPlaybackFingerprint = fingerprint
      }
    }
  }

  publishCurrentPlayback(): void {
    this.publishPlayback(this.options.getPlayback())
  }

  publishQueue(snapshot: CompanionApiQueueSnapshot): void {
    this.broadcastTopic('queue', snapshot)
  }

  publishCurrentQueue(): void {
    this.publishQueue(this.options.getQueue())
  }

  publishLibraryEvent(event: CompanionApiLibraryEvent): void {
    this.broadcastTopic(event.kind, event)
  }

  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    requestUrl: URL
  ): Promise<boolean> {
    const path = requestUrl.pathname
    if (path !== '/v2' && !path.startsWith('/v2/')) return false

    try {
      return await this.handleV2Request(req, res, requestUrl)
    } catch (error) {
      console.error('Companion API request failed:', error)
      if (!res.headersSent) {
        this.respondError(res, 500, 'internal_error', 'The request could not be completed.')
      } else if (!res.writableEnded) {
        res.destroy()
      }
      return true
    }
  }

  private async handleV2Request(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    requestUrl: URL
  ): Promise<boolean> {
    const path = requestUrl.pathname

    this.applyCorsHeaders(res)
    const method = req.method ?? 'GET'
    if (method === 'OPTIONS') {
      this.respondCorsPreflight(res)
      return true
    }

    if (method === 'GET' && path === '/v2/openapi.json') {
      this.respondJson(res, 200, this.options.getOpenApiDocument())
      return true
    }

    const session = this.options.authenticateRequest(req)
    if (!session) {
      this.respondError(res, 401, 'unauthorized', 'A valid bearer token is required.')
      return true
    }
    if (!this.checkRateLimit(session.id)) {
      this.respondError(res, 429, 'rate_limit_exceeded', 'The API rate limit has been exceeded.')
      return true
    }

    if (method === 'GET' && path === '/v2/capabilities') {
      this.respondJson(res, 200, this.buildCapabilities(session))
      return true
    }

    if (method === 'GET' && path === '/v2/playback') {
      if (!this.requireScope(res, session, 'observe')) return true
      this.respondJson(res, 200, this.options.getPlayback())
      return true
    }

    if (method === 'POST' && path === '/v2/playback/actions') {
      if (!this.requireScope(res, session, 'playback-control')) return true
      await this.handlePlaybackAction(req, res)
      return true
    }

    if (method === 'GET' && path === '/v2/events') {
      if (!this.requireScope(res, session, 'observe')) return true
      this.handleEvents(req, res, requestUrl, session)
      return true
    }

    if (method === 'GET' && path === '/v2/search') {
      if (!this.requireScope(res, session, 'library-search')) return true
      await this.handleSearch(res, requestUrl)
      return true
    }

    if (method === 'POST' && path === '/v2/intents') {
      await this.handleIntent(req, res, session)
      return true
    }

    if (method === 'GET' && path === '/v2/queue') {
      if (!this.requireScope(res, session, 'observe')) return true
      this.respondJson(res, 200, this.options.getQueue())
      return true
    }

    const queueItemMatch = /^\/v2\/queue\/items\/([^/]+)$/.exec(path)
    if (queueItemMatch && method === 'PATCH') {
      if (!this.requireScope(res, session, 'playback-control')) return true
      const queueItemId = decodePathPart(queueItemMatch[1], 512)
      if (!queueItemId) {
        this.respondError(res, 400, 'invalid_queue_item_id', 'The queue item id is invalid.')
        return true
      }
      await this.handleMoveQueueItem(req, res, queueItemId)
      return true
    }
    if (queueItemMatch && method === 'DELETE') {
      if (!this.requireScope(res, session, 'playback-control')) return true
      const queueItemId = decodePathPart(queueItemMatch[1], 512)
      if (!queueItemId) {
        this.respondError(res, 400, 'invalid_queue_item_id', 'The queue item id is invalid.')
        return true
      }
      this.handleRemoveQueueItem(res, queueItemId)
      return true
    }
    if (method === 'DELETE' && path === '/v2/queue') {
      if (!this.requireScope(res, session, 'playback-control')) return true
      this.dispatchOrUnavailable(res, { type: 'clear-upcoming-queue' })
      return true
    }

    const artworkMatch = /^\/v2\/artwork\/([^/]+)$/.exec(path)
    if (artworkMatch && method === 'GET') {
      if (!this.requireScope(res, session, 'observe')) return true
      const ref = decodePathPart(artworkMatch[1])
      if (!ref) {
        this.respondError(res, 400, 'invalid_reference', 'The target reference is invalid.')
        return true
      }
      await this.handleArtwork(res, ref)
      return true
    }

    const favoriteMatch = /^\/v2\/tracks\/([^/]+)\/favorite$/.exec(path)
    if (favoriteMatch && method === 'PUT') {
      if (!this.requireScope(res, session, 'library-write')) return true
      const trackRef = decodePathPart(favoriteMatch[1])
      if (!trackRef) {
        this.respondError(res, 400, 'invalid_reference', 'The track reference is invalid.')
        return true
      }
      await this.handleFavorite(req, res, trackRef)
      return true
    }

    if (method === 'POST' && path === '/v2/playlists') {
      if (!this.requireScope(res, session, 'library-write')) return true
      await this.handleCreatePlaylist(req, res)
      return true
    }

    const playlistItemMatch = /^\/v2\/playlists\/([^/]+)\/items\/([^/]+)$/.exec(path)
    if (playlistItemMatch && method === 'DELETE') {
      if (!this.requireScope(res, session, 'library-write')) return true
      const playlistRef = decodePathPart(playlistItemMatch[1])
      const trackRef = decodePathPart(playlistItemMatch[2])
      if (!playlistRef || !trackRef) {
        this.respondError(res, 400, 'invalid_reference', 'A playlist or track reference is invalid.')
        return true
      }
      await this.handleRemovePlaylistItem(
        res,
        playlistRef,
        trackRef
      )
      return true
    }
    if (playlistItemMatch && method === 'PATCH') {
      if (!this.requireScope(res, session, 'library-write')) return true
      const playlistRef = decodePathPart(playlistItemMatch[1])
      const trackRef = decodePathPart(playlistItemMatch[2])
      if (!playlistRef || !trackRef) {
        this.respondError(res, 400, 'invalid_reference', 'A playlist or track reference is invalid.')
        return true
      }
      await this.handleMovePlaylistItem(
        req,
        res,
        playlistRef,
        trackRef
      )
      return true
    }

    const playlistItemsMatch = /^\/v2\/playlists\/([^/]+)\/items$/.exec(path)
    if (playlistItemsMatch && method === 'POST') {
      if (!this.requireScope(res, session, 'library-write')) return true
      const playlistRef = decodePathPart(playlistItemsMatch[1])
      if (!playlistRef) {
        this.respondError(res, 400, 'invalid_reference', 'The playlist reference is invalid.')
        return true
      }
      await this.handleAddPlaylistItems(req, res, playlistRef)
      return true
    }

    const playlistMatch = /^\/v2\/playlists\/([^/]+)$/.exec(path)
    if (playlistMatch && method === 'PATCH') {
      if (!this.requireScope(res, session, 'library-write')) return true
      const playlistRef = decodePathPart(playlistMatch[1])
      if (!playlistRef) {
        this.respondError(res, 400, 'invalid_reference', 'The playlist reference is invalid.')
        return true
      }
      await this.handleRenamePlaylist(req, res, playlistRef)
      return true
    }

    this.respondError(res, 404, 'not_found', 'The requested API resource was not found.')
    return true
  }

  private buildCapabilities(session: CompanionApiSession): unknown {
    return {
      apiVersion: COMPANION_API_VERSION,
      transport: this.options.transport,
      grantedScopes: Array.from(session.scopes).sort(),
      features: {
        playback: true,
        events: true,
        boundedSearch: true,
        intents: true,
        queueEditing: true,
        favorites: true,
        normalPlaylistEditing: true,
        playlistDeletion: false,
        dynamicPlaylistAuthoring: false,
        audioStreaming: false
      },
      limits: {
        searchDefault: COMPANION_API_DEFAULT_SEARCH_LIMIT,
        searchMaximum: COMPANION_API_MAX_SEARCH_LIMIT,
        mutationReferencesMaximum: COMPANION_API_MAX_MUTATION_REFS,
        eventStreamsMaximum: MAX_SSE_CLIENTS,
        positionIntervalMinimumMs: COMPANION_API_MIN_POSITION_INTERVAL_MS,
        positionIntervalMaximumMs: COMPANION_API_MAX_POSITION_INTERVAL_MS
      }
    }
  }

  private async handlePlaybackAction(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    const body = await this.readJsonBody(req, res)
    if (body === null) return
    const action = this.parsePlaybackAction(body)
    if (!action) {
      this.respondError(res, 400, 'invalid_playback_action', 'The playback action is invalid.')
      return
    }
    this.dispatchOrUnavailable(res, { type: 'playback-action', action })
  }

  private handleEvents(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    requestUrl: URL,
    session: CompanionApiSession
  ): void {
    if (this.sseClients.size >= MAX_SSE_CLIENTS) {
      this.respondError(res, 503, 'event_stream_limit', 'Too many event streams are already connected.')
      return
    }
    const topics = parseEventTopics(requestUrl.searchParams.get('topics'))
    if (!topics) {
      this.respondError(res, 400, 'invalid_topics', 'One or more event topics are invalid.')
      return
    }
    if (!session.scopes.has('library-search')) {
      topics.delete('favorite')
      topics.delete('playlist')
    }
    const rawInterval = Number(requestUrl.searchParams.get('positionIntervalMs'))
    const positionIntervalMs = Number.isFinite(rawInterval) && rawInterval > 0
      ? clampNumber(Math.floor(rawInterval), COMPANION_API_MIN_POSITION_INTERVAL_MS, COMPANION_API_MAX_POSITION_INTERVAL_MS)
      : COMPANION_API_DEFAULT_POSITION_INTERVAL_MS

    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    res.write(': connected\n\n')

    const playback = this.options.getPlayback()
    const client: CompanionApiSseClient = {
      response: res,
      topics,
      positionIntervalMs,
      lastPlaybackSentAt: Date.now(),
      lastPlaybackFingerprint: playbackFingerprint(playback)
    }
    this.sseClients.add(client)
    this.options.onConnectedClientsChange?.()
    this.writeSse(client, 'capabilities', this.buildCapabilities(session))
    if (topics.has('playback')) this.writeSse(client, 'playback', playback)
    if (topics.has('queue')) this.writeSse(client, 'queue', this.options.getQueue())

    const cleanup = () => {
      if (this.sseClients.delete(client)) this.options.onConnectedClientsChange?.()
    }
    req.on('close', cleanup)
    req.on('aborted', cleanup)
  }

  private async handleSearch(res: ServerResponse<IncomingMessage>, requestUrl: URL): Promise<void> {
    const query = normalizeText(requestUrl.searchParams.get('q'), MAX_QUERY_LENGTH)
    if (!query) {
      this.respondError(res, 400, 'invalid_query', 'Search requires a non-empty q parameter of at most 200 characters.')
      return
    }
    const types = parseTargetTypes(requestUrl.searchParams.get('types'))
    if (!types) {
      this.respondError(res, 400, 'invalid_types', 'One or more search target types are invalid.')
      return
    }
    const rawLimit = Number(requestUrl.searchParams.get('limit'))
    const limit = Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, COMPANION_API_MAX_SEARCH_LIMIT)
      : COMPANION_API_DEFAULT_SEARCH_LIMIT
    const response = await this.options.search(query, types, limit)
    this.respondJson(res, 200, response)
  }

  private async handleIntent(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    session: CompanionApiSession
  ): Promise<void> {
    const body = await this.readJsonBody(req, res)
    if (body === null) return
    const action = body.action
    if (action !== 'open' && action !== 'play' && action !== 'enqueue') {
      this.respondError(res, 400, 'invalid_intent', 'Intent action must be open, play, or enqueue.')
      return
    }
    if (action === 'open') {
      if (!this.requireScope(res, session, 'library-search')) return
    } else if (!this.requireScope(res, session, 'playback-control')) {
      return
    }
    const targetRef = normalizeText(body.targetRef, 2_048)
    if (!targetRef) {
      this.respondError(res, 400, 'invalid_reference', 'A valid targetRef is required.')
      return
    }
    const target = this.options.resolveTarget(targetRef)
    if (!target) {
      this.respondError(res, 404, 'target_not_found', 'The referenced target no longer exists.')
      return
    }
    if (action !== 'open' && target.trackPaths.length === 0) {
      this.respondError(res, 409, 'target_not_playable', 'The referenced target has no playable tracks.')
      return
    }

    let command: CompanionApiRendererCommand
    if (action === 'open') {
      command = { type: 'open-target', target: target.openTarget }
    } else if (action === 'play') {
      command = {
        type: 'play-paths',
        trackPaths: target.trackPaths,
        contextLabel: `API ${target.type}`
      }
    } else {
      command = {
        type: 'enqueue-paths',
        trackPaths: target.trackPaths,
        position: body.position === 'next' ? 'next' : 'end'
      }
    }
    if (!this.options.dispatchRendererCommand(command)) {
      this.respondError(res, 503, 'renderer_unavailable', 'Astra is not ready to execute the intent.')
      return
    }
    this.respondJson(res, 202, { accepted: true, action, targetRef: target.ref })
  }

  private async handleMoveQueueItem(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    queueItemId: string
  ): Promise<void> {
    const item = this.options.getQueue().items.find((candidate) => candidate.id === queueItemId && !candidate.current)
    if (!item) {
      this.respondError(res, 404, 'queue_item_not_found', 'The upcoming queue item was not found.')
      return
    }
    const body = await this.readJsonBody(req, res)
    if (body === null) return
    const position = Number(body.position)
    if (!Number.isInteger(position) || position < 0) {
      this.respondError(res, 400, 'invalid_position', 'Queue position must be a non-negative integer.')
      return
    }
    this.dispatchOrUnavailable(res, { type: 'move-queue-item', queueItemId, position })
  }

  private handleRemoveQueueItem(res: ServerResponse<IncomingMessage>, queueItemId: string): void {
    const item = this.options.getQueue().items.find((candidate) => candidate.id === queueItemId && !candidate.current)
    if (!item) {
      this.respondError(res, 404, 'queue_item_not_found', 'The upcoming queue item was not found.')
      return
    }
    this.dispatchOrUnavailable(res, { type: 'remove-queue-item', queueItemId })
  }

  private async handleArtwork(res: ServerResponse<IncomingMessage>, ref: string): Promise<void> {
    if (!this.options.resolveTarget(ref)) {
      this.respondError(res, 404, 'target_not_found', 'The referenced target no longer exists.')
      return
    }
    const dataUrl = await this.options.resolveArtworkDataUrl(ref).catch(() => null)
    const artwork = dataUrl ? parseArtworkDataUrl(dataUrl) : null
    if (!artwork) {
      this.respondError(res, 404, 'artwork_not_found', 'Artwork is not available for the referenced target.')
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', artwork.mimeType)
    res.setHeader('Content-Length', String(artwork.bytes.length))
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.end(artwork.bytes)
  }

  private async handleFavorite(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    trackRef: string
  ): Promise<void> {
    if (!this.options.resolveTarget(trackRef, 'track')) {
      this.respondError(res, 404, 'track_not_found', 'The referenced track no longer exists.')
      return
    }
    const body = await this.readJsonBody(req, res)
    if (body === null) return
    if (typeof body.favorite !== 'boolean') {
      this.respondError(res, 400, 'invalid_favorite', 'favorite must be a boolean.')
      return
    }
    const updated = await this.options.setFavorite(trackRef, body.favorite)
    if (!updated) {
      this.respondError(res, 409, 'favorite_not_updated', 'The favorite state could not be updated.')
      return
    }
    this.respondJson(res, 200, { ref: trackRef, favorite: body.favorite })
  }

  private async handleCreatePlaylist(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    const body = await this.readJsonBody(req, res)
    if (body === null) return
    const name = normalizeText(body.name, MAX_NAME_LENGTH)
    if (!name) {
      this.respondError(res, 400, 'invalid_playlist_name', 'Playlist name must contain 1 to 200 characters.')
      return
    }
    const playlist = await this.options.createPlaylist(name)
    if (!playlist) {
      this.respondError(res, 409, 'playlist_not_created', 'The playlist could not be created.')
      return
    }
    this.respondJson(res, 201, { type: 'playlist', ref: playlist.ref, title: playlist.title })
  }

  private async handleRenamePlaylist(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    playlistRef: string
  ): Promise<void> {
    const body = await this.readJsonBody(req, res)
    if (body === null) return
    const name = normalizeText(body.name, MAX_NAME_LENGTH)
    if (!name) {
      this.respondError(res, 400, 'invalid_playlist_name', 'Playlist name must contain 1 to 200 characters.')
      return
    }
    const updated = await this.options.renamePlaylist(playlistRef, name)
    if (!updated) {
      this.respondError(res, 404, 'playlist_not_writable', 'The playlist does not exist or is not a writable local playlist.')
      return
    }
    this.respondJson(res, 200, { ref: playlistRef, title: name })
  }

  private async handleAddPlaylistItems(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    playlistRef: string
  ): Promise<void> {
    const body = await this.readJsonBody(req, res)
    if (body === null) return
    if (!Array.isArray(body.trackRefs) || body.trackRefs.length === 0 || body.trackRefs.length > COMPANION_API_MAX_MUTATION_REFS) {
      this.respondError(res, 400, 'invalid_track_references', 'trackRefs must contain between 1 and 100 track references.')
      return
    }
    const trackRefs = body.trackRefs.filter((value): value is string => typeof value === 'string')
    if (trackRefs.length !== body.trackRefs.length || trackRefs.some((ref) => !this.options.resolveTarget(ref, 'track'))) {
      this.respondError(res, 400, 'invalid_track_references', 'One or more track references are invalid.')
      return
    }
    const updated = await this.options.addPlaylistItems(playlistRef, trackRefs)
    if (!updated) {
      this.respondError(res, 404, 'playlist_not_writable', 'The playlist does not exist or is not a writable local playlist.')
      return
    }
    this.respondJson(res, 200, { ref: playlistRef, added: trackRefs.length })
  }

  private async handleRemovePlaylistItem(
    res: ServerResponse<IncomingMessage>,
    playlistRef: string,
    trackRef: string
  ): Promise<void> {
    if (!this.options.resolveTarget(trackRef, 'track')) {
      this.respondError(res, 404, 'track_not_found', 'The referenced track no longer exists.')
      return
    }
    const updated = await this.options.removePlaylistItem(playlistRef, trackRef)
    if (!updated) {
      this.respondError(res, 404, 'playlist_not_writable', 'The playlist does not exist or is not a writable local playlist.')
      return
    }
    this.respondJson(res, 200, { ref: playlistRef, removed: trackRef })
  }

  private async handleMovePlaylistItem(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    playlistRef: string,
    trackRef: string
  ): Promise<void> {
    if (!this.options.resolveTarget(trackRef, 'track')) {
      this.respondError(res, 404, 'track_not_found', 'The referenced track no longer exists.')
      return
    }
    const body = await this.readJsonBody(req, res)
    if (body === null) return
    const position = Number(body.position)
    if (!Number.isInteger(position) || position < 0) {
      this.respondError(res, 400, 'invalid_position', 'Playlist position must be a non-negative integer.')
      return
    }
    const updated = await this.options.movePlaylistItem(playlistRef, trackRef, position)
    if (!updated) {
      this.respondError(res, 404, 'playlist_not_writable', 'The playlist does not exist or is not a writable local playlist.')
      return
    }
    this.respondJson(res, 200, { ref: playlistRef, moved: trackRef, position })
  }

  private parsePlaybackAction(body: Record<string, unknown>): CompanionApiPlaybackAction | null {
    switch (body.action) {
      case 'play':
      case 'pause':
      case 'stop':
      case 'next':
      case 'previous':
        return { action: body.action }
      case 'seek': {
        const positionSeconds = Number(body.positionSeconds)
        if (!Number.isFinite(positionSeconds) || positionSeconds < 0) return null
        return { action: 'seek', positionSeconds }
      }
      case 'set-volume': {
        const volume = Number(body.volume)
        if (!Number.isFinite(volume) || volume < 0 || volume > 1) return null
        return { action: 'set-volume', volume }
      }
      case 'set-muted':
        return typeof body.muted === 'boolean' ? { action: 'set-muted', muted: body.muted } : null
      case 'set-shuffle':
        return typeof body.enabled === 'boolean' ? { action: 'set-shuffle', enabled: body.enabled } : null
      case 'set-repeat':
        return body.mode === 'none' || body.mode === 'one' || body.mode === 'all'
          ? { action: 'set-repeat', mode: body.mode }
          : null
      default:
        return null
    }
  }

  private dispatchOrUnavailable(res: ServerResponse<IncomingMessage>, command: CompanionApiRendererCommand): void {
    if (!this.options.dispatchRendererCommand(command)) {
      this.respondError(res, 503, 'renderer_unavailable', 'Astra is not ready to execute the command.')
      return
    }
    this.respondJson(res, 202, { accepted: true })
  }

  private requireScope(
    res: ServerResponse<IncomingMessage>,
    session: CompanionApiSession,
    scope: CompanionApiScope
  ): boolean {
    if (session.scopes.has(scope)) return true
    this.respondError(res, 403, 'insufficient_scope', `The ${scope} scope is required.`)
    return false
  }

  private checkRateLimit(sessionId: string): boolean {
    const now = Date.now()
    const current = this.rateLimits.get(sessionId)
    if (!current || now - current.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
      this.rateLimits.set(sessionId, { count: 1, windowStartedAt: now })
      return true
    }
    current.count += 1
    return current.count <= RATE_LIMIT_MAX_REQUESTS
  }

  private async readJsonBody(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>
  ): Promise<Record<string, unknown> | null> {
    const rawBody = await this.readRequestBody(req, MAX_BODY_BYTES).catch(() => undefined)
    if (rawBody === null) {
      this.respondError(res, 413, 'body_too_large', 'The request body exceeds 64 KiB.')
      return null
    }
    if (rawBody === undefined) {
      this.respondError(res, 400, 'body_read_failed', 'The request body could not be read.')
      return null
    }
    try {
      const parsed = JSON.parse(rawBody)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
      return parsed as Record<string, unknown>
    } catch {
      this.respondError(res, 400, 'invalid_json', 'The request body must be a JSON object.')
      return null
    }
  }

  private async readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let bytes = 0
      let tooLarge = false
      req.on('data', (chunk: Buffer | string) => {
        const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += normalized.length
        if (bytes > maxBytes) {
          tooLarge = true
          return
        }
        chunks.push(normalized)
      })
      req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  private applyCorsHeaders(res: ServerResponse<IncomingMessage>): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }

  private respondCorsPreflight(res: ServerResponse<IncomingMessage>): void {
    res.statusCode = 204
    res.setHeader('Access-Control-Allow-Methods', CORS_ALLOW_METHODS)
    res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS)
    res.setHeader('Access-Control-Max-Age', String(CORS_MAX_AGE_SECONDS))
    res.end()
  }

  private respondError(
    res: ServerResponse<IncomingMessage>,
    statusCode: number,
    code: string,
    message: string
  ): void {
    this.respondJson(res, statusCode, { error: { code, message } })
  }

  private respondJson(res: ServerResponse<IncomingMessage>, statusCode: number, body: unknown): void {
    let encoded = Buffer.from(JSON.stringify(body), 'utf8')
    if (encoded.byteLength > MAX_JSON_RESPONSE_BYTES) {
      statusCode = 507
      encoded = Buffer.from(JSON.stringify({
        error: { code: 'response_too_large', message: 'The response exceeds the transport limit.' }
      }), 'utf8')
    }
    res.statusCode = statusCode
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', String(encoded.byteLength))
    res.setHeader('Cache-Control', 'no-store')
    res.end(encoded)
  }

  private writeSse(client: CompanionApiSseClient, event: string, payload: unknown): boolean {
    try {
      client.response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
      return true
    } catch {
      if (this.sseClients.delete(client)) this.options.onConnectedClientsChange?.()
      return false
    }
  }

  private broadcastTopic(topic: CompanionApiEventTopic, payload: unknown): void {
    for (const client of this.sseClients) {
      if (client.topics.has(topic)) this.writeSse(client, topic, payload)
    }
  }
}
