import assert from 'node:assert/strict'
import test from 'node:test'
import { StratumLinkEstimates, StratumQualityController, stratumPlaybackQuality } from './stratumQuality.ts'
import { STRATUM_QUALITIES } from '../../shared/stratumQuality.ts'
import { StratumProofError } from './stratumProofTransport.ts'
import { StratumNetworkError } from './stratumNetwork.ts'
import type { StratumProofQuality } from './stratumProofClient.ts'

const source = { sha256: 'a'.repeat(64), sample_rate: 48000, channels: 2, bits_per_sample: 24, frames: 48000 * 240 }
const FRAMES = 4 * 48000
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function rig(options: { mode?: 'automatic' | 'automatic-original'; ahead?: number; pinInitial?: boolean; initial?: StratumProofQuality;
  qualities?: readonly StratumProofQuality[] } = {}) {
  const state = { now: 0, ahead: options.ahead ?? 0 }
  const estimates = new StratumLinkEstimates(() => state.now)
  const controller = new StratumQualityController({ mode: options.mode ?? 'automatic', key: 'account', source,
    initial: options.initial ?? 'lossless', pinInitial: options.pinInitial, now: () => state.now, estimates,
    buffer: () => ({ position: 0, ahead: state.ahead }), qualities: () => options.qualities })
  /** One completed network transfer at a given rate, through the controller's own timing. */
  const transfer = (quality: StratumProofQuality, kbps: number, overheadMs: number, bytes: number) => {
    const timing = controller.begin(FRAMES, quality)
    state.now += overheadMs
    timing.observe({ phase: 'start' })
    state.now += bytes * 8 / kbps
    timing.observe({ phase: 'data', bytes })
    timing.observe({ phase: 'end', complete: true })
    timing.ready(quality, FRAMES, bytes)
    timing.close()
  }
  const link = (kbps: number, overheadMs: number) => {
    estimates.overhead('account', overheadMs)
    estimates.body('account', kbps)
  }
  return { state, estimates, controller, transfer, link }
}
const OPUS_128_BYTES = 69_580, LOSSLESS_BYTES = 900_000

test('Automatic chooses and reports every advertised high bitrate without inventing legacy support', () => {
  for (const [bandwidth, target] of [[350, 192], [450, 256], [600, 320]] as const) {
    const full = rig({ qualities: STRATUM_QUALITIES, ahead: 20 })
    full.link(bandwidth, 100)
    const quality = full.controller.choose(FRAMES)
    assert.equal(quality, `opus-${target}`)
    assert.equal(stratumPlaybackQuality(source, quality, 'automatic').requested, target)
    const legacy = rig({ ahead: 20 }); legacy.link(bandwidth, 100)
    assert.equal(legacy.controller.choose(FRAMES), 'opus-128')
  }
  const subset = rig({ qualities: ['opus-64', 'opus-256', 'lossless'], ahead: 20 })
  assert.equal(subset.controller.choose(FRAMES), 'opus-64', 'cold start cannot invent 128 support')
  const pinned = rig({ qualities: ['opus-64', 'lossless'], initial: 'opus-320', pinInitial: true })
  assert.equal(pinned.controller.choose(FRAMES), 'opus-64')
})

test('expanded ladder failures still reach a cheap quality within three attempts', async () => {
  const r = rig({ qualities: STRATUM_QUALITIES, ahead: 0 })
  r.link(150_000, 100)
  const attempts: StratumProofQuality[] = []
  const result = await r.controller.fetch(FRAMES, 'lossless', new AbortController().signal, async quality => {
    attempts.push(quality)
    if (quality !== 'opus-64') throw new Error('network failed')
    return quality
  })
  assert.deepEqual(attempts, ['lossless', 'opus-128', 'opus-64'])
  assert.equal(result, 'opus-64')
})

