export const LOCAL_PCM_STREAM_VERSION = 1 as const
export const LOCAL_PCM_STREAM_MARKER = 'astra:local-audio-pcm-stream-port' as const

const MEBIBYTE = 1024 * 1024

export const LOCAL_PCM_STREAM_CHUNK_BYTES = 8 * MEBIBYTE
export const LOCAL_PCM_STREAM_INITIAL_CREDITS = 2
export const LOCAL_PCM_STREAM_MAX_CREDITS = 2
export const LOCAL_PCM_STREAM_MAX_BYTES = 192 * MEBIBYTE

export type LocalPcmStreamPriority = 'interactive' | 'background'

export interface LocalPcmStreamOpenRequest {
  requestId: number
  filePath: string
  outputSampleRate: number
  expectedChannels: number | null
  priority: LocalPcmStreamPriority
  nonce: string
}

interface LocalPcmStreamWireBase {
  version: typeof LOCAL_PCM_STREAM_VERSION
  requestId: number
  nonce: string
}

export interface LocalPcmStreamPortEnvelope extends LocalPcmStreamWireBase {
  marker: typeof LOCAL_PCM_STREAM_MARKER
}

export interface LocalPcmStreamReadyMessage extends LocalPcmStreamWireBase {
  type: 'ready'
  credits: typeof LOCAL_PCM_STREAM_INITIAL_CREDITS
}

export interface LocalPcmStreamCreditMessage extends LocalPcmStreamWireBase {
  type: 'credit'
  /** Exact sequence number of the chunk whose renderer copy has completed. */
  sequence: number
  credits: 1
}

export interface LocalPcmStreamCancelMessage extends LocalPcmStreamWireBase {
  type: 'cancel'
}

export type LocalPcmStreamRendererMessage =
  | LocalPcmStreamReadyMessage
  | LocalPcmStreamCreditMessage
  | LocalPcmStreamCancelMessage

export interface LocalPcmStreamAcceptedMessage extends LocalPcmStreamWireBase {
  type: 'accepted'
}

export interface LocalPcmStreamStartMessage extends LocalPcmStreamWireBase {
  type: 'start'
  sampleRate: number
  channels: number
  /** Initial renderer allocation; a later resize message may increase it. */
  backingBufferBytes: number
}

export interface LocalPcmStreamResizeMessage extends LocalPcmStreamWireBase {
  type: 'resize'
  backingBufferBytes: number
}

export interface LocalPcmStreamChunkMessage extends LocalPcmStreamWireBase {
  type: 'chunk'
  sequence: number
  byteOffset: number
  byteLength: number
  payload: ArrayBuffer
}

