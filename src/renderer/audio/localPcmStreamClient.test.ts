import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LOCAL_PCM_STREAM_INITIAL_CREDITS,
  LOCAL_PCM_STREAM_MARKER,
  LOCAL_PCM_STREAM_VERSION,
  type LocalPcmStreamMainTransportTimings,
} from '../../shared/localPcmStream.ts'
import {
  LocalPcmStreamCancelledError,
  LocalPcmStreamDecodeError,
  LocalPcmStreamTransportError,
  createLocalPcmStreamClient,
  isLocalPcmStreamDecodeError,
  isLocalPcmStreamTransportError,
  preferLocalPcmStreamWithLegacyFallback,
  type LocalPcmCompatibleDecodeResult,
  type LocalPcmStreamClientRuntime,
  type LocalPcmStreamWindowTarget,
} from './localPcmStreamClient.ts'

class FakeWindowTarget implements LocalPcmStreamWindowTarget {
  readonly sourceIdentity = this as unknown as MessageEventSource
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>()

  addMessageListener(listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener)
  }

  removeMessageListener(listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener)
  }

  dispatch(data: unknown, ports: FakePort[] = [], source = this.sourceIdentity): void {
    const event = {
      data,
      ports: ports as unknown as MessagePort[],
      source,
    } as unknown as MessageEvent<unknown>
    for (const listener of this.listeners) listener(event)
  }
}

class FakePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  readonly sent: unknown[] = []
  started = false
  closed = false
  failPosts = false

  postMessage(message: unknown): void {
    if (this.failPosts) throw new Error('post failed')
    this.sent.push(message)
  }

  start(): void {
    this.started = true
  }

  close(): void {
    this.closed = true
  }

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>)
  }

  emitMessageError(): void {
    this.onmessageerror?.({ data: null } as MessageEvent<unknown>)
  }

  emitRemoteClose(): void {
    this.onclose?.({} as Event)
  }
}

const request = {
  requestId: 17,
  filePath: 'C:\\Music\\track.flac',
  outputSampleRate: 48_000,
  expectedChannels: 2,
  priority: 'interactive' as const,
}

const nonce = 'stream_nonce_17'
const wireBase = {
  version: LOCAL_PCM_STREAM_VERSION,
  requestId: request.requestId,
  nonce,
} as const

function mainTimings(
  byteLength: number,
  chunkCount: number,
  growthCount = 0,
  overrides: Partial<LocalPcmStreamMainTransportTimings> = {},
): LocalPcmStreamMainTransportTimings {
  return {
    decodeRequestId: request.requestId,
    validPcmBytes: byteLength,
    backingBufferBytes: byteLength,
    allocationGrowthCount: growthCount,
    transportRoute: 'message_port_stream',
    mainHandlerMs: 30,
    binaryResolutionMs: 1,
    probeMs: 2,
    probeCacheStatus: 'hit',
    probeDecodeOverlapEnabled: true,
    probeFfmpegOverlapMs: 8,
    ffmpegMs: 20,
    ffmpegSpawnToFirstPcmMs: 4,
    ffmpegPcmOutputSpanMs: 14,
    ffmpegCloseTailMs: 2,
    allocationMs: 0,
    initialAllocationMs: 0,
    growthAllocationMs: 0,
    payloadFinalizationMs: 0,
    preloadInvokeMs: 0,
    streamChunkCount: chunkCount,
    streamDispatchCopyMs: 3,
    streamDispatchPostMs: 4,
    streamTailMs: 5,
    ...overrides,
  }
}

interface TestRuntime {
  runtime: LocalPcmStreamClientRuntime
  windowTarget: FakeWindowTarget
  openCalls: unknown[][]
  fireHandshakeTimer(): void
}

function makeRuntime(openResult = true): TestRuntime {
  const windowTarget = new FakeWindowTarget()
  const openCalls: unknown[][] = []
  let timerCallback: (() => void) | null = null
  let clock = 0
  return {
    windowTarget,
    openCalls,
    fireHandshakeTimer: () => timerCallback?.(),
    runtime: {
      windowTarget,
      openLocalAudioPcmStream: (...args) => {
        openCalls.push(args)
        return openResult
      },
      monotonicNow: () => {
        clock += 1
        return clock
      },
      createNonce: () => nonce,
      setTimer: (callback) => {
        timerCallback = callback
        return 1 as unknown as ReturnType<typeof globalThis.setTimeout>
      },
      clearTimer: () => {
        timerCallback = null
      },
      handshakeTimeoutMs: 100,
    },
  }
}

