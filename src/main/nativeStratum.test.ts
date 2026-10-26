import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeStratumRegistry } from './nativeStratum.ts'

test('native Stratum pending work is bounded, sender-scoped and cancelled on owner teardown', async () => {
  const pending: Array<{ signal: AbortSignal; finish(): void }> = []
  let failures = 0
  const registry = new NativeStratumRegistry({
    route: async (_path, _quality, signal) => {
      await new Promise<void>(resolve => { pending.push({ signal, finish: resolve }) })
      return null
    },
    allocateId: () => 1, ffmpeg: async () => null,
    started: () => assert.fail('a cancelled route cannot start'), failed: () => { failures++ }
  })
  const request = { policy: 'processed', slot: 'current', startTimeSeconds: 0 } as const
  const opens = Array.from({ length: 4 }, (_, i) => registry.open(1, String(i), 'subsonic://1/a', 'original', request))
  const rejected = opens.map(open => assert.rejects(open, /cancelled/))
  await new Promise<void>(resolve => setImmediate(resolve))
  await assert.rejects(registry.open(1, 'overflow', 'subsonic://1/a', 'original', request), /Too many/)
  await registry.release(2, '0')
  assert.equal(pending[0].signal.aborted, false)
  await registry.releaseOwner(1)
  assert.ok(pending.every(work => work.signal.aborted))
  for (const work of pending) work.finish()
  await Promise.all(rejected)
  assert.equal(failures, 0, 'cancellation must not mark the server as failed')
  assert.throws(() => registry.progress(1, '0'), /no longer/)
  await registry.close()
})