/** Main-process timings that remain meaningful for a streamed result. */
export interface LocalPcmStreamMainTransportTimings {
  decodeRequestId: number
  validPcmBytes: number
  backingBufferBytes: number
  allocationGrowthCount: number
  transportRoute: 'message_port_stream'
  mainHandlerMs: number
  binaryResolutionMs: number
  probeMs: number
  probeCacheStatus?: 'hit' | 'miss' | 'bypass'
  probeDecodeOverlapEnabled?: boolean
  probeFfmpegOverlapMs?: number
  /** FFmpeg child spawn-to-close wall time, not decoder CPU time. */
  ffmpegMs: number
  ffmpegOutputSink?: 'stdout_pipe' | 'rechunked_pipe' | 'native_pipe' | 'preload_native' | 'worker_thread' | 'temporary_file'
  tempPcmCreateMs?: number
  tempPcmStatMs?: number
  tempPcmReadMs?: number
  tempPcmReadChunkCount?: number
  tempPcmBytes?: number
  tempPcmCleanupMs?: number
  tempPcmCleanupSucceeded?: boolean
  ffmpegWorkerStartupMs?: number
  ffmpegWorkerTotalMs?: number
  ffmpegWorkerSpawnMs?: number
  ffmpegWorkerFfmpegMs?: number
  ffmpegWorkerSpawnToFirstPcmMs?: number
  ffmpegWorkerPcmOutputSpanMs?: number
  ffmpegWorkerCloseTailMs?: number
  ffmpegWorkerRequestMs?: number
  ffmpegWorkerMainDeliverySpanMs?: number
  ffmpegWorkerBatchCount?: number
  ffmpegWorkerBatchBytes?: number
  ffmpegWorkerBatchMinBytes?: number
  ffmpegWorkerBatchMaxBytes?: number
  ffmpegWorkerAggregationCopyMs?: number
  ffmpegWorkerAggregationCopyMaxMs?: number
  ffmpegWorkerBatchCopyMs?: number
  ffmpegWorkerBatchPostMs?: number
  ffmpegWorkerMainCopyMs?: number
  ffmpegWorkerMainCopyMaxMs?: number
  ffmpegWorkerCreditWaitCount?: number
  ffmpegWorkerCreditWaitMs?: number
  ffmpegWorkerCreditWaitMaxMs?: number
  nativePcmCaptureSpawnMs?: number
  nativePcmCaptureProcessMs?: number
  nativePcmCaptureFirstByteMs?: number
  nativePcmCaptureStdoutReadSpanMs?: number
  nativePcmCaptureStdoutReadCount?: number
  nativePcmCaptureStdoutReadMinBytes?: number
  nativePcmCaptureStdoutReadMaxBytes?: number
  nativePcmCaptureOutputBytes?: number
  nativePcmCaptureRequestedPipeBufferBytes?: number
  nativePcmCaptureEffectivePipeBufferBytes?: number
  nativePcmCaptureBufferCopyMs?: number
  nativePcmCaptureUsedExternalBuffer?: boolean
  nativePcmCaptureDeliveryMode?: 'complete_buffer' | 'progress_batches'
  nativePcmCaptureBatchTargetBytes?: number
  nativePcmCaptureBatchCount?: number
  nativePcmCaptureBatchBytes?: number
  nativePcmCaptureBatchMinBytes?: number
  nativePcmCaptureBatchMaxBytes?: number
  nativePcmCaptureBatchCreditWaitCount?: number
  nativePcmCaptureBatchCreditWaitMs?: number
  nativePcmCaptureBatchCreditWaitMaxMs?: number
  nativePcmCaptureBatchCopyMs?: number
  nativePcmCaptureBatchCopyMaxMs?: number
  nativePcmCaptureBatchCallbackMs?: number
  nativePcmCaptureBatchCallbackMaxMs?: number
  nativePcmCaptureMainCopyMs?: number
  nativePcmCaptureMainCopyMaxMs?: number
  nativePcmCaptureFirstBatchMs?: number
  nativePcmCaptureMainBatchSpanMs?: number
  ffmpegSpawnToFirstPcmMs?: number
  ffmpegPcmOutputSpanMs?: number
  ffmpegCloseTailMs?: number
  ffmpegStdoutChunkCount?: number
  ffmpegStdoutBytes?: number
  ffmpegStdoutChunkMinBytes?: number
  ffmpegStdoutChunkMaxBytes?: number
  ffmpegStdoutDrainSpanMs?: number
  ffmpegStdoutDrainToCloseMs?: number
  ffmpegStdoutCallbackWorkMs?: number
  ffmpegStdoutCallbackMaxMs?: number
  ffmpegStdoutInterCallbackGapMs?: number
  ffmpegStdoutInterCallbackGapMaxMs?: number
  ffmpegStdoutPostDispatchGapCount?: number
  ffmpegStdoutPostDispatchGapMs?: number
  ffmpegStdoutPostDispatchGapMaxMs?: number
  ffmpegStdoutCopyMs?: number
  ffmpegStdoutCopyMaxMs?: number
  ffmpegStdoutFlushMs?: number
  ffmpegStdoutFlushMaxMs?: number
  ffmpegStdoutPauseCount?: number
  ffmpegStdoutPausedMs?: number
  ffmpegStdoutPauseMaxMs?: number
  allocationMs: number
  initialAllocationMs: number
  growthAllocationMs: number
  payloadFinalizationMs: number
  /** Compatibility field; always zero because this route does not invoke. */
  preloadInvokeMs: 0
  streamChunkCount: number
  streamDispatchCopyMs: number
  streamDispatchPostMs: number
  streamCreditAckCount?: number
  streamCreditRoundTripMs?: number
  streamCreditRoundTripMaxMs?: number
  streamTailMs: number
  /** Diagnostics-only synthetic stream generation work. */
  benchmarkMainGenerationMs?: number
  /** Diagnostics-only subset spent filling synthetic bytes and sentinels. */
  benchmarkMainFillMs?: number
}

