import type { StreamingDiagnosticsSession, StreamingDiagnosticSegment } from '../../types/streamingDiagnostics.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { diagnosticBufferedRange, diagnosticMapSpans, diagnosticWindow, pollStreamingDiagnostics, streamingTimingReport, type StreamingDiagnosticsReading } from './streamingDiagnostics.ts'

const reading: StreamingDiagnosticsReading = { title: 'Track', artist: 'Artist', duration: 180, position: 90,
  playbackState: 'playing', start: 80, bufferedEnd: 100, completeLocalBuffer: false,
  transport: 'stream', session: null, next: null, loadedBytes: 900, totalBytes: 1000 }

test('copied timing reports retain failed/pending attempts but omit identifying fields and bound their size', () => {
  const segments = Array.from({ length: 300 }, (_, i) => ({ ...segment(i * 4, i === 299 ? 'requesting' : 'decoded'),
    elapsedMs: 8000, connectionMs: 6000, responseWaitMs: 1200, transferMs: 700, decodeMs: 100,
    privateDetail: 'PRIVATE-SEGMENT-DATA' }))
  const session: StreamingDiagnosticsSession = { sessionId: 9876, transport: 'stratum', start: 0, duration: 1200,
    bufferedEnd: 1196, sourceRate: 44100, outputRate: 48000, channels: 2, loadedBytes: 9600000,
    totalBytes: null, localCacheComplete: false, state: 'preparing', omittedSegments: 4, segments }
  const raw = streamingTimingReport({ ...reading, title: 'PRIVATE-TITLE', artist: 'PRIVATE-ARTIST',
    trackKey: 'PRIVATE-PATH', transport: 'stratum', session, next: null })
  assert.doesNotMatch(raw, /PRIVATE|sessionId|9876|trackKey/)
  const report = JSON.parse(raw)
  assert.equal(report.current.segments.length, 256)
  assert.equal(report.current.omittedSegments, 48)
  assert.equal(report.current.segments.at(-1).state, 'requesting')
  assert.equal(report.current.segments.at(-1).elapsedMs, 8000)
  assert.equal(report.current.segments.at(-1).connectionMs, 6000)
  assert.equal(report.current.segments.at(-1).responseWaitMs, 1200)
  assert.equal(report.next, null)
  assert.equal(segments.length, 300, 'export must not mutate the live trace')
})

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

test('activity map separates retained islands, prepared PCM, transfers and unprepared time after a seek', () => {
  const session: StreamingDiagnosticsSession = { sessionId: 1, transport: 'stratum', start: 8, duration: 24,
    bufferedEnd: 12, sourceRate: 48000, outputRate: 48000, channels: 2, loadedBytes: 500, totalBytes: null,
    localCacheComplete: false, state: 'preparing', omittedSegments: 0,
    cachedRanges: [{ start: 0, end: 4, qualities: ['lossless'] }, { start: 8, end: 12, qualities: ['lossless', 'opus-64'] },
      { start: 20, end: 24, qualities: ['opus-128'] }],
    segments: [segment(8, 'decoded', 'opus-64'), { ...segment(12, 'downloading'), receivedBytes: 100, transferTotalBytes: 400 }] }
  const actual = diagnosticMapSpans({ ...reading, transport: 'stratum', start: 8, position: 9, duration: 24, bufferedEnd: 12, session })
  assert.deepEqual(actual.map(s => [s.start, s.end, s.state, s.quality, s.progress]), [
    [0, 4, 'cached', 'lossless', null], [4, 8, 'unprepared', null, null], [8, 9, 'cached', 'opus-64', null],
    [9, 12, 'buffered', 'opus-64', null], [12, 16, 'downloading', 'lossless', .25],
    [16, 20, 'unprepared', null, null], [20, 24, 'cached', 'opus-128', null]
  ])
  // A Sidecar hit or old receipt is not Astra's retained cache.
  session.cachedRanges = []
  session.segments = [segment(0, 'received')]
  assert.equal(diagnosticMapSpans({ ...reading, transport: 'stratum', session, bufferedEnd: 0 })[0].state, 'unprepared')
})

test('unknown transfer size stays indeterminate; reading retained music does not pretend to download', () => {
  const session: StreamingDiagnosticsSession = { sessionId: 1, transport: 'stratum', start: 0, duration: 8,
    bufferedEnd: 0, sourceRate: 48000, outputRate: 48000, channels: 2, loadedBytes: 100, totalBytes: null,
    localCacheComplete: false, state: 'preparing', omittedSegments: 0, segments: [segment(0, 'downloading')] }
  const sample = { ...reading, session, transport: 'stratum' as const, start: 0, position: 0, duration: 8, bufferedEnd: 0 }
  assert.equal(diagnosticMapSpans(sample)[0].progress, null)
  session.segments[0].state = 'requesting'
  session.cachedRanges = [{ start: 0, end: 4, qualities: ['lossless'] }]
  assert.equal(diagnosticMapSpans(sample)[0].state, 'cached')
  assert.equal(diagnosticMapSpans({ ...sample, duration: NaN }).length, 0)
})

function segment(start: number, state: StreamingDiagnosticSegment['state'], quality: StreamingDiagnosticSegment['quality'] = 'lossless'): StreamingDiagnosticSegment {
  return { start, end: start + 4, quality, state, receivedBytes: 100, payloadBytes: null,
    elapsedMs: 20, transferMs: null, decodeMs: null, serverCacheHit: true }
}
