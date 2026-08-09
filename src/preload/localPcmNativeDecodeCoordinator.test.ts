import assert from 'node:assert/strict'
import test from 'node:test'
import type { LocalPcmNativeCaptureResult } from '../main/localPcmNativeCaptureClient.ts'
import type { PreloadLocalPcmNativeCaptureClient } from './localPcmNativeCaptureClient.ts'
import {
  parsePreloadLocalPcmFfprobeOutput,
  PreloadLocalPcmNativeDecodeCancelledError,
  PreloadLocalPcmNativeDecodeCoordinator,
  PreloadLocalPcmNativeDecodeTimeoutError,
  PreloadLocalPcmNativeDecodeUnauthorizedError,
  PreloadLocalPcmNativeDecodeUnavailableError,
  validatePreloadLocalPcmNativeDecodeInput,
  type PreloadLocalPcmNativeDecodeInput,
  type PreloadLocalPcmNativeDecodeResult,
  type PreloadLocalPcmProbeResult
} from './localPcmNativeDecodeCoordinator.ts'

const input: PreloadLocalPcmNativeDecodeInput = {
  requestId: 41,
  filePath: 'C:\\Music\\track.flac',
  outputSampleRate: 48_000,
  expectedChannels: 2,
  priority: 'interactive'
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

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function makeNativeResult(
  overrides: Partial<LocalPcmNativeCaptureResult> = {}
): LocalPcmNativeCaptureResult {
  return {
    ok: true,
    jobId: 'preload:41:test',
    deliveryMode: 'complete_buffer',
    pcm: Buffer.alloc(32),
    stderr: '',
    stderrTruncated: false,
    exitCode: 0,
    processId: 1234,
    cancelled: false,
    errorCode: null,
    errorMessage: null,
    windowsErrorCode: null,
    outputBytes: 32,
    stdoutReadCount: 2,
    stdoutReadMinBytes: 8,
    stdoutReadMaxBytes: 24,
    requestedPipeBufferBytes: 1024 * 1024,
    effectivePipeBufferBytes: 1024 * 1024,
    bufferCopyMs: 0.25,
    usedExternalBuffer: true,
    spawnMs: 2.5,
    firstByteMs: 4,
    stdoutReadSpanMs: 10,
    processMs: 20,
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

interface FakeNativeClientOptions {
  ensureReady?: () => Promise<unknown>
  capture?: (value: unknown) => Promise<LocalPcmNativeCaptureResult>
  cancel?: (requestId: number) => boolean
  cancelAll?: () => number
  getActiveProcessIds?: () => number[]
}

function makeNativeClient(
  options: FakeNativeClientOptions = {}
): PreloadLocalPcmNativeCaptureClient {
  return {
    ensureReady: options.ensureReady ?? (async () => ({})),
    capture: options.capture ?? (async () => makeNativeResult()),
    cancel: options.cancel ?? (() => false),
    cancelAll: options.cancelAll ?? (() => 0),
    getActiveProcessIds: options.getActiveProcessIds ?? (() => [])
  } as unknown as PreloadLocalPcmNativeCaptureClient
}

function makeCoordinator(options: {
  nativeCaptureClient?: PreloadLocalPcmNativeCaptureClient
  authorize?: (value: PreloadLocalPcmNativeDecodeInput) => Promise<boolean>
  resolveFfprobePath?: () => Promise<string | null>
  runFfprobe?: (
    ffprobePath: string,
    filePath: string,
    signal: AbortSignal,
    publishProcessId: (processId: number | null) => void
  ) => Promise<PreloadLocalPcmProbeResult>
  now?: () => number
  timeoutMs?: number
} = {}): PreloadLocalPcmNativeDecodeCoordinator {
  return new PreloadLocalPcmNativeDecodeCoordinator({
    nativeCaptureClient: options.nativeCaptureClient ?? makeNativeClient(),
    authorize: options.authorize ?? (async () => true),
    resolveFfprobePath: options.resolveFfprobePath ?? (async () => 'ffprobe.exe'),
    runFfprobe: options.runFfprobe ?? (async () => ({
      channels: 2,
      durationSeconds: 1
    })),
    now: options.now,
    timeoutMs: options.timeoutMs
  })
}

test('validates only the exact logical request and parses bounded FFprobe metadata', () => {
  assert.equal(validatePreloadLocalPcmNativeDecodeInput(input), true)
  assert.equal(validatePreloadLocalPcmNativeDecodeInput({ ...input, priority: 'background' }), false)
  assert.equal(validatePreloadLocalPcmNativeDecodeInput({ ...input, expectedChannels: 9 }), false)
  assert.equal(validatePreloadLocalPcmNativeDecodeInput({ ...input, expectedChannels: undefined }), false)
  assert.equal(validatePreloadLocalPcmNativeDecodeInput({ ...input, outputSampleRate: 7_999 }), false)
  assert.equal(validatePreloadLocalPcmNativeDecodeInput({ ...input, filePath: 'bad\0path' }), false)
  assert.equal(validatePreloadLocalPcmNativeDecodeInput({ ...input, ffprobePath: 'other.exe' }), false)

  assert.deepEqual(parsePreloadLocalPcmFfprobeOutput(JSON.stringify({
    streams: [{ channels: 2, duration_ts: '144000', time_base: '1/48000' }],
    format: { duration: '99' }
  })), {
    channels: 2,
    durationSeconds: 3
  })
  assert.deepEqual(parsePreloadLocalPcmFfprobeOutput(JSON.stringify({
    streams: [{ channels: '1', duration: '2.5' }]
  })), {
    channels: 1,
    durationSeconds: 2.5
  })
  assert.throws(
    () => parsePreloadLocalPcmFfprobeOutput('{"streams":[{"channels":9}]}'),
    /at most 8 channels/
  )
  assert.throws(() => parsePreloadLocalPcmFfprobeOutput('not json'), SyntaxError)
})

test('authorizes the exact request before loading either private binary', async () => {
  const authorization = deferred<boolean>()
  const events: string[] = []
  const coordinator = makeCoordinator({
    authorize: async (value) => {
      events.push(`authorize:${value.requestId}`)
      return authorization.promise
    },
    nativeCaptureClient: makeNativeClient({
      ensureReady: async () => {
        events.push('ffmpeg-ready')
      },
      capture: async () => {
        events.push('capture')
        return makeNativeResult()
      }
    }),
    resolveFfprobePath: async () => {
      events.push('ffprobe-ready')
      return 'ffprobe.exe'
    },
    runFfprobe: async () => {
      events.push('probe')
      return { channels: 2, durationSeconds: 1 }
    }
  })

  const pending = coordinator.decode(input)
  await flushPromises()
  assert.deepEqual(events, ['authorize:41'])

  authorization.resolve(true)
  await pending
  assert.equal(events[0], 'authorize:41')
  assert.ok(events.indexOf('ffmpeg-ready') > 0)
  assert.ok(events.indexOf('ffprobe-ready') > 0)
  assert.ok(events.indexOf('capture') > events.indexOf('ffmpeg-ready'))
})

test('overlaps capture and probe, reconciles frames, and reports preload-native telemetry', async () => {
  const capture = deferred<LocalPcmNativeCaptureResult>()
  const probe = deferred<PreloadLocalPcmProbeResult>()
  const events: string[] = []
  let clock = 0
  const coordinator = makeCoordinator({
    nativeCaptureClient: makeNativeClient({
      capture: async (value) => {
        events.push(`capture:${JSON.stringify(value)}`)
        return capture.promise
      }
    }),
    runFfprobe: async (ffprobePath, filePath) => {
      events.push(`probe:${ffprobePath}:${filePath}`)
      return probe.promise
    },
    now: () => ++clock
  })

  const pending = coordinator.decode(input)
  await flushPromises()
  assert.equal(events.length, 2)
  assert.match(events[0], /^capture:/)
  assert.equal(events[1], `probe:ffprobe.exe:${input.filePath}`)

  capture.resolve(makeNativeResult())
  await flushPromises()
  let settled = false
  void pending.then(() => { settled = true })
  await flushPromises()
  assert.equal(settled, false)
  probe.resolve({ channels: 2, durationSeconds: 1 })

  const result: PreloadLocalPcmNativeDecodeResult = await pending
  assert.equal(result.requestId, input.requestId)
  assert.equal(result.sampleRate, 48_000)
  assert.equal(result.channels, 2)
  assert.equal(result.frames, 4)
  assert.equal(result.pcmByteLength, 32)
  assert.equal(result.interleavedPcm.byteLength, 32)
  assert.equal(result.backgroundPriorityApplied, false)
  assert.equal(result.transportTimings.transportRoute, 'preload_native')
  assert.equal(result.transportTimings.ffmpegOutputSink, 'preload_native')
  assert.equal(result.transportTimings.mainHandlerMs, 0)
  assert.equal(result.transportTimings.validPcmBytes, 32)
  assert.equal(result.transportTimings.backingBufferBytes, 32)
  assert.equal(result.transportTimings.nativePcmCaptureOutputBytes, 32)
  assert.equal(result.transportTimings.nativePcmCaptureStdoutReadCount, 2)
  assert.equal(result.decodeMs, result.transportTimings.ffmpegMs)
  assert.equal(result.transportTimings.nativePcmCaptureProcessMs, 20)
  assert.equal(result.transportTimings.ffmpegCloseTailMs, 0)
  assert.ok((result.transportTimings.preloadNativeServiceMs ?? 0) > 0)
  assert.ok((result.transportTimings.probeFfmpegOverlapMs ?? 0) > 0)
})

test('includes the active FFprobe PID in the published child snapshot until probe settlement', async () => {
  const capture = deferred<LocalPcmNativeCaptureResult>()
  const probe = deferred<PreloadLocalPcmProbeResult>()
  let nativeProcessIds = [321]
  const coordinator = makeCoordinator({
    nativeCaptureClient: makeNativeClient({
      capture: () => capture.promise,
      getActiveProcessIds: () => nativeProcessIds
    }),
    runFfprobe: async (_path, _file, _signal, publishProcessId) => {
      publishProcessId(654)
      return probe.promise
    }
  })

  const pending = coordinator.decode(input)
  await flushPromises()
  assert.deepEqual(coordinator.getActiveProcessIds(), [321, 654])

  nativeProcessIds = []
  capture.resolve(makeNativeResult())
  probe.resolve({ channels: 2, durationSeconds: 1 })
  await pending
  assert.deepEqual(coordinator.getActiveProcessIds(), [])
})

test('keeps authorization refusal distinct while classifying pre-spawn setup failure as unavailable', async () => {
  await assert.rejects(
    makeCoordinator({ authorize: async () => false }).decode(input),
    PreloadLocalPcmNativeDecodeUnauthorizedError
  )

  const setupFailure = makeNativeResult({
    ok: false,
    pcm: Buffer.alloc(0),
    exitCode: null,
    processId: null,
    errorCode: 'spawn_failed',
    errorMessage: 'could not spawn',
    outputBytes: 0,
    stdoutReadCount: 0,
    stdoutReadMinBytes: null,
    stdoutReadMaxBytes: null,
    firstByteMs: null,
    stdoutReadSpanMs: null,
    processMs: 0
  })
  await assert.rejects(
    makeCoordinator({
      nativeCaptureClient: makeNativeClient({ capture: async () => setupFailure })
    }).decode(input),
    (error: unknown) => error instanceof PreloadLocalPcmNativeDecodeUnavailableError
      && /could not spawn/.test(error.message)
  )
})

test('classifies private-binary readiness failures as unavailable without native dispatch', async () => {
  let captureCalls = 0
  const coordinator = makeCoordinator({
    nativeCaptureClient: makeNativeClient({
      ensureReady: async () => {
        throw new Error('native addon unavailable')
      },
      capture: async () => {
        captureCalls += 1
        return makeNativeResult()
      }
    }),
    resolveFfprobePath: async () => null
  })

  await assert.rejects(
    coordinator.decode(input),
    PreloadLocalPcmNativeDecodeUnavailableError
  )
  assert.equal(captureCalls, 0)
})

test('classifies an authorization IPC rejection as setup-unavailable before dispatch', async () => {
  let captureCalls = 0
  const coordinator = makeCoordinator({
    authorize: async () => {
      throw new Error('authorization IPC unavailable')
    },
    nativeCaptureClient: makeNativeClient({
      capture: async () => {
        captureCalls += 1
        return makeNativeResult()
      }
    })
  })

  await assert.rejects(
    coordinator.decode(input),
    PreloadLocalPcmNativeDecodeUnavailableError
  )
  assert.equal(captureCalls, 0)
})

test('keeps a failure after native spawn authoritative and cancels the dispatched job', async () => {
  const cancelled: number[] = []
  const runtimeFailure = makeNativeResult({
    ok: false,
    pcm: Buffer.alloc(0),
    exitCode: 1,
    processId: 4321,
    errorCode: 'decode_error',
    errorMessage: 'decode failed',
    outputBytes: 0,
    stdoutReadCount: 0,
    stdoutReadMinBytes: null,
    stdoutReadMaxBytes: null,
    firstByteMs: null,
    stdoutReadSpanMs: null
  })
  const coordinator = makeCoordinator({
    nativeCaptureClient: makeNativeClient({
      capture: async () => runtimeFailure,
      cancel: (requestId) => {
        cancelled.push(requestId)
        return true
      }
    })
  })

  await assert.rejects(
    coordinator.decode(input),
    (error: unknown) => error instanceof Error
      && !(error instanceof PreloadLocalPcmNativeDecodeUnavailableError)
      && /decode_error/.test(error.message)
  )
  assert.deepEqual(cancelled, [input.requestId])
})

test('rejects misaligned native PCM after dispatch without offering setup fallback', async () => {
  let cancelCalls = 0
  const coordinator = makeCoordinator({
    nativeCaptureClient: makeNativeClient({
      capture: async () => makeNativeResult({
        pcm: Buffer.alloc(30),
        outputBytes: 30
      }),
      cancel: () => {
        cancelCalls += 1
        return true
      }
    })
  })

  await assert.rejects(
    coordinator.decode(input),
    (error: unknown) => error instanceof Error
      && !(error instanceof PreloadLocalPcmNativeDecodeUnavailableError)
      && /byte\/frame reconciliation/.test(error.message)
  )
  assert.equal(cancelCalls, 1)
})

test('cancels cleanly while authorization is pending without preparing or dispatching', async () => {
  const authorization = deferred<boolean>()
  let readyCalls = 0
  let captureCalls = 0
  const coordinator = makeCoordinator({
    authorize: () => authorization.promise,
    nativeCaptureClient: makeNativeClient({
      ensureReady: async () => { readyCalls += 1 },
      capture: async () => {
        captureCalls += 1
        return makeNativeResult()
      }
    })
  })

  const pending = coordinator.decode(input)
  await flushPromises()
  assert.equal(coordinator.cancel(input.requestId), true)
  authorization.resolve(true)
  await assert.rejects(pending, PreloadLocalPcmNativeDecodeCancelledError)
  assert.equal(readyCalls, 0)
  assert.equal(captureCalls, 0)
})

test('times out hung authorization without readiness or native dispatch', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const authorization = deferred<boolean>()
  let readyCalls = 0
  let resolverCalls = 0
  let captureCalls = 0
  let cancelCalls = 0
  const coordinator = makeCoordinator({
    timeoutMs: 25,
    authorize: () => authorization.promise,
    nativeCaptureClient: makeNativeClient({
      ensureReady: async () => { readyCalls += 1 },
      capture: async () => {
        captureCalls += 1
        return makeNativeResult()
      },
      cancel: () => {
        cancelCalls += 1
        return false
      }
    }),
    resolveFfprobePath: async () => {
      resolverCalls += 1
      return 'ffprobe.exe'
    }
  })

  const pending = coordinator.decode(input)
  context.mock.timers.tick(25)
  await assert.rejects(pending, PreloadLocalPcmNativeDecodeTimeoutError)
  assert.equal(readyCalls, 0)
  assert.equal(resolverCalls, 0)
  assert.equal(captureCalls, 0)
  assert.equal(cancelCalls, 1)
})

test('times out hung FFmpeg or FFprobe readiness without native dispatch', async (context) => {
  const cases = [
    {
      name: 'native FFmpeg readiness',
      ensureReady: () => new Promise<unknown>(() => {}),
      resolveFfprobePath: async (): Promise<string | null> => 'ffprobe.exe'
    },
    {
      name: 'FFprobe resolver readiness',
      ensureReady: async (): Promise<unknown> => ({}),
      resolveFfprobePath: () => new Promise<string | null>(() => {})
    }
  ]

  for (const readinessCase of cases) {
    await context.test(readinessCase.name, async (subcontext) => {
      subcontext.mock.timers.enable({ apis: ['setTimeout'] })
      let captureCalls = 0
      let cancelCalls = 0
      const coordinator = makeCoordinator({
        timeoutMs: 25,
        nativeCaptureClient: makeNativeClient({
          ensureReady: readinessCase.ensureReady,
          capture: async () => {
            captureCalls += 1
            return makeNativeResult()
          },
          cancel: () => {
            cancelCalls += 1
            return false
          }
        }),
        resolveFfprobePath: readinessCase.resolveFfprobePath
      })

      const pending = coordinator.decode(input)
      await flushPromises()
      subcontext.mock.timers.tick(25)
      await assert.rejects(pending, PreloadLocalPcmNativeDecodeTimeoutError)
      assert.equal(captureCalls, 0)
      assert.equal(cancelCalls, 1)
    })
  }
})

test('cancels cleanly during readiness and prevents stale native dispatch', async () => {
  const ffmpegReady = deferred<unknown>()
  const ffprobeReady = deferred<string | null>()
  let captureCalls = 0
  const coordinator = makeCoordinator({
    nativeCaptureClient: makeNativeClient({
      ensureReady: () => ffmpegReady.promise,
      capture: async () => {
        captureCalls += 1
        return makeNativeResult()
      }
    }),
    resolveFfprobePath: () => ffprobeReady.promise
  })

  const pending = coordinator.decode(input)
  await flushPromises()
  assert.equal(coordinator.cancel(input.requestId), true)
  ffmpegReady.resolve({})
  ffprobeReady.resolve('ffprobe.exe')
  await assert.rejects(pending, PreloadLocalPcmNativeDecodeCancelledError)
  assert.equal(captureCalls, 0)
})

test('cancels active capture and aborts its overlapping probe', async () => {
  const nativeCompletion = deferred<LocalPcmNativeCaptureResult>()
  let probeAborted = false
  const cancelled: number[] = []
  const coordinator = makeCoordinator({
    nativeCaptureClient: makeNativeClient({
      capture: () => nativeCompletion.promise,
      cancel: (requestId) => {
        cancelled.push(requestId)
        nativeCompletion.resolve(makeNativeResult({
          ok: false,
          pcm: Buffer.alloc(0),
          exitCode: null,
          cancelled: true,
          errorCode: 'cancelled',
          errorMessage: 'cancelled',
          outputBytes: 0
        }))
        return true
      }
    }),
    runFfprobe: async (_path, _file, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        probeAborted = true
        reject(new Error('probe aborted'))
      }, { once: true })
      void resolve
    })
  })

  const pending = coordinator.decode(input)
  await flushPromises()
  assert.equal(coordinator.cancel(input.requestId), true)
  await assert.rejects(pending, PreloadLocalPcmNativeDecodeCancelledError)
  assert.equal(probeAborted, true)
  assert.deepEqual(cancelled, [input.requestId])
})

