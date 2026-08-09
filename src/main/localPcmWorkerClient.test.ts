import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  LocalPcmWorkerClient,
  LocalPcmWorkerDecodeError,
  type LocalPcmWorkerBatch,
  type LocalPcmWorkerLike
} from './localPcmWorkerClient.ts'
import {
  LOCAL_PCM_WORKER_PROTOCOL_VERSION,
  type LocalPcmWorkerResponseMessage,
  type LocalPcmWorkerTimingSummary
} from './localPcmWorkerProtocol.ts'
import type { FfmpegStdoutIngestionTimingSummary } from './ffmpegStdoutIngestionTimings.ts'

class FakeWorker extends EventEmitter implements LocalPcmWorkerLike {
  readonly posted: unknown[] = []
  readonly lifecycle: string[]
  unrefCount = 0

  constructor(lifecycle: string[] = []) {
    super()
    this.lifecycle = lifecycle
  }

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  terminate(): number {
    this.lifecycle.push('terminate')
    return 0
  }

  unref(): void {
    this.unrefCount += 1
  }

  send(message: LocalPcmWorkerResponseMessage): void {
    this.emit('message', message)
  }
}

function stdoutTimings(bytes: number, chunks: number): FfmpegStdoutIngestionTimingSummary {
  return {
    ffmpegStdoutChunkCount: chunks,
    ffmpegStdoutBytes: bytes,
    ffmpegStdoutChunkMinBytes: chunks === 0 ? 0 : bytes,
    ffmpegStdoutChunkMaxBytes: chunks === 0 ? 0 : bytes,
    ffmpegStdoutDrainSpanMs: chunks,
    ffmpegStdoutDrainToCloseMs: 0,
    ffmpegStdoutCallbackWorkMs: chunks,
    ffmpegStdoutCallbackMaxMs: chunks === 0 ? 0 : 1,
    ffmpegStdoutInterCallbackGapMs: 0,
    ffmpegStdoutInterCallbackGapMaxMs: 0,
    ffmpegStdoutPostDispatchGapCount: 0,
    ffmpegStdoutPostDispatchGapMs: 0,
    ffmpegStdoutPostDispatchGapMaxMs: 0,
    streamCreditAckCount: 0,
    streamCreditRoundTripMs: 0,
    streamCreditRoundTripMaxMs: 0,
    ffmpegStdoutCopyMs: chunks,
    ffmpegStdoutCopyMaxMs: chunks === 0 ? 0 : 1,
    ffmpegStdoutFlushMs: 0,
    ffmpegStdoutFlushMaxMs: 0,
    ffmpegStdoutPauseCount: 0,
    ffmpegStdoutPausedMs: 0,
    ffmpegStdoutPauseMaxMs: 0
  }
}

function workerTimings(bytes: number, chunks: number): LocalPcmWorkerTimingSummary {
  return {
    ffmpegWorkerTotalMs: 5,
    ffmpegWorkerSpawnMs: 1,
    ffmpegWorkerFfmpegMs: 4,
    ffmpegWorkerSpawnToFirstPcmMs: 1,
    ffmpegWorkerPcmOutputSpanMs: 2,
    ffmpegWorkerCloseTailMs: 1,
    ffmpegWorkerBatchCount: chunks,
    ffmpegWorkerBatchBytes: bytes,
    ffmpegWorkerBatchMinBytes: chunks === 0 ? 0 : bytes,
    ffmpegWorkerBatchMaxBytes: chunks === 0 ? 0 : bytes,
    ffmpegWorkerAggregationCopyMs: chunks,
    ffmpegWorkerAggregationCopyMaxMs: chunks === 0 ? 0 : 1,
    ffmpegWorkerBatchCopyMs: chunks,
    ffmpegWorkerBatchPostMs: 0,
    ffmpegWorkerCreditWaitCount: 0,
    ffmpegWorkerCreditWaitMs: 0,
    ffmpegWorkerCreditWaitMaxMs: 0
  }
}

async function ready(client: LocalPcmWorkerClient, worker: FakeWorker): Promise<void> {
  const promise = client.ensureReady()
  await new Promise<void>((resolve) => setImmediate(resolve))
  worker.send({ type: 'ready', version: LOCAL_PCM_WORKER_PROTOCOL_VERSION })
  await promise
}

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function started(worker: FakeWorker, jobId: string, pid: number): void {
  worker.send({
    type: 'started',
    version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
    jobId,
    pid
  })
}

