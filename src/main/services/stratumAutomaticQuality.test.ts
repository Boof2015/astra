import assert from 'node:assert/strict'
import test from 'node:test'
import { AutomaticStreamingQuality, type AutomaticQualityConditions } from './automaticStreamingQuality.ts'
import { StratumAutomaticQuality } from './stratumAutomaticQuality.ts'

const source = { sha256: 'a'.repeat(64), sample_rate: 48000, channels: 2, bits_per_sample: 24, frames: 48000 * 300 }
const base: AutomaticQualityConditions = { current: 'original', originalKbps: 2000, duration: 300, position: 200,
  bufferedSeconds: 210, loadedBytes: 999_999_999, totalBytes: 1_000_000_000, complete: false,
  segments: { decisionKey: 'playback', bitrates: [64, 128], aheadSeconds: 10, nextSeconds: 4,
    overheadSeconds: .3, deliverySeconds: 4, mediaSeconds: 4, observedSeconds: 4 } }
function harness() {
  let now = 0
  const policy = new AutomaticStreamingQuality(() => now)
  const advance = (ms: number) => { now += ms }
  const feed = (kbps: number, seconds: number) => {
    const observe = policy.observer('stratum')
    observe({ phase: 'start' })
    for (let i = 0; i < seconds; i++) { advance(1000); observe({ phase: 'data', bytes: kbps * 125 }) }
    observe({ phase: 'end' })
  }
  return { policy, advance, feed, now: () => now }
}

test('segments use exact lookahead and their own ladder, without whole-file catch-up cost or final-12-second suppression', () => {
  const h = harness()
  h.feed(250, 4)
  assert.equal(h.policy.recommend('stratum', 'automatic', base), null)
  h.feed(250, 3)
  assert.equal(h.policy.recommend('stratum', 'automatic', base), 128, '64/128 are the supported proof ladder')
  assert.equal(h.policy.recommend('stratum', 'automatic', { ...base, position: 294 }), 128, 'there is still an unfetched final segment')
  assert.equal(h.policy.recommend('stratum', 'automatic', { ...base, complete: true }), null)
  const ample = { ...base, segments: { ...base.segments!, aheadSeconds: 24 } }
  assert.equal(h.policy.recommend('stratum', 'automatic', ample), null,
    'far into a song does not incur fetching another representation from its beginning')
})

test('segment decisions retain original-priority patience and ignore a brief dip', () => {
  const h = harness()
  h.feed(200, 4)
  const low = { ...base, segments: { ...base.segments!, aheadSeconds: 2 } }
  assert.equal(h.policy.recommend('stratum', 'automatic', low), null)
  assert.equal(h.policy.recommend('stratum', 'automatic-original', low), null)
  h.feed(200, 3)
  assert.equal(h.policy.recommend('stratum', 'automatic', low), 128)
  assert.equal(h.policy.recommend('stratum', 'automatic-original', low), null)
  h.feed(200, 3)
  assert.equal(h.policy.recommend('stratum', 'automatic-original', low), 128)
  const fresh = harness()
  fresh.feed(6000, 15); fresh.feed(200, 1)
  assert.equal(fresh.policy.recommend('stratum', 'automatic', low), null)
})

test('recovery requires sustained body-transfer evidence, settling time and enough segment buffer', () => {
  const h = harness()
  h.policy.committed('stratum', 'automatic', 64, 'playback')
  const reduced = { ...base, current: 64 as const, segments: { ...base.segments!, deliverySeconds: .5 } }
  h.feed(8000, 15)
  assert.equal(h.policy.recommend('stratum', 'automatic', reduced), null)
  h.feed(8000, 16)
  assert.equal(h.policy.recommend('stratum', 'automatic', reduced), 'original', 'small encoded segments do not cap estimated capacity')
  assert.equal(h.policy.recommend('stratum', 'automatic', { ...reduced, segments: { ...reduced.segments, aheadSeconds: 1 } }), null)
  h.advance(21_000)
  assert.equal(h.policy.recommend('stratum', 'automatic', reduced), null, 'idle buffering is not recovery evidence')
})

test('slow server/decoder readiness can threaten a buffer even with fast body delivery', () => {
  const h = harness()
  h.feed(8000, 4)
  const slow = { ...base, segments: { ...base.segments!, aheadSeconds: 1, deliverySeconds: 12, mediaSeconds: 4, overheadSeconds: 11 } }
  assert.equal(h.policy.recommend('stratum', 'automatic', slow), null)
  h.feed(8000, 4)
  assert.equal(h.policy.recommend('stratum', 'automatic', slow), 128)
})

