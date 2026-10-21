import { createHash } from 'node:crypto'
import type { StratumStatus } from '../../types/stratum.ts'
import { discoverStratum, parseStratumManifest, verifyStratumCapabilities, StratumVerificationError, type StratumManifest } from './stratumDiscovery.ts'
import { createStratumTransport, type StratumTransport } from './stratumTransport.ts'
import type { StratumProofAuthentication } from './stratumProofClient.ts'
import { StratumProofSession } from './stratumProofSession.ts'

export const STRATUM_SETTINGS_KEY = 'stratum_connections_v1'
interface Source { binding: string; enabled: boolean }
interface Saved { binding: string; manifest: StratumManifest }
interface Candidate { binding: string; manifest: StratumManifest; endpoint: string }
interface Dependencies {
  source(id: number): Source | null
  credentials(id: number): Promise<{ username: string; password: string }>
  radios(id: number, signal: AbortSignal): Promise<unknown[]>
  read(): string | null | undefined
  write(value: string): Promise<unknown>
  changed(status: StratumStatus): void
  transport?: typeof createStratumTransport
}

/** Bind approval to the saved server/account/credential generation, never just a numeric id. */
export function stratumSourceBinding(source: { base_url: string; username: string; secret_encrypted: string; created_at: number }): string {
  return createHash('sha256').update(JSON.stringify([source.base_url, source.username, source.secret_encrypted, source.created_at])).digest('hex')
}

function equal(a: StratumManifest, b: StratumManifest): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function cancelled(): Error { return new Error('The Stratum connection changed. Try again.') }

/** Main-process settings, discovery and session ownership. No bearer or password leaves this class. */
export class StratumConnections {
  private readonly deps: Dependencies
  private readonly candidates = new Map<number, Candidate>()
  private readonly statuses = new Map<number, StratumStatus>()
  private readonly controllers = new Map<number, AbortController>()
  private readonly sessions = new Map<number, StratumProofSession>()
  private readonly connecting = new Map<number, Promise<StratumProofSession>>()
  private readonly checks = new Map<number, Promise<StratumStatus>>()
  private readonly enabling = new Map<number, Promise<StratumStatus>>()
  private readonly cachedConnections = new Map<number, { connection: StratumProofAuthentication; scope: string }>()
  private writes: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(deps: Dependencies) { this.deps = deps }

  private source(id: number): Source {
    if (this.closed || !Number.isSafeInteger(id) || id < 1) throw new Error('Invalid Stratum server.')
    const source = this.deps.source(id)
    if (!source) throw new Error('This server no longer exists.')
    return source
  }

  private savedAll(): Record<string, Saved> {
    try {
      const raw = this.deps.read()
      if (!raw || raw.length > 1024 * 1024) return {}
      const value = JSON.parse(raw)
      const result: Record<string, Saved> = {}
      for (const [id, item] of Object.entries(value)) {
        const saved = item as Saved
        if (/^[1-9]\d*$/.test(id) && saved && /^[a-f0-9]{64}$/.test(saved.binding)) {
          result[id] = { binding: saved.binding, manifest: parseStratumManifest(saved.manifest) }
        }
      }
      return result
    } catch { return {} }
  }

  private saved(id: number): Saved | undefined {
    const saved = this.savedAll()[id]
    return saved?.binding === this.source(id).binding ? saved : undefined
  }

  status(id: number): StratumStatus {
    const source = this.source(id)
    const saved = this.saved(id)
    const current = this.statuses.get(id)
    if (current) return { ...current, enabled: !!saved }
    return { sourceId: id, enabled: !!saved, state: saved ? 'enabled' : 'unchecked',
      endpoint: saved?.manifest.endpoints[0].url ?? null,
      error: source.enabled ? null : 'Turn on this server to use Stratum.' }
  }

  private publish(id: number, state: StratumStatus['state'], endpoint: string | null, error: string | null = null): StratumStatus {
    const status: StratumStatus = { sourceId: id, enabled: !!this.saved(id), state, endpoint, error }
    this.statuses.set(id, status)
    this.deps.changed(status)
    return status
  }

  private controller(id: number): AbortController {
    let controller = this.controllers.get(id)
    if (!controller) { controller = new AbortController(); this.controllers.set(id, controller) }
    return controller
  }

  private assertCurrent(id: number, binding: string, signal: AbortSignal): void {
    signal.throwIfAborted()
    const source = this.source(id)
    if (!source.enabled || source.binding !== binding) throw cancelled()
  }

  private async announcement(id: number, signal: AbortSignal): Promise<StratumManifest | null> {
    let radios: unknown[]
    try { radios = await this.deps.radios(id, signal) }
    catch { throw new Error('Could not check Navidrome for Stratum. Check the server connection and try again.') }
    signal.throwIfAborted()
    return discoverStratum(radios)
  }