test('a cold start with no evidence or hint begins at Opus 128 in both automatic modes, never Original first', () => {
  for (const mode of ['automatic', 'automatic-original'] as const) {
    assert.equal(rig({ mode }).controller.choose(FRAMES), 'opus-128')
  }
  const fast = rig()
  fast.link(150_000, 100)
  assert.equal(fast.controller.choose(FRAMES), 'lossless', 'fresh LAN evidence may start at Original')
  const seek = rig({ pinInitial: true, initial: 'opus-64' })
  seek.link(150_000, 100)
  assert.equal(seek.controller.choose(FRAMES), 'opus-64', 'a seek keeps its pinned representation')
})

test('each interval is chosen from what it costs to fetch, including request overhead', () => {
  const threeG = rig({ ahead: 60 })
  threeG.link(700, 500)
  assert.equal(threeG.controller.choose(FRAMES), 'opus-128')
  // Even with a full buffer, Original cannot be fetched as fast as it plays.
  for (let i = 0; i < 6; i++) { threeG.transfer('opus-128', 700, 500, OPUS_128_BYTES); assert.equal(threeG.controller.choose(FRAMES), 'opus-128') }
  const edge = rig({ ahead: 60 })
  edge.link(220, 1500)
  assert.equal(edge.controller.choose(FRAMES), 'opus-64', '128 would take as long as it plays once overhead is paid')
  // A fast body alone does not justify a rung whose overhead eats the interval.
  const slowServer = rig({ ahead: 60 })
  slowServer.link(5_000, 2_600)
  assert.equal(slowServer.controller.choose(FRAMES), 'opus-64')
})

test('one slow transfer lowers the estimate at once; recovery needs buffer and fresh evidence', () => {
  const r = rig({ ahead: 3 })
  r.link(150_000, 100)
  assert.equal(r.controller.choose(FRAMES), 'lossless')
  r.transfer('lossless', 150_000, 100, LOSSLESS_BYTES)
  assert.equal(r.controller.choose(FRAMES), 'lossless')
  r.transfer('lossless', 700, 500, LOSSLESS_BYTES)
  assert.equal(r.controller.choose(FRAMES), 'opus-128', 'a single 3G transfer after LAN speeds leaves Original immediately')
  // Back on a fast link: two fresh samples and enough buffer are needed for each step.
  r.state.ahead = 30
  r.transfer('opus-128', 150_000, 100, OPUS_128_BYTES)
  assert.equal(r.controller.choose(FRAMES), 'opus-128', 'one sample since the change is not enough')
  r.transfer('opus-128', 150_000, 100, OPUS_128_BYTES)
  r.transfer('opus-128', 150_000, 100, OPUS_128_BYTES)
  assert.equal(r.controller.choose(FRAMES), 'lossless')
})

for (const qualities of [undefined, STRATUM_QUALITIES]) test(`an unthrottled cold start reaches Original by the third interval (${qualities ? 'expanded' : 'legacy'})`, () => {
  const r = rig({ qualities })
  const chosen: StratumProofQuality[] = []
  for (let i = 0; i < 4; i++) {
    const quality = r.controller.choose(FRAMES)
    chosen.push(quality)
    r.transfer(quality, 150_000, 100, quality === 'lossless' ? LOSSLESS_BYTES : OPUS_128_BYTES)
    r.state.ahead += 4
  }
  assert.deepEqual(chosen.slice(0, 3), ['opus-128', 'opus-128', 'lossless'])
})

test('an expanded ladder drops a late Original directly to a sustainable quality', () => {
  const r = rig({ qualities: STRATUM_QUALITIES, ahead: 3.5 })
  r.link(150_000, 100)
  assert.equal(r.controller.choose(FRAMES), 'lossless')
  let lower: StratumProofQuality | undefined
  const timing = r.controller.begin(FRAMES, 'lossless', quality => { lower = quality })
  r.state.now += 500
  timing.observe({ phase: 'start' })
  for (let i = 0; i < 6 && !lower; i++) {
    r.state.now += 16384 * 8 / 220
    timing.observe({ phase: 'data', bytes: 16384 })
  }
  timing.close()
  assert.equal(lower, 'opus-64', 'do not spend the remaining buffer stepping through high bitrates')
})

