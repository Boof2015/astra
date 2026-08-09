/// <reference types="electron-vite/node" />

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LOCAL_PCM_STREAM_CHUNK_BYTES,
  LOCAL_PCM_STREAM_MAX_BYTES
} from '../shared/localPcmStream'

const require = createRequire(import.meta.url)

export interface LocalPcmNativeCaptureCapabilities {
  supported: boolean
  reason: string | null
  maxPcmBytes: number
  supportsProgressBatches: boolean
  progressBatchBytes: number
  progressMaxInFlightBatches: number
}

export type LocalPcmNativeCaptureDeliveryMode = 'complete_buffer' | 'progress_batches'

export interface LocalPcmNativeCaptureRequest {
  jobId: string
  slotId: string
  ffmpegPath: string
  args: string[]
  deliveryMode: LocalPcmNativeCaptureDeliveryMode
  batchBytes?: number
}

export interface LocalPcmNativeCaptureBatchPayload {
  jobId: string
  sequence: number
  byteOffset: number
  byteLength: number
  payload: Buffer
}

export interface LocalPcmNativeCaptureBatch extends LocalPcmNativeCaptureBatchPayload {
  /** Returns the native producer credit at most once and never crosses job reuse. */
  acknowledge: () => void
}

export interface LocalPcmNativeCaptureCallbacks {
  onBatch: (batch: LocalPcmNativeCaptureBatch) => void
}

export interface LocalPcmNativeCaptureResult {
  ok: boolean
  jobId: string
  deliveryMode: LocalPcmNativeCaptureDeliveryMode
  pcm: Buffer
  stderr: string
  stderrTruncated: boolean
  exitCode: number | null
  processId: number | null
  cancelled: boolean
  errorCode: string | null
  errorMessage: string | null
  windowsErrorCode: number | null
  outputBytes: number
  stdoutReadCount: number
  stdoutReadMinBytes: number | null
  stdoutReadMaxBytes: number | null
  requestedPipeBufferBytes: number
  effectivePipeBufferBytes: number | null
  bufferCopyMs: number
  usedExternalBuffer: boolean
  spawnMs: number
  firstByteMs: number | null
  stdoutReadSpanMs: number | null
  processMs: number
  batchTargetBytes: number
  batchCount: number
  batchBytes: number
  batchMinBytes: number | null
  batchMaxBytes: number | null
  batchCreditWaitCount: number
  batchCreditWaitMs: number
  batchCreditWaitMaxMs: number
  batchCopyMs: number
  batchCopyMaxMs: number
  batchCallbackMs: number
  batchCallbackMaxMs: number
}

interface LocalPcmNativeCaptureApi {
  getCapabilities: () => unknown
  capture: (
    request: LocalPcmNativeCaptureRequest,
    onBatch?: (batch: unknown) => void
  ) => Promise<unknown>
  acknowledge: (jobId: string, sequence: number) => boolean
  cancel: (jobId: string) => boolean
  cancelAll: () => number
  getActiveProcessIds: () => unknown
}

export type LocalPcmNativeAddonLoader = () => unknown

export interface LocalPcmNativeCaptureClientOptions {
  loadAddon: LocalPcmNativeAddonLoader
}

interface ActiveNativeCaptureState {
  jobId: string
  slotId: string
  cancelRequested: boolean
}

export class LocalPcmNativeCaptureUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalPcmNativeCaptureUnavailableError'
  }
}

export function isLocalPcmNativeCaptureSetupFailure(
  result: LocalPcmNativeCaptureResult
): boolean {
  return !result.ok
    && !result.cancelled
    && result.processId === null
    && result.outputBytes === 0
    && result.batchCount === 0
    && result.batchBytes === 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNullableNonNegativeSafeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeSafeInteger(value)
}

function isNonNegativeDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNullableNonNegativeDuration(value: unknown): value is number | null {
  return value === null || isNonNegativeDuration(value)
}

