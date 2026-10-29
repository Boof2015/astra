import assert from 'node:assert/strict'
import test from 'node:test'
import { createNativeAudioController, normalizeNativeAudioOutputStatus, type NativeAudioAddonPlayback, type NativeAudioControllerOptions } from './nativeAudioController.ts'
import type { NativeProgressiveInput, NativeProgressiveInputOptions } from '../types/nativeProgressive.ts'
import type { NativeAudioEvent, NativeAudioPlaybackSnapshot } from '../types/nativeAudio.ts'
import type { NativePcmDecoderOptions } from './nativePcmDecoder.ts'
import { startNativePcmDecoder } from './nativePcmDecoder.ts'
import { RemoteAudioCache } from '../main/services/remoteAudioCache.ts'
import { createRequire } from 'node:module'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function harness(overrides: NativeAudioControllerOptions = {}, backend = 'coreaudio') {
  const inputs: NativeProgressiveInput[] = []
  const inputOptions: NativeProgressiveInputOptions[] = []
  const leases: { path: string; released: boolean }[] = []
  const decoders: NativePcmDecoderOptions[] = []
  const events: NativeAudioEvent[] = []
  let current: NativeProgressiveInput | null = null
  let next: NativeProgressiveInput | null = null
  let state: NativeAudioPlaybackSnapshot['playbackState'] = 'stopped'
  let localLoads = 0
  let localDecodes = 0
  let localNext = false
  let localTime = 0
  const localSeeks: number[] = []
  let buffering = false
  const snapshot = (): NativeAudioPlaybackSnapshot => ({
    progressiveSessionId: current?.status().sessionId, buffering, playbackState: state,
    currentTime: current ? current.status().startFrame / current.status().sampleRate : localTime, duration: 60,
    sampleRate: current?.status().sampleRate ?? 48000, channels: 2,
    sampleFormat: current ? inputOptions[current.status().sessionId - 1].sampleFormat : 's16', deviceId: 'test', deviceLabel: 'test',
    outputStatus: normalizeNativeAudioOutputStatus(null)
  })
  const caps = { activeBackend: backend, bitPerfectAvailable: true, processedExclusiveAvailable: true, devices: [] }
  const playback = {
    getCapabilities: () => caps, configureOutput: () => caps, getPlaybackSnapshot: snapshot, setVisualizerTapDemand() {}, flushVisualizerSamples: () => null,
    drainEvents: () => events.splice(0),
    createProgressiveInput: (options: NativeProgressiveInputOptions) => {
      inputOptions.push(options)
      let published = options.startFrame ?? 0
      let inputState: 'open' | 'ended' | 'cancelled' = 'open'
      const id = inputs.length + 1
      const stride = options.channels * (options.sampleFormat === 's16' ? 2 : options.sampleFormat === 's24' ? 3 : 4)
      const input: NativeProgressiveInput = {
        append: bytes => { const frames = bytes.length / stride; published += frames; return frames },
        finish: () => { inputState = 'ended'; return true }, cancel: () => { inputState = 'cancelled' },
        status: () => ({ sessionId: id, startFrame: options.startFrame ?? 0, retainedFrame: options.startFrame ?? 0,
          publishedFrame: published, capacityFrames: options.capacityFrames, sampleRate: options.sampleRate, bytesPerFrame: stride, state: inputState }),
        load: () => { current?.cancel(); next?.cancel(); current = input; next = null; localNext = false; state = 'stopped'; return snapshot() },
        preloadNext: () => { assert.equal(next, null); assert.equal(localNext, false); next = input },
        seek: async expected => {
          assert.equal(current?.status().sessionId, expected)
          assert.notEqual(inputState, 'cancelled')
          current?.cancel(); current = input
          return snapshot()
        }
      }
      inputs.push(input)
      return input
    },
    clearNextTrack: () => { next?.cancel(); next = null; localNext = false },
    loadTrack: () => { localLoads++; current?.cancel(); current = null; localTime = 0; return snapshot() },
    preloadNextTrack: () => { assert.equal(next, null); assert.equal(localNext, false); localNext = true },
    setCurrentTrackGain: snapshot,
    promoteNextTrack: () => { assert.ok(next || localNext); current?.cancel(); current = next; next = null; localNext = false; localTime = 0; state = 'stopped'; return snapshot() },
    play: async () => { state = 'playing'; return snapshot() },
    pause: () => { state = 'paused'; return snapshot() },
    stop: () => { current?.cancel(); next?.cancel(); next = null; localNext = false; localTime = 0; state = 'stopped'; return snapshot() },
    seek: (seconds: number) => { assert.equal(current, null, 'Remote seek must replace its decoder'); localSeeks.push(seconds); localTime = seconds; return snapshot() }
  } as unknown as NativeAudioAddonPlayback
  const controller = createNativeAudioController({ playback }, {
    eventPolling: false,
    resolveBinary: async binary => binary,
    runProbe: async () => JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'flac', sample_rate: '48000', channels: 2, sample_fmt: 's16', duration: '60' }] }),
    runDecode: async () => { localDecodes++; return Buffer.alloc(4) },
    acquireRemoteSource: async path => {
      const lease = { path, released: false }
      leases.push(lease)
      return { url: 'http://cache/internal', duration: 60, release: () => { lease.released = true },
        finished: async () => {}, progress: async () => ({ loadedBytes: 100, totalBytes: 100, complete: true, error: null }) }
    },
    startRemoteDecoder: options => {
      decoders.push(options)
      options.input.append(Buffer.alloc(40000 * 4))
      return { ready: Promise.resolve(), done: Promise.resolve(), cancel: () => options.input.cancel(), pid: undefined, pendingBytes: 0 }
    },
    ...overrides
  })
  return { controller, playback, inputs, inputOptions, leases, decoders, localSeeks,
    local: () => ({ localLoads, localDecodes }),
    setBuffering: (value: boolean) => { buffering = value },
    transition: () => {
      assert.ok(next || localNext)
      current = next; next = null; localNext = false; localTime = 0
      events.push({ type: 'gaplessTransition', playbackSequence: 0, progressiveSessionId: current?.status().sessionId })
    }
  }
}

