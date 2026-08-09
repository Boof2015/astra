import {
  LOCAL_PCM_STREAM_CHUNK_BYTES,
  LOCAL_PCM_STREAM_INITIAL_CREDITS,
  LOCAL_PCM_STREAM_MAX_BYTES
} from '../shared/localPcmStream'
import type { FfmpegStdoutIngestionTimingSummary } from './ffmpegStdoutIngestionTimings'

export const LOCAL_PCM_WORKER_PROTOCOL_VERSION = 1 as const
export const LOCAL_PCM_WORKER_CHUNK_BYTES = LOCAL_PCM_STREAM_CHUNK_BYTES
export const LOCAL_PCM_WORKER_INITIAL_CREDITS = LOCAL_PCM_STREAM_INITIAL_CREDITS
export const LOCAL_PCM_WORKER_MAX_BYTES = LOCAL_PCM_STREAM_MAX_BYTES
export const LOCAL_PCM_WORKER_MAX_STDERR_BYTES = 32 * 1024
export const LOCAL_PCM_WORKER_READY_TIMEOUT_MS = 10_000
export const LOCAL_PCM_WORKER_CANCEL_TIMEOUT_MS = 5_000

const LOCAL_PCM_WORKER_MAX_JOB_ID_LENGTH = 256
const LOCAL_PCM_WORKER_MAX_PATH_LENGTH = 32_768
const LOCAL_PCM_WORKER_MAX_ARGUMENT_COUNT = 256
const LOCAL_PCM_WORKER_MAX_ARGUMENT_LENGTH = 32_768

interface LocalPcmWorkerWireBase {
  version: typeof LOCAL_PCM_WORKER_PROTOCOL_VERSION
}

interface LocalPcmWorkerJobWireBase extends LocalPcmWorkerWireBase {
  jobId: string
}

export interface LocalPcmWorkerStartMessage extends LocalPcmWorkerJobWireBase {
  type: 'start'
  ffmpegPath: string
  args: string[]
}

export interface LocalPcmWorkerCreditMessage extends LocalPcmWorkerJobWireBase {
  type: 'credit'
  sequence: number
}

export interface LocalPcmWorkerCancelMessage extends LocalPcmWorkerJobWireBase {
  type: 'cancel'
}

export type LocalPcmWorkerRequestMessage =
  | LocalPcmWorkerStartMessage
  | LocalPcmWorkerCreditMessage
  | LocalPcmWorkerCancelMessage

export interface LocalPcmWorkerTimingSummary {
  /** Start-message acceptance through the terminal worker message. */
  ffmpegWorkerTotalMs: number
  /** Synchronous child_process.spawn call duration. */
  ffmpegWorkerSpawnMs: number
  /** FFmpeg spawn through child close, measured inside the worker. */
  ffmpegWorkerFfmpegMs: number
  ffmpegWorkerSpawnToFirstPcmMs: number
  ffmpegWorkerPcmOutputSpanMs: number
  ffmpegWorkerCloseTailMs: number
  ffmpegWorkerBatchCount: number
  ffmpegWorkerBatchBytes: number
  ffmpegWorkerBatchMinBytes: number
  ffmpegWorkerBatchMaxBytes: number
  /** Raw stdout fragments copied into the active owned batch. */
  ffmpegWorkerAggregationCopyMs: number
  ffmpegWorkerAggregationCopyMaxMs: number
  /** Raw stdout bytes copied into owned transferable batches. */
  ffmpegWorkerBatchCopyMs: number
  /** Time spent enqueueing owned batches to the main thread. */
  ffmpegWorkerBatchPostMs: number
  ffmpegWorkerCreditWaitCount: number
  ffmpegWorkerCreditWaitMs: number
  ffmpegWorkerCreditWaitMaxMs: number
}

export interface LocalPcmWorkerReadyMessage extends LocalPcmWorkerWireBase {
  type: 'ready'
}

export interface LocalPcmWorkerStartedMessage extends LocalPcmWorkerJobWireBase {
  type: 'started'
  pid: number
}

export interface LocalPcmWorkerChunkMessage extends LocalPcmWorkerJobWireBase {
  type: 'chunk'
  sequence: number
  byteOffset: number
  byteLength: number
  payload: ArrayBuffer
}

