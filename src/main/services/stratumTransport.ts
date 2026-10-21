import { Agent, request } from 'node:https'
import { connect } from 'node:tls'
import { createHash, X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import type { AudioTransferEvent } from './automaticStreamingQuality.ts'
import { StratumProofError } from './stratumProofTransport.ts'
import { stratumEndpoint, StratumVerificationError, type StratumEndpoint } from './stratumDiscovery.ts'

export type StratumRequest = (path: string, method: 'GET' | 'POST' | 'DELETE', signal: AbortSignal,
  body?: unknown, bearer?: string, limit?: number, observe?: (event: AudioTransferEvent) => void
) => Promise<{ bytes: Buffer; type: string }>
export interface StratumTransport { endpoint: string; request: StratumRequest }

/** Each request establishes the advertised trust BEFORE handing a socket to HTTP.
 * Direct pinning is scoped to this socket; proxy endpoints retain CA/hostname checks.
 * There are no redirects, ambient proxies, cookies, TLS sessions or global overrides.
 */
export function createStratumTransport(target: StratumEndpoint, spkiSha256: string): StratumTransport {
  const endpoint = stratumEndpoint(target.url)
  if (!['sidecar_key', 'https_proxy'].includes(target.trust) || !/^[a-f0-9]{64}$/.test(spkiSha256)) {
    throw new Error('Invalid Sidecar trust settings.')
  }
  return { endpoint, request: async (path, method, signal, body, bearer, limit = 64 * 1024, observe) => {
    if (!/^\/(?:access|audio)\/v1\/[a-zA-Z0-9/_-]+$/.test(path)
      || (bearer !== undefined && !/^[a-f0-9]{64}$/.test(bearer))) throw new Error('Invalid Stratum request.')
    signal.throwIfAborted()
    const url = new URL(`${endpoint}/stratum${path}`)
    const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 })
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    let trustError: Error | undefined
    agent.createConnection = (_options, callback) => {
      let handedOff = false
      const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 443),
        servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
        rejectUnauthorized: target.trust === 'https_proxy', minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] })
      const abort = () => socket.destroy(new Error('Stratum connection cancelled.'))
      combined.addEventListener('abort', abort, { once: true })
      socket.once('close', () => combined.removeEventListener('abort', abort))
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
        if (combined.aborted) { abort(); return }
        // Do not return the socket synchronously: HTTP must wait for this callback.
        handedOff = true
        callback?.(null, socket)
      })
      if (combined.aborted) abort()
      return undefined
    }
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
          error ? reject(error) : resolve(value!)
        }
        const req = request(url, { method, agent, signal: combined, headers: {
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {})
        } }, response => {
          if (![200, 201, 204].includes(response.statusCode ?? 0)) {
            finish(new StratumProofError(response.statusCode ?? 0)); response.destroy(); return
          }
          const chunks: Buffer[] = []
          let length = 0
          transferring = true
          const totalBytes = Number(response.headers['content-length'])
          observe?.({ phase: 'start', ...(Number.isSafeInteger(totalBytes) && totalBytes > 0 && totalBytes <= limit ? { totalBytes } : {}) })
          response.on('data', (chunk: Buffer) => {
            length += chunk.length
            observe?.({ phase: 'data', bytes: chunk.length })
            if (length > limit) { finish(new Error('Stratum response exceeded its size limit.')); response.destroy() }
            else chunks.push(chunk)
          })
          response.on('error', () => finish(new Error('Stratum response was interrupted.')))
          response.on('end', () => finish(undefined, { bytes: Buffer.concat(chunks), type: String(response.headers['content-type'] ?? '').split(';')[0] }))
        })
        const timer = setTimeout(() => {
          finish(new Error('Sidecar took too long to respond.')); controller.abort()
        }, 12_000)
        timer.unref()
        req.on('error', () => finish(trustError ?? new Error(combined.aborted ? 'Stratum connection was cancelled.'
          : 'Could not connect securely to Sidecar. Check its address and certificate.')))
        req.end(bytes)
      })
    } finally { controller.abort(); agent.destroy() }
  } }
}