export interface LocalPcmStreamCompleteMessage extends LocalPcmStreamWireBase {
  type: 'complete'
  frames: number
  pcmByteLength: number
  probeMs: number
  decodeMs: number
  backgroundPriorityApplied: boolean
  chunkCount: number
  transportTimings: LocalPcmStreamMainTransportTimings
}

export interface LocalPcmStreamCancelledMessage extends LocalPcmStreamWireBase {
  type: 'cancelled'
}

export type LocalPcmStreamErrorKind = 'decode' | 'transport'

export interface LocalPcmStreamErrorMessage extends LocalPcmStreamWireBase {
  type: 'error'
  kind: LocalPcmStreamErrorKind
  code: string
  message: string
}

export type LocalPcmStreamMainMessage =
  | LocalPcmStreamAcceptedMessage
  | LocalPcmStreamStartMessage
  | LocalPcmStreamResizeMessage
  | LocalPcmStreamChunkMessage
  | LocalPcmStreamCompleteMessage
  | LocalPcmStreamCancelledMessage
  | LocalPcmStreamErrorMessage

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function optionalNumberLessThanOrEqual(left: unknown, right: unknown): boolean {
  return left === undefined
    || right === undefined
    || (typeof left === 'number' && typeof right === 'number' && left <= right)
}

function isValidNonce(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value)
}

function hasValidWireBase(value: Record<string, unknown>): boolean {
  return value.version === LOCAL_PCM_STREAM_VERSION
    && isNonNegativeSafeInteger(value.requestId)
    && isValidNonce(value.nonce)
}

function isValidSampleRate(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 8_000
    && value <= 384_000
}

function isValidChannelCount(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 1
    && value <= 8
}

function isValidBackingBufferBytes(value: unknown): value is number {
  return isPositiveSafeInteger(value) && value <= LOCAL_PCM_STREAM_MAX_BYTES
}

export function validateLocalPcmStreamOpenRequest(
  value: unknown,
): value is LocalPcmStreamOpenRequest {
  if (!isRecord(value)) return false
  if (!isNonNegativeSafeInteger(value.requestId)) return false
  if (
    typeof value.filePath !== 'string'
    || value.filePath.trim().length === 0
    || value.filePath.length > 32_768
    || value.filePath.includes('\0')
  ) return false
  if (!isValidSampleRate(value.outputSampleRate)) return false
  if (value.expectedChannels !== null && !isValidChannelCount(value.expectedChannels)) return false
  if (value.priority !== 'interactive' && value.priority !== 'background') return false
  return isValidNonce(value.nonce)
}

export function isLocalPcmStreamPortEnvelope(
  value: unknown,
): value is LocalPcmStreamPortEnvelope {
  return isRecord(value)
    && hasValidWireBase(value)
    && value.marker === LOCAL_PCM_STREAM_MARKER
}

export function isLocalPcmStreamRendererMessage(
  value: unknown,
): value is LocalPcmStreamRendererMessage {
  if (!isRecord(value) || !hasValidWireBase(value)) return false
  switch (value.type) {
    case 'ready':
      return value.credits === LOCAL_PCM_STREAM_INITIAL_CREDITS
    case 'credit':
      return isNonNegativeSafeInteger(value.sequence) && value.credits === 1
    case 'cancel':
      return true
    default:
      return false
  }
}