function normalizeCapabilities(value: unknown): LocalPcmNativeCaptureCapabilities {
  if (
    !isRecord(value)
    || typeof value.supported !== 'boolean'
    || (value.reason !== null && typeof value.reason !== 'string')
    || !isNonNegativeSafeInteger(value.maxPcmBytes)
    || typeof value.supportsProgressBatches !== 'boolean'
    || !isPositiveSafeInteger(value.progressBatchBytes)
    || !isPositiveSafeInteger(value.progressMaxInFlightBatches)
  ) {
    throw new TypeError('Native FFmpeg PCM capture returned invalid capabilities.')
  }
  return {
    supported: value.supported,
    reason: value.reason,
    maxPcmBytes: value.maxPcmBytes,
    supportsProgressBatches: value.supportsProgressBatches,
    progressBatchBytes: value.progressBatchBytes,
    progressMaxInFlightBatches: value.progressMaxInFlightBatches
  }
}

function normalizeCaptureResult(
  value: unknown,
  deliveryMode: LocalPcmNativeCaptureDeliveryMode
): LocalPcmNativeCaptureResult {
  if (
    !isRecord(value)
    || typeof value.ok !== 'boolean'
    || typeof value.jobId !== 'string'
    || value.deliveryMode !== deliveryMode
    || !Buffer.isBuffer(value.pcm)
    || typeof value.stderr !== 'string'
    || typeof value.stderrTruncated !== 'boolean'
    || !isNullableNonNegativeSafeInteger(value.exitCode)
    || (value.processId !== null && !isPositiveSafeInteger(value.processId))
    || typeof value.cancelled !== 'boolean'
    || (value.errorCode !== null && typeof value.errorCode !== 'string')
    || (value.errorMessage !== null && typeof value.errorMessage !== 'string')
    || !isNullableNonNegativeSafeInteger(value.windowsErrorCode)
    || !isNonNegativeSafeInteger(value.outputBytes)
    || value.outputBytes > LOCAL_PCM_STREAM_MAX_BYTES
    || !isNonNegativeSafeInteger(value.stdoutReadCount)
    || !isNullableNonNegativeSafeInteger(value.stdoutReadMinBytes)
    || !isNullableNonNegativeSafeInteger(value.stdoutReadMaxBytes)
    || !isPositiveSafeInteger(value.requestedPipeBufferBytes)
    || (value.effectivePipeBufferBytes !== null
      && !isPositiveSafeInteger(value.effectivePipeBufferBytes))
    || !isNonNegativeDuration(value.bufferCopyMs)
    || typeof value.usedExternalBuffer !== 'boolean'
    || !isNonNegativeDuration(value.spawnMs)
    || !isNullableNonNegativeDuration(value.firstByteMs)
    || !isNullableNonNegativeDuration(value.stdoutReadSpanMs)
    || !isNonNegativeDuration(value.processMs)
    || value.batchTargetBytes !== LOCAL_PCM_STREAM_CHUNK_BYTES
    || !isNonNegativeSafeInteger(value.batchCount)
    || !isNonNegativeSafeInteger(value.batchBytes)
    || value.batchBytes > LOCAL_PCM_STREAM_MAX_BYTES
    || !isNullableNonNegativeSafeInteger(value.batchMinBytes)
    || !isNullableNonNegativeSafeInteger(value.batchMaxBytes)
    || !isNonNegativeSafeInteger(value.batchCreditWaitCount)
    || !isNonNegativeDuration(value.batchCreditWaitMs)
    || !isNonNegativeDuration(value.batchCreditWaitMaxMs)
    || !isNonNegativeDuration(value.batchCopyMs)
    || !isNonNegativeDuration(value.batchCopyMaxMs)
    || !isNonNegativeDuration(value.batchCallbackMs)
    || !isNonNegativeDuration(value.batchCallbackMaxMs)
  ) {
    throw new TypeError('Native FFmpeg PCM capture returned an invalid result.')
  }
  if (value.stdoutReadMinBytes !== null && value.stdoutReadMaxBytes !== null
    && value.stdoutReadMinBytes > value.stdoutReadMaxBytes) {
    throw new TypeError('Native FFmpeg PCM capture returned an invalid read-size range.')
  }
  if (
    (value.batchCount === 0 && (
      value.batchBytes !== 0
      || value.batchMinBytes !== null
      || value.batchMaxBytes !== null
      || value.batchCopyMs !== 0
      || value.batchCopyMaxMs !== 0
      || value.batchCallbackMs !== 0
      || value.batchCallbackMaxMs !== 0
    ))
    || (value.batchCount > 0 && (
      value.batchBytes === 0
      || value.batchMinBytes === null
      || value.batchMaxBytes === null
      || value.batchMinBytes <= 0
      || value.batchMinBytes > value.batchMaxBytes
      || value.batchMaxBytes > value.batchTargetBytes
      || value.batchBytes < value.batchMaxBytes
    ))
    || (value.ok && value.batchCreditWaitCount > value.batchCount)
    || value.batchCreditWaitMaxMs > value.batchCreditWaitMs
    || value.batchCopyMaxMs > value.batchCopyMs
    || value.batchCallbackMaxMs > value.batchCallbackMs
    || value.batchBytes < value.batchCount * (value.batchMinBytes ?? 0)
    || value.batchBytes > value.batchCount * (value.batchMaxBytes ?? 0)
    || (deliveryMode === 'complete_buffer' && (
      value.batchCount !== 0
      || value.batchBytes !== 0
      || value.batchCreditWaitCount !== 0
      || value.batchCreditWaitMs !== 0
      || value.batchCreditWaitMaxMs !== 0
      || value.batchCopyMs !== 0
      || value.batchCopyMaxMs !== 0
      || value.batchCallbackMs !== 0
      || value.batchCallbackMaxMs !== 0
    ))
  ) {
    throw new TypeError('Native FFmpeg PCM capture returned inconsistent batch telemetry.')
  }
  if (
    value.spawnMs > value.processMs
    || (value.firstByteMs !== null && value.firstByteMs > value.processMs)
    || (
      value.firstByteMs !== null
      && value.stdoutReadSpanMs !== null
      && value.firstByteMs + value.stdoutReadSpanMs > value.processMs
    )
  ) {
    throw new TypeError('Native FFmpeg PCM capture returned inconsistent phase timings.')
  }
  if (
    (value.stdoutReadCount === 0
      && (value.stdoutReadMinBytes !== null || value.stdoutReadMaxBytes !== null))
    || (value.stdoutReadCount > 0
      && (value.stdoutReadMinBytes === null || value.stdoutReadMaxBytes === null))
    || (value.stdoutReadMaxBytes !== null && value.stdoutReadMaxBytes > value.outputBytes)
  ) {
    throw new TypeError('Native FFmpeg PCM capture returned inconsistent read telemetry.')
  }
  if (value.jobId.length === 0) {
    throw new TypeError('Native FFmpeg PCM capture returned an empty job ID.')
  }
  if (value.ok) {
    const invalidCompleteBuffer = deliveryMode === 'complete_buffer' && (
      value.outputBytes !== value.pcm.byteLength
      || value.batchCount !== 0
      || value.batchBytes !== 0
    )
    const invalidProgressBatches = deliveryMode === 'progress_batches' && (
      value.pcm.byteLength !== 0
      || value.outputBytes !== value.batchBytes
      || value.batchCount === 0
      || value.bufferCopyMs !== 0
      || value.usedExternalBuffer
    )
    if (
      value.exitCode !== 0
      || value.processId === null
      || value.cancelled
      || value.errorCode !== null
      || value.errorMessage !== null
      || value.outputBytes === 0
      || value.outputBytes > LOCAL_PCM_STREAM_MAX_BYTES
      || value.stdoutReadCount === 0
      || value.stdoutReadMinBytes === null
      || value.stdoutReadMaxBytes === null
      || invalidCompleteBuffer
      || invalidProgressBatches
    ) {
      throw new TypeError('Native FFmpeg PCM capture returned an inconsistent success result.')
    }
    if (value.usedExternalBuffer && value.bufferCopyMs !== 0) {
      throw new TypeError('Native FFmpeg PCM capture reported copying an external buffer.')
    }
  } else {
    if (value.pcm.byteLength !== 0) {
      throw new TypeError('Native FFmpeg PCM capture returned PCM for a failed result.')
    }
    if (value.bufferCopyMs !== 0 || value.usedExternalBuffer) {
      throw new TypeError('Native FFmpeg PCM capture reported a buffer handoff for a failed result.')
    }
  }
  return value as unknown as LocalPcmNativeCaptureResult
}

