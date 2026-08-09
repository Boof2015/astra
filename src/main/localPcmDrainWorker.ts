import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { parentPort } from 'node:worker_threads'
import { FfmpegStdoutIngestionTimingAccumulator } from './ffmpegStdoutIngestionTimings'
import {
  LOCAL_PCM_WORKER_CHUNK_BYTES,
  LOCAL_PCM_WORKER_INITIAL_CREDITS,
  LOCAL_PCM_WORKER_MAX_BYTES,
  LOCAL_PCM_WORKER_MAX_STDERR_BYTES,
  LOCAL_PCM_WORKER_PROTOCOL_VERSION,
  isLocalPcmWorkerRequestMessage,
  localPcmWorkerProtocolJobId,
  type LocalPcmWorkerCancelMessage,
  type LocalPcmWorkerCreditMessage,
  type LocalPcmWorkerFailureKind,
  type LocalPcmWorkerResponseMessage,
  type LocalPcmWorkerStartMessage,
  type LocalPcmWorkerTimingSummary
} from './localPcmWorkerProtocol'

export interface LocalPcmOwnedBatch {
  byteOffset: number
  byteLength: number
  payload: ArrayBuffer
}

/**
 * Copies arbitrary pipe fragments into independently-owned batches. A full
 * batch can be transferred without cloning or retaining Node's Buffer pool.
 */
export class LocalPcmOwnedBatcher {
  private readonly batchBytes: number
  private readonly maxBytes: number
  private active: Uint8Array | null = null
  private activeBytes = 0
  private acceptedBytes = 0
  private emittedBytes = 0

  constructor(
    batchBytes: number = LOCAL_PCM_WORKER_CHUNK_BYTES,
    maxBytes: number = LOCAL_PCM_WORKER_MAX_BYTES
  ) {
    if (!Number.isSafeInteger(batchBytes) || batchBytes <= 0) {
      throw new RangeError('Local PCM worker batch size must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < batchBytes) {
      throw new RangeError('Local PCM worker byte cap must cover at least one batch.')
    }
    this.batchBytes = batchBytes
    this.maxBytes = maxBytes
  }

  get byteLength(): number {
    return this.activeBytes
  }

  get totalByteLength(): number {
    return this.acceptedBytes
  }

  get emittedByteLength(): number {
    return this.emittedBytes
  }

  get hasFullBatch(): boolean {
    return this.activeBytes === this.batchBytes
  }

  /** Appends at most enough bytes to fill the current owned batch. */
  append(source: Uint8Array): number {
    if (source.byteLength === 0) return 0
    const remainingLimit = this.maxBytes - this.acceptedBytes
    if (source.byteLength > remainingLimit) {
      throw new RangeError('Decoded audio exceeds the 192 MiB Standard playback limit.')
    }
    if (this.hasFullBatch) return 0
    this.active ??= new Uint8Array(this.batchBytes)
    const copiedBytes = Math.min(source.byteLength, this.batchBytes - this.activeBytes)
    this.active.set(source.subarray(0, copiedBytes), this.activeBytes)
    this.activeBytes += copiedBytes
    this.acceptedBytes += copiedBytes
    return copiedBytes
  }

  takeBatch(options: { allowPartial?: boolean } = {}): LocalPcmOwnedBatch | null {
    if (!this.active || this.activeBytes === 0) return null
    if (!this.hasFullBatch && options.allowPartial !== true) return null

    const byteLength = this.activeBytes
    let payload: ArrayBuffer
    if (byteLength === this.active.byteLength) {
      payload = this.active.buffer as ArrayBuffer
    } else {
      const exact = new Uint8Array(byteLength)
      exact.set(this.active.subarray(0, byteLength))
      payload = exact.buffer
    }
    const batch: LocalPcmOwnedBatch = {
      byteOffset: this.emittedBytes,
      byteLength,
      payload
    }
    this.emittedBytes += byteLength
    this.active = null
    this.activeBytes = 0
    return batch
  }

  clear(): void {
    this.active = null
    this.activeBytes = 0
  }
}

/** Retains only the UTF-8 tail needed for a useful FFmpeg failure message. */
export class LocalPcmBoundedStderr {
  private readonly maxBytes: number
  private chunks: Buffer[] = []
  private totalBytes = 0