const a = 'subsonic://server/track/a'
const b = 'subsonic://server/track/b'

test('direct Stratum rejects a reduced representation before creating native input', async () => {
  let released = false
  const quality = { transport: 'stratum' as const, requested: 64 as const, requestedCodec: 'opus' as const, delivered: null }
  const h = harness({ acquireRemoteSource: async () => ({ url: '', duration: 1, quality,
    release: () => { released = true }, finished: async () => {},
    progress: async () => ({ loadedBytes: 0, totalBytes: null, complete: false, error: null }),
    pcm: { info: { sessionId: 1, sampleRate: 48000, channels: 2, bitDepth: 24, duration: 1, startFrame: 0, quality },
      read: async () => { assert.fail('no reduced audio may be accepted') }, close: async () => {}, activate() {} }
  }) })
  await h.controller.configureNativeOutput({ policy: 'direct', requestedSampleRate: null })
  await assert.rejects(h.controller.loadTrack(a), /Original integer audio/)
  assert.equal(h.inputs.length, 0)
  assert.equal(released, true)
  await h.controller.stop()
})

test('processed Stratum uses source-rate s32 input, preserves gain, and activates a prepared successor', async () => {
  const requests: import('../types/nativeRemoteSource.ts').NativeRemoteRequest[] = []
  const lifecycle: string[] = []
  const h = harness({ acquireRemoteSource: async (path, _signal, _quality, request) => {
    assert.ok(request)
    requests.push(request)
    lifecycle.push(`open:${path}:${request.startTimeSeconds}`)
    const rate = path === a ? 44100 : 96000
    const startFrame = Math.floor(request.startTimeSeconds * rate)
    const quality = { transport: 'stratum' as const, requested: 64 as const, requestedCodec: 'opus' as const,
      mode: 'automatic' as const, delivered: null, loudness: { loudnessLufs: -18, peakLinear: .25 } }
    let remaining = (6 * rate - startFrame) * 8
    return { url: '', duration: 6, quality, release() {}, finished: async () => {},
      progress: async () => ({ loadedBytes: 100, totalBytes: null, complete: true, error: null }),
      pcm: { info: { sessionId: 100 + requests.length, sampleRate: rate, channels: 2, bitDepth: 16, startFrame, duration: 6, quality },
        read: async () => { if (!remaining) return null
          const count = Math.min(remaining, 65536); remaining -= count; return new ArrayBuffer(count) },
        close: async () => { lifecycle.push(`close:${path}`) }, activate: () => { lifecycle.push(`activate:${path}`) } }
    }
  }, resolveBinary: async () => { throw new Error('Stratum must not use the conventional decoder/probe') } })
  await h.controller.configureNativeOutput({ policy: 'processed', requestedSampleRate: 48000 })
  const loaded = await h.controller.loadTrack(a, { path: a, remoteNormalizationTargetLufs: -14 })
  assert.equal(loaded.quality?.transport, 'stratum')
  assert.equal(loaded.sampleRate, 44100)
  assert.equal(loaded.sampleFormat, 's32')
  assert.equal(h.inputOptions[0].gain?.gainDb, 4)
  await h.controller.preloadNextTrack(b)
  assert.equal(requests[1].slot, 'next')
  assert.equal(h.inputOptions[1].sampleRate, 96000)
  await h.controller.seek(2.125)
  assert.ok(lifecycle.indexOf(`close:${a}`) < lifecycle.indexOf(`open:${a}:2.125`))
  assert.equal(h.inputs[2].status().startFrame, Math.floor(2.125 * 44100))
  assert.deepEqual(h.inputOptions[2].gain, h.inputOptions[0].gain)
  h.transition()
  await h.controller.getPlaybackSnapshot()
  assert.ok(lifecycle.includes(`activate:${b}`))
  assert.equal(h.decoders.length, 0)
  await h.controller.stop()
})

