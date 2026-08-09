import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  clampDiagnosticDurationMs,
  summarizePcmTransportTimings,
  sumDiagnosticDurations,
  type PcmTransportTimings,
} from './pcmTransportTimings.ts'

function makeTransportTimings(
  overrides: Partial<PcmTransportTimings> = {},
): PcmTransportTimings {
  return {
    decodeRequestId: 17,
    validPcmBytes: 1_024,
    backingBufferBytes: 2_048,
    allocationGrowthCount: 2,
    mainHandlerMs: 120,
    binaryResolutionMs: 3,
    probeMs: 12,
    probeCacheStatus: 'miss',
    probeDecodeOverlapEnabled: true,
    probeFfmpegOverlapMs: 8,
    ffmpegMs: 90,
    ffmpegOutputSink: 'stdout_pipe',
    ffmpegSpawnToFirstPcmMs: 20,
    ffmpegPcmOutputSpanMs: 65,
    ffmpegCloseTailMs: 5,
    ffmpegStdoutChunkCount: 3,
    ffmpegStdoutBytes: 1_024,
    ffmpegStdoutChunkMinBytes: 256,
    ffmpegStdoutChunkMaxBytes: 512,
    ffmpegStdoutDrainSpanMs: 67,
    ffmpegStdoutDrainToCloseMs: 3,
    ffmpegStdoutCallbackWorkMs: 9,
    ffmpegStdoutCallbackMaxMs: 4,
    ffmpegStdoutInterCallbackGapMs: 58,
    ffmpegStdoutInterCallbackGapMaxMs: 45,
    ffmpegStdoutPostDispatchGapCount: 2,
    ffmpegStdoutPostDispatchGapMs: 30,
    ffmpegStdoutPostDispatchGapMaxMs: 18,
    ffmpegStdoutCopyMs: 6,
    ffmpegStdoutCopyMaxMs: 3,
    ffmpegStdoutFlushMs: 2,
    ffmpegStdoutFlushMaxMs: 1,
    ffmpegStdoutPauseCount: 1,
    ffmpegStdoutPausedMs: 8,
    ffmpegStdoutPauseMaxMs: 8,
    streamCreditAckCount: 1,
    streamCreditRoundTripMs: 5,
    streamCreditRoundTripMaxMs: 5,
    allocationMs: 4,
    payloadFinalizationMs: 6,
    preloadInvokeMs: 155,
    ...overrides,
  }
}

