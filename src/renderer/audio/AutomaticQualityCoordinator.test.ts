import assert from 'node:assert/strict'
import test from 'node:test'
import { AutomaticQualityCoordinator, type AutomaticPlaybackSnapshot } from './AutomaticQualityCoordinator.ts'

function harness() {
  let resolve!: (value: { complete: boolean }) => void
  const prepared = new Promise<{ complete: boolean }>(done => { resolve = done })
  const applied: unknown[] = [], released: string[] = [], failures: unknown[] = []
  let snapshot: AutomaticPlaybackSnapshot | null = { path: 'subsonic://1/a', identity: 'a:1',
    quality: { mode: 'automatic', requested: 'original', requestedCodec: null, delivered: null },
    position: 12, bufferedSeconds: 22, loadedBytes: 10000, totalBytes: null, complete: false }
  const coordinator = new AutomaticQualityCoordinator({
    snapshot: () => snapshot, recommend: async () => 128, prepare: async () => prepared,
    release: async id => { released.push(id) }, apply: async (state, request) => { applied.push({ state, request }) },
    failed: async state => { failures.push(state) }, now: () => 5000
  })
  return { coordinator, applied, released, failures, ready: resolve,
    snapshot: () => snapshot!, change: (value: AutomaticPlaybackSnapshot | null) => { snapshot = value } }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('current playback is untouched until a prepared candidate is ready; commit uses the latest position', async () => {
  const h = harness()
  const pending = h.coordinator.tick()
  await flush()
  assert.equal(h.applied.length, 0)
  h.change({ ...h.snapshot(), position: 14 })
  h.ready({ complete: false })
  await pending
  assert.equal(h.applied.length, 1)
  assert.equal((h.applied[0] as any).state.position, 14)
  assert.deepEqual((h.applied[0] as any).request, { mode: 'automatic', target: 128 })
  assert.equal(h.released.length, 1)
})

for (const action of ['seek', 'pause', 'skip', 'cache-completes'] as const) {
  test(`${action} prevents an obsolete quality preparation from replacing playback`, async () => {
    const h = harness()
    const pending = h.coordinator.tick()
    await flush()
    if (action === 'seek') h.coordinator.cancel()
    else if (action === 'pause') h.change(null)
    else if (action === 'skip') h.change({ ...h.snapshot(), identity: 'b:2' })
    else h.change({ ...h.snapshot(), complete: true })
    h.ready({ complete: false })
    await pending
    assert.equal(h.applied.length, 0)
    assert.equal(h.failures.length, 0)
    assert.ok(h.released.length)
  })
}

test('an unready or failed replacement never interrupts the current stream', async () => {
  let failed = 0, applied = 0
  const state = harness().snapshot()
  const coordinator = new AutomaticQualityCoordinator({ snapshot: () => state, recommend: async () => 64,
    prepare: async () => { throw new Error('Conversion refused') }, release: async () => {},
    apply: async () => { applied++ }, failed: async () => { failed++ } })
  await coordinator.tick()
  assert.equal(applied, 0)
  assert.equal(failed, 1)
})
