import assert from 'node:assert/strict'
import test from 'node:test'
import { StratumPrefetchGate, canPrefetchStratum, type StratumPrefetchState } from './stratumPrefetch.ts'
import { StratumFetchAhead } from './stratumFetchAhead.ts'
import { StratumSegmentDiagnostics } from './streamingDiagnostics.ts'
import type { StratumCachedPlayback } from './stratumAudioCache.ts'

const signal = () => new AbortController().signal
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('the live report cannot spend current playback’s six-second buffer on two minutes of next-track cache', async () => {
  const gate = new StratumPrefetchGate()
  const state: StratumPrefetchState = { slot: 'next', nextAhead: 120, current: [{ ahead: 6.4, complete: false }] }
  let reads = 0
  const pending = gate.wait(() => canPrefetchStratum(state), signal()).then(() => { reads++ })
  await tick(); assert.equal(reads, 0)
  state.current[0].ahead = 20; gate.changed()
  await tick(); assert.equal(reads, 0)
  state.current[0].ahead = 32; gate.changed()
  await pending; assert.equal(reads, 1)
})

test('prime a short gapless successor, then yield until current playback has a larger reserve', () => {
  const state: StratumPrefetchState = { slot: 'next', nextAhead: 0, current: [{ ahead: 12, complete: false }] }
  assert.equal(canPrefetchStratum(state), true)
  state.nextAhead = 4
  assert.equal(canPrefetchStratum(state), true)
  state.nextAhead = 8
  assert.equal(canPrefetchStratum(state), false)
  state.current[0].complete = true
  state.current[0].ahead = 2
  assert.equal(canPrefetchStratum(state), true, 'a fully retained short tail must not prevent gapless preparation')
})

test('promotion and current-track removal wake an already waiting successor', async () => {
  for (const action of ['promote', 'remove'] as const) {
    const gate = new StratumPrefetchGate()
    const state: StratumPrefetchState = { slot: 'next', nextAhead: 100, current: [{ ahead: 1, complete: false }] }
    const pending = gate.wait(() => canPrefetchStratum(state), signal())
    if (action === 'promote') state.slot = 'current'
    else state.current = []
    gate.changed()
    await pending
  }
})

test('cancellation removes waiting work without starting it or keeping a polling timer alive', async () => {
  const gate = new StratumPrefetchGate()
  const stop = new AbortController()
  let calls = 0
  const pending = assert.rejects(gate.wait(() => { calls++; return false }, stop.signal), { name: 'AbortError' })
  stop.abort(); await pending
  const before = calls
  gate.changed()
  assert.equal(calls, before)
})

test('current playback has no fetch horizon; healthy next-track fetching is not limited to a prefix', () => {
  assert.equal(canPrefetchStratum({ slot: 'current', nextAhead: 500, current: [{ ahead: 0, complete: false }] }), true)
  assert.equal(canPrefetchStratum({ slot: 'next', nextAhead: 500, current: [{ ahead: 100, complete: false }] }), true)
})

test('shared constrained bandwidth sustains playback and primes the successor instead of filling it at the current track’s expense', async () => {
  // Run the real download schedulers against a deterministic shared link. Each
  // four-second interval needs 2.8 seconds alone, or 5.6 when both tracks fetch.
  // This models contention, not the user's particular Network Link Conditioner.
  async function simulate(prioritize: boolean) {
    const gate = new StratumPrefetchGate(), stop = new AbortController()
    const pending = new Set<{ left: number; finish: () => void }>()
    let position = 0, stalls = 0
    const make = (duration: number, initial: number) => {
      const state = { end: initial }
      const cached = {
        playback: { source: { sample_rate: 48000, frames: duration * 48000 } },
        retainedQuality: (start: number) => start / 48000 < state.end ? 'opus-64' : undefined,
        releaseRemote: async () => {},
        segment: async (start: number, _quality: string, signal: AbortSignal) => {
          signal.throwIfAborted()
          const localCacheHit = start / 48000 < state.end
          if (!localCacheHit) await new Promise<void>((resolve, reject) => {
            const abort = () => { pending.delete(request); reject(signal.reason) }
            const request = { left: 2.8, finish: () => {
              pending.delete(request); signal.removeEventListener('abort', abort)
              state.end = start / 48000 + 4; resolve()
            } }
            pending.add(request); signal.addEventListener('abort', abort, { once: true })
          })
          return { metadata: { quality: 'opus-64' }, payload: Buffer.alloc(32), localCacheHit }
        }
      } as unknown as StratumCachedPlayback
      return { state, cached }
    }
    const current = make(180, 24), next = make(240, 0)
    const allowed = () => !prioritize || canPrefetchStratum({ slot: 'next', nextAhead: next.state.end,
      current: [{ ahead: current.state.end - position, complete: current.state.end >= 180 }] })
    const downloads = [
      new StratumFetchAhead(current.cached, 24 * 48000, stop.signal, 'opus-64', new StratumSegmentDiagnostics(), () => gate.changed()),
      new StratumFetchAhead(next.cached, 0, stop.signal, 'opus-64', new StratumSegmentDiagnostics(), () => gate.changed(),
        undefined, signal => gate.wait(allowed, signal))
    ]
    try {
      await tick()
      for (let time = 0; time < 1200; time++) {
        const work = [...pending]
        for (const request of work) {
          request.left -= .1 / work.length
          if (request.left <= .000001) request.finish()
        }
        await tick()
        const played = Math.min(.1, Math.max(0, current.state.end - position))
        position += played; stalls += .1 - played
        gate.changed(); await tick()
      }
      return { stalls, nextSeconds: next.state.end }
    } finally {
      stop.abort(); await Promise.all(downloads.map(download => download.finished))
      assert.equal(pending.size, 0)
    }
  }
  const unbounded = await simulate(false), prioritized = await simulate(true)
  assert.ok(unbounded.stalls > 8, `fixture must expose contention: ${JSON.stringify(unbounded)}`)
  assert.ok(prioritized.stalls < .001, JSON.stringify(prioritized))
  assert.ok(prioritized.nextSeconds >= 8, 'the gapless successor still gets primed')
  assert.ok(prioritized.nextSeconds < unbounded.nextSeconds, 'capacity goes to current playback when its reserve shrinks')
})
