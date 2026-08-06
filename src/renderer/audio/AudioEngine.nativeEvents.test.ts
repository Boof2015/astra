import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioEngine, SupersededAudioLoadError } from './AudioEngine.ts'
import type { NativeAudioEvent, NativeAudioPlaybackSnapshot } from '../../types/nativeAudio.ts'
import type { Track } from '../types/audio.ts'

type AudioEngineInternals = {
  playbackOutputMode: 'standard' | 'bitperfect'
  _playbackState: 'stopped' | 'loading' | 'playing' | 'paused'
  nativeLifecycleSuppressionTokens: Set<number>
  nativeCurrentPlaybackSequence: number | null
  nativeNextPlaybackSequence: number | null
  currentBufferTrackPath: string | null
  nextBufferTrackPath: string | null
  nativeNextTrackBuffered: boolean
  nativeSnapshot: NativeAudioPlaybackSnapshot | null
  context: AudioContext | null
  loadGeneration: number
  prebufferGeneration: number
  parallaxHostPublishGeneration: number
  nextBuffer: AudioBuffer | null
  activePrebufferPcmDecodeRequestId: number | null
  activePrebufferPcmDecodeTrackPath: string | null
  handleNativeAudioEvent: (event: NativeAudioEvent) => void
  initNativeAudio: () => Promise<void>
  initContext: () => Promise<void>
  refreshNativeCapabilities: () => Promise<void>
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
  ) => Promise<void>
  commitNextPcmBuffer: (
    pcm: { interleavedPcm: ArrayBuffer },
    options: { trackPath?: string | null },
    generation: number,
  ) => Promise<void>
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

function makeLocalPcmResult(requestId: number, left = 0.25): {
  requestId: number
  sampleRate: number
  channels: number
  frames: number
  pcmByteLength: number
  interleavedPcm: ArrayBuffer
  probeMs: number
  decodeMs: number
  backgroundPriorityApplied: boolean
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
  }
}

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

test('Standard PCM latest-wins cancels stale decode without committing until the winner is ready', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as AudioEngineInternals
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const pending = new Map<number, {
    resolve: (result: ReturnType<typeof makeLocalPcmResult>) => void
  }>()
  const cancelled: number[] = []
  const committedPaths: string[] = []
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
  internals.loadPcmDataForOperation = async (pcm, options, generation) => {
    assert.equal(generation, internals.loadGeneration)
    // Real contextBridge return values may be frozen. The engine must pass an
    // owned wrapper into the commit path so releasing the IPC buffer is safe.
    pcm.interleavedPcm = new ArrayBuffer(0)
    committedPaths.push(options.trackPath ?? '')
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

    pending.get(secondRequestId)?.resolve(Object.freeze(makeLocalPcmResult(secondRequestId, 0.2)))
    assert.equal(await secondLoad, 'loaded')
    assert.deepEqual(committedPaths, [secondTrack.path])
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