test('a newer request supersedes authorization-pending work without stale dispatch', async () => {
  const firstAuthorization = deferred<boolean>()
  const capturedRequestIds: number[] = []
  const coordinator = makeCoordinator({
    authorize: (value) => value.requestId === input.requestId
      ? firstAuthorization.promise
      : Promise.resolve(true),
    nativeCaptureClient: makeNativeClient({
      capture: async (value) => {
        const request = value as { requestId: number }
        capturedRequestIds.push(request.requestId)
        return makeNativeResult({ jobId: `preload:${request.requestId}:test` })
      }
    })
  })

  const first = coordinator.decode(input)
  await flushPromises()
  const second = coordinator.decode({ ...input, requestId: 42 })
  firstAuthorization.resolve(true)

  await assert.rejects(first, PreloadLocalPcmNativeDecodeCancelledError)
  assert.equal((await second).requestId, 42)
  assert.deepEqual(capturedRequestIds, [42])
})

test('times out active native capture, cancels it, and aborts the probe', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const nativeCompletion = deferred<LocalPcmNativeCaptureResult>()
  let probeAborted = false
  let cancelCalls = 0
  const coordinator = makeCoordinator({
    timeoutMs: 10,
    nativeCaptureClient: makeNativeClient({
      capture: () => nativeCompletion.promise,
      cancel: () => {
        cancelCalls += 1
        return true
      }
    }),
    runFfprobe: async (_path, _file, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        probeAborted = true
        reject(new Error('probe aborted'))
      }, { once: true })
    })
  })

  const pending = coordinator.decode(input)
  await flushPromises()
  context.mock.timers.tick(10)
  await assert.rejects(pending, PreloadLocalPcmNativeDecodeTimeoutError)
  assert.equal(cancelCalls, 1)
  assert.equal(probeAborted, true)
})
