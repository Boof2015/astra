import assert from 'node:assert/strict'
import test from 'node:test'
import { CompletedStreamingDiagnostics, StratumSegmentDiagnostics, STREAMING_DIAGNOSTIC_SEGMENT_LIMIT } from './streamingDiagnostics.ts'
import type { StreamingDiagnosticsSession } from '../../types/streamingDiagnostics.ts'

test('segment observations distinguish transfer, decoding, buffer delivery and unknown cache state', () => {
  let now = 100
  const trace = new StratumSegmentDiagnostics(() => now)
  const interval = trace.begin(12, 16, 'opus-64')
  now = 250
  assert.equal(trace.snapshot().segments[0].state, 'requesting')
  assert.equal(trace.snapshot().segments[0].elapsedMs, 150)
  interval.observe({ phase: 'start' })
  interval.observe({ phase: 'data', bytes: 1000 })
  now = 300
  interval.observe({ phase: 'end', complete: true })
  interval.received(980, null)
  assert.equal(trace.snapshot().segments[0].state, 'received')
  now = 320
  interval.decoded()
  now = 1000 // Waiting for playback capacity must not inflate preparation time.
  const segment = trace.snapshot().segments[0]
  assert.deepEqual(segment, { start: 12, end: 16, quality: 'opus-64', state: 'decoded', receivedBytes: 1000,
    payloadBytes: 980, elapsedMs: 220, transferMs: 50, decodeMs: 20, serverCacheHit: null })
  segment.state = 'failed'
  assert.equal(trace.snapshot().segments[0].state, 'decoded', 'IPC snapshots must not mutate the trace')
})

test('seek/skip failures stop pending timing and do not create cache hits', () => {
  let now = 0
  const trace = new StratumSegmentDiagnostics(() => now)
  const request = trace.begin(42.125, 46.125, 'lossless')
  now = 100
  request.failed(true)
  now = 200
  assert.equal(trace.snapshot().segments[0].elapsedMs, 100)
  assert.equal(trace.snapshot().segments[0].state, 'cancelled')
  assert.equal(trace.snapshot().segments[0].serverCacheHit, null)
  const next = trace.begin(46.125, 50.125, 'opus-128')
  next.received(2000, true)
  next.decoded()
  assert.equal(trace.snapshot().segments[1].serverCacheHit, true)
})

test('transfer progress uses the declared response length, including the segment envelope', () => {
  const trace = new StratumSegmentDiagnostics()
  const request = trace.begin(0, 4, 'lossless')
  request.observe({ phase: 'start', totalBytes: 4000 })
  request.observe({ phase: 'data', bytes: 1000 })
  assert.equal(trace.snapshot().segments[0].transferTotalBytes, 4000)
  assert.equal(trace.snapshot().segments[0].receivedBytes, 1000)
  assert.equal(trace.snapshot().segments[0].payloadBytes, null)
})

test('fetch-ahead receipts freeze transfer timing and exclude waiting for decoder capacity', () => {
  let now = 0
  const trace = new StratumSegmentDiagnostics(() => now)
  const first = trace.begin(0, 4, 'lossless')
  now = 100
  first.received(1000, false, false)
  const second = trace.begin(4, 8, 'opus-128')
  now = 200
  second.received(500, true, false)
  now = 60000
  assert.deepEqual(trace.snapshot().segments.map(s => s.elapsedMs), [100, 100])
  first.decoding()
  now += 20
  first.decoded()
  assert.equal(trace.snapshot().segments[0].decodeMs, 20)
  assert.equal(trace.snapshot().segments[0].elapsedMs, 120)
  assert.equal(trace.snapshot().segments[1].state, 'received')
})

test('long playback retains a bounded tail, including the active request', () => {
  const trace = new StratumSegmentDiagnostics()
  for (let i = 0; i < 1000; i++) trace.begin(i * 4, i * 4 + 4, 'lossless').decoded()
  trace.begin(4000, 4004, 'opus-64')
  const snapshot = trace.snapshot()
  assert.equal(snapshot.segments.length, STREAMING_DIAGNOSTIC_SEGMENT_LIMIT)
  assert.equal(snapshot.omittedSegments, 1001 - STREAMING_DIAGNOSTIC_SEGMENT_LIMIT)
  assert.equal(snapshot.segments.at(-1)?.state, 'requesting')
})

test('completed session retention is bounded and isolated by renderer', () => {
  const history = new CompletedStreamingDiagnostics()
  const owner = {}, other = {}
  const snapshot: StreamingDiagnosticsSession = { sessionId: 1, transport: 'stratum', start: 0, duration: 12,
    bufferedEnd: 12, sourceRate: 44100, outputRate: 48000, channels: 2, loadedBytes: 4096, totalBytes: null,
    localCacheComplete: true, cachedRanges: [{ start: 0, end: 12, qualities: ['lossless'] }], state: 'complete', segments: [], omittedSegments: 0 }
  for (let id = 1; id <= 9; id++) history.remember(owner, { ...snapshot, sessionId: id })
  assert.equal(history.get(owner, 5), undefined)
  assert.equal(history.get(owner, 6)?.sessionId, 6)
  assert.equal(history.get(other, 9), undefined)
  assert.equal(history.get(owner, 9)?.localCacheComplete, false)
  assert.deepEqual(history.get(owner, 9)?.cachedRanges, [], 'completed history must not claim released cache is still present')
  history.forget(owner, 9)
  assert.equal(history.get(owner, 9), undefined)
})