for (const backend of ['coreaudio', 'wasapi-exclusive', 'alsa-hw']) {
  for (const bitDepth of [16, 24] as const) {
    test(`Bit-perfect Stratum selects exact ${bitDepth}-bit native format on ${backend}, including seeks`, async () => {
      const h = harness({ acquireRemoteSource: async (_path, _signal, _quality, request) => {
        assert.equal(request?.policy, 'direct')
        const startFrame = Math.floor(request!.startTimeSeconds * 44100)
        let remaining = (44100 - startFrame) * 8
        const quality = { transport: 'stratum' as const, requested: 'original' as const, requestedCodec: 'flac' as const,
          delivered: { codec: 'flac', sampleRate: 44100, channels: 2, bitDepth, bitrateKbps: null },
          loudness: { loudnessLufs: -24, peakLinear: .25 } }
        return { url: '', duration: 1, quality, release() {}, finished: async () => {},
          progress: async () => ({ loadedBytes: 100, totalBytes: null, complete: true, error: null }),
          pcm: { info: { sessionId: 99, sampleRate: 44100, channels: 2, bitDepth, startFrame, duration: 1, quality },
            read: async () => { if (!remaining) return null
              const count = Math.min(remaining, 65536); remaining -= count; return new ArrayBuffer(count) },
            close: async () => {}, activate() {} } }
      }, resolveBinary: async () => { throw new Error('Stratum must not probe/convert its PCM again') } }, backend)
      await h.controller.configureNativeOutput({ policy: 'direct', requestedSampleRate: null })
      await h.controller.loadTrack(a, { path: a, remoteNormalizationTargetLufs: -14 })
      await h.controller.seek(.12345)
      const format = bitDepth === 16 ? 's16' : backend === 'coreaudio' ? 's32' : 's24'
      assert.ok(h.inputOptions.every(input => input.sampleFormat === format && input.sampleRate === 44100))
      assert.ok(h.inputOptions.every(input => input.gain?.mode === 'off' && input.gain.gainDb === 0))
      assert.equal(h.inputOptions[1].startFrame, Math.floor(.12345 * 44100))
      assert.equal(h.decoders.length, 0)
      await h.controller.stop()
    })
  }
}

test('real native Opus decoding starts before EOF and retains exact frames through a seek', { timeout: 15_000 }, async t => {
  const require = createRequire(import.meta.url)
  const ffmpeg = require('ffmpeg-static') as string, ffprobe = require('ffprobe-static').path as string
  const frames = 480_037
  const encoded = execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=sample_rate=48000:seed=1',
    '-af', `atrim=end_sample=${frames}`, '-ac', '2', '-c:a', 'libopus', '-b:a', '64k', '-f', 'opus', 'pipe:1'])
  const directory = await mkdtemp(join(tmpdir(), 'astra-native-opus-'))
  const cache = new RemoteAudioCache(directory)
  let upstream!: ReadableStreamDefaultController<Uint8Array>
  let requests = 0
  const source = { provider: 'fixture', account: 'a', track: 'song', revision: '1', representation: 'opus:64:v1',
    open: async () => { requests++; return new Response(new ReadableStream<Uint8Array>({ start(c) { upstream = c } }), {
      headers: { 'content-type': 'audio/ogg' }
    }) } }
  const lease = await cache.acquire(source)
  while (!upstream) await new Promise(resolve => setImmediate(resolve))
  const split = Math.floor(encoded.length * 0.8)
  upstream.enqueue(encoded.subarray(0, split))
  const decoders: ReturnType<typeof startNativePcmDecoder>[] = []
  const h = harness({ resolveBinary: async binary => binary === 'ffmpeg' ? ffmpeg : ffprobe,
    runProbe: async (binary, args, signal) => (await promisify(execFile)(binary, args, { signal, timeout: 5000 })).stdout,
    acquireRemoteSource: async () => {
      const held = await cache.acquire(source)
      return { ...held, duration: frames / 48000, quality: { requested: 64, requestedCodec: 'opus', delivered: null },
        progress: async () => ({ ...held.progress(), error: null }) }
    },
    startRemoteDecoder: options => { const decoder = startNativePcmDecoder(options); decoders.push(decoder); return decoder }
  })
  t.after(async () => { await h.controller.stop(); lease.release(); await cache.close(); await rm(directory, { recursive: true, force: true }) })
  const result = await h.controller.loadTrack(a)
  assert.equal(result.quality?.delivered?.codec, 'opus')
  assert.equal(lease.progress().complete, false, 'native preparation uses an incomplete response')
  assert.ok(h.inputs[0].status().publishedFrame > 0)
  upstream.enqueue(encoded.subarray(split)); upstream.close()
  await decoders[0].done
  assert.equal(h.inputs[0].status().publishedFrame, frames)
  await h.controller.seek(2)
  await decoders[1].done
  assert.equal(h.inputs[1].status().startFrame, 96000)
  assert.equal(h.inputs[1].status().publishedFrame, frames)
  assert.equal(requests, 1, 'seek uses retained Opus bytes')
})

