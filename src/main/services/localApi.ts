import { randomBytes } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { MiniPlayerCommand, MiniPlayerQueueSnapshot, MiniPlayerSnapshot } from '../../types/miniPlayer'
import type { CompanionApiLibraryEvent, CompanionApiScope } from '../../types/companionApi'
import {
  LOCAL_API_LOOPBACK_HOST,
  type LocalApiServiceConfig,
  type LocalApiStatus
} from '../../types/localApi'
import {
  PlaybackHttpCore,
  hashToken,
  hasBearerToken,
  secureTokenEquals
} from './playbackHttpCore'
import {
  CompanionApiV2,
  type CompanionApiV2Options
} from './companionApiV2'

const LOCAL_API_CORS_ALLOW_ORIGIN = '*'
const LOCAL_API_CORS_ALLOW_METHODS = 'GET, POST, OPTIONS'
const LOCAL_API_CORS_ALLOW_HEADERS = 'Authorization, Content-Type'
const LOCAL_API_CORS_MAX_AGE_SECONDS = 600

export function generateLocalApiToken(): string {
  return randomBytes(24).toString('hex')
}

interface LocalApiServiceOptions {
  config: LocalApiServiceConfig
  getSnapshot: () => MiniPlayerSnapshot | null
  dispatchCommand: (command: MiniPlayerCommand) => void
  resolveArtworkDataUrl?: (artworkHash: string) => Promise<string | null>
  onStatusChange?: (status: LocalApiStatus) => void
  companionApi?: Omit<CompanionApiV2Options, 'transport' | 'authenticateRequest' | 'onConnectedClientsChange'>
}

type LocalApiAuthorizationContext = { kind: 'primary' }

export class LocalApiService {
  private config: LocalApiServiceConfig
  private readonly onStatusChange?: (status: LocalApiStatus) => void
  private server: Server | null = null
  private active = false
  private lastError: string | null = null
  private readonly core: PlaybackHttpCore<LocalApiAuthorizationContext>
  private readonly companionApi: CompanionApiV2 | null

  constructor(options: LocalApiServiceOptions) {
    this.config = { ...options.config }
    this.onStatusChange = options.onStatusChange
    this.core = new PlaybackHttpCore({
      getSnapshot: options.getSnapshot,
      dispatchCommand: options.dispatchCommand,
      resolveArtworkDataUrl: options.resolveArtworkDataUrl,
      authorizeRequest: (req) => this.authorizeRequest(req),
      buildArtworkUrl: (trackId) =>
        `http://${LOCAL_API_LOOPBACK_HOST}:${this.config.port}/v1/artwork/current?trackId=${encodeURIComponent(trackId)}`,
      getControlsEnabled: () => this.config.controlsEnabled,
      onConnectedClientsChange: () => this.emitStatus()
    })
    this.companionApi = options.companionApi
      ? new CompanionApiV2({
          ...options.companionApi,
          transport: 'loopback',
          authenticateRequest: (req) => {
            const suppliedToken = hasBearerToken(req)
            if (!suppliedToken || !secureTokenEquals(suppliedToken, this.config.token)) return null
            const scopes = new Set<CompanionApiScope>(['observe'])
            if (this.config.controlsEnabled) scopes.add('playback-control')
            if (this.config.librarySearchEnabled) scopes.add('library-search')
            if (this.config.libraryWriteEnabled) scopes.add('library-write')
            return { id: `loopback:${hashToken(suppliedToken)}`, scopes }
          },
          onConnectedClientsChange: () => this.emitStatus()
        })
      : null
  }

  getStatus(): LocalApiStatus {
    return {
      enabled: this.config.enabled,
      controlsEnabled: this.config.controlsEnabled,
      librarySearchEnabled: this.config.librarySearchEnabled,
      libraryWriteEnabled: this.config.libraryWriteEnabled,
      bindHost: LOCAL_API_LOOPBACK_HOST,
      port: this.config.port,
      baseUrl: `http://${LOCAL_API_LOOPBACK_HOST}:${this.config.port}`,
      token: this.config.token,
      active: this.active,
      mode: !this.config.enabled ? 'off' : this.config.controlsEnabled ? 'api-control' : 'api',
      connectedClients: this.core.getConnectedClientCount() + (this.companionApi?.getConnectedClientCount() ?? 0),
      lastError: this.lastError
    }
  }

