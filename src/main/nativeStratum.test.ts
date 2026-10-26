import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeStratumRegistry } from './nativeStratum.ts'

test('direct Stratum pins Original and preserves explicit conventional compatibility retries', async () => {
  const requests: unknown[] = []
  let failures = 0
  const registry = new NativeStratumRegistry({
    route: async (_path, quality) => {
      requests.push(quality)
      return { connection: { endpoint: 'http://127.0.0.1:1', session: 'test' }, track: 'a', quality: 'opus-64',
        mode: 'automatic', key: 'test' }
    },
    allocateId: () => 1, ffmpeg: async () => null,
    started: () => assert.fail('missing decoder cannot start'), failed: () => { failures++ }
  })
  const request = { policy: 'direct', slot: 'current', startTimeSeconds: 0 } as const
  for (const quality of [64, 'automatic', 'automatic-original', 'original'] as const) {
    assert.deepEqual(await registry.open(1, String(quality), 'subsonic://1/a', quality, request), { fallbackQuality: 'original' })
  }
  assert.deepEqual(requests, ['original', 'original', 'original', 'original'])
  assert.equal(failures, 4)
  assert.equal(await registry.open(1, 'compat', 'subsonic://1/a', { target: 'original', compatibility: 'flac' }, request), null)
  assert.equal(requests.length, 4)
  await registry.close()
})

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
