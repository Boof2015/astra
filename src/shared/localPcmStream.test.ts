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
