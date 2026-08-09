export interface FfmpegStdoutChunkTimingSample {
  byteLength: number
  callbackStartedAtMs: number
  callbackCompletedAtMs: number
}

export interface FfmpegStdoutIngestionTimingSummary {
  ffmpegStdoutChunkCount: number
  ffmpegStdoutBytes: number
  ffmpegStdoutChunkMinBytes: number
  ffmpegStdoutChunkMaxBytes: number
  ffmpegStdoutDrainSpanMs: number
  ffmpegStdoutDrainToCloseMs: number
  ffmpegStdoutCallbackWorkMs: number
  ffmpegStdoutCallbackMaxMs: number
  ffmpegStdoutInterCallbackGapMs: number
  ffmpegStdoutInterCallbackGapMaxMs: number
  ffmpegStdoutPostDispatchGapCount: number
  ffmpegStdoutPostDispatchGapMs: number
  ffmpegStdoutPostDispatchGapMaxMs: number
  streamCreditAckCount: number
  streamCreditRoundTripMs: number
  streamCreditRoundTripMaxMs: number
  ffmpegStdoutCopyMs: number
  ffmpegStdoutCopyMaxMs: number
  ffmpegStdoutFlushMs: number
  ffmpegStdoutFlushMaxMs: number
  ffmpegStdoutPauseCount: number
  ffmpegStdoutPausedMs: number
  ffmpegStdoutPauseMaxMs: number
}

