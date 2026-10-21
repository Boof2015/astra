import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { RemoteAudioCache } from './remoteAudioCache.ts'
import { StratumAudioCache, type StratumCacheOptions } from './stratumAudioCache.ts'
import type { StratumProofAuthentication, StratumProofSource } from './stratumProofClient.ts'
import type { RemoteAudioAnalysis } from '../../types/remoteAudioAnalysis.ts'
import { StratumFetchAhead } from './stratumFetchAhead.ts'
import { StratumSegmentDiagnostics } from './streamingDiagnostics.ts'

const source: StratumProofSource = { sha256: 'a'.repeat(64), sample_rate: 48000, channels: 2, bits_per_sample: 16, frames: 480000 }
const options: StratumCacheOptions = { scope: 'approved-account', track: 'song', revision: 'catalog-v1', profile: 'lossless' }
const analysis: RemoteAudioAnalysis = { version: 1, duration: 10, peaks: Array(512).fill(.5), loudnessLufs: -18, peakLinear: .5 }
const signal = () => AbortSignal.timeout(10000)

function fake() {
  const state = { offline: false, corrupt: false, opens: 0, closes: 0, reads: 0, scans: 0, starts: [] as number[], segmentHold: null as Promise<void> | null, hold: null as Promise<void> | null }
  const connection: StratumProofAuthentication = {
    endpoint: 'https://cache-fixture.test', signal: new AbortController().signal,
    getBearer: async () => 'test-only', reject() {},
    request: async (path, method, requestSignal, body) => {
      requestSignal.throwIfAborted()
      if (state.offline) throw new Error('offline')
      if (method === 'DELETE') { state.closes++; return { bytes: Buffer.alloc(0), type: '' } }
      if (path.includes('capabilities')) return { type: 'application/json', bytes: Buffer.from(JSON.stringify({
        protocol: 'stratum-access-proof-1', audioExperiment: 'stratum-authenticated-audio-1' })) }
      if (path.includes('/playbacks/')) {
        state.opens++
        if (state.hold) await state.hold
        return { type: 'application/json', bytes: Buffer.from(JSON.stringify({ playback: state.opens.toString(16).padStart(64, '0'),
          source: { ...source, codec: 'flac' }, sourcePolicy: 'complete-private-copy', maxSegmentSeconds: 4 })) }
      }
      state.reads++
      if (state.segmentHold) await state.segmentHold
      const { start, frames, quality } = body as { start: number; frames: number; quality: string }
      state.starts.push(start)
      const payload = Buffer.from(`${start}-${frames}-${quality}`)
      const meta = Buffer.from(JSON.stringify({ experiment: 'stratum-audio-poc-2', source_sha256: source.sha256,
        encoder: 'b'.repeat(64), quality, sample_rate: 48000, codec_sample_rate: 48000, channels: 2,
        presentation: { start, frames }, encoded_interval: { start, frames }, decoded_frames: frames,
        discard_start_frames: 0, discard_end_frames: 0, resample_tail_frames: 0, codec_decoded_frames: frames,
        codec_preskip_frames: 0, source_bytes_preserved: false, source_pcm_preserved: quality === 'lossless',
        payload_bytes: payload.length, payload_sha256: state.corrupt ? '0'.repeat(64) : createHash('sha256').update(payload).digest('hex') }))
      const size = Buffer.alloc(4); size.writeUInt32BE(meta.length)
      return { type: 'application/vnd.stratum.segment', bytes: Buffer.concat([size, meta, payload]) }
    }
  }
  return { state, connection }
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'astra-stratum-cache-'))
  const service = fake()
  const events: string[] = []
  const cache = new RemoteAudioCache(directory, 1024 * 1024, { analyze: async () => { throw new Error('Segments are not full tracks.') }, ready: key => { events.push(key) } })
  const tools = { decode: async () => Buffer.alloc(8), scan: async (_s: StratumProofSource, pcm: AsyncIterable<Buffer>) => {
    for await (const _chunk of pcm) { /* Require every retained interval. */ }
    service.state.scans++; return analysis
  } }
  const owner = new StratumAudioCache(cache, tools)
  t.after(async () => { await owner.close(); await cache.close(); await rm(directory, { recursive: true, force: true }) })
  return { ...service, cache, owner, directory, events, tools }
}
async function until(check: () => boolean) { for (let i = 0; i < 1000; i++) { if (check()) return; await delay(5) }; assert.fail('Timed out') }

