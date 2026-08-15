import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioEngine, SupersededAudioLoadError, type AudioLoadTimings } from './AudioEngine.ts'
import type { NativeAudioEvent, NativeAudioPlaybackSnapshot } from '../../types/nativeAudio.ts'
import type { Track } from '../types/audio.ts'
import type { PcmTransportTimings } from './pcmTransportTimings.ts'
import {
  LocalPcmStreamCancelledError,
  LocalPcmStreamDecodeError,
  LocalPcmStreamTransportError,
  type LocalPcmStreamClient,
  type LocalPcmStreamDecodeRequest,
  type LocalPcmStreamDecodeResult,
} from './localPcmStreamClient.ts'
import { LOCAL_PCM_DECODE_LIMIT_EXCEEDED_CODE } from '../../shared/localPcmStream.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

type PcmRendererDeliveryTiming = {
  decodeRequestId: number
  rendererBridgeCallMs: number
  deliveredAt: number
  pipelineStartedAt: number
}

type AudioEngineInternals = {
  playbackOutputMode: 'standard' | 'exclusive' | 'bitperfect'
  _playbackState: 'stopped' | 'loading' | 'playing' | 'paused'
  nativeLifecycleSuppressionTokens: Set<number>
  nativeCurrentPlaybackSequence: number | null
  nativeNextPlaybackSequence: number | null
  currentBufferTrackPath: string | null
  nextBufferTrackPath: string | null
  nativeNextTrackBuffered: boolean
  nativeSnapshot: NativeAudioPlaybackSnapshot | null
  context: AudioContext | null
  workletLoaded: boolean
  loadGeneration: number
  prebufferGeneration: number
  parallaxHostPublishGeneration: number
  nextBuffer: AudioBuffer | null
  localPcmStreamClient?: LocalPcmStreamClient
  activePrebufferPcmDecodeRequestId: number | null
  activePrebufferPcmDecodeTrackPath: string | null
  handleNativeAudioEvent: (event: NativeAudioEvent) => void
  initNativeAudio: () => Promise<void>
  initContext: () => Promise<void>
  stopSource: () => void
  clearNextBuffer: () => void
  clearRemoteStreamState: (cancelSession: boolean) => Promise<void>
  clearParallaxSinkState: () => void
  notifyTrackChange: () => void
  createRemoteStreamNode: (channels: number, discardConsumedChunks?: boolean) => AudioWorkletNode
  applyChannelRoutingPreferences: (channels?: number) => void
  applyAnalysisRoutingPreferences: (channels?: number) => void
  refreshNativeCapabilities: () => Promise<void>
  refreshNativeSnapshot: () => Promise<NativeAudioPlaybackSnapshot | null>
  syncNativeScopePolling: () => void
  _normalizationEnabled: boolean
  _replayGainEnabled: boolean
  resolveLoudnessAnalysisForLoad: (
    buffer: AudioBuffer,
    options: {
      trackPath?: string
      loudnessAnalysis?: Promise<{ loudnessLufs: number; peakLinear: number | null } | null> | null
    },
    replayGainDb: number | null,
    assertCurrent: () => void
  ) => Promise<unknown>
  loadPcmDataForOperation: (
    pcm: { interleavedPcm: ArrayBuffer },
    options: { trackPath?: string | null },
    generation: number,
    delivery?: PcmRendererDeliveryTiming,
  ) => Promise<void>
  commitNextPcmBuffer: (
    pcm: { interleavedPcm: ArrayBuffer },
    options: { trackPath?: string | null },
    generation: number,
    delivery?: PcmRendererDeliveryTiming,
  ) => Promise<void>
  buildPcmLoadTimings: (
    pcm: ReturnType<typeof makeLocalPcmResult>,
    installed: {
      validPcmBytes: number
      backingBufferBytes: number
      webAudioBufferAllocationMs: number
      pcmDeinterleaveMs: number
    },
    loudnessMs: number,
    delivery?: PcmRendererDeliveryTiming,
  ) => AudioLoadTimings
}

function makeLocalPcmTrack(id: string): Track {
  return {
    id,
    path: `/pcm/${id}.flac`,
    title: id,
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    format: 'flac',
    channels: 2,
    sourceType: 'local',
  }
}

function makeTransportTimings(
  decodeRequestId: number,
  overrides: Partial<PcmTransportTimings> = {},
): PcmTransportTimings {
  return {
    decodeRequestId,
    validPcmBytes: 2 * Float32Array.BYTES_PER_ELEMENT,
    backingBufferBytes: 2 * Float32Array.BYTES_PER_ELEMENT,
    allocationGrowthCount: 2,
    mainHandlerMs: 120,
    binaryResolutionMs: 3,
    probeMs: 12,
    ffmpegMs: 90,
    allocationMs: 4,
    payloadFinalizationMs: 6,
    preloadInvokeMs: 155,
    ...overrides,
  }
}