export interface LocalPcmWorkerCompleteMessage extends LocalPcmWorkerJobWireBase {
  type: 'complete'
  pcmByteLength: number
  chunkCount: number
  stdoutTimings: FfmpegStdoutIngestionTimingSummary
  workerTimings: LocalPcmWorkerTimingSummary
}

export type LocalPcmWorkerFailureKind =
  | 'spawn'
  | 'decode'
  | 'stdout'
  | 'limit'
  | 'protocol'

export interface LocalPcmWorkerFailedMessage extends LocalPcmWorkerJobWireBase {
  type: 'failed'
  failureKind: LocalPcmWorkerFailureKind
  errorMessage: string
  stderr: string
  stdoutTimings: FfmpegStdoutIngestionTimingSummary
  workerTimings: LocalPcmWorkerTimingSummary
}

export interface LocalPcmWorkerCancelledMessage extends LocalPcmWorkerJobWireBase {
  type: 'cancelled'
  stdoutTimings: FfmpegStdoutIngestionTimingSummary
  workerTimings: LocalPcmWorkerTimingSummary
}

export interface LocalPcmWorkerProtocolErrorMessage extends LocalPcmWorkerWireBase {
  type: 'protocol-error'
  jobId: string | null
  errorMessage: string
}

export type LocalPcmWorkerResponseMessage =
  | LocalPcmWorkerReadyMessage
  | LocalPcmWorkerStartedMessage
  | LocalPcmWorkerChunkMessage
  | LocalPcmWorkerCompleteMessage
  | LocalPcmWorkerFailedMessage
  | LocalPcmWorkerCancelledMessage
  | LocalPcmWorkerProtocolErrorMessage

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value)
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key) => expectedKeys.includes(key))
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function isNonNegativeDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function isLocalPcmWorkerJobId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= LOCAL_PCM_WORKER_MAX_JOB_ID_LENGTH
}

function hasWireVersion(value: Record<string, unknown>): boolean {
  return value.version === LOCAL_PCM_WORKER_PROTOCOL_VERSION
}

export function isLocalPcmWorkerRequestMessage(
  value: unknown
): value is LocalPcmWorkerRequestMessage {
  if (!isRecord(value) || !hasWireVersion(value) || !isLocalPcmWorkerJobId(value.jobId)) {
    return false
  }

  if (value.type === 'start') {
    return hasExactKeys(value, ['type', 'version', 'jobId', 'ffmpegPath', 'args'])
      && typeof value.ffmpegPath === 'string'
      && value.ffmpegPath.length > 0
      && value.ffmpegPath.length <= LOCAL_PCM_WORKER_MAX_PATH_LENGTH
      && Array.isArray(value.args)
      && value.args.length <= LOCAL_PCM_WORKER_MAX_ARGUMENT_COUNT
      && value.args.every((argument) => (
        typeof argument === 'string' && argument.length <= LOCAL_PCM_WORKER_MAX_ARGUMENT_LENGTH
      ))
  }

  if (value.type === 'credit') {
    return hasExactKeys(value, ['type', 'version', 'jobId', 'sequence'])
      && isNonNegativeSafeInteger(value.sequence)
  }

  if (value.type === 'cancel') {
    return hasExactKeys(value, ['type', 'version', 'jobId'])
  }

  return false
}

const FFMPEG_STDOUT_TIMING_KEYS = [
  'ffmpegStdoutChunkCount',
  'ffmpegStdoutBytes',
  'ffmpegStdoutChunkMinBytes',
  'ffmpegStdoutChunkMaxBytes',
  'ffmpegStdoutDrainSpanMs',
  'ffmpegStdoutDrainToCloseMs',
  'ffmpegStdoutCallbackWorkMs',
  'ffmpegStdoutCallbackMaxMs',
  'ffmpegStdoutInterCallbackGapMs',
  'ffmpegStdoutInterCallbackGapMaxMs',
  'ffmpegStdoutPostDispatchGapCount',
  'ffmpegStdoutPostDispatchGapMs',
  'ffmpegStdoutPostDispatchGapMaxMs',
  'streamCreditAckCount',
  'streamCreditRoundTripMs',
  'streamCreditRoundTripMaxMs',
  'ffmpegStdoutCopyMs',
  'ffmpegStdoutCopyMaxMs',
  'ffmpegStdoutFlushMs',
  'ffmpegStdoutFlushMaxMs',
  'ffmpegStdoutPauseCount',
  'ffmpegStdoutPausedMs',
  'ffmpegStdoutPauseMaxMs'
] as const