for (const policy of ['processed', 'direct'] as const) {
  for (const codec of ['flac', 'opus'] as const) {
    test(`${policy}: compatibility ${codec} pins seeks and stages a converted successor`, async () => {
      const requests: unknown[] = [], released: string[] = []
      const h = harness({ acquireRemoteSource: async (_path, _signal, request) => {
        requests.push(request)
        const compatibility = typeof request === 'object' ? request.compatibility : undefined
        const url = `http://cache/${compatibility ?? 'original'}`
        return { url, duration: 60, quality: { requested: 'original', requestedCodec: compatibility ?? null, compatibility, delivered: null },
          release: () => { released.push(url) }, finished: async () => {},
          progress: async () => ({ complete: true, loadedBytes: 100, totalBytes: 100, error: null }) }
      }, runProbe: async () => JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: codec, sample_rate: '48000', channels: 2, sample_fmt: 's16', duration: '60' }] }),
      startRemoteDecoder: options => {
        if (!options.args.includes(`http://cache/${codec}`)) throw new Error('Decoder (codec ac4) not found for input stream #0:0')
        options.input.append(Buffer.alloc(40000 * 4))
        return { ready: Promise.resolve(), done: Promise.resolve(), cancel: () => options.input.cancel(), pid: undefined, pendingBytes: 0 }
      } })
      await h.controller.configureNativeOutput({ policy, requestedSampleRate: null })
      const result = await h.controller.loadTrack(a)
      assert.equal(result.quality?.compatibility, codec)
      assert.equal(result.quality?.delivered?.codec, codec)
      assert.ok(released.includes('http://cache/original'))
      assert.equal(h.inputs[0].status().state, 'cancelled')
      await h.controller.play()
      await h.controller.seek(20)
      assert.deepEqual(requests.at(-1), { target: 'original', compatibility: codec })
      await h.controller.preloadNextTrack(b)
      h.transition()
      await h.controller.getPlaybackSnapshot()
      await h.controller.seek(30)
      assert.deepEqual(requests.at(-1), { target: 'original', compatibility: codec })
      assert.ok((await h.controller.getNativeAudioDiagnosticReport()).text.includes(`"policy":"${policy}"`))
      await h.controller.stop()
    })
  }
}

test('native corrupt media and device errors never request a compatibility encode', async () => {
  for (const failure of ['corrupt', 'device', 'partial'] as const) {
    let acquisitions = 0
    const h = harness({ acquireRemoteSource: async () => { acquisitions++; return automaticSource(undefined) },
      startRemoteDecoder: options => {
        if (failure === 'corrupt') throw new Error('Invalid data found when processing input')
        if (failure === 'partial') {
          options.input.append(Buffer.alloc(4))
          throw new Error('Decoder (codec ac4) not found for input stream #0:0')
        }
        options.input.append(Buffer.alloc(40000 * 4))
        return { ready: Promise.resolve(), done: Promise.resolve(), cancel: () => options.input.cancel(), pid: undefined, pendingBytes: 0 }
      } })
    if (failure === 'device') h.playback.createProgressiveInput = () => { throw new Error('Decoder (codec ac4) not found for input stream #0:0') }
    await assert.rejects(h.controller.loadTrack(a))
    assert.equal(acquisitions, 1)
    await h.controller.stop()
  }
})

for (const policy of ['processed', 'direct'] as const) {
  test(`saved remote loudness is fixed before ${policy} playback and successor preparation`, async () => {
    let loudness: { loudnessLufs: number; peakLinear: number } | null = null
    const h = harness({ acquireRemoteSource: async (_path, _signal, request) => {
      const source = automaticSource(request)
      return { ...source, quality: { ...source.quality, loudness } }
    } })
    await h.controller.configureNativeOutput({ policy, requestedSampleRate: null })
    const metadata = { path: a, remoteNormalizationTargetLufs: -14 }
    await h.controller.loadTrack(a, metadata)
    await h.controller.play()
    const initialGain = h.inputOptions[0].gain
    assert.equal(initialGain?.gainDb, 0)
    loudness = { loudnessLufs: -18, peakLinear: 0.3 }
    await h.controller.seek(20)
    assert.deepEqual(h.inputOptions.at(-1)?.gain, initialGain, 'a completed scan must not alter a seek in this play')
    await h.controller.changeRemoteQuality(a, { mode: 'automatic', target: 128 })
    assert.deepEqual(h.inputOptions.at(-1)?.gain, initialGain, 'automatic changes retain the playing gain')
    await h.controller.preloadNextTrack(b, { ...metadata, path: b })
    assert.equal(h.inputOptions.at(-1)?.gain?.gainDb, policy === 'processed' ? 4 : 0)
    h.transition()
    await h.controller.getPlaybackSnapshot()
    loudness = { loudnessLufs: -25, peakLinear: 0.1 }
    await h.controller.seek(30)
    assert.equal(h.inputOptions.at(-1)?.gain?.gainDb, policy === 'processed' ? 4 : 0, 'promotion and seek retain prepared gain')
    await h.controller.loadTrack(a, metadata, { mode: 'replaygain', gainDb: -3 })
    assert.equal(h.inputOptions.at(-1)?.gain?.gainDb, -3, 'explicit ReplayGain takes priority over measured loudness')
    await h.controller.stop()
  })
}

function automaticSource(request: import('../types/streamingQuality.ts').StreamingQualityRequest | undefined) {
  const pin = typeof request === 'object' ? request : { mode: 'automatic' as const, target: 'original' as const }
  return { url: 'http://cache/internal', duration: 60,
    quality: { requested: pin.target, mode: pin.mode, requestedCodec: pin.target === 'original' ? null : 'opus' as const, delivered: null },
    release() {}, finished: async () => {},
    progress: async () => ({ loadedBytes: 100, totalBytes: null, complete: false, error: null }) }
}

