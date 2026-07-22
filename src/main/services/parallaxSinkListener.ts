import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { EventEmitter } from 'events'
import {
  // Sink-side TTL is `PARALLAX_PAIR_PIN_TTL_MS`. The candidate TTL constant is host-side and
  // belongs in `parallax.ts` with `pendingPairs`.
  PARALLAX_PAIR_PIN_MAX_FAILS,
  PARALLAX_PAIR_PIN_TTL_MS,
  PARALLAX_PAIR_LOCKOUT_COOLDOWN_MS,
  PARALLAX_PAIR_RATE_LIMIT_MS,
  PARALLAX_PROTOCOL_VERSION,
  type ParallaxIncomingPairRequest,
  type ParallaxPairConfirmBody,
  type ParallaxPairConfirmResponse,
  type ParallaxPairRequestBody,
  type ParallaxPairRequestResponse,
  type ParallaxSinkIdentityResponse
} from '../../types/parallax'
import {
  createParallaxEphemeralKeyPair,
  deriveParallaxPairingCode,
  deriveParallaxPairingKey,
  normalizeParallaxFingerprint,
  openParallaxPairingPayload,
  parallaxCertificateFingerprint,
  sealParallaxPairingPayload,
  type ParallaxEphemeralKeyPair,
  type ParallaxPairingTranscript
} from './parallaxSecurity'

// §20 / §14.1.5 Commit 3. Sink-role HTTP listener — runs only while `parallaxSinkEnabled` is on
// and exposes ONLY the pre-pair endpoints (sink-identity + pair-request + pair-confirm). Audio /
// timeline / control endpoints stay on the host service in `parallax.ts`. New attack surface is
// intentionally minimal:
//
//   - GET  /v1/parallax/sink-identity  → unauth: name, endpoint_uuid, paired
//   - POST /v1/parallax/pair-request   → unauth: rate-limited, busy=409 if PIN pending
//   - POST /v1/parallax/pair-confirm   → unauth: PIN-gated, 3-fail lockout, persists creds
//
// The PIN-on-screen IS the auth (Codex §20.7) — anyone able to read it has physical access. The
// candidate `(sinkId, token)` arrives only in pair-confirm, never in pair-request (Codex round 1
// correction to §20.6) so a snooper of pair-request can't harvest credentials.

interface PendingPair {
  pairingId: string
  pin: string
  pairingKey: Buffer
  transcript: ParallaxPairingTranscript
  sinkEphemeral: ParallaxEphemeralKeyPair
  hostName: string
  hostUrl: string
  hostCertificatePem: string
  hostCertificateFingerprint: string
  hostParallaxEndpointUuid: string | null
  startedAtMs: number
  expiresAtMs: number
  failCount: number
  awaitingApproval: boolean
  approvalResolve: ((approved: boolean) => void) | null
  expiryTimer: ReturnType<typeof setTimeout>
}

export interface ParallaxSinkListenerCallbacks {
  getEndpointUuid: () => string
  getSinkName: () => string
  getHasPersistedConnection: () => boolean
  // Fired when pair-confirm validates — main wires this to clear+persist the §14.1.2 sink
  // connection. Async so main can finish its persistence path before the 200 response goes out.
  onPaired: (info: ParallaxSinkListenerPairedInfo) => Promise<void>
  // Push incoming-pair state into the status payload so the renderer's PIN card (Commit 4) and
  // any other subscribers see it via the existing status push.
  onIncomingPairChange: (state: ParallaxIncomingPairRequest | null) => void
}

export interface ParallaxSinkListenerPairedInfo {
  protocolVersion: 2
  hostUrl: string
  hostName: string
  sinkId: string
  token: string
  hostCertificatePem: string
  hostCertificateFingerprint: string
  hostParallaxEndpointUuid: string | null
  pairedAt: number
}

interface ParallaxSinkListenerEvents {
  error: [Error]
}

