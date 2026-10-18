import { createHash, randomBytes } from 'node:crypto'
import type { StratumProofAuthentication } from './stratumProofClient.ts'
import { stratumProofRequest, validateStratumProofEndpoint } from './stratumProofTransport.ts'

interface SignIn { username: string; password: string }
interface Lease { token: string; expires: number; renewAt: number }

function responseJson(bytes: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(bytes.toString())
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch { /* Untrusted response bodies must not appear in errors. */ }
  throw new Error('Invalid Stratum session response.')
}

function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error && signal.reason.name !== 'AbortError'
      ? signal.reason : new Error('Stratum playback was cancelled.'))
    signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Disposable main-process connection owner. Current/next/seek clients share it.
 * Closing a playback does not close this owner; disabling its source must do so.
 * Production settings integration waits for owner pairing and protected transport.
 */
export class StratumProofSession implements StratumProofAuthentication {
  readonly endpoint: string
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private readonly credentials: () => Promise<SignIn>
  private lease?: Lease
  private username?: string
  private pending?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private cleanup?: Promise<void>

  constructor(endpoint: string, credentials: () => Promise<SignIn>) {
    this.endpoint = validateStratumProofEndpoint(endpoint)
    this.credentials = credentials
  }

  async getBearer(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    this.signal.throwIfAborted()
    if (this.lease && performance.now() >= this.lease.expires) {
      this.reject()
      throw new Error('The Stratum test sign-in expired. Reconnect to start another session.')
    }
    if (this.pending || !this.lease || performance.now() >= this.lease.renewAt) {
      await waitFor(this.refresh(), AbortSignal.any([signal, this.signal]))
    }
    signal.throwIfAborted()
    this.signal.throwIfAborted()
    return this.lease!.token
  }

  private refresh(): Promise<void> {
    if (this.pending) return this.pending
    const pending = this.exchange().catch(error => { void this.stop(error); throw error })
    this.pending = pending
    void pending.then(() => { if (this.pending === pending) this.pending = undefined },
      () => { if (this.pending === pending) this.pending = undefined })
    return pending
  }

  private async exchange(): Promise<void> {
    this.signal.throwIfAborted()
    const old = this.lease
    if (old && performance.now() >= old.expires) throw new Error('The Stratum test sign-in expired.')
    // One bounded attempt. A failed renewal ends this experimental connection;
    // it never silently creates a different session underneath old handles.
    const remaining = old ? Math.max(1, Math.ceil(old.expires - performance.now())) : 12000
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(Math.min(12000, remaining))])
    if (!old) {
      const result = await stratumProofRequest(this.endpoint, '/access/v1/capabilities', 'GET', signal, undefined, undefined, 4096)
      const value = responseJson(result.bytes)
      if (value.protocol !== 'stratum-access-proof-1' || value.audioExperiment !== 'stratum-authenticated-audio-1'
        || value.authentication !== 'subsonic-token' || value.sessionRenewal !== 'fresh-credentials-same-user') {
        throw new Error('This Stratum proof does not support renewable sessions.')
      }
    }
    let signIn: SignIn
    try { signIn = await waitFor(this.credentials(), signal) }
    catch { throw new Error('Could not read the disposable Navidrome sign-in.') }
    if (!signIn || typeof signIn.username !== 'string' || !signIn.username || signIn.username.trim() !== signIn.username
      || Buffer.byteLength(signIn.username) > 128 || /\p{Cc}/u.test(signIn.username)
      || typeof signIn.password !== 'string' || !signIn.password || signIn.password.length > 4096
      || (this.username !== undefined && signIn.username !== this.username)) {
      throw new Error('The disposable Navidrome sign-in changed or is invalid. Reconnect first.')
    }
    signal.throwIfAborted()
    const salt = randomBytes(16).toString('hex')
    const credential = { username: signIn.username, salt,
      token: createHash('md5').update(signIn.password + salt).digest('hex') }
    const started = performance.now()
    const result = await stratumProofRequest(this.endpoint, old ? '/access/v1/session' : '/access/v1/sessions',
      'POST', signal, credential, old?.token, 4096)
    const value = responseJson(result.bytes)
    if (typeof value.session !== 'string' || !/^[a-f0-9]{64}$/.test(value.session)
      || (old && value.session !== old.token) || typeof value.expiresInSeconds !== 'number' || !Number.isSafeInteger(value.expiresInSeconds)
      || value.expiresInSeconds < 1 || value.expiresInSeconds > 600) {
      throw new Error('Invalid Stratum session response.')
    }
    const ttl = value.expiresInSeconds * 1000
    this.lease = { token: value.session, expires: started + ttl, renewAt: started + ttl / 2 }
    this.username = credential.username
    if (signal.aborted || performance.now() >= this.lease.expires) {
      // Covers close/expiry racing a completed exchange. Never publish that lease.
      this.cleanup = undefined
      this.reject()
      throw new Error('The Stratum test sign-in ended while connecting.')
    }
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.refresh().catch(() => {}) }, Math.max(1, this.lease.renewAt - performance.now()))
    this.timer.unref()
  }

  reject(): void { void this.close() }

  close(): Promise<void> {
    return this.stop(new Error('The Stratum test connection has ended.'))
  }

  private stop(reason: Error): Promise<void> {
    this.controller.abort(reason)
    clearTimeout(this.timer)
    this.cleanup ??= this.lease
      ? stratumProofRequest(this.endpoint, '/access/v1/session', 'DELETE', AbortSignal.timeout(1500),
        undefined, this.lease.token).then(() => {}, () => {})
      : Promise.resolve()
    return this.cleanup
  }
}
