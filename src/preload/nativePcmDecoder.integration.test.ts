import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startNativePcmDecoder } from './nativePcmDecoder.ts'
import { RemoteAudioCache } from '../main/services/remoteAudioCache.ts'
import { createJellyfinAudioSource } from '../main/services/jellyfinAudioSource.ts'
import { createNativeAudioController, type NativeAudioAddonPlayback } from './nativeAudioController.ts'

const require = createRequire(import.meta.url)
const ffmpeg: string = require('ffmpeg-static')
const { playback } = require('../../native/build/Release/visualizer_dsp.node') as { playback: NativeAudioAddonPlayback }

test('real FFmpeg decodes retained original audio and replacement seeks into addon inputs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-native-decoder-'))
  const cache = new RemoteAudioCache(directory, 1024 * 1024)
  t.after(async () => { playback.stop(); await cache.close(); await rm(directory, { recursive: true, force: true }) })
  const frames = 12000
  const pcm = Buffer.alloc(frames * 4)
  for (let frame = 0; frame < frames; frame++) {
    pcm.writeInt16LE((frame * 37) % 32768, frame * 4)
    pcm.writeInt16LE(-((frame * 73) % 32768), frame * 4 + 2)
  }
  const encoded = execFileSync(ffmpeg, [
    '-v', 'error', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
    '-c:a', 'flac', '-f', 'flac', 'pipe:1'
  ], { input: pcm })
  let downloads = 0
  const source = {
    provider: 'subsonic' as const, account: 'native/test', track: 'original', representation: 'original', revision: '1',
    open: async () => {
      downloads++
      return new Response(encoded, { headers: { 'content-type': 'audio/flac', 'content-length': String(encoded.length) } })
    }
  }
  const lease = await cache.acquire(source)
  t.after(lease.release)
  let firstId = 0
  for (const [sampleFormat, codec, startFrame] of [
    ['s16', 'pcm_s16le', 0], ['s24', 'pcm_s24le', 0], ['s32', 'pcm_s32le', 0], ['f32', 'pcm_f32le', 0],
    ['s16', 'pcm_s16le', 6000]
  ] as const) {
    const input = playback.createProgressiveInput!({
      sampleRate: 48000, channels: 2, sampleFormat, capacityFrames: 16000, startFrame, duration: frames / 48000
    })
    const args = [
      '-v', 'error', '-nostdin', ...(startFrame ? ['-ss', String(startFrame / 48000)] : []),
      '-i', lease.url, '-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', codec,
      '-f', `${sampleFormat}le`, 'pipe:1'
    ]
    const accepted: Buffer[] = []
    const append = input.append.bind(input)
    const monitored = {
      append: (data: Uint8Array) => {
        const frames = append(data)
        accepted.push(Buffer.from(data.subarray(0, frames * input.status().bytesPerFrame)))
        return frames
      },
      status: input.status.bind(input), finish: input.finish.bind(input), cancel: input.cancel.bind(input),
      load: input.load.bind(input), preloadNext: input.preloadNext.bind(input), seek: input.seek.bind(input)
    }
    const decoder = startNativePcmDecoder({
      command: ffmpeg, args, input: monitored, startupFrames: 4000, validateEof: lease.finished
    })
    t.after(decoder.cancel)
    await decoder.ready
    await decoder.done
    assert.equal(input.status().state, 'ended')
    assert.equal(input.status().publishedFrame, frames)
    const expected = sampleFormat === 's16' ? pcm.subarray(startFrame * 4)
      : execFileSync(ffmpeg, ['-v', 'error', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
        '-c:a', codec, '-f', `${sampleFormat}le`, 'pipe:1'], { input: pcm })
    assert.deepEqual(Buffer.concat(accepted), expected)
    if (startFrame) {
      // A seek replaces an already loaded source without opening an output device.
      const snapshot = await input.seek(firstId)
      assert.equal(snapshot.currentTime, startFrame / 48000)
      assert.equal(snapshot.progressiveSessionId, input.status().sessionId)
    } else if (sampleFormat === 's16') {
      firstId = input.load().progressiveSessionId!
    }
  }
  assert.equal(downloads, 1)
  assert.equal(lease.progress().complete, true)
  await cache.clearUnused()
  assert.ok((await cache.status()).activeBytes > 0, 'the playback lease protects the encoded file')
  const cached = await cache.acquire({ ...source, open: async () => { throw new Error('offline') } })
  t.after(cached.release)
  assert.equal(cached.progress().complete, true)

  // Exercise the production controller's probing, format selection, ownership,
  // startup and replacement-seek paths against the real addon, without play().
  let released = 0
  const controller = createNativeAudioController({ playback: { ...playback,
    getCapabilities: () => ({ ...playback.getCapabilities(), bitPerfectAvailable: true })
  } }, {
    eventPolling: false,
    resolveBinary: async binary => binary === 'ffmpeg' ? ffmpeg : require('ffprobe-static').path,
    acquireRemoteSource: async (_path, signal) => {
      const acquired = await cache.acquire(source, signal)
      let disposed = false
      return { ...acquired, duration: frames / 48000,
        progress: async () => ({ ...acquired.progress(), error: null }),
        release: () => { if (!disposed) { disposed = true; released++; acquired.release() } }
      }
    }
  })
  t.after(() => controller.stop())
  const logicalPath = 'subsonic://native-test/track/original'
  const loaded = await controller.loadTrack(logicalPath)
  assert.equal(loaded.sampleRate, 48000)
  assert.equal(loaded.sampleFormat, 's16')
  assert.equal(loaded.duration, frames / 48000)
  await controller.preloadNextTrack(logicalPath)
  assert.equal(released, 0, 'short completed decoders retain both playback leases')
  const sought = await controller.seek(6000 / 48000)
  assert.equal(sought.currentTime, 6000 / 48000)
  assert.equal(released, 1, 'seek releases only the replaced current lease')
  assert.equal((await controller.getNativeAudioDiagnosticReport()).track?.path, logicalPath)
  await controller.stop()
  assert.equal(released, 3)
  assert.equal(downloads, 1)

  const localPath = join(directory, 'local.flac')
  await writeFile(localPath, encoded)
  await controller.loadTrack(logicalPath)
  await controller.preloadNextTrack(localPath)
  await controller.promoteNextTrack(localPath)
  assert.equal(released, 4, 'remote-to-local promotion releases the former lease')
  assert.equal((await controller.getBufferMemoryStats()).currentBytes, pcm.byteLength)
  assert.equal((await controller.seek(0.125)).currentTime, 0.125)
  assert.equal((await controller.getPlaybackSnapshot()).progressiveSessionId, undefined)
  await controller.preloadNextTrack(logicalPath)
  await controller.promoteNextTrack(logicalPath)
  assert.ok((await controller.getPlaybackSnapshot()).progressiveSessionId)
  await controller.stop()
  // Also adopt an ordinary full local load, before any remote session existed.
  await controller.loadTrack(localPath)
  await controller.preloadNextTrack(logicalPath)
  await controller.clearNextTrack()
  assert.equal((await controller.seek(0.125)).currentTime, 0.125)
  await controller.stop()
  assert.equal((await controller.getBufferMemoryStats()).currentBytes, pcm.byteLength)
  assert.equal(released, 6)
})