  constructor(maxBytes: number = LOCAL_PCM_WORKER_MAX_STDERR_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError('Local PCM worker stderr cap must be a positive safe integer.')
    }
    this.maxBytes = maxBytes
  }

  append(value: Buffer | string): void {
    const incoming = Buffer.from(value)
    if (incoming.byteLength >= this.maxBytes) {
      this.chunks = [Buffer.from(incoming.subarray(incoming.byteLength - this.maxBytes))]
      this.totalBytes = this.maxBytes
      return
    }

    this.chunks.push(incoming)
    this.totalBytes += incoming.byteLength
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const overflow = this.totalBytes - this.maxBytes
      const first = this.chunks[0]
      if (first.byteLength <= overflow) {
        this.chunks.shift()
        this.totalBytes -= first.byteLength
      } else {
        this.chunks[0] = Buffer.from(first.subarray(overflow))
        this.totalBytes -= overflow
      }
    }
  }

  toString(): string {
    let text = Buffer.concat(this.chunks, this.totalBytes).toString('utf8')
    // Starting at an arbitrary UTF-8 tail byte can introduce a replacement
    // character whose encoded form is larger than that byte. Keep the wire
    // representation within the same hard cap as the retained buffer.
    while (Buffer.byteLength(text, 'utf8') > this.maxBytes && text.length > 0) {
      text = text.slice(1)
    }
    return text
  }
}

export interface LocalPcmDrainWorkerPort {
  on(event: 'message', listener: (message: unknown) => void): unknown
  postMessage(message: LocalPcmWorkerResponseMessage, transferList?: readonly ArrayBuffer[]): void
}

interface LocalPcmDrainJob {
  jobId: string
  child: ChildProcessWithoutNullStreams
  pid: number | null
  acceptedAtMs: number
  spawnStartedAtMs: number
  spawnCompletedAtMs: number
  firstPcmAtMs: number | null
  lastPcmAtMs: number | null
  closeAtMs: number | null
  closeCode: number | null
  stdoutEnded: boolean
  settled: boolean
  cancelRequested: boolean
  failure: { kind: LocalPcmWorkerFailureKind; message: string } | null
  credits: number
  nextSequence: number
  nextCreditSequence: number
  nextByteOffset: number
  receivedBytes: number
  pendingInput: Buffer | null
  batcher: LocalPcmOwnedBatcher
  stderr: LocalPcmBoundedStderr
  stdoutTimings: FfmpegStdoutIngestionTimingAccumulator
  batchCopyMs: number
  aggregationCopyMs: number
  aggregationCopyMaxMs: number
  batchPostMs: number
  batchMinBytes: number | null
  batchMaxBytes: number
  creditWaitStartedAtMs: number | null
  creditWaitCount: number
  creditWaitMs: number
  creditWaitMaxMs: number
}

function nowMs(): number {
  return performance.now()
}

function durationMs(startedAtMs: number, completedAtMs: number): number {
  return Math.max(0, completedAtMs - startedAtMs)
}

