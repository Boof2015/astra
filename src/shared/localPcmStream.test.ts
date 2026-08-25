import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LOCAL_PCM_DECODE_LIMIT_EXCEEDED_CODE,
  LOCAL_PCM_STREAM_CHUNK_BYTES,
  LOCAL_PCM_STREAM_INITIAL_CREDITS,
  LOCAL_PCM_STREAM_MARKER,
  LOCAL_PCM_STREAM_MAX_BYTES,
  LOCAL_PCM_STREAM_VERSION,
  LOCAL_PCM_WAVEFORM_RESOLUTION,
  STATIC_TRACK_WAVEFORM_RESULT_VERSION,
  isLocalPcmDecodeLimitRefusal,
  isLocalPcmStreamMainMessage,
  isLocalPcmStreamPortEnvelope,
  isLocalPcmStreamRendererMessage,
  isStaticTrackWaveformResult,
  validateLocalPcmStreamOpenRequest,
  type LocalPcmStreamMainTransportTimings,
} from './localPcmStream.ts'

const base = {
  version: LOCAL_PCM_STREAM_VERSION,
  requestId: 17,
  nonce: 'stream_nonce_17',
} as const

test('validates the structured complete-PCM size-limit refusal', () => {
  assert.equal(isLocalPcmDecodeLimitRefusal({
    refused: true,
    code: LOCAL_PCM_DECODE_LIMIT_EXCEEDED_CODE,
    message: 'Decoded audio exceeds the 192 MiB Standard playback limit.'
  }), true)
  assert.equal(isLocalPcmDecodeLimitRefusal({
    refused: true,
    code: 'PCM_DECODE_FAILED',
    message: 'generic failure'
  }), false)
})

test('validates independent late static-waveform results', () => {
  const waveformData = new Float32Array(LOCAL_PCM_WAVEFORM_RESOLUTION).fill(0.5).buffer
  assert.equal(isStaticTrackWaveformResult({
    version: STATIC_TRACK_WAVEFORM_RESULT_VERSION,
    status: 'ready',
    requestId: 17,
    trackPath: '/music/track.flac',
    waveformData,
    waveformAnalysisMs: 2.5,
  }), true)
  assert.equal(isStaticTrackWaveformResult({
    version: STATIC_TRACK_WAVEFORM_RESULT_VERSION,
    status: 'failed',
    requestId: 17,
    trackPath: '/music/track.flac',
    waveformAnalysisMs: 0.1,
    failureKind: 'unavailable',
  }), true)
  assert.equal(isStaticTrackWaveformResult({
    version: STATIC_TRACK_WAVEFORM_RESULT_VERSION,
    status: 'ready',
    requestId: 17,
    trackPath: '/music/track.flac',
    waveformData: new ArrayBuffer(16),
    waveformAnalysisMs: 2.5,
  }), false)
  assert.equal(isStaticTrackWaveformResult({
    version: STATIC_TRACK_WAVEFORM_RESULT_VERSION,
    status: 'failed',
    requestId: 17,
    trackPath: '/music/track.flac',
    waveformAnalysisMs: -1,
    failureKind: 'analysis_failed',
  }), false)
})

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
    ffmpegMs: 20,
    allocationMs: 0,
    initialAllocationMs: 0,
    growthAllocationMs: 0,
    payloadFinalizationMs: 0,
    preloadInvokeMs: 0,
    streamChunkCount: 1,
    streamDispatchCopyMs: 3,
    streamDispatchPostMs: 4,
    streamTailMs: 5,
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
