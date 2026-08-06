import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createCachedNativeAudioBinaryResolver,
  createNativeAudioController,
  normalizeNativeAudioOutputStatus,
  type NativeAudioAddonPlayback
} from './nativeAudioController.ts'
import type { NativeAudioEvent, NativeAudioPlaybackSnapshot } from '../types/nativeAudio.ts'
import {
  createNativeOutputFailureError,
  parseNativeOutputFailureError,
  stripNativeOutputFailureTag
} from '../shared/audio/bitPerfectFormatError.ts'
import { normalizePlaybackOutputMode } from '../types/nativeAudio.ts'

const verifiedBase = {
  streamRunning: true,
  exclusiveAcquired: true,
  systemMixerBypassed: true,
  sourceSamplesModified: false,
  wireFormatCanCarrySourceExactly: true
}

const availableCapabilities = {
  bitPerfectAvailable: true,
  reasonUnavailable: null,
  processedExclusiveAvailable: true,
  reasonProcessedExclusiveUnavailable: null,
  activeBackend: 'coreaudio' as const,
  selectedDeviceId: 'test-device',
  selectedDeviceMaxChannels: 2,
  devices: [{ deviceId: 'test-device', label: 'Test Device', maxChannels: 2, isDefault: true }]
}

function createPlaybackSnapshot(playbackState: NativeAudioPlaybackSnapshot['playbackState'] = 'stopped'): NativeAudioPlaybackSnapshot {
  return {
    playbackState,
    currentTime: 0,
    duration: 1,
    sampleRate: 48_000,
    channels: 2,
    sampleFormat: 's16',
    deviceId: 'test-device',
    deviceLabel: 'Test Device',
    outputStatus: normalizeNativeAudioOutputStatus(null)
  }
}

function createPlaybackStub(overrides: Partial<NativeAudioAddonPlayback> = {}): NativeAudioAddonPlayback {
  return {
    getCapabilities: () => availableCapabilities,
    setOutputDevice: () => availableCapabilities,
    configureOutput: () => availableCapabilities,
    setDspConfig: () => createPlaybackSnapshot(),
    setCurrentTrackGain: () => createPlaybackSnapshot(),
    loadTrack: () => createPlaybackSnapshot(),
    preloadNextTrack: () => undefined,
    promoteNextTrack: () => createPlaybackSnapshot(),
    play: async () => createPlaybackSnapshot('playing'),
    pause: () => createPlaybackSnapshot('paused'),
    stop: () => createPlaybackSnapshot(),
    seek: () => createPlaybackSnapshot(),
    clearNextTrack: () => undefined,
    getPlaybackSnapshot: () => createPlaybackSnapshot(),
    setVisualizerTapDemand: () => undefined,
    drainEvents: () => [],
    flushOscilloscopeSamples: () => null,
    flushSpectrumSamples: () => null,
    flushVectorscopeSamples: () => null,
    flushVUMeterSamples: () => null,
    ...overrides
  }
}

test('derives bit-perfect activation solely from the verified runtime rule', () => {
  const active = normalizeNativeAudioOutputStatus({
    ...verifiedBase,
    bitPerfectActive: false
  })
  assert.equal(active.bitPerfectActive, true)

  for (const override of [
    { streamRunning: false },
    { exclusiveAcquired: false },
    { systemMixerBypassed: false },
    { sourceSamplesModified: true },
    { wireFormatCanCarrySourceExactly: false }
  ]) {
    const inactive = normalizeNativeAudioOutputStatus({
      ...verifiedBase,
      ...override,
      bitPerfectActive: true
    })
    assert.equal(inactive.bitPerfectActive, false)
  }
})

test('does not report activation while output is merely open, negotiated, or initialized', () => {
  const status = normalizeNativeAudioOutputStatus({
    outputOpen: true,
    deviceResolved: true,
    formatNegotiated: true,
    streamInitialized: true,
    streamStarted: false,
    streamRunning: false,
    exclusiveAcquired: true,
    systemMixerBypassed: true,
    wireFormatCanCarrySourceExactly: true,
    bitPerfectActive: true
  })
  assert.equal(status.exclusiveAcquired, true)
  assert.equal(status.bitPerfectActive, false)
})

