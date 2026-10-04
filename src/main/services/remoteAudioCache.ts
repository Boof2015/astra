import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http'
import { join } from 'node:path'

export const DEFAULT_REMOTE_CACHE_BYTES = 5 * 1024 ** 3

// Identity never includes a signed URL or password. Account and representation
// are separate so another login or a future transcode cannot reuse these bytes.
export interface RemoteAudioSource {
  provider: string
  account: string
  track: string
  representation: string
  revision: string
  open: (signal: AbortSignal) => Promise<Response>
}

interface CacheRecord {
  version: 1
  bytes: number
  contentType: string
  lastPlayed: number
}

interface Entry {
  key: string
  token: string
  bytes: number
  total: number | null
  contentType: string
  complete: boolean
  error: Error | null
  leases: number
  lastPlayed: number
  controller: AbortController
  changed: Set<() => void>
  task: Promise<void>
  settled: boolean
  releaseTimer: ReturnType<typeof setTimeout> | null
}

export interface RemoteAudioLease {
  url: string
  progress: () => { loadedBytes: number; totalBytes: number | null; complete: boolean }
  release: () => void
  finished: () => Promise<void>
}

class RetryableDownloadError extends Error {}

async function networkOperation<T>(work: () => Promise<T>, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    controller.signal.throwIfAborted()
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new RetryableDownloadError('Remote audio request cancelled.'))
        controller.signal.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => {
          controller.abort()
          reject(new RetryableDownloadError('Remote audio request timed out.'))
        }, 20_000)
      })
    ])
  } catch {
    throw new RetryableDownloadError('Remote audio connection interrupted.')
  } finally {
    clearTimeout(timer)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
  }
}

export function remoteAudioCacheKey(source: Omit<RemoteAudioSource, 'open'>): string {
  return createHash('sha256').update(JSON.stringify([
    1, source.provider, source.account, source.track, source.representation, source.revision
  ])).digest('hex')
}

/** Retained encoded bytes, independent of decoder speed. Only completed files
 * survive restart. Readers wait for missing bytes; temporary starvation is never
 * presented as EOF. The loopback endpoint gives FFmpeg real seekable byte access
 * without exposing provider credentials to the renderer or child process.
 */
export class RemoteAudioCache {
  private readonly directory: string
  private limitBytes: number
  private readonly entries = new Map<string, Entry>()
  private readonly records = new Map<string, CacheRecord>()
  private readonly tokens = new Map<string, Entry>()
  private initialization: Promise<void> | null = null
  private server: Server | null = null
  private origin = ''
  private mutations: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(directory: string, limitBytes = DEFAULT_REMOTE_CACHE_BYTES) {
    this.directory = directory
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw new Error('Invalid remote cache size.')
    this.limitBytes = limitBytes
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(work)
    this.mutations = next.catch(() => undefined)
    return next
  }

