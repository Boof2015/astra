import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LOCAL_PCM_STREAM_CHUNK_BYTES,
  LOCAL_PCM_STREAM_INITIAL_CREDITS,
  LOCAL_PCM_STREAM_MARKER,
  LOCAL_PCM_STREAM_MAX_BYTES,
  LOCAL_PCM_STREAM_VERSION,
  isLocalPcmStreamMainMessage,
  isLocalPcmStreamPortEnvelope,
  isLocalPcmStreamRendererMessage,
  validateLocalPcmStreamOpenRequest,
  type LocalPcmStreamMainTransportTimings,
} from './localPcmStream.ts'

const base = {
  version: LOCAL_PCM_STREAM_VERSION,
  requestId: 17,
  nonce: 'stream_nonce_17',
} as const

function makeMainTimings(
  overrides: Partial<LocalPcmStreamMainTransportTimings> = {},
): LocalPcmStreamMainTransportTimings {
  return {
    decodeRequestId: 17,
    validPcmBytes: 16,
    backingBufferBytes: 32,
    allocationGrowthCount: 0,
    transportRoute: 'message_port_stream',
    mainHandlerMs: 30,
    binaryResolutionMs: 1,
    probeMs: 2,
    probeCacheStatus: 'miss',
    probeDecodeOverlapEnabled: true,
    probeFfmpegOverlapMs: 8,
    ffmpegMs: 20,
    ffmpegOutputSink: 'stdout_pipe',
    ffmpegSpawnToFirstPcmMs: 4,
    ffmpegPcmOutputSpanMs: 12,
    ffmpegCloseTailMs: 4,
    ffmpegStdoutChunkCount: 3,
    ffmpegStdoutBytes: 16,
    ffmpegStdoutChunkMinBytes: 4,
    ffmpegStdoutChunkMaxBytes: 8,
    ffmpegStdoutDrainSpanMs: 14,
    ffmpegStdoutDrainToCloseMs: 2,
    ffmpegStdoutCallbackWorkMs: 6,
    ffmpegStdoutCallbackMaxMs: 3,
    ffmpegStdoutInterCallbackGapMs: 8,
    ffmpegStdoutInterCallbackGapMaxMs: 5,
    ffmpegStdoutPostDispatchGapCount: 1,
    ffmpegStdoutPostDispatchGapMs: 5,
    ffmpegStdoutPostDispatchGapMaxMs: 5,
    ffmpegStdoutCopyMs: 4,
    ffmpegStdoutCopyMaxMs: 2,
    ffmpegStdoutFlushMs: 2,
    ffmpegStdoutFlushMaxMs: 1,
    ffmpegStdoutPauseCount: 1,
    ffmpegStdoutPausedMs: 8,
    ffmpegStdoutPauseMaxMs: 8,
    allocationMs: 0,
    initialAllocationMs: 0,
    growthAllocationMs: 0,
    payloadFinalizationMs: 0,
    preloadInvokeMs: 0,
    streamChunkCount: 1,
    streamDispatchCopyMs: 3,
    streamDispatchPostMs: 4,
    streamTailMs: 5,
    streamCreditAckCount: 1,
    streamCreditRoundTripMs: 5,
    streamCreditRoundTripMaxMs: 5,
    ...overrides,
  }
}

test('validates bounded PCM stream open requests and transferred-port envelopes', () => {
  assert.equal(validateLocalPcmStreamOpenRequest({
    requestId: 17,
    filePath: 'C:\\Music\\track.flac',
    outputSampleRate: 48_000,
    expectedChannels: 2,
    priority: 'interactive',
    nonce: base.nonce,
  }), true)

  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    // New timing fields are additive; older stream envelopes remain valid.
    transportTimings: makeMainTimings({
      probeCacheStatus: undefined,
      probeDecodeOverlapEnabled: undefined,
      probeFfmpegOverlapMs: undefined,
      ffmpegOutputSink: undefined,
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
    }),
  }), true)
  assert.equal(isLocalPcmStreamPortEnvelope({
    ...base,
    marker: LOCAL_PCM_STREAM_MARKER,
  }), true)

  assert.equal(validateLocalPcmStreamOpenRequest({
    requestId: -1,
    filePath: '',
    outputSampleRate: 1,
    expectedChannels: 9,
    priority: 'urgent',
    nonce: 'bad nonce',
  }), false)
  assert.equal(isLocalPcmStreamPortEnvelope({
    ...base,
    version: LOCAL_PCM_STREAM_VERSION + 1,
    marker: LOCAL_PCM_STREAM_MARKER,
  }), false)
})

test('validates exact renderer credit protocol fields', () => {
  assert.equal(isLocalPcmStreamRendererMessage({
    ...base,
    type: 'ready',
    credits: LOCAL_PCM_STREAM_INITIAL_CREDITS,
  }), true)
  assert.equal(isLocalPcmStreamRendererMessage({
    ...base,
    type: 'credit',
    sequence: 3,
    credits: 1,
  }), true)
  assert.equal(isLocalPcmStreamRendererMessage({
    ...base,
    type: 'credit',
    sequence: 3,
    credits: 2,
  }), false)
})