const FFMPEG_STDOUT_INTEGER_KEYS = new Set<string>([
  'ffmpegStdoutChunkCount',
  'ffmpegStdoutBytes',
  'ffmpegStdoutChunkMinBytes',
  'ffmpegStdoutChunkMaxBytes',
  'ffmpegStdoutPostDispatchGapCount',
  'streamCreditAckCount',
  'ffmpegStdoutPauseCount'
])

export function isFfmpegStdoutIngestionTimingSummary(
  value: unknown
): value is FfmpegStdoutIngestionTimingSummary {
  if (!isRecord(value) || !hasExactKeys(value, FFMPEG_STDOUT_TIMING_KEYS)) return false
  for (const key of FFMPEG_STDOUT_TIMING_KEYS) {
    if (FFMPEG_STDOUT_INTEGER_KEYS.has(key)) {
      if (!isNonNegativeSafeInteger(value[key])) return false
    } else if (!isNonNegativeDuration(value[key])) {
      return false
    }
  }
  return Number(value.ffmpegStdoutChunkMinBytes) <= Number(value.ffmpegStdoutChunkMaxBytes)
    && Number(value.ffmpegStdoutChunkMaxBytes) <= Number(value.ffmpegStdoutBytes)
    && Number(value.ffmpegStdoutCallbackMaxMs) <= Number(value.ffmpegStdoutCallbackWorkMs)
    && Number(value.ffmpegStdoutInterCallbackGapMaxMs) <= Number(value.ffmpegStdoutInterCallbackGapMs)
    && Number(value.ffmpegStdoutPostDispatchGapMaxMs) <= Number(value.ffmpegStdoutPostDispatchGapMs)
    && Number(value.streamCreditRoundTripMaxMs) <= Number(value.streamCreditRoundTripMs)
    && Number(value.ffmpegStdoutCopyMaxMs) <= Number(value.ffmpegStdoutCopyMs)
    && Number(value.ffmpegStdoutFlushMaxMs) <= Number(value.ffmpegStdoutFlushMs)
    && Number(value.ffmpegStdoutPauseMaxMs) <= Number(value.ffmpegStdoutPausedMs)
}

const WORKER_TIMING_KEYS = [
  'ffmpegWorkerTotalMs',
  'ffmpegWorkerSpawnMs',
  'ffmpegWorkerFfmpegMs',
  'ffmpegWorkerSpawnToFirstPcmMs',
  'ffmpegWorkerPcmOutputSpanMs',
  'ffmpegWorkerCloseTailMs',
  'ffmpegWorkerBatchCount',
  'ffmpegWorkerBatchBytes',
  'ffmpegWorkerBatchMinBytes',
  'ffmpegWorkerBatchMaxBytes',
  'ffmpegWorkerAggregationCopyMs',
  'ffmpegWorkerAggregationCopyMaxMs',
  'ffmpegWorkerBatchCopyMs',
  'ffmpegWorkerBatchPostMs',
  'ffmpegWorkerCreditWaitCount',
  'ffmpegWorkerCreditWaitMs',
  'ffmpegWorkerCreditWaitMaxMs'
] as const

export function isLocalPcmWorkerTimingSummary(
  value: unknown
): value is LocalPcmWorkerTimingSummary {
  if (!isRecord(value) || !hasExactKeys(value, WORKER_TIMING_KEYS)) return false
  for (const key of WORKER_TIMING_KEYS) {
    if (
      key === 'ffmpegWorkerCreditWaitCount'
      || key === 'ffmpegWorkerBatchCount'
      || key === 'ffmpegWorkerBatchBytes'
      || key === 'ffmpegWorkerBatchMinBytes'
      || key === 'ffmpegWorkerBatchMaxBytes'
    ) {
      if (!isNonNegativeSafeInteger(value[key])) return false
    } else if (!isNonNegativeDuration(value[key])) {
      return false
    }
  }
  const batchCount = Number(value.ffmpegWorkerBatchCount)
  const batchBytes = Number(value.ffmpegWorkerBatchBytes)
  const batchMinBytes = Number(value.ffmpegWorkerBatchMinBytes)
  const batchMaxBytes = Number(value.ffmpegWorkerBatchMaxBytes)
  return Number(value.ffmpegWorkerCreditWaitMaxMs) <= Number(value.ffmpegWorkerCreditWaitMs)
    && Number(value.ffmpegWorkerAggregationCopyMaxMs)
      <= Number(value.ffmpegWorkerAggregationCopyMs)
    && (batchCount === 0
      ? batchBytes === 0 && batchMinBytes === 0 && batchMaxBytes === 0
      : batchBytes > 0
        && batchMinBytes > 0
        && batchMinBytes <= batchMaxBytes
        && batchMaxBytes <= LOCAL_PCM_WORKER_CHUNK_BYTES
        && batchMaxBytes <= batchBytes)
}