  async applyConfig(config: LocalApiServiceConfig): Promise<LocalApiStatus> {
    const previous = this.config
    const restartNeeded = previous.port !== config.port || previous.enabled !== config.enabled
    const authorizationChanged = previous.token !== config.token
      || previous.controlsEnabled !== config.controlsEnabled
      || previous.librarySearchEnabled !== config.librarySearchEnabled
      || previous.libraryWriteEnabled !== config.libraryWriteEnabled

    this.config = { ...config }

    if (!this.config.enabled) {
      await this.stopServer()
      this.lastError = null
      this.emitStatus()
      return this.getStatus()
    }

    if (restartNeeded || !this.server || !this.active) {
      await this.startServer()
    } else {
      this.lastError = null
      this.emitStatus()
    }

    if (authorizationChanged) {
      this.core.closeSseClients((client) => client.authorization.kind === 'primary')
      this.companionApi?.closeAllSseClients()
      this.emitStatus()
    }

    return this.getStatus()
  }

  publishSnapshot(snapshot: MiniPlayerSnapshot | null): void {
    this.core.publishSnapshot(snapshot)
    this.companionApi?.publishCurrentPlayback()
  }

  publishQueueSnapshot(snapshot: MiniPlayerQueueSnapshot | null): void {
    this.core.publishQueueSnapshot(snapshot)
    this.companionApi?.publishCurrentQueue()
  }

  publishLibraryEvent(event: CompanionApiLibraryEvent): void {
    this.companionApi?.publishLibraryEvent(event)
  }

  async stop(): Promise<void> {
    await this.stopServer()
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.getStatus())
  }

  private authorizeRequest(req: IncomingMessage): LocalApiAuthorizationContext | null {
    const suppliedToken = hasBearerToken(req)
    if (!suppliedToken) return null
    if (!secureTokenEquals(suppliedToken, this.config.token)) return null
    return { kind: 'primary' }
  }

  private async startServer(): Promise<void> {
    await this.stopServer()

    const server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })

    try {
      await new Promise<void>((resolve, reject) => {
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        const onError = (error: Error) => {
          server.off('listening', onListening)
          reject(error)
        }

        server.once('listening', onListening)
        server.once('error', onError)
        server.listen(this.config.port, LOCAL_API_LOOPBACK_HOST)
      })

      server.on('error', (error) => {
        this.lastError = error.message
        this.active = false
        this.emitStatus()
      })

      this.server = server
      this.active = true
      this.lastError = null
      this.core.startHeartbeat()
      this.companionApi?.startHeartbeat()
      this.emitStatus()
    } catch (error) {
      this.server = null
      this.active = false
      this.lastError = error instanceof Error ? error.message : 'Failed to start local API.'
      this.core.stopHeartbeat()
      this.emitStatus()
    }
  }

  private async stopServer(): Promise<void> {
    this.core.stopHeartbeat()
    this.core.closeAllSseClients()
    this.companionApi?.stopHeartbeat()
    this.companionApi?.closeAllSseClients()

    if (!this.server) {
      this.active = false
      this.emitStatus()
      return
    }

    const server = this.server
    this.server = null

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })

    this.active = false
    this.emitStatus()
  }

  private respondJson(res: ServerResponse<IncomingMessage>, statusCode: number, body: unknown): void {
    res.statusCode = statusCode
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(body))
  }

  private applyCorsHeaders(res: ServerResponse<IncomingMessage>): void {
    res.setHeader('Access-Control-Allow-Origin', LOCAL_API_CORS_ALLOW_ORIGIN)
  }

  private respondCorsPreflight(res: ServerResponse<IncomingMessage>): void {
    res.statusCode = 204
    res.setHeader('Access-Control-Allow-Methods', LOCAL_API_CORS_ALLOW_METHODS)
    res.setHeader('Access-Control-Allow-Headers', LOCAL_API_CORS_ALLOW_HEADERS)
    res.setHeader('Access-Control-Max-Age', String(LOCAL_API_CORS_MAX_AGE_SECONDS))
    res.end()
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>
  ): Promise<void> {
    this.applyCorsHeaders(res)

    let requestUrl: URL
    try {
      requestUrl = new URL(req.url ?? '/', `http://${LOCAL_API_LOOPBACK_HOST}`)
    } catch {
      this.respondJson(res, 400, { error: 'Invalid request URL.' })
      return
    }
    const path = requestUrl.pathname

    if (this.companionApi && await this.companionApi.handleRequest(req, res, requestUrl)) {
      return
    }

    const method = req.method ?? 'GET'
    if (method === 'OPTIONS') {
      this.respondCorsPreflight(res)
      return
    }

    if (method === 'GET' && path === '/v1/now-playing') {
      this.core.handleNowPlaying(req, res, requestUrl)
      return
    }

    if (method === 'GET' && path === '/v1/events') {
      this.core.handleSse(req, res)
      return
    }

    if (method === 'GET' && path === '/v1/artwork/current') {
      this.core.handleArtwork(req, res, requestUrl)
      return
    }

    if (method === 'GET' && path === '/v1/queue') {
      this.core.handleQueue(req, res)
      return
    }

    if (method === 'POST' && path === '/v1/control') {
      await this.core.handleControl(req, res)
      return
    }

    this.respondJson(res, 404, { error: 'Not found' })
  }
}
