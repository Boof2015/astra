import assert from 'node:assert/strict'
import test from 'node:test'
import { ProviderPlaybackService, type PlaybackReport, type PlaybackReportClient } from './providerPlayback.ts'
import type { ProviderPlaybackSnapshot } from '../../types/providerPlayback.ts'

const path = 'subsonic://7/track/a'
function harness(overrides: Partial<ConstructorParameters<typeof ProviderPlaybackService>[0]> = {}) {
  let now = 0
  const reports: { action: string; report: PlaybackReport }[] = []
  const client: PlaybackReportClient = Object.fromEntries(['start', 'progress', 'stop', 'scrobble'].map(action => [action,
    async (report: PlaybackReport) => { reports.push({ action, report: { ...report } }) }])) as unknown as PlaybackReportClient
  const service = new ProviderPlaybackService({ now: () => now, wallNow: () => 1_800_000_000_000 + now,
    watchdog: false, resolve: async () => client, ...overrides })
  const observe = (position: number, state: ProviderPlaybackSnapshot['state'] = 'playing', extra: Partial<ProviderPlaybackSnapshot> = {}) => {
    service.observe({ sessionId: 'one', path, state, position, duration: 60, ...extra })
  }
  return { service, reports, client, observe, advance: (ms = 1000) => { now += ms } }
}

test('live status starts immediately, reports pause/seek/buffering, and never counts preparation', async () => {
  const h = harness()
  h.observe(0, 'loading')
  h.observe(0, 'paused')
  await h.service.flush()
  assert.equal(h.reports.length, 0)
  h.observe(0)
  await h.service.flush()
  assert.deepEqual(h.reports.map(r => r.action), ['start'])
  h.advance(); h.observe(1)
  h.advance(); h.observe(45) // Seeking does not fabricate 44 seconds of listening.
  await h.service.flush()
  assert.equal(h.reports.at(-1)?.report.position, 45)
  h.observe(45, 'paused')
  await h.service.flush()
  assert.equal(h.reports.at(-1)?.report.state, 'paused')
  h.advance(100_000); h.observe(45, 'paused')
  h.observe(45, 'loading')
  await h.service.flush()
  h.advance(100_000); h.observe(0, 'loading')
  await h.service.flush()
  assert.equal(h.reports.at(-1)?.report.position, 45)
  assert.equal(h.reports.some(r => r.action === 'scrobble'), false)
  h.observe(45, 'stopped')
  await h.service.flush()
  assert.equal(h.reports.at(-1)?.action, 'stop')
})

for (const [duration, threshold] of [[60, 30], [600, 240], [0, 240], [29, null]] as const) {
  test(`qualified plays: duration ${duration} counts once at ${threshold ?? 'never'}`, async () => {
    const h = harness()
    h.observe(0, 'playing', { duration })
    await h.service.flush()
    for (let second = 1; second <= (threshold ?? 29) + 2; second++) {
      h.advance(); h.observe(second, 'playing', { duration })
      await h.service.flush()
      assert.equal(h.reports.filter(r => r.action === 'scrobble').length, threshold && second >= threshold ? 1 : 0)
    }
    h.observe(250, 'stopped', { duration })
    await h.service.flush()
    const scrobbles = h.reports.filter(r => r.action === 'scrobble')
    assert.equal(scrobbles.length, threshold ? 1 : 0)
    assert.equal(h.reports.filter(r => r.action === 'progress').length, Math.floor(((threshold ?? 29) + 2) / 10))
    if (threshold) assert.equal(scrobbles[0].report.startedAt, 1_800_000_000_000)
  })
}

test('pause, buffering, rewind and a frozen playhead add no played time', async () => {
  const h = harness()
  h.observe(0); await h.service.flush()
  for (let i = 1; i < 30; i++) { h.advance(); h.observe(i) }
  h.observe(29, 'paused'); await h.service.flush()
  h.advance(100_000); h.observe(29, 'playing')
  h.advance(); h.observe(0) // rewind
  for (let i = 0; i < 50; i++) { h.advance(); h.observe(0) }
  h.observe(0, 'loading'); h.advance(100_000); h.observe(0, 'playing')
  await h.service.flush()
  assert.equal(h.reports.some(r => r.action === 'scrobble'), false)
  h.advance(); h.observe(1); await h.service.flush()
  assert.equal(h.reports.filter(r => r.action === 'scrobble').length, 1)
})

test('repeated copies of a track have distinct live sessions; stale stop cannot end the new play', async () => {
  const h = harness()
  h.observe(0); await h.service.flush()
  h.advance(); h.observe(0, 'playing', { sessionId: 'two' }); await h.service.flush()
  h.observe(1, 'stopped')
  await h.service.flush()
  assert.deepEqual(h.reports.map(r => [r.action, r.report.sessionId]), [['start', 'one'], ['stop', 'one'], ['start', 'two']])
  await h.service.shutdown()
  assert.equal(h.reports.at(-1)?.report.sessionId, 'two')
  assert.equal(h.reports.at(-1)?.action, 'stop')
})

