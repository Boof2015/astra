import { Agent, request } from 'node:https'
import type { RequestOptions } from 'node:https'
import type { Duplex } from 'node:stream'
import { connect } from 'node:tls'
import { createHash, X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import type { AudioTransferEvent } from './automaticStreamingQuality.ts'
import { StratumProofError } from './stratumProofTransport.ts'
import { stratumEndpoint, StratumVerificationError, type StratumEndpoint } from './stratumDiscovery.ts'
import { StratumNetworkError, stratumAborted, stratumConnectionFailure, stratumRequestTimeout, stratumRequestStage, stratumTimeoutContext } from './stratumNetwork.ts'

export type StratumRequest = (path: string, method: 'GET' | 'POST' | 'DELETE', signal: AbortSignal,
  body?: unknown, bearer?: string, limit?: number, observe?: (event: AudioTransferEvent) => void
) => Promise<{ bytes: Buffer; type: string }>
export interface StratumTransport { endpoint: string; request: StratumRequest; close?: () => void }

// Sidecar bounds installed sockets to 60 seconds. Retire before even a 30-second
// control request could hit that limit. Idle sockets are kept for only 5 seconds.
const REUSE_AGE_MS = 20_000
const MAX_REQUESTS = 3

/** Admission includes TLS handshakes, which an asynchronous Agent connection
 * factory has not added to its socket count yet. No requests queue inside Agent:
 * this also keeps each new connection's cancellation tied to its own request. */
class RequestSlots {
  private active = 0
  private waiting: (() => void)[] = []
  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiting = this.waiting.filter(waiter => waiter !== enter)
        reject(stratumAborted(signal))
      }
      const enter = () => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) { abort(); this.waiting.shift()?.(); return }
        this.active++
        resolve(() => { this.active--; this.waiting.shift()?.() })
      }
      if (signal.aborted) { abort(); return }
      if (this.active < MAX_REQUESTS) enter()
      else { this.waiting.push(enter); signal.addEventListener('abort', abort, { once: true }) }
    })
  }
}
type ConnectionOptions = RequestOptions & { stratumSignal: AbortSignal }

/** Each new connection establishes advertised trust BEFORE giving HTTP a socket.
 * Direct pinning is scoped to this socket; proxy endpoints retain CA/hostname checks.
 * There are no redirects, ambient proxies, cookies, TLS sessions or global overrides.
 */
