import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeRemoteLeaseRegistry } from './nativeRemoteLeaseRegistry.ts'
import { createNativeRemoteSourceResolver } from '../preload/nativeRemoteSource.ts'

test('processed Subsonic tries Stratum; direct and other providers retain conventional acquisition', async () => {
  const calls: string[] = []
  const resolve = createNativeRemoteSourceResolver(async channel => {
    calls.push(channel)
    if (channel === 'native-stratum:open') return null
    if (channel === 'native-remote:acquire') return { url: 'http://cache', duration: 1 }
  })
  for (const [path, policy, expected] of [
    ['subsonic://1/a', 'processed', true], ['subsonic://1/a', 'direct', false], ['jellyfin://1/a', 'processed', false]
  ] as const) {
    calls.length = 0
    const source = await resolve(path, new AbortController().signal, 'original', { policy, slot: 'current', startTimeSeconds: 0 })
    assert.equal(calls.includes('native-stratum:open'), expected)
    assert.ok(calls.includes('native-remote:acquire'))
    source.release()
  }
})

test('cancelling pending Stratum acquisition releases only its request and never falls back', async () => {
  let deliver!: (value: null) => void
  const calls: Array<[string, unknown]> = []
  const resolve = createNativeRemoteSourceResolver(async (channel, id) => {
    calls.push([channel, id])
    if (channel === 'native-stratum:open') return new Promise<null>(done => { deliver = done })
  })
  const stop = new AbortController()
  const pending = resolve('subsonic://1/a', stop.signal, 'original', { policy: 'processed', slot: 'current', startTimeSeconds: 0 })
  stop.abort(); deliver(null)
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(calls.map(call => call[0]), ['native-stratum:open', 'native-stratum:release'])
  assert.equal(calls[0][1], calls[1][1])
})

test('sender-scoped leases retain completed audio and release pending acquisitions on teardown', async () => {
  let released = 0
  let deliver!: () => void
  const registry = new NativeRemoteLeaseRegistry(async path => {
    if (path === 'pending') await new Promise<void>(resolve => { deliver = resolve })
    return { url: path, release: () => { released++ }, finished: async () => {},
      progress: () => ({ loadedBytes: 10, totalBytes: 10, complete: true }) }
  })
  await registry.acquire(1, 'a', 'ready')
  await registry.finished(1, 'a')
  assert.equal(released, 0, 'decode/download EOF must not release playback ownership')
  assert.throws(() => registry.progress(2, 'a'), /no longer/)
  registry.release(2, 'a')
  assert.equal(registry.progress(1, 'a').loadedBytes, 10)
  const pending = registry.acquire(1, 'b', 'pending')
  registry.releaseOwner(1)
  deliver()
  await assert.rejects(pending, /cancelled/)
  assert.equal(released, 2)
  assert.throws(() => registry.progress(1, 'a'), /no longer/)
})

test('preload cancellation releases its exact pending lease and never exposes a stale result', async () => {
  const calls: string[] = []
  let deliver!: (value: unknown) => void
  const resolve = createNativeRemoteSourceResolver(async (channel, id) => {
    calls.push(`${channel}:${id}`)
    if (channel.endsWith('acquire')) return new Promise(resolve => { deliver = resolve })
  })
  const controller = new AbortController()
  const pending = resolve('subsonic://test/track/a', controller.signal)
  controller.abort()
  deliver({ url: 'http://decoder-only', duration: 1 })
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].split(':').at(-1), calls[1].split(':').at(-1))
})

test('lease validation is interrupted by owner cleanup; requests have a fixed bound', async () => {
  const registry = new NativeRemoteLeaseRegistry(async () => ({
    url: 'cache', release() {}, progress: () => ({ loadedBytes: 0, totalBytes: null, complete: false }),
    finished: () => new Promise<void>(() => {})
  }))
  for (let i = 0; i < 4; i++) await registry.acquire(1, String(i), 'track')
  await assert.rejects(registry.acquire(1, 'overflow', 'track'), /Too many/)
  const validation = registry.finished(1, '0')
  registry.releaseOwner(1)
  await assert.rejects(validation, /cancelled/)
})