test('PCM transport residuals reconcile process-local elapsed durations', () => {
  const summary = summarizePcmTransportTimings(makeTransportTimings(), 181)

  assert.equal(summary.electronIpcResidualMs, 35)
  assert.equal(summary.contextBridgeResidualMs, 26)
  assert.equal(summary.pcmAllocationMs, 4)
  assert.equal(summary.decodeRequestId, 17)
  assert.equal(summary.validPcmBytes, 1_024)
  assert.equal(summary.backingBufferBytes, 2_048)
  assert.equal(summary.probeCacheStatus, 'miss')
  assert.equal(summary.probeDecodeOverlapEnabled, true)
  assert.equal(summary.probeFfmpegOverlapMs, 8)
  assert.equal(summary.ffmpegOutputSink, 'stdout_pipe')
  assert.equal(summary.ffmpegSpawnToFirstPcmMs, 20)
  assert.equal(summary.ffmpegPcmOutputSpanMs, 65)
  assert.equal(summary.ffmpegCloseTailMs, 5)
  assert.equal(summary.ffmpegStdoutChunkCount, 3)
  assert.equal(summary.ffmpegStdoutBytes, 1_024)
  assert.equal(summary.ffmpegStdoutChunkMinBytes, 256)
  assert.equal(summary.ffmpegStdoutChunkMaxBytes, 512)
  assert.equal(summary.ffmpegStdoutDrainSpanMs, 67)
  assert.equal(summary.ffmpegStdoutDrainToCloseMs, 3)
  assert.equal(summary.ffmpegStdoutCallbackWorkMs, 9)
  assert.equal(summary.ffmpegStdoutCallbackMaxMs, 4)
  assert.equal(summary.ffmpegStdoutInterCallbackGapMs, 58)
  assert.equal(summary.ffmpegStdoutInterCallbackGapMaxMs, 45)
  assert.equal(summary.ffmpegStdoutPostDispatchGapCount, 2)
  assert.equal(summary.ffmpegStdoutPostDispatchGapMs, 30)
  assert.equal(summary.ffmpegStdoutPostDispatchGapMaxMs, 18)
  assert.equal(summary.ffmpegStdoutCopyMs, 6)
  assert.equal(summary.ffmpegStdoutCopyMaxMs, 3)
  assert.equal(summary.ffmpegStdoutFlushMs, 2)
  assert.equal(summary.ffmpegStdoutFlushMaxMs, 1)
  assert.equal(summary.ffmpegStdoutPauseCount, 1)
  assert.equal(summary.ffmpegStdoutPausedMs, 8)
  assert.equal(summary.ffmpegStdoutPauseMaxMs, 8)
  assert.equal(summary.streamCreditAckCount, 1)
  assert.equal(summary.streamCreditRoundTripMs, 5)
  assert.equal(summary.streamCreditRoundTripMaxMs, 5)
  assert.equal(
    summary.ffmpegMs,
    (summary.ffmpegSpawnToFirstPcmMs ?? 0)
      + (summary.ffmpegStdoutDrainSpanMs ?? 0)
      + (summary.ffmpegStdoutDrainToCloseMs ?? 0),
  )
  assert.equal(
    summary.ffmpegStdoutDrainSpanMs,
    (summary.ffmpegStdoutCallbackWorkMs ?? 0)
      + (summary.ffmpegStdoutInterCallbackGapMs ?? 0),
  )
})

test('temporary PCM sink timings propagate without becoming decoder work', () => {
  const summary = summarizePcmTransportTimings(makeTransportTimings({
    ffmpegOutputSink: 'temporary_file',
    tempPcmCreateMs: 1.5,
    tempPcmStatMs: 0.25,
    tempPcmReadMs: 14,
    tempPcmReadChunkCount: 11,
    tempPcmBytes: 1_024,
    tempPcmCleanupMs: 2.5,
    tempPcmCleanupSucceeded: false,
  }), 181)

  assert.equal(summary.ffmpegOutputSink, 'temporary_file')
  assert.equal(summary.tempPcmCreateMs, 1.5)
  assert.equal(summary.tempPcmStatMs, 0.25)
  assert.equal(summary.tempPcmReadMs, 14)
  assert.equal(summary.tempPcmReadChunkCount, 11)
  assert.equal(summary.tempPcmBytes, 1_024)
  assert.equal(summary.tempPcmCleanupMs, 2.5)
  assert.equal(summary.tempPcmCleanupSucceeded, false)
})

test('rechunked-pipe PCM sink survives diagnostics summarization', () => {
  const summary = summarizePcmTransportTimings(makeTransportTimings({
    ffmpegOutputSink: 'rechunked_pipe',
  }), 181)

  assert.equal(summary.ffmpegOutputSink, 'rechunked_pipe')
})

