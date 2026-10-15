import assert from 'node:assert/strict'
import test from 'node:test'
import { AutomaticStreamingQuality, type AutomaticQualityConditions } from './automaticStreamingQuality.ts'
import { isStreamingQualityRequest, playbackQualityRequest, parseStreamingQualitySettings } from '../../types/streamingQuality.ts'

function network() {
  let now = 0
  const policy = new AutomaticStreamingQuality(() => now)
  const observe = policy.observer('server')
  observe({ phase: 'start' })
  return { policy, observe, advance: (ms: number) => { now += ms },
    feed: (kbps: number, seconds: number) => {
      for (let i = 0; i < seconds; i++) { now += 1000; observe({ phase: 'data', bytes: kbps * 125 }) }
    } }
}
const conditions: AutomaticQualityConditions = { originalKbps: 2000, current: 'original', position: 20,
  duration: 300, bufferedSeconds: 26, loadedBytes: 6_000_000, totalBytes: 75_000_000, complete: false }

test('both modes begin at Original without evidence, and settings/pins retain the selected automatic mode', () => {
  const h = network()
  for (const mode of ['automatic', 'automatic-original'] as const) {
    assert.equal(h.policy.select('server', mode, 2000), 'original')
    const pin = playbackQualityRequest({ mode, requested: 192, requestedCodec: 'mp3', delivered: null })
    assert.deepEqual(pin, { mode, target: 192 })
    assert.ok(isStreamingQualityRequest(pin))
    assert.equal(parseStreamingQualitySettings(JSON.stringify({ global: mode })).global, mode)
  }
  for (const invalid of [{ mode: 'automatic', target: 93 }, { mode: 'original', target: 128 }, { target: 128 }]) {
    assert.equal(isStreamingQualityRequest(invalid), false)
  }
})

test('one-second dips and ample lookahead do not trigger a downgrade', () => {
  const h = network()
  h.feed(6000, 15)
  h.feed(200, 1)
  assert.equal(h.policy.recommend('server', 'automatic', conditions), null)
  h.feed(6000, 5)
  assert.equal(h.policy.recommend('server', 'automatic', conditions), null)
  h.feed(200, 20)
  for (let i = 0; i < 8; i++) {
    assert.equal(h.policy.recommend('server', 'automatic', { ...conditions, bufferedSeconds: 299 }), null)
    h.feed(200, 1)
  }
})

test('sustained shortfall predicts exhaustion and chooses the highest sustainable preset', () => {
  const h = network()
  h.feed(300, 4)
  assert.equal(h.policy.recommend('server', 'automatic', conditions), null)
  h.feed(300, 3)
  assert.equal(h.policy.recommend('server', 'automatic', conditions), 192)
  assert.equal(h.policy.recommend('server', 'automatic', { ...conditions, complete: true }), null)
  assert.equal(h.policy.recommend('server', 'automatic', { ...conditions, position: 294 }), null)
})

test('prioritize-original uses more of its buffer and needs a longer sustained shortfall', () => {
  const h = network()
  h.feed(1200, 4)
  assert.equal(h.policy.select('server', 'automatic', 1000), 320)
  assert.equal(h.policy.select('server', 'automatic-original', 1000), 'original')
  h.feed(800, 25)
  const smallBuffer = { ...conditions, originalKbps: 1000, position: 0, bufferedSeconds: 3, loadedBytes: 0 }
  assert.equal(h.policy.recommend('server', 'automatic', smallBuffer), null)
  assert.equal(h.policy.recommend('server', 'automatic-original', smallBuffer), null)
  h.feed(800, 3)
  assert.equal(h.policy.recommend('server', 'automatic', smallBuffer), 320)
  assert.equal(h.policy.recommend('server', 'automatic-original', smallBuffer), null)
  assert.equal(h.policy.recommend('server', 'automatic-original', { ...smallBuffer, bufferedSeconds: 1 }), null)
  h.feed(800, 6)
  assert.equal(h.policy.recommend('server', 'automatic-original', { ...smallBuffer, bufferedSeconds: 1 }), 320)
})

test('upgrades need sustained recovery and settling time, including across track boundaries', () => {
  const h = network()
  h.policy.committed('server', 'automatic', 128)
  h.feed(6000, 3)
  assert.equal(h.policy.select('server', 'automatic', 2000), 128, 'a boundary and short burst are insufficient')
  h.feed(6000, 12)
  assert.equal(h.policy.recommend('server', 'automatic', { ...conditions, current: 128 }), null, 'settling still applies')
  h.feed(6000, 16)
  assert.equal(h.policy.recommend('server', 'automatic', { ...conditions, current: 128 }), 'original')
  assert.equal(h.policy.select('server', 'automatic', 2000), 'original')
})

test('cache idle time cannot prove recovery; server evidence is isolated and simultaneous transfers are not double-clocked', () => {
  const h = network()
  h.feed(200, 4)
  h.observe({ phase: 'end' })
  h.advance(21_000)
  assert.equal(h.policy.evidence('server'), null)
  assert.equal(h.policy.evidence('other-account'), null)
  const second = h.policy.observer('server')
  h.observe({ phase: 'start' }); second({ phase: 'start' })
  for (let i = 0; i < 5; i++) {
    h.advance(500); h.observe({ phase: 'data', bytes: 12_500 })
    h.advance(500); second({ phase: 'data', bytes: 12_500 })
  }
  assert.equal(h.policy.evidence('server')?.kbps, 200)
})

test('a stalled source supplies zero-byte evidence and failed preparations have a retry cooldown', () => {
  const h = network()
  h.feed(400, 4)
  h.advance(6000)
  assert.ok(h.policy.evidence('server')!.kbps < 400)
  h.policy.failed('server', 'automatic')
  h.feed(200, 4)
  assert.equal(h.policy.recommend('server', 'automatic', conditions), null)
})

test('repeated fast complete downloads can establish recovery without inventing bandwidth from idle cache hits', () => {
  const h = network()
  h.observe({ phase: 'end' })
  h.policy.committed('server', 'automatic', 128)
  for (let i = 0; i < 3; i++) {
    h.advance(16_000)
    h.observe({ phase: 'start' })
    h.advance(100)
    h.observe({ phase: 'data', bytes: 1024 * 1024 })
    h.observe({ phase: 'end' })
    if (i < 2) assert.equal(h.policy.select('server', 'automatic', 2000), 128)
  }
  assert.equal(h.policy.select('server', 'automatic', 2000), 'original')
})