test('partial intervals survive restart, reuse locally, and never trigger incomplete analysis', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const p = await f.owner.open(f.connection, options, signal())
  assert.equal((await p.segment(0, 'lossless', signal())).localCacheHit, false)
  assert.equal(p.complete, false); assert.equal(f.state.scans, 0)
  p.dispose(); await p.releaseRemote(); await f.owner.close(); await f.cache.close()
  const cache = new RemoteAudioCache(f.directory)
  const owner = new StratumAudioCache(cache, f.tools)
  t.after(async () => { await owner.close(); await cache.close() })
  f.state.offline = true
  const warm = await owner.open(f.connection, options, signal())
  assert.equal((await warm.segment(0, 'lossless', signal())).localCacheHit, true)
  assert.equal(f.state.opens, 1); assert.equal(f.state.reads, 1)
  await assert.rejects(warm.segment(192000, 'lossless', signal()))
  warm.dispose()
})

test('complete mixed quality coverage supplies persisted analysis without changing the current loudness snapshot', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const p = await f.owner.open(f.connection, { ...options, profile: 'automatic' }, signal())
  await p.segment(0, 'lossless', signal())
  await p.segment(192000, 'opus-128', signal())
  assert.equal(f.state.scans, 0)
  assert.equal(p.analysisReady, false)
  await p.segment(384000, 'opus-64', signal())
  await until(() => f.events.length === 1)
  assert.equal(p.complete, true); assert.equal(p.analysis, null)
  assert.equal(p.analysisReady, true, 'readiness changes for this playback without changing its loudness snapshot')
  assert.deepEqual(await f.cache.getAnalysis(p.analysisKey), analysis)
  p.dispose(); await p.releaseRemote()
  f.state.offline = true
  const warm = await f.owner.open(f.connection, { ...options, profile: 'automatic' }, signal())
  assert.deepEqual(warm.analysis, analysis)
  warm.dispose()
  const original = await f.owner.open(f.connection, options, signal())
  assert.notEqual(original.analysisKey, p.analysisKey); assert.equal(original.analysis, null)
  assert.equal(original.complete, false); original.dispose()
  assert.equal(f.state.reads, 3, 'analysis and warm startup must never fetch audio')
})

test('current and next groups survive Clear cache; unprotected segments share its budget and are cleared', async t => {
  const f = await fixture(t)
  const current = await f.owner.open(f.connection, options, signal())
  await current.segment(0, 'lossless', signal())
  const next = await f.owner.open(f.connection, { ...options, track: 'next' }, signal())
  await next.segment(192000, 'opus-128', signal())
  const before = await f.cache.status()
  await f.cache.clearUnused()
  assert.deepEqual(await f.cache.status(), before)
  assert.deepEqual(current.cachedRanges, [{ start: 0, end: 4, qualities: ['lossless'] }])
  assert.deepEqual(next.cachedRanges, [{ start: 4, end: 8, qualities: ['opus-128'] }])
  await f.cache.setLimitBytes(1)
  assert.deepEqual(await f.cache.status(), before)
  current.dispose(); next.dispose()
  await Promise.all([current.releaseRemote(), next.releaseRemote()])
  await f.cache.clearUnused()
  assert.equal((await f.cache.status()).usedBytes, 0)
  assert.deepEqual(current.cachedRanges, [], 'released playback cannot report an evictable snapshot as current')
})

test('diagnostics report actual partial cache islands and quality variants before replay requests', async t => {
  const f = await fixture(t)
  const p = await f.owner.open(f.connection, options, signal())
  await p.segment(0, 'lossless', signal())
  await p.segment(0, 'opus-64', signal())
  await p.segment(384000, 'opus-128', signal())
  const expected = [{ start: 0, end: 4, qualities: ['lossless', 'opus-64'] }, { start: 8, end: 10, qualities: ['opus-128'] }]
  assert.deepEqual(p.cachedRanges, expected)
  p.dispose(); await p.releaseRemote()
  f.state.offline = true
  const replay = await f.owner.open(f.connection, options, signal())
  t.after(() => replay.dispose())
  const reads = f.state.reads
  assert.deepEqual(replay.cachedRanges, expected)
  replay.cachedRanges[0].qualities.length = 0
  assert.deepEqual(replay.cachedRanges, expected, 'view snapshots cannot mutate cache inventory')
  assert.equal(f.state.reads, reads, 'opening and sampling the view must not fetch missing music')
})