function chunk(
  worker: FakeWorker,
  jobId: string,
  sequence: number,
  byteOffset: number,
  bytes: number[]
): void {
  const payload = Uint8Array.from(bytes).buffer
  worker.send({
    type: 'chunk',
    version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
    jobId,
    sequence,
    byteOffset,
    byteLength: payload.byteLength,
    payload
  })
}

function complete(worker: FakeWorker, jobId: string, bytes: number, chunks: number): void {
  worker.send({
    type: 'complete',
    version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
    jobId,
    pcmByteLength: bytes,
    chunkCount: chunks,
    stdoutTimings: stdoutTimings(bytes, chunks),
    workerTimings: workerTimings(bytes, chunks)
  })
}

test('uses one persistent ready worker and exposes exact chunks with idempotent credits', async () => {
  const worker = new FakeWorker()
  let factoryCalls = 0
  const client = new LocalPcmWorkerClient({
    workerFactory: () => {
      factoryCalls += 1
      return worker
    }
  })
  await ready(client, worker)
  assert.equal(worker.unrefCount, 1)

  const batches: LocalPcmWorkerBatch[] = []
  const handle = client.start(
    { jobId: 'job-1', ffmpegPath: 'ffmpeg', args: ['pipe:1'] },
    { onChunk: (batch) => batches.push(batch) }
  )
  await flushTasks()
  started(worker, 'job-1', 123)
  chunk(worker, 'job-1', 0, 0, [1, 2])
  chunk(worker, 'job-1', 1, 2, [3])
  assert.deepEqual(batches.map((batch) => Array.from(new Uint8Array(batch.payload))), [[1, 2], [3]])
  assert.equal(handle.getPid(), 123)

  batches[0].acknowledge()
  batches[0].acknowledge()
  batches[1].acknowledge()
  const credits = worker.posted.filter((message) => (
    typeof message === 'object' && message !== null && (message as { type?: string }).type === 'credit'
  ))
  assert.deepEqual(credits, [
    { type: 'credit', version: 1, jobId: 'job-1', sequence: 0 },
    { type: 'credit', version: 1, jobId: 'job-1', sequence: 1 }
  ])

  complete(worker, 'job-1', 3, 2)
  assert.deepEqual(await handle.promise, {
    jobId: 'job-1',
    pid: 123,
    pcmByteLength: 3,
    chunkCount: 2,
    stdoutTimings: stdoutTimings(3, 2),
    workerTimings: workerTimings(3, 2)
  })

  const second = client.decode(
    { jobId: 'job-2', ffmpegPath: 'ffmpeg', args: ['pipe:1'] },
    { onChunk: () => undefined }
  )
  await flushTasks()
  started(worker, 'job-2', 124)
  chunk(worker, 'job-2', 0, 0, [4])
  complete(worker, 'job-2', 1, 1)
  await second.promise
  assert.equal(factoryCalls, 1)
  client.dispose()
})

test('a deferred stale acknowledgement cannot credit a completed or reused job ID', async () => {
  const worker = new FakeWorker()
  const client = new LocalPcmWorkerClient({ workerFactory: () => worker })
  await ready(client, worker)

  let oldBatch: LocalPcmWorkerBatch | null = null
  const first = client.start(
    { jobId: 'same', ffmpegPath: 'ffmpeg', args: [] },
    { onChunk: (batch) => { oldBatch = batch } }
  )
  await flushTasks()
  started(worker, 'same', 200)
  chunk(worker, 'same', 0, 0, [1])
  complete(worker, 'same', 1, 1)
  await first.promise

  const second = client.start(
    { jobId: 'same', ffmpegPath: 'ffmpeg', args: [] },
    { onChunk: () => undefined }
  )
  await flushTasks()
  const creditsBefore = worker.posted.length
  const deferredBatch = oldBatch as unknown as LocalPcmWorkerBatch
  assert.ok(deferredBatch)
  deferredBatch.acknowledge()
  assert.equal(worker.posted.length, creditsBefore)
  second.cancel()
  worker.send({
    type: 'cancelled',
    version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
    jobId: 'same',
    stdoutTimings: stdoutTimings(0, 0),
    workerTimings: workerTimings(0, 0)
  })
  await assert.rejects(second.promise)
  client.dispose()
})