function makeLocalPcmResult(
  requestId: number,
  left = 0.25,
  transportTimings?: PcmTransportTimings,
): {
  requestId: number
  sampleRate: number
  channels: number
  frames: number
  pcmByteLength: number
  interleavedPcm: ArrayBuffer
  probeMs: number
  decodeMs: number
  backgroundPriorityApplied: boolean
  transportTimings?: PcmTransportTimings
} {
  return {
    requestId,
    sampleRate: 48_000,
    channels: 2,
    frames: 1,
    pcmByteLength: 2 * Float32Array.BYTES_PER_ELEMENT,
    interleavedPcm: Float32Array.from([left, -left]).buffer,
    probeMs: 2,
    decodeMs: 10,
    backgroundPriorityApplied: false,
    ...(transportTimings ? { transportTimings } : {}),
  }
}

function makeStreamPcmResult(requestId: number, left = 0.25): LocalPcmStreamDecodeResult {
  return {
    ...makeLocalPcmResult(requestId, left),
    transportTimings: {
      decodeRequestId: requestId,
      validPcmBytes: 2 * Float32Array.BYTES_PER_ELEMENT,
      backingBufferBytes: 2 * Float32Array.BYTES_PER_ELEMENT,
      allocationGrowthCount: 0,
      transportRoute: 'message_port_stream',
      mainHandlerMs: 30,
      binaryResolutionMs: 1,
      probeMs: 4,
      ffmpegMs: 20,
      allocationMs: 2,
      initialAllocationMs: 2,
      growthAllocationMs: 0,
      payloadFinalizationMs: 0,
      preloadInvokeMs: 0,
      streamChunkCount: 1,
      streamDispatchCopyMs: 1,
      streamDispatchPostMs: 1,
      streamTailMs: 2,
      rendererPcmAssemblyAllocationMs: 1,
      rendererPcmAssemblyCopyMs: 1,
      rendererPortRequestMs: 35,
    },
  }
}

function makePcmStreamClient(
  decode: (request: LocalPcmStreamDecodeRequest) => Promise<LocalPcmStreamDecodeResult>,
  cancel: (requestId: number) => boolean = () => false,
): LocalPcmStreamClient {
  return {
    decode,
    cancel,
    dispose: () => undefined,
    hasPending: () => false,
    get pendingCount() {
      return 0
    },
  }
}

test('Standard PCM timings keep allocation, deinterleave, loudness, and transport phases distinct', () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const requestId = 23
  const pcm = Object.freeze(makeLocalPcmResult(
    requestId,
    0.25,
    Object.freeze(makeTransportTimings(requestId, {
      validPcmBytes: 8,
      backingBufferBytes: 16,
      initialAllocationMs: 3,
      growthAllocationMs: 1,
    })),
  ))

  const timings = internals.buildPcmLoadTimings(pcm, {
    validPcmBytes: 8,
    backingBufferBytes: 16,
    webAudioBufferAllocationMs: 7,
    pcmDeinterleaveMs: 11,
  }, 13, {
    decodeRequestId: requestId,
    rendererBridgeCallMs: 181,
    deliveredAt: 500,
    pipelineStartedAt: 300,
  })

  assert.equal(timings.decodeRequestId, requestId)
  assert.equal(timings.validPcmBytes, 8)
  assert.equal(timings.backingBufferBytes, 16)
  assert.equal(timings.webAudioBufferAllocationMs, 7)
  assert.equal(timings.pcmDeinterleaveMs, 11)
  assert.equal(timings.pcmAllocationMs, 4)
  assert.equal(timings.initialPcmAllocationMs, 3)
  assert.equal(timings.growthPcmAllocationMs, 1)
  assert.equal(timings.loudnessMs, 13)
  assert.equal(timings.analysisMs, 13)
  assert.equal(timings.decodeWorkMs, 132)
  assert.equal(timings.decodeMs, timings.decodeWorkMs)
  assert.equal(timings.electronIpcResidualMs, 35)
  assert.equal(timings.contextBridgeResidualMs, 26)
})

test('polled native lifecycle events cannot override an authoritative load or device command', () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  internals.playbackOutputMode = 'bitperfect'
  internals._playbackState = 'loading'
  internals.nativeLifecycleSuppressionTokens.add(1)
  internals.nativeCurrentPlaybackSequence = 1
  internals.nativeNextPlaybackSequence = 2
  internals.currentBufferTrackPath = '/music/new.flac'
  internals.nextBufferTrackPath = '/music/new-next.flac'

  const observed: string[] = []
  engine.on('stateChange', () => observed.push('state'))
  engine.on('timeUpdate', () => observed.push('time'))
  engine.on('durationChange', () => observed.push('duration'))
  engine.on('gaplessTransition', () => observed.push('gapless'))
  engine.on('ended', () => observed.push('ended'))

  internals.handleNativeAudioEvent({ type: 'stateChange', playbackSequence: 1, playbackState: 'playing' })
  internals.handleNativeAudioEvent({ type: 'timeUpdate', playbackSequence: 1, currentTime: 99 })
  internals.handleNativeAudioEvent({ type: 'durationChange', playbackSequence: 1, duration: 999 })
  internals.handleNativeAudioEvent({ type: 'gaplessTransition', playbackSequence: 2 })
  internals.handleNativeAudioEvent({ type: 'ended', playbackSequence: 1 })

  assert.deepEqual(observed, [])
  assert.equal(engine.playbackState, 'loading')
  assert.equal(internals.currentBufferTrackPath, '/music/new.flac')
  assert.equal(internals.nextBufferTrackPath, '/music/new-next.flac')

  internals.nativeLifecycleSuppressionTokens.clear()
  internals._playbackState = 'stopped'
  internals.handleNativeAudioEvent({ type: 'stateChange', playbackSequence: 1, playbackState: 'playing' })
  assert.deepEqual(observed, ['state'])
  assert.equal(engine.playbackState, 'playing')
})