function hasValidTerminalTimings(value: Record<string, unknown>): boolean {
  return isFfmpegStdoutIngestionTimingSummary(value.stdoutTimings)
    && isLocalPcmWorkerTimingSummary(value.workerTimings)
}

export function isLocalPcmWorkerResponseMessage(
  value: unknown
): value is LocalPcmWorkerResponseMessage {
  if (!isRecord(value) || !hasWireVersion(value) || typeof value.type !== 'string') return false

  if (value.type === 'ready') {
    return hasExactKeys(value, ['type', 'version'])
  }

  if (value.type === 'protocol-error') {
    return hasExactKeys(value, ['type', 'version', 'jobId', 'errorMessage'])
      && (value.jobId === null || isLocalPcmWorkerJobId(value.jobId))
      && typeof value.errorMessage === 'string'
      && value.errorMessage.length > 0
  }

  if (!isLocalPcmWorkerJobId(value.jobId)) return false

  if (value.type === 'started') {
    return hasExactKeys(value, ['type', 'version', 'jobId', 'pid'])
      && isPositiveSafeInteger(value.pid)
  }

  if (value.type === 'chunk') {
    return hasExactKeys(value, [
      'type', 'version', 'jobId', 'sequence', 'byteOffset', 'byteLength', 'payload'
    ])
      && isNonNegativeSafeInteger(value.sequence)
      && isNonNegativeSafeInteger(value.byteOffset)
      && isPositiveSafeInteger(value.byteLength)
      && value.byteLength <= LOCAL_PCM_WORKER_CHUNK_BYTES
      && value.payload instanceof ArrayBuffer
      && value.payload.byteLength === value.byteLength
      && value.byteOffset + value.byteLength <= LOCAL_PCM_WORKER_MAX_BYTES
  }

  if (value.type === 'complete') {
    if (!hasExactKeys(value, [
      'type', 'version', 'jobId', 'pcmByteLength', 'chunkCount', 'stdoutTimings', 'workerTimings'
    ])) return false
    if (
      !isPositiveSafeInteger(value.pcmByteLength)
      || value.pcmByteLength > LOCAL_PCM_WORKER_MAX_BYTES
      || !isPositiveSafeInteger(value.chunkCount)
      || !isFfmpegStdoutIngestionTimingSummary(value.stdoutTimings)
      || !isLocalPcmWorkerTimingSummary(value.workerTimings)
    ) return false
    return value.stdoutTimings.ffmpegStdoutBytes === value.pcmByteLength
      && value.workerTimings.ffmpegWorkerBatchBytes === value.pcmByteLength
      && value.workerTimings.ffmpegWorkerBatchCount === value.chunkCount
  }

  if (value.type === 'failed') {
    return hasExactKeys(value, [
      'type', 'version', 'jobId', 'failureKind', 'errorMessage', 'stderr',
      'stdoutTimings', 'workerTimings'
    ])
      && ['spawn', 'decode', 'stdout', 'limit', 'protocol'].includes(String(value.failureKind))
      && typeof value.errorMessage === 'string'
      && value.errorMessage.length > 0
      && typeof value.stderr === 'string'
      && Buffer.byteLength(value.stderr, 'utf8') <= LOCAL_PCM_WORKER_MAX_STDERR_BYTES
      && hasValidTerminalTimings(value)
  }

  if (value.type === 'cancelled') {
    return hasExactKeys(value, [
      'type', 'version', 'jobId', 'stdoutTimings', 'workerTimings'
    ]) && hasValidTerminalTimings(value)
  }

  return false
}

export function localPcmWorkerProtocolJobId(value: unknown): string | null {
  if (!isRecord(value)) return null
  return isLocalPcmWorkerJobId(value.jobId) ? value.jobId : null
}