test('normalizes complete PCM and attempt diagnostics', () => {
  const status = normalizeNativeAudioOutputStatus({
    ...verifiedBase,
    backend: 'wasapi-exclusive',
    transport: 'timer-driven',
    actualPeriodMs: 10,
    wireFormat: {
      sampleRate: 192000,
      channels: 2,
      sampleFormat: 's24in32',
      containerBits: 32,
      validBits: 24,
      channelMask: 3,
      channelLayout: 'stereo',
      representation: 'WAVEFORMATEXTENSIBLE/interleaved'
    },
    attempts: [{
      index: 2,
      backend: 'wasapi-exclusive',
      probeResult: 'rejected',
      streamInitialized: true,
      bufferPrimed: true,
      streamStarted: true,
      finalVerified: true
    }]
  })
  assert.equal(status.wireFormat.sampleFormat, 's24in32')
  assert.equal(status.wireFormat.validBits, 24)
  assert.equal(status.attempts[0].probeResult, 'rejected')
  assert.equal(status.attempts[0].finalVerified, true)
})

test('native output failures retain stage, OS code, and report across an Error message bridge', () => {
  const error = createNativeOutputFailureError({
    deviceLabel: 'Test DAC',
    sampleRate: 96000,
    channels: 2,
    sampleFormat: 's24',
    message: 'The platform start call failed.',
    failureStage: 'start',
    osCode: 'AUDCLNT_E_DEVICE_IN_USE',
    report: 'attempt #1\nattempt #2'
  })
  const parsed = parseNativeOutputFailureError(error)
  assert.equal(parsed?.failureStage, 'start')
  assert.equal(parsed?.osCode, 'AUDCLNT_E_DEVICE_IN_USE')
  assert.equal(parsed?.report, 'attempt #1\nattempt #2')
  assert.equal(stripNativeOutputFailureTag(error.message), 'The platform start call failed.')
})

test('native binary resolution reuses one process-lifetime lookup per tool', async () => {
  const calls: string[] = []
  const resolveBinary = createCachedNativeAudioBinaryResolver(async (binary) => {
    calls.push(binary)
    return `/test/${binary}`
  })

  const [first, second] = await Promise.all([
    resolveBinary('ffmpeg'),
    resolveBinary('ffmpeg')
  ])
  assert.equal(first, '/test/ffmpeg')
  assert.equal(second, '/test/ffmpeg')
  assert.equal(await resolveBinary('ffmpeg'), '/test/ffmpeg')
  assert.equal(await resolveBinary('ffprobe'), '/test/ffprobe')
  assert.deepEqual(calls, ['ffmpeg', 'ffprobe'])
})

test('native prebuffer promotion retains the probe and decode timing totals', async () => {
  const controller = createNativeAudioController({ playback: createPlaybackStub() }, {
    eventPolling: false,
    resolveBinary: async (binary) => `/test/${binary}`,
    runProbe: async () => {
      await new Promise((resolve) => setTimeout(resolve, 4))
      return JSON.stringify({
        streams: [{
          codec_type: 'audio',
          codec_name: 'flac',
          sample_rate: '48000',
          channels: 2,
          duration: '1',
          sample_fmt: 's16'
        }]
      })
    },
    runDecode: async () => {
      await new Promise((resolve) => setTimeout(resolve, 4))
      return Buffer.alloc(8)
    }
  })

  const preloaded = await controller.preloadNextTrack('/music/next.flac', { path: '/music/next.flac' })
  const promoted = await controller.promoteNextTrack('/music/next.flac', { path: '/music/next.flac' })

  assert.ok((preloaded.timings?.probeMs ?? 0) > 0)
  assert.ok((preloaded.timings?.decodeMs ?? 0) > 0)
  assert.equal(promoted.timings?.binaryResolutionMs, preloaded.timings?.binaryResolutionMs)
  assert.equal(promoted.timings?.probeMs, preloaded.timings?.probeMs)
  assert.equal(promoted.timings?.decodeMs, preloaded.timings?.decodeMs)
})

