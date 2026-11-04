import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteArtworkCache, REMOTE_ARTWORK_REFRESH_MS } from './remoteArtworkCache.ts'

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'astra-artwork-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let time = 1_000, loads = 0, body = 'first cover', offline = false
  const options = {
    now: () => time,
    store: async (bytes: Buffer) => {
      const hash = createHash('md5').update(bytes).digest('hex') + '.jpg'
      await writeFile(join(directory, hash), bytes)
      return hash
    },
    exists: async (hash: string) => { try { return (await stat(join(directory, hash))).isFile() } catch { return false } }
  }
  const open = () => new RemoteArtworkCache(join(directory, 'references'), options)
  const request = { scope: ['subsonic', 1, 'https://music.test', 'listener'], id: 'cover', load: async () => {
    loads++
    if (offline) throw new Error('offline')
    return { data: Buffer.from(body) }
  } }
  return { directory, open, request, reads: () => loads, advance: () => { time += REMOTE_ARTWORK_REFRESH_MS + 1 },
    change: (value: string) => { body = value }, offline: () => { offline = true } }
}

test('all providers reuse saved artwork across page requests and cache restarts without a network', async t => {
  const f = await fixture(t)
  for (const provider of ['subsonic', 'jellyfin', 'plex']) {
    const request = { ...f.request, scope: [provider, 'server', 'account'] }
    const cache = f.open(), before = f.reads()
    const hashes = await Promise.all(Array.from({ length: 12 }, () => cache.resolve(request)))
    assert.equal(new Set(hashes).size, 1)
    assert.equal(f.reads(), before + 1, 'concurrent size/view requests share the download')
    const reopened = f.open()
    assert.equal(await reopened.resolve({ ...request, refresh: true,
      load: async () => { throw new Error('network must not be needed') } }), hashes[0])
    assert.equal((await readFile(join(f.directory, hashes[0]!))).toString(), 'first cover')
  }
})

test('viewing stale artwork never waits for a sync refresh; changed bytes replace it after success', async t => {
  const f = await fixture(t), cache = f.open()
  const first = await cache.resolve(f.request)
  f.advance()
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const refreshed = cache.resolve({ ...f.request, refresh: true, load: async () => {
    entered(); await held; return { data: Buffer.from('new cover') }
  } })
  await started
  assert.equal(await cache.resolve(f.request), first)
  release()
  const second = await refreshed
  assert.notEqual(second, first)
  assert.equal(await cache.resolve(f.request), second)
  assert.equal(await f.open().resolve(f.request), second)
})

test('image revision changes refresh promptly, and failed refreshes preserve saved covers', async t => {
  const f = await fixture(t), cache = f.open()
  const first = await cache.resolve({ ...f.request, revision: 'tag-1', refresh: true })
  f.change('changed tag cover')
  const second = await cache.resolve({ ...f.request, revision: 'tag-2', refresh: true })
  assert.notEqual(second, first)
  assert.equal(f.reads(), 2)
  f.offline()
  assert.equal(await cache.resolve({ ...f.request, revision: 'tag-3', refresh: true }), second)
  assert.equal(await f.open().resolve(f.request), second)
})

test('same artwork IDs on different accounts or servers cannot reuse the wrong cover', async t => {
  const f = await fixture(t), cache = f.open()
  const first = await cache.resolve(f.request)
  f.change('other account cover')
  const second = await cache.resolve({ ...f.request, scope: ['subsonic', 1, 'https://music.test', 'other'] })
  assert.notEqual(second, first)
  assert.equal(await cache.resolve(f.request), first)
  await cache.resolve({ ...f.request, scope: ['subsonic', 1, 'https://another.test', 'listener'] })
  assert.equal(f.reads(), 3)
})

test('missing image files are fetched again, and an uncached Subsonic catalog stays lazy', async t => {
  const f = await fixture(t), cache = f.open()
  assert.equal(await cache.resolve({ ...f.request, refresh: true, existingOnly: true }), null)
  assert.equal(f.reads(), 0)
  const first = await cache.resolve(f.request)
  await rm(join(f.directory, first!))
  f.change('repaired cover')
  const repaired = await cache.resolve(f.request)
  assert.notEqual(repaired, first)
  assert.equal(f.reads(), 2)
  assert.equal(await cache.resolve({ ...f.request, refresh: true, existingOnly: true }), repaired)
  assert.equal(f.reads(), 2)
})
