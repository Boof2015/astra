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
  loadGeneration: number
  handleNativeAudioEvent: (event: NativeAudioEvent) => void
  initNativeAudio: () => Promise<void>
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