test('Stratum transfer history and playback cooldowns cannot affect conventional streaming or a successor', () => {
  const h = harness()
  h.feed(250, 10)
  assert.equal(h.policy.select('normal-server', 'automatic', 2000), 'original')
  h.policy.committed('stratum', 'automatic', 64, 'playback')
  h.feed(8000, 16)
  const reduced = { ...base, current: 64 as const, segments: { ...base.segments!, deliverySeconds: .5 } }
  assert.equal(h.policy.recommend('stratum', 'automatic', reduced), null)
  assert.equal(h.policy.recommend('stratum', 'automatic', { ...reduced, segments: { ...reduced.segments!, decisionKey: 'successor' } }), 'original')
})

test('controller adapts with a deterministic delivery schedule and recovers', () => {
  const h = harness()
  let ahead = 12, position = 0
  const controller = new StratumAutomaticQuality({ mode: 'automatic', policy: h.policy, key: 'stratum', decisionKey: 'song',
    source, initial: 'lossless', now: h.now, buffer: () => ({ position, ahead }) })
  const run = (kbps: number, overhead = .2) => {
    const quality = controller.choose(48000 * 4)
    const bits = (quality === 'lossless' ? 1500 : quality === 'opus-64' ? 64 : 128) * 4000
    const seconds = bits / (kbps * 1000)
    const delivery = controller.begin(48000 * 4)
    h.advance(overhead * 1000)
    delivery.observe({ phase: 'start' })
    h.advance(seconds * 1000)
    delivery.observe({ phase: 'data', bytes: bits / 8 })
    delivery.observe({ phase: 'end' })
    delivery.ready(quality, 48000 * 4, bits / 8)
    position += seconds + overhead
    ahead = Math.min(24, Math.max(0, ahead - seconds - overhead) + 4)
    // Model bounded lookahead pacing. Idle time must not enter transfer samples.
    if (ahead >= 20) { h.advance(4000); position += 4; ahead -= 4 }
    return quality
  }
  assert.equal(run(8000), 'lossless')
  const slow = Array.from({ length: 8 }, () => run(700))
  assert.ok(slow.includes('opus-128') || slow.includes('opus-64'), slow.join(','))
  const recovered = Array.from({ length: 30 }, () => run(8000))
  assert.equal(recovered.at(-1), 'lossless', recovered.join(','))
  controller.close()
})

test('automatic seeks retain their pinned initial quality before evaluating later intervals', () => {
  const h = harness()
  h.feed(200, 8)
  for (const pinInitial of [false, true]) {
    const controller = new StratumAutomaticQuality({ mode: 'automatic', policy: h.policy, key: 'stratum', decisionKey: `seek-${pinInitial}`,
      source, initial: 'lossless', pinInitial, now: h.now, buffer: () => ({ position: 100, ahead: 0 }) })
    assert.equal(controller.choose(192000), pinInitial ? 'lossless' : 'opus-128')
    controller.close()
  }
})

test('observes a sustained slowdown within a long segment before fetching another one would empty the buffer', () => {
  const h = harness()
  let position = 0, delivered = 0, minimumAhead = Infinity
  const controller = new StratumAutomaticQuality({ mode: 'automatic', policy: h.policy, key: 'stratum', decisionKey: 'song',
    source, initial: 'lossless', now: h.now, buffer: () => ({ position, ahead: delivered - position }) })
  const advance = (seconds: number) => {
    h.advance(seconds * 1000)
    if (delivered) { position += seconds; minimumAhead = Math.min(minimumAhead, delivered - position) }
  }
  const run = (kbps: number) => {
    const quality = controller.choose(192000)
    const bytes = quality === 'lossless' ? 960000 : 70000
    const transfer = controller.begin(192000)
    advance(.18)
    transfer.observe({ phase: 'start' })
    for (let remaining = bytes; remaining > 0;) {
      const chunk = Math.min(remaining, 4096)
      advance(chunk * 8 / kbps / 1000)
      transfer.observe({ phase: 'data', bytes: chunk })
      remaining -= chunk
    }
    transfer.observe({ phase: 'end' })
    transfer.ready(quality, 192000, bytes)
    delivered += 4
    return quality
  }
  try {
    for (let i = 0; i < 4; i++) assert.equal(run(16000), 'lossless')
    assert.equal(run(900), 'lossless', 'the in-flight original interval finishes unchanged')
    run(900)
    assert.equal(run(900), 'opus-128', 'the next decision uses stress observed during transfer')
    assert.ok(minimumAhead > 0, `buffer emptied by ${-minimumAhead} seconds`)
  } finally { controller.close() }
})
