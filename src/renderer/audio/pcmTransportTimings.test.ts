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
    ffmpegSpawnToFirstPcmMs: 20,
    ffmpegPcmOutputSpanMs: 65,
    ffmpegCloseTailMs: 5,
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
  assert.equal(summary.ffmpegSpawnToFirstPcmMs, 20)
  assert.equal(summary.ffmpegPcmOutputSpanMs, 65)
  assert.equal(summary.ffmpegCloseTailMs, 5)
})

test('PCM transport residuals and invalid negative durations clamp to zero', () => {
  const summary = summarizePcmTransportTimings(makeTransportTimings({
    mainHandlerMs: 190,
    preloadInvokeMs: 150,
    allocationMs: -4,
    probeFfmpegOverlapMs: -3,
    ffmpegCloseTailMs: -2,
  }), 140)

  assert.equal(summary.electronIpcResidualMs, 0)
  assert.equal(summary.contextBridgeResidualMs, 0)
  assert.equal(summary.pcmAllocationMs, 0)
  assert.equal(summary.probeFfmpegOverlapMs, 0)
  assert.equal(summary.ffmpegCloseTailMs, 0)
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
  })
  const summary = summarizePcmTransportTimings(legacy, 181)
  assert.equal(summary.probeCacheStatus, undefined)
  assert.equal(summary.probeDecodeOverlapEnabled, undefined)
  assert.equal(summary.probeFfmpegOverlapMs, undefined)
  assert.equal(summary.ffmpegSpawnToFirstPcmMs, undefined)
  assert.equal(sumDiagnosticDurations(2, -4, Number.NaN, 3.5), 5.5)
})