test('native-pipe capture timings propagate as bounded diagnostics', () => {
  const summary = summarizePcmTransportTimings(makeTransportTimings({
    ffmpegOutputSink: 'native_pipe',
    nativePcmCaptureSpawnMs: 4,
    nativePcmCaptureProcessMs: 80,
    nativePcmCaptureFirstByteMs: 15,
    nativePcmCaptureStdoutReadSpanMs: 60,
    nativePcmCaptureStdoutReadCount: 3,
    nativePcmCaptureStdoutReadMinBytes: 128,
    nativePcmCaptureStdoutReadMaxBytes: 512,
    nativePcmCaptureOutputBytes: 1_024,
    nativePcmCaptureRequestedPipeBufferBytes: 1_048_576,
    nativePcmCaptureEffectivePipeBufferBytes: 1_048_576,
    nativePcmCaptureBufferCopyMs: 0,
    nativePcmCaptureUsedExternalBuffer: false,
    nativePcmCaptureDeliveryMode: 'progress_batches',
    nativePcmCaptureBatchTargetBytes: 8 * 1024 * 1024,
    nativePcmCaptureBatchCount: 1,
    nativePcmCaptureBatchBytes: 1_024,
    nativePcmCaptureBatchMinBytes: 1_024,
    nativePcmCaptureBatchMaxBytes: 1_024,
    nativePcmCaptureBatchCreditWaitCount: 1,
    nativePcmCaptureBatchCreditWaitMs: 6,
    nativePcmCaptureBatchCreditWaitMaxMs: 6,
    nativePcmCaptureBatchCopyMs: 3,
    nativePcmCaptureBatchCopyMaxMs: 3,
    nativePcmCaptureBatchCallbackMs: 2,
    nativePcmCaptureBatchCallbackMaxMs: 2,
    nativePcmCaptureMainCopyMs: 1.5,
    nativePcmCaptureMainCopyMaxMs: 1.5,
    nativePcmCaptureFirstBatchMs: 15,
    nativePcmCaptureMainBatchSpanMs: 0,
  }), 181)

  assert.equal(summary.ffmpegOutputSink, 'native_pipe')
  assert.equal(summary.nativePcmCaptureSpawnMs, 4)
  assert.equal(summary.nativePcmCaptureProcessMs, 80)
  assert.equal(summary.nativePcmCaptureFirstByteMs, 15)
  assert.equal(summary.nativePcmCaptureStdoutReadSpanMs, 60)
  assert.equal(summary.nativePcmCaptureStdoutReadCount, 3)
  assert.equal(summary.nativePcmCaptureStdoutReadMinBytes, 128)
  assert.equal(summary.nativePcmCaptureStdoutReadMaxBytes, 512)
  assert.equal(summary.nativePcmCaptureOutputBytes, 1_024)
  assert.equal(summary.nativePcmCaptureRequestedPipeBufferBytes, 1_048_576)
  assert.equal(summary.nativePcmCaptureEffectivePipeBufferBytes, 1_048_576)
  assert.equal(summary.nativePcmCaptureBufferCopyMs, 0)
  assert.equal(summary.nativePcmCaptureUsedExternalBuffer, false)
  assert.equal(summary.nativePcmCaptureDeliveryMode, 'progress_batches')
  assert.equal(summary.nativePcmCaptureBatchTargetBytes, 8 * 1024 * 1024)
  assert.equal(summary.nativePcmCaptureBatchCount, 1)
  assert.equal(summary.nativePcmCaptureBatchBytes, 1_024)
  assert.equal(summary.nativePcmCaptureBatchMinBytes, 1_024)
  assert.equal(summary.nativePcmCaptureBatchMaxBytes, 1_024)
  assert.equal(summary.nativePcmCaptureBatchCreditWaitCount, 1)
  assert.equal(summary.nativePcmCaptureBatchCreditWaitMs, 6)
  assert.equal(summary.nativePcmCaptureBatchCreditWaitMaxMs, 6)
  assert.equal(summary.nativePcmCaptureBatchCopyMs, 3)
  assert.equal(summary.nativePcmCaptureBatchCopyMaxMs, 3)
  assert.equal(summary.nativePcmCaptureBatchCallbackMs, 2)
  assert.equal(summary.nativePcmCaptureBatchCallbackMaxMs, 2)
  assert.equal(summary.nativePcmCaptureMainCopyMs, 1.5)
  assert.equal(summary.nativePcmCaptureMainCopyMaxMs, 1.5)
  assert.equal(summary.nativePcmCaptureFirstBatchMs, 15)
  assert.equal(summary.nativePcmCaptureMainBatchSpanMs, 0)
})