function isLocalPcmStreamMainTransportTimings(
  value: unknown,
): value is LocalPcmStreamMainTransportTimings {
  if (!isRecord(value)) return false
  return isNonNegativeSafeInteger(value.decodeRequestId)
    && isNonNegativeSafeInteger(value.validPcmBytes)
    && isNonNegativeSafeInteger(value.backingBufferBytes)
    && isNonNegativeSafeInteger(value.allocationGrowthCount)
    && value.transportRoute === 'message_port_stream'
    && isNonNegativeDuration(value.mainHandlerMs)
    && isNonNegativeDuration(value.binaryResolutionMs)
    && isNonNegativeDuration(value.probeMs)
    && (value.probeCacheStatus === undefined
      || value.probeCacheStatus === 'hit'
      || value.probeCacheStatus === 'miss'
      || value.probeCacheStatus === 'bypass')
    && (value.probeDecodeOverlapEnabled === undefined
      || typeof value.probeDecodeOverlapEnabled === 'boolean')
    && (value.probeFfmpegOverlapMs === undefined
      || isNonNegativeDuration(value.probeFfmpegOverlapMs))
    && isNonNegativeDuration(value.ffmpegMs)
    && (value.ffmpegOutputSink === undefined
      || value.ffmpegOutputSink === 'stdout_pipe'
      || value.ffmpegOutputSink === 'rechunked_pipe'
      || value.ffmpegOutputSink === 'native_pipe'
      || value.ffmpegOutputSink === 'preload_native'
      || value.ffmpegOutputSink === 'worker_thread'
      || value.ffmpegOutputSink === 'temporary_file')
    && (value.tempPcmCreateMs === undefined
      || isNonNegativeDuration(value.tempPcmCreateMs))
    && (value.tempPcmStatMs === undefined
      || isNonNegativeDuration(value.tempPcmStatMs))
    && (value.tempPcmReadMs === undefined
      || isNonNegativeDuration(value.tempPcmReadMs))
    && (value.tempPcmReadChunkCount === undefined
      || isNonNegativeSafeInteger(value.tempPcmReadChunkCount))
    && (value.tempPcmBytes === undefined
      || isNonNegativeSafeInteger(value.tempPcmBytes))
    && (value.tempPcmCleanupMs === undefined
      || isNonNegativeDuration(value.tempPcmCleanupMs))
    && (value.tempPcmCleanupSucceeded === undefined
      || typeof value.tempPcmCleanupSucceeded === 'boolean')
    && (value.ffmpegWorkerStartupMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerStartupMs))
    && (value.ffmpegWorkerTotalMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerTotalMs))
    && (value.ffmpegWorkerSpawnMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerSpawnMs))
    && (value.ffmpegWorkerFfmpegMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerFfmpegMs))
    && optionalNumberLessThanOrEqual(
      value.ffmpegWorkerFfmpegMs,
      value.ffmpegWorkerTotalMs
    )
    && (value.ffmpegWorkerSpawnToFirstPcmMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerSpawnToFirstPcmMs))
    && (value.ffmpegWorkerPcmOutputSpanMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerPcmOutputSpanMs))
    && (value.ffmpegWorkerCloseTailMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerCloseTailMs))
    && (value.ffmpegWorkerRequestMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerRequestMs))
    && (value.ffmpegWorkerMainDeliverySpanMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerMainDeliverySpanMs))
    && optionalNumberLessThanOrEqual(
      value.ffmpegWorkerMainDeliverySpanMs,
      value.ffmpegWorkerRequestMs
    )
    && (value.ffmpegWorkerBatchCount === undefined
      || isNonNegativeSafeInteger(value.ffmpegWorkerBatchCount))
    && (value.ffmpegWorkerBatchBytes === undefined
      || isNonNegativeSafeInteger(value.ffmpegWorkerBatchBytes))
    && (value.ffmpegWorkerBatchMinBytes === undefined
      || isPositiveSafeInteger(value.ffmpegWorkerBatchMinBytes))
    && (value.ffmpegWorkerBatchMaxBytes === undefined
      || isPositiveSafeInteger(value.ffmpegWorkerBatchMaxBytes))
    && optionalNumberLessThanOrEqual(
      value.ffmpegWorkerBatchMinBytes,
      value.ffmpegWorkerBatchMaxBytes
    )
    && optionalNumberLessThanOrEqual(
      value.ffmpegWorkerBatchMaxBytes,
      value.ffmpegWorkerBatchBytes
    )
    && (value.ffmpegWorkerAggregationCopyMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerAggregationCopyMs))
    && (value.ffmpegWorkerAggregationCopyMaxMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerAggregationCopyMaxMs))
    && optionalNumberLessThanOrEqual(
      value.ffmpegWorkerAggregationCopyMaxMs,
      value.ffmpegWorkerAggregationCopyMs
    )
    && (value.ffmpegWorkerBatchCopyMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerBatchCopyMs))
    && (value.ffmpegWorkerBatchPostMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerBatchPostMs))
    && (value.ffmpegWorkerMainCopyMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerMainCopyMs))
    && (value.ffmpegWorkerMainCopyMaxMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerMainCopyMaxMs))
    && optionalNumberLessThanOrEqual(
      value.ffmpegWorkerMainCopyMaxMs,
      value.ffmpegWorkerMainCopyMs
    )
    && (value.ffmpegWorkerCreditWaitCount === undefined
      || isNonNegativeSafeInteger(value.ffmpegWorkerCreditWaitCount))
    && (value.ffmpegWorkerCreditWaitMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerCreditWaitMs))
    && (value.ffmpegWorkerCreditWaitMaxMs === undefined
      || isNonNegativeDuration(value.ffmpegWorkerCreditWaitMaxMs))
    && optionalNumberLessThanOrEqual(
      value.ffmpegWorkerCreditWaitMaxMs,
      value.ffmpegWorkerCreditWaitMs
    )
    && (value.nativePcmCaptureSpawnMs === undefined
      || isNonNegativeDuration(value.nativePcmCaptureSpawnMs))
    && (value.nativePcmCaptureProcessMs === undefined
      || isNonNegativeDuration(value.nativePcmCaptureProcessMs))
    && optionalNumberLessThanOrEqual(
      value.nativePcmCaptureSpawnMs,
      value.nativePcmCaptureProcessMs
    )
    && (value.nativePcmCaptureFirstByteMs === undefined
      || isNonNegativeDuration(value.nativePcmCaptureFirstByteMs))
    && optionalNumberLessThanOrEqual(
      value.nativePcmCaptureFirstByteMs,
      value.nativePcmCaptureProcessMs
    )
    && (value.nativePcmCaptureStdoutReadSpanMs === undefined
      || isNonNegativeDuration(value.nativePcmCaptureStdoutReadSpanMs))
    && (value.nativePcmCaptureStdoutReadCount === undefined
      || isNonNegativeSafeInteger(value.nativePcmCaptureStdoutReadCount))
    && (value.nativePcmCaptureStdoutReadMinBytes === undefined
      || isPositiveSafeInteger(value.nativePcmCaptureStdoutReadMinBytes))
    && (value.nativePcmCaptureStdoutReadMaxBytes === undefined
      || isPositiveSafeInteger(value.nativePcmCaptureStdoutReadMaxBytes))
    && optionalNumberLessThanOrEqual(
      value.nativePcmCaptureStdoutReadMinBytes,
      value.nativePcmCaptureStdoutReadMaxBytes
    )
    && (value.nativePcmCaptureOutputBytes === undefined
      || isNonNegativeSafeInteger(value.nativePcmCaptureOutputBytes))
    && optionalNumberLessThanOrEqual(
      value.nativePcmCaptureStdoutReadMaxBytes,
      value.nativePcmCaptureOutputBytes
    )
    && (value.nativePcmCaptureRequestedPipeBufferBytes === undefined
      || isPositiveSafeInteger(value.nativePcmCaptureRequestedPipeBufferBytes))
    && (value.nativePcmCaptureEffectivePipeBufferBytes === undefined
      || isPositiveSafeInteger(value.nativePcmCaptureEffectivePipeBufferBytes))
    && (value.nativePcmCaptureBufferCopyMs === undefined
      || isNonNegativeDuration(value.nativePcmCaptureBufferCopyMs))
    && (value.nativePcmCaptureUsedExternalBuffer === undefined
      || typeof value.nativePcmCaptureUsedExternalBuffer === 'boolean')
    && (value.nativePcmCaptureUsedExternalBuffer !== true
      || value.nativePcmCaptureBufferCopyMs === undefined
      || value.nativePcmCaptureBufferCopyMs === 0)
    && (value.nativePcmCaptureDeliveryMode === undefined
      || value.nativePcmCaptureDeliveryMode === 'complete_buffer'
      || value.nativePcmCaptureDeliveryMode === 'progress_batches')
    && (value.nativePcmCaptureBatchTargetBytes === undefined
      || value.nativePcmCaptureBatchTargetBytes === LOCAL_PCM_STREAM_CHUNK_BYTES)
    && (value.nativePcmCaptureBatchCount === undefined
      || isNonNegativeSafeInteger(value.nativePcmCaptureBatchCount))
    && (value.nativePcmCaptureBatchBytes === undefined
      || isNonNegativeSafeInteger(value.nativePcmCaptureBatchBytes))
    && (value.nativePcmCaptureBatchMinBytes === undefined
      || isPositiveSafeInteger(value.nativePcmCaptureBatchMinBytes))
    && (value.nativePcmCaptureBatchMaxBytes === undefined
      || isPositiveSafeInteger(value.nativePcmCaptureBatchMaxBytes))
    && optionalNumberLessThanOrEqual(
      value.nativePcmCaptureBatchMinBytes,
      value.nativePcmCaptureBatchMaxBytes
    )
    && optionalNumberLessThanOrEqual(
      value.nativePcmCaptureBatchMaxBytes,
      value.nativePcmCaptureBatchTargetBytes
    )
    && optionalNumberLessThanOrEqual(
      value.nativePcmCaptureBatchBytes,
      value.nativePcmCaptureOutputBytes
    )
    && (value.nativePcmCaptureBatchCreditWaitCount === undefined
      || isNonNegativeSafeInteger(value.nativePcmCaptureBatchCreditWaitCount))
    && optionalNumberLessThanOrEqual(
      value.nativePcmCaptureBatchCreditWaitCount,
      value.nativePcmCaptureBatchCount
    )
    && (value.nativePcmCaptureBatchCreditWaitMs === undefined
      || isNonNegativeDuration(value.nativePcmCaptureBatchCreditWaitMs))
    && (value.nativePcmCaptureBatchCreditWaitMaxMs === undefined
      || isNonNegativeDuration(value.nativePcmCaptureBatchCreditWaitMaxMs))
    && optionalNumberLessThanOrEqual(
      value.nativePcmCaptureBatchCreditWaitMaxMs,
      value.nativePcmCaptureBatchCreditWaitMs
    )
    && (value.nativePcmCaptureBatchCopyMs === undefined
      || isNonNegativeDuration(value.nativePcmCaptureBatchCopyMs))
    && (value.nativePcmCaptureBatchCopyMaxMs === undefined
      || isNonNegativeDuration(value.nativePcmCaptureBatchCopyMaxMs))
    && optionalNumberLessThanOrEqual(
      value.nativePcmCaptureBatchCopyMaxMs,
      value.nativePcmCaptureBatchCopyMs
    )
    && (value.nativePcmCaptureBatchCallbackMs === undefined
      || isNonNegativeDuration(value.nativePcmCaptureBatchCallbackMs))
    && (value.nativePcmCaptureBatchCallbackMaxMs === undefined
      || isNonNegativeDuration(value.nativePcmCaptureBatchCallbackMaxMs))
    && optionalNumberLessThanOrEqual(
      value.nativePcmCaptureBatchCallbackMaxMs,
      value.nativePcmCaptureBatchCallbackMs
    )
    && (value.nativePcmCaptureMainCopyMs === undefined
      || isNonNegativeDuration(value.nativePcmCaptureMainCopyMs))
    && (value.nativePcmCaptureMainCopyMaxMs === undefined
      || isNonNegativeDuration(value.nativePcmCaptureMainCopyMaxMs))
    && optionalNumberLessThanOrEqual(
      value.nativePcmCaptureMainCopyMaxMs,
      value.nativePcmCaptureMainCopyMs
    )
    && (value.nativePcmCaptureFirstBatchMs === undefined
      || isNonNegativeDuration(value.nativePcmCaptureFirstBatchMs))
    && (value.nativePcmCaptureMainBatchSpanMs === undefined
      || isNonNegativeDuration(value.nativePcmCaptureMainBatchSpanMs))
    && (value.nativePcmCaptureDeliveryMode !== 'complete_buffer'
      || (
        value.nativePcmCaptureBatchCount === 0
        && value.nativePcmCaptureBatchBytes === 0
      ))
    && (value.nativePcmCaptureDeliveryMode !== 'progress_batches'
      || (
        isPositiveSafeInteger(value.nativePcmCaptureBatchCount)
        && value.nativePcmCaptureBatchBytes === value.nativePcmCaptureOutputBytes
      ))
    && (value.ffmpegSpawnToFirstPcmMs === undefined
      || isNonNegativeDuration(value.ffmpegSpawnToFirstPcmMs))
    && (value.ffmpegPcmOutputSpanMs === undefined
      || isNonNegativeDuration(value.ffmpegPcmOutputSpanMs))
    && (value.ffmpegCloseTailMs === undefined
      || isNonNegativeDuration(value.ffmpegCloseTailMs))
    && (value.ffmpegStdoutChunkCount === undefined
      || isNonNegativeSafeInteger(value.ffmpegStdoutChunkCount))
    && (value.ffmpegStdoutBytes === undefined
      || isNonNegativeSafeInteger(value.ffmpegStdoutBytes))
    && (value.ffmpegStdoutChunkMinBytes === undefined
      || isPositiveSafeInteger(value.ffmpegStdoutChunkMinBytes))
    && (value.ffmpegStdoutChunkMaxBytes === undefined
      || isPositiveSafeInteger(value.ffmpegStdoutChunkMaxBytes))
    && optionalNumberLessThanOrEqual(
      value.ffmpegStdoutChunkMinBytes,
      value.ffmpegStdoutChunkMaxBytes
    )
    && optionalNumberLessThanOrEqual(value.ffmpegStdoutChunkMaxBytes, value.ffmpegStdoutBytes)
    && (value.ffmpegStdoutDrainSpanMs === undefined
      || isNonNegativeDuration(value.ffmpegStdoutDrainSpanMs))
    && (value.ffmpegStdoutDrainToCloseMs === undefined
      || isNonNegativeDuration(value.ffmpegStdoutDrainToCloseMs))
    && (value.ffmpegStdoutCallbackWorkMs === undefined
      || isNonNegativeDuration(value.ffmpegStdoutCallbackWorkMs))
    && (value.ffmpegStdoutCallbackMaxMs === undefined
      || isNonNegativeDuration(value.ffmpegStdoutCallbackMaxMs))
    && optionalNumberLessThanOrEqual(
      value.ffmpegStdoutCallbackMaxMs,
      value.ffmpegStdoutCallbackWorkMs
    )
    && (value.ffmpegStdoutInterCallbackGapMs === undefined
      || isNonNegativeDuration(value.ffmpegStdoutInterCallbackGapMs))
    && (value.ffmpegStdoutInterCallbackGapMaxMs === undefined
      || isNonNegativeDuration(value.ffmpegStdoutInterCallbackGapMaxMs))
    && optionalNumberLessThanOrEqual(
      value.ffmpegStdoutInterCallbackGapMaxMs,
      value.ffmpegStdoutInterCallbackGapMs
    )
    && (value.ffmpegStdoutPostDispatchGapCount === undefined
      || isNonNegativeSafeInteger(value.ffmpegStdoutPostDispatchGapCount))
    && (value.ffmpegStdoutPostDispatchGapMs === undefined
      || isNonNegativeDuration(value.ffmpegStdoutPostDispatchGapMs))
    && (value.ffmpegStdoutPostDispatchGapMaxMs === undefined
      || isNonNegativeDuration(value.ffmpegStdoutPostDispatchGapMaxMs))
    && optionalNumberLessThanOrEqual(
      value.ffmpegStdoutPostDispatchGapMaxMs,
      value.ffmpegStdoutPostDispatchGapMs
    )
    && (value.ffmpegStdoutCopyMs === undefined
      || isNonNegativeDuration(value.ffmpegStdoutCopyMs))
    && (value.ffmpegStdoutCopyMaxMs === undefined
      || isNonNegativeDuration(value.ffmpegStdoutCopyMaxMs))
    && optionalNumberLessThanOrEqual(value.ffmpegStdoutCopyMaxMs, value.ffmpegStdoutCopyMs)
    && (value.ffmpegStdoutFlushMs === undefined
      || isNonNegativeDuration(value.ffmpegStdoutFlushMs))
    && (value.ffmpegStdoutFlushMaxMs === undefined
      || isNonNegativeDuration(value.ffmpegStdoutFlushMaxMs))
    && optionalNumberLessThanOrEqual(value.ffmpegStdoutFlushMaxMs, value.ffmpegStdoutFlushMs)
    && (value.ffmpegStdoutPauseCount === undefined
      || isNonNegativeSafeInteger(value.ffmpegStdoutPauseCount))
    && (value.ffmpegStdoutPausedMs === undefined
      || isNonNegativeDuration(value.ffmpegStdoutPausedMs))
    && (value.ffmpegStdoutPauseMaxMs === undefined
      || isNonNegativeDuration(value.ffmpegStdoutPauseMaxMs))
    && optionalNumberLessThanOrEqual(value.ffmpegStdoutPauseMaxMs, value.ffmpegStdoutPausedMs)
    && isNonNegativeDuration(value.allocationMs)
    && isNonNegativeDuration(value.initialAllocationMs)
    && isNonNegativeDuration(value.growthAllocationMs)
    && isNonNegativeDuration(value.payloadFinalizationMs)
    && value.preloadInvokeMs === 0
    && isNonNegativeSafeInteger(value.streamChunkCount)
    && isNonNegativeDuration(value.streamDispatchCopyMs)
    && isNonNegativeDuration(value.streamDispatchPostMs)
    && (value.streamCreditAckCount === undefined
      || isNonNegativeSafeInteger(value.streamCreditAckCount))
    && (value.streamCreditRoundTripMs === undefined
      || isNonNegativeDuration(value.streamCreditRoundTripMs))
    && (value.streamCreditRoundTripMaxMs === undefined
      || isNonNegativeDuration(value.streamCreditRoundTripMaxMs))
    && optionalNumberLessThanOrEqual(
      value.streamCreditRoundTripMaxMs,
      value.streamCreditRoundTripMs
    )
    && isNonNegativeDuration(value.streamTailMs)
    && (value.benchmarkMainGenerationMs === undefined
      || isNonNegativeDuration(value.benchmarkMainGenerationMs))
    && (value.benchmarkMainFillMs === undefined
      || isNonNegativeDuration(value.benchmarkMainFillMs))
}