test('a buffer shorter than the next interval’s fetch time chooses a rung that arrives in time', () => {
  const r = rig({ ahead: 60 })
  r.link(700, 500)
  assert.equal(r.controller.choose(FRAMES), 'opus-128')
  // 128 takes ~1.3 s and 64 ~0.9 s here; one second of buffer is kept in reserve.
  r.state.ahead = 2.5
  assert.equal(r.controller.choose(FRAMES), 'opus-128')
  r.state.ahead = 2
  assert.equal(r.controller.choose(FRAMES), 'opus-64')
})

test('an in-flight interval is abandoned only when it would arrive late and a lower one arrives sooner', () => {
  const run = (ahead: number, kbps: number, overheadMs: number) => {
    const r = rig({ ahead })
    r.link(kbps, overheadMs)
    let lower: StratumProofQuality | undefined
    const timing = r.controller.begin(FRAMES, 'lossless', value => { lower = value })
    r.state.now += overheadMs
    timing.observe({ phase: 'start' })
    for (let i = 0; i < 6 && !lower; i++) {
      r.state.now += 16384 * 8 / kbps
      timing.observe({ phase: 'data', bytes: 16384 })
    }
    timing.close()
    return lower
  }
  assert.equal(run(3.5, 700, 500), 'opus-128', 'a LAN→3G drop with 3.5 s buffered replaces the late Original interval')
  assert.equal(run(60, 700, 500), undefined, 'a deep buffer lets the slow interval finish')
  assert.equal(run(0, 150_000, 100), undefined, 'a lower rung that would not arrive sooner is not worth a new connection')
  // Edge cold start: no shared estimate yet, but this request already waited
  // ~1.9 s for headers. A replacement would pay that again plus a new connection.
  const edge = rig()
  let lower: StratumProofQuality | undefined
  const timing = edge.controller.begin(FRAMES, 'opus-128', value => { lower = value })
  edge.state.now += 1900
  timing.observe({ phase: 'start' })
  for (let i = 0; i < 4 && !lower; i++) { edge.state.now += 4096 * 8 / 220; timing.observe({ phase: 'data', bytes: 4096 }) }
  timing.close()
  assert.equal(lower, undefined, 'the nearly finished cold-start interval is kept')
})

test('silence moves down a rung only after patience; the lowest rung is left to the transport deadline', async () => {
  const run = async (quality: StratumProofQuality, silentMs: number) => {
    const r = rig({ ahead: 2 })
    r.link(700, 500)
    let lower: StratumProofQuality | undefined
    const timing = r.controller.begin(FRAMES, quality, value => { lower = value })
    r.state.now += silentMs
    await delay(650)
    timing.close()
    return lower
  }
  assert.equal(await run('lossless', 4000), undefined, 'four seconds of congestion is not a dead transfer')
  assert.equal(await run('lossless', 9000), 'opus-128')
  assert.equal(await run('opus-64', 9000), undefined, 'restarting the cheapest request only loses its place in the queue')
})