test('processed-exclusive lifecycle events use the same suppression and playback sequence guards', () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  internals.playbackOutputMode = 'exclusive'
  internals._playbackState = 'loading'
  internals.nativeLifecycleSuppressionTokens.add(1)
  internals.nativeCurrentPlaybackSequence = 11

  const observed: string[] = []
  engine.on('stateChange', () => observed.push('state'))
  engine.on('timeUpdate', () => observed.push('time'))

  internals.handleNativeAudioEvent({ type: 'stateChange', playbackSequence: 11, playbackState: 'playing' })
  internals.handleNativeAudioEvent({ type: 'timeUpdate', playbackSequence: 11, currentTime: 12 })
  assert.deepEqual(observed, [])

  internals.nativeLifecycleSuppressionTokens.clear()
  internals._playbackState = 'stopped'
  internals.handleNativeAudioEvent({ type: 'stateChange', playbackSequence: 10, playbackState: 'playing' })
  assert.deepEqual(observed, [], 'stale processed-exclusive sequences must be ignored')
  internals.handleNativeAudioEvent({ type: 'stateChange', playbackSequence: 11, playbackState: 'playing' })
  assert.deepEqual(observed, ['state'])
})

test('processed-exclusive native decode starts without waiting for loudness analysis', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let resolveLoudness!: (value: { loudnessLufs: number; peakLinear: number }) => void
  const loudnessAnalysis = new Promise<{ loudnessLufs: number; peakLinear: number }>((resolve) => {
    resolveLoudness = resolve
  })
  let nativeLoadStarted = false
  let nativeGainUpdates = 0
  const snapshot = {
    playbackSequence: 31,
    playbackState: 'stopped',
    currentTime: 0,
    duration: 180,
    sampleRate: 48_000,
    channels: 2,
    sampleFormat: 'f32',
    deviceId: 'exclusive-test',
    deviceLabel: 'Exclusive Test Device',
    outputStatus: {}
  } as NativeAudioPlaybackSnapshot

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      nativeAudioAPI: {
        loadTrack: async () => {
          nativeLoadStarted = true
          return {
            playbackSequence: 31,
            sampleRate: 48_000,
            channels: 2,
            sampleFormat: 'f32',
            duration: 180
          }
        },
        setNativeTrackGain: async () => {
          nativeGainUpdates += 1
          return snapshot
        }
      }
    }
  })

  internals.playbackOutputMode = 'exclusive'
  internals._normalizationEnabled = true
  internals._replayGainEnabled = false
  internals.initNativeAudio = async () => undefined
  internals.refreshNativeCapabilities = async () => undefined
  internals.refreshNativeSnapshot = async () => snapshot
  engine.clearNextBuffer = async () => undefined

  try {
    const load = engine.loadTrackFromPath(makeLocalPcmTrack('exclusive-parallel-gain'), {
      trackPath: '/pcm/exclusive-parallel-gain.flac',
      loudnessAnalysis
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(nativeLoadStarted, true, 'native decode/load must overlap optional loudness analysis')
    assert.equal(nativeGainUpdates, 0)

    resolveLoudness({ loudnessLufs: -20, peakLinear: 0.5 })
    await load
    assert.equal(nativeGainUpdates, 1)
  } finally {
    resolveLoudness?.({ loudnessLufs: -20, peakLinear: 0.5 })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  }
})

test('superseded external loudness cancellation cannot enter renderer fallback analysis', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  internals._normalizationEnabled = true
  internals._replayGainEnabled = false

  let resolveExternal!: (value: null) => void
  const externalLoudness = new Promise<null>((resolve) => {
    resolveExternal = resolve
  })
  let current = true
  let fallbackChannelReads = 0
  let generationChecks = 0
  const buffer = {
    sampleRate: 44_100,
    length: 32,
    numberOfChannels: 1,
    getChannelData: () => {
      fallbackChannelReads += 1
      return new Float32Array(32)
    }
  } as unknown as AudioBuffer

  const analysis = internals.resolveLoudnessAnalysisForLoad(
    buffer,
    { trackPath: '/superseded-loudness.flac', loudnessAnalysis: externalLoudness },
    null,
    () => {
      generationChecks += 1
      if (!current) throw new SupersededAudioLoadError()
    }
  )

  current = false
  resolveExternal(null)
  await assert.rejects(analysis, SupersededAudioLoadError)
  assert.equal(generationChecks, 1)
  assert.equal(fallbackChannelReads, 0, 'obsolete null results must not trigger renderer analysis')
})