export function startLocalPcmDrainWorkerRuntime(port: LocalPcmDrainWorkerPort): () => void {
  const jobs = new Map<string, LocalPcmDrainJob>()

  const post = (message: LocalPcmWorkerResponseMessage, transferList?: readonly ArrayBuffer[]): void => {
    port.postMessage(message, transferList)
  }

  const endCreditWait = (job: LocalPcmDrainJob, atMs: number): void => {
    if (job.creditWaitStartedAtMs === null) return
    const waitedMs = durationMs(job.creditWaitStartedAtMs, atMs)
    job.creditWaitMs += waitedMs
    job.creditWaitMaxMs = Math.max(job.creditWaitMaxMs, waitedMs)
    job.creditWaitStartedAtMs = null
    job.stdoutTimings.endPause(atMs)
  }

  const beginCreditWait = (job: LocalPcmDrainJob, atMs: number): void => {
    if (job.creditWaitStartedAtMs !== null) return
    job.creditWaitStartedAtMs = atMs
    job.creditWaitCount += 1
    job.stdoutTimings.beginPause(atMs)
  }

  const workerTimings = (job: LocalPcmDrainJob, completedAtMs: number): LocalPcmWorkerTimingSummary => {
    const closeAtMs = job.closeAtMs ?? completedAtMs
    const firstPcmAtMs = job.firstPcmAtMs ?? job.spawnStartedAtMs
    const lastPcmAtMs = job.lastPcmAtMs ?? firstPcmAtMs
    const activeCreditWaitMs = job.creditWaitStartedAtMs === null
      ? 0
      : durationMs(job.creditWaitStartedAtMs, completedAtMs)
    return {
      ffmpegWorkerTotalMs: durationMs(job.acceptedAtMs, completedAtMs),
      ffmpegWorkerSpawnMs: durationMs(job.spawnStartedAtMs, job.spawnCompletedAtMs),
      ffmpegWorkerFfmpegMs: durationMs(job.spawnStartedAtMs, closeAtMs),
      ffmpegWorkerSpawnToFirstPcmMs: job.firstPcmAtMs === null
        ? 0
        : durationMs(job.spawnStartedAtMs, job.firstPcmAtMs),
      ffmpegWorkerPcmOutputSpanMs: job.firstPcmAtMs === null || job.lastPcmAtMs === null
        ? 0
        : durationMs(firstPcmAtMs, lastPcmAtMs),
      ffmpegWorkerCloseTailMs: job.lastPcmAtMs === null
        ? 0
        : durationMs(lastPcmAtMs, closeAtMs),
      ffmpegWorkerBatchCount: job.nextSequence,
      ffmpegWorkerBatchBytes: job.nextByteOffset,
      ffmpegWorkerBatchMinBytes: job.batchMinBytes ?? 0,
      ffmpegWorkerBatchMaxBytes: job.batchMaxBytes,
      ffmpegWorkerAggregationCopyMs: job.aggregationCopyMs,
      ffmpegWorkerAggregationCopyMaxMs: job.aggregationCopyMaxMs,
      ffmpegWorkerBatchCopyMs: job.batchCopyMs,
      ffmpegWorkerBatchPostMs: job.batchPostMs,
      ffmpegWorkerCreditWaitCount: job.creditWaitCount,
      ffmpegWorkerCreditWaitMs: job.creditWaitMs + activeCreditWaitMs,
      ffmpegWorkerCreditWaitMaxMs: Math.max(job.creditWaitMaxMs, activeCreditWaitMs)
    }
  }

  const clearJobBuffers = (job: LocalPcmDrainJob): void => {
    job.pendingInput = null
    job.batcher.clear()
  }

  const finishCancelled = (job: LocalPcmDrainJob): void => {
    if (job.settled) return
    const completedAtMs = nowMs()
    endCreditWait(job, completedAtMs)
    job.settled = true
    jobs.delete(job.jobId)
    clearJobBuffers(job)
    post({
      type: 'cancelled',
      version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
      jobId: job.jobId,
      stdoutTimings: job.stdoutTimings.snapshot(job.closeAtMs ?? completedAtMs),
      workerTimings: workerTimings(job, completedAtMs)
    })
  }

  const finishFailed = (job: LocalPcmDrainJob): void => {
    if (job.settled) return
    const completedAtMs = nowMs()
    endCreditWait(job, completedAtMs)
    job.settled = true
    jobs.delete(job.jobId)
    clearJobBuffers(job)
    const failure = job.failure ?? {
      kind: 'decode' as const,
      message: 'Local FFmpeg worker decode failed.'
    }
    post({
      type: 'failed',
      version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
      jobId: job.jobId,
      failureKind: failure.kind,
      errorMessage: failure.message,
      stderr: job.stderr.toString(),
      stdoutTimings: job.stdoutTimings.snapshot(job.closeAtMs ?? completedAtMs),
      workerTimings: workerTimings(job, completedAtMs)
    })
  }

  const requestFailure = (
    job: LocalPcmDrainJob,
    kind: LocalPcmWorkerFailureKind,
    message: string
  ): void => {
    if (job.settled || job.cancelRequested) return
    job.failure ??= { kind, message }
    try {
      job.child.stdout.pause()
      if (job.pid !== null && !job.child.killed) job.child.kill('SIGKILL')
    } catch {
      // A concurrent child close is handled below.
    }
    if (job.closeAtMs !== null || job.pid === null) finishFailed(job)
  }

  const postBatch = (job: LocalPcmDrainJob, allowPartial: boolean): boolean => {
    if (job.settled || job.credits <= 0) return false
    const copyStartedAtMs = nowMs()
    const batch = job.batcher.takeBatch({ allowPartial })
    const copyCompletedAtMs = nowMs()
    if (!batch) return false
    const finalCopyMs = durationMs(copyStartedAtMs, copyCompletedAtMs)
    job.batchCopyMs += finalCopyMs
    job.stdoutTimings.recordCopy(copyStartedAtMs, copyCompletedAtMs)
    if (
      batch.byteOffset !== job.nextByteOffset
      || batch.byteLength < 1
      || batch.byteLength > LOCAL_PCM_WORKER_CHUNK_BYTES
    ) {
      requestFailure(job, 'protocol', 'Local PCM worker assembled an invalid batch offset.')
      return false
    }

    const sequence = job.nextSequence
    const postStartedAtMs = nowMs()
    try {
      post({
        type: 'chunk',
        version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
        jobId: job.jobId,
        sequence,
        byteOffset: batch.byteOffset,
        byteLength: batch.byteLength,
        payload: batch.payload
      }, [batch.payload])
    } catch (error) {
      requestFailure(
        job,
        'protocol',
        error instanceof Error ? error.message : 'Local PCM worker could not post a batch.'
      )
      return false
    }
    const postCompletedAtMs = nowMs()
    const postMs = durationMs(postStartedAtMs, postCompletedAtMs)
    job.batchPostMs += postMs
    job.stdoutTimings.recordFlush(postStartedAtMs, postCompletedAtMs)
    job.stdoutTimings.recordStreamDispatch(sequence, postCompletedAtMs)
    job.credits -= 1
    job.nextSequence += 1
    job.nextByteOffset += batch.byteLength
    job.batchMinBytes = job.batchMinBytes === null
      ? batch.byteLength
      : Math.min(job.batchMinBytes, batch.byteLength)
    job.batchMaxBytes = Math.max(job.batchMaxBytes, batch.byteLength)
    return true
  }

  const updateFlowControl = (job: LocalPcmDrainJob): void => {
    if (job.settled || job.cancelRequested || job.failure) return
    const atMs = nowMs()
    if (job.credits <= 0) {
      try {
        job.child.stdout.pause()
      } catch {
        // The child may have closed between the state check and pause.
      }
      beginCreditWait(job, atMs)
      return
    }

    endCreditWait(job, atMs)
    if (!job.stdoutEnded && job.pendingInput === null && !job.batcher.hasFullBatch) {
      try {
        job.child.stdout.resume()
      } catch {
        // The child may have closed between the state check and resume.
      }
    }
  }

  const drainPendingInput = (job: LocalPcmDrainJob): void => {
    while (!job.settled && !job.cancelRequested && !job.failure) {
      if (job.batcher.hasFullBatch) {
        if (!postBatch(job, false)) break
        continue
      }
      const input = job.pendingInput
      if (!input || input.byteLength === 0) {
        job.pendingInput = null
        break
      }
      const copyStartedAtMs = nowMs()
      let copiedBytes = 0
      try {
        copiedBytes = job.batcher.append(input)
      } catch (error) {
        requestFailure(
          job,
          'limit',
          error instanceof Error
            ? error.message
            : 'Decoded audio exceeds the 192 MiB Standard playback limit.'
        )
        return
      } finally {
        const copyCompletedAtMs = nowMs()
        const copyMs = durationMs(copyStartedAtMs, copyCompletedAtMs)
        job.batchCopyMs += copyMs
        job.aggregationCopyMs += copyMs
        job.aggregationCopyMaxMs = Math.max(job.aggregationCopyMaxMs, copyMs)
        job.stdoutTimings.recordCopy(copyStartedAtMs, copyCompletedAtMs)
      }
      job.pendingInput = copiedBytes === input.byteLength
        ? null
        : input.subarray(copiedBytes)
    }
    updateFlowControl(job)
  }

  const finishComplete = (job: LocalPcmDrainJob): void => {
    if (job.settled) return
    const completedAtMs = nowMs()
    endCreditWait(job, completedAtMs)
    job.settled = true
    jobs.delete(job.jobId)
    post({
      type: 'complete',
      version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
      jobId: job.jobId,
      pcmByteLength: job.nextByteOffset,
      chunkCount: job.nextSequence,
      stdoutTimings: job.stdoutTimings.snapshot(job.closeAtMs ?? completedAtMs),
      workerTimings: workerTimings(job, completedAtMs)
    })
  }

  const maybeFinish = (job: LocalPcmDrainJob): void => {
    if (job.settled) return
    if (job.cancelRequested) {
      if (job.closeAtMs !== null || job.pid === null) finishCancelled(job)
      return
    }
    if (job.failure) {
      if (job.closeAtMs !== null || job.pid === null) finishFailed(job)
      return
    }
    if (job.closeAtMs === null || !job.stdoutEnded) return
    if (job.closeCode !== 0) {
      job.failure = {
        kind: 'decode',
        message: job.stderr.toString().trim().length > 0
          ? `Local FFmpeg decode failed: ${job.stderr.toString().trim()}`
          : `Local FFmpeg decode failed (exit ${job.closeCode ?? 'unknown'}).`
      }
      finishFailed(job)
      return
    }

    drainPendingInput(job)
    if (job.settled || job.failure || job.pendingInput || job.batcher.hasFullBatch) return
    if (job.batcher.byteLength > 0 && !postBatch(job, true)) {
      updateFlowControl(job)
      return
    }
    if (
      job.receivedBytes === 0
      || job.batcher.totalByteLength !== job.receivedBytes
      || job.batcher.emittedByteLength !== job.receivedBytes
      || job.nextByteOffset !== job.receivedBytes
      || job.nextSequence === 0
    ) {
      requestFailure(job, 'stdout', 'Local FFmpeg worker produced incomplete or empty PCM audio.')
      return
    }
    // All batch posts are FIFO on parentPort. Outstanding acknowledgements do
    // not hold completion once the final owned payload has been enqueued.
    finishComplete(job)
  }

  const handleStdoutData = (job: LocalPcmDrainJob, chunk: Buffer): void => {
    if (job.settled || job.cancelRequested || job.failure || chunk.byteLength === 0) return
    const callbackStartedAtMs = nowMs()
    job.firstPcmAtMs ??= callbackStartedAtMs
    job.receivedBytes += chunk.byteLength
    if (!Number.isSafeInteger(job.receivedBytes) || job.receivedBytes > LOCAL_PCM_WORKER_MAX_BYTES) {
      requestFailure(job, 'limit', 'Decoded audio exceeds the 192 MiB Standard playback limit.')
    } else if (job.pendingInput !== null) {
      requestFailure(job, 'protocol', 'Local FFmpeg stdout advanced while worker flow control was paused.')
    } else {
      job.pendingInput = chunk
      drainPendingInput(job)
    }
    const callbackCompletedAtMs = nowMs()
    job.lastPcmAtMs = callbackCompletedAtMs
    job.stdoutTimings.recordChunk({
      byteLength: chunk.byteLength,
      callbackStartedAtMs,
      callbackCompletedAtMs
    })
  }

  const startJob = (message: LocalPcmWorkerStartMessage): void => {
    if (jobs.has(message.jobId)) {
      post({
        type: 'protocol-error',
        version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
        jobId: message.jobId,
        errorMessage: 'Local PCM worker received a duplicate active job ID.'
      })
      return
    }

    const acceptedAtMs = nowMs()
    const spawnStartedAtMs = nowMs()
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(message.ffmpegPath, message.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      const spawnCompletedAtMs = nowMs()
      const timings = new FfmpegStdoutIngestionTimingAccumulator()
      const stderr = new LocalPcmBoundedStderr()
      const errorMessage = error instanceof Error
        ? error.message
        : 'Local FFmpeg worker could not spawn FFmpeg.'
      post({
        type: 'failed',
        version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
        jobId: message.jobId,
        failureKind: 'spawn',
        errorMessage,
        stderr: stderr.toString(),
        stdoutTimings: timings.snapshot(spawnCompletedAtMs),
        workerTimings: {
          ffmpegWorkerTotalMs: durationMs(acceptedAtMs, spawnCompletedAtMs),
          ffmpegWorkerSpawnMs: durationMs(spawnStartedAtMs, spawnCompletedAtMs),
          ffmpegWorkerFfmpegMs: durationMs(spawnStartedAtMs, spawnCompletedAtMs),
          ffmpegWorkerSpawnToFirstPcmMs: 0,
          ffmpegWorkerPcmOutputSpanMs: 0,
          ffmpegWorkerCloseTailMs: 0,
          ffmpegWorkerBatchCount: 0,
          ffmpegWorkerBatchBytes: 0,
          ffmpegWorkerBatchMinBytes: 0,
          ffmpegWorkerBatchMaxBytes: 0,
          ffmpegWorkerAggregationCopyMs: 0,
          ffmpegWorkerAggregationCopyMaxMs: 0,
          ffmpegWorkerBatchCopyMs: 0,
          ffmpegWorkerBatchPostMs: 0,
          ffmpegWorkerCreditWaitCount: 0,
          ffmpegWorkerCreditWaitMs: 0,
          ffmpegWorkerCreditWaitMaxMs: 0
        }
      })
      return
    }
    const spawnCompletedAtMs = nowMs()
    const pid = typeof child.pid === 'number' && Number.isSafeInteger(child.pid) && child.pid > 0
      ? child.pid
      : null
    const job: LocalPcmDrainJob = {
      jobId: message.jobId,
      child,
      pid,
      acceptedAtMs,
      spawnStartedAtMs,
      spawnCompletedAtMs,
      firstPcmAtMs: null,
      lastPcmAtMs: null,
      closeAtMs: null,
      closeCode: null,
      stdoutEnded: false,
      settled: false,
      cancelRequested: false,
      failure: null,
      credits: LOCAL_PCM_WORKER_INITIAL_CREDITS,
      nextSequence: 0,
      nextCreditSequence: 0,
      nextByteOffset: 0,
      receivedBytes: 0,
      pendingInput: null,
      batcher: new LocalPcmOwnedBatcher(),
      stderr: new LocalPcmBoundedStderr(),
      stdoutTimings: new FfmpegStdoutIngestionTimingAccumulator(),
      batchCopyMs: 0,
      aggregationCopyMs: 0,
      aggregationCopyMaxMs: 0,
      batchPostMs: 0,
      batchMinBytes: null,
      batchMaxBytes: 0,
      creditWaitStartedAtMs: null,
      creditWaitCount: 0,
      creditWaitMs: 0,
      creditWaitMaxMs: 0
    }
    jobs.set(job.jobId, job)

    if (pid !== null) {
      post({
        type: 'started',
        version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
        jobId: job.jobId,
        pid
      })
    }

    child.stdout.on('data', (chunk: Buffer) => handleStdoutData(job, chunk))
    const handleStdoutEnded = (): void => {
      if (job.stdoutEnded) return
      job.stdoutEnded = true
      maybeFinish(job)
    }
    child.stdout.once('end', handleStdoutEnded)
    child.stdout.once('close', handleStdoutEnded)
    child.stdout.once('error', (error) => {
      requestFailure(
        job,
        'stdout',
        error instanceof Error ? error.message : 'Local FFmpeg worker output pipe failed.'
      )
    })

    child.stderr.on('data', (chunk: Buffer) => job.stderr.append(chunk))
    child.stdin.once('error', () => {
      // FFmpeg reads the local file directly and `-nostdin` is always used.
    })
    try {
      child.stdin.end()
    } catch {
      // The unused pipe may already have closed after a spawn failure.
    }

    child.once('error', (error) => {
      requestFailure(
        job,
        'spawn',
        error instanceof Error ? error.message : 'Local FFmpeg worker could not start FFmpeg.'
      )
    })
    child.once('close', (code) => {
      if (job.closeAtMs !== null) return
      job.closeAtMs = nowMs()
      job.closeCode = code
      maybeFinish(job)
    })
  }

  const acknowledgeChunk = (message: LocalPcmWorkerCreditMessage): void => {
    const job = jobs.get(message.jobId)
    if (!job || job.settled) return
    if (
      message.sequence !== job.nextCreditSequence
      || message.sequence >= job.nextSequence
      || job.credits >= LOCAL_PCM_WORKER_INITIAL_CREDITS
    ) {
      requestFailure(job, 'protocol', 'Local PCM worker received an invalid batch credit.')
      return
    }
    const receivedAtMs = nowMs()
    job.stdoutTimings.recordStreamCredit(message.sequence, receivedAtMs)
    job.nextCreditSequence += 1
    job.credits += 1
    endCreditWait(job, receivedAtMs)
    drainPendingInput(job)
    maybeFinish(job)
  }

  const cancelJob = (message: LocalPcmWorkerCancelMessage): void => {
    const job = jobs.get(message.jobId)
    if (!job || job.settled || job.cancelRequested) return
    job.cancelRequested = true
    try {
      job.child.stdout.pause()
      if (job.pid !== null && !job.child.killed) job.child.kill('SIGKILL')
    } catch {
      // A concurrent child close is handled by maybeFinish.
    }
    maybeFinish(job)
  }

  const handleMessage = (value: unknown): void => {
    if (!isLocalPcmWorkerRequestMessage(value)) {
      post({
        type: 'protocol-error',
        version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
        jobId: localPcmWorkerProtocolJobId(value),
        errorMessage: 'Local PCM worker received an invalid protocol message.'
      })
      return
    }
    if (value.type === 'start') startJob(value)
    else if (value.type === 'credit') acknowledgeChunk(value)
    else cancelJob(value)
  }

  port.on('message', handleMessage)
  post({ type: 'ready', version: LOCAL_PCM_WORKER_PROTOCOL_VERSION })
  return () => {
    for (const job of jobs.values()) {
      job.cancelRequested = true
      try {
        if (job.pid !== null && !job.child.killed) job.child.kill('SIGKILL')
      } catch {
        // Runtime shutdown is best-effort; the parent retains every child PID.
      }
      clearJobBuffers(job)
    }
    jobs.clear()
  }
}

if (parentPort) {
  startLocalPcmDrainWorkerRuntime(parentPort as unknown as LocalPcmDrainWorkerPort)
}
