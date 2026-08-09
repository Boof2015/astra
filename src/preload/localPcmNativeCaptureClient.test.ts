import assert from 'node:assert/strict'
import test from 'node:test'
import { LOCAL_PCM_STREAM_MAX_BYTES } from '../shared/localPcmStream.ts'
import {
  PreloadLocalPcmNativeCaptureCancelledError,
  PreloadLocalPcmNativeCaptureClient,
  validatePreloadLocalPcmNativeCaptureInput,
  type PreloadLocalPcmNativeCaptureBackend,
  type PreloadLocalPcmNativeCaptureInput
} from './localPcmNativeCaptureClient.ts'
import type {
  LocalPcmNativeCaptureCapabilities,
  LocalPcmNativeCaptureRequest,
  LocalPcmNativeCaptureResult
} from '../main/localPcmNativeCaptureClient.ts'

const input: PreloadLocalPcmNativeCaptureInput = {
  requestId: 17,
  filePath: 'C:\\Music\\track.flac',
  outputSampleRate: 48_000,
  priority: 'interactive'
}

const capabilities: LocalPcmNativeCaptureCapabilities = {
  supported: true,
  reason: null,
  maxPcmBytes: LOCAL_PCM_STREAM_MAX_BYTES,
  supportsProgressBatches: true,
  progressBatchBytes: 8 * 1024 * 1024,
  progressMaxInFlightBatches: 2
}