test('failures move down a rung, are bounded, and never retry refusals or cancellation', async () => {
  const r = rig({ ahead: 30 })
  r.link(150_000, 100)
  const attempted: StratumProofQuality[] = []
  const result = await r.controller.fetch(FRAMES, 'lossless', new AbortController().signal, async quality => {
    attempted.push(quality)
    if (attempted.length < 3) throw new StratumNetworkError('timeout')
    return quality
  })
  assert.deepEqual(attempted, ['lossless', 'opus-128', 'opus-64'])
  assert.equal(result, 'opus-64')
  await assert.rejects(r.controller.fetch(FRAMES, 'opus-64', new AbortController().signal, async () => {
    throw new StratumNetworkError('interrupted')
  }), StratumNetworkError, 'three attempts at most')
  let refused = 0
  await assert.rejects(r.controller.fetch(FRAMES, 'lossless', new AbortController().signal, async () => {
    refused++; throw new StratumProofError(404)
  }), StratumProofError)
  assert.equal(refused, 1, 'a revoked track is not requested again')
  const cancel = new AbortController()
  let cancelled = 0
  await assert.rejects(r.controller.fetch(FRAMES, 'lossless', cancel.signal, async () => {
    cancelled++; cancel.abort(); throw new Error('aborted')
  }))
  assert.equal(cancelled, 1)
})

test('abandonment replaces the same interval and records the partial transfer as link evidence', async () => {
  const r = rig({ ahead: 3.5 })
  r.link(150_000, 100)
  const attempted: StratumProofQuality[] = []
  const result = await r.controller.fetch(FRAMES, 'lossless', new AbortController().signal, async (quality, signal, timing) => {
    attempted.push(quality)
    timing!.observe({ phase: 'start' })
    if (quality === 'lossless') {
      // The link has just dropped to 3G.
      for (let i = 0; i < 40 && !signal.aborted; i++) {
        r.state.now += 16384 * 8 / 700
        timing!.observe({ phase: 'data', bytes: 16384 })
      }
      assert.ok(signal.aborted, 'the late Original interval was abandoned')
      throw new Error('aborted')
    }
    r.state.now += OPUS_128_BYTES * 8 / 700
    timing!.observe({ phase: 'data', bytes: OPUS_128_BYTES })
    timing!.ready(quality, FRAMES, OPUS_128_BYTES)
    return quality
  })
  assert.deepEqual(attempted, ['lossless', 'opus-128'])
  assert.equal(result, 'opus-128')
  assert.ok(r.estimates.get('account')!.kbps < 2000, 'the partial 3G transfer pulled the estimate down')
})

test('a track’s short final interval keeps the sustainable quality', () => {
  const r = rig({ ahead: 60 })
  r.link(150_000, 100)
  assert.equal(r.controller.choose(FRAMES), 'lossless')
  assert.equal(r.controller.choose(317), 'lossless', 'request overhead cannot fit 7 ms of audio, but the link is still fast')
})

test('link estimates are shared by one account and isolated from others', () => {
  const estimates = new StratumLinkEstimates(() => 0)
  estimates.overhead('a', 100); estimates.body('a', 150_000)
  const make = (key: string) => new StratumQualityController({ mode: 'automatic', key, source, initial: 'lossless',
    now: () => 0, estimates, buffer: () => ({ position: 0, ahead: 0 }) })
  assert.equal(make('a').choose(FRAMES), 'lossless', 'a successor on the same account reuses the estimate')
  assert.equal(make('b').choose(FRAMES), 'opus-128')
})

test('the last known link survives a pause as a weaker hint for the first interval only', () => {
  const lan = rig()
  lan.link(150_000, 100)
  lan.state.now += 6 * 60_000
  assert.equal(lan.estimates.get('account'), null, 'no longer fresh evidence')
  const after = new StratumQualityController({ mode: 'automatic', key: 'account', source, initial: 'lossless',
    now: () => lan.state.now, estimates: lan.estimates, buffer: () => ({ position: 0, ahead: 0 }) })
  assert.equal(after.choose(FRAMES), 'lossless', 'a LAN listener starts at Original after a pause')
  assert.equal(after.choose(FRAMES), 'lossless', 'without fresh evidence later intervals keep the current quality')
  const slow = rig()
  slow.link(700, 500)
  slow.state.now += 6 * 60_000
  const resumed = new StratumQualityController({ mode: 'automatic', key: 'account', source, initial: 'lossless',
    now: () => slow.state.now, estimates: slow.estimates, buffer: () => ({ position: 0, ahead: 0 }) })
  assert.equal(resumed.choose(FRAMES), 'opus-128', 'a 3G hint starts at 128')
})

