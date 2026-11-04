import assert from 'node:assert/strict'
import test from 'node:test'
import { StreamActivityPresentation, ACTIVITY_SETTLE_MS } from './streamActivityPresentation.ts'
import type { StreamingDiagnosticsReading } from './streamingDiagnostics.ts'

function sample(): StreamingDiagnosticsReading {
  return { trackKey: 'track-a', title: 'Track', artist: 'Artist', position: 0, duration: 180,
    playbackState: 'playing', bufferedEnd: 0, start: 0, completeLocalBuffer: false, transport: 'stratum', next: null,
    loadedBytes: 0, totalBytes: null, session: { sessionId: 1, transport: 'stratum', start: 0, duration: 180,
      bufferedEnd: 0, sourceRate: 48000, outputRate: 48000, channels: 2, loadedBytes: 0, totalBytes: null,
      localCacheComplete: false, state: 'preparing', omittedSegments: 0, segments: [], cachedRanges: [] } }
}
function cache(reading: StreamingDiagnosticsReading, start: number, end: number) {
  reading.session!.cachedRanges!.push({ start, end, qualities: ['lossless'] })
  reading.session!.segments.push({ start, end, quality: 'lossless', state: 'received', receivedBytes: 100,
    payloadBytes: 100, elapsedMs: 20, transferMs: 10, decodeMs: null, serverCacheHit: true, localCacheHit: false })
}

test('opening on cached islands is quiet; transfers completed between polls still assemble only their true ranges', () => {
  const view = new StreamActivityPresentation(), reading = sample()
  cache(reading, 40, 44)
  assert.equal(view.update(reading, 0).changes.length, 0)
  cache(reading, 0, 4); cache(reading, 4, 8)
  const frame = view.update(reading, 500)
  assert.deepEqual(frame.changes.map(c => [c.start, c.end, c.kind, c.quality]), [[0, 8, 'arrival', 'lossless']])
  assert.equal(view.update(reading, 1000).changes[0].id, frame.changes[0].id, 'unchanged samples do not restart the burst')
  assert.equal(view.update(reading, 500 + ACTIVITY_SETTLE_MS).changes.length, 0, 'settles even if nothing else happens')
})

test('preparing cached audio uses a preparation transition, with no new downloading activity', () => {
  const view = new StreamActivityPresentation(), reading = sample()
  cache(reading, 0, 4); cache(reading, 4, 8)
  view.update(reading, 0)
  reading.bufferedEnd = 8
  const changes = view.update(reading, 500).changes
  assert.deepEqual(changes.map(c => [c.start, c.end, c.from, c.to, c.kind]), [[0, 8, 'cached', 'buffered', 'prepared']])
  reading.position = 1
  assert.equal(view.update(reading, 1000).changes.length, 0, 'consuming prepared audio does not generate activity')
})

test('seeking, changing sessions/tracks, and visibility baselines do not replay old work', () => {
  for (const change of [
    (r: StreamingDiagnosticsReading) => { r.session!.sessionId++ },
    (r: StreamingDiagnosticsReading) => { r.trackKey = 'different-track-same-title' },
    (r: StreamingDiagnosticsReading) => { r.start = 40; r.session!.start = 40; r.position = 40 },
    (r: StreamingDiagnosticsReading) => { r.position = 0 }
  ]) {
    const view = new StreamActivityPresentation(), reading = sample()
    reading.position = 2
    view.update(reading, 0)
    cache(reading, 4, 8)
    assert.equal(view.update(reading, 500).changes.length, 1)
    change(reading)
    assert.equal(view.update(reading, 600).changes.length, 0)
  }
  const view = new StreamActivityPresentation(), reading = sample()
  view.update(reading, 0)
  cache(reading, 4, 8)
  assert.equal(view.update(reading, 500, false).changes.length, 0)
  assert.equal(view.update(reading, 600).changes.length, 0)
})

test('unknown-length activity requires new bytes, never invents a percentage, and stops on failure', () => {
  const view = new StreamActivityPresentation(), reading = sample()
  cache(reading, 4, 8)
  reading.session!.cachedRanges = []
  const segment = reading.session!.segments[0]
  segment.state = 'downloading'; segment.receivedBytes = 10
  view.update(reading, 0)
  assert.equal(view.update(reading, 500).changes.length, 0)
  segment.receivedBytes = 20
  const frame = view.update(reading, 1000)
  assert.equal(frame.changes[0].kind, 'bytes')
  assert.equal(frame.spans.find(s => s.start === 4)!.progress, null)
  const id = frame.changes[0].id
  assert.equal(view.update(reading, 1100).changes[0].id, id)
  segment.state = 'failed'
  assert.equal(view.update(reading, 1200).changes.length, 0)
})

test('known-length progress stays measured; cache removal and quality changes discard obsolete transitions', () => {
  const view = new StreamActivityPresentation(), reading = sample()
  cache(reading, 4, 8)
  reading.session!.cachedRanges = []
  const segment = reading.session!.segments[0]
  segment.state = 'downloading'; segment.receivedBytes = 10; segment.transferTotalBytes = 100
  view.update(reading, 0)
  segment.receivedBytes = 40
  const frame = view.update(reading, 500)
  assert.equal(frame.spans.find(s => s.start === 4)!.progress, .4)
  assert.equal(frame.changes.length, 0)
  segment.state = 'received'
  reading.session!.cachedRanges = [{ start: 4, end: 8, qualities: ['lossless'] }]
  assert.equal(view.update(reading, 1000).changes.length, 1)
  reading.session!.cachedRanges = [{ start: 4, end: 8, qualities: ['opus-64'] }]
  assert.equal(view.update(reading, 1100).changes.length, 0, 'no decorative quality islands')
  reading.session!.cachedRanges = []
  assert.equal(view.update(reading, 1200).changes.length, 0)
})