// Tombstone holds a recently-expired pairingId so a `pair-confirm` arriving just after the
// expiry timer fires gets the documented `410 expired` instead of a generic `404 no pending`.
// Codex round 1 finding (low). Tombstone TTL is intentionally short — the wizard's expiry
// window is bounded anyway and we don't want lingering state to confuse new pair flows.
const EXPIRED_TOMBSTONE_TTL_MS = 30_000

interface ExpiredTombstone {
  pairingId: string
  timer: ReturnType<typeof setTimeout>
}

export class ParallaxSinkListener extends EventEmitter<ParallaxSinkListenerEvents> {
  private server: Server | null = null
  private stopPromise: Promise<void> | null = null
  private port = 0
  private pending: PendingPair | null = null
  private expiredTombstones = new Map<string, ExpiredTombstone>()
  private readonly lastAcceptedRequestAtMs = new Map<string, number>()
  private readonly lockoutUntilMs = new Map<string, number>()
  private readonly callbacks: ParallaxSinkListenerCallbacks
  // Test/debug hook: override the PIN TTL so a test can exercise the real expiry path without
  // hanging the suite for 90s. Defaults to `PARALLAX_PAIR_PIN_TTL_MS`.
  private readonly pinTtlMs: number

  constructor(callbacks: ParallaxSinkListenerCallbacks, options: { pinTtlMs?: number } = {}) {
    super()
    this.callbacks = callbacks
    this.pinTtlMs = options.pinTtlMs ?? PARALLAX_PAIR_PIN_TTL_MS
  }

