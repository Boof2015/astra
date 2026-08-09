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
  standardTransportSetupMs: number
  standardContextReadyMs: number
  standardDecodeRequestSetupMs: number
}

type AudioEngineInternals = {
  playbackOutputMode: 'standard' | 'exclusive' | 'bitperfect'
  _playbackState: 'stopped' | 'loading' | 'playing' | 'paused'
  nativeLifecycleSuppressionTokens: Set<number>
  nativeCurrentPlaybackSequence: number | null
  nativeNextPlaybackSequence: number | null
  audioBuffer: AudioBuffer | null
  currentBufferTrackPath: string | null
  nextBufferTrackPath: string | null
  nativeNextTrackBuffered: boolean
  nativeSnapshot: NativeAudioPlaybackSnapshot | null
  context: AudioContext | null
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
  refreshNativeCapabilities: () => Promise<void>
  refreshNativeSnapshot: () => Promise<NativeAudioPlaybackSnapshot | null>
  syncNativeScopePolling: () => void
  scheduleGaplessTransition: () => void
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
      pcmDestinationViewMs: number
      pcmCopySetupMs: number
      pcmChannelCopyTotalMs: number
      pcmChannelCopyMaxMs: number
      pcmChannelCopyByChannelMs: number[]
      pcmPayloadReleaseMs: number
      pcmDeinterleaveResidualMs: number
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

const FFMPEG_STDOUT_TIMINGS = Object.freeze({
  ffmpegStdoutChunkCount: 2,
  ffmpegStdoutBytes: 2 * Float32Array.BYTES_PER_ELEMENT,
  ffmpegStdoutChunkMinBytes: 4,
  ffmpegStdoutChunkMaxBytes: 4,
  ffmpegStdoutDrainSpanMs: 66,
  ffmpegStdoutDrainToCloseMs: 3,
  ffmpegStdoutCallbackWorkMs: 5,
  ffmpegStdoutCallbackMaxMs: 3,
  ffmpegStdoutInterCallbackGapMs: 61,
  ffmpegStdoutInterCallbackGapMaxMs: 50,
  ffmpegStdoutPostDispatchGapCount: 1,
  ffmpegStdoutPostDispatchGapMs: 5,
  ffmpegStdoutPostDispatchGapMaxMs: 5,
  ffmpegStdoutCopyMs: 3,
  ffmpegStdoutCopyMaxMs: 2,
  ffmpegStdoutFlushMs: 1,
  ffmpegStdoutFlushMaxMs: 1,
  ffmpegStdoutPauseCount: 1,
  ffmpegStdoutPausedMs: 6,
  ffmpegStdoutPauseMaxMs: 6,
}) satisfies Readonly<Partial<PcmTransportTimings>>

const STREAM_FFMPEG_STDOUT_TIMINGS = Object.freeze({
  ...FFMPEG_STDOUT_TIMINGS,
  ffmpegStdoutDrainSpanMs: 15,
  ffmpegStdoutDrainToCloseMs: 1,
  ffmpegStdoutCallbackWorkMs: 5,
  ffmpegStdoutInterCallbackGapMs: 10,
  ffmpegStdoutInterCallbackGapMaxMs: 10,
}) satisfies Readonly<Partial<PcmTransportTimings>>

const STREAM_CREDIT_TIMINGS = Object.freeze({
  streamCreditAckCount: 1,
  streamCreditRoundTripMs: 5,
  streamCreditRoundTripMaxMs: 5,
}) satisfies Readonly<Partial<PcmTransportTimings>>

function assertFfmpegStdoutTimings(
  actual: object | null | undefined,
  expectedTimings: Readonly<Partial<PcmTransportTimings>> = FFMPEG_STDOUT_TIMINGS,
): void {
  assert.ok(actual)
  const record = actual as Record<string, unknown>
  for (const [field, expected] of Object.entries(expectedTimings)) {
    assert.equal(record[field], expected, `unexpected FFmpeg stdout timing: ${field}`)
  }
}

function assertStreamCreditTimings(actual: object | null | undefined): void {
  assert.ok(actual)
  const record = actual as Record<string, unknown>
  for (const [field, expected] of Object.entries(STREAM_CREDIT_TIMINGS)) {
    assert.equal(record[field], expected, `unexpected stream-credit timing: ${field}`)
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
    probeCacheStatus: 'hit',
    probeDecodeOverlapEnabled: true,
    probeFfmpegOverlapMs: 9,
    ffmpegMs: 90,
    ffmpegOutputSink: 'stdout_pipe',
    ffmpegSpawnToFirstPcmMs: 21,
    ffmpegPcmOutputSpanMs: 64,
    ffmpegCloseTailMs: 5,
    ...FFMPEG_STDOUT_TIMINGS,
    ...STREAM_CREDIT_TIMINGS,
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
      probeCacheStatus: 'hit',
      probeDecodeOverlapEnabled: true,
      probeFfmpegOverlapMs: 3,
      ffmpegMs: 20,
      ffmpegSpawnToFirstPcmMs: 4,
      ffmpegPcmOutputSpanMs: 14,
      ffmpegCloseTailMs: 2,
      ...STREAM_FFMPEG_STDOUT_TIMINGS,
      ...STREAM_CREDIT_TIMINGS,
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
      ffmpegOutputSink: 'temporary_file',
      tempPcmCreateMs: 1.5,
      tempPcmStatMs: 0.5,
      tempPcmReadMs: 14,
      tempPcmReadChunkCount: 2,
      tempPcmBytes: 8,
      tempPcmCleanupMs: 2,
      tempPcmCleanupSucceeded: true,
    })),
  ))

  const timings = internals.buildPcmLoadTimings(pcm, {
    validPcmBytes: 8,
    backingBufferBytes: 16,
    webAudioBufferAllocationMs: 7,
    pcmDeinterleaveMs: 11,
    pcmDestinationViewMs: 0.5,
    pcmCopySetupMs: 0.25,
    pcmChannelCopyTotalMs: 9,
    pcmChannelCopyMaxMs: 5,
    pcmChannelCopyByChannelMs: [4, 5],
    pcmPayloadReleaseMs: 0.25,
    pcmDeinterleaveResidualMs: 1,
  }, 13, {
    decodeRequestId: requestId,
    rendererBridgeCallMs: 181,
    deliveredAt: 500,
    pipelineStartedAt: 300,
    standardTransportSetupMs: 18,
    standardContextReadyMs: 16,
    standardDecodeRequestSetupMs: 2,
  })

  assert.equal(timings.decodeRequestId, requestId)
  assert.equal(timings.validPcmBytes, 8)
  assert.equal(timings.backingBufferBytes, 16)
  assert.equal(timings.webAudioBufferAllocationMs, 7)
  assert.equal(timings.pcmDeinterleaveMs, 11)
  assert.equal(timings.pcmDestinationViewMs, 0.5)
  assert.equal(timings.pcmCopySetupMs, 0.25)
  assert.equal(timings.pcmChannelCopyTotalMs, 9)
  assert.equal(timings.pcmChannelCopyMaxMs, 5)
  assert.deepEqual(timings.pcmChannelCopyByChannelMs, [4, 5])
  assert.equal(timings.pcmPayloadReleaseMs, 0.25)
  assert.equal(timings.pcmDeinterleaveResidualMs, 1)
  assert.equal(timings.standardTransportSetupMs, 18)
  assert.equal(timings.standardContextReadyMs, 16)
  assert.equal(timings.standardDecodeRequestSetupMs, 2)
  assert.equal(timings.pcmAllocationMs, 4)
  assert.equal(timings.initialPcmAllocationMs, 3)
  assert.equal(timings.growthPcmAllocationMs, 1)
  assert.equal(timings.loudnessMs, 13)
  assert.equal(timings.analysisMs, 13)
  assert.equal(timings.decodeWorkMs, 120)
  assert.equal(timings.decodeMs, timings.decodeWorkMs)
  assert.equal(timings.ffmpegOutputSink, 'temporary_file')
  assert.equal(timings.tempPcmCreateMs, 1.5)
  assert.equal(timings.tempPcmStatMs, 0.5)
  assert.equal(timings.tempPcmReadMs, 14)
  assert.equal(timings.tempPcmReadChunkCount, 2)
  assert.equal(timings.tempPcmBytes, 8)
  assert.equal(timings.tempPcmCleanupMs, 2)
  assert.equal(timings.tempPcmCleanupSucceeded, true)
  assert.equal(timings.electronIpcResidualMs, 35)
  assert.equal(timings.contextBridgeResidualMs, 26)
  assert.equal(timings.probeCacheStatus, 'hit')
  assert.equal(timings.probeDecodeOverlapEnabled, true)
  assert.equal(timings.probeFfmpegOverlapMs, 9)
  assert.equal(timings.ffmpegSpawnToFirstPcmMs, 21)
  assert.equal(timings.ffmpegPcmOutputSpanMs, 64)
  assert.equal(timings.ffmpegCloseTailMs, 5)
  assertFfmpegStdoutTimings(timings)
  assertStreamCreditTimings(timings)
})

