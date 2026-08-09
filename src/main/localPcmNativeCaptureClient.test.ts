import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LocalPcmNativeCaptureClient,
  LocalPcmNativeCaptureUnavailableError,
  isLocalPcmNativeCaptureSetupFailure,
  resolveLocalPcmNativeAddonPath,
  type LocalPcmNativeCaptureRequest,
  type LocalPcmNativeCaptureResult
} from './localPcmNativeCaptureClient.ts'

const request: LocalPcmNativeCaptureRequest = {
  jobId: 'job-1',
  slotId: 'local-pcm-foreground',
  ffmpegPath: 'ffmpeg.exe',
  args: ['-i', 'track.flac', 'pipe:1'],
  deliveryMode: 'complete_buffer'
}

const nativeCapabilities = {
  supported: true,
  reason: null,
  maxPcmBytes: 192 * 1024 * 1024,
  supportsProgressBatches: true,
  progressBatchBytes: 8 * 1024 * 1024,
  progressMaxInFlightBatches: 2
} as const

function makeResult(
  overrides: Partial<LocalPcmNativeCaptureResult> = {}
): LocalPcmNativeCaptureResult {
  return {
    ok: true,
    jobId: request.jobId,
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
    bufferCopyMs: 5,
    usedExternalBuffer: false,
    spawnMs: 4,
    firstByteMs: 12,
    stdoutReadSpanMs: 30,
    processMs: 46,
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

test('complete-buffer capture uses the one-argument native API', async () => {
  let captured: LocalPcmNativeCaptureRequest | null = null
  let captureArgumentCount = 0
  const client = new LocalPcmNativeCaptureClient({
    loadAddon: () => ({
      getCapabilities: () => nativeCapabilities,
      capture: async (...values: [LocalPcmNativeCaptureRequest]) => {
        captureArgumentCount = values.length
        captured = values[0]
        return makeResult()
      },
      acknowledge: () => true,
      cancel: () => true,
      cancelAll: () => 1,
      getActiveProcessIds: () => [123, 123, 456, 0, -1, 'bad']
    })
  })

  assert.deepEqual(client.getCapabilities(), {
    supported: true,
    reason: null,
    maxPcmBytes: 192 * 1024 * 1024,
    supportsProgressBatches: true,
    progressBatchBytes: 8 * 1024 * 1024,
    progressMaxInFlightBatches: 2
  })
  assert.deepEqual(await client.capture(request), makeResult())
  assert.deepEqual(captured, request)
  const observedRequest = captured as LocalPcmNativeCaptureRequest | null
  assert.ok(observedRequest)
  assert.equal(observedRequest.deliveryMode, 'complete_buffer')
  assert.equal(observedRequest.batchBytes, undefined)
  assert.equal(captureArgumentCount, 1)
  assert.equal(client.cancel(request.jobId), true)
  assert.equal(client.cancelAll(), 1)
  assert.deepEqual(client.getActiveProcessIds(), [123, 456])
})

test('loads the addon at most once and caches an unavailable error', () => {
  let loadCount = 0
  const client = new LocalPcmNativeCaptureClient({
    loadAddon: () => {
      loadCount += 1
      throw new Error('missing addon')
    }
  })

  assert.throws(() => client.getCapabilities(), /missing addon/)
  assert.throws(() => client.getCapabilities(), /missing addon/)
  assert.equal(loadCount, 1)
  assert.equal(client.cancel('absent'), false)
  assert.equal(client.cancelAll(), 0)
})

test('rejects capture addons without the required API', () => {
  const client = new LocalPcmNativeCaptureClient({ loadAddon: () => ({}) })
  assert.throws(
    () => client.getCapabilities(),
    LocalPcmNativeCaptureUnavailableError
  )
})

test('rejects malformed native results before main-process adoption', async () => {
  const client = new LocalPcmNativeCaptureClient({
    loadAddon: () => ({
      getCapabilities: () => nativeCapabilities,
      capture: async () => makeResult({ stdoutReadMinBytes: 128, stdoutReadMaxBytes: 64 }),
      acknowledge: () => false,
      cancel: () => false,
      cancelAll: () => 0,
      getActiveProcessIds: () => []
    })
  })

  await assert.rejects(client.capture(request), /invalid read-size range/)
})

test('rejects stale and internally inconsistent native success results', async () => {
  let result = makeResult({ jobId: 'stale-job' })
  const client = new LocalPcmNativeCaptureClient({
    loadAddon: () => ({
      getCapabilities: () => nativeCapabilities,
      capture: async () => result,
      acknowledge: () => false,
      cancel: () => false,
      cancelAll: () => 0,
      getActiveProcessIds: () => []
    })
  })

  await assert.rejects(client.capture(request), /stale job result/)
  result = makeResult({
    outputBytes: 63,
    stdoutReadMinBytes: 32,
    stdoutReadMaxBytes: 63
  })
  await assert.rejects(client.capture(request), /inconsistent success result/)
})

test('rejects failed results that retain PCM output', async () => {
  const client = new LocalPcmNativeCaptureClient({
    loadAddon: () => ({
      getCapabilities: () => nativeCapabilities,
      capture: async () => makeResult({
        ok: false,
        exitCode: 1,
        errorCode: 'ffmpeg_exit',
        errorMessage: 'failed',
        bufferCopyMs: 0
      }),
      acknowledge: () => false,
      cancel: () => false,
      cancelAll: () => 0,
      getActiveProcessIds: () => []
    })
  })

  await assert.rejects(client.capture(request), /returned PCM for a failed result/)
})

test('retains bounded partial-output telemetry for failed native jobs', async () => {
  const client = new LocalPcmNativeCaptureClient({
    loadAddon: () => ({
      getCapabilities: () => nativeCapabilities,
      capture: async () => makeResult({
        ok: false,
        pcm: Buffer.alloc(0),
        exitCode: 1,
        errorCode: 'ffmpeg_exit',
        errorMessage: 'failed',
        outputBytes: 32,
        stdoutReadMinBytes: 32,
        stdoutReadMaxBytes: 32,
        bufferCopyMs: 0
      }),
      acknowledge: () => false,
      cancel: () => false,
      cancelAll: () => 0,
      getActiveProcessIds: () => []
    })
  })

  const result = await client.capture(request)
  assert.equal(result.ok, false)
  assert.equal(result.outputBytes, 32)
  assert.equal(result.pcm.byteLength, 0)
})

test('accepts zero-copy telemetry and rejects impossible handoff combinations', async () => {
  let result = makeResult({ bufferCopyMs: 0, usedExternalBuffer: true })
  const client = new LocalPcmNativeCaptureClient({
    loadAddon: () => ({
      getCapabilities: () => nativeCapabilities,
      capture: async () => result,
      acknowledge: () => false,
      cancel: () => false,
      cancelAll: () => 0,
      getActiveProcessIds: () => []
    })
  })

  assert.equal((await client.capture(request)).usedExternalBuffer, true)
  result = makeResult({ bufferCopyMs: 1, usedExternalBuffer: true })
  await assert.rejects(client.capture(request), /copying an external buffer/)
})

test('validates ordered progress batches and returns idempotent native credits', async () => {
  const targetBytes = 8 * 1024 * 1024
  const finalBytes = 3
  const acknowledgements: Array<[string, number]> = []
  const progressRequest: LocalPcmNativeCaptureRequest = {
    ...request,
    deliveryMode: 'progress_batches',
    batchBytes: targetBytes
  }
  const client = new LocalPcmNativeCaptureClient({
    loadAddon: () => ({
      getCapabilities: () => nativeCapabilities,
      capture: async (
        _value: LocalPcmNativeCaptureRequest,
        onBatch: (batch: unknown) => void
      ) => {
        onBatch({
          jobId: request.jobId,
          sequence: 0,
          byteOffset: 0,
          byteLength: targetBytes,
          payload: Buffer.alloc(targetBytes, 1)
        })
        onBatch({
          jobId: request.jobId,
          sequence: 1,
          byteOffset: targetBytes,
          byteLength: finalBytes,
          payload: Buffer.from([2, 3, 4])
        })
        return makeResult({
          deliveryMode: 'progress_batches',
          pcm: Buffer.alloc(0),
          outputBytes: targetBytes + finalBytes,
          stdoutReadMaxBytes: 64,
          bufferCopyMs: 0,
          batchCount: 2,
          batchBytes: targetBytes + finalBytes,
          batchMinBytes: finalBytes,
          batchMaxBytes: targetBytes,
          batchCreditWaitCount: 2,
          batchCreditWaitMs: 4,
          batchCreditWaitMaxMs: 3,
          batchCopyMs: 2,
          batchCopyMaxMs: 1.5,
          batchCallbackMs: 1,
          batchCallbackMaxMs: 0.75
        })
      },
      acknowledge: (jobId: string, sequence: number) => {
        acknowledgements.push([jobId, sequence])
        return true
      },
      cancel: () => false,
      cancelAll: () => 0,
      getActiveProcessIds: () => []
    })
  })

  const received: number[] = []
  const result = await client.capture(progressRequest, {
    onBatch: (batch) => {
      received.push(batch.byteLength)
      batch.acknowledge()
      batch.acknowledge()
    }
  })

  assert.deepEqual(received, [targetBytes, finalBytes])
  assert.deepEqual(acknowledgements, [
    [request.jobId, 0],
    [request.jobId, 1]
  ])
  assert.equal(result.pcm.byteLength, 0)
  assert.equal(result.batchBytes, targetBytes + finalBytes)
})

test('cancels malformed native progress without throwing through the addon callback', async () => {
  let cancelCount = 0
  const progressRequest: LocalPcmNativeCaptureRequest = {
    ...request,
    deliveryMode: 'progress_batches',
    batchBytes: 8 * 1024 * 1024
  }
  const client = new LocalPcmNativeCaptureClient({
    loadAddon: () => ({
      getCapabilities: () => nativeCapabilities,
      capture: async (
        _value: LocalPcmNativeCaptureRequest,
        onBatch: (batch: unknown) => void
      ) => {
        assert.doesNotThrow(() => onBatch({
          jobId: request.jobId,
          sequence: 1,
          byteOffset: 0,
          byteLength: 4,
          payload: Buffer.alloc(4)
        }))
        return makeResult({
          ok: false,
          deliveryMode: 'progress_batches',
          pcm: Buffer.alloc(0),
          exitCode: null,
          cancelled: true,
          errorCode: 'cancelled',
          errorMessage: 'cancelled',
          outputBytes: 4,
          stdoutReadMinBytes: 4,
          stdoutReadMaxBytes: 4,
          bufferCopyMs: 0
        })
      },
      acknowledge: () => false,
      cancel: () => {
        cancelCount += 1
        return true
      },
      cancelAll: () => 0,
      getActiveProcessIds: () => []
    })
  })

  await assert.rejects(
    client.capture(progressRequest, { onBatch: () => undefined }),
    /invalid or out-of-order batch/
  )
  assert.equal(cancelCount, 1)
})

test('a deferred batch acknowledgement cannot cross terminal job settlement', async () => {
  let acknowledged = 0
  let deferredAcknowledge: (() => void) | null = null
  const progressRequest: LocalPcmNativeCaptureRequest = {
    ...request,
    deliveryMode: 'progress_batches',
    batchBytes: 8 * 1024 * 1024
  }
  const client = new LocalPcmNativeCaptureClient({
    loadAddon: () => ({
      getCapabilities: () => nativeCapabilities,
      capture: async (
        _value: LocalPcmNativeCaptureRequest,
        onBatch: (batch: unknown) => void
      ) => {
        onBatch({
          jobId: request.jobId,
          sequence: 0,
          byteOffset: 0,
          byteLength: 4,
          payload: Buffer.alloc(4)
        })
        return makeResult({
          deliveryMode: 'progress_batches',
          pcm: Buffer.alloc(0),
          outputBytes: 4,
          stdoutReadMinBytes: 4,
          stdoutReadMaxBytes: 4,
          bufferCopyMs: 0,
          batchCount: 1,
          batchBytes: 4,
          batchMinBytes: 4,
          batchMaxBytes: 4
        })
      },
      acknowledge: () => {
        acknowledged += 1
        return true
      },
      cancel: () => false,
      cancelAll: () => 0,
      getActiveProcessIds: () => []
    })
  })

  await client.capture(progressRequest, {
    onBatch: (batch) => { deferredAcknowledge = batch.acknowledge }
  })
  ;(deferredAcknowledge as unknown as () => void)()
  assert.equal(acknowledged, 0)
})

test('cancels a live progress job when native refuses its batch credit', async () => {
  let cancelCount = 0
  const progressRequest: LocalPcmNativeCaptureRequest = {
    ...request,
    deliveryMode: 'progress_batches',
    batchBytes: 8 * 1024 * 1024
  }
  const client = new LocalPcmNativeCaptureClient({
    loadAddon: () => ({
      getCapabilities: () => nativeCapabilities,
      capture: async (
        _value: LocalPcmNativeCaptureRequest,
        onBatch: (batch: unknown) => void
      ) => {
        onBatch({
          jobId: request.jobId,
          sequence: 0,
          byteOffset: 0,
          byteLength: 4,
          payload: Buffer.alloc(4)
        })
        return makeResult({
          ok: false,
          deliveryMode: 'progress_batches',
          pcm: Buffer.alloc(0),
          exitCode: null,
          cancelled: true,
          errorCode: 'cancelled',
          errorMessage: 'cancelled',
          outputBytes: 4,
          stdoutReadMinBytes: 4,
          stdoutReadMaxBytes: 4,
          bufferCopyMs: 0,
          batchCount: 1,
          batchBytes: 4,
          batchMinBytes: 4,
          batchMaxBytes: 4
        })
      },
      acknowledge: () => false,
      cancel: () => {
        cancelCount += 1
        return true
      },
      cancelAll: () => 0,
      getActiveProcessIds: () => []
    })
  })

  await assert.rejects(
    client.capture(progressRequest, { onBatch: (batch) => batch.acknowledge() }),
    /refused a live batch acknowledgement/
  )
  assert.equal(cancelCount, 1)
})

test('accepts cancellation telemetry when queued descriptors were suppressed', async () => {
  const progressRequest: LocalPcmNativeCaptureRequest = {
    ...request,
    deliveryMode: 'progress_batches',
    batchBytes: 8 * 1024 * 1024
  }
  const client = new LocalPcmNativeCaptureClient({
    loadAddon: () => ({
      getCapabilities: () => nativeCapabilities,
      capture: async () => makeResult({
        ok: false,
        deliveryMode: 'progress_batches',
        pcm: Buffer.alloc(0),
        exitCode: null,
        cancelled: true,
        errorCode: 'cancelled',
        errorMessage: 'cancelled',
        outputBytes: 4,
        stdoutReadMinBytes: 4,
        stdoutReadMaxBytes: 4,
        bufferCopyMs: 0,
        batchCreditWaitCount: 1,
        batchCreditWaitMs: 2,
        batchCreditWaitMaxMs: 2
      }),
      acknowledge: () => false,
      cancel: () => false,
      cancelAll: () => 0,
      getActiveProcessIds: () => []
    })
  })

  const result = await client.capture(progressRequest, { onBatch: () => undefined })
  assert.equal(result.cancelled, true)
  assert.equal(result.batchCount, 0)
  assert.equal(result.batchCreditWaitCount, 1)
})

test('allows JS pipe fallback only for confirmed pre-spawn setup failures', () => {
  const setupFailure = makeResult({
    ok: false,
    pcm: Buffer.alloc(0),
    exitCode: null,
    processId: null,
    errorCode: 'create_process_failed',
    errorMessage: 'failed to spawn',
    outputBytes: 0,
    stdoutReadCount: 0,
    stdoutReadMinBytes: null,
    stdoutReadMaxBytes: null,
    bufferCopyMs: 0,
    firstByteMs: null,
    stdoutReadSpanMs: null
  })
  assert.equal(isLocalPcmNativeCaptureSetupFailure(setupFailure), true)
  assert.equal(isLocalPcmNativeCaptureSetupFailure({
    ...setupFailure,
    processId: 123
  }), false)
  assert.equal(isLocalPcmNativeCaptureSetupFailure({
    ...setupFailure,
    outputBytes: 64
  }), false)
  assert.equal(isLocalPcmNativeCaptureSetupFailure({
    ...setupFailure,
    batchCount: 1
  }), false)
  assert.equal(isLocalPcmNativeCaptureSetupFailure({
    ...setupFailure,
    cancelled: true
  }), false)
})

test('resolves the separate main-only capture addon in dev and packaged builds', () => {
  assert.match(
    resolveLocalPcmNativeAddonPath(false, 'C:/app/resources', 'C:/repo/src/main').replaceAll('\\', '/'),
    /native\/build\/Release\/ffmpeg_pcm_capture\.node$/
  )
  assert.match(
    resolveLocalPcmNativeAddonPath(true, 'C:/app/resources', 'C:/repo/src/main').replaceAll('\\', '/'),
    /native\/ffmpeg_pcm_capture\.node$/
  )
})