  private async verified(manifest: StratumManifest, signal: AbortSignal): Promise<StratumTransport> {
    let failure = new Error('None of Sidecar’s addresses could be reached.')
    for (const endpoint of manifest.endpoints) {
      signal.throwIfAborted()
      const transport = (this.deps.transport ?? createStratumTransport)(endpoint, manifest.spkiSha256)
      try {
        const result = await transport.request('/access/v1/capabilities', 'GET',
          AbortSignal.any([signal, AbortSignal.timeout(4000)]), undefined, undefined, 16 * 1024)
        verifyStratumCapabilities(result.bytes, manifest)
        // Every later capabilities check (including session login and playback open)
        // rechecks the installation. Credentials only follow this verified result.
        return { endpoint: transport.endpoint, request: async (...args) => {
          const response = await transport.request(...args)
          if (args[0] === '/access/v1/capabilities') verifyStratumCapabilities(response.bytes, manifest)
          return response
        } }
      } catch (error) {
        failure = error instanceof Error ? error : failure
        if (failure instanceof StratumVerificationError) throw failure
      }
    }
    throw failure
  }

  discover(id: number): Promise<StratumStatus> {
    const existing = this.checks.get(id)
    if (existing) return existing
    const pending = this.check(id)
    this.checks.set(id, pending)
    void pending.finally(() => { if (this.checks.get(id) === pending) this.checks.delete(id) }).catch(() => {})
    return pending
  }

  private async check(id: number): Promise<StratumStatus> {
    const source = this.source(id)
    if (!source.enabled) return this.status(id)
    const controller = this.controller(id)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
    this.publish(id, 'checking', this.status(id).endpoint)
    try {
      const manifest = await this.announcement(id, signal)
      this.assertCurrent(id, source.binding, signal)
      const saved = this.saved(id)
      if (saved && (!manifest || !equal(saved.manifest, manifest))) {
        throw new StratumVerificationError('The Stratum announcement changed. Turn Stratum off, check again, then enable it to use the new connection.')
      }
      if (!manifest) { this.candidates.delete(id); return this.publish(id, 'unavailable', null) }
      const transport = await this.verified(manifest, signal)
      this.assertCurrent(id, source.binding, signal)
      this.candidates.set(id, { binding: source.binding, manifest, endpoint: transport.endpoint })
      return this.publish(id, saved ? 'enabled' : 'available', transport.endpoint)
    } catch (error) {
      if (controller.signal.aborted || this.deps.source(id)?.binding !== source.binding) throw cancelled()
      this.candidates.delete(id)
      // Rechecking an unreachable endpoint must not interrupt already playing
      // audio. An identity/configuration change, however, cancels pending logins too.
      if (error instanceof StratumVerificationError) this.invalidate(id)
      return this.publish(id, 'error', null, error instanceof Error ? error.message : 'Could not check Stratum.')
    }
  }

  private persist(id: number, value: Saved | undefined, validate: () => void): Promise<void> {
    const write = this.writes.then(async () => {
      validate()
      const all = this.savedAll()
      if (value) all[id] = value
      else delete all[id]
      await this.deps.write(JSON.stringify(all))
    })
    this.writes = write.catch(() => {})
    return write
  }

  async setEnabled(id: number, enabled: boolean): Promise<StratumStatus> {
    if (enabled !== true) return this.updateEnabled(id, enabled)
    const existing = this.enabling.get(id)
    if (existing) return existing
    const pending = this.updateEnabled(id, enabled)
    this.enabling.set(id, pending)
    try { return await pending }
    finally { if (this.enabling.get(id) === pending) this.enabling.delete(id) }
  }

  private async updateEnabled(id: number, enabled: boolean): Promise<StratumStatus> {
    if (typeof enabled !== 'boolean') throw new Error('Invalid Stratum setting.')
    const source = this.source(id)
    if (!enabled) {
      this.invalidate(id)
      await this.persist(id, undefined, () => { this.source(id) })
      return this.publish(id, 'unchecked', null)
    }
    if (!source.enabled) throw new Error('Turn on this server before enabling Stratum.')
    if (this.saved(id)) return this.status(id)
    const candidate = this.candidates.get(id)
    if (!candidate || candidate.binding !== source.binding) throw new Error('Check for Stratum before enabling it.')
    const controller = this.controller(id)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
    let session: StratumProofSession | undefined
    try {
      const manifest = await this.announcement(id, signal)
      if (!manifest || !equal(candidate.manifest, manifest)) throw new Error('The Stratum announcement changed. Check again before enabling it.')
      const transport = await this.verified(manifest, signal)
      session = this.makeSession(id, source.binding, controller.signal, transport)
      await session.getBearer(signal)
      this.assertCurrent(id, source.binding, signal)
      await this.persist(id, { binding: source.binding, manifest }, () => this.assertCurrent(id, source.binding, signal))
      this.assertCurrent(id, source.binding, signal)
      void this.sessions.get(id)?.close()
      this.sessions.set(id, session)
      return this.publish(id, 'enabled', transport.endpoint)
    } catch (error) {
      void session?.close()
      if (controller.signal.aborted || this.deps.source(id)?.binding !== source.binding) throw cancelled()
      return this.publish(id, 'error', candidate.endpoint, error instanceof Error ? error.message : 'Could not enable Stratum.')
    }
  }

