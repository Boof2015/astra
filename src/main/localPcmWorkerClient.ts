/// <reference types="electron-vite/node" />

import { Worker } from 'node:worker_threads'
import {
  LOCAL_PCM_WORKER_CANCEL_TIMEOUT_MS,
  LOCAL_PCM_WORKER_MAX_BYTES,
  LOCAL_PCM_WORKER_PROTOCOL_VERSION,
  LOCAL_PCM_WORKER_READY_TIMEOUT_MS,
  isLocalPcmWorkerRequestMessage,
  isLocalPcmWorkerResponseMessage,
  type LocalPcmWorkerCompleteMessage,
  type LocalPcmWorkerFailureKind,
  type LocalPcmWorkerStartMessage,
  type LocalPcmWorkerTimingSummary
} from './localPcmWorkerProtocol'
import type { FfmpegStdoutIngestionTimingSummary } from './ffmpegStdoutIngestionTimings'

export interface LocalPcmWorkerLike {
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  postMessage(message: unknown): void
  terminate(): Promise<number> | number
  unref?: () => void
}

export type LocalPcmWorkerFactory = () => LocalPcmWorkerLike | Promise<LocalPcmWorkerLike>

export interface LocalPcmWorkerDecodeRequest {
  jobId: string
  ffmpegPath: string
  args: string[]
}

export interface LocalPcmWorkerBatchPayload {
  jobId: string
  sequence: number
  byteOffset: number
  byteLength: number
  payload: ArrayBuffer
}

export interface LocalPcmWorkerBatch extends LocalPcmWorkerBatchPayload {
  /** Returns one credit at most once; safe to defer until FFprobe releases the gate. */
  acknowledge: () => void
}

export interface LocalPcmWorkerCallbacks {
  onStarted?: (pid: number) => void
  onChunk?: (batch: LocalPcmWorkerBatch) => void
  onBatch?: (batch: LocalPcmWorkerBatchPayload, acknowledge: () => void) => void
}

export interface LocalPcmWorkerDecodeResult {
  jobId: string
  pid: number
  pcmByteLength: number
  chunkCount: number
  stdoutTimings: FfmpegStdoutIngestionTimingSummary
  workerTimings: LocalPcmWorkerTimingSummary
}

export interface LocalPcmWorkerJobHandle {
  readonly jobId: string
  readonly promise: Promise<LocalPcmWorkerDecodeResult>
  cancel: () => void
  getPid: () => number | null
}

export class LocalPcmWorkerCancelledError extends Error {
  readonly jobId: string

  constructor(jobId: string) {
    super('Local PCM worker decode was cancelled.')
    this.name = 'LocalPcmWorkerCancelledError'
    this.jobId = jobId
  }
}

export class LocalPcmWorkerDecodeError extends Error {
  readonly jobId: string
  readonly failureKind: LocalPcmWorkerFailureKind | 'worker'
  readonly stderr: string
  readonly stdoutTimings?: FfmpegStdoutIngestionTimingSummary
  readonly workerTimings?: LocalPcmWorkerTimingSummary

  constructor(options: {
    jobId: string
    message: string
    failureKind: LocalPcmWorkerFailureKind | 'worker'
    stderr?: string
    stdoutTimings?: FfmpegStdoutIngestionTimingSummary
    workerTimings?: LocalPcmWorkerTimingSummary
  }) {
    super(options.message)
    this.name = 'LocalPcmWorkerDecodeError'
    this.jobId = options.jobId
    this.failureKind = options.failureKind
    this.stderr = options.stderr ?? ''
    this.stdoutTimings = options.stdoutTimings
    this.workerTimings = options.workerTimings
  }
}

interface ClientJobState {
  jobId: string
  callbacks: LocalPcmWorkerCallbacks
  resolve: (result: LocalPcmWorkerDecodeResult) => void
  reject: (error: Error) => void
  pid: number | null
  startPosted: boolean
  cancelRequested: boolean
  settled: boolean
  expectedSequence: number
  expectedByteOffset: number
  cancelTimer: ReturnType<typeof setTimeout> | null
}

export interface LocalPcmWorkerClientOptions {
  workerFactory?: LocalPcmWorkerFactory
  emergencyKill?: (pid: number) => void
  readyTimeoutMs?: number
  cancelTimeoutMs?: number
}

async function createBundledLocalPcmWorker(): Promise<LocalPcmWorkerLike> {
  // Keep the Vite-only query out of the direct Node test graph. electron-vite
  // separately compiles this TypeScript entry in dev and production and
  // returns its absolute output path.
  const { default: workerPath } = await import('./localPcmDrainWorker?modulePath')
  return new Worker(workerPath, { name: 'astra-local-pcm-drain' })
}

