import assert from 'node:assert/strict'
import test from 'node:test'
import { FfmpegStdoutIngestionTimingAccumulator } from './ffmpegStdoutIngestionTimings.ts'

test('aggregates serialized stdout callbacks, append work, and pause intervals', () => {
  const timings = new FfmpegStdoutIngestionTimingAccumulator()

  timings.recordChunk({ byteLength: 4, callbackStartedAtMs: 10, callbackCompletedAtMs: 12 })
  timings.recordChunk({ byteLength: 6, callbackStartedAtMs: 15, callbackCompletedAtMs: 18 })
  timings.recordChunk({ byteLength: 2, callbackStartedAtMs: 20, callbackCompletedAtMs: 21 })
  timings.recordCopy(30, 32)
  timings.recordCopy(40, 43)
  timings.recordFlush(50, 51)
  timings.recordFlush(60, 64)
  timings.beginPause(70)
  timings.endPause(75)
  timings.beginPause(80)
  timings.endPause(83)

  const summary = timings.snapshot(25)
  assert.deepEqual(summary, {
    ffmpegStdoutChunkCount: 3,
    ffmpegStdoutBytes: 12,
    ffmpegStdoutChunkMinBytes: 2,
    ffmpegStdoutChunkMaxBytes: 6,
    ffmpegStdoutDrainSpanMs: 11,
    ffmpegStdoutDrainToCloseMs: 4,
    ffmpegStdoutCallbackWorkMs: 6,
    ffmpegStdoutCallbackMaxMs: 3,
    ffmpegStdoutInterCallbackGapMs: 5,
    ffmpegStdoutInterCallbackGapMaxMs: 3,
    ffmpegStdoutPostDispatchGapCount: 0,
    ffmpegStdoutPostDispatchGapMs: 0,
    ffmpegStdoutPostDispatchGapMaxMs: 0,
    streamCreditAckCount: 0,
    streamCreditRoundTripMs: 0,
    streamCreditRoundTripMaxMs: 0,
    ffmpegStdoutCopyMs: 5,
    ffmpegStdoutCopyMaxMs: 3,
    ffmpegStdoutFlushMs: 5,
    ffmpegStdoutFlushMaxMs: 4,
    ffmpegStdoutPauseCount: 2,
    ffmpegStdoutPausedMs: 8,
    ffmpegStdoutPauseMaxMs: 5
  })
  assert.equal(
    summary.ffmpegStdoutDrainSpanMs,
    summary.ffmpegStdoutCallbackWorkMs + summary.ffmpegStdoutInterCallbackGapMs
  )
  assert.equal(timings.snapshot(20).ffmpegStdoutDrainToCloseMs, 0)
  assert.equal(timings.snapshot(Number.NaN).ffmpegStdoutDrainToCloseMs, 0)
})

test('records copy and flush work independently from stdout callbacks', () => {
  const timings = new FfmpegStdoutIngestionTimingAccumulator()
  timings.recordCopy(1, 4)
  timings.recordFlush(5, 7)

  assert.deepEqual(timings.snapshot(100), {
    ffmpegStdoutChunkCount: 0,
    ffmpegStdoutBytes: 0,
    ffmpegStdoutChunkMinBytes: 0,
    ffmpegStdoutChunkMaxBytes: 0,
    ffmpegStdoutDrainSpanMs: 0,
    ffmpegStdoutDrainToCloseMs: 0,
    ffmpegStdoutCallbackWorkMs: 0,
    ffmpegStdoutCallbackMaxMs: 0,
    ffmpegStdoutInterCallbackGapMs: 0,
    ffmpegStdoutInterCallbackGapMaxMs: 0,
    ffmpegStdoutPostDispatchGapCount: 0,
    ffmpegStdoutPostDispatchGapMs: 0,
    ffmpegStdoutPostDispatchGapMaxMs: 0,
    streamCreditAckCount: 0,
    streamCreditRoundTripMs: 0,
    streamCreditRoundTripMaxMs: 0,
    ffmpegStdoutCopyMs: 3,
    ffmpegStdoutCopyMaxMs: 3,
    ffmpegStdoutFlushMs: 2,
    ffmpegStdoutFlushMaxMs: 2,
    ffmpegStdoutPauseCount: 0,
    ffmpegStdoutPausedMs: 0,
    ffmpegStdoutPauseMaxMs: 0
  })
})

test('correlates the latest successful stream dispatch with the next stdout callback', () => {
  const timings = new FfmpegStdoutIngestionTimingAccumulator()

  timings.recordChunk({ byteLength: 4, callbackStartedAtMs: 10, callbackCompletedAtMs: 12 })
  // A post made after the first callback (for example by a credit handler) is
  // measured only through the next callback entry.
  timings.recordStreamDispatch(0, 14)
  timings.recordChunk({ byteLength: 4, callbackStartedAtMs: 20, callbackCompletedAtMs: 21 })

  // Multiple posts before another callback retain the latest completion so
  // their overlapping tails are not double-counted.
  timings.recordStreamDispatch(1, 22)
  timings.recordStreamDispatch(2, 24)
  timings.recordChunk({ byteLength: 4, callbackStartedAtMs: 30, callbackCompletedAtMs: 31 })

  // The production stdout callback records its post before it records the
  // enclosing callback sample. That post belongs to the following callback.
  timings.recordStreamDispatch(3, 31.5)
  timings.recordChunk({ byteLength: 4, callbackStartedAtMs: 31, callbackCompletedAtMs: 32 })
  timings.recordChunk({ byteLength: 4, callbackStartedAtMs: 40, callbackCompletedAtMs: 41 })

  const summary = timings.snapshot(42)
  assert.equal(summary.ffmpegStdoutPostDispatchGapCount, 3)
  assert.equal(summary.ffmpegStdoutPostDispatchGapMs, 20.5)
  assert.equal(summary.ffmpegStdoutPostDispatchGapMaxMs, 8.5)
})

