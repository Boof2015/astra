import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { RemoteArtworkCache } from './remoteArtworkCache.ts'
import { PlaybackNetworkPriority } from './playbackNetworkPriority.ts'
import { buildSubsonicArtworkHash, parseSubsonicArtworkHash } from './subsonic.ts'

// Execute the real main-process entry points without launching Electron or
// opening a personal database. Image bytes and reference records use real disk.
const names = ['resolveSubsonicArtworkHash', 'hydrateJellyfinTrackArtworkHashes']
const source = ts.createSourceFile('index.ts', readFileSync(new URL('../index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''))
assert.equal(functions.length, names.length)
const javascript = ts.transpileModule(functions.map(node => node.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'astra-artwork-main-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const options = {
    store: async (bytes: Buffer) => {
      const hash = createHash('md5').update(bytes).digest('hex') + '.jpg'
      await writeFile(join(directory, hash), bytes); return hash
    },
    exists: async (hash: string) => { try { return (await stat(join(directory, hash))).isFile() } catch { return false } }
  }
  let cache = new RemoteArtworkCache(join(directory, 'references'), options)
  const state = { reads: 0, offline: false, body: 'art', replacements: [] as string[] }
  const load = async () => {
    state.reads++
    if (state.offline) throw new Error('offline')
    return { data: Buffer.from(state.body), contentType: 'image/jpeg' }
  }
  const dependencies = {
    parseSubsonicArtworkHash, getRemoteArtworkCache: () => cache,
    subsonicArtworkResolveRequestCache: new Map(), playbackNetworkPriority: new PlaybackNetworkPriority(),
    Buffer, console: { warn: () => {} },
    library: {
      getSubsonicSourceById: () => ({ id: 1, base_url: 'https://music.test', username: 'listener' }),
      replaceSubsonicArtworkHash: async (_id: number, _old: string, next: string) => { state.replacements.push(next) }
    },
    requireSubsonicSourceCredentials: () => ({ connection: {} }),
    fetchSubsonicCoverArt: load, fetchJellyfinCoverArt: load
  }
  const main = new Function(...Object.keys(dependencies), javascript + `\nreturn {${names.join(',')}}`)(...Object.values(dependencies)) as {
    resolveSubsonicArtworkHash: (hash: string, refresh?: boolean, existingOnly?: boolean) => Promise<string | null>
    hydrateJellyfinTrackArtworkHashes: (id: number, connection: object, auth: object,
      tracks: Array<{ artwork_source_id: string; artwork_revision: string }>) => Promise<Map<string, string>>
  }
  return { main, state, restart: () => { cache = new RemoteArtworkCache(join(directory, 'references'), options) } }
}

test('Navidrome views holding their original artwork reference reuse disk bytes through the real resolver', async t => {
  const f = await fixture(t), alias = buildSubsonicArtworkHash(1, 'album-cover')
  assert.equal(await f.main.resolveSubsonicArtworkHash(alias, true, true), null)
  assert.equal(f.state.reads, 0)
  const first = await f.main.resolveSubsonicArtworkHash(alias)
  assert.ok(first)
  f.state.offline = true
  assert.equal(await f.main.resolveSubsonicArtworkHash(alias), first)
  f.restart()
  assert.equal(await f.main.resolveSubsonicArtworkHash(alias), first)
  assert.equal(await f.main.resolveSubsonicArtworkHash(alias, true, true), first)
  assert.equal(f.state.reads, 1)
})

test('Jellyfin repeated syncs reuse persisted covers and fetch a changed image tag once', async t => {
  const f = await fixture(t)
  const connection = { baseUrl: 'https://jelly.test', username: 'listener', password: 'test' }
  const auth = { userId: 'listener', accessToken: 'test' }
  const tracks = [{ artwork_source_id: 'album', artwork_revision: 'tag1' }, { artwork_source_id: 'album', artwork_revision: 'tag1' }]
  const sync = () => f.main.hydrateJellyfinTrackArtworkHashes(1, connection, auth, tracks)
  const first = await sync()
  await sync(); f.restart(); await sync()
  assert.equal(f.state.reads, 1)
  tracks.forEach(track => { track.artwork_revision = 'tag2' })
  f.state.body = 'changed art'
  const next = await sync()
  assert.notEqual(next.get('album'), first.get('album'))
  assert.equal(f.state.reads, 2)
  f.state.offline = true
  tracks.forEach(track => { track.artwork_revision = 'tag3' })
  assert.equal((await sync()).get('album'), next.get('album'))
})