function defaultEmergencyKill(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return
  // This path runs only after the worker's child-termination/close handshake
  // failed or the worker itself died. Force termination before the
  // owning worker is discarded so FFmpeg cannot survive as an orphan.
  process.kill(pid, 'SIGKILL')
}

function validateTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

export class LocalPcmWorkerClient {
  private readonly workerFactory: LocalPcmWorkerFactory
  private readonly emergencyKill: (pid: number) => void
  private readonly readyTimeoutMs: number
  private readonly cancelTimeoutMs: number
  private readonly jobs = new Map<string, ClientJobState>()
  private worker: LocalPcmWorkerLike | null = null
  private workerGeneration = 0
  private ready = false
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(options: LocalPcmWorkerClientOptions = {}) {
    this.workerFactory = options.workerFactory ?? createBundledLocalPcmWorker
    this.emergencyKill = options.emergencyKill ?? defaultEmergencyKill
    this.readyTimeoutMs = validateTimeout(options.readyTimeoutMs, LOCAL_PCM_WORKER_READY_TIMEOUT_MS)
    this.cancelTimeoutMs = validateTimeout(options.cancelTimeoutMs, LOCAL_PCM_WORKER_CANCEL_TIMEOUT_MS)
  }

  async ensureReady(): Promise<void> {
    if (this.disposed) throw new Error('Local PCM worker client has been disposed.')
    if (this.ready && this.worker) return
    if (this.readyPromise) return this.readyPromise

    const generation = ++this.workerGeneration
    const initializing = this.initializeWorker(generation)
    this.readyPromise = initializing
    try {
      await initializing
    } catch (error) {
      if (this.workerGeneration === generation) {
        this.readyPromise = null
        this.ready = false
      }
      throw error
    }
  }

  start(
    request: LocalPcmWorkerDecodeRequest,
    callbacks: LocalPcmWorkerCallbacks
  ): LocalPcmWorkerJobHandle {
    if (this.disposed) throw new Error('Local PCM worker client has been disposed.')
    if (
      typeof callbacks?.onChunk !== 'function'
      && typeof callbacks?.onBatch !== 'function'
    ) {
      throw new TypeError('Local PCM worker requires an onChunk or onBatch callback.')
    }
    const startMessage: LocalPcmWorkerStartMessage = {
      type: 'start',
      version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
      jobId: request.jobId,
      ffmpegPath: request.ffmpegPath,
      args: [...request.args]
    }
    if (!isLocalPcmWorkerRequestMessage(startMessage)) {
      throw new TypeError('Local PCM worker decode request is invalid.')
    }
    if (this.jobs.has(request.jobId)) {
      throw new Error(`Local PCM worker job is already active: ${request.jobId}`)
    }

    let resolvePromise!: (result: LocalPcmWorkerDecodeResult) => void
    let rejectPromise!: (error: Error) => void
    const promise = new Promise<LocalPcmWorkerDecodeResult>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const job: ClientJobState = {
      jobId: request.jobId,
      callbacks,
      resolve: resolvePromise,
      reject: rejectPromise,
      pid: null,
      startPosted: false,
      cancelRequested: false,
      settled: false,
      expectedSequence: 0,
      expectedByteOffset: 0,
      cancelTimer: null
    }
    this.jobs.set(job.jobId, job)
    void this.postStartWhenReady(job, startMessage)

    return {
      jobId: job.jobId,
      promise,
      cancel: () => this.cancel(job.jobId),
      getPid: () => job.pid
    }
  }

