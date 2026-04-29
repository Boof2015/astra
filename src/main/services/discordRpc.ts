import { randomUUID } from 'crypto'
import { readdirSync } from 'fs'
import { createConnection, Socket } from 'net'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildDiscordActivityFromPresence } from './discordRpcActivity'

const DISCORD_IPC_ENDPOINTS = 10
const RECONNECT_DELAY_MS = 5000
const MAX_RPC_PACKET_SIZE = 1024 * 1024
const DISCORD_RPC_CLIENT_ID = '1471059486100815915'
const DISCORD_APP_INFO_LOOKUP_URL = `https://discord.com/api/v10/oauth2/applications/${DISCORD_RPC_CLIENT_ID}/rpc`
const DISCORD_APP_ICON_LOOKUP_TIMEOUT_MS = 5000
const DISCORD_RPC_USER_AGENT = 'Astra-Discord-RPC/0.2.0 (https://github.com/Boof2015/astra)'
const DISCORD_SET_ACTIVITY_COALESCE_MS = 150
const DISCORD_SET_ACTIVITY_ACK_TIMEOUT_MS = 1500

const OPCODE_HANDSHAKE = 0
const OPCODE_FRAME = 1
const OPCODE_CLOSE = 2
const OPCODE_PING = 3
const OPCODE_PONG = 4
const DISCORD_LINUX_SOCKET_PREFIXES = ['discord-ipc', 'vesktop-ipc'] as const
const DISCORD_LINUX_RUNTIME_APP_DIR_HINTS = [
  'app/com.discordapp.Discord',
  'app/com.discordapp.DiscordCanary',
  'app/com.discordapp.DiscordPTB',
  'app/com.vesktop.Vesktop',
  'app/dev.vencord.Vesktop'
] as const

export type DiscordPlaybackState = 'stopped' | 'playing' | 'paused' | 'loading'

export interface DiscordTrackPresence {
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

export interface DiscordPresenceUpdate {
  playbackState: DiscordPlaybackState
  currentTimeSeconds?: number
  durationSeconds?: number
  track?: DiscordTrackPresence | null
}

export interface DiscordRpcConfigureOptions {
  enabled: boolean
  coverArtEnabled?: boolean
}

export interface DiscordRpcConfigureResult {
  ok: boolean
  connected: boolean
  message: string
}

interface DiscordRpcApplicationInfoResponse {
  icon?: unknown
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined
  if (!Number.isFinite(value)) return undefined
  if (value < 0) return 0
  return value
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized) return undefined