test('Jellyfin originals use the real native controller and retained cache without authenticating offline', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-jellyfin-decoder-'))
  let cache = new RemoteAudioCache(directory, 1024 * 1024)
  const encoded = execFileSync(ffmpeg, [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.25',
    '-ac', '2', '-c:a', 'flac', '-f', 'flac', 'pipe:1'
  ])
  let offline = false
  let authentications = 0
  let downloads = 0
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    assert.equal(offline, false, 'completed cache entries must not contact the server')
    const url = new URL(input)
    assert.equal(url.pathname, '/Audio/song/stream')
    assert.equal(url.searchParams.get('static'), 'true')
    downloads++
    return new Response(encoded, { headers: { 'content-type': 'audio/flac', 'content-length': String(encoded.length) } })
  })
  const source = createJellyfinAudioSource({
    sourceId: 7, connection: { baseUrl: 'https://music.example', username: 'listener', password: 'secret' },
    trackId: 'song', revision: '1', authenticate: async () => {
      assert.equal(offline, false, 'cached playback must not need a fresh login')
      authentications++
      return { accessToken: 'test-token', userId: 'user' }
    }
  })
  const controller = createNativeAudioController({ playback: { ...playback,
    getCapabilities: () => ({ ...playback.getCapabilities(), bitPerfectAvailable: true })
  } }, {
    eventPolling: false,
    resolveBinary: async binary => binary === 'ffmpeg' ? ffmpeg : require('ffprobe-static').path,
    acquireRemoteSource: async (path, signal) => {
      assert.equal(path, 'jellyfin://7/song')
      const lease = await cache.acquire(source, signal)
      return { ...lease, duration: 0.25, progress: async () => ({ ...lease.progress(), error: null }) }
    }
  })
  t.after(async () => { await controller.stop(); await cache.close(); await rm(directory, { recursive: true, force: true }) })
  const loaded = await controller.loadTrack('jellyfin://7/song')
  assert.equal(loaded.sampleRate, 48000)
  assert.equal(loaded.sampleFormat, 's16')
  assert.equal(loaded.duration, 0.25)
  await controller.preloadNextTrack('jellyfin://7/song')
  assert.equal((await controller.seek(0.125)).currentTime, 0.125)
  await cache.clearUnused()
  assert.ok((await cache.status()).activeBytes > 0)
  await controller.stop()
  await cache.close()

  offline = true
  cache = new RemoteAudioCache(directory, 1024 * 1024)
  await controller.loadTrack('jellyfin://7/song')
  assert.equal((await controller.seek(0.125)).currentTime, 0.125)
  const report = await controller.getNativeAudioDiagnosticReport()
  assert.equal(report.track?.path, 'jellyfin://7/song')
  assert.ok(!report.text.includes('test-token'))
  assert.equal(authentications, 1)
  assert.equal(downloads, 1)
})