function makeResult(
  jobId: string,
  overrides: Partial<LocalPcmNativeCaptureResult> = {}
): LocalPcmNativeCaptureResult {
  return {
    ok: true,
    jobId,
    deliveryMode: 'complete_buffer',
    pcm: Buffer.alloc(64),
    stderr: '',
    stderrTruncated: false,
    exitCode: 0,
    processId: 123,
    cancelled: false,
    errorCode: null,
    errorMessage: null,
    windowsErrorCode: null,
    outputBytes: 64,
    stdoutReadCount: 1,
    stdoutReadMinBytes: 64,
    stdoutReadMaxBytes: 64,
    requestedPipeBufferBytes: 1024 * 1024,
    effectivePipeBufferBytes: 1024 * 1024,
    bufferCopyMs: 0,
    usedExternalBuffer: true,
    spawnMs: 3,
    firstByteMs: 10,
    stdoutReadSpanMs: 20,
    processMs: 35,
    batchTargetBytes: 8 * 1024 * 1024,
    batchCount: 0,
    batchBytes: 0,
    batchMinBytes: null,
    batchMaxBytes: null,
    batchCreditWaitCount: 0,
    batchCreditWaitMs: 0,
    batchCreditWaitMaxMs: 0,
    batchCopyMs: 0,
    batchCopyMaxMs: 0,
    batchCallbackMs: 0,
    batchCallbackMaxMs: 0,
    ...overrides
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function makeBackend(
  overrides: Partial<PreloadLocalPcmNativeCaptureBackend> = {}
): PreloadLocalPcmNativeCaptureBackend {
  return {
    getCapabilities: () => capabilities,
    capture: async (request) => makeResult(request.jobId),
    cancel: () => true,
    cancelAll: () => 0,
    getActiveProcessIds: () => [],
    ...overrides
  }
}

test('accepts only the exact foreground logical request', () => {
  assert.equal(validatePreloadLocalPcmNativeCaptureInput(input), true)
  assert.equal(validatePreloadLocalPcmNativeCaptureInput({ ...input, priority: 'background' }), false)
  assert.equal(validatePreloadLocalPcmNativeCaptureInput({ ...input, ffmpegPath: 'other.exe' }), false)
  assert.equal(validatePreloadLocalPcmNativeCaptureInput({ ...input, args: ['-version'] }), false)
  assert.equal(validatePreloadLocalPcmNativeCaptureInput({ ...input, requestId: -1 }), false)
  assert.equal(validatePreloadLocalPcmNativeCaptureInput({ ...input, outputSampleRate: 7_999 }), false)
  assert.equal(validatePreloadLocalPcmNativeCaptureInput({ ...input, outputSampleRate: 384_001 }), false)
  assert.equal(validatePreloadLocalPcmNativeCaptureInput({ ...input, filePath: 'bad\0path' }), false)
})

test('builds one fixed complete-buffer FFmpeg request internally', async () => {
  let observed: LocalPcmNativeCaptureRequest | null = null
  const client = new PreloadLocalPcmNativeCaptureClient({
    nativeClient: makeBackend({
      capture: async (request) => {
        observed = request
        return makeResult(request.jobId)
      }
    }),
    resolveFfmpegPath: async () => 'C:\\Astra\\ffmpeg.exe',
    createJobId: () => 'fixed-id'
  })

  const result = await client.capture(input)
  assert.equal(result.jobId, 'preload:17:fixed-id')
  assert.deepEqual(observed, {
    jobId: 'preload:17:fixed-id',
    slotId: 'local-pcm-preload-foreground',
    ffmpegPath: 'C:\\Astra\\ffmpeg.exe',
    deliveryMode: 'complete_buffer',
    args: [
      '-v', 'error',
      '-nostdin',
      '-i', 'C:\\Music\\track.flac',
      '-map', '0:a:0',
      '-vn',
      '-acodec', 'pcm_f32le',
      '-f', 'f32le',
      '-ar', '48000',
      'pipe:1'
    ]
  })
})

test('ensureReady loads and caches the addon capabilities and private FFmpeg path', async () => {
  let capabilityCalls = 0
  let resolverCalls = 0
  const client = new PreloadLocalPcmNativeCaptureClient({
    nativeClient: makeBackend({
      getCapabilities: () => {
        capabilityCalls += 1
        return capabilities
      }
    }),
    resolveFfmpegPath: async () => {
      resolverCalls += 1
      return 'ffmpeg.exe'
    }
  })

  assert.deepEqual(await client.ensureReady(), capabilities)
  assert.deepEqual(await client.ensureReady(), capabilities)
  await client.capture(input)
  assert.equal(capabilityCalls, 1)
  assert.equal(resolverCalls, 1)
})

test('rejects unsupported, mismatched-limit, and unresolved setups before native dispatch', async () => {
  let captureCalls = 0
  const capture = async (request: LocalPcmNativeCaptureRequest) => {
    captureCalls += 1
    return makeResult(request.jobId)
  }

  const unsupported = new PreloadLocalPcmNativeCaptureClient({
    nativeClient: makeBackend({
      getCapabilities: () => ({ ...capabilities, supported: false, reason: 'not supported' }),
      capture
    }),
    resolveFfmpegPath: async () => 'ffmpeg.exe'
  })
  await assert.rejects(unsupported.capture(input), /not supported/)

  const wrongLimit = new PreloadLocalPcmNativeCaptureClient({
    nativeClient: makeBackend({
      getCapabilities: () => ({ ...capabilities, maxPcmBytes: 1 }),
      capture
    }),
    resolveFfmpegPath: async () => 'ffmpeg.exe'
  })
  await assert.rejects(wrongLimit.capture(input), /limit does not match/)

  const unresolved = new PreloadLocalPcmNativeCaptureClient({
    nativeClient: makeBackend({ capture }),
    resolveFfmpegPath: async () => null
  })
  await assert.rejects(unresolved.capture(input), /could not be resolved/)
  assert.equal(captureCalls, 0)
})

test('cancellation during private FFmpeg resolution prevents stale native dispatch', async () => {
  const resolution = deferred<string | null>()
  let captureCalls = 0
  const client = new PreloadLocalPcmNativeCaptureClient({
    nativeClient: makeBackend({
      capture: async (request) => {
        captureCalls += 1
        return makeResult(request.jobId)
      }
    }),
    resolveFfmpegPath: () => resolution.promise,
    createJobId: () => 'pending'
  })

  const pending = client.capture(input)
  assert.equal(client.cancel(input.requestId), true)
  resolution.resolve('ffmpeg.exe')
  await assert.rejects(pending, PreloadLocalPcmNativeCaptureCancelledError)
  assert.equal(captureCalls, 0)
})

test('a newer foreground request supersedes a pending request without a stale start', async () => {
  const resolution = deferred<string | null>()
  const dispatched: LocalPcmNativeCaptureRequest[] = []
  const ids = ['first', 'second']
  const client = new PreloadLocalPcmNativeCaptureClient({
    nativeClient: makeBackend({
      capture: async (request) => {
        dispatched.push(request)
        return makeResult(request.jobId)
      }
    }),
    resolveFfmpegPath: () => resolution.promise,
    createJobId: () => ids.shift() ?? 'unexpected'
  })

  const first = client.capture(input)
  const second = client.capture({ ...input, requestId: 18 })
  resolution.resolve('ffmpeg.exe')

  await assert.rejects(first, PreloadLocalPcmNativeCaptureCancelledError)
  assert.equal((await second).jobId, 'preload:18:second')
  assert.deepEqual(dispatched.map((request) => request.jobId), ['preload:18:second'])
})

test('maps dispatched cancellation by logical request and exposes lifecycle hooks', async () => {
  const completion = deferred<LocalPcmNativeCaptureResult>()
  const cancelledJobs: string[] = []
  let cancelAllCalls = 0
  const client = new PreloadLocalPcmNativeCaptureClient({
    nativeClient: makeBackend({
      capture: (request) => completion.promise.then((result) => ({ ...result, jobId: request.jobId })),
      cancel: (jobId) => {
        cancelledJobs.push(jobId)
        return true
      },
      cancelAll: () => {
        cancelAllCalls += 1
        return 1
      },
      getActiveProcessIds: () => [321, 654]
    }),
    resolveFfmpegPath: async () => 'ffmpeg.exe',
    createJobId: () => 'active'
  })

  const pending = client.capture(input)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(client.cancel(input.requestId), true)
  assert.deepEqual(cancelledJobs, ['preload:17:active'])
  assert.deepEqual(client.getActiveProcessIds(), [321, 654])
  assert.equal(client.cancelAll(), 1)
  assert.equal(cancelAllCalls, 1)

  completion.resolve(makeResult('ignored', {
    ok: false,
    pcm: Buffer.alloc(0),
    outputBytes: 0,
    exitCode: null,
    cancelled: true,
    errorCode: 'cancelled',
    errorMessage: 'cancelled',
    processId: 321
  }))
  const result = await pending
  assert.equal(result.cancelled, true)
  assert.equal(client.cancel(input.requestId), false)
})

test('rejects a native completion that does not reconcile to the private job', async () => {
  const client = new PreloadLocalPcmNativeCaptureClient({
    nativeClient: makeBackend({
      capture: async () => makeResult('stale-job')
    }),
    resolveFfmpegPath: async () => 'ffmpeg.exe',
    createJobId: () => 'expected'
  })

  await assert.rejects(client.capture(input), /did not reconcile/)
})