  try {
    const parsed = new URL(normalized)
    if (parsed.protocol !== 'https:') return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

function listDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

export class DiscordRpcService {
  private enabled = false
  private coverArtEnabled = false
  private socket: Socket | null = null
  private ready = false
  private receiveBuffer = Buffer.alloc(0)
  private reconnectTimer: NodeJS.Timeout | null = null
  private connectPromise: Promise<boolean> | null = null
  private pendingPresence: DiscordPresenceUpdate | null = null
  private lastPresenceSignature: string | null = null
  private presenceSendTimer: NodeJS.Timeout | null = null
  private pendingForcePresenceSend = false
  private setActivityInFlightNonce: string | null = null
  private setActivityInFlightTimer: NodeJS.Timeout | null = null
  private sendAfterInFlight = false
  private fallbackLargeImageUrl: string | null = null
  private fallbackLargeImageLookupPromise: Promise<void> | null = null

  async configure(options: DiscordRpcConfigureOptions): Promise<DiscordRpcConfigureResult> {
    const nextEnabled = Boolean(options.enabled)
    const nextCoverArtEnabled = Boolean(options.coverArtEnabled)
    const enabledChanged = this.enabled !== nextEnabled

    this.enabled = nextEnabled
    this.coverArtEnabled = nextCoverArtEnabled

    if (!this.enabled) {
      this.clearPresenceSendTimer()
      this.clearSetActivityInFlight()
      this.pendingForcePresenceSend = false
      this.clearReconnectTimer()
      this.disconnectSocket()
      return {
        ok: true,
        connected: false,
        message: 'Discord Rich Presence is disabled.'
      }
    }

    if (enabledChanged) {
      this.disconnectSocket()
    }

    const connected = await this.ensureConnected()
    if (!this.fallbackLargeImageUrl) {
      void this.ensureFallbackLargeImageUrl()
    }
    if (connected) {
      return {
        ok: true,
        connected: true,
        message: 'Discord Rich Presence connected.'
      }
    }

    this.scheduleReconnect()
    return {
      ok: false,
      connected: false,
      message: 'Discord IPC socket not found. Start Discord and keep Rich Presence enabled.'
    }
  }

  updatePresence(update: DiscordPresenceUpdate): void {
    this.pendingPresence = {
      playbackState: update.playbackState,
      currentTimeSeconds: normalizeNumber(update.currentTimeSeconds),
      durationSeconds: normalizeNumber(update.durationSeconds),
      track: update.track
        ? {
            title: update.track.title,
            artist: normalizeText(update.track.artist),
            album: normalizeText(update.track.album),
            albumArtist: normalizeText(update.track.albumArtist),
            coverArtUrl: normalizeHttpsUrl(update.track.coverArtUrl),
            durationSeconds: normalizeNumber(update.track.durationSeconds),
            format: normalizeText(update.track.format),
            sampleRate: normalizeNumber(update.track.sampleRate),
            bitDepth: normalizeNumber(update.track.bitDepth),
            bitrate: normalizeNumber(update.track.bitrate),
            channels: normalizeNumber(update.track.channels),
            codec: normalizeText(update.track.codec),
            codecProfile: normalizeText(update.track.codecProfile),
            isAtmosJoc: normalizeBoolean(update.track.isAtmosJoc)
          }
        : null
    }

    if (!this.enabled) return
    if (!this.ready) {
      void this.ensureConnected()
      return
    }

    this.queuePendingPresenceSend()
  }

  clearPresence(): void {
    this.pendingPresence = null
    this.lastPresenceSignature = null
    this.pendingForcePresenceSend = true
    if (!this.ready) {
      this.clearPresenceSendTimer()
      return
    }
    this.queuePendingPresenceSend(0, true)
  }

  shutdown(): void {
    this.enabled = false
    this.pendingPresence = null
    this.lastPresenceSignature = null
    this.clearPresenceSendTimer()
    this.clearSetActivityInFlight()
    this.pendingForcePresenceSend = false
    this.clearReconnectTimer()
    this.disconnectSocket()
  }

  private async ensureConnected(): Promise<boolean> {
    if (!this.enabled) return false
    if (this.socket && !this.socket.destroyed) return true
    if (this.connectPromise) return this.connectPromise

    this.connectPromise = this.tryConnect()
      .catch(() => false)
      .finally(() => {
        this.connectPromise = null
      })

    return this.connectPromise
  }

  private async tryConnect(): Promise<boolean> {
    for (const endpoint of this.getIpcEndpoints()) {
      const connected = await this.connectToEndpoint(endpoint)
      if (connected) {
        return true
      }
    }
    return false
  }

  private connectToEndpoint(endpoint: string): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection(endpoint)

      const onError = () => {
        cleanup()
        try {
          socket.destroy()
        } catch {
          // Ignore cleanup errors.
        }
        resolve(false)
      }

      const onConnect = () => {
        cleanup()
        this.attachSocket(socket)
        this.sendHandshake()
        resolve(true)
      }

      const cleanup = () => {
        socket.removeListener('error', onError)
        socket.removeListener('connect', onConnect)
      }

      socket.once('error', onError)
      socket.once('connect', onConnect)
    })
  }

  private attachSocket(socket: Socket): void {
    this.disconnectSocket()
    this.socket = socket
    this.ready = false
    this.receiveBuffer = Buffer.alloc(0)
    this.lastPresenceSignature = null
    this.clearReconnectTimer()

    socket.on('data', (chunk: Buffer) => {
      this.handleData(chunk)
    })

    socket.on('error', (error) => {
      console.warn('Discord RPC socket error:', error)
    })

    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null
        this.ready = false
        this.receiveBuffer = Buffer.alloc(0)
      }
      if (this.enabled) {
        this.scheduleReconnect()
      }
    })
  }

  private disconnectSocket(): void {
    this.clearSetActivityInFlight()
    if (!this.socket) return
    const socket = this.socket
    this.socket = null
    this.ready = false
    this.receiveBuffer = Buffer.alloc(0)
    socket.removeAllListeners('data')
    socket.removeAllListeners('error')
    socket.removeAllListeners('close')
    try {
      socket.destroy()
    } catch {
      // Ignore disconnect errors.
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.enabled) return
      void this.ensureConnected()
    }, RECONNECT_DELAY_MS)
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private getIpcEndpoints(): string[] {
    if (process.platform === 'win32') {
      return Array.from({ length: DISCORD_IPC_ENDPOINTS }, (_, index) => `\\\\.\\pipe\\discord-ipc-${index}`)
    }

    const endpointDirectories = new Set<string>()
    const linuxRuntimeRoots = new Set<string>()
    const addEndpointDirectory = (rawPath: string | undefined): void => {
      if (!rawPath) return
      const normalized = rawPath.trim()
      if (!normalized) return
      endpointDirectories.add(normalized)
    }
    const addLinuxRuntimeRoot = (rawPath: string | undefined): void => {
      if (!rawPath) return
      const normalized = rawPath.trim()
      if (!normalized) return
      linuxRuntimeRoots.add(normalized)
      endpointDirectories.add(normalized)
    }

    if (process.platform === 'linux') {
      // AppImage builds often need XDG runtime sockets before /tmp fallbacks.
      addLinuxRuntimeRoot(process.env.XDG_RUNTIME_DIR)

      const readUid = process.getuid
      if (typeof readUid === 'function') {
        addLinuxRuntimeRoot(join('/run/user', String(readUid())))
      }

      for (const runtimeRoot of linuxRuntimeRoots) {
        for (const candidate of DISCORD_LINUX_RUNTIME_APP_DIR_HINTS) {
          addEndpointDirectory(join(runtimeRoot, candidate))
        }

        for (const appDirName of listDirectories(join(runtimeRoot, 'app'))) {
          addEndpointDirectory(join(runtimeRoot, 'app', appDirName))
        }
      }
    }

    addEndpointDirectory('/tmp')
    addEndpointDirectory(tmpdir())

    const socketPrefixes = process.platform === 'linux'
      ? DISCORD_LINUX_SOCKET_PREFIXES
      : ['discord-ipc']

    const endpoints: string[] = []
    for (const directory of endpointDirectories) {
      for (const socketPrefix of socketPrefixes) {
        for (let index = 0; index < DISCORD_IPC_ENDPOINTS; index += 1) {
          endpoints.push(join(directory, `${socketPrefix}-${index}`))
        }
      }
    }
    return endpoints
  }

  private sendHandshake(): void {
    this.sendFrame(OPCODE_HANDSHAKE, {
      v: 1,
      client_id: DISCORD_RPC_CLIENT_ID
    })
  }

  private clearPresenceSendTimer(): void {
    if (!this.presenceSendTimer) return
    clearTimeout(this.presenceSendTimer)
    this.presenceSendTimer = null
  }

  private clearSetActivityInFlight(): void {
    if (this.setActivityInFlightTimer) {
      clearTimeout(this.setActivityInFlightTimer)
      this.setActivityInFlightTimer = null
    }
    this.setActivityInFlightNonce = null
    this.sendAfterInFlight = false
  }

  private queuePendingPresenceSend(
    delayMs = DISCORD_SET_ACTIVITY_COALESCE_MS,
    force = false
  ): void {
    if (!this.enabled || !this.ready) return

    this.pendingForcePresenceSend = this.pendingForcePresenceSend || force
    this.clearPresenceSendTimer()

    this.presenceSendTimer = setTimeout(() => {
      this.presenceSendTimer = null
      const forceSend = this.pendingForcePresenceSend
      this.pendingForcePresenceSend = false
      this.flushPendingPresence(forceSend)
    }, Math.max(0, delayMs))
  }

  private flushPendingPresence(force = false): void {
    if (this.setActivityInFlightNonce) {
      this.sendAfterInFlight = true
      this.pendingForcePresenceSend = this.pendingForcePresenceSend || force
      return
    }

    this.sendPendingPresence(force)
  }

  private sendPendingPresence(force = false): void {
    const activity = this.buildActivityFromPresence(this.pendingPresence)
    const signature = JSON.stringify(activity)
    const socket = this.socket
    if (!socket || socket.destroyed) {
      this.ready = false
      if (this.enabled) {
        void this.ensureConnected()
        this.scheduleReconnect()
      }
      return
    }
    if (!force && signature === this.lastPresenceSignature) return
    const nonce = this.sendSetActivity(activity)
    if (nonce) {
      this.lastPresenceSignature = signature
      this.setActivityInFlightNonce = nonce
      this.setActivityInFlightTimer = setTimeout(() => {
        if (this.setActivityInFlightNonce !== nonce) return
        this.clearSetActivityInFlight()
        this.queuePendingPresenceSend(0, this.pendingForcePresenceSend)
      }, DISCORD_SET_ACTIVITY_ACK_TIMEOUT_MS)
    }
  }

  private sendSetActivity(activity: Record<string, unknown> | null): string | null {
    const nonce = randomUUID()
    return this.sendFrame(OPCODE_FRAME, {
      cmd: 'SET_ACTIVITY',
      args: {
        pid: process.pid,
        activity
      },
      nonce
    }) ? nonce : null
  }

  private buildActivityFromPresence(
    presence: DiscordPresenceUpdate | null
  ): Record<string, unknown> | null {
    const coverArtUrl = this.coverArtEnabled ? normalizeHttpsUrl(presence?.track?.coverArtUrl) : undefined
    const largeImageUrl = coverArtUrl ?? this.fallbackLargeImageUrl ?? undefined
    return buildDiscordActivityFromPresence(presence, { largeImageUrl })
  }

  private async ensureFallbackLargeImageUrl(): Promise<void> {
    if (this.fallbackLargeImageUrl) return
    if (this.fallbackLargeImageLookupPromise) {
      await this.fallbackLargeImageLookupPromise
      return
    }

    this.fallbackLargeImageLookupPromise = this.fetchFallbackLargeImageUrl()
      .catch(() => {
        // Ignore fallback lookup failures and keep presence updates running.
      })
      .finally(() => {
        this.fallbackLargeImageLookupPromise = null
      })

    await this.fallbackLargeImageLookupPromise
  }

  private async fetchFallbackLargeImageUrl(): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DISCORD_APP_ICON_LOOKUP_TIMEOUT_MS)

    try {
      const response = await fetch(DISCORD_APP_INFO_LOOKUP_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': DISCORD_RPC_USER_AGENT
        },
        signal: controller.signal
      })

      if (!response.ok) return

      const payload: unknown = await response.json()
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return

      const iconHash = normalizeText((payload as DiscordRpcApplicationInfoResponse).icon)
      if (!iconHash) return

      const extension = iconHash.startsWith('a_') ? 'gif' : 'png'
      const iconUrl = normalizeHttpsUrl(
        `https://cdn.discordapp.com/app-icons/${DISCORD_RPC_CLIENT_ID}/${iconHash}.${extension}?size=512`
      )
      if (!iconUrl) return

      this.fallbackLargeImageUrl = iconUrl
      if (this.enabled && this.ready && this.pendingPresence) {
        this.queuePendingPresenceSend(0, true)
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private sendFrame(opcode: number, payload: unknown): boolean {
    const socket = this.socket
    if (!socket || socket.destroyed) return false

    try {
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      const header = Buffer.allocUnsafe(8)
      header.writeInt32LE(opcode, 0)
      header.writeInt32LE(body.byteLength, 4)
      socket.write(Buffer.concat([header, body]))
      return true
    } catch (error) {
      console.warn('Discord RPC send failed:', error)
      return false
    }
  }

  private handleData(chunk: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk])

    while (this.receiveBuffer.length >= 8) {
      const opcode = this.receiveBuffer.readInt32LE(0)
      const payloadLength = this.receiveBuffer.readInt32LE(4)

      if (payloadLength < 0 || payloadLength > MAX_RPC_PACKET_SIZE) {
        this.disconnectSocket()
        return
      }

      const frameLength = 8 + payloadLength
      if (this.receiveBuffer.length < frameLength) {
        return
      }

      const payloadBuffer = this.receiveBuffer.subarray(8, frameLength)
      this.receiveBuffer = this.receiveBuffer.subarray(frameLength)

      let payload: unknown = null
      if (payloadBuffer.length > 0) {
        try {
          payload = JSON.parse(payloadBuffer.toString('utf8'))
        } catch {
          // Ignore malformed payloads.
        }
      }

      this.handleFrame(opcode, payload)
    }
  }

  private handleFrame(opcode: number, payload: unknown): void {
    if (opcode === OPCODE_PING) {
      this.sendFrame(OPCODE_PONG, payload ?? {})
      return
    }

    if (opcode === OPCODE_CLOSE) {
      this.disconnectSocket()
      if (this.enabled) {
        this.scheduleReconnect()
      }
      return
    }

    if (opcode !== OPCODE_FRAME || !payload || typeof payload !== 'object') return

    const record = payload as Record<string, unknown>
    const nonce = typeof record.nonce === 'string' ? record.nonce : null
    if (nonce) {
      this.handleSetActivityResponse(nonce)
    }

    if (record.evt === 'READY') {
      this.ready = true
      if (!this.fallbackLargeImageUrl) {
        void this.ensureFallbackLargeImageUrl()
      }
      this.queuePendingPresenceSend(0, true)
      return
    }

    if (record.evt === 'ERROR') {
      const errorData = record.data
      console.warn('Discord RPC protocol error:', errorData)
    }
  }

  private handleSetActivityResponse(nonce: string): void {
    if (nonce !== this.setActivityInFlightNonce) return

    if (this.setActivityInFlightTimer) {
      clearTimeout(this.setActivityInFlightTimer)
      this.setActivityInFlightTimer = null
    }
    this.setActivityInFlightNonce = null

    if (this.sendAfterInFlight) {
      this.sendAfterInFlight = false
      this.queuePendingPresenceSend(0, this.pendingForcePresenceSend)
    }
  }
}

export const discordRpcService = new DiscordRpcService()