test('automatic native changes preserve audible position, playback identity, prepared next and mode through subsequent seeks', async () => {
  const requests: unknown[] = []
  const h = harness({ acquireRemoteSource: async (_path, _signal, request) => {
    requests.push(request); return automaticSource(request)
  } })
  await h.controller.loadTrack(a)
  const playing = await h.controller.play()
  await h.controller.seek(23)
  await h.controller.preloadNextTrack(b)
  const changed = await h.controller.changeRemoteQuality(a, { mode: 'automatic', target: 128 })
  assert.equal(changed.currentTime, 23)
  assert.equal(changed.playbackState, 'playing')
  assert.equal(changed.playbackSequence, playing.playbackSequence)
  await h.controller.seek(25)
  assert.deepEqual(requests.at(-1), { mode: 'automatic', target: 128 })
  h.transition()
  await h.controller.getPlaybackSnapshot()
  assert.equal((await h.controller.getNativeAudioDiagnosticReport()).track?.path, b)
  await h.controller.stop()
})

test('automatic native format changes keep the output policy and rebuild the incompatible successor', async () => {
  let reduced = false
  const h = harness({ acquireRemoteSource: async (_path, _signal, request) => {
    reduced = typeof request === 'object' && request.target !== 'original'
    return automaticSource(request)
  }, runProbe: async () => JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'flac',
    sample_rate: reduced ? '44100' : '48000', channels: 2, sample_fmt: 's16', duration: '60' }] }) })
  const events: NativeAudioEvent[] = []
  h.controller.onEvent(event => events.push(event))
  await h.controller.loadTrack(a)
  await h.controller.play()
  await h.controller.seek(23)
  await h.controller.preloadNextTrack(b)
  const next = h.inputs.at(-1)!
  const result = await h.controller.changeRemoteQuality(a, { mode: 'automatic-original', target: 192 })
  assert.equal(result.currentTime, 23)
  assert.equal(result.playbackState, 'playing')
  assert.equal(next.status().state, 'cancelled')
  assert.ok(events.some(event => event.type === 'prebufferInvalidated'))
  assert.deepEqual((await h.controller.getNativeAudioDiagnosticReport()).track?.streamingQuality,
    { mode: 'automatic-original', target: 192 })
  await h.controller.stop()
})

for (const action of ['pause', 'seek', 'paused-seek', 'skip', 'failure'] as const) {
  test(`native automatic preparation respects ${action} and keeps obsolete work from resuming playback`, async () => {
    let resolve!: () => void
    const ready = new Promise<void>(done => { resolve = done })
    let replacing = false
    const h = harness({ acquireRemoteSource: async (_path, _signal, request) => {
      replacing = typeof request === 'object' && request.target === 128
      return automaticSource(request)
    }, runProbe: async (_file, args) => {
      if (replacing && args.at(-1) === 'http://cache/internal') {
        await ready
        if (action === 'failure') throw new Error('Candidate probe failed')
      }
      return JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'flac', sample_rate: '48000',
        channels: 2, sample_fmt: 's16', duration: '60' }] })
    } })
    await h.controller.loadTrack(a)
    await h.controller.play()
    const old = h.inputs[0]
    const change = h.controller.changeRemoteQuality(a, { mode: 'automatic', target: 128 })
    const outcome = action === 'pause' ? change : assert.rejects(change)
    await new Promise<void>(done => setImmediate(done))
    if (action === 'pause' || action === 'paused-seek') await h.controller.pause()
    if (action === 'seek' || action === 'paused-seek') await h.controller.seek(25)
    if (action === 'skip') { await h.controller.loadTrack('/local.flac'); await h.controller.play() }
    resolve()
    await outcome
    const result = await h.controller.getPlaybackSnapshot()
    assert.equal(result.playbackState, action === 'pause' || action === 'paused-seek' ? 'paused' : 'playing')
    if (action === 'seek' || action === 'paused-seek') assert.equal(result.currentTime, 25)
    if (action === 'failure') assert.equal(old.status().state, 'open')
    if (action === 'skip') assert.equal((await h.controller.getNativeAudioDiagnosticReport()).track?.path, '/local.flac')
    await h.controller.stop()
  })
}

test('native quality stays pinned on seeks while a new successor inherits the changed preference', async () => {
  let globalQuality = 128 as 128 | 320
  const requests: Array<{ path: string; quality: unknown }> = []
  const h = harness({ acquireRemoteSource: async (path, _signal, pinned) => {
    assert.ok(pinned === undefined || pinned === 128 || pinned === 320)
    const requested = pinned ?? globalQuality
    requests.push({ path, quality: requested })
    return { url: 'http://cache/internal', duration: 60,
      quality: { requested, requestedCodec: 'mp3', delivered: null },
      release() {}, finished: async () => {},
      progress: async () => ({ loadedBytes: 100, totalBytes: 100, complete: true, error: null }) }
  } })
  await h.controller.loadTrack(a)
  await h.controller.play()
  globalQuality = 320
  await h.controller.preloadNextTrack(b)
  await h.controller.seek(20)
  assert.deepEqual(requests, [{ path: a, quality: 128 }, { path: b, quality: 320 }, { path: a, quality: 128 }])
  assert.equal((await h.controller.getNativeAudioDiagnosticReport()).track?.streamingQuality, 128)
  h.transition()
  await h.controller.getPlaybackSnapshot()
  assert.equal((await h.controller.getNativeAudioDiagnosticReport()).track?.streamingQuality, 320)
  await h.controller.seek(30)
  assert.equal(requests.at(-1)?.quality, 320, 'a promoted successor retains its own selection')
  await h.controller.stop()
})

