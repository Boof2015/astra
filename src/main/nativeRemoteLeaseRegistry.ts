import type { RemoteAudioLease } from './services/remoteAudioCache'
import type { NativeRemoteProgress } from '../types/nativeRemoteSource'
import type { StreamingQualityRequest } from '../types/streamingQuality'

interface LeaseEntry {
  controller: AbortController
  lease: RemoteAudioLease | null
  error: string | null
}

/** Sender-scoped ownership includes pending acquisitions, not just ready leases. */
export class NativeRemoteLeaseRegistry {
  private owners = new Map<number, Map<string, LeaseEntry>>()
  private acquireSource: (path: string, signal: AbortSignal, quality?: StreamingQualityRequest) => Promise<RemoteAudioLease>

  constructor(acquireSource: (path: string, signal: AbortSignal, quality?: StreamingQualityRequest) => Promise<RemoteAudioLease>) {
    this.acquireSource = acquireSource
  }

  async acquire(owner: number, id: string, path: string, quality?: StreamingQualityRequest): Promise<string> {
    if (typeof id !== 'string' || id.length < 1 || id.length > 128 || typeof path !== 'string') {
      throw new Error('Invalid native remote source request.')
    }
    const entries = this.owners.get(owner) ?? new Map<string, LeaseEntry>()
    if (entries.has(id) || entries.size >= 4) throw new Error('Too many native remote source requests.')
    this.owners.set(owner, entries)
    const entry: LeaseEntry = { controller: new AbortController(), lease: null, error: null }
    entries.set(id, entry)
    try {
      const lease = await this.acquireSource(path, entry.controller.signal, quality)
      if (entry.controller.signal.aborted) { lease.release(); throw new Error('Native source request cancelled.') }
      entry.lease = lease
      // Observe early download failure even when decoding is backpressured.
      void lease.finished().catch(error => { entry.error = error instanceof Error ? error.message : 'Remote download failed.' })
      return lease.url
    } catch (error) {
      if (this.owners.get(owner)?.get(id) === entry) this.release(owner, id)
      throw error
    }
  }

  progress(owner: number, id: string): NativeRemoteProgress {
    const entry = this.require(owner, id)
    return { ...entry.lease!.progress(), error: entry.error }
  }

  quality(owner: number, id: string) { return this.require(owner, id).lease!.quality }

  async finished(owner: number, id: string): Promise<void> {
    const entry = this.require(owner, id)
    const signal = entry.controller.signal
    let onAbort!: () => void
    try {
      await Promise.race([
        entry.lease!.finished(),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error('Native source request cancelled.'))
          signal.addEventListener('abort', onAbort, { once: true })
        })
      ])
    } finally { signal.removeEventListener('abort', onAbort) }
  }

  release(owner: number, id: string): void {
    const entries = this.owners.get(owner)
    const entry = entries?.get(id)
    if (!entry) return
    entries!.delete(id)
    if (!entries!.size) this.owners.delete(owner)
    entry.controller.abort()
    entry.lease?.release()
  }

  releaseOwner(owner: number): void {
    for (const id of this.owners.get(owner)?.keys() ?? []) this.release(owner, id)
  }

  private require(owner: number, id: string): LeaseEntry {
    const entry = this.owners.get(owner)?.get(id)
    if (!entry?.lease) throw new Error('Native remote source is no longer available.')
    return entry
  }
}