test('a delayed native lifecycle event cannot advance a newly started track after play settles', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const startedSnapshot = {
    playbackState: 'playing',
    currentTime: 0,
    duration: 180,
    sampleRate: 96_000,
    channels: 2,
    sampleFormat: 's24',
    deviceId: 'device-test',
    deviceLabel: 'Test Device',
    outputStatus: {}
  } as NativeAudioPlaybackSnapshot
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      nativeAudioAPI: {
        play: async () => startedSnapshot
      }
    }
  })

  internals.playbackOutputMode = 'bitperfect'
  internals._playbackState = 'paused'
  internals.loadGeneration = 7
  internals.nativeCurrentPlaybackSequence = 2
  internals.nativeNextPlaybackSequence = 3
  internals.currentBufferTrackPath = '/native-delayed/new.flac'
  internals.nextBufferTrackPath = '/native-delayed/stale-next.flac'
  internals.nativeNextTrackBuffered = true
  internals.nativeSnapshot = startedSnapshot
  internals.initNativeAudio = async () => undefined
  internals.refreshNativeCapabilities = async () => undefined
  internals.syncNativeScopePolling = () => undefined
  const gaplessEvents: string[] = []
  engine.on('gaplessTransition', () => gaplessEvents.push('gapless'))

  try {
    await engine.play()
    await Promise.resolve()
    internals.nativeLifecycleSuppressionTokens.clear()

    internals.handleNativeAudioEvent({ type: 'gaplessTransition', playbackSequence: 1 })
    assert.deepEqual(gaplessEvents, [])
    assert.equal(internals.currentBufferTrackPath, '/native-delayed/new.flac')
    assert.equal(internals.nextBufferTrackPath, '/native-delayed/stale-next.flac')
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  }
})

test('superseding a native load during deferred clear-next prevents the subsequent decode/load', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let nativeLoadCalls = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      nativeAudioAPI: {
        loadTrack: async () => {
          nativeLoadCalls += 1
          return {
            playbackSequence: 1,
            sampleRate: 96_000,
            channels: 2,
            sampleFormat: 's24',
            duration: 180
          }
        }
      }
    }
  })

  let resolveClear!: () => void
  const clearGate = new Promise<void>((resolve) => {
    resolveClear = resolve
  })
  let clearStarted = false
  engine.clearNextBuffer = () => {
    clearStarted = true
    return clearGate
  }
  internals.playbackOutputMode = 'bitperfect'
  internals.initNativeAudio = async () => undefined
  const track: Track = {
    id: 'native-clear-race',
    path: '/native-clear-race/target.flac',
    title: 'Native Clear Race',
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    format: 'flac',
    sourceType: 'local'
  }

  try {
    const load = engine.loadTrackFromPath(track)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(clearStarted, true)

    engine.supersedeCurrentLoadPreservingPrebuffer()
    resolveClear()

    await assert.rejects(load, SupersededAudioLoadError)
    assert.equal(nativeLoadCalls, 0, 'a superseded request must not begin native probe/decode after clear-next')
  } finally {
    resolveClear()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  }
})

test('local progressive playback uses stable unity gain and can seek without fixed loudness', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const starts: Array<{ path: string; startTimeSeconds: number | null | undefined }> = []
  const producerPositions: Array<{ sessionId: number; currentFrame: number }> = []
  const discardPolicies: boolean[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        startProgressiveStream: async (
          path: string,
          _sampleRate: number,
          _channels: number | null,
          options?: { startTimeSeconds?: number | null }
        ) => {
          starts.push({ path, startTimeSeconds: options?.startTimeSeconds })
          return {
            sessionId: starts.length,
            path,
            sourceType: 'local' as const,
            sampleRate: 48_000,
            channels: 2,
            durationSeconds: 12 * 60 * 60,
            startTimeSeconds: options?.startTimeSeconds ?? 0
          }
        },
        updateProgressiveStreamPosition: (sessionId: number, currentFrame: number) => {
          producerPositions.push({ sessionId, currentFrame })
        },
        cancelProgressiveStream: async () => undefined,
      },
    },
  })
  internals.context = { sampleRate: 48_000 } as AudioContext
  internals.workletLoaded = true
  internals.initContext = async () => undefined
  internals.stopSource = () => undefined
  internals.clearNextBuffer = () => undefined
  internals.clearRemoteStreamState = async () => undefined
  internals.clearParallaxSinkState = () => undefined
  internals.notifyTrackChange = () => undefined
  internals.createRemoteStreamNode = (_channels, discardConsumedChunks = false) => {
    discardPolicies.push(discardConsumedChunks)
    return {
      port: { postMessage: () => undefined },
      disconnect: () => undefined
    } as unknown as AudioWorkletNode
  }
  internals.applyChannelRoutingPreferences = () => undefined
  internals.applyAnalysisRoutingPreferences = () => undefined
  internals._normalizationEnabled = true
  internals._replayGainEnabled = false
  const track = {
    ...makeLocalPcmTrack('progressive-unity'),
    duration: 12 * 60 * 60
  }

  try {
    await engine.loadProgressiveStream(track, { loudnessAnalysis: null })
    assert.equal(engine.getNormalizationMode(), 'normalization')
    assert.equal(engine.getNormalizationGainDb(), 0)
    assert.equal(engine.isNormalizationApproximate(), false)

    await engine.seek(120)
    assert.deepEqual(starts, [
      { path: track.path, startTimeSeconds: 0 },
      { path: track.path, startTimeSeconds: 120 }
    ])
    assert.deepEqual(discardPolicies, [true, true])
    assert.deepEqual(producerPositions, [
      { sessionId: 1, currentFrame: 0 },
      { sessionId: 2, currentFrame: 0 }
    ])
    assert.equal(engine.getNormalizationMode(), 'normalization')
    assert.equal(engine.getNormalizationGainDb(), 0)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  }
})

