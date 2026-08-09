export interface PcmTransportTimings {
  decodeRequestId: number
  validPcmBytes: number
  backingBufferBytes: number
  allocationGrowthCount: number
  transportRoute?: 'invoke' | 'message_port_stream' | 'preload_native'
  /** Preload-owned native decode service wall span. */
  preloadNativeServiceMs?: number
  /** Main-process handler wall span; decoder subphases may overlap within it. */
  mainHandlerMs: number
  binaryResolutionMs: number
  probeMs: number
  probeCacheStatus?: 'hit' | 'miss' | 'bypass'
  probeDecodeOverlapEnabled?: boolean
  /** Wall time during which probing and FFmpeg decoding overlapped. */
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
  initialAllocationMs?: number
  growthAllocationMs?: number
  payloadFinalizationMs: number
  preloadInvokeMs: number
  streamChunkCount?: number
  streamDispatchCopyMs?: number
  streamDispatchPostMs?: number
  streamCreditAckCount?: number
  streamCreditRoundTripMs?: number
  streamCreditRoundTripMaxMs?: number
  streamTailMs?: number
  rendererPcmAssemblyAllocationMs?: number
  rendererPcmAssemblyCopyMs?: number
  rendererPortRequestMs?: number
}

export interface PcmTransportTimingSummary {
  decodeRequestId?: number
  validPcmBytes?: number
  backingBufferBytes?: number
  allocationGrowthCount?: number
  transportRoute?: 'invoke' | 'message_port_stream' | 'preload_native'
  preloadNativeServiceMs?: number
  preloadNativeContextBridgeResidualMs?: number
  mainHandlerMs?: number
  binaryResolutionMs?: number
  probeMs?: number
  probeCacheStatus?: 'hit' | 'miss' | 'bypass'
  probeDecodeOverlapEnabled?: boolean
  probeFfmpegOverlapMs?: number
  ffmpegMs?: number
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
  pcmAllocationMs?: number
  initialPcmAllocationMs?: number
  growthPcmAllocationMs?: number
  payloadFinalizationMs?: number
  preloadInvokeMs?: number
  rendererBridgeCallMs: number
  electronIpcResidualMs?: number
  contextBridgeResidualMs?: number
  streamChunkCount?: number
  streamDispatchCopyMs?: number
  streamDispatchPostMs?: number
  streamCreditAckCount?: number
  streamCreditRoundTripMs?: number
  streamCreditRoundTripMaxMs?: number
  streamTailMs?: number
  rendererPcmAssemblyAllocationMs?: number
  rendererPcmAssemblyCopyMs?: number
  rendererPortRequestMs?: number
  streamTransportResidualMs?: number
}

export function clampDiagnosticDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, value)
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined
  return Math.max(0, value)
}

/**
 * Builds renderer-visible transport timings from durations measured in their
 * owning processes. The residuals include Electron scheduling/dispatch and
 * serialization overhead; they are diagnostics and do not establish a memcpy
 * count or attribute all elapsed time to copying.
 */