test('native playback sequences identify current and buffered lifecycle epochs', async () => {
  const originalSetInterval = globalThis.setInterval
  let pollEvents: (() => void) | null = null
  globalThis.setInterval = ((callback: Parameters<typeof globalThis.setInterval>[0]) => {
    if (typeof callback === 'function') pollEvents = callback as () => void
    return 1 as unknown as ReturnType<typeof globalThis.setInterval>
  }) as typeof globalThis.setInterval

  const rawEvents: NativeAudioEvent[] = []
  let drainCalls = 0
  const playback = createPlaybackStub({
    drainEvents: () => {
      drainCalls += 1
      return rawEvents.splice(0)
    }
  })
  const controller = createNativeAudioController({ playback }, {
    resolveBinary: async (binary) => `/test/${binary}`,
    runProbe: async () => JSON.stringify({
      streams: [{
        codec_type: 'audio',
        codec_name: 'flac',
        sample_rate: '48000',
        channels: 2,
        duration: '1',
        sample_fmt: 's16'
      }]
    }),
    runDecode: async () => Buffer.alloc(8)
  })
  const observed: NativeAudioEvent[] = []
  controller.onEvent((event) => observed.push(event))

  try {
    const loaded = await controller.loadTrack('/music/sequence-current.flac', {
      path: '/music/sequence-current.flac'
    })
    const preloaded = await controller.preloadNextTrack('/music/sequence-next.flac', {
      path: '/music/sequence-next.flac'
    })
    assert.notEqual(loaded.playbackSequence, preloaded.playbackSequence)
    assert.ok(pollEvents)

    rawEvents.push({ type: 'timeUpdate', playbackSequence: 0, currentTime: 0.25 })
    ;(pollEvents as (() => void) | null)?.()
    assert.deepEqual(observed, [{
      type: 'timeUpdate',
      playbackSequence: loaded.playbackSequence,
      currentTime: 0.25
    }])

    rawEvents.push({ type: 'ended', playbackSequence: 0 })
    const drainsBeforePlay = drainCalls
    const played = await controller.play() as NativeAudioPlaybackSnapshot & { playbackSequence: number }
    assert.equal(drainCalls, drainsBeforePlay + 1, 'play must drain queued pre-command events')
    assert.equal(observed.length, 1, 'pre-command lifecycle events must be discarded')
    assert.notEqual(played.playbackSequence, loaded.playbackSequence)
    assert.notEqual(played.playbackSequence, preloaded.playbackSequence)

    rawEvents.push(
      { type: 'timeUpdate', playbackSequence: 0, currentTime: 0.5 },
      { type: 'gaplessTransition', playbackSequence: 0 },
      { type: 'timeUpdate', playbackSequence: 0, currentTime: 0.75 }
    )
    ;(pollEvents as (() => void) | null)?.()
    assert.deepEqual(observed.slice(1), [
      {
        type: 'timeUpdate',
        playbackSequence: played.playbackSequence,
        currentTime: 0.5
      },
      {
        type: 'gaplessTransition',
        playbackSequence: preloaded.playbackSequence
      },
      {
        type: 'timeUpdate',
        playbackSequence: preloaded.playbackSequence,
        currentTime: 0.75
      }
    ])
  } finally {
    globalThis.setInterval = originalSetInterval
  }
})

test('cancelPendingDecode aborts obsolete probe work before PCM reaches the addon', async () => {
  let nativeLoadCalls = 0
  let signalCaptured: ((signal: AbortSignal) => void) | null = null
  const probeStarted = new Promise<AbortSignal>((resolve) => { signalCaptured = resolve })
  const playback = createPlaybackStub({
    loadTrack: () => {
      nativeLoadCalls += 1
      return createPlaybackSnapshot()
    }
  })
  const controller = createNativeAudioController({ playback }, {
    eventPolling: false,
    resolveBinary: async (binary) => `/test/${binary}`,
    runProbe: async (_file, _args, signal) => {
      signalCaptured?.(signal)
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('superseded')
          error.name = 'SupersededNativeAudioLoadError'
          reject(error)
        }, { once: true })
      })
    },
    runDecode: async () => Buffer.alloc(8)
  })

  const load = controller.loadTrack('/music/obsolete.flac', { path: '/music/obsolete.flac' })
  const signal = await probeStarted
  assert.equal(signal.aborted, false)
  await controller.cancelPendingDecode()
  await assert.rejects(load, (error: unknown) => (
    error instanceof Error && error.name === 'SupersededNativeAudioLoadError'
  ))
  assert.equal(signal.aborted, true)
  assert.equal(nativeLoadCalls, 0)
})