test('pending or failed Standard PCM decode leaves live playback, Parallax, and matching prebuffer untouched', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let rejectDecode!: (error: Error) => void
  let decodeStarted = false
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        decodeLocalAudioToPcm: async () => new Promise<null>((_resolve, reject) => {
          decodeStarted = true
          rejectDecode = reject
        }),
        cancelLocalAudioDecode: async () => undefined,
      },
    },
  })

  const track = makeLocalPcmTrack('preserve-live-state')
  internals.context = { sampleRate: 48_000 } as AudioContext
  internals.initContext = async () => undefined
  internals.loadGeneration = 17
  internals.prebufferGeneration = 23
  internals.parallaxHostPublishGeneration = 31
  internals.nextBuffer = {} as AudioBuffer
  internals.nextBufferTrackPath = track.path

  try {
    const load = engine.loadStandardTrackFromPath(track)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(decodeStarted, true)
    assert.equal(internals.loadGeneration, 17)
    assert.equal(internals.prebufferGeneration, 23)
    assert.equal(internals.parallaxHostPublishGeneration, 31)
    assert.equal(engine.nextBufferedTrackPath, track.path)

    rejectDecode(new Error('native decode failed'))
    assert.equal(await load, 'failed')
    assert.equal(internals.loadGeneration, 17)
    assert.equal(internals.prebufferGeneration, 23)
    assert.equal(internals.parallaxHostPublishGeneration, 31)
    assert.equal(engine.nextBufferedTrackPath, track.path)
  } finally {
    rejectDecode?.(new Error('test cleanup'))
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  }
})

test('Standard PCM keeps the legacy invoke route unchanged when stream setup is unavailable', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const calls: unknown[][] = []
  const committedPaths: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        decodeLocalAudioToPcm: async (...args: unknown[]) => {
          calls.push(args)
          return makeLocalPcmResult(args[0] as number)
        },
        cancelLocalAudioDecode: async () => undefined,
      },
    },
  })
  internals.context = { sampleRate: 48_000 } as AudioContext
  internals.initContext = async () => undefined
  internals.loadPcmDataForOperation = async (_pcm, options) => {
    committedPaths.push(options.trackPath ?? '')
  }
  const track = makeLocalPcmTrack('legacy-only')

  try {
    assert.equal(await engine.loadStandardTrackFromPath(track), 'loaded')
    assert.deepEqual(calls, [[1, track.path, 48_000, 2, 'interactive']])
    assert.deepEqual(committedPaths, [track.path])
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  }
})

test('Standard PCM falls back to legacy invoke exactly once when the stream handshake fails', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const streamRequests: LocalPcmStreamDecodeRequest[] = []
  const legacyCalls: unknown[][] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        openLocalAudioPcmStream: () => true,
        decodeLocalAudioToPcm: async (...args: unknown[]) => {
          legacyCalls.push(args)
          return makeLocalPcmResult(args[0] as number)
        },
        cancelLocalAudioDecode: async () => undefined,
      },
    },
  })
  internals.context = { sampleRate: 48_000 } as AudioContext
  internals.initContext = async () => undefined
  internals.localPcmStreamClient = makePcmStreamClient(async (request) => {
    streamRequests.push(request)
    throw new LocalPcmStreamTransportError('open_rejected', 'test handshake failure')
  })
  internals.loadPcmDataForOperation = async () => undefined
  const track = makeLocalPcmTrack('stream-handshake-fallback')

  try {
    assert.equal(await engine.loadStandardTrackFromPath(track), 'loaded')
    assert.deepEqual(streamRequests, [{
      requestId: 1,
      filePath: track.path,
      outputSampleRate: 48_000,
      expectedChannels: 2,
      priority: 'interactive',
    }])
    assert.deepEqual(legacyCalls, [[1, track.path, 48_000, 2, 'interactive']])
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  }
})