  private dataPath(key: string): string { return join(this.directory, `${key}.audio`) }
  private recordPath(key: string): string { return join(this.directory, `${key}.json`) }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const files = await readdir(this.directory)
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
      const key = file.slice(0, -5)
      try {
        const record: CacheRecord = JSON.parse(await readFile(this.recordPath(key), 'utf8'))
        const size = (await stat(this.dataPath(key))).size
        if (record.version !== 1 || !Number.isSafeInteger(record.bytes) || record.bytes <= 0
          || size !== record.bytes || typeof record.contentType !== 'string'
          || !Number.isFinite(record.lastPlayed)) throw new Error('Invalid cache record')
        this.records.set(key, record)
      } catch {
        await rm(this.recordPath(key), { force: true })
      }
    }
    // Incomplete files and interrupted metadata commits cannot be reused as audio.
    for (const file of files) {
      const match = /^([a-f0-9]{64})\.(audio|json\.tmp)$/.exec(file)
      if (match && (match[2] !== 'audio' || !this.records.has(match[1]))) {
        await rm(join(this.directory, file), { force: true })
      }
    }
    await this.makeRoom(0)
    this.server = createServer((request, response) => {
      void this.serve(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(502)
        response.destroy()
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => {
        this.server!.removeListener('error', reject)
        resolve()
      })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Remote cache listener failed.')
    this.origin = `http://127.0.0.1:${address.port}`
    this.server.unref()
  }

  async acquire(source: RemoteAudioSource, signal?: AbortSignal): Promise<RemoteAudioLease> {
    if (this.closed) throw new Error('Remote cache is closed.')
    await (this.initialization ??= this.initialize())
    signal?.throwIfAborted()
    if (this.closed) throw new Error('Remote cache is closed.')
    const key = remoteAudioCacheKey(source)
    let entry: Entry | null = null
    while (!entry) {
      const previous = this.entries.get(key)
      if (previous?.error && previous.leases === 0) await previous.task
      entry = await this.serialize(async () => {
        signal?.throwIfAborted()
        if (this.closed) throw new Error('Remote cache is closed.')
        let existing = this.entries.get(key)
        if (existing?.error && existing.leases === 0) {
          // A cancelled producer must finish closing its file before a new writer opens it.
          if (!existing.settled) return null
          if (existing.releaseTimer) clearTimeout(existing.releaseTimer)
          await rm(this.dataPath(key), { force: true })
          this.entries.delete(key)
          this.tokens.delete(existing.token)
          existing = undefined
        }
        if (existing) {
          if (existing.releaseTimer) clearTimeout(existing.releaseTimer)
          existing.releaseTimer = null
          existing.leases++
          existing.lastPlayed = Date.now()
          const record = this.records.get(key)
          if (record) {
            record.lastPlayed = existing.lastPlayed
            await this.saveRecord(key, record).catch(() => undefined)
          }
          return existing
        }
        const record = this.records.get(key)
        const created: Entry = {
          key, token: randomBytes(24).toString('hex'), bytes: record?.bytes ?? 0,
          total: record?.bytes ?? null, contentType: record?.contentType ?? 'application/octet-stream',
          complete: !!record, error: null, leases: 1, lastPlayed: Date.now(),
          controller: new AbortController(), changed: new Set(), task: Promise.resolve(), settled: !!record, releaseTimer: null
        }
        this.entries.set(key, created)
        this.tokens.set(created.token, created)
        if (record) {
          record.lastPlayed = created.lastPlayed
          await this.saveRecord(key, record).catch(() => undefined)
        }
        return created
      })
    }
    // Start outside the mutation queue: the downloader uses that queue for disk accounting.
    this.startDownload(entry, source)
    let released = false
    const release = () => {
      if (released) return
      released = true
      signal?.removeEventListener('abort', release)
      entry.leases--
      if (entry.leases === 0 && !entry.complete) {
        // A seek replaces its decoder immediately; let the replacement claim the
        // same download instead of discarding useful partial bytes between IPCs.
        entry.releaseTimer = setTimeout(() => {
          entry.releaseTimer = null
          if (entry.leases === 0 && !entry.complete) {
            entry.error = new Error('Remote download cancelled.')
            entry.controller.abort()
            this.notify(entry)
          }
        }, 1_000)
        entry.releaseTimer.unref()
      } else if (entry.leases === 0) {
        void this.serialize(() => this.makeRoom(0)).catch(() => undefined)
      }
    }
    signal?.addEventListener('abort', release, { once: true })
    if (signal?.aborted) release()
    signal?.throwIfAborted()
    return {
      url: `${this.origin}/${entry.token}`,
      progress: () => ({ loadedBytes: entry.bytes, totalBytes: entry.total, complete: entry.complete }),
      finished: async () => { await entry.task; if (entry.error) throw entry.error },
      release
    }
  }

  private readonly producers = new WeakSet<Entry>()

  private startDownload(entry: Entry, source: RemoteAudioSource): void {
    if (entry.complete || entry.error || this.producers.has(entry)) return
    this.producers.add(entry)
    entry.task = this.download(entry, source).catch(async () => {
      // Never expose authenticated request URLs through fetch error messages.
      entry.error ??= new Error('Remote audio download failed. Retry this track.')
      this.notify(entry)
      try {
        await rm(this.dataPath(entry.key), { force: true })
        entry.bytes = 0
      } catch {
        // Continue accounting for any bytes that could not be removed.
      }
    }).finally(() => { entry.settled = true })
  }

  private async download(entry: Entry, source: RemoteAudioSource): Promise<void> {
    const file = await open(this.dataPath(entry.key), 'w+')
    try {
      for (let attempt = 0; ; attempt++) {
        const request = new AbortController()
        const abortRequest = () => request.abort()
        entry.controller.signal.addEventListener('abort', abortRequest, { once: true })
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        try {
          entry.controller.signal.throwIfAborted()
          const response = await networkOperation(() => source.open(request.signal), request)
          reader = response.body?.getReader()
          const contentType = response.headers.get('content-type')?.toLowerCase() ?? 'application/octet-stream'
          if (response.status >= 500 || response.status === 408 || response.status === 429) {
            throw new RetryableDownloadError('Remote server temporarily unavailable.')
          }
          if (!response.ok || response.status === 206 || !reader || /json|xml|^text\//.test(contentType)) {
            throw new Error('Invalid audio response.')
          }
          const length = Number(response.headers.get('content-length'))
          const total = Number.isSafeInteger(length) && length > 0 ? length : null
          if (entry.total !== null && total !== null && entry.total !== total) {
            throw new Error('Remote audio changed during recovery.')
          }
          entry.total = total ?? entry.total
          entry.contentType = contentType
          if (entry.total !== null && entry.total > this.limitBytes) {
            entry.error = new Error('This track exceeds the remote audio cache limit.')
            throw entry.error
          }
          this.notify(entry)
          let responseOffset = 0
          while (true) {
            entry.controller.signal.throwIfAborted()
            const { done, value } = await networkOperation(() => reader!.read(), request)
            if (done) break
            if (!value?.byteLength) continue
            // Recovery restarts the original request. Compare the prefix before
            // appending: never splice together bytes from different revisions.
            const retained = Math.min(value.byteLength, Math.max(0, entry.bytes - responseOffset))
            if (retained > 0) {
              const previous = Buffer.allocUnsafe(retained)
              const { bytesRead } = await file.read(previous, 0, retained, responseOffset)
              if (bytesRead !== retained || !previous.equals(Buffer.from(value.subarray(0, retained)))) {
                throw new Error('Remote audio changed during recovery.')
              }
            }
            const additional = value.subarray(retained)
            if (additional.byteLength > 0) {
              await this.serialize(async () => {
                entry.controller.signal.throwIfAborted()
                await this.makeRoom(additional.byteLength)
                let offset = 0
                while (offset < additional.byteLength) {
                  const { bytesWritten } = await file.write(additional, offset, additional.byteLength - offset, entry.bytes + offset)
                  if (bytesWritten === 0) throw new Error('Could not write remote cache.')
                  offset += bytesWritten
                }
                entry.bytes += additional.byteLength
              })
              this.notify(entry)
            }
            responseOffset += value.byteLength
          }
          if (entry.bytes === 0 || responseOffset !== entry.bytes || (entry.total !== null && entry.total !== entry.bytes)) {
            throw new RetryableDownloadError('Incomplete audio response.')
          }
          break
        } catch (error) {
          if (entry.controller.signal.aborted || !(error instanceof RetryableDownloadError) || attempt >= 2) throw error
          // Bounded retry while readers hold their exact byte position. A pause
          // affects decoded playback, while this independent fetch can finish.
          await new Promise<void>(resolve => {
            const finish = () => {
              clearTimeout(timer)
              entry.controller.signal.removeEventListener('abort', finish)
              resolve()
            }
            const timer = setTimeout(finish, attempt === 0 ? 300 : 1_000)
            entry.controller.signal.addEventListener('abort', finish, { once: true })
            if (entry.controller.signal.aborted) finish()
          })
        } finally {
          request.abort()
          entry.controller.signal.removeEventListener('abort', abortRequest)
          await reader?.cancel().catch(() => undefined)
        }
      }
      entry.controller.signal.throwIfAborted()
      await this.serialize(async () => {
        const record: CacheRecord = {
          version: 1, bytes: entry.bytes, contentType: entry.contentType, lastPlayed: entry.lastPlayed
        }
        await this.saveRecord(entry.key, record)
        this.records.set(entry.key, record)
        entry.total = entry.bytes
        entry.complete = true
      })
      this.notify(entry)
    } finally {
      await file.close()
    }
  }

  private async saveRecord(key: string, record: CacheRecord): Promise<void> {
    await writeFile(`${this.recordPath(key)}.tmp`, JSON.stringify(record))
    await rename(`${this.recordPath(key)}.tmp`, this.recordPath(key))
  }

  private async makeRoom(additionalBytes: number): Promise<void> {
    let used = [...this.records.values()].reduce((total, record) => total + record.bytes, 0)
    for (const entry of this.entries.values()) if (!entry.complete) used += entry.bytes
    if (used + additionalBytes <= this.limitBytes) return
    const candidates = [...this.records.entries()]
      .filter(([key]) => !this.entries.get(key)?.leases)
      .sort((a, b) => a[1].lastPlayed - b[1].lastPlayed)
    for (const [key, record] of candidates) {
      await this.removeRecord(key)
      used -= record.bytes
      if (used + additionalBytes <= this.limitBytes) return
    }
    // Lowering a limit may leave active entries over budget until released.
    if (additionalBytes > 0) throw new Error('Remote audio cache is full; active audio is protected.')
  }

  private async removeRecord(key: string): Promise<void> {
    await rm(this.recordPath(key), { force: true })
    await rm(this.dataPath(key), { force: true })
    this.records.delete(key)
    const entry = this.entries.get(key)
    if (entry) this.tokens.delete(entry.token)
    this.entries.delete(key)
  }

  async clearUnused(): Promise<void> {
    await (this.initialization ??= this.initialize())
    const cancelled: Promise<void>[] = []
    for (const entry of this.entries.values()) {
      if (entry.leases === 0 && !entry.complete) {
        entry.error ??= new Error('Unused cached audio cleared.')
        entry.controller.abort()
        this.notify(entry)
        cancelled.push(entry.task)
      }
    }
    await Promise.all(cancelled)
    await this.serialize(async () => {
      for (const key of this.records.keys()) {
        if (!this.entries.get(key)?.leases) await this.removeRecord(key)
      }
    })
  }

  async setLimitBytes(bytes: number): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Invalid remote cache size.')
    await (this.initialization ??= this.initialize())
    await this.serialize(async () => { this.limitBytes = bytes; await this.makeRoom(0) })
  }

  async status(): Promise<{ usedBytes: number; activeBytes: number }> {
    await (this.initialization ??= this.initialize())
    return this.serialize(async () => {
      let usedBytes = [...this.records.values()].reduce((total, record) => total + record.bytes, 0)
      let activeBytes = 0
      for (const entry of this.entries.values()) {
        if (!entry.complete) usedBytes += entry.bytes
        if (entry.leases > 0) activeBytes += entry.bytes
      }
      return { usedBytes, activeBytes }
    })
  }

  private notify(entry: Entry): void {
    for (const changed of entry.changed) changed()
    entry.changed.clear()
  }

  private async waitForBytes(entry: Entry, offset: number, signal: AbortSignal): Promise<void> {
    while (entry.bytes <= offset && !entry.complete && !entry.error) {
      signal.throwIfAborted()
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal.removeEventListener('abort', wake)
          entry.changed.delete(wake)
          resolve()
        }
        entry.changed.add(wake)
        signal.addEventListener('abort', wake, { once: true })
      })
    }
    signal.throwIfAborted()
    if (entry.error) throw entry.error
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const entry = this.tokens.get((request.url ?? '').slice(1))
    if (!entry || entry.leases === 0 || (request.method !== 'GET' && request.method !== 'HEAD')) {
      response.writeHead(404).end()
      return
    }
    const controller = new AbortController()
    response.once('close', () => controller.abort())
    await this.waitForBytes(entry, 0, controller.signal)
    // A chunked upstream has no trustworthy total yet. Ignore Range until EOF
    // establishes it; HTTP permits a full 200 response to a Range request.
    const range = entry.total === null ? undefined : request.headers.range
    let start = 0
    let end = entry.total !== null ? entry.total - 1 : null
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (!match || (!match[1] && !match[2]) || entry.total === null) {
        response.writeHead(416).end()
        return
      }
      start = match[1] ? Number(match[1]) : Math.max(0, entry.total - Number(match[2]))
      end = match[1] && match[2] ? Math.min(Number(match[2]), entry.total - 1) : entry.total - 1
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= entry.total) {
        response.writeHead(416, { 'Content-Range': `bytes */${entry.total}` }).end()
        return
      }
    }
    response.setHeader('Content-Type', entry.contentType)
    response.setHeader('Cache-Control', 'no-store')
    if (entry.total !== null) response.setHeader('Accept-Ranges', 'bytes')
    if (end !== null) response.setHeader('Content-Length', end - start + 1)
    if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${entry.total}`)
    response.writeHead(range ? 206 : 200)
    if (request.method === 'HEAD') { response.end(); return }
    const file = await open(this.dataPath(entry.key), 'r')
    try {
      let offset = start
      while (end === null || offset <= end) {
        await this.waitForBytes(entry, offset, controller.signal)
        if (offset >= entry.bytes && entry.complete) break
        const count = Math.min(64 * 1024, entry.bytes - offset, end === null ? Infinity : end - offset + 1)
        const buffer = Buffer.allocUnsafe(count)
        const { bytesRead } = await file.read(buffer, 0, count, offset)
        if (!bytesRead) throw new Error('Cached audio could not be read.')
        offset += bytesRead
        if (entry.total !== null && offset === entry.total) {
          // Do not let Content-Length make a truncated/failed producer look like
          // a successful EOF before it validates and commits its final bytes.
          await entry.task
          if (entry.error) throw entry.error
        }
        await new Promise<void>((resolve, reject) => {
          response.write(buffer.subarray(0, bytesRead), (error?: Error | null) => error ? reject(error) : resolve())
        })
      }
      response.end()
    } finally {
      await file.close()
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.initialization) await this.initialization.catch(() => undefined)
    for (const entry of this.entries.values()) {
      if (entry.releaseTimer) clearTimeout(entry.releaseTimer)
      entry.controller.abort()
      entry.error ??= new Error('Remote cache is closed.')
      this.notify(entry)
    }
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve())
    await Promise.all([...this.entries.values()].map(entry => entry.task))
    await this.mutations
  }
}