test('supports distinct concurrent keyed jobs while rejecting a duplicate active key', async () => {
  const worker = new FakeWorker()
  const client = new LocalPcmWorkerClient({ workerFactory: () => worker })
  await ready(client, worker)
  const callbacks = { onChunk: () => undefined }
  const first = client.start({ jobId: 'a', ffmpegPath: 'ffmpeg', args: [] }, callbacks)
  const second = client.start({ jobId: 'b', ffmpegPath: 'ffmpeg', args: [] }, callbacks)
  assert.throws(
    () => client.start({ jobId: 'a', ffmpegPath: 'ffmpeg', args: [] }, callbacks),
    /already active/
  )
  first.cancel()
  second.cancel()
  await assert.rejects(first.promise)
  await assert.rejects(second.promise)
  client.dispose()
})

test('a job-scoped protocol error kills its child before replacing the worker', async () => {
  const lifecycle: string[] = []
  const worker = new FakeWorker(lifecycle)
  const client = new LocalPcmWorkerClient({
    workerFactory: () => worker,
    emergencyKill: (pid) => lifecycle.push(`kill:${pid}`)
  })
  await ready(client, worker)
  const handle = client.start(
    { jobId: 'protocol-job', ffmpegPath: 'ffmpeg', args: [] },
    { onChunk: () => undefined }
  )
  await flushTasks()
  started(worker, 'protocol-job', 332)
  worker.send({
    type: 'protocol-error',
    version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
    jobId: 'protocol-job',
    errorMessage: 'invalid worker control'
  })

  await assert.rejects(handle.promise, LocalPcmWorkerDecodeError)
  assert.deepEqual(lifecycle, ['kill:332', 'terminate'])
})

test('kills every reported pid before terminating after a protocol failure', async () => {
  const lifecycle: string[] = []
  const worker = new FakeWorker(lifecycle)
  const client = new LocalPcmWorkerClient({
    workerFactory: () => worker,
    emergencyKill: (pid) => lifecycle.push(`kill:${pid}`)
  })
  await ready(client, worker)
  const handle = client.start(
    { jobId: 'bad', ffmpegPath: 'ffmpeg', args: [] },
    { onChunk: () => undefined }
  )
  await flushTasks()
  started(worker, 'bad', 333)
  chunk(worker, 'bad', 0, 1, [1])
  await assert.rejects(handle.promise, LocalPcmWorkerDecodeError)
  assert.deepEqual(lifecycle, ['kill:333', 'terminate'])
})

test('cancellation timeout emergency-kills before replacing the worker', async () => {
  const lifecycle: string[] = []
  const worker = new FakeWorker(lifecycle)
  const client = new LocalPcmWorkerClient({
    workerFactory: () => worker,
    emergencyKill: (pid) => lifecycle.push(`kill:${pid}`),
    cancelTimeoutMs: 5
  })
  await ready(client, worker)
  const handle = client.start(
    { jobId: 'cancel', ffmpegPath: 'ffmpeg', args: [] },
    { onChunk: () => undefined }
  )
  await flushTasks()
  started(worker, 'cancel', 444)
  handle.cancel()
  await assert.rejects(handle.promise, /cancellation timed out/)
  assert.deepEqual(lifecycle, ['kill:444', 'terminate'])
})

test('clean shutdown kills active children before terminating the unrefed worker', async () => {
  const lifecycle: string[] = []
  const worker = new FakeWorker(lifecycle)
  const client = new LocalPcmWorkerClient({
    workerFactory: () => worker,
    emergencyKill: (pid) => lifecycle.push(`kill:${pid}`)
  })
  await ready(client, worker)
  const handle = client.start(
    { jobId: 'shutdown', ffmpegPath: 'ffmpeg', args: [] },
    { onChunk: () => undefined }
  )
  await flushTasks()
  started(worker, 'shutdown', 555)
  client.shutdown()
  await assert.rejects(handle.promise)
  assert.deepEqual(lifecycle, ['kill:555', 'terminate'])
})
