import assert from 'node:assert/strict'
import { appendFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  LocalPcmProbeCache,
  areLocalPcmProbeFileIdentitiesEqual,
  identifyLocalPcmProbeFile,
  isValidLocalPcmProbeResult,
  type LocalPcmProbeFileIdentity,
  type LocalPcmProbeResult
} from './localPcmProbeCache.ts'

function identity(
  canonicalPath: string,
  version = 1
): LocalPcmProbeFileIdentity {
  return {
    canonicalPath,
    dev: 10n,
    ino: BigInt(version),
    size: BigInt(version * 100),
    mtimeNs: BigInt(version * 1_000),
    ctimeNs: BigInt(version * 2_000),
    birthtimeNs: 500n
  }
}

const stereoProbe: LocalPcmProbeResult = {
  channels: 2,
  durationSeconds: 180.25
}

test('identifies a canonical path with precise stat fields', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-pcm-probe-cache-'))
  context.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const filePath = join(directory, 'track.flac')
  await writeFile(filePath, Buffer.from([1, 2, 3]))

  const first = await identifyLocalPcmProbeFile(filePath)
  assert.ok(first)
  assert.equal(first.canonicalPath, await realpath(filePath))
  assert.equal(typeof first.dev, 'bigint')
  assert.equal(typeof first.ino, 'bigint')
  assert.equal(first.size, 3n)
  assert.equal(typeof first.mtimeNs, 'bigint')
  assert.equal(typeof first.ctimeNs, 'bigint')
  assert.equal(typeof first.birthtimeNs, 'bigint')

  await appendFile(filePath, Buffer.from([4]))
  const second = await identifyLocalPcmProbeFile(filePath)
  assert.ok(second)
  assert.equal(second.size, 4n)
  assert.equal(areLocalPcmProbeFileIdentitiesEqual(first, second), false)
})

test('returns null when canonicalization or stat cannot identify a file', async () => {
  const result = await identifyLocalPcmProbeFile(
    join(tmpdir(), `astra-missing-probe-${Date.now()}.flac`)
  )
  assert.equal(result, null)
})

test('validates channels and nullable positive durations', () => {
  assert.equal(isValidLocalPcmProbeResult(stereoProbe), true)
  assert.equal(isValidLocalPcmProbeResult({ channels: 8, durationSeconds: null }), true)
  assert.equal(isValidLocalPcmProbeResult({ channels: 0, durationSeconds: 1 }), false)
  assert.equal(isValidLocalPcmProbeResult({ channels: 9, durationSeconds: 1 }), false)
  assert.equal(isValidLocalPcmProbeResult({ channels: 2.5, durationSeconds: 1 }), false)
  assert.equal(isValidLocalPcmProbeResult({ channels: 2, durationSeconds: 0 }), false)
  assert.equal(isValidLocalPcmProbeResult({ channels: 2, durationSeconds: Number.NaN }), false)
})

test('caches a successful stable probe and reports later hits', async () => {
  const stableIdentity = identity('C:\\music\\stable.flac')
  const cache = new LocalPcmProbeCache({
    identifyFile: async () => stableIdentity
  })
  let probeCalls = 0
  const runProbe = async (): Promise<LocalPcmProbeResult> => {
    probeCalls += 1
    return stereoProbe
  }

  const first = await cache.getOrProbe('stable.flac', runProbe)
  const second = await cache.getOrProbe('stable.flac', runProbe)

  assert.equal(first.cacheStatus, 'miss')
  assert.equal(second.cacheStatus, 'hit')
  assert.deepEqual(second.result, stereoProbe)
  assert.equal(Object.isFrozen(second.result), true)
  assert.equal(probeCalls, 1)
  assert.equal(cache.size, 1)
})

test('bypasses caching when file identity cannot be read', async () => {
  const cache = new LocalPcmProbeCache({
    identifyFile: async () => null
  })
  let probeCalls = 0
  const runProbe = async (): Promise<LocalPcmProbeResult> => {
    probeCalls += 1
    return stereoProbe
  }

  assert.equal((await cache.getOrProbe('missing.flac', runProbe)).cacheStatus, 'bypass')
  assert.equal((await cache.getOrProbe('missing.flac', runProbe)).cacheStatus, 'bypass')
  assert.equal(probeCalls, 2)
  assert.equal(cache.size, 0)
})

test('does not cache invalid or failed probe results', async () => {
  const cache = new LocalPcmProbeCache({
    identifyFile: async () => identity('invalid.flac')
  })

  const invalid = await cache.getOrProbe('invalid.flac', async () => ({
    channels: 2,
    durationSeconds: -1
  }))
  assert.equal(invalid.cacheStatus, 'bypass')
  assert.equal(cache.size, 0)

  await assert.rejects(
    cache.getOrProbe('invalid.flac', async () => {
      throw new Error('probe failed')
    }),
    /probe failed/
  )
  assert.equal(cache.size, 0)
})

test('does not cache a result when the file changes during probing', async () => {
  const before = identity('changing.flac', 1)
  const after = identity('changing.flac', 2)
  const identities = [before, after, after, after]
  const cache = new LocalPcmProbeCache({
    identifyFile: async () => identities.shift() ?? after
  })
  let probeCalls = 0

  const first = await cache.getOrProbe('changing.flac', async () => {
    probeCalls += 1
    return stereoProbe
  })
  const second = await cache.getOrProbe('changing.flac', async () => {
    probeCalls += 1
    return stereoProbe
  })

  assert.equal(first.cacheStatus, 'bypass')
  assert.equal(second.cacheStatus, 'miss')
  assert.equal(probeCalls, 2)
  assert.equal(cache.size, 1)
})

test('uses bounded least-recently-used eviction', async () => {
  const identities = new Map([
    ['a.flac', identity('a.flac')],
    ['b.flac', identity('b.flac')],
    ['c.flac', identity('c.flac')]
  ])
  const cache = new LocalPcmProbeCache({
    maxEntries: 2,
    identifyFile: async (filePath) => identities.get(filePath) ?? null
  })
  const probeCalls = new Map<string, number>()
  const resolveProbe = async (filePath: string): Promise<LocalPcmProbeResult> => {
    probeCalls.set(filePath, (probeCalls.get(filePath) ?? 0) + 1)
    return stereoProbe
  }

  await cache.getOrProbe('a.flac', () => resolveProbe('a.flac'))
  await cache.getOrProbe('b.flac', () => resolveProbe('b.flac'))
  assert.equal(
    (await cache.getOrProbe('a.flac', () => resolveProbe('a.flac'))).cacheStatus,
    'hit'
  )
  await cache.getOrProbe('c.flac', () => resolveProbe('c.flac'))

  assert.equal(cache.size, 2)
  assert.equal(
    (await cache.getOrProbe('b.flac', () => resolveProbe('b.flac'))).cacheStatus,
    'miss'
  )
  assert.deepEqual(Object.fromEntries(probeCalls), {
    'a.flac': 1,
    'b.flac': 2,
    'c.flac': 1
  })
})

test('rejects invalid cache bounds and supports explicit clearing', async () => {
  assert.throws(() => new LocalPcmProbeCache({ maxEntries: 0 }), /positive integer/)
  const cache = new LocalPcmProbeCache({
    identifyFile: async () => identity('clear.flac')
  })
  await cache.getOrProbe('clear.flac', async () => stereoProbe)
  assert.equal(cache.size, 1)
  cache.clear()
  assert.equal(cache.size, 0)
})