export function isLocalPcmStreamMainMessage(
  value: unknown,
): value is LocalPcmStreamMainMessage {
  if (!isRecord(value) || !hasValidWireBase(value)) return false
  switch (value.type) {
    case 'accepted':
    case 'cancelled':
      return true
    case 'start':
      return isValidSampleRate(value.sampleRate)
        && isValidChannelCount(value.channels)
        && isValidBackingBufferBytes(value.backingBufferBytes)
    case 'resize':
      return isValidBackingBufferBytes(value.backingBufferBytes)
    case 'chunk':
      return isNonNegativeSafeInteger(value.sequence)
        && isNonNegativeSafeInteger(value.byteOffset)
        && isPositiveSafeInteger(value.byteLength)
        && value.byteLength <= LOCAL_PCM_STREAM_CHUNK_BYTES
        && value.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0
        && value.byteLength % Float32Array.BYTES_PER_ELEMENT === 0
        && value.payload instanceof ArrayBuffer
        && value.payload.byteLength === value.byteLength
        && value.byteOffset + value.byteLength <= LOCAL_PCM_STREAM_MAX_BYTES
    case 'complete': {
      if (!isPositiveSafeInteger(value.frames)) return false
      if (
        !isPositiveSafeInteger(value.pcmByteLength)
        || value.pcmByteLength > LOCAL_PCM_STREAM_MAX_BYTES
        || !isNonNegativeDuration(value.probeMs)
        || !isNonNegativeDuration(value.decodeMs)
        || typeof value.backgroundPriorityApplied !== 'boolean'
        || !isPositiveSafeInteger(value.chunkCount)
        || !isLocalPcmStreamMainTransportTimings(value.transportTimings)
      ) return false
      return value.transportTimings.decodeRequestId === value.requestId
        && value.transportTimings.validPcmBytes === value.pcmByteLength
        && (value.transportTimings.ffmpegStdoutBytes === undefined
          || value.transportTimings.ffmpegStdoutBytes === value.pcmByteLength)
        && (value.transportTimings.ffmpegWorkerBatchBytes === undefined
          || value.transportTimings.ffmpegWorkerBatchBytes === value.pcmByteLength)
        && (value.transportTimings.nativePcmCaptureOutputBytes === undefined
          || value.transportTimings.nativePcmCaptureOutputBytes === value.pcmByteLength)
        && (value.transportTimings.ffmpegStdoutPostDispatchGapCount === undefined
          || value.transportTimings.ffmpegStdoutPostDispatchGapCount <= value.chunkCount)
        && (value.transportTimings.streamCreditAckCount === undefined
          || value.transportTimings.streamCreditAckCount <= value.chunkCount)
        && value.transportTimings.backingBufferBytes >= value.pcmByteLength
        && value.transportTimings.backingBufferBytes <= LOCAL_PCM_STREAM_MAX_BYTES
        && value.transportTimings.streamChunkCount === value.chunkCount
        && value.transportTimings.probeMs === value.probeMs
        && value.transportTimings.ffmpegMs === value.decodeMs
    }
    case 'error':
      return (value.kind === 'decode' || value.kind === 'transport')
        && typeof value.code === 'string'
        && value.code.length > 0
        && value.code.length <= 128
        && typeof value.message === 'string'
        && value.message.length > 0
        && value.message.length <= 4_096
    default:
      return false
  }
}