function attachAcceptedStream(
  testRuntime: TestRuntime,
  client: ReturnType<typeof createLocalPcmStreamClient>,
  backingBufferBytes: number,
): { port: FakePort; promise: ReturnType<typeof client.decode> } {
  const promise = client.decode(request)
  const port = new FakePort()
  testRuntime.windowTarget.dispatch({
    ...wireBase,
    marker: LOCAL_PCM_STREAM_MARKER,
  }, [port])
  assert.equal(port.started, true)
  assert.deepEqual(port.sent[0], {
    ...wireBase,
    type: 'ready',
    credits: LOCAL_PCM_STREAM_INITIAL_CREDITS,
  })
  port.emit({ ...wireBase, type: 'accepted' })
  port.emit({
    ...wireBase,
    type: 'start',
    sampleRate: 48_000,
    channels: 2,
    backingBufferBytes,
  })
  return { port, promise }
}

test('assembles a correlated stream and returns renderer-local timing fields', async () => {
  const testRuntime = makeRuntime()
  const client = createLocalPcmStreamClient(testRuntime.runtime)
  const { port, promise } = attachAcceptedStream(testRuntime, client, 16)
  const payload = Uint8Array.from({ length: 16 }, (_, index) => index + 1).buffer

  port.emit({
    ...wireBase,
    type: 'chunk',
    sequence: 0,
    byteOffset: 0,
    byteLength: payload.byteLength,
    payload,
  })
  assert.deepEqual(port.sent[1], {
    ...wireBase,
    type: 'credit',
    sequence: 0,
    credits: 1,
  })
  port.emit({
    ...wireBase,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: mainTimings(16, 1),
  })

  const result = await promise
  assert.equal(result.requestId, request.requestId)
  assert.equal(result.frames, 2)
  assert.deepEqual([...new Uint8Array(result.interleavedPcm)], [...new Uint8Array(payload)])
  assert.equal(result.transportTimings.transportRoute, 'message_port_stream')
  assert.equal(result.transportTimings.preloadInvokeMs, 0)
  assert.equal(result.transportTimings.probeCacheStatus, 'hit')
  assert.equal(result.transportTimings.probeDecodeOverlapEnabled, true)
  assert.equal(result.transportTimings.probeFfmpegOverlapMs, 8)
  assert.equal(result.transportTimings.ffmpegSpawnToFirstPcmMs, 4)
  assert.equal(result.transportTimings.ffmpegPcmOutputSpanMs, 14)
  assert.equal(result.transportTimings.ffmpegCloseTailMs, 2)
  assert.equal(result.transportTimings.rendererPcmAssemblyAllocationMs, 1)
  assert.equal(result.transportTimings.rendererPcmAssemblyCopyMs, 1)
  assert.equal(result.transportTimings.rendererPortRequestMs, 5)
  assert.equal(client.pendingCount, 0)
  assert.equal(port.closed, true)
})

test('strictly grows the zeroed assembly and preserves the received prefix', async () => {
  const testRuntime = makeRuntime()
  const client = createLocalPcmStreamClient(testRuntime.runtime)
  const { port, promise } = attachAcceptedStream(testRuntime, client, 8)
  const first = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]).buffer
  const second = Uint8Array.from([9, 10, 11, 12, 13, 14, 15, 16]).buffer

  port.emit({ ...wireBase, type: 'chunk', sequence: 0, byteOffset: 0, byteLength: 8, payload: first })
  port.emit({ ...wireBase, type: 'resize', backingBufferBytes: 16 })
  port.emit({ ...wireBase, type: 'chunk', sequence: 1, byteOffset: 8, byteLength: 8, payload: second })
  port.emit({
    ...wireBase,
    type: 'complete',
    frames: 2,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: true,
    chunkCount: 2,
    transportTimings: mainTimings(16, 2, 1),
  })

  const result = await promise
  assert.deepEqual([...new Uint8Array(result.interleavedPcm)], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
  assert.equal(result.backgroundPriorityApplied, true)
  assert.equal(result.transportTimings.rendererPcmAssemblyAllocationMs, 2)
  assert.equal(result.transportTimings.rendererPcmAssemblyCopyMs, 3)
})