test('saved hints restore across restarts by digest only, and a damaged store is a cold start', () => {
  const store = { saved: null as string | null, read: () => store.saved, write: (value: string) => { store.saved = value } }
  const before = new StratumLinkEstimates(() => 0, () => 1_000)
  before.attach(store)
  before.overhead('stratum:secret-bearer', 100); before.body('stratum:secret-bearer', 150_000)
  before.flush()
  assert.ok(store.saved && !store.saved.includes('secret-bearer'), 'saved keys are digests')
  const restarted = new StratumLinkEstimates(() => 0, () => 2_000)
  restarted.attach(store)
  const make = (estimates: StratumLinkEstimates) => new StratumQualityController({ mode: 'automatic', key: 'stratum:secret-bearer',
    source, initial: 'lossless', now: () => 0, estimates, buffer: () => ({ position: 0, ahead: 0 }) })
  assert.equal(make(restarted).choose(FRAMES), 'lossless')
  const expired = new StratumLinkEstimates(() => 0, () => 31 * 24 * 60 * 60_000)
  expired.attach(store)
  assert.equal(make(expired).choose(FRAMES), 'opus-128', 'hints expire after 30 days')
  store.saved = '{"version":1,"links":{"nope":{"kbps":"x"}}}'
  const damaged = new StratumLinkEstimates(() => 0, () => 2_000)
  damaged.attach(store)
  assert.equal(make(damaged).choose(FRAMES), 'opus-128')
})

test('a wrong LAN hint on a 3G link costs one abandoned interval, priced from its own transfer', () => {
  const r = rig()
  r.link(150_000, 100)
  r.state.now += 6 * 60_000
  const controller = new StratumQualityController({ mode: 'automatic', key: 'account', source, initial: 'lossless',
    now: () => r.state.now, estimates: r.estimates, buffer: () => ({ position: 0, ahead: 0 }) })
  assert.equal(controller.choose(FRAMES), 'lossless')
  let lower: StratumProofQuality | undefined
  const timing = controller.begin(FRAMES, 'lossless', value => { lower = value })
  r.state.now += 550
  timing.observe({ phase: 'start' })
  for (let i = 0; i < 6 && !lower; i++) { r.state.now += 16384 * 8 / 700; timing.observe({ phase: 'data', bytes: 16384 }) }
  timing.close()
  assert.equal(lower, 'opus-128')
})

test('a retained lower interval is replaced only when the link clearly supports better', () => {
  const r = rig()
  assert.equal(r.controller.prefers('opus-128'), false, 'no evidence: use what is retained')
  r.link(700, 500)
  assert.equal(r.controller.prefers('opus-64'), true)
  assert.equal(r.controller.prefers('opus-128'), false, '3G cannot sustain Original')
  const fast = rig()
  fast.link(150_000, 100)
  assert.equal(fast.controller.prefers('opus-128'), true)
  assert.equal(fast.controller.prefers('lossless'), false)
})

test('an upgrade’s deadline is when playback reaches that interval, not the end of retained audio', () => {
  const run = (start?: number) => {
    const r = rig({ ahead: 60 })
    r.link(700, 500)
    let lower: StratumProofQuality | undefined
    const timing = r.controller.begin(FRAMES, 'lossless', value => { lower = value }, start)
    r.state.now += 500
    timing.observe({ phase: 'start' })
    for (let i = 0; i < 6 && !lower; i++) { r.state.now += 16384 * 8 / 700; timing.observe({ phase: 'data', bytes: 16384 }) }
    timing.close()
    return lower
  }
  assert.equal(run(), undefined, 'the next missing interval may use the whole buffer')
  assert.equal(run(4 * 48000), 'opus-128', 'an interval needed in four seconds falls back in time')
})