function normalizeCaptureBatch(
  value: unknown,
  request: LocalPcmNativeCaptureRequest,
  expectedSequence: number,
  expectedByteOffset: number,
  sawPartialBatch: boolean
): LocalPcmNativeCaptureBatchPayload {
  if (
    !isRecord(value)
    || value.jobId !== request.jobId
    || value.sequence !== expectedSequence
    || value.byteOffset !== expectedByteOffset
    || !isPositiveSafeInteger(value.byteLength)
    || value.byteLength > LOCAL_PCM_STREAM_CHUNK_BYTES
    || !Buffer.isBuffer(value.payload)
    || value.payload.byteLength !== value.byteLength
    || sawPartialBatch
    || !Number.isSafeInteger(expectedByteOffset + value.byteLength)
    || expectedByteOffset + value.byteLength > LOCAL_PCM_STREAM_MAX_BYTES
  ) {
    throw new TypeError('Native FFmpeg PCM capture returned an invalid or out-of-order batch.')
  }
  return value as unknown as LocalPcmNativeCaptureBatchPayload
}

function normalizeApi(value: unknown): LocalPcmNativeCaptureApi {
  if (!isRecord(value)) {
    throw new LocalPcmNativeCaptureUnavailableError('Astra native audio addon did not load.')
  }
  const api = value as unknown as LocalPcmNativeCaptureApi
  if (
    !api
    || typeof api.getCapabilities !== 'function'
    || typeof api.capture !== 'function'
    || typeof api.acknowledge !== 'function'
    || typeof api.cancel !== 'function'
    || typeof api.cancelAll !== 'function'
    || typeof api.getActiveProcessIds !== 'function'
  ) {
    throw new LocalPcmNativeCaptureUnavailableError(
      'Astra native FFmpeg PCM capture addon has an invalid API.'
    )
  }
  return api
}