  decode(
    request: LocalPcmWorkerDecodeRequest,
    callbacks: LocalPcmWorkerCallbacks
  ): LocalPcmWorkerJobHandle {
    return this.start(request, callbacks)
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job || job.settled || job.cancelRequested) return
    job.cancelRequested = true
    if (!job.startPosted) {
      this.settleCancelled(job)
      return
    }
    try {
      this.worker?.postMessage({
        type: 'cancel',
        version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
        jobId
      })
    } catch (error) {
      this.failWorker(
        this.worker,
        error instanceof Error ? error : new Error('Local PCM worker cancellation failed.')
      )
      return
    }
    job.cancelTimer = setTimeout(() => {
      if (!job.settled) {
        this.failWorker(
          this.worker,
          new Error(`Local PCM worker cancellation timed out for ${job.jobId}.`)
        )
      }
    }, this.cancelTimeoutMs)
    job.cancelTimer.unref?.()
  }

  shutdown(): void {
    this.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const worker = this.worker
    this.rejectReady(new Error('Local PCM worker client was disposed.'))
    this.emergencyKillAll()
    for (const job of this.jobs.values()) {
      this.settleCancelled(job)
    }
    this.worker = null
    this.ready = false
    this.readyPromise = null
    this.workerGeneration += 1
    if (worker) {
      try {
        void worker.terminate()
      } catch {
        // Shutdown is best-effort after every known child PID was killed.
      }
    }
  }

  private async initializeWorker(generation: number): Promise<void> {
    let worker: LocalPcmWorkerLike
    try {
      worker = await this.workerFactory()
    } catch (error) {
      throw error instanceof Error ? error : new Error('Local PCM worker could not be created.')
    }
    if (this.disposed || generation !== this.workerGeneration) {
      try {
        void worker.terminate()
      } catch {
        // A superseded worker has no jobs or child PIDs yet.
      }
      throw new Error('Local PCM worker initialization was superseded.')
    }

    this.worker = worker
    worker.on('message', (message) => {
      if (this.worker === worker) this.handleMessage(worker, message)
    })
    worker.on('error', (error) => {
      if (this.worker === worker) this.failWorker(worker, error)
    })
    worker.on('exit', (code) => {
      if (this.worker === worker) {
        this.failWorker(worker, new Error(`Local PCM worker exited unexpectedly (${code}).`), false)
      }
    })
    // The worker is persistent between decodes but must never keep Electron
    // alive if a platform quit path races explicit client shutdown.
    worker.unref?.()

    await new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      this.readyTimer = setTimeout(() => {
        if (this.worker === worker && !this.ready) {
          this.failWorker(worker, new Error('Local PCM worker ready handshake timed out.'))
        }
      }, this.readyTimeoutMs)
      this.readyTimer.unref?.()
    })
  }

  private async postStartWhenReady(
    job: ClientJobState,
    message: LocalPcmWorkerStartMessage
  ): Promise<void> {
    try {
      await this.ensureReady()
      if (job.settled || job.cancelRequested || this.jobs.get(job.jobId) !== job) return
      const worker = this.worker
      if (!worker) throw new Error('Local PCM worker disappeared before decode start.')
      worker.postMessage(message)
      job.startPosted = true
    } catch (error) {
      if (!job.settled) {
        this.settleRejected(job, new LocalPcmWorkerDecodeError({
          jobId: job.jobId,
          message: error instanceof Error ? error.message : 'Local PCM worker failed to initialize.',
          failureKind: 'worker'
        }))
      }
    }
  }

  private handleMessage(worker: LocalPcmWorkerLike, value: unknown): void {
    if (!isLocalPcmWorkerResponseMessage(value)) {
      this.failWorker(worker, new Error('Local PCM worker returned an invalid protocol message.'))
      return
    }

    if (value.type === 'ready') {
      if (this.ready) {
        this.failWorker(worker, new Error('Local PCM worker repeated its ready handshake.'))
        return
      }
      this.ready = true
      if (this.readyTimer) clearTimeout(this.readyTimer)
      this.readyTimer = null
      const resolve = this.readyResolve
      this.readyResolve = null
      this.readyReject = null
      resolve?.()
      return
    }

    if (value.type === 'protocol-error') {
      // A protocol error means the worker and client no longer agree on job
      // ownership. Tear down the whole worker so no child can survive after
      // its client-side cancellation handle has been removed.
      this.failWorker(worker, new Error(value.errorMessage))
      return
    }

    const job = this.jobs.get(value.jobId)
    // A terminal/cancelled job can still have already-enqueued worker events.
    if (!job || job.settled) return

    if (value.type === 'started') {
      if (job.pid !== null) {
        this.failWorker(worker, new Error(`Local PCM worker repeated pid for ${job.jobId}.`))
        return
      }
      job.pid = value.pid
      try {
        job.callbacks.onStarted?.(value.pid)
      } catch (error) {
        this.cancelAfterConsumerFailure(job, error)
      }
      return
    }

    if (value.type === 'chunk') {
      if (
        value.sequence !== job.expectedSequence
        || value.byteOffset !== job.expectedByteOffset
        || value.byteOffset + value.byteLength > LOCAL_PCM_WORKER_MAX_BYTES
      ) {
        this.failWorker(worker, new Error(`Local PCM worker batch ordering failed for ${job.jobId}.`))
        return
      }
      job.expectedSequence += 1
      job.expectedByteOffset += value.byteLength
      let acknowledged = false
      const acknowledge = (): void => {
        if (acknowledged) return
        acknowledged = true
        if (job.settled || this.jobs.get(job.jobId) !== job || this.worker !== worker) return
        try {
          worker.postMessage({
            type: 'credit',
            version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
            jobId: job.jobId,
            sequence: value.sequence
          })
        } catch (error) {
          this.failWorker(
            worker,
            error instanceof Error ? error : new Error('Local PCM worker credit failed.')
          )
        }
      }
      try {
        const batchPayload: LocalPcmWorkerBatchPayload = {
          jobId: job.jobId,
          sequence: value.sequence,
          byteOffset: value.byteOffset,
          byteLength: value.byteLength,
          payload: value.payload
        }
        if (job.callbacks.onChunk) {
          job.callbacks.onChunk({ ...batchPayload, acknowledge })
        } else {
          job.callbacks.onBatch?.(batchPayload, acknowledge)
        }
      } catch (error) {
        this.cancelAfterConsumerFailure(job, error)
      }
      return
    }

    if (value.type === 'complete') {
      this.completeJob(job, value, worker)
      return
    }

    if (value.type === 'cancelled') {
      this.settleCancelled(job)
      return
    }

    this.settleRejected(job, new LocalPcmWorkerDecodeError({
      jobId: job.jobId,
      message: value.errorMessage,
      failureKind: value.failureKind,
      stderr: value.stderr,
      stdoutTimings: value.stdoutTimings,
      workerTimings: value.workerTimings
    }))
  }

  private completeJob(
    job: ClientJobState,
    message: LocalPcmWorkerCompleteMessage,
    worker: LocalPcmWorkerLike
  ): void {
    if (
      job.pid === null
      || message.chunkCount !== job.expectedSequence
      || message.pcmByteLength !== job.expectedByteOffset
    ) {
      this.failWorker(worker, new Error(`Local PCM worker completion did not reconcile for ${job.jobId}.`))
      return
    }
    this.clearCancelTimer(job)
    job.settled = true
    this.jobs.delete(job.jobId)
    job.resolve({
      jobId: job.jobId,
      pid: job.pid,
      pcmByteLength: message.pcmByteLength,
      chunkCount: message.chunkCount,
      stdoutTimings: message.stdoutTimings,
      workerTimings: message.workerTimings
    })
  }

  private cancelAfterConsumerFailure(job: ClientJobState, error: unknown): void {
    if (!job.cancelRequested && job.startPosted) {
      try {
        this.worker?.postMessage({
          type: 'cancel',
          version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
          jobId: job.jobId
        })
      } catch {
        // The retained PID is emergency-killed below if worker messaging failed.
      }
    }
    if (job.pid !== null) this.killPid(job.pid)
    this.settleRejected(job, error instanceof Error ? error : new Error('PCM batch consumer failed.'))
  }

  private settleCancelled(job: ClientJobState): void {
    if (job.settled) return
    this.clearCancelTimer(job)
    job.settled = true
    this.jobs.delete(job.jobId)
    job.reject(new LocalPcmWorkerCancelledError(job.jobId))
  }

  private settleRejected(job: ClientJobState, error: Error): void {
    if (job.settled) return
    this.clearCancelTimer(job)
    job.settled = true
    this.jobs.delete(job.jobId)
    job.reject(error)
  }

  private clearCancelTimer(job: ClientJobState): void {
    if (job.cancelTimer) clearTimeout(job.cancelTimer)
    job.cancelTimer = null
  }

  private rejectReady(error: Error): void {
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
    const reject = this.readyReject
    this.readyResolve = null
    this.readyReject = null
    reject?.(error)
  }

  private killPid(pid: number): void {
    try {
      this.emergencyKill(pid)
    } catch {
      // The process may already have exited between the message and cleanup.
    }
  }

  private emergencyKillAll(): void {
    const killed = new Set<number>()
    for (const job of this.jobs.values()) {
      if (job.pid === null || killed.has(job.pid)) continue
      killed.add(job.pid)
      this.killPid(job.pid)
    }
  }

  private failWorker(
    worker: LocalPcmWorkerLike | null,
    error: Error,
    terminate: boolean = true
  ): void {
    if (worker && this.worker !== worker) return
    const failedWorker = this.worker
    // Kill every child while the worker/PID ownership table is still intact,
    // then terminate the worker. This prevents an orphaned FFmpeg process.
    this.emergencyKillAll()
    this.rejectReady(error)
    this.worker = null
    this.ready = false
    this.readyPromise = null
    this.workerGeneration += 1
    for (const job of [...this.jobs.values()]) {
      this.settleRejected(job, new LocalPcmWorkerDecodeError({
        jobId: job.jobId,
        message: error.message,
        failureKind: 'worker'
      }))
    }
    if (terminate && failedWorker) {
      try {
        void failedWorker.terminate()
      } catch {
        // The worker may already be terminating after its error event.
      }
    }
  }
}

export function createLocalPcmWorkerClient(
  options: LocalPcmWorkerClientOptions = {}
): LocalPcmWorkerClient {
  return new LocalPcmWorkerClient(options)
}

/** Lazily starts on first ensureReady/decode and persists between jobs. */
export const localPcmWorkerClient = createLocalPcmWorkerClient()