for (const provider of ['subsonic', 'jellyfin']) {
  test(`${provider}: mixed handoffs preserve full local PCM and acknowledge remote ownership`, async () => {
    const h = harness()
    await h.controller.loadTrack('/local.flac')
    await h.controller.play()
    const remote = await h.controller.preloadNextTrack(`${provider}://7/a`)
    assert.deepEqual(h.local(), { localLoads: 1, localDecodes: 1 })
    assert.equal((await h.controller.seek(20)).currentTime, 20)
    assert.equal(h.leases.length, 1, 'local seek must not create a remote decoder')
    h.transition()
    assert.equal((await h.controller.getPlaybackSnapshot()).playbackSequence, remote.playbackSequence)
    assert.equal(h.leases[0].released, false)
    const local = await h.controller.preloadNextTrack('/next.flac', undefined, { mode: 'replaygain', gainDb: -4 })
    assert.deepEqual(h.local(), { localLoads: 1, localDecodes: 2 })
    h.transition()
    const snapshot = await h.controller.getPlaybackSnapshot()
    assert.equal(snapshot.playbackSequence, local.playbackSequence)
    assert.equal(snapshot.progressiveSessionId, undefined)
    assert.equal(h.leases[0].released, true)
    assert.equal((await h.controller.getNativeAudioDiagnosticReport()).track?.path, '/next.flac')
    assert.equal((await h.controller.seek(35)).currentTime, 35)
    assert.deepEqual(h.localSeeks, [20, 35])
    await h.controller.preloadNextTrack(`${provider}://7/b`)
    await h.controller.stop()
    assert.ok(h.leases.every(lease => lease.released))
    assert.equal((await h.controller.getBufferMemoryStats()).currentBytes, 4, 'stop retains the local buffer')
  })
}

for (const direction of ['to-local', 'to-remote']) {
  test(`manual mixed promotion ${direction} preserves the prepared source`, async () => {
    const h = harness()
    const target = direction === 'to-local' ? '/local.flac' : a
    await h.controller.loadTrack(direction === 'to-local' ? a : '/local.flac')
    const prepared = await h.controller.preloadNextTrack(target)
    const promoted = await h.controller.promoteNextTrack(target)
    assert.equal(promoted.playbackSequence, prepared.playbackSequence)
    assert.equal((await h.controller.getNativeAudioDiagnosticReport()).track?.path, target)
    assert.equal(h.leases[0].released, direction === 'to-local')
    await h.controller.stop()
  })

  test(`pause acknowledges a mixed handoff ${direction} before returning its identity`, async () => {
    const h = harness()
    await h.controller.loadTrack(direction === 'to-local' ? a : '/local.flac')
    const prepared = await h.controller.preloadNextTrack(direction === 'to-local' ? '/local.flac' : a)
    const pause = h.playback.pause
    h.playback.pause = () => { h.transition(); return pause() }
    assert.equal((await h.controller.pause()).playbackSequence, prepared.playbackSequence)
    assert.equal(h.leases[0].released, direction === 'to-local')
    await h.controller.stop()
  })
}

test('replacing a remote successor cannot discard a local-to-remote handoff acknowledged during withdrawal', async () => {
  const h = harness()
  await h.controller.loadTrack('/local.flac')
  const prepared = await h.controller.preloadNextTrack(a)
  const clear = h.playback.clearNextTrack
  h.playback.clearNextTrack = () => { h.transition(); clear() }
  await assert.rejects(h.controller.preloadNextTrack(b), { name: 'SupersededNativeAudioLoadError' })
  assert.equal((await h.controller.getPlaybackSnapshot()).playbackSequence, prepared.playbackSequence)
  assert.equal((await h.controller.getNativeAudioDiagnosticReport()).track?.path, a)
  assert.equal(h.leases[0].released, false)
  await h.controller.stop()
})

test('local successors after a remote handoff retain consumption-based withdrawal and seek bookkeeping', async () => {
  const h = harness()
  await h.controller.loadTrack(a)
  await h.controller.preloadNextTrack('/first.flac')
  h.transition()
  await h.controller.getPlaybackSnapshot()
  await h.controller.preloadNextTrack('/obsolete.flac')
  const prepared = await h.controller.preloadNextTrack('/next.flac')
  const clear = h.playback.clearNextTrack
  h.playback.clearNextTrack = () => { h.transition(); clear() }
  await h.controller.clearNextTrack()
  assert.equal((await h.controller.getPlaybackSnapshot()).playbackSequence, prepared.playbackSequence)
  assert.equal((await h.controller.getNativeAudioDiagnosticReport()).track?.path, '/next.flac')
  assert.equal((await h.controller.seek(25)).currentTime, 25)
  await h.controller.stop()
  assert.equal((await h.controller.getBufferMemoryStats()).currentBytes, 4)
})