test('validates bounded chunks, resize messages, and complete metadata', () => {
  const payload = new ArrayBuffer(16)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'start',
    sampleRate: 48_000,
    channels: 2,
    backingBufferBytes: 32,
  }), true)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'resize',
    backingBufferBytes: 64,
  }), true)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'chunk',
    sequence: 0,
    byteOffset: 0,
    byteLength: payload.byteLength,
    payload,
  }), true)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({
      benchmarkMainGenerationMs: 6,
      benchmarkMainFillMs: 4,
      ffmpegOutputSink: 'temporary_file',
      tempPcmCreateMs: 1,
      tempPcmStatMs: 2,
      tempPcmReadMs: 3,
      tempPcmReadChunkCount: 1,
      tempPcmBytes: 16,
      tempPcmCleanupMs: 4,
      tempPcmCleanupSucceeded: true,
    }),
  }), true)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({
      ffmpegOutputSink: 'worker_thread',
      ffmpegWorkerStartupMs: 1,
      ffmpegWorkerTotalMs: 23,
      ffmpegWorkerSpawnMs: 1,
      ffmpegWorkerFfmpegMs: 20,
      ffmpegWorkerSpawnToFirstPcmMs: 4,
      ffmpegWorkerPcmOutputSpanMs: 14,
      ffmpegWorkerCloseTailMs: 2,
      ffmpegWorkerRequestMs: 24,
      ffmpegWorkerMainDeliverySpanMs: 18,
      ffmpegWorkerBatchCount: 2,
      ffmpegWorkerBatchBytes: 16,
      ffmpegWorkerBatchMinBytes: 8,
      ffmpegWorkerBatchMaxBytes: 8,
      ffmpegWorkerAggregationCopyMs: 2,
      ffmpegWorkerAggregationCopyMaxMs: 1.25,
      ffmpegWorkerBatchCopyMs: 2,
      ffmpegWorkerBatchPostMs: 0.5,
      ffmpegWorkerMainCopyMs: 1,
      ffmpegWorkerMainCopyMaxMs: 0.75,
      ffmpegWorkerCreditWaitCount: 1,
      ffmpegWorkerCreditWaitMs: 3,
      ffmpegWorkerCreditWaitMaxMs: 3,
    }),
  }), true)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({
      ffmpegOutputSink: 'rechunked_pipe',
    }),
  }), true)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({
      ffmpegOutputSink: 'native_pipe',
      nativePcmCaptureSpawnMs: 3,
      nativePcmCaptureProcessMs: 20,
      nativePcmCaptureFirstByteMs: 5,
      nativePcmCaptureStdoutReadSpanMs: 13,
      nativePcmCaptureStdoutReadCount: 2,
      nativePcmCaptureStdoutReadMinBytes: 8,
      nativePcmCaptureStdoutReadMaxBytes: 8,
      nativePcmCaptureOutputBytes: 16,
      nativePcmCaptureRequestedPipeBufferBytes: 1024 * 1024,
      nativePcmCaptureEffectivePipeBufferBytes: 1024 * 1024,
      nativePcmCaptureBufferCopyMs: 0,
      nativePcmCaptureUsedExternalBuffer: false,
      nativePcmCaptureDeliveryMode: 'progress_batches',
      nativePcmCaptureBatchTargetBytes: LOCAL_PCM_STREAM_CHUNK_BYTES,
      nativePcmCaptureBatchCount: 1,
      nativePcmCaptureBatchBytes: 16,
      nativePcmCaptureBatchMinBytes: 16,
      nativePcmCaptureBatchMaxBytes: 16,
      nativePcmCaptureBatchCreditWaitCount: 1,
      nativePcmCaptureBatchCreditWaitMs: 2,
      nativePcmCaptureBatchCreditWaitMaxMs: 2,
      nativePcmCaptureBatchCopyMs: 1,
      nativePcmCaptureBatchCopyMaxMs: 1,
      nativePcmCaptureBatchCallbackMs: 0.5,
      nativePcmCaptureBatchCallbackMaxMs: 0.5,
      nativePcmCaptureMainCopyMs: 0.25,
      nativePcmCaptureMainCopyMaxMs: 0.25,
      nativePcmCaptureFirstBatchMs: 5,
      nativePcmCaptureMainBatchSpanMs: 0,
    }),
  }), true)

  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'chunk',
    sequence: 0,
    byteOffset: 0,
    byteLength: LOCAL_PCM_STREAM_CHUNK_BYTES + 4,
    payload: new ArrayBuffer(4),
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'resize',
    backingBufferBytes: LOCAL_PCM_STREAM_MAX_BYTES + 1,
  }), false)
})