test('preload-native timings expose their dedicated service and context-bridge spans', () => {
  const summary = summarizePcmTransportTimings(makeTransportTimings({
    transportRoute: 'preload_native',
    ffmpegOutputSink: 'preload_native',
    nativePcmCaptureProcessMs: 80,
    preloadNativeServiceMs: 80,
  }), 105)

  assert.equal(summary.transportRoute, 'preload_native')
  assert.equal(summary.ffmpegOutputSink, 'preload_native')
  assert.equal(summary.nativePcmCaptureProcessMs, 80)
  assert.equal(summary.preloadNativeServiceMs, 80)
  assert.equal(summary.preloadNativeContextBridgeResidualMs, 25)
  assert.equal(summary.preloadInvokeMs, undefined)
  assert.equal(summary.electronIpcResidualMs, undefined)
  assert.equal(summary.contextBridgeResidualMs, undefined)
  assert.equal(summary.streamTransportResidualMs, undefined)
})

test('preload-native context-bridge residual is bounded at zero', () => {
  const summary = summarizePcmTransportTimings(makeTransportTimings({
    transportRoute: 'preload_native',
    preloadNativeServiceMs: 120,
  }), 105)

  assert.equal(summary.preloadNativeContextBridgeResidualMs, 0)
})

test('worker-thread PCM sink timings propagate as bounded diagnostics', () => {
  const summary = summarizePcmTransportTimings(makeTransportTimings({
    ffmpegOutputSink: 'worker_thread',
    ffmpegWorkerStartupMs: 2,
    ffmpegWorkerTotalMs: 101,
    ffmpegWorkerSpawnMs: 3,
    ffmpegWorkerFfmpegMs: 90,
    ffmpegWorkerSpawnToFirstPcmMs: 20,
    ffmpegWorkerPcmOutputSpanMs: 65,
    ffmpegWorkerCloseTailMs: 5,
    ffmpegWorkerRequestMs: 105,
    ffmpegWorkerMainDeliverySpanMs: 83,
    ffmpegWorkerBatchCount: 9,
    ffmpegWorkerBatchBytes: 1_024,
    ffmpegWorkerBatchMinBytes: 64,
    ffmpegWorkerBatchMaxBytes: 128,
    ffmpegWorkerAggregationCopyMs: 7,
    ffmpegWorkerAggregationCopyMaxMs: 1.5,
    ffmpegWorkerBatchCopyMs: 7,
    ffmpegWorkerBatchPostMs: 0.75,
    ffmpegWorkerMainCopyMs: 5,
    ffmpegWorkerMainCopyMaxMs: 1,
    ffmpegWorkerCreditWaitCount: 3,
    ffmpegWorkerCreditWaitMs: 11,
    ffmpegWorkerCreditWaitMaxMs: 6,
  }), 181)

  assert.equal(summary.ffmpegOutputSink, 'worker_thread')
  assert.equal(summary.ffmpegWorkerStartupMs, 2)
  assert.equal(summary.ffmpegWorkerTotalMs, 101)
  assert.equal(summary.ffmpegWorkerSpawnMs, 3)
  assert.equal(summary.ffmpegWorkerFfmpegMs, 90)
  assert.equal(summary.ffmpegWorkerSpawnToFirstPcmMs, 20)
  assert.equal(summary.ffmpegWorkerPcmOutputSpanMs, 65)
  assert.equal(summary.ffmpegWorkerCloseTailMs, 5)
  assert.equal(summary.ffmpegWorkerRequestMs, 105)
  assert.equal(summary.ffmpegWorkerMainDeliverySpanMs, 83)
  assert.equal(summary.ffmpegWorkerBatchCount, 9)
  assert.equal(summary.ffmpegWorkerBatchBytes, 1_024)
  assert.equal(summary.ffmpegWorkerBatchMinBytes, 64)
  assert.equal(summary.ffmpegWorkerBatchMaxBytes, 128)
  assert.equal(summary.ffmpegWorkerAggregationCopyMs, 7)
  assert.equal(summary.ffmpegWorkerAggregationCopyMaxMs, 1.5)
  assert.equal(summary.ffmpegWorkerBatchCopyMs, 7)
  assert.equal(summary.ffmpegWorkerBatchPostMs, 0.75)
  assert.equal(summary.ffmpegWorkerMainCopyMs, 5)
  assert.equal(summary.ffmpegWorkerMainCopyMaxMs, 1)
  assert.equal(summary.ffmpegWorkerCreditWaitCount, 3)
  assert.equal(summary.ffmpegWorkerCreditWaitMs, 11)
  assert.equal(summary.ffmpegWorkerCreditWaitMaxMs, 6)
})