test('rejects out-of-order chunks as transport failures and cancels the port session', async () => {
  const testRuntime = makeRuntime()
  const client = createLocalPcmStreamClient(testRuntime.runtime)
  const { port, promise } = attachAcceptedStream(testRuntime, client, 16)

  port.emit({
    ...wireBase,
    type: 'chunk',
    sequence: 1,
    byteOffset: 0,
    byteLength: 8,
    payload: new ArrayBuffer(8),
  })

  await assert.rejects(promise, (error) => {
    assert.equal(isLocalPcmStreamTransportError(error), true)
    assert.equal((error as LocalPcmStreamTransportError).code, 'protocol_error')
    return true
  })
  assert.deepEqual(port.sent.at(-1), { ...wireBase, type: 'cancel' })
  assert.equal(port.closed, true)
  assert.equal(client.pendingCount, 0)
})

test('rejects stale start metadata and inconsistent final PCM dimensions', async () => {
  const startRuntime = makeRuntime()
  const startClient = createLocalPcmStreamClient(startRuntime.runtime)
  const startPromise = startClient.decode(request)
  const startPort = new FakePort()
  startRuntime.windowTarget.dispatch({ ...wireBase, marker: LOCAL_PCM_STREAM_MARKER }, [startPort])
  startPort.emit({ ...wireBase, type: 'accepted' })
  startPort.emit({
    ...wireBase,
    type: 'start',
    sampleRate: 44_100,
    channels: 2,
    backingBufferBytes: 16,
  })
  await assert.rejects(startPromise, LocalPcmStreamTransportError)

  const completeRuntime = makeRuntime()
  const completeClient = createLocalPcmStreamClient(completeRuntime.runtime)
  const { port, promise } = attachAcceptedStream(completeRuntime, completeClient, 16)
  port.emit({
    ...wireBase,
    type: 'chunk',
    sequence: 0,
    byteOffset: 0,
    byteLength: 16,
    payload: new ArrayBuffer(16),
  })
  port.emit({
    ...wireBase,
    type: 'complete',
    frames: 1,
    pcmByteLength: 16,
    probeMs: 2,
    decodeMs: 20,
    backgroundPriorityApplied: false,
    chunkCount: 1,
    transportTimings: mainTimings(16, 1),
  })
  await assert.rejects(promise, LocalPcmStreamTransportError)
})

test('a transport rejection uses legacy invoke unchanged', async () => {
  const testRuntime = makeRuntime(false)
  const client = createLocalPcmStreamClient(testRuntime.runtime)
  let legacyCalls = 0
  const legacyResult: LocalPcmCompatibleDecodeResult = {
    requestId: request.requestId,
    sampleRate: 48_000,
    channels: 2,
    frames: 1,
    pcmByteLength: 8,
    interleavedPcm: new ArrayBuffer(8),
    probeMs: 1,
    decodeMs: 2,
    backgroundPriorityApplied: false,
  }

  const result = await preferLocalPcmStreamWithLegacyFallback(
    request,
    async () => {
      legacyCalls += 1
      return legacyResult
    },
    { client },
  )
  assert.equal(result, legacyResult)
  assert.equal(legacyCalls, 1)
  assert.equal(testRuntime.openCalls.length, 1)
})

test('main decoder errors remain distinct and never invoke fallback', async () => {
  const testRuntime = makeRuntime()
  const client = createLocalPcmStreamClient(testRuntime.runtime)
  let legacyCalls = 0
  const resultPromise = preferLocalPcmStreamWithLegacyFallback(
    request,
    async () => {
      legacyCalls += 1
      return null
    },
    { client },
  )
  const port = new FakePort()
  testRuntime.windowTarget.dispatch({ ...wireBase, marker: LOCAL_PCM_STREAM_MARKER }, [port])
  port.emit({ ...wireBase, type: 'accepted' })
  port.emit({
    ...wireBase,
    type: 'error',
    kind: 'decode',
    code: 'ffmpeg_failed',
    message: 'FFmpeg failed.',
  })

  await assert.rejects(resultPromise, (error) => {
    assert.equal(isLocalPcmStreamDecodeError(error), true)
    assert.equal((error as LocalPcmStreamDecodeError).code, 'ffmpeg_failed')
    return true
  })
  assert.equal(legacyCalls, 0)
})

test('cancellation posts cancel, closes the port, and releases pending state immediately', async () => {
  const testRuntime = makeRuntime()
  const client = createLocalPcmStreamClient(testRuntime.runtime)
  const { port, promise } = attachAcceptedStream(testRuntime, client, 16)

  assert.equal(client.cancel(request.requestId), true)
  assert.equal(client.pendingCount, 0)
  assert.equal(port.closed, true)
  assert.deepEqual(port.sent.at(-1), { ...wireBase, type: 'cancel' })
  await assert.rejects(promise, LocalPcmStreamCancelledError)
})