test('rejects malformed terminal messages and timing metadata', () => {
  const completeWithTimings = (transportTimings: unknown) => ({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings,
  })

  assert.equal(isLocalPcmStreamMainMessage(completeWithTimings({
    ...makeMainTimings(),
    ffmpegOutputSink: 'memory_map',
  })), false)
  assert.equal(isLocalPcmStreamMainMessage(completeWithTimings(
    makeMainTimings({ tempPcmReadMs: -1 }),
  )), false)
  assert.equal(isLocalPcmStreamMainMessage(completeWithTimings(
    makeMainTimings({
      ffmpegOutputSink: 'native_pipe',
      nativePcmCaptureBufferCopyMs: 1,
      nativePcmCaptureUsedExternalBuffer: true,
    }),
  )), false)
  assert.equal(isLocalPcmStreamMainMessage(completeWithTimings(
    makeMainTimings({ tempPcmReadChunkCount: 1.5 }),
  )), false)
  assert.equal(isLocalPcmStreamMainMessage(completeWithTimings(
    makeMainTimings({ tempPcmBytes: Number.MAX_SAFE_INTEGER + 1 }),
  )), false)
  assert.equal(isLocalPcmStreamMainMessage(completeWithTimings({
    ...makeMainTimings(),
    tempPcmCleanupSucceeded: 'yes',
  })), false)
  assert.equal(isLocalPcmStreamMainMessage(completeWithTimings(
    makeMainTimings({
      ffmpegOutputSink: 'worker_thread',
      ffmpegWorkerTotalMs: 10,
      ffmpegWorkerFfmpegMs: 11,
    }),
  )), false)
  assert.equal(isLocalPcmStreamMainMessage(completeWithTimings(
    makeMainTimings({
      ffmpegOutputSink: 'native_pipe',
      nativePcmCaptureProcessMs: 10,
      nativePcmCaptureFirstByteMs: 11,
    }),
  )), false)
  assert.equal(isLocalPcmStreamMainMessage(completeWithTimings(
    makeMainTimings({
      ffmpegOutputSink: 'native_pipe',
      nativePcmCaptureStdoutReadMinBytes: 17,
      nativePcmCaptureStdoutReadMaxBytes: 16,
      nativePcmCaptureOutputBytes: 16,
    }),
  )), false)
  assert.equal(isLocalPcmStreamMainMessage(completeWithTimings(
    makeMainTimings({
      ffmpegOutputSink: 'native_pipe',
      nativePcmCaptureOutputBytes: 15,
    }),
  )), false)
  assert.equal(isLocalPcmStreamMainMessage(completeWithTimings(
    makeMainTimings({
      ffmpegOutputSink: 'worker_thread',
      ffmpegWorkerRequestMs: 10,
      ffmpegWorkerMainDeliverySpanMs: 11,
    }),
  )), false)
  assert.equal(isLocalPcmStreamMainMessage(completeWithTimings(
    makeMainTimings({
      ffmpegOutputSink: 'worker_thread',
      ffmpegWorkerBatchBytes: 15,
    }),
  )), false)
  assert.equal(isLocalPcmStreamMainMessage(completeWithTimings(
    makeMainTimings({
      ffmpegOutputSink: 'worker_thread',
      ffmpegWorkerAggregationCopyMs: 1,
      ffmpegWorkerAggregationCopyMaxMs: 2,
    }),
  )), false)
  assert.equal(isLocalPcmStreamMainMessage(completeWithTimings(
    makeMainTimings({
      ffmpegOutputSink: 'worker_thread',
      ffmpegWorkerCreditWaitMs: -1,
    }),
  )), false)

  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({ streamTailMs: -1 }),
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({ benchmarkMainFillMs: -1 }),
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: {
      ...makeMainTimings(),
      probeCacheStatus: 'stale',
    },
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({ ffmpegSpawnToFirstPcmMs: -1 }),
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({ probeFfmpegOverlapMs: -1 }),
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({ ffmpegStdoutChunkCount: -1 }),
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({ ffmpegStdoutDrainSpanMs: -1 }),
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({ ffmpegStdoutPostDispatchGapCount: -1 }),
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({ ffmpegStdoutPostDispatchGapMs: -1 }),
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({ streamCreditAckCount: -1 }),
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({ streamCreditRoundTripMs: -1 }),
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({
      streamCreditRoundTripMs: 4,
      streamCreditRoundTripMaxMs: 5,
    }),
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({
      ffmpegStdoutPostDispatchGapMs: 4,
      ffmpegStdoutPostDispatchGapMaxMs: 5,
    }),
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({
      ffmpegStdoutChunkMinBytes: 9,
      ffmpegStdoutChunkMaxBytes: 8,
    }),
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: {
      ...makeMainTimings(),
      probeDecodeOverlapEnabled: 'yes',
    },
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: makeMainTimings({ validPcmBytes: 12 }),
  }), false)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'error',
    kind: 'decode',
    code: 'ffmpeg_failed',
    message: 'FFmpeg exited unsuccessfully.',
  }), true)
  assert.equal(isLocalPcmStreamMainMessage({
    ...base,
    type: 'error',
    kind: 'unknown',
    code: '',
    message: '',
  }), false)
})
