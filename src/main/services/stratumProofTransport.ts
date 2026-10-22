import { request as httpRequest } from 'node:http'
import type { AudioTransferEvent } from './automaticStreamingQuality.ts'
import { StratumNetworkError, stratumAborted, stratumRequestTimeout, stratumRequestStage, stratumTimeoutContext } from './stratumNetwork.ts'

/** Disposable loopback only. Pairing/TLS must precede any remote credential use. */
export function validateStratumProofEndpoint(endpoint: string): string {
  let url: URL
  try { url = new URL(endpoint) } catch { throw new Error('Invalid Stratum proof endpoint.') }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Stratum proof requires a literal loopback endpoint.')
  }
  return url.origin
}

export class StratumProofError extends Error {
  readonly status: number
  constructor(status: number) {
    super(status === 401 ? 'The Stratum sign-in expired or was refused.'
      : status === 404 ? 'This track or playback is no longer available through Stratum.'
      : status === 415 ? 'This source format is not supported by the Stratum proof.'
      : status === 429 ? 'The Stratum proof is busy. Try again.'
      : status === 503 ? 'Stratum cannot reach Navidrome.'
      : `The Stratum proof request failed (HTTP ${status}).`)
    this.status = status
  }
}

/** Access or format refusals that asking again (at any quality) cannot fix. */
export function isStratumRefusal(error: unknown): error is StratumProofError {
  return error instanceof StratumProofError && [401, 403, 404, 415].includes(error.status)
}

/** No proxies, redirects, cookies or raw upstream error text. */
export async function stratumProofRequest(endpoint: string, path: string, method: 'GET' | 'POST' | 'DELETE',
  signal: AbortSignal, body?: unknown, bearer?: string, limit = 64 * 1024,
  observe?: (event: AudioTransferEvent) => void): Promise<{ bytes: Buffer; type: string }> {
  const origin = validateStratumProofEndpoint(endpoint)
  if (!/^\/(?:access|audio)\/v1\/[a-zA-Z0-9/_-]+$/.test(path)
    || (bearer !== undefined && !/^[a-f0-9]{64}$/.test(bearer))) throw new Error('Invalid Stratum proof request.')
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    let settled = false
    let transferring = false
    const finish = (error?: Error, result?: { bytes: Buffer; type: string }) => {
      if (settled) return
      settled = true
      if (transferring) observe?.({ phase: 'end', complete: !error })
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (error) reject(stratumTimeoutContext(error, stratumRequestStage(path)))
      else resolve(result!)
    }
    const req = httpRequest(new URL(path, origin), {
      method, agent: false, headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {})
      }
    }, response => {
      if (![200, 201, 204].includes(response.statusCode ?? 0)) {
        finish(new StratumProofError(response.statusCode ?? 0))
        response.destroy()
        return
      }
      const chunks: Buffer[] = []
      transferring = true
      const totalBytes = Number(response.headers['content-length'])
      observe?.({ phase: 'start', ...(Number.isSafeInteger(totalBytes) && totalBytes > 0 && totalBytes <= limit ? { totalBytes } : {}) })
      let length = 0
      response.on('data', (chunk: Buffer) => {
        length += chunk.length
        observe?.({ phase: 'data', bytes: chunk.length })
        if (length > limit) {
          finish(new Error('Stratum proof response exceeded its size limit.'))
          response.destroy()
        } else chunks.push(chunk)
      })
      response.on('error', () => finish(new Error('Stratum proof response was interrupted.')))
      response.on('end', () => finish(undefined, { bytes: Buffer.concat(chunks),
        type: String(response.headers['content-type'] ?? '').split(';')[0] }))
    })
    const abort = () => { finish(stratumAborted(signal)); req.destroy() }
    const timer = setTimeout(() => { finish(new StratumNetworkError('timeout')); req.destroy() }, stratumRequestTimeout(path))
    timer.unref()
    req.on('error', () => finish(new Error('Could not connect to the Stratum proof.')))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    req.end(bytes)
  })
}