test('account, catalog revision and quality cannot reuse another representation; invalid packets are not retained', async t => {
  const f = await fixture(t)
  const p = await f.owner.open(f.connection, options, signal())
  await p.segment(0, 'lossless', signal())
  await p.segment(0, 'opus-128', signal())
  assert.equal(f.state.reads, 2)
  for (const change of [{ scope: 'another-account' }, { revision: 'changed-file' }]) {
    const other = await f.owner.open(f.connection, { ...options, ...change }, signal())
    assert.equal((await other.segment(0, 'lossless', signal())).localCacheHit, false)
    other.dispose(); await other.releaseRemote()
  }
  f.state.corrupt = true
  await assert.rejects(p.segment(192000, 'lossless', signal()))
  p.dispose(); await p.releaseRemote()
  f.state.corrupt = false
  const retry = await f.owner.open(f.connection, options, signal())
  assert.equal((await retry.segment(192000, 'lossless', signal())).localCacheHit, false)
  retry.dispose()
  for (const name of await readdir(f.directory)) {
    if (name.endsWith('.json')) assert.equal((await readFile(join(f.directory, name), 'utf8')).includes('test-only'), false)
  }
})

test('automatic offline playback can use retained lower quality; a fixed request cannot', async t => {
  const f = await fixture(t)
  const p = await f.owner.open(f.connection, { ...options, profile: 'automatic' }, signal())
  await p.segment(0, 'opus-128', signal())
  p.dispose(); await p.releaseRemote()
  f.state.offline = true
  const warm = await f.owner.open(f.connection, { ...options, profile: 'automatic' }, signal())
  const segment = await warm.segment(0, 'lossless', signal())
  assert.equal(segment.localCacheHit, true); assert.equal(segment.metadata.quality, 'opus-128')
  warm.dispose()
  const fixed = await f.owner.open(f.connection, options, signal())
  await assert.rejects(fixed.segment(0, 'lossless', signal()))
  fixed.dispose()
})


test('a cancelled cached download closes its slot before the next track opens', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  const p = await f.owner.open(f.connection, options, signal())
  let release!: () => void
  f.state.segmentHold = new Promise<void>(resolve => { release = resolve })
  const old = assert.rejects(p.segment(0, 'lossless', signal()))
  await until(() => f.state.reads === 1)
  p.dispose()
  const replacement = f.owner.open(f.connection, { ...options, track: 'next' }, signal())
  await delay(20)
  assert.equal(f.state.opens, 1, 'replacement must wait for the pending segment and slot cleanup')
  release()
  await old
  const next = await replacement
  assert.equal(f.state.closes, 1); assert.equal(f.state.opens, 2)
  next.dispose(); await next.releaseRemote()
})


test('budget eviction removes an old segmented track with its source index instead of leaving unusable packets', async t => {
  const f = await fixture(t)
  const p = await f.owner.open(f.connection, options, signal())
  await p.segment(0, 'lossless', signal())
  await p.segment(192000, 'lossless', signal())
  const before = (await f.cache.status()).usedBytes
  p.dispose(); await p.releaseRemote()
  await f.cache.setLimitBytes(before - 1)
  assert.equal((await f.cache.status()).usedBytes, 0)
})

test('fetch ahead finishes on disk and frees the server without waiting for any PCM consumption', async t => {
  const f = await fixture(t)
  const p = await f.owner.open(f.connection, options, signal())
  const diagnostics = new StratumSegmentDiagnostics()
  let bytes = 0
  const fetcher = new StratumFetchAhead(p, 0, signal(), 'lossless', diagnostics, n => { bytes += n })
  await fetcher.finished
  assert.equal(f.state.reads, 3); assert.equal(f.state.closes, 1); assert.equal(p.complete, true)
  assert.deepEqual(diagnostics.snapshot().segments.map(s => s.state), ['received', 'received', 'received'])
  await until(() => f.events.length === 1)
  assert.ok(await f.cache.getAnalysis(p.analysisKey), 'analysis can finish before the decoder consumes any interval')
  f.state.offline = true
  let decodedBytes = 0
  for (const start of [0, 192000, 384000]) {
    const { segment, diagnostic } = await fetcher.take(start)
    assert.equal(segment.localCacheHit, true)
    decodedBytes += segment.payload.length
    diagnostic.decoding(); diagnostic.decoded()
  }
  assert.equal(bytes, decodedBytes, 'disk rereads must not double-count downloaded bytes')
  assert.equal(f.state.reads, 3)
  assert.ok(diagnostics.snapshot().segments.every(s => s.localCacheHit === false), 'diagnostics describe the original fetch, not decoder rereads')
  p.dispose()
})