test('slow reporting coalesces stale progress and orders stop before the next start', async () => {
  let release!: () => void
  const h = harness()
  const start = h.client.start
  h.client.start = async (report, signal) => { await start(report, signal); await new Promise<void>(r => { release = r }) }
  h.observe(0, 'playing', { duration: 600 })
  await new Promise(resolve => setImmediate(resolve))
  for (let i = 1; i <= 100; i++) { h.advance(); h.observe(i, 'playing', { duration: 600 }) }
  h.observe(0, 'playing', { sessionId: 'two', path: 'subsonic://7/track/b' })
  h.client.start = start
  release()
  await h.service.flush()
  assert.deepEqual(h.reports.map(r => r.action), ['start', 'stop', 'start'])
  assert.equal(h.reports[1].report.position, 100)
  assert.equal(h.reports[2].report.path, 'subsonic://7/track/b')
})

test('late discovery never announces a superseded play; other servers remain independent', async () => {
  let release!: () => void
  const h = harness({ resolve: async (source) => {
    if (source.provider === 'subsonic') await new Promise<void>(r => { release = r })
    return h.client
  } })
  h.observe(0)
  await new Promise(resolve => setImmediate(resolve))
  h.observe(0, 'playing', { path: 'jellyfin://8/track/b', sessionId: 'two' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.reports[0].report.path, 'jellyfin://8/track/b')
  release(); await h.service.flush()
  assert.equal(h.reports.length, 1)
  for (let i = 1; i <= 60; i++) { h.advance(); h.observe(i, 'playing', { path: 'jellyfin://8/track/b', sessionId: 'two' }) }
  await h.service.flush()
  assert.equal(h.reports.some(r => r.action === 'scrobble'), false, 'Jellyfin owns its play-count policy')
})

test('delayed start is immediately followed by the latest live position and pause state', async () => {
  let release!: () => void
  const h = harness()
  const start = h.client.start
  h.client.start = async (report, signal) => { await start(report, signal); await new Promise<void>(r => { release = r }) }
  h.observe(0)
  await new Promise(resolve => setImmediate(resolve))
  h.advance(); h.observe(1)
  h.advance(); h.observe(2, 'paused')
  release(); await h.service.flush()
  assert.deepEqual(h.reports.map(r => [r.action, r.report.state, r.report.position]), [
    ['start', 'playing', 0], ['progress', 'paused', 2]
  ])
})

test('counted-play failures are not replayed and malformed observations are ignored', async () => {
  const h = harness()
  let attempts = 0
  h.client.scrobble = async () => { attempts++; throw new Error('ambiguous timeout') }
  h.observe(0); await h.service.flush()
  for (let i = 1; i <= 60; i++) { h.advance(); h.observe(i); await h.service.flush() }
  assert.equal(attempts, 1)
  h.service.observe({ sessionId: 'bad', path, state: 'playing', position: NaN, duration: 0 })
  h.service.observe({ sessionId: 'bad', path, state: 'playing', position: 0, duration: -1 })
  await h.service.shutdown()
  assert.equal(h.reports.at(-1)?.report.sessionId, 'one')
})

test('a missing renderer heartbeat freezes the live clock without starting another play on recovery', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const h = harness({ watchdog: true })
  h.observe(0); await h.service.flush()
  for (let i = 1; i <= 20; i++) { h.advance(); h.observe(i) }
  await h.service.flush()
  h.advance(31_000); t.mock.timers.tick(5000)
  await h.service.flush()
  assert.equal(h.reports.at(-1)?.report.state, 'loading')
  h.observe(20)
  for (let i = 21; i <= 30; i++) { h.advance(); h.observe(i) }
  await h.service.flush()
  assert.equal(h.reports.filter(r => r.action === 'start').length, 1)
  assert.equal(h.reports.filter(r => r.action === 'scrobble').length, 1)
  h.observe(30, 'paused')
  h.advance(60_000); t.mock.timers.tick(60_000)
  await h.service.flush()
  assert.equal(h.reports.at(-1)?.report.state, 'paused')
  await h.service.shutdown()
})

test('failed connection setup can recover live reporting on a later heartbeat', async () => {
  let attempts = 0
  const h = harness({ requestTimeoutMs: 5, resolve: async (_source, signal) => {
    if (++attempts === 1) await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('offline')), { once: true }))
    return h.client
  } })
  h.observe(0); await h.service.flush()
  assert.equal(h.reports.length, 0)
  h.advance(10_000); h.observe(10); await h.service.flush()
  assert.equal(h.reports[0].action, 'start')
  assert.equal(h.reports[0].report.position, 10)
  await h.service.shutdown()
})