test('cancelPendingDecode invalidates a load before its decoder controller exists', async () => {
  let probeCalls = 0
  let nativeLoadCalls = 0
  const playback = createPlaybackStub({
    loadTrack: () => {
      nativeLoadCalls += 1
      return createPlaybackSnapshot()
    }
  })
  const controller = createNativeAudioController({ playback }, {
    eventPolling: false,
    resolveBinary: async (binary) => `/test/${binary}`,
    runProbe: async () => {
      probeCalls += 1
      return JSON.stringify({ streams: [] })
    },
    runDecode: async () => Buffer.alloc(8)
  })

  const load = controller.loadTrack('/music/obsolete-before-probe.flac', {
    path: '/music/obsolete-before-probe.flac'
  })
  await controller.cancelPendingDecode()

  await assert.rejects(load, (error: unknown) => (
    error instanceof Error && error.name === 'SupersededNativeAudioLoadError'
  ))
  assert.equal(probeCalls, 0)
  assert.equal(nativeLoadCalls, 0)
})

test('decode cancellation never interrupts an active native device-start handshake', async () => {
  let resolvePlay!: (snapshot: NativeAudioPlaybackSnapshot) => void
  let signalPlayStarted: (() => void) | null = null
  const playStarted = new Promise<void>((resolve) => { signalPlayStarted = resolve })
  const playback = createPlaybackStub({
    play: async () => {
      signalPlayStarted?.()
      return await new Promise<NativeAudioPlaybackSnapshot>((resolve) => { resolvePlay = resolve })
    }
  })
  const controller = createNativeAudioController({ playback }, {
    eventPolling: false,
    resolveBinary: async (binary) => `/test/${binary}`,
    runProbe: async () => JSON.stringify({
      streams: [{ codec_type: 'audio', codec_name: 'flac', sample_rate: '48000', channels: 2, duration: '1', sample_fmt: 's16' }]
    }),
    runDecode: async () => Buffer.alloc(8)
  })

  const result = await controller.loadTrack('/music/current.flac', { path: '/music/current.flac' })
  assert.ok(result.timings)
  assert.equal(result.timings?.probeMs != null && result.timings.probeMs >= 0, true)
  assert.equal(result.timings?.decodeMs != null && result.timings.decodeMs >= 0, true)

  let playSettled = false
  const play = controller.play().finally(() => { playSettled = true })
  await playStarted
  await controller.cancelPendingDecode()
  await Promise.resolve()
  assert.equal(playSettled, false)
  resolvePlay(createPlaybackSnapshot('playing'))
  assert.equal((await play).playbackState, 'playing')
})

test('normalizes processed-exclusive activation independently from bit-perfect integrity', () => {
  const status = normalizeNativeAudioOutputStatus({
    ...verifiedBase,
    sourceSamplesModified: true,
    processingFormat: {
      sampleRate: 96000,
      channels: 2,
      sampleFormat: 'f64',
      containerBits: 64,
      validBits: 53,
      representation: 'planar/native-dsp'
    },
    processing: {
      outputPolicy: 'processed',
      processingActive: true,
      resamplingActive: true,
      sourceSampleRate: 44100,
      targetSampleRate: 96000,
      resamplerName: 'r8brain-free-src 7.1'
    }
  })
  assert.equal(status.outputPolicy, 'processed')
  assert.equal(status.exclusiveActive, true)
  assert.equal(status.processingActive, true)
  assert.equal(status.resamplingActive, true)
  assert.equal(status.processingFormat.sampleFormat, 'f64')
  assert.equal(status.bitPerfectActive, false)
})

test('keeps saved output modes and safely migrates unknown values', () => {
  assert.equal(normalizePlaybackOutputMode('standard'), 'standard')
  assert.equal(normalizePlaybackOutputMode('exclusive'), 'exclusive')
  assert.equal(normalizePlaybackOutputMode('bitperfect'), 'bitperfect')
  assert.equal(normalizePlaybackOutputMode('legacy-shared'), 'standard')
})