export function summarizePcmTransportTimings(
  transportTimings: PcmTransportTimings | null | undefined,
  rendererBridgeCallMsValue: unknown,
): PcmTransportTimingSummary {
  const rendererBridgeCallMs = clampDiagnosticDurationMs(rendererBridgeCallMsValue) ?? 0
  if (!transportTimings) return { rendererBridgeCallMs }

  const preloadNativeServiceMs = clampDiagnosticDurationMs(
    transportTimings.preloadNativeServiceMs
  )
  const mainHandlerMs = clampDiagnosticDurationMs(transportTimings.mainHandlerMs)
  const preloadInvokeMs = clampDiagnosticDurationMs(transportTimings.preloadInvokeMs)
  const decodeRequestId = nonNegativeSafeInteger(transportTimings.decodeRequestId)
  const validPcmBytes = nonNegativeSafeInteger(transportTimings.validPcmBytes)
  const backingBufferBytes = nonNegativeSafeInteger(transportTimings.backingBufferBytes)
  const allocationGrowthCount = nonNegativeSafeInteger(transportTimings.allocationGrowthCount)
  const transportRoute = transportTimings.transportRoute === 'message_port_stream'
    ? 'message_port_stream'
    : transportTimings.transportRoute === 'preload_native'
      ? 'preload_native'
      : 'invoke'
  const binaryResolutionMs = clampDiagnosticDurationMs(transportTimings.binaryResolutionMs)
  const probeMs = clampDiagnosticDurationMs(transportTimings.probeMs)
  const probeCacheStatus = transportTimings.probeCacheStatus === 'hit'
    || transportTimings.probeCacheStatus === 'miss'
    || transportTimings.probeCacheStatus === 'bypass'
    ? transportTimings.probeCacheStatus
    : undefined
  const probeDecodeOverlapEnabled = typeof transportTimings.probeDecodeOverlapEnabled === 'boolean'
    ? transportTimings.probeDecodeOverlapEnabled
    : undefined
  const probeFfmpegOverlapMs = clampDiagnosticDurationMs(transportTimings.probeFfmpegOverlapMs)
  const ffmpegMs = clampDiagnosticDurationMs(transportTimings.ffmpegMs)
  const ffmpegOutputSink = transportTimings.ffmpegOutputSink === 'stdout_pipe'
    || transportTimings.ffmpegOutputSink === 'rechunked_pipe'
    || transportTimings.ffmpegOutputSink === 'native_pipe'
    || transportTimings.ffmpegOutputSink === 'preload_native'
    || transportTimings.ffmpegOutputSink === 'worker_thread'
    || transportTimings.ffmpegOutputSink === 'temporary_file'
    ? transportTimings.ffmpegOutputSink
    : undefined
  const tempPcmCreateMs = clampDiagnosticDurationMs(transportTimings.tempPcmCreateMs)
  const tempPcmStatMs = clampDiagnosticDurationMs(transportTimings.tempPcmStatMs)
  const tempPcmReadMs = clampDiagnosticDurationMs(transportTimings.tempPcmReadMs)
  const tempPcmReadChunkCount = nonNegativeSafeInteger(transportTimings.tempPcmReadChunkCount)
  const tempPcmBytes = nonNegativeSafeInteger(transportTimings.tempPcmBytes)
  const tempPcmCleanupMs = clampDiagnosticDurationMs(transportTimings.tempPcmCleanupMs)
  const tempPcmCleanupSucceeded = typeof transportTimings.tempPcmCleanupSucceeded === 'boolean'
    ? transportTimings.tempPcmCleanupSucceeded
    : undefined
  const ffmpegWorkerStartupMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegWorkerStartupMs
  )
  const ffmpegWorkerTotalMs = clampDiagnosticDurationMs(transportTimings.ffmpegWorkerTotalMs)
  const ffmpegWorkerSpawnMs = clampDiagnosticDurationMs(transportTimings.ffmpegWorkerSpawnMs)
  const ffmpegWorkerFfmpegMs = clampDiagnosticDurationMs(transportTimings.ffmpegWorkerFfmpegMs)
  const ffmpegWorkerSpawnToFirstPcmMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegWorkerSpawnToFirstPcmMs
  )
  const ffmpegWorkerPcmOutputSpanMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegWorkerPcmOutputSpanMs
  )
  const ffmpegWorkerCloseTailMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegWorkerCloseTailMs
  )
  const ffmpegWorkerRequestMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegWorkerRequestMs
  )
  const ffmpegWorkerMainDeliverySpanMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegWorkerMainDeliverySpanMs
  )
  const ffmpegWorkerBatchCount = nonNegativeSafeInteger(
    transportTimings.ffmpegWorkerBatchCount
  )
  const ffmpegWorkerBatchBytes = nonNegativeSafeInteger(
    transportTimings.ffmpegWorkerBatchBytes
  )
  const ffmpegWorkerBatchMinBytes = nonNegativeSafeInteger(
    transportTimings.ffmpegWorkerBatchMinBytes
  )
  const ffmpegWorkerBatchMaxBytes = nonNegativeSafeInteger(
    transportTimings.ffmpegWorkerBatchMaxBytes
  )
  const ffmpegWorkerAggregationCopyMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegWorkerAggregationCopyMs
  )
  const ffmpegWorkerAggregationCopyMaxMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegWorkerAggregationCopyMaxMs
  )
  const ffmpegWorkerBatchCopyMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegWorkerBatchCopyMs
  )
  const ffmpegWorkerBatchPostMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegWorkerBatchPostMs
  )
  const ffmpegWorkerMainCopyMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegWorkerMainCopyMs
  )
  const ffmpegWorkerMainCopyMaxMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegWorkerMainCopyMaxMs
  )
  const ffmpegWorkerCreditWaitCount = nonNegativeSafeInteger(
    transportTimings.ffmpegWorkerCreditWaitCount
  )
  const ffmpegWorkerCreditWaitMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegWorkerCreditWaitMs
  )
  const ffmpegWorkerCreditWaitMaxMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegWorkerCreditWaitMaxMs
  )
  const nativePcmCaptureSpawnMs = clampDiagnosticDurationMs(
    transportTimings.nativePcmCaptureSpawnMs
  )
  const nativePcmCaptureProcessMs = clampDiagnosticDurationMs(
    transportTimings.nativePcmCaptureProcessMs
  )
  const nativePcmCaptureFirstByteMs = clampDiagnosticDurationMs(
    transportTimings.nativePcmCaptureFirstByteMs
  )
  const nativePcmCaptureStdoutReadSpanMs = clampDiagnosticDurationMs(
    transportTimings.nativePcmCaptureStdoutReadSpanMs
  )
  const nativePcmCaptureStdoutReadCount = nonNegativeSafeInteger(
    transportTimings.nativePcmCaptureStdoutReadCount
  )
  const nativePcmCaptureStdoutReadMinBytes = nonNegativeSafeInteger(
    transportTimings.nativePcmCaptureStdoutReadMinBytes
  )
  const nativePcmCaptureStdoutReadMaxBytes = nonNegativeSafeInteger(
    transportTimings.nativePcmCaptureStdoutReadMaxBytes
  )
  const nativePcmCaptureOutputBytes = nonNegativeSafeInteger(
    transportTimings.nativePcmCaptureOutputBytes
  )
  const nativePcmCaptureRequestedPipeBufferBytes = nonNegativeSafeInteger(
    transportTimings.nativePcmCaptureRequestedPipeBufferBytes
  )
  const nativePcmCaptureEffectivePipeBufferBytes = nonNegativeSafeInteger(
    transportTimings.nativePcmCaptureEffectivePipeBufferBytes
  )
  const nativePcmCaptureBufferCopyMs = clampDiagnosticDurationMs(
    transportTimings.nativePcmCaptureBufferCopyMs
  )
  const nativePcmCaptureUsedExternalBuffer =
    typeof transportTimings.nativePcmCaptureUsedExternalBuffer === 'boolean'
      ? transportTimings.nativePcmCaptureUsedExternalBuffer
      : undefined
  const nativePcmCaptureDeliveryMode =
    transportTimings.nativePcmCaptureDeliveryMode === 'complete_buffer'
    || transportTimings.nativePcmCaptureDeliveryMode === 'progress_batches'
      ? transportTimings.nativePcmCaptureDeliveryMode
      : undefined
  const nativePcmCaptureBatchTargetBytes = nonNegativeSafeInteger(
    transportTimings.nativePcmCaptureBatchTargetBytes
  )
  const nativePcmCaptureBatchCount = nonNegativeSafeInteger(
    transportTimings.nativePcmCaptureBatchCount
  )
  const nativePcmCaptureBatchBytes = nonNegativeSafeInteger(
    transportTimings.nativePcmCaptureBatchBytes
  )
  const nativePcmCaptureBatchMinBytes = nonNegativeSafeInteger(
    transportTimings.nativePcmCaptureBatchMinBytes
  )
  const nativePcmCaptureBatchMaxBytes = nonNegativeSafeInteger(
    transportTimings.nativePcmCaptureBatchMaxBytes
  )
  const nativePcmCaptureBatchCreditWaitCount = nonNegativeSafeInteger(
    transportTimings.nativePcmCaptureBatchCreditWaitCount
  )
  const nativePcmCaptureBatchCreditWaitMs = clampDiagnosticDurationMs(
    transportTimings.nativePcmCaptureBatchCreditWaitMs
  )
  const nativePcmCaptureBatchCreditWaitMaxMs = clampDiagnosticDurationMs(
    transportTimings.nativePcmCaptureBatchCreditWaitMaxMs
  )
  const nativePcmCaptureBatchCopyMs = clampDiagnosticDurationMs(
    transportTimings.nativePcmCaptureBatchCopyMs
  )
  const nativePcmCaptureBatchCopyMaxMs = clampDiagnosticDurationMs(
    transportTimings.nativePcmCaptureBatchCopyMaxMs
  )
  const nativePcmCaptureBatchCallbackMs = clampDiagnosticDurationMs(
    transportTimings.nativePcmCaptureBatchCallbackMs
  )
  const nativePcmCaptureBatchCallbackMaxMs = clampDiagnosticDurationMs(
    transportTimings.nativePcmCaptureBatchCallbackMaxMs
  )
  const nativePcmCaptureMainCopyMs = clampDiagnosticDurationMs(
    transportTimings.nativePcmCaptureMainCopyMs
  )
  const nativePcmCaptureMainCopyMaxMs = clampDiagnosticDurationMs(
    transportTimings.nativePcmCaptureMainCopyMaxMs
  )
  const nativePcmCaptureFirstBatchMs = clampDiagnosticDurationMs(
    transportTimings.nativePcmCaptureFirstBatchMs
  )
  const nativePcmCaptureMainBatchSpanMs = clampDiagnosticDurationMs(
    transportTimings.nativePcmCaptureMainBatchSpanMs
  )
  const ffmpegSpawnToFirstPcmMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegSpawnToFirstPcmMs
  )
  const ffmpegPcmOutputSpanMs = clampDiagnosticDurationMs(transportTimings.ffmpegPcmOutputSpanMs)
  const ffmpegCloseTailMs = clampDiagnosticDurationMs(transportTimings.ffmpegCloseTailMs)
  const ffmpegStdoutChunkCount = nonNegativeSafeInteger(transportTimings.ffmpegStdoutChunkCount)
  const ffmpegStdoutBytes = nonNegativeSafeInteger(transportTimings.ffmpegStdoutBytes)
  const ffmpegStdoutChunkMinBytes = nonNegativeSafeInteger(
    transportTimings.ffmpegStdoutChunkMinBytes
  )
  const ffmpegStdoutChunkMaxBytes = nonNegativeSafeInteger(
    transportTimings.ffmpegStdoutChunkMaxBytes
  )
  const ffmpegStdoutDrainSpanMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegStdoutDrainSpanMs
  )
  const ffmpegStdoutDrainToCloseMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegStdoutDrainToCloseMs
  )
  const ffmpegStdoutCallbackWorkMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegStdoutCallbackWorkMs
  )
  const ffmpegStdoutCallbackMaxMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegStdoutCallbackMaxMs
  )
  const ffmpegStdoutInterCallbackGapMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegStdoutInterCallbackGapMs
  )
  const ffmpegStdoutInterCallbackGapMaxMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegStdoutInterCallbackGapMaxMs
  )
  const ffmpegStdoutPostDispatchGapCount = nonNegativeSafeInteger(
    transportTimings.ffmpegStdoutPostDispatchGapCount
  )
  const ffmpegStdoutPostDispatchGapMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegStdoutPostDispatchGapMs
  )
  const ffmpegStdoutPostDispatchGapMaxMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegStdoutPostDispatchGapMaxMs
  )
  const ffmpegStdoutCopyMs = clampDiagnosticDurationMs(transportTimings.ffmpegStdoutCopyMs)
  const ffmpegStdoutCopyMaxMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegStdoutCopyMaxMs
  )
  const ffmpegStdoutFlushMs = clampDiagnosticDurationMs(transportTimings.ffmpegStdoutFlushMs)
  const ffmpegStdoutFlushMaxMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegStdoutFlushMaxMs
  )
  const ffmpegStdoutPauseCount = nonNegativeSafeInteger(transportTimings.ffmpegStdoutPauseCount)
  const ffmpegStdoutPausedMs = clampDiagnosticDurationMs(transportTimings.ffmpegStdoutPausedMs)
  const ffmpegStdoutPauseMaxMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegStdoutPauseMaxMs
  )
  const pcmAllocationMs = clampDiagnosticDurationMs(transportTimings.allocationMs)
  const initialPcmAllocationMs = clampDiagnosticDurationMs(transportTimings.initialAllocationMs)
  const growthPcmAllocationMs = clampDiagnosticDurationMs(transportTimings.growthAllocationMs)
  const payloadFinalizationMs = clampDiagnosticDurationMs(transportTimings.payloadFinalizationMs)
  const streamChunkCount = nonNegativeSafeInteger(transportTimings.streamChunkCount)
  const streamDispatchCopyMs = clampDiagnosticDurationMs(transportTimings.streamDispatchCopyMs)
  const streamDispatchPostMs = clampDiagnosticDurationMs(transportTimings.streamDispatchPostMs)
  const streamCreditAckCount = nonNegativeSafeInteger(transportTimings.streamCreditAckCount)
  const streamCreditRoundTripMs = clampDiagnosticDurationMs(
    transportTimings.streamCreditRoundTripMs
  )
  const streamCreditRoundTripMaxMs = clampDiagnosticDurationMs(
    transportTimings.streamCreditRoundTripMaxMs
  )
  const streamTailMs = clampDiagnosticDurationMs(transportTimings.streamTailMs)
  const rendererPcmAssemblyAllocationMs = clampDiagnosticDurationMs(
    transportTimings.rendererPcmAssemblyAllocationMs
  )
  const rendererPcmAssemblyCopyMs = clampDiagnosticDurationMs(
    transportTimings.rendererPcmAssemblyCopyMs
  )
  const rendererPortRequestMs = clampDiagnosticDurationMs(transportTimings.rendererPortRequestMs)

  return {
    rendererBridgeCallMs,
    transportRoute,
    ...(transportRoute !== 'preload_native' || preloadNativeServiceMs === undefined
      ? {}
      : { preloadNativeServiceMs }),
    ...(transportRoute !== 'preload_native' || preloadNativeServiceMs === undefined
      ? {}
      : {
          preloadNativeContextBridgeResidualMs: Math.max(
            0,
            rendererBridgeCallMs - preloadNativeServiceMs,
          ),
        }),
    ...(decodeRequestId === undefined ? {} : { decodeRequestId }),
    ...(validPcmBytes === undefined ? {} : { validPcmBytes }),
    ...(backingBufferBytes === undefined ? {} : { backingBufferBytes }),
    ...(allocationGrowthCount === undefined ? {} : { allocationGrowthCount }),
    ...(mainHandlerMs === undefined ? {} : { mainHandlerMs }),
    ...(binaryResolutionMs === undefined ? {} : { binaryResolutionMs }),
    ...(probeMs === undefined ? {} : { probeMs }),
    ...(probeCacheStatus === undefined ? {} : { probeCacheStatus }),
    ...(probeDecodeOverlapEnabled === undefined ? {} : { probeDecodeOverlapEnabled }),
    ...(probeFfmpegOverlapMs === undefined ? {} : { probeFfmpegOverlapMs }),
    ...(ffmpegMs === undefined ? {} : { ffmpegMs }),
    ...(ffmpegOutputSink === undefined ? {} : { ffmpegOutputSink }),
    ...(tempPcmCreateMs === undefined ? {} : { tempPcmCreateMs }),
    ...(tempPcmStatMs === undefined ? {} : { tempPcmStatMs }),
    ...(tempPcmReadMs === undefined ? {} : { tempPcmReadMs }),
    ...(tempPcmReadChunkCount === undefined ? {} : { tempPcmReadChunkCount }),
    ...(tempPcmBytes === undefined ? {} : { tempPcmBytes }),
    ...(tempPcmCleanupMs === undefined ? {} : { tempPcmCleanupMs }),
    ...(tempPcmCleanupSucceeded === undefined ? {} : { tempPcmCleanupSucceeded }),
    ...(ffmpegWorkerStartupMs === undefined ? {} : { ffmpegWorkerStartupMs }),
    ...(ffmpegWorkerTotalMs === undefined ? {} : { ffmpegWorkerTotalMs }),
    ...(ffmpegWorkerSpawnMs === undefined ? {} : { ffmpegWorkerSpawnMs }),
    ...(ffmpegWorkerFfmpegMs === undefined ? {} : { ffmpegWorkerFfmpegMs }),
    ...(ffmpegWorkerSpawnToFirstPcmMs === undefined
      ? {}
      : { ffmpegWorkerSpawnToFirstPcmMs }),
    ...(ffmpegWorkerPcmOutputSpanMs === undefined
      ? {}
      : { ffmpegWorkerPcmOutputSpanMs }),
    ...(ffmpegWorkerCloseTailMs === undefined ? {} : { ffmpegWorkerCloseTailMs }),
    ...(ffmpegWorkerRequestMs === undefined ? {} : { ffmpegWorkerRequestMs }),
    ...(ffmpegWorkerMainDeliverySpanMs === undefined
      ? {}
      : { ffmpegWorkerMainDeliverySpanMs }),
    ...(ffmpegWorkerBatchCount === undefined ? {} : { ffmpegWorkerBatchCount }),
    ...(ffmpegWorkerBatchBytes === undefined ? {} : { ffmpegWorkerBatchBytes }),
    ...(ffmpegWorkerBatchMinBytes === undefined ? {} : { ffmpegWorkerBatchMinBytes }),
    ...(ffmpegWorkerBatchMaxBytes === undefined ? {} : { ffmpegWorkerBatchMaxBytes }),
    ...(ffmpegWorkerAggregationCopyMs === undefined
      ? {}
      : { ffmpegWorkerAggregationCopyMs }),
    ...(ffmpegWorkerAggregationCopyMaxMs === undefined
      ? {}
      : { ffmpegWorkerAggregationCopyMaxMs }),
    ...(ffmpegWorkerBatchCopyMs === undefined ? {} : { ffmpegWorkerBatchCopyMs }),
    ...(ffmpegWorkerBatchPostMs === undefined ? {} : { ffmpegWorkerBatchPostMs }),
    ...(ffmpegWorkerMainCopyMs === undefined ? {} : { ffmpegWorkerMainCopyMs }),
    ...(ffmpegWorkerMainCopyMaxMs === undefined ? {} : { ffmpegWorkerMainCopyMaxMs }),
    ...(ffmpegWorkerCreditWaitCount === undefined
      ? {}
      : { ffmpegWorkerCreditWaitCount }),
    ...(ffmpegWorkerCreditWaitMs === undefined ? {} : { ffmpegWorkerCreditWaitMs }),
    ...(ffmpegWorkerCreditWaitMaxMs === undefined
      ? {}
      : { ffmpegWorkerCreditWaitMaxMs }),
    ...(nativePcmCaptureSpawnMs === undefined ? {} : { nativePcmCaptureSpawnMs }),
    ...(nativePcmCaptureProcessMs === undefined ? {} : { nativePcmCaptureProcessMs }),
    ...(nativePcmCaptureFirstByteMs === undefined ? {} : { nativePcmCaptureFirstByteMs }),
    ...(nativePcmCaptureStdoutReadSpanMs === undefined
      ? {}
      : { nativePcmCaptureStdoutReadSpanMs }),
    ...(nativePcmCaptureStdoutReadCount === undefined
      ? {}
      : { nativePcmCaptureStdoutReadCount }),
    ...(nativePcmCaptureStdoutReadMinBytes === undefined
      ? {}
      : { nativePcmCaptureStdoutReadMinBytes }),
    ...(nativePcmCaptureStdoutReadMaxBytes === undefined
      ? {}
      : { nativePcmCaptureStdoutReadMaxBytes }),
    ...(nativePcmCaptureOutputBytes === undefined ? {} : { nativePcmCaptureOutputBytes }),
    ...(nativePcmCaptureRequestedPipeBufferBytes === undefined
      ? {}
      : { nativePcmCaptureRequestedPipeBufferBytes }),
    ...(nativePcmCaptureEffectivePipeBufferBytes === undefined
      ? {}
      : { nativePcmCaptureEffectivePipeBufferBytes }),
    ...(nativePcmCaptureBufferCopyMs === undefined ? {} : { nativePcmCaptureBufferCopyMs }),
    ...(nativePcmCaptureUsedExternalBuffer === undefined
      ? {}
      : { nativePcmCaptureUsedExternalBuffer }),
    ...(nativePcmCaptureDeliveryMode === undefined ? {} : { nativePcmCaptureDeliveryMode }),
    ...(nativePcmCaptureBatchTargetBytes === undefined
      ? {}
      : { nativePcmCaptureBatchTargetBytes }),
    ...(nativePcmCaptureBatchCount === undefined ? {} : { nativePcmCaptureBatchCount }),
    ...(nativePcmCaptureBatchBytes === undefined ? {} : { nativePcmCaptureBatchBytes }),
    ...(nativePcmCaptureBatchMinBytes === undefined
      ? {}
      : { nativePcmCaptureBatchMinBytes }),
    ...(nativePcmCaptureBatchMaxBytes === undefined
      ? {}
      : { nativePcmCaptureBatchMaxBytes }),
    ...(nativePcmCaptureBatchCreditWaitCount === undefined
      ? {}
      : { nativePcmCaptureBatchCreditWaitCount }),
    ...(nativePcmCaptureBatchCreditWaitMs === undefined
      ? {}
      : { nativePcmCaptureBatchCreditWaitMs }),
    ...(nativePcmCaptureBatchCreditWaitMaxMs === undefined
      ? {}
      : { nativePcmCaptureBatchCreditWaitMaxMs }),
    ...(nativePcmCaptureBatchCopyMs === undefined ? {} : { nativePcmCaptureBatchCopyMs }),
    ...(nativePcmCaptureBatchCopyMaxMs === undefined
      ? {}
      : { nativePcmCaptureBatchCopyMaxMs }),
    ...(nativePcmCaptureBatchCallbackMs === undefined
      ? {}
      : { nativePcmCaptureBatchCallbackMs }),
    ...(nativePcmCaptureBatchCallbackMaxMs === undefined
      ? {}
      : { nativePcmCaptureBatchCallbackMaxMs }),
    ...(nativePcmCaptureMainCopyMs === undefined ? {} : { nativePcmCaptureMainCopyMs }),
    ...(nativePcmCaptureMainCopyMaxMs === undefined
      ? {}
      : { nativePcmCaptureMainCopyMaxMs }),
    ...(nativePcmCaptureFirstBatchMs === undefined ? {} : { nativePcmCaptureFirstBatchMs }),
    ...(nativePcmCaptureMainBatchSpanMs === undefined
      ? {}
      : { nativePcmCaptureMainBatchSpanMs }),
    ...(ffmpegSpawnToFirstPcmMs === undefined ? {} : { ffmpegSpawnToFirstPcmMs }),
    ...(ffmpegPcmOutputSpanMs === undefined ? {} : { ffmpegPcmOutputSpanMs }),
    ...(ffmpegCloseTailMs === undefined ? {} : { ffmpegCloseTailMs }),
    ...(ffmpegStdoutChunkCount === undefined ? {} : { ffmpegStdoutChunkCount }),
    ...(ffmpegStdoutBytes === undefined ? {} : { ffmpegStdoutBytes }),
    ...(ffmpegStdoutChunkMinBytes === undefined ? {} : { ffmpegStdoutChunkMinBytes }),
    ...(ffmpegStdoutChunkMaxBytes === undefined ? {} : { ffmpegStdoutChunkMaxBytes }),
    ...(ffmpegStdoutDrainSpanMs === undefined ? {} : { ffmpegStdoutDrainSpanMs }),
    ...(ffmpegStdoutDrainToCloseMs === undefined ? {} : { ffmpegStdoutDrainToCloseMs }),
    ...(ffmpegStdoutCallbackWorkMs === undefined ? {} : { ffmpegStdoutCallbackWorkMs }),
    ...(ffmpegStdoutCallbackMaxMs === undefined ? {} : { ffmpegStdoutCallbackMaxMs }),
    ...(ffmpegStdoutInterCallbackGapMs === undefined ? {} : { ffmpegStdoutInterCallbackGapMs }),
    ...(ffmpegStdoutInterCallbackGapMaxMs === undefined
      ? {}
      : { ffmpegStdoutInterCallbackGapMaxMs }),
    ...(ffmpegStdoutPostDispatchGapCount === undefined
      ? {}
      : { ffmpegStdoutPostDispatchGapCount }),
    ...(ffmpegStdoutPostDispatchGapMs === undefined ? {} : { ffmpegStdoutPostDispatchGapMs }),
    ...(ffmpegStdoutPostDispatchGapMaxMs === undefined
      ? {}
      : { ffmpegStdoutPostDispatchGapMaxMs }),
    ...(ffmpegStdoutCopyMs === undefined ? {} : { ffmpegStdoutCopyMs }),
    ...(ffmpegStdoutCopyMaxMs === undefined ? {} : { ffmpegStdoutCopyMaxMs }),
    ...(ffmpegStdoutFlushMs === undefined ? {} : { ffmpegStdoutFlushMs }),
    ...(ffmpegStdoutFlushMaxMs === undefined ? {} : { ffmpegStdoutFlushMaxMs }),
    ...(ffmpegStdoutPauseCount === undefined ? {} : { ffmpegStdoutPauseCount }),
    ...(ffmpegStdoutPausedMs === undefined ? {} : { ffmpegStdoutPausedMs }),
    ...(ffmpegStdoutPauseMaxMs === undefined ? {} : { ffmpegStdoutPauseMaxMs }),
    ...(pcmAllocationMs === undefined ? {} : { pcmAllocationMs }),
    ...(initialPcmAllocationMs === undefined ? {} : { initialPcmAllocationMs }),
    ...(growthPcmAllocationMs === undefined ? {} : { growthPcmAllocationMs }),
    ...(payloadFinalizationMs === undefined ? {} : { payloadFinalizationMs }),
    ...(transportRoute !== 'invoke' || preloadInvokeMs === undefined ? {} : { preloadInvokeMs }),
    ...(transportRoute !== 'invoke' || mainHandlerMs === undefined || preloadInvokeMs === undefined
      ? {}
      : { electronIpcResidualMs: Math.max(0, preloadInvokeMs - mainHandlerMs) }),
    ...(transportRoute !== 'invoke' || preloadInvokeMs === undefined
      ? {}
      : { contextBridgeResidualMs: Math.max(0, rendererBridgeCallMs - preloadInvokeMs) }),
    ...(streamChunkCount === undefined ? {} : { streamChunkCount }),
    ...(streamDispatchCopyMs === undefined ? {} : { streamDispatchCopyMs }),
    ...(streamDispatchPostMs === undefined ? {} : { streamDispatchPostMs }),
    ...(streamCreditAckCount === undefined ? {} : { streamCreditAckCount }),
    ...(streamCreditRoundTripMs === undefined ? {} : { streamCreditRoundTripMs }),
    ...(streamCreditRoundTripMaxMs === undefined ? {} : { streamCreditRoundTripMaxMs }),
    ...(streamTailMs === undefined ? {} : { streamTailMs }),
    ...(rendererPcmAssemblyAllocationMs === undefined ? {} : { rendererPcmAssemblyAllocationMs }),
    ...(rendererPcmAssemblyCopyMs === undefined ? {} : { rendererPcmAssemblyCopyMs }),
    ...(rendererPortRequestMs === undefined ? {} : { rendererPortRequestMs }),
    ...(transportRoute !== 'message_port_stream' || mainHandlerMs === undefined
      ? {}
      : {
          streamTransportResidualMs: Math.max(
            0,
            (rendererPortRequestMs ?? rendererBridgeCallMs) - mainHandlerMs
          )
        }),
  }
}

export function sumDiagnosticDurations(...values: readonly unknown[]): number {
  return values.reduce<number>((total, value) => {
    return total + (clampDiagnosticDurationMs(value) ?? 0)
  }, 0)
}
