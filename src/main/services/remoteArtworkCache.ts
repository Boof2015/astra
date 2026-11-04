import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const REMOTE_ARTWORK_REFRESH_MS = 24 * 60 * 60_000
const HASH = /^[a-f0-9]{32}\.(?:jpg|png|gif|webp|bmp)$/
interface Entry { version: 1; hash: string; checkedAt: number; revision: string | null }
export interface RemoteArtworkRequest {
  /** Provider, server/account identity. Never include passwords or tokens. */
  scope: readonly (string | number)[]
  id: string
  revision?: string | null
  /** Catalog sync may refresh old entries. Display requests always use saved art. */
  refresh?: boolean
  /** Subsonic keeps first downloads lazy; sync only refreshes art already viewed. */
  existingOnly?: boolean
  load: () => Promise<{ data: Buffer; contentType?: string | null }>
}
interface Options {
  store: (bytes: Buffer, mimeType?: string | null) => Promise<string | null>
  exists: (hash: string) => Promise<boolean>
  now?: () => number
}

/** Persistent server-reference → content-hash lookup. The existing artwork
 * cache owns image bytes; this stores only small records, never credentials. */
export class RemoteArtworkCache {
  private readonly directory: string
  private readonly options: Options
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Map<string, { revision: string | null; promise: Promise<string | null> }>()
  constructor(directory: string, options: Options) { this.directory = directory; this.options = options }

  private remember(key: string, entry: Entry): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    if (this.entries.size > 4096) this.entries.delete(this.entries.keys().next().value!)
  }

  private async read(key: string): Promise<Entry | null> {
    let entry = this.entries.get(key)
    if (!entry) {
      try {
        const bytes = await readFile(join(this.directory, `${key}.json`))
        if (bytes.length > 4096) return null
        const value = JSON.parse(bytes.toString()) as Entry
        if (value.version !== 1 || !HASH.test(value.hash) || !Number.isFinite(value.checkedAt)
          || value.checkedAt < 0 || !(value.revision === null || typeof value.revision === 'string')) return null
        entry = value
      } catch { return null }
    }
    if (!await this.options.exists(entry.hash)) { this.entries.delete(key); return null }
    this.remember(key, entry)
    return entry
  }

  async resolve(request: RemoteArtworkRequest): Promise<string | null> {
    const key = createHash('sha256').update(JSON.stringify([request.scope, request.id])).digest('hex')
    const cached = await this.read(key)
    const now = (this.options.now ?? Date.now)()
    const revision = request.revision ?? null
    if (cached && (!request.refresh || (cached.revision === revision
      && now >= cached.checkedAt && now - cached.checkedAt < REMOTE_ARTWORK_REFRESH_MS))) return cached.hash
    if (!cached && request.existingOnly) return null
    const pending = this.pending.get(key)
    if (pending) {
      if (pending.revision === revision) return pending.promise
      await pending.promise.catch(() => {})
      return this.resolve(request)
    }
    const promise = (async () => {
      try {
        const payload = await request.load()
        const hash = await this.options.store(payload.data, payload.contentType)
        if (!hash || !HASH.test(hash)) return cached?.hash ?? null
        const entry: Entry = { version: 1, hash, revision, checkedAt: (this.options.now ?? Date.now)() }
        this.remember(key, entry)
        // A failed metadata write must not turn a successfully stored image into
        // a missing cover. Atomic replacement also protects the previous record.
        const temporary = join(this.directory, `${key}.${randomUUID()}.tmp`)
        try {
          await mkdir(this.directory, { recursive: true, mode: 0o700 })
          await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 })
          await rename(temporary, join(this.directory, `${key}.json`))
        } catch { await rm(temporary, { force: true }).catch(() => {}) }
        return hash
      } catch (error) {
        if (cached) return cached.hash
        throw error
      }
    })().finally(() => { this.pending.delete(key) })
    this.pending.set(key, { revision, promise })
    return promise
  }
}