test('PCM transport residuals and invalid negative durations clamp to zero', () => {
  const summary = summarizePcmTransportTimings(makeTransportTimings({
    mainHandlerMs: 190,
    preloadInvokeMs: 150,
    allocationMs: -4,
    probeFfmpegOverlapMs: -3,
    ffmpegCloseTailMs: -2,
    ffmpegStdoutChunkCount: -2,
    ffmpegStdoutDrainSpanMs: -3,
    ffmpegStdoutPostDispatchGapCount: -2,
    ffmpegStdoutPostDispatchGapMs: -3,
    streamCreditAckCount: -2,
    streamCreditRoundTripMs: -3,
    tempPcmCreateMs: -1,
    tempPcmReadChunkCount: -2,
    tempPcmCleanupMs: -4,
    ffmpegWorkerStartupMs: -1,
    ffmpegWorkerTotalMs: -1,
    ffmpegWorkerBatchPostMs: -2,
    ffmpegWorkerBatchCount: -2,
    ffmpegWorkerAggregationCopyMs: -3,
    ffmpegWorkerCreditWaitCount: -4,
    ffmpegWorkerCreditWaitMs: -5,
  }), 140)

  assert.equal(summary.electronIpcResidualMs, 0)
  assert.equal(summary.contextBridgeResidualMs, 0)
  assert.equal(summary.pcmAllocationMs, 0)
  assert.equal(summary.probeFfmpegOverlapMs, 0)
  assert.equal(summary.ffmpegCloseTailMs, 0)
  assert.equal(summary.ffmpegStdoutChunkCount, 0)
  assert.equal(summary.ffmpegStdoutDrainSpanMs, 0)
  assert.equal(summary.ffmpegStdoutPostDispatchGapCount, 0)
  assert.equal(summary.ffmpegStdoutPostDispatchGapMs, 0)
  assert.equal(summary.streamCreditAckCount, 0)
  assert.equal(summary.streamCreditRoundTripMs, 0)
  assert.equal(summary.tempPcmCreateMs, 0)
  assert.equal(summary.tempPcmReadChunkCount, 0)
  assert.equal(summary.tempPcmCleanupMs, 0)
  assert.equal(summary.ffmpegWorkerStartupMs, 0)
  assert.equal(summary.ffmpegWorkerTotalMs, 0)
  assert.equal(summary.ffmpegWorkerBatchPostMs, 0)
  assert.equal(summary.ffmpegWorkerBatchCount, 0)
  assert.equal(summary.ffmpegWorkerAggregationCopyMs, 0)
  assert.equal(summary.ffmpegWorkerCreditWaitCount, 0)
  assert.equal(summary.ffmpegWorkerCreditWaitMs, 0)
  assert.equal(clampDiagnosticDurationMs(-10), 0)
  assert.equal(clampDiagnosticDurationMs(Number.NaN), undefined)
})

test('stream timings expose overlap-aware fields without inventing invoke residuals', () => {
  const summary = summarizePcmTransportTimings(makeTransportTimings({
    transportRoute: 'message_port_stream',
    mainHandlerMs: 150,
    preloadInvokeMs: 0,
    initialAllocationMs: 3,
    growthAllocationMs: 1,
    streamChunkCount: 9,
    streamDispatchCopyMs: 7,
    streamDispatchPostMs: 2,
    streamTailMs: 13,
    rendererPcmAssemblyAllocationMs: 1,
    rendererPcmAssemblyCopyMs: 6,
    rendererPortRequestMs: 177,
  }), 179)

  assert.equal(summary.transportRoute, 'message_port_stream')
  assert.equal(summary.preloadInvokeMs, undefined)
  assert.equal(summary.electronIpcResidualMs, undefined)
  assert.equal(summary.contextBridgeResidualMs, undefined)
  assert.equal(summary.initialPcmAllocationMs, 3)
  assert.equal(summary.growthPcmAllocationMs, 1)
  assert.equal(summary.streamChunkCount, 9)
  assert.equal(summary.rendererPcmAssemblyCopyMs, 6)
  assert.equal(summary.rendererPortRequestMs, 177)
  assert.equal(summary.streamTransportResidualMs, 27)
})