export function createStratumTransport(target: StratumEndpoint, spkiSha256: string): StratumTransport {
  const endpoint = stratumEndpoint(target.url)
  if (!['sidecar_key', 'https_proxy'].includes(target.trust) || !/^[a-f0-9]{64}$/.test(spkiSha256)) {
    throw new Error('Invalid Sidecar trust settings.')
  }
  const origin = new URL(endpoint)
  const host = origin.hostname.replace(/^\[|\]$/g, '')
  const stopped = new AbortController()
  const slots = new RequestSlots()
  const born = new WeakMap<Duplex, number>()
  const agent = new Agent({ keepAlive: true, maxCachedSessions: 0, maxFreeSockets: MAX_REQUESTS,
    maxSockets: Infinity, timeout: 5000, scheduling: 'lifo' })
  const keep = agent.keepSocketAlive.bind(agent)
  agent.keepSocketAlive = socket => performance.now() - born.get(socket)! < REUSE_AGE_MS && keep(socket)
  agent.createConnection = (options, callback) => {
    const signal = (options as ConnectionOptions).stratumSignal
    let handedOff = false
    let trustError: Error | undefined
    const socket = connect({ host, port: Number(origin.port || 443),
      servername: isIP(host) ? undefined : host,
      rejectUnauthorized: target.trust === 'https_proxy', minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] })
    born.set(socket, performance.now())
    const abort = () => socket.destroy(new Error('Stratum connection cancelled.'))
    signal.addEventListener('abort', abort, { once: true })
    socket.once('close', () => signal.removeEventListener('abort', abort))
    socket.once('error', error => { if (!handedOff) { handedOff = true; callback?.(trustError ?? error, socket) } })
    socket.once('secureConnect', () => {
      if (target.trust === 'sidecar_key') {
        try {
          const key = new X509Certificate(socket.getPeerCertificate().raw).publicKey.export({ type: 'spki', format: 'der' })
          if (createHash('sha256').update(key).digest('hex') !== spkiSha256) throw new Error()
        } catch {
          trustError = new StratumVerificationError('Sidecar’s identity does not match its announcement. Check its discovery settings.')
          socket.destroy(trustError)
          return
        }
      }
      if (signal.aborted) { abort(); return }
      // HTTP owns cancellation after handoff. An old request's signal must never
      // destroy this socket after it has been reused by a different request.
      signal.removeEventListener('abort', abort)
      handedOff = true
      callback?.(null, socket)
    })
    if (signal.aborted) abort()
    // HTTP cannot write credentials until the verification callback succeeds.
    return undefined
  }
  return { endpoint, close: () => { stopped.abort(); agent.destroy() },
    request: async (path, method, signal, body, bearer, limit = 64 * 1024, observe) => {
    if (!/^\/(?:access|audio)\/v1\/[a-zA-Z0-9/_-]+$/.test(path)
      || (bearer !== undefined && !/^[a-f0-9]{64}$/.test(bearer))) throw new Error('Invalid Stratum request.')
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal, stopped.signal])
    combined.throwIfAborted()
    const release = await slots.acquire(combined)
    const url = new URL(`${endpoint}/stratum${path}`)
    // Prune only idle sockets: active transfers keep their existing deadline.
    for (const sockets of Object.values(agent.freeSockets)) {
      for (const socket of sockets ?? []) if (performance.now() - born.get(socket)! >= REUSE_AGE_MS) socket.destroy()
    }
    let secure = false
    const connectionStarted = performance.now()
    let connectedAt = connectionStarted
    try {
      return await new Promise<{ bytes: Buffer; type: string }>((resolve, reject) => {
        const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
        let settled = false
        let transferring = false
        const finish = (error?: Error, value?: { bytes: Buffer; type: string }) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (transferring) observe?.({ phase: 'end', complete: !error })
          error ? reject(stratumTimeoutContext(error, secure ? stratumRequestStage(path) : 'secure')) : resolve(value!)
        }
        const options: ConnectionOptions = { method, agent, signal: combined, stratumSignal: combined, headers: {
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {})
        } }
        const req = request(url, options, response => {
          if (![200, 201, 204].includes(response.statusCode ?? 0)) {
            finish(new StratumProofError(response.statusCode ?? 0)); response.destroy(); return
          }
          const chunks: Buffer[] = []
          let length = 0
          transferring = true
          const totalBytes = Number(response.headers['content-length'])
          observe?.({ phase: 'start', connectionMs: Math.max(0, connectedAt - connectionStarted),
            responseWaitMs: Math.max(0, performance.now() - connectedAt),
            ...(Number.isSafeInteger(totalBytes) && totalBytes > 0 && totalBytes <= limit ? { totalBytes } : {}) })
          response.on('data', (chunk: Buffer) => {
            length += chunk.length
            observe?.({ phase: 'data', bytes: chunk.length })
            if (length > limit) { finish(new Error('Stratum response exceeded its size limit.')); response.destroy() }
            else chunks.push(chunk)
          })
          response.on('error', () => finish(combined.aborted ? stratumAborted(combined) : new StratumNetworkError('interrupted')))
          response.on('end', () => finish(undefined, { bytes: Buffer.concat(chunks), type: String(response.headers['content-type'] ?? '').split(';')[0] }))
        })
        const timer = setTimeout(() => {
          finish(new StratumNetworkError('timeout')); controller.abort()
        }, stratumRequestTimeout(path))
        timer.unref()
        req.on('socket', () => { secure = true; connectedAt = req.reusedSocket ? connectionStarted : performance.now() })
        req.on('error', error => finish(error instanceof StratumVerificationError ? error
          : combined.aborted ? stratumAborted(combined) : stratumConnectionFailure(error, secure)))
        req.end(bytes)
      })
    } finally { release() }
  } }
}
