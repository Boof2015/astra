import type { ProviderSyncRef } from '../../types/providerSync'
import type { RemotePlaylistEdit, RemotePlaylistLocal, RemotePlaylistSnapshot, RemotePlaylistStatus } from '../../types/remotePlaylists'
import { providerSyncKey } from '../../shared/sync/providerState'

export interface RemotePlaylistClient {
  list(): Promise<RemotePlaylistSnapshot[]>
  read(id: string): Promise<RemotePlaylistSnapshot | null>
  write(before: RemotePlaylistSnapshot, after: RemotePlaylistSnapshot | null): Promise<void>
}
interface Options {
  sources(): ProviderSyncRef[]
  fingerprint(ref: ProviderSyncRef): string | null
  enabled(ref: ProviderSyncRef): boolean
  setEnabled(ref: ProviderSyncRef, enabled: boolean): Promise<void>
  local(id: number): RemotePlaylistLocal | null
  apply(ref: ProviderSyncRef, playlists: RemotePlaylistSnapshot[], prune: boolean): Promise<void>
  remove(id: number): Promise<void>
  client(ref: ProviderSyncRef, signal: AbortSignal): Promise<RemotePlaylistClient>
  changed(): void
}
const same = (a: RemotePlaylistSnapshot, b: RemotePlaylistSnapshot) => a.name === b.name
  && a.tracks.length === b.tracks.length && a.tracks.every((track, i) => track.path === b.tracks[i].path)

export function planRemotePlaylistEdit(before: RemotePlaylistLocal, edit: RemotePlaylistEdit): RemotePlaylistSnapshot | null {
  if (edit.kind === 'delete') {
    if (!(before.deletable ?? before.writable)) throw new Error('You do not have permission to delete this server playlist.')
    return null
  }
  if (!before.writable) throw new Error('This server playlist is read-only.')
  const after: RemotePlaylistSnapshot = { ...before, tracks: before.tracks.map(track => ({ ...track })) }
  const validEntries = (ids: number[]) => {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id)
      || !after.tracks.some(track => track.entryId === id))) throw new Error('Playlist changed. Refresh it before editing.')
  }
  const position = (value: number) => {
    if (!Number.isFinite(value)) throw new Error('Invalid playlist position.')
    return Math.max(0, Math.min(after.tracks.length, Math.trunc(value)))
  }
  if (edit.kind === 'rename') {
    if (typeof edit.name !== 'string' || !edit.name.trim()) throw new Error('Playlist name is required.')
    after.name = edit.name.trim()
  } else if (edit.kind === 'insert') {
    if (!Array.isArray(edit.paths) || edit.paths.some(path => typeof path !== 'string' || !path.trim())) throw new Error('Invalid playlist tracks.')
    // Match Astra's existing insertion behavior; imported repeated occurrences
    // are retained, while adding an already-present song is skipped.
    const seen = new Set(after.tracks.map(track => track.path))
    const added = edit.paths.filter(path => { if (seen.has(path)) return false; seen.add(path); return true }).map(path => ({ path }))
    after.tracks.splice(edit.position === 'end' ? after.tracks.length : position(edit.position), 0, ...added)
  } else if (edit.kind === 'removePath') after.tracks = after.tracks.filter(track => track.path !== edit.path)
  else if (edit.kind === 'remove') {
    validEntries([edit.entryId])
    after.tracks = after.tracks.filter(track => track.entryId !== edit.entryId)
  } else if (edit.kind === 'reorder') {
    validEntries(edit.entryIds)
    if (edit.entryIds.length !== after.tracks.length) throw new Error('Playlist changed. Refresh it before editing.')
    after.tracks = edit.entryIds.map(id => after.tracks.find(track => track.entryId === id)!)
  } else if (edit.kind === 'move') {
    validEntries(edit.entryIds)
    const target = position(edit.position)
    const ids = new Set(edit.entryIds)
    const adjusted = target - after.tracks.slice(0, target).filter(track => ids.has(track.entryId!)).length
    const moved = edit.entryIds.map(id => after.tracks.find(track => track.entryId === id)!)
    after.tracks = after.tracks.filter(track => !ids.has(track.entryId!))
    after.tracks.splice(adjusted, 0, ...moved)
  } else throw new Error('Unsupported playlist edit.')
  return after
}