function isValidClock(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function clampedDuration(startedAtMs: number, completedAtMs: number): number {
  if (!isValidClock(startedAtMs) || !isValidClock(completedAtMs)) return 0
  return Math.max(0, completedAtMs - startedAtMs)
}

/**
 * Aggregates FFmpeg stdout ingestion work without owning a clock. Callers
 * provide process-local timestamps around the work they want to measure.
 * Copy and flush samples are deliberately independent from stdout callbacks:
 * the pre-probe gate can release buffered chunks outside a data callback.
 */
export class FfmpegStdoutIngestionTimingAccumulator {
  private chunkCount = 0
  private totalBytes = 0
  private chunkMinBytes: number | null = null
  private chunkMaxBytes = 0
  private callbackWorkMs = 0
  private callbackMaxMs = 0
  private interCallbackGapMs = 0
  private interCallbackGapMaxMs = 0
  private postDispatchGapCount = 0
  private postDispatchGapMs = 0
  private postDispatchGapMaxMs = 0
  private latestStreamDispatchCompletedAtMs: number | null = null
  private streamPostCompletedAtBySequence = new Map<number, number>()
  private streamCreditAckCount = 0
  private streamCreditRoundTripMs = 0
  private streamCreditRoundTripMaxMs = 0
  private lastCallbackStartedAtMs: number | null = null
  private lastCallbackCompletedAtMs: number | null = null
  private copyMs = 0
  private copyMaxMs = 0
  private flushMs = 0
  private flushMaxMs = 0
  private pauseCount = 0
  private pausedMs = 0
  private pauseMaxMs = 0
  private pauseActive = false
  private pauseStartedAtMs: number | null = null

  recordChunk(sample: FfmpegStdoutChunkTimingSample): void {
    if (!Number.isSafeInteger(sample.byteLength) || sample.byteLength < 0) {
      throw new RangeError('FFmpeg stdout chunk byte length must be a nonnegative safe integer.')
    }

    const nextTotalBytes = this.totalBytes + sample.byteLength
    if (!Number.isSafeInteger(nextTotalBytes)) {
      throw new RangeError('FFmpeg stdout byte total exceeded the safe integer range.')
    }
    this.chunkCount += 1
    this.totalBytes = nextTotalBytes
    this.chunkMinBytes = this.chunkMinBytes === null
      ? sample.byteLength
      : Math.min(this.chunkMinBytes, sample.byteLength)
    this.chunkMaxBytes = Math.max(this.chunkMaxBytes, sample.byteLength)

    if (
      !isValidClock(sample.callbackStartedAtMs)
      || !isValidClock(sample.callbackCompletedAtMs)
    ) {
      this.latestStreamDispatchCompletedAtMs = null
      return
    }

    // Data callbacks are serialized. Clamp a regressing timestamp to the
    // previous callback exit so callback work plus inter-callback gaps always
    // reconciles with the normalized first-entry-to-last-exit drain span.
    const callbackStartedAtMs = this.lastCallbackCompletedAtMs === null
      ? sample.callbackStartedAtMs
      : Math.max(this.lastCallbackCompletedAtMs, sample.callbackStartedAtMs)
    const callbackCompletedAtMs = Math.max(callbackStartedAtMs, sample.callbackCompletedAtMs)
    const callbackMs = callbackCompletedAtMs - callbackStartedAtMs
    const gapMs = this.lastCallbackCompletedAtMs === null
      ? 0
      : callbackStartedAtMs - this.lastCallbackCompletedAtMs

    const dispatchCompletedAtMs = this.latestStreamDispatchCompletedAtMs
    if (
      this.lastCallbackStartedAtMs !== null
      && dispatchCompletedAtMs !== null
      && dispatchCompletedAtMs >= this.lastCallbackStartedAtMs
      && dispatchCompletedAtMs <= callbackStartedAtMs
    ) {
      const postDispatchGapMs = callbackStartedAtMs - dispatchCompletedAtMs
      this.postDispatchGapCount += 1
      this.postDispatchGapMs += postDispatchGapMs
      this.postDispatchGapMaxMs = Math.max(this.postDispatchGapMaxMs, postDispatchGapMs)
    }
    if (dispatchCompletedAtMs !== null && dispatchCompletedAtMs <= callbackStartedAtMs) {
      this.latestStreamDispatchCompletedAtMs = null
    }

    this.callbackWorkMs += callbackMs
    this.callbackMaxMs = Math.max(this.callbackMaxMs, callbackMs)
    this.interCallbackGapMs += gapMs
    this.interCallbackGapMaxMs = Math.max(this.interCallbackGapMaxMs, gapMs)
    this.lastCallbackStartedAtMs = callbackStartedAtMs
    this.lastCallbackCompletedAtMs = callbackCompletedAtMs
  }

  /**
   * Records the completion of a successful main-to-renderer PCM chunk post.
   * The latest post is correlated with the next stdout callback without
   * claiming that the intervening latency was caused by IPC.
   */
  recordStreamDispatch(sequence: number, completedAtMs: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new RangeError('PCM stream chunk sequence must be a nonnegative safe integer.')
    }
    if (!isValidClock(completedAtMs)) return
    this.latestStreamDispatchCompletedAtMs = this.latestStreamDispatchCompletedAtMs === null
      ? completedAtMs
      : Math.max(this.latestStreamDispatchCompletedAtMs, completedAtMs)
    this.streamPostCompletedAtBySequence.set(sequence, completedAtMs)
  }

  recordStreamCredit(sequence: number, receivedAtMs: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new RangeError('PCM stream credit sequence must be a nonnegative safe integer.')
    }
    const postedAtMs = this.streamPostCompletedAtBySequence.get(sequence)
    if (postedAtMs === undefined) return
    this.streamPostCompletedAtBySequence.delete(sequence)
    const roundTripMs = clampedDuration(postedAtMs, receivedAtMs)
    this.streamCreditAckCount += 1
    this.streamCreditRoundTripMs += roundTripMs
    this.streamCreditRoundTripMaxMs = Math.max(this.streamCreditRoundTripMaxMs, roundTripMs)
  }

  recordCopy(startedAtMs: number, completedAtMs: number): void {
    const durationMs = clampedDuration(startedAtMs, completedAtMs)
    this.copyMs += durationMs
    this.copyMaxMs = Math.max(this.copyMaxMs, durationMs)
  }

  recordFlush(startedAtMs: number, completedAtMs: number): void {
    const durationMs = clampedDuration(startedAtMs, completedAtMs)
    this.flushMs += durationMs
    this.flushMaxMs = Math.max(this.flushMaxMs, durationMs)
  }

  beginPause(atMs: number): void {
    if (this.pauseActive) return
    this.pauseActive = true
    this.pauseStartedAtMs = isValidClock(atMs) ? atMs : null
    this.pauseCount += 1
  }

  endPause(atMs: number): void {
    if (!this.pauseActive) return
    const durationMs = this.pauseStartedAtMs === null
      ? 0
      : clampedDuration(this.pauseStartedAtMs, atMs)
    this.pausedMs += durationMs
    this.pauseMaxMs = Math.max(this.pauseMaxMs, durationMs)
    this.pauseActive = false
    this.pauseStartedAtMs = null
  }

  /**
   * Returns a fresh summary. When `atMs` is supplied, an open pause is
   * included through that timestamp without closing or otherwise mutating it.
   */
  snapshot(atMs?: number): FfmpegStdoutIngestionTimingSummary {
    const openPauseMs = this.pauseActive
      && this.pauseStartedAtMs !== null
      && atMs !== undefined
      ? clampedDuration(this.pauseStartedAtMs, atMs)
      : 0
    const drainToCloseMs = this.lastCallbackCompletedAtMs !== null
      && atMs !== undefined
      ? clampedDuration(this.lastCallbackCompletedAtMs, atMs)
      : 0

    return {
      ffmpegStdoutChunkCount: this.chunkCount,
      ffmpegStdoutBytes: this.totalBytes,
      ffmpegStdoutChunkMinBytes: this.chunkMinBytes ?? 0,
      ffmpegStdoutChunkMaxBytes: this.chunkMaxBytes,
      // The normalized serialized timeline is exactly callback work plus the
      // gaps between callbacks, including after a regressing clock sample.
      ffmpegStdoutDrainSpanMs: this.callbackWorkMs + this.interCallbackGapMs,
      ffmpegStdoutDrainToCloseMs: drainToCloseMs,
      ffmpegStdoutCallbackWorkMs: this.callbackWorkMs,
      ffmpegStdoutCallbackMaxMs: this.callbackMaxMs,
      ffmpegStdoutInterCallbackGapMs: this.interCallbackGapMs,
      ffmpegStdoutInterCallbackGapMaxMs: this.interCallbackGapMaxMs,
      ffmpegStdoutPostDispatchGapCount: this.postDispatchGapCount,
      ffmpegStdoutPostDispatchGapMs: this.postDispatchGapMs,
      ffmpegStdoutPostDispatchGapMaxMs: this.postDispatchGapMaxMs,
      streamCreditAckCount: this.streamCreditAckCount,
      streamCreditRoundTripMs: this.streamCreditRoundTripMs,
      streamCreditRoundTripMaxMs: this.streamCreditRoundTripMaxMs,
      ffmpegStdoutCopyMs: this.copyMs,
      ffmpegStdoutCopyMaxMs: this.copyMaxMs,
      ffmpegStdoutFlushMs: this.flushMs,
      ffmpegStdoutFlushMaxMs: this.flushMaxMs,
      ffmpegStdoutPauseCount: this.pauseCount,
      ffmpegStdoutPausedMs: this.pausedMs + openPauseMs,
      ffmpegStdoutPauseMaxMs: Math.max(this.pauseMaxMs, openPauseMs)
    }
  }
}