test('fetch ahead keeps exact interval qualities and starts at the seek interval', async t => {
  const f = await fixture(t)
  const p = await f.owner.open(f.connection, { ...options, profile: 'automatic' }, signal())
  const starts: number[] = []
  const fetcher = new StratumFetchAhead(p, 192000, signal(), start => {
    starts.push(start); return start === 192000 ? 'opus-64' : 'lossless'
  }, new StratumSegmentDiagnostics(), () => {})
  await fetcher.finished
  assert.deepEqual(starts, [192000, 384000], 'seeking must not wait for earlier missing audio')
  assert.equal(p.complete, false)
  assert.equal(p.playableAhead(0), 0, 'a cached tail is not contiguous audio at the start')
  assert.equal(p.playableAhead(5), 5)
  assert.equal((await fetcher.take(192000)).segment.metadata.quality, 'opus-64')
  assert.equal((await fetcher.take(384000)).segment.metadata.quality, 'lossless')
  p.dispose()
})

test('a failed later fetch preserves earlier intervals and never fetches past the failure', async t => {
  const f = await fixture(t)
  const p = await f.owner.open(f.connection, options, signal())
  let completed = 0
  const fetcher = new StratumFetchAhead(p, 0, signal(), 'lossless', new StratumSegmentDiagnostics(), () => {
    if (++completed === 1) f.state.corrupt = true
  })
  await fetcher.finished
  assert.deepEqual([...new Set(f.state.starts)], [0, 192000], 'retries may repeat the failing interval, never fetch a later one')
  assert.equal(f.state.closes, 1)
  assert.equal((await fetcher.take(0)).segment.metadata.quality, 'lossless')
  await assert.rejects(fetcher.take(192000))
  await assert.rejects(fetcher.take(384000))
  assert.equal(p.playableAhead(0), 4)
  p.dispose()
})

test('cancelling fetch ahead stops later requests while preserving completed cache intervals', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  const p = await f.owner.open(f.connection, options, controller.signal)
  const fetcher = new StratumFetchAhead(p, 0, controller.signal, 'lossless', new StratumSegmentDiagnostics(), () => controller.abort())
  await fetcher.finished
  assert.equal(f.state.reads, 1); assert.equal(f.state.closes, 1)
  await assert.rejects(fetcher.take(0))
  p.dispose()
  f.state.offline = true
  const retry = await f.owner.open(f.connection, options, signal())
  assert.equal((await retry.segment(0, 'lossless', signal())).localCacheHit, true)
  retry.dispose()
})

test('cancelling an in-flight fetch-ahead request cleans up before replacement and stops its queued tail', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  const p = await f.owner.open(f.connection, options, controller.signal)
  let release!: () => void
  f.state.segmentHold = new Promise<void>(resolve => { release = resolve })
  const fetcher = new StratumFetchAhead(p, 0, controller.signal, 'lossless', new StratumSegmentDiagnostics(), () => {})
  const failedRead = assert.rejects(fetcher.take(0))
  await until(() => f.state.reads === 1)
  controller.abort(); p.dispose()
  const replacement = f.owner.open(f.connection, { ...options, track: 'next' }, signal())
  await delay(20)
  assert.equal(f.state.opens, 1)
  release()
  await fetcher.finished; await failedRead
  const next = await replacement
  assert.equal(f.state.closes, 1); assert.equal(f.state.opens, 2)
  assert.deepEqual(f.state.starts, [0], 'none of the queued intervals may start after cancellation')
  next.dispose(); await next.releaseRemote()
})

test('automatic fetch ahead reuses retained qualities without treating disk reads as network delivery', async t => {
  const f = await fixture(t)
  const first = await f.owner.open(f.connection, { ...options, profile: 'automatic' }, signal())
  await first.segment(0, 'opus-128', signal())
  await first.segment(192000, 'lossless', signal())
  await first.segment(384000, 'opus-64', signal())
  first.dispose(); await first.releaseRemote()
  f.state.offline = true
  const warm = await f.owner.open(f.connection, { ...options, profile: 'automatic' }, signal())
  assert.equal(warm.playableAhead(1.5), 8.5)
  assert.equal(warm.retainedQuality(0, 'lossless'), 'opus-128')
  assert.equal(warm.retainedQuality(192000, 'opus-64'), 'lossless')
  const diagnostics = new StratumSegmentDiagnostics()
  const fetcher = new StratumFetchAhead(warm, 0, signal(), 'lossless', diagnostics, () => {})
  await fetcher.finished
  assert.equal(f.state.opens, 1); assert.equal(f.state.reads, 3)
  assert.deepEqual(diagnostics.snapshot().segments.map(s => [s.quality, s.localCacheHit]),
    [['opus-128', true], ['lossless', true], ['opus-64', true]])
  warm.dispose()
  const fixed = await f.owner.open(f.connection, options, signal())
  assert.equal(fixed.playableAhead(0), 0); assert.equal(fixed.playableAhead(4), 4)
  assert.equal(fixed.retainedQuality(0, 'lossless'), undefined)
  fixed.dispose()
})