test('a legacy complete-PCM size-limit refusal remains progressive-required', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let legacyCalls = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        decodeLocalAudioToPcm: async () => {
          legacyCalls += 1
          return {
            refused: true as const,
            code: LOCAL_PCM_DECODE_LIMIT_EXCEEDED_CODE,
            message: 'Decoded audio exceeds the 192 MiB Standard playback limit.'
          }
        },
        cancelLocalAudioDecode: async () => undefined,
      },
    },
  })
  internals.context = { sampleRate: 48_000 } as AudioContext
  internals.initContext = async () => undefined

  try {
    assert.equal(
      await engine.loadStandardTrackFromPath(makeLocalPcmTrack('legacy-size-limit')),
      'progressive_required'
    )
    assert.equal(legacyCalls, 1)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  }
})

test('Standard PCM stream success preserves request correlation and skips legacy invoke', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const requests: LocalPcmStreamDecodeRequest[] = []
  const committed: Array<{
    pcm: { interleavedPcm: ArrayBuffer; transportTimings?: PcmTransportTimings }
    path: string
    delivery?: PcmRendererDeliveryTiming
  }> = []
  let legacyCalls = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        openLocalAudioPcmStream: () => true,
        decodeLocalAudioToPcm: async () => {
          legacyCalls += 1
          return null
        },
        cancelLocalAudioDecode: async () => undefined,
      },
    },
  })
  internals.context = { sampleRate: 48_000 } as AudioContext
  internals.initContext = async () => undefined
  internals.localPcmStreamClient = makePcmStreamClient(async (request) => {
    requests.push(request)
    return makeStreamPcmResult(request.requestId, 0.4)
  })
  internals.loadPcmDataForOperation = async (pcm, options, _generation, delivery) => {
    committed.push({
      pcm: pcm as { interleavedPcm: ArrayBuffer; transportTimings?: PcmTransportTimings },
      path: options.trackPath ?? '',
      delivery,
    })
  }
  const track = makeLocalPcmTrack('stream-success')

  try {
    assert.equal(await engine.loadStandardTrackFromPath(track), 'loaded')
    assert.equal(legacyCalls, 0)
    assert.deepEqual(requests, [{
      requestId: 1,
      filePath: track.path,
      outputSampleRate: 48_000,
      expectedChannels: 2,
      priority: 'interactive',
    }])
    assert.equal(committed.length, 1)
    assert.equal(committed[0]?.path, track.path)
    assert.equal(committed[0]?.delivery?.decodeRequestId, 1)
    assert.equal(committed[0]?.pcm.transportTimings?.decodeRequestId, 1)
    assert.equal(committed[0]?.pcm.transportTimings?.transportRoute, 'message_port_stream')
    assert.deepEqual(
      Array.from(new Float32Array(committed[0]?.pcm.interleavedPcm)),
      Array.from(Float32Array.from([0.4, -0.4])),
    )
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  }
})

test('a genuine streamed PCM decode error does not retry native decode through invoke', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let legacyCalls = 0
  let commitCalls = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        openLocalAudioPcmStream: () => true,
        decodeLocalAudioToPcm: async () => {
          legacyCalls += 1
          return null
        },
        cancelLocalAudioDecode: async () => undefined,
      },
    },
  })
  internals.context = { sampleRate: 48_000 } as AudioContext
  internals.initContext = async () => undefined
  internals.localPcmStreamClient = makePcmStreamClient(async () => {
    throw new LocalPcmStreamDecodeError('PCM_DECODE_FAILED', 'test decode failure')
  })
  internals.loadPcmDataForOperation = async () => {
    commitCalls += 1
  }

  try {
    assert.equal(await engine.loadStandardTrackFromPath(makeLocalPcmTrack('stream-decode-error')), 'failed')
    assert.equal(legacyCalls, 0)
    assert.equal(commitCalls, 0)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  }
})

test('a streamed complete-PCM size-limit refusal remains progressive-required', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let legacyCalls = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        openLocalAudioPcmStream: () => true,
        decodeLocalAudioToPcm: async () => {
          legacyCalls += 1
          return null
        },
        cancelLocalAudioDecode: async () => undefined,
      },
    },
  })
  internals.context = { sampleRate: 48_000 } as AudioContext
  internals.initContext = async () => undefined
  internals.localPcmStreamClient = makePcmStreamClient(async () => {
    throw new LocalPcmStreamDecodeError(
      LOCAL_PCM_DECODE_LIMIT_EXCEEDED_CODE,
      'Decoded audio exceeds the 192 MiB Standard playback limit.'
    )
  })

  try {
    assert.equal(
      await engine.loadStandardTrackFromPath(makeLocalPcmTrack('stream-size-limit')),
      'progressive_required'
    )
    assert.equal(legacyCalls, 0)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  }
})