test('first remote preparation credits a prior local handoff acknowledged during withdrawal', async () => {
  const h = harness()
  await h.controller.loadTrack('/first.flac')
  const prepared = await h.controller.preloadNextTrack('/next.flac')
  const clear = h.playback.clearNextTrack
  h.playback.clearNextTrack = () => { h.transition(); clear() }
  await assert.rejects(h.controller.preloadNextTrack(a), { name: 'SupersededNativeAudioLoadError' })
  assert.equal((await h.controller.getPlaybackSnapshot()).playbackSequence, prepared.playbackSequence)
  assert.equal((await h.controller.getNativeAudioDiagnosticReport()).track?.path, '/next.flac')
  assert.equal(h.leases.length, 0)
  await h.controller.stop()
})

for (const currentProvider of ['subsonic', 'jellyfin']) {
  for (const nextProvider of ['subsonic', 'jellyfin']) {
    const a = `${currentProvider}://7/a`
    const b = `${nextProvider}://7/b`
    test(`${currentProvider} to ${nextProvider}: leases survive decode/seek and promotion follows audible identity`, async () => {
      const h = harness()
      await h.controller.loadTrack(a)
      await h.controller.play()
      const next = await h.controller.preloadNextTrack(b)
      await h.controller.pause()
      const seek = await h.controller.seek(17)
      assert.equal(seek.playbackState, 'paused')
      assert.equal(seek.currentTime, 17)
      assert.deepEqual(h.leases.map(x => x.released), [true, false, false])
      assert.equal(h.inputs[1].status().state, 'open', 'seeking must preserve prepared next')
      assert.ok(h.decoders[2].args.includes('17'))
      assert.equal(h.decoders[2].args.includes(a), false, 'FFmpeg receives only the internal cache URL')
      const observed: NativeAudioEvent[] = []
      h.controller.onEvent(event => observed.push(event))
      h.transition()
      const snapshot = await h.controller.getPlaybackSnapshot()
      assert.equal(snapshot.playbackSequence, next.playbackSequence)
      assert.equal(snapshot.progressiveSessionId, h.inputs[1].status().sessionId)
      assert.equal(observed.filter(x => x.type === 'gaplessTransition').length, 1)
      assert.deepEqual(h.leases.map(x => x.released), [true, false, true])
      const report = await h.controller.getNativeAudioDiagnosticReport()
      assert.equal(report.track?.path, b)
      assert.ok(!report.text.includes('http://cache'))
      await h.controller.stop()
      assert.ok(h.leases.every(x => x.released))
      assert.equal((await h.controller.getBufferMemoryStats()).totalBytes, 0)
      assert.deepEqual(h.local(), { localLoads: 0, localDecodes: 0 })
    })

  }
}

test('pending-decode cancellation leaves attached playback alone; stop cancels it and local loading stays complete', async () => {
  const h = harness()
  await h.controller.loadTrack(a)
  await h.controller.preloadNextTrack(b)
  await h.controller.cancelPendingDecode()
  assert.ok(h.inputs.every(x => x.status().state === 'open'))
  assert.ok(h.leases.every(x => !x.released))
  await h.controller.clearNextTrack()
  assert.equal(h.inputs[1].status().state, 'cancelled')
  assert.equal(h.leases[0].released, false)
  await h.controller.loadTrack('/local.flac')
  assert.ok(h.leases.every(x => x.released))
  assert.deepEqual(h.local(), { localLoads: 1, localDecodes: 1 })
})

test('a stale acquisition releases its lease without replacing a newer local load', async () => {
  let deliver!: () => void
  let released = false
  const h = harness({ acquireRemoteSource: async () => {
    await new Promise<void>(resolve => { deliver = resolve })
    return { url: 'internal', duration: 60, release: () => { released = true }, finished: async () => {},
      progress: async () => ({ loadedBytes: 0, totalBytes: null, complete: false, error: null }) }
  } })
  const stale = h.controller.loadTrack(a)
  await new Promise(resolve => setImmediate(resolve))
  await h.controller.loadTrack('/new.flac')
  deliver()
  await assert.rejects(stale, { name: 'SupersededNativeAudioLoadError' })
  assert.equal(released, true)
  assert.equal(h.inputs.length, 0)
  assert.equal((await h.controller.getNativeAudioDiagnosticReport()).track?.path, '/new.flac')
})

test('decoder failure releases a failed cache entry but preserves PCM and never generates ended', async () => {
  const h = harness({ eventPolling: true })
  const events: NativeAudioEvent[] = []
  h.controller.onEvent(event => events.push(event))
  try {
    await h.controller.loadTrack(a)
    await h.controller.play()
    h.decoders[0].onFailure!(new Error('connection interrupted'))
    h.setBuffering(true)
    await new Promise(resolve => setTimeout(resolve, 350))
    const progress = events.find(x => x.type === 'remoteProgress')
    assert.ok(progress?.type === 'remoteProgress' && progress.progress.failed && progress.buffering)
    assert.equal(h.leases[0].released, true)
    assert.equal(h.inputs[0].status().state, 'open')
    assert.equal(events.some(x => x.type === 'ended'), false)
    await h.controller.seek(0)
    assert.equal(h.leases[1].released, false)
  } finally { await h.controller.stop() }
})

