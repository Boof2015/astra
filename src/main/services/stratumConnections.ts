import { createHash, randomUUID } from 'node:crypto'
import type { StratumManualCheck, StratumStatus } from '../../types/stratum.ts'
import { inspectManualSidecar } from './stratumManual.ts'
import { discoverStratum, parseStratumManifest, verifyStratumCapabilities, StratumVerificationError, type StratumManifest } from './stratumDiscovery.ts'
import { createStratumTransport, type StratumTransport } from './stratumTransport.ts'
import type { StratumProofAuthentication } from './stratumProofClient.ts'
import { StratumProofSession } from './stratumProofSession.ts'
import { StratumProofError } from './stratumProofTransport.ts'
import { STRATUM_CONNECT_TIMEOUT_MS, STRATUM_VERIFY_TIMEOUT_MS, StratumNetworkError, stratumAborted, stratumTimeoutContext } from './stratumNetwork.ts'

export const STRATUM_SETTINGS_KEY = 'stratum_connections_v1'
interface Source { binding: string; enabled: boolean }
interface Saved { binding: string; manifest: StratumManifest; manual?: boolean; enabled?: boolean }
interface Candidate { binding: string; manifest: StratumManifest; endpoint: string }
interface ManualProposal extends Candidate { token: string; expires: number; controller: AbortController }
interface Dependencies {
  source(id: number): Source | null
  credentials(id: number): Promise<{ username: string; password: string }>
  radios(id: number, signal: AbortSignal): Promise<unknown[]>
  read(): string | null | undefined
  write(value: string): Promise<unknown>
  changed(status: StratumStatus): void
  transport?: typeof createStratumTransport
  inspectManual?: typeof inspectManualSidecar
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
  private readonly manualChecks = new Map<number, AbortController>()
  private readonly manualProposals = new Map<number, ManualProposal>()
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
          result[id] = { binding: saved.binding, manifest: parseStratumManifest(saved.manifest),
            ...(saved.manual === true ? { manual: true, enabled: saved.enabled !== false } : {}) }
        }
      }
      return result
    } catch { return {} }
  }

  private saved(id: number): Saved | undefined {
    const saved = this.savedAll()[id]
    return saved?.binding === this.source(id).binding ? saved : undefined
  }

  private enabled(id: number): boolean { const saved = this.saved(id); return !!saved && saved.enabled !== false }

  status(id: number): StratumStatus {
    const source = this.source(id)
    const saved = this.saved(id)
    const current = this.statuses.get(id)
    if (current) return { ...current, enabled: this.enabled(id) }
    return { sourceId: id, enabled: this.enabled(id), state: saved ? saved.enabled === false ? 'available' : 'enabled' : 'unchecked',
      connection: saved ? saved.manual ? 'manual' : 'discovery' : null,
      endpoint: saved?.manifest.endpoints[0].url ?? null,
      error: source.enabled ? null : 'Turn on this server to use Stratum.' }
  }

  private publish(id: number, state: StratumStatus['state'], endpoint: string | null, error: string | null = null): StratumStatus {
    const saved = this.saved(id)
    const status: StratumStatus = { sourceId: id, enabled: this.enabled(id), state,
      connection: saved?.manual ? 'manual' : saved || this.candidates.has(id) ? 'discovery' : null,
      endpoint: endpoint ?? (saved?.manual ? saved.manifest.endpoints[0].url : null), error }
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
    catch {
      if (signal.aborted) throw stratumTimeoutContext(signal.reason, 'discovery')
      throw new Error('Could not check Navidrome for Stratum. Check the server connection and try again.')
    }
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
          AbortSignal.any([signal, AbortSignal.timeout(STRATUM_VERIFY_TIMEOUT_MS)]), undefined, undefined, 16 * 1024)
        verifyStratumCapabilities(result.bytes, manifest)
        // The connection, its login and its playback clients share this verified
        // public snapshot. Repeating the same GET at each layer adds handshakes
        // before any audio can start. Fresh connections and explicit discovery
        // still verify afresh; every authenticated request still checks TLS trust.
        return { endpoint: transport.endpoint, close: transport.close, request: async (...args) => {
          args[2].throwIfAborted()
          if (args[0] === '/access/v1/capabilities' && args[1] === 'GET' && args[3] === undefined && args[4] === undefined) {
            if (result.bytes.length > (args[5] ?? 64 * 1024)) throw new Error('Stratum response exceeded its size limit.')
            return { ...result, bytes: Buffer.from(result.bytes) }
          }
          return transport.request(...args)
        } }
      } catch (error) {
        transport.close?.()
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
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(STRATUM_CONNECT_TIMEOUT_MS)])
    this.publish(id, 'checking', this.status(id).endpoint)
    try {
      const saved = this.saved(id)
      const manifest = saved?.manual ? saved.manifest : await this.announcement(id, signal)
      this.assertCurrent(id, source.binding, signal)
      if (saved && (!manifest || !equal(saved.manifest, manifest))) {
        throw new StratumVerificationError('The Stratum announcement changed. Turn Stratum off, check again, then enable it to use the new connection.')
      }
      if (!manifest) { this.candidates.delete(id); return this.publish(id, 'unavailable', null) }
      const transport = await this.verified(manifest, signal)
      try {
        this.assertCurrent(id, source.binding, signal)
        this.candidates.set(id, { binding: source.binding, manifest, endpoint: transport.endpoint })
        return this.publish(id, this.enabled(id) ? 'enabled' : 'available', transport.endpoint)
      } finally { transport.close?.() }
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
      const status = this.status(id)
      const saved = this.saved(id)
      // Turning playback off is not forgetting that Sidecar exists. Re-enabling
      // still verifies the current announcement and identity before signing in.
      // A failed check must instead offer discovery of the replacement server.
      const candidate = status.state !== 'error' ? this.candidates.get(id) ?? (saved ? {
        ...saved, endpoint: status.endpoint ?? saved.manifest.endpoints[0].url
      } : undefined) : undefined
      this.invalidate(id)
      const controller = this.controller(id)
      const validate = () => {
        if (controller.signal.aborted || this.source(id).binding !== source.binding) throw cancelled()
      }
      await this.persist(id, saved?.manual ? { ...saved, enabled: false } : undefined, validate)
      validate()
      if (saved?.manual) return this.publish(id, status.state === 'error' ? 'error' : 'available',
        saved.manifest.endpoints[0].url, status.state === 'error' ? status.error : null)
      if (candidate?.binding === source.binding) {
        this.candidates.set(id, candidate)
        return this.publish(id, 'available', candidate.endpoint)
      }
      return this.publish(id, 'unchecked', null)
    }
    if (!source.enabled) throw new Error('Turn on this server before enabling Stratum.')
    if (this.enabled(id)) return this.status(id)
    const saved = this.saved(id)
    const candidate = this.candidates.get(id) ?? (saved?.manual ? { ...saved, endpoint: saved.manifest.endpoints[0].url } : undefined)
    if (!candidate || candidate.binding !== source.binding) throw new Error('Check for Stratum before enabling it.')
    const controller = this.controller(id)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(STRATUM_CONNECT_TIMEOUT_MS)])
    let session: StratumProofSession | undefined
    let transport: StratumTransport | undefined
    try {
      const manifest = saved?.manual ? saved.manifest : await this.announcement(id, signal)
      if (!manifest || !equal(candidate.manifest, manifest)) throw new Error('The Stratum announcement changed. Check again before enabling it.')
      transport = await this.verified(manifest, signal)
      session = this.makeSession(id, source.binding, controller.signal, transport)
      await session.getBearer(signal)
      this.assertCurrent(id, source.binding, signal)
      await this.persist(id, { binding: source.binding, manifest, ...(saved?.manual ? { manual: true, enabled: true } : {}) },
        () => this.assertCurrent(id, source.binding, signal))
      this.assertCurrent(id, source.binding, signal)
      void this.sessions.get(id)?.close()
      this.sessions.set(id, session)
      return this.publish(id, 'enabled', transport.endpoint)
    } catch (error) {
      void session?.close()
      if (!session) transport?.close?.()
      if (controller.signal.aborted || this.deps.source(id)?.binding !== source.binding) throw cancelled()
      return this.publish(id, 'error', candidate.endpoint, error instanceof Error ? error.message : 'Could not enable Stratum.')
    }
  }

  async inspectManual(id: number, address: string): Promise<StratumManualCheck> {
    const source = this.source(id)
    if (!source.enabled) throw new Error('Turn on this server before connecting Sidecar.')
    this.manualChecks.get(id)?.abort()
    this.manualProposals.delete(id)
    const controller = new AbortController()
    this.manualChecks.set(id, controller)
    const signal = AbortSignal.any([controller.signal, this.controller(id).signal, AbortSignal.timeout(STRATUM_VERIFY_TIMEOUT_MS)])
    try {
      const { manifest, requiresTrust } = await (this.deps.inspectManual ?? inspectManualSidecar)(address, signal)
      this.assertCurrent(id, source.binding, signal)
      const endpoint = manifest.endpoints[0].url
      const saved = this.saved(id)
      const previous = saved?.manifest.endpoints.find(value => value.url === endpoint)
      const sameIdentity = !!previous && saved!.manifest.installation === manifest.installation
        && saved!.manifest.spkiSha256 === manifest.spkiSha256 && previous.trust === manifest.endpoints[0].trust
      const token = randomUUID()
      this.manualProposals.set(id, { token, binding: source.binding, manifest, endpoint,
        expires: Date.now() + 5 * 60_000, controller })
      return { token, endpoint, fingerprint: manifest.spkiSha256,
        requiresTrust: (requiresTrust && !sameIdentity) || (!!previous && !sameIdentity),
        identityChanged: !!previous && !sameIdentity }
    } catch (error) {
      if (this.manualChecks.get(id) === controller) this.manualChecks.delete(id)
      controller.abort()
      throw error
    }
  }

  /** The user accepts this exact main-owned proposal. Recheck the same identity
   * before reading credentials, and replace saved settings only after sign-in. */
  async connectManual(id: number, token: string): Promise<StratumStatus> {
    const source = this.source(id)
    const proposal = this.manualProposals.get(id)
    if (typeof token !== 'string' || !proposal || proposal.token !== token || proposal.expires < Date.now()
      || proposal.binding !== source.binding || proposal.controller.signal.aborted) {
      throw new Error('This connection check has expired. Check the address again.')
    }
    this.manualProposals.delete(id)
    const controller = proposal.controller
    const signal = AbortSignal.any([controller.signal, this.controller(id).signal, AbortSignal.timeout(STRATUM_CONNECT_TIMEOUT_MS)])
    let transport: StratumTransport | undefined
    let session: StratumProofSession | undefined
    try {
      this.assertCurrent(id, source.binding, signal)
      transport = await this.verified(proposal.manifest, signal)
      session = this.makeSession(id, source.binding, controller.signal, transport)
      await session.getBearer(signal)
      this.assertCurrent(id, source.binding, signal)
      await this.persist(id, { binding: source.binding, manifest: proposal.manifest, manual: true, enabled: true },
        () => this.assertCurrent(id, source.binding, signal))
      this.assertCurrent(id, source.binding, signal)
      // Keep the new session's controller alive while retiring the old connection.
      this.manualChecks.delete(id)
      this.invalidate(id)
      this.controllers.set(id, controller)
      this.sessions.set(id, session)
      return this.publish(id, 'enabled', transport.endpoint)
    } catch (error) {
      void session?.close()
      if (!session) transport?.close?.()
      if (this.manualChecks.get(id) === controller) this.manualChecks.delete(id)
      controller.abort()
      throw stratumTimeoutContext(error, 'setup')
    }
  }

  async forgetManual(id: number): Promise<StratumStatus> {
    const source = this.source(id)
    if (!this.saved(id)?.manual) return this.status(id)
    this.invalidate(id)
    const signal = this.controller(id).signal
    const validate = () => { if (signal.aborted || this.source(id).binding !== source.binding) throw cancelled() }
    await this.persist(id, undefined, validate)
    validate()
    this.publish(id, 'unchecked', null)
    return this.discover(id)
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
    if (!source.enabled || !saved || !this.enabled(id)) return null
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
    if (!source.enabled || !saved || !this.enabled(id)) return null
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
      const abort = () => reject(stratumTimeoutContext(stratumAborted(signal), 'setup'))
      signal.addEventListener('abort', abort, { once: true })
      pending!.then(value => { if (signal.aborted) reject(cancelled()); else resolve(value) }, reject)
        .finally(() => signal.removeEventListener('abort', abort))
      if (signal.aborted) abort()
    })
  }

  private async connect(id: number, saved: Saved): Promise<StratumProofSession> {
    const controller = this.controller(id)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(STRATUM_CONNECT_TIMEOUT_MS)])
    let session: StratumProofSession | undefined
    let transport: StratumTransport | undefined
    try {
      const manifest = saved.manual ? saved.manifest : await this.announcement(id, signal)
      if (!manifest || !equal(saved.manifest, manifest)) {
        throw new Error('The Stratum announcement changed. Turn Stratum off and check its connection again.')
      }
      transport = await this.verified(manifest, signal)
      this.assertCurrent(id, saved.binding, signal)
      session = this.makeSession(id, saved.binding, controller.signal, transport)
      await session.getBearer(signal)
      this.assertCurrent(id, saved.binding, signal)
      if (!this.enabled(id)) throw cancelled()
      this.sessions.set(id, session)
      this.publish(id, 'enabled', transport.endpoint)
      return session
    } catch (error) {
      void session?.close()
      if (!session) transport?.close?.()
      error = stratumTimeoutContext(error, 'setup')
      if (!controller.signal.aborted && this.deps.source(id)?.binding === saved.binding) {
        this.publish(id, 'error', null, error instanceof Error ? error.message : 'Could not connect to Stratum.')
      }
      throw error
    }
  }

  playbackFailed(id: number, error?: unknown): void {
    if (this.deps.source(id) && this.enabled(id)) {
      const current = this.status(id)
      // Connection setup already publishes a safe, specific reason. Do not
      // overwrite it, or expose arbitrary cache/filesystem errors to the UI.
      const reason = error instanceof StratumNetworkError || error instanceof StratumProofError || error instanceof StratumVerificationError
        ? error.message : error instanceof Error && error.name === 'TimeoutError'
          ? new StratumNetworkError('timeout').message
          : error instanceof Error && current.state === 'error' && current.error === error.message
            ? current.error : 'Stratum could not prepare this track.'
      this.publish(id, 'error', current.endpoint, `${reason} Astra is using the server’s usual streaming.`)
    }
  }

  playbackStarted(id: number): void {
    const session = this.sessions.get(id)
    if (session && !session.signal.aborted && this.enabled(id) && this.statuses.get(id)?.state === 'error') {
      this.publish(id, 'enabled', session.endpoint)
    }
  }

  invalidate(id: number): void {
    this.manualChecks.get(id)?.abort()
    this.manualChecks.delete(id)
    this.manualProposals.delete(id)
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
