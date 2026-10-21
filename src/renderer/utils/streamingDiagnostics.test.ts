import assert from 'node:assert/strict'
import test from 'node:test'
import { diagnosticBufferedRange, diagnosticWindow, pollStreamingDiagnostics, type StreamingDiagnosticsReading } from './streamingDiagnostics.ts'

const reading: StreamingDiagnosticsReading = { title: 'Track', artist: 'Artist', duration: 180, position: 90,
  playbackState: 'playing', start: 80, bufferedEnd: 100, completeLocalBuffer: false,
  transport: 'stream', session: null, next: null, loadedBytes: 900, totalBytes: 1000 }

test('buffer maps respect seeks and never turn byte progress into track time', () => {
  assert.deepEqual(diagnosticBufferedRange(reading), { start: 80, end: 100 })
  assert.equal(diagnosticBufferedRange({ ...reading, start: null }), null)
  assert.deepEqual(diagnosticBufferedRange({ ...reading, completeLocalBuffer: true }), { start: 0, end: 180 })
  assert.deepEqual(diagnosticBufferedRange({ ...reading, bufferedEnd: 200 }), { start: 80, end: 180 })
})

test('long tracks get a labelled, bounded window; ordinary tracks show the whole track', () => {
  assert.deepEqual(diagnosticWindow(180, 140), { start: 0, end: 180 })
  assert.deepEqual(diagnosticWindow(1800, 900), { start: 852, end: 1092 })
  assert.deepEqual(diagnosticWindow(1800, 1799), { start: 1560, end: 1800 })
  assert.equal(diagnosticWindow(NaN, 0), null)
})

test('diagnostic polling does not overlap, publish hidden/stale samples, or continue after closing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let visible = true, calls = 0, removed = false
  let visibilityChanged = () => {}
  let finish!: (value: number) => void
  const values: number[] = []
  const stop = pollStreamingDiagnostics({
    read: () => { calls++; return new Promise<number>(resolve => { finish = resolve }) },
    deliver: value => values.push(value), failed: () => assert.fail('unexpected failure'), visible: () => visible,
    subscribeVisibility: changed => { visibilityChanged = changed; return () => { removed = true } }
  })
  t.mock.timers.tick(5000)
  assert.equal(calls, 1, 'slow IPC must not queue reads')
  visible = false; visibilityChanged()
  visible = true; visibilityChanged()
  finish(1)
  await Promise.resolve()
  assert.deepEqual(values, [], 'a pre-hide response must not reappear')
  t.mock.timers.tick(500)
  assert.equal(calls, 2)
  finish(2)
  await Promise.resolve()
  assert.deepEqual(values, [2])
  visible = false; visibilityChanged()
  t.mock.timers.tick(5000)
  assert.equal(calls, 2)
  visible = true; visibilityChanged()
  assert.equal(calls, 3)
  stop(); finish(3)
  await Promise.resolve()
  t.mock.timers.tick(5000)
  assert.deepEqual(values, [2])
  assert.equal(calls, 3)
  assert.equal(removed, true)
})