test('startup decoder failure remains a real error and releases its lease', async () => {
  const h = harness({ startRemoteDecoder: options => ({ ready: Promise.reject(new Error('broken audio')),
    done: Promise.resolve(), cancel: () => options.input.cancel(), pid: undefined, pendingBytes: 0 }) })
  await assert.rejects(h.controller.loadTrack(a), /broken audio/)
  assert.equal(h.leases[0].released, true)
  assert.equal(h.inputs[0].status().state, 'cancelled')
})

test('withdrawal credits a handoff acknowledged during pause before releasing next ownership', async () => {
  const h = harness()
  await h.controller.loadTrack(a)
  const next = await h.controller.preloadNextTrack(b)
  const clear = h.playback.clearNextTrack
  h.playback.clearNextTrack = () => { h.transition(); clear() }
  await h.controller.clearNextTrack()
  assert.equal((await h.controller.getPlaybackSnapshot()).playbackSequence, next.playbackSequence)
  assert.deepEqual(h.leases.map(x => x.released), [true, false])
  assert.equal(h.inputs[1].status().state, 'open')
  await h.controller.stop()
})

test('seek preparation that loses a gapless race cannot replace the newly audible track', async () => {
  let resume!: () => void
  let decodes = 0
  const h = harness({ startRemoteDecoder: options => {
    options.input.append(Buffer.alloc(40000 * 4))
    return { ready: ++decodes === 3 ? new Promise<void>(resolve => { resume = resolve }) : Promise.resolve(),
      done: Promise.resolve(), cancel: () => options.input.cancel(), pid: undefined, pendingBytes: 0 }
  } })
  await h.controller.loadTrack(a)
  await h.controller.preloadNextTrack(b)
  const seek = h.controller.seek(59)
  await new Promise(resolve => setImmediate(resolve))
  h.transition()
  await h.controller.getPlaybackSnapshot()
  resume()
  await assert.rejects(seek, { name: 'SupersededNativeAudioLoadError' })
  assert.equal((await h.controller.getNativeAudioDiagnosticReport()).track?.path, b)
  assert.deepEqual(h.leases.map(x => x.released), [true, false, true])
  await h.controller.stop()
})

test('native format rejection falls through FLAC and Opus to MP3, while forbidden requests stay errors', async () => {
  for (const failureKind of ['unsupported-format', undefined] as const) {
    const requests: unknown[] = [], released: string[] = []
    const h = harness({ acquireRemoteSource: async (_path, _signal, request) => {
      requests.push(request)
      const compatibility = typeof request === 'object' ? request.compatibility : undefined
      return { url: `http://cache/${compatibility ?? 'original'}`, duration: 60,
        quality: { requested: 'original', requestedCodec: compatibility ?? null, compatibility, delivered: null },
        release: () => { released.push(compatibility ?? 'original') }, finished: async () => {},
        progress: async () => ({ loadedBytes: 0, totalBytes: null, complete: false, error: 'HTTP failure', failureKind }) }
    }, runProbe: async (_command, args) => {
      if (args.includes('http://cache/original')) throw new Error('Decoder (codec ac4) not found')
      if (args.includes('http://cache/flac') || args.includes('http://cache/opus')) throw new Error('HTTP error')
      return JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'mp3', sample_rate: '48000', channels: 2, sample_fmt: 's16' }] })
    } })
    if (failureKind) {
      const result = await h.controller.loadTrack(a)
      assert.equal(result.quality?.compatibility, 'mp3')
      assert.equal(result.quality?.delivered?.codec, 'mp3')
      assert.equal(requests.length, 4)
    } else {
      await assert.rejects(h.controller.loadTrack(a), /HTTP error/)
      assert.equal(requests.length, 2)
    }
    assert.ok(released.includes('original') && released.includes('flac'))
    await h.controller.stop()
  }
})

test('stopping during a compatibility retry releases the stale source without starting another decoder', async () => {
  let deliver!: () => void
  const requests: unknown[] = [], released: unknown[] = []
  const h = harness({ acquireRemoteSource: async (_path, _signal, request) => {
    requests.push(request)
    if (typeof request === 'object') await new Promise<void>(resolve => { deliver = resolve })
    const source = automaticSource(request)
    return { ...source, release: () => { released.push(request) } }
  }, runProbe: async () => { throw new Error('Decoder (codec ac4) not found') } })
  const pending = h.controller.loadTrack(a)
  const rejected = assert.rejects(pending, { name: 'SupersededNativeAudioLoadError' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests.length, 2)
  // Stop cancels retry without needing a decoder for a new track.
  await h.controller.stop()
  deliver()
  await rejected
  assert.equal(requests.length, 2)
  assert.equal(released.length, 2)
  assert.equal(h.inputs.length, 0)
})