test('PCM transport summary remains useful when older bridge results omit metadata', () => {
  assert.deepEqual(summarizePcmTransportTimings(undefined, 22.5), {
    rendererBridgeCallMs: 22.5,
  })
  const legacy = makeTransportTimings({
    probeCacheStatus: undefined,
    probeDecodeOverlapEnabled: undefined,
    probeFfmpegOverlapMs: undefined,
    ffmpegSpawnToFirstPcmMs: undefined,
    ffmpegPcmOutputSpanMs: undefined,
    ffmpegCloseTailMs: undefined,
    ffmpegStdoutChunkCount: undefined,
    ffmpegStdoutBytes: undefined,
    ffmpegStdoutChunkMinBytes: undefined,
    ffmpegStdoutChunkMaxBytes: undefined,
    ffmpegStdoutDrainSpanMs: undefined,
    ffmpegStdoutDrainToCloseMs: undefined,
    ffmpegStdoutCallbackWorkMs: undefined,
    ffmpegStdoutCallbackMaxMs: undefined,
    ffmpegStdoutInterCallbackGapMs: undefined,
    ffmpegStdoutInterCallbackGapMaxMs: undefined,
    ffmpegStdoutPostDispatchGapCount: undefined,
    ffmpegStdoutPostDispatchGapMs: undefined,
    ffmpegStdoutPostDispatchGapMaxMs: undefined,
    ffmpegStdoutCopyMs: undefined,
    ffmpegStdoutCopyMaxMs: undefined,
    ffmpegStdoutFlushMs: undefined,
    ffmpegStdoutFlushMaxMs: undefined,
    ffmpegStdoutPauseCount: undefined,
    ffmpegStdoutPausedMs: undefined,
    ffmpegStdoutPauseMaxMs: undefined,
    streamCreditAckCount: undefined,
    streamCreditRoundTripMs: undefined,
    streamCreditRoundTripMaxMs: undefined,
    ffmpegOutputSink: undefined,
    tempPcmCreateMs: undefined,
    tempPcmStatMs: undefined,
    tempPcmReadMs: undefined,
    tempPcmReadChunkCount: undefined,
    tempPcmBytes: undefined,
    tempPcmCleanupMs: undefined,
    tempPcmCleanupSucceeded: undefined,
    ffmpegWorkerStartupMs: undefined,
    ffmpegWorkerTotalMs: undefined,
    ffmpegWorkerSpawnMs: undefined,
    ffmpegWorkerFfmpegMs: undefined,
    ffmpegWorkerSpawnToFirstPcmMs: undefined,
    ffmpegWorkerPcmOutputSpanMs: undefined,
    ffmpegWorkerCloseTailMs: undefined,
    ffmpegWorkerRequestMs: undefined,
    ffmpegWorkerMainDeliverySpanMs: undefined,
    ffmpegWorkerBatchCount: undefined,
    ffmpegWorkerBatchBytes: undefined,
    ffmpegWorkerBatchMinBytes: undefined,
    ffmpegWorkerBatchMaxBytes: undefined,
    ffmpegWorkerAggregationCopyMs: undefined,
    ffmpegWorkerAggregationCopyMaxMs: undefined,
    ffmpegWorkerBatchCopyMs: undefined,
    ffmpegWorkerBatchPostMs: undefined,
    ffmpegWorkerMainCopyMs: undefined,
    ffmpegWorkerMainCopyMaxMs: undefined,
    ffmpegWorkerCreditWaitCount: undefined,
    ffmpegWorkerCreditWaitMs: undefined,
    ffmpegWorkerCreditWaitMaxMs: undefined,
  })
  const summary = summarizePcmTransportTimings(legacy, 181)
  assert.equal(summary.probeCacheStatus, undefined)
  assert.equal(summary.probeDecodeOverlapEnabled, undefined)
  assert.equal(summary.probeFfmpegOverlapMs, undefined)
  assert.equal(summary.ffmpegSpawnToFirstPcmMs, undefined)
  assert.equal(summary.ffmpegStdoutChunkCount, undefined)
  assert.equal(summary.ffmpegStdoutBytes, undefined)
  assert.equal(summary.ffmpegStdoutChunkMinBytes, undefined)
  assert.equal(summary.ffmpegStdoutChunkMaxBytes, undefined)
  assert.equal(summary.ffmpegStdoutDrainSpanMs, undefined)
  assert.equal(summary.ffmpegStdoutDrainToCloseMs, undefined)
  assert.equal(summary.ffmpegStdoutCallbackWorkMs, undefined)
  assert.equal(summary.ffmpegStdoutCallbackMaxMs, undefined)
  assert.equal(summary.ffmpegStdoutInterCallbackGapMs, undefined)
  assert.equal(summary.ffmpegStdoutInterCallbackGapMaxMs, undefined)
  assert.equal(summary.ffmpegStdoutPostDispatchGapCount, undefined)
  assert.equal(summary.ffmpegStdoutPostDispatchGapMs, undefined)
  assert.equal(summary.ffmpegStdoutPostDispatchGapMaxMs, undefined)
  assert.equal(summary.ffmpegStdoutCopyMs, undefined)
  assert.equal(summary.ffmpegStdoutCopyMaxMs, undefined)
  assert.equal(summary.ffmpegStdoutFlushMs, undefined)
  assert.equal(summary.ffmpegStdoutFlushMaxMs, undefined)
  assert.equal(summary.ffmpegStdoutPauseCount, undefined)
  assert.equal(summary.ffmpegStdoutPausedMs, undefined)
  assert.equal(summary.ffmpegStdoutPauseMaxMs, undefined)
  assert.equal(summary.streamCreditAckCount, undefined)
  assert.equal(summary.streamCreditRoundTripMs, undefined)
  assert.equal(summary.streamCreditRoundTripMaxMs, undefined)
  assert.equal(summary.ffmpegOutputSink, undefined)
  assert.equal(summary.tempPcmCreateMs, undefined)
  assert.equal(summary.tempPcmStatMs, undefined)
  assert.equal(summary.tempPcmReadMs, undefined)
  assert.equal(summary.tempPcmReadChunkCount, undefined)
  assert.equal(summary.tempPcmBytes, undefined)
  assert.equal(summary.tempPcmCleanupMs, undefined)
  assert.equal(summary.tempPcmCleanupSucceeded, undefined)
  assert.equal(summary.ffmpegWorkerStartupMs, undefined)
  assert.equal(summary.ffmpegWorkerTotalMs, undefined)
  assert.equal(summary.ffmpegWorkerFfmpegMs, undefined)
  assert.equal(summary.ffmpegWorkerBatchPostMs, undefined)
  assert.equal(summary.ffmpegWorkerRequestMs, undefined)
  assert.equal(summary.ffmpegWorkerMainDeliverySpanMs, undefined)
  assert.equal(summary.ffmpegWorkerBatchCount, undefined)
  assert.equal(summary.ffmpegWorkerBatchBytes, undefined)
  assert.equal(summary.ffmpegWorkerAggregationCopyMs, undefined)
  assert.equal(summary.ffmpegWorkerMainCopyMs, undefined)
  assert.equal(summary.ffmpegWorkerCreditWaitMs, undefined)
  assert.equal(sumDiagnosticDurations(2, -4, Number.NaN, 3.5), 5.5)
})