test('superseding a streamed PCM request cleans it up immediately and ignores late delivery', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const pending = createDeferred<LocalPcmStreamDecodeResult>()
  const decodeStarted = createDeferred<number>()
  const clientCancelled: number[] = []
  const mainCancelled: number[] = []
  let commitCalls = 0
  let pendingRequestId: number | null = null
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        openLocalAudioPcmStream: () => true,
        decodeLocalAudioToPcm: async () => {
          throw new Error('legacy invoke must not run for user cancellation')
        },
        cancelLocalAudioDecode: async (requestId: number) => {
          mainCancelled.push(requestId)
        },
      },
    },
  })
  internals.context = { sampleRate: 48_000 } as AudioContext
  internals.initContext = async () => undefined
  internals.localPcmStreamClient = makePcmStreamClient(
    async (request) => {
      pendingRequestId = request.requestId
      decodeStarted.resolve(request.requestId)
      return pending.promise
    },
    (requestId) => {
      clientCancelled.push(requestId)
      pending.reject(new LocalPcmStreamCancelledError())
      return true
    },
  )
  internals.loadPcmDataForOperation = async () => {
    commitCalls += 1
  }

  try {
    const load = engine.loadStandardTrackFromPath(makeLocalPcmTrack('stream-cancelled'))
    const requestId = await decodeStarted.promise
    engine.supersedeCurrentLoadPreservingPrebuffer()
    pending.resolve(makeStreamPcmResult(requestId, 0.9))

    assert.equal(await load, 'cancelled')
    await Promise.resolve()
    assert.equal(pendingRequestId, requestId)
    assert.deepEqual(clientCancelled, [requestId])
    assert.deepEqual(mainCancelled, [requestId])
    assert.equal(commitCalls, 0)
  } finally {
    pending.reject(new LocalPcmStreamCancelledError('test cleanup'))
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  }
})

test('concurrent current and prebuffer PCM streams keep request results isolated', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const pending = new Map<number, Deferred<LocalPcmStreamDecodeResult>>()
  const requests: LocalPcmStreamDecodeRequest[] = []
  const currentCommits: Array<{ path: string; requestId: number | undefined }> = []
  const prebufferCommits: Array<{ path: string; requestId: number | undefined }> = []
  const mainCancelled: number[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        openLocalAudioPcmStream: () => true,
        decodeLocalAudioToPcm: async () => {
          throw new Error('legacy invoke must not run for active streams')
        },
        cancelLocalAudioDecode: async (requestId: number) => {
          mainCancelled.push(requestId)
        },
      },
    },
  })
  internals.context = { sampleRate: 48_000 } as AudioContext
  internals.initContext = async () => undefined
  internals.localPcmStreamClient = makePcmStreamClient(async (request) => {
    requests.push(request)
    const deferred = createDeferred<LocalPcmStreamDecodeResult>()
    pending.set(request.requestId, deferred)
    return deferred.promise
  })
  internals.loadPcmDataForOperation = async (pcm, options, _generation, delivery) => {
    currentCommits.push({
      path: options.trackPath ?? '',
      requestId: delivery?.decodeRequestId ?? (pcm as { requestId?: number }).requestId,
    })
  }
  internals.commitNextPcmBuffer = async (pcm, options, _generation, delivery) => {
    prebufferCommits.push({
      path: options.trackPath ?? '',
      requestId: delivery?.decodeRequestId ?? (pcm as { requestId?: number }).requestId,
    })
  }
  const currentTrack = makeLocalPcmTrack('stream-current')
  const nextTrack = makeLocalPcmTrack('stream-prebuffer')

  try {
    const currentLoad = engine.loadStandardTrackFromPath(currentTrack)
    const nextLoad = engine.preBufferNextStandardTrackFromPath(nextTrack)
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.equal(requests.length, 2)
    const currentRequest = requests.find((request) => request.filePath === currentTrack.path)
    const prebufferRequest = requests.find((request) => request.filePath === nextTrack.path)
    assert.ok(currentRequest)
    assert.ok(prebufferRequest)
    assert.notEqual(currentRequest.requestId, prebufferRequest.requestId)
    assert.equal(currentRequest.priority, 'interactive')
    assert.equal(prebufferRequest.priority, 'background')

    pending.get(prebufferRequest.requestId)?.resolve(
      makeStreamPcmResult(prebufferRequest.requestId, 0.2),
    )
    assert.equal(await nextLoad, 'loaded')
    pending.get(currentRequest.requestId)?.resolve(
      makeStreamPcmResult(currentRequest.requestId, 0.7),
    )
    assert.equal(await currentLoad, 'loaded')

    assert.deepEqual(prebufferCommits, [{ path: nextTrack.path, requestId: prebufferRequest.requestId }])
    assert.deepEqual(currentCommits, [{ path: currentTrack.path, requestId: currentRequest.requestId }])
    assert.deepEqual(mainCancelled, [])
  } finally {
    for (const [requestId, deferred] of pending) {
      deferred.resolve(makeStreamPcmResult(requestId))
    }
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  }
})