test('a remote cancellation returns null without invoking legacy fallback', async () => {
  const testRuntime = makeRuntime()
  const client = createLocalPcmStreamClient(testRuntime.runtime)
  let legacyCalls = 0
  const resultPromise = preferLocalPcmStreamWithLegacyFallback(
    request,
    async () => {
      legacyCalls += 1
      return null
    },
    { client },
  )
  const port = new FakePort()
  testRuntime.windowTarget.dispatch({ ...wireBase, marker: LOCAL_PCM_STREAM_MARKER }, [port])
  port.emit({ ...wireBase, type: 'accepted' })
  port.emit({ ...wireBase, type: 'cancelled' })

  assert.equal(await resultPromise, null)
  assert.equal(legacyCalls, 0)
})

test('handshake timeout and port deserialization failure are typed transport errors', async () => {
  const timeoutRuntime = makeRuntime()
  const timeoutClient = createLocalPcmStreamClient(timeoutRuntime.runtime)
  const timeoutPromise = timeoutClient.decode(request)
  timeoutRuntime.fireHandshakeTimer()
  await assert.rejects(timeoutPromise, (error) => (
    error instanceof LocalPcmStreamTransportError && error.code === 'handshake_timeout'
  ))

  const messageRuntime = makeRuntime()
  const messageClient = createLocalPcmStreamClient(messageRuntime.runtime)
  const messagePromise = messageClient.decode(request)
  const port = new FakePort()
  messageRuntime.windowTarget.dispatch({ ...wireBase, marker: LOCAL_PCM_STREAM_MARKER }, [port])
  port.emitMessageError()
  await assert.rejects(messagePromise, (error) => (
    error instanceof LocalPcmStreamTransportError && error.code === 'message_error'
  ))
})

test('an envelope without an exact pending request and nonce is ignored', async () => {
  const testRuntime = makeRuntime()
  const client = createLocalPcmStreamClient(testRuntime.runtime)
  const promise = client.decode(request)
  const stalePort = new FakePort()
  testRuntime.windowTarget.dispatch({
    ...wireBase,
    nonce: 'stale_nonce',
    marker: LOCAL_PCM_STREAM_MARKER,
  }, [stalePort])
  assert.equal(stalePort.closed, false)
  assert.equal(client.hasPending(request.requestId), true)

  const port = new FakePort()
  testRuntime.windowTarget.dispatch({ ...wireBase, marker: LOCAL_PCM_STREAM_MARKER }, [port])
  port.emit({ ...wireBase, type: 'cancelled' })
  await assert.rejects(promise, LocalPcmStreamCancelledError)
})

test('two clients sharing a window cannot steal or close each other transferred ports', async () => {
  const sharedWindow = new FakeWindowTarget()
  const firstRuntime = makeRuntime().runtime
  const secondRuntime = makeRuntime().runtime
  const secondRequest = { ...request, requestId: 18 }
  const secondNonce = 'stream_nonce_18'
  const first = createLocalPcmStreamClient({
    ...firstRuntime,
    windowTarget: sharedWindow,
    createNonce: () => nonce,
  })
  const second = createLocalPcmStreamClient({
    ...secondRuntime,
    windowTarget: sharedWindow,
    createNonce: () => secondNonce,
  })
  const firstPromise = first.decode(request)
  const secondPromise = second.decode(secondRequest)
  const secondPort = new FakePort()

  sharedWindow.dispatch({
    version: LOCAL_PCM_STREAM_VERSION,
    marker: LOCAL_PCM_STREAM_MARKER,
    requestId: secondRequest.requestId,
    nonce: secondNonce,
  }, [secondPort])

  assert.equal(secondPort.started, true)
  assert.equal(secondPort.closed, false)
  assert.equal(first.hasPending(request.requestId), true)
  secondPort.emit({
    version: LOCAL_PCM_STREAM_VERSION,
    requestId: secondRequest.requestId,
    nonce: secondNonce,
    type: 'cancelled',
  })
  await assert.rejects(secondPromise, LocalPcmStreamCancelledError)
  assert.equal(first.cancel(request.requestId), true)
  await assert.rejects(firstPromise, LocalPcmStreamCancelledError)
})