test('Standard PCM timings propagate worker-thread ingestion without inflating decode work', () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const requestId = 24
  const workerTimings = {
    ffmpegOutputSink: 'worker_thread' as const,
    ffmpegWorkerStartupMs: 2,
    ffmpegWorkerTotalMs: 101,
    ffmpegWorkerSpawnMs: 3,
    ffmpegWorkerFfmpegMs: 90,
    ffmpegWorkerSpawnToFirstPcmMs: 20,
    ffmpegWorkerPcmOutputSpanMs: 65,
    ffmpegWorkerCloseTailMs: 5,
    ffmpegWorkerRequestMs: 105,
    ffmpegWorkerMainDeliverySpanMs: 83,
    ffmpegWorkerBatchCount: 1,
    ffmpegWorkerBatchBytes: 8,
    ffmpegWorkerBatchMinBytes: 8,
    ffmpegWorkerBatchMaxBytes: 8,
    ffmpegWorkerAggregationCopyMs: 7,
    ffmpegWorkerAggregationCopyMaxMs: 7,
    ffmpegWorkerBatchCopyMs: 7,
    ffmpegWorkerBatchPostMs: 0.75,
    ffmpegWorkerMainCopyMs: 5,
    ffmpegWorkerMainCopyMaxMs: 5,
    ffmpegWorkerCreditWaitCount: 1,
    ffmpegWorkerCreditWaitMs: 11,
    ffmpegWorkerCreditWaitMaxMs: 11,
  }
  const pcm = makeLocalPcmResult(
    requestId,
    0.25,
    makeTransportTimings(requestId, workerTimings),
  )
  const timings = internals.buildPcmLoadTimings(pcm, {
    validPcmBytes: 8,
    backingBufferBytes: 16,
    webAudioBufferAllocationMs: 1,
    pcmDeinterleaveMs: 2,
    pcmDestinationViewMs: 0.25,
    pcmCopySetupMs: 0.25,
    pcmChannelCopyTotalMs: 1,
    pcmChannelCopyMaxMs: 0.5,
    pcmChannelCopyByChannelMs: [0.5, 0.5],
    pcmPayloadReleaseMs: 0.25,
    pcmDeinterleaveResidualMs: 0.25,
  }, 3, {
    decodeRequestId: requestId,
    rendererBridgeCallMs: 181,
    deliveredAt: 500,
    pipelineStartedAt: 300,
    standardTransportSetupMs: 1,
    standardContextReadyMs: 1,
    standardDecodeRequestSetupMs: 1,
  })

  for (const [field, expected] of Object.entries(workerTimings)) {
    assert.equal(timings[field as keyof typeof timings], expected, `unexpected worker timing: ${field}`)
  }
  assert.equal(timings.decodeWorkMs, 105)
  assert.equal(timings.decodeMs, timings.decodeWorkMs)
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
    assert.equal(committed[0]?.pcm.transportTimings?.probeCacheStatus, 'hit')
    assert.equal(committed[0]?.pcm.transportTimings?.probeDecodeOverlapEnabled, true)
    assert.equal(committed[0]?.pcm.transportTimings?.probeFfmpegOverlapMs, 3)
    assertFfmpegStdoutTimings(
      committed[0]?.pcm.transportTimings,
      STREAM_FFMPEG_STDOUT_TIMINGS,
    )
    assertStreamCreditTimings(committed[0]?.pcm.transportTimings)
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
  const currentCommits: Array<{ path: string; delivery: PcmRendererDeliveryTiming | undefined }> = []
  const prebufferCommits: Array<{ path: string; delivery: PcmRendererDeliveryTiming | undefined }> = []
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
  internals.loadPcmDataForOperation = async (_pcm, options, _generation, delivery) => {
    currentCommits.push({
      path: options.trackPath ?? '',
      delivery,
    })
  }
  internals.commitNextPcmBuffer = async (_pcm, options, _generation, delivery) => {
    prebufferCommits.push({
      path: options.trackPath ?? '',
      delivery,
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

    assert.equal(prebufferCommits[0]?.path, nextTrack.path)
    assert.equal(prebufferCommits[0]?.delivery?.decodeRequestId, prebufferRequest.requestId)
    assert.equal(currentCommits[0]?.path, currentTrack.path)
    assert.equal(currentCommits[0]?.delivery?.decodeRequestId, currentRequest.requestId)
    for (const commit of [...prebufferCommits, ...currentCommits]) {
      const delivery = commit.delivery
      assert.ok(delivery)
      assert.ok(delivery.standardTransportSetupMs >= 0)
      assert.ok(delivery.standardContextReadyMs >= 0)
      assert.ok(delivery.standardDecodeRequestSetupMs >= 0)
      assert.ok(delivery.standardContextReadyMs <= delivery.standardTransportSetupMs)
      assert.ok(delivery.standardDecodeRequestSetupMs <= delivery.standardTransportSetupMs)
      assert.ok(
        Math.abs(
          delivery.standardTransportSetupMs
            - delivery.standardContextReadyMs
            - delivery.standardDecodeRequestSetupMs,
        ) < 0.001,
      )
    }
    assert.deepEqual(mainCancelled, [])
  } finally {
    for (const [requestId, deferred] of pending) {
      deferred.resolve(makeStreamPcmResult(requestId))
    }
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  }
})

test('timing-rich Standard PCM prebuffer preserves current playback and Parallax while scheduling gapless', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const requests: unknown[][] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        decodeLocalAudioToPcm: async (...args: unknown[]) => {
          requests.push(args)
          const requestId = args[0] as number
          return Object.freeze(makeLocalPcmResult(
            requestId,
            0.6,
            Object.freeze(makeTransportTimings(requestId, {
              transportRoute: 'invoke',
              ffmpegOutputSink: 'temporary_file',
              tempPcmCreateMs: 1,
              tempPcmStatMs: 0.25,
              tempPcmReadMs: 8,
              tempPcmReadChunkCount: 1,
              tempPcmBytes: 8,
              tempPcmCleanupMs: 2,
              tempPcmCleanupSucceeded: false,
            })),
          ))
        },
        cancelLocalAudioDecode: async () => undefined,
      },
    },
  })

  const destinationChannels = [new Float32Array(1), new Float32Array(1)]
  const currentBuffer = { duration: 180, numberOfChannels: 2 } as AudioBuffer
  internals.context = {
    sampleRate: 48_000,
    createBuffer: () => ({
      duration: 1 / 48_000,
      length: 1,
      numberOfChannels: 2,
      sampleRate: 48_000,
      getChannelData: (channel: number) => destinationChannels[channel],
    }),
  } as unknown as AudioContext
  internals.initContext = async () => undefined
  internals.resolveLoudnessAnalysisForLoad = async () => null
  internals._playbackState = 'playing'
  internals.audioBuffer = currentBuffer
  internals.currentBufferTrackPath = '/pcm/current-playing.flac'
  internals.loadGeneration = 101
  internals.prebufferGeneration = 202
  internals.parallaxHostPublishGeneration = 303
  let gaplessSchedules = 0
  internals.scheduleGaplessTransition = () => {
    gaplessSchedules += 1
  }
  const nextTrack = makeLocalPcmTrack('diagnostic-rich-next')

  try {
    assert.equal(
      await engine.preBufferNextStandardTrackFromPath(nextTrack, { priority: 'background' }),
      'loaded',
    )

    assert.deepEqual(requests, [[1, nextTrack.path, 48_000, 2, 'background']])
    assert.equal(internals.loadGeneration, 101)
    assert.equal(internals.prebufferGeneration, 203)
    assert.equal(internals.parallaxHostPublishGeneration, 303)
    assert.equal(internals.audioBuffer, currentBuffer)
    assert.equal(internals.currentBufferTrackPath, '/pcm/current-playing.flac')
    assert.equal(engine.nextBufferedTrackPath, nextTrack.path)
    assert.equal(gaplessSchedules, 1)
    assert.deepEqual(
      destinationChannels.map((channel) => Array.from(channel)),
      [[Math.fround(0.6)], [Math.fround(-0.6)]],
    )

    const timings = engine.getLastPrebufferLoadTimings()
    assert.ok(timings)
    assert.equal(timings.decodeRequestId, 1)
    assert.equal(timings.probeCacheStatus, 'hit')
    assert.equal(timings.probeDecodeOverlapEnabled, true)
    assert.equal(timings.probeFfmpegOverlapMs, 9)
    assert.equal(timings.ffmpegSpawnToFirstPcmMs, 21)
    assert.equal(timings.ffmpegPcmOutputSpanMs, 64)
    assert.equal(timings.ffmpegCloseTailMs, 5)
    assert.equal(timings.ffmpegOutputSink, 'temporary_file')
    assert.equal(timings.tempPcmCreateMs, 1)
    assert.equal(timings.tempPcmStatMs, 0.25)
    assert.equal(timings.tempPcmReadMs, 8)
    assert.equal(timings.tempPcmReadChunkCount, 1)
    assert.equal(timings.tempPcmBytes, 8)
    assert.equal(timings.tempPcmCleanupMs, 2)
    assert.equal(timings.tempPcmCleanupSucceeded, false)
    assertFfmpegStdoutTimings(timings)
    assertStreamCreditTimings(timings)
    assert.ok((timings.standardTransportSetupMs ?? -1) >= 0)
    assert.ok((timings.postDeliveryCommitMs ?? -1) >= 0)
    assert.ok((timings.standardLoadPipelineMs ?? -1) >= 0)
    assert.equal(timings.audioEngineStandardPipelineMs, timings.standardLoadPipelineMs)
    assert.ok(Math.abs(
      (timings.standardTransportSetupMs ?? 0)
        + (timings.rendererBridgeCallMs ?? 0)
        + (timings.postDeliveryCommitMs ?? 0)
        + (timings.standardPipelineResidualMs ?? 0)
        - (timings.audioEngineStandardPipelineMs ?? 0),
    ) < 0.001)
    assert.ok(Math.abs(
      (timings.pcmDestinationViewMs ?? 0)
        + (timings.pcmCopySetupMs ?? 0)
        + (timings.pcmChannelCopyTotalMs ?? 0)
        + (timings.pcmPayloadReleaseMs ?? 0)
        + (timings.pcmDeinterleaveResidualMs ?? 0)
        - (timings.pcmDeinterleaveMs ?? 0),
    ) < 0.001)

    const returnedChannelTimings = timings.pcmChannelCopyByChannelMs
    assert.ok(returnedChannelTimings)
    returnedChannelTimings[0] = 999
    assert.notEqual(engine.getLastPrebufferLoadTimings()?.pcmChannelCopyByChannelMs?.[0], 999)
  } finally {
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
    assert.ok((committedDeliveries[0]?.standardTransportSetupMs ?? -1) >= 0)
    assert.ok(
      (committedDeliveries[0]?.standardContextReadyMs ?? Number.POSITIVE_INFINITY)
        <= (committedDeliveries[0]?.standardTransportSetupMs ?? -1),
    )
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