export class LocalPcmNativeCaptureClient {
  private readonly loadAddon: LocalPcmNativeAddonLoader
  private api: LocalPcmNativeCaptureApi | null = null
  private loadError: Error | null = null
  private readonly activeCaptures = new Map<string, ActiveNativeCaptureState>()
  private readonly latestCapturesBySlot = new Map<string, ActiveNativeCaptureState>()

  constructor(options: LocalPcmNativeCaptureClientOptions) {
    this.loadAddon = options.loadAddon
  }

  getCapabilities(): LocalPcmNativeCaptureCapabilities {
    return normalizeCapabilities(this.getApi().getCapabilities())
  }

  async capture(
    request: LocalPcmNativeCaptureRequest,
    callbacks?: LocalPcmNativeCaptureCallbacks
  ): Promise<LocalPcmNativeCaptureResult> {
    const progressMode = request.deliveryMode === 'progress_batches'
    if (
      (request.deliveryMode !== 'complete_buffer' && !progressMode)
      || (progressMode && (
        request.batchBytes !== LOCAL_PCM_STREAM_CHUNK_BYTES
        || typeof callbacks?.onBatch !== 'function'
      ))
      || (!progressMode && (request.batchBytes !== undefined || callbacks !== undefined))
    ) {
      throw new TypeError('Native FFmpeg PCM capture delivery options are invalid.')
    }

    const api = this.getApi()
    const captureState: ActiveNativeCaptureState = {
      jobId: request.jobId,
      slotId: request.slotId,
      cancelRequested: false
    }
    const cancelCapture = (): void => {
      captureState.cancelRequested = true
      try {
        api.cancel(request.jobId)
      } catch {
        // Native cancellation remains best-effort after a boundary failure.
      }
    }
    let active = true
    let expectedSequence = 0
    let expectedByteOffset = 0
    let sawPartialBatch = false
    let consumerError: Error | null = null
    const onBatch = progressMode
      ? (value: unknown): void => {
          if (!active || consumerError) return
          let batchPayload: LocalPcmNativeCaptureBatchPayload
          try {
            batchPayload = normalizeCaptureBatch(
              value,
              request,
              expectedSequence,
              expectedByteOffset,
              sawPartialBatch
            )
          } catch (error) {
            consumerError = error instanceof Error
              ? error
              : new TypeError('Native FFmpeg PCM capture batch validation failed.')
            cancelCapture()
            return
          }

          expectedSequence += 1
          expectedByteOffset += batchPayload.byteLength
          sawPartialBatch = batchPayload.byteLength < LOCAL_PCM_STREAM_CHUNK_BYTES
          let acknowledged = false
          const acknowledge = (): void => {
            if (acknowledged || !active) return
            acknowledged = true
            try {
              if (
                !api.acknowledge(request.jobId, batchPayload.sequence)
                && !captureState.cancelRequested
                && !consumerError
              ) {
                consumerError = new Error(
                  'Native FFmpeg PCM capture refused a live batch acknowledgement.'
                )
                cancelCapture()
              }
            } catch (error) {
              if (!consumerError) {
                consumerError = error instanceof Error
                  ? error
                  : new Error('Native FFmpeg PCM capture acknowledgement failed.')
                try {
                  cancelCapture()
                } catch {
                  // The native job may already be terminating after the failed credit.
                }
              }
            }
          }
          try {
            callbacks?.onBatch({ ...batchPayload, acknowledge })
          } catch (error) {
            consumerError = error instanceof Error
              ? error
              : new Error('Native FFmpeg PCM capture batch consumer failed.')
            cancelCapture()
            acknowledge()
          }
        }
      : undefined

    let result: unknown
    try {
      const resultPromise = progressMode
        ? api.capture(request, onBatch)
        : api.capture(request)
      const superseded = this.latestCapturesBySlot.get(request.slotId)
      if (superseded) superseded.cancelRequested = true
      this.activeCaptures.set(request.jobId, captureState)
      this.latestCapturesBySlot.set(request.slotId, captureState)
      result = await resultPromise
    } finally {
      active = false
      if (this.activeCaptures.get(request.jobId) === captureState) {
        this.activeCaptures.delete(request.jobId)
      }
      if (this.latestCapturesBySlot.get(request.slotId) === captureState) {
        this.latestCapturesBySlot.delete(request.slotId)
      }
    }
    if (consumerError) throw consumerError
    const normalized = normalizeCaptureResult(result, request.deliveryMode)
    if (normalized.jobId !== request.jobId) {
      throw new TypeError('Native FFmpeg PCM capture returned a stale job result.')
    }
    if (
      progressMode
      && normalized.ok
      && (
        normalized.batchCount !== expectedSequence
        || normalized.batchBytes !== expectedByteOffset
      )
    ) {
      throw new TypeError('Native FFmpeg PCM capture batch completion did not reconcile.')
    }
    return normalized
  }