test('Standard PCM latest-wins cancels stale decode without committing until the winner is ready', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const pending = new Map<number, {
    resolve: (result: ReturnType<typeof makeLocalPcmResult>) => void
  }>()
  const cancelled: number[] = []
  const committedPaths: string[] = []
  const committedDeliveries: PcmRendererDeliveryTiming[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        decodeLocalAudioToPcm: async (requestId: number) => new Promise((resolve) => {
          pending.set(requestId, { resolve })
        }),
        cancelLocalAudioDecode: async (requestId: number) => {
          cancelled.push(requestId)
        },
      },
    },
  })

  internals.context = { sampleRate: 48_000 } as AudioContext
  internals.initContext = async () => undefined
  internals.loadGeneration = 41
  internals.prebufferGeneration = 53
  internals.parallaxHostPublishGeneration = 67
  internals.loadPcmDataForOperation = async (pcm, options, generation, delivery) => {
    assert.equal(generation, internals.loadGeneration)
    // Real contextBridge return values may be frozen. The engine must pass an
    // owned wrapper into the commit path so releasing the IPC buffer is safe.
    pcm.interleavedPcm = new ArrayBuffer(0)
    committedPaths.push(options.trackPath ?? '')
    assert.ok(delivery)
    committedDeliveries.push(delivery)
  }

  const firstTrack = makeLocalPcmTrack('first')
  const secondTrack = makeLocalPcmTrack('second')
  try {
    const firstLoad = engine.loadStandardTrackFromPath(firstTrack)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const firstRequestId = Array.from(pending.keys())[0]
    assert.ok(Number.isSafeInteger(firstRequestId))

    const secondLoad = engine.loadStandardTrackFromPath(secondTrack)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const secondRequestId = Array.from(pending.keys()).find((id) => id !== firstRequestId)
    assert.ok(secondRequestId != null)
    assert.deepEqual(cancelled, [firstRequestId])
    assert.equal(internals.loadGeneration, 41, 'starting a newer decode must not claim playback')
    assert.equal(internals.parallaxHostPublishGeneration, 67)
    assert.deepEqual(committedPaths, [])

    // Even if cancellation races and the obsolete process returns PCM, its
    // independent decode generation prevents it from reaching the load path.
    pending.get(firstRequestId)?.resolve(makeLocalPcmResult(firstRequestId, 0.1))
    assert.equal(await firstLoad, 'cancelled')
    assert.deepEqual(committedPaths, [])

    const frozenTransport = Object.freeze(makeTransportTimings(secondRequestId))
    pending.get(secondRequestId)?.resolve(Object.freeze(
      makeLocalPcmResult(secondRequestId, 0.2, frozenTransport),
    ))
    assert.equal(await secondLoad, 'loaded')
    assert.deepEqual(committedPaths, [secondTrack.path])
    assert.equal(committedDeliveries[0]?.decodeRequestId, secondRequestId)
    assert.ok(committedDeliveries[0]?.rendererBridgeCallMs >= 0)
    assert.ok(committedDeliveries[0]?.deliveredAt >= committedDeliveries[0]?.pipelineStartedAt)
    assert.equal(internals.loadGeneration, 42)
    assert.equal(internals.prebufferGeneration, 54)
    assert.equal(internals.parallaxHostPublishGeneration, 68)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  }
})

test('matching Next promotes only its active background PCM decode request', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let activeRequestId: number | null = null
  let resolveDecode!: (result: ReturnType<typeof makeLocalPcmResult>) => void
  let decodeStarted = false
  const promotedRequestIds: number[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        decodeLocalAudioToPcm: async (requestId: number) => new Promise<ReturnType<typeof makeLocalPcmResult>>((resolve) => {
          activeRequestId = requestId
          resolveDecode = resolve
          decodeStarted = true
        }),
        cancelLocalAudioDecode: async () => undefined,
        promoteLocalAudioDecode: async (requestId: number) => {
          promotedRequestIds.push(requestId)
        },
      },
    },
  })

  const track = makeLocalPcmTrack('promoted-prebuffer')
  internals.context = { sampleRate: 48_000 } as AudioContext
  internals.initContext = async () => undefined
  internals.commitNextPcmBuffer = async () => undefined

  try {
    const prebuffer = engine.preBufferNextStandardTrackFromPath(track, { priority: 'background' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const requestId = activeRequestId
    assert.ok(requestId != null)
    assert.equal(internals.activePrebufferPcmDecodeRequestId, requestId)
    assert.equal(internals.activePrebufferPcmDecodeTrackPath, track.path)

    assert.equal(engine.promoteMatchingPrebufferDecode('/pcm/not-this-track.flac'), false)
    assert.equal(engine.promoteMatchingPrebufferDecode(track.path), true)
    await Promise.resolve()
    assert.deepEqual(promotedRequestIds, [requestId])

    resolveDecode(makeLocalPcmResult(requestId))
    assert.equal(await prebuffer, 'loaded')
    assert.equal(internals.activePrebufferPcmDecodeRequestId, null)
    assert.equal(internals.activePrebufferPcmDecodeTrackPath, null)
    assert.equal(engine.promoteMatchingPrebufferDecode(track.path), false)
  } finally {
    if (decodeStarted && activeRequestId != null) resolveDecode(makeLocalPcmResult(activeRequestId))
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  }
})