/** Serialize catalog refresh and edits per source; never queue offline writes. */
export class RemotePlaylists {
  private running = new Map<string, Promise<unknown>>()
  private controllers = new Map<string, AbortController>()
  private generations = new Map<string, number>()
  private errors = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false
  private readonly options: Options
  constructor(options: Options) { this.options = options }
  status(): RemotePlaylistStatus[] {
    return this.options.sources().map(ref => ({ ...ref, enabled: this.options.enabled(ref),
      busy: this.running.has(providerSyncKey(ref)), error: this.errors.get(providerSyncKey(ref)) ?? null }))
  }
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.refreshAll(), 30_000); this.timer.unref(); this.refreshAll()
  }
  close(): void { this.closed = true; if (this.timer) clearInterval(this.timer); for (const c of this.controllers.values()) c.abort() }
  private refreshAll(): void {
    for (const ref of this.options.sources()) if (this.options.enabled(ref) && !this.running.has(providerSyncKey(ref))) void this.refresh(ref).catch(() => {})
  }
  async setEnabled(ref: ProviderSyncRef, enabled: boolean): Promise<void> {
    if (!this.options.sources().some(source => providerSyncKey(source) === providerSyncKey(ref))) throw new Error('Playlist sync is not supported for this server yet.')
    const key = providerSyncKey(ref)
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
    this.controllers.get(key)?.abort()
    await this.options.setEnabled(ref, enabled)
    this.errors.delete(key); this.options.changed()
    if (enabled) await this.refresh(ref)
  }
  private run<T>(ref: ProviderSyncRef, task: (client: RemotePlaylistClient, check: () => void) => Promise<T>): Promise<T> {
    const key = providerSyncKey(ref), fingerprint = this.options.fingerprint(ref), generation = this.generations.get(key)
    const work = Promise.resolve(this.running.get(key)).catch(() => {}).then(async () => {
      const controller = new AbortController(); this.controllers.set(key, controller)
      const check = () => {
        controller.signal.throwIfAborted()
        if (this.closed || !fingerprint || fingerprint !== this.options.fingerprint(ref) || generation !== this.generations.get(key)
          || !this.options.enabled(ref)) throw new Error('Playlist sync is off or the server connection changed.')
      }
      try {
        check()
        const client = await this.options.client(ref, controller.signal)
        check()
        const result = await task(client, check)
        this.errors.delete(key)
        return result
      } catch (error) {
        if (!controller.signal.aborted) this.errors.set(key, error instanceof Error ? error.message : 'Could not sync playlists.')
        throw error
      } finally { if (this.controllers.get(key) === controller) this.controllers.delete(key) }
    })
    this.running.set(key, work); this.options.changed()
    void work.finally(() => { if (this.running.get(key) === work) this.running.delete(key); this.options.changed() }).catch(() => {})
    return work
  }
  refresh(ref: ProviderSyncRef): Promise<void> {
    if (!this.options.enabled(ref)) return Promise.resolve()
    return this.run(ref, async (client, check) => {
      const snapshots = await client.list(); check()
      await this.options.apply(ref, snapshots, true); check()
    })
  }
  edit(id: number, edit: RemotePlaylistEdit): Promise<void> {
    const captured = this.options.local(id)
    if (!captured) return Promise.reject(new Error('Server playlist not found.'))
    // Capture the content the user acted on, before joining the source queue.
    const after = planRemotePlaylistEdit(captured, edit)
    return this.run(captured.ref, async (client, check) => {
      const local = this.options.local(id)
      if (!local || !same(local, captured) || local.tracks.some((track, i) => track.entryId !== captured.tracks[i].entryId)) {
        throw new Error('Playlist changed. Refresh it before editing.')
      }
      const remote = await client.read(captured.id); check()
      if (!remote) { await this.options.remove(id); throw new Error('This playlist was removed from the server.') }
      if (after === null ? !(remote.deletable ?? remote.writable) : !remote.writable) {
        await this.options.apply(captured.ref, [remote], false)
        throw new Error(after === null ? 'You do not have permission to delete this server playlist.' : 'This server playlist is read-only.')
      }
      if (!same(remote, captured)) {
        await this.options.apply(captured.ref, [remote], false)
        throw new Error('This playlist changed on the server. Astra refreshed it; please try your edit again.')
      }
      const withOccurrenceIds = (snapshot: RemotePlaylistSnapshot, planned: RemotePlaylistSnapshot): RemotePlaylistSnapshot => ({
        ...snapshot, tracks: snapshot.tracks.map((track, i) => ({ ...track, entryId: planned.tracks[i].entryId }))
      })
      if (after && same(remote, after)) {
        // Swapping identical songs needs no server write, but their local
        // occurrence IDs must still follow the edit for selection/removal.
        await this.options.apply(captured.ref, [withOccurrenceIds(remote, after)], false)
        return
      }
      await client.write(remote, after); check()
      const verified = await client.read(captured.id); check()
      if (after === null) {
        if (verified) throw new Error('The server did not delete this playlist.')
        await this.options.remove(id)
      } else {
        if (!verified || !same(verified, after)) {
          if (verified) await this.options.apply(captured.ref, [verified], false)
          throw new Error('The server did not retain the expected playlist changes. Please refresh.')
        }
        // Preserve occurrence IDs from the exact edit, including repeated songs.
        await this.options.apply(captured.ref, [withOccurrenceIds(verified, after)], false)
      }
    })
  }
}
