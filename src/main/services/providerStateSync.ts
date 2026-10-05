import { randomUUID } from 'node:crypto'
import { compareProviderValue, providerSyncKey, resolveProviderChoice, validProviderValue } from '../../shared/sync/providerState'
import type { ProviderSyncRef, ProviderSyncTrack, ProviderUserState, ProviderSyncField, ProviderSyncValue,
  ProviderSyncReview, ProviderSyncStatus, ProviderSyncDifference, ProviderSyncChoice } from '../../types/providerSync'

export interface ProviderStateClient {
  read(ids?: string[]): Promise<Map<string, ProviderUserState>>
  write(id: string, field: ProviderSyncField, value: ProviderSyncValue): Promise<void>
}
interface Options {
  sources(): ProviderSyncRef[]
  fingerprint(ref: ProviderSyncRef): string | null
  setting(ref: ProviderSyncRef): { fingerprint: string; enabled: number } | null
  setSetting(ref: ProviderSyncRef, fingerprint: string, enabled: boolean): Promise<void>
  tracks(ref: ProviderSyncRef): ProviderSyncTrack[]
  track(ref: ProviderSyncRef, path: string): ProviderSyncTrack | undefined
  baselines(ref: ProviderSyncRef): Map<string, ProviderSyncValue>
  saveBaseline(ref: ProviderSyncRef, path: string, field: ProviderSyncField, value: ProviderSyncValue): void
  applyLocal(path: string, field: ProviderSyncField, value: ProviderSyncValue): Promise<void>
  persist(): Promise<void>
  client(ref: ProviderSyncRef, signal: AbortSignal): Promise<ProviderStateClient>
  changed(): void
}
interface Session { check(): void; client: ProviderStateClient }
const fieldKey = (path: string, field: ProviderSyncField) => JSON.stringify([path, field])
const fields = (ref: ProviderSyncRef): ProviderSyncField[] => ref.provider === 'subsonic' ? ['favorite', 'rating'] : ['favorite']
const valueOf = (state: ProviderUserState, field: ProviderSyncField): ProviderSyncValue => state[field] ?? null

/** Provider-specific transport; shared opt-in, comparison and conflict handling. */
export class ProviderStateSync {
  private readonly options: Options
  private readonly running = new Map<string, Promise<unknown>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly generations = new Map<string, number>()
  private readonly info = new Map<string, { conflicts: number; error: string | null; lastSyncAt: number | null }>()
  private readonly reviews = new Map<string, { review: ProviderSyncReview; fingerprint: string; generation: number; created: number }>()
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(options: Options) { this.options = options }

  enabled(ref: ProviderSyncRef): boolean {
    const setting = this.options.setting(ref)
    return setting?.enabled === 1 && setting.fingerprint === this.options.fingerprint(ref)
  }

