import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LOCAL_PCM_WORKER_CHUNK_BYTES,
  LOCAL_PCM_WORKER_MAX_BYTES,
  LOCAL_PCM_WORKER_PROTOCOL_VERSION,
  isLocalPcmWorkerRequestMessage,
  isLocalPcmWorkerResponseMessage,
  type LocalPcmWorkerTimingSummary
} from './localPcmWorkerProtocol.ts'
import type { FfmpegStdoutIngestionTimingSummary } from './ffmpegStdoutIngestionTimings.ts'

function stdoutTimings(bytes: number): FfmpegStdoutIngestionTimingSummary {
  return {
    ffmpegStdoutChunkCount: bytes === 0 ? 0 : 1,
    ffmpegStdoutBytes: bytes,
    ffmpegStdoutChunkMinBytes: bytes,
    ffmpegStdoutChunkMaxBytes: bytes,
    ffmpegStdoutDrainSpanMs: 1,
    ffmpegStdoutDrainToCloseMs: 0,
    ffmpegStdoutCallbackWorkMs: 1,
    ffmpegStdoutCallbackMaxMs: 1,
    ffmpegStdoutInterCallbackGapMs: 0,
    ffmpegStdoutInterCallbackGapMaxMs: 0,
    ffmpegStdoutPostDispatchGapCount: 0,
    ffmpegStdoutPostDispatchGapMs: 0,
    ffmpegStdoutPostDispatchGapMaxMs: 0,
    streamCreditAckCount: 0,
    streamCreditRoundTripMs: 0,
    streamCreditRoundTripMaxMs: 0,
    ffmpegStdoutCopyMs: 1,
    ffmpegStdoutCopyMaxMs: 1,
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
    ffmpegWorkerAggregationCopyMs: 1,
    ffmpegWorkerAggregationCopyMaxMs: 1,
    ffmpegWorkerBatchCopyMs: 1,
    ffmpegWorkerBatchPostMs: 0,
    ffmpegWorkerCreditWaitCount: 0,
    ffmpegWorkerCreditWaitMs: 0,
    ffmpegWorkerCreditWaitMaxMs: 0
  }
}

test('strictly validates start, credit, and cancel requests', () => {
  const start = {
    type: 'start',
    version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
    jobId: 'sender:42',
    ffmpegPath: 'C:\\ffmpeg.exe',
    args: ['-v', 'error', 'pipe:1']
  }
  assert.equal(isLocalPcmWorkerRequestMessage(start), true)
  assert.equal(isLocalPcmWorkerRequestMessage({ ...start, extra: true }), false)
  assert.equal(isLocalPcmWorkerRequestMessage({ ...start, args: [1] }), false)
  assert.equal(isLocalPcmWorkerRequestMessage({ ...start, jobId: '' }), false)
  assert.equal(isLocalPcmWorkerRequestMessage({
    type: 'credit', version: 1, jobId: 'sender:42', sequence: 0
  }), true)
  assert.equal(isLocalPcmWorkerRequestMessage({
    type: 'credit', version: 1, jobId: 'sender:42', sequence: -1
  }), false)
  assert.equal(isLocalPcmWorkerRequestMessage({
    type: 'cancel', version: 1, jobId: 'sender:42'
  }), true)
})

test('validates owned chunks and rejects oversized or inexact payloads', () => {
  const payload = new ArrayBuffer(16)
  const chunk = {
    type: 'chunk',
    version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
    jobId: 'job',
    sequence: 0,
    byteOffset: 0,
    byteLength: payload.byteLength,
    payload
  }
  assert.equal(isLocalPcmWorkerResponseMessage(chunk), true)
  assert.equal(isLocalPcmWorkerResponseMessage({ ...chunk, byteLength: 15 }), false)
  assert.equal(isLocalPcmWorkerResponseMessage({
    ...chunk,
    byteOffset: LOCAL_PCM_WORKER_MAX_BYTES,
    byteLength: 16
  }), false)
  assert.equal(isLocalPcmWorkerResponseMessage({
    ...chunk,
    byteLength: LOCAL_PCM_WORKER_CHUNK_BYTES + 1,
    payload: new ArrayBuffer(LOCAL_PCM_WORKER_CHUNK_BYTES + 1)
  }), false)
})

test('requires complete messages to reconcile PCM, batches, and stdout bytes', () => {
  const complete = {
    type: 'complete',
    version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
    jobId: 'job',
    pcmByteLength: 16,
    chunkCount: 1,
    stdoutTimings: stdoutTimings(16),
    workerTimings: workerTimings(16, 1)
  }
  assert.equal(isLocalPcmWorkerResponseMessage(complete), true)
  assert.equal(isLocalPcmWorkerResponseMessage({ ...complete, pcmByteLength: 15 }), false)
  assert.equal(isLocalPcmWorkerResponseMessage({ ...complete, chunkCount: 2 }), false)
  assert.equal(isLocalPcmWorkerResponseMessage({
    ...complete,
    workerTimings: { ...complete.workerTimings, ffmpegWorkerAggregationCopyMaxMs: 2 }
  }), false)
  assert.equal(isLocalPcmWorkerResponseMessage({ ...complete, unexpected: 1 }), false)
})

test('validates terminal failures without accepting unbounded stderr', () => {
  const failed = {
    type: 'failed',
    version: LOCAL_PCM_WORKER_PROTOCOL_VERSION,
    jobId: 'job',
    failureKind: 'decode',
    errorMessage: 'decode failed',
    stderr: 'tail',
    stdoutTimings: stdoutTimings(0),
    workerTimings: workerTimings(0, 0)
  }
  assert.equal(isLocalPcmWorkerResponseMessage(failed), true)
  assert.equal(isLocalPcmWorkerResponseMessage({ ...failed, failureKind: 'other' }), false)
  assert.equal(isLocalPcmWorkerResponseMessage({ ...failed, stderr: 'x'.repeat(32 * 1024 + 1) }), false)
})