test('correlates stream credits by sequence without counting unacknowledged chunks', () => {
  const timings = new FfmpegStdoutIngestionTimingAccumulator()
  timings.recordStreamDispatch(0, 10)
  timings.recordStreamDispatch(1, 12)
  timings.recordStreamDispatch(2, 14)

  timings.recordStreamCredit(1, 19)
  timings.recordStreamCredit(1, 25)
  timings.recordStreamCredit(0, 21)
  timings.recordStreamCredit(99, 30)

  const summary = timings.snapshot()
  assert.equal(summary.streamCreditAckCount, 2)
  assert.equal(summary.streamCreditRoundTripMs, 18)
  assert.equal(summary.streamCreditRoundTripMaxMs, 11)
})

test('clamps invalid and regressing clocks without breaking drain reconciliation', () => {
  const timings = new FfmpegStdoutIngestionTimingAccumulator()
  timings.recordChunk({ byteLength: 3, callbackStartedAtMs: 10, callbackCompletedAtMs: 8 })
  timings.recordChunk({ byteLength: 5, callbackStartedAtMs: 9, callbackCompletedAtMs: 12 })
  timings.recordChunk({ byteLength: 7, callbackStartedAtMs: Number.NaN, callbackCompletedAtMs: 20 })
  timings.recordChunk({ byteLength: 11, callbackStartedAtMs: 15, callbackCompletedAtMs: 20 })
  timings.recordCopy(5, 4)
  timings.recordCopy(Number.NaN, 8)
  timings.recordFlush(-1, 4)
  timings.recordFlush(8, Number.POSITIVE_INFINITY)
  timings.beginPause(20)
  timings.endPause(18)

  const summary = timings.snapshot()
  assert.equal(summary.ffmpegStdoutChunkCount, 4)
  assert.equal(summary.ffmpegStdoutBytes, 26)
  assert.equal(summary.ffmpegStdoutChunkMinBytes, 3)
  assert.equal(summary.ffmpegStdoutChunkMaxBytes, 11)
  assert.equal(summary.ffmpegStdoutCallbackWorkMs, 7)
  assert.equal(summary.ffmpegStdoutCallbackMaxMs, 5)
  assert.equal(summary.ffmpegStdoutInterCallbackGapMs, 3)
  assert.equal(summary.ffmpegStdoutInterCallbackGapMaxMs, 3)
  assert.equal(summary.ffmpegStdoutDrainSpanMs, 10)
  assert.equal(summary.ffmpegStdoutDrainToCloseMs, 0)
  assert.equal(summary.ffmpegStdoutCopyMs, 0)
  assert.equal(summary.ffmpegStdoutFlushMs, 0)
  assert.equal(summary.ffmpegStdoutPauseCount, 1)
  assert.equal(summary.ffmpegStdoutPausedMs, 0)
  assert.equal(summary.ffmpegStdoutPauseMaxMs, 0)
  assert.equal(
    summary.ffmpegStdoutDrainSpanMs,
    summary.ffmpegStdoutCallbackWorkMs + summary.ffmpegStdoutInterCallbackGapMs
  )
})

test('accounts for an open pause in snapshots without mutating it', () => {
  const timings = new FfmpegStdoutIngestionTimingAccumulator()
  timings.endPause(5)
  timings.beginPause(10)
  timings.beginPause(11)

  assert.equal(timings.snapshot().ffmpegStdoutPausedMs, 0)
  assert.equal(timings.snapshot(18).ffmpegStdoutPausedMs, 8)
  assert.equal(timings.snapshot(18).ffmpegStdoutPauseMaxMs, 8)
  assert.equal(timings.snapshot(8).ffmpegStdoutPausedMs, 0)
  assert.equal(timings.snapshot(Number.NaN).ffmpegStdoutPausedMs, 0)

  timings.endPause(20)
  const completed = timings.snapshot(50)
  assert.equal(completed.ffmpegStdoutPauseCount, 1)
  assert.equal(completed.ffmpegStdoutPausedMs, 10)
  assert.equal(completed.ffmpegStdoutPauseMaxMs, 10)
})

test('rejects invalid chunk byte lengths and totals', () => {
  for (const byteLength of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const timings = new FfmpegStdoutIngestionTimingAccumulator()
    assert.throws(
      () => timings.recordChunk({ byteLength, callbackStartedAtMs: 0, callbackCompletedAtMs: 1 }),
      /nonnegative safe integer/
    )
  }

  const timings = new FfmpegStdoutIngestionTimingAccumulator()
  timings.recordChunk({
    byteLength: Number.MAX_SAFE_INTEGER,
    callbackStartedAtMs: 0,
    callbackCompletedAtMs: 0
  })
  assert.throws(
    () => timings.recordChunk({ byteLength: 1, callbackStartedAtMs: 0, callbackCompletedAtMs: 0 }),
    /byte total exceeded/
  )
  assert.throws(() => timings.recordStreamDispatch(-1, 0), /nonnegative safe integer/)
  assert.throws(() => timings.recordStreamCredit(1.5, 0), /nonnegative safe integer/)
})

test('returns independent summary objects', () => {
  const timings = new FfmpegStdoutIngestionTimingAccumulator()
  timings.recordChunk({ byteLength: 4, callbackStartedAtMs: 1, callbackCompletedAtMs: 2 })

  const first = timings.snapshot()
  first.ffmpegStdoutBytes = 999

  assert.equal(timings.snapshot().ffmpegStdoutBytes, 4)
})