  status(): ProviderSyncStatus[] {
    return this.options.sources().map(ref => ({ ...ref, enabled: this.enabled(ref),
      busy: this.running.has(providerSyncKey(ref)),
      ...(this.info.get(providerSyncKey(ref)) ?? { conflicts: 0, error: null, lastSyncAt: null }) }))
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.refreshAll(), 30_000)
    this.timer.unref()
    this.refreshAll()
  }

  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const controller of this.controllers.values()) controller.abort()
    this.reviews.clear()
  }

  refreshAll(): void {
    for (const ref of this.options.sources()) {
      if (this.enabled(ref) && !this.running.has(providerSyncKey(ref))) void this.refresh(ref).catch(() => {})
    }
  }

  async disable(ref: ProviderSyncRef): Promise<void> {
    const key = providerSyncKey(ref)
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
    this.controllers.get(key)?.abort()
    this.reviews.delete(key)
    await this.options.setSetting(ref, this.options.fingerprint(ref) ?? '', false)
    this.info.delete(key)
    this.options.changed()
  }

  private run<T>(ref: ProviderSyncRef, required: boolean, task: (session: Session) => Promise<T>): Promise<T> {
    const key = providerSyncKey(ref)
    const fingerprint = this.options.fingerprint(ref)
    const generation = this.generations.get(key) ?? 0
    const previous = this.running.get(key)
    const work = Promise.resolve(previous).catch(() => {}).then(async () => {
      const controller = new AbortController()
      this.controllers.set(key, controller)
      const check = () => {
        controller.signal.throwIfAborted()
        if (this.closed || !fingerprint || this.options.fingerprint(ref) !== fingerprint
          || (this.generations.get(key) ?? 0) !== generation || (required && !this.enabled(ref))) {
          throw new Error('Server settings changed. Review this server again.')
        }
      }
      try {
        check()
        const client = await this.options.client(ref, controller.signal)
        check()
        const result = await task({ check, client })
        const old = this.info.get(key)
        this.info.set(key, { conflicts: old?.conflicts ?? 0, error: null, lastSyncAt: Date.now() })
        return result
      } catch (error) {
        if (!controller.signal.aborted) {
          this.info.set(key, { conflicts: this.info.get(key)?.conflicts ?? 0,
            error: 'Could not sync this server. Check the connection and try again.', lastSyncAt: this.info.get(key)?.lastSyncAt ?? null })
        }
        throw error
      } finally {
        if (this.controllers.get(key) === controller) this.controllers.delete(key)
      }
    })
    this.running.set(key, work)
    this.options.changed()
    void work.finally(() => {
      if (this.running.get(key) === work) this.running.delete(key)
      this.options.changed()
    }).catch(() => {})
    return work
  }

  private difference(track: ProviderSyncTrack, field: ProviderSyncField, server: ProviderSyncValue,
    initial: boolean): ProviderSyncDifference {
    const local = valueOf(track, field)
    return { key: fieldKey(track.path, field), path: track.path, id: track.id,
      title: track.title, artist: track.artist, field, local, server,
      reason: !validProviderValue(field, local) ? 'precision' : initial ? 'initial' : 'changed' }
  }

  review(ref: ProviderSyncRef): Promise<ProviderSyncReview> {
    return this.run(ref, false, async ({ check, client }) => {
      const server = await client.read()
      check()
      const tracks = this.options.tracks(ref)
      const differences: ProviderSyncDifference[] = []
      let matchedTracks = 0
      for (const track of tracks) {
        const remote = server.get(track.id)
        if (!remote) continue // Missing is not an unfavorite or a cleared rating.
        matchedTracks++
        for (const field of fields(ref)) {
          const value = valueOf(remote, field)
          if (!validProviderValue(field, value)) throw new Error('Server returned an unsupported value.')
          if (valueOf(track, field) !== value || !validProviderValue(field, valueOf(track, field))) {
            differences.push(this.difference(track, field, value, !this.enabled(ref)))
          }
        }
      }
      if (tracks.length && !matchedTracks) throw new Error('No matching tracks returned. Refresh the server library before enabling sync.')
      const review = { token: randomUUID(), ref, differences, matchedTracks,
        missingTracks: tracks.length - matchedTracks, enabling: !this.enabled(ref) }
      this.reviews.set(providerSyncKey(ref), { review, fingerprint: this.options.fingerprint(ref)!,
        generation: this.generations.get(providerSyncKey(ref)) ?? 0, created: Date.now() })
      return review
    })
  }

  async apply(token: string, choices: Record<string, ProviderSyncChoice>): Promise<void> {
    const saved = [...this.reviews.values()].find(entry => entry.review.token === token)
    if (!saved || Date.now() - saved.created > 600_000) throw new Error('This review expired. Refresh the comparison.')
    const { review, fingerprint, generation } = saved
    const ref = review.ref
    if (fingerprint !== this.options.fingerprint(ref) || generation !== (this.generations.get(providerSyncKey(ref)) ?? 0)) {
      throw new Error('Server settings changed. Refresh the comparison.')
    }
    // Validate every choice before any local or server write.
    const resolved = review.differences.map(row => ({ row, value: resolveProviderChoice(row, choices[row.key]) }))
    this.reviews.delete(providerSyncKey(ref))
    return this.run(ref, !review.enabling, async ({ check, client }) => {
      const remote = await client.read()
      check()
      const local = new Map(this.options.tracks(ref).map(track => [track.path, track]))
      if (!resolved.length) {
        // Empty comparisons can be accepted directly by the enable action.
        // Recheck agreement before opting in, as values may have changed since
        // the initial read. Missing tracks still cannot establish a baseline.
        let matched = 0
        for (const track of local.values()) {
          const state = remote.get(track.id)
          if (!state) continue
          matched++
          for (const field of fields(ref)) {
            const value = valueOf(track, field)
            if (!validProviderValue(field, value) || value !== valueOf(state, field)) {
              throw new Error('Values changed during setup. Review this server again to choose which values to keep.')
            }
          }
        }
        if (local.size && !matched) throw new Error('No matching tracks returned. Refresh the server library before enabling sync.')
      }
      for (const { row } of resolved) {
        const track = local.get(row.path), state = remote.get(row.id)
        if (!track || !state || valueOf(track, row.field) !== row.local || valueOf(state, row.field) !== row.server) {
          throw new Error('Values changed since this review. Refresh the comparison before applying.')
        }
      }
      for (const { row, value } of resolved) {
        check()
        const current = this.options.track(ref, row.path)
        if (!current || valueOf(current, row.field) !== row.local) throw new Error('Astra values changed. Refresh the comparison.')
        // Recheck immediately before writes as another client may have edited mid-review.
        const fresh = (await client.read([row.id])).get(row.id)
        check()
        if (!fresh || valueOf(fresh, row.field) !== row.server) throw new Error('Server values changed. Refresh the comparison.')
        if (value !== row.server) {
          await client.write(row.id, row.field, value)
          check()
          const verified = (await client.read([row.id])).get(row.id)
          check()
          if (!verified || valueOf(verified, row.field) !== value) throw new Error('The server did not retain the selected value.')
        }
        const latest = this.options.track(ref, row.path)
        if (!latest || valueOf(latest, row.field) !== row.local) throw new Error('Astra values changed. Refresh the comparison.')
        if (value !== row.local) await this.options.applyLocal(row.path, row.field, value)
        check()
        const state = remote.get(row.id)!
        if (row.field === 'favorite') state.favorite = value as boolean
        else state.rating = value as number | null
      }
      check()
      if (review.enabling) await this.options.setSetting(ref, fingerprint, true)
      check()
      // Only confirmed equal fields establish a baseline; new differences remain for review.
      for (const track of this.options.tracks(ref)) {
        const state = remote.get(track.id)
        if (!state) continue
        for (const field of fields(ref)) {
          const value = valueOf(track, field)
          if (validProviderValue(field, value) && value === valueOf(state, field)) {
            if (field === 'favorite' && track.favoriteMixed) {
              await this.options.applyLocal(track.path, field, value)
              check()
            }
            this.options.saveBaseline(ref, track.path, field, value)
          }
        }
      }
      await this.options.persist()
      this.info.set(providerSyncKey(ref), { conflicts: 0, error: null, lastSyncAt: Date.now() })
    })
  }

  refresh(ref: ProviderSyncRef): Promise<void> {
    if (!this.enabled(ref)) return Promise.resolve()
    return this.run(ref, true, async ({ check, client }) => {
      const remote = await client.read()
      check()
      const baselines = this.options.baselines(ref)
      let conflicts = 0
      let processed = 0
      for (const track of this.options.tracks(ref)) {
        if (++processed % 128 === 0) await new Promise<void>(resolve => setImmediate(resolve))
        check()
        const state = remote.get(track.id)
        if (!state) continue
        for (const field of fields(ref)) {
          check()
          const server = valueOf(state, field)
          if (!validProviderValue(field, server)) throw new Error('Server returned an unsupported value.')
          const current = this.options.track(ref, track.path)
          if (!current) continue
          const comparison = compareProviderValue(field, valueOf(current, field), server, baselines.get(fieldKey(track.path, field)))
          if (comparison === 'review') { conflicts++; continue }
          let confirmed = server
          if (comparison === 'outgoing') {
            const desired = valueOf(current, field)
            const fresh = (await client.read([track.id])).get(track.id)
            check()
            const latest = this.options.track(ref, track.path)
            if (!fresh || !latest || valueOf(fresh, field) !== server || valueOf(latest, field) !== desired) {
              conflicts++
              continue
            }
            await client.write(track.id, field, desired)
            check()
            const verified = (await client.read([track.id])).get(track.id)
            check()
            if (!verified || valueOf(verified, field) !== desired) throw new Error('The server did not retain this change.')
            const afterWrite = this.options.track(ref, track.path)
            if (!afterWrite || valueOf(afterWrite, field) !== desired) { conflicts++; continue }
            confirmed = desired
          }
          if (comparison === 'incoming' || (field === 'favorite' && current.favoriteMixed)) {
            await this.options.applyLocal(track.path, field, confirmed)
          }
          check()
          if (baselines.get(fieldKey(track.path, field)) !== confirmed) this.options.saveBaseline(ref, track.path, field, confirmed)
        }
      }
      await this.options.persist()
      this.info.set(providerSyncKey(ref), { conflicts, error: null, lastSyncAt: Date.now() })
    })
  }

  /** Online edits use fresh server state; no durable offline write queue. */
  edit(ref: ProviderSyncRef, path: string, field: ProviderSyncField, value: ProviderSyncValue): Promise<void> {
    if (!validProviderValue(field, value)) return Promise.reject(new Error('Unsupported server value.'))
    return this.run(ref, true, async ({ check, client }) => {
      const track = this.options.track(ref, path)
      if (!track) throw new Error('Track is no longer in this server library.')
      const remote = (await client.read([track.id])).get(track.id)
      check()
      if (!remote) throw new Error('Track is unavailable on this server.')
      const current = this.options.track(ref, path)
      if (!current || valueOf(current, field) !== valueOf(track, field)) throw new Error('Astra values changed. Review the server values before retrying.')
      const baseline = this.options.baselines(ref).get(fieldKey(path, field))
      const server = valueOf(remote, field)
      if (server !== value && (baseline === undefined || server !== baseline)) {
        await this.options.applyLocal(path, field, value)
        this.info.set(providerSyncKey(ref), { conflicts: (this.info.get(providerSyncKey(ref))?.conflicts ?? 0) + 1,
          error: null, lastSyncAt: Date.now() })
        return // Keep both edits for explicit review, not last-write-wins.
      }
      if (server !== value) {
        await client.write(track.id, field, value)
        check()
        const verified = (await client.read([track.id])).get(track.id)
        check()
        if (!verified || valueOf(verified, field) !== value) throw new Error('The server did not retain this change.')
      }
      const latest = this.options.track(ref, path)
      if (!latest || valueOf(latest, field) !== valueOf(track, field)) throw new Error('Astra values changed. Review the server values before retrying.')
      await this.options.applyLocal(path, field, value)
      check()
      this.options.saveBaseline(ref, path, field, value)
      await this.options.persist()
    })
  }
}
