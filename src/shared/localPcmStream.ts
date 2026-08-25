export const LOCAL_PCM_STREAM_VERSION = 1 as const
export const LOCAL_PCM_STREAM_MARKER = 'astra:local-audio-pcm-stream-port' as const
export const LOCAL_PCM_DECODE_LIMIT_EXCEEDED_CODE = 'PCM_DECODE_LIMIT_EXCEEDED' as const

const MEBIBYTE = 1024 * 1024

export const LOCAL_PCM_STREAM_CHUNK_BYTES = 8 * MEBIBYTE
export const LOCAL_PCM_STREAM_INITIAL_CREDITS = 2
export const LOCAL_PCM_STREAM_MAX_CREDITS = 2
export const LOCAL_PCM_STREAM_MAX_BYTES = 192 * MEBIBYTE
export const LOCAL_PCM_WAVEFORM_RESOLUTION = 512
export const LOCAL_PCM_WAVEFORM_BYTES = LOCAL_PCM_WAVEFORM_RESOLUTION * Float32Array.BYTES_PER_ELEMENT
export const STATIC_TRACK_WAVEFORM_RESULT_VERSION = 1 as const
export const STATIC_TRACK_WAVEFORM_RESULT_IPC_CHANNEL = 'audio:staticTrackWaveformResult' as const

export type LocalPcmStreamPriority = 'interactive' | 'background'

interface StaticTrackWaveformResultBase {
  version: typeof STATIC_TRACK_WAVEFORM_RESULT_VERSION
  requestId: number
  trackPath: string
  waveformAnalysisMs: number
}

export interface StaticTrackWaveformReadyResult extends StaticTrackWaveformResultBase {
  status: 'ready'
  waveformData: ArrayBuffer
}

export interface StaticTrackWaveformFailedResult extends StaticTrackWaveformResultBase {
  status: 'failed'
  failureKind: 'unavailable' | 'analysis_failed'
}

export type StaticTrackWaveformResult =
  | StaticTrackWaveformReadyResult
  | StaticTrackWaveformFailedResult

export interface LocalPcmDecodeLimitRefusal {
  refused: true
  code: typeof LOCAL_PCM_DECODE_LIMIT_EXCEEDED_CODE
  message: string
}

export function isLocalPcmDecodeLimitRefusal(value: unknown): value is LocalPcmDecodeLimitRefusal {
  return isRecord(value)
    && value.refused === true
    && value.code === LOCAL_PCM_DECODE_LIMIT_EXCEEDED_CODE
    && typeof value.message === 'string'
    && value.message.length > 0
    && value.message.length <= 4_096
}

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
  ffmpegMs: number
  allocationMs: number
  initialAllocationMs: number
  growthAllocationMs: number
  payloadFinalizationMs: number
  /** Compatibility field; always zero because this route does not invoke. */
  preloadInvokeMs: 0
  streamChunkCount: number
  streamDispatchCopyMs: number
  streamDispatchPostMs: number
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

function isValidWaveformData(value: unknown): value is ArrayBuffer {
  if (!(value instanceof ArrayBuffer) || value.byteLength !== LOCAL_PCM_WAVEFORM_BYTES) return false
  for (const sample of new Float32Array(value)) {
    if (!Number.isFinite(sample) || sample < 0 || sample > 1) return false
  }
  return true
}

function isValidTrackPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 32_768
    && !value.includes('\0')
}

export function isStaticTrackWaveformResult(
  value: unknown,
): value is StaticTrackWaveformResult {
  if (
    !isRecord(value)
    || value.version !== STATIC_TRACK_WAVEFORM_RESULT_VERSION
    || !isNonNegativeSafeInteger(value.requestId)
    || !isValidTrackPath(value.trackPath)
    || !isNonNegativeDuration(value.waveformAnalysisMs)
  ) return false

  if (value.status === 'ready') return isValidWaveformData(value.waveformData)
  return value.status === 'failed'
    && (value.failureKind === 'unavailable' || value.failureKind === 'analysis_failed')
}

export function validateLocalPcmStreamOpenRequest(
  value: unknown,
): value is LocalPcmStreamOpenRequest {
  if (!isRecord(value)) return false
  if (!isNonNegativeSafeInteger(value.requestId)) return false
  if (
    !isValidTrackPath(value.filePath)
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
    && isNonNegativeDuration(value.ffmpegMs)
    && isNonNegativeDuration(value.allocationMs)
    && isNonNegativeDuration(value.initialAllocationMs)
    && isNonNegativeDuration(value.growthAllocationMs)
    && isNonNegativeDuration(value.payloadFinalizationMs)
    && value.preloadInvokeMs === 0
    && isNonNegativeSafeInteger(value.streamChunkCount)
    && isNonNegativeDuration(value.streamDispatchCopyMs)
    && isNonNegativeDuration(value.streamDispatchPostMs)
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