  async start(port: number): Promise<void> {
    if (this.server && this.port === port) return
    if (this.server) {
      await this.stop()
    }
    this.port = port
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res).catch((error) => {
          this.emit('error', error instanceof Error ? error : new Error(String(error)))
          if (!res.headersSent) toJsonResponse(res, 500, { error: 'Internal sink error.' })
        })
      })
      server.headersTimeout = 10_000
      server.requestTimeout = 10_000
      server.keepAliveTimeout = 5_000
      server.maxConnections = 32
      server.once('error', (error) => reject(error))
      server.listen(port, '0.0.0.0', () => {
        server.removeAllListeners('error')
        server.on('error', (error) => this.emit('error', error))
        this.server = server
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.clearPending(null)
    // Tombstones hold their own setTimeouts; drain them too so stop() leaves no live handles.
    for (const [, tombstone] of this.expiredTombstones) {
      clearTimeout(tombstone.timer)
    }
    this.expiredTombstones.clear()
    if (!this.server) return
    const server = this.server
    this.server = null
    const stopping = new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    // Stop accepting first, then shed active/keep-alive/partially-read requests. A pairing client
    // must not be able to hold server.close() open during app or receiver shutdown.
    server.closeAllConnections()
    this.stopPromise = stopping.finally(() => {
      this.stopPromise = null
    })
    return this.stopPromise
  }

  get isRunning(): boolean {
    return this.server !== null
  }

  // Public for cancellation IPC (Commit 4 sink-side "Reject"). Calling with `null` clears any
  // pending pair without emitting an event; passing `'expired'` / `'lockout'` is informational —
  // the actual UI distinguishes via the absence of incomingPairRequest in subsequent status.
  cancelPending(): void {
    this.clearPending(null)
  }

  approvePending(): boolean {
    const pending = this.pending
    if (!pending?.awaitingApproval || !pending.approvalResolve) return false
    const resolve = pending.approvalResolve
    pending.approvalResolve = null
    resolve(true)
    return true
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'sink'}`)
    const { method } = req
    const path = requestUrl.pathname

    if (method === 'GET' && path === '/v1/parallax/sink-identity') {
      const payload: ParallaxSinkIdentityResponse = {
        name: this.callbacks.getSinkName(),
        endpoint_uuid: this.callbacks.getEndpointUuid(),
        paired: this.callbacks.getHasPersistedConnection()
      }
      toJsonResponse(res, 200, payload)
      return
    }

    if (method === 'POST' && path === '/v1/parallax/pair-request') {
      await this.handlePairRequest(req, res)
      return
    }

    if (method === 'POST' && path === '/v1/parallax/pair-confirm') {
      await this.handlePairConfirm(req, res)
      return
    }

    toJsonResponse(res, 404, { error: 'Not found' })
  }

  private async handlePairRequest(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    const now = Date.now()
    // Derive the host IP up front (also reused below for hostUrl). Strip the IPv6-mapped prefix Node
    // adds on dual-stack sockets ("::ffff:192.168.1.5" → "192.168.1.5").
    const rawRemote = req.socket.remoteAddress ?? ''
    const remoteAddress = rawRemote.startsWith('::ffff:') ? rawRemote.slice('::ffff:'.length) : rawRemote

    if (this.pending) {
      toJsonResponse(res, 409, { error: 'busy' })
      return
    }
    const lockoutUntil = this.lockoutUntilMs.get(remoteAddress) ?? 0
    if (now < lockoutUntil) {
      toJsonResponse(res, 429, { error: 'locked-out' })
      return
    }
    const lastAccepted = this.lastAcceptedRequestAtMs.get(remoteAddress) ?? 0
    if (now < lastAccepted + PARALLAX_PAIR_RATE_LIMIT_MS) {
      toJsonResponse(res, 429, { error: 'rate-limited' })
      return
    }

    let body: ParallaxPairRequestBody
    try {
      body = await readJsonBody<ParallaxPairRequestBody>(req)
    } catch {
      toJsonResponse(res, 400, { error: 'Invalid pair-request payload.' })
      return
    }

    const pairingId = pickString(body.pairingId)
    const hostName = pickString(body.hostName) || 'Unknown host'
    const hostPort = Number(body.hostPort)
    const hostParallaxEndpointUuid = pickString(body.parallaxEndpointUuid) || null
    const hostEphemeralPublicKey = pickString(body.hostEphemeralPublicKey)
    const hostCertificatePem = pickString(body.hostCertificatePem)
    const hostCertificateFingerprint = normalizeParallaxFingerprint(pickString(body.hostCertificateFingerprint))
    if (
      body.version !== PARALLAX_PROTOCOL_VERSION
      || !pairingId
      || pairingId.length > 128
      || !Number.isFinite(hostPort)
      || hostPort <= 0
      || hostPort > 65535
      || !hostEphemeralPublicKey
      || hostEphemeralPublicKey.length > 256
      || hostCertificatePem.length > 16 * 1024
      || !hostCertificateFingerprint
    ) {
      toJsonResponse(res, 400, { error: 'Invalid Parallax v2 pair-request.' })
      return
    }
    try {
      if (parallaxCertificateFingerprint(hostCertificatePem) !== hostCertificateFingerprint) {
        toJsonResponse(res, 400, { error: 'Host certificate fingerprint mismatch.' })
        return
      }
    } catch {
      toJsonResponse(res, 400, { error: 'Invalid host certificate.' })
      return
    }

    // Codex round 1 amendment (b): derive hostUrl from the socket remote address (computed above) so
    // we always store the address we can actually reach back on.
    if (!remoteAddress) {
      toJsonResponse(res, 400, { error: 'Could not derive host address from request.' })
      return
    }
    const hostUrl = `https://${remoteAddress}:${hostPort}`

    const sinkEphemeral = createParallaxEphemeralKeyPair()
    const transcript: ParallaxPairingTranscript = {
      version: PARALLAX_PROTOCOL_VERSION,
      pairingId,
      hostEphemeralPublicKey,
      sinkEphemeralPublicKey: sinkEphemeral.publicKey,
      hostCertificateFingerprint,
      hostParallaxEndpointUuid: hostParallaxEndpointUuid ?? '',
      sinkParallaxEndpointUuid: this.callbacks.getEndpointUuid(),
      hostPort
    }
    let pairingKey: Buffer
    try {
      pairingKey = deriveParallaxPairingKey(sinkEphemeral.privateKey, hostEphemeralPublicKey, transcript)
    } catch {
      toJsonResponse(res, 400, { error: 'Invalid host pairing key.' })
      return
    }
    const pin = deriveParallaxPairingCode(pairingKey, transcript)
    const expiresAtMs = now + this.pinTtlMs
    const expiryTimer = setTimeout(() => this.clearPending('expired'), this.pinTtlMs)
    this.pending = {
      pairingId,
      pin,
      pairingKey,
      transcript,
      sinkEphemeral,
      hostName,
      hostUrl,
      hostCertificatePem,
      hostCertificateFingerprint,
      hostParallaxEndpointUuid,
      startedAtMs: now,
      expiresAtMs,
      failCount: 0,
      awaitingApproval: false,
      approvalResolve: null,
      expiryTimer
    }
    this.lastAcceptedRequestAtMs.set(remoteAddress, now)
    this.callbacks.onIncomingPairChange({
      pairingId,
      pin,
      hostName,
      hostParallaxEndpointUuid,
      hostUrl,
      expiresAtMs,
      awaitingApproval: false
    })

    const payload: ParallaxPairRequestResponse = {
      version: PARALLAX_PROTOCOL_VERSION,
      expiresInSeconds: Math.max(1, Math.round(this.pinTtlMs / 1000)),
      parallaxEndpointUuid: this.callbacks.getEndpointUuid(),
      sinkName: this.callbacks.getSinkName(),
      sinkEphemeralPublicKey: sinkEphemeral.publicKey
    }
    toJsonResponse(res, 200, payload)
  }

  private async handlePairConfirm(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    let body: ParallaxPairConfirmBody
    try {
      body = await readJsonBody<ParallaxPairConfirmBody>(req)
    } catch {
      toJsonResponse(res, 400, { error: 'Invalid pair-confirm payload.' })
      return
    }
    const pairingId = pickString(body.pairingId)

    const pending = this.pending
    if (!pending) {
      // Codex round 1 finding (low): if the timer already fired the documented 410-expired path
      // takes precedence over the generic 404 — the wizard's copy on expiry differs from "sink
      // never knew about this pairing." Tombstone lives ~30s after expiry.
      if (pairingId && this.expiredTombstones.has(pairingId)) {
        toJsonResponse(res, 410, { error: 'expired' })
        return
      }
      toJsonResponse(res, 404, { error: 'No pending pair-request.' })
      return
    }
    if (!pairingId || pairingId !== pending.pairingId) {
      toJsonResponse(res, 404, { error: 'No pending pair-request.' })
      return
    }
    if (pending.awaitingApproval) {
      toJsonResponse(res, 409, { error: 'confirmation-already-pending' })
      return
    }

    const now = Date.now()
    if (now > pending.expiresAtMs) {
      this.clearPending('expired')
      toJsonResponse(res, 410, { error: 'expired' })
      return
    }

    let confirmed: { sinkId?: unknown; token?: unknown; sinkName?: unknown }
    try {
      confirmed = openParallaxPairingPayload(body, pending.pairingKey, pending.transcript)
    } catch {
      pending.failCount += 1
      if (pending.failCount >= PARALLAX_PAIR_PIN_MAX_FAILS) {
        const remoteAddress = parsePendingHostAddress(pending.hostUrl)
        if (remoteAddress) {
          this.lockoutUntilMs.set(remoteAddress, Date.now() + PARALLAX_PAIR_LOCKOUT_COOLDOWN_MS)
        }
        this.clearPending('lockout')
      }
      toJsonResponse(res, 401, { error: 'confirmation' })
      return
    }

    const sinkId = pickString(confirmed.sinkId)
    const token = pickString(confirmed.token)
    if (!sinkId || sinkId.length > 128 || !token || token.length > 512) {
      toJsonResponse(res, 400, { error: 'sinkId and token are required.' })
      return
    }

    const sinkNameRequested = pickString(confirmed.sinkName) || ''
    if (sinkNameRequested.length > 200) {
      toJsonResponse(res, 400, { error: 'Invalid sink name.' })
      return
    }
    pending.awaitingApproval = true
    this.callbacks.onIncomingPairChange({
      pairingId: pending.pairingId,
      pin: pending.pin,
      hostName: pending.hostName,
      hostParallaxEndpointUuid: pending.hostParallaxEndpointUuid,
      hostUrl: pending.hostUrl,
      expiresAtMs: pending.expiresAtMs,
      awaitingApproval: true
    })
    const approved = await new Promise<boolean>((resolve) => {
      pending.approvalResolve = resolve
    })
    if (!approved || this.pending !== pending || Date.now() > pending.expiresAtMs) {
      if (!res.headersSent) toJsonResponse(res, 409, { error: 'pairing-not-approved' })
      return
    }

    const info: ParallaxSinkListenerPairedInfo = {
      protocolVersion: PARALLAX_PROTOCOL_VERSION,
      hostUrl: pending.hostUrl,
      hostName: pending.hostName,
      sinkId,
      token,
      hostCertificatePem: pending.hostCertificatePem,
      hostCertificateFingerprint: pending.hostCertificateFingerprint,
      hostParallaxEndpointUuid: pending.hostParallaxEndpointUuid,
      pairedAt: now
    }
    this.clearPending(null)
    try {
      await this.callbacks.onPaired(info)
    } catch (error) {
      // Surface the error but report it as a server-side problem — the host's wizard will
      // present a generic failure. The sink's pending state is already cleared.
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
      toJsonResponse(res, 500, { error: 'persist-failed' })
      return
    }

    const payload: ParallaxPairConfirmResponse = sealParallaxPairingPayload({
      pairingId,
      parallaxEndpointUuid: this.callbacks.getEndpointUuid(),
      sinkName: sinkNameRequested || this.callbacks.getSinkName()
    }, pending.pairingKey, pending.transcript)
    toJsonResponse(res, 200, payload)
  }

  private clearPending(reason: 'expired' | 'lockout' | null): void {
    if (!this.pending) return
    const cleared = this.pending
    clearTimeout(cleared.expiryTimer)
    const approvalResolve = cleared.approvalResolve
    cleared.approvalResolve = null
    approvalResolve?.(false)
    this.pending = null
    // Codex round 1 finding (low): record an expired tombstone so a confirm arriving just
    // after the timer fires can still resolve to 410 instead of 404. `lockout` doesn't earn a
    // tombstone — locked-out clients should learn "no pending" (the 3-fail flow already gave
    // them three explicit 401s, the next confirm needs to read as the dead end it is).
    if (reason === 'expired') {
      const pairingId = cleared.pairingId
      const timer = setTimeout(() => this.expiredTombstones.delete(pairingId), EXPIRED_TOMBSTONE_TTL_MS)
      this.expiredTombstones.set(pairingId, { pairingId, timer })
    }
    this.callbacks.onIncomingPairChange(null)
  }
}

function toJsonResponse(res: ServerResponse<IncomingMessage>, statusCode: number, payload: unknown): void {
  if (res.headersSent) return
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(JSON.stringify(payload))
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const MAX_BODY_BYTES = 8 * 1024
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new Error('Pair body too large.')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) throw new Error('Empty body.')
  return JSON.parse(text) as T
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// §Pillar 4. Extract just the host (IP) from a stored pending `hostUrl` so a fresh pair-request can
// be matched to the host that started the current pending. Returns null on a malformed URL.
function parsePendingHostAddress(hostUrl: string): string | null {
  try {
    return new URL(hostUrl).hostname || null
  } catch {
    return null
  }
}