  private makeSession(id: number, binding: string, signal: AbortSignal, transport: StratumTransport): StratumProofSession {
    const session = new StratumProofSession(transport.endpoint, async () => {
      this.assertCurrent(id, binding, signal)
      return this.deps.credentials(id)
    }, transport)
    const close = () => { void session.close() }
    signal.addEventListener('abort', close, { once: true })
    session.signal.addEventListener('abort', () => signal.removeEventListener('abort', close), { once: true })
    if (signal.aborted) close()
    return session
  }

  /** Resolve local approval without contacting either server. A retained interval
   * needs no network; every cache miss still goes through verified session setup. */
  cachedConnection(id: number): { connection: StratumProofAuthentication; scope: string } | null {
    const source = this.source(id)
    const saved = this.saved(id)
    if (!source.enabled || !saved) return null
    const scope = createHash('sha256').update(JSON.stringify([id, saved.binding, saved.manifest])).digest('hex')
    const previous = this.cachedConnections.get(id)
    if (previous?.scope === scope && !previous.connection.signal.aborted) return previous
    const signal = this.controller(id).signal
    const current = async (requestSignal: AbortSignal) => {
      this.assertCurrent(id, saved.binding, signal)
      const connection = await this.connection(id, AbortSignal.any([signal, requestSignal]))
      if (!connection) throw cancelled()
      return connection
    }
    const result: { connection: StratumProofAuthentication; scope: string } = {
      scope,
      connection: {
        endpoint: saved.manifest.endpoints[0].url, signal,
        getBearer: async requestSignal => (await current(requestSignal)).getBearer(requestSignal),
        request: async (...args) => (await current(args[2])).request!(...args),
        reject: () => this.sessions.get(id)?.reject()
      }
    }
    this.cachedConnections.set(id, result)
    return result
  }

  async connection(id: number, signal: AbortSignal): Promise<StratumProofSession | null> {
    const source = this.source(id)
    const saved = this.saved(id)
    if (!source.enabled || !saved) return null
    signal.throwIfAborted()
    const current = this.sessions.get(id)
    if (current && !current.signal.aborted) return current
    let pending = this.connecting.get(id)
    if (!pending) {
      pending = this.connect(id, saved)
      this.connecting.set(id, pending)
      const captured = pending
      void pending.finally(() => { if (this.connecting.get(id) === captured) this.connecting.delete(id) }).catch(() => {})
    }
    return new Promise((resolve, reject) => {
      const abort = () => reject(cancelled())
      signal.addEventListener('abort', abort, { once: true })
      pending!.then(value => { if (signal.aborted) reject(cancelled()); else resolve(value) }, reject)
        .finally(() => signal.removeEventListener('abort', abort))
      if (signal.aborted) abort()
    })
  }

  private async connect(id: number, saved: Saved): Promise<StratumProofSession> {
    const controller = this.controller(id)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
    let session: StratumProofSession | undefined
    try {
      const manifest = await this.announcement(id, signal)
      if (!manifest || !equal(saved.manifest, manifest)) {
        throw new Error('The Stratum announcement changed. Turn Stratum off and check its connection again.')
      }
      const transport = await this.verified(manifest, signal)
      this.assertCurrent(id, saved.binding, signal)
      session = this.makeSession(id, saved.binding, controller.signal, transport)
      await session.getBearer(signal)
      this.assertCurrent(id, saved.binding, signal)
      if (!this.saved(id)) throw cancelled()
      this.sessions.set(id, session)
      this.publish(id, 'enabled', transport.endpoint)
      return session
    } catch (error) {
      void session?.close()
      if (!controller.signal.aborted && this.deps.source(id)?.binding === saved.binding) {
        this.publish(id, 'error', null, error instanceof Error ? error.message : 'Could not connect to Stratum.')
      }
      throw error
    }
  }

  playbackFailed(id: number): void {
    if (this.deps.source(id) && this.saved(id)) {
      this.publish(id, 'error', this.status(id).endpoint, 'Stratum could not prepare this track. Astra is using the server’s usual streaming.')
    }
  }

  playbackStarted(id: number): void {
    const session = this.sessions.get(id)
    if (session && !session.signal.aborted && this.saved(id) && this.statuses.get(id)?.state === 'error') {
      this.publish(id, 'enabled', session.endpoint)
    }
  }

  invalidate(id: number): void {
    this.cachedConnections.delete(id)
    this.controllers.get(id)?.abort()
    this.controllers.delete(id)
    void this.sessions.get(id)?.close()
    this.sessions.delete(id)
    this.connecting.delete(id)
    this.checks.delete(id)
    this.enabling.delete(id)
    this.candidates.delete(id)
    this.statuses.delete(id)
  }

  close(): void {
    this.closed = true
    for (const id of this.controllers.keys()) this.invalidate(id)
  }
}