  cancel(jobId: string): boolean {
    const capture = this.activeCaptures.get(jobId)
    if (capture) capture.cancelRequested = true
    if (!this.api) return false
    try {
      return this.api.cancel(jobId)
    } catch {
      return false
    }
  }

  cancelAll(): number {
    for (const capture of this.activeCaptures.values()) capture.cancelRequested = true
    if (!this.api) return 0
    try {
      return this.api.cancelAll()
    } catch {
      return 0
    }
  }

  getActiveProcessIds(): number[] {
    if (!this.api) return []
    try {
      const value = this.api.getActiveProcessIds()
      if (!Array.isArray(value)) return []
      return [...new Set(value.filter(isPositiveSafeInteger))]
    } catch {
      return []
    }
  }

  private getApi(): LocalPcmNativeCaptureApi {
    if (this.api) return this.api
    if (this.loadError) throw this.loadError
    try {
      this.api = normalizeApi(this.loadAddon())
      return this.api
    } catch (error) {
      this.loadError = error instanceof Error
        ? error
        : new LocalPcmNativeCaptureUnavailableError('Astra native audio addon did not load.')
      throw this.loadError
    }
  }
}

export function resolveLocalPcmNativeAddonPath(
  isPackaged: boolean,
  resourcesPath: string = process.resourcesPath,
  moduleDir: string = dirname(fileURLToPath(import.meta.url))
): string {
  return isPackaged
    ? join(resourcesPath, 'native/ffmpeg_pcm_capture.node')
    : join(moduleDir, '../../native/build/Release/ffmpeg_pcm_capture.node')
}

export function createBundledLocalPcmNativeCaptureClient(
  isPackaged: boolean
): LocalPcmNativeCaptureClient {
  const modulePath = resolveLocalPcmNativeAddonPath(isPackaged)
  return new LocalPcmNativeCaptureClient({
    loadAddon: () => require(modulePath)
  })
}
